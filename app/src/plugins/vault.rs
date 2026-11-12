//! Cofre: tokens da IDE (GitHub, OpenAI, Jira...) que você guarda uma vez e libera para os plugins que quiser.
//! Fica em ~/.bluescreen/vault.json, com cada valor cifrado pelo DPAPI do Windows.
//!
//! Todo ui.js roda na mesma página, então um plugin pode se passar por outro numa chamada à API e ler o que se digita
//! num campo da página. Por isso o cofre não confia na página:
//!   - o valor é digitado numa janela nativa do Windows aberta pelo núcleo (vault_input.rs), com os campos que o plugin
//!     pediu (token, usuário e senha...), ou vem da área de transferência, lida aqui: nunca passa por um campo da página;
//!   - tudo o que amplia o acesso (gravar um valor, liberar um plugin, acrescentar sites ou programas) só vale depois
//!     do "Sim" numa caixa de diálogo nativa do Windows, que o JavaScript da página não clica;
//!   - o plugin usa o segredo sem vê-lo: `{{vault:nome}}` no `plugin/fetch` (só para os sites liberados, em HTTPS)
//!     ou nas variáveis de ambiente do `plugin/exec`/`plugin/proc` (só para os programas liberados); o valor é
//!     tirado das respostas e da saída antes de voltar para a página;
//!   - ler o valor cru (`vault/reveal`) só para um servidor de plugin, identificado pelo token que ele recebeu ao ser
//!     iniciado (BLUESCREEN_PLUGIN_TOKEN), e só se você marcou "pode ver o valor" para ele;
//!   - cada uso (e cada recusa) entra no registro do cofre.
//! Plugins com servidor nativo rodam como o seu usuário do Windows: o cofre limita o que eles recebem pela API, mas
//! não é uma sandbox.
use super::{RouteFn, ok, route_fn, vault_input};
use crate::server::host;
use crate::util::*;
use bluescreen_sdk::plugin::Req;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::LazyLock;

