//! BlueScreen: IDE leve para mostrar código e alterações (Git/SVN), estilo IntelliJ, com plugins.
//!   bluescreen [pasta] [--lan] [--web] [--no-open] [--devtools]
//!   bluescreen --doc <arquivo>    janela leve só com o documento (o "Abrir com" do Windows, assoc.rs)
//!   bluescreen --unregister       tira o BlueScreen do "Abrir com" (os desinstaladores chamam)
//! O núcleo (servidor, Git/SVN, árvore, busca, lint, rede local) é Rust; a interface é a página em wwwroot/,
//! mostrada numa janela nativa com WebView2 (ou no navegador com --web).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assoc;
mod automation;
mod tray;
mod bigfile;
mod deps;
mod build;
mod desktop;
mod install;
mod lint;
mod output;
mod plugins;
mod rpc;
mod sdk;
mod server;
mod share;
mod terminal;
mod update;
mod watch;
mod workspace;
pub(crate) use bluescreen_sdk::{util, vcs};

use std::path::PathBuf;
use std::time::Duration;
use util::log;

fn fatal(msg: &str) -> ! {
    log(msg);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MessageBoxW};
        let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        MessageBoxW(std::ptr::null_mut(), w(msg).as_ptr(), w("BlueScreen").as_ptr(), MB_ICONERROR);
    }
    std::process::exit(1)
}

/// Porta ocupada por outro BlueScreen: se ele tem janela, só traz para a frente (ou, com --web/--no-open, usa ele como
/// está, sem fechar a janela de ninguém); senão pede para encerrar (versões antigas, em Node, não têm /api/activate) e,
/// se não sair, finaliza o processo pelo PID. Ok(false): a instância aberta continua e esta sai.
/// `replace`: aberto pelo atualizador (BLUESCREEN_REPLACE): a instância antiga sai mesmo tendo janela.
async fn take_over(port: u16, want_window: bool, replace: bool) -> Result<bool, String> {
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())?;
    let cfg: serde_json::Value = match http.get(format!("{base}/api/config")).send().await { Ok(r) => r.json().await.unwrap_or_default(), Err(_) => Default::default() };
    if cfg.get("root").is_none() || cfg.get("network").is_none() { return Err(format!("A porta {port} está em uso por outro programa. Use BLUESCREEN_PORT para escolher outra.")); }
    if want_window && !replace && cfg["desktop"].as_bool() == Some(true) {
        // quem o usuário acabou de abrir pode passar o direito de ir para a frente à instância que já está aberta
        #[cfg(windows)]
        if let Some(pid) = cfg["pid"].as_u64() { unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid as u32); } }
        if let Ok(r) = http.post(format!("{base}/api/activate")).header("X-BlueScreen", "takeover").send().await {
            if r.status().is_success() { return Ok(false); }
        }
    }
    // --web/--no-open com uma IDE aberta numa janela: o servidor dela serve; derrubá-la perderia o que não foi salvo
    if !want_window && !replace && cfg["desktop"].as_bool() == Some(true) { return Ok(false); }
    let _ = http.post(format!("{base}/api/shutdown")).header("X-BlueScreen", "takeover").send().await;
    let free = || std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_err();
    for _ in 0..10 { tokio::time::sleep(Duration::from_millis(200)).await; if free() { return Ok(true); } }
    if let Some(pid) = cfg["pid"].as_u64().filter(|&p| p as u32 != std::process::id()) {
        log(format!("Encerrando o BlueScreen antigo (PID {pid}) que ocupava a porta {port}."));
        let _ = util::run("taskkill", &["/PID", &pid.to_string(), "/T", "/F"], &std::env::temp_dir(), 5000).await;
        for _ in 0..15 { tokio::time::sleep(Duration::from_millis(200)).await; if free() { return Ok(true); } }
    }
    Err(format!("Não foi possível liberar a porta {port}. Feche a outra instância ou use BLUESCREEN_PORT."))
}

/// Documento aberto pelo Windows ("Abrir com", dois cliques): um processo à parte, numa porta livre qualquer, sem
/// mexer na IDE que estiver aberta. A pasta do arquivo vira o projeto; os plugins com servidor próprio não sobem
/// (a planilha roda só na página), então a janela fica pronta quase tão rápido quanto o WebView2 abre.
fn run_doc(file: PathBuf, devtools: bool) -> ! {
    if !file.is_file() { fatal(&format!("Arquivo não encontrado: {}", file.display())); }
    plugins::LIGHT.store(true, std::sync::atomic::Ordering::Relaxed);
    let dir = file.parent().map(PathBuf::from).unwrap_or_default();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("bluescreen-doc").build().expect("tokio");
    let listener = rt.block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0))).unwrap_or_else(|e| fatal(&format!("Não foi possível abrir o documento: {e}")));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let _ = server::create(dir, port, 0);
    log(format!("documento: {}  ▸  http://127.0.0.1:{port}", file.display()));
    rt.spawn(async move { let _ = axum::serve(listener, server::router(false)).await; });
    let _rt = Box::leak(Box::new(rt));
    let url = format!("http://127.0.0.1:{port}/?doc={}", urlencoding::encode(&file.to_string_lossy()));
    desktop::run(url, devtools, Some(file))
}

