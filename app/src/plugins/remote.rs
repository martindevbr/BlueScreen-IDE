//! Loja de plugins: o catálogo oficial é o repositório github.com/martindevbr/BlueScreen-Plugins (cada pasta de
//! `plugins/` é um plugin). A IDE baixa o zip do branch num pedido só, guarda em ~/.bluescreen/store-cache com o
//! ETag (sem mudança no repositório, o GitHub responde 304 e nada é baixado de novo; sem rede, vale o guardado),
//! lista, instala e atualiza na pasta do usuário. BLUESCREEN_PLUGIN_REPO aponta uma pasta local no lugar do GitHub
//! (um clone do repositório, para testar um plugin antes de publicar).
//! Servidores de plugins de equipe (app/plugin-server) continuam valendo se estiverem em ~/.bluescreen/plugins.json
//! (`servers: [{ url }]`): os plugins deles entram no mesmo catálogo. Plugin instalado leva um `.origin.json` na
//! pasta ({ server, version, sha256, installed }); a interface pergunta de tempos em tempos (`plugins/remote`) e
//! mostra o aviso de atualização enquanto houver versão maior.
use super::{RouteFn, ok, route_fn};
use crate::server::host;
use crate::util::*;
use base64::Engine;
use bluescreen_sdk::store::{bundle_hash, safe_rel, valid_id, version_cmp};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// última verificação: o painel e o aviso reaproveitam por um minuto (fresh=1 força)
static LAST: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(|| Mutex::new(None));

