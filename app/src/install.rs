//! Instalar servidores de linguagem pela própria IDE, sem console (como o IntelliJ baixa JDKs e plugins).
//! Para cada ferramenta há receitas, em ordem de preferência:
//! - Cmd: o gerenciador oficial da linguagem (rustup, npm, pip, go, dotnet, gem), rodado escondido, com a saída no log;
//!   só vale se o gerenciador existir no PC;
//! - Github: baixa o pacote da última versão publicada (zip), com progresso, e extrai em ~/.bluescreen/tools/<id>
//!   (o tar.exe do Windows extrai zip). Não precisa de nada instalado antes e não pede administrador.
//! A instalação roda em segundo plano; a página consulta o andamento (GET rpc/install?tool=<id>).
//! No fim, o cache do PATH é limpo e as ferramentas são detectadas de novo (rpc::tools(true)).
use crate::build::detect::which;
use crate::util::{log, user_dir};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Copy)]
pub enum Recipe {
    /// programa, argumentos e o nome do que precisa estar instalado (para a mensagem)
    Cmd(&'static str, &'static [&'static str], &'static str),
    /// repositório no GitHub e o padrão (regex) do nome do pacote para Windows x64
    Github(&'static str, &'static str),
    /// pacote num endereço fixo (zip ou tar.gz)
    Url(&'static str),
    /// arquivo único num endereço fixo (ex.: um .jar), guardado como veio em tools/<id>
    File(&'static str),
}

pub fn recipes(id: &str) -> &'static [Recipe] {
    use Recipe::*;
    match id {
        "rust-analyzer" => &[Cmd("rustup", &["component", "add", "rust-analyzer"], "Rust (rustup)"), Github("rust-lang/rust-analyzer", r"^rust-analyzer-x86_64-pc-windows-msvc\.zip$")],
        "tsserver" => &[Cmd("npm", &["install", "-g", "typescript", "typescript-language-server"], "Node.js (npm)")],
        "basedpyright" => &[Cmd("pip", &["install", "--upgrade", "basedpyright"], "Python (pip)")],
        "pyright" => &[Cmd("npm", &["install", "-g", "pyright"], "Node.js (npm)")],
        "pylsp" => &[Cmd("pip", &["install", "--upgrade", "python-lsp-server"], "Python (pip)")],
        "gopls" => &[Cmd("go", &["install", "golang.org/x/tools/gopls@latest"], "Go")],
        "clangd" => &[Github("clangd/clangd", r"^clangd-windows-[\d.]+\.zip$")],
        "csharp-ls" => &[Cmd("dotnet", &["tool", "install", "--global", "csharp-ls"], ".NET SDK")],
        "kotlin" => &[Github("fwcd/kotlin-language-server", r"^server\.zip$")],
        "intelephense" => &[Cmd("npm", &["install", "-g", "intelephense"], "Node.js (npm)")],
        "ruby-lsp" => &[Cmd("gem", &["install", "ruby-lsp"], "Ruby (gem)")],
        "solargraph" => &[Cmd("gem", &["install", "solargraph"], "Ruby (gem)")],
        "lua" => &[Github("LuaLS/lua-language-server", r"-win32-x64\.zip$")],
        "html" | "css" | "json" => &[Cmd("npm", &["install", "-g", "vscode-langservers-extracted"], "Node.js (npm)")],
        "yaml" => &[Cmd("npm", &["install", "-g", "yaml-language-server"], "Node.js (npm)")],
        "bash" => &[Cmd("npm", &["install", "-g", "bash-language-server"], "Node.js (npm)")],
        "zls" => &[Github("zigtools/zls", r"x86_64-windows\.zip$")],
        "js-debug" => &[Github("microsoft/vscode-js-debug", r"^js-debug-dap-v[\d.]+\.tar\.gz$")],
        "rdbg" => &[Cmd("gem", &["install", "debug"], "Ruby (gem)")],
        "java-debug" => &[File("https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/0.53.1/com.microsoft.java.debug.plugin-0.53.1.jar")],
        "jdtls" => &[Url("https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz")],
        _ => &[],
    }
}

/// a receita que dá para usar neste PC (o gerenciador existe, ou é download direto)
pub fn pick(id: &str) -> Option<Recipe> {
    recipes(id).iter().copied().find(|r| match r { Recipe::Cmd(p, ..) => which(p).is_some(), Recipe::Github(..) | Recipe::Url(_) | Recipe::File(_) => true })
}
/// como a IDE vai instalar (para mostrar antes de clicar), ou o que falta para poder instalar
pub fn describe(id: &str) -> (Option<String>, Option<String>) {
    match pick(id) {
        Some(Recipe::Cmd(p, a, _)) => (Some(format!("{p} {}", a.join(" "))), None),
        Some(Recipe::Github(repo, _)) => (Some(format!("download do GitHub ({repo})")), None),
        Some(Recipe::Url(url) | Recipe::File(url)) => (Some(format!("download de {}", url.split('/').nth(2).unwrap_or(url))), None),
        None => (None, recipes(id).iter().find_map(|r| if let Recipe::Cmd(_, _, need) = r { Some(format!("precisa de {need} instalado")) } else { None })),
    }
}

/// sem gerenciador para instalar (npm, pip, go, dotnet...): o SDK que a IDE pode baixar para resolver
pub fn needs_sdk(id: &str) -> Option<&'static str> {
    if pick(id).is_some() { return None; }
    recipes(id).iter().find_map(|r| if let Recipe::Cmd(p, ..) = r { crate::sdk::for_program(p) } else { None })
}

/// pasta onde as ferramentas baixadas ficam
pub fn tools_dir() -> PathBuf { user_dir().join("tools") }
/// programa baixado pela IDE: procura <prog>.exe/.cmd/.bat até 4 níveis dentro de tools/<id>
pub fn local(id: &str, prog: &str) -> Option<PathBuf> {
    fn walk(d: &Path, names: &[String], depth: u32) -> Option<PathBuf> {
        let rd = std::fs::read_dir(d).ok()?;
        let mut dirs = vec![];
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { dirs.push(p); } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| names.iter().any(|x| x.eq_ignore_ascii_case(n))) { return Some(p); }
        }
        if depth == 0 { return None; }
        dirs.sort();
        dirs.iter().find_map(|d| walk(d, names, depth - 1))
    }
    let names: Vec<String> = ["exe", "cmd", "bat"].iter().map(|e| format!("{prog}.{e}")).collect();
    walk(&tools_dir().join(id), &names, 4)
}

