//! O nó Navegador do Automator: abre o Edge (ou o Chrome) num perfil próprio e conversa com ele pelo protocolo de
//! depuração (CDP), sem programa nenhum no meio. A janela pertence à execução do fluxo: o primeiro nó Navegador
//! abre, os seguintes continuam na mesma página (dá para entrar num site num nó, repetir uma ação por item em
//! outro, dentro de um laço, e ler o resultado num terceiro) e, quando a execução termina, a janela fecha.
//! O gravador de passos (`record`) usa a mesma conexão: a pessoa usa o site e cada ação vira uma linha do roteiro.
use super::{number_of, stringify, text_of};
use crate::util::*;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

pub(super) fn catalog() -> Value {
    // (ação, nome, grupo): o grupo dá a cor da etiqueta na lista de passos
    let actions: Vec<Value> = [("click", "Clicar", "act"), ("type", "Digitar", "act"), ("select", "Escolher opção", "act"), ("check", "Marcar ou desmarcar", "act"), ("key", "Apertar tecla", "act"), ("hover", "Passar o mouse", "act"),
        ("upload", "Enviar arquivo", "act"), ("scroll", "Rolar a página", "act"), ("goto", "Ir para endereço", "act"), ("back", "Voltar uma página", "act"), ("tab", "Ir para a aba que abriu", "act"), ("js", "Rodar JavaScript", "act"),
        ("read", "Ler campo (devolver)", "read"), ("list", "Ler todos (lista)", "read"), ("shot", "Capturar tela", "read"),
        ("wait", "Esperar aparecer", "wait"), ("gone", "Esperar sumir", "wait"), ("sleep", "Esperar (segundos)", "wait"),
        ("text", "Conferir texto", "check"), ("see", "Conferir que aparece", "check"), ("url", "Conferir endereço", "check"), ("title", "Conferir título", "check"), ("count", "Conferir quantidade", "check")]
        .iter().map(|(v, l, t)| json!({"value": v, "label": l, "tone": t})).collect();
    json!([
        {"type":"browser.run","name":"Navegador","category":"Navegador","desc":"Abre um site e faz por você: clica, digita, lê, confere. Os nós Navegador de um fluxo continuam na mesma página, do começo ao fim.","inputs":["in"],"outputs":["out"],
         "params":{"url":"","steps":[],"show":"yes","profile":"keep","device":"desktop","after":"close","wait_s":15},
         "fields":[
            {"name":"url","label":"Endereço","kind":"text","placeholder":"https://… (vazio: continua na página em que o nó anterior parou)"},
            {"name":"steps","label":"Passos","kind":"rows","add":"Passo","recorder":true,
             "help":"Gravar abre o site: use ele normalmente e cada ação vira um passo. Onde: um seletor CSS (#senha, .botao) ou texto=Entrar para achar pelo texto. Em Ler campo, o valor é o nome do campo na saída. Senhas: {{cred:nome}}, guardadas em Credenciais.",
             "columns":[
                {"name":"do","kind":"select","options":actions},
                {"name":"on","placeholder":"Onde: #id ou texto=Entrar","hide":{"do":["key","goto","sleep","shot","url","title","back","tab"]}},
                {"name":"value","placeholder":"Valor","hide":{"do":["click","wait","see","gone","hover","back","tab"]}}
             ]},
            {"name":"show","label":"Janela do navegador","kind":"select","options":[{"value":"yes","label":"Mostrar"},{"value":"no","label":"Não mostrar"}]},
            {"name":"profile","label":"Sessão","kind":"select","options":[{"value":"keep","label":"Lembrar dos logins entre as execuções"},{"value":"clean","label":"Começar sempre do zero (sem cookies)"}],"help":"Vale o que o primeiro nó Navegador do fluxo pedir."},
            {"name":"device","label":"Tela","kind":"select","options":[{"value":"desktop","label":"Computador (1280 × 900)"},{"value":"wide","label":"Monitor grande (1920 × 1080)"},{"value":"tablet","label":"Tablet (820 × 1180)"},{"value":"phone","label":"Celular (390 × 844)"}]},
            {"name":"after","label":"Quando o fluxo terminar","kind":"select","show":{"show":["yes"]},"options":[{"value":"close","label":"Fechar o navegador"},{"value":"keep","label":"Deixar aberto"}]},
            {"name":"wait_s","label":"Esperar cada elemento por até (segundos)","kind":"number","min":1,"max":300}
         ],
         "record":{"core":true}}
    ])
}
pub(super) fn io_doc(kind: &str) -> Option<(&'static str, &'static str, Value)> {
    (kind == "browser.run").then(|| ("Qualquer dado, para usar no endereço e nos passos com {{input}}.",
        "Objeto com o endereço final, o título da página e o que os passos Ler campo e Ler todos guardaram (em values).",
        json!({"url": "https://exemplo.com/conta", "title": "Minha conta", "values": {"saldo": "R$ 120,00"}})))
}

