//! Build local e console de build.
//! Descobre como o repositório é construído (Maven, npm), acha os Maven e JDK instalados e roda as tarefas.
//! Cada execução vira um "run" com saída incremental, lida pelo navegador em polling. Maven é chamado direto pela
//! JVM (classworlds), sem shell.
use crate::util::*;
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

const IS_WIN: bool = cfg!(windows);

// ---------- ferramentas instaladas ----------
#[derive(Serialize, Clone, Debug)]
pub struct Maven { pub home: String, pub version: String, pub classworlds: String }
#[derive(Serialize, Clone, Debug)]
pub struct Jdk { pub home: String, pub major: u32, pub name: String }

fn glob_dirs(base: &Path, re: &Regex) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(base) else { return vec![] };
    rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && re.is_match(&e.file_name().to_string_lossy())).map(|e| e.path()).collect()
}
/// "3.2.5" x "3.10.1" em ordem numérica (como localeCompare com numeric: true)
fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    let seg = |s: &str| s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    seg(a).cmp(&seg(b)).then_with(|| a.cmp(b))
}
pub fn mavens() -> Vec<Maven> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut cands: Vec<PathBuf> = vec![];
    for k in ["MAVEN_HOME", "M2_HOME"] { if let Ok(v) = std::env::var(k) { if !v.is_empty() { cands.push(PathBuf::from(v)); } } }
    // o escolhido na janela SDKs e o mvn do PATH (scoop, pasta própria)
    cands.extend(crate::sdk::chosen("maven"));
    if let Some(h) = super::detect::which("mvn").and_then(|p| p.parent()?.parent().map(Path::to_path_buf)) { cands.push(h); }
    let re = Regex::new(r"(?i)^apache-maven-\d").unwrap();
    for base in [crate::sdk::root("maven"), home.join("Tools"), home.join("tools"), PathBuf::from("C:\\"), PathBuf::from("C:\\Program Files"), PathBuf::from("C:\\tools"), home.clone()] {
        cands.extend(glob_dirs(&base, &re));
    }
    let ver_re = Regex::new(r"(?i)apache-maven-([\d.]+)").unwrap();
    let mut out = vec![]; let mut seen = std::collections::HashSet::new();
    for d in cands {
        // Windows: Tools e tools são a mesma pasta
        if !seen.insert(d.to_string_lossy().to_lowercase()) { continue; }
        let boot = d.join("boot");
        let jar = std::fs::read_dir(&boot).ok().and_then(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).find(|n| n.starts_with("plexus-classworlds") && n.ends_with(".jar")));
        if let Some(jar) = jar {
            if d.join("bin").join("m2.conf").exists() {
                let ds = d.to_string_lossy().to_string();
                // apache-maven-3.9.9 no nome da pasta; senão o maven-core-3.9.9.jar de lib/
                let version = ver_re.captures(&ds).map(|c| c[1].to_string())
                    .or_else(|| std::fs::read_dir(d.join("lib")).ok()?.flatten().find_map(|e| e.file_name().to_string_lossy().strip_prefix("maven-core-").and_then(|v| v.strip_suffix(".jar")).map(String::from)))
                    .unwrap_or_else(|| "?".into());
                out.push(Maven { home: ds, version, classworlds: boot.join(jar).to_string_lossy().into() });
            }
        }
    }
    out.sort_by(|a, b| cmp_version(&b.version, &a.version));
    out
}
pub fn jdks() -> Vec<Jdk> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut cands: Vec<PathBuf> = vec![];
    // o escolhido como padrão na janela SDKs (pode estar em qualquer pasta) vem primeiro
    let chosen = crate::sdk::chosen("jdk");
    cands.extend(chosen.clone());
    if let Ok(v) = std::env::var("JAVA_HOME") { if !v.is_empty() { cands.push(PathBuf::from(v)); } }
    // o javac do PATH (scoop, winget, instalado em outra pasta)
    if let Some(home) = super::detect::which("javac").and_then(|p| p.parent()?.parent().map(Path::to_path_buf)) { cands.push(home); }
    let any = Regex::new(".").unwrap();
    for base in ["C:\\Program Files\\Java", "C:\\Program Files\\Semeru", "C:\\Program Files\\AdoptOpenJDK", "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Microsoft", "C:\\Program Files\\Amazon Corretto", "C:\\Program Files\\Zulu"].map(PathBuf::from).into_iter().chain([home.join(".jdks")]) {
        cands.extend(glob_dirs(&base, &any));
    }
    let vre = Regex::new(r"(\d+)(?:\.(\d+))?").unwrap();
    let mut out = vec![]; let mut seen = std::collections::HashSet::new();
    for d in cands {
        if !seen.insert(d.to_string_lossy().to_lowercase()) { continue; }
        if !d.join("bin").join(if IS_WIN { "javac.exe" } else { "javac" }).exists() { continue; } // só JDK (JRE não compila)
        let name = d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // jdk-8.0.482, corretto-1.8.0_422, corretto-17
        // JAVA_VERSION="21.0.2" do arquivo release; sem ele, o número do nome da pasta
        let release = std::fs::read_to_string(d.join("release")).unwrap_or_default();
        let ver = release.lines().find_map(|l| l.strip_prefix("JAVA_VERSION=")).map(|v| v.trim().trim_matches('"').to_string());
        let major = vre.captures(ver.as_deref().unwrap_or(&name)).map(|c| {
            let a: u32 = c[1].parse().unwrap_or(0);
            match c.get(2) { Some(b) if a == 1 => b.as_str().parse().unwrap_or(a), _ => a }
        }).unwrap_or(0);
        out.push(Jdk { home: d.to_string_lossy().into(), major, name });
    }
    let is_chosen = |j: &Jdk| chosen.as_ref().is_some_and(|c| c.to_string_lossy().eq_ignore_ascii_case(&j.home));
    out.sort_by(|a, b| is_chosen(b).cmp(&is_chosen(a)).then((b.major == 8).cmp(&(a.major == 8))).then(b.major.cmp(&a.major)));
    out
}

