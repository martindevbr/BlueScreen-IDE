//! Atualização pelo repositório (git) de onde este BlueScreen foi compilado.
//! O repositório é achado pelo `source.txt` que o instalador grava ao lado do exe ou subindo as pastas do exe
//! (app\dist\BlueScreen, app\target\release e app\ ficam dentro dele). Ao abrir a IDE, a página pergunta
//! (update/check): git fetch e os commits que chegaram. O que mudou decide o tamanho da atualização:
//! - só interface (app/wwwroot, ui.js/style.css de plugins, docs): git pull e copiar os arquivos; a página recarrega;
//! - núcleo (Rust, Cargo, build.ps1, ícone): git pull, build.ps1 numa pasta temporária, troca dos arquivos e reinício.
//!
//! A troca dos arquivos é transacional (ver swap): os arquivos retirados ficam temporariamente em .bs-update.
//! Um erro no meio desfaz a troca; depois de concluir, os temporários são removidos.
//! O reinício abre o exe novo com BLUESCREEN_REPLACE, que encerra esta instância.
use crate::build::detect::which;
use crate::plugins::{RouteFn, ok, route_fn};
use crate::util::*;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

#[derive(Default)]
struct Job {
    running: bool,
    step: usize,
    steps: Vec<&'static str>,
    progress: f64,
    line: String,
    lines: Vec<String>,
    error: Option<String>,
    done: bool,
    restart: bool,
    started: Option<Instant>,
    /// exe a abrir no reinício (o caminho de antes da troca)
    exe: Option<PathBuf>,
    /// versão publicada (GitHub Releases): baixa o pacote pronto em vez de compilar
    release: bool,
}
static JOB: LazyLock<Mutex<Job>> = LazyLock::new(Default::default);
static LAST: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Default::default);

fn is_repo(d: &Path) -> bool { d.join(".git").exists() && d.join("app").join("build.ps1").is_file() }
pub fn repo() -> Option<PathBuf> {
    let dir = app_dir();
    if let Ok(s) = std::fs::read_to_string(dir.join("source.txt")) { let p = PathBuf::from(s.trim()); if is_repo(&p) { return Some(p); } }
    dir.ancestors().find(|d| is_repo(d)).map(Path::to_path_buf)
}
async fn git(repo: &Path, args: &[&str], ms: u64) -> ProcResult { run("git", args, repo, ms).await }

/// o arquivo mudado exige compilar o núcleo?
fn native(f: &str) -> bool {
    // o servidor de plugins é um programa à parte, que a IDE não usa
    if !f.starts_with("app/") || f.ends_with(".md") || f.starts_with("app/wwwroot/") || f.starts_with("app/plugin-server/") { return false; }
    if f.starts_with("app/plugins/") { return f.contains("/src/") || f.ends_with("Cargo.toml"); }
    true
}

/// Pacotes do cargo que os arquivos mudados afetam (o resto não recompila). None = todos: mudou o SDK, que
/// núcleo e plugins usam, ou o Cargo.toml/Cargo.lock do workspace (versões das dependências).
fn packages(files: &[String]) -> Option<Vec<String>> {
    let mut out: Vec<String> = vec![];
    let mut add = |p: String| if !out.contains(&p) { out.push(p) };
    for f in files.iter().filter(|f| native(f)) {
        if f.starts_with("app/sdk/") || f == "app/Cargo.toml" || f == "app/Cargo.lock" { return None; }
        match f.strip_prefix("app/plugins/").and_then(|r| r.split('/').next()) {
            Some(id) => add(format!("bluescreen-{id}")),
            None => add("bluescreen".into()),
        }
    }
    Some(out)
}

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![
        ("update/check", route_fn(|r| async move {
            r.local_only()?;
            if !r.flag("fresh") { if let Some((t, v)) = LAST.lock().clone() { if t.elapsed() < Duration::from_secs(600) { return ok(v); } } }
            let v = check().await;
            *LAST.lock() = Some((Instant::now(), v.clone()));
            ok(v)
        })),
        ("update/apply", route_fn(|r| async move {
            r.local_only()?;
            if !r.is_post() { return Err(fail("use POST", 405)); }
            let info = check().await;
            if info["behind"].as_u64().unwrap_or(0) == 0 { return Err(fail("Nada para atualizar.", 409)); }
            let release = info["mode"] == "release";
            {
                let mut j = JOB.lock();
                if j.running { return Err(fail("A atualização já está rodando.", 409)); }
                if release {
                    *j = Job { running: true, started: Some(Instant::now()), restart: true, release: true,
                        steps: vec!["Baixar a versão nova", "Conferir e extrair", "Instalar a versão nova", "Reiniciar"], ..Default::default() };
                }
            }
            if release {
                tokio::spawn(async move { if let Err(e) = apply_release(info).await { let mut j = JOB.lock(); j.error = Some(e); j.running = false; } });
                return ok(json!({ "started": true }));
            }
            {
                let mut j = JOB.lock();
                let build = info["needsBuild"].as_bool() == Some(true);
                *j = Job { running: true, started: Some(Instant::now()), restart: build,
                    steps: if build { vec!["Baixar as alterações (git pull)", "Compilar o BlueScreen", "Instalar a versão nova", "Reiniciar"] } else { vec!["Baixar as alterações (git pull)", "Atualizar a interface"] },
                    ..Default::default() };
            }
            tokio::spawn(async move { if let Err(e) = apply(info).await { let mut j = JOB.lock(); j.error = Some(e); j.running = false; } });
            ok(json!({ "started": true }))
        })),
        ("update/status", route_fn(|_r| async move {
            let j = JOB.lock();
            ok(json!({ "running": j.running, "step": j.step, "steps": j.steps, "progress": j.progress, "line": j.line, "error": j.error, "done": j.done,
                "restart": j.restart, "release": j.release, "elapsed": j.started.map(|t| t.elapsed().as_secs()).unwrap_or(0), "tail": j.lines.iter().rev().take(80).rev().collect::<Vec<_>>() }))
        })),
        ("update/restart", route_fn(|r| async move {
            r.local_only()?;
            if !r.is_post() { return Err(fail("use POST", 405)); }
            let exe = JOB.lock().exe.clone().or_else(|| std::env::current_exe().ok()).ok_or_else(|| fail("exe não encontrado", 500))?;
            let args: Vec<String> = std::env::args().skip(1).collect();
            let mut c = std::process::Command::new(&exe);
            c.args(&args).env("BLUESCREEN_REPLACE", "1").current_dir(exe.parent().unwrap_or(Path::new(".")));
            c.spawn().map_err(|e| fail(format!("não abriu {}: {e}", exe.display()), 500))?;
            log("Reiniciando na versão nova.");
            ok(json!({ "ok": true }))
        })),
    ]
}