// Procura o elemento na página. "texto=Entrar" acha pelo texto visível (botões e links primeiro); o resto é seletor CSS.
const FIND: &str = r#"(sel) => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const m = /^texto\s*=\s*(.+)$/i.exec(sel);
  if (!m) { const list = [...document.querySelectorAll(sel)]; return list.find(seen) || list[0] || null; }
  const want = m[1].trim().toLowerCase();
  const label = (e) => [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title'), e.getAttribute('name')].filter(x => typeof x === 'string').map(x => x.trim().replace(/\s+/g, ' ').toLowerCase());
  const groups = ['button, a, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], [role=menuitem]', 'input, textarea, select, label, summary', 'h1, h2, h3, h4, li, td, th, span, p, div'];
  for (const exact of [true, false]) for (const g of groups) {
    const hit = [...document.querySelectorAll(g)].filter(seen).filter(e => label(e).some(t => exact ? t === want : t.includes(want)));
    if (hit.length) return hit.sort((a, b) => a.innerText.length - b.innerText.length)[0];
  }
  return null;
}"#;
const TEXT_OF: &str = "String('value' in el && el.value !== undefined && el.tagName !== 'LI' ? el.value : el.innerText || el.textContent || '').trim()";
const RECORDER: &str = include_str!("recorder.js");
/// tecla -> (key, código, texto que ela digita)
fn key_of(name: &str) -> Option<(&'static str, u32, &'static str)> {
    Some(match name.trim().to_lowercase().as_str() {
        "enter" => ("Enter", 13, "\r"), "tab" => ("Tab", 9, ""), "escape" | "esc" => ("Escape", 27, ""), "backspace" => ("Backspace", 8, ""), "delete" => ("Delete", 46, ""),
        "espaco" | "espaço" | "space" => (" ", 32, " "), "arrowdown" | "baixo" => ("ArrowDown", 40, ""), "arrowup" | "cima" => ("ArrowUp", 38, ""),
        "arrowleft" | "esquerda" => ("ArrowLeft", 37, ""), "arrowright" | "direita" => ("ArrowRight", 39, ""), "pagedown" => ("PageDown", 34, ""), "pageup" => ("PageUp", 33, ""), "home" => ("Home", 36, ""), "end" => ("End", 35, ""),
        _ => return None,
    })
}
fn action_name(k: &str) -> &'static str {
    match k { "goto" => "Ir para", "click" => "Clicar", "type" => "Digitar", "wait" => "Esperar aparecer", "read" => "Ler campo", "list" => "Ler todos", "key" => "Apertar tecla", "sleep" => "Esperar", "shot" => "Capturar tela",
        "select" => "Escolher opção", "check" => "Marcar ou desmarcar", "hover" => "Passar o mouse", "upload" => "Enviar arquivo", "scroll" => "Rolar a página", "back" => "Voltar", "tab" => "Ir para a aba que abriu", "js" => "Rodar JavaScript",
        "see" => "Conferir que aparece", "gone" => "Esperar sumir", "text" => "Conferir texto", "url" => "Conferir endereço", "title" => "Conferir título", "count" => "Conferir quantidade", _ => "Passo" }
}
fn device(name: &str) -> (u32, u32, bool) { match name { "wide" => (1920, 1080, false), "tablet" => (820, 1180, true), "phone" => (390, 844, true), _ => (1280, 900, false) } }
fn find_browser() -> Option<PathBuf> {
    let roots: Vec<PathBuf> = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(|k| std::env::var_os(k).map(PathBuf::from)).collect();
    ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe"].iter().flat_map(|n| roots.iter().map(move |r| r.join(n))).find(|p| p.is_file())
}
/// Onde ficam o perfil do navegador (cookies, logins) e as telas capturadas nas falhas.
fn data_dir() -> PathBuf { super::file().parent().map(PathBuf::from).unwrap_or_default().join("automator-navegador") }
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(5)).no_proxy().build().unwrap_or_default());
fn closed() -> ApiError { fail("o navegador foi fechado no meio do caminho", 409) }

