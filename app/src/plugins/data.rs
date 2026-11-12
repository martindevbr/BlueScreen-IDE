//! Pasta de dados de cada plugin: `~/.bluescreen/plugin-data/<id>/`. Fica fora da pasta do plugin, então
//! atualizar, reinstalar ou desinstalar o plugin não apaga o que ele guardou.
//!   store.json     atributos (chave -> qualquer JSON): `plugin.data` no ui.js, rota `plugin/data`
//!   secrets.json   tokens e senhas, cifrados com o DPAPI do Windows (só o usuário deste PC decifra):
//!                  `plugin.secrets`, rota `plugin/secrets`, que nunca responde pela rede local
//!   settings.json  valores das configurações que o plugin declara no plugin.json (`settings`); os campos do tipo
//!                  `secret` vão para o secrets.json
//!   files/         arquivos livres do plugin: `plugin.files`, rota `plugin/files`
//! Os servidores dos plugins recebem a pasta em `BLUESCREEN_PLUGIN_DATA` e podem usar as mesmas rotas pelo token.
use super::{Reply, RouteFn, ok, route_fn};
use crate::server::host;
use crate::util::*;
use axum::http::{HeaderValue, header};
use axum::response::IntoResponse;
use bluescreen_sdk::plugin::Req;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// leituras e escritas dos JSON da pasta de dados passam uma por vez (ler, mudar e gravar sem perder nada)
static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

pub fn root() -> PathBuf { user_dir().join("plugin-data") }
pub fn dir(id: &str) -> PathBuf { root().join(id) }
pub fn files_dir(id: &str) -> PathBuf { dir(id).join("files") }

/// id do plugin da query (`?plugin=`), validado: vira nome de pasta
pub fn plugin_of(r: &Req) -> ApiResult<String> {
    let id = r.require("plugin")?;
    if !bluescreen_sdk::store::valid_id(id) { return Err(fail(format!("id de plugin inválido: {id}"), 400)); }
    Ok(id.to_string())
}

fn read_obj(p: &Path) -> Map<String, Value> { match read_json(p) { Value::Object(o) => o, _ => Map::new() } }
fn write_obj(p: &Path, o: &Map<String, Value>) -> ApiResult<()> {
    if let Some(d) = p.parent() { std::fs::create_dir_all(d)?; }
    Ok(write_atomic(p, &serde_json::to_string_pretty(o).unwrap_or_default())?)
}
/// lê, muda e grava um dos JSON da pasta de dados
fn edit<T>(p: &Path, f: impl FnOnce(&mut Map<String, Value>) -> T) -> ApiResult<T> {
    let _g = LOCK.lock();
    // arquivo ilegível não é "vazio": gravar por cima apagaria o que o plugin guardou
    let mut o = match read_json_strict(p).map_err(|e| fail(e.to_string(), 500))? {
        Value::Object(o) => o,
        Value::Null => Map::new(),
        _ => return Err(fail(format!("{} não é um objeto JSON; conserte ou apague o arquivo", p.display()), 500)),
    };
    let out = f(&mut o);
    write_obj(p, &o)?;
    Ok(out)
}
fn read(p: &Path) -> Map<String, Value> { let _g = LOCK.lock(); read_obj(p) }

