//! Build nativo da IDE: rotas /api/build/*.
//! Reconhece todos os sistemas de build do projeto (`detect`) e roda as tarefas e arquivos soltos com saída ao vivo
//! (`runner`). Só roda processos pelo PC local.
//!
//! Plugins estendem o build pelos ganchos do plugin.json (o núcleo não conhece nenhum plugin):
//! - "build.info": recebe a estrutura do projeto (POST) e pode devolver
//!   `{ tasks, aggregator, maven, systemNames, repos, data }`: tarefas extras, o pom agregador, a versão de Maven
//!   preferida, nomes para os grupos de tarefas, repositórios Maven para escolher na janela Build e dados livres
//!   que a interface do plugin lê em `info.plugins[id]`.
//! - "build.run": chamado quando o usuário escolheu um repositório do plugin; recebe `{ project, root, repo }` e
//!   devolve `{ settings, env, note }`: o settings.xml do Maven, variáveis de ambiente do build e um aviso para o console.
//!
//! Plugins também podem rodar passos próprios no console (POST build/run com `{ project, title, steps, jdk }`, ex.: o
//! plugin runtimes executando um main). Execuções de programa são interativas: o que se digita no console vai para a
//! entrada do processo (POST build/input).
use crate::plugins::{Reply, RouteFn, ok, path_str, project_of, route_fn};
use crate::util::*;
use futures_util::future::join_all;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub mod detect;
mod runner;
use detect::{System, Task, TaskStep};
use runner as maven;
pub use runner::{jdks, mavens};
use runner::{Jdk, Maven, Step};

/// Repositório Maven oferecido por um plugin.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Repo { id: String, label: String, plugin: String, default: bool }
/// O que um plugin devolve no gancho "build.info".
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Contribution {
    tasks: Vec<Task>,
    aggregator: Option<String>,
    maven: Option<String>,
    system_names: HashMap<String, String>,
    repos: Vec<Repo>,
    data: Value,
}
/// Repositório padrão do núcleo: o settings.xml do usuário.
const USER_REPO: &str = "user";

fn mvn_step(label: String, args: Vec<String>) -> TaskStep { TaskStep { kind: "maven".into(), label, args, java: true, ..Default::default() } }
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Info {
    root: String, rel: String, vcs: Option<&'static str>, aggregator: Option<String>, poms: Vec<String>, npm: bool,
    mavens: Vec<Maven>, jdks: Vec<Jdk>, mvn_default: Option<String>, jdk_default: Option<String>, settings: Option<String>,
    systems: Vec<System>, tasks: Vec<Task>,
    /// repositórios dos plugins (o do usuário é sempre oferecido pela interface)
    repos: Vec<Repo>, repo_default: String,
    /// dados livres de cada plugin (`data` do gancho "build.info"), ou `{ error }` quando o plugin falhou
    plugins: Map<String, Value>,
}

fn rel_of(root: &Path, dir: &Path) -> String {
    let (r, d) = (norm(&root.to_string_lossy()), norm(&dir.to_string_lossy()));
    let (rl, dl) = (r.trim_end_matches('/').to_lowercase(), d.trim_end_matches('/').to_lowercase());
    // o corte usa o tamanho do texto original (em minúsculas o tamanho em bytes pode mudar) e nunca no meio de uma letra
    if dl == rl { String::new() } else if dl.starts_with(&format!("{rl}/")) && let Some(x) = d.trim_end_matches('/').get(r.trim_end_matches('/').len() + 1..) { x.to_string() } else { norm(&rel(root, dir)) }
}

/// Chama a rota de um plugin como chamada interna (com o token do núcleo).
async fn call_plugin(route: &str, body: &Value) -> ApiResult<Value> { bluescreen_sdk::plugin::core().post(route, &[], body).await }