// ---------- versões publicadas (GitHub Releases, .github/workflows/release.yml) ----------
/// pacote de cada versão: BlueScreen-X.Y.Z-windows-x64.zip (+ .sha256)
const ASSET: &str = "-windows-x64.zip";
/// registro dos instaladores: AppId do app/installer/BlueScreen.iss (+ "_is1" do Inno Setup) e o do Instalar BlueScreen.cmd
const UNINSTALL_KEYS: &[&str] = &["{6B3F2D1A-9C4E-4E8B-A7D2-B1E5C0F3A9D4}_is1", "BlueScreen"];
fn releases_api() -> Option<String> {
    let slug = env!("CARGO_PKG_REPOSITORY").trim_end_matches('/').strip_prefix("https://github.com/")?.to_string();
    Some(format!("https://api.github.com/repos/{slug}/releases/latest"))
}
fn semver(v: &str) -> (u64, u64, u64) {
    let mut p = v.trim().trim_start_matches('v').split(['.', '-', '+']).map(|x| x.parse().unwrap_or(0));
    (p.next().unwrap_or(0), p.next().unwrap_or(0), p.next().unwrap_or(0))
}
/// rodando do código-fonte (app\, app\target\..., app\dist\...): quem programa atualiza pelo git e compila
fn from_source() -> bool {
    let d = absolute(&app_dir());
    repo().is_some_and(|r| { let app = absolute(&r.join("app")); d == app || within(&app.join("target"), &d) || within(&app.join("dist"), &d) })
}
/// instalação compilada do código neste PC (marcador do Instalar BlueScreen.cmd ou do atualizador): a versão dela é a
/// do Cargo.toml (X.Y.0) e os Releases são X.Y.Z, então o Release pareceria sempre "mais novo" e trocaria o build
/// local por cima. Ela segue pelo git, como quem roda do código.
fn local_build() -> bool { app_dir().join(LOCAL_BUILD).is_file() }
fn http(timeout: Option<u64>) -> Result<reqwest::Client, String> {
    let b = reqwest::Client::builder().user_agent(concat!("BlueScreen-IDE/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(15));
    let b = match timeout { Some(s) => b.timeout(Duration::from_secs(s)), None => b };
    b.build().map_err(|e| e.to_string())
}
/// último Release: { mode: "release", behind: 1 se é mais novo que esta versão, commits (das notas), url do zip... }
async fn check_release() -> Result<Value, String> {
    let api = releases_api().ok_or("o Cargo.toml não aponta um repositório do GitHub")?;
    let v: Value = http(Some(15))?.get(&api).header("Accept", "application/vnd.github+json").send().await.and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let tag = v["tag_name"].as_str().ok_or("Release sem tag")?.to_string();
    let assets = v["assets"].as_array().cloned().unwrap_or_default();
    let zip = assets.iter().find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(ASSET))).ok_or_else(|| format!("{tag} não tem o pacote para Windows"))?;
    let name = zip["name"].as_str().unwrap_or_default();
    let sha = assets.iter().find(|a| a["name"].as_str() == Some(&format!("{name}.sha256"))).and_then(|a| a["browser_download_url"].as_str());
    let remote = tag.trim_start_matches('v').to_string();
    let newer = semver(&remote) > semver(crate::server::VERSION);
    // notas geradas pelo workflow: "- assunto (hash)"
    let body = v["body"].as_str().unwrap_or_default();
    let commits: Vec<Value> = body.lines().filter_map(|l| l.trim().strip_prefix("- ")).map(|l| {
        let (subject, hash) = match l.rsplit_once(" (") { Some((s, h)) if h.ends_with(')') => (s, h.trim_end_matches(')')), _ => (l, "") };
        json!({ "subject": subject, "hash": hash, "author": "", "when": "" })
    }).collect();
    Ok(json!({ "available": true, "mode": "release", "behind": if newer { 1 } else { 0 }, "ahead": 0, "commits": commits, "files": 0,
        "needsBuild": true, "dirty": false, "version": crate::server::VERSION, "remoteVersion": remote, "remoteHead": tag,
        "upstream": format!("GitHub · {tag}"), "size": zip["size"], "url": zip["browser_download_url"], "digest": zip["digest"], "sha256Url": sha,
        "published": v["published_at"], "appDir": app_dir() }))
}

