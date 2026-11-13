//! Servidor HTTP (axum/tokio): rotas do núcleo, despacho para plugins, arquivos da interface e rede local com PIN.
use crate::plugins::{Host, Reply, Req, RouteFn, ok, route_fn};
// as mesmas do servidor de plugins (sdk/src/plugin.rs): uma resposta JSON e uma leitura de query só
use bluescreen_sdk::plugin::{json_resp, parse_query};
use crate::util::*;
use crate::{lint, vcs, workspace};
use axum::body::Body;
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

mod files;
mod history;
mod network;
mod sdks;
mod system;
pub use system::{studio_holds_quit, studio_kill};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Avisos do servidor para a janela do aplicativo. Prompt: a janela do cofre para digitar um segredo (vault_input.rs),
/// com a resposta (os valores, ou None se cancelou) no canal.
pub enum UiEvent { Activate, Quit, Notify(String, String), Prompt(serde_json::Value, std::sync::mpsc::Sender<Option<Vec<String>>>) }
pub static UI: OnceLock<Box<dyn Fn(UiEvent) + Send + Sync>> = OnceLock::new();

/// project: nome do projeto aberto na janela deste PC, anunciado na rede (share.rs)
pub struct Lan { pub pin: Option<String>, pub port: u16, pub project: Option<String>, stop: Option<tokio::sync::oneshot::Sender<()>> }
#[allow(dead_code)]
pub struct App {
    pub root: PathBuf,
    pub port: u16,
    pub lan: Mutex<Lan>,
    /// sessões da rede local (cookie -> sessão); valem SESSION_TTL, como o cookie, e só do IP que fez o login
    pub sessions: Mutex<HashMap<String, Session>>,
    pub host: OnceLock<Host>,
}
/// Um aparelho logado pela rede: o IP que digitou o PIN (o cookie não vale de outro IP), quando entrou e o último
/// pedido. `id` é o que a lista de aparelhos mostra para revogar (o cookie em si nunca sai do servidor).
pub struct Session { pub id: String, pub ip: Option<std::net::IpAddr>, pub at: std::time::Instant, pub since_ms: f64, pub last_ms: f64 }
pub type Shared = Arc<App>;
static APP: OnceLock<Shared> = OnceLock::new();
pub fn app() -> &'static Shared { APP.get().expect("app") }

pub fn create(root: PathBuf, port: u16, lan_port: u16) -> Shared {
    let a = Arc::new(App { root, port, lan: Mutex::new(Lan { pin: None, port: lan_port, project: None, stop: None }), sessions: Mutex::new(HashMap::new()), host: OnceLock::new() });
    let _ = APP.set(a.clone());
    // token dos plugins: quem chama o núcleo com ele é um plugin ou o próprio núcleo (pode usar rotas internas)
    let token: String = (0..40).map(|_| format!("{:x}", rand::random_range(0..16u8))).collect();
    bluescreen_sdk::plugin::set_core(&format!("http://127.0.0.1:{port}"), &token);
    let _ = a.host.set(Host::new(core_routes()));
    a
}
pub fn host() -> &'static Host { app().host.get().expect("host") }

