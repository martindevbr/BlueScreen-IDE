//! Rotas do sistema: sessão, configuração, janela, plugins, preferências, terminal e servidores de linguagem.
//! Separadas de server.rs só por assunto: as funções de apoio (project, in_project, blocking...) ficam lá.
use super::*;

// ---------- a janela do Estúdio (um processo filho, só a janela: main.rs --studio) ----------
static STUDIO_WIN: Mutex<Option<std::process::Child>> = Mutex::new(None);
static STUDIO_GOTO: Mutex<String> = Mutex::new(String::new());
static STUDIO_ASKED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static STUDIO_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static STUDIO_CLOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn studio_alive() -> bool { STUDIO_WIN.lock().as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None))) }
/// O Estúdio está aberto com trabalho não salvo (um fluxo alterado, por exemplo)? Se sim, ele vem para a frente.
pub fn studio_holds_quit() -> bool {
    let held = studio_alive() && STUDIO_DIRTY.load(std::sync::atomic::Ordering::Relaxed);
    if held { STUDIO_ASKED.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
    held
}
/// O BlueScreen está saindo: a janela do Estúdio sai junto (sem ele, ela ficaria aberta falando com ninguém).
pub fn studio_kill() {
    if let Some(mut c) = STUDIO_WIN.lock().take() { let _ = c.kill(); let _ = c.wait(); }
}

// ---------- logs pesados: o da própria IDE, os dos plugins e os do projeto aberto ----------
fn is_log(name: &str) -> bool { let n = name.to_ascii_lowercase(); n.ends_with(".log") || n.contains(".log.") || n.ends_with(".out") && n.contains("log") }
/// Arquivos de log com mais de `min` bytes: em ~/.bluescreen (a IDE e plugin-data) e na pasta do projeto, até 4 níveis.
fn heavy_logs(project: Option<PathBuf>, min: u64) -> Vec<Value> {
    fn walk(dir: &Path, depth: usize, min: u64, kind: &str, out: &mut Vec<Value>, seen: &mut usize) {
        if *seen > 40_000 || out.len() >= 50 { return; }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            *seen += 1;
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if depth > 0 && !name.starts_with('.') && !IGNORED_DIRS.contains(name.as_str()) { walk(&e.path(), depth - 1, min, kind, out, seen); }
            } else if ft.is_file() && is_log(&name) {
                let Ok(md) = e.metadata() else { continue };
                if md.len() > min {
                    let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                    out.push(json!({ "path": e.path().to_string_lossy(), "name": name, "size": md.len(), "mtime": mtime, "kind": kind }));
                }
            }
        }
    }
    let (mut out, mut seen) = (vec![], 0usize);
    let ud = user_dir();
    walk(&ud, 4, min, "ide", &mut out, &mut seen);
    for v in out.iter_mut() { if v["path"].as_str().is_some_and(|p| p.contains("plugin-data")) { v["kind"] = json!("plugin"); } }
    if let Some(p) = project && p.is_dir() && !within(&ud, &p) { seen = 0; walk(&p, 4, min, "project", &mut out, &mut seen); }
    out.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    out
}
/// Esvazia um log deixando só o final (`keep` bytes, a partir de uma linha inteira). Só arquivo de log, e só dentro
/// de ~/.bluescreen ou do projeto informado.
fn trim_log(path: &Path, project: Option<PathBuf>, keep: u64) -> Result<u64, String> {
    use std::io::{Read, Seek, SeekFrom};
    let abs = absolute(path);
    let name = abs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !is_log(&name) { return Err("só arquivos de log".into()); }
    if !(within(&user_dir(), &abs) || project.as_deref().is_some_and(|p| within(p, &abs))) { return Err("fora da IDE e do projeto aberto".into()); }
    let mut f = std::fs::File::open(&abs).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len <= keep { return Ok(len); }
    f.seek(SeekFrom::Start(len - keep)).map_err(|e| e.to_string())?;
    let mut tail = Vec::with_capacity(keep as usize);
    f.read_to_end(&mut tail).map_err(|e| e.to_string())?;
    drop(f);
    let cut = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    let mut body = format!("[... {} anteriores apagados pela IDE em {} ...]\n", fmt_mb(len - keep + cut as u64), chrono::Local::now().format("%d/%m/%Y %H:%M")).into_bytes();
    body.extend_from_slice(&tail[cut..]);
    std::fs::write(&abs, &body).map_err(|e| if e.raw_os_error() == Some(32) { "o arquivo está em uso por outro programa: feche-o e tente de novo".into() } else { e.to_string() })?;
    Ok(body.len() as u64)
}
fn fmt_mb(n: u64) -> String { if n >= 1 << 20 { format!("{:.1} MB", n as f64 / 1048576.0) } else { format!("{} KB", n / 1024) } }

