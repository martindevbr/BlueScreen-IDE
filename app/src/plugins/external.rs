//! Plugins com servidor próprio: um programa na pasta do plugin. Pode ser um `server.exe` compilado ou um script
//! (`server.js`, `server.py`, `server.ps1`) que roda com o Node, o Python ou o PowerShell achados pela IDE; o campo
//! `server` do plugin.json escolhe outro arquivo ou um comando inteiro.
//! O núcleo inicia o programa, espera o aviso `BLUESCREEN-READY {"port":..,"routes":[..]}` na saída padrão e
//! encaminha cada /api/<rota> do plugin para ele. Desligar o plugin (ou recarregar) encerra o processo.
use super::{Reply, RouteFn, route_fn};
use crate::util::*;
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use bluescreen_sdk::plugin::{H_INTERNAL, H_REMOTE, H_TOKEN};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub struct Running { pub child: Child, pub port: u16, pub routes: Vec<String>, token: String }
impl Drop for Running {
    fn drop(&mut self) {
        TOKENS.lock().remove(&self.token);
        // a árvore toda: um servidor em Node/Python pode ter aberto outros processos (só enquanto ele está vivo, senão
        // o PID pode já ser de outro programa)
        #[cfg(windows)]
        if matches!(self.child.try_wait(), Ok(None)) {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill").args(["/PID", &self.child.id().to_string(), "/T", "/F"]).creation_flags(0x0800_0000).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let _ = self.child.kill(); let _ = self.child.wait();
    }
}

/// Token próprio de cada processo de plugin (BLUESCREEN_PLUGIN_TOKEN) -> id do plugin. O BLUESCREEN_TOKEN é o mesmo
/// para todos; este identifica quem chama (o cofre só entrega valores assim).
static TOKENS: LazyLock<parking_lot::Mutex<std::collections::HashMap<String, String>>> = LazyLock::new(Default::default);
pub fn token_owner(tok: &str) -> Option<String> { TOKENS.lock().get(tok).cloned() }

/// Como iniciar o servidor do plugin: o programa (ou o motivo de não dar para iniciar) e os argumentos.
pub struct Launch { pub program: Result<PathBuf, String>, pub args: Vec<String> }

/// Runtime de um script pela extensão: (programas, do preferido ao último; argumentos antes do script; nome)
fn runtime(ext: &str) -> Option<(&'static [&'static str], &'static [&'static str], &'static str)> {
    Some(match ext {
        "js" | "mjs" | "cjs" => (&["node"], &[], "Node.js"),
        // -u: sem buffer na saída, para o aviso BLUESCREEN-READY chegar na hora
        "py" => (&["python", "python3", "py"], &["-u"], "Python"),
        "ps1" => (&["pwsh", "powershell"], &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"], "PowerShell"),
        _ => return None,
    })
}
fn script(dir: &Path, rel: &str) -> Launch {
    let ext = Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let file = dir.join(rel);
    if ext == "exe" || ext.is_empty() { return Launch { program: Ok(file), args: vec![] }; }
    let Some((progs, pre, name)) = runtime(&ext) else {
        return Launch { program: Err(format!("não sei rodar o servidor {rel} (use .exe, .js, .py ou .ps1, ou um comando no campo server)")), args: vec![] };
    };
    let program = progs.iter().find_map(|p| crate::build::detect::which(p)).ok_or_else(|| format!("o servidor do plugin ({rel}) precisa do {name}: instale na janela SDKs ou adicione ao PATH"));
    Launch { program, args: pre.iter().map(|s| s.to_string()).chain(std::iter::once(file.to_string_lossy().into_owned())).collect() }
}
/// Servidor do plugin, se tiver: o campo `server` do plugin.json (um arquivo da pasta, ou `{ command, args }`); sem
/// ele, `server.exe`, `server.js`, `server.mjs`, `server.py` ou `server.ps1` da pasta; em desenvolvimento, o binário
/// `bluescreen-<id>` do cargo.
pub fn server_cmd(dir: &Path, id: &str, decl: &Value) -> Option<Launch> {
    if let Some(rel) = decl.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        let rel = rel.replace('\\', "/");
        if !bluescreen_sdk::store::safe_rel(&rel) { return Some(Launch { program: Err(format!("server inválido no plugin.json: {rel}")), args: vec![] }); }
        if !dir.join(&rel).is_file() { return Some(Launch { program: Err(format!("o servidor {rel} não está na pasta do plugin")), args: vec![] }); }
        return Some(script(dir, &rel));
    }
    if let Some(cmd) = decl["command"].as_str().filter(|s| !s.is_empty()) {
        let args = decl["args"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        // um programa da própria pasta (bin/srv.exe) ou um da busca da IDE (node, java, dotnet...)
        let local = dir.join(cmd);
        let program = if local.is_file() { Ok(local) } else { crate::build::detect::which(cmd).ok_or_else(|| format!("{cmd} não encontrado (servidor do plugin): instale ou adicione ao PATH")) };
        return Some(Launch { program, args });
    }
    let exe = if cfg!(windows) { "server.exe" } else { "server" };
    if let Some(f) = [exe, "server.js", "server.mjs", "server.py", "server.ps1"].into_iter().find(|f| dir.join(f).is_file()) { return Some(script(dir, f)); }
    let bin = format!("bluescreen-{id}{}", if cfg!(windows) { ".exe" } else { "" });
    ["release", "debug"].iter().map(|prof| app_dir().join("target").join(prof).join(&bin)).filter(|p| p.is_file())
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())
        .map(|p| Launch { program: Ok(p), args: vec![] })
}

