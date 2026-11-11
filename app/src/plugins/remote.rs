//! Servidores de plugins (app/plugin-server): a IDE aponta para um ou mais servidores, lista o que eles têm,
//! instala e atualiza plugins na pasta do usuário. O servidor é só de leitura: nada é publicado pela IDE.
//! Os servidores ficam em ~/.bluescreen/plugins.json (`servers: [{ url }]`). Plugin instalado de um servidor
//! leva um `.origin.json` na pasta ({ server, version, sha256, installed }); a interface pergunta de tempos em
//! tempos (`plugins/remote`) e mostra o aviso de atualização enquanto houver versão maior em algum servidor.
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
use std::sync::LazyLock;
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

/// Plugins de todos os servidores, comparados com os instalados. O mesmo id em dois servidores: vale a maior versão.
async fn check() -> Value {
    let list = servers();
    let results = futures_util::future::join_all(list.iter().map(|s| index(s.url.clone()))).await;
    let installed: HashMap<String, (String, Value, bool)> = host().get().list.iter().map(|p| (p.id.clone(), (p.version.clone(), p.origin.clone(), p.user))).collect();
    let mut best: HashMap<String, Value> = HashMap::new();
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
            Some((v, origin, user)) => {
                p["installed"] = json!(v);
                p["update"] = json!(version_cmp(&remote, v) == Ordering::Greater);
                p["origin"] = origin.clone();
                p["user"] = json!(user);
            }
            None => { p["installed"] = Value::Null; p["update"] = json!(false); }
        }
        p
    }).collect();
    plugins.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    let updates = plugins.iter().filter(|p| p["update"] == json!(true)).count();
    json!({ "servers": out_servers, "plugins": plugins, "updates": updates, "checked": now_ms() })
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
    host().load(); host().print();
    Ok(())
}

/// maior pacote aceito (o JSON com os arquivos em base64)
const MAX_PACKAGE: usize = 256 << 20;
async fn install(server: &str, id: &str, version: Option<&str>) -> Result<Value, String> {
    if !valid_id(id) { return Err(format!("id inválido: {id}")); }
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
    Ok(json!({ "id": id, "version": version }))
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
            let v = check().await;
            *LAST.lock() = Some((Instant::now(), v.clone()));
            ok(v)
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
}