/// Baixa o zip do Release, confere o SHA-256, extrai e troca os arquivos da pasta do programa. Sem compilar.
async fn apply_release(info: Value) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::Digest;
    use tokio::io::AsyncWriteExt;
    let url = info["url"].as_str().ok_or("Release sem endereço do pacote")?.to_string();
    let dir = app_dir();
    let lock = update_lock(&dir)?;
    let stage = std::env::temp_dir().join("bluescreen-release");
    let _ = tokio::fs::remove_dir_all(&stage).await;
    tokio::fs::create_dir_all(&stage).await.map_err(|e| e.to_string())?;
    let zip = stage.join("pacote.zip");

    // 1. baixar (a soma é calculada enquanto chega)
    set(|j| { j.step = 0; j.progress = 0.02; });
    push(&format!("$ baixar {url}"));
    let client = http(None)?;
    let resp = client.get(&url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("download: {e}"))?;
    let total = resp.content_length().or(info["size"].as_u64()).unwrap_or(0).max(1);
    let mut f = tokio::fs::File::create(&zip).await.map_err(|e| e.to_string())?;
    let mut h = sha2::Sha256::new();
    let (mut got, mut stream) = (0u64, resp.bytes_stream());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download: {e}"))?;
        f.write_all(&chunk).await.map_err(|e| e.to_string())?;
        h.update(&chunk);
        got += chunk.len() as u64;
        let p = (got as f64 / total as f64).min(1.0);
        set(|j| { j.progress = 0.02 + 0.68 * p; j.line = format!("{:.1} de {:.1} MB", got as f64 / 1048576.0, total as f64 / 1048576.0); });
    }
    f.flush().await.map_err(|e| e.to_string())?;
    drop(f);
    push(&format!("baixado: {:.1} MB", got as f64 / 1048576.0));

    // 2. conferir a soma publicada e extrair
    set(|j| { j.step = 1; j.progress = 0.72; });
    let have = format!("{:x}", h.finalize());
    let want = match info["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")) {
        Some(d) => d.to_string(),
        None => match info["sha256Url"].as_str() {
            Some(u) => client.get(u).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("soma: {e}"))?.text().await.map_err(|e| e.to_string())?
                .split_whitespace().next().unwrap_or_default().to_string(),
            None => return Err("O Release não publica a soma SHA-256 do pacote; por segurança, nada foi instalado.".into()),
        },
    };
    if !want.eq_ignore_ascii_case(&have) { return Err(format!("O pacote baixado não confere com a soma publicada (esperado {want}, veio {have}). Nada foi instalado.")); }
    push(&format!("sha256 conferido: {have}"));
    // extraído na pasta de troca, ao lado da instalação (mesmo disco: a troca é só renomear)
    let out = upd(&dir).join("new");
    let _ = tokio::fs::remove_dir_all(&out).await;
    tokio::fs::create_dir_all(&out).await.map_err(|e| e.to_string())?;
    let x = run("tar", &["-xf", &zip.to_string_lossy(), "-C", &out.to_string_lossy()], &stage, 120_000).await;
    if !x.ok { let _ = tokio::fs::remove_dir_all(&out).await; return Err(format!("não deu para extrair o pacote: {}", x.err.trim())); }
    if !out.join(EXE).is_file() { let _ = tokio::fs::remove_dir_all(&out).await; return Err("o pacote não tem o BlueScreen.exe".into()); }
    set(|j| j.progress = 0.85);

    // 3. instalar: troca os arquivos por renomeação; um erro no meio desfaz (ver swap)
    set(|j| j.step = 2);
    let d2 = dir.clone();
    tokio::task::spawn_blocking(move || install_stage(&out, &d2)).await.map_err(|e| e.to_string())?.map_err(|e| format!("instalação em {}: {e}", dir.display()))?;
    drop(lock);
    push(&format!("instalado em {}", dir.display()));
    let _ = tokio::fs::remove_dir_all(&stage).await;
    // Configurações > Apps mostra a versão nova (instalado pelo BlueScreen-Setup.exe ou pelo Instalar BlueScreen.cmd)
    if let Some(v) = info["remoteVersion"].as_str() {
        for key in UNINSTALL_KEYS {
            let k = format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{key}");
            if run("reg", &["query", &k, "/v", "DisplayVersion"], &dir, 5_000).await.ok {
                let _ = run("reg", &["add", &k, "/v", "DisplayVersion", "/d", v, "/f"], &dir, 5_000).await;
            }
        }
    }
    set(|j| { j.exe = Some(dir.join("BlueScreen.exe")); j.step = 3; j.progress = 1.0; j.done = true; j.running = false; });
    *LAST.lock() = None;
    Ok(())
}

