//! Git e SVN: projetos, resumo, alterações, histórico, diff e o código que a cópia local representa.
use crate::util::*;
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

#[derive(Serialize, Clone, Debug)]
pub struct Commit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub hash: String,
    pub author: String,
    pub when: String,
    pub subject: String,
    /// data do commit (segundos unix): o Histórico agrupa por dia
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
    /// histórico de um arquivo: o caminho dele naquele commit (muda quando o arquivo foi renomeado)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}
#[derive(Serialize)]
pub struct ProjectInfo { pub name: String, pub path: String, pub vcs: Option<&'static str>, pub mtime: f64 }
#[derive(Serialize)]
pub struct Summary { pub vcs: Option<&'static str>, pub dirty: usize, pub branch: String, pub last: Option<Commit> }
#[derive(Serialize, Clone)]
pub struct ChangedFile {
    pub path: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub del: Option<i64>,
}
#[derive(Serialize, Clone)]
pub struct Changes {
    pub vcs: Option<&'static str>,
    pub files: Vec<ChangedFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
}
#[derive(Serialize, Clone)]
pub struct DiffPair {
    pub original: String,
    pub modified: String,
    /// lado direito lido do disco (editável): como o arquivo está gravado, para salvar do mesmo jeito (ver /api/file)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bom: bool,
}
impl DiffPair {
    fn pair(original: String, modified: String) -> Self { DiffPair { original, modified, encoding: None, bom: false } }
    /// lado direito do disco: leva a codificação junto
    fn with_disk(original: String, (modified, enc, bom): (String, &'static str, bool)) -> Self { DiffPair { original, modified, encoding: Some(enc), bom } }
}

// --no-optional-locks: um "git status" de consulta não cria o index.lock para atualizar o índice. Sem isso, cada
// consulta mexia na pasta .git, o vigia de arquivos via a mudança e a IDE consultava de novo, sem parar.
pub async fn git(cwd: &Path, a: &[&str]) -> ProcResult {
    let mut v = vec!["--no-optional-locks", "-c", "core.quotepath=off"];
    v.extend_from_slice(a);
    run("git", &v, cwd, 20000).await
}
pub async fn git_t(cwd: &Path, a: &[&str], timeout_ms: u64) -> ProcResult {
    let mut v = vec!["--no-optional-locks", "-c", "core.quotepath=off"];
    v.extend_from_slice(a);
    run("git", &v, cwd, timeout_ms).await
}
pub async fn svn(cwd: &Path, a: &[&str]) -> ProcResult { svn_t(cwd, a, 20000).await }
pub async fn svn_t(cwd: &Path, a: &[&str], timeout_ms: u64) -> ProcResult {
    let mut v = vec!["--non-interactive"];
    v.extend_from_slice(a);
    run("svn", &v, cwd, timeout_ms).await
}

pub fn here(dir: &Path) -> Option<&'static str> {
    if dir.join(".git").exists() { return Some("git"); }
    if dir.join(".svn").is_dir() { return Some("svn"); }
    None
}
static DETECT: LazyLock<TtlCache<PathBuf, Option<&'static str>>> = LazyLock::new(|| TtlCache::new(Duration::from_secs(10)));
/// Sobe até a raiz do checkout: uma subpasta de um working copy também é um projeto versionado.
pub fn detect(dir: &Path) -> Option<&'static str> {
    let start = absolute(dir);
    if let Some(v) = DETECT.get(&start) { return v; }
    let mut cur = Some(start.as_path());
    let mut found = None;
    for _ in 0..40 {
        let Some(c) = cur else { break };
        found = here(c);
        if found.is_some() { break; }
        cur = c.parent();
    }
    DETECT.set(start, found);
    found
}

static PREFIX: LazyLock<TtlCache<PathBuf, String>> = LazyLock::new(|| TtlCache::new(Duration::from_secs(30)));
/// Prefixo da pasta dentro do repositório git ("" na raiz, "sub/dir/" numa subpasta).
pub async fn git_prefix(dir: &Path) -> String {
    if let Some(p) = PREFIX.get(&dir.to_path_buf()) { return p; }
    let r = git(dir, &["rev-parse", "--show-prefix"]).await;
    let p = if r.ok { r.out.trim().trim_start_matches('/').to_string() } else { String::new() };
    PREFIX.set(dir.to_path_buf(), p.clone());
    p
}
fn strip_prefix(p: &str, pre: &str) -> Option<String> {
    if pre.is_empty() { Some(p.to_string()) } else { p.strip_prefix(pre).map(str::to_string) }
}
fn unquote(p: &str) -> &str { if p.len() > 1 && p.starts_with('"') && p.ends_with('"') { &p[1..p.len() - 1] } else { p } }

// ---------- projetos ----------
pub fn list_projects(root: &Path) -> std::io::Result<Vec<ProjectInfo>> {
    let dirs: Vec<_> = std::fs::read_dir(root)?.flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| { let n = e.file_name().to_string_lossy().to_string(); !n.starts_with('.') && !IGNORED_DIRS.contains(n.as_str()) })
        .collect();
    let mut out: Vec<ProjectInfo> = dirs.par_iter().map(|e| {
        let p = e.path();
        let mtime = e.metadata().and_then(|m| m.modified()).map(mtime_ms).unwrap_or(0.0);
        ProjectInfo { name: e.file_name().to_string_lossy().into(), path: p.to_string_lossy().into(), vcs: detect(&p), mtime }
    }).collect();
    out.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    Ok(out)
}

pub async fn summary(dir: &Path) -> Summary {
    match detect(dir) {
        Some("git") => {
            let (st, lg, br) = tokio::join!(
                git(dir, &["status", "--porcelain", "--", "."]),
                git(dir, &["log", "-1", "--format=%h%x1f%an%x1f%ct%x1f%s", "--", "."]),
                git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
            );
            let dirty = st.out.lines().filter(|l| !l.is_empty()).count();
            let f: Vec<&str> = lg.out.trim().split('\x1f').collect();
            let last = (lg.ok && f.len() >= 4 && !f[0].is_empty()).then(|| Commit { id: None, hash: f[0].into(), author: f[1].into(), when: rel_time_unix(f[2]), subject: f[3].into(), ts: f[2].trim().parse().ok(), path: None });
            Summary { vcs: Some("git"), dirty, branch: br.out.trim().into(), last }
        }
        Some("svn") => {
            let (st, info) = tokio::join!(svn(dir, &["status", "-q"]), svn(dir, &["info", "--show-item", "last-changed-revision"]));
            let dirty = st.out.lines().filter(|l| !l.trim().is_empty()).count();
            let rev = info.out.trim().to_string();
            let mut last = None;
            if !rev.is_empty() {
                let lg = svn(dir, &["log", "-r", &rev, "--xml"]).await;
                last = parse_svn_log(&lg.out).into_iter().next().map(|mut c| { c.hash = format!("r{}", c.hash); c });
            }
            Summary { vcs: Some("svn"), dirty, branch: String::new(), last }
        }
        _ => Summary { vcs: None, dirty: 0, branch: String::new(), last: None },
    }
}

static LOG_ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<logentry\s+revision="(\d+)">([\s\S]*?)</logentry>"#).unwrap());
static LOG_AUTHOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<author>([\s\S]*?)</author>").unwrap());
static LOG_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<date>([\s\S]*?)</date>").unwrap());
static LOG_MSG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<msg>([\s\S]*?)</msg>").unwrap());
pub fn parse_svn_log(xml: &str) -> Vec<Commit> {
    let tag = |re: &Regex, body: &str| re.captures(body).map(|c| html_unescape(&c[1])).unwrap_or_default();
    LOG_ENTRY.captures_iter(xml).map(|m| {
        let body = &m[2];
        let date = tag(&LOG_DATE, body);
        Commit { id: None, hash: m[1].into(), author: tag(&LOG_AUTHOR, body), when: if date.is_empty() { String::new() } else { rel_time_iso(&date) }, subject: tag(&LOG_MSG, body).lines().next().unwrap_or("").into(), ts: iso_ms(&date).map(|ms| (ms / 1000.0) as i64), path: None }
    }).collect()
}

// ---------- alterações / log / diff ----------
// arquivo novo (não versionado) dentro de saída de build (target/, node_modules/...): não conta como alteração
fn is_build_output(f: &ChangedFile) -> bool { (f.code == "?" || f.code == "I") && f.path.split('/').any(|s| IGNORED_DIRS.contains(s)) }
fn apply_numstat(files: &mut [ChangedFile], out: &str, pre: &str) {
    let mut stat = std::collections::HashMap::new();
    for l in out.lines() {
        let parts: Vec<&str> = l.split('\t').collect();
        if parts.len() < 3 || parts[2].is_empty() { continue; }
        if let Some(q) = strip_prefix(unquote(parts[2]), pre) { stat.insert(q, (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))); }
    }
    for f in files.iter_mut() { if let Some(&(a, d)) = stat.get(&f.path) { f.add = Some(a); f.del = Some(d); } }
}