/// O que dá para rodar nesta pasta: tarefas dos plugins + Maven da raiz do checkout + os outros sistemas de build.
async fn build_info(dir: &Path) -> ApiResult<Info> {
    let vcs = crate::vcs::detect(dir);
    let root = maven::wc_root(dir, vcs).await;
    let (r2, d2) = (root.clone(), dir.to_path_buf());
    let (mavens, jdks, (poms, aggregator), npm) = tokio::task::spawn_blocking(move || (maven::mavens(), maven::jdks(), maven::maven_layout(&r2), maven::npm_layout(&d2)))
        .await.map_err(|e| fail(e.to_string(), 500))?;
    let rel = rel_of(&root, dir);

    // plugins inscritos em "build.info", em paralelo
    let ctx = json!({ "project": path_str(dir), "root": path_str(&root), "rel": rel, "vcs": vcs, "aggregator": aggregator, "poms": poms, "mavens": mavens, "jdks": jdks });
    let hooks = crate::server::host().hooks("build.info");
    let answers = join_all(hooks.iter().map(|(_, route)| call_plugin(route, &ctx))).await;
    let mut contribs: Vec<(String, Contribution)> = vec![];
    let mut plugins = Map::new();
    for ((id, _), res) in hooks.into_iter().zip(answers) {
        match res.and_then(|v| serde_json::from_value::<Contribution>(v).map_err(|e| fail(format!("resposta inválida: {e}"), 502))) {
            Ok(c) => { if !c.data.is_null() { plugins.insert(id.clone(), c.data.clone()); } contribs.push((id, c)); }
            Err(e) => { plugins.insert(id, json!({ "error": e.msg })); }
        }
    }

    let agg = contribs.iter().find_map(|(_, c)| c.aggregator.clone()).or(aggregator);
    let mut tasks: Vec<Task> = vec![];
    for (id, c) in &contribs {
        for mut t in c.tasks.iter().cloned() {
            if t.steps.is_empty() { continue; }
            // id que colide com o de outra tarefa ganha o prefixo do plugin
            if tasks.iter().any(|x| x.id == t.id) { t.id = format!("{id}:{}", t.id); }
            tasks.push(t);
        }
    }
    if let Some(agg) = &agg {
        let idre = Regex::new(r"(?i)[^a-z-]").unwrap();
        let mut m = |label: &str, desc: &str, goals: &[&str]| {
            let mut args = vec!["-f".to_string(), agg.clone()];
            args.extend(goals.iter().map(|g| g.to_string()));
            tasks.push(Task { id: idre.replace_all(&goals.join("-"), "").into_owned(), label: label.into(), desc: desc.into(), system: "maven".into(), steps: vec![mvn_step(format!("mvn {}", goals.join(" ")), args)], ..Default::default() });
        };
        m("Compilar", "compila todos os módulos", &["compile"]);
        m("Empacotar", "gera ear/war/jar sem rodar testes", &["clean", "install", "-DskipTests"]);
        m("Testes", "roda os testes unitários", &["test"]);
        m("Dependências", "árvore de dependências", &["dependency:tree"]);
        m("Limpar", "apaga target/", &["clean"]);
    }
    // Maven completo (raiz do checkout, com escolha de Maven, JDK e repositório) + os outros sistemas achados na pasta
    let mut systems = vec![];
    if let Some(a) = &agg {
        let ok = !mavens.is_empty() || detect::which("mvn").is_some();
        systems.push(System { id: "maven".into(), name: "Maven".into(), file: a.clone(), tool: "mvn".into(), available: ok, note: (!ok).then(|| "Nenhum Maven encontrado (procurei em ~/Tools, C:\\ e MAVEN_HOME)".into()) });
    }
    let (d2, r3, has_agg) = (dir.to_path_buf(), root.clone(), agg.is_some());
    let (more_sys, more_tasks) = tokio::task::spawn_blocking(move || detect::detect(&d2, if has_agg { Some(r3.as_path()) } else { None }))
        .await.map_err(|e| fail(e.to_string(), 500))?;
    systems.extend(more_sys);
    tasks.extend(more_tasks);
    for (_, c) in &contribs {
        for (sys, name) in &c.system_names { if let Some(x) = systems.iter_mut().find(|x| &x.id == sys) { x.name = name.clone(); } }
    }
    // versão de Maven: a que um plugin pedir (exata, depois mesma versão menor, depois mesma maior); senão a mais nova
    let want = contribs.iter().find_map(|(_, c)| c.maven.clone());
    let prefix = |w: &str, n: usize| w.split('.').take(n).collect::<Vec<_>>().join(".");
    let pick = want.as_ref().and_then(|w| mavens.iter().find(|x| &x.version == w)
        .or_else(|| mavens.iter().find(|x| prefix(&x.version, 2) == prefix(w, 2)))
        .or_else(|| mavens.iter().find(|x| prefix(&x.version, 1) == prefix(w, 1))))
        .or(mavens.first());
    let settings = dirs::home_dir().map(|h| h.join(".m2").join("settings.xml")).filter(|p| p.exists()).map(|p| p.to_string_lossy().into_owned());
    let repos: Vec<Repo> = contribs.iter().flat_map(|(id, c)| c.repos.iter().filter(|r| !r.id.is_empty() && r.id != USER_REPO).map(move |r| Repo { plugin: id.clone(), ..r.clone() })).collect();
    let repo_default = repos.iter().find(|r| r.default).map(|r| r.id.clone()).unwrap_or_else(|| USER_REPO.into());
    Ok(Info {
        rel, root: root.to_string_lossy().into(), vcs, aggregator: agg, poms, npm: npm.is_some(),
        mvn_default: pick.map(|m| m.home.clone()), jdk_default: jdks.first().map(|j| j.home.clone()), mavens, jdks, settings,
        systems, tasks, repos, repo_default, plugins,
    })
}

