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
    // os checkouts Git/SVN dentro de uma pasta (ela mesma, se for um): uma pasta cheia de repositórios vira um painel só
    add("repos", route_fn(|r| async move { ok(json!({ "repos": vcs::repos(&project(&r)?, r.q_or("depth", "3").parse().unwrap_or(3)).await })) }));
    // os commits de um período (since/until em segundos unix) com os arquivos de cada um
    add("timeline", route_fn(|r| async move {
        let since = r.q_or("since", "0").parse().unwrap_or(0);
        ok(vcs::timeline(&project(&r)?, since, r.q("until").and_then(|u| u.parse().ok()), r.q_or("n", "400").parse().unwrap_or(400)).await)
    }));
    // POST { terms: [..] }: as linhas somadas/removidas no período que contêm um dos termos (o erro colado no incidente)
    add("scan", route_fn(|r| async move {
        let b: Value = r.body_json()?;
        let terms: Vec<String> = b["terms"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(String::from)).collect();
        let since = r.q_or("since", "0").parse().unwrap_or(0);
        ok(vcs::scan(&project(&r)?, since, r.q("until").and_then(|u| u.parse().ok()), &terms, 400).await)
    }));
    // ----- gravar no repositório: só da própria máquina (quem entra pela rede local lê e edita, mas não commita) -----
    // POST { files: [{ path, code }], message, amend?, all? }: commit desses arquivos (Git e SVN)
    add("vcs/commit", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        let b: Value = r.body_json()?;
        let files: Vec<(String, String)> = b["files"].as_array().into_iter().flatten().filter_map(|f| Some((f["path"].as_str()?.to_string(), f["code"].as_str().unwrap_or("M").to_string()))).collect();
        vcs::commit(&project(&r)?, &files, b["message"].as_str().unwrap_or(""), b["amend"].as_bool().unwrap_or(false), b["all"].as_bool().unwrap_or(false)).await.map_err(|e| fail(e, 400)).and_then(ok)
    }));
    add("vcs/branches", route_fn(|r| async move { vcs::branches(&project(&r)?).await.map_err(|e| fail(e, 400)).and_then(ok) }));
    // POST { name, create? }: troca de branch (ou cria a partir da atual)
    add("vcs/checkout", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        let b: Value = r.body_json()?;
        vcs::checkout(&project(&r)?, b["name"].as_str().unwrap_or(""), b["create"].as_bool().unwrap_or(false)).await.map_err(|e| fail(e, 400)).and_then(ok)
    }));
    // POST { action: push | pull | fetch }
    add("vcs/sync", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        let b: Value = r.body_json()?;
        vcs::sync(&project(&r)?, b["action"].as_str().unwrap_or("")).await.map_err(|e| fail(e, 400)).and_then(ok)
    }));
}