struct Server { url: String }
fn servers() -> Vec<Server> {
    super::config()["servers"].as_array().into_iter().flatten().filter_map(|s| {
        let url = s["url"].as_str().or_else(|| s.as_str())?.to_string();
        Some(Server { url })
    }).collect()
}
/// "meu-pc:4900" vira "http://meu-pc:4900"; sem barra no fim
fn norm_url(s: &str) -> Result<String, String> {
    let s = s.trim().trim_end_matches('/');
    let s = if s.contains("://") { s.to_string() } else { format!("http://{s}") };
    let ok = (s.starts_with("http://") || s.starts_with("https://")) && s.len() > 8 && !s.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok { Ok(s) } else { Err(format!("endereço inválido: {s}")) }
}
fn http(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(concat!("BlueScreen-IDE/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(secs)).build().map_err(|e| e.to_string())
}
/// erro legível de uma resposta do servidor ({ error } ou o status)
async fn server_error(r: reqwest::Response) -> String {
    let st = r.status();
    r.json::<Value>().await.ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or_else(|| format!("o servidor respondeu {st}"))
}
fn net_error(url: &str, e: reqwest::Error) -> String {
    if e.is_timeout() { format!("{url} não respondeu a tempo") } else if e.is_connect() { format!("não deu para conectar em {url}") } else { e.to_string() }
}

async fn index(url: String) -> Result<Value, String> {
    let r = http(12)?.get(format!("{url}/api/index")).send().await.map_err(|e| net_error(&url, e))?;
    if !r.status().is_success() { return Err(server_error(r).await); }
    let v: Value = r.json().await.map_err(|_| format!("{url} não é um servidor de plugins do BlueScreen"))?;
    if v["plugins"].is_array() { Ok(v) } else { Err(format!("{url} não é um servidor de plugins do BlueScreen")) }
}

// ---------- a loja oficial: o repositório de plugins no GitHub ----------
/// como a loja aparece no `.origin.json` e no campo `server` de cada plugin do catálogo
pub const STORE: &str = "github:martindevbr/BlueScreen-Plugins";
const STORE_WEB: &str = "https://github.com/martindevbr/BlueScreen-Plugins";
const STORE_ZIP: &str = "https://codeload.github.com/martindevbr/BlueScreen-Plugins/zip/refs/heads/main";
/// maior arquivo e maior repositório aceitos (descompactados)
const MAX_FILE: u64 = 64 << 20;
const MAX_REPO: u64 = 512 << 20;

struct Pkg { id: String, manifest: Value, files: Vec<(String, Vec<u8>)> }
/// `stale`: a rede falhou e a lista é a guardada da última vez (o aviso vai para a tela)
struct Snap { pkgs: Vec<Pkg>, stale: Option<String> }
static SNAP: LazyLock<Mutex<Option<(Instant, Arc<Snap>)>>> = LazyLock::new(|| Mutex::new(None));

/// arquivos soltos ("plugins/<id>/<caminho>") viram um pacote por plugin; pasta sem plugin.json válido fica de fora
fn group(files: Vec<(String, Vec<u8>)>) -> Vec<Pkg> {
    let mut by: HashMap<String, Vec<(String, Vec<u8>)>> = HashMap::new();
    for (p, d) in files {
        let Some(rest) = p.strip_prefix("plugins/") else { continue };
        let Some((id, rel)) = rest.split_once('/') else { continue };
        if !valid_id(id) || !safe_rel(rel) || rel == ".origin.json" { continue; }
        by.entry(id.to_string()).or_default().push((rel.to_string(), d));
    }
    let mut out: Vec<Pkg> = by.into_iter().filter_map(|(id, mut files)| {
        let m: Value = files.iter().find(|f| f.0 == "plugin.json").and_then(|f| serde_json::from_slice(f.1.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&f.1)).ok())?;
        if m["id"].as_str().map(str::trim) != Some(id.as_str()) { return None; }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        Some(Pkg { id, manifest: m, files })
    }).collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}
/// o zip do GitHub: tudo dentro de uma pasta "<repo>-<branch>/"
fn from_zip(bytes: &[u8]) -> Result<Vec<Pkg>, String> {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("o pacote da loja não abriu: {e}"))?;
    let (mut files, mut total) = (vec![], 0u64);
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        if !f.is_file() { continue; }
        let Ok(name) = f.name().map(|n| n.replace('\\', "/")) else { continue };
        let Some((_, rel)) = name.split_once('/') else { continue };
        if !rel.starts_with("plugins/") { continue; }
        total += f.size();
        if f.size() > MAX_FILE || total > MAX_REPO { return Err("o repositório de plugins passou do tamanho aceito".into()); }
        let mut d = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut d).map_err(|e| format!("{rel}: {e}"))?;
        files.push((rel.to_string(), d));
    }
    Ok(group(files))
}
/// uma pasta local com a mesma forma do repositório (BLUESCREEN_PLUGIN_REPO)
fn from_dir(root: &Path) -> Result<Vec<Pkg>, String> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, Vec<u8>)>, total: &mut u64) -> Result<(), String> {
        for e in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n == ".git" || n == "node_modules" || n == ".origin.json" { continue; }
            let r = format!("{rel}/{n}");
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() { walk(&e.path(), &r, out, total)?; }
            else if t.is_file() {
                let d = std::fs::read(e.path()).map_err(|e| format!("{r}: {e}"))?;
                *total += d.len() as u64;
                if d.len() as u64 > MAX_FILE || *total > MAX_REPO { return Err("a pasta de plugins passou do tamanho aceito".into()); }
                out.push((r, d));
            }
        }
        Ok(())
    }
    let (mut files, mut total) = (vec![], 0u64);
    walk(&root.join("plugins"), "plugins", &mut files, &mut total)?;
    Ok(group(files))
}
/// baixa o zip (ou confirma pelo ETag que o guardado ainda vale). Sem rede, devolve o guardado com o aviso.
async fn download() -> Result<(Vec<u8>, Option<String>), String> {
    let dir = user_dir().join("store-cache");
    let (zip_file, etag_file) = (dir.join("repo.zip"), dir.join("etag"));
    let cached = || std::fs::read(&zip_file).ok().filter(|b| !b.is_empty());
    let etag = std::fs::read_to_string(&etag_file).ok().filter(|_| zip_file.is_file());
    let mut req = http(120)?.get(STORE_ZIP);
    if let Some(e) = &etag { req = req.header("If-None-Match", e.trim()); }
    let offline = |why: String| match cached() { Some(b) => Ok((b, Some(why))), None => Err(why) };
    let r = match req.send().await { Ok(r) => r, Err(e) => return offline(net_error("o GitHub", e)) };
    if r.status() == reqwest::StatusCode::NOT_MODIFIED && let Some(b) = cached() { return Ok((b, None)); }
    if !r.status().is_success() { return offline(format!("o GitHub respondeu {}", r.status())); }
    let new_etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(String::from);
    let body = match r.bytes().await { Ok(b) => b.to_vec(), Err(e) => return offline(net_error("o GitHub", e)) };
    let _ = std::fs::create_dir_all(&dir);
    if std::fs::write(&zip_file, &body).is_ok() { match new_etag { Some(e) => { let _ = std::fs::write(&etag_file, e); } None => { let _ = std::fs::remove_file(&etag_file); } } }
    Ok((body, None))
}
/// O catálogo da loja. Vale por dez minutos (`fresh` pergunta de novo: com o ETag, custa um pedido sem corpo).
async fn snapshot(fresh: bool) -> Result<Arc<Snap>, String> {
    if !fresh && let Some((t, s)) = SNAP.lock().clone() && t.elapsed() < Duration::from_secs(600) { return Ok(s); }
    let local = std::env::var_os("BLUESCREEN_PLUGIN_REPO").filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
    let snap = match local {
        Some(dir) => { let pkgs = tokio::task::spawn_blocking(move || from_dir(&dir)).await.map_err(|e| e.to_string())??; Snap { pkgs, stale: None } }
        None => {
            let (bytes, stale) = download().await?;
            let pkgs = tokio::task::spawn_blocking(move || from_zip(&bytes)).await.map_err(|e| e.to_string())??;
            Snap { pkgs, stale }
        }
    };
    let snap = Arc::new(snap);
    *SNAP.lock() = Some((Instant::now(), snap.clone()));
    Ok(snap)
}
impl Pkg {
    fn file(&self, name: &str) -> Option<&[u8]> { self.files.iter().find(|f| f.0 == name).map(|f| f.1.as_slice()) }
    fn text(&self, name: &str) -> Option<String> { self.file(name).map(|d| String::from_utf8_lossy(d.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(d)).into_owned()) }
    /// o mesmo ícone da aba Plugins (store::icon_uri), lido do pacote
    fn icon(&self) -> Option<String> {
        let named = self.manifest["icon"].as_str().map(|s| s.trim().replace('\\', "/")).filter(|s| !s.is_empty());
        let pick = match named { Some(n) => n, None => ["icon.svg", "icon.png"].into_iter().find(|f| self.file(f).is_some())?.to_string() };
        let mime = match pick.rsplit('.').next()?.to_ascii_lowercase().as_str() { "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", _ => return None };
        let d = self.file(&pick).filter(|d| !d.is_empty() && d.len() <= 64 * 1024)?;
        Some(format!("data:{mime};base64,{}", B64.encode(d)))
    }
    /// os nós que o plugin acrescenta ao Automator (automator.json): nome, categoria e descrição
    fn nodes(&self) -> Vec<Value> {
        let v: Value = self.file("automator.json").and_then(|d| serde_json::from_slice(d.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(d)).ok()).unwrap_or(Value::Null);
        v["nodes"].as_array().into_iter().flatten().map(|n| json!({ "name": n["name"], "category": n["category"], "desc": n["desc"] })).collect()
    }
    /// o que o servidor do plugin precisa para rodar (o cartão avisa antes de instalar)
    fn runtime(&self) -> Option<&'static str> {
        let named = self.manifest["server"].as_str().map(str::to_string);
        let has = |ext: &str| named.as_deref().is_some_and(|n| n.ends_with(ext)) || self.files.iter().any(|f| f.0 == format!("server{ext}"));
        if has(".js") || has(".mjs") || has(".cjs") { Some("Node.js") } else if has(".py") { Some("Python") } else if has(".ps1") { Some("PowerShell") } else { None }
    }
    /// a versão mínima do BlueScreen que o plugin pede (`minBlueScreen`), quando esta IDE é mais velha que ela
    fn too_new(&self) -> Option<String> {
        let min = self.manifest["minBlueScreen"].as_str().map(str::trim).filter(|v| !v.is_empty())?;
        (version_cmp(env!("CARGO_PKG_VERSION"), min) == Ordering::Less).then(|| min.to_string())
    }
    fn entry(&self) -> Value {
        let m = &self.manifest;
        let words = |k: &str| m[k].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty())).take(20).collect::<Vec<_>>()).unwrap_or_default();
        json!({
            "id": self.id, "name": m["name"].as_str().unwrap_or(&self.id), "description": m["description"].as_str().unwrap_or(""),
            "version": m["version"].as_str().unwrap_or("0"), "author": m["author"].as_str().unwrap_or(""), "icon": self.icon(), "server": STORE,
            "requires": m["requires"], "nodes": self.nodes().len(), "readme": self.file("README.md").is_some(), "runtime": self.runtime(),
            "size": self.files.iter().map(|f| f.1.len()).sum::<usize>(), "files": self.files.len(),
            // padrão do repositório de plugins (ferramentas/plugins.mjs lá): licença, categoria, busca e compatibilidade
            "license": m["license"].as_str(), "category": m["category"].as_str(), "keywords": words("keywords"), "contributors": words("contributors"),
            "minBlueScreen": m["minBlueScreen"].as_str(), "incompatible": self.too_new().is_some(),
        })
    }
}