/// Revisão vinda de um pedido (hash, branch, tag, HEAD~1, número do SVN, {data}): nunca uma opção ("--output=...")
/// nem espaços. As que não passam viram resposta vazia.
pub fn safe_rev(r: &str) -> bool {
    r.len() <= 256 && r.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '{')
        && r.chars().all(|c| c.is_ascii_alphanumeric() || "._/~^@{}+-".contains(c))
}
fn bad_rev(r: Option<&str>) -> bool { r.is_some_and(|r| !r.is_empty() && !safe_rev(r)) }

pub async fn changes(dir: &Path, mode: &str, rev: Option<&str>, base: Option<&str>) -> Changes {
    let vcs = detect(dir);
    if bad_rev(rev) || bad_rev(base) { return Changes { vcs, files: vec![], rev: None }; }
    match vcs {
        None => Changes { vcs, files: vec![], rev: None },
        Some("git") => {
            let pre = git_prefix(dir).await;
            if mode == "working" {
                let (st, ns) = tokio::join!(git(dir, &["status", "--porcelain", "-uall", "--", "."]), git(dir, &["diff", "--numstat", "HEAD", "--", "."]));
                let mut files = Vec::new();
                for l in st.out.lines() {
                    if l.len() < 4 { continue; }
                    let b = l.as_bytes(); let (x, y) = (b[0] as char, b[1] as char);
                    let mut p = &l[3..];
                    if let Some(i) = p.find(" -> ") { p = &p[i + 4..]; }
                    let Some(q) = strip_prefix(unquote(p), &pre) else { continue };
                    let code = if x == '?' { "?".to_string() } else if y != ' ' { y.to_string() } else { x.to_string() };
                    let f = ChangedFile { path: q, code, staged: Some(x != ' ' && x != '?'), add: None, del: None };
                    if !is_build_output(&f) { files.push(f); }
                }
                apply_numstat(&mut files, &ns.out, &pre);
                return Changes { vcs, files, rev: None };
            }
            if mode == "range" { return compare(dir, base.unwrap_or("HEAD"), rev).await; }
            let target = rev.filter(|r| !r.is_empty()).unwrap_or("HEAD").to_string();
            let key = format!("{}|{target}", dir.display());
            if fixed(&target) && let Some(c) = CHANGES.lock().get(&key) { return c; }
            // um processo só: o hash (%H), a lista com o tipo da mudança (--raw) e as linhas (--numstat)
            let r = git(dir, &["show", "--format=%H", "--raw", "--numstat", "-m", "--first-parent", "--end-of-options", &target, "--", "."]).await;
            let hash = r.out.lines().next().map(str::trim).filter(|h| fixed(h)).map(str::to_string);
            let c = Changes { vcs, files: parse_raw_numstat(&r.out, &pre), rev: Some(hash.clone().unwrap_or(target)) };
            // guardado pelo hash: o "último commit" (HEAD) de agora também serve quando ele for aberto pelo hash
            if r.ok && let Some(h) = hash { let cost = c.files.iter().map(|f| f.path.len() + 40).sum(); CHANGES.lock().put(format!("{}|{h}", dir.display()), c.clone(), cost); }
            c
        }
        Some(_) => {
            if mode == "working" {
                let st = svn(dir, &["status"]).await;
                let files = st.out.lines().filter(|l| svn_file_line(l))
                    .map(|l| ChangedFile { path: norm(l.get(8..).unwrap_or("").trim()), code: l.get(..1).unwrap_or("?").to_string(), staged: None, add: None, del: None })
                    .filter(|f| !is_build_output(f)).collect();
                return Changes { vcs, files, rev: None };
            }
            if mode == "range" { return compare(dir, base.unwrap_or("BASE"), rev).await; }
            let t = match rev.filter(|r| !r.is_empty()) {
                Some(r) => r.to_string(),
                None => svn(dir, &["info", "--show-item", "last-changed-revision"]).await.out.trim().to_string(),
            };
            let key = format!("{}|{t}", dir.display());
            if fixed(&t) && let Some(c) = CHANGES.lock().get(&key) { return c; }
            let r = svn(dir, &["diff", "--summarize", "-c", &t]).await;
            let c = Changes { vcs, files: parse_svn_summarize(dir, &r.out), rev: Some(t.clone()) };
            if r.ok && fixed(&t) { let cost = c.files.iter().map(|f| f.path.len() + 40).sum(); CHANGES.lock().put(key, c.clone(), cost); }
            c
        }
    }
}