async fn check() -> Value {
    // instalado (fora do código-fonte): a versão pronta publicada pelo GitHub Actions; sem internet ou sem Release, o git
    if local_build() && repo().is_none() {
        return json!({ "available": false, "reason": "Este BlueScreen foi compilado do código, mas a pasta do repositório não foi encontrada (source.txt). Atualize pelo repositório e rode o instalador de novo." });
    }
    if !from_source() && !local_build() {
        match check_release().await {
            Ok(v) => return v,
            Err(e) => { log(format!("atualização: Releases indisponíveis ({e}); tentando pelo git")); if repo().is_none() { return json!({ "available": false, "reason": format!("Não deu para consultar as versões publicadas: {e}") }); } }
        }
    }
    let Some(repo) = repo() else { return json!({ "available": false, "reason": "Este BlueScreen não foi compilado de um repositório git (sem pasta de origem)." }) };
    if which("git").is_none() { return json!({ "available": false, "reason": "git não está no PATH." }); }
    let fetch = git(&repo, &["fetch", "--quiet", "--no-tags"], 45_000).await;
    let up = git(&repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000).await;
    if !up.ok { return json!({ "available": false, "repo": repo, "reason": "O branch atual não segue nenhum branch remoto." }); }
    let upstream = up.out.trim().to_string();
    // o resto não depende um do outro: em paralelo (cada git no Windows custa um processo novo)
    let (behind, ahead, log_out, diff, status, cargo_toml, head) = tokio::join!(
        git(&repo, &["rev-list", "--count", "HEAD..@{u}"], 10_000),
        git(&repo, &["rev-list", "--count", "@{u}..HEAD"], 10_000),
        git(&repo, &["log", "--no-merges", "-n", "60", "--format=%h%x1f%an%x1f%at%x1f%s", "HEAD..@{u}"], 10_000),
        git(&repo, &["diff", "--name-only", "HEAD...@{u}"], 10_000),
        git(&repo, &["status", "--porcelain", "--untracked-files=no"], 10_000),
        git(&repo, &["show", "@{u}:app/Cargo.toml"], 10_000),
        git(&repo, &["rev-parse", "--short", "@{u}"], 10_000),
    );
    let behind: u64 = behind.out.trim().parse().unwrap_or(0);
    let ahead: u64 = ahead.out.trim().parse().unwrap_or(0);
    let log_out = log_out.out;
    let commits: Vec<Value> = log_out.lines().filter_map(|l| {
        let p: Vec<&str> = l.split('\x1f').collect();
        (p.len() == 4).then(|| json!({ "hash": p[0], "author": p[1], "when": rel_time_unix(p[2]), "subject": p[3] }))
    }).collect();
    let files: Vec<String> = diff.out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let needs_build = files.iter().any(|f| native(f));
    let packages = packages(&files);
    let dirty = !status.out.trim().is_empty();
    let remote_version = cargo_toml.out.lines()
        .find_map(|l| l.trim().strip_prefix("version").and_then(|v| v.split('"').nth(1)).map(String::from)).unwrap_or_default();
    let head = head.out.trim().to_string();
    json!({ "available": true, "repo": repo, "upstream": upstream, "behind": behind, "ahead": ahead, "commits": commits, "files": files.len(),
        "needsBuild": needs_build, "packages": packages, "dirty": dirty, "version": crate::server::VERSION, "remoteVersion": remote_version, "remoteHead": head,
        "offline": !fetch.ok, "appDir": app_dir() })
}

fn set(f: impl FnOnce(&mut Job)) { f(&mut JOB.lock()); }
fn push(line: &str) {
    let mut j = JOB.lock();
    let l = line.trim_end().to_string();
    if !l.trim().is_empty() { j.line = l.trim().chars().take(200).collect(); }
    j.lines.push(l); if j.lines.len() > 4000 { j.lines.drain(..1000); }
}

async fn apply(info: Value) -> Result<(), String> {
    let repo = PathBuf::from(info["repo"].as_str().unwrap_or_default());
    let build = info["needsBuild"].as_bool() == Some(true);
    let dir = app_dir();
    let in_repo_app = absolute(&dir) == absolute(&repo.join("app")); // rodando do código-fonte (wwwroot do próprio repo)
    let _lock = if in_repo_app { None } else { Some(update_lock(&dir)?) };

    // 1. git pull (guarda e reaplica mudanças locais)
    set(|j| { j.step = 0; j.progress = 0.03; });
    push(&format!("$ git pull --ff-only --autostash  ({})", repo.display()));
    let r = run_env("git", &["pull", "--ff-only", "--autostash"], &repo, 180_000, &[("GIT_TERMINAL_PROMPT", "0")]).await;
    for l in r.out.lines().chain(r.err.lines()) { push(l); }
    if !r.ok { return Err("O git pull não conseguiu avançar (talvez o branch local tenha commits que não estão no remoto). Resolva no repositório e tente de novo.".into()); }
    set(|j| j.progress = if build { 0.08 } else { 0.5 });

    if !build {
        // 2. só interface: copia wwwroot e a interface dos plugins para a pasta do programa
        set(|j| j.step = 1);
        if !in_repo_app {
            mirror(&repo.join("app").join("wwwroot"), &dir.join("wwwroot")).map_err(|e| format!("cópia da interface: {e}"))?;
            plugin_ui(&repo.join("app").join("plugins"), &dir.join("plugins"));
            push(&format!("interface copiada para {}", dir.display()));
        } else { push("rodando do código-fonte: a interface já é a do repositório"); }
        set(|j| { j.progress = 1.0; j.done = true; j.running = false; j.step = 2; });
        *LAST.lock() = None;
        return Ok(());
    }

    // 2. compilar numa pasta temporária (a pasta em uso fica intacta até a troca)
    set(|j| j.step = 1);
    let app = repo.join("app");
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    // rodando de app\target\release: o cargo precisa sobrescrever o exe em uso
    if within(&app.join("target"), &me) { unlock(&me, &mut vec![])?; }
    let stage = std::env::temp_dir().join("bluescreen-update");
    let _ = std::fs::remove_dir_all(&stage);
    let total = std::fs::read_to_string(app.join("Cargo.lock")).map(|t| t.matches("[[package]]").count()).unwrap_or(400).max(150) as f64 * 0.8;
    let ps1 = app.join("build.ps1");
    // só o que mudou: os pacotes que ficam de fora vêm do target\release da compilação anterior
    let only: Vec<String> = info["packages"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let total = if only.is_empty() { total } else { only.len() as f64 * 3.0 };
    let mut c = tokio::process::Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&ps1).arg("-Out").arg(&stage).current_dir(&app)
        .env("CARGO_TERM_COLOR", "never").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    if let Some(home) = dirs::home_dir() { let path = std::env::var("PATH").unwrap_or_default(); c.env("PATH", format!("{};{path}", home.join(".cargo").join("bin").display())); }
    if !only.is_empty() { c.arg("-Packages").arg(only.join(",")); }
    crate::install::hidden(&mut c);
    push(&format!("$ build.ps1{}", if only.is_empty() { String::new() } else { format!(" -Packages {}", only.join(",")) }));
    let mut child = c.spawn().map_err(|e| format!("não abriu o powershell: {e}"))?;
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let compiled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let reader = |s: Box<dyn tokio::io::AsyncRead + Unpin + Send>, n: std::sync::Arc<std::sync::atomic::AtomicUsize>| tokio::spawn(async move {
        let mut lines = crate::output::Lines::new(s);
        while let Some(l) = lines.next().await {
            if l.trim_start().starts_with("Compiling ") {
                let k = n.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                set(|j| j.progress = j.progress.max(0.08 + 0.72 * (k as f64 / total).min(1.0)));
            } else if l.trim_start().starts_with("Finished") { set(|j| j.progress = j.progress.max(0.82)); }
            push(&l);
        }
    });
    let (a, b) = (reader(Box::new(out), compiled.clone()), reader(Box::new(err), compiled.clone()));
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = tokio::join!(a, b);
    if !status.success() { return Err("A compilação falhou. As últimas linhas do cargo estão abaixo.".into()); }

    // 3. instalar: troca os arquivos da pasta do programa pelos novos
    set(|j| { j.step = 2; j.progress = 0.86; });
    let new = stage.join("BlueScreen");
    let exe = if in_repo_app {
        push("rodando do código-fonte: o exe novo fica em app\\target\\release");
        app.join("target").join("release").join("bluescreen.exe")
    } else {
        install_tree(&new, &dir).map_err(|e| format!("instalação em {}: {e}", dir.display()))?;
        // compilada aqui: as próximas atualizações seguem pelo git, nunca pelo Release (ver check)
        let _ = std::fs::write(dir.join(LOCAL_BUILD), "compilado do código-fonte pelo atualizador do BlueScreen\n");
        push(&format!("instalado em {}", dir.display()));
        dir.join("BlueScreen.exe")
    };
    let _ = std::fs::remove_dir_all(&stage);
    set(|j| { j.exe = Some(exe); j.step = 3; j.progress = 1.0; j.done = true; j.running = false; });
    *LAST.lock() = None;
    Ok(())
}

