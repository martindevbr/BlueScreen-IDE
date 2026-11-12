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

pub(super) fn add_routes(m: &mut HashMap<String, RouteFn>) {
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
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
