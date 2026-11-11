//! Espaço de trabalho compartilhado: achar outros BlueScreen na rede e espelhar o que se faz entre as janelas.
//! - Anúncio: com a rede local ligada, o BlueScreen avisa por UDP (broadcast na porta BEACON) que está aberto,
//!   com o nome do PC, a porta e o projeto aberto. Quem abre o "Conectar" escuta essa porta e lista o que achou.
//! - Conectar: a janela do aplicativo troca a página local pela do outro PC (desktop.rs), sem abrir o navegador.
//! - Espelhar: cada janela com o espelho ligado entra em /api/mirror/ws; o que uma manda, as outras recebem
//!   (abrir projeto, abas, edição, cursor, rolagem...). O servidor só repassa: quem entende as mensagens é share.js.
use crate::server::{app, gethostname, lan_enabled, VERSION};
use crate::util::log;
use axum::body::Body;
use axum::extract::FromRequest;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// porta UDP dos anúncios
const BEACON: u16 = 4749;
/// identifica esta instância nos anúncios (para não listar a si mesma)
fn instance() -> &'static str { static I: OnceLock<String> = OnceLock::new(); I.get_or_init(|| format!("{:016x}", rand::random::<u64>())) }

// ---------- anúncio ----------
/// Liga o anúncio enquanto a rede local estiver ligada (chamado por lan_enable; sai sozinho quando ela desliga).
pub fn announce_start() {
    // desligar e religar a rede em menos de 2 s deixaria duas tarefas anunciando: cada início vale só a última
    static GEN: AtomicUsize = AtomicUsize::new(0);
    let me = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tokio::spawn(async move {
        let Ok(sock) = tokio::net::UdpSocket::bind(("0.0.0.0", 0)).await else { return };
        let _ = sock.set_broadcast(true);
        while lan_enabled() && GEN.load(Ordering::SeqCst) == me {
            let (port, project) = { let l = app().lan.lock(); (l.port, l.project.clone()) };
            let msg = json!({ "bs": "bluescreen", "id": instance(), "host": gethostname(), "port": port, "project": project, "v": VERSION }).to_string();
            // broadcast geral e o da sub-rede de cada endereço (/24): com várias placas, o geral sai só por uma
            let mut to = vec!["255.255.255.255".to_string()];
            for ip in local_ipv4() { let o = ip.octets(); to.push(format!("{}.{}.{}.255", o[0], o[1], o[2])); }
            for a in to { let _ = sock.send_to(msg.as_bytes(), (a.as_str(), BEACON)).await; }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}
fn local_ipv4() -> Vec<std::net::Ipv4Addr> {
    let mut v = vec![];
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") { if s.connect("8.8.8.8:80").is_ok() { if let Ok(std::net::SocketAddr::V4(a)) = s.local_addr() { v.push(*a.ip()); } } }
    if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&(gethostname(), 0)) {
        for a in addrs { if let std::net::IpAddr::V4(ip) = a.ip() { if !ip.is_loopback() && !ip.is_link_local() && !v.contains(&ip) { v.push(ip); } } }
    }
    v
}

// ---------- descoberta ----------
type Seen = Mutex<HashMap<String, (Value, Instant)>>;
fn seen() -> &'static Seen { static S: OnceLock<Seen> = OnceLock::new(); S.get_or_init(Default::default) }
/// Escuta os anúncios (uma thread, iniciada no primeiro pedido) e devolve o que foi ouvido nos últimos segundos.
pub fn discovered() -> Value {
    static LISTEN: OnceLock<Result<(), String>> = OnceLock::new();
    let state = LISTEN.get_or_init(|| {
        let sock = std::net::UdpSocket::bind(("0.0.0.0", BEACON)).map_err(|e| format!("Não deu para escutar a porta UDP {BEACON}: {e}"))?;
        let _ = std::thread::Builder::new().name("bs-discover".into()).spawn(move || {
            // 64 KB: um datagrama maior que o buffer dá erro no Windows (WSAEMSGSIZE); erro não encerra a escuta
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let (n, from) = match sock.recv_from(&mut buf) { Ok(x) => x, Err(_) => { std::thread::sleep(Duration::from_millis(100)); continue; } };
                let Ok(v) = serde_json::from_slice::<Value>(&buf[..n]) else { continue };
                if v["bs"] != "bluescreen" || v["id"] == instance() { continue; }
                let Some(port) = v["port"].as_u64() else { continue };
                let url = format!("http://{}:{port}", from.ip());
                let item = json!({ "host": v["host"], "project": v["project"], "version": v["v"], "url": url });
                seen().lock().insert(url, (item, Instant::now()));
            }
        });
        log(format!("rede: procurando espaços de trabalho (UDP {BEACON})"));
        Ok(())
    });
    let mut s = seen().lock();
    s.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(7));
    let mut list: Vec<Value> = s.values().map(|(v, _)| v.clone()).collect();
    list.sort_by(|a, b| a["host"].as_str().cmp(&b["host"].as_str()));
    json!({ "found": list, "error": state.as_ref().err() })
}