// ---------- o que não muda fica guardado: um commit do Git (hash) ou uma revisão do SVN é imutável ----------
// Navegar commit a commit e voltar não chama o Git/SVN de novo (no SVN, cada chamada vai ao servidor).
struct Lru<V> { map: HashMap<String, (V, usize)>, order: VecDeque<String>, bytes: usize, max: usize }
impl<V: Clone> Lru<V> {
    fn new(max: usize) -> Self { Self { map: HashMap::new(), order: VecDeque::new(), bytes: 0, max } }
    fn get(&self, k: &str) -> Option<V> { self.map.get(k).map(|(v, _)| v.clone()) }
    fn put(&mut self, k: String, v: V, cost: usize) {
        if cost > self.max / 4 { return; }
        if let Some((_, c)) = self.map.insert(k.clone(), (v, cost)) { self.bytes -= c; self.order.retain(|x| x != &k); }
        self.order.push_back(k);
        self.bytes += cost;
        while self.bytes > self.max {
            let Some(o) = self.order.pop_front() else { break };
            if let Some((_, c)) = self.map.remove(&o) { self.bytes -= c; }
        }
    }
}
static CHANGES: LazyLock<Mutex<Lru<Changes>>> = LazyLock::new(|| Mutex::new(Lru::new(8 << 20)));
static DIFFS: LazyLock<Mutex<Lru<DiffPair>>> = LazyLock::new(|| Mutex::new(Lru::new(96 << 20)));
/// hash completo do Git (SHA-1 ou SHA-256) ou número de revisão do SVN: aponta sempre para o mesmo conteúdo
fn fixed(rev: &str) -> bool {
    ((rev.len() == 40 || rev.len() == 64) && rev.bytes().all(|b| b.is_ascii_hexdigit())) || (!rev.is_empty() && rev.len() < 12 && rev.bytes().all(|b| b.is_ascii_digit()))
}

/// saída de "git show/diff --raw --numstat": ":100644 100644 a b M\tcaminho" e depois "adições\tremoções\tcaminho"
fn parse_raw_numstat(out: &str, pre: &str) -> Vec<ChangedFile> {
    let mut files: Vec<ChangedFile> = out.lines().filter(|l| l.starts_with(':')).filter_map(|l| {
        let parts: Vec<&str> = l.split('\t').collect();
        let code = parts[0].split(' ').next_back().and_then(|c| c.get(..1)).unwrap_or("M").to_string();
        strip_prefix(unquote(parts[parts.len() - 1]), pre).map(|q| ChangedFile { path: q, code, staged: None, add: None, del: None })
    }).collect();
    let ns = out.lines().filter(|l| !l.starts_with(':') && l.contains('\t')).collect::<Vec<_>>().join("\n");
    apply_numstat(&mut files, &ns, pre);
    files
}
/// linha de arquivo do "svn status"/"--summarize": 7 colunas de estado (ASCII), um espaço e o caminho. As outras
/// ("Summary of conflicts:", "--- Changelist", "Status against revision") ficam de fora.
fn svn_file_line(l: &str) -> bool {
    let b = l.as_bytes();
    b.len() > 8 && b[..8].is_ascii() && b[7] == b' ' && "ACDIMRX?!~ ".contains(b[0] as char) && !l.starts_with("Status against") && !l[8..].trim().is_empty()
}
fn parse_svn_summarize(dir: &Path, out: &str) -> Vec<ChangedFile> {
    let od = norm(&dir.to_string_lossy());
    let nd = od.to_lowercase();
    out.lines().filter(|l| svn_file_line(l)).map(|l| {
        let p = norm(l.get(8..).unwrap_or("").trim());
        // corta pelo tamanho do caminho original (em minúsculas ele pode mudar de tamanho em bytes)
        let path = match p.get(od.len()..) { Some(x) if p.to_lowercase().starts_with(&nd) => x.trim_start_matches('/').to_string(), _ => p };
        ChangedFile { path, code: l.get(..1).unwrap_or("?").to_string(), staged: None, add: None, del: None }
    }).collect()
}