// ---------- rede local (acesso via LAN com PIN) ----------
fn lan_addresses(port: u16) -> Vec<Value> {
    // IPs da máquina: abre um socket UDP "conectado" para descobrir o endereço de saída, e lista os do hostname
    let mut ips: Vec<String> = vec![];
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") { if s.connect("8.8.8.8:80").is_ok() { if let Ok(a) = s.local_addr() { ips.push(a.ip().to_string()); } } }
    if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&(gethostname(), 0)) {
        for a in addrs { if let std::net::IpAddr::V4(v4) = a.ip() { if !v4.is_loopback() && !v4.is_link_local() { let s = v4.to_string(); if !ips.contains(&s) { ips.push(s); } } } }
    }
    ips.into_iter().map(|ip| json!({ "iface": "rede", "url": format!("http://{ip}:{port}") })).collect()
}
pub fn gethostname() -> String { std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "localhost".into()) }
pub fn lan_status() -> Value {
    // login fechado por excesso de PINs errados: quanto falta e quantas vezes o PIN já foi trocado (o aviso na janela
    // mostra o PIN novo sem precisar reabrir). Lido e solto antes de pegar `lan`: pin_can_try pega os dois na ordem
    // contrária, e segurar um esperando o outro travaria as duas
    let (closed, rounds) = { let g = pin_guard().lock(); (g.closed_until.map(|t| t.saturating_duration_since(std::time::Instant::now()).as_secs()).filter(|s| *s > 0), g.rounds) };
    let l = app().lan.lock();
    let on = l.stop.is_some();
    json!({ "enabled": on, "pin": l.pin, "port": l.port, "urls": if on { lan_addresses(l.port) } else { vec![] }, "lockedFor": closed, "pinChanges": rounds })
}
pub fn lan_enabled() -> bool { app().lan.lock().stop.is_some() }
pub async fn lan_enable() -> ApiResult<Value> {
    if lan_enabled() { return Ok(lan_status()); }
    let port = app().lan.lock().port;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.map_err(|e| fail(format!("Não deu para abrir a porta {port}: {e}"), 500))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut l = app().lan.lock();
        l.pin = Some(new_pin());
        l.stop = Some(tx);
    }
    *pin_guard().lock() = PinGuard::default();
    // o IP de quem conecta vai junto do pedido: as tentativas de PIN são contadas por IP
    let router = router(true).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(async { let _ = rx.await; }).await;
    });
    crate::share::announce_start();
    Ok(lan_status())
}
fn new_pin() -> String { std::env::var("BLUESCREEN_PIN").unwrap_or_else(|_| format!("{:06}", rand::random_range(100000..1000000u32))) }
/// sessão da rede local: igual ao Max-Age do cookie; depois disso, PIN de novo
const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(86400);
/// Tentativas de PIN erradas. Cada IP tem PIN_PER_IP tentativas por minuto; a cada PIN_ROUND erros no total o PIN
/// muda (se não veio de BLUESCREEN_PIN) e o login fica fechado por um tempo que dobra a cada rodada (até 1 h).
const PIN_PER_IP: u32 = 5;
const PIN_ROUND: u32 = 10;
#[derive(Default)]
struct PinGuard { per_ip: HashMap<std::net::IpAddr, (u32, std::time::Instant)>, total: u32, rounds: u32, closed_until: Option<std::time::Instant> }
fn pin_guard() -> &'static Mutex<PinGuard> { static G: OnceLock<Mutex<PinGuard>> = OnceLock::new(); G.get_or_init(Default::default) }
/// Pode tentar agora? Err(segundos de espera). A tentativa já conta aqui, antes de conferir o PIN: mil pedidos em
/// paralelo não passam todos pela porta antes do primeiro erro ser anotado (o acerto zera a conta em pin_ok).
fn pin_can_try(ip: Option<std::net::IpAddr>) -> Result<(), u64> {
    let mut g = pin_guard().lock();
    let now = std::time::Instant::now();
    if let Some(t) = g.closed_until { if t > now { return Err((t - now).as_secs() + 1); } g.closed_until = None; }
    if let Some(ip) = ip && let Some((n, since)) = g.per_ip.get(&ip).copied() {
        let wait = std::time::Duration::from_secs(60);
        if since.elapsed() >= wait { g.per_ip.remove(&ip); } else if n >= PIN_PER_IP { return Err((wait - since.elapsed()).as_secs() + 1); }
    }
    // conta a tentativa (no mesmo bloqueio da conferência)
    if let Some(ip) = ip { let e = g.per_ip.entry(ip).or_insert((0, std::time::Instant::now())); e.0 += 1; }
    g.total += 1;
    if g.total.is_multiple_of(PIN_ROUND) {
        g.rounds += 1;
        let secs = (60u64 << (g.rounds - 1).min(6)).min(3600);
        g.closed_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(secs));
        if std::env::var("BLUESCREEN_PIN").is_err() { let pin = new_pin(); log(format!("rede: {} PINs errados; PIN trocado para {pin} e login fechado por {secs} s", g.total)); app().lan.lock().pin = Some(pin); }
        else { log(format!("rede: {} PINs errados; login fechado por {secs} s", g.total)); }
    }
    Ok(())
}
fn pin_ok(ip: Option<std::net::IpAddr>) { let mut g = pin_guard().lock(); if let Some(ip) = ip { g.per_ip.remove(&ip); } g.total = 0; g.rounds = 0; }

pub async fn lan_disable() -> Value {
    { let mut l = app().lan.lock(); if let Some(tx) = l.stop.take() { let _ = tx.send(()); } l.pin = None; }
    app().sessions.lock().clear();
    lan_status()
}