// ---------- a conversa com uma aba ----------
type Waiting = Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>>;
struct Cdp { tx: tokio::sync::mpsc::UnboundedSender<String>, waiting: Waiting, events: tokio::sync::broadcast::Sender<Value>, seq: AtomicU64, open: Arc<AtomicBool> }
impl Cdp {
    async fn connect(url: &str) -> ApiResult<Arc<Cdp>> {
        let (ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| fail(format!("não deu para falar com o navegador: {e}"), 502))?;
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (events, _) = tokio::sync::broadcast::channel(256);
        let waiting: Waiting = Default::default();
        let open = Arc::new(AtomicBool::new(true));
        tokio::spawn(async move { while let Some(m) = rx.recv().await { if sink.send(tokio_tungstenite::tungstenite::Message::Text(m.into())).await.is_err() { break; } } let _ = sink.close().await; });
        let (w, ev, alive) = (waiting.clone(), events.clone(), open.clone());
        tokio::spawn(async move {
            while let Some(Ok(m)) = stream.next().await {
                let Ok(text) = m.to_text() else { continue };
                let Ok(v) = serde_json::from_str::<Value>(text) else { continue };
                if let Some(id) = v["id"].as_u64() {
                    if let Some(tx) = w.lock().remove(&id) { let _ = tx.send(if v["error"].is_null() { Ok(v["result"].clone()) } else { Err(v["error"]["message"].as_str().unwrap_or("erro do navegador").to_string()) }); }
                } else if v["method"].is_string() { let _ = ev.send(v); }
            }
            alive.store(false, Ordering::Relaxed);
            w.lock().clear();
        });
        Ok(Arc::new(Cdp { tx, waiting, events, seq: AtomicU64::new(0), open }))
    }
    async fn send(&self, method: &str, params: Value) -> ApiResult<Value> {
        if !self.open.load(Ordering::Relaxed) { return Err(closed()); }
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.waiting.lock().insert(id, tx);
        self.tx.send(json!({"id": id, "method": method, "params": params}).to_string()).map_err(|_| closed())?;
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(m))) => Err(fail(m, 422)),
            Ok(Err(_)) => Err(closed()),
            Err(_) => { self.waiting.lock().remove(&id); Err(fail("o navegador não respondeu", 504)) }
        }
    }
    /// Roda JavaScript na página e devolve o valor.
    async fn eval(&self, expression: &str) -> ApiResult<Value> {
        let r = self.send("Runtime.evaluate", json!({"expression": expression, "awaitPromise": true, "returnByValue": true})).await?;
        if !r["exceptionDetails"].is_null() {
            let d = &r["exceptionDetails"];
            return Err(fail(d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or("erro na página").lines().next().unwrap_or("").to_string(), 422));
        }
        Ok(r["result"]["value"].clone())
    }
    /// Acha o elemento e roda `body` com ele em `el`. Sem elemento: `{ missing: true }`.
    async fn call(&self, sel: &str, body: &str) -> ApiResult<Value> {
        self.eval(&format!("(() => {{ const el = ({FIND})({}); if (!el) return {{ missing: true }}; {body} }})()", json!(sel))).await
    }
    async fn goto(&self, to: &str) -> ApiResult<()> {
        static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap());
        let to = to.trim();
        if to.is_empty() { return Err(fail("diga o endereço", 400)); }
        let to = if SCHEME.is_match(to) { to.to_string() } else { format!("https://{to}") };
        let mut ev = self.events.subscribe();
        let r = self.send("Page.navigate", json!({"url": to})).await?;
        if let Some(e) = r["errorText"].as_str().filter(|e| !e.is_empty()) { return Err(fail(format!("o endereço não abriu ({e})"), 422)); }
        let loaded = async { loop { match ev.recv().await { Ok(v) if v["method"] == "Page.loadEventFired" => break, Err(tokio::sync::broadcast::error::RecvError::Closed) => break, _ => {} } } };
        let _ = tokio::time::timeout(Duration::from_secs(30), loaded).await;
        Ok(())
    }
    /// Depois de um clique ou de uma tecla: dá tempo de a página reagir (ou trocar) antes do próximo passo.
    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(350)).await;
        for _ in 0..40 { if self.eval("document.readyState").await.is_ok_and(|v| v != "loading") { return; } tokio::time::sleep(Duration::from_millis(150)).await; }
    }
    async fn shot(&self) -> ApiResult<Vec<u8>> {
        let r = self.send("Page.captureScreenshot", json!({"format": "png"})).await?;
        base64::engine::general_purpose::STANDARD.decode(r["data"].as_str().unwrap_or("")).map_err(|_| fail("o navegador não entregou a imagem", 500))
    }
}