/// Erro interno (panic) em qualquer thread vai para o log com o nome da thread e o lugar; com panic = "unwind" a IDE
/// segue aberta: a rota que falhou responde 500 (server.rs), a tarefa do tokio termina e as outras continuam.
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let t = std::thread::current();
        log(format!("ERRO interno (panic) na thread {}: {info}", t.name().unwrap_or("sem nome")));
        default(info);
    }));
}

fn main() {
    #[cfg(windows)]
    unsafe { windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS); }
    log_panics();
    // SDKs baixados pela IDE (sdk.rs) no PATH do processo, antes de qualquer thread
    sdk::apply_env_at_startup();
    // reinício pedido pelo atualizador: vale só para esta instância (os terminais e plugins não herdam)
    let replace = std::env::var_os("BLUESCREEN_REPLACE").is_some();
    unsafe { std::env::remove_var("BLUESCREEN_REPLACE"); }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--unregister") { assoc::unregister(); return; }
    // --doc <arquivo>, ou um arquivo (não pasta) passado direto, como "Abrir com" e arrastar para o exe fazem
    let doc = args.iter().position(|a| a == "--doc").and_then(|i| args.get(i + 1)).cloned()
        .or_else(|| args.iter().find(|a| !a.starts_with("--")).filter(|a| PathBuf::from(a).is_file()).cloned());
    if let Some(f) = doc { run_doc(util::absolute(&PathBuf::from(f)), has("--devtools")) }
    let env_port = |k: &str, d: u16| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let port = env_port("BLUESCREEN_PORT", 4747);
    let lan_port = env_port("BLUESCREEN_LAN_PORT", 4748);
    let headless = has("--no-open") || std::env::var("BLUESCREEN_NO_OPEN").is_ok_and(|v| !v.is_empty());
    let web = has("--web");
    let root = args.iter().find(|a| !a.starts_with("--")).map(|a| util::absolute(&PathBuf::from(a)))
        .unwrap_or_else(|| util::app_dir().parent().map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap_or_default()));

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("bluescreen").build().expect("tokio");
    if has("--quit") {
        let result=rt.block_on(async {reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/quit")).header("X-BlueScreen","takeover").timeout(Duration::from_secs(3)).send().await});
        match result {Ok(r) if r.status().is_success()=>{},Ok(r)=>log(format!("Não foi possível solicitar a saída: {}",r.status())),Err(e)=>log(format!("BlueScreen não está acessível: {e}"))}
        return;
    }
    let listener = rt.block_on(async {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                log(format!("Porta {port} ocupada. Verificando se é outro BlueScreen…"));
                match take_over(port, !headless && !web, replace).await {
                    Ok(false) if web => { log("O BlueScreen já está aberto numa janela: abrindo o navegador nele."); util::open_url(&format!("http://127.0.0.1:{port}")); std::process::exit(0) }
                    Ok(false) if headless => { log(format!("O BlueScreen já está aberto numa janela e atende em http://127.0.0.1:{port}.")); std::process::exit(0) }
                    Ok(false) => { log("O BlueScreen já está aberto: trouxe a janela para a frente."); std::process::exit(0) }
                    Ok(true) => tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap_or_else(|e| fatal(&format!("Porta {port}: {e}"))),
                    Err(m) => fatal(&m),
                }
            }
            Err(e) => fatal(&format!("Não foi possível iniciar o BlueScreen na porta {port}: {e}")),
        }
    });
    let _ = server::create(root.clone(), port, lan_port);
    // sobras de uma atualização (exe/dll antigos renomeados porque estavam em uso)
    let _ = std::thread::Builder::new().name("bs-update-cleanup".into()).spawn(update::cleanup);
    let _ = std::thread::Builder::new().name("bs-assoc".into()).spawn(assoc::register);
    let addr = format!("http://127.0.0.1:{port}");
    println!();
    log(format!("BlueScreen {} (Rust)  ▸  {addr}", server::VERSION));
    log(format!("pasta: {}", root.display()));
    server::host().print();
    rt.spawn(async move { let _ = axum::serve(listener, server::router(false)).await; });
    if has("--lan") {
        match rt.block_on(server::lan_enable()) {
            Ok(s) => log(format!("rede: PIN {}  {}", s["pin"].as_str().unwrap_or(""), s["urls"].as_array().map(|u| u.iter().filter_map(|x| x["url"].as_str()).collect::<Vec<_>>().join("  ")).unwrap_or_default())),
            Err(e) => log(format!("rede: falhou: {e}")),
        }
    }
    rt.spawn(automation::scheduler());
    println!();
    if headless { rt.block_on(std::future::pending::<()>()); }
    if web { util::open_url(&addr); rt.block_on(std::future::pending::<()>()); }
    // a janela precisa da thread principal; o servidor segue nas threads do tokio
    let _rt = Box::leak(Box::new(rt));
    desktop::run(addr + "/", has("--devtools"), None)
}