pub(super) fn add_routes(m: &mut HashMap<String, RouteFn>) {
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
    // logs com mais de `min` bytes (padrão 1 MB): o da IDE, os dos plugins e os do projeto (?project=)
    add("logs/heavy", route_fn(|r| async move {
        let min = r.q_or("min", "1048576").parse().unwrap_or(1 << 20);
        let p = r.q("project").filter(|p| !p.is_empty()).map(PathBuf::from);
        let files = blocking(move || heavy_logs(p, min)).await?;
        ok(json!({ "files": files, "min": min }))
    }));
    // POST { path, keep? }: deixa só o final do log (padrão 256 KB)
    add("logs/trim", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        let b: Value = r.body_json()?;
        let path = PathBuf::from(b["path"].as_str().unwrap_or(""));
        let keep = b["keep"].as_u64().unwrap_or(256 * 1024).clamp(0, 64 << 20);
        let p = r.q("project").filter(|p| !p.is_empty()).map(PathBuf::from);
        let size = blocking(move || trim_log(&path, p, keep)).await?.map_err(|e| fail(e, 400))?;
        ok(json!({ "size": size }))
    }));
    add("session", route_fn(|r| async move { ok(json!({ "remote": r.remote, "authed": true })) }));
    add("config", route_fn(|_| async move {
        let a = app();
        ok(json!({ "app": "bluescreen", "engine": "rust", "version": VERSION, "pid": std::process::id(), "root": a.root, "host": gethostname(), "network": lan_status(), "plugins": host().get().list, "desktop": UI.get().is_some() }))
    }));
    add("reveal", route_fn(|r| async move {
        r.local_only()?;
        let target = absolute(Path::new(r.q_or("path", "")));
        if !target.exists() { return Err(fail(format!("Não existe: {}", target.display()), 400)); }
        let t = target.to_string_lossy().to_string();
        if target.is_dir() { fire("explorer.exe", &[&t]); } else { fire("explorer.exe", &[&format!("/select,{t}")]); }
        ok(json!({ "ok": true }))
    }));
    add("activate", route_fn(|r| async move {
        // outra instância foi aberta: traz esta janela para a frente
        if r.remote || !r.is_post() || r.headers.get("x-bluescreen").and_then(|v| v.to_str().ok()) != Some("takeover") { return Err(fail("só pelo PC local", 403)); }
        match UI.get() { Some(f) => { f(UiEvent::Activate); ok(json!({ "ok": true })) } None => Err(fail("sem janela", 409)) }
    }));
    // Estúdio: os plugins numa janela só deles, sem a IDE em volta. POST abre (ou chama para a frente a que já está
    // aberta); POST { close: true } pede para ela fechar (a IDE abriu o projeto que o Estúdio pediu). GET é a própria
    // janela do Estúdio perguntando o que há para ela (vir para a frente, abrir um plugin, fechar) e contando, em
    // ?dirty=1, se tem trabalho não salvo.
    add("studio", route_fn(|r| async move {
        r.local_only()?;
        use std::sync::atomic::Ordering::Relaxed;
        if !r.is_post() {
            if let Some(d) = r.q("dirty") { STUDIO_DIRTY.store(d == "1", Relaxed); }
            return ok(json!({ "focus": STUDIO_ASKED.load(Relaxed), "app": std::mem::take(&mut *STUDIO_GOTO.lock()), "close": STUDIO_CLOSE.swap(false, Relaxed) }));
        }
        let b = serde_json::from_slice::<Value>(&r.body).unwrap_or(Value::Null);
        if b["close"] == true { if studio_alive() { STUDIO_CLOSE.store(true, Relaxed); } return ok(json!({ "ok": true })); }
        // { "app": "automator" }: abre direto naquele plugin
        let goto = b["app"].as_str().map(String::from).filter(|a| !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        if UI.get().is_none() { return Err(fail("sem janela: abra o Estúdio pelo navegador", 409)); }
        let mut win = STUDIO_WIN.lock();
        if let Some(c) = win.as_mut() && matches!(c.try_wait(), Ok(None)) { if let Some(a) = &goto { *STUDIO_GOTO.lock() = a.clone(); } STUDIO_ASKED.fetch_add(1, Relaxed); return ok(json!({ "ok": true, "already": true })); }
        let exe = std::env::current_exe().map_err(|e| fail(format!("não achei o executável: {e}"), 500))?;
        let child = std::process::Command::new(exe).arg("--studio").args(goto.iter()).env("BLUESCREEN_PORT", app().port.to_string()).spawn().map_err(|e| fail(format!("não deu para abrir o Estúdio: {e}"), 500))?;
        STUDIO_DIRTY.store(false, Relaxed); STUDIO_CLOSE.store(false, Relaxed);
        *win = Some(child);
        ok(json!({ "ok": true }))
    }));
    // O Estúdio pede para a IDE abrir um projeto: POST guarda o pedido e traz a janela da IDE para a frente;
    // GET é a página da IDE buscando o pedido (ele some ao ser lido).
    add("ide/open", route_fn(|r| async move {
        r.local_only()?;
        static ASK: Mutex<Option<Value>> = Mutex::new(None);
        if !r.is_post() { return ok(ASK.lock().take().unwrap_or(json!({}))); }
        let b: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        let path = b["path"].as_str().unwrap_or("").trim().to_string();
        if !path.is_empty() && !Path::new(&path).is_dir() { return Err(fail(format!("A pasta não existe mais: {path}"), 404)); }
        *ASK.lock() = Some(json!({ "path": path, "pick": b["pick"] == true }));
        if let Some(f) = UI.get() { f(UiEvent::Activate); }
        ok(json!({ "ok": true }))
    }));
    add("quit", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() || r.headers.get("x-bluescreen").and_then(|v|v.to_str().ok())!=Some("takeover") {return Err(fail("use o comando --quit do BlueScreen",403));}
        match UI.get(){Some(f)=>f(UiEvent::Quit),None=>{studio_kill();tokio::spawn(async{tokio::time::sleep(std::time::Duration::from_millis(150)).await;std::process::exit(0);});}}
        ok(json!({"ok":true}))
    }));
    add("shutdown", route_fn(|r| async move {
        if r.remote || !r.is_post() || r.headers.get("x-bluescreen").and_then(|v| v.to_str().ok()) != Some("takeover") { return Err(fail("só pelo PC local", 403)); }
        log("Outra instância do BlueScreen assumiu. Encerrando.");
        studio_kill();
        tokio::spawn(async { tokio::time::sleep(std::time::Duration::from_millis(150)).await; std::process::exit(0); });
        ok(json!({ "ok": true }))
    }));
    // lista de plugins; POST { id, enabled } liga/desliga (persistido em ~/.bluescreen/plugins.json) e POST { reload: true } relê a pasta
    add("plugins", route_fn(|r| async move {
        if r.is_post() {
            r.local_only()?;
            let b: Value = r.body_json()?;
            if let Some(id) = b["id"].as_str() {
                if !host().get().list.iter().any(|p| p.id == id) { return Err(fail(format!("plugin desconhecido: {id}"), 404)); }
                host().set_enabled(id, b["enabled"].as_bool().unwrap_or(false));
            } else { host().load(); }
            host().print();
        }
        ok(json!({ "plugins": host().get().list, "dirs": crate::plugins::dirs(), "config": crate::plugins::config_file() }))
    }));
    // terminal embutido: shells instalados (o shell em si abre por WebSocket em /api/terminal/ws)
    add("terminal/shells", route_fn(|r| async move {
        r.local_only()?;
        let fresh = r.q_or("fresh", "") == "1";
        ok(json!({ "shells": blocking(move || crate::terminal::shells(fresh)).await?.as_ref() }))
    }));
    // ?pids=1,2: o que está rodando dentro de cada shell (vazio = parado no prompt); a aba pergunta antes de fechar
    add("terminal/running", route_fn(|r| async move {
        r.local_only()?;
        let pids: Vec<u32> = r.q_or("pids", "").split(',').filter_map(|p| p.trim().parse().ok()).take(64).collect();
        let map = blocking(move || pids.into_iter().map(|p| (p.to_string(), json!(crate::terminal::running(p)))).collect::<serde_json::Map<String, Value>>()).await?;
        ok(Value::Object(map))
    }));
    // servidores de linguagem e depuradores encontrados (cada um abre por WebSocket em /api/rpc/ws)
    add("rpc/tools", route_fn(|r| async move {
        r.local_only()?;
        let fresh = r.q_or("fresh", "") == "1";
        ok(json!({ "tools": blocking(move || crate::rpc::tools(fresh)).await?.as_ref() }))
    }));
    // instalar um servidor de linguagem pela IDE: POST começa, GET devolve o andamento (ver install.rs)
    add("rpc/install", route_fn(|r| async move {
        r.local_only()?;
        let id = r.q_or("tool", "").to_string();
        if r.is_post() { return ok(crate::install::start(&id).map_err(|e| fail(e, 400))?); }
        ok(crate::install::status(&id))
    }));
    // preferências da interface (aparência, predefinições) em ~/.bluescreen/settings.json
    add("settings", route_fn(|r| async move {
        let file = user_dir().join("settings.json");
        if r.is_post() {
            r.local_only()?;
            let v: Value = r.body_json()?;
            write_atomic(&file, &serde_json::to_string_pretty(&v).unwrap_or_default())?;
            return ok(json!({ "saved": true }));
        }
        let v = read_json(&file);
        ok(if v.is_null() { json!({}) } else { v })
    }));
}
