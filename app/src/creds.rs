//! Credenciais do Automator: senhas e tokens que os fluxos usam como `{{cred:nome}}` (`{{cred:nome.user}}` é o usuário).
//! É um cofre só do Automator, separado do Cofre da IDE (plugins/vault.rs): fica ao lado do arquivo dos fluxos, com
//! cada valor cifrado pelo DPAPI do Windows (só este usuário, neste PC, decifra).
//!   - o valor nunca volta para a página: nenhuma rota o entrega. Ele é digitado numa janela nativa, ou tirado do
//!     pedido feito à IA antes de o pedido sair do PC (automation.rs, `find_secrets`);
//!   - na execução, o valor entra no nó e é tirado do que o nó devolve (saída e erro) antes de ir para o histórico;
//!   - diferente do Cofre da IDE, uma credencial daqui não tem lista de sites: qualquer fluxo do Automator pode
//!     usá-la, para onde o fluxo mandar. Para um token que só pode ir a um site, o Cofre da IDE continua valendo.
use crate::plugins::vault_input;
use crate::util::*;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::LazyLock;

const ENTROPY: &[u8] = b"bluescreen-automator-creds";
static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
/// uma janela de digitar por vez
static ASKING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
/// registro de uso (e de recusa) desta sessão, o mais novo primeiro
static AUDIT: LazyLock<Mutex<VecDeque<Value>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
static MARK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{\{\s*cred:\s*([A-Za-z0-9_-]{1,64})(?:\.(user|value))?\s*\}\}").unwrap());

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Cred {
    /// cifrado (DPAPI, base64); nunca sai daqui
    value: String,
    /// usuário ou login que acompanha a senha (não é segredo)
    user: String,
    label: String,
    length: usize,
    /// "ia": tirada de um pedido feito à IA; vazio: digitada na janela
    origin: String,
    created: i64,
    updated: i64,
    last_used: Option<i64>,
    /// "fluxo › nó" que usou por último
    last_by: Option<String>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Store { creds: BTreeMap<String, Cred> }

fn file() -> std::path::PathBuf { crate::automation::file().with_file_name("automator-credentials.json") }
fn load() -> Store { serde_json::from_value(read_json(&file())).unwrap_or_default() }
/// para mudar e gravar: arquivo ilegível é erro, nunca "vazio" (a gravação seguinte apagaria as credenciais)
fn edit<T>(f: impl FnOnce(&mut Store) -> ApiResult<T>) -> ApiResult<T> {
    let _g = LOCK.lock();
    let v = read_json_strict(&file()).map_err(|e| fail(format!("as credenciais do Automator não puderam ser lidas: {e}"), 500))?;
    let mut s: Store = if v.is_null() { Store::default() } else { serde_json::from_value(v).map_err(|e| fail(format!("credenciais num formato inesperado ({e}); nada foi gravado"), 500))? };
    let out = f(&mut s)?;
    if let Some(dir) = file().parent() { std::fs::create_dir_all(dir)?; }
    write_atomic(&file(), &serde_json::to_string_pretty(&s).unwrap_or_default())?;
    Ok(out)
}
fn now() -> i64 { chrono::Utc::now().timestamp_millis() }
fn seal(plain: &str) -> ApiResult<String> {
    use base64::Engine;
    let c = crate::plugins::data::dpapi::protect(plain.as_bytes(), ENTROPY, true).ok_or_else(|| fail("não deu para cifrar", 500))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(c))
}
fn unseal(sealed: &str) -> Option<String> {
    use base64::Engine;
    let c = base64::engine::general_purpose::STANDARD.decode(sealed).ok()?;
    String::from_utf8(crate::plugins::data::dpapi::protect(&c, ENTROPY, false)?).ok()
}

pub fn valid_name(n: &str) -> bool { !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') }
/// Um nome de credencial a partir de um texto qualquer ("Senha do Portal" -> "senha-do-portal").
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        let c = match c { 'á' | 'à' | 'â' | 'ã' => 'a', 'é' | 'ê' => 'e', 'í' => 'i', 'ó' | 'ô' | 'õ' => 'o', 'ú' | 'ü' => 'u', 'ç' => 'c', c => c };
        if c.is_ascii_alphanumeric() || c == '_' { out.push(c); } else if !out.ends_with('-') && !out.is_empty() { out.push('-'); }
    }
    let out: String = out.trim_end_matches('-').chars().take(40).collect();
    out.trim_end_matches('-').to_string()
}