// ---------- troca transacional dos arquivos ----------
// Tudo acontece dentro da pasta do programa, em .bs-update\ (mesmo disco: cada troca é uma renomeação, instantânea):
//   new\         a versão nova, copiada ou extraída inteira antes de mexer em qualquer arquivo em uso
//   prev-<n>\    arquivos retirados durante a troca; removidos ao concluir ou no próximo início se ainda em uso.
//   journal.json a troca em andamento: se o BlueScreen cair no meio, o próximo início desfaz (recover)
// O manifesto (.bluescreen-files) lista os arquivos instalados. Os que saíram da versão nova são removidos,
// sem tocar no que não é do programa (Desinstalar.cmd, source.txt, unins000.exe).
const UPD_DIR: &str = ".bs-update";
const MANIFEST: &str = ".bluescreen-files";
/// marcador gravado ao lado do exe quando ele foi compilado do código (Instalar BlueScreen.cmd ou o atualizador
/// compilando): essa instalação se atualiza pelo git e nunca recebe o Release por cima (ver check)
pub const LOCAL_BUILD: &str = "local-build.txt";
const EXE: &str = "BlueScreen.exe";

fn upd(dir: &Path) -> PathBuf { dir.join(UPD_DIR) }
/// arquivos de uma pasta, com caminho relativo em "/" (pastas vazias não contam)
fn files_of(root: &Path) -> Vec<String> {
    fn walk(root: &Path, d: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir()) { walk(root, &p, out); } else { out.push(rel(root, &p)); }
        }
    }
    let mut out = vec![]; walk(root, root, &mut out); out.sort(); out
}
/// caminho relativo de um manifesto ou diário: nada de "..", absoluto ou a pasta da própria atualização
fn safe_rel(r: &str) -> bool { !r.is_empty() && !r.starts_with('/') && !r.contains(':') && !r.contains('\\') && !r.split('/').any(|s| s.is_empty() || s == "." || s == "..") && !r.starts_with(UPD_DIR) }
fn read_list(p: &Path) -> Option<Vec<String>> { std::fs::read_to_string(p).ok().map(|t| t.lines().map(str::trim).filter(|l| safe_rel(l)).map(String::from).collect()) }

/// Lock de arquivo: duas instâncias (outra porta, outro usuário na mesma pasta) não atualizam ao mesmo tempo. O
/// Windows solta o arquivo quando o processo sai, mesmo se cair: não sobra trava velha.
pub struct UpdateLock(#[allow(dead_code)] std::fs::File);
fn update_lock(dir: &Path) -> Result<UpdateLock, String> {
    let d = upd(dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("não deu para criar {}: {e}", d.display()))?;
    let mut o = std::fs::OpenOptions::new(); o.write(true).create(true).truncate(false);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; o.share_mode(0); }
    let lock = o.open(d.join("lock")).map(UpdateLock).map_err(|e| format!("Não foi possível obter a trava da atualização (outra janela pode estar atualizando): {e}"))?;
    recover(dir)?;
    Ok(lock)
}

