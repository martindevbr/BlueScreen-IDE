//! O que um plugin só com `ui.js` precisaria de um servidor próprio para fazer, oferecido pelo núcleo:
//!   plugin/exec   rodar um programa e esperar a saída (POST { program, args, cwd, env, stdin, timeout })
//!   plugin/proc   processo longo (servidor de desenvolvimento, watcher): começa, lê a saída aos poucos, recebe
//!                 entrada e é encerrado; os processos de um plugin saem quando ele é desligado
//!   plugin/fetch  HTTP de qualquer lugar, sem CORS, com `{{secret:nome}}` trocado pelo segredo do plugin aqui no
//!                 núcleo (o token nunca passa pela página)
//! `{{vault:nome}}` usa um segredo do cofre (vault.rs): só com a permissão do plugin, só para os sites liberados (no
//! fetch) ou só para os programas liberados (nas variáveis de ambiente e na entrada do exec/proc). O valor é tirado
//! das respostas e da saída antes de voltarem para a página.
//! Tudo só pelo PC local: pela rede local (celular, outro PC) essas rotas respondem 403.
use super::data::secret;
use super::vault::{self, Caller, Target, caller};
use super::{RouteFn, ok, route_fn};
use crate::util::*;
use base64::Engine;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default()
}
/// Troca `{{secret:nome}}` (segredo do próprio plugin) e `{{vault:nome}}` (cofre, se o plugin tem permissão). Guarda os
/// valores, para tirá-los do que volta à página, e os nomes do cofre, para conferir o destino antes de mandar.
struct Fill<'a> { c: &'a Caller, vault: Vec<String>, values: Vec<String> }
impl<'a> Fill<'a> {
    fn new(c: &'a Caller) -> Self { Fill { c, vault: vec![], values: vec![] } }
    fn apply(&mut self, s: &str) -> ApiResult<String> {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        loop {
            let next = [("{{secret:", false), ("{{vault:", true)].into_iter().filter_map(|(t, v)| rest.find(t).map(|i| (i, t.len(), v))).min_by_key(|x| x.0);
            let Some((i, tl, is_vault)) = next else { break };
            out.push_str(&rest[..i]);
            let after = &rest[i + tl..];
            let end = after.find("}}").ok_or_else(|| fail("{{secret:/{{vault: sem }}", 400))?;
            let key = after[..end].trim();
            let v = if is_vault {
                let v = vault::resolve(self.c, key)?;
                if !self.vault.iter().any(|k| k == key) { self.vault.push(key.to_string()); }
                v
            } else { secret(&self.c.plugin, key).ok_or_else(|| fail(format!("segredo \"{key}\" não configurado"), 400))? };
            self.values.push(v.clone());
            out.push_str(&v);
            rest = &after[end + 2..];
        }
        out.push_str(rest);
        Ok(out)
    }
    fn scrub(&self, t: &str) -> String { vault::scrub(t, &self.values) }
}
fn has_marker(s: &str) -> bool { s.contains("{{vault:") || s.contains("{{secret:") }

/// O comando pedido: o programa é achado pela busca da IDE (PATH, SDKs, npm -g...), na pasta pedida (ou na do usuário).
/// Segredos (`{{vault:..}}`, `{{secret:..}}`) valem nas variáveis de ambiente, nunca nos argumentos (que qualquer
/// programa do PC enxerga na lista de processos).
fn command(b: &Value, f: &mut Fill) -> ApiResult<tokio::process::Command> {
    let prog = b["program"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| fail("program obrigatório", 400))?;
    let exe = crate::build::detect::which(prog).ok_or_else(|| fail(format!("{prog} não encontrado. Instale ou adicione ao PATH."), 404))?;
    let cwd = b["cwd"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    if !cwd.is_dir() { return Err(fail(format!("pasta não existe: {}", cwd.display()), 400)); }
    // .cmd/.bat (npm, gradlew) também vão direto: o Rust chama o cmd com as aspas e escapes certos e recusa argumento
    // que não dá para passar com segurança ("cmd /d /c exe args" quebrava com espaços e deixava & e % virarem comandos)
    let mut c = tokio::process::Command::new(&exe);
    let args = strs(&b["args"]);
    if args.iter().any(|a| has_marker(a)) { return Err(fail("segredos vão em env (variáveis de ambiente) ou stdin, não nos argumentos", 400)); }
    c.args(args).current_dir(cwd).kill_on_drop(true).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in crate::sdk::env() { c.env(k, v); }
    if let Some(env) = b["env"].as_object() { for (k, v) in env { match v.as_str() { Some(s) => { c.env(k, f.apply(s)?); } None if v.is_null() => { c.env_remove(k); } None => { c.env(k, v.to_string()); } } } }
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    Ok(c)
}
/// saída de programa como texto: UTF-8, ou a code page do Windows (o mesmo leitor do build, output.rs)
fn text(bytes: &[u8]) -> String { crate::output::decode_console(bytes) }

// ---------- processos longos ----------
struct Proc {
    plugin: String,
    label: String,
    /// pedaços da saída: (número, "out" | "err", texto); os mais antigos saem quando passa de MAX_BUF
    buf: Mutex<(VecDeque<(u64, &'static str, String)>, usize)>,
    next: AtomicU64,
    code: Mutex<Option<i32>>,
    done: Mutex<bool>,
    stdin: tokio::sync::Mutex<Option<tokio::process::ChildStdin>>,
    kill: Notify,
    news: Notify,
    /// valores de segredos usados no processo: saem da saída antes de chegar à página
    hide: Vec<String>,
}
const MAX_BUF: usize = 4 << 20;
static PROCS: LazyLock<Mutex<HashMap<u64, Arc<Proc>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SEQ: AtomicU64 = AtomicU64::new(1);

impl Proc {
    fn push(&self, stream: &'static str, s: String) {
        let s = if self.hide.is_empty() { s } else { vault::scrub(&s, &self.hide) };
        let mut g = self.buf.lock();
        g.1 += s.len();
        g.0.push_back((self.next.fetch_add(1, Ordering::SeqCst), stream, s));
        while g.1 > MAX_BUF && g.0.len() > 1 { if let Some((_, _, x)) = g.0.pop_front() { g.1 -= x.len(); } }
        drop(g);
        self.news.notify_waiters();
    }
    fn since(&self, n: u64) -> (Vec<Value>, u64) {
        let g = self.buf.lock();
        let chunks: Vec<Value> = g.0.iter().filter(|(i, _, _)| *i >= n).map(|(_, s, t)| json!({ "s": s, "t": t })).collect();
        (chunks, self.next.load(Ordering::SeqCst))
    }
    fn state(&self, id: u64) -> Value { json!({ "id": id, "label": self.label, "done": *self.done.lock(), "code": *self.code.lock() }) }
}
async fn pump(p: Arc<Proc>, mut r: impl tokio::io::AsyncRead + Unpin, stream: &'static str) {
    let mut buf = vec![0u8; 16 * 1024];
    let mut rest: Vec<u8> = vec![];
    // com segredos: limpa o que juntou e segura o fim (um segredo pode estar cortado entre dois pedaços)
    let keep = if p.hide.is_empty() { 0 } else { vault::scrub_tail(&p.hide) };
    while let Ok(n) = r.read(&mut buf).await {
        if n == 0 { break; }
        rest.extend_from_slice(&buf[..n]);
        if keep > 0 { rest = vault::scrub_bytes(&rest, &p.hide); }
        // não corta um caractere UTF-8 no meio
        let cut = match std::str::from_utf8(&rest) { Ok(_) => rest.len(), Err(e) if e.error_len().is_none() => e.valid_up_to(), Err(_) => rest.len() };
        let mut cut = cut.min(rest.len().saturating_sub(keep));
        while cut > 0 && cut < rest.len() && (rest[cut] & 0xC0) == 0x80 { cut -= 1; }
        let piece: Vec<u8> = rest.drain(..cut).collect();
        if !piece.is_empty() { p.push(stream, text(&piece)); }
    }
    if !rest.is_empty() { p.push(stream, text(&rest)); }
}
fn start(who: &Caller, b: &Value) -> ApiResult<Value> {
    let mut f = Fill::new(who);
    let mut c = command(b, &mut f)?;
    c.stdin(Stdio::piped());
    vault::check(who, &f.vault, Target::Program(b["program"].as_str().unwrap_or("")))?;
    let plugin = who.plugin.clone();
    let hide = f.values.clone();
    let mut child = c.spawn().map_err(|e| fail(format!("não deu para iniciar: {e}"), 500))?;
    #[cfg(windows)]
    if let Some(h) = child.raw_handle() { super::external::job::assign_raw(h); }
    let label = b["label"].as_str().map(String::from).unwrap_or_else(|| std::iter::once(b["program"].as_str().unwrap_or("").to_string()).chain(strs(&b["args"])).collect::<Vec<_>>().join(" "));
    let p = Arc::new(Proc {
        plugin, label, buf: Mutex::new((VecDeque::new(), 0)), next: AtomicU64::new(0), code: Mutex::new(None), done: Mutex::new(false),
        stdin: tokio::sync::Mutex::new(child.stdin.take()), kill: Notify::new(), news: Notify::new(), hide,
    });
    let id = SEQ.fetch_add(1, Ordering::SeqCst);
    PROCS.lock().insert(id, p.clone());
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let readers = [out.map(|o| tokio::spawn(pump(p.clone(), o, "out"))), err.map(|e| tokio::spawn(pump(p.clone(), e, "err")))];
    tokio::spawn(async move {
        let code = tokio::select! {
            s = child.wait() => s.ok().and_then(|s| s.code()).unwrap_or(-1),
            _ = p.kill.notified() => { let _ = child.kill().await; -1 }
        };
        for t in readers.into_iter().flatten() { let _ = tokio::time::timeout(Duration::from_secs(2), t).await; }
        *p.code.lock() = Some(code);
        *p.done.lock() = true;
        p.news.notify_waiters();
        // terminado, ainda dá para ler o fim da saída por 5 minutos
        tokio::time::sleep(Duration::from_secs(300)).await;
        PROCS.lock().remove(&id);
    });
    Ok(json!({ "id": id }))
}
fn get(plugin: &str, id: u64) -> ApiResult<Arc<Proc>> {
    PROCS.lock().get(&id).filter(|p| p.plugin == plugin).cloned().ok_or_else(|| fail("processo não existe (já saiu há mais de 5 minutos?)", 404))
}
/// Encerra os processos dos plugins que não estão mais ligados (chamado a cada recarga dos plugins).
pub fn reap(active: &HashSet<String>) {
    for p in PROCS.lock().values() { if !active.contains(&p.plugin) && !*p.done.lock() { p.kill.notify_one(); } }
}

// ---------- HTTP ----------
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().user_agent(concat!("BlueScreen/", env!("CARGO_PKG_VERSION"))).build().expect("http"));
/// com segredo do cofre não segue redirecionamento: o corpo e a URL iriam para um site que não foi liberado
static HTTP_NOREDIR: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().user_agent(concat!("BlueScreen/", env!("CARGO_PKG_VERSION"))).redirect(reqwest::redirect::Policy::none()).build().expect("http"));
const MAX_BODY: usize = 64 << 20;
async fn fetch(who: &Caller, b: &Value) -> ApiResult<Value> {
    let tpl = b["url"].as_str().ok_or_else(|| fail("url obrigatória", 400))?;
    let mut f = Fill::new(who);
    let url = f.apply(tpl)?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| fail(format!("url inválida: {tpl}"), 400))?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err(fail("só http:// e https://", 400)); }
    let method = reqwest::Method::from_bytes(b["method"].as_str().unwrap_or("GET").to_uppercase().as_bytes()).map_err(|_| fail("método inválido", 400))?;
    let timeout = b["timeout"].as_u64().unwrap_or(30_000).clamp(1_000, 600_000);
    let mut headers_out: Vec<(String, String)> = vec![];
    if let Some(h) = b["headers"].as_object() { for (k, v) in h { if let Some(v) = v.as_str() { headers_out.push((k.clone(), f.apply(v)?)); } } }
    let body: Option<Vec<u8>> = if let Some(s) = b["bodyBase64"].as_str() { Some(B64.decode(s).map_err(|_| fail("bodyBase64 inválido", 400))?) }
        else if let Some(s) = b["body"].as_str() { Some(f.apply(s)?.into_bytes()) }
        else if !b["json"].is_null() { headers_out.push(("content-type".into(), "application/json".into())); Some(f.apply(&b["json"].to_string())?.into_bytes()) }
        else { None };
    // o destino tem de estar liberado para cada segredo do cofre usado (só HTTPS)
    vault::check(who, &f.vault, Target::Http(&parsed))?;
    let client = if f.vault.is_empty() { &*HTTP } else { &*HTTP_NOREDIR };
    let mut rb = client.request(method, parsed.clone()).timeout(Duration::from_millis(timeout));
    for (k, v) in headers_out { rb = rb.header(k, v); }
    if let Some(body) = body { rb = rb.body(body); }
    let resp = rb.send().await.map_err(|e| fail(format!("{tpl}: {}", e.without_url()), 502))?;
    let status = resp.status().as_u16();
    let headers: serde_json::Map<String, Value> = resp.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), json!(f.scrub(v))))).collect();
    // com segredo na URL, a página recebe a URL como pediu (com {{secret:..}}), nunca a preenchida
    let final_url = if has_marker(tpl) { tpl.to_string() } else { resp.url().to_string() };
    if resp.content_length().is_some_and(|n| n as usize > MAX_BODY) { return Err(fail("resposta grande demais (mais de 64 MB)", 502)); }
    let bytes = resp.bytes().await.map_err(|e| fail(e.to_string(), 502))?;
    if bytes.len() > MAX_BODY { return Err(fail("resposta grande demais (mais de 64 MB)", 502)); }
    let binary = b["as"].as_str() == Some("base64");
    Ok(json!({
        "status": status, "ok": (200..300).contains(&status), "url": final_url, "headers": headers,
        "body": if binary { Value::Null } else { json!(f.scrub(&text(&bytes))) },
        // binário: o valor sai dos bytes antes de virar base64 (depois, não daria mais para achar)
        "bodyBase64": if binary { json!(B64.encode(if f.values.is_empty() { bytes.to_vec() } else { vault::scrub_bytes(&bytes, &f.values) })) } else { Value::Null },
    }))
}

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![
        // POST { program, args, cwd, env, stdin, timeout (ms, padrão 60 s) } -> { ok, code, out, err, timedOut }
        ("plugin/exec", route_fn(|r| async move {
            r.local_only()?;
            let who = caller(&r)?;
            let b: Value = r.body_json()?;
            let mut f = Fill::new(&who);
            let mut c = command(&b, &mut f)?;
            let input = b["stdin"].as_str().map(|s| f.apply(s)).transpose()?;
            vault::check(&who, &f.vault, Target::Program(b["program"].as_str().unwrap_or("")))?;
            c.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
            let mut child = c.spawn().map_err(|e| fail(format!("não deu para iniciar: {e}"), 500))?;
            #[cfg(windows)]
            if let Some(h) = child.raw_handle() { super::external::job::assign_raw(h); }
            if let (Some(s), Some(mut w)) = (input, child.stdin.take()) { tokio::spawn(async move { let _ = w.write_all(s.as_bytes()).await; }); }
            let ms = b["timeout"].as_u64().unwrap_or(60_000).clamp(100, 3_600_000);
            match tokio::time::timeout(Duration::from_millis(ms), child.wait_with_output()).await {
                Ok(Ok(o)) => ok(json!({ "ok": o.status.success(), "code": o.status.code().unwrap_or(-1), "out": f.scrub(&text(&o.stdout)), "err": f.scrub(&text(&o.stderr)), "timedOut": false })),
                Ok(Err(e)) => Err(fail(e.to_string(), 500)),
                Err(_) => ok(json!({ "ok": false, "code": -1, "out": "", "err": "tempo esgotado", "timedOut": true })),
            }
        })),
        // POST { action: "start", program, args, cwd, env, label } -> { id } | { action: "input", id, text } | { action: "kill", id }
        // GET ?id=&since=&wait= -> { chunks: [{ s, t }], next, done, code } (espera até `wait` ms por saída nova)
        // GET ?list=1 -> { procs } (os do plugin, inclusive os que a página perdeu ao recarregar)
        ("plugin/proc", route_fn(|r| async move {
            r.local_only()?;
            let who = caller(&r)?;
            let plugin = who.plugin.clone();
            if r.is_post() {
                let b: Value = r.body_json()?;
                let id = b["id"].as_u64().unwrap_or(0);
                return match b["action"].as_str().unwrap_or("start") {
                    "start" => ok(start(&who, &b)?),
                    "input" => {
                        let p = get(&plugin, id)?;
                        let mut g = p.stdin.lock().await;
                        let w = g.as_mut().ok_or_else(|| fail("o processo não recebe entrada", 409))?;
                        if has_marker(b["text"].as_str().unwrap_or("")) { return Err(fail("segredos só no início do processo (env)", 400)); }
                        w.write_all(b["text"].as_str().unwrap_or("").as_bytes()).await.map_err(|e| fail(e.to_string(), 409))?;
                        let _ = w.flush().await;
                        if b["close"].as_bool() == Some(true) { *g = None; }
                        ok(json!({ "ok": true }))
                    }
                    "kill" => { get(&plugin, id)?.kill.notify_one(); ok(json!({ "ok": true })) }
                    a => Err(fail(format!("ação desconhecida: {a}"), 400)),
                };
            }
            if r.flag("list") {
                let list: Vec<Value> = PROCS.lock().iter().filter(|(_, p)| p.plugin == plugin).map(|(id, p)| p.state(*id)).collect();
                return ok(json!({ "procs": list }));
            }
            let id = r.require("id")?.parse::<u64>().map_err(|_| fail("id inválido", 400))?;
            let p = get(&plugin, id)?;
            let since = r.q("since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let wait = r.q("wait").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0).min(30_000);
            if wait > 0 && p.next.load(Ordering::SeqCst) <= since && !*p.done.lock() {
                let n = p.news.notified();
                tokio::pin!(n);
                n.as_mut().enable();
                if p.next.load(Ordering::SeqCst) <= since && !*p.done.lock() { let _ = tokio::time::timeout(Duration::from_millis(wait), n).await; }
            }
            let (chunks, next) = p.since(since);
            let mut st = p.state(id);
            st["chunks"] = json!(chunks); st["next"] = json!(next);
            ok(st)
        })),
        // POST { url, method, headers, body | json | bodyBase64, as: "text" | "base64", timeout }
        //   -> { status, ok, url, headers, body | bodyBase64 }. `{{secret:nome}}` vale em url, headers e corpo.
        ("plugin/fetch", route_fn(|r| async move {
            r.local_only()?;
            let who = caller(&r)?;
            let b: Value = r.body_json()?;
            ok(fetch(&who, &b).await?)
        })),
    ]
}