/// Caminho vindo de um pedido que aponta para um compartilhamento de rede ou dispositivo (\\servidor\..., \\?\...,
/// //servidor/...): só de tentar abrir, o Windows manda as credenciais (NTLM) para o outro lado.
pub(crate) fn unc_like(p: &str) -> bool { let b = p.trim_start().as_bytes(); b.len() >= 2 && matches!(b[0], b'\\' | b'/') && matches!(b[1], b'\\' | b'/') }
/// Pela rede, o projeto (e a pasta de projetos) tem de estar dentro da pasta raiz do BlueScreen, com atalhos e
/// junções resolvidos: um celular logado não lê ~/.ssh nem grava fora dali.
fn inside_root(p: &str) -> bool {
    match (std::fs::canonicalize(&app().root), std::fs::canonicalize(p)) { (Ok(r), Ok(t)) => t.starts_with(&r), _ => false }
}
/// conferência dos caminhos da query, para as rotas do núcleo e as dos plugins
fn path_guard(q: &HashMap<String, String>, remote: bool) -> Result<(), &'static str> {
    for k in ["project", "path", "root", "cwd", "start"] { if q.get(k).is_some_and(|v| unc_like(v)) { return Err("caminho de rede (\\\\servidor) não é aceito"); } }
    if remote { for k in ["project", "root"] { if q.get(k).is_some_and(|v| !v.is_empty() && !inside_root(v)) { return Err("pela rede, só projetos dentro da pasta do BlueScreen"); } } }
    Ok(())
}

// ---------- rotas do núcleo ----------
fn project(r: &Req) -> ApiResult<PathBuf> { Ok(PathBuf::from(r.require("project")?)) }
fn in_project(r: &Req, key: &str) -> ApiResult<(PathBuf, PathBuf, String)> {
    let p = project(r)?;
    let rel = r.q_or(key, "").to_string();
    let abs = absolute(&p.join(&rel));
    if !within(&p, &abs) { return Err(fail("fora do projeto", 400)); }
    Ok((p, abs, rel))
}
// caminho relativo que dá para criar no Windows: sem nomes vazios, "..", caracteres proibidos ou ponto/espaço no fim
/// Manda arquivos/pastas para a Lixeira (dá para restaurar). Sem conseguir, devolve o erro: nunca apaga de vez
/// por conta própria. Fora do Windows não há Lixeira comum: remove.
pub(crate) fn to_trash(paths: &[std::path::PathBuf]) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW};
        // lista de caminhos separados por \0 e terminada por \0\0
        let mut from: Vec<u16> = vec![];
        for p in paths { from.extend(p.as_os_str().encode_wide()); from.push(0); }
        from.push(0);
        let mut op = SHFILEOPSTRUCTW {
            hwnd: std::ptr::null_mut(), wFunc: FO_DELETE, pFrom: from.as_ptr(), pTo: std::ptr::null(),
            // FOF_WANTNUKEWARNING: sem Lixeira (rede, pendrive, arquivo grande demais) o Windows pergunta antes de apagar de vez
            fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING) as u16,
            fAnyOperationsAborted: 0, hNameMappings: std::ptr::null_mut(), lpszProgressTitle: std::ptr::null(),
        };
        let code = unsafe { SHFileOperationW(&mut op) };
        if code != 0 { return Err(format!("o Windows recusou (código 0x{code:X}); o arquivo pode estar aberto em outro programa")); }
        if op.fAnyOperationsAborted != 0 { return Err("a exclusão foi cancelada".into()); }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        for p in paths { if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(|e| e.to_string())?; }
        Ok(())
    }
}

fn valid_rel(rel: &str) -> ApiResult<()> {
    if rel.is_empty() { return Err(fail("Dê um nome", 400)); }
    for s in rel.split('/') {
        let bad = s.is_empty() || s == "." || s == ".." || s.ends_with('.') || s.ends_with(' ') || s.chars().any(|c| "\\:*?\"<>|".contains(c) || c.is_control());
        if bad { return Err(fail(format!("Nome inválido: \"{s}\" (não use \\ : * ? \" < > |)"), 400)); }
    }
    Ok(())
}
fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = ApiResult<T>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| fail(e.to_string(), 500)) }
}

fn core_routes() -> HashMap<String, RouteFn> {
    let mut m: HashMap<String, RouteFn> = HashMap::new();
    // rotas do núcleo, por assunto (src/server/*.rs)
    system::add_routes(&mut m);
    network::add_routes(&mut m);
    files::add_routes(&mut m);
    history::add_routes(&mut m);
    sdks::add_routes(&mut m);
    crate::automation::add_routes(&mut m);
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
    // build nativo da IDE
    for (name, f) in crate::build::routes() { add(name, f); }
    // dependências do projeto que ainda não foram baixadas (aviso no canto da tela)
    for (name, f) in crate::deps::routes() { add(name, f); }
    // atualização pelo repositório git de origem
    for (name, f) in crate::update::routes() { add(name, f); }
    for (name, f) in crate::plugins::remote::routes() { add(name, f); }
    // pasta de dados dos plugins e o que eles fariam com um servidor próprio (rodar programas, HTTP)
    for (name, f) in crate::plugins::data::routes() { add(name, f); }
    for (name, f) in crate::plugins::services::routes() { add(name, f); }
    for (name, f) in crate::plugins::vault::routes() { add(name, f); }
    m
}

