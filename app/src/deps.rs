//! Dependências não instaladas: acha os manifestos do projeto (raiz e até 2 níveis abaixo) e confere se o que eles
//! pedem já está baixado. A página mostra um aviso com o comando que resolve (npm install, uv sync, dotnet restore...).
//! Erros como "Cannot find module" ou "Type annotations can only be used in TypeScript files" quase sempre vêm daqui.
//! - Node: cada pacote de dependencies/devDependencies precisa de node_modules/<nome>/package.json nesta pasta ou
//!   numa acima, até a raiz do projeto (workspaces instalam na raiz);
//!   com Yarn PnP (.pnp.cjs) não há node_modules: o próprio .pnp.cjs diz que está instalado;
//! - Python: precisa de um ambiente virtual (.venv, venv, env) com pyvenv.cfg; Poetry e Pipenv guardam o ambiente
//!   fora do projeto (cache do Poetry, ~/.virtualenvs), e o conda (environment.yml) nas pastas envs do conda;
//! - PHP: vendor/autoload.php; .NET: obj/project.assets.json; Dart/Flutter: .dart_tool/package_config.json;
//!   Ruby: Gemfile.lock; Go: go.sum quando o go.mod tem require.
//!
//! "Ignorar esta pasta" no aviso fica em ~/.bluescreen/deps-ignore.json, por projeto (vale para todas as janelas).
use crate::build::detect::which;
use crate::plugins::{RouteFn, ok, project_of, route_fn};
use crate::util::{absolute, fail, read_json_strict, user_dir, write_atomic};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Item {
    /// pasta relativa à raiz do projeto ("" = raiz), com "/"
    dir: String,
    kind: &'static str,
    label: String,
    reason: String,
    missing: usize,
    total: usize,
    sample: Vec<String>,
    /// linhas para rodar no terminal, na pasta `dir`, uma depois da outra
    commands: Vec<String>,
    tool: String,
    tool_ok: bool,
}

const SKIP: &[&str] = &["node_modules", "target", "dist", "build", "out", "vendor", "venv", "env", "bin", "obj", "__pycache__", "coverage"];

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![("deps/check", route_fn(|r| async move {
        let root = project_of(&r)?;
        let ignored = ignored_dirs(&root);
        let items = tokio::task::spawn_blocking(move || check(&root)).await.unwrap_or_default();
        // pasta ignorada (e o que está dentro dela) não aparece no aviso
        ok(items.into_iter().filter(|it| !ignored.iter().any(|d| inside(&it.dir, d))).collect::<Vec<_>>())
    })),
    // POST { dir, ignore: true|false } ou { clear: true }: pastas do projeto que o aviso não confere
    ("deps/ignore", route_fn(|r| async move {
        if !r.is_post() { return Err(fail("POST", 405)); }
        let root = project_of(&r)?;
        let b: Value = r.body_json()?;
        let file = ignore_file();
        let mut all = read_json_strict(&file).map_err(|e| fail(e.to_string(), 500))?;
        if !all.is_object() { all = json!({}); }
        let key = ignore_key(&root);
        let mut list: Vec<String> = all[&key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        if b["clear"].as_bool() == Some(true) { list.clear(); }
        else {
            let dir = b["dir"].as_str().unwrap_or("").trim_matches('/').replace('\\', "/");
            if dir.split('/').any(|s| s == "..") { return Err(fail("pasta inválida", 400)); }
            list.retain(|d| d != &dir);
            if b["ignore"].as_bool() != Some(false) { list.push(dir); }
        }
        list.sort(); list.dedup();
        if list.is_empty() { if let Some(o) = all.as_object_mut() { o.remove(&key); } } else { all[&key] = json!(list); }
        write_atomic(&file, &serde_json::to_string_pretty(&all).unwrap_or_default()).map_err(|e| fail(e.to_string(), 500))?;
        ok(json!({ "ignored": list }))
    }))]
}
fn ignore_file() -> PathBuf { user_dir().join("deps-ignore.json") }
/// projeto no arquivo: caminho absoluto em minúsculas (no Windows "C:\Proj" e "c:\proj\" são a mesma pasta)
fn ignore_key(root: &Path) -> String { absolute(root).to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase() }
fn ignored_dirs(root: &Path) -> Vec<String> {
    crate::util::read_json(&ignore_file())[ignore_key(root)].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}
/// `dir` é a pasta `ignored` ou fica dentro dela (a raiz, "", vale só para os manifestos da própria raiz)
fn inside(dir: &str, ignored: &str) -> bool { dir == ignored || (!ignored.is_empty() && dir.starts_with(&format!("{ignored}/"))) }