// ---------- estrutura do repositório ----------
pub async fn wc_root(dir: &Path, vcs: Option<&str>) -> PathBuf {
    match vcs {
        Some("svn") => { let r = crate::vcs::svn(dir, &["info", "--show-item", "wc-root"]).await; if r.ok && !r.out.trim().is_empty() { return absolute(Path::new(r.out.trim())); } }
        Some("git") => { let r = run("git", &["rev-parse", "--show-toplevel"], dir, 20000).await; if r.ok && !r.out.trim().is_empty() { return absolute(Path::new(r.out.trim())); } }
        _ => {}
    }
    dir.to_path_buf()
}
/// pom agregador: o que tem <modules>; senão o pom.xml da raiz
pub fn maven_layout(root: &Path) -> (Vec<String>, Option<String>) {
    let skip = Regex::new(r"^(\.|target$|node_modules$|src$|web$|WebContent$)").unwrap();
    let mut poms = vec![];
    fn scan(root: &Path, rel: &str, depth: u32, skip: &Regex, poms: &mut Vec<String>) {
        let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        let ents: Vec<_> = rd.flatten().collect();
        if ents.iter().any(|e| e.file_name() == "pom.xml") { poms.push(if rel.is_empty() { "pom.xml".into() } else { format!("{rel}/pom.xml") }); }
        if depth < 2 {
            for e in &ents {
                let n = e.file_name().to_string_lossy().to_string();
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !skip.is_match(&n) {
                    scan(root, &if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") }, depth + 1, skip, poms);
                }
            }
        }
    }
    scan(root, "", 0, &skip, &mut poms);
    // agregador = packaging pom com <modules><module>; o <modules> do maven-ear-plugin não conta
    let comments = Regex::new(r"<!--[\s\S]*?-->").unwrap();
    let build = Regex::new(r"<build>[\s\S]*</build>").unwrap();
    let pack = Regex::new(r"<packaging>\s*pom\s*</packaging>").unwrap();
    let mods = Regex::new(r"<modules>\s*<module>").unwrap();
    let mut agg = None;
    for p in &poms {
        let x = std::fs::read(root.join(p)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let x = comments.replace_all(&x, "");
        let x = build.replace_all(&x, "");
        if pack.is_match(&x) && mods.is_match(&x) { agg = Some(p.clone()); break; }
    }
    let agg = agg.or_else(|| if poms.iter().any(|p| p == "pom.xml") { Some("pom.xml".into()) } else { poms.first().cloned() });
    (poms, agg)
}
pub fn npm_layout(dir: &Path) -> Option<Vec<String>> {
    let pj = dir.join("package.json");
    if !pj.exists() { return None; }
    let j: Value = std::fs::read_to_string(&pj).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    Some(j["scripts"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default())
}

// ---------- linha de comando ----------
/// Separa os argumentos de uma linha de comando (aspas simples e duplas agrupam).
pub fn split_args(s: &str) -> Vec<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]*)"|'([^']*)'|(\S+)"#).unwrap());
    RE.captures_iter(s).map(|c| c.get(1).or(c.get(2)).or(c.get(3)).map(|m| m.as_str().to_string()).unwrap_or_default()).collect()
}