// (decode_text/encode_text: codificação dos arquivos de texto, em bluescreen_sdk::util — o diff usa as mesmas)
/// o arquivo no disco é o que o editor leu? (data em ms com fração: a ida e volta pelo JSON do navegador pode mexer
/// na última casa, então vale até 1 ms de diferença; o tamanho tem de ser igual)
pub(crate) fn stamp_matches(mtime: f64, size: u64, expect_mtime: f64, expect_size: u64) -> bool { size == expect_size && (mtime - expect_mtime).abs() < 1.0 }
/// Grava num temporário ao lado e troca pelo arquivo: quem lê no meio (ou uma queda de energia) nunca vê o arquivo pela
/// metade. Atalho (symlink) ou troca recusada (arquivo aberto em outro programa, pasta sem permissão): grava direto.
async fn write_replace(p: &Path, data: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let link = tokio::fs::symlink_metadata(p).await.is_ok_and(|m| m.file_type().is_symlink());
    if !link {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = p.with_file_name(format!(".{name}.bs-{:08x}.tmp", rand::random::<u32>()));
        let res = async {
            let mut f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await?;
            f.write_all(data).await?;
            f.sync_all().await?;
            drop(f);
            tokio::fs::rename(&tmp, p).await
        }.await;
        if res.is_ok() { return Ok(()); }
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    tokio::fs::write(p, data).await
}

// ---------- HTTP ----------
/// chaves do preview de HTML: chave -> (projeto, último uso)
fn previews() -> &'static Mutex<HashMap<String, (PathBuf, std::time::Instant)>> { static P: OnceLock<Mutex<HashMap<String, (PathBuf, std::time::Instant)>>> = OnceLock::new(); P.get_or_init(Default::default) }
const PREVIEW_TTL: std::time::Duration = std::time::Duration::from_secs(12 * 3600);
const PREVIEW_MAX: usize = 64;
async fn serve_preview(rest: &str) -> Response {
    let (key, rel) = rest.split_once('/').unwrap_or((rest, ""));
    let root = { let mut m = previews().lock(); m.get_mut(key).filter(|v| v.1.elapsed() < PREVIEW_TTL).map(|v| { v.1 = std::time::Instant::now(); v.0.clone() }) };
    let Some(root) = root else { return bad("preview expirado", 404) };
    let rel = urlencoding::decode(rel).map(|s| s.into_owned()).unwrap_or_default();
    let file = absolute(&root.join(rel.trim_start_matches('/')));
    if !within(&root, &file) { return bad("fora do projeto", 400); }
    match tokio::fs::read(&file).await {
        // HTML/SVG do projeto nunca roda com a origem da IDE: mesmo aberto fora do iframe, a página fica isolada
        Ok(bytes) => ([(header::CONTENT_TYPE, mime(&file)), (header::CACHE_CONTROL, "no-cache"), (header::CONTENT_SECURITY_POLICY, SANDBOX_CSP), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes).into_response(),
        Err(_) => bad("not found", 404),
    }
}
/// conteúdo do projeto servido pela IDE (preview, /api/raw): origem própria e opaca, sem acesso à API
const SANDBOX_CSP: &str = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
/// maior trecho lido de uma vez (Range de vídeo, visualizador hexadecimal)
const MAX_CHUNK: u64 = 4 << 20;
/// "bytes=a-b", "bytes=a-" ou "bytes=-n" -> [início, fim) dentro do arquivo, no máximo MAX_CHUNK
fn parse_range(v: &str, size: u64) -> Option<(u64, u64)> {
    let spec = v.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => { let n: u64 = n.parse().ok()?; (size.saturating_sub(n), size) }
        (a, "") => (a.parse().ok()?, size),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.saturating_add(1).min(size)),
    };
    (start < end).then(|| (start, end.min(start + MAX_CHUNK)))
}
/// o arquivo em pedaços de 64 KB, para a resposta
async fn stream_file(p: &Path) -> std::io::Result<Body> {
    use tokio::io::AsyncReadExt;
    let f = tokio::fs::File::open(p).await?;
    let s = futures_util::stream::unfold(Some(f), |f| async move {
        let mut f = f?;
        let mut buf = vec![0u8; 64 * 1024];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => { buf.truncate(n); Some((Ok::<_, std::io::Error>(bytes::Bytes::from(buf)), Some(f))) }
            Err(e) => Some((Err(e), None)),
        }
    });
    Ok(Body::from_stream(s))
}
async fn read_slice(p: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = tokio::fs::File::open(p).await?;
    if start > 0 { f.seek(std::io::SeekFrom::Start(start)).await?; }
    let mut buf = Vec::with_capacity((end - start) as usize);
    f.take(end - start).read_to_end(&mut buf).await?;
    Ok(buf)
}
fn bad(msg: &str, code: u16) -> Response { json_resp(code, &json!({ "error": msg })) }
fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8", "mjs" => "text/javascript; charset=utf-8", "txt" | "md" => "text/plain; charset=utf-8", "xml" => "application/xml",
        "mp4" | "m4v" => "video/mp4", "webm" => "video/webm", "ogv" => "video/ogg", "mov" => "video/quicktime", "mp3" => "audio/mpeg", "wav" => "audio/wav", "ogg" | "opus" | "oga" => "audio/ogg", "flac" => "audio/flac", "m4a" => "audio/mp4", "aac" => "audio/aac", "bmp" => "image/bmp", "pdf" => "application/pdf", "avif" => "image/avif", "otf" => "font/otf", "js" => "text/javascript; charset=utf-8", "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "ico" => "image/x-icon", "json" => "application/json",
        "woff2" => "font/woff2", "woff" => "font/woff", "ttf" => "font/ttf", "map" => "application/json", _ => "application/octet-stream",
    }
}
fn cookie(req: &Request<Body>, name: &str) -> Option<String> {
    req.headers().get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';'))
        .filter_map(|c| c.split_once('=')).find(|(k, _)| k.trim() == name).map(|(_, v)| urlencoding::decode(v.trim()).map(|s| s.into_owned()).unwrap_or_default())
}