/// "192.168.0.10", "pc:4748" ou "http://192.168.0.10:4748/..." -> "http://192.168.0.10:4748"
pub fn normalize(addr: &str) -> Option<String> {
    let a = addr.trim().trim_start_matches("http://").split('/').next()?.trim().to_string();
    if a.is_empty() || a.contains(['@', ' ', '?', '#']) { return None; }
    Some(if a.contains(':') { format!("http://{a}") } else { format!("http://{a}:{}", app().lan.lock().port) })
}
/// confere se do outro lado tem um BlueScreen com a rede ligada, antes de a janela navegar para lá
pub async fn probe(url: &str) -> Result<Value, String> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().map_err(|e| e.to_string())?;
    let r = http.get(format!("{url}/api/session")).send().await.map_err(|_| format!("Ninguém respondeu em {url}. O outro PC está com \"Permitir acesso pela rede\" ligado? O firewall libera a porta?"))?;
    let v: Value = r.json().await.map_err(|_| format!("{url} respondeu, mas não é um BlueScreen"))?;
    if !v["remote"].is_boolean() { return Err(format!("{url} respondeu, mas não é um BlueScreen")); }
    Ok(json!({ "url": url, "authed": v["authed"] }))
}

// ---------- espelho ----------
fn hub() -> &'static tokio::sync::broadcast::Sender<(u64, String)> {
    static H: OnceLock<tokio::sync::broadcast::Sender<(u64, String)>> = OnceLock::new();
    H.get_or_init(|| tokio::sync::broadcast::channel(1024).0)
}
static PEERS: AtomicUsize = AtomicUsize::new(0);
fn peers_msg() -> String { json!({ "t": "peers", "n": PEERS.load(Ordering::SeqCst) }).to_string() }

/// GET /api/mirror/ws — só a própria página (Origin = Host); pela rede, o login com PIN já foi conferido em handle().
pub async fn mirror_ws(req: Request<Body>, remote: bool) -> Response {
    if !crate::server::ws_origin_ok(req.headers(), remote) { return (StatusCode::FORBIDDEN, "origem não permitida").into_response(); }
    let who = if remote { "rede" } else { "local" };
    match WebSocketUpgrade::from_request(req, &()).await {
        Ok(up) => up.on_upgrade(move |s| mirror_session(s, who)),
        Err(e) => e.into_response(),
    }
}
async fn mirror_session(ws: WebSocket, who: &'static str) {
    let id = rand::random::<u64>() | 1; // 0 = o próprio servidor
    let tx = hub();
    let mut rx = tx.subscribe();
    PEERS.fetch_add(1, Ordering::SeqCst);
    let _ = tx.send((0, peers_msg()));
    log(format!("espelho: janela ({who}) entrou; {} no total", PEERS.load(Ordering::SeqCst)));
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Text(t))) => { let _ = tx.send((id, t.to_string())); }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => {}
                _ => break,
            },
            m = rx.recv() => match m {
                Ok((from, t)) if from != id => { if sink.send(Message::Text(t.into())).await.is_err() { break; } }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            },
        }
    }
    PEERS.fetch_sub(1, Ordering::SeqCst);
    let _ = tx.send((0, peers_msg()));
}