// ---------- execuções ----------
/// Passo de uma execução: "maven" (Maven pela JVM) ou "cmd" (qualquer programa: gradle, npm, cargo...).
#[derive(Clone, Debug)]
pub struct Step { pub kind: String, pub label: String, pub args: Vec<String>, pub program: String, pub cwd: String, pub java: bool, pub env: Vec<(String, String)> }
impl From<super::detect::TaskStep> for Step {
    fn from(t: super::detect::TaskStep) -> Self { Step { kind: t.kind, label: t.label, args: t.args, program: t.program, cwd: t.cwd, java: t.java, env: t.env.into_iter().collect() } }
}
pub struct Extra { pub env: Vec<(String, String)>, pub jvm: Vec<String> }

struct Run {
    id: String, dir: String, title: String, steps: Vec<String>,
    lines: Vec<String>, base: usize, tail: String,
    status: &'static str, started: f64, ended: Option<f64>, exit: Option<i32>, step: usize,
    pid: Option<u32>, stopped: bool,
    /// execução de programa (Executar main): o console manda o que você digita para a entrada do processo
    interactive: bool,
    input: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}
type RunRef = Arc<Mutex<Run>>;
struct Runs { map: BTreeMap<u64, RunRef>, seq: u64 }
static RUNS: LazyLock<Mutex<Runs>> = LazyLock::new(|| Mutex::new(Runs { map: BTreeMap::new(), seq: 0 }));
const MAX_LINES: usize = 30000;

fn new_run(dir: &str, title: &str, steps: Vec<String>, interactive: bool) -> RunRef {
    let mut rs = RUNS.lock();
    rs.seq += 1;
    let id = rs.seq;
    let r = Arc::new(Mutex::new(Run { id: id.to_string(), dir: dir.into(), title: title.into(), steps, lines: vec![], base: 0, tail: String::new(), status: "running", started: now_ms(), ended: None, exit: None, step: 0, pid: None, stopped: false, interactive, input: None }));
    rs.map.insert(id, r.clone());
    // guarda as 12 mais recentes, mas nunca tira uma que ainda está rodando (a aba Build perderia a saída e o Parar)
    while rs.map.len() > 12 {
        let Some(k) = rs.map.iter().find(|(k, v)| **k != id && v.try_lock().is_some_and(|r| r.status != "running")).map(|(k, _)| *k) else { break };
        rs.map.remove(&k);
    }
    r
}
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());
fn push(r: &RunRef, text: &str) {
    let text = ANSI.replace_all(text, "");
    let mut r = r.lock();
    let mut parts: Vec<String> = text.split('\n').map(|p| p.strip_suffix('\r').unwrap_or(p).to_string()).collect();
    if !r.tail.is_empty() { let t = std::mem::take(&mut r.tail); parts[0] = t + &parts[0]; }
    r.tail = parts.pop().unwrap_or_default();
    r.lines.extend(parts);
    if r.lines.len() > MAX_LINES {
        // índices absolutos continuam valendo
        let n = r.lines.len() - MAX_LINES;
        r.lines.drain(..n);
        r.base += n;
    }
}
fn flush(r: &RunRef) { let mut r = r.lock(); if !r.tail.is_empty() { let t = std::mem::take(&mut r.tail); r.lines.push(t); } }