// ---------- quem fez cada plugin: o autor do primeiro commit da pasta e o da última edição ----------
// Vem da API do GitHub (commits?path=plugins/<id>), dois pedidos por plugin, e fica guardado em store-cache/authors.json
// junto com o ETag do zip: enquanto o repositório não muda, nada é pedido de novo. Sem rede (ou no limite de pedidos
// da API), vale o guardado; sem nada guardado, o cartão mostra o autor do plugin.json.
const STORE_API: &str = "https://api.github.com/repos/martindevbr/BlueScreen-Plugins/commits";
fn authors_file() -> std::path::PathBuf { user_dir().join("store-cache").join("authors.json") }
fn who(c: &Value) -> Value {
    json!({ "name": c["commit"]["author"]["name"], "login": c["author"]["login"], "avatar": c["author"]["avatar_url"], "date": c["commit"]["author"]["date"], "sha": c["sha"].as_str().map(|s| s.chars().take(7).collect::<String>()) })
}
/// último commit da pasta e o número da última página (com um commit por página, é o total de commits)
async fn commits_page(client: &reqwest::Client, id: &str, page: u64) -> Result<(Value, u64), String> {
    let r = client.get(format!("{STORE_API}?path=plugins/{}&per_page=1&page={page}", urlencoding::encode(id)))
        .header("Accept", "application/vnd.github+json").send().await.map_err(|e| net_error("o GitHub", e))?;
    if !r.status().is_success() { return Err(format!("o GitHub respondeu {}", r.status())); }
    let last = r.headers().get("link").and_then(|v| v.to_str().ok()).and_then(|l| l.split(',').find(|p| p.contains("rel=\"last\"")).and_then(|p| p.split("page=").last().and_then(|n| n.split(['>', '&']).next().and_then(|n| n.parse().ok())))).unwrap_or(page);
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    Ok((v.as_array().and_then(|a| a.first().cloned()).unwrap_or(Value::Null), last))
}
async fn author_of(client: reqwest::Client, id: String) -> Option<(String, Value)> {
    let (last, pages) = commits_page(&client, &id, 1).await.ok()?;
    if last.is_null() { return None; }
    let first = if pages > 1 { commits_page(&client, &id, pages).await.ok()?.0 } else { last.clone() };
    Some((id, json!({ "first": who(&first), "last": who(&last), "commits": pages })))
}
/// numa pasta local (BLUESCREEN_PLUGIN_REPO), o mesmo pelo git dela
fn authors_local(root: &Path, ids: &[String]) -> HashMap<String, Value> {
    let log = |args: &[&str]| -> Vec<String> {
        let mut c = std::process::Command::new("git"); c.arg("-C").arg(root).arg("log").args(args);
        #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
        c.output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect()).unwrap_or_default()
    };
    let one = |l: &str| { let p: Vec<&str> = l.splitn(3, '\t').collect(); json!({ "name": p.first(), "date": p.get(1), "sha": p.get(2) }) };
    ids.iter().filter_map(|id| {
        let lines = log(&["--format=%an%x09%aI%x09%h", "--", &format!("plugins/{id}")]);
        let (last, first) = (lines.first()?, lines.last()?);
        Some((id.clone(), json!({ "first": one(first), "last": one(last), "commits": lines.len() })))
    }).collect()
}
async fn authors(pkgs: &[Pkg]) -> HashMap<String, Value> {
    let ids: Vec<String> = pkgs.iter().map(|p| p.id.clone()).collect();
    if let Some(dir) = std::env::var_os("BLUESCREEN_PLUGIN_REPO").filter(|p| !p.is_empty()).map(std::path::PathBuf::from) {
        return tokio::task::spawn_blocking(move || authors_local(&dir, &ids)).await.unwrap_or_default();
    }
    let etag = std::fs::read_to_string(user_dir().join("store-cache").join("etag")).unwrap_or_default().trim().to_string();
    let saved: Value = read_json(&authors_file());
    let mut have: HashMap<String, Value> = saved["plugins"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    // o repositório não mudou desde a última consulta: só falta buscar os plugins que ainda não têm autor guardado
    let same = !etag.is_empty() && saved["etag"].as_str() == Some(etag.as_str());
    let want: Vec<String> = ids.iter().filter(|id| !same || !have.contains_key(*id)).cloned().collect();
    if want.is_empty() { return have; }
    let Ok(client) = http(10) else { return have };
    let got = tokio::time::timeout(Duration::from_secs(12), futures_util::future::join_all(want.iter().map(|id| author_of(client.clone(), id.clone())))).await.unwrap_or_default();
    let all = got.len() == want.len() && got.iter().all(Option::is_some);
    for (id, v) in got.into_iter().flatten() { have.insert(id, v); }
    have.retain(|id, _| ids.contains(id));
    // só marca o ETag como consultado quando todos responderam: o que faltou é pedido de novo na próxima vez
    let _ = std::fs::create_dir_all(user_dir().join("store-cache"));
    let _ = std::fs::write(authors_file(), serde_json::to_string(&json!({ "etag": if all { etag } else { String::new() }, "plugins": have })).unwrap_or_default());
    have
}

/// espaço que uma pasta ocupa no disco: cada arquivo arredondado para o bloco de 4 KB do NTFS
pub fn disk_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() { stack.push(e.path()); } else if let Ok(m) = e.metadata() { total += m.len().div_ceil(4096) * 4096; }
        }
    }
    total
}