use bluescreen_sdk::plugin::H_PLUGIN_TOKEN;
const ENTROPY: &[u8] = b"bluescreen-vault";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Grant {
    /// usar sem ver ({{vault:nome}} no fetch e nas variáveis de ambiente)
    #[serde(rename = "use")]
    pub allow: bool,
    /// ler o valor (só servidores de plugin)
    pub reveal: bool,
    /// o nome que o plugin usa para este segredo, quando é outro ({{vault:rastro.dynatrace}} -> segredo "dynatrace"):
    /// vários plugins que pedem o mesmo token com nomes diferentes usam um segredo só
    #[serde(rename = "as", skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}
/// O segredo que um plugin quer dizer com `name`: o de mesmo nome liberado para ele ou o que ele recebeu com esse
/// apelido; sem nenhum dos dois, o de mesmo nome (para a mensagem de "sem permissão").
fn find<'a>(s: &'a Store, plugin: &str, name: &str) -> Option<(&'a String, &'a Entry)> {
    let exact = s.entries.get_key_value(name);
    if let Some((_, e)) = exact { if e.grants.get(plugin).is_some_and(|g| g.allow || g.reveal) { return exact; } }
    s.entries.iter().find(|(_, e)| e.grants.get(plugin).is_some_and(|g| g.alias.as_deref() == Some(name))).or(exact)
}
/// Um campo de um segredo com mais de um valor (usuário e senha, token e id do cliente...). O plugin declara no
/// plugin.json (`"fields"`) e usa cada um como `{{vault:nome/campo}}`.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Field {
    pub key: String,
    pub label: String,
    /// digitado como ••• e nunca mostrado
    pub secret: bool,
    pub optional: bool,
    /// o formato do que se digita (FIELD_TYPES): "text" (padrão), "multiline", "url", "email", "number"
    #[serde(rename = "type", skip_serializing_if = "String::is_empty")]
    pub kind: String,
}
/// Formatos de campo: a janela confere url, e-mail e número; "multiline" é uma caixa de várias linhas (chave PEM,
/// certificado). "secret" e "password" são texto com `secret: true`.
pub const FIELD_TYPES: &[&str] = &["text", "secret", "password", "multiline", "url", "email", "number"];
/// Tipos prontos de segredo: o plugin escolhe um com `"kind"` no lugar de listar os campos.
/// (id, rótulo, [(campo, rótulo, secreto, opcional, formato)])
type Preset = (&'static str, &'static str, &'static [(&'static str, &'static str, bool, bool, &'static str)]);
pub const KINDS: &[Preset] = &[
    ("token", "Um token (ou chave de API)", &[("value", "Token", true, false, "")]),
    ("basic", "Usuário e senha", &[("user", "Usuário", false, false, ""), ("password", "Senha", true, false, "")]),
    ("domain", "Usuário, senha e domínio (Windows/AD)", &[("user", "Usuário", false, false, ""), ("password", "Senha", true, false, ""), ("domain", "Domínio", false, true, "")]),
    ("apiKeySecret", "Chave e segredo de API", &[("key", "Chave (key / id)", false, false, ""), ("secret", "Segredo (secret)", true, false, "")]),
    ("oauthClient", "OAuth: client ID e client secret", &[("client_id", "Client ID", false, false, ""), ("client_secret", "Client secret", true, false, ""), ("tenant", "Tenant / realm", false, true, "")]),
    ("aws", "AWS: access key e secret key", &[("access_key_id", "Access key ID", false, false, ""), ("secret_access_key", "Secret access key", true, false, ""), ("session_token", "Session token", true, true, ""), ("region", "Região", false, true, "")]),
    ("database", "Banco de dados: servidor, usuário e senha", &[("host", "Servidor", false, false, ""), ("port", "Porta", false, true, "number"), ("database", "Banco", false, true, ""), ("user", "Usuário", false, false, ""), ("password", "Senha", true, false, "")]),
    ("connectionString", "String de conexão", &[("value", "String de conexão", true, false, "")]),
    ("webhook", "URL de webhook (com o segredo na URL)", &[("value", "URL do webhook", true, false, "url")]),
    ("sshKey", "Chave SSH ou privada (PEM)", &[("private_key", "Chave privada (cole o texto inteiro)", true, false, "multiline"), ("passphrase", "Senha da chave", true, true, "")]),
    ("certificate", "Certificado e chave (PEM)", &[("cert", "Certificado (PEM)", false, false, "multiline"), ("key", "Chave privada (PEM)", true, false, "multiline"), ("passphrase", "Senha da chave", true, true, "")]),
    ("pin", "PIN ou código numérico", &[("value", "PIN", true, false, "number")]),
    ("text", "Texto livre (várias linhas)", &[("value", "Texto", true, false, "multiline")]),
];
fn preset(id: &str) -> Vec<Field> {
    KINDS.iter().find(|k| k.0.eq_ignore_ascii_case(id)).map(|k| k.2.iter().map(|&(key, label, secret, optional, kind)| Field { key: key.into(), label: label.into(), secret, optional, kind: kind.into() }).collect()).unwrap_or_default()
}
/// os tipos prontos para a tela do cofre: [{ id, label, fields }]
fn kinds_json() -> Value { Value::Array(KINDS.iter().map(|k| json!({ "id": k.0, "label": k.1, "fields": preset(k.0) })).collect()) }
/// O que um pedido quer que se digite: `fields` (lista própria) ou `kind` (um tipo pronto); sem nenhum, vazio (token).
fn fields_for(d: &Value) -> Vec<Field> {
    let f = fields_of(&d["fields"]);
    if !f.is_empty() { return f; }
    d["kind"].as_str().map(preset).unwrap_or_default()
}
/// Campos que um plugin pede: [{ key, label, secret, optional, type }] ou só os nomes (["user", "password"]). Sem
/// `secret`, só usuário, login, e-mail e endereços aparecem ao digitar.
fn fields_of(v: &Value) -> Vec<Field> {
    let mut out: Vec<Field> = vec![];
    for f in v.as_array().into_iter().flatten().take(8) {
        let key = f.as_str().or(f["key"].as_str()).unwrap_or("").trim().to_string();
        if key.is_empty() || key.len() > 32 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c)) || out.iter().any(|x| x.key == key) { continue; }
        let plain = matches!(key.to_ascii_lowercase().as_str(), "user" | "username" | "usuario" | "login" | "email" | "url" | "host" | "domain" | "tenant" | "org" | "account" | "client_id" | "clientid");
        let ty = f["type"].as_str().unwrap_or("").trim().to_ascii_lowercase();
        let ty = if FIELD_TYPES.contains(&ty.as_str()) { ty } else { String::new() };
        let secret = matches!(ty.as_str(), "secret" | "password") || f["secret"].as_bool().unwrap_or(!plain);
        out.push(Field {
            label: f["label"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| key.clone()),
            secret, optional: f["optional"].as_bool().unwrap_or(false), key,
            kind: if matches!(ty.as_str(), "text" | "secret" | "password") { String::new() } else { ty },
        });
    }
    out
}
/// o campo que `{{vault:nome}}` (sem /campo) usa: o primeiro secreto, ou o primeiro
fn main_field(fields: &[Field]) -> Option<&Field> { fields.iter().find(|f| f.secret).or(fields.first()) }
/// `nome/campo` -> (nome, Some(campo))
fn split_name(n: &str) -> (&str, Option<&str>) { match n.split_once('/') { Some((a, b)) => (a.trim(), Some(b.trim())), None => (n.trim(), None) } }

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct Entry {
    /// cifrado (DPAPI, base64); nunca sai daqui. Com `fields`, um JSON { campo: valor } cifrado
    #[serde(skip_serializing_if = "String::is_empty")]
    value: String,
    /// os campos do segredo (vazio = um valor só, o token)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fields: Vec<Field>,
    label: String,
    note: String,
    /// sites para onde o segredo pode ir: "api.github.com", "*.atlassian.net"
    hosts: Vec<String>,
    /// programas que podem recebê-lo numa variável de ambiente: "gh", "git"
    programs: Vec<String>,
    grants: BTreeMap<String, Grant>,
    /// começo do valor ("ghp_"), para você reconhecer qual token é; só em valores longos
    hint: String,
    length: usize,
    created: i64,
    updated: i64,
    last_used: Option<i64>,
    last_by: Option<String>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Store { entries: BTreeMap<String, Entry> }

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static AUDIT: LazyLock<Mutex<VecDeque<Value>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
/// uma caixa de confirmação por vez (um plugin não empilha dezenas de pedidos)
static ASKING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn file() -> std::path::PathBuf { user_dir().join("vault.json") }
fn load() -> Store { serde_json::from_value(read_json(&file())).unwrap_or_default() }
fn save(s: &Store) -> ApiResult<()> { Ok(write_atomic(&file(), &serde_json::to_string_pretty(s).unwrap_or_default())?) }
/// para mudar e gravar: cofre ilegível é erro, nunca "vazio" (a gravação seguinte apagaria todos os segredos)
fn load_strict() -> ApiResult<Store> {
    let v = read_json_strict(&file()).map_err(|e| fail(format!("o cofre não pôde ser lido: {e}"), 500))?;
    if v.is_null() { return Ok(Store::default()); }
    serde_json::from_value(v).map_err(|e| fail(format!("o cofre ({}) está num formato inesperado ({e}); nada foi gravado", file().display()), 500))
}
fn edit<T>(f: impl FnOnce(&mut Store) -> ApiResult<T>) -> ApiResult<T> {
    let _g = LOCK.lock();
    let mut s = load_strict()?;
    let out = f(&mut s)?;
    save(&s)?;
    Ok(out)
}
fn now() -> i64 { chrono::Utc::now().timestamp_millis() }
fn valid_name(n: &str) -> bool { !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) }
fn need_name(n: &str) -> ApiResult<String> {
    if valid_name(n) { Ok(n.to_string()) } else { Err(fail("nome inválido: use letras, números, _ . - (até 64)", 400)) }
}