/// Comparar duas versões quaisquer: base (commit, branch, tag, revisão) contra target (outra versão ou, sem target,
/// a cópia local como está no disco).
pub async fn compare(dir: &Path, base: &str, target: Option<&str>) -> Changes {
    let target = target.filter(|t| !t.is_empty());
    let vcs = detect(dir);
    if bad_rev(Some(base)) || bad_rev(target) { return Changes { vcs, files: vec![], rev: None }; }
    let key = format!("{}|{base}..{}", dir.display(), target.unwrap_or(""));
    let cache = fixed(base) && target.is_some_and(fixed);
    if cache && let Some(c) = CHANGES.lock().get(&key) { return c; }
    // só vai para o cache o que o Git/SVN respondeu (um tempo esgotado não pode virar "nenhuma mudança" para sempre)
    let mut answered = true;
    let c = match vcs {
        Some("git") => {
            let pre = git_prefix(dir).await;
            let mut a = vec!["diff", "--raw", "--numstat", "--end-of-options", base];
            if let Some(t) = target { a.push(t); }
            a.extend(["--", "."]);
            let r = git(dir, &a).await;
            answered = r.ok;
            Changes { vcs, files: parse_raw_numstat(&r.out, &pre), rev: target.map(str::to_string) }
        }
        Some(_) => {
            let range = match target { Some(t) => format!("{base}:{t}"), None => base.to_string() };
            let r = svn(dir, &["diff", "--summarize", "-r", &range]).await;
            answered = r.ok;
            Changes { vcs, files: parse_svn_summarize(dir, &r.out), rev: target.map(str::to_string) }
        }
        None => Changes { vcs, files: vec![], rev: None },
    };
    if cache && answered { let cost = c.files.iter().map(|f| f.path.len() + 40).sum(); CHANGES.lock().put(key, c.clone(), cost); }
    c
}

pub async fn history(dir: &Path) -> Vec<Commit> { history_n(dir, 30).await }

/// os `n` commits mais recentes (a aba Alterações pede mais conforme se navega para trás)
pub async fn history_n(dir: &Path, n: usize) -> Vec<Commit> { history_of(dir, n, None).await }

/// histórico do projeto ou, com `file`, só dos commits que mexeram nesse arquivo (seguindo renomeações no Git)
pub async fn history_of(dir: &Path, n: usize, file: Option<&str>) -> Vec<Commit> {
    let n = n.clamp(1, 5000).to_string();
    let file = file.filter(|f| !f.is_empty());
    match detect(dir) {
        Some("git") => {
            let mut a = vec!["log", "-n", &n, "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s"];
            match file { Some(f) => a.extend(["--follow", "--name-only", "--", f]), None => a.extend(["--", "."]) }
            let (r, pre) = tokio::join!(git(dir, &a), git_prefix(dir));
            let mut out: Vec<Commit> = Vec::new();
            for l in r.out.lines() {
                let f: Vec<&str> = l.split('').collect();
                if f.len() >= 5 { out.push(Commit { id: Some(f[0].into()), hash: f[1].into(), author: f[2].into(), when: rel_time_unix(f[3]), subject: f[4].into(), ts: f[3].trim().parse().ok(), path: None }); }
                // --name-only: o caminho (a partir da raiz do repositório) vem nas linhas depois do commit
                else if !l.trim().is_empty() && let Some(c) = out.last_mut() { c.path = strip_prefix(unquote(l.trim()), &pre); }
            }
            out
        }
        Some("svn") => {
            let mut a = vec!["log", "-l", &n, "--xml"];
            if let Some(f) = file { a.extend(["--", f]); }
            let r = svn(dir, &a).await;
            parse_svn_log(&r.out).into_iter().map(|mut c| { c.id = Some(c.hash.clone()); c.hash = format!("r{}", c.hash); c }).collect()
        }
        _ => vec![],
    }
}

/// mode: "working" (último commit x disco), "last" (commit `rev` x o anterior a ele) ou "range" (`base` x `rev`;
/// sem `rev`, o disco)
pub async fn diff(dir: &Path, file: &str, mode: &str, rev: Option<&str>, base: Option<&str>) -> DiffPair {
    let rev = rev.filter(|r| !r.is_empty());
    let base = base.filter(|b| !b.is_empty());
    if bad_rev(rev) || bad_rev(base) { return DiffPair::pair(String::new(), String::new()); }
    // as duas versões são imutáveis: guarda (o mesmo diff aberto de novo, ou pré-carregado pela interface)
    let key = match (mode, rev, base) {
        ("last", Some(r), _) if fixed(r) => Some(format!("{}|{r}|{file}", dir.display())),
        ("range", Some(r), Some(b)) if fixed(r) && fixed(b) => Some(format!("{}|{b}..{r}|{file}", dir.display())),
        _ => None,
    };
    if let Some(k) = &key && let Some(d) = DIFFS.lock().get(k) { return d; }
    // falha passageira (tempo esgotado, git que não abriu) não vai para o cache: a próxima vez pergunta de novo
    let transient = std::sync::atomic::AtomicBool::new(false);
    let d = diff_uncached(dir, file, mode, rev, base, &transient).await;
    if let Some(k) = key.filter(|_| !transient.load(std::sync::atomic::Ordering::Relaxed)) { let cost = d.original.len() + d.modified.len() + 64; DIFFS.lock().put(k, d.clone(), cost); }
    d
}
async fn diff_uncached(dir: &Path, file: &str, mode: &str, rev: Option<&str>, base: Option<&str>, transient: &std::sync::atomic::AtomicBool) -> DiffPair {
    // arquivo que não existe naquela versão é resposta (vazio); código -1 é o processo que não rodou ou passou do tempo
    let failed = |r: &ProcResult| if r.code == -1 { transient.store(true, std::sync::atomic::Ordering::Relaxed); };
    let abs = dir.join(file);
    // o disco e as versões guardadas passam pela mesma decodificação do /api/file: um arquivo Windows-1252 aparece (e é
    // gravado de volta) com os acentos certos, sem "�" que corromperia o arquivo ao salvar pelo diff
    let disk = || async { tokio::fs::read(&abs).await.map(|b| decode_text(&b)).unwrap_or_else(|_| (String::new(), "utf-8", false)) };
    match detect(dir) {
        Some("git") => {
            let pre = git_prefix(dir).await;
            let nf = norm(file);
            let show = |spec: String| { let pre = pre.clone(); let nf = nf.clone(); async move {
                let (r, raw) = run_raw("git", &["-c", "core.quotepath=off", "show", "--end-of-options", &format!("{spec}:{pre}{nf}")], dir, 20000).await;
                if r.ok { decode_text(&raw).0 } else { failed(&r); String::new() }
            } };
            if mode == "working" { let (a, b) = tokio::join!(show("HEAD".into()), disk()); return DiffPair::with_disk(a, b); }
            if mode == "range" {
                let b = base.unwrap_or("HEAD").to_string();
                return match rev { Some(t) => { let (a, m) = tokio::join!(show(b), show(t.to_string())); DiffPair::pair(a, m) } None => { let (a, m) = tokio::join!(show(b), disk()); DiffPair::with_disk(a, m) } };
            }
            let t = rev.unwrap_or("HEAD").to_string();
            let (a, b) = tokio::join!(show(format!("{t}~1")), show(t.clone()));
            DiffPair::pair(a, b)
        }
        Some("svn") => {
            let cat = |r: String| async move { let (x, raw) = run_raw("svn", &["--non-interactive", "cat", "-r", &r, "--", file], dir, 20000).await; if x.ok { decode_text(&raw).0 } else { failed(&x); String::new() } };
            if mode == "working" { let (a, b) = tokio::join!(cat("BASE".into()), disk()); return DiffPair::with_disk(a, b); }
            if mode == "range" {
                let b = base.unwrap_or("BASE").to_string();
                return match rev { Some(t) => { let (a, m) = tokio::join!(cat(b), cat(t.to_string())); DiffPair::pair(a, m) } None => { let (a, m) = tokio::join!(cat(b), disk()); DiffPair::with_disk(a, m) } };
            }
            let t = match rev {
                Some(r) => r.to_string(),
                None => svn(dir, &["info", "--show-item", "last-changed-revision"]).await.out.trim().to_string(),
            };
            let n: i64 = t.parse().unwrap_or(0);
            let (a, b) = tokio::join!(cat((n - 1).to_string()), cat(t.clone()));
            DiffPair::pair(a, b)
        }
        _ => DiffPair::with_disk(String::new(), disk().await),
    }
}