/// O que uma troca fez, para desfazer: `moved` saiu do lugar para old\ (substituído ou removido); `placed` entrou
/// vindo de new\ (e não existia antes quando também não está em `moved`).
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Journal { #[serde(default)] old: String, moved: Vec<String>, placed: Vec<String> }
/// pastas prev-<n> da mais antiga para a mais nova
fn prev_dirs(u: &Path) -> Vec<PathBuf> {
    let mut v: Vec<(u64, PathBuf)> = std::fs::read_dir(u).into_iter().flatten().flatten()
        .filter_map(|e| { let n = e.file_name().to_string_lossy().into_owned(); n.strip_prefix("prev-")?.parse().ok().map(|k| (k, e.path())) }).collect();
    v.sort(); v.into_iter().map(|(_, p)| p).collect()
}
fn mv(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(p) = to.parent() { std::fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))?; }
    std::fs::rename(from, to).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))
}
/// tira pastas que ficaram vazias depois de remover arquivos (só as do caminho de cada um, nunca a raiz)
fn prune_empty(dir: &Path, rels: &[String]) {
    for r in rels {
        let mut p = dir.join(r);
        while let Some(parent) = p.parent().map(Path::to_path_buf) {
            if parent == dir || std::fs::remove_dir(&parent).is_err() { break; }
            p = parent;
        }
    }
}
fn save_journal(dir: &Path, j: &Journal) -> Result<(), String> {
    write_atomic(&upd(dir).join("journal.json"), &serde_json::to_string(j).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
/// Desfaz a troca, preservando o diário e o backup se algum arquivo não puder voltar.
fn rollback(dir: &Path, stage: Option<&Path>, old: &Path, j: &mut Journal) -> Result<(), String> {
    // Registra as remoções antes de restaurar os originais: permite tentar novamente sem apagá-los.
    while let Some(r) = j.placed.last().cloned() {
        let at = dir.join(&r);
        if at.exists() {
            let back = stage.map(|s| s.join(&r));
            if !back.as_ref().is_some_and(|b| mv(&at, b).is_ok()) {
                std::fs::remove_file(&at).map_err(|e| format!("Retirada de {r}: {e}"))?;
            }
        }
        j.placed.pop(); save_journal(dir, j)?;
    }
    while let Some(r) = j.moved.last().cloned() {
        let o = old.join(&r);
        if o.exists() { mv(&o, &dir.join(&r))?; }
        j.moved.pop(); save_journal(dir, j)?;
    }
    Ok(())
}

/// Troca os arquivos de `dir` pelos de `stage` (mesmo disco) e remove `remove` (os que saíram da versão nova). Tudo
/// por renomeação, o BlueScreen.exe por último; um erro no meio desfaz o que já foi trocado.
/// Ao concluir, remove os temporários e devolve a lista nova do manifesto.
fn swap(dir: &Path, stage: &Path, remove: &[String]) -> Result<Vec<String>, String> {
    let u = upd(dir);
    let mut n = now_ms() as u64;
    while u.join(format!("prev-{n}")).exists() { n += 1; }
    let old = u.join(format!("prev-{n}"));
    let mut news = files_of(stage);
    if news.is_empty() { return Err("a versão nova está vazia".into()); }
    // o exe por último: até ele ser trocado, quem abre o programa pega a versão antiga
    news.sort_by_key(|r| r.eq_ignore_ascii_case(EXE));
    let mut j = Journal { old: format!("prev-{n}"), ..Default::default() };
    let journal = u.join("journal.json");
    let save = |j: &Journal| write_atomic(&journal, &serde_json::to_string(j).unwrap_or_default()).map_err(|e| format!("diário da atualização: {e}"));
    let res = (|| -> Result<(), String> {
        for r in remove.iter().filter(|r| !news.contains(r)) {
            let at = dir.join(r);
            if !at.is_file() { continue; }
            j.moved.push(r.clone()); save(&j)?;
            mv(&at, &old.join(r))?;
        }
        for r in &news {
            let at = dir.join(r);
            if at.exists() { j.moved.push(r.clone()); save(&j)?; mv(&at, &old.join(r))?; }
            j.placed.push(r.clone()); save(&j)?;
            mv(&stage.join(r), &at)?;
        }
        Ok(())
    })();
    if let Err(e) = res {
        push(&format!("erro na troca: {e}; desfazendo"));
        if let Err(back) = rollback(dir, Some(stage), &old, &mut j) {
            return Err(format!("{e}; falha ao restaurar: {back}. Diário e backup preservados em {}", u.display()));
        }
        let _ = std::fs::remove_file(&journal);
        let _ = std::fs::remove_dir_all(&old);
        return Err(e);
    }
    let removed: Vec<String> = j.moved.iter().filter(|r| !news.contains(r)).cloned().collect();
    prune_empty(dir, &removed);
    // A troca terminou: os arquivos retirados eram apenas temporários de recuperação.
    std::fs::remove_file(&journal).map_err(|e| e.to_string())?;
    for p in prev_dirs(&u) { let _ = std::fs::remove_dir_all(&p); }
    Ok(news)
}

/// Instala a pasta `src` (a versão nova, em qualquer disco) em `dst`: copia para .bs-update\new e troca (swap).
fn install_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let stage = upd(dst).join("new");
    let _ = std::fs::remove_dir_all(&stage);
    copy_tree_plain(src, &stage).map_err(|e| format!("cópia da versão nova: {e}"))?;
    install_stage(&stage, dst)
}
/// Troca `dst` pela versão já em .bs-update\new, com a lista do manifesto anterior (ou, na primeira vez, o que dá
/// para saber que é do programa: a interface e os plugins que vêm junto).
fn install_stage(stage: &Path, dst: &Path) -> Result<(), String> {
    let news = files_of(stage);
    let remove = read_list(&dst.join(MANIFEST)).unwrap_or_else(|| {
        let plugins: Vec<String> = news.iter().filter_map(|r| r.strip_prefix("plugins/")?.split('/').next().map(|id| format!("plugins/{id}/"))).collect();
        files_of(dst).into_iter().filter(|r| r.starts_with("wwwroot/") || plugins.iter().any(|p| r.starts_with(p.as_str()))).collect()
    });
    let list = swap(dst, stage, &remove)?;
    let _ = std::fs::remove_dir_all(stage);
    write_atomic(&dst.join(MANIFEST), &(list.join("\n") + "\n")).map_err(|e| format!("manifesto: {e}"))?;
    Ok(())
}
/// Troca que não terminou (o BlueScreen caiu no meio): desfaz pelo diário, no início do programa.
fn recover(dir: &Path) -> Result<(), String> {
    let u = upd(dir);
    let journal = u.join("journal.json");
    let text = match std::fs::read_to_string(&journal) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let mut j: Journal = serde_json::from_str(&text).map_err(|e| format!("Diário inválido; backup preservado: {e}"))?;
    if j.moved.iter().chain(&j.placed).any(|r| !safe_rel(r)) || !(j.old.is_empty() || j.old.starts_with("prev-") && safe_rel(&j.old)) {
        return Err("Diário com caminhos inválidos; backup preservado".into());
    }
    let old = if j.old.is_empty() { u.join("old") } else { u.join(&j.old) };
    rollback(dir, None, &old, &mut j)?;
    std::fs::remove_file(&journal).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}
/// arquivo em uso (exe/dll rodando): renomeia para *.old-<n> para liberar o nome; anota em `moved` (nome, renomeado).
/// Ainda usado para o exe de app\target\release (o cargo precisa sobrescrevê-lo ao compilar do código).
fn unlock(p: &Path, moved: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
    if !p.exists() || std::fs::OpenOptions::new().write(true).open(p).is_ok() { return Ok(()); }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let old = p.with_file_name(format!("{stem}.old-{}.{ext}", now_ms() as u64));
    std::fs::rename(p, &old).map_err(|e| format!("{} está em uso e não pôde ser trocado: {e}", p.display()))?;
    push(&format!("{} em uso: renomeado para {}", p.display(), old.file_name().unwrap_or_default().to_string_lossy()));
    moved.push((p.to_path_buf(), old));
    Ok(())
}
/// deixa `dst` igual a `src` (remove o que saiu da versão nova)
fn mirror(src: &Path, dst: &Path) -> Result<(), String> {
    copy_tree_plain(src, dst)?;
    fn prune(src: &Path, dst: &Path) {
        let Ok(rd) = std::fs::read_dir(dst) else { return };
        for e in rd.flatten() {
            let s = src.join(e.file_name());
            if !s.exists() { let _ = if e.path().is_dir() { std::fs::remove_dir_all(e.path()) } else { std::fs::remove_file(e.path()) }; }
            else if e.path().is_dir() { prune(&s, &e.path()); }
        }
    }
    prune(src, dst);
    Ok(())
}
fn copy_tree_plain(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let to = dst.join(e.file_name());
        if e.file_type().is_ok_and(|t| t.is_dir()) { copy_tree_plain(&e.path(), &to)?; }
        else { std::fs::copy(e.path(), &to).map_err(|er| format!("{}: {er}", to.display()))?; }
    }
    Ok(())
}
fn plugin_ui(src: &Path, dst: &Path) {
    let Ok(rd) = std::fs::read_dir(src) else { return };
    for e in rd.flatten() {
        let to = dst.join(e.file_name());
        if !to.is_dir() { continue; }
        for f in ["plugin.json", "ui.js", "style.css", "icon.svg", "icon.png"] { if e.path().join(f).is_file() { let _ = std::fs::copy(e.path().join(f), to.join(f)); } }
    }
}