fn seal(plain: &str) -> ApiResult<String> {
    use base64::Engine;
    let c = super::data::dpapi::protect(plain.as_bytes(), ENTROPY, true).ok_or_else(|| fail("não deu para cifrar", 500))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(c))
}
fn unseal(sealed: &str) -> Option<String> {
    use base64::Engine;
    let c = base64::engine::general_purpose::STANDARD.decode(sealed).ok()?;
    String::from_utf8(super::data::dpapi::protect(&c, ENTROPY, false)?).ok()
}
/// Os valores de um segredo, campo a campo (um segredo de valor só fica como { "value": ... }).
fn values(e: &Entry) -> Option<BTreeMap<String, String>> {
    let plain = unseal(&e.value)?;
    if e.fields.is_empty() { return Some(BTreeMap::from([("value".to_string(), plain)])); }
    serde_json::from_str(&plain).ok()
}
/// O valor de `campo` (ou do campo principal). `basic` sem um campo com esse nome: base64("usuário:senha"), do primeiro
/// campo que não é secreto e do primeiro secreto, para `Authorization: Basic {{vault:nome/basic}}`.
fn value_of(e: &Entry, name: &str, field: Option<&str>) -> ApiResult<String> {
    let v = values(e).ok_or_else(|| fail(format!("não deu para decifrar \"{name}\" (o cofre foi copiado de outro usuário ou PC?)"), 500))?;
    if e.fields.is_empty() {
        return match field { None | Some("value") => Ok(v.get("value").cloned().unwrap_or_default()), Some(f) => Err(fail(format!("\"{name}\" tem um valor só, sem o campo \"{f}\""), 400)) };
    }
    let key = match field {
        Some("basic") if !e.fields.iter().any(|f| f.key == "basic") => {
            use base64::Engine;
            let user = e.fields.iter().find(|f| !f.secret).and_then(|f| v.get(&f.key)).cloned().unwrap_or_default();
            let pass = e.fields.iter().find(|f| f.secret).and_then(|f| v.get(&f.key)).cloned().unwrap_or_default();
            return Ok(base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")));
        }
        Some(f) => e.fields.iter().find(|x| x.key == f).map(|x| x.key.clone())
            .ok_or_else(|| fail(format!("\"{name}\" não tem o campo \"{f}\" (tem: {})", e.fields.iter().map(|x| x.key.as_str()).collect::<Vec<_>>().join(", ")), 400))?,
        None => main_field(&e.fields).map(|f| f.key.clone()).unwrap_or_default(),
    };
    Ok(v.get(&key).cloned().unwrap_or_default())
}

fn audit(plugin: &str, name: &str, target: &str, allowed: bool, why: &str) {
    let mut a = AUDIT.lock();
    a.push_front(json!({ "at": now(), "plugin": plugin, "name": name, "target": target, "ok": allowed, "why": why }));
    a.truncate(200);
    if !allowed { log(format!("cofre: {plugin} -> {name} ({target}) recusado: {why}")); }
}

// ---------- quem chama ----------
pub struct Caller {
    pub plugin: String,
    /// identificado pelo token do processo (servidor de plugin); falso = a página, que só declara o id
    pub verified: bool,
}
/// Quem está chamando: o servidor de plugin dono do token do cabeçalho ou, sem ele, o plugin que a página declara.
pub fn caller(r: &Req) -> ApiResult<Caller> {
    let claimed = r.q("plugin");
    if let Some(tok) = r.headers.get(H_PLUGIN_TOKEN).and_then(|v| v.to_str().ok()).filter(|t| !t.is_empty()) {
        if r.remote { return Err(fail("só pelo PC local", 403)); }
        let id = super::external::token_owner(tok).ok_or_else(|| fail("token de plugin desconhecido", 403))?;
        if claimed.is_some_and(|c| c != id) { return Err(fail("o token é de outro plugin", 403)); }
        return Ok(Caller { plugin: id, verified: true });
    }
    Ok(Caller { plugin: super::data::plugin_of(r)?, verified: false })
}

// ---------- uso pelos plugins ----------
/// Valor do segredo para um plugin liberado (a política de destino é conferida depois, em `check`). `nome/campo` pega
/// um campo de um segredo com vários (usuário e senha).
pub fn resolve(c: &Caller, full: &str) -> ApiResult<String> {
    let (name, field) = split_name(full);
    let s = { let _g = LOCK.lock(); load() };
    let Some((_, e)) = find(&s, &c.plugin, name) else {
        audit(&c.plugin, name, "", false, "não existe no cofre");
        return Err(fail(format!("\"{name}\" não está no cofre. Crie em Plugins › Cofre."), 404));
    };
    if !e.grants.get(&c.plugin).is_some_and(|g| g.allow) {
        audit(&c.plugin, name, "", false, "plugin sem permissão");
        return Err(fail(format!("o plugin {} não tem permissão para usar \"{name}\" (Plugins › Cofre)", c.plugin), 403));
    }
    value_of(e, name, field)
}
pub enum Target<'a> { Http(&'a reqwest::Url), Program(&'a str) }
fn host_ok(pattern: &str, host: &str) -> bool {
    let (p, h) = (pattern.trim().to_ascii_lowercase(), host.to_ascii_lowercase());
    match p.strip_prefix("*.") { Some(base) => h == base || h.ends_with(&format!(".{base}")), None => p == h }
}
fn local_host(h: &str) -> bool { matches!(h, "localhost" | "127.0.0.1" | "[::1]" | "::1") }
/// Confere se os segredos usados podem ir para esse destino; registra o uso (ou a recusa).
pub fn check(c: &Caller, names: &[String], target: Target) -> ApiResult<()> {
    if names.is_empty() { return Ok(()); }
    let s = { let _g = LOCK.lock(); load() };
    let mut real: Vec<String> = vec![];
    for full in names {
        let name = split_name(full).0;
        let Some((key, e)) = find(&s, &c.plugin, name) else { continue };
        real.push(key.clone());
        let (desc, res): (String, Result<(), String>) = match &target {
            Target::Http(u) => {
                let h = u.host_str().unwrap_or("");
                let desc = h.to_string();
                let res = if u.scheme() != "https" && !local_host(h) { Err(format!("\"{name}\" só vai por HTTPS")) }
                    // sem sites liberados, não vai para nenhum (nem para servidor de plugin)
                    else if e.hosts.is_empty() { Err(format!("\"{name}\" não tem sites liberados: defina para onde ele pode ir em Plugins › Cofre")) }
                    else if !e.hosts.iter().any(|p| host_ok(p, h)) { Err(format!("\"{name}\" não pode ir para {h} (liberados: {})", e.hosts.join(", "))) }
                    else { Ok(()) };
                (desc, res)
            }
            Target::Program(p) => {
                let base = std::path::Path::new(p).file_stem().and_then(|s| s.to_str()).unwrap_or(p).to_ascii_lowercase();
                let res = if e.programs.iter().any(|x| x.trim().eq_ignore_ascii_case(&base)) { Ok(()) }
                    else { Err(format!("\"{name}\" não está liberado para o programa {base} (Plugins › Cofre)")) };
                (format!("programa {base}"), res)
            }
        };
        match res {
            Ok(()) => audit(&c.plugin, name, &desc, true, ""),
            Err(m) => { audit(&c.plugin, name, &desc, false, &m); return Err(fail(m, 403)); }
        }
    }
    // último uso (sem travar a resposta numa escrita de disco por pedido)
    let (names, who) = (real, c.plugin.clone());
    std::thread::spawn(move || { let _ = edit(|s| { for n in &names { if let Some(e) = s.entries.get_mut(n) { e.last_used = Some(now()); e.last_by = Some(who.clone()); } } Ok(()) }); });
    Ok(())
}
/// Tira os valores dos segredos de um texto que volta para a página (resposta HTTP, saída de programa).
/// O valor como ele costuma voltar numa resposta: como é, URL-encoded, escapado em JSON e em base64. As mais
/// longas primeiro (uma forma que contém outra sai inteira).
pub fn forms(v: &str) -> Vec<String> {
    use base64::Engine;
    let json = serde_json::to_string(v).ok().and_then(|s| s.get(1..s.len() - 1).map(String::from)).unwrap_or_default();
    let mut f = vec![v.to_string(), urlencoding::encode(v).into_owned(), json, base64::engine::general_purpose::STANDARD.encode(v), base64::engine::general_purpose::STANDARD_NO_PAD.encode(v), base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v)];
    f.retain(|x| x.len() >= 4);
    f.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    f.dedup();
    f
}
pub fn scrub(text: &str, values: &[String]) -> String {
    let mut out = text.to_string();
    for v in values.iter().filter(|v| v.len() >= 4) { for f in forms(v) { if out.contains(f.as_str()) { out = out.replace(f.as_str(), "••••••"); } } }
    out
}
/// `scrub` em bytes (resposta binária, saída de programa ainda não decodificada)
pub fn scrub_bytes(bytes: &[u8], values: &[String]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for v in values.iter().filter(|v| v.len() >= 4) {
        for f in forms(v) {
            let f = f.as_bytes();
            if memchr::memmem::find(&out, f).is_none() { continue; }
            let (mut n, mut i) = (Vec::with_capacity(out.len()), 0);
            for at in memchr::memmem::find_iter(&out, f) { if at < i { continue; } n.extend_from_slice(&out[i..at]); n.extend_from_slice("••••••".as_bytes()); i = at + f.len(); }
            n.extend_from_slice(&out[i..]);
            out = n;
        }
    }
    out
}
/// quantos bytes do fim de um pedaço de saída esperar pelo próximo: um segredo cortado entre dois pedaços sai inteiro
pub fn scrub_tail(values: &[String]) -> usize { values.iter().filter(|v| v.len() >= 4).flat_map(|v| forms(v)).map(|f| f.len()).max().unwrap_or(1).saturating_sub(1) }

