//! Vigia da pasta do projeto: o próprio Windows avisa (ReadDirectoryChangesW, a mesma API que o Explorer usa)
//! quando um arquivo é criado, apagado, renomeado ou gravado por outro programa (git pull, formatador, outro editor,
//! um agente...). A página pergunta por /api/watch?project=..&since=<seq> (long-poll): a resposta sai assim que
//! algo muda, ou depois de ~25 s sem novidade. Cada evento leva um número de sequência global; quem está atrasado
//! demais (o buffer do Windows estourou ou o histórico daqui foi descartado) recebe `all: true` e confere tudo.
//! Pastas pesadas e geradas (node_modules, target, .git/objects...) são ignoradas; do .git só interessa o que muda
//! o estado do VCS (HEAD, index, refs), que vira `vcs: true`.
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// eventos guardados por projeto; quem pede algo mais antigo recebe `all: true`
const KEEP: usize = 4000;
/// mais que isso numa resposta: manda `all: true` em vez da lista
const MAX_FILES: usize = 400;
/// projeto sem ninguém perguntando por este tempo: o vigia é desligado (libera a pasta)
const IDLE: Duration = Duration::from_secs(90);
const IGNORED: &[&str] = &["node_modules", "target", ".gradle", "__pycache__", ".vs", ".idea", ".mypy_cache", ".pytest_cache", ".next", ".turbo"];

static SEQ: AtomicU64 = AtomicU64::new(0);
static WATCHES: LazyLock<Mutex<HashMap<PathBuf, Arc<Watch>>>> = LazyLock::new(Default::default);

#[derive(Clone, Copy, PartialEq)]
enum Kind { Change, Add, Remove, Vcs, Overflow }

struct State { events: VecDeque<(u64, Kind, String)>, first: u64, dropped: u64, last_poll: Instant }

pub struct Watch {
    state: Mutex<State>,
    notify: Notify,
    stop: AtomicBool,
    dead: AtomicBool,
}

impl Watch {
    fn push(&self, evs: Vec<(Kind, String)>) {
        if evs.is_empty() { return; }
        let mut s = self.state.lock();
        for (k, p) in evs {
            let n = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            s.events.push_back((n, k, p));
            if s.events.len() > KEEP { if let Some((n, ..)) = s.events.pop_front() { s.dropped = n; } }
        }
        drop(s);
        self.notify.notify_waiters();
    }
    /// eventos depois de `since`, já sem repetição; None = nada novo
    fn collect(&self, since: u64) -> Option<Value> {
        let s = self.state.lock();
        let seq = s.events.back().map(|e| e.0).unwrap_or(s.first);
        if since > seq || since < s.first || since < s.dropped { return Some(json!({ "seq": seq.max(s.first), "native": true, "all": true, "vcs": true, "files": [] })); }
        if seq == since { return None; }
        let (mut all, mut vcs) = (false, false);
        let mut files: BTreeMap<&str, &'static str> = BTreeMap::new();
        for (_, k, p) in s.events.iter().filter(|e| e.0 > since) {
            match k {
                Kind::Overflow => all = true,
                Kind::Vcs => vcs = true,
                _ => {
                    let k = match k { Kind::Add => "add", Kind::Remove => "remove", _ => "change" };
                    // criar/apagar vale mais que gravar: a árvore precisa saber
                    let e = files.entry(p.as_str()).or_insert(k);
                    if *e == "change" { *e = k; }
                }
            }
        }
        if files.len() > MAX_FILES { all = true; files.clear(); }
        let files: Vec<Value> = files.into_iter().map(|(p, k)| json!({ "p": p, "k": k })).collect();
        Some(json!({ "seq": seq, "native": true, "all": all, "vcs": vcs || all, "files": files }))
    }
}

/// caminho relativo (com /) que interessa à interface, ou None para ignorar
fn classify(rel: &str) -> Option<Kind> {
    if let Some(g) = rel.strip_prefix(".git/") {
        return (g == "HEAD" || g == "index" || g == "MERGE_HEAD" || g == "packed-refs" || g.starts_with("refs/")).then_some(Kind::Vcs);
    }
    if rel == ".git" { return Some(Kind::Vcs); }
    if let Some(s) = rel.strip_prefix(".svn/") { return (s == "wc.db").then_some(Kind::Vcs); }
    if rel.split('/').any(|seg| IGNORED.contains(&seg)) { return None; }
    // arquivo temporário do salvar de arquivos grandes (bigfile.rs): vira o arquivo de verdade logo em seguida
    if rel.ends_with(".bs-save~") { return None; }
    Some(Kind::Change)
}