pub fn check(root: &Path) -> Vec<Item> {
    let mut dirs = vec![root.to_path_buf()];
    let mut level = vec![root.to_path_buf()];
    for _ in 0..2 {
        let mut next = vec![];
        for d in &level {
            let Ok(rd) = fs::read_dir(d) else { continue };
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with('.') || SKIP.contains(&n.as_str()) || !e.file_type().is_ok_and(|t| t.is_dir()) { continue; }
                next.push(e.path());
            }
        }
        dirs.extend(next.iter().cloned());
        level = next;
        if dirs.len() > 400 { break; }
    }
    let mut out = vec![];
    let mut root_node_missing = false;
    for d in &dirs {
        let rel = d.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        // workspaces: com a raiz sem instalar, um "npm install" na raiz resolve as subpastas também
        if let Some(it) = node(root, d, &rel) { if rel.is_empty() { root_node_missing = true; out.push(it); } else if !root_node_missing { out.push(it); } }
        out.extend([python(d, &rel), conda(d, &rel), php(d, &rel), dotnet(d, &rel), dart(d, &rel), ruby(d, &rel), go(d, &rel)].into_iter().flatten());
    }
    out
}

fn item(kind: &'static str, label: &str, rel: &str, reason: String, tool: &str, commands: Vec<String>) -> Item {
    Item { dir: rel.into(), kind, label: label.into(), reason, missing: 0, total: 0, sample: vec![], commands, tool: tool.into(), tool_ok: which(tool).is_some() }
}

fn node(root: &Path, d: &Path, rel: &str) -> Option<Item> {
    let pj: Value = serde_json::from_str(&fs::read_to_string(d.join("package.json")).ok()?).ok()?;
    let mut deps: BTreeMap<String, ()> = BTreeMap::new();
    for k in ["dependencies", "devDependencies"] {
        if let Some(o) = pj[k].as_object() { for n in o.keys() { deps.insert(n.clone(), ()); } }
    }
    if deps.is_empty() { return None; }
    // Yarn Plug'n'Play: os pacotes ficam em .yarn/cache e o .pnp.cjs (gerado pelo yarn install) os resolve
    let mut cur = Some(d);
    while let Some(c) = cur {
        if c.join(".pnp.cjs").is_file() || c.join(".pnp.js").is_file() { return None; }
        if c == root { break; }
        cur = c.parent();
    }
    let installed = |name: &str| {
        let mut cur = Some(d);
        while let Some(c) = cur {
            if c.join("node_modules").join(name).join("package.json").is_file() { return true; }
            if c == root { break; }
            cur = c.parent();
        }
        false
    };
    let missing: Vec<String> = deps.keys().filter(|n| !installed(n)).cloned().collect();
    if missing.is_empty() { return None; }
    let declared = pj["packageManager"].as_str().unwrap_or("").split('@').next().unwrap_or("").to_string();
    let has = |f: &str| d.join(f).is_file() || root.join(f).is_file();
    let pm = if !declared.is_empty() { declared } else if has("pnpm-lock.yaml") { "pnpm".into() } else if has("yarn.lock") { "yarn".into() } else if has("bun.lockb") || has("bun.lock") { "bun".into() } else { "npm".into() };
    let none = !d.join("node_modules").is_dir() && !root.join("node_modules").is_dir();
    let reason = if none { format!("node_modules não existe: {} pacotes do package.json não foram baixados", deps.len()) }
                 else { format!("{} de {} pacotes do package.json não estão em node_modules", missing.len(), deps.len()) };
    let mut it = item("node", &format!("Node · {pm}"), rel, reason, &pm, vec![format!("{pm} install")]);
    it.total = deps.len(); it.missing = missing.len(); it.sample = missing.into_iter().take(6).collect();
    Some(it)
}

