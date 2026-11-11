//! Servidores de linguagem (LSP) e depuradores (DAP), como os do IntelliJ e do VS Code: o BlueScreen não reimplementa
//! a análise de cada linguagem, ele conversa com as ferramentas oficiais de cada uma (rust-analyzer, gopls, pyright,
//! clangd, jdtls, debugpy, Delve, lldb-dap...). Os dois protocolos usam a mesma moldura (cabeçalho Content-Length +
//! JSON), então uma ponte só liga o processo à página por WebSocket: cada mensagem vira um quadro de texto.
//! Ferramentas a mais ou com outro caminho: ~/.bluescreen/tools.json, lista de { id, kind, name, langs, command, args }.
use crate::build::detect::which;
use crate::util::{read_json, user_dir};
use axum::body::Body;
use axum::extract::FromRequest;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

#[derive(Serialize, Clone, Debug)]
pub struct Tool {
    pub id: String,
    /// "lsp" ou "dap"
    pub kind: &'static str,
    pub name: String,
    /// linguagens do editor (ids do Monaco) que a ferramenta atende
    pub langs: Vec<String>,
    /// caminho encontrado (vazio = não instalada)
    pub command: String,
    pub args: Vec<String>,
    /// como instalar, para mostrar na interface
    pub install: String,
    /// DAP por TCP: o processo abre {port} e a ponte conecta nele
    pub tcp: bool,
    pub installed: bool,
    /// como a IDE instala sozinha (sem console), se der neste PC
    #[serde(skip_serializing_if = "Option::is_none")] pub auto: Option<String>,
    /// o que falta para a IDE conseguir instalar (ex.: "precisa de Node.js (npm) instalado")
    #[serde(skip_serializing_if = "Option::is_none")] pub needs: Option<String>,
    /// SDK que a IDE pode baixar para resolver o que falta (node, python, jdk...; ver sdk.rs) e a versão mínima
    #[serde(skip_serializing_if = "Option::is_none")] pub sdk: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub sdk_min: Option<u32>,
}

struct Def { id: &'static str, kind: &'static str, name: &'static str, langs: &'static [&'static str], progs: &'static [&'static str], args: &'static [&'static str], install: &'static str, tcp: bool }
const fn lsp(id: &'static str, name: &'static str, langs: &'static [&'static str], progs: &'static [&'static str], args: &'static [&'static str], install: &'static str) -> Def {
    Def { id, kind: "lsp", name, langs, progs, args, install, tcp: false }
}
const fn dap(id: &'static str, name: &'static str, langs: &'static [&'static str], progs: &'static [&'static str], args: &'static [&'static str], install: &'static str, tcp: bool) -> Def {
    Def { id, kind: "dap", name, langs, progs, args, install, tcp }
}