async fn exec(r: &RunRef, cmd: &str, args: &[String], cwd: &Path, env: &[(String, String)]) -> i32 {
    let mut c = tokio::process::Command::new(cmd);
    let stdin = if r.lock().interactive { std::process::Stdio::piped() } else { std::process::Stdio::null() };
    c.args(args).envs(crate::sdk::env()).current_dir(cwd).stdin(stdin).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    for (k, v) in env { c.env(k, v); }
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => { push(r, &format!("[BlueScreen] Falha ao iniciar: {e}\n")); return -1; }
    };
    r.lock().pid = child.id();
    // no Job Object dos plugins: se o BlueScreen fechar (ou cair), o build e o que ele abriu saem junto
    #[cfg(windows)]
    if let Some(h) = child.raw_handle() { crate::plugins::external::job::assign_raw(h); }
    // entrada do console -> stdin do processo (cada passo tem o seu; o canal some quando o passo acaba)
    let feeder = child.stdin.take().map(|mut sin| {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        r.lock().input = Some(tx);
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(s) = rx.recv().await { if sin.write_all(s.as_bytes()).await.is_err() || sin.flush().await.is_err() { break; } }
        })
    });
    // linhas pelo leitor comum (output.rs): code page do Windows quando não é UTF-8, \r de barra de progresso
    async fn pump<R: tokio::io::AsyncRead + Unpin>(r: RunRef, s: Option<R>) {
        let Some(s) = s else { return };
        let mut lines = crate::output::Lines::new(s);
        while let Some(l) = lines.next().await { push(&r, &(l + "\n")); }
    }
    /// programa interativo: o que chegar vai para o console na hora, mesmo sem quebra de linha ("Digite seu nome: ");
    /// um caractere UTF-8 cortado entre dois pedaços espera o resto
    async fn pump_raw<R: tokio::io::AsyncRead + Unpin>(r: RunRef, s: Option<R>) {
        use tokio::io::AsyncReadExt;
        let Some(mut s) = s else { return };
        let (mut chunk, mut pend) = (vec![0u8; 8192], Vec::<u8>::new());
        loop {
            let n = match s.read(&mut chunk).await { Ok(0) | Err(_) => break, Ok(n) => n };
            pend.extend_from_slice(&chunk[..n]);
            let keep = match std::str::from_utf8(&pend) { Err(e) if e.error_len().is_none() => pend.len() - e.valid_up_to(), _ => 0 };
            let cut = pend.len() - keep;
            push(&r, &crate::output::decode_console(&pend[..cut]));
            pend.drain(..cut);
        }
        if !pend.is_empty() { push(&r, &crate::output::decode_console(&pend)); }
    }
    let (o, e) = (child.stdout.take(), child.stderr.take());
    if r.lock().interactive { tokio::join!(pump_raw(r.clone(), o), pump_raw(r.clone(), e)); }
    else { tokio::join!(pump(r.clone(), o), pump(r.clone(), e)); }
    let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
    flush(r);
    { let mut g = r.lock(); g.pid = None; g.input = None; }
    if let Some(f) = feeder { f.abort(); }
    code
}
fn maven_cmd(mvn: &Maven, jdk: &Jdk, args: &[String], cwd: &Path, extra: &Extra) -> (String, Vec<String>, Vec<(String, String)>) {
    let java = Path::new(&jdk.home).join("bin").join(if IS_WIN { "java.exe" } else { "java" });
    let mut a = vec![
        "-classpath".to_string(), mvn.classworlds.clone(),
        format!("-Dclassworlds.conf={}", Path::new(&mvn.home).join("bin").join("m2.conf").display()),
        format!("-Dmaven.home={}", mvn.home),
        format!("-Dmaven.multiModuleProjectDirectory={}", cwd.display()),
        "-Dfile.encoding=UTF-8".into(),
    ];
    a.extend(extra.jvm.iter().cloned());
    a.push("org.codehaus.plexus.classworlds.launcher.Launcher".into());
    a.extend(args.iter().cloned());
    let mut env = vec![("JAVA_HOME".into(), jdk.home.clone()), ("M2_HOME".into(), mvn.home.clone()), ("MAVEN_HOME".into(), mvn.home.clone())];
    env.extend(extra.env.iter().cloned());
    (java.to_string_lossy().into(), a, env)
}

