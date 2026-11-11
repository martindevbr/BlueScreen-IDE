//! Build nativo: reconhece os sistemas de build de um projeto (como o IntelliJ) e monta as tarefas de cada um.
//! Procura os arquivos-marca na pasta aberta e em subpastas (até 2 níveis): pom.xml, build.gradle, package.json,
//! Cargo.toml, go.mod, *.csproj, pyproject.toml, Makefile, CMakeLists.txt... Cada sistema achado vira um grupo de
//! tarefas; tarefas dinâmicas vêm do próprio arquivo (scripts do package.json, alvos do Makefile e do Ant, tarefas
//! do deno.json/justfile/Taskfile/Rakefile/composer, presets do CMake). Prefere o wrapper do projeto (gradlew,
//! mvnw) e avisa quando a ferramenta não está instalada.
//! Também sabe executar um arquivo solto de quase qualquer linguagem ("Executar arquivo", Ctrl+Shift+F10).
use crate::util::*;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Tarefas e passos também chegam dos plugins (gancho "build.info"), por isso aceitam JSON com campos faltando.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct TaskStep {
    pub kind: String,
    pub label: String,
    pub args: Vec<String>,
    /// programa (comando genérico); vazio no Maven, que roda pela JVM
    #[serde(skip_serializing_if = "String::is_empty")] pub program: String,
    /// pasta onde roda (absoluta); vazio = raiz do checkout
    #[serde(skip_serializing_if = "String::is_empty")] pub cwd: String,
    /// precisa do JDK escolhido (JAVA_HOME)
    #[serde(skip_serializing_if = "std::ops::Not::not")] pub java: bool,
    /// variáveis de ambiente só deste passo (ex.: PYTHONPATH de um plugin que executa o main)
    #[serde(skip_serializing_if = "BTreeMap::is_empty")] pub env: BTreeMap<String, String>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Task {
    pub id: String,
    pub label: String,
    pub desc: String,
    pub system: String,
    pub steps: Vec<TaskStep>,
    /// tarefa que fica rodando (servidor de desenvolvimento, watch)
    #[serde(skip_serializing_if = "std::ops::Not::not")] pub long: bool,
    /// tarefa principal do projeto: destacada no topo do grupo, com a descrição no lugar do comando
    #[serde(skip_serializing_if = "std::ops::Not::not")] pub main: bool,
    /// mostra cada passo da tarefa na janela Build
    #[serde(skip_serializing_if = "std::ops::Not::not")] pub detail: bool,
}
#[derive(Serialize, Clone, Debug)]
pub struct System {
    pub id: String,
    pub name: String,
    /// arquivo que identificou o sistema (relativo à pasta aberta)
    pub file: String,
    pub tool: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub note: Option<String>,
}

// ---------- ferramentas no PATH ----------
static WHICH: LazyLock<Mutex<HashMap<String, Option<PathBuf>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Caminho do programa no PATH (com as extensões do Windows), com cache.
pub fn which(prog: &str) -> Option<PathBuf> {
    if let Some(v) = WHICH.lock().get(prog) { return v.clone(); }
    let p = Path::new(prog);
    let found = if p.is_absolute() { p.is_file().then(|| p.to_path_buf()) } else {
        let exts: Vec<String> = if cfg!(windows) {
            let pe = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
            std::iter::once(String::new()).chain(pe.split(';').map(|e| e.to_lowercase())).collect()
        } else { vec![String::new()] };
        // PATH do processo e, depois, as pastas onde os gerenciadores põem programas globais (npm -g, go install,
        // dotnet tool, cargo): instalado agora há pouco, o PATH desta janela ainda não sabe delas
        let scoop = std::env::var_os("SCOOP").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join("scoop")));
        let extra = [dirs::data_dir().map(|d| d.join("npm")), dirs::home_dir().map(|h| h.join("go").join("bin")), dirs::home_dir().map(|h| h.join(".dotnet").join("tools")), dirs::home_dir().map(|h| h.join(".cargo").join("bin")), scoop.map(|s| s.join("shims"))];
        // e o PATH atual do Windows (registro): o que você pôs no PATH depois de abrir a IDE
        let reg = REG_PATH.lock().clone().unwrap_or_default();
        std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default().into_iter().chain(crate::sdk::path_dirs()).chain(extra.into_iter().flatten()).chain(reg).find_map(|d| {
            exts.iter().map(|e| d.join(format!("{prog}{e}"))).find(|c| c.is_file() && (cfg!(not(windows)) || c.extension().is_some()))
        })
    };
    WHICH.lock().insert(prog.into(), found.clone());
    found
}
/// esquece o que já foi procurado (depois de instalar algo) e relê o PATH do registro
pub fn forget_which() { *REG_PATH.lock() = Some(registry_path()); WHICH.lock().clear(); }
static REG_PATH: Mutex<Option<Vec<PathBuf>>> = parking_lot::const_mutex(None);
/// PATH do usuário e do sistema como estão agora no registro (o do processo é o de quando a IDE abriu)
fn registry_path() -> Vec<PathBuf> {
    if !cfg!(windows) { return vec![]; }
    let mut out = vec![];
    for key in ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"] {
        let mut c = std::process::Command::new("reg");
        c.args(["query", key, "/v", "Path"]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
        let Ok(o) = c.output() else { continue };
        let text = String::from_utf8_lossy(&o.stdout);
        // "    Path    REG_EXPAND_SZ    C:\a;%USERPROFILE%\b"
        let Some(v) = text.lines().find_map(|l| l.split_once("REG_EXPAND_SZ").or_else(|| l.split_once("REG_SZ")).map(|(_, v)| v.trim().to_string())) else { continue };
        static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"%([^%]+)%").unwrap());
        for d in v.split(';').filter(|d| !d.trim().is_empty()) {
            let d = VAR.replace_all(d.trim(), |c: &regex::Captures| std::env::var(&c[1]).unwrap_or_else(|_| c[0].to_string()));
            out.push(PathBuf::from(d.as_ref()));
        }
    }
    out
}
fn first_tool(cands: &[&str]) -> (String, bool) {
    for c in cands { if which(c).is_some() { return (c.to_string(), true); } }
    (cands[0].to_string(), false)
}