/// Bibliotecas de apoio dos servidores em script (Node e Python), gravadas em ~/.bluescreen/sdk e passadas aos
/// plugins em BLUESCREEN_SDK: `require(process.env.BLUESCREEN_SDK + "/bluescreen.js")`.
pub fn sdk_dir() -> PathBuf {
    static DONE: std::sync::Once = std::sync::Once::new();
    let d = user_dir().join("sdk");
    DONE.call_once(|| {
        let _ = std::fs::create_dir_all(&d);
        for (name, text) in [("bluescreen.js", include_str!("../../sdk/scripts/bluescreen.js")), ("bluescreen_plugin.py", include_str!("../../sdk/scripts/bluescreen_plugin.py"))] {
            let f = d.join(name);
            if std::fs::read_to_string(&f).ok().as_deref() != Some(text) { let _ = write_atomic(&f, text); }
        }
    });
    d
}

/// Inicia o programa do plugin e espera ele avisar a porta (até 15 s).
pub fn start(id: &str, dir: &Path, launch: &Launch) -> anyhow::Result<Running> {
    let exe = launch.program.as_ref().map_err(|e| anyhow::anyhow!("{e}"))?;
    let (url, token) = (bluescreen_sdk::plugin::core().url.clone(), bluescreen_sdk::plugin::core().token().to_string());
    let own: String = (0..48).map(|_| format!("{:x}", rand::random_range(0..16u8))).collect();
    let data = super::data::dir(id);
    let _ = std::fs::create_dir_all(&data);
    // o token próprio vale desde já: o programa pode chamar o núcleo antes de avisar a porta (configurações, cofre);
    // se ele não chegar a ficar pronto, o token sai junto
    struct Forget(Option<String>);
    impl Drop for Forget { fn drop(&mut self) { if let Some(t) = self.0.take() { TOKENS.lock().remove(&t); } } }
    TOKENS.lock().insert(own.clone(), id.to_string());
    let mut forget = Forget(Some(own.clone()));
    let mut cmd = Command::new(exe);
    cmd.args(&launch.args).current_dir(dir).env("BLUESCREEN_URL", url).env("BLUESCREEN_TOKEN", token).env("BLUESCREEN_PLUGIN", id).env("BLUESCREEN_PLUGIN_DIR", dir)
        .env("BLUESCREEN_PLUGIN_DATA", &data).env("BLUESCREEN_SDK", sdk_dir()).env("BLUESCREEN_PLUGIN_TOKEN", &own).env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // sem janela de console
    }
    let mut child = cmd.spawn().map_err(|e| anyhow::anyhow!("não foi possível iniciar {}: {e}", exe.display()))?;
    job::assign(&child);
    let (tx, rx) = mpsc::channel::<Value>();
    let out = child.stdout.take().expect("stdout");
    let err = child.stderr.take().expect("stderr");
    let tag = id.to_string();
    std::thread::spawn(move || {
        // primeira linha útil: o aviso de pronto; o resto vai para o log do BlueScreen
        let mut sent = false;
        for line in crate::output::LinesSync::new(out) {
            if !sent { if let Some(j) = line.strip_prefix("BLUESCREEN-READY ") { let _ = tx.send(serde_json::from_str(j).unwrap_or_default()); sent = true; continue; } }
            log(format!("[{tag}] {line}"));
        }
    });
    let tag = id.to_string();
    std::thread::spawn(move || { for line in crate::output::LinesSync::new(err) { log(format!("[{tag}] {line}")); } });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(v) => {
            let port = v["port"].as_u64().unwrap_or(0) as u16;
            if port == 0 { let _ = child.kill(); anyhow::bail!("o servidor do plugin não informou a porta"); }
            let routes = v["routes"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            forget.0 = None; // pronto: o token fica até o Running sair
            Ok(Running { child, port, routes, token: own })
        }
        Err(_) => {
            let code = child.try_wait().ok().flatten().map(|s| format!(" (saiu com código {})", s.code().unwrap_or(-1))).unwrap_or_default();
            let _ = child.kill();
            anyhow::bail!("o servidor do plugin não respondeu{code}")
        }
    }
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().no_proxy().build().expect("http"));