pub struct StartOpts { pub dir: String, pub root: PathBuf, pub steps: Vec<Step>, pub mvn: Option<Maven>, pub jdk: Option<Jdk>, pub title: String, pub extra: Extra, pub note: String, pub interactive: bool }
pub fn start(o: StartOpts) -> String {
    let r = new_run(&o.dir, &o.title, o.steps.iter().map(|s| s.label.clone()).collect(), o.interactive);
    let id = r.lock().id.clone();
    tokio::spawn(async move {
        let mut head = format!("[BlueScreen] {}\n[BlueScreen] pasta: {}\n", o.title, o.root.display());
        if let Some(m) = &o.mvn { head += &format!("[BlueScreen] Maven {} ({}) · JDK {}\n", m.version, m.home, o.jdk.as_ref().map(|j| j.name.as_str()).unwrap_or("?")); }
        if !o.note.is_empty() { head += &format!("[BlueScreen] {}\n", o.note); }
        push(&r, &head);
        let mut code = 0;
        let n = o.steps.len();
        for (i, s) in o.steps.iter().enumerate() {
            if r.lock().stopped { break; }
            r.lock().step = i + 1;
            push(&r, &format!("\n[BlueScreen] ===== passo {}/{n}: {} =====\n", i + 1, s.label));
            if s.kind == "maven" {
                let (Some(mvn), Some(jdk)) = (&o.mvn, &o.jdk) else { code = -1; break };
                let (cmd, args, mut env) = maven_cmd(mvn, jdk, &s.args, &o.root, &o.extra);
                env.extend(s.env.iter().cloned());
                push(&r, &format!("[BlueScreen] $ mvn {}\n", s.args.join(" ")));
                code = exec(&r, &cmd, &args, &o.root, &env).await;
            } else {
                // qualquer programa: acha no PATH (inclui .cmd/.bat, como npm e gradlew) e roda na pasta do sistema de build
                let cwd = if s.cwd.is_empty() { o.root.clone() } else { PathBuf::from(&s.cwd) };
                let prog = super::detect::which(&s.program).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| s.program.clone());
                let mut env = vec![];
                if s.java { if let Some(j) = &o.jdk { env.push(("JAVA_HOME".to_string(), j.home.clone())); } }
                env.extend(o.extra.env.iter().cloned()); // ex.: credencial do repositório de um plugin, também para o mvnw
                env.extend(s.env.iter().cloned());
                push(&r, &format!("[BlueScreen] $ {}\n", s.label));
                if super::detect::which(&s.program).is_none() && !Path::new(&s.program).is_file() {
                    push(&r, &format!("[BlueScreen] {} não encontrado. Instale ou adicione ao PATH.\n", s.program));
                    code = -1;
                } else {
                    code = exec(&r, &prog, &s.args, &cwd, &env).await;
                }
            }
            if code != 0 { break; }
        }
        let msg = {
            let mut g = r.lock();
            g.exit = Some(if g.stopped { -1 } else { code });
            g.status = if g.stopped { "stopped" } else if code == 0 { "ok" } else { "failed" };
            let ended = now_ms(); g.ended = Some(ended);
            let secs = ((ended - g.started) / 1000.0).round();
            let what = match g.status { "ok" => "Concluído com sucesso".to_string(), "stopped" => "Interrompido".to_string(), _ => format!("Falhou (código {code})") };
            format!("\n[BlueScreen] {what} em {secs} s\n")
        };
        push(&r, &msg);
        flush(&r);
    });
    id
}
pub async fn stop(id: &str) -> bool {
    let r = { let rs = RUNS.lock(); rs.map.values().find(|r| r.lock().id == id).cloned() };
    let Some(r) = r else { return false };
    let pid = { let mut g = r.lock(); g.stopped = true; g.pid };
    if let Some(pid) = pid {
        if IS_WIN { fire("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]); }
        else { fire("kill", &["-TERM", &pid.to_string()]); }
    }
    true
}
/// texto digitado no console vai para a entrada do processo do passo atual (e aparece no console, como no IntelliJ)
pub fn input(id: &str, text: &str) -> bool {
    let r = { let rs = RUNS.lock(); rs.map.values().find(|r| r.lock().id == id).cloned() };
    let Some(r) = r else { return false };
    let Some(tx) = r.lock().input.clone() else { return false };
    let line = format!("{}\n", text.trim_end_matches(['\r', '\n']));
    if tx.send(if IS_WIN { line.replace('\n', "\r\n") } else { line.clone() }).is_err() { return false; }
    push(&r, &line);
    true
}
pub fn read(id: &str, from: usize) -> Option<Value> {
    let r = { let rs = RUNS.lock(); rs.map.values().find(|r| r.lock().id == id).cloned() }?;
    let g = r.lock();
    let off = g.base.max(from);
    let start = (off - g.base).min(g.lines.len());
    let end = (start + 5000).min(g.lines.len());
    Some(json!({ "id": g.id, "title": g.title, "status": g.status, "step": g.step, "steps": g.steps, "started": g.started, "ended": g.ended, "exit": g.exit,
        "from": off, "lines": &g.lines[start..end], "total": g.base + g.lines.len(),
        "interactive": g.interactive, "input": g.input.is_some(), "prompt": &g.tail }))
}
pub fn list(dir: Option<&str>) -> Vec<Value> {
    let rs = RUNS.lock();
    rs.map.values().rev().filter_map(|r| {
        let g = r.lock();
        (dir.is_none_or(|d| g.dir == d)).then(|| json!({ "id": g.id, "title": g.title, "status": g.status, "started": g.started, "ended": g.ended }))
    }).collect()
}