pub fn router(remote: bool) -> axum::Router {
    axum::Router::new().fallback(move |req: Request<Body>| guarded(req, remote))
}
/// Um erro interno (panic) numa rota não derruba a IDE: o pedido responde 500 e o caso vai para o log (o gancho de
/// main.rs já anotou onde foi). As outras rotas, abas e plugins seguem normalmente.
async fn guarded(req: Request<Body>, remote: bool) -> Response {
    use futures_util::FutureExt;
    let what = format!("{} {}", req.method(), req.uri().path());
    match std::panic::AssertUnwindSafe(handle(req, remote)).catch_unwind().await {
        Ok(r) => r,
        Err(p) => {
            let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
            log(format!("rota {what} falhou com erro interno: {msg}"));
            bad(&format!("erro interno do BlueScreen em {what}: {msg} (detalhes em ~/.bluescreen/bluescreen.log)"), 500)
        }
    }
}

// ---------- porteiro: Host e Origin ----------
// Qualquer página aberta no navegador consegue mandar pedidos para 127.0.0.1 (POST "simples", <img>, <form>), e um
// nome de DNS que passa a apontar para cá (DNS rebinding) faz o navegador achar que é o mesmo site. Por isso o Host
// tem de ser um endereço fixo desta máquina e, vindo de um navegador, o pedido tem de sair da própria página.
/// "127.0.0.1:4747" -> ("127.0.0.1", 4747); sem porta, 80. IPv6 entre colchetes: "[::1]:4747".
fn split_host(host: &str) -> Option<(&str, u16)> {
    let host = host.trim();
    let (h, rest) = if host.starts_with('[') { let i = host.find(']')?; (&host[..=i], &host[i + 1..]) } else { match host.find(':') { Some(i) => (&host[..i], &host[i..]), None => (host, "") } };
    let port = if rest.is_empty() { 80 } else { rest.strip_prefix(':')?.parse().ok()? };
    Some((h, port))
}
/// Host aceito: no PC local, só 127.0.0.1 / localhost / [::1] na porta deste servidor; pela rede, um IP escrito
/// (nunca um nome) na porta da rede. A lista é fixa: não vale o que o cliente mandar.
pub(crate) fn host_ok(host: &str, remote: bool, port: u16) -> bool {
    let Some((h, p)) = split_host(host) else { return false };
    if p != port || p == 0 { return false; }
    let h = h.to_ascii_lowercase();
    if !remote { return matches!(h.as_str(), "127.0.0.1" | "localhost" | "[::1]"); }
    h.parse::<std::net::Ipv4Addr>().is_ok() || h.strip_prefix('[').and_then(|x| x.strip_suffix(']')).is_some_and(|x| x.parse::<std::net::Ipv6Addr>().is_ok())
}
/// Pedido de navegador vindo de outra página (outro site, outra porta, iframe isolado do preview, Origin "null"):
/// recusado. Sem Origin e sem Sec-Fetch-Site é um programa (plugins, SDK, outra instância), não uma página.
pub(crate) fn origin_ok(h: &axum::http::HeaderMap, host: &str) -> bool {
    if let Some(o) = h.get(header::ORIGIN) && !o.to_str().is_ok_and(|o| o.eq_ignore_ascii_case(&format!("http://{host}"))) { return false; }
    !matches!(h.get("sec-fetch-site").and_then(|v| v.to_str().ok()), Some("cross-site" | "same-site"))
}
/// porta em que o pedido chegou: a da janela (ou do --doc) ou a da rede local
fn listen_port(remote: bool) -> u16 { if remote { app().lan.lock().port } else { app().port } }
fn host_of(h: &axum::http::HeaderMap) -> &str { h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("") }
/// WebSocket não passa por CORS: só a própria página (Origin obrigatório e igual ao Host, que tem de estar na lista).
/// Terminal, servidores de linguagem e espelho usam esta mesma conferência.
pub(crate) fn ws_origin_ok(h: &axum::http::HeaderMap, remote: bool) -> bool {
    let host = host_of(h);
    host_ok(host, remote, listen_port(remote)) && h.get(header::ORIGIN).is_some() && origin_ok(h, host)
}