const DEFS: &[Def] = &[
    // ----- análise e refatoração (LSP) -----
    // o jdtls não é aberto pelo jdtls.bat (que precisa de Python e usa o java do JAVA_HOME, muitas vezes 8 ou 17):
    // a IDE acha a pasta dele e um Java 21+ e roda o launcher direto (ver jdtls())
    lsp("jdtls", "Eclipse JDT LS (Java)", &["java"], &["jdtls"], &[], "scoop install jdtls"),
    lsp("tsserver", "TypeScript Language Server", &["typescript", "javascript"], &["typescript-language-server", "tsc"], &["--stdio"], "npm i -g typescript typescript-language-server"),
    lsp("basedpyright", "basedpyright (Python)", &["python"], &["basedpyright-langserver"], &["--stdio"], "pip install basedpyright"),
    lsp("pyright", "Pyright (Python)", &["python"], &["pyright-langserver"], &["--stdio"], "npm i -g pyright"),
    lsp("pylsp", "Python LSP Server", &["python"], &["pylsp"], &[], "pip install python-lsp-server"),
    lsp("rust-analyzer", "rust-analyzer", &["rust"], &["rust-analyzer"], &[], "rustup component add rust-analyzer"),
    lsp("gopls", "gopls (Go)", &["go"], &["gopls"], &[], "go install golang.org/x/tools/gopls@latest"),
    lsp("clangd", "clangd (C/C++)", &["c", "cpp"], &["clangd"], &[], "winget install LLVM.LLVM"),
    lsp("csharp-ls", "csharp-ls (C#)", &["csharp"], &["csharp-ls"], &[], "dotnet tool install -g csharp-ls"),
    lsp("kotlin", "Kotlin Language Server", &["kotlin"], &["kotlin-language-server"], &[], "scoop install kotlin-language-server"),
    lsp("intelephense", "Intelephense (PHP)", &["php"], &["intelephense"], &["--stdio"], "npm i -g intelephense"),
    lsp("ruby-lsp", "Ruby LSP", &["ruby"], &["ruby-lsp"], &[], "gem install ruby-lsp"),
    lsp("solargraph", "Solargraph (Ruby)", &["ruby"], &["solargraph"], &["stdio"], "gem install solargraph"),
    lsp("lua", "Lua Language Server", &["lua"], &["lua-language-server"], &[], "winget install LuaLS.lua-language-server"),
    lsp("html", "HTML (VS Code)", &["html"], &["vscode-html-language-server"], &["--stdio"], "npm i -g vscode-langservers-extracted"),
    lsp("css", "CSS, SCSS e Less (VS Code)", &["css", "scss", "less"], &["vscode-css-language-server"], &["--stdio"], "npm i -g vscode-langservers-extracted"),
    lsp("json", "JSON (VS Code)", &["json"], &["vscode-json-language-server"], &["--stdio"], "npm i -g vscode-langservers-extracted"),
    lsp("yaml", "YAML Language Server", &["yaml"], &["yaml-language-server"], &["--stdio"], "npm i -g yaml-language-server"),
    lsp("bash", "Bash Language Server", &["shell"], &["bash-language-server"], &["start"], "npm i -g bash-language-server"),
    lsp("lemminx", "LemMinX (XML)", &["xml"], &["lemminx"], &[], "scoop install lemminx"),
    lsp("dart", "Dart Analysis Server", &["dart"], &["dart"], &["language-server", "--protocol=lsp"], "instale o Dart SDK ou o Flutter"),
    lsp("zls", "ZLS (Zig)", &["zig"], &["zls"], &[], "winget install zigtools.zls"),
    // ----- depuração (DAP) -----
    dap("debugpy", "debugpy (Python)", &["python"], &["python", "py"], &["-m", "debugpy.adapter"], "pip install debugpy", false),
    dap("delve", "Delve (Go)", &["go"], &["dlv"], &["dap", "--listen=127.0.0.1:{port}"], "go install github.com/go-delve/delve/cmd/dlv@latest", true),
    dap("lldb-dap", "LLDB (C, C++ e Rust)", &["c", "cpp", "rust"], &["lldb-dap", "lldb-vscode"], &[], "winget install LLVM.LLVM", false),
    dap("codelldb", "CodeLLDB (C, C++ e Rust)", &["c", "cpp", "rust"], &["codelldb"], &["--port", "{port}"], "baixe o CodeLLDB (github.com/vadimcn/codelldb) e ponha adapter/ no PATH", true),
    dap("netcoredbg", "netcoredbg (.NET)", &["csharp"], &["netcoredbg"], &["--interpreter=vscode"], "scoop install netcoredbg", false),
    // Java: o depurador oficial (o mesmo do VS Code) é um plugin carregado dentro do jdtls; ele abre a porta DAP quando
    // pedido (vscode.java.startDebugSession) e a ponte só conecta nela (ver attach_session())
    dap("java-debug", "Java Debug (jdtls)", &["java"], &[], &[], "a IDE baixa o plugin de depuração do jdtls (com.microsoft.java.debug.plugin)", true),
    // JavaScript e TypeScript: o depurador do VS Code (js-debug) em modo servidor DAP, rodando no Node
    dap("js-debug", "js-debug (Node.js)", &["javascript", "typescript"], &["node"], &["{tools}/js-debug/js-debug/src/dapDebugServer.js", "{port}", "127.0.0.1"], "a IDE baixa o js-debug do GitHub (microsoft/vscode-js-debug)", true),
    // Ruby: rdbg (gem debug, vem com o Ruby 3.1+) abre a porta junto com o programa; a ponte só conecta
    dap("rdbg", "rdbg (Ruby)", &["ruby"], &["rdbg"], &[], "gem install debug", true),
];
/// depuradores que não são abertos pela ponte: a porta já vem aberta (pelo jdtls ou pelo programa) em &port=
const ATTACH_ONLY: &[&str] = &["java-debug", "rdbg"];