/// O que a tela mostra: nunca o valor.
pub fn list() -> Value {
    let s = { let _g = LOCK.lock(); load() };
    Value::Array(s.creds.iter().map(|(k, c)| json!({"name": k, "label": c.label, "user": c.user, "length": c.length, "origin": c.origin, "created": c.created, "updated": c.updated, "lastUsed": c.last_used, "lastBy": c.last_by})).collect())
}
pub fn file_path() -> String { file().to_string_lossy().into() }
pub fn audit_log() -> Vec<Value> { AUDIT.lock().iter().take(100).cloned().collect() }
/// Anota que `who` (fluxo › nó) usou, ou não conseguiu usar, as credenciais citadas em `text`.
pub fn note_use(text: &str, who: &str, ok: bool, why: &str) {
    let mut names: Vec<String> = marks(text).into_iter().map(|m| m.1).collect();
    names.sort(); names.dedup();
    if names.is_empty() { return; }
    {
        let mut a = AUDIT.lock();
        for n in &names { a.push_front(json!({"at": now(), "by": who, "name": n, "ok": ok, "why": why})); }
        a.truncate(200);
    }
    if !ok { return; }
    // último uso, sem prender a execução numa escrita de disco
    let who = who.to_string();
    std::thread::spawn(move || { let _ = edit(|s| { for n in &names { if let Some(c) = s.creds.get_mut(n) { c.last_used = Some(now()); c.last_by = Some(who.clone()); } } Ok(()) }); });
}
pub fn names() -> Vec<String> { let _g = LOCK.lock(); load().creds.keys().cloned().collect() }
/// As referências `{{cred:..}}` de um texto: (como está escrito, nome, campo).
pub fn marks(text: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = vec![];
    for c in MARK.captures_iter(text) {
        let m = (c[0].to_string(), c[1].to_string(), c.get(2).map(|x| x.as_str()).unwrap_or("value").to_string());
        if !out.contains(&m) { out.push(m); }
    }
    out
}
/// Os valores de todas as referências do texto: (como está escrito, valor). Falta de credencial é erro, com o nome.
pub fn resolve_all(text: &str) -> ApiResult<Vec<(String, String)>> {
    let found = marks(text);
    if found.is_empty() { return Ok(vec![]); }
    let s = { let _g = LOCK.lock(); load() };
    found.into_iter().map(|(mark, name, field)| {
        let c = s.creds.get(&name).ok_or_else(|| fail(format!("a credencial \"{name}\" não existe. Guarde em Credenciais, no Automator."), 404))?;
        let v = if field == "user" { c.user.clone() } else { unseal(&c.value).ok_or_else(|| fail(format!("não deu para decifrar a credencial \"{name}\" (o arquivo veio de outro usuário ou PC?). Guarde o valor de novo."), 500))? };
        Ok((mark, v))
    }).collect()
}
/// Troca as referências pelos valores, em todo texto dentro de `v`.
pub fn fill(v: &Value, found: &[(String, String)]) -> Value {
    match v {
        Value::String(s) if s.contains("cred:") => { let mut t = s.clone(); for (mark, val) in found { t = t.replace(mark, val); } json!(t) }
        Value::Array(a) => Value::Array(a.iter().map(|x| fill(x, found)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), fill(x, found))).collect()),
        o => o.clone(),
    }
}
/// Tira os valores (como são, em URL, em JSON e em base64) de todo texto dentro de `v`.
pub fn scrub_value(v: &Value, values: &[String]) -> Value {
    match v {
        Value::String(s) => json!(crate::plugins::vault::scrub(s, values)),
        Value::Array(a) => Value::Array(a.iter().map(|x| scrub_value(x, values)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), scrub_value(x, values))).collect()),
        o => o.clone(),
    }
}
/// O nome com que um valor novo vai ser guardado: o de uma credencial que já tem esse valor (e então não há o que
/// gravar: `true`), ou `base`, `base-2`... livre no arquivo e em `taken`.
pub fn plan_name(base: &str, value: &str, taken: &[String]) -> (String, bool) {
    let s = { let _g = LOCK.lock(); load() };
    if let Some((k, _)) = s.creds.iter().find(|(_, c)| unseal(&c.value).as_deref() == Some(value)) { return (k.clone(), true); }
    let base = if valid_name(base) { base.to_string() } else { "credencial".to_string() };
    let free = |n: &str| !s.creds.contains_key(n) && !taken.iter().any(|t| t == n);
    if free(&base) { return (base, false); }
    let n = (2..).map(|i| format!("{}-{i}", base.chars().take(58).collect::<String>())).find(|n| free(n)).unwrap_or(base);
    (n, false)
}
/// Guarda um valor que não foi digitado na janela (veio do pedido à IA). Nunca troca uma credencial que já existe.
pub fn add(name: &str, value: &str, label: &str, origin: &str) -> ApiResult<()> {
    if !valid_name(name) { return Err(fail("nome de credencial inválido: use letras, números, - e _ (até 64)", 400)); }
    if value.is_empty() || value.chars().count() > 16_384 { return Err(fail("valor vazio ou grande demais para uma credencial", 400)); }
    let sealed = seal(value)?;
    edit(|s| {
        if s.creds.contains_key(name) { return Err(fail(format!("a credencial \"{name}\" já existe"), 409)); }
        s.creds.insert(name.to_string(), Cred { value: sealed, user: String::new(), label: label.trim().chars().take(120).collect(), length: value.chars().count(), origin: origin.into(), created: now(), updated: now(), ..Default::default() });
        Ok(())
    })?;
    log(format!("automator: credencial \"{name}\" guardada"));
    Ok(())
}