#[derive(Serialize, Clone, Default)]
pub struct Job {
    /// running | done | error
    pub state: String,
    /// o que está fazendo agora
    pub step: String,
    /// 0..1 quando dá para medir (download); None = sem medida
    pub progress: Option<f64>,
    pub log: Vec<String>,
    pub error: Option<String>,
}
static JOBS: LazyLock<Mutex<HashMap<String, Job>>> = LazyLock::new(Default::default);

pub(crate) fn upd(id: &str, f: impl FnOnce(&mut Job)) { if let Some(j) = JOBS.lock().get_mut(id) { f(j); } }
pub(crate) fn line(id: &str, s: &str) {
    let s = s.trim_end();
    if s.is_empty() { return; }
    upd(id, |j| { j.log.push(s.to_string()); if j.log.len() > 300 { j.log.remove(0); } if j.progress.is_none() { j.step = s.chars().take(160).collect(); } });
}

pub fn status(id: &str) -> Value { JOBS.lock().get(id).map(|j| json!(j)).unwrap_or(Value::Null) }

/// marca um trabalho como começado; Some = já estava rodando (devolve o andamento dele)
pub(crate) fn begin(id: &str) -> Option<Value> {
    let mut jobs = JOBS.lock();
    if jobs.get(id).is_some_and(|j| j.state == "running") { return Some(json!(jobs[id])); }
    jobs.insert(id.into(), Job { state: "running".into(), step: "Preparando…".into(), ..Default::default() });
    None
}
/// fecha o trabalho como instalado ou com o erro
pub(crate) fn finish(id: &str, err: Option<String>) {
    if let Some(e) = &err { log(&format!("[install {id}] {e}")); }
    upd(id, |j| { j.state = if err.is_some() { "error" } else { "done" }.into(); j.step = if err.is_some() { "Falhou".into() } else { "Instalado".into() }; j.progress = None; j.error = err; });
}

/// começa a instalar (se já está instalando, só devolve o andamento)
pub fn start(id: &str) -> Result<Value, String> {
    let Some(recipe) = pick(id) else { return Err(describe(id).1.unwrap_or_else(|| "a IDE ainda não sabe instalar esta ferramenta sozinha".into())) };
    if let Some(running) = begin(id) { return Ok(running); }
    let id2 = id.to_string();
    tokio::spawn(async move {
        let r = match recipe { Recipe::Cmd(p, a, _) => run_cmd(&id2, p, a).await, Recipe::Github(repo, pat) => github(&id2, repo, pat).await, Recipe::Url(url) => from_url(&id2, url).await, Recipe::File(url) => save_file(&id2, url).await };
        crate::build::detect::forget_which();
        let tools = tokio::task::spawn_blocking(|| crate::rpc::tools(true)).await.ok();
        let ok = tools.as_ref().is_some_and(|t| t.iter().any(|t| t.id == id2 && t.installed));
        let err = match r { Err(e) => Some(e), Ok(()) if !ok => Some("a instalação terminou, mas o programa não foi encontrado; veja o log".into()), Ok(()) => None };
        finish(&id2, err);
    });
    Ok(status(id))
}