/// A loja e os servidores de equipe, comparados com os instalados. O mesmo id em dois lugares: vale a maior versão.
async fn check(fresh: bool) -> Value {
    let list = servers();
    let (snap, results) = tokio::join!(snapshot(fresh), futures_util::future::join_all(list.iter().map(|s| index(s.url.clone()))));
    let installed: HashMap<String, (String, Value, bool, String)> = host().get().list.iter().map(|p| (p.id.clone(), (p.version.clone(), p.origin.clone(), p.user, p.path.clone()))).collect();
    let made = match &snap { Ok(s) => authors(&s.pkgs).await, Err(_) => HashMap::new() };
    let mut best: HashMap<String, Value> = HashMap::new();
    let store = match &snap {
        Ok(s) => { for p in &s.pkgs { let mut e = p.entry(); if let Some(a) = made.get(&p.id) { e["made"] = a.clone(); } best.insert(p.id.clone(), e); } json!({ "ok": true, "url": STORE_WEB, "count": s.pkgs.len(), "stale": s.stale, "local": std::env::var_os("BLUESCREEN_PLUGIN_REPO").is_some() }) }
        Err(e) => json!({ "ok": false, "url": STORE_WEB, "error": e }),
    };
    let mut out_servers = vec![];
    for (s, r) in list.iter().zip(results) {
        match r {
            Ok(v) => {
                let plugins = v["plugins"].as_array().cloned().unwrap_or_default();
                out_servers.push(json!({ "url": s.url, "ok": true, "name": v["name"], "count": plugins.len() }));
                for mut p in plugins {
                    let Some(id) = p["id"].as_str().map(String::from).filter(|i| valid_id(i)) else { continue };
                    p["server"] = json!(s.url);
                    let newer = best.get(&id).is_none_or(|b| version_cmp(p["version"].as_str().unwrap_or(""), b["version"].as_str().unwrap_or("")) == Ordering::Greater);
                    if newer { best.insert(id, p); }
                }
            }
            Err(e) => out_servers.push(json!({ "url": s.url, "ok": false, "error": e })),
        }
    }
    let mut plugins: Vec<Value> = best.into_iter().map(|(id, mut p)| {
        let remote = p["version"].as_str().unwrap_or("").to_string();
        match installed.get(&id) {
            Some((v, origin, user, path)) => {
                // o espaço que o plugin instalado ocupa: medido na instalação (.origin.json) ou agora, na pasta
                p["disk"] = json!(origin["disk"].as_u64().unwrap_or_else(|| disk_size(Path::new(path))));
                p["installed"] = json!(v);
                // versão nova que pede um BlueScreen mais novo não vira aviso: o cartão explica o que falta
                p["update"] = json!(version_cmp(&remote, v) == Ordering::Greater && p["incompatible"] != json!(true));
                p["origin"] = origin.clone();
                p["user"] = json!(user);
            }
            None => { p["installed"] = Value::Null; p["update"] = json!(false); }
        }
        p
    }).collect();
    plugins.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    let updates = plugins.iter().filter(|p| p["update"] == json!(true)).count();
    json!({ "store": store, "servers": out_servers, "plugins": plugins, "updates": updates, "checked": now_ms() })
}