/// JDK pedido (home): um dos achados ou, se não estiver na lista, qualquer pasta com bin/javac; senão o primeiro
fn pick_jdk(info: &Info, want: Option<&str>) -> Option<Jdk> {
    let want = want.filter(|w| !w.is_empty());
    info.jdks.iter().find(|y| Some(y.home.as_str()) == want).cloned()
        .or_else(|| want.map(PathBuf::from).filter(|h| h.join("bin").join(if cfg!(windows) { "javac.exe" } else { "javac" }).is_file())
            .map(|h| Jdk { name: h.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), home: path_str(&h), major: 0 }))
        .or_else(|| info.jdks.first().cloned())
}

/// `java Arquivo.java` pelo JDK escolhido (o java do PATH pode ser outra versão). Arquivo compacto (main fora de uma
/// classe, Java 21+): do 21 ao 24 é preview e precisa de --enable-preview --source N; com um JDK anterior ao 21 não
/// roda, então vai o mais novo achado
fn java_single(file: &Path, info: &Info, jdk: &mut Option<Jdk>, steps: &mut [Step]) {
    let compact = top_level_main(&std::fs::read_to_string(file).unwrap_or_default());
    if compact && jdk.as_ref().is_none_or(|j| j.major > 0 && j.major < 21) {
        if let Some(n) = info.jdks.iter().filter(|j| j.major >= 21).max_by_key(|j| j.major) { *jdk = Some(n.clone()); }
    }
    let Some(j) = jdk.as_ref() else { return };
    let bin = Path::new(&j.home).join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
    for s in steps.iter_mut().filter(|s| s.java && s.program == "java") {
        if bin.is_file() { s.program = path_str(&bin); }
        if compact && (21..25).contains(&j.major) { s.args.splice(0..0, ["--enable-preview".to_string(), "--source".into(), j.major.to_string()]); }
        s.label = format!("java {}", s.args.join(" "));
    }
}