fn tools_dir() -> PathBuf { crate::install::tools_dir() }

/// debugpy não é um programa: o que precisa existir é o módulo no Python encontrado
fn extra_check(id: &str, prog: &Path) -> bool {
    match id {
        "debugpy" => {
            let mut c = std::process::Command::new(prog);
            c.args(["-c", "import debugpy"]).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
            c.status().map(|s| s.success()).unwrap_or(false)
        }
        // atalhos do rustup em ~/.cargo/bin (rust-analyzer...) existem mesmo sem o componente instalado; aí saem na
        // hora com "Unknown binary": só conta como instalado se responder ao --version
        _ if prog.parent().is_some_and(|d| d.ends_with(".cargo/bin") || d.ends_with(".cargo\\bin")) => {
            let mut c = std::process::Command::new(prog);
            c.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
            c.status().map(|s| s.success()).unwrap_or(false)
        }
        _ => true,
    }
}

/// plugin de depuração do jdtls baixado pela IDE (tools/java-debug/com.microsoft.java.debug.plugin-*.jar)
pub fn java_debug_jar() -> Option<PathBuf> {
    let mut jars: Vec<PathBuf> = std::fs::read_dir(tools_dir().join("java-debug")).ok()?.flatten().map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("com.microsoft.java.debug.plugin") && n.ends_with(".jar"))).collect();
    jars.sort(); jars.pop()
}

