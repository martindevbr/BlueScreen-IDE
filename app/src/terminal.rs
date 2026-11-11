//! Terminal embutido (como o do IntelliJ): cada aba é um shell de verdade num pseudoconsole do Windows (ConPTY),
//! ligado à página por WebSocket. Reconhece os shells instalados: PowerShell 7, Windows PowerShell, Prompt de
//! Comando, Git Bash, WSL, MSYS2, Cygwin, Nushell, os prompts de desenvolvedor do Visual Studio e os perfis com
//! linha de comando do Windows Terminal. Só responde pelo PC local e só para a própria página (Origin).
use crate::build::detect::which;
use axum::body::Body;
use axum::extract::FromRequest;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Serialize, Clone)]
pub struct Shell {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    /// tipo para o ícone na interface: ps, cmd, bash, wsl, nu, vs, wt
    pub kind: &'static str,
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

fn sh(id: &str, name: &str, program: &Path, args: &[&str], kind: &'static str) -> Shell {
    Shell { id: id.into(), name: name.into(), program: program.to_string_lossy().into_owned(), args: args.iter().map(|s| s.to_string()).collect(), kind, env: vec![] }
}
fn env_path(var: &str, rest: &str) -> Option<PathBuf> { std::env::var_os(var).map(|v| PathBuf::from(v).join(rest)) }
fn first_file(c: impl IntoIterator<Item = Option<PathBuf>>) -> Option<PathBuf> { c.into_iter().flatten().find(|p| p.is_file()) }
/// %VAR% do Windows expandidas (perfis do Windows Terminal)
fn expand(s: &str) -> String {
    let mut out = String::new(); let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]); let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => { let name = &after[..j]; match std::env::var(name) { Ok(v) if !name.is_empty() => out.push_str(&v), _ => { out.push('%'); out.push_str(name); out.push('%'); } } rest = &after[j + 1..]; }
            None => { out.push('%'); rest = after; }
        }
    }
    out.push_str(rest); out
}
/// linha de comando em programa + argumentos (aspas como no Windows, sem os casos raros de barra invertida)
fn split_cmdline(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut q, mut any) = (vec![], String::new(), false, false);
    for c in s.chars() {
        match c { '"' => { q = !q; any = true; } c if c.is_whitespace() && !q => { if any || !cur.is_empty() { out.push(std::mem::take(&mut cur)); any = false; } } c => cur.push(c) }
    }
    if any || !cur.is_empty() { out.push(cur); }
    out
}
/// JSON com comentários (settings.json do Windows Terminal)
fn strip_jsonc(s: &str) -> String {
    let b = s.as_bytes(); let mut out = Vec::with_capacity(b.len()); let (mut i, mut str_) = (0, false);
    while i < b.len() {
        let c = b[i];
        if str_ { out.push(c); if c == b'\\' && i + 1 < b.len() { out.push(b[i + 1]); i += 1; } else if c == b'"' { str_ = false; } i += 1; continue; }
        if c == b'"' { str_ = true; out.push(c); i += 1; continue; }
        if c == b'/' && b.get(i + 1) == Some(&b'/') { while i < b.len() && b[i] != b'\n' { i += 1; } continue; }
        if c == b'/' && b.get(i + 1) == Some(&b'*') { i += 2; while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') { i += 1; } i += 2; continue; }
        out.push(c); i += 1;
    }
    // vírgula sobrando antes de } ou ]
    let s = String::from_utf8_lossy(&out).into_owned();
    regex::Regex::new(r",(\s*[}\]])").map(|r| r.replace_all(&s, "$1").into_owned()).unwrap_or(s)
}

fn detect() -> Vec<Shell> {
    let mut v: Vec<Shell> = vec![];
    if let Some(p) = which("pwsh").or_else(|| first_file([env_path("ProgramFiles", "PowerShell\\7\\pwsh.exe")])) { v.push(sh("pwsh", "PowerShell 7", &p, &["-NoLogo"], "ps")); }
    if let Some(p) = first_file([env_path("SystemRoot", "System32\\WindowsPowerShell\\v1.0\\powershell.exe")]).or_else(|| which("powershell")) { v.push(sh("powershell", "Windows PowerShell", &p, &["-NoLogo"], "ps")); }
    if let Some(p) = first_file([std::env::var_os("ComSpec").map(PathBuf::from), env_path("SystemRoot", "System32\\cmd.exe")]) { v.push(sh("cmd", "Prompt de Comando", &p, &[], "cmd")); }
    // Git Bash: bash.exe do Git for Windows (login, mas na pasta do projeto: CHERE_INVOKING)
    let git_bash = which("git").and_then(|g| g.parent().and_then(|d| d.parent()).map(|r| r.join("bin\\bash.exe")));
    if let Some(p) = first_file([env_path("ProgramFiles", "Git\\bin\\bash.exe"), env_path("ProgramFiles(x86)", "Git\\bin\\bash.exe"), env_path("LOCALAPPDATA", "Programs\\Git\\bin\\bash.exe"), git_bash]) {
        let mut s = sh("gitbash", "Git Bash", &p, &["--login", "-i"], "bash"); s.env.push(("CHERE_INVOKING".into(), "1".into())); v.push(s);
    }
    if let Some(p) = first_file([env_path("SystemRoot", "System32\\wsl.exe")]) { v.push(sh("wsl", "WSL", &p, &["--cd", "{cwd}"], "wsl")); }
    if let Some(p) = first_file([Some(PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe"))]) {
        let mut s = sh("msys2", "MSYS2 (UCRT64)", &p, &["--login", "-i"], "bash");
        s.env.extend([("CHERE_INVOKING".into(), "1".into()), ("MSYSTEM".into(), "UCRT64".into())]); v.push(s);
    }
    if let Some(p) = first_file([Some(PathBuf::from("C:\\cygwin64\\bin\\bash.exe")), Some(PathBuf::from("C:\\cygwin\\bin\\bash.exe"))]) {
        let mut s = sh("cygwin", "Cygwin", &p, &["--login", "-i"], "bash"); s.env.push(("CHERE_INVOKING".into(), "1".into())); v.push(s);
    }
    if let Some(p) = which("nu") { v.push(sh("nu", "Nushell", &p, &[], "nu")); }
    // Visual Studio: prompt e PowerShell de desenvolvedor (MSVC, msbuild, dotnet no PATH)
    if let Some(vswhere) = first_file([env_path("ProgramFiles(x86)", "Microsoft Visual Studio\\Installer\\vswhere.exe")]) {
        let mut c = std::process::Command::new(vswhere);
        c.args(["-latest", "-products", "*", "-property", "installationPath"]);
        #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
        if let Ok(o) = c.output() {
            let vs = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let bat = Path::new(&vs).join("Common7\\Tools\\VsDevCmd.bat");
            if !vs.is_empty() && bat.is_file() {
                if let Some(cmd) = v.iter().find(|s| s.id == "cmd").map(|s| s.program.clone()) {
                    v.push(Shell { id: "vsdevcmd".into(), name: "Developer Command Prompt (VS)".into(), program: cmd, args: vec!["/k".into(), bat.to_string_lossy().into_owned()], kind: "vs", env: vec![] });
                }
                let dll = Path::new(&vs).join("Common7\\Tools\\Microsoft.VisualStudio.DevShell.dll");
                if let (true, Some(ps)) = (dll.is_file(), v.iter().find(|s| s.id == "powershell").map(|s| s.program.clone())) {
                    let script = format!("& {{ Import-Module '{}'; Enter-VsDevShell -VsInstallPath '{}' -SkipAutomaticLocation }}", dll.display(), vs);
                    v.push(Shell { id: "vsdevps".into(), name: "Developer PowerShell (VS)".into(), program: ps, args: vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), script], kind: "vs", env: vec![] });
                }
            }
        }
    }
    // perfis do Windows Terminal que têm linha de comando própria (os que não repetem um shell já listado)
    let wt = [env_path("LOCALAPPDATA", "Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json"), env_path("LOCALAPPDATA", "Packages\\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\\LocalState\\settings.json"), env_path("LOCALAPPDATA", "Microsoft\\Windows Terminal\\settings.json")];
    for f in wt.into_iter().flatten().filter(|p| p.is_file()) {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let Ok(j) = serde_json::from_str::<Value>(&strip_jsonc(&text)) else { continue };
        let list = j["profiles"]["list"].as_array().or_else(|| j["profiles"].as_array()).cloned().unwrap_or_default();
        for p in list {
            if p["hidden"].as_bool() == Some(true) { continue; }
            let (Some(name), Some(cl)) = (p["name"].as_str(), p["commandline"].as_str()) else { continue };
            let parts = split_cmdline(&expand(cl)); let Some(first) = parts.first() else { continue };
            let prog = if Path::new(first).is_absolute() { PathBuf::from(first) } else { match which(first) { Some(p) => p, None => continue } };
            if !prog.is_file() { continue; }
            let args: Vec<String> = parts[1..].to_vec();
            let same = v.iter().any(|s| Path::new(&s.program).file_name().map(|n| n.to_ascii_lowercase()) == prog.file_name().map(|n| n.to_ascii_lowercase()) && (args.is_empty() || s.args == args));
            if same { continue; }
            let id = format!("wt:{}", p["guid"].as_str().unwrap_or(name));
            if v.iter().any(|s| s.id == id) { continue; }
            v.push(Shell { id, name: name.into(), program: prog.to_string_lossy().into_owned(), args, kind: "wt", env: vec![] });
        }
    }
    v
}

static SHELLS: Mutex<Option<Arc<Vec<Shell>>>> = parking_lot::const_mutex(None);
pub fn shells(fresh: bool) -> Arc<Vec<Shell>> {
    if !fresh { if let Some(s) = SHELLS.lock().clone() { return s; } }
    let s = Arc::new(detect()); *SHELLS.lock() = Some(s.clone()); s
}

fn deny(code: StatusCode, msg: &str) -> Response { (code, msg.to_string()).into_response() }

/// GET /api/terminal/ws?shell=<id>&cwd=<pasta>&cols=&rows= — abre um shell e liga ao WebSocket.
/// Do navegador para cá: texto JSON {"i": "entrada"} ou {"r": [colunas, linhas]}; daqui para lá: bytes da saída
/// (binário) e texto JSON {"ready": {pid, shell}} / {"exit": código} / {"error": msg}.
pub async fn ws(req: Request<Body>, remote: bool, q: HashMap<String, String>) -> Response {
    if remote { return deny(StatusCode::FORBIDDEN, "só pelo PC local"); }
    // WebSocket não passa por CORS: só a própria página pode abrir um shell
    if !crate::server::ws_origin_ok(req.headers(), remote) { return deny(StatusCode::FORBIDDEN, "origem não permitida"); }
    let list = shells(false);
    let id = q.get("shell").cloned().unwrap_or_default();
    let Some(shell) = list.iter().find(|s| s.id == id).or_else(|| list.first()).cloned() else { return deny(StatusCode::NOT_FOUND, "nenhum shell encontrado") };
    let cwd = q.get("cwd").map(PathBuf::from).filter(|p| p.is_dir()).or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("C:\\"));
    let num = |k: &str, d: u16| q.get(k).and_then(|v| v.parse::<u16>().ok()).filter(|n| *n > 1 && *n < 2000).unwrap_or(d);
    let (cols, rows) = (num("cols", 120), num("rows", 30));
    match WebSocketUpgrade::from_request(req, &()).await {
        Ok(up) => up.on_upgrade(move |socket| session(socket, shell, cwd, cols, rows)),
        Err(e) => e.into_response(),
    }
}