// ---------- quem mudou esta linha ----------
#[derive(Serialize)]
pub struct Blame {
    /// o commit que deixou a linha como está (None: ainda não commitada)
    pub commit: Option<Commit>,
    /// número da linha naquele commit (para abrir o diff dele no lugar certo)
    pub line: usize,
}
static SVN_BLAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<entry\s+line-number="(\d+)">\s*(?:<commit\s+revision="(\d+)">)?"#).unwrap());
/// `contents`: o texto do editor (com edições ainda não salvas), para a linha bater com a que você está vendo
pub async fn blame(dir: &Path, file: &str, line: usize, contents: Option<&str>) -> Blame {
    let line = line.max(1);
    match detect(dir) {
        Some("git") => {
            let tmp = contents.and_then(|c| {
                let p = std::env::temp_dir().join(format!("bs-blame-{}-{}", std::process::id(), now_ms() as u64));
                std::fs::write(&p, c).is_ok().then_some(p)
            });
            let tp = tmp.as_ref().map(|p| p.to_string_lossy().to_string());
            let l = format!("{line},{line}");
            let mut a = vec!["blame", "--porcelain", "-L", &l];
            if let Some(t) = &tp { a.extend(["--contents", t.as_str()]); }
            a.extend(["--", file]);
            let r = git(dir, &a).await;
            if let Some(p) = tmp { let _ = std::fs::remove_file(p); }
            let mut it = r.out.lines();
            let Some(first) = it.next() else { return Blame { commit: None, line } };
            let mut f = first.split(' ');
            let id = f.next().unwrap_or("").to_string();
            let orig: usize = f.next().and_then(|x| x.parse().ok()).unwrap_or(line);
            if id.is_empty() || id.bytes().all(|b| b == b'0') { return Blame { commit: None, line }; }
            let (mut author, mut ts, mut subject) = (String::new(), String::new(), String::new());
            for l in it {
                if let Some(v) = l.strip_prefix("author ") { author = v.into(); }
                else if let Some(v) = l.strip_prefix("author-time ") { ts = v.into(); }
                else if let Some(v) = l.strip_prefix("summary ") { subject = v.into(); }
                else if l.starts_with('\t') { break; }
            }
            let c = Commit { hash: id[..id.len().min(7)].into(), id: Some(id), author, when: rel_time_unix(&ts), subject, ts: ts.trim().parse().ok(), path: None };
            Blame { commit: Some(c), line: orig }
        }
        Some("svn") => {
            let r = svn(dir, &["blame", "--xml", "--", file]).await;
            let rev = SVN_BLAME.captures_iter(&r.out).find(|c| c[1].parse::<usize>().ok() == Some(line)).and_then(|c| c.get(2).map(|m| m.as_str().to_string()));
            let Some(rev) = rev else { return Blame { commit: None, line } };
            let lg = svn(dir, &["log", "-r", &rev, "--xml"]).await;
            let c = parse_svn_log(&lg.out).into_iter().next().map(|mut c| { c.id = Some(c.hash.clone()); c.hash = format!("r{}", c.hash); c });
            Blame { commit: c, line }
        }
        _ => Blame { commit: None, line },
    }
}

static SVN_BRANCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/(trunk|branches/[^/]+|tags/[^/]+)(/|$)").unwrap());
/// Qual código a cópia local representa (trunk, branch, revisão).
pub async fn local_ref(dir: &Path, vcs: Option<&str>) -> serde_json::Value {
    match vcs {
        Some("git") => { let r = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await; serde_json::json!({ "branch": r.out.trim() }) }
        Some("svn") => {
            let (u, rv) = tokio::join!(svn(dir, &["info", "--show-item", "url"]), svn(dir, &["info", "--show-item", "revision"]));
            let url = u.out.trim();
            let branch = SVN_BRANCH.captures(url).map(|c| c[1].trim_start_matches("branches/").trim_start_matches("tags/").to_string()).unwrap_or_default();
            let rev = rv.out.trim();
            serde_json::json!({ "branch": branch, "rev": if rev.is_empty() { String::new() } else { format!("r{rev}") }, "url": url })
        }
        _ => serde_json::json!({}),
    }
}