// ---------- montagem das tarefas ----------
/// `from`: `simple` acha um sistema por vez; ele marca de onde continuar na tabela (0 = não há mais o que procurar)
struct Ctx<'a> { dir: &'a Path, rel: String, sys: String, java: bool, tasks: Vec<Task>, marker: String, from: usize }
impl Ctx<'_> {
    fn add(&mut self, label: &str, desc: &str, program: &str, args: &[&str]) { self.add_s(label, desc, program, args.iter().map(|s| s.to_string()).collect(), false); }
    fn add_long(&mut self, label: &str, desc: &str, program: &str, args: &[&str]) { self.add_s(label, desc, program, args.iter().map(|s| s.to_string()).collect(), true); }
    fn add_s(&mut self, label: &str, desc: &str, program: &str, args: Vec<String>, long: bool) {
        let shown = Path::new(program).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| program.into());
        let line = format!("{} {}", shown, args.join(" ")).trim().to_string();
        let id = format!("{}#{}", self.sys, line);
        self.tasks.push(Task {
            id, label: label.into(), desc: desc.into(), system: self.sys.clone(), long,
            steps: vec![TaskStep { kind: "cmd".into(), label: line, args, program: program.into(), cwd: self.dir.to_string_lossy().into(), java: self.java, ..Default::default() }],
            ..Default::default()
        });
    }
}
fn read(dir: &Path, f: &str) -> String { read_text(&dir.join(f), 1024 * 1024) }
fn json_keys(v: &Value, key: &str) -> Vec<String> { v[key].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default() }
macro_rules! re { ($s:expr) => {{ static R: LazyLock<Regex> = LazyLock::new(|| Regex::new($s).unwrap()); &*R }}; }
fn long_running(name: &str) -> bool { re!(r"(?i)^(start|serve|dev|watch|preview)(:|$)").is_match(name) }

/// Um sistema de build numa pasta: devolve (nome, ferramenta, disponível, nota) e acrescenta as tarefas em `c`.
type Detector = fn(&mut Ctx, &HashSet<String>) -> Option<(String, String, bool, Option<String>)>;

fn has_ext(names: &HashSet<String>, exts: &[&str]) -> Option<String> {
    let mut v: Vec<&String> = names.iter().filter(|n| exts.iter().any(|e| n.to_lowercase().ends_with(e))).collect();
    v.sort();
    v.first().map(|s| s.to_string())
}