// ---------- abrir o navegador ----------
async fn alive(port: u16) -> bool { HTTP.get(format!("http://127.0.0.1:{port}/json/version")).send().await.is_ok_and(|r| r.status().is_success()) }
/// Abre o navegador naquele perfil (ou aproveita o que já está aberto nele) e devolve a porta de controle.
async fn launch(profile: &Path, hidden: bool, size: (u32, u32)) -> ApiResult<u16> {
    std::fs::create_dir_all(profile)?;
    let port_file = profile.join("DevToolsActivePort");
    let read_port = || std::fs::read_to_string(&port_file).ok().and_then(|t| t.lines().next().and_then(|l| l.trim().parse::<u16>().ok())).filter(|p| *p > 0);
    // janela deixada aberta por uma execução anterior: aproveita (o perfil só aceita um navegador por vez)
    if let Some(p) = read_port() && alive(p).await { return Ok(p); }
    let _ = std::fs::remove_file(&port_file);
    let exe = find_browser().ok_or_else(|| fail("não achei o Microsoft Edge nem o Google Chrome neste PC", 404))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(format!("--user-data-dir={}", profile.display())).args(["--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen"]).arg(format!("--window-size={},{}", size.0, size.1));
    if hidden { cmd.arg("--headless=new"); }
    cmd.arg("about:blank").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| fail(format!("não deu para abrir o navegador: {e}"), 500))?;
    for _ in 0..120 {
        if let Some(p) = read_port() && alive(p).await { return Ok(p); }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err(fail("o navegador não abriu a porta de controle. Feche as janelas dele abertas pelo Automator e tente de novo.", 500))
}
async fn pages(port: u16) -> Vec<Value> {
    let Ok(r) = HTTP.get(format!("http://127.0.0.1:{port}/json")).send().await else { return vec![] };
    r.json::<Vec<Value>>().await.unwrap_or_default().into_iter().filter(|t| t["type"] == "page").collect()
}
async fn attach(ws: &str) -> ApiResult<Arc<Cdp>> {
    let cdp = Cdp::connect(ws).await?;
    cdp.send("Page.enable", json!({})).await?;
    cdp.send("Runtime.enable", json!({})).await?;
    Ok(cdp)
}
async fn new_tab(port: u16) -> ApiResult<(Arc<Cdp>, String)> {
    let t: Value = HTTP.put(format!("http://127.0.0.1:{port}/json/new?about:blank")).send().await.map_err(|_| closed())?.json().await.map_err(|_| closed())?;
    let ws = t["webSocketDebuggerUrl"].as_str().ok_or_else(|| fail("o navegador não abriu uma aba nova", 500))?;
    Ok((attach(ws).await?, t["id"].as_str().unwrap_or("").to_string()))
}

/// O navegador de uma execução do fluxo.
struct Session { port: u16, hidden: bool, clean: Option<PathBuf>, cdp: Mutex<Arc<Cdp>>, target: Mutex<String>, keep: AtomicBool }
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(Default::default);
impl Session {
    async fn open(p: &Value) -> ApiResult<Session> {
        let hidden = p["show"] == "no";
        let clean = (p["profile"] == "clean").then(|| std::env::temp_dir().join(format!("bluescreen-navegador-{}", super::id())));
        let profile = clean.clone().unwrap_or_else(|| data_dir().join(if hidden { "perfil-oculto" } else { "perfil" }));
        let dev = device(p["device"].as_str().unwrap_or("desktop"));
        let port = launch(&profile, hidden, (dev.0, dev.1)).await?;
        let (cdp, target) = new_tab(port).await?;
        if p["device"].as_str().is_some_and(|d| d != "desktop") {
            let _ = cdp.send("Emulation.setDeviceMetricsOverride", json!({"width": dev.0, "height": dev.1, "deviceScaleFactor": if dev.2 { 2 } else { 1 }, "mobile": dev.2})).await;
        }
        let _ = cdp.send("Page.bringToFront", json!({})).await;
        Ok(Session { port, hidden, clean, cdp: Mutex::new(cdp), target: Mutex::new(target), keep: AtomicBool::new(false) })
    }
    fn cdp(&self) -> Arc<Cdp> { self.cdp.lock().clone() }
    /// Fim da execução: a aba fecha; se não sobrou outra página aberta no perfil, o navegador fecha junto.
    async fn end(&self) {
        let cdp = self.cdp();
        if self.keep.load(Ordering::Relaxed) && !self.hidden && self.clean.is_none() { return; }
        let mine = self.target.lock().clone();
        let others = pages(self.port).await.into_iter().filter(|t| t["id"] != mine.as_str() && !matches!(t["url"].as_str().unwrap_or(""), "about:blank" | "edge://newtab/" | "chrome://newtab/")).count();
        if others == 0 || self.clean.is_some() {
            let _ = tokio::time::timeout(Duration::from_secs(2), cdp.send("Browser.close", json!({}))).await;
        } else {
            let _ = HTTP.get(format!("http://127.0.0.1:{}/json/close/{mine}", self.port)).send().await;
        }
        if let Some(dir) = self.clean.clone() {
            tokio::spawn(async move { for _ in 0..10 { tokio::time::sleep(Duration::from_millis(700)).await; if std::fs::remove_dir_all(&dir).is_ok() { break; } } });
        }
    }
}
/// A execução terminou: fecha (ou deixa aberto, se o nó pediu) o navegador que ela abriu.
pub(super) async fn finish(rid: &str) {
    let s = SESSIONS.lock().remove(rid);
    if let Some(s) = s { s.end().await; }
}