fn has_venv(d: &Path) -> bool { [".venv", "venv", "env", ".env"].iter().any(|v| d.join(v).join("pyvenv.cfg").is_file()) }
/// pasta com ambiente cujo nome começa com `prefix` (Poetry: "<nome>-<hash>-py3.12"; Pipenv: "<pasta>-<hash>")
fn env_named(dirs: &[PathBuf], prefix: &str) -> bool {
    let prefix = prefix.to_lowercase();
    dirs.iter().any(|d| fs::read_dir(d).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().to_lowercase().starts_with(&prefix) && e.path().join("pyvenv.cfg").is_file()))
}
/// Poetry fora do projeto: o ambiente fica no cache do Poetry (POETRY_VIRTUALENVS_PATH ou %LOCALAPPDATA%\pypoetry)
fn poetry_env(d: &Path) -> bool {
    let toml = fs::read_to_string(d.join("pyproject.toml")).unwrap_or_default();
    // [tool.poetry] name = "meu-app" (ou [project] name): o Poetry normaliza para minúsculas com "-"
    let name = toml.lines().find_map(|l| l.trim().strip_prefix("name").map(str::trim_start).and_then(|v| v.strip_prefix('=')).map(|v| v.trim().trim_matches(['"', '\'']).to_string()));
    let Some(name) = name.filter(|n| !n.is_empty()) else { return false };
    let name = name.to_lowercase().replace(['_', '.', ' '], "-");
    let mut dirs: Vec<PathBuf> = std::env::var_os("POETRY_VIRTUALENVS_PATH").map(PathBuf::from).into_iter().collect();
    for base in [dirs::cache_dir(), dirs::data_local_dir()].into_iter().flatten() { dirs.push(base.join("pypoetry").join("Cache").join("virtualenvs")); dirs.push(base.join("pypoetry").join("virtualenvs")); }
    env_named(&dirs, &format!("{name}-"))
}
/// Pipenv fora do projeto: WORKON_HOME ou ~/.virtualenvs, numa pasta "<nome da pasta>-<hash>"
fn pipenv_env(d: &Path) -> bool {
    let Some(folder) = d.file_name().map(|n| n.to_string_lossy().into_owned()) else { return false };
    let mut dirs: Vec<PathBuf> = std::env::var_os("WORKON_HOME").map(PathBuf::from).into_iter().collect();
    if let Some(h) = dirs::home_dir() { dirs.push(h.join(".virtualenvs")); dirs.push(h.join(".local").join("share").join("virtualenvs")); }
    env_named(&dirs, &format!("{folder}-"))
}
/// conda: o ambiente "name:" do environment.yml existe numa das pastas envs (CONDA_ENVS_PATH, ~/.conda, miniconda, anaconda...)
fn conda_env(name: &str) -> bool {
    let mut dirs: Vec<PathBuf> = std::env::var_os("CONDA_ENVS_PATH").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default();
    if let Some(p) = std::env::var_os("CONDA_PREFIX").map(PathBuf::from) { dirs.push(p.join("envs")); if let Some(up) = p.parent() { dirs.push(up.to_path_buf()); } }
    if let Some(h) = dirs::home_dir() { for b in [".conda", "miniconda3", "anaconda3", "miniforge3", "mambaforge"] { dirs.push(h.join(b).join("envs")); } }
    if let Some(l) = dirs::data_local_dir() { for b in ["miniconda3", "anaconda3", "miniforge3"] { dirs.push(l.join(b).join("envs")); } }
    dirs.iter().any(|d| d.join(name).join("conda-meta").is_dir())
}
fn conda(d: &Path, rel: &str) -> Option<Item> {
    let file = ["environment.yml", "environment.yaml"].into_iter().find(|f| d.join(f).is_file())?;
    let spec = fs::read_to_string(d.join(file)).ok()?;
    let name = spec.lines().find_map(|l| l.strip_prefix("name:").map(|v| v.trim().trim_matches(['"', '\'']).to_string())).filter(|n| !n.is_empty())?;
    if conda_env(&name) { return None; }
    let tool = if which("mamba").is_some() { "mamba" } else { "conda" };
    Some(item("python", "Python · conda", rel, format!("o ambiente conda \"{name}\" do {file} não foi criado"), tool, vec![format!("{tool} env create -f {file}")]))
}
fn python(d: &Path, rel: &str) -> Option<Item> {
    let f = |n: &str| d.join(n).is_file();
    if !(f("requirements.txt") || f("pyproject.toml") || f("Pipfile")) || has_venv(d) { return None; }
    // um ambiente na pasta de cima (monorepo) também serve
    if d.parent().is_some_and(has_venv) { return None; }
    // conda cuida do ambiente: o environment.yml manda (aviso próprio, em conda())
    if f("environment.yml") || f("environment.yaml") { return None; }
    if f("poetry.lock") && poetry_env(d) { return None; }
    if f("Pipfile") && pipenv_env(d) { return None; }
    let py = if which("py").is_some() { "py" } else { "python" };
    let reason = "nenhum ambiente virtual (.venv) com as dependências foi encontrado".to_string();
    Some(if f("uv.lock") || (f("pyproject.toml") && fs::read_to_string(d.join("pyproject.toml")).is_ok_and(|t| t.contains("[tool.uv]"))) {
        item("python", "Python · uv", rel, reason, "uv", vec!["uv sync".into()])
    } else if f("poetry.lock") {
        item("python", "Python · Poetry", rel, reason, "poetry", vec!["poetry install".into()])
    } else if f("Pipfile") {
        item("python", "Python · Pipenv", rel, reason, "pipenv", vec!["pipenv install --dev".into()])
    } else if f("requirements.txt") {
        item("python", "Python · pip", rel, reason, py, vec![format!("{py} -m venv .venv"), r".venv\Scripts\python -m pip install -r requirements.txt".into()])
    } else {
        item("python", "Python · pip", rel, reason, py, vec![format!("{py} -m venv .venv"), r".venv\Scripts\python -m pip install -e .".into()])
    })
}
fn php(d: &Path, rel: &str) -> Option<Item> {
    (d.join("composer.json").is_file() && !d.join("vendor").join("autoload.php").is_file())
        .then(|| item("php", "PHP · Composer", rel, "vendor/ não existe: as dependências do composer.json não foram baixadas".into(), "composer", vec!["composer install".into()]))
}
fn dotnet(d: &Path, rel: &str) -> Option<Item> {
    let projs: Vec<_> = fs::read_dir(d).ok()?.flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "csproj" || x == "fsproj" || x == "vbproj")).collect();
    if projs.is_empty() || d.join("obj").join("project.assets.json").is_file() { return None; }
    Some(item("dotnet", ".NET · NuGet", rel, "os pacotes NuGet não foram restaurados (falta obj/project.assets.json)".into(), "dotnet", vec!["dotnet restore".into()]))
}
fn dart(d: &Path, rel: &str) -> Option<Item> {
    let spec = fs::read_to_string(d.join("pubspec.yaml")).ok()?;
    if d.join(".dart_tool").join("package_config.json").is_file() { return None; }
    let flutter = spec.contains("sdk: flutter");
    let tool = if flutter { "flutter" } else { "dart" };
    Some(item("dart", if flutter { "Flutter · pub" } else { "Dart · pub" }, rel, "os pacotes do pubspec.yaml não foram baixados".into(), tool, vec![format!("{tool} pub get")]))
}
fn ruby(d: &Path, rel: &str) -> Option<Item> {
    (d.join("Gemfile").is_file() && !d.join("Gemfile.lock").is_file())
        .then(|| item("ruby", "Ruby · Bundler", rel, "as gems do Gemfile ainda não foram instaladas (sem Gemfile.lock)".into(), "bundle", vec!["bundle install".into()]))
}
fn go(d: &Path, rel: &str) -> Option<Item> {
    let m = fs::read_to_string(d.join("go.mod")).ok()?;
    (m.contains("require") && !d.join("go.sum").is_file())
        .then(|| item("go", "Go · módulos", rel, "go.sum não existe: os módulos do go.mod não foram baixados".into(), "go", vec!["go mod download".into()]))
}