fn gradle(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    c.marker = ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"].into_iter().find(|f| n.contains(*f))?.into();
    c.java = true;
    let wrapper = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
    let (prog, ok) = if n.contains(wrapper) { (c.dir.join(wrapper).to_string_lossy().into_owned(), true) } else { first_tool(&["gradle"]) };
    let script = read(c.dir, "build.gradle") + &read(c.dir, "build.gradle.kts");
    for (l, d, a) in [("Build", "compila, testa e empacota", "build"), ("Compilar", "só compila", "classes"), ("Testes", "roda os testes", "test"), ("Empacotar", "gera os artefatos sem testar", "assemble"), ("Verificar", "testes e checagens", "check"), ("Limpar", "apaga build/", "clean"), ("Dependências", "árvore de dependências", "dependencies"), ("Listar tarefas", "todas as tarefas do Gradle", "tasks")] {
        c.add(l, d, &prog, &[a]);
    }
    if script.contains("org.springframework.boot") { c.add_long("Spring Boot", "sobe a aplicação", &prog, &["bootRun"]); }
    // o plugin application (id 'application', apply plugin: 'application'), não qualquer "application" (com.android.application)
    else if re!(r#"(?m)\bid\s*\(?\s*["']application["']|apply\s+plugin\s*:\s*["']application["']|^\s*application\s*\{"#).is_match(&script) { c.add_long("Executar", "plugin application", &prog, &["run"]); }
    if script.contains("com.android") { c.add("APK debug", "gera o APK", &prog, &["assembleDebug"]); }
    Some(("Gradle".into(), prog, ok, (!ok).then(|| "Gradle não encontrado (nem gradlew no projeto)".into())))
}
fn maven_generic(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    // pom.xml fora da raiz do checkout (o da raiz já tem o Maven completo, com escolha de Maven, JDK e repositório)
    if !n.contains("pom.xml") { return None; }
    c.java = true;
    let wrapper = if cfg!(windows) { "mvnw.cmd" } else { "mvnw" };
    let (prog, ok) = if n.contains(wrapper) { (c.dir.join(wrapper).to_string_lossy().into_owned(), true) } else { first_tool(&["mvn"]) };
    for (l, d, a) in [("Compilar", "mvn compile", &["compile"][..]), ("Empacotar", "sem testes", &["package", "-DskipTests"][..]), ("Testes", "mvn test", &["test"][..]), ("Instalar", "no ~/.m2", &["install"][..]), ("Limpar", "apaga target/", &["clean"][..])] {
        let mut v = vec!["-B"]; v.extend_from_slice(a); c.add(l, d, &prog, &v);
    }
    Some(("Maven".into(), prog, ok, (!ok).then(|| "Maven não encontrado no PATH".into())))
}
fn node(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    if !n.contains("package.json") { return None; }
    c.marker = "package.json".into();
    let pj: Value = serde_json::from_str(&read(c.dir, "package.json")).unwrap_or_default();
    let declared = pj["packageManager"].as_str().unwrap_or("").split('@').next().unwrap_or("").to_string();
    let pm = if !declared.is_empty() { declared } else if n.contains("pnpm-lock.yaml") { "pnpm".into() } else if n.contains("yarn.lock") { "yarn".into() } else if n.contains("bun.lockb") || n.contains("bun.lock") { "bun".into() } else { "npm".into() };
    let ok = which(&pm).is_some();
    c.add("Instalar dependências", &format!("{pm} install"), &pm, &["install"]);
    let scripts = json_keys(&pj, "scripts");
    for s in scripts.iter().take(40) {
        let args: Vec<String> = if pm == "npm" || pm == "bun" { vec!["run".into(), s.clone()] } else { vec![s.clone()] };
        c.add_s(s, "script do package.json", &pm, args, long_running(s));
    }
    if n.contains("nx.json") { c.add("Nx: build de tudo", "nx run-many -t build", "npx", &["nx", "run-many", "-t", "build"]); }
    if n.contains("turbo.json") { c.add("Turbo: build", "turbo run build", "npx", &["turbo", "run", "build"]); }
    if n.contains("tsconfig.json") && !scripts.iter().any(|s| s == "typecheck") { c.add("Checar tipos", "tsc --noEmit", "npx", &["tsc", "--noEmit"]); }
    let name = match pm.as_str() { "pnpm" => "pnpm", "yarn" => "Yarn", "bun" => "Bun", _ => "npm" };
    Some((format!("{name} · {}", pj["name"].as_str().unwrap_or("package.json")), pm.clone(), ok, (!ok).then(|| format!("{pm} não encontrado (instale o Node.js)"))))
}
fn deno(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    let f = ["deno.json", "deno.jsonc"].into_iter().find(|f| n.contains(*f))?;
    c.marker = f.into();
    let txt = re!(r"(?m)^\s*//.*$").replace_all(&read(c.dir, f), "").into_owned();
    let v: Value = serde_json::from_str(&txt).unwrap_or_default();
    for t in json_keys(&v, "tasks") { c.add_s(&t, "tarefa do deno.json", "deno", vec!["task".into(), t.clone()], long_running(&t)); }
    c.add("Checar tipos", "deno check", "deno", &["check", "."]);
    c.add("Testes", "deno test", "deno", &["test"]);
    c.add("Lint", "deno lint", "deno", &["lint"]);
    let ok = which("deno").is_some();
    Some(("Deno".into(), "deno".into(), ok, None))
}
fn cargo(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    if !n.contains("Cargo.toml") { return None; }
    c.marker = "Cargo.toml".into();
    for (l, d, a) in [("Build", "cargo build", &["build"][..]), ("Build release", "otimizado", &["build", "--release"][..]), ("Testes", "cargo test", &["test"][..]), ("Checar", "cargo check", &["check"][..]), ("Clippy", "lint do Rust", &["clippy"][..]), ("Formatar", "cargo fmt", &["fmt"][..]), ("Limpar", "apaga target/", &["clean"][..])] { c.add(l, d, "cargo", a); }
    c.add_long("Executar", "cargo run", "cargo", &["run"]);
    Some(("Cargo (Rust)".into(), "cargo".into(), which("cargo").is_some(), None))
}
fn go(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    if !n.contains("go.mod") { return None; }
    c.marker = "go.mod".into();
    for (l, d, a) in [("Build", "go build ./...", &["build", "./..."][..]), ("Testes", "go test ./...", &["test", "./..."][..]), ("Vet", "análise estática", &["vet", "./..."][..]), ("Arrumar módulos", "go mod tidy", &["mod", "tidy"][..])] { c.add(l, d, "go", a); }
    c.add_long("Executar", "go run .", "go", &["run", "."]);
    Some(("Go".into(), "go".into(), which("go").is_some(), None))
}
fn dotnet(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    let f = has_ext(n, &[".slnx", ".sln"]).or_else(|| has_ext(n, &[".csproj", ".fsproj", ".vbproj"]))?;
    let is_proj = !f.ends_with(".sln") && !f.ends_with(".slnx");
    c.marker = f.clone();
    for (l, d, a) in [("Build", "dotnet build", "build"), ("Testes", "dotnet test", "test"), ("Restaurar", "pacotes NuGet", "restore"), ("Limpar", "dotnet clean", "clean")] { c.add(l, d, "dotnet", &[a, &f]); }
    c.add("Publicar", "Release", "dotnet", &["publish", &f, "-c", "Release"]);
    if is_proj { c.add_long("Executar", "dotnet run", "dotnet", &["run", "--project", &f]); }
    Some((format!(".NET · {f}"), "dotnet".into(), which("dotnet").is_some(), None))
}
fn python(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    let markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "tox.ini", "environment.yml"];
    if !markers.iter().any(|m| n.contains(*m)) && !n.iter().any(|f| f.starts_with("requirements") && f.ends_with(".txt")) { return None; }
    c.marker = markers.iter().find(|m| n.contains(**m)).map(|m| m.to_string()).or_else(|| n.iter().find(|f| f.starts_with("requirements")).cloned()).unwrap_or_default();
    let pp = read(c.dir, "pyproject.toml");
    let (py, ok_py) = if cfg!(windows) { first_tool(&["py", "python", "python3"]) } else { first_tool(&["python3", "python"]) };
    let tests = n.contains("pytest.ini") || pp.contains("pytest") || n.contains("tests") || n.contains("test");
    let (mgr, ok) = if n.contains("uv.lock") || pp.contains("[tool.uv]") {
        c.add("Sincronizar", "uv sync", "uv", &["sync"]); if tests { c.add("Testes", "pytest", "uv", &["run", "pytest"]); } c.add("Build", "uv build", "uv", &["build"]); ("uv", which("uv").is_some())
    } else if n.contains("poetry.lock") || pp.contains("[tool.poetry") {
        c.add("Instalar", "poetry install", "poetry", &["install"]); if tests { c.add("Testes", "pytest", "poetry", &["run", "pytest"]); } c.add("Build", "poetry build", "poetry", &["build"]); ("Poetry", which("poetry").is_some())
    } else if n.contains("pdm.lock") || pp.contains("[tool.pdm") {
        c.add("Instalar", "pdm install", "pdm", &["install"]); if tests { c.add("Testes", "pytest", "pdm", &["run", "pytest"]); } c.add("Build", "pdm build", "pdm", &["build"]); ("PDM", which("pdm").is_some())
    } else if pp.contains("[tool.hatch") {
        c.add("Testes", "hatch test", "hatch", &["test"]); c.add("Build", "hatch build", "hatch", &["build"]); ("Hatch", which("hatch").is_some())
    } else if n.contains("Pipfile") {
        c.add("Instalar", "pipenv install", "pipenv", &["install", "--dev"]); if tests { c.add("Testes", "pytest", "pipenv", &["run", "pytest"]); } ("Pipenv", which("pipenv").is_some())
    } else if n.contains("environment.yml") {
        c.add("Criar ambiente", "conda env create", "conda", &["env", "create", "-f", "environment.yml"]); ("Conda", which("conda").is_some())
    } else {
        let mut reqs: Vec<&String> = n.iter().filter(|f| f.starts_with("requirements") && f.ends_with(".txt")).collect(); reqs.sort();
        for r in reqs { c.add(&format!("pip install -r {r}"), "instala dependências", &py, &["-m", "pip", "install", "-r", r]); }
        if n.contains("pyproject.toml") || n.contains("setup.py") { c.add("Instalar o projeto", "pip install -e .", &py, &["-m", "pip", "install", "-e", "."]); c.add("Build", "python -m build", &py, &["-m", "build"]); }
        if tests { c.add("Testes", "pytest", &py, &["-m", "pytest"]); }
        ("pip", ok_py)
    };
    if n.contains("tox.ini") { c.add("Tox", "testes em vários ambientes", "tox", &[]); }
    if n.contains("manage.py") { c.add_long("Django: servidor", "runserver", &py, &["manage.py", "runserver"]); c.add("Django: testes", "manage.py test", &py, &["manage.py", "test"]); }
    Some((format!("Python · {mgr}"), mgr.to_lowercase(), ok, None))
}
fn make(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    let f = ["GNUmakefile", "Makefile", "makefile"].into_iter().find(|f| n.contains(*f))?;
    c.marker = f.into();
    let (prog, ok) = first_tool(&["make", "mingw32-make", "gmake"]);
    c.add("make", "alvo padrão", &prog, &[]);
    let txt = read(c.dir, f);
    let mut seen = HashSet::new();
    for m in re!(r"(?m)^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:([^=]|$)").captures_iter(&txt) {
        let t = m[1].to_string();
        if t.contains('.') && !t.contains('-') || !seen.insert(t.clone()) { continue; }
        c.add_s(&t, "alvo do Makefile", &prog, vec![t.clone()], long_running(&t));
        if seen.len() >= 30 { break; }
    }
    Some(("Make".into(), prog, ok, (!ok).then(|| "make não encontrado (instale via MSYS2, Git Bash ou Chocolatey)".into())))
}
fn cmake(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    if !n.contains("CMakeLists.txt") { return None; }
    c.marker = "CMakeLists.txt".into();
    let presets: Value = serde_json::from_str(&read(c.dir, "CMakePresets.json")).unwrap_or_default();
    let cfg: Vec<String> = presets["configurePresets"].as_array().map(|a| a.iter().filter(|p| p["hidden"] != Value::Bool(true)).filter_map(|p| p["name"].as_str().map(String::from)).collect()).unwrap_or_default();
    if cfg.is_empty() {
        c.add("Configurar", "cmake -B build", "cmake", &["-S", ".", "-B", "build"]);
        c.add("Build", "cmake --build build", "cmake", &["--build", "build"]);
        c.add("Testes", "ctest", "ctest", &["--test-dir", "build", "--output-on-failure"]);
        c.add("Limpar", "alvo clean", "cmake", &["--build", "build", "--target", "clean"]);
    } else {
        for p in &cfg { c.add(&format!("Configurar ({p})"), "preset do CMake", "cmake", &["--preset", p]); }
        let builds: Vec<String> = presets["buildPresets"].as_array().map(|a| a.iter().filter_map(|p| p["name"].as_str().map(String::from)).collect()).unwrap_or_default();
        for p in &builds { c.add(&format!("Build ({p})"), "preset de build", "cmake", &["--build", "--preset", p]); }
    }
    Some(("CMake".into(), "cmake".into(), which("cmake").is_some(), None))
}
fn simple(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    // sistemas com tarefas fixas: (marca, nome, programa, java, [(rótulo, args, longo)])
    type T = (&'static str, &'static [&'static str], bool);
    let table: &[(&[&str], &str, &str, bool, &[T])] = &[
        (&["meson.build"], "Meson", "meson", false, &[("Configurar", &["setup", "builddir"], false), ("Build", &["compile", "-C", "builddir"], false), ("Testes", &["test", "-C", "builddir"], false)]),
        (&["build.ninja"], "Ninja", "ninja", false, &[("Build", &[], false), ("Limpar", &["-t", "clean"], false)]),
        (&["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"], "Bazel", "bazel", false, &[("Build", &["build", "//..."], false), ("Testes", &["test", "//..."], false), ("Alvos", &["query", "//..."], false)]),
        (&[".buckconfig"], "Buck2", "buck2", false, &[("Build", &["build", "//..."], false), ("Testes", &["test", "//..."], false)]),
        (&["pants.toml"], "Pants", "pants", false, &[("Testes", &["test", "::"], false), ("Empacotar", &["package", "::"], false), ("Lint", &["lint", "::"], false)]),
        (&["build.sbt"], "sbt (Scala)", "sbt", true, &[("Compilar", &["compile"], false), ("Testes", &["test"], false), ("Empacotar", &["package"], false), ("Limpar", &["clean"], false), ("Executar", &["run"], true)]),
        (&["build.mill", "build.sc"], "Mill", "mill", true, &[("Compilar", &["__.compile"], false), ("Testes", &["__.test"], false)]),
        (&["project.clj"], "Leiningen (Clojure)", "lein", true, &[("Compilar", &["compile"], false), ("Testes", &["test"], false), ("Uberjar", &["uberjar"], false), ("Executar", &["run"], true)]),
        (&["deps.edn"], "Clojure CLI", "clojure", true, &[("Baixar dependências", &["-P"], false), ("Testes", &["-X:test"], false)]),
        (&["mix.exs"], "Mix (Elixir)", "mix", false, &[("Dependências", &["deps.get"], false), ("Compilar", &["compile"], false), ("Testes", &["test"], false), ("Formatar", &["format"], false), ("Phoenix: servidor", &["phx.server"], true)]),
        (&["rebar.config"], "rebar3 (Erlang)", "rebar3", false, &[("Compilar", &["compile"], false), ("EUnit", &["eunit"], false), ("Common Test", &["ct"], false), ("Release", &["release"], false)]),
        (&["Package.swift"], "SwiftPM", "swift", false, &[("Build", &["build"], false), ("Testes", &["test"], false), ("Executar", &["run"], true)]),
        (&["stack.yaml"], "Stack (Haskell)", "stack", false, &[("Build", &["build"], false), ("Testes", &["test"], false), ("Executar", &["run"], true)]),
        (&["cabal.project"], "Cabal (Haskell)", "cabal", false, &[("Build", &["build", "all"], false), ("Testes", &["test", "all"], false)]),
        (&["dune-project"], "Dune (OCaml)", "dune", false, &[("Build", &["build"], false), ("Testes", &["test"], false), ("Limpar", &["clean"], false)]),
        (&["build.zig"], "Zig", "zig", false, &[("Build", &["build"], false), ("Testes", &["build", "test"], false), ("Executar", &["build", "run"], true)]),
        (&["shard.yml"], "Crystal", "shards", false, &[("Instalar", &["install"], false), ("Build", &["build"], false)]),
        (&["Gemfile"], "Bundler (Ruby)", "bundle", false, &[("Instalar", &["install"], false), ("RSpec", &["exec", "rspec"], false)]),
        (&["xmake.lua"], "xmake", "xmake", false, &[("Build", &[], false), ("Executar", &["run"], true), ("Testes", &["test"], false)]),
        (&["SConstruct"], "SCons", "scons", false, &[("Build", &[], false), ("Limpar", &["-c"], false)]),
        (&["premake5.lua"], "Premake", "premake5", false, &[("Gerar VS 2022", &["vs2022"], false), ("Gerar Makefiles", &["gmake2"], false)]),
        (&["vcpkg.json"], "vcpkg", "vcpkg", false, &[("Instalar dependências", &["install"], false)]),
        (&["conanfile.txt", "conanfile.py"], "Conan", "conan", false, &[("Instalar dependências", &["install", ".", "--build=missing"], false)]),
        (&["Chart.yaml"], "Helm", "helm", false, &[("Lint", &["lint", "."], false), ("Template", &["template", "."], false)]),
        (&["mkdocs.yml"], "MkDocs", "mkdocs", false, &[("Build", &["build"], false), ("Servidor", &["serve"], true)]),
        (&["hugo.toml", "hugo.yaml"], "Hugo", "hugo", false, &[("Build", &[], false), ("Servidor", &["server"], true)]),
        (&["Makefile.PL"], "Perl (MakeMaker)", "perl", false, &[("Configurar", &["Makefile.PL"], false)]),
        (&["cpanfile"], "Perl (cpanm)", "cpanm", false, &[("Instalar dependências", &["--installdeps", "."], false)]),
        (&["project.godot"], "Godot", "godot", false, &[("Abrir no editor", &["--editor", "--path", "."], true)]),
        (&["Project.toml"], "Julia", "julia", false, &[("Instanciar", &["--project", "-e", "using Pkg; Pkg.instantiate()"], false), ("Testes", &["--project", "-e", "using Pkg; Pkg.test()"], false)]),
        (&["DESCRIPTION"], "R (pacote)", "R", false, &[("Build", &["CMD", "build", "."], false), ("Check", &["CMD", "check", "."], false)]),
        (&["elm.json"], "Elm", "elm", false, &[("Build", &["make", "src/Main.elm", "--output=main.js"], false)]),
        (&["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"], "Docker Compose", "docker", false, &[("Subir", &["compose", "up", "-d", "--build"], false), ("Derrubar", &["compose", "down"], false), ("Status", &["compose", "ps"], false), ("Logs", &["compose", "logs", "-f"], true)]),
    ];
    for (i, (marks, name, prog, java, tasks)) in table.iter().enumerate().skip(c.from) {
        if let Some(m) = marks.iter().find(|m| n.contains(**m)) {
            // Project.toml é do Julia só se não for de outro sistema; DESCRIPTION só se for pacote R
            if *m == "DESCRIPTION" && !read(c.dir, m).contains("Package:") { continue; }
            c.java = *java;
            c.marker = m.to_string();
            for (l, a, long) in tasks.iter() { if *long { c.add_long(l, name, prog, a) } else { c.add(l, name, prog, a) } }
            c.sys = format!("{}:{}", name.to_lowercase().split(' ').next().unwrap_or(name), c.rel);
            c.from = i + 1; // a pasta pode ter outro sistema da tabela (compose.yaml junto do Gemfile)
            return Some((name.to_string(), prog.to_string(), which(prog).is_some(), None));
        }
    }
    None
}
fn extra_files(c: &mut Ctx, n: &HashSet<String>) -> Option<(String, String, bool, Option<String>)> {
    // tarefas declaradas em arquivos de tarefas: Ant, Rake, composer, just, Taskfile, Docker, Terraform, LaTeX
    let before = c.tasks.len(); let mut names = vec![];
    if n.contains("build.xml") {
        let x = read(c.dir, "build.xml");
        if x.contains("<project") {
            c.java = true; names.push("Ant");
            for m in re!(r#"<target\s[^>]*name="([^"]+)""#).captures_iter(&x).take(30) { c.add(&m[1], "alvo do Ant", "ant", &[&m[1]]); }
            c.java = false;
        }
    }
    if let Some(f) = ["Rakefile", "rakefile", "Rakefile.rb"].into_iter().find(|f| n.contains(*f)) {
        names.push("Rake");
        let x = read(c.dir, f); c.add("rake", "tarefa padrão", "rake", &[]);
        for m in re!(r#"(?m)^\s*task\s+[:"']?([A-Za-z0-9_:-]+)"#).captures_iter(&x).take(25) { c.add(&m[1], "tarefa do Rake", "rake", &[&m[1]]); }
    }
    if n.contains("composer.json") {
        names.push("Composer");
        let v: Value = serde_json::from_str(&read(c.dir, "composer.json")).unwrap_or_default();
        c.add("Instalar", "composer install", "composer", &["install"]);
        for s in json_keys(&v, "scripts").iter().take(25) { c.add(s, "script do composer.json", "composer", &["run-script", s]); }
        if n.contains("artisan") { c.add("Laravel: testes", "php artisan test", "php", &["artisan", "test"]); c.add_long("Laravel: servidor", "php artisan serve", "php", &["artisan", "serve"]); }
    }
    if let Some(f) = ["justfile", "Justfile", ".justfile"].into_iter().find(|f| n.contains(*f)) {
        names.push("just");
        let x = read(c.dir, f);
        for m in re!(r"(?m)^@?([A-Za-z0-9_-]+)(\s+[^:=\n]*)?:([^=]|$)").captures_iter(&x).take(30) { c.add(&m[1], "receita do justfile", "just", &[&m[1]]); }
    }
    if let Some(f) = ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml"].into_iter().find(|f| n.contains(*f)) {
        names.push("Task");
        let x = read(c.dir, f);
        if let Some(i) = x.find("\ntasks:") { for m in re!(r"(?m)^  ([A-Za-z0-9_:-]+):").captures_iter(&x[i..]).take(30) { c.add(&m[1], "tarefa do Taskfile", "task", &[&m[1]]); } }
    }
    if n.contains("Dockerfile") {
        names.push("Docker");
        let tag = c.dir.file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_else(|| "app".into());
        c.add("Docker: imagem", "docker build", "docker", &["build", "-t", &tag, "."]);
    }
    if n.iter().any(|f| f.ends_with(".tf")) {
        names.push("Terraform");
        for (l, a) in [("Init", &["init"][..]), ("Validar", &["validate"][..]), ("Plan", &["plan"][..]), ("Formatar", &["fmt", "-recursive"][..])] { c.add(l, "Terraform", "terraform", a); }
    }
    let mut texs: Vec<&String> = n.iter().filter(|f| f.ends_with(".tex")).collect(); texs.sort();
    for t in texs.into_iter().filter(|t| read(c.dir, t).contains("\\documentclass")).take(3) { names.push("LaTeX"); c.add(&format!("PDF de {t}"), "latexmk", "latexmk", &["-pdf", t]); }
    if c.tasks.len() == before { return None; }
    c.marker = ["build.xml", "Rakefile", "composer.json", "justfile", "Taskfile.yml", "Dockerfile"].into_iter().find(|f| n.contains(*f)).unwrap_or("").into();
    names.dedup();
    Some((names.join(" · "), String::new(), true, None))
}

const DETECTORS: &[Detector] = &[gradle, node, deno, cargo, go, dotnet, python, cmake, make, simple, extra_files];

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bs-detect-{tag}-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap(); d
    }
    #[test]
    fn ids_estaveis() {
        let d = tmp("ids");
        std::fs::write(d.join("package.json"), r#"{"scripts":{"build":"tsc","dev":"vite"}}"#).unwrap();
        let (s1, t1) = detect(&d, None);
        let npm = s1.iter().find(|s| s.file == "package.json").expect("sistema do package.json");
        assert!(npm.id.ends_with("@package.json"), "{}", npm.id);
        let dev = t1.iter().find(|t| t.label == "dev").unwrap();
        assert!(dev.long && dev.id.starts_with(&npm.id));
        // uma pasta nova com outro sistema, achada antes na varredura: o id do npm e o da tarefa não mudam
        std::fs::create_dir_all(d.join("aaa")).unwrap();
        std::fs::write(d.join("aaa").join("go.mod"), "module x\n").unwrap();
        std::fs::write(d.join("Makefile"), "all:\n\techo\n").unwrap();
        let (s2, t2) = detect(&d, None);
        assert!(s2.len() > s1.len());
        assert_eq!(s2.iter().find(|s| s.file == "package.json").unwrap().id, npm.id);
        assert!(t2.iter().any(|t| t.id == dev.id));
        // ids únicos
        let mut ids: Vec<&str> = s2.iter().map(|s| s.id.as_str()).collect(); ids.sort(); ids.dedup();
        assert_eq!(ids.len(), s2.len());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn varios_sistemas_na_mesma_pasta() {
        let d = tmp("multi");
        std::fs::write(d.join("Gemfile"), "source 'x'\n").unwrap();
        std::fs::write(d.join("compose.yaml"), "services: {}\n").unwrap();
        let (s, _) = detect(&d, None);
        assert!(s.iter().any(|x| x.name.starts_with("Bundler")));
        assert!(s.iter().any(|x| x.name == "Docker Compose"));
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// Id do sistema pelo que ele é e onde está ("npm@web/package.json"), não pela ordem em que foi achado: criar uma
/// pasta ou um arquivo no projeto não troca a tarefa que "Executar de novo" e os grupos recolhidos lembram.
fn sys_id(systems: &[System], name: &str, file: &str) -> String {
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>().split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    let base = format!("{slug}@{file}");
    let (mut id, mut n) = (base.clone(), 1);
    while systems.iter().any(|s| s.id == id) { n += 1; id = format!("{base}~{n}"); }
    id
}

/// Varre a pasta aberta (e subpastas até 2 níveis) e devolve os sistemas de build e as tarefas de cada um.
/// `skip_maven_root`: o pom.xml dessa pasta já é tratado pelo Maven completo (com escolha de Maven, JDK e repositório).
pub fn detect(project: &Path, skip_maven_root: Option<&Path>) -> (Vec<System>, Vec<Task>) {
    let mut dirs = vec![(project.to_path_buf(), String::new())];
    fn walk(d: &Path, rel: &str, depth: u32, out: &mut Vec<(PathBuf, String)>) {
        if depth > 2 || out.len() > 400 { return; }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') || IGNORED_DIRS.contains(n.as_str()) || matches!(n.as_str(), "src" | "test" | "tests" | "docs" | "vendor" | "bin" | "obj" | "out" | "venv" | "env") { continue; }
            let r = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
            out.push((e.path(), r.clone()));
            walk(&e.path(), &r, depth + 1, out);
        }
    }
    walk(project, "", 1, &mut dirs);
    let (mut systems, mut tasks) = (vec![], vec![]);
    for (dir, rel) in dirs {
        let names: HashSet<String> = std::fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        if names.is_empty() { continue; }
        for det in DETECTORS {
            let mut from = 0;
            loop {
                let mut c = Ctx { dir: &dir, rel: rel.clone(), sys: String::new(), java: false, tasks: vec![], marker: String::new(), from };
                c.sys = format!("{}:{rel}", systems.len());
                let Some((name, tool, available, note)) = det(&mut c, &names) else { break };
                let marker = c.marker.clone();
                let file = if rel.is_empty() { marker } else { format!("{rel}/{marker}") }.trim_end_matches('/').to_string();
                let id = sys_id(&systems, &name, &file);
                for t in c.tasks.iter_mut() { t.system = id.clone(); t.id = format!("{id}#{}", t.steps[0].label); }
                systems.push(System { id, name, file, tool, available, note });
                tasks.extend(c.tasks);
                // só o `simple` continua (um sistema por chamada); os outros acham um por pasta
                if c.from <= from { break; }
                from = c.from;
            }
        }
        // pom.xml de submódulo (não o da raiz do Maven completo): tarefas genéricas com mvn/mvnw
        if names.contains("pom.xml") && skip_maven_root.is_none_or(|r| absolute(r) != absolute(&dir)) && !rel.is_empty() && !names.contains("mvnw.cmd") { continue; }
        if names.contains("pom.xml") && skip_maven_root.is_none_or(|r| absolute(r) != absolute(&dir)) && (rel.is_empty() || names.contains("mvnw.cmd")) {
            let mut c = Ctx { dir: &dir, rel: rel.clone(), sys: String::new(), java: true, tasks: vec![], marker: "pom.xml".into(), from: 0 };
            if let Some((name, tool, available, note)) = maven_generic(&mut c, &names) {
                let file = if rel.is_empty() { "pom.xml".into() } else { format!("{rel}/pom.xml") };
                let id = sys_id(&systems, &name, &file);
                for t in c.tasks.iter_mut() { t.system = id.clone(); t.id = format!("{id}#{}", t.steps[0].label); }
                systems.push(System { id, name, file, tool, available, note });
                tasks.extend(c.tasks);
            }
        }
        if systems.len() > 40 { break; }
    }
    (systems, tasks)
}

// ---------- executar um arquivo solto ----------
/// Passos para executar um arquivo pela extensão (Python, Node, Java, Go, C#, Ruby, PHP, C/C++...).
pub fn run_file(project: &Path, rel: &str) -> Option<(String, Vec<TaskStep>)> {
    let abs = project.join(rel);
    let f = abs.to_string_lossy().to_string();
    let dir = abs.parent().unwrap_or(project).to_string_lossy().to_string();
    let ext = Path::new(rel).extension()?.to_string_lossy().to_lowercase();
    let exe = std::env::temp_dir().join(format!("bluescreen-run{}", if cfg!(windows) { ".exe" } else { "" })).to_string_lossy().to_string();
    let py = if cfg!(windows) { first_tool(&["py", "python"]).0 } else { "python3".into() };
    let step = |program: &str, args: Vec<String>| TaskStep { kind: "cmd".into(), label: format!("{} {}", program, args.join(" ")), args, program: program.into(), cwd: dir.clone(), ..Default::default() };
    let one = |program: &str, args: &[&str]| vec![step(program, args.iter().map(|a| a.replace("{f}", &f)).collect())];
    let steps: Vec<TaskStep> = match ext.as_str() {
        "py" | "pyw" => one(&py, &["{f}"]),
        "js" | "mjs" | "cjs" => one("node", &["{f}"]),
        "ts" | "mts" | "cts" | "tsx" => if which("deno").is_some() { one("deno", &["run", "-A", "{f}"]) } else if which("bun").is_some() { one("bun", &["run", "{f}"]) } else { one("npx", &["tsx", "{f}"]) },
        "java" => { let mut s = one("java", &["{f}"]); s[0].java = true; s } // Java 11+: roda o arquivo direto
        "kts" => one("kotlin", &["{f}"]),
        "kt" => vec![step("kotlinc", vec![f.clone(), "-include-runtime".into(), "-d".into(), exe.replace(".exe", ".jar")]), step("java", vec!["-jar".into(), exe.replace(".exe", ".jar")])],
        "groovy" => one("groovy", &["{f}"]),
        "scala" | "sc" => one("scala-cli", &["run", "{f}"]),
        "go" => one("go", &["run", "{f}"]),
        "cs" => one("dotnet", &["run", "{f}"]), // .NET 10: dotnet run arquivo.cs
        "fsx" => one("dotnet", &["fsi", "{f}"]),
        "rs" => vec![step("rustc", vec![f.clone(), "-o".into(), exe.clone()]), step(&exe, vec![])],
        "c" => vec![step(&first_tool(&["gcc", "clang"]).0, vec![f.clone(), "-o".into(), exe.clone()]), step(&exe, vec![])],
        "cpp" | "cc" | "cxx" => vec![step(&first_tool(&["g++", "clang++"]).0, vec![f.clone(), "-std=c++20".into(), "-o".into(), exe.clone()]), step(&exe, vec![])],
        "zig" => one("zig", &["run", "{f}"]),
        "nim" => one("nim", &["r", "{f}"]),
        "cr" => one("crystal", &["run", "{f}"]),
        "d" => one("rdmd", &["{f}"]),
        "swift" => one("swift", &["{f}"]),
        "dart" => one("dart", &["run", "{f}"]),
        "rb" => one("ruby", &["{f}"]),
        "php" => one("php", &["{f}"]),
        "pl" => one("perl", &["{f}"]),
        "lua" => one(&first_tool(&["lua", "luajit", "lua54"]).0, &["{f}"]),
        "r" => one("Rscript", &["{f}"]),
        "jl" => one("julia", &["{f}"]),
        "exs" | "ex" => one("elixir", &["{f}"]),
        "erl" => one("escript", &["{f}"]),
        "hs" => one("runghc", &["{f}"]),
        "ml" => one("ocaml", &["{f}"]),
        "clj" => one("clojure", &["-M", "{f}"]),
        "fs" => one("dotnet", &["fsi", "{f}"]),
        "ps1" => one("powershell", &["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "{f}"]),
        "sh" | "bash" => one("bash", &["{f}"]),
        // o próprio .bat/.cmd como programa: o Rust chama o cmd com as aspas e escapes certos (um caminho com espaço,
        // & ou % quebrava ou virava outro comando no "cmd /c")
        "bat" | "cmd" => vec![step(&f, vec![])],
        "vbs" => one("cscript", &["//nologo", "{f}"]),
        "sql" => return None,
        "tex" => one("latexmk", &["-pdf", "{f}"]),
        _ => return None,
    };
    let title = format!("Executar {}", Path::new(rel).file_name()?.to_string_lossy());
    Some((title, steps))
}