/// apaga os *.old-<n>.exe/.dll deixados por uma atualização (já não estão em uso)
pub fn cleanup() {
    fn walk(d: &Path, depth: u32) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if e.file_type().is_ok_and(|t| t.is_dir()) { if depth > 0 && n != "wwwroot" && n != "node_modules" && n != "deps" && n != "build" { walk(&e.path(), depth - 1); } }
            else if n.contains(".old-") && (n.ends_with(".exe") || n.ends_with(".dll")) { let _ = std::fs::remove_file(e.path()); }
        }
    }
    let dir = app_dir();
    // troca interrompida: volta ao que era; sobras de uma troca (new\, old\ sem diário, versões anteriores presas)
    if let Err(e) = cleanup_update(&dir) { log(format!("Limpeza adiada: {e}")); return; }
    walk(&dir, 2);
    walk(&dir.join("target").join("release"), 0);
}

fn cleanup_update(dir: &Path) -> Result<(), String> {
    let _lock = update_lock(dir)?;
    let u = upd(dir);
    let _ = std::fs::remove_dir_all(u.join("new"));
    for p in prev_dirs(&u) { let _ = std::fs::remove_dir_all(&p); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{native, packages, semver};
    fn test_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bs-recovery-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap(); d
    }
    #[test]
    fn recovery_preserves_backup_and_retries() {
        use super::{Journal, upd, save_journal, recover};
        let d = test_dir(); let old = upd(&d).join("prev-1");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("a"), "old-a").unwrap();
        std::fs::write(old.join("b"), "old-b").unwrap();
        // An external directory blocks restoring a. b can already be restored.
        std::fs::create_dir(d.join("a")).unwrap();
        std::fs::write(d.join("a/block"), "keep").unwrap();
        std::fs::write(d.join("b"), "new-b").unwrap();
        save_journal(&d, &Journal { old: "prev-1".into(), moved: vec!["a".into(), "b".into()], placed: vec!["b".into()] }).unwrap();
        assert!(recover(&d).is_err());
        assert!(upd(&d).join("journal.json").is_file());
        assert_eq!(std::fs::read_to_string(old.join("a")).unwrap(), "old-a");
        assert_eq!(std::fs::read_to_string(d.join("b")).unwrap(), "old-b");
        std::fs::remove_file(d.join("a/block")).unwrap();
        std::fs::remove_dir(d.join("a")).unwrap();
        recover(&d).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("a")).unwrap(), "old-a");
        assert_eq!(std::fs::read_to_string(d.join("b")).unwrap(), "old-b");
        assert!(!upd(&d).join("journal.json").exists());
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    #[cfg(windows)]
    fn cleanup_respects_update_lock() {
        let d = test_dir(); let lock = super::update_lock(&d).unwrap();
        let stage = super::upd(&d).join("new");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("file"), "new").unwrap();
        let journal = super::upd(&d).join("journal.json");
        std::fs::write(&journal, "in use").unwrap();
        assert!(super::cleanup_update(&d).is_err());
        assert!(stage.join("file").exists());
        assert_eq!(std::fs::read_to_string(&journal).unwrap(), "in use");
        drop(lock);
        // Invalid journals also prevent cleanup from deleting recovery data.
        assert!(super::cleanup_update(&d).is_err());
        assert!(stage.join("file").exists());
        std::fs::remove_file(journal).unwrap();
        super::cleanup_update(&d).unwrap();
        assert!(!stage.exists());
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn troca_sem_guardar_versao_anterior() {
        use super::{MANIFEST, install_stage, prev_dirs, upd};
        let d = std::env::temp_dir().join(format!("bs-upd-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        let w = |p: &str, t: &str| { let f = d.join(p); std::fs::create_dir_all(f.parent().unwrap()).unwrap(); std::fs::write(f, t).unwrap(); };
        let r = |p: &str| std::fs::read_to_string(d.join(p)).ok();
        // instalação antiga (sem manifesto) com arquivos que não são do programa
        w("BlueScreen.exe", "exe1"); w("wwwroot/app.js", "a1"); w("wwwroot/velho.js", "v1"); w("source.txt", "repo"); w("plugins/x/ui.js", "x1"); w("plugins/meu/ui.js", "meu");
        // versão nova em .bs-update\new
        w(".bs-update/new/BlueScreen.exe", "exe2"); w(".bs-update/new/wwwroot/app.js", "a2"); w(".bs-update/new/wwwroot/novo.js", "n2"); w(".bs-update/new/plugins/x/ui.js", "x2");
        install_stage(&upd(&d).join("new"), &d).unwrap();
        assert_eq!(r("BlueScreen.exe").as_deref(), Some("exe2"));
        assert_eq!(r("wwwroot/app.js").as_deref(), Some("a2"));
        assert_eq!(r("wwwroot/novo.js").as_deref(), Some("n2"));
        assert_eq!(r("wwwroot/velho.js"), None); // saiu da versão nova
        assert_eq!(r("source.txt").as_deref(), Some("repo")); // não é do programa: fica
        assert_eq!(r("plugins/meu/ui.js").as_deref(), Some("meu")); // plugin que não vem junto: fica
        assert!(r(MANIFEST).unwrap().contains("wwwroot/novo.js"));
        assert!(prev_dirs(&upd(&d)).is_empty());
        assert!(!upd(&d).join("journal.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn caminhos_do_manifesto() {
        use super::safe_rel;
        assert!(safe_rel("wwwroot/app.js"));
        assert!(!safe_rel("../fora.txt"));
        assert!(!safe_rel("a/../../b"));
        assert!(!safe_rel("C:/Windows/x"));
        assert!(!safe_rel("/etc/x"));
        assert!(!safe_rel(".bs-update/lock"));
        assert!(!safe_rel(""));
    }
    #[test]
    fn versions() {
        assert!(semver("v2.1.10") > semver("2.1.9"));
        assert!(semver("2.1.0") > semver("2.0.37"));
        assert_eq!(semver("v3.0.1"), (3, 0, 1));
    }
    #[test]
    fn classify() {
        assert!(native("app/src/main.rs"));
        assert!(native("app/Cargo.toml"));
        assert!(native("app/plugins/unilint/src/engine.rs"));
        assert!(!native("app/wwwroot/app.js"));
        assert!(!native("app/plugins/unilint/ui.js"));
        assert!(!native("app/plugin-server/src/main.rs"));
        assert!(!native("README.md"));
        assert!(!native("Instalar BlueScreen.cmd"));
    }
    #[test]
    fn only_what_changed() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(packages(&v(&["app/src/main.rs", "app/wwwroot/app.js"])), Some(v(&["bluescreen"])));
        assert_eq!(packages(&v(&["app/plugins/unilint/src/jsp.rs"])), Some(v(&["bluescreen-unilint"])));
        assert_eq!(packages(&v(&["app/src/lint.rs", "app/plugins/unilint/src/a.rs", "app/src/x.rs"])), Some(v(&["bluescreen", "bluescreen-unilint"])));
        assert_eq!(packages(&v(&["app/sdk/src/lib.rs"])), None);
        assert_eq!(packages(&v(&["app/Cargo.lock"])), None);
    }
}
