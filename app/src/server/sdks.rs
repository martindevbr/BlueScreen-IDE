//! Rotas dos SDKs e runtimes baixados pela IDE e da busca de programas (ver sdk.rs).
//! Separadas de server.rs só por assunto: as funções de apoio (project, in_project, blocking...) ficam lá.
use super::*;

pub(super) fn add_routes(m: &mut HashMap<String, RouteFn>) {
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
    // SDKs e runtimes baixados pela IDE (JDK, Node.js, Python, Go, .NET...; ver sdk.rs)
    add("sdk/list", route_fn(|r| async move {
        r.local_only()?;
        ok(blocking(crate::sdk::list).await?)
    }));
    add("sdk/versions", route_fn(|r| async move {
        r.local_only()?;
        let kind = r.q_or("kind", "").to_string();
        let v = crate::sdk::versions(&kind, r.q_or("fresh", "") == "1").await.map_err(|e| fail(e, 502))?;
        ok(json!({ "pkgs": v }))
    }));
    // POST começa a baixar; GET devolve o andamento (o mesmo formato das instalações de servidores de linguagem)
    add("sdk/install", route_fn(|r| async move {
        r.local_only()?;
        if r.is_post() { return ok(crate::sdk::install(r.q_or("kind", ""), r.q_or("id", "")).map_err(|e| fail(e, 400))?); }
        ok(crate::install::status(r.q_or("job", "")))
    }));
    // as três mudam o PC (apagam uma pasta, trocam o PATH): só por POST
    add("sdk/remove", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        crate::sdk::remove(r.q_or("kind", ""), r.q_or("path", "")).await.map_err(|e| fail(e, 400))?;
        ok(json!({ "ok": true }))
    }));
    add("sdk/default", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        crate::sdk::set_default(r.q_or("kind", ""), r.q_or("path", "")).map_err(|e| fail(e, 400))?;
        ok(json!({ "ok": true }))
    }));
    // pasta de programas de um runtime que a IDE não baixa (Ruby, PHP, Perl...): entra no PATH como os SDKs
    add("sdk/path", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        crate::sdk::set_path(r.q_or("name", ""), r.q_or("path", "")).map_err(|e| fail(e, 400))?;
        ok(json!({ "ok": true }))
    }));
    // onde estão os programas, pela mesma busca da IDE (PATH, SDKs, PATH do registro, npm -g, go/bin...):
    // POST { progs: ["java", "node"] } -> { java: "C:\\...\\java.exe", node: null }. Para plugins (runtimes).
    add("sdk/which", route_fn(|r| async move {
        let b: Value = r.body_json()?;
        let progs: Vec<String> = b["progs"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(200).collect()).unwrap_or_default();
        let found = blocking(move || progs.into_iter().map(|p| { let w = crate::build::detect::which(&p).map(|x| x.to_string_lossy().into_owned()); (p, json!(w)) }).collect::<serde_json::Map<String, Value>>()).await?;
        ok(Value::Object(found))
    }));
    // JDKs achados (o escolhido primeiro), com a versão: o plugin runtimes escolhe o que atende ao projeto
    add("sdk/jdks", route_fn(|_r| async move { ok(blocking(crate::build::jdks).await?) }));
    add("sdk/mavens", route_fn(|_r| async move { ok(blocking(crate::build::mavens).await?) }));
    add("sdk/forget", route_fn(|r| async move {
        // depois de instalar algo por fora (winget, scoop): relê o PATH do registro
        r.local_only()?;
        crate::build::detect::forget_which();
        ok(json!({ "ok": true }))
    }));
}
