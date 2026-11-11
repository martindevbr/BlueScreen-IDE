//! Rotas da rede local: ligar/desligar o acesso pela rede, achar outros BlueScreen e conferir um endereço.
//! Separadas de server.rs só por assunto: as funções de apoio (project, in_project, blocking...) ficam lá.
use super::*;

pub(super) fn add_routes(m: &mut HashMap<String, RouteFn>) {
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
    add("network", route_fn(|r| async move {
        r.local_only()?;
        if r.is_post() {
            let b: Value = r.body_json()?;
            // { project: "nome" | null }: o que o anúncio na rede mostra como aberto
            if let Some(p) = b.get("project") { app().lan.lock().project = p.as_str().map(String::from); return ok(lan_status()); }
            return ok(if b["enable"].as_bool().unwrap_or(false) { lan_enable().await? } else { lan_disable().await });
        }
        ok(lan_status())
    }));
    // espaços de trabalho de outros PCs que anunciaram na rede (share.rs)
    add("network/discover", route_fn(|r| async move { r.local_only()?; ok(blocking(crate::share::discovered).await?) }));
    // GET ?addr=: o endereço é de um BlueScreen alcançável? (a janela só navega para lá se for)
    // aparelhos logados pela rede: GET lista { id, ip, since, last }; POST { revoke: id } ou { revoke: "*" } derruba
    add("network/sessions", route_fn(|r| async move {
        r.local_only()?;
        if r.is_post() {
            let b: Value = r.body_json()?;
            let id = b["revoke"].as_str().unwrap_or("").to_string();
            if id.is_empty() { return Err(fail("revoke: id da sessão (ou \"*\")", 400)); }
            let mut m = app().sessions.lock();
            let before = m.len();
            m.retain(|_, s| id != "*" && s.id != id);
            if m.len() == before { return Err(fail("sessão não encontrada (já saiu?)", 404)); }
            log(format!("rede: {} aparelho(s) desconectado(s) pelo PC", before - m.len()));
        }
        let mut list: Vec<Value> = app().sessions.lock().values().filter(|s| s.at.elapsed() < SESSION_TTL)
            .map(|s| json!({ "id": s.id, "ip": s.ip.map(|i| i.to_string()), "since": s.since_ms, "last": s.last_ms })).collect();
        list.sort_by(|a, b| b["last"].as_f64().partial_cmp(&a["last"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        ok(json!({ "sessions": list }))
    }));
    add("network/probe", route_fn(|r| async move {
        r.local_only()?;
        let Some(url) = crate::share::normalize(r.q_or("addr", "")) else { return Err(fail("Endereço inválido. Use o IP do outro PC, ex.: 192.168.0.10", 400)) };
        ok(crate::share::probe(&url).await.map_err(|e| fail(e, 502))?)
    }));
}