// ---------- os passos ----------
struct Steps { cdp: Arc<Cdp>, wait: Duration, values: serde_json::Map<String, Value> }
impl Steps {
    async fn appear(&self, sel: &str) -> ApiResult<()> {
        if sel.is_empty() { return Err(fail("diga onde (um seletor, ou texto=...)", 400)); }
        let end = Instant::now() + self.wait;
        loop {
            // a página pode trocar no meio (um clique que navega): erro de contexto é só "ainda não"
            if self.cdp.call(sel, "const b = el.getBoundingClientRect(); return { ok: b.width > 0 && b.height > 0 };").await.is_ok_and(|r| r["ok"] == true) { return Ok(()); }
            if !self.cdp.open.load(Ordering::Relaxed) { return Err(closed()); }
            if Instant::now() > end { return Err(fail(format!("não apareceu em {} s", self.wait.as_secs()), 408)); }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    /// Repete a leitura até `ok` valer ou o tempo acabar; devolve o que viu por último e se valeu.
    async fn until(&self, expr: &str, ok: impl Fn(&Value) -> bool) -> ApiResult<(Value, bool)> {
        let end = Instant::now() + self.wait;
        let mut seen = Value::Null;
        loop {
            if let Ok(v) = self.cdp.eval(expr).await { if ok(&v) { return Ok((v, true)); } seen = v; }
            if !self.cdp.open.load(Ordering::Relaxed) { return Err(closed()); }
            if Instant::now() > end { return Ok((seen, false)); }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    async fn step(&mut self, s: &Value, n: usize, session: &Session) -> ApiResult<()> {
        let has = |hay: &str, needle: &str| { let norm = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase(); norm(hay).contains(&norm(needle)) };
        let (on, value) = (text_of(s, "on").trim().to_string(), text_of(s, "value"));
        let either = if value.trim().is_empty() { on.clone() } else { value.trim().to_string() };
        let found = |sel: &str| format!("(() => {{ const el = ({FIND})({}); return el ? {{ text: {TEXT_OF}, there: (() => {{ const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; }})() }} : {{ missing: true }}; }})()", json!(sel));
        match s["do"].as_str().unwrap_or("") {
            "goto" => self.cdp.goto(&either).await?,
            "back" => { self.cdp.eval("history.back()").await?; self.cdp.settle().await; }
            "sleep" => tokio::time::sleep(Duration::from_secs_f64(number_of(&json!(either)).unwrap_or(1.0).clamp(0.0, 600.0))).await,
            "key" => {
                let (key, code, text) = key_of(&either).ok_or_else(|| fail(format!("tecla desconhecida: {either} (use Enter, Tab, Escape, Espaço, setas...)"), 400))?;
                let mut ev = json!({"key": key, "code": if key == " " { "Space" } else { key }, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code});
                if !text.is_empty() { ev["text"] = json!(text); }
                let mut down = ev.clone();
                down["type"] = json!(if text.is_empty() { "rawKeyDown" } else { "keyDown" });
                self.cdp.send("Input.dispatchKeyEvent", down).await?;
                ev["type"] = json!("keyUp");
                self.cdp.send("Input.dispatchKeyEvent", ev).await?;
                self.cdp.settle().await;
            }
            "shot" => {
                if either.is_empty() { return Err(fail("diga em que arquivo gravar a imagem", 400)); }
                let file = std::path::absolute(either.trim_matches('"')).unwrap_or_else(|_| PathBuf::from(&either));
                if let Some(d) = file.parent() { std::fs::create_dir_all(d)?; }
                std::fs::write(&file, self.cdp.shot().await?)?;
                self.values.insert(format!("imagem{n}"), json!(file.to_string_lossy()));
            }
            k @ ("url" | "title") => {
                if either.is_empty() { return Err(fail("diga o trecho que deve aparecer", 400)); }
                let (seen, ok) = self.until(if k == "url" { "location.href" } else { "document.title" }, |v| has(&stringify(v), &either)).await?;
                if !ok { return Err(fail(format!("esperava \"{either}\", mas {} \"{}\"", if k == "url" { "o endereço é" } else { "o título é" }, stringify(&seen)), 422)); }
            }
            "gone" => {
                if on.is_empty() { return Err(fail("diga o que deve sumir (um seletor, ou texto=...)", 400)); }
                let (_, ok) = self.until(&found(&on), |v| v["missing"] == true || v["there"] == false).await?;
                if !ok { return Err(fail(format!("continua na tela depois de {} s", self.wait.as_secs()), 422)); }
            }
            "count" => {
                if on.to_lowercase().starts_with("texto") { return Err(fail("para contar, use um seletor CSS (ex.: .item, table tr)", 400)); }
                let want = value.trim().parse::<u64>().map_err(|_| fail("diga quantos devem existir (um número)", 400))?;
                let (seen, ok) = self.until(&format!("document.querySelectorAll({}).length", json!(on)), |v| v.as_u64() == Some(want)).await?;
                if !ok { return Err(fail(format!("esperava {want}, mas há {}", seen.as_u64().unwrap_or(0)), 422)); }
            }
            "list" => {
                if on.is_empty() || on.to_lowercase().starts_with("texto") { return Err(fail("para ler todos, use um seletor CSS (ex.: .item, table tr)", 400)); }
                let v = self.cdp.eval(&format!("[...document.querySelectorAll({})].map(el => {TEXT_OF}.replace(/\\s+/g, ' '))", json!(on))).await?;
                self.values.insert(if value.trim().is_empty() { format!("lista{n}") } else { value.trim().to_string() }, v);
            }
            "js" => {
                if value.trim().is_empty() { return Err(fail("escreva o JavaScript no valor (use return para devolver algo)", 400)); }
                let v = self.cdp.eval(&format!("(async () => {{ {value}\n }})()")).await?;
                if !v.is_null() { self.values.insert(if on.is_empty() { format!("js{n}") } else { on }, v); }
                self.cdp.settle().await;
            }
            "scroll" if on.is_empty() => { self.cdp.eval(if value.trim().to_lowercase().starts_with("topo") { "window.scrollTo(0, 0)" } else { "window.scrollTo(0, document.documentElement.scrollHeight)" }).await?; tokio::time::sleep(Duration::from_millis(300)).await; }
            "tab" => {
                // a aba mais nova que não é a atual (um link que abre em outra aba, a janela de login de outro site)
                let mine = session.target.lock().clone();
                let end = Instant::now() + self.wait;
                let other = loop {
                    if let Some(t) = pages(session.port).await.into_iter().find(|t| t["id"] != mine.as_str() && !matches!(t["url"].as_str().unwrap_or(""), "about:blank" | "")) { break t; }
                    if Instant::now() > end { return Err(fail("não há outra aba aberta", 422)); }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                };
                let cdp = attach(other["webSocketDebuggerUrl"].as_str().unwrap_or("")).await?;
                let _ = cdp.send("Page.bringToFront", json!({})).await;
                *session.cdp.lock() = cdp.clone();
                *session.target.lock() = other["id"].as_str().unwrap_or("").to_string();
                self.cdp = cdp;
            }
            k => {
                self.appear(&on).await?;
                match k {
                    "wait" | "see" => {}
                    "click" => { self.cdp.call(&on, "el.scrollIntoView({ block: 'center' }); el.click(); return {};").await?; self.cdp.settle().await; }
                    "scroll" => { self.cdp.call(&on, "el.scrollIntoView({ block: 'center' }); return {};").await?; }
                    "hover" => {
                        let r = self.cdp.call(&on, "el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };").await?;
                        self.cdp.send("Input.dispatchMouseEvent", json!({"type": "mouseMoved", "x": r["x"], "y": r["y"]})).await?;
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    "type" => {
                        // limpa pelo setter nativo (React e afins percebem) e digita como o teclado faria
                        self.cdp.call(&on, "el.scrollIntoView({ block: 'center' }); el.focus(); if ('value' in el) { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d && d.set ? d.set.call(el, '') : (el.value = ''); el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) el.textContent = ''; return {};").await?;
                        self.cdp.send("Input.insertText", json!({"text": value})).await?;
                    }
                    "select" => {
                        let r = self.cdp.call(&on, &format!("const want = {}; const o = [...(el.options || [])].find(o => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want); if (!o) return {{ none: true }}; el.value = o.value; el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); return {{}};", json!(value.trim().to_lowercase()))).await?;
                        if r["none"] == true { return Err(fail(format!("a lista não tem a opção \"{value}\""), 422)); }
                    }
                    "check" => {
                        let want = !matches!(value.trim().to_lowercase().as_str(), "não" | "nao" | "no" | "false" | "0" | "desmarcar");
                        self.cdp.call(&on, &format!("el.scrollIntoView({{ block: 'center' }}); if (!!el.checked !== {want}) el.click(); return {{}};")).await?;
                    }
                    "upload" => {
                        let file = value.trim().trim_matches('"');
                        if !Path::new(file).is_file() { return Err(fail(format!("não achei o arquivo {file}"), 400)); }
                        let r = self.cdp.send("Runtime.evaluate", json!({"expression": format!("({FIND})({})", json!(on))})).await?;
                        let id = r["result"]["objectId"].as_str().ok_or_else(|| fail("não achei o campo de arquivo", 422))?;
                        self.cdp.send("DOM.setFileInputFiles", json!({"files": [file], "objectId": id})).await.map_err(|e| fail(format!("esse elemento não é um campo de arquivo ({e})"), 422))?;
                    }
                    "read" => {
                        let r = self.cdp.call(&on, &format!("return {{ text: {TEXT_OF} }};")).await?;
                        self.values.insert(if value.trim().is_empty() { format!("texto{n}") } else { value.trim().to_string() }, r["text"].clone());
                    }
                    "text" => {
                        if value.trim().is_empty() { return Err(fail("diga o texto que deve aparecer ali", 400)); }
                        let (seen, ok) = self.until(&found(&on), |v| has(v["text"].as_str().unwrap_or(""), &value)).await?;
                        if !ok { return Err(fail(format!("esperava \"{value}\", mas está \"{}\"", seen["text"].as_str().unwrap_or("").chars().take(200).collect::<String>()), 422)); }
                    }
                    o => return Err(fail(format!("ação desconhecida: {o}"), 400)),
                }
            }
        }
        Ok(())
    }
}
pub(super) async fn node(_kind: &str, p: &Value) -> ApiResult<Value> {
    let steps: Vec<Value> = p["steps"].as_array().map(|a| a.iter().filter(|s| s["do"].as_str().is_some_and(|d| !d.is_empty())).cloned().collect()).unwrap_or_default();
    let url = text_of(p, "url").trim().to_string();
    let rid = super::RUN_ID.try_with(|r| r.clone()).unwrap_or_else(|_| "avulso".into());
    let existing = SESSIONS.lock().get(&rid).cloned();
    // a janela pode ter sido fechada à mão no meio do fluxo: abre outra
    let session = match existing.filter(|s| s.cdp().open.load(Ordering::Relaxed)) {
        Some(s) => s,
        None => {
            if url.is_empty() && steps.is_empty() { return Err(fail("informe o endereço do site ou pelo menos um passo", 400)); }
            let s = Arc::new(Session::open(p).await?);
            SESSIONS.lock().insert(rid.clone(), s.clone());
            s
        }
    };
    session.keep.store(p["after"] == "keep", Ordering::Relaxed);
    let mut run = Steps { cdp: session.cdp(), wait: Duration::from_secs(number_of(&p["wait_s"]).unwrap_or(15.0).clamp(1.0, 300.0) as u64), values: Default::default() };
    if !url.is_empty() { run.cdp.goto(&url).await?; }
    for (i, s) in steps.iter().enumerate() {
        let n = i + 1;
        if let Err(e) = run.step(s, n, &session).await {
            let kind = s["do"].as_str().unwrap_or("");
            let on = text_of(s, "on");
            // a evidência: como a tela estava na hora da falha
            let mut shot = String::new();
            if let Ok(png) = run.cdp.shot().await {
                let dir = data_dir().join("evidencias");
                let file = dir.join(format!("{}-passo-{n}.png", chrono::Local::now().format("%Y%m%d-%H%M%S")));
                if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&file, png).is_ok() { shot = format!(". A tela na hora da falha: {}", file.display()); }
            }
            return Err(fail(format!("passo {n} ({}{}): {}{shot}", action_name(kind), if on.trim().is_empty() { String::new() } else { format!(" \"{}\"", on.trim()) }, e.msg), e.status));
        }
    }
    run.cdp.settle().await;
    let info = run.cdp.eval("({ url: location.href, title: document.title })").await.unwrap_or(Value::Null);
    Ok(json!({"out": {"url": info["url"].as_str().unwrap_or(""), "title": info["title"].as_str().unwrap_or(""), "values": run.values}}))
}

// ---------- gravador ----------
/// Abre o site com a barra de gravação. Cada ação da pessoa entra em `lines` como `{ do, on, value }`; `stop` (ou o
/// botão Concluir da barra, ou fechar a janela) encerra, e `done` avisa a tela.
pub(super) async fn record(p: Value, lines: Arc<Mutex<Vec<Value>>>, done: Arc<AtomicBool>, err: Arc<Mutex<String>>, mut stop: tokio::sync::oneshot::Receiver<()>) {
    let work = async {
        let port = launch(&data_dir().join("perfil"), false, (1280, 900)).await?;
        let (cdp, target) = new_tab(port).await?;
        let source = format!("({RECORDER})()");
        cdp.send("Runtime.addBinding", json!({"name": "bsRec"})).await?;
        cdp.send("Page.addScriptToEvaluateOnNewDocument", json!({"source": source})).await?;
        let mut ev = cdp.events.subscribe();
        let _ = cdp.send("Page.bringToFront", json!({})).await;
        let url = text_of(&p, "url").trim().to_string();
        let mut need_url = url.is_empty();
        if url.is_empty() { let _ = cdp.eval(&source).await; } else if let Err(e) = cdp.goto(&url).await { lines.lock().push(json!({"warn": e.msg})); }
        lines.lock().push(json!({"ready": true}));
        let mut count = 0usize;
        loop {
            let v = tokio::select! {
                _ = &mut stop => break,
                v = ev.recv() => match v { Ok(v) => v, Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue, Err(_) => break },
                _ = tokio::time::sleep(Duration::from_secs(1)) => { if cdp.open.load(Ordering::Relaxed) { continue } else { break } }
            };
            if v["method"] == "Runtime.bindingCalled" && v["params"]["name"] == "bsRec" {
                let Ok(s) = serde_json::from_str::<Value>(v["params"]["payload"].as_str().unwrap_or("")) else { continue };
                if s["done"] == true { break; }
                count += 1;
                { let mut g = lines.lock(); if g.len() < 2000 { g.push(s); } }
                let _ = cdp.eval(&format!("window.__bsRecCount && window.__bsRecCount({count})")).await;
            } else if v["method"] == "Page.frameNavigated" && v["params"]["frame"]["parentId"].is_null() {
                let u = v["params"]["frame"]["url"].as_str().unwrap_or("");
                // sem endereço no nó: o primeiro site que a pessoa abrir vira o endereço
                if need_url && (u.starts_with("http://") || u.starts_with("https://")) { need_url = false; lines.lock().push(json!({"url": u})); }
                let c = cdp.clone();
                tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(400)).await; let _ = c.eval(&format!("window.__bsRecCount && window.__bsRecCount({count})")).await; });
            }
        }
        // a aba da gravação fecha; o navegador fica se a pessoa tinha outras páginas abertas nele
        let others = pages(port).await.into_iter().filter(|t| t["id"] != target.as_str() && !matches!(t["url"].as_str().unwrap_or(""), "about:blank" | "edge://newtab/" | "chrome://newtab/")).count();
        if others == 0 { let _ = tokio::time::timeout(Duration::from_secs(2), cdp.send("Browser.close", json!({}))).await; } else { let _ = HTTP.get(format!("http://127.0.0.1:{port}/json/close/{target}")).send().await; }
        Ok::<(), ApiError>(())
    };
    if let Err(e) = work.await { *err.lock() = e.msg; }
    done.store(true, Ordering::Relaxed);
}