/// Chave do vigia: o mesmo projeto pedido como "C:\Proj", "c:\proj\" ou "C:/Proj" é uma pasta só (no Windows os
/// nomes não diferenciam maiúsculas); sem isso cada grafia abria um vigia próprio na mesma pasta.
fn key(root: &Path) -> PathBuf {
    let s = crate::util::absolute(root).to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\');
    // "C:\" vira "C:" no trim: a raiz do disco continua sendo a raiz
    let s = if s.ends_with(':') { format!("{s}\\") } else { s.to_string() };
    PathBuf::from(if cfg!(windows) { s.to_lowercase() } else { s })
}
/// desliga os vigias que ninguém consulta há um tempo (outro projeto aberto, janela fechada) e os que morreram
fn reap(keep: Option<&Path>) {
    WATCHES.lock().retain(|p, w| {
        let keep = Some(p.as_path()) == keep || (!w.dead.load(Ordering::SeqCst) && w.state.lock().last_poll.elapsed() < IDLE);
        if !keep { w.stop.store(true, Ordering::SeqCst); }
        keep
    });
}
fn get_or_start(root: &Path) -> Arc<Watch> {
    let k = key(root);
    // limpeza também por tempo: sem isso um vigia ocioso só caía quando outro projeto pedisse o seu
    static REAPER: std::sync::Once = std::sync::Once::new();
    if tokio::runtime::Handle::try_current().is_ok() {
        REAPER.call_once(|| { tokio::spawn(async { loop { tokio::time::sleep(IDLE / 3).await; reap(None); } }); });
    }
    reap(Some(&k));
    let mut m = WATCHES.lock();
    if let Some(w) = m.get(&k) { if !w.dead.load(Ordering::SeqCst) { return w.clone(); } }
    let first = SEQ.load(Ordering::SeqCst);
    let w = Arc::new(Watch { state: Mutex::new(State { events: VecDeque::new(), first, dropped: 0, last_poll: Instant::now() }), notify: Notify::new(), stop: AtomicBool::new(false), dead: AtomicBool::new(false) });
    m.insert(k, w.clone());
    let (w2, root) = (w.clone(), root.to_path_buf());
    let started = std::thread::Builder::new().name("bs-watch".into()).spawn(move || {
        // erro interno no vigia: ele morre (anotado no log pelo gancho de main.rs) e a página passa a conferir as abas
        // de tempos em tempos (native: false); o próximo pedido abre outro
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&root, &w2)));
        w2.dead.store(true, Ordering::SeqCst);
        w2.notify.notify_waiters();
    });
    if started.is_err() { w.dead.store(true, Ordering::SeqCst); }
    w
}

/// Long-poll: devolve { seq, native, all, vcs, files: [{ p, k: change|add|remove }] }.
/// Sem `since`, responde na hora só com o seq atual (ponto de partida). `native: false` = sem vigia nesta
/// plataforma ou a pasta não pôde ser vigiada; a interface passa a conferir as abas abertas de tempos em tempos.
pub async fn poll(root: PathBuf, since: Option<u64>) -> Value {
    let w = get_or_start(&root);
    w.state.lock().last_poll = Instant::now();
    let Some(since) = since else {
        let s = w.state.lock();
        return json!({ "seq": s.events.back().map(|e| e.0).unwrap_or(s.first), "native": !w.dead.load(Ordering::SeqCst), "files": [] });
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    loop {
        let notified = w.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if w.collect(since).is_some() {
            // junta a rajada (um git checkout grava dezenas de arquivos em sequência)
            tokio::time::sleep(Duration::from_millis(150)).await;
            w.state.lock().last_poll = Instant::now();
            return w.collect(since).unwrap_or_else(|| json!({ "seq": since, "native": true, "files": [] }));
        }
        if w.dead.load(Ordering::SeqCst) { return json!({ "seq": since, "native": false, "files": [] }); }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            w.state.lock().last_poll = Instant::now();
            return json!({ "seq": since, "native": true, "files": [] });
        }
    }
}