// ---------- confirmação nativa e área de transferência ----------
#[cfg(windows)]
fn native_confirm(title: &str, text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (t, m) = (w(title), w(text));
    // SAFETY: textos terminados em zero, vivos durante a chamada; sem janela dona (fica por cima de tudo)
    let r = unsafe { MessageBoxW(std::ptr::null_mut(), m.as_ptr(), t.as_ptr(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND) };
    r == IDYES
}
#[cfg(not(windows))]
fn native_confirm(_: &str, _: &str) -> bool { false }
/// Pergunta numa caixa nativa (o JavaScript da página não clica nela). Uma por vez.
async fn confirm(text: String) -> ApiResult<()> {
    let _g = ASKING.try_lock().map_err(|_| fail("já há uma confirmação do cofre aberta", 409))?;
    let yes = tokio::task::spawn_blocking(move || native_confirm("BlueScreen · Cofre", &text)).await.unwrap_or(false);
    if yes { Ok(()) } else { Err(fail("cancelado", 409)) }
}
#[cfg(windows)]
fn clipboard_text(clear: bool) -> Option<String> {
    use windows_sys::Win32::System::DataExchange::*;
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    // SAFETY: a área de transferência fica aberta só aqui dentro; o texto é copiado antes de soltar o bloqueio
    unsafe {
        let mut opened = false;
        for _ in 0..10 { if OpenClipboard(std::ptr::null_mut()) != 0 { opened = true; break; } std::thread::sleep(std::time::Duration::from_millis(30)); }
        if !opened { return None; }
        let h = GetClipboardData(CF_UNICODETEXT);
        let mut out = None;
        if !h.is_null() {
            let p = GlobalLock(h as _) as *const u16;
            if !p.is_null() {
                let mut n = 0; while *p.add(n) != 0 && n < 1 << 20 { n += 1; }
                out = Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, n)));
                GlobalUnlock(h as _);
            }
        }
        if clear && out.is_some() { EmptyClipboard(); }
        CloseClipboard();
        out
    }
}
#[cfg(not(windows))]
fn clipboard_text(_: bool) -> Option<String> { None }

