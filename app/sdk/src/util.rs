//! Utilidades do núcleo: processos, erros de API, arquivos, datas e cache com validade.
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ---------- erro com status HTTP: as rotas devolvem Err e o despachante responde { error } ----------
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub msg: String,
}
impl ApiError {
    pub fn new(msg: impl Into<String>, status: u16) -> Self { Self { status, msg: msg.into() } }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.msg) }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self { ApiError::new(e.to_string(), 500) }
}
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self { ApiError::new(e.to_string(), 500) }
}
impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self { ApiError::new(e.to_string(), 400) }
}
pub type ApiResult<T> = Result<T, ApiError>;
/// Atalho: `return Err(fail("msg", 400))`.
pub fn fail(msg: impl Into<String>, status: u16) -> ApiError { ApiError::new(msg, status) }

// ---------- processos ----------
#[derive(Debug, Clone, Default)]
pub struct ProcResult {
    pub ok: bool,
    pub code: i32,
    pub out: String,
    pub err: String,
    pub not_found: bool,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Roda um programa e devolve a saída. Nunca falha: erro vira ok=false (not_found quando o programa não existe).
pub async fn run(cmd: &str, args: &[&str], cwd: &Path, timeout_ms: u64) -> ProcResult {
    run_env(cmd, args, cwd, timeout_ms, &[]).await
}
pub async fn run_env(cmd: &str, args: &[&str], cwd: &Path, timeout_ms: u64, env: &[(&str, &str)]) -> ProcResult {
    run_env_raw(cmd, args, cwd, timeout_ms, env).await.0
}
/// Como `run`, devolvendo também os bytes da saída como vieram (para decodificar com `decode_text`: o conteúdo de um
/// arquivo pelo `git show` pode ser Windows-1252).
pub async fn run_raw(cmd: &str, args: &[&str], cwd: &Path, timeout_ms: u64) -> (ProcResult, Vec<u8>) {
    run_env_raw(cmd, args, cwd, timeout_ms, &[]).await
}
async fn run_env_raw(cmd: &str, args: &[&str], cwd: &Path, timeout_ms: u64, env: &[(&str, &str)]) -> (ProcResult, Vec<u8>) {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args).current_dir(cwd).env("LC_ALL", "C.UTF-8").env("GIT_PAGER", "cat")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env { c.env(k, v); }
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return (ProcResult { ok: false, code: -1, err: e.to_string(), not_found: e.kind() == std::io::ErrorKind::NotFound, ..Default::default() }, vec![]),
    };
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(o)) => (ProcResult {
            ok: o.status.success(),
            code: o.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&o.stdout).into_owned(),
            err: String::from_utf8_lossy(&o.stderr).into_owned(),
            not_found: false,
        }, o.stdout),
        Ok(Err(e)) => (ProcResult { ok: false, code: -1, err: e.to_string(), ..Default::default() }, vec![]),
        Err(_) => (ProcResult { ok: false, code: -1, err: "tempo esgotado".into(), ..Default::default() }, vec![]),
    }
}

/// Próxima linha da saída de um programa, mesmo que não seja UTF-8 (cp850, cp1252): os bytes ruins viram "�" em vez
/// de encerrar a leitura, como faz `lines()`. None no fim da saída.
pub async fn next_line_lossy<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> Option<String> {
    use tokio::io::AsyncBufReadExt;
    buf.clear();
    match r.read_until(b'\n', buf).await { Ok(0) | Err(_) => None, Ok(_) => Some(String::from_utf8_lossy(buf).trim_end_matches(['\n', '\r']).to_string()) }
}
/// O mesmo, para leitura sem tokio (threads).
pub fn next_line_lossy_sync<R: std::io::BufRead>(r: &mut R, buf: &mut Vec<u8>) -> Option<String> {
    buf.clear();
    match r.read_until(b'\n', buf) { Ok(0) | Err(_) => None, Ok(_) => Some(String::from_utf8_lossy(buf).trim_end_matches(['\n', '\r']).to_string()) }
}

/// Abre algo sem esperar (Explorer, navegador).
pub fn fire(cmd: &str, args: &[&str]) {
    let mut c = std::process::Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = c.spawn();
}
pub fn open_url(url: &str) {
    #[cfg(windows)]
    fire("rundll32", &["url.dll,FileProtocolHandler", url]);
    #[cfg(not(windows))]
    fire("xdg-open", &[url]);
}

// ---------- arquivos ----------
pub static IGNORED_DIRS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    ["node_modules", ".git", ".svn", "dist", "build", "target", ".idea", ".vscode", "__pycache__", ".next", "coverage"].into_iter().collect()
});
pub const MAX_FILE: u64 = 2 * 1024 * 1024;

pub fn norm(p: &str) -> String { p.replace('\\', "/") }
pub fn exists(p: &Path) -> bool { p.exists() }