#[cfg(not(windows))]
fn run(_root: &Path, _w: &Watch) {}

#[cfg(windows)]
fn run(root: &Path, w: &Watch) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_IO_PENDING, GetLastError, INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResultEx, OVERLAPPED};
    use windows_sys::Win32::System::Threading::CreateEventW;

    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // FILE_SHARE_DELETE: a pasta continua podendo ser renomeada/apagada por outros programas
    let h = unsafe { CreateFileW(wide.as_ptr(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, std::ptr::null_mut()) };
    if h == INVALID_HANDLE_VALUE { crate::util::log(&format!("Vigia: não deu para abrir {}", root.display())); return; }
    let ev = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if ev.is_null() { unsafe { CloseHandle(h) }; return; }
    // FILE_NOTIFY_INFORMATION precisa de alinhamento de DWORD: buffer de u64
    let mut buf = vec![0u64; 8192];
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE;
    'outer: while !w.stop.load(Ordering::SeqCst) {
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = ev;
        let issued = unsafe { ReadDirectoryChangesW(h, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, 1, filter, std::ptr::null_mut(), &mut ov, None) };
        if issued == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING { break; }
        let mut got: u32 = 0;
        // espera em fatias curtas para poder desligar o vigia sem depender de fechar a pasta no meio da leitura
        loop {
            if unsafe { GetOverlappedResultEx(h, &ov, &mut got, 500, 0) } != 0 { break; }
            if unsafe { GetLastError() } != WAIT_TIMEOUT { break 'outer; }
            if w.stop.load(Ordering::SeqCst) {
                unsafe { CancelIoEx(h, &ov); GetOverlappedResultEx(h, &ov, &mut got, 2000, 0); }
                break 'outer;
            }
        }
        if got == 0 { w.push(vec![(Kind::Overflow, String::new())]); continue; }
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), got as usize) };
        let mut evs = vec![];
        let mut off = 0usize;
        while off + 12 <= bytes.len() {
            let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            let (next, action, len) = (u32_at(off) as usize, u32_at(off + 4), u32_at(off + 8) as usize);
            let end = (off + 12 + len).min(bytes.len());
            let name: Vec<u16> = bytes[off + 12..end].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            let rel = String::from_utf16_lossy(&name).replace('\\', "/");
            if let Some(k) = classify(&rel) {
                let k = match (k, action) {
                    (Kind::Vcs, _) => Kind::Vcs,
                    (_, FILE_ACTION_ADDED | FILE_ACTION_RENAMED_NEW_NAME) => Kind::Add,
                    (_, FILE_ACTION_REMOVED | FILE_ACTION_RENAMED_OLD_NAME) => Kind::Remove,
                    _ => Kind::Change,
                };
                evs.push((k, rel));
            }
            if next == 0 { break; }
            off += next;
        }
        w.push(evs);
    }
    unsafe { CloseHandle(ev); CloseHandle(h); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classify_paths() {
        assert!(classify("src/main.rs") == Some(Kind::Change));
        assert!(classify(".git/index") == Some(Kind::Vcs));
        assert!(classify(".git/refs/heads/main") == Some(Kind::Vcs));
        assert!(classify(".git/objects/ab/cdef").is_none());
        assert!(classify("web/node_modules/x/index.js").is_none());
        assert!(classify("target/debug/app.exe").is_none());
    }
    #[test]
    #[cfg(windows)]
    fn mesma_pasta_mesma_chave() {
        assert_eq!(key(Path::new(r"C:\Proj\App")), key(Path::new("c:/proj/app/")));
        assert_eq!(key(Path::new(r"C:\Proj\App\")), key(Path::new(r"C:\PROJ\APP")));
        assert_eq!(key(Path::new(r"C:\Proj\.\App")), key(Path::new(r"C:\Proj\App")));
        assert_ne!(key(Path::new(r"C:\Proj\App")), key(Path::new(r"C:\Proj\App2")));
        assert_eq!(key(Path::new("C:\\")), PathBuf::from("c:\\"));
    }
}