/// Rota que repassa a requisição ao processo do plugin e devolve a resposta como veio.
pub fn proxy(id: String, port: u16, route: String) -> RouteFn {
    let id = Arc::new(id);
    route_fn(move |r| {
        let (id, route) = (id.clone(), route.clone());
        async move {
            let token = bluescreen_sdk::plugin::core().token().to_string();
            let mut rb = HTTP.request(r.method.clone(), format!("http://127.0.0.1:{port}/api/{route}{}", bluescreen_sdk::plugin::query_string(r.query.iter().map(|(k, v)| (k.as_str(), v.as_str())))))
                .header(H_TOKEN, token).header(H_REMOTE, if r.remote { "1" } else { "0" }).header(H_INTERNAL, if r.internal { "1" } else { "0" })
                .body(r.body.clone());
            if let Some(ct) = r.headers.get(header::CONTENT_TYPE) { rb = rb.header(header::CONTENT_TYPE, ct.clone()); }
            let resp = rb.send().await.map_err(|e| fail(format!("O plugin {id} não respondeu ({e}). Recarregue os plugins na aba Plugins."), 502))?;
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let headers = resp.headers().clone();
            let mut out = Response::new(Body::from_stream(resp.bytes_stream()));
            *out.status_mut() = status;
            copy_headers(&headers, &mut out);
            Ok(Reply::Raw(out))
        }
    })
}

/// Repassa o tipo do conteúdo e o nome do arquivo do plugin para o navegador.
pub fn copy_headers(from: &reqwest::header::HeaderMap, to: &mut Response) {
    for k in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION, header::CACHE_CONTROL] {
        if let Some(v) = from.get(k.as_str()).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) { to.headers_mut().insert(k, v); }
    }
}

/// Windows: os processos dos plugins ficam num Job Object que morre junto com o BlueScreen (mesmo se ele travar).
#[cfg(windows)]
pub mod job {
    use std::os::windows::io::AsRawHandle;
    use std::sync::LazyLock;
    use windows_sys::Win32::System::JobObjects::*;
    struct Job(isize);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    static JOB: LazyLock<Job> = LazyLock::new(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        Job(h as isize)
    });
    pub fn assign(child: &std::process::Child) { assign_raw(child.as_raw_handle()); }
    pub fn assign_raw(h: std::os::windows::io::RawHandle) { unsafe { AssignProcessToJobObject(JOB.0 as _, h as _); } }
    /// Job Object de uma árvore só (uma sessão de LSP/DAP): `kill` encerra o processo e tudo o que ele abriu (o node
    /// por trás de um atalho .cmd do npm), mesmo os netos que já não têm pai vivo. Ao sair do escopo, fecha o handle e,
    /// com KILL_ON_JOB_CLOSE, o que sobrou morre junto; se o BlueScreen cair, o Windows fecha o handle do mesmo jeito.
    pub struct Tree(isize);
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}
    impl Tree {
        pub fn new() -> Option<Tree> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() { return None; }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
                Some(Tree(h as isize))
            }
        }
        /// false: o Windows recusou (processo já saiu); quem chama ainda tem o JOB geral como rede de segurança
        pub fn add(&self, h: std::os::windows::io::RawHandle) -> bool { unsafe { AssignProcessToJobObject(self.0 as _, h as _) != 0 } }
        pub fn kill(&self) { unsafe { TerminateJobObject(self.0 as _, 1); } }
    }
    impl Drop for Tree { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); } } }
}
#[cfg(not(windows))]
pub mod job {
    pub fn assign(_: &std::process::Child) {}
    pub struct Tree;
    impl Tree { pub fn new() -> Option<Tree> { None } pub fn kill(&self) {} }
}