/// pasta do jdtls (a que tem plugins/org.eclipse.equinox.launcher_*.jar): baixada pela IDE, do scoop ou o bin no PATH
fn jdtls_home() -> Option<PathBuf> {
    let ok = |d: &Path| launcher_jar(d).is_some();
    let scoop = std::env::var_os("SCOOP").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join("scoop")));
    let mut cands = vec![tools_dir().join("jdtls")];
    cands.extend(scoop.map(|s| s.join("apps").join("jdtls").join("current")));
    cands.push(PathBuf::from("C:\\ProgramData\\scoop\\apps\\jdtls\\current"));
    // jdtls.bat no PATH: <pasta>\bin\jdtls.bat
    cands.extend(which("jdtls").and_then(|p| p.parent()?.parent().map(Path::to_path_buf)));
    cands.into_iter().find(|d| ok(d))
}
fn launcher_jar(home: &Path) -> Option<PathBuf> {
    let plugins = home.join("plugins");
    if plugins.join("org.eclipse.equinox.launcher.jar").is_file() { return Some(plugins.join("org.eclipse.equinox.launcher.jar")); }
    std::fs::read_dir(&plugins).ok()?.flatten().map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar")))
}
/// versão principal de um java (java -version escreve no stderr: openjdk version "21.0.2" / "1.8.0_402")
fn java_major(java: &Path) -> u32 {
    let mut c = std::process::Command::new(java);
    c.arg("-version").stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    let Ok(o) = c.output() else { return 0 };
    let s = String::from_utf8_lossy(&o.stderr);
    let v = s.split('"').nth(1).unwrap_or("");
    let mut it = v.split(['.', '_', '-', '+']).filter_map(|x| x.parse::<u32>().ok());
    match it.next() { Some(1) => it.next().unwrap_or(0), Some(n) => n, None => 0 }
}
/// Java mínimo do jdtls instalado: o que o org.eclipse.jdt.core declara (JavaSE-25 nas versões de 2026; o jdtls.py
/// ainda fala em 21 e, com 21, o servidor sai na hora com código 13). O tar do Windows lê o .jar (é um zip).
fn jdtls_java_min(home: &Path) -> u32 {
    let jar = std::fs::read_dir(home.join("plugins")).ok().and_then(|rd| rd.flatten().map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("org.eclipse.jdt.core_") && n.ends_with(".jar"))));
    let Some(jar) = jar else { return 21 };
    let mut c = std::process::Command::new("tar");
    c.arg("-xOf").arg(&jar).arg("META-INF/MANIFEST.MF").stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    let text = c.output().map(|o| String::from_utf8_lossy(&o.stdout).replace(['\r', '\n', ' '], "")).unwrap_or_default();
    regex::Regex::new(r"JavaSE-(\d+)|osgi\.ee=JavaSE\)\(version=(\d+)").ok()
        .and_then(|re| re.captures_iter(&text).filter_map(|c| c.get(1).or(c.get(2))?.as_str().parse().ok()).max()).unwrap_or(21)
}
/// o Java mais novo que sirva ao jdtls: os JDKs conhecidos (JAVA_HOME, Program Files, ~/.jdks), depois o java do PATH
fn java_for_jdtls(min: u32) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let mut jdks = crate::build::jdks(); jdks.sort_by_key(|j| std::cmp::Reverse(j.major));
    jdks.into_iter().filter(|j| j.major >= min).map(|j| Path::new(&j.home).join("bin").join(exe)).find(|p| p.is_file())
        .or_else(|| which("java").filter(|p| java_major(p) >= min))
}
/// Java mínimo do jdtls: o do instalado ou, sem ele, o que o pacote atual pede
fn jdtls_min() -> u32 { jdtls_home().as_deref().map(jdtls_java_min).unwrap_or(25) }
/// (comando, argumentos) do jdtls, ou o que falta (texto vazio = não instalado)
fn jdtls() -> Result<(PathBuf, Vec<String>), String> {
    let home = jdtls_home();
    let min = home.as_deref().map(jdtls_java_min).unwrap_or(25);
    let Some(java) = java_for_jdtls(min) else {
        return Err(if home.is_some() { format!("o jdtls está instalado, mas precisa do Java {min} ou mais novo (JDK)") } else { format!("precisa do Java {min} ou mais novo (JDK) instalado") });
    };
    let home = home.ok_or_else(String::new)?;
    let jar = launcher_jar(&home).ok_or_else(String::new)?;
    let config = home.join(if cfg!(windows) { "config_win" } else if cfg!(target_os = "macos") { "config_mac" } else { "config_linux" });
    let mut args: Vec<String> = vec![
        "-Declipse.application=org.eclipse.jdt.ls.core.id1".into(), "-Dosgi.bundles.defaultStartLevel=4".into(), "-Declipse.product=org.eclipse.jdt.ls.core.product".into(),
        "-Dosgi.checkConfiguration=true".into(), format!("-Dosgi.sharedConfiguration.area={}", config.display()), "-Dosgi.sharedConfiguration.area.readOnly=true".into(), "-Dosgi.configuration.cascaded=true".into(),
        "-Xms256m".into(), "--add-modules=ALL-SYSTEM".into(), "--add-opens".into(), "java.base/java.util=ALL-UNNAMED".into(), "--add-opens".into(), "java.base/java.lang=ALL-UNNAMED".into(),
    ];
    if java_major(&java) >= 24 { args.splice(0..0, ["-Djdk.xml.maxGeneralEntitySizeLimit=0".to_string(), "-Djdk.xml.totalEntitySizeLimit=0".to_string()]); }
    args.extend(["-jar".into(), jar.to_string_lossy().into_owned(), "-data".into(), "{data}".into()]);
    Ok((java, args))
}