// ---------- segredos (DPAPI) ----------
#[cfg(windows)]
pub(crate) mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData};
    fn blob(d: &[u8]) -> CRYPT_INTEGER_BLOB { CRYPT_INTEGER_BLOB { cbData: d.len() as u32, pbData: d.as_ptr() as *mut u8 } }
    /// `entropy` (o id do plugin) amarra o segredo ao plugin: copiado para outro, não decifra
    pub fn protect(data: &[u8], entropy: &[u8], on: bool) -> Option<Vec<u8>> {
        let (inp, ent) = (blob(data), blob(entropy));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: os blobs de entrada apontam para fatias vivas; a saída é alocada pelo Windows e liberada com LocalFree
        let done = unsafe {
            if on { CryptProtectData(&inp, std::ptr::null(), &ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
            else { CryptUnprotectData(&inp, std::ptr::null_mut(), &ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        };
        if done == 0 || out.pbData.is_null() { return None; }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _); }
        Some(v)
    }
}
#[cfg(not(windows))]
pub(crate) mod dpapi {
    // fora do Windows não há DPAPI: o arquivo fica só com permissão do usuário (base64, sem cifra)
    pub fn protect(data: &[u8], _: &[u8], _: bool) -> Option<Vec<u8>> { Some(data.to_vec()) }
}
fn seal(id: &str, plain: &str) -> ApiResult<String> {
    use base64::Engine;
    let c = dpapi::protect(plain.as_bytes(), id.as_bytes(), true).ok_or_else(|| fail("não deu para cifrar o segredo", 500))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(c))
}
fn unseal(id: &str, sealed: &str) -> Option<String> {
    use base64::Engine;
    let c = base64::engine::general_purpose::STANDARD.decode(sealed).ok()?;
    String::from_utf8(dpapi::protect(&c, id.as_bytes(), false)?).ok()
}
/// Segredo de um plugin, decifrado (para o `plugin/fetch` trocar `{{secret:nome}}` sem o valor passar pela página).
pub fn secret(id: &str, key: &str) -> Option<String> { read(&dir(id).join("secrets.json")).get(key).and_then(|v| v.as_str()).and_then(|s| unseal(id, s)) }
pub fn set_secret(id: &str, key: &str, value: Option<&str>) -> ApiResult<()> {
    let sealed = value.map(|v| seal(id, v)).transpose()?;
    edit(&dir(id).join("secrets.json"), |o| match sealed { Some(s) => { o.insert(key.into(), json!(s)); } None => { o.remove(key); } })
}
fn secret_keys(id: &str) -> Vec<String> { read(&dir(id).join("secrets.json")).keys().cloned().collect() }

// ---------- configurações declaradas no plugin.json ----------
/// `settings` do plugin.json: [{ key, label, type, default, options, placeholder, help }]
fn schema(id: &str) -> Vec<Value> {
    host().get().list.iter().find(|p| p.id == id).and_then(|p| p.settings.as_array().cloned()).unwrap_or_default()
}
fn is_secret(f: &Value) -> bool { matches!(f["type"].as_str(), Some("secret" | "password")) }
/// valores das configurações: o padrão do plugin.json por baixo do que o usuário salvou. Segredos não vêm (só `secretSet`).
pub fn settings(id: &str) -> Value {
    let saved = read(&dir(id).join("settings.json"));
    let secrets = secret_keys(id);
    let (mut values, mut set) = (Map::new(), Map::new());
    for f in schema(id) {
        let Some(k) = f["key"].as_str() else { continue };
        if is_secret(&f) { set.insert(k.into(), json!(secrets.iter().any(|s| s == k))); continue; }
        values.insert(k.into(), saved.get(k).cloned().unwrap_or_else(|| f["default"].clone()));
    }
    json!({ "schema": schema(id), "values": values, "secretSet": set })
}