async fn handle(req: Request<Body>, remote: bool) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let host_hdr = host_of(req.headers()).to_string();
    if !host_ok(&host_hdr, remote, listen_port(remote)) { return bad("endereço não permitido: abra pelo endereço que o BlueScreen mostra (IP e porta)", 403); }
    // arquivos do preview de HTML: liberados pela chave (vale para a rede local também). O iframe isolado tem origem
    // "null" e o navegador marca os pedidos dele como cross-site, por isso o preview fica antes da conferência de Origin.
    if let Some(rest) = path.strip_prefix("/api/preview/") { return serve_preview(rest).await; }
    // a API só atende a própria página (ou um programa: plugins e SDK mandam o token e nenhum Origin)
    if path.starts_with("/api/") {
        let token = !remote && req.headers().get(bluescreen_sdk::plugin::H_TOKEN).and_then(|v| v.to_str().ok()) == Some(bluescreen_sdk::plugin::core().token());
        if !token && !origin_ok(req.headers(), &host_hdr) { return bad("origem não permitida", 403); }
    }
    // --- autenticação só para acessos pela rede ---
    if remote {
        if path == "/api/login" && method == Method::POST {
            let ip = req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip());
            if let Err(s) = pin_can_try(ip) { return bad(&format!("Muitas tentativas. Tente de novo em {s} s."), 429); }
            let body = axum::body::to_bytes(req.into_body(), 64 * 1024).await.unwrap_or_default();
            let pin = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["pin"].as_str().map(String::from)).unwrap_or_default();
            if Some(pin) != app().lan.lock().pin {
                // a tentativa já foi contada em pin_can_try; cada erro ainda custa um segundo
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                return bad("PIN incorreto", 401);
            }
            pin_ok(ip);
            let hex = |n: usize| -> String { (0..n).map(|_| format!("{:x}", rand::random_range(0..16u8))).collect() };
            let sid = hex(48);
            let now = now_ms();
            { let mut s = app().sessions.lock(); s.retain(|_, x| x.at.elapsed() < SESSION_TTL); s.insert(sid.clone(), Session { id: hex(10), ip, at: std::time::Instant::now(), since_ms: now, last_ms: now }); }
            log(format!("rede: aparelho entrou com o PIN ({})", ip.map(|i| i.to_string()).unwrap_or_default()));
            let mut r = json_resp(200, &json!({ "ok": true }));
            r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&format!("bs_sid={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400")).unwrap());
            return r;
        }
        // a sessão vale só do mesmo IP que fez o login (um cookie copiado para outro aparelho não entra) e marca o
        // último acesso, que a lista de aparelhos mostra
        let ip = req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip());
        let authed = cookie(&req, "bs_sid").is_some_and(|s| {
            let mut m = app().sessions.lock();
            match m.get_mut(&s) {
                Some(x) if x.at.elapsed() < SESSION_TTL && x.ip == ip => { x.last_ms = now_ms(); true }
                _ => false,
            }
        });
        if path.starts_with("/api/") {
            if path == "/api/session" { return json_resp(200, &json!({ "remote": true, "authed": authed })); }
            // o Endpoint HTTP do Automator é chamado por outros programas e aparelhos, que não têm como digitar o PIN:
            // a rota confere se o fluxo aceita a rede ("A rede local também") e os nós de Segurança fazem o resto
            if !authed && path != "/api/automator/hook" { return bad("login necessário", 401); }
        }
    }
    // script de um plugin (ui.js + style.css num arquivo só)
    if let Some(id) = path.strip_prefix("/plugins/").and_then(|p| p.strip_suffix(".js")) {
        return match host().bundle(id) {
            Some(b) => ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], b).into_response(),
            None => bad("plugin sem interface ou desligado", 404),
        };
    }
    if !path.starts_with("/api/") { return serve_static(&path).await; }
    if let Err(e) = path_guard(&parse_query(req.uri().query()), remote) { return bad(e, 403); }
    if path == "/api/rpc/ws" { let q = parse_query(req.uri().query()); return crate::rpc::ws(req, remote, q).await; }
    if path == "/api/mirror/ws" { return crate::share::mirror_ws(req, remote).await; }
    if path == "/api/terminal/ws" { let q = parse_query(req.uri().query()); return crate::terminal::ws(req, remote, q).await; }
    let name = path[5..].to_string();
    // o registro não fica preso durante a rota: instalar/atualizar um plugin troca o registro e precisa que o antigo
    // saia (é ele que encerra o server.exe e solta o arquivo)
    // rota do núcleo ganha de rota anunciada por plugin (um plugin não troca file, plugins, vault...)
    let handler = host().core().get(&name).cloned().or_else(|| host().get().routes.get(&name).cloned());
    let Some(handler) = handler else { return bad("rota desconhecida", 404) };
    let (mut parts, body) = req.into_parts();
    if name == "automator/hook" {
        // quem chamou e o endereço inteiro, para o fluxo: vão em cabeçalhos do próprio núcleo (o que vier de fora
        // com esses nomes é trocado)
        let ip = parts.extensions.get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip().to_string()).unwrap_or_else(|| "127.0.0.1".into());
        let url = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
        for (k, v) in [("x-bluescreen-ip", ip), ("x-bluescreen-url", url)] { if let Ok(v) = HeaderValue::from_str(&v) { parts.headers.insert(k, v); } else { parts.headers.remove(k); } }
    }
    let body = match axum::body::to_bytes(body, 256 * 1024 * 1024).await { Ok(b) => b, Err(e) => return bad(&e.to_string(), 413) };
    let internal = !remote && parts.headers.get(bluescreen_sdk::plugin::H_TOKEN).and_then(|v| v.to_str().ok()) == Some(bluescreen_sdk::plugin::core().token());
    let r = Arc::new(Req { query: parse_query(parts.uri.query()), method: parts.method, headers: parts.headers, body, remote, internal });
    match handler(r.clone()).await {
        Ok(Reply::Raw(resp)) => resp,
        Ok(Reply::Json(v)) => json_resp(200, &v),
        Err(e) => bad(&e.msg, e.status),
    }
}