pub(crate) fn hidden(c: &mut tokio::process::Command) { #[cfg(windows)] c.creation_flags(0x0800_0000); let _ = c; }

pub(crate) async fn run_cmd(id: &str, prog: &str, args: &[&str]) -> Result<(), String> {
    let exe = which(prog).ok_or_else(|| format!("{prog} não encontrado"))?;
    upd(id, |j| j.step = format!("Rodando {prog} {}…", args.join(" ")));
    line(id, &format!("> {prog} {}", args.join(" ")));
    let mut c = tokio::process::Command::new(&exe);
    c.args(args).envs(crate::sdk::env()).current_dir(dirs::home_dir().unwrap_or_else(std::env::temp_dir)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1").env("PYTHONIOENCODING", "utf-8").env("npm_config_fund", "false").env("npm_config_audit", "false").kill_on_drop(true);
    hidden(&mut c);
    let mut child = c.spawn().map_err(|e| format!("não deu para rodar {prog}: {e}"))?;
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let (a, b) = (id.to_string(), id.to_string());
    let t1 = tokio::spawn(async move { if let Some(o) = out { let mut l = crate::output::Lines::new(o); while let Some(s) = l.next().await { line(&a, &s); } } });
    let t2 = tokio::spawn(async move { if let Some(o) = err { let mut l = crate::output::Lines::new(o); while let Some(s) = l.next().await { line(&b, &s); } } });
    let st = tokio::time::timeout(std::time::Duration::from_secs(900), child.wait()).await.map_err(|_| "demorou demais (15 min)".to_string())?.map_err(|e| e.to_string())?;
    let _ = tokio::join!(t1, t2);
    if st.success() { Ok(()) } else { Err(format!("{prog} terminou com erro (código {})", st.code().unwrap_or(-1))) }
}

async fn github(id: &str, repo: &str, pat: &str) -> Result<(), String> {
    let http = reqwest::Client::builder().user_agent("BlueScreen-IDE").build().map_err(|e| e.to_string())?;
    upd(id, |j| j.step = format!("Procurando a última versão em github.com/{repo}…"));
    let rel: Value = http.get(format!("https://api.github.com/repos/{repo}/releases/latest")).header("Accept", "application/vnd.github+json").send().await
        .and_then(|r| r.error_for_status()).map_err(|e| format!("GitHub: {e}"))?.json().await.map_err(|e| e.to_string())?;
    let re = regex::Regex::new(pat).map_err(|e| e.to_string())?;
    let asset = rel["assets"].as_array().into_iter().flatten().find(|a| a["name"].as_str().is_some_and(|n| re.is_match(n)))
        .ok_or_else(|| format!("a versão {} não tem pacote para Windows", rel["tag_name"].as_str().unwrap_or("?")))?;
    let (name, url, size) = (asset["name"].as_str().unwrap_or("pacote.zip").to_string(), asset["browser_download_url"].as_str().unwrap_or("").to_string(), asset["size"].as_u64().unwrap_or(0));
    line(id, &format!("{} · {name} ({:.1} MB)", rel["tag_name"].as_str().unwrap_or(""), size as f64 / 1048576.0));
    download(id, &http, &url, &name, size).await
}

async fn from_url(id: &str, url: &str) -> Result<(), String> {
    let http = reqwest::Client::builder().user_agent("BlueScreen-IDE").build().map_err(|e| e.to_string())?;
    download(id, &http, url, url.rsplit('/').next().unwrap_or("pacote"), 0).await
}

/// baixa um arquivo só (pequeno) para tools/<id>/<nome>, trocando de uma vez
async fn save_file(id: &str, url: &str) -> Result<(), String> {
    let http = reqwest::Client::builder().user_agent("BlueScreen-IDE").build().map_err(|e| e.to_string())?;
    let name = url.rsplit('/').next().unwrap_or("arquivo");
    let dir = tools_dir().join(id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    upd(id, |j| j.step = format!("Baixando {name}…"));
    let bytes = http.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("download: {e}"))?.bytes().await.map_err(|e| format!("download: {e}"))?;
    let tmp = dir.join(format!("{name}.download"));
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, dir.join(name)).await.map_err(|e| e.to_string())?;
    line(id, &format!("Instalado em {}", dir.join(name).display()));
    Ok(())
}

/// baixa o pacote e extrai em tools/<id>
async fn download(id: &str, http: &reqwest::Client, url: &str, name: &str, size: u64) -> Result<(), String> {
    fetch(id, http, url, name, size, None, &tools_dir().join(id), false).await
}

/// soma publicada pela fonte (o download é conferido enquanto chega)
pub(crate) enum Sum { Sha256(String), Sha512(String) }
enum Hasher { None, S256(sha2::Sha256), S512(sha2::Sha512) }

/// baixa url (zip ou tar.gz) com progresso no trabalho `job`, confere a soma e extrai em `dest`, trocando a pasta de
/// uma vez (uma versão antiga continua funcionando se algo falhar). flatten: o pacote tem uma pasta só por fora
/// (node-v24-win-x64/, jdk-25+7/, go/...) e o conteúdo dela é que vai para dest.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch(job: &str, http: &reqwest::Client, url: &str, name: &str, size: u64, sum: Option<Sum>, dest: &Path, flatten: bool) -> Result<(), String> {
    use sha2::Digest;
    let base = dest.parent().ok_or("pasta de destino inválida")?.to_path_buf();
    let leaf = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    tokio::fs::create_dir_all(&base).await.map_err(|e| e.to_string())?;
    let zip = base.join(format!("{leaf}.download"));
    // download em blocos, com progresso
    let resp = http.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("download: {e}"))?;
    let total = resp.content_length().unwrap_or(size).max(1);
    let mut f = tokio::fs::File::create(&zip).await.map_err(|e| e.to_string())?;
    let mut h = match &sum { Some(Sum::Sha256(_)) => Hasher::S256(sha2::Sha256::new()), Some(Sum::Sha512(_)) => Hasher::S512(sha2::Sha512::new()), None => Hasher::None };
    let (mut got, mut stream) = (0u64, resp.bytes_stream());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download: {e}"))?;
        f.write_all(&chunk).await.map_err(|e| e.to_string())?;
        match &mut h { Hasher::S256(x) => x.update(&chunk), Hasher::S512(x) => x.update(&chunk), Hasher::None => {} }
        got += chunk.len() as u64;
        let p = got as f64 / total as f64;
        upd(job, |j| { j.progress = Some(p.min(1.0)); j.step = format!("Baixando {name}… {:.1} de {:.1} MB", got as f64 / 1048576.0, total as f64 / 1048576.0); });
    }
    f.flush().await.map_err(|e| e.to_string())?;
    drop(f);
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let (want, have) = match (sum, h) { (Some(Sum::Sha256(w)), Hasher::S256(x)) => (w, hex(&x.finalize())), (Some(Sum::Sha512(w)), Hasher::S512(x)) => (w, hex(&x.finalize())), _ => (String::new(), String::new()) };
    if !want.is_empty() {
        if !want.trim().eq_ignore_ascii_case(&have) { let _ = tokio::fs::remove_file(&zip).await; return Err(format!("o arquivo baixado não confere com a soma publicada (esperado {}, veio {have})", want.trim())); }
        line(job, "Soma conferida");
    }
    upd(job, |j| { j.progress = None; j.step = "Extraindo…".into(); });
    let tmp = base.join(format!("{leaf}.new"));
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| e.to_string())?;
    // o tar do Windows (System32) extrai zip e tar.gz
    let mut c = tokio::process::Command::new("tar");
    c.arg("-xf").arg(&zip).arg("-C").arg(&tmp).stdout(Stdio::null()).stderr(Stdio::piped());
    hidden(&mut c);
    let out = c.output().await.map_err(|e| format!("tar: {e}"))?;
    let _ = tokio::fs::remove_file(&zip).await;
    if !out.status.success() { let _ = tokio::fs::remove_dir_all(&tmp).await; return Err(format!("não deu para extrair: {}", String::from_utf8_lossy(&out.stderr).trim())); }
    let mut src = tmp.clone();
    if flatten {
        let ents: Vec<_> = std::fs::read_dir(&tmp).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        if let [one] = ents.as_slice() && one.is_dir() { src = one.clone(); }
    }
    // a versão anterior só sai depois que a nova entrou: em uso (ou se a troca falhar), ela continua funcionando
    let old = base.join(format!("{leaf}.old"));
    let had = dest.exists();
    if had {
        let _ = tokio::fs::remove_dir_all(&old).await;
        if let Err(e) = tokio::fs::rename(dest, &old).await {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
            return Err(format!("não deu para trocar a pasta (algum programa dela está aberto?): {e}"));
        }
    }
    let moved = tokio::fs::rename(&src, dest).await;
    if src != tmp { let _ = tokio::fs::remove_dir_all(&tmp).await; }
    if let Err(e) = moved {
        if had { let _ = tokio::fs::rename(&old, dest).await; }
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(format!("não deu para trocar a pasta (algum programa dela está aberto?): {e}"));
    }
    if had { let _ = tokio::fs::remove_dir_all(&old).await; }
    line(job, &format!("Instalado em {}", dest.display()));
    Ok(())
}