// ---------- o que a página e os plugins veem (nunca o valor) ----------
fn public(name: &str, e: &Entry) -> Value {
    let mut v = serde_json::to_value(e).unwrap_or_default();
    if let Some(o) = v.as_object_mut() { o.remove("value"); o.insert("name".into(), json!(name)); }
    v
}
/// pedidos dos plugins (`vault` no plugin.json): [{ key, label, why, hosts, programs, reveal }]
fn requests(s: &Store) -> Vec<Value> {
    let mut out = vec![];
    for p in host().get().list.iter() {
        for d in p.vault.as_array().into_iter().flatten() {
            let Some(key) = d["key"].as_str().filter(|k| valid_name(k)) else { continue };
            let hit = find(s, &p.id, key);
            let g = hit.and_then(|(_, e)| e.grants.get(&p.id)).cloned().unwrap_or_default();
            // segredos que já existem para os mesmos sites: dá para liberar um deles em vez de criar outro
            let hosts = list_of(&d["hosts"]);
            let same: Vec<&String> = if hosts.is_empty() { vec![] } else { s.entries.iter().filter(|(_, e)| { let mut a = e.hosts.clone(); a.sort(); a == hosts }).map(|(k, _)| k).collect() };
            out.push(json!({
                "plugin": p.id, "pluginName": p.name, "enabled": p.enabled, "key": key, "label": d["label"], "why": d["why"],
                "hosts": d["hosts"], "programs": d["programs"], "reveal": d["reveal"].as_bool().unwrap_or(false), "fields": fields_for(d), "kind": d["kind"],
                "exists": hit.is_some(), "entry": hit.map(|(k, _)| k), "granted": g.allow, "revealGranted": g.reveal, "sameHosts": same,
            }));
        }
    }
    out
}
/// apelido válido e diferente do nome do segredo: Some(Some(apelido)); igual ao nome ou vazio: Some(None); ausente: None
fn alias_of(v: &Value, name: &str) -> Option<Option<String>> {
    let s = v.as_str()?.trim();
    Some(if s.is_empty() || s == name || !valid_name(s) { None } else { Some(s.to_string()) })
}
fn plugin_name(id: &str) -> String { host().get().list.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_else(|| id.to_string()) }
fn list_of(v: &Value) -> Vec<String> {
    let raw: Vec<String> = match v { Value::String(s) => s.split([',', ' ', '\n', ';']).map(String::from).collect(), _ => v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() };
    let mut out: Vec<String> = raw.into_iter().map(|s| s.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_ascii_lowercase()).filter(|s| !s.is_empty()).collect();
    out.sort(); out.dedup(); out
}

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![
        // a tela do cofre: GET -> { entries, requests, audit }; POST { action, ... } (veja abaixo). Só pelo PC local.
        ("vault", route_fn(|r| async move {
            r.local_only()?;
            // servidores de plugin não administram o cofre: só a tela da IDE (com a confirmação nativa)
            if r.headers.contains_key(H_PLUGIN_TOKEN) { return Err(fail("plugins não administram o cofre", 403)); }
            if r.is_post() { manage(&r).await?; }
            let s = { let _g = LOCK.lock(); load() };
            ok(json!({
                "entries": s.entries.iter().map(|(k, e)| public(k, e)).collect::<Vec<_>>(),
                "requests": requests(&s),
                "audit": AUDIT.lock().iter().take(100).cloned().collect::<Vec<_>>(),
                "kinds": kinds_json(),
                "file": file(),
            }))
        })),
        // para os plugins: GET ?plugin= -> { items: [{ key, exists, granted, reveal, hosts, programs }] } (sem valores)
        ("vault/status", route_fn(|r| async move {
            let c = caller(&r)?;
            let s = { let _g = LOCK.lock(); load() };
            let mut keys: Vec<String> = host().get().list.iter().filter(|p| p.id == c.plugin).flat_map(|p| p.vault.as_array().cloned().unwrap_or_default())
                .filter_map(|d| d["key"].as_str().map(String::from)).collect();
            // o plugin enxerga os segredos pelo nome que ele usa (o apelido, quando há)
            keys.extend(s.entries.iter().filter_map(|(k, e)| e.grants.get(&c.plugin).filter(|g| g.allow || g.reveal).map(|g| g.alias.clone().unwrap_or_else(|| k.clone()))));
            keys.sort(); keys.dedup();
            let items: Vec<Value> = keys.iter().map(|k| {
                let e = find(&s, &c.plugin, k).map(|(_, e)| e);
                let g = e.and_then(|e| e.grants.get(&c.plugin)).cloned().unwrap_or_default();
                json!({ "key": k, "exists": e.is_some(), "granted": g.allow, "reveal": g.reveal, "hosts": e.map(|e| e.hosts.clone()), "programs": e.map(|e| e.programs.clone()),
                    "fields": e.map(|e| e.fields.iter().map(|f| f.key.clone()).collect::<Vec<_>>()) })
            }).collect();
            ok(json!({ "items": items }))
        })),
        // valor cru: só um servidor de plugin (token do processo) com "pode ver o valor"
        ("vault/reveal", route_fn(|r| async move {
            r.local_only()?;
            let c = caller(&r)?;
            let full = r.require("key")?.to_string();
            let (base, field) = split_name(&full);
            let name = need_name(base)?;
            if !c.verified {
                audit(&c.plugin, &name, "valor", false, "pedido da página");
                return Err(fail("o valor do cofre só sai para servidores de plugin; na página, use {{vault:nome}} no fetch", 403));
            }
            let s = { let _g = LOCK.lock(); load() };
            let (_, e) = find(&s, &c.plugin, &name).ok_or_else(|| fail(format!("\"{name}\" não está no cofre"), 404))?;
            if !e.grants.get(&c.plugin).is_some_and(|g| g.reveal) {
                audit(&c.plugin, &name, "valor", false, "sem permissão para ver o valor");
                return Err(fail(format!("o plugin {} não pode ver o valor de \"{name}\"", c.plugin), 403));
            }
            let v = value_of(e, &name, field)?;
            // todos os campos juntos, para quem pediu o segredo inteiro
            let all = if field.is_none() && !e.fields.is_empty() { values(e).map(|m| json!(m)) } else { None };
            audit(&c.plugin, &full, "valor", true, "");
            ok(json!({ "value": v, "fields": all }))
        })),
    ]
}