// ---------- arquivos ----------
/// caminho dentro de files/ (relativo, com `/`); vazio é a própria pasta
fn file_path(id: &str, rel: &str) -> ApiResult<PathBuf> {
    let rel = rel.replace('\\', "/").trim_matches('/').to_string();
    let base = files_dir(id);
    if rel.is_empty() { return Ok(base); }
    if !bluescreen_sdk::store::safe_rel(&rel) { return Err(fail(format!("caminho inválido: {rel}"), 400)); }
    Ok(base.join(rel))
}
fn modified(m: &std::fs::Metadata) -> u64 { m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0) }

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![
        // GET ?plugin=&key= -> { value } | sem key -> { values }; POST { key, value } | { values: {..} } (junta; null apaga) | { clear: true }
        ("plugin/data", route_fn(|r| async move {
            let id = plugin_of(&r)?;
            let file = dir(&id).join("store.json");
            if r.is_post() {
                let b: Value = r.body_json()?;
                edit(&file, |o| {
                    if b["clear"].as_bool() == Some(true) { o.clear(); }
                    let mut put = |k: &str, v: &Value| { if v.is_null() { o.remove(k); } else { o.insert(k.into(), v.clone()); } };
                    if let Some(k) = b["key"].as_str() { put(k, &b["value"]); }
                    if let Some(m) = b["values"].as_object() { for (k, v) in m { put(k, v); } }
                })?;
                return ok(json!({ "ok": true }));
            }
            let o = read(&file);
            match r.q("key") { Some(k) => ok(json!({ "value": o.get(k).cloned().unwrap_or(Value::Null) })), None => ok(json!({ "values": o })) }
        })),
        // segredos: só pelo PC local. GET ?key= -> { value } | sem key -> { keys }; POST { key, value } (null apaga)
        ("plugin/secrets", route_fn(|r| async move {
            r.local_only()?;
            let id = plugin_of(&r)?;
            if r.is_post() {
                let b: Value = r.body_json()?;
                let k = b["key"].as_str().filter(|k| !k.is_empty()).ok_or_else(|| fail("key obrigatório", 400))?;
                set_secret(&id, k, b["value"].as_str())?;
                return ok(json!({ "ok": true }));
            }
            match r.q("key") { Some(k) => ok(json!({ "value": secret(&id, k) })), None => ok(json!({ "keys": secret_keys(&id) })) }
        })),
        // GET -> { schema, values, secretSet }; POST { values } (campo secreto: texto grava, null apaga, ausente fica)
        ("plugin/settings", route_fn(|r| async move {
            let id = plugin_of(&r)?;
            if r.is_post() {
                r.local_only()?;
                let b: Value = r.body_json()?;
                let fields = schema(&id);
                let vals = b["values"].as_object().cloned().unwrap_or_default();
                let mut plain = Map::new();
                for f in &fields {
                    let Some(k) = f["key"].as_str() else { continue };
                    let Some(v) = vals.get(k) else { continue };
                    if is_secret(f) { if v.is_null() { set_secret(&id, k, None)?; } else if let Some(s) = v.as_str().filter(|s| !s.is_empty()) { set_secret(&id, k, Some(s))?; } }
                    else { plain.insert(k.into(), v.clone()); }
                }
                edit(&dir(&id).join("settings.json"), |o| for (k, v) in plain { if v.is_null() { o.remove(&k); } else { o.insert(k, v); } })?;
            }
            ok(settings(&id))
        })),
        // arquivos em files/: GET ?path= (o arquivo) | ?path=&list=1 -> { entries }; POST ?path= (corpo = conteúdo) | ?path=&delete=1
        ("plugin/files", route_fn(|r| async move {
            let id = plugin_of(&r)?;
            let p = file_path(&id, r.q_or("path", ""))?;
            if r.is_post() {
                if r.flag("delete") {
                    if p == files_dir(&id) { return Err(fail("caminho obrigatório", 400)); }
                    if p.is_dir() { tokio::fs::remove_dir_all(&p).await?; } else if p.exists() { tokio::fs::remove_file(&p).await?; }
                    return ok(json!({ "ok": true }));
                }
                if p == files_dir(&id) { return Err(fail("caminho obrigatório", 400)); }
                if let Some(d) = p.parent() { tokio::fs::create_dir_all(d).await?; }
                tokio::fs::write(&p, &r.body).await?;
                return ok(json!({ "ok": true, "size": r.body.len() }));
            }
            if r.flag("list") {
                let mut entries = vec![];
                if let Ok(mut rd) = tokio::fs::read_dir(&p).await {
                    while let Ok(Some(e)) = rd.next_entry().await {
                        let Ok(m) = e.metadata().await else { continue };
                        entries.push(json!({ "name": e.file_name().to_string_lossy(), "dir": m.is_dir(), "size": m.len(), "modified": modified(&m) }));
                    }
                }
                entries.sort_by(|a, b| b["dir"].as_bool().cmp(&a["dir"].as_bool()).then(a["name"].as_str().cmp(&b["name"].as_str())));
                return ok(json!({ "entries": entries }));
            }
            let bytes = tokio::fs::read(&p).await.map_err(|e| fail(format!("{}: {e}", r.q_or("path", "")), 404))?;
            let mut resp = ([(header::CACHE_CONTROL, "no-store")], bytes).into_response();
            resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime_of(&p)));
            Ok(Reply::Raw(resp))
        })),
        // onde ficam os dados; POST { wipe: true } apaga a pasta de dados inteira (atributos, segredos, configurações e arquivos)
        ("plugin/info", route_fn(|r| async move {
            let id = plugin_of(&r)?;
            if r.is_post() {
                r.local_only()?;
                let b: Value = r.body_json()?;
                if b["wipe"].as_bool() == Some(true) {
                    let _g = LOCK.lock();
                    let d = dir(&id);
                    if d.exists() { std::fs::remove_dir_all(&d)?; }
                    log(format!("plugin {id}: dados apagados"));
                }
            }
            let d = dir(&id);
            ok(json!({ "id": id, "dataDir": d, "filesDir": files_dir(&id), "exists": d.exists() }))
        })),
    ]
}

fn mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("json") => "application/json; charset=utf-8",
        Some("txt" | "md" | "log" | "csv") => "text/plain; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}
