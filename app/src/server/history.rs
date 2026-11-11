//! Rotas do Git/SVN: resumo, alterações, histórico, diff e blame.
//! Separadas de server.rs só por assunto: as funções de apoio (project, in_project, blocking...) ficam lá.
use super::*;

pub(super) fn add_routes(m: &mut HashMap<String, RouteFn>) {
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
    add("summary", route_fn(|r| async move { ok(vcs::summary(&project(&r)?).await) }));
    // mode: working | last (commit rev) | range (base x rev; sem rev, a cópia local)
    add("changes", route_fn(|r| async move { ok(vcs::changes(&project(&r)?, r.q_or("mode", "working"), r.q("rev"), r.q("base")).await) }));
    // file: só os commits que mexeram nele
    add("log", route_fn(|r| async move { ok(vcs::history_of(&project(&r)?, r.q_or("n", "30").parse().unwrap_or(30), r.q("file")).await) }));
    add("diff", route_fn(|r| async move { ok(vcs::diff(&project(&r)?, r.q_or("file", ""), r.q_or("mode", "working"), r.q("rev"), r.q("base")).await) }));
    // quem deixou a linha como está; POST manda o texto do editor (com o que ainda não foi salvo)
    add("blame", route_fn(|r| async move {
        let text = if r.is_post() { Some(String::from_utf8_lossy(&r.body).into_owned()) } else { None };
        ok(vcs::blame(&project(&r)?, r.q_or("file", ""), r.q_or("line", "1").parse().unwrap_or(1), text.as_deref()).await)
    }));
}