#[cfg(test)]
mod tests {
    use super::check;
    use std::fs;
    #[test]
    fn yarn_pnp_e_pasta_ignorada() {
        let d = std::env::temp_dir().join(format!("bs-deps-pnp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("web")).unwrap();
        fs::write(d.join("web/package.json"), r#"{"dependencies":{"react":"18"}}"#).unwrap();
        assert_eq!(check(&d).len(), 1);
        // Yarn PnP: sem node_modules, mas instalado
        fs::write(d.join(".pnp.cjs"), "").unwrap();
        assert!(check(&d).is_empty());
        assert!(super::inside("web", "web") && super::inside("web/app", "web") && super::inside("", ""));
        assert!(!super::inside("web", ""));
        assert!(!super::inside("website", "web"));
        let _ = fs::remove_dir_all(&d);
    }
    #[test]
    fn node_missing_and_installed() {
        let d = std::env::temp_dir().join(format!("bs-deps-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("node_modules/left-pad")).unwrap();
        fs::write(d.join("package.json"), r#"{"dependencies":{"left-pad":"1","typescript":"5"}}"#).unwrap();
        fs::write(d.join("node_modules/left-pad/package.json"), "{}").unwrap();
        let v = check(&d);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].missing, v[0].total), (1, 2));
        assert_eq!(v[0].sample, vec!["typescript".to_string()]);
        fs::create_dir_all(d.join("node_modules/typescript")).unwrap();
        fs::write(d.join("node_modules/typescript/package.json"), "{}").unwrap();
        assert!(check(&d).is_empty());
        let _ = fs::remove_dir_all(&d);
    }
}