/// instala da loja: os arquivos já estão no catálogo baixado (se o plugin não está nele, pergunta de novo ao GitHub)
async fn install_store(id: &str) -> Result<Value, String> {
    let mut snap = snapshot(false).await?;
    if !snap.pkgs.iter().any(|p| p.id == id) { snap = snapshot(true).await?; }
    let p = snap.pkgs.iter().find(|p| p.id == id).ok_or(format!("a loja não tem o plugin {id}"))?;
    if let Some(min) = p.too_new() { return Err(format!("este plugin precisa do BlueScreen {min} ou mais novo (você tem a {}); atualize o BlueScreen primeiro", env!("CARGO_PKG_VERSION"))); }
    let files = p.files.clone();
    let version = p.manifest["version"].as_str().unwrap_or("").to_string();
    let origin = json!({ "server": STORE, "version": version, "sha256": bundle_hash(&files), "installed": now_ms() });
    let id2 = id.to_string();
    tokio::task::spawn_blocking(move || place(&id2, &files, &origin)).await.map_err(|e| e.to_string())??;
    *LAST.lock() = None;
    log(format!("plugin {id} {version} instalado da loja"));
    Ok(json!({ "id": id, "version": version, "disk": disk_size(&user_dir().join("plugins").join(id)) }))
}