/// Caminho absoluto sem prefixo \\?\ (canonicalize no Windows devolve UNC) e sem exigir que exista.
pub fn absolute(p: &Path) -> PathBuf {
    let a = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut out = PathBuf::new();
    for c in a.components() {
        match c {
            std::path::Component::ParentDir => { out.pop(); }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
pub fn within(root: &Path, target: &Path) -> bool {
    let r = absolute(root).to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string();
    let t = absolute(target).to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string();
    t == r || t.starts_with(&(r + std::path::MAIN_SEPARATOR_STR))
}
pub fn rel(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).map(|p| norm(&p.to_string_lossy())).unwrap_or_else(|_| norm(&full.to_string_lossy()))
}
pub fn read_text(p: &Path, max: u64) -> String {
    match std::fs::metadata(p) {
        Ok(m) if m.len() <= max => std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default(),
        _ => String::new(),
    }
}
// ---------- codificação dos arquivos de texto ----------
/// Windows-1252 de 0x80 a 0x9F (o resto é igual ao Latin-1); os 5 bytes sem letra viram o próprio código, como no
/// TextDecoder do navegador: qualquer arquivo lido assim grava de volta exatamente os mesmos bytes.
const CP1252: [u16; 32] = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
/// Bytes em Windows-1252 como texto (cada byte vira um caractere; nunca falha).
pub fn decode_cp1252(buf: &[u8]) -> String {
    buf.iter().map(|&b| if (0x80..0xA0).contains(&b) { char::from_u32(CP1252[(b - 0x80) as usize] as u32).unwrap_or('?') } else { b as char }).collect()
}
/// Texto de um arquivo: (texto, codificação, BOM). UTF-8, com ou sem BOM; o que não é UTF-8 válido é lido como
/// Windows-1252 (o padrão do Windows em português), em vez de virar "�" e ser gravado assim.
pub fn decode_text(buf: &[u8]) -> (String, &'static str, bool) {
    if let Some(rest) = buf.strip_prefix(b"\xEF\xBB\xBF") { return (String::from_utf8_lossy(rest).into_owned(), "utf-8", true); }
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), "utf-8", false),
        Err(_) => (decode_cp1252(buf), "windows-1252", false),
    }
}
/// O texto do editor de volta nos bytes do arquivo; Err(caractere) quando ele não existe no Windows-1252.
pub fn encode_text(text: &str, encoding: &str, bom: bool) -> Result<Vec<u8>, char> {
    if encoding != "windows-1252" {
        let mut out = if bom { b"\xEF\xBB\xBF".to_vec() } else { vec![] };
        out.extend_from_slice(if bom { text.strip_prefix('\u{FEFF}').unwrap_or(text) } else { text }.as_bytes());
        return Ok(out);
    }
    text.chars().map(|c| {
        let u = c as u32;
        if u < 0x80 || (0xA0..=0xFF).contains(&u) { Ok(u as u8) } else { CP1252.iter().position(|&x| x as u32 == u).map(|i| 0x80 + i as u8).ok_or(c) }
    }).collect()
}

pub fn looks_binary(head: &[u8]) -> bool { memchr::memchr(0, &head[..head.len().min(8000)]).is_some() }
pub fn mtime_ms(t: SystemTime) -> f64 { t.duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0) }
pub fn now_ms() -> f64 { mtime_ms(SystemTime::now()) }
pub fn user_dir() -> PathBuf { dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".bluescreen") }
pub fn read_json(p: &Path) -> Value { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null) }
/// Para ler, mudar e gravar de volta: `Null` só quando o arquivo não existe (ou está vazio). Arquivo que existe mas não
/// abre ou não é JSON é erro: tratá-lo como vazio faria a próxima gravação apagar o que estava lá (o cofre, a config).
pub fn read_json_strict(p: &Path) -> std::io::Result<Value> {
    match std::fs::read_to_string(p) {
        Ok(s) if s.trim().is_empty() => Ok(Value::Null),
        Ok(s) => serde_json::from_str(s.trim_start_matches('\u{FEFF}')).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{} não é um JSON válido ({e}); conserte ou apague o arquivo", p.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(std::io::Error::new(e.kind(), format!("não deu para ler {}: {e}", p.display()))),
    }
}
/// Grava num temporário de nome único, manda para o disco e troca pelo arquivo: uma queda no meio deixa o antigo inteiro.
pub fn write_atomic(p: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(d) = p.parent() { std::fs::create_dir_all(d)?; }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = p.with_file_name(format!("{name}.{}-{:08x}.tmp", std::process::id(), rand::random::<u32>()));
    let res = (|| { let mut f = std::fs::File::create(&tmp)?; f.write_all(text.as_bytes())?; f.sync_all()?; drop(f); std::fs::rename(&tmp, p) })();
    if res.is_err() { let _ = std::fs::remove_file(&tmp); }
    res
}