pub fn detect() -> Vec<Tool> {
    let mut out: Vec<Tool> = DEFS.iter().map(|d| {
        if d.id == "jdtls" {
            let r = jdtls();
            let (auto, needs) = match &r { Ok(_) => (None, None), Err(e) if !e.is_empty() => (None, Some(e.clone())), Err(_) => crate::install::describe(d.id) };
            // falta Java: a IDE baixa um JDK novo o bastante (sdk.rs)
            let (sdk, sdk_min) = match &r { Err(e) if !e.is_empty() => (Some("jdk"), Some(jdtls_min())), _ => (None, None) };
            let (command, args) = r.map(|(j, a)| (j.to_string_lossy().into_owned(), a)).unwrap_or_default();
            return Tool { id: d.id.into(), kind: d.kind, name: d.name.into(), langs: d.langs.iter().map(|s| s.to_string()).collect(), installed: !command.is_empty(), command, args, install: d.install.into(), tcp: false, auto, needs, sdk, sdk_min };
        }
        if d.id == "java-debug" {
            // instalado = o plugin baixado e um jdtls que consiga carregá-lo
            let jar = java_debug_jar(); let jd = jdtls().is_ok();
            let (auto, needs) = if jar.is_some() { (None, None) } else { crate::install::describe(d.id) };
            let needs = if jd { needs } else { Some("precisa do Eclipse JDT LS (jdtls), o servidor de linguagem do Java".into()) };
            return Tool { id: d.id.into(), kind: d.kind, name: d.name.into(), langs: d.langs.iter().map(|s| s.to_string()).collect(), installed: jar.is_some() && jd,
                command: jar.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(), args: vec![], install: d.install.into(), tcp: true, auto, needs, sdk: None, sdk_min: None };
        }
        if d.id == "js-debug" {
            // o servidor do js-debug é um script: precisa do Node e do pacote baixado em tools/js-debug
            let script = ["js-debug/src/dapDebugServer.js", "src/dapDebugServer.js"].iter().map(|r| tools_dir().join("js-debug").join(r)).find(|p| p.is_file());
            let node = which("node");
            let (auto, needs) = if script.is_some() { (None, None) } else { crate::install::describe(d.id) };
            let needs = if node.is_some() { needs } else { Some("precisa do Node.js instalado".into()) };
            let args = script.as_ref().map(|s| vec![s.to_string_lossy().into_owned(), "{port}".into(), "127.0.0.1".into()]).unwrap_or_default();
            return Tool { id: d.id.into(), kind: d.kind, name: d.name.into(), langs: d.langs.iter().map(|s| s.to_string()).collect(), installed: script.is_some() && node.is_some(),
                command: node.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(), args, install: d.install.into(), tcp: true, auto, needs, sdk: None, sdk_min: None };
        }
        // baixada pela IDE (~/.bluescreen/tools/<id>) primeiro, depois o PATH
        let found = d.progs.iter().find_map(|p| crate::install::local(d.id, p).or_else(|| which(p).filter(|w| extra_check(d.id, w))));
        let (auto, needs) = if found.is_some() { (None, None) } else { crate::install::describe(d.id) };
        Tool {
            id: d.id.into(), kind: d.kind, name: d.name.into(), langs: d.langs.iter().map(|s| s.to_string()).collect(),
            command: found.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            args: d.args.iter().map(|s| s.to_string()).collect(), install: d.install.into(), tcp: d.tcp, installed: found.is_some(), auto, needs,
            sdk: if found.is_none() { crate::install::needs_sdk(d.id) } else { None }, sdk_min: None,
        }
    }).collect();
    // ~/.bluescreen/tools.json: ferramentas do usuário (mesmo id troca a de fábrica)
    if let Some(list) = read_json(&user_dir().join("tools.json")).as_array() {
        for v in list {
            let (Some(id), Some(cmd)) = (v["id"].as_str(), v["command"].as_str()) else { continue };
            let kind = if v["kind"].as_str() == Some("dap") { "dap" } else { "lsp" };
            let prog = if Path::new(cmd).is_absolute() { Some(PathBuf::from(cmd)).filter(|p| p.is_file()) } else { which(cmd) };
            let t = Tool {
                id: id.into(), kind, name: v["name"].as_str().unwrap_or(id).into(),
                langs: v["langs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                command: prog.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                args: v["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                install: v["install"].as_str().unwrap_or("").into(), tcp: v["tcp"].as_bool().unwrap_or(false), installed: prog.is_some(), auto: None, needs: None, sdk: None, sdk_min: None,
            };
            out.retain(|x| x.id != t.id); out.insert(0, t);
        }
    }
    out
}

static TOOLS: parking_lot::Mutex<Option<std::sync::Arc<Vec<Tool>>>> = parking_lot::const_mutex(None);
pub fn tools(fresh: bool) -> std::sync::Arc<Vec<Tool>> {
    if !fresh { if let Some(t) = TOOLS.lock().clone() { return t; } }
    // procurar de novo: sem isto o which devolvia o "não achei" guardado e nada instalado depois aparecia
    else { crate::build::detect::forget_which(); }
    let t = std::sync::Arc::new(detect()); *TOOLS.lock() = Some(t.clone()); t
}

fn deny(code: StatusCode, msg: &str) -> Response { (code, msg.to_string()).into_response() }

/// GET /api/rpc/ws?tool=<id>&root=<pasta> — inicia a ferramenta e liga ao WebSocket (só PC local, só a própria página).
/// Com &port=<n> (depuradores) não inicia nada: conecta na porta DAP que já está aberta.
pub async fn ws(req: Request<Body>, remote: bool, q: HashMap<String, String>) -> Response {
    if remote { return deny(StatusCode::FORBIDDEN, "só pelo PC local"); }
    if !crate::server::ws_origin_ok(req.headers(), remote) { return deny(StatusCode::FORBIDDEN, "origem não permitida"); }
    let list = tools(false);
    let Some(tool) = q.get("tool").and_then(|id| list.iter().find(|t| &t.id == id)).cloned() else { return deny(StatusCode::NOT_FOUND, "ferramenta desconhecida") };
    if !tool.installed { return deny(StatusCode::NOT_FOUND, "ferramenta não instalada"); }
    let root = q.get("root").map(PathBuf::from).filter(|p| p.is_dir()).or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("C:\\"));
    // &port=: só conecta num depurador que já está escutando (os ATTACH_ONLY, e as sessões filhas do js-debug)
    let attach = if tool.kind == "dap" { q.get("port").and_then(|p| p.parse::<u16>().ok()).unwrap_or(0) } else { 0 };
    if attach == 0 && ATTACH_ONLY.contains(&tool.id.as_str()) { return deny(StatusCode::BAD_REQUEST, "falta a porta do depurador"); }
    match WebSocketUpgrade::from_request(req, &()).await {
        Ok(up) => up.on_upgrade(move |socket| async move { if attach > 0 { attach_session(socket, tool, attach).await } else { session(socket, tool, root).await } }),
        Err(e) => e.into_response(),
    }
}