// ---------- vários repositórios e linha do tempo (o painel Alterações em tela grande e o "Investigar incidente") ----------
#[derive(Serialize, Clone)]
pub struct Repo {
    pub path: String,
    /// caminho a partir da pasta pesquisada ("" quando a própria pasta é o repositório)
    pub rel: String,
    pub name: String,
    pub vcs: &'static str,
    pub branch: String,
    pub dirty: usize,
    pub last: Option<Commit>,
}
/// Checkouts Git/SVN dentro de `root` (ela mesma, se for um), até `depth` níveis. Dentro de um repositório achado não
/// procura mais (só a raiz pesquisada pode ter outros dentro). Pastas de build e ocultas ficam de fora.
pub fn find_repos(root: &Path, depth: usize) -> Vec<(PathBuf, &'static str)> {
    fn walk(dir: &Path, depth: usize, top: bool, out: &mut Vec<(PathBuf, &'static str)>, seen: &mut usize) {
        if out.len() >= 300 || *seen > 30_000 { return; }
        if let Some(v) = here(dir) { out.push((dir.to_path_buf(), v)); if !top { return; } }
        if depth == 0 { return; }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut subs: Vec<PathBuf> = rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| { let n = e.file_name().to_string_lossy().to_string(); !n.starts_with('.') && !IGNORED_DIRS.contains(n.as_str()) })
            .map(|e| e.path()).collect();
        subs.sort();
        for s in subs { *seen += 1; walk(&s, depth - 1, false, out, seen); }
    }
    let (mut out, mut seen) = (vec![], 0);
    walk(root, depth.min(6), true, &mut out, &mut seen);
    out
}
/// Os repositórios de uma pasta com o resumo de cada um (branch, alterações locais, último commit), até 8 por vez.
pub async fn repos(root: &Path, depth: usize) -> Vec<Repo> {
    let r2 = root.to_path_buf();
    let found = tokio::task::spawn_blocking(move || find_repos(&r2, depth)).await.unwrap_or_default();
    let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
    let jobs: Vec<_> = found.into_iter().map(|(p, v)| {
        let (gate, root) = (gate.clone(), root.to_path_buf());
        tokio::spawn(async move {
            let _g = gate.acquire().await;
            let s = summary(&p).await;
            let rel = norm(&rel(&root, &p));
            Repo { name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string_lossy().to_string()), path: p.to_string_lossy().into(), rel, vcs: v, branch: s.branch, dirty: s.dirty, last: s.last }
        })
    }).collect();
    let mut out = vec![];
    for j in jobs { if let Ok(r) = j.await { out.push(r); } }
    out
}