async fn serve_static(path: &str) -> Response {
    let base = app_dir().join("wwwroot");
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    let rel = urlencoding::decode(rel).map(|s| s.into_owned()).unwrap_or_default();
    let file = absolute(&base.join(&rel));
    if !within(&base, &file) { return bad("not found", 404); }
    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            // bibliotecas (Monaco, fontes) não mudam: cache longo; o resto sempre revalida
            let cache = if rel.starts_with("vendor/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            ([(header::CONTENT_TYPE, mime(&file)), (header::CACHE_CONTROL, cache)], bytes).into_response()
        }
        Err(_) => bad("not found", 404),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;
    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 100)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 1000)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 1000)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 1000)));
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("bytes=0-", 100 << 20), Some((0, 4 << 20)));
    }
    #[test]
    fn codificacao() {
        use crate::util::{decode_text, encode_text};
        // Windows-1252: lê e grava os mesmos bytes, inclusive os que não têm letra
        let cp: Vec<u8> = (0u8..=255).filter(|b| *b != 0).collect();
        let (t, enc, bom) = decode_text(&cp);
        assert_eq!((enc, bom), ("windows-1252", false));
        assert_eq!(encode_text(&t, enc, bom).unwrap(), cp);
        assert_eq!(decode_text(b"a\xE7\xE3o \x80").0, "ação €");
        assert_eq!(encode_text("ação €", "windows-1252", false).unwrap(), b"a\xE7\xE3o \x80");
        assert_eq!(encode_text("日本", "windows-1252", false), Err('日'));
        // UTF-8 com BOM: o BOM sai do texto e volta ao gravar
        let (t, enc, bom) = decode_text("\u{FEFF}olá".as_bytes());
        assert_eq!((t.as_str(), enc, bom), ("olá", "utf-8", true));
        assert_eq!(encode_text(&t, enc, bom).unwrap(), "\u{FEFF}olá".as_bytes());
        assert_eq!(decode_text("olá".as_bytes()), ("olá".to_string(), "utf-8", false));
    }
    #[test]
    fn limite_do_pin() {
        use super::{PinGuard, pin_can_try, pin_guard, pin_ok};
        *pin_guard().lock() = PinGuard::default();
        let ip: std::net::IpAddr = "192.168.0.50".parse().unwrap();
        // 5 tentativas por minuto por IP; a 6ª espera
        for _ in 0..super::PIN_PER_IP { assert!(pin_can_try(Some(ip)).is_ok()); }
        let wait = pin_can_try(Some(ip)).unwrap_err();
        assert!((1..=61).contains(&wait), "{wait}");
        // outro IP ainda pode
        assert!(pin_can_try(Some("192.168.0.51".parse().unwrap())).is_ok());
        // acertar zera a conta do IP
        pin_ok(Some(ip));
        assert!(pin_can_try(Some(ip)).is_ok());
        *pin_guard().lock() = PinGuard::default();
    }
    #[test]
    fn data_lida_e_a_do_disco() {
        use super::stamp_matches;
        assert!(stamp_matches(1700000000123.456, 10, 1700000000123.456, 10));
        assert!(stamp_matches(1700000000123.456, 10, 1700000000123.4, 10)); // arredondado na ida e volta
        assert!(!stamp_matches(1700000000123.456, 10, 1700000000125.0, 10));
        assert!(!stamp_matches(1700000000123.456, 11, 1700000000123.456, 10));
    }
    #[test]
    fn porteiro_host() {
        use super::host_ok;
        assert!(host_ok("127.0.0.1:4747", false, 4747));
        assert!(host_ok("localhost:4747", false, 4747));
        assert!(host_ok("LOCALHOST:4747", false, 4747));
        assert!(host_ok("[::1]:4747", false, 4747));
        assert!(!host_ok("127.0.0.1:4748", false, 4747));
        assert!(!host_ok("evil.com:4747", false, 4747)); // DNS rebinding
        assert!(!host_ok("127.0.0.1.nip.io:4747", false, 4747));
        assert!(!host_ok("", false, 4747));
        assert!(!host_ok("127.0.0.1:4747x", false, 4747));
        assert!(!host_ok("192.168.0.10:4747", false, 4747));
        assert!(host_ok("127.0.0.1", false, 80));
        // rede local: IP escrito, nunca nome
        assert!(host_ok("192.168.0.10:4748", true, 4748));
        assert!(host_ok("[fe80::1]:4748", true, 4748));
        assert!(!host_ok("meupc.local:4748", true, 4748));
        assert!(!host_ok("evil.com:4748", true, 4748));
        assert!(!host_ok("192.168.0.10:4747", true, 4748));
    }
    #[test]
    fn porteiro_origin() {
        use super::origin_ok;
        use axum::http::{HeaderMap, HeaderValue};
        let h = |o: Option<&'static str>, s: Option<&'static str>| { let mut m = HeaderMap::new(); if let Some(o) = o { m.insert("origin", HeaderValue::from_static(o)); } if let Some(s) = s { m.insert("sec-fetch-site", HeaderValue::from_static(s)); } m };
        let host = "127.0.0.1:4747";
        assert!(origin_ok(&h(None, None), host)); // programa (plugin, SDK, outra instância)
        assert!(origin_ok(&h(Some("http://127.0.0.1:4747"), Some("same-origin")), host));
        assert!(origin_ok(&h(None, Some("same-origin")), host));
        assert!(origin_ok(&h(None, Some("none")), host)); // endereço digitado
        assert!(!origin_ok(&h(Some("http://evil.com"), None), host));
        assert!(!origin_ok(&h(Some("http://127.0.0.1:5173"), Some("same-site")), host));
        assert!(!origin_ok(&h(Some("null"), Some("cross-site")), host));
        assert!(!origin_ok(&h(None, Some("cross-site")), host)); // <img>, <form> GET
        assert!(!origin_ok(&h(Some("http://127.0.0.1:4747.evil.com"), None), host));
    }
}