/// TypeScript 7 (o compilador nativo, em Go) não traz mais o lib/tsserver.js de que o typescript-language-server
/// precisa ("Could not find a valid TypeScript installation"): com ele, o próprio tsc é o servidor (tsc --lsp --stdio).
/// O TypeScript do projeto (node_modules) manda; sem ele, vale o global. None = seguir com o typescript-language-server.
fn ts_native(root: &Path) -> Option<(PathBuf, Vec<String>)> {
    let major = |pkg: &Path| read_json(&pkg.join("package.json"))["version"].as_str().and_then(|v| v.split('.').next()?.parse::<u32>().ok()).unwrap_or(0);
    let bin = |dir: &Path| ["tsc.cmd", "tsc.exe", "tsc"].iter().map(|b| dir.join(b)).find(|p| p.is_file());
    let args = vec!["--lsp".to_string(), "--stdio".to_string()];
    if let Some(nm) = root.ancestors().map(|d| d.join("node_modules")).find(|d| d.join("typescript").is_dir()) {
        let pkg = nm.join("typescript");
        if pkg.join("lib").join("tsserver.js").is_file() { return None; }
        if major(&pkg) >= 7 { if let Some(b) = bin(&nm.join(".bin")) { return Some((b, args)); } }
    }
    // global do npm: %APPDATA%\npm\tsc.cmd + %APPDATA%\npm\node_modules\typescript (no Linux/macOS: bin/ e lib/node_modules)
    let tsc = which("tsc")?;
    let dir = tsc.parent()?;
    let pkg = [dir.join("node_modules").join("typescript"), dir.parent()?.join("lib").join("node_modules").join("typescript")].into_iter().find(|p| p.is_dir())?;
    (!pkg.join("lib").join("tsserver.js").is_file() && major(&pkg) >= 7).then_some((tsc, args))
}

fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(0) }

async fn session(mut ws: WebSocket, tool: Tool, root: PathBuf) {
    let text = |v: Value| Message::Text(v.to_string().into());
    let port = if tool.tcp { free_port() } else { 0 };
    // pasta de trabalho do jdtls por projeto (ele guarda o índice lá)
    let data = user_dir().join("lsp-data").join(format!("{}-{:x}", tool.id, root.to_string_lossy().bytes().fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64))));
    let args: Vec<String> = tool.args.iter().map(|a| a.replace("{port}", &port.to_string()).replace("{data}", &data.to_string_lossy()).replace("{tools}", &tools_dir().to_string_lossy()).replace("{root}", &root.to_string_lossy())).collect();
    let (command, args) = match tool.id.as_str() {
        "tsserver" => match ts_native(&root) {
            Some((p, a)) => (p.to_string_lossy().into_owned(), a),
            // só o tsc foi achado, mas é um TypeScript antigo (sem LSP próprio): falta o typescript-language-server
            None if Path::new(&tool.command).file_stem().is_some_and(|s| s.eq_ignore_ascii_case("tsc")) => {
                let _ = ws.send(text(json!({ "bs": "error", "message": format!("o TypeScript instalado não tem servidor de linguagem próprio (só o 7 em diante); instale o typescript-language-server: {}", tool.install) }))).await;
                return;
            }
            None => (tool.command.clone(), args),
        },
        _ => (tool.command.clone(), args),
    };
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args).envs(crate::sdk::env()).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)] cmd.creation_flags(0x0800_0000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => { let _ = ws.send(text(json!({ "bs": "error", "message": format!("não deu para iniciar {}: {e}", tool.name) }))).await; return; }
    };
    // Job Object só desta sessão: fechar a sessão encerra a árvore inteira (o node por trás do atalho .cmd do npm, os
    // processos que o depurador abriu). Sem ele (Windows recusou), o Job Object geral: sai junto com o BlueScreen.
    let tree = crate::plugins::external::job::Tree::new();
    #[cfg(windows)]
    if let Some(h) = child.raw_handle() && !tree.as_ref().is_some_and(|t| t.add(h)) { crate::plugins::external::job::assign_raw(h); }
    // o que a ferramenta escreve no stderr vai para a página como log (aparece no console do BlueScreen)
    if let Some(err) = child.stderr.take() {
        let name = tool.id.clone();
        tokio::spawn(async move { let mut l = crate::output::Lines::new(err); while let Some(s) = l.next().await { crate::util::log(&format!("[{name}] {s}")); } });
    }
    let (reader, writer): (Box<dyn AsyncRead + Unpin + Send>, Box<dyn AsyncWrite + Unpin + Send>) = if tool.tcp {
        // DAP por TCP: espera o adaptador abrir a porta
        let mut conn = None;
        for _ in 0..100 { if let Ok(s) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await { conn = Some(s); break; } tokio::time::sleep(Duration::from_millis(100)).await; }
        let Some(s) = conn else { let _ = ws.send(text(json!({ "bs": "error", "message": format!("{} não abriu a porta {port}", tool.name) }))).await; kill_tree(&mut child, tree.as_ref()).await; return; };
        let (r, w) = s.into_split(); (Box::new(r), Box::new(w))
    } else {
        (Box::new(child.stdout.take().expect("stdout")), Box::new(child.stdin.take().expect("stdin")))
    };
    let _ = ws.send(text(json!({ "bs": "ready", "pid": child.id(), "name": tool.name, "port": port }))).await;
    pump(&mut ws, reader, writer, Some(&mut child)).await;
    // dá um instante para sair sozinha (depois do shutdown/disconnect da página); senão encerra. Mesmo saindo, o que ela
    // abriu e deixou para trás (netos) é encerrado junto com o Job Object da sessão.
    if tokio::time::timeout(Duration::from_millis(1500), child.wait()).await.is_err() { kill_tree(&mut child, tree.as_ref()).await; }
    if let Some(t) = &tree { t.kill(); }
}