/// Texto da confirmação quando um segredo ganha sites ou programas; None se nada foi acrescentado.
fn widen_text(name: &str, cur: &Entry, hosts: &[String], programs: &[String]) -> Option<String> {
    let new_hosts: Vec<&String> = hosts.iter().filter(|h| !cur.hosts.contains(h)).collect();
    let new_progs: Vec<&String> = programs.iter().filter(|p| !cur.programs.contains(p)).collect();
    if new_hosts.is_empty() && new_progs.is_empty() { return None; }
    let mut t = format!("Liberar \"{name}\" para mais destinos?\n");
    if !new_hosts.is_empty() { t += &format!("\nSites novos: {}", new_hosts.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")); }
    if !new_progs.is_empty() { t += &format!("\nProgramas novos: {}", new_progs.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")); }
    let users: Vec<String> = cur.grants.iter().filter(|(_, g)| g.allow).map(|(p, _)| plugin_name(p)).collect();
    if !users.is_empty() { t += &format!("\n\nPlugins que usam este segredo: {}", users.join(", ")); }
    Some(t)
}

/// Ações da tela do cofre. As que ampliam acesso passam pela confirmação nativa; restringir ou apagar, não.
///   enter   { name, label, note, hosts, programs, fields | kind }  abre a janela nativa para digitar os campos e grava
///   paste   { name, label, note, hosts, programs, clear }   grava o texto da área de transferência (um valor só)
///   edit    { name, label, note, hosts, programs }          muda os dados (sites/programas novos pedem confirmação)
///   grant   { name, plugin, use, reveal }                    libera ou tira um plugin
///   delete  { name }
async fn manage(r: &Req) -> ApiResult<()> {
    let b: Value = r.body_json()?;
    let name = need_name(b["name"].as_str().unwrap_or("").trim())?;
    let cur = { let _g = LOCK.lock(); load() }.entries.get(&name).cloned();
    match b["action"].as_str().unwrap_or("") {
        "paste" => {
            let clear = b["clear"].as_bool().unwrap_or(true);
            let text = tokio::task::spawn_blocking(move || clipboard_text(false)).await.ok().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .ok_or_else(|| fail("a área de transferência está vazia (copie o token antes)", 400))?;
            if text.chars().count() > 16_384 { return Err(fail("texto grande demais para um segredo", 400)); }
            let hint: String = if text.chars().count() >= 16 { text.chars().take(4).collect() } else { String::new() };
            let (hosts, programs) = (list_of(&b["hosts"]), list_of(&b["programs"]));
            let dest = if hosts.is_empty() { "nenhum site ainda".to_string() } else { hosts.join(", ") };
            let shown = if hint.is_empty() { format!("{} caracteres", text.chars().count()) } else { format!("{} caracteres, começa com \"{hint}\"", text.chars().count()) };
            confirm(format!("{} \"{name}\" no cofre com o texto da área de transferência ({shown})?\n\nPode ir para: {}\nProgramas: {}{}",
                if cur.is_some() { "Trocar o valor de" } else { "Guardar" },
                dest,
                if programs.is_empty() { "nenhum".to_string() } else { programs.join(", ") },
                if clear { "\n\nA área de transferência será limpa." } else { "" })).await?;
            let sealed = seal(&text)?;
            let len = text.chars().count();
            drop(text);
            edit(|s| {
                let e = s.entries.entry(name.clone()).or_insert_with(|| Entry { created: now(), ..Default::default() });
                e.value = sealed; e.fields = vec![]; e.hint = hint; e.length = len; e.updated = now();
                if let Some(l) = b["label"].as_str() { e.label = l.trim().into(); }
                if let Some(n) = b["note"].as_str() { e.note = n.trim().into(); }
                if !b["hosts"].is_null() { e.hosts = hosts; }
                if !b["programs"].is_null() { e.programs = programs; }
                Ok(())
            })?;
            if clear { let _ = tokio::task::spawn_blocking(|| clipboard_text(true)).await; }
            log(format!("cofre: \"{name}\" gravado"));
        }
        "enter" => {
            // os campos: os que a página manda (do pedido do plugin), os do segredo que já existe ou um token só
            let mut fields = fields_for(&b);
            if fields.is_empty() { fields = cur.as_ref().map(|e| e.fields.clone()).unwrap_or_default(); }
            if fields.is_empty() { fields = preset("token"); }
            let old = cur.as_ref().and_then(values).unwrap_or_default();
            // um segredo de valor só que ganha campos: o valor antigo vale como o campo principal
            let single = cur.as_ref().is_some_and(|e| e.fields.is_empty());
            let main_key = main_field(&fields).map(|f| f.key.clone()).unwrap_or_default();
            let old_of = |f: &Field| old.get(&f.key).or_else(|| if single && f.key == main_key { old.get("value") } else { None }).cloned();
            let hosts = if b["hosts"].is_null() { cur.as_ref().map(|e| e.hosts.clone()).unwrap_or_default() } else { list_of(&b["hosts"]) };
            let programs = if b["programs"].is_null() { cur.as_ref().map(|e| e.programs.clone()).unwrap_or_default() } else { list_of(&b["programs"]) };
            // segredo que já existe ganhando sites/programas: a mesma confirmação nativa do "edit" (a janela de digitar
            // aceita os campos em branco, que mantêm o valor antigo)
            if let Some(t) = cur.as_ref().and_then(|c| widen_text(&name, c, &hosts, &programs)) { confirm(t).await?; }
            let asks: Vec<vault_input::Ask> = fields.iter().map(|f| {
                let had = old_of(f).unwrap_or_default();
                vault_input::Ask { label: f.label.clone(), secret: f.secret, optional: f.optional, kind: f.kind.clone(), keep: !had.is_empty(), prefill: if f.secret { String::new() } else { had } }
            }).collect();
            let prompt = vault_input::Prompt { replace: cur.is_some(), name: name.clone(), hosts: hosts.clone(), programs: programs.clone(), fields: asks, place: "" };
            let got = {
                let _g = ASKING.try_lock().map_err(|_| fail("já há uma janela do cofre aberta", 409))?;
                tokio::task::spawn_blocking(move || vault_input::ask(&prompt)).await.ok().flatten().ok_or_else(|| fail("cancelado", 409))?
            };
            let mut vals: BTreeMap<String, String> = BTreeMap::new();
            for (f, v) in fields.iter().zip(got) {
                let v = if v.is_empty() { old_of(f).unwrap_or_default() } else { v };
                if v.chars().count() > 16_384 { return Err(fail(format!("{} grande demais", f.label), 400)); }
                vals.insert(f.key.clone(), v);
            }
            if vals.values().all(|v| v.is_empty()) { return Err(fail("nada digitado", 400)); }
            let main = vals.get(&main_key).cloned().unwrap_or_default();
            let hint: String = if main.chars().count() >= 16 { main.chars().take(4).collect() } else { String::new() };
            let len = main.chars().count();
            let sealed = seal(&serde_json::to_string(&vals).unwrap_or_default())?;
            // se o que foi colado ainda está na área de transferência, sai de lá
            let typed: Vec<String> = fields.iter().filter(|f| f.secret).filter_map(|f| vals.get(&f.key).cloned()).filter(|v| !v.is_empty()).collect();
            drop(vals);
            edit(|s| {
                let e = s.entries.entry(name.clone()).or_insert_with(|| Entry { created: now(), ..Default::default() });
                e.value = sealed; e.fields = fields; e.hint = hint; e.length = len; e.updated = now();
                if let Some(l) = b["label"].as_str() { e.label = l.trim().into(); }
                if let Some(n) = b["note"].as_str() { e.note = n.trim().into(); }
                e.hosts = hosts; e.programs = programs;
                Ok(())
            })?;
            let _ = tokio::task::spawn_blocking(move || { if clipboard_text(false).is_some_and(|c| typed.iter().any(|t| *t == c.trim())) { clipboard_text(true); } }).await;
            log(format!("cofre: \"{name}\" gravado"));
        }
        "edit" => {
            let cur = cur.ok_or_else(|| fail(format!("\"{name}\" não está no cofre"), 404))?;
            let hosts = if b["hosts"].is_null() { cur.hosts.clone() } else { list_of(&b["hosts"]) };
            let programs = if b["programs"].is_null() { cur.programs.clone() } else { list_of(&b["programs"]) };
            if let Some(t) = widen_text(&name, &cur, &hosts, &programs) { confirm(t).await?; }
            edit(|s| {
                let e = s.entries.get_mut(&name).ok_or_else(|| fail("sumiu", 404))?;
                e.hosts = hosts; e.programs = programs; e.updated = now();
                if let Some(l) = b["label"].as_str() { e.label = l.trim().into(); }
                if let Some(n) = b["note"].as_str() { e.note = n.trim().into(); }
                Ok(())
            })?;
        }
        "grant" => {
            let cur = cur.ok_or_else(|| fail(format!("\"{name}\" não está no cofre"), 404))?;
            let plugin = b["plugin"].as_str().filter(|p| bluescreen_sdk::store::valid_id(p)).ok_or_else(|| fail("plugin obrigatório", 400))?.to_string();
            let old = cur.grants.get(&plugin).cloned().unwrap_or_default();
            let allow = b["use"].as_bool().unwrap_or(old.allow);
            let reveal = b["reveal"].as_bool().unwrap_or(old.reveal);
            if (allow && !old.allow) || (reveal && !old.reveal) {
                let pname = plugin_name(&plugin);
                let dest = if cur.hosts.is_empty() { "nenhum site liberado ainda".to_string() } else { cur.hosts.join(", ") };
                let t = if reveal && !old.reveal {
                    format!("Deixar o plugin \"{pname}\" VER o valor de \"{name}\"?\n\nCom isso o plugin pode copiar o token e mandá-lo para qualquer lugar. Só permita para plugins em que você confia.")
                } else {
                    format!("Permitir que o plugin \"{pname}\" use \"{name}\"?\n\nO plugin não vê o valor: o BlueScreen o coloca nos pedidos.\nPode ir para: {dest}\nProgramas: {}", if cur.programs.is_empty() { "nenhum".into() } else { cur.programs.join(", ") })
                };
                confirm(t).await?;
            }
            let alias = alias_of(&b["as"], &name).unwrap_or(old.alias);
            edit(|s| {
                let e = s.entries.get_mut(&name).ok_or_else(|| fail("sumiu", 404))?;
                if !allow && !reveal { e.grants.remove(&plugin); } else { e.grants.insert(plugin.clone(), Grant { allow, reveal, alias }); }
                Ok(())
            })?;
            log(format!("cofre: \"{name}\" para {plugin}: usar={allow} ver={reveal}"));
        }
        // vários plugins de uma vez (pedidos do mesmo site), com uma confirmação só:
        // { name, grants: [{ plugin, as, use, reveal }] }
        "grantMany" => {
            let cur = cur.ok_or_else(|| fail(format!("\"{name}\" não está no cofre"), 404))?;
            let mut list = vec![];
            for g in b["grants"].as_array().into_iter().flatten() {
                let plugin = g["plugin"].as_str().filter(|p| bluescreen_sdk::store::valid_id(p)).ok_or_else(|| fail("plugin obrigatório", 400))?.to_string();
                let old = cur.grants.get(&plugin).cloned().unwrap_or_default();
                let grant = Grant { allow: g["use"].as_bool().unwrap_or(true) || old.allow, reveal: g["reveal"].as_bool().unwrap_or(false) || old.reveal, alias: alias_of(&g["as"], &name).unwrap_or(old.alias.clone()) };
                list.push((plugin, old, grant));
            }
            if list.is_empty() { return Err(fail("nenhum plugin", 400)); }
            let wider: Vec<String> = list.iter().filter(|(_, o, g)| (g.allow && !o.allow) || (g.reveal && !o.reveal)).map(|(p, _, g)| {
                format!("• {}{}{}", plugin_name(p), g.alias.as_deref().map(|a| format!(" (chama de \"{a}\")")).unwrap_or_default(), if g.reveal { " — também VÊ o valor" } else { "" })
            }).collect();
            if !wider.is_empty() {
                let dest = if cur.hosts.is_empty() { "nenhum site liberado ainda".to_string() } else { cur.hosts.join(", ") };
                let reveal = list.iter().any(|(_, o, g)| g.reveal && !o.reveal);
                let only_use = list.iter().any(|(_, _, g)| !g.reveal);
                // quem só usa não vê o valor; quem pediu para ver, vê: o texto diz o que vale para cada caso
                let how = match (reveal, only_use) {
                    (false, _) => "Os plugins não veem o valor: o BlueScreen o coloca nos pedidos.",
                    (true, true) => "Os que só usam não veem o valor: o BlueScreen o coloca nos pedidos.",
                    (true, false) => "Estes plugins vão ler o valor (os servidores deles usam o token direto).",
                };
                confirm(format!("Permitir que estes plugins usem \"{name}\"?\n\n{}\n\n{how}\nPode ir para: {dest}{}",
                    wider.join("\n"), if reveal { "\n\nQuem VÊ o valor pode copiar o token e mandá-lo para qualquer lugar. Só permita para plugins em que você confia." } else { "" })).await?;
            }
            edit(|s| {
                let e = s.entries.get_mut(&name).ok_or_else(|| fail("sumiu", 404))?;
                for (p, _, g) in list { e.grants.insert(p, g); }
                Ok(())
            })?;
            log(format!("cofre: \"{name}\" liberado para vários plugins"));
        }
        "delete" => { edit(|s| { s.entries.remove(&name); Ok(()) })?; log(format!("cofre: \"{name}\" apagado")); }
        a => return Err(fail(format!("ação desconhecida: {a}"), 400)),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosts() {
        assert!(host_ok("api.github.com", "API.github.com"));
        assert!(host_ok("*.atlassian.net", "acme.atlassian.net") && host_ok("*.atlassian.net", "atlassian.net"));
        assert!(!host_ok("*.atlassian.net", "atlassian.net.evil.com") && !host_ok("github.com", "api.github.com"));
        assert_eq!(list_of(&json!("https://api.github.com/, *.x.com;gh")), vec!["*.x.com", "api.github.com", "gh"]);
        assert_eq!(scrub("token=abcd1234 ok", &["abcd1234".into()]), "token=•••••• ok");
        // as outras formas do mesmo valor também saem
        let v = vec!["s3cr3t/+=&x".to_string()];
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode("s3cr3t/+=&x");
        assert!(!scrub(&format!("a={} b={b64}", urlencoding::encode("s3cr3t/+=&x")), &v).contains("s3cr3t"));
        assert!(!scrub(&format!("b={b64}"), &v).contains(&b64));
        assert!(!scrub(r#"{"t":"a\"b\\c"}"#, &["a\"b\\c".into()]).contains("\\c"));
        assert_eq!(scrub_bytes(b"x abcd1234 y abcd1234", &["abcd1234".into()]), "x •••••• y ••••••".as_bytes());
        assert!(scrub_tail(&v) >= b64.len() - 1);
    }
    #[test]
    fn aliases() {
        // um segredo "dynatrace" liberado para dois plugins, cada um com o nome que ele usa
        let mut e = Entry::default();
        e.grants.insert("rastro".into(), Grant { allow: true, reveal: false, alias: Some("rastro.dynatrace".into()) });
        e.grants.insert("drill".into(), Grant { allow: true, reveal: false, alias: Some("drilltrace.dynatrace".into()) });
        let mut s = Store::default();
        s.entries.insert("dynatrace".into(), e);
        assert_eq!(find(&s, "rastro", "rastro.dynatrace").map(|x| x.0.as_str()), Some("dynatrace"));
        assert_eq!(find(&s, "drill", "drilltrace.dynatrace").map(|x| x.0.as_str()), Some("dynatrace"));
        // o apelido de um plugin não serve para outro, e o nome que o outro usa não vale para este
        assert!(find(&s, "outro", "rastro.dynatrace").is_none());
        assert!(find(&s, "rastro", "drilltrace.dynatrace").is_none());
        assert_eq!(alias_of(&json!("dynatrace"), "dynatrace"), Some(None));
        assert_eq!(alias_of(&json!("rastro.dynatrace"), "dynatrace"), Some(Some("rastro.dynatrace".into())));
        assert_eq!(alias_of(&Value::Null, "dynatrace"), None);
    }
    #[test]
    fn fields() {
        let f = fields_of(&json!(["user", { "key": "password", "label": "Senha" }, "user", "a/b", { "key": "pin", "secret": false }]));
        assert_eq!(f.iter().map(|x| (x.key.as_str(), x.secret)).collect::<Vec<_>>(), vec![("user", false), ("password", true), ("pin", false)]);
        assert_eq!(f[1].label, "Senha");
        assert_eq!(main_field(&f).map(|x| x.key.as_str()), Some("password"));
        assert_eq!(split_name("bitbucket/user"), ("bitbucket", Some("user")));
        assert_eq!(split_name("rastro.dynatrace"), ("rastro.dynatrace", None));
        // tipo pronto, e `fields` vale mais que `kind`
        assert_eq!(fields_for(&json!({ "kind": "aws" })).iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), vec!["access_key_id", "secret_access_key", "session_token", "region"]);
        assert_eq!(fields_for(&json!({ "kind": "basic", "fields": ["pin"] }))[0].key, "pin");
        assert!(fields_for(&json!({ "kind": "nada" })).is_empty());
        let t = fields_of(&json!([{ "key": "pem", "type": "multiline" }, { "key": "pw", "type": "password" }, { "key": "x", "type": "zzz" }]));
        assert_eq!(t.iter().map(|x| (x.kind.as_str(), x.secret)).collect::<Vec<_>>(), vec![("multiline", true), ("", true), ("", true)]);
        for k in KINDS { assert!(!preset(k.0).is_empty() && main_field(&preset(k.0)).is_some()); }
    }
}