fn stamp() -> String { format!("{}-{}", now_ms() as u64, std::process::id()) }
/// Troca a pasta do plugin na pasta do usuário: o plugin sai do registro (processo encerrado), a pasta antiga
/// vai para plugin-staging e a nova entra no lugar. Sem dar para trocar, volta tudo como estava.
fn place(id: &str, files: &[(String, Vec<u8>)], origin: &Value) -> Result<(), String> {
    let staging = user_dir().join("plugin-staging");
    let tmp = staging.join(format!("{id}-{}", stamp()));
    let write = || -> std::io::Result<()> {
        for (p, d) in files { let to = tmp.join(p); if let Some(par) = to.parent() { std::fs::create_dir_all(par)?; } std::fs::write(to, d)?; }
        std::fs::write(tmp.join(".origin.json"), serde_json::to_string_pretty(origin).unwrap_or_default())
    };
    if let Err(e) = write() { let _ = std::fs::remove_dir_all(&tmp); return Err(format!("não deu para gravar o plugin: {e}")); }
    let dest = user_dir().join("plugins").join(id);
    host().unload(id);
    let old = staging.join(format!("{id}-old-{}", stamp()));
    if dest.exists() {
        // o server.exe pode levar um instante para soltar o arquivo depois de encerrado
        let mut moved = Err(std::io::Error::other("?"));
        for _ in 0..30 { moved = std::fs::rename(&dest, &old); if moved.is_ok() { break; } std::thread::sleep(Duration::from_millis(100)); }
        if let Err(e) = moved { let _ = std::fs::remove_dir_all(&tmp); host().load(); return Err(format!("a pasta do plugin está em uso ({e}); feche o que estiver usando {}", dest.display())); }
    }
    let _ = std::fs::create_dir_all(user_dir().join("plugins"));
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        if old.exists() { let _ = std::fs::rename(&old, &dest); }
        let _ = std::fs::remove_dir_all(&tmp); host().load();
        return Err(format!("não deu para instalar em {}: {e}", dest.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    let _ = std::fs::remove_dir(&staging); // só sai se ficou vazia
    // instalado: mede o espaço que ficou ocupado no disco e anota na origem (a loja mostra no cartão)
    let mut o = origin.clone(); o["disk"] = json!(disk_size(&dest));
    let _ = std::fs::write(dest.join(".origin.json"), serde_json::to_string_pretty(&o).unwrap_or_default());
    host().load(); host().print();
    Ok(())
}

/// maior pacote aceito (o JSON com os arquivos em base64)
const MAX_PACKAGE: usize = 256 << 20;
async fn install(server: &str, id: &str, version: Option<&str>) -> Result<Value, String> {
    if !valid_id(id) { return Err(format!("id inválido: {id}")); }
    if server.is_empty() || server == STORE { return install_store(id).await; }
    let server = norm_url(server)?;
    // só dos servidores que o usuário cadastrou (Plugins › Servidores), nunca de um endereço vindo no pedido
    if !servers().iter().any(|s| norm_url(&s.url).is_ok_and(|u| u.eq_ignore_ascii_case(&server))) { return Err(format!("{server} não está na lista de servidores de plugins")); }
    let mut url = format!("{server}/api/plugins/{id}");
    if let Some(v) = version { url.push_str(&format!("?version={}", urlencoding::encode(v))); }
    let mut r = http(600)?.get(&url).send().await.map_err(|e| net_error(&server, e))?;
    if !r.status().is_success() { return Err(server_error(r).await); }
    let too_big = || format!("o pacote passa de {} MB", MAX_PACKAGE >> 20);
    if r.content_length().is_some_and(|n| n > MAX_PACKAGE as u64) { return Err(too_big()); }
    let mut body: Vec<u8> = vec![];
    while let Some(c) = r.chunk().await.map_err(|e| net_error(&server, e))? {
        if body.len() + c.len() > MAX_PACKAGE { return Err(too_big()); }
        body.extend_from_slice(&c);
    }
    let b: Value = serde_json::from_slice(&body).map_err(|e| format!("pacote inválido: {e}"))?;
    let mut files: Vec<(String, Vec<u8>)> = vec![];
    for f in b["files"].as_array().into_iter().flatten() {
        let p = f["path"].as_str().unwrap_or("");
        if !safe_rel(p) || p == ".origin.json" { return Err(format!("o pacote tem um caminho inválido: {p}")); }
        files.push((p.to_string(), B64.decode(f["data"].as_str().unwrap_or("")).map_err(|e| format!("{p}: {e}"))?));
    }
    let sha = bundle_hash(&files);
    if b["sha256"].as_str() != Some(sha.as_str()) { return Err("o pacote chegou corrompido (sha256 não confere)".into()); }
    let m: Value = files.iter().find(|f| f.0 == "plugin.json").and_then(|f| serde_json::from_slice(f.1.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&f.1)).ok())
        .ok_or("o pacote não tem um plugin.json válido")?;
    if m["id"].as_str().map(str::trim) != Some(id) { return Err(format!("o pacote é de outro plugin ({})", m["id"])); }
    let version = m["version"].as_str().unwrap_or("").to_string();
    let origin = json!({ "server": server, "version": version, "sha256": sha, "installed": now_ms() });
    let id2 = id.to_string();
    tokio::task::spawn_blocking(move || place(&id2, &files, &origin)).await.map_err(|e| e.to_string())??;
    *LAST.lock() = None;
    log(format!("plugin {id} {version} instalado de {server}"));
    Ok(json!({ "id": id, "version": version, "disk": disk_size(&user_dir().join("plugins").join(id)) }))
}

/// Remove da pasta do usuário um plugin instalado (o do app, se houver, volta a valer).
/// Remove um plugin da pasta do usuário mandando a pasta para a Lixeira (dá para restaurar). Com `data`, a pasta de
/// dados (~/.bluescreen/plugin-data/<id>: atributos, tokens, configurações, arquivos) vai junto.
fn uninstall(id: &str, data: bool) -> Result<(), String> {
    let p = host().get().list.iter().find(|p| p.id == id).cloned().ok_or(format!("plugin desconhecido: {id}"))?;
    if !p.user { return Err("este plugin vem com o BlueScreen; dá para desligar, não para remover".into()); }
    host().unload(id);
    // o servidor do plugin pode levar um instante para soltar os arquivos depois de encerrado
    let mut res = Err(String::from("?"));
    for _ in 0..30 { res = crate::server::to_trash(&[Path::new(&p.path).to_path_buf()]); if res.is_ok() { break; } std::thread::sleep(Duration::from_millis(100)); }
    let dir = super::data::dir(id);
    let data_res = if data && res.is_ok() && dir.exists() { crate::server::to_trash(&[dir]) } else { Ok(()) };
    host().load();
    *LAST.lock() = None;
    res.map_err(|e| format!("não deu para remover {}: {e}", p.path))?;
    data_res.map_err(|e| format!("o plugin foi para a Lixeira, mas os dados não: {e}"))
}

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![
        // GET: servidores; POST { servers: [{ url }] }: troca a lista
        ("plugins/servers", route_fn(|r| async move {
            r.local_only()?;
            if r.is_post() {
                let b: Value = r.body_json()?;
                        let mut out: Vec<Value> = vec![];
                for s in b["servers"].as_array().into_iter().flatten() {
                    let url = norm_url(s["url"].as_str().unwrap_or("")).map_err(|e| fail(e, 400))?;
                    if out.iter().any(|o| o["url"] == json!(url)) { continue; }
                    out.push(json!({ "url": url }));
                }
                super::save_config(|c| { c.insert("servers".into(), json!(out)); });
                *LAST.lock() = None;
            }
            ok(json!({ "servers": servers().iter().map(|s| json!({ "url": s.url })).collect::<Vec<_>>() }))
        })),
        // plugins dos servidores comparados com os instalados (fresh=1 ignora o último minuto)
        ("plugins/remote", route_fn(|r| async move {
            r.local_only()?;
            if !r.flag("fresh") { if let Some((t, v)) = LAST.lock().clone() { if t.elapsed() < Duration::from_secs(60) { return ok(v); } } }
            let v = check(r.flag("fresh")).await;
            *LAST.lock() = Some((Instant::now(), v.clone()));
            ok(v)
        })),
        // a página de um plugin na loja: o README, os nós do Automator e os arquivos. Sem o plugin na loja (os que vêm
        // com o BlueScreen, os seus), o README da pasta instalada
        ("plugins/about", route_fn(|r| async move {
            r.local_only()?;
            let id = r.q_or("id", "").to_string();
            if !valid_id(&id) { return Err(fail("id inválido", 400)); }
            if let Ok(s) = snapshot(false).await && let Some(p) = s.pkgs.iter().find(|p| p.id == id) {
                return ok(json!({ "id": id, "readme": p.text("README.md"), "nodes": p.nodes(), "files": p.files.iter().map(|f| json!({ "path": f.0, "size": f.1.len() })).collect::<Vec<_>>(), "web": format!("{STORE_WEB}/tree/main/plugins/{id}") }));
            }
            let local = host().get().list.iter().find(|p| p.id == id).map(|p| p.path.clone()).ok_or_else(|| fail("plugin desconhecido", 404))?;
            let dir = std::path::PathBuf::from(local);
            let nodes: Value = read_json(&dir.join("automator.json"));
            ok(json!({ "id": id, "readme": std::fs::read_to_string(dir.join("README.md")).ok(),
                "nodes": nodes["nodes"].as_array().into_iter().flatten().map(|n| json!({ "name": n["name"], "category": n["category"], "desc": n["desc"] })).collect::<Vec<_>>(), "files": [] }))
        })),
        // POST { server, id, version? }: baixa, confere e instala (ou atualiza) na pasta do usuário
        ("plugins/install", route_fn(|r| async move {
            r.local_only()?;
            if !r.is_post() { return Err(fail("POST", 405)); }
            let b: Value = r.body_json()?;
            let (server, id) = (b["server"].as_str().unwrap_or(""), b["id"].as_str().unwrap_or(""));
            install(server, id, b["version"].as_str().filter(|v| !v.is_empty())).await.map_err(|e| fail(e, 502)).and_then(ok)
        })),
        // POST { id }: desinstala um plugin da pasta do usuário
        ("plugins/uninstall", route_fn(|r| async move {
            r.local_only()?;
            let b: Value = r.body_json()?;
            let id = b["id"].as_str().unwrap_or("").to_string();
            let data = b["data"].as_bool().unwrap_or(false);
            tokio::task::spawn_blocking(move || uninstall(&id, data)).await.map_err(|e| fail(e.to_string(), 500))?.map_err(|e| fail(e, 400))?;
            ok(json!({ "removed": true }))
        })),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls() {
        assert_eq!(norm_url("meu-pc:4900/").unwrap(), "http://meu-pc:4900");
        assert_eq!(norm_url(" https://x.com ").unwrap(), "https://x.com");
        assert!(norm_url("ftp://x").is_err() && norm_url("a b").is_err());
    }
    #[test]
    fn pacotes_do_repositorio() {
        let f = |p: &str, d: &str| (p.to_string(), d.as_bytes().to_vec());
        let pk = group(vec![
            f("README.md", "raiz"), f("plugins/ola/plugin.json", r#"{"id":"ola","name":"Olá","version":"1.2.0","server":"server.mjs"}"#), f("plugins/ola/ui.js", "x"), f("plugins/ola/icon.svg", "<svg/>"),
            f("plugins/ola/automator.json", r#"{"nodes":[{"type":"a","name":"A","category":"Texto","desc":"d"}]}"#), f("plugins/ola/.origin.json", "{}"), f("plugins/ola/../fora.txt", "x"),
            f("plugins/outro/plugin.json", r#"{"id":"nao-bate"}"#), f("plugins/sem-manifesto/ui.js", "x"),
        ]);
        assert_eq!(pk.len(), 1);
        let p = &pk[0];
        assert_eq!(p.files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), vec!["automator.json", "icon.svg", "plugin.json", "ui.js"]);
        let e = p.entry();
        assert_eq!((e["name"].as_str(), e["version"].as_str(), e["nodes"].as_u64(), e["runtime"].as_str()), (Some("Olá"), Some("1.2.0"), Some(1), Some("Node.js")));
        assert!(e["icon"].as_str().unwrap().starts_with("data:image/svg+xml;base64,"));
        assert_eq!((e["license"].as_str(), e["category"].as_str(), e["incompatible"].as_bool()), (None, None, Some(false)));
    }
    #[test]
    fn padrao_do_repositorio() {
        let f = |p: &str, d: &str| (p.to_string(), d.as_bytes().to_vec());
        let pk = group(vec![
            f("plugins/novo/plugin.json", r#"{"id":"novo","version":"1.0.0","license":"MIT","category":"midia","keywords":["música"," ",3],"contributors":["Ana"],"minBlueScreen":"999.0.0"}"#),
            f("plugins/velho/plugin.json", r#"{"id":"velho","version":"1.0.0","minBlueScreen":"1.0.0"}"#),
        ]);
        let (novo, velho) = (pk[0].entry(), pk[1].entry());
        assert_eq!((novo["license"].as_str(), novo["category"].as_str()), (Some("MIT"), Some("midia")));
        assert_eq!(novo["keywords"], json!(["música"]));
        assert_eq!(novo["contributors"], json!(["Ana"]));
        assert_eq!((novo["incompatible"].as_bool(), velho["incompatible"].as_bool()), (Some(true), Some(false)));
        assert_eq!(pk[0].too_new().as_deref(), Some("999.0.0"));
    }
}