/// depurador que já roda em outro processo (java-debug dentro do jdtls, rdbg junto do programa, js-debug de uma sessão
/// anterior): só conecta na porta dele
async fn attach_session(mut ws: WebSocket, tool: Tool, port: u16) {
    let text = |v: Value| Message::Text(v.to_string().into());
    let mut conn = None;
    for _ in 0..50 { if let Ok(s) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await { conn = Some(s); break; } tokio::time::sleep(Duration::from_millis(100)).await; }
    let Some(s) = conn else { let _ = ws.send(text(json!({ "bs": "error", "message": format!("{} não abriu a porta {port}", tool.name) }))).await; return; };
    let (r, w) = s.into_split();
    let _ = ws.send(text(json!({ "bs": "ready", "name": tool.name, "port": port }))).await;
    pump(&mut ws, Box::new(r), Box::new(w), None).await;
}

/// quadros Content-Length da ferramenta <-> mensagens de texto do WebSocket, até um dos lados fechar
async fn pump(ws: &mut WebSocket, reader: Box<dyn AsyncRead + Unpin + Send>, writer: Box<dyn AsyncWrite + Unpin + Send>, mut child: Option<&mut tokio::process::Child>) {
    let text = |v: Value| Message::Text(v.to_string().into());
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    let rtask = tokio::spawn(async move {
        let mut r = BufReader::new(reader);
        loop {
            // cabeçalhos até a linha vazia; só o Content-Length importa
            let mut len: Option<usize> = None;
            loop {
                let mut line = String::new();
                match r.read_line(&mut line).await { Ok(0) | Err(_) => return, Ok(_) => {} }
                let l = line.trim_end();
                if l.is_empty() { if len.is_some() { break; } continue; }
                if let Some(v) = l.strip_prefix("Content-Length:").or_else(|| l.strip_prefix("content-length:")) { len = v.trim().parse().ok(); }
            }
            let mut buf = vec![0u8; len.unwrap_or(0)];
            if r.read_exact(&mut buf).await.is_err() { return; }
            if tx.send(String::from_utf8_lossy(&buf).into_owned()).await.is_err() { return; }
        }
    });
    let mut writer = writer;
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some(s) => { if ws.send(Message::Text(s.into())).await.is_err() { break; } }
                None => {
                    // a saída fechou: normalmente o processo está saindo. Se ele continuar vivo (fechou só o stdout, ou
                    // um depurador TCP derrubou a conexão), não fica preso esperando: a sessão termina e quem chamou encerra
                    let code = match child.as_mut() { Some(c) => tokio::time::timeout(Duration::from_secs(3), c.wait()).await.ok().and_then(|r| r.ok()).and_then(|s| s.code()), None => None };
                    let _ = ws.send(text(json!({ "bs": "exit", "code": code }))).await; break;
                }
            },
            m = ws.recv() => match m {
                Some(Ok(Message::Text(t))) => {
                    let body = t.as_str().as_bytes();
                    let frame = [format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes(), body].concat();
                    if writer.write_all(&frame).await.is_err() || writer.flush().await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    rtask.abort();
    drop(writer);
}

/// shims do npm (.cmd) rodam o node como neto: encerrar só o filho deixaria o servidor vivo. Com o Job Object da sessão,
/// a árvore toda sai de uma vez; sem ele, o taskkill /T (que só acha os netos enquanto o pai está vivo).
async fn kill_tree(child: &mut tokio::process::Child, tree: Option<&crate::plugins::external::job::Tree>) {
    if let Some(t) = tree { t.kill(); }
    #[cfg(windows)]
    if tree.is_none() && let Some(pid) = child.id() {
        let mut c = tokio::process::Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x0800_0000);
        let _ = c.status().await;
    }
    let _ = child.kill().await;
}