/// um `main(` fora de qualquer chave (sem contar comentários, strings e text blocks): arquivo compacto do Java 21+
fn top_level_main(src: &str) -> bool {
    let b = src.as_bytes();
    let (mut i, mut depth) = (0usize, 0i32);
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => { while i < b.len() && b[i] != b'\n' { i += 1; } }
            b'/' if b.get(i + 1) == Some(&b'*') => { i += 2; while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') { i += 1; } i += 1; }
            b'"' if b[i..].starts_with(b"\"\"\"") => { i += 3; while i < b.len() && !b[i..].starts_with(b"\"\"\"") { if b[i] == b'\\' { i += 1; } i += 1; } i += 2; }
            q @ (b'"' | b'\'') => { i += 1; while i < b.len() && b[i] != q && b[i] != b'\n' { if b[i] == b'\\' { i += 1; } i += 1; } }
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b'm' if depth == 0 && b[i..].starts_with(b"main") && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_' || b[i - 1] == b'$')) => {
                let mut k = i + 4;
                while k < b.len() && b[k].is_ascii_whitespace() { k += 1; }
                if b.get(k) == Some(&b'(') { return true; }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::top_level_main;
    #[test]
    fn compact_java() {
        assert!(top_level_main("public static void main(String[] args) {\n  System.out.println(\"x\");\n}\n"));
        assert!(top_level_main("// class A {\nvoid main() { IO.println(\"{\"); }\n"));
        assert!(!top_level_main("public class A {\n  public static void main(String[] a) {}\n}\n"));
        assert!(!top_level_main("/* main( */ class A { void main() {} }\nrecord P(int x) {}\n"));
    }
}

static CACHE: LazyLock<Arc<TtlCache<PathBuf, Info>>> = LazyLock::new(|| Arc::new(TtlCache::new(Duration::from_secs(120))));

/// Rotas do build (entram na tabela de rotas do núcleo).
pub fn routes() -> Vec<(&'static str, RouteFn)> {
    let mut v: Vec<(&'static str, RouteFn)> = vec![];
    let cache = CACHE.clone();

        let c = cache.clone();
        v.push(("build/info", route_fn(move |r| { let c = c.clone(); async move {
            let p = project_of(&r)?;
            if !r.flag("fresh") { if let Some(i) = c.get(&p) { return ok(i); } }
            let info = build_info(&p).await?;
            c.set(p, info.clone());
            ok(info)
        } })));

        let c = cache.clone();
        v.push(("build/run", route_fn(move |r| { let c = c.clone(); async move {
            // executa processos nesta máquina: só pelo PC local
            r.local_only()?;
            if !r.is_post() { return Err(fail("POST", 405)); }
            let body: Value = r.body_json()?;
            let project = PathBuf::from(body["project"].as_str().unwrap_or(""));
            let info = match c.get(&project) { Some(i) => i, None => build_info(&project).await? };
            // arquivo solto: roda pela extensão (Python, Node, Java, Go, C#...)
            if let Some(file) = body["file"].as_str().filter(|x| !x.is_empty()) {
                let (title, ts) = detect::run_file(&project, file).ok_or_else(|| fail("Não sei executar esse tipo de arquivo", 400))?;
                let mut jdk = pick_jdk(&info, body["jdk"].as_str());
                let mut steps: Vec<Step> = ts.into_iter().map(Step::from).collect();
                if file.to_lowercase().ends_with(".java") { java_single(&project.join(file), &info, &mut jdk, &mut steps); }
                let id = maven::start(maven::StartOpts { dir: path_str(&project), root: project.clone(), steps, mvn: None, jdk, title, extra: maven::Extra { env: vec![], jvm: vec![] }, note: String::new(), interactive: true });
                return ok(json!({ "id": id }));
            }
            // passos prontos de um plugin (ex.: runtimes executando um main): rodam como uma tarefa, com o console interativo
            let plugin_steps = body["steps"].as_array().filter(|a| !a.is_empty()).cloned();
            let interactive = plugin_steps.is_some();
            let (mut steps, title): (Vec<Step>, String) = if let Some(arr) = plugin_steps {
                let ts: Vec<TaskStep> = serde_json::from_value(Value::Array(arr)).map_err(|e| fail(format!("passos inválidos: {e}"), 400))?;
                let t = body["title"].as_str().filter(|x| !x.is_empty()).map(String::from).unwrap_or_else(|| ts[0].label.clone());
                (ts.into_iter().map(Step::from).collect(), t)
            } else if let Some(custom) = body["custom"].as_str().filter(|x| !x.is_empty()) {
                let args: Vec<String> = maven::split_args(custom).into_iter().filter(|a| a != "mvn" && a != "mvn.cmd").collect();
                if args.is_empty() { return Err(fail("comando vazio", 400)); }
                let t = format!("mvn {}", args.join(" "));
                (vec![Step::from(mvn_step(t.clone(), args))], t)
            } else {
                let id = body["task"].as_str().unwrap_or("");
                let t = info.tasks.iter().find(|y| y.id == id).ok_or_else(|| fail("tarefa desconhecida", 400))?;
                (t.steps.iter().cloned().map(Step::from).collect(), t.label.clone())
            };
            let mvn = info.mavens.iter().find(|y| Some(y.home.as_str()) == body["mvn"].as_str())
                .or_else(|| info.mavens.iter().find(|y| Some(&y.home) == info.mvn_default.as_ref())).cloned();
            let jdk = pick_jdk(&info, body["jdk"].as_str());
            if steps.iter().any(|y| y.kind == "maven") && mvn.is_none() {
                // sem Maven achado nas pastas de ferramentas: usa o mvnw do projeto ou o mvn do PATH
                let w = Path::new(&info.root).join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" });
                let prog = if w.is_file() { Some(w.to_string_lossy().into_owned()) } else { detect::which("mvn").map(|_| "mvn".to_string()) };
                if let Some(prog) = prog { for st in steps.iter_mut().filter(|y| y.kind == "maven") { st.kind = "cmd".into(); st.program = prog.clone(); st.cwd = info.root.clone(); } }
            }
            if steps.iter().any(|y| y.kind == "maven") && (mvn.is_none() || jdk.is_none()) {
                return Err(fail(if mvn.is_none() { "Nenhum Maven encontrado (procurei em ~/Tools, C:\\ e MAVEN_HOME)" } else { "Nenhum JDK encontrado (só JRE não compila)" }, 400));
            }
            // confia nas CAs instaladas no Windows (proxy corporativo)
            let mut extra = maven::Extra { env: vec![], jvm: if cfg!(windows) { vec!["-Djavax.net.ssl.trustStoreType=Windows-ROOT".into()] } else { vec![] } };
            let mut note = String::new();
            let mut settings: Option<String> = None;
            if steps.iter().any(|y| y.kind == "maven" || (y.kind == "cmd" && y.label.starts_with("mvn"))) {
                // repositório: o de um plugin (gancho "build.run" do plugin dono) ou o settings.xml do usuário
                let want = body["repo"].as_str().filter(|x| !x.is_empty()).unwrap_or(&info.repo_default);
                let repo = info.repos.iter().find(|x| x.id == want);
                let route = repo.and_then(|x| crate::server::host().hooks("build.run").into_iter().find(|(id, _)| *id == x.plugin).map(|(_, r)| r));
                match (repo, route) {
                    (Some(repo), Some(route)) => {
                        let v = call_plugin(&route, &json!({ "project": path_str(&project), "root": info.root, "repo": repo.id })).await?;
                        settings = v["settings"].as_str().filter(|x| !x.is_empty()).map(String::from);
                        if let Some(env) = v["env"].as_object() { for (k, x) in env { extra.env.push((k.clone(), x.as_str().unwrap_or("").into())); } }
                        note = v["note"].as_str().map(String::from).unwrap_or_else(|| format!("Repositório: {}", repo.label));
                    }
                    _ => note = "Repositório: settings.xml do usuário".into(),
                }
            }
            let offline = body["offline"].as_bool().unwrap_or(false);
            if offline && steps.iter().any(|y| y.kind == "maven") { note.push_str(" · offline"); }
            for st in steps.iter_mut().filter(|y| y.kind == "maven" || (y.kind == "cmd" && y.label.starts_with("mvn"))) {
                if !st.args.iter().any(|a| a == "-B") { st.args.insert(0, "-B".into()); } // sem cores nem barra de progresso no console
                if offline {
                    st.args.retain(|a| a != "-U");
                    if !st.args.iter().any(|a| a == "-o") { st.args.insert(0, "-o".into()); }
                }
                if let Some(sx) = &settings { if !st.args.iter().any(|a| a == "-s") { st.args.insert(0, sx.clone()); st.args.insert(0, "-s".into()); } }
            }
            let id = maven::start(maven::StartOpts { dir: path_str(&project), root: PathBuf::from(&info.root), steps, mvn, jdk, title, extra, note, interactive });
            ok(json!({ "id": id }))
        } })));
        v.push(("build/input", route_fn(|r| async move {
            // o que se digita no console vai para a entrada do programa que está rodando
            r.local_only()?;
            if !r.is_post() { return Err(fail("POST", 405)); }
            let body: Value = r.body_json()?;
            ok(json!({ "ok": maven::input(body["id"].as_str().unwrap_or(""), body["text"].as_str().unwrap_or("")) }))
        })));

        v.push(("build/read", route_fn(|r| async move {
            let id = r.require("id")?;
            let from = r.q("from").and_then(|f| f.parse::<f64>().ok()).map(|f| f.max(0.0) as usize).unwrap_or(0);
            maven::read(id, from).map(Reply::Json).ok_or_else(|| fail("execução não encontrada", 404))
        })));
        v.push(("build/exists", route_fn(|r| async move {
            // quais caminhos citados no console existem na cópia local (relativos à raiz do checkout)
            let body: Value = r.body_json()?;
            let base = absolute(Path::new(body["root"].as_str().unwrap_or("")));
            let paths: Vec<String> = body["paths"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(2000).collect()).unwrap_or_default();
            let out = tokio::task::spawn_blocking(move || paths.into_iter().filter(|rel| { let abs = absolute(&base.join(rel)); within(&base, &abs) && abs.exists() }).collect::<Vec<_>>())
                .await.map_err(|e| fail(e.to_string(), 500))?;
            ok(out)
        })));
        v.push(("build/stop", route_fn(|r| async move {
            r.local_only()?;
            if !r.is_post() { return Err(fail("POST", 405)); }
            ok(json!({ "ok": maven::stop(r.q_or("id", "")).await }))
        })));
    v.push(("build/runs", route_fn(|r| async move { ok(maven::list(r.q("project"))) })));
    v
}