#[derive(Serialize, Clone)]
pub struct TimelineCommit {
    #[serde(flatten)]
    pub c: Commit,
    /// branches e tags que apontam para o commit (as tags costumam ser as versões implantadas)
    pub refs: Vec<String>,
    pub merge: bool,
    pub files: Vec<ChangedFile>,
}
fn iso_utc(ts: i64) -> String { chrono::DateTime::from_timestamp(ts, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default() }
static SVN_PATHS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<path\b([^>]*)>([\s\S]*?)</path>"#).unwrap());
static SVN_ACTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"action="(\w)""#).unwrap());
/// Os commits de um período (`since`/`until` em segundos unix), do mais novo para o mais antigo, cada um com os
/// arquivos que mudou. Um processo só por repositório. No SVN não vêm as linhas somadas e removidas.
pub async fn timeline(dir: &Path, since: i64, until: Option<i64>, max: usize) -> Vec<TimelineCommit> {
    let n = max.clamp(1, 2000).to_string();
    match detect(dir) {
        Some("git") => {
            let (s, u) = (format!("--since=@{since}"), until.map(|u| format!("--until=@{u}")));
            let mut a = vec!["log", "-n", &n, &s];
            if let Some(u) = &u { a.push(u); }
            a.extend(["--format=%x1e%H%x1f%h%x1f%an%x1f%ct%x1f%D%x1f%P%x1f%s", "--raw", "--numstat", "--", "."]);
            let (r, pre) = tokio::join!(git_t(dir, &a, 45000), git_prefix(dir));
            r.out.split('\x1e').filter_map(|chunk| {
                let (head, rest) = chunk.split_once('\n').unwrap_or((chunk, ""));
                let f: Vec<&str> = head.split('\x1f').collect();
                if f.len() < 7 || f[0].is_empty() { return None; }
                let refs = f[4].split(", ").map(|x| x.trim().trim_start_matches("HEAD -> ").to_string()).filter(|x| !x.is_empty() && x != "HEAD").collect();
                Some(TimelineCommit {
                    c: Commit { id: Some(f[0].into()), hash: f[1].into(), author: f[2].into(), when: rel_time_unix(f[3]), subject: f[6].into(), ts: f[3].trim().parse().ok(), path: None },
                    refs, merge: f[5].split_whitespace().count() > 1, files: parse_raw_numstat(rest, &pre),
                })
            }).collect()
        }
        Some("svn") => {
            let range = format!("{}:{{{}}}", until.map(|u| format!("{{{}}}", iso_utc(u))).unwrap_or_else(|| "HEAD".into()), iso_utc(since));
            let (la, ia) = (["log", "-r", &range, "-l", &n, "--xml", "-v"], ["info", "--show-item", "relative-url"]);
            let (r, base) = tokio::join!(svn_t(dir, &la, 45000), svn(dir, &ia));
            // "^/trunk/projeto": os caminhos do log vêm a partir da raiz do repositório
            let base = base.out.trim().trim_start_matches('^').trim_end_matches('/').to_string();
            LOG_ENTRY.captures_iter(&r.out).filter_map(|m| {
                let c = parse_svn_log(&m[0]).into_iter().next()?;
                let ts = c.ts?;
                if ts < since || until.is_some_and(|u| ts > u) { return None; } // {data} sem commit no dia devolve o anterior
                let files = SVN_PATHS.captures_iter(&m[2]).filter_map(|p| {
                    let full = html_unescape(p[2].trim());
                    let path = if base.is_empty() { full.trim_start_matches('/').to_string() } else { full.strip_prefix(&base)?.trim_start_matches('/').to_string() };
                    if path.is_empty() { return None; }
                    Some(ChangedFile { path, code: SVN_ACTION.captures(&p[1]).map(|a| a[1].to_string()).unwrap_or_else(|| "M".into()), staged: None, add: None, del: None })
                }).collect();
                Some(TimelineCommit { c: Commit { id: Some(c.hash.clone()), hash: format!("r{}", c.hash), ..c }, refs: vec![], merge: false, files })
            }).collect()
        }
        _ => vec![],
    }
}

/// Uma linha somada ou removida, num commit do período, que contém um dos termos procurados.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit { pub commit: String, pub file: String, pub line: usize, pub sign: char, pub term: String, pub text: String }
/// Lê a saída de "git log -p -U0" (commits marcados com \x1e + hash) ou de "svn log --diff" e devolve as linhas
/// que mudaram e contêm um termo. Até 3 por termo em cada arquivo de cada commit, `max` no total.
fn scan_patch(out: &str, terms: &[String], pre: &str, max: usize) -> Vec<Hit> {
    static HUNK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)").unwrap());
    static SVN_REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^r(\d+) \| ").unwrap());
    let (mut commit, mut file, mut old_file) = (String::new(), None::<String>, None::<String>);
    let (mut lo, mut ln, mut in_hunk) = (0usize, 0usize, false);
    let mut per: HashMap<(String, String, String), usize> = HashMap::new();
    let mut hits = vec![];
    let path = |p: &str| strip_prefix(unquote(p.split('\t').next().unwrap_or(p).trim()), pre);
    for l in out.lines() {
        if let Some(h) = l.strip_prefix('\x1e') { commit = h.trim().to_string(); file = None; in_hunk = false; continue; }
        if !in_hunk || !(l.starts_with('+') || l.starts_with('-') || l.starts_with(' ') || l.starts_with('\\')) {
            if let Some(c) = SVN_REV.captures(l) { commit = c[1].to_string(); file = None; in_hunk = false; continue; }
            if let Some(p) = l.strip_prefix("--- ") { old_file = p.strip_prefix("a/").and_then(path); in_hunk = false; continue; }
            if let Some(p) = l.strip_prefix("+++ ") { file = if p.starts_with("/dev/null") { old_file.clone() } else { path(p.strip_prefix("b/").unwrap_or(p)) }; in_hunk = false; continue; }
            if let Some(p) = l.strip_prefix("Index: ") { file = path(p); in_hunk = false; continue; }
            if let Some(c) = HUNK.captures(l) { lo = c[1].parse().unwrap_or(1); ln = c[2].parse().unwrap_or(1); in_hunk = true; continue; }
            in_hunk = false; continue;
        }
        let (sign, at) = match l.as_bytes()[0] { b'+' => { ln += 1; ('+', ln - 1) } b'-' => { lo += 1; ('-', lo - 1) } b' ' => { lo += 1; ln += 1; continue } _ => continue };
        let Some(f) = &file else { continue };
        let body = &l[1..];
        if body.len() > 2000 { continue; } // linha minificada: não é ali que alguém vai ler
        let low = body.to_lowercase();
        for t in terms {
            if !low.contains(t.as_str()) { continue; }
            let k = per.entry((commit.clone(), f.clone(), t.clone())).or_insert(0);
            if *k >= 3 { continue; }
            *k += 1;
            hits.push(Hit { commit: commit.clone(), file: f.clone(), line: at, sign, term: t.clone(), text: body.trim().chars().take(220).collect() });
            if hits.len() >= max { return hits; }
        }
    }
    hits
}
/// Procura os termos (um erro colado, o nome de uma classe, uma tabela) nas linhas que os commits do período somaram
/// ou removeram. Termos com menos de 3 letras ficam de fora; no máximo 12.
pub async fn scan(dir: &Path, since: i64, until: Option<i64>, terms: &[String], max: usize) -> Vec<Hit> {
    let mut terms: Vec<String> = terms.iter().map(|t| t.trim().to_lowercase()).filter(|t| t.chars().count() >= 3).collect();
    terms.sort(); terms.dedup(); terms.truncate(12);
    if terms.is_empty() { return vec![]; }
    match detect(dir) {
        Some("git") => {
            let (s, u) = (format!("--since=@{since}"), until.map(|u| format!("--until=@{u}")));
            let mut a = vec!["log", "-n", "400", &s];
            if let Some(u) = &u { a.push(u); }
            a.extend(["--format=%x1e%H", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--", "."]);
            let (r, pre) = tokio::join!(git_t(dir, &a, 60000), git_prefix(dir));
            scan_patch(&r.out, &terms, &pre, max)
        }
        Some("svn") => {
            let range = format!("{}:{{{}}}", until.map(|u| format!("{{{}}}", iso_utc(u))).unwrap_or_else(|| "HEAD".into()), iso_utc(since));
            let r = svn_t(dir, &["log", "-r", &range, "-l", "100", "--diff", "-x", "-U0"], 90000).await;
            scan_patch(&r.out, &terms, "", max)
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_e_numstat_de_um_processo_so() {
        let out = "a7a487c74e44859aa703ac41f9724ed195abecd0\n\n:100644 100644 1111111 2222222 M\tsub/a.rs\n:000000 100644 0000000 3333333 A\tsub/novo.txt\n:100644 100644 4444444 5555555 R087\tsub/velho.js\tsub/renomeado.js\n:100644 000000 6666666 0000000 D\tfora.md\n3\t1\tsub/a.rs\n10\t0\tsub/novo.txt\n-\t-\tsub/img.png\n";
        let f = parse_raw_numstat(out, "sub/");
        let got: Vec<(&str, &str, Option<i64>)> = f.iter().map(|x| (x.path.as_str(), x.code.as_str(), x.add)).collect();
        assert_eq!(got, vec![("a.rs", "M", Some(3)), ("novo.txt", "A", Some(10)), ("renomeado.js", "R", None)]);
        assert_eq!(f[0].del, Some(1));
    }

    #[test]
    fn termos_nas_linhas_que_mudaram() {
        let out = "aaa111
diff --git a/sub/Pedido.java b/sub/Pedido.java
--- a/sub/Pedido.java
+++ b/sub/Pedido.java
@@ -10,2 +10,3 @@ class Pedido {
-    int total = soma();
-    return total;
+    BigDecimal total = somaComDesconto();
+    log.info(\"total\");
+    return total;
bbb222
diff --git a/fora.txt b/fora.txt
--- a/fora.txt
+++ b/fora.txt
@@ -1 +1 @@
-somaComDesconto
+x
diff --git a/sub/velho.sql b/sub/velho.sql
--- a/sub/velho.sql
+++ /dev/null
@@ -3 +0,0 @@
-DROP TABLE desconto;
";
        let h = scan_patch(out, &["somacomdesconto".into(), "drop table".into()], "sub/", 50);
        assert_eq!(h.len(), 2, "{h:?}");
        assert_eq!((h[0].commit.as_str(), h[0].file.as_str(), h[0].line, h[0].sign), ("aaa111", "Pedido.java", 10, '+'));
        assert_eq!((h[1].commit.as_str(), h[1].file.as_str(), h[1].line, h[1].sign, h[1].term.as_str()), ("bbb222", "velho.sql", 3, '-', "drop table"));
        // svn log --diff: revisão na linha "r12 | autor | data", arquivo em "Index:"
        let svn = "------------------------------------------------------------------------
r12 | ana | 2024-01-02 03:04:05 +0000 (Tue, 02 Jan 2024) | 1 line

msg

Index: src/a.rs
===================================================================
--- src/a.rs	(revision 11)
+++ src/a.rs	(revision 12)
@@ -5 +5 @@
-let x = 1;
+let x = timeout_ms;
";
        let h = scan_patch(svn, &["timeout_ms".into()], "", 50);
        assert_eq!(h.len(), 1, "{h:?}");
        assert_eq!((h[0].commit.as_str(), h[0].file.as_str(), h[0].line), ("12", "src/a.rs", 5));
    }
    #[test]
    fn log_do_svn() {
        let xml = r#"<log><logentry revision="12"><author>ana</author><date>2024-01-02T03:04:05.000000Z</date><msg>corrige &amp; testa
segunda linha</msg></logentry><logentry revision="11"><author></author><msg></msg></logentry></log>"#;
        let c = parse_svn_log(xml);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].hash.as_str(), c[0].author.as_str(), c[0].subject.as_str()), ("12", "ana", "corrige & testa"));
        assert_eq!(c[0].ts, Some(1704164645));
        assert_eq!((c[1].hash.as_str(), c[1].ts), ("11", None));
    }
    #[test]
    fn numstat_com_caminho_entre_aspas_e_fora_do_prefixo() {
        let mut f = vec![ChangedFile { path: "ação.rs".into(), code: "M".into(), staged: None, add: None, del: None }];
        apply_numstat(&mut f, "4\t2\t\"sub/ação.rs\"\n1\t1\toutro/x.rs\n", "sub/");
        assert_eq!((f[0].add, f[0].del), (Some(4), Some(2)));
        assert_eq!(strip_prefix("sub/a/b.rs", "sub/").as_deref(), Some("a/b.rs"));
        assert_eq!(strip_prefix("outro/x.rs", "sub/"), None);
        assert_eq!(unquote("\"a b\""), "a b");
    }
    #[test]
    fn so_versoes_fixas_vao_para_o_cache() {
        assert!(fixed("a7a487c74e44859aa703ac41f9724ed195abecd0"));
        assert!(fixed("1234"));
        assert!(!fixed("HEAD"));
        assert!(!fixed("main"));
        assert!(!fixed("a7a487c"));
        assert!(!fixed(""));
    }

    #[test]
    fn linhas_do_svn_status() {
        assert!(svn_file_line("M       src/ação.rs"));
        assert!(svn_file_line("A  +    novo.txt"));
        assert!(!svn_file_line("Summary of conflicts:"));
        assert!(!svn_file_line("  Text conflicts: 1"));
        assert!(!svn_file_line("Status against revision:    12"));
        assert!(!svn_file_line("ção"));
        let f = parse_svn_summarize(Path::new("C:/Repo"), "M       C:/repo/Ação/x.rs\n");
        assert_eq!(f[0].path, "Ação/x.rs");
    }
    #[test]
    fn revisoes_de_pedido() {
        for ok in ["HEAD", "HEAD~1", "abc123^", "origin/main", "v1.2.0", "HEAD@{2}", "123", "BASE", "{2024-01-01}", "feature/x-y"] { assert!(safe_rev(ok), "{ok}"); }
        for bad in ["--output=C:/x", "-p", "", "a b", "a\nb", "HEAD:arquivo", "/etc", ".git"] { assert!(!safe_rev(bad), "{bad}"); }
    }
    #[test]
    fn lru_respeita_o_limite() {
        let mut l: Lru<String> = Lru::new(100);
        l.put("a".into(), "1".into(), 20);
        l.put("b".into(), "2".into(), 20);
        for k in ["c", "d", "e"] { l.put(k.into(), "3".into(), 25); }
        assert!(l.get("a").is_none()); // 115 > 100: sai o mais antigo
        assert_eq!(l.get("b").as_deref(), Some("2"));
        assert_eq!(l.get("e").as_deref(), Some("3"));
        l.put("grande".into(), "x".into(), 26); // mais de 1/4 do limite: não guarda
        assert!(l.get("grande").is_none());
    }
}