async fn session(mut ws: WebSocket, shell: Shell, cwd: PathBuf, cols: u16, rows: u16) {
    let text = |v: Value| Message::Text(v.to_string().into());
    let size = |cols: u16, rows: u16| PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = match native_pty_system().openpty(size(cols, rows)) {
        Ok(p) => p,
        Err(e) => { let _ = ws.send(text(json!({ "error": format!("não deu para abrir o pseudoconsole: {e}") }))).await; return; }
    };
    let cwd_s = cwd.to_string_lossy().into_owned();
    let mut cmd = CommandBuilder::new(&shell.program);
    for a in &shell.args { cmd.arg(a.replace("{cwd}", &cwd_s)); }
    cmd.cwd(&cwd);
    for (k, v) in [("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("TERM_PROGRAM", "BlueScreen")] { cmd.env(k, v); }
    for (k, v) in crate::sdk::env() { cmd.env(k, v); }
    for (k, v) in &shell.env { cmd.env(k, v); }
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => { let _ = ws.send(text(json!({ "error": format!("não deu para iniciar {}: {e}", shell.name) }))).await; return; }
    };
    drop(pair.slave);
    let pid = child.process_id();
    let mut killer = child.clone_killer();
    let (Ok(mut reader), Ok(mut writer)) = (pair.master.try_clone_reader(), pair.master.take_writer()) else { let _ = killer.kill(); return };
    // leitura e escrita do pseudoconsole são bloqueantes: uma thread para cada, ligadas por canais
    let (otx, mut orx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
    let _ = std::thread::Builder::new().name("bs-term-read".into()).spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        loop { match reader.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => if otx.blocking_send(buf[..n].to_vec()).is_err() { break } } }
    });
    let (wtx, wrx) = std::sync::mpsc::channel::<Vec<u8>>();
    let _ = std::thread::Builder::new().name("bs-term-write".into()).spawn(move || { while let Ok(b) = wrx.recv() { if writer.write_all(&b).and_then(|_| writer.flush()).is_err() { break; } } });
    let (etx, mut erx) = tokio::sync::oneshot::channel::<u32>();
    let _ = std::thread::Builder::new().name("bs-term-wait".into()).spawn(move || { let code = child.wait().map(|s| s.exit_code()).unwrap_or(1); let _ = etx.send(code); });

    let _ = ws.send(text(json!({ "ready": { "pid": pid, "shell": shell.name, "cwd": cwd_s } }))).await;
    loop {
        tokio::select! {
            Some(b) = orx.recv() => { if ws.send(Message::Binary(b.into())).await.is_err() { break; } }
            code = &mut erx => {
                // o que o shell escreveu por último ainda está chegando
                tokio::time::sleep(Duration::from_millis(80)).await;
                while let Ok(b) = orx.try_recv() { let _ = ws.send(Message::Binary(b.into())).await; }
                let _ = ws.send(text(json!({ "exit": code.unwrap_or(1) }))).await;
                break;
            }
            m = ws.recv() => match m {
                Some(Ok(Message::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    if let Some(s) = v["i"].as_str() { let _ = wtx.send(s.as_bytes().to_vec()); }
                    if let Some(r) = v["r"].as_array() {
                        let n = |i: usize| r.get(i).and_then(|x| x.as_u64()).map(|x| x.clamp(2, 1999) as u16);
                        if let (Some(c), Some(rw)) = (n(0), n(1)) { let _ = pair.master.resize(size(c, rw)); }
                    }
                }
                Some(Ok(Message::Binary(b))) => { let _ = wtx.send(b.to_vec()); }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    // fechar o pseudoconsole encerra também o que estava rodando dentro do shell
    let _ = killer.kill();
    drop(wtx);
    drop(pair.master);
}