/// Ações da tela de Credenciais:
///   enter  { name, label }   abre a janela nativa (usuário e senha ou token) e grava; em branco mantém o valor atual
///   label  { name, label }
///   delete { name }
pub async fn manage(b: &Value) -> ApiResult<()> {
    let name = b["name"].as_str().unwrap_or("").trim().to_string();
    if !valid_name(&name) { return Err(fail("dê um nome à credencial: letras, números, - e _ (sem espaços, até 64)", 400)); }
    let cur = { let _g = LOCK.lock(); load() }.creds.get(&name).cloned();
    match b["action"].as_str().unwrap_or("") {
        "enter" => {
            let prompt = vault_input::Prompt {
                replace: cur.is_some(), name: name.clone(), hosts: vec![], programs: vec![], place: "nas credenciais do Automator",
                fields: vec![
                    vault_input::Ask { label: "Usuário ou login".into(), secret: false, optional: true, kind: String::new(), prefill: cur.as_ref().map(|c| c.user.clone()).unwrap_or_default(), keep: false },
                    vault_input::Ask { label: "Senha ou token".into(), secret: true, optional: false, kind: String::new(), prefill: String::new(), keep: cur.is_some() },
                ],
            };
            let got = {
                let _g = ASKING.try_lock().map_err(|_| fail("já há uma janela de credencial aberta", 409))?;
                tokio::task::spawn_blocking(move || vault_input::ask(&prompt)).await.ok().flatten().ok_or_else(|| fail("cancelado", 409))?
            };
            let (user, value) = (got[0].trim().to_string(), got[1].clone());
            if value.is_empty() && cur.is_none() { return Err(fail("nada digitado", 400)); }
            if value.chars().count() > 16_384 { return Err(fail("valor grande demais", 400)); }
            let sealed = if value.is_empty() { None } else { Some((seal(&value)?, value.chars().count())) };
            drop(value);
            edit(|s| {
                let c = s.creds.entry(name.clone()).or_insert_with(|| Cred { created: now(), ..Default::default() });
                if let Some((v, len)) = sealed { c.value = v; c.length = len; }
                c.user = user; c.updated = now();
                if let Some(l) = b["label"].as_str() { c.label = l.trim().chars().take(120).collect(); }
                Ok(())
            })?;
            log(format!("automator: credencial \"{name}\" gravada"));
        }
        "label" => edit(|s| {
            let c = s.creds.get_mut(&name).ok_or_else(|| fail(format!("a credencial \"{name}\" não existe"), 404))?;
            c.label = b["label"].as_str().unwrap_or("").trim().chars().take(120).collect();
            Ok(())
        })?,
        "delete" => { edit(|s| { s.creds.remove(&name); Ok(()) })?; log(format!("automator: credencial \"{name}\" apagada")); }
        _ => return Err(fail("ação desconhecida", 400)),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nomes_e_referencias() {
        assert_eq!(slug("Senha do Portal (produção)"), "senha-do-portal-producao");
        assert!(valid_name("senha-loja_2") && !valid_name("a.b") && !valid_name(""));
        let m = marks("a {{cred:loja}} b {{ cred:loja.user }} c {{cred:loja}} {{vault:x}} {{cred:ruim nome}}");
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].1.as_str(), m[0].2.as_str()), ("loja", "value"));
        assert_eq!((m[1].1.as_str(), m[1].2.as_str()), ("loja", "user"));
        let found = vec![("{{cred:loja}}".to_string(), "s3nh@!".to_string())];
        assert_eq!(fill(&json!({"a": ["x {{cred:loja}}"], "n": 1}), &found), json!({"a": ["x s3nh@!"], "n": 1}));
        assert_eq!(scrub_value(&json!({"eco": "veio s3nh@! aqui", "n": 2}), &["s3nh@!".to_string()]), json!({"eco": "veio •••••• aqui", "n": 2}));
    }
}