// ---------- datas (pt-BR) ----------
pub fn rel_time_ms(ms: f64) -> String {
    let s = (now_ms() - ms) / 1000.0;
    if s < 3600.0 { return format!("{} min", (s / 60.0).round().max(1.0)); }
    if s < 86400.0 { return format!("{} h", (s / 3600.0).round()); }
    if s < 86400.0 * 30.0 { return format!("{} d", (s / 86400.0).round()); }
    br_date(ms)
}
pub fn br_date(ms: f64) -> String {
    use chrono::{Local, TimeZone};
    Local.timestamp_millis_opt(ms as i64).single().map(|d| d.format("%d/%m/%Y").to_string()).unwrap_or_default()
}
pub fn rel_time_unix(secs: &str) -> String { secs.trim().parse::<f64>().map(|s| rel_time_ms(s * 1000.0)).unwrap_or_default() }
pub fn iso_ms(iso: &str) -> Option<f64> { chrono::DateTime::parse_from_rfc3339(iso.trim()).ok().map(|d| d.timestamp_millis() as f64) }
pub fn rel_time_iso(iso: &str) -> String { iso_ms(iso).map(rel_time_ms).unwrap_or_default() }

pub fn html_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&#10;", "\n").replace("&amp;", "&")
}

// ---------- cache com validade, seguro entre threads ----------
pub struct TtlCache<K, V> {
    map: Mutex<HashMap<K, (Instant, V)>>,
    ttl: Duration,
}
impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    pub fn new(ttl: Duration) -> Self { Self { map: Mutex::new(HashMap::new()), ttl } }
    pub fn get(&self, k: &K) -> Option<V> {
        let m = self.map.lock();
        m.get(k).filter(|(at, _)| at.elapsed() < self.ttl).map(|(_, v)| v.clone())
    }
    pub fn set(&self, k: K, v: V) { self.map.lock().insert(k, (Instant::now(), v)); }
    pub fn remove(&self, k: &K) { self.map.lock().remove(k); }
}

/// Pasta da aplicação (onde estão wwwroot/ e plugins/): ao lado do executável ou, em desenvolvimento, subindo a partir dele.
pub fn app_dir() -> PathBuf {
    static DIR: LazyLock<PathBuf> = LazyLock::new(|| {
        let exe = std::env::current_exe().unwrap_or_default();
        let mut cur = exe.parent().map(Path::to_path_buf);
        while let Some(d) = cur {
            if d.join("wwwroot").join("index.html").exists() { return d; }
            cur = d.parent().map(Path::to_path_buf);
        }
        std::env::current_dir().unwrap_or_default()
    });
    DIR.clone()
}

/// Log no console (quando existe) e em ~/.bluescreen/bluescreen.log.
pub fn log(msg: impl AsRef<str>) {
    let line = format!("  {}", msg.as_ref());
    println!("{line}");
    static FILE: LazyLock<Mutex<Option<std::fs::File>>> = LazyLock::new(|| {
        let _ = std::fs::create_dir_all(user_dir());
        Mutex::new(std::fs::OpenOptions::new().create(true).append(true).open(user_dir().join("bluescreen.log")).ok())
    });
    if let Some(f) = FILE.lock().as_mut() {
        use std::io::Write;
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg.as_ref());
    }
}

/// Conteúdo de um zip: (nome, bytes), sem as pastas.
pub fn unzip(data: &[u8]) -> ApiResult<Vec<(String, Vec<u8>)>> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| fail(format!("zip inválido: {e}"), 500))?;
    let mut out = vec![];
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| fail(format!("zip inválido: {e}"), 500))?;
        if f.is_dir() { continue; }
        let mut buf = Vec::with_capacity(f.size() as usize);
        std::io::Read::read_to_end(&mut f, &mut buf)?;
        out.push((f.name().map(|n| n.to_string()).unwrap_or_default(), buf));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn caminhos_dentro_do_projeto() {
        let p = Path::new(r"C:\Proj\App");
        assert!(within(p, Path::new(r"C:\Proj\App\src\a.rs")));
        assert!(within(p, Path::new(r"c:\proj\app\SRC"))); // o Windows não diferencia maiúsculas
        assert!(within(p, Path::new(r"C:\Proj\App\"))); // a própria pasta, com barra no fim
        assert!(within(p, &absolute(Path::new(r"C:\Proj\App\src\..\b.txt"))));
        assert!(!within(p, &absolute(Path::new(r"C:\Proj\App\..\..\Windows"))));
        assert!(!within(p, Path::new(r"C:\Proj\App2\x"))); // prefixo de nome não é estar dentro
        assert!(!within(p, Path::new(r"C:\Proj")));
        assert_eq!(absolute(Path::new(r"C:\a\.\b\..\c")), PathBuf::from(r"C:\a\c"));
        assert_eq!(rel(Path::new(r"C:\a"), Path::new(r"C:\a\b\c.txt")), "b/c.txt");
    }
    #[test]
    fn json_para_editar() {
        let d = std::env::temp_dir().join(format!("bs-json-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("a.json");
        assert!(read_json_strict(&p).unwrap().is_null()); // não existe: vazio
        write_atomic(&p, r#"{"x":1}"#).unwrap();
        assert_eq!(read_json_strict(&p).unwrap()["x"], 1);
        std::fs::write(&p, "{quebrado").unwrap();
        assert!(read_json_strict(&p).is_err()); // existe e não é JSON: erro, não vazio
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1); // nenhum temporário sobrando
        let _ = std::fs::remove_dir_all(&d);
    }
}
