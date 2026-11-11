//! SDKs e runtimes baixados pela própria IDE, como o "Download JDK" do IntelliJ: você escolhe a linguagem, o
//! fornecedor e a versão, e a IDE baixa o pacote oficial, confere a soma publicada e extrai. Não usa instalador nem
//! pede administrador.
//! - JDKs vão para ~/.jdks/<fornecedor>-<versão>, a mesma pasta do IntelliJ (um enxerga os JDKs do outro);
//! - o resto vai para ~/.bluescreen/sdks/<tipo>/<versão>;
//! - Rust é instalado pelo rustup (~/.cargo, ~/.rustup), que é como a própria linguagem se instala.
//! O SDK padrão de cada tipo entra no PATH de tudo o que a IDE abre (terminal, build, servidores de linguagem,
//! instalações) e nas buscas de programas (which). Runtimes que a IDE não baixa (Ruby, PHP, Perl, Dart...) podem ser
//! apontados à mão numa pasta já instalada (`paths` no sdks.json, rota sdk/path) e entram no PATH do mesmo jeito. Assim as receitas dos servidores de linguagem ("npm i -g",
//! "pip install", "go install", "dotnet tool install") funcionam mesmo sem nada instalado no Windows.
//! As listas de versões vêm ao vivo das fontes oficiais:
//!   - JDK: api.foojay.io (Temurin, Microsoft, Corretto, Zulu, Liberica, GraalVM, Oracle, SapMachine, Semeru, JBR...)
//!   - Maven: Maven Central · Gradle: services.gradle.org · Node.js: nodejs.org/dist · Python: python-build-standalone
//!     (o mesmo do uv) · Go: go.dev/dl · .NET: builds.dotnet.microsoft.com · Zig: ziglang.org · Kotlin: GitHub
use crate::build::detect::which;
use crate::install::{Sum, begin, fetch, finish, line, upd};
use crate::util::{absolute, read_json, read_json_strict, user_dir, within, write_atomic};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

pub struct Kind {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    /// pastas (relativas à do SDK) que entram no PATH
    bins: &'static [&'static str],
    /// programa que prova que o SDK está ali (e que acha o do sistema)
    probe: &'static str,
    /// o pacote tem uma pasta só por fora (node-v24-win-x64/, go/, jdk-25+7/...)
    flatten: bool,
}
const fn k(id: &'static str, name: &'static str, desc: &'static str, bins: &'static [&'static str], probe: &'static str, flatten: bool) -> Kind {
    Kind { id, name, desc, bins, probe, flatten }
}
pub const KINDS: &[Kind] = &[
    k("jdk", "Java (JDK)", "Temurin, Microsoft, Corretto, Zulu, Liberica, GraalVM, Oracle e outros", &["bin"], "java", true),
    k("maven", "Maven", "build de projetos Java (pom.xml)", &["bin"], "mvn", true),
    k("gradle", "Gradle", "build de projetos Java, Kotlin e Android", &["bin"], "gradle", true),
    k("node", "Node.js", "JavaScript e TypeScript, com npm e npx", &[""], "node", true),
    k("python", "Python", "CPython com pip (python-build-standalone)", &["", "Scripts"], "python", true),
    k("go", "Go", "compilador e ferramentas do Go", &["bin"], "go", true),
    k("dotnet", ".NET SDK", "C#, F# e VB (dotnet)", &[""], "dotnet", false),
    k("rust", "Rust", "rustc e cargo pelo rustup", &[], "cargo", false),
    k("zig", "Zig", "compilador Zig (também compila C e C++)", &[""], "zig", true),
    k("kotlin", "Kotlin", "compilador de linha de comando (kotlinc)", &["bin"], "kotlinc", true),
];
pub fn find_kind(id: &str) -> Option<&'static Kind> { KINDS.iter().find(|k| k.id == id) }

/// onde a IDE guarda os SDKs de um tipo
pub fn root(kind: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    match kind { "jdk" => home.join(".jdks"), "rust" => home.join(".cargo"), _ => user_dir().join("sdks").join(kind) }
}
fn cargo_bin() -> PathBuf { std::env::var_os("CARGO_HOME").map(PathBuf::from).unwrap_or_else(|| root("rust")).join("bin") }
fn exe(name: &str) -> String { if cfg!(windows) { format!("{name}.exe") } else { name.into() } }

/// "1.27.2" x "1.9.10" em ordem numérica
fn vkey(s: &str) -> Vec<u64> { s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).map(|x| x.parse().unwrap_or(0)).collect() }
/// `p` dentro de `base`, com ".." resolvido (comparar o texto deixava "...\.jdks\..\Documents" passar)
fn under(p: &Path, base: &Path) -> bool { within(base, p) }
/// SDK que a IDE baixou: uma pasta logo abaixo de root(kind), nunca a própria nem algo mais fundo ou fora
fn managed_dir(p: &Path, kind: &str) -> bool {
    let (p, base) = (absolute(p), absolute(&root(kind)));
    p.parent().is_some_and(|d| within(&base, d) && within(d, &base)) && p.file_name().is_some()
}

// ---------- padrão de cada tipo (~/.bluescreen/sdks.json: { tipo: pasta }) ----------
fn defaults_file() -> PathBuf { user_dir().join("sdks.json") }
fn explicit_default(kind: &str) -> Option<PathBuf> { read_json(&defaults_file())[kind].as_str().filter(|s| !s.is_empty()).map(PathBuf::from).filter(|p| p.is_dir()) }
/// SDK escolhido à mão para um tipo (Usar como padrão, ou uma pasta apontada pelo plugin runtimes)
pub fn chosen(kind: &str) -> Option<PathBuf> { explicit_default(kind) }
/// pastas de programas apontadas à mão para runtimes que a IDE não baixa: { "paths": { "ruby": "C:\\Ruby33\\bin" } }
pub fn extra_paths() -> Vec<(String, PathBuf)> {
    read_json(&defaults_file())["paths"].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), PathBuf::from(v.as_str()?)))).filter(|(_, p)| p.is_dir()).collect()).unwrap_or_default()
}
/// sdks.json para mudar e gravar: ilegível é erro (gravar por cima perderia os outros padrões)
fn defaults_for_edit() -> Result<Value, String> {
    match read_json_strict(&defaults_file()).map_err(|e| e.to_string())? { v @ Value::Object(_) => Ok(v), Value::Null => Ok(json!({})), _ => Err(format!("{} não é um objeto JSON; conserte ou apague o arquivo", defaults_file().display())) }
}
/// aponta (ou esquece, com path vazio) a pasta de programas de um runtime que a IDE não baixa
pub fn set_path(name: &str, path: &str) -> Result<(), String> {
    if name.is_empty() || find_kind(name).is_some() { return Err("use sdk/default para os SDKs que a IDE baixa".into()); }
    if !path.is_empty() && !Path::new(path).is_dir() { return Err(format!("a pasta {path} não existe")); }
    let mut v = defaults_for_edit()?;
    if !v["paths"].is_object() { v["paths"] = json!({}); }
    if path.is_empty() { v["paths"].as_object_mut().map(|o| o.remove(name)); } else { v["paths"][name] = json!(path); }
    write_atomic(&defaults_file(), &serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())?;
    crate::build::detect::forget_which();
    Ok(())
}
pub fn set_default(kind: &str, path: &str) -> Result<(), String> {
    kind_of(kind)?;
    if !path.is_empty() && !Path::new(path).is_dir() { return Err(format!("a pasta {path} não existe")); }
    let mut v = defaults_for_edit()?;
    if path.is_empty() { v.as_object_mut().map(|o| o.remove(kind)); } else { v[kind] = json!(path); }
    write_atomic(&defaults_file(), &serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())?;
    crate::build::detect::forget_which();
    Ok(())
}
/// pastas baixadas pela IDE para um tipo (a mais nova primeiro)
fn managed(kind: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(root(kind)).map(|rd| rd.flatten().map(|e| e.path())
        .filter(|p| p.is_dir() && !p.extension().is_some_and(|e| e == "new" || e == "download" || e == "old")).collect()).unwrap_or_default();
    v.sort_by(|a, b| vkey(&b.to_string_lossy()).cmp(&vkey(&a.to_string_lossy())));
    v
}
/// SDK em uso de um tipo: o escolhido, senão o mais novo baixado pela IDE. O JDK só entra quando escolhido (o JDK do
/// sistema e o JAVA_HOME continuam valendo, como no IntelliJ).
pub fn default_dir(kind: &str) -> Option<PathBuf> {
    explicit_default(kind).or_else(|| if kind == "jdk" || kind == "rust" { None } else { managed(kind).into_iter().next() })
}
/// pastas dos SDKs padrão que entram no PATH (as que existem)
pub fn path_dirs() -> Vec<PathBuf> {
    KINDS.iter().filter_map(|k| default_dir(k.id).map(|d| (k, d))).flat_map(|(k, d)| k.bins.iter().map(move |b| if b.is_empty() { d.clone() } else { d.join(b) }))
        .chain(extra_paths().into_iter().map(|(_, p)| p))
        .filter(|p| p.is_dir()).collect()
}
/// variáveis para os processos que a IDE abre: PATH com os SDKs na frente, DOTNET_ROOT, JAVA_HOME (se escolhido)
pub fn env() -> Vec<(String, String)> {
    let mut dirs = path_dirs();
    if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
    let mut out = vec![("PATH".to_string(), std::env::join_paths(dirs).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())];
    if let Some(d) = default_dir("dotnet") { out.push(("DOTNET_ROOT".into(), d.to_string_lossy().into())); }
    if let Some(d) = explicit_default("jdk") { out.push(("JAVA_HOME".into(), d.to_string_lossy().into())); }
    out
}
/// na abertura (antes de existir qualquer thread): os SDKs padrão já entram no PATH do próprio processo, então tudo o
/// que ele abrir (lint, git hooks, plugins) também os acha
pub fn apply_env_at_startup() {
    // SAFETY: chamado no começo do main, antes do runtime do tokio e de qualquer outra thread
    for (k, v) in env() { unsafe { std::env::set_var(k, v); } }
}

// ---------- o que está instalado ----------
#[derive(Serialize)]
pub struct Installed {
    pub version: String,
    pub path: String,
    /// baixado pela IDE (dá para remover)
    pub managed: bool,
    pub default: bool,
}
fn rustup() -> Option<PathBuf> { Some(cargo_bin().join(exe("rustup"))).filter(|p| p.is_file()).or_else(|| which("rustup")) }
fn run_out(prog: &Path, args: &[&str]) -> String {
    let mut c = std::process::Command::new(prog);
    c.args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    c.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}
pub fn installed(kind: &str) -> Vec<Installed> {
    let def = default_dir(kind).map(|p| p.to_string_lossy().to_lowercase());
    let is_def = |p: &Path| def.as_deref() == Some(p.to_string_lossy().to_lowercase().as_str());
    match kind {
        "jdk" => crate::build::jdks().into_iter().map(|j| {
            let p = PathBuf::from(&j.home);
            Installed { managed: under(&p, &root("jdk")), default: is_def(&p), version: j.name, path: j.home }
        }).collect(),
        "maven" => crate::build::mavens().into_iter().map(|m| {
            let p = PathBuf::from(&m.home);
            Installed { managed: under(&p, &root("maven")), default: is_def(&p), version: m.version, path: m.home }
        }).collect(),
        "rust" => {
            let Some(r) = rustup() else { return vec![] };
            // stable-x86_64-pc-windows-msvc (active, default)
            run_out(&r, &["toolchain", "list"]).lines().filter(|l| !l.trim().is_empty() && !l.contains("no installed toolchains")).map(|l| {
                let name = l.split_whitespace().next().unwrap_or("").to_string();
                Installed { default: l.contains("default"), managed: true, path: name.clone(), version: name }
            }).collect()
        }
        _ => {
            let k = kind_or(kind);
            let mut v: Vec<Installed> = managed(kind).into_iter().filter(|d| k.bins.iter().any(|b| d.join(b).join(exe(k.probe)).is_file() || d.join(b).join(format!("{}.cmd", k.probe)).is_file() || d.join(b).join(format!("{}.bat", k.probe)).is_file()))
                .map(|d| Installed { version: d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), default: is_def(&d), managed: true, path: d.to_string_lossy().into_owned() }).collect();
            // o do sistema (o que estava no PATH antes da IDE): aparece para você saber que existe, sem remover
            let sdk_dirs: Vec<PathBuf> = path_dirs();
            if let Some(p) = which(k.probe).filter(|p| !under(p, &root(kind)) && !sdk_dirs.iter().any(|d| p.parent() == Some(d.as_path()))) {
                // nome da pasta como versão (Python312, nodejs, dotnet...); a etiqueta "do sistema" vem da página
                let name = p.parent().filter(|d| !d.ends_with("bin")).or_else(|| p.parent().and_then(Path::parent)).and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                v.push(Installed { version: name, path: p.to_string_lossy().into_owned(), managed: false, default: false });
            }
            v
        }
    }
}
fn kind_or(id: &str) -> &'static Kind { find_kind(id).unwrap_or(&KINDS[0]) }

pub fn list() -> Value {
    json!({ "kinds": KINDS.iter().map(|k| json!({
        "id": k.id, "name": k.name, "desc": k.desc, "root": root(k.id).to_string_lossy(),
        "installed": installed(k.id), "explicit": explicit_default(k.id).is_some(),
    })).collect::<Vec<_>>() })
}

// ---------- versões disponíveis ----------
#[derive(Serialize, Clone, Default)]
pub struct Pkg {
    /// único dentro do tipo (é o que a página manda para instalar)
    pub id: String,
    pub version: String,
    /// JDK: fornecedor (id e nome)
    #[serde(skip_serializing_if = "String::is_empty")] pub vendor: String,
    #[serde(skip_serializing_if = "String::is_empty")] pub vendor_name: String,
    /// grupo na lista (25, 3.13, 24, 1.27...)
    pub major: String,
    pub lts: bool,
    /// pré-lançamento (rc, beta, preview)
    pub pre: bool,
    pub size: u64,
    /// nome da pasta de destino
    pub dir: String,
    #[serde(skip)] url: String,
    #[serde(skip)] sum: Option<(bool, String)>,
    /// soma (ou o pacote) a resolver na hora de instalar: foojay id, canal do .NET, SHASUMS do Node, .sha256 do Gradle
    #[serde(skip)] lazy: String,
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("BlueScreen-IDE").connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())
}
async fn get_json(c: &reqwest::Client, url: &str) -> Result<Value, String> {
    c.get(url).timeout(Duration::from_secs(40)).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("{}: {e}", host(url)))?
        .json().await.map_err(|e| format!("{}: {e}", host(url)))
}
async fn get_text(c: &reqwest::Client, url: &str) -> Result<String, String> {
    c.get(url).timeout(Duration::from_secs(40)).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("{}: {e}", host(url)))?
        .text().await.map_err(|e| format!("{}: {e}", host(url)))
}
fn host(url: &str) -> &str { url.split('/').nth(2).unwrap_or(url) }
fn s(v: &Value) -> String { v.as_str().unwrap_or("").to_string() }
fn major_of(v: &str, parts: usize) -> String { v.split('.').take(parts).collect::<Vec<_>>().join(".") }
fn is_pre(v: &str) -> bool { v.chars().any(|c| c.is_ascii_alphabetic()) }
/// "sha256:abc..." (campo digest dos assets do GitHub)
fn gh_digest(a: &Value) -> Option<(bool, String)> { a["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(|h| (false, h.to_string())) }

/// fornecedores de JDK mostrados (id do foojay, nome, prefixo da pasta como o IntelliJ usa em ~/.jdks)
const JDK_VENDORS: &[(&str, &str, &str)] = &[
    ("temurin", "Eclipse Temurin", "temurin"), ("microsoft", "Microsoft OpenJDK", "ms"), ("corretto", "Amazon Corretto", "corretto"),
    ("zulu", "Azul Zulu", "azul"), ("liberica", "BellSoft Liberica", "liberica"), ("graalvm_community", "GraalVM Community", "graalvm-ce"),
    ("graalvm", "Oracle GraalVM", "graalvm"), ("oracle", "Oracle JDK", "oracle"), ("oracle_open_jdk", "Oracle OpenJDK", "openjdk"),
    ("sap_machine", "SapMachine", "sap"), ("semeru", "IBM Semeru", "semeru"), ("jetbrains", "JetBrains Runtime", "jbr"),
    ("dragonwell", "Alibaba Dragonwell", "dragonwell"), ("kona", "Tencent Kona", "kona"), ("redhat", "Red Hat", "redhat"),
];

async fn catalog(kind: &str) -> Result<Vec<Pkg>, String> {
    let c = http()?;
    let mut out: Vec<Pkg> = vec![];
    match kind {
        "jdk" => {
            let v = get_json(&c, "https://api.foojay.io/disco/v3.0/packages?os=windows&arch=x64&archive_type=zip&package_type=jdk&latest=available&release_status=ga&javafx_bundled=false&directly_downloadable=true").await?;
            let mut seen = std::collections::HashSet::new();
            for p in v["result"].as_array().into_iter().flatten() {
                let dist = s(&p["distribution"]);
                let Some((_, vname, prefix)) = JDK_VENDORS.iter().find(|(id, ..)| *id == dist) else { continue };
                let file = s(&p["filename"]).to_lowercase();
                if file.contains("crac") || file.contains("-fx") || file.contains("debug") || file.contains("musl") { continue; }
                let major = p["major_version"].as_u64().unwrap_or(0);
                if major < 8 { continue; }
                let version = s(&p["java_version"]).split('+').next().unwrap_or("").to_string();
                if !seen.insert((dist.clone(), version.clone())) { continue; }
                out.push(Pkg {
                    id: s(&p["id"]), dir: format!("{prefix}-{version}"), version, vendor: dist.clone(), vendor_name: vname.to_string(),
                    major: major.to_string(), lts: p["term_of_support"].as_str() == Some("lts"), pre: false, size: p["size"].as_u64().unwrap_or(0),
                    lazy: s(&p["id"]), ..Default::default()
                });
            }
        }
        "maven" => {
            let xml = get_text(&c, "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml").await?;
            let re = regex::Regex::new(r"<version>([^<]+)</version>").unwrap();
            for v in re.captures_iter(&xml).map(|m| m[1].to_string()) {
                if vkey(&v) < vec![3, 6] { continue; }
                out.push(Pkg {
                    url: format!("https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/{v}/apache-maven-{v}-bin.zip"),
                    lazy: format!("https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/{v}/apache-maven-{v}-bin.zip.sha512"),
                    id: v.clone(), dir: format!("apache-maven-{v}"), major: major_of(&v, 2), pre: is_pre(&v), version: v, ..Default::default()
                });
            }
        }
        "gradle" => {
            let v = get_json(&c, "https://services.gradle.org/versions/all").await?;
            for g in v.as_array().into_iter().flatten() {
                if g["snapshot"].as_bool() == Some(true) || g["nightly"].as_bool() == Some(true) || g["releaseNightly"].as_bool() == Some(true) || g["broken"].as_bool() == Some(true) { continue; }
                let ver = s(&g["version"]);
                let pre = !s(&g["rcFor"]).is_empty() || !s(&g["milestoneFor"]).is_empty();
                if vkey(&ver) < vec![6] { continue; }
                out.push(Pkg { url: s(&g["downloadUrl"]), lazy: s(&g["checksumUrl"]), id: ver.clone(), dir: format!("gradle-{ver}"), major: major_of(&ver, 1), pre, version: ver, ..Default::default() });
            }
        }
        "node" => {
            let v = get_json(&c, "https://nodejs.org/dist/index.json").await?;
            for n in v.as_array().into_iter().flatten() {
                if !n["files"].as_array().is_some_and(|f| f.iter().any(|x| x.as_str() == Some("win-x64-zip"))) { continue; }
                let tag = s(&n["version"]);
                let ver = tag.trim_start_matches('v').to_string();
                if vkey(&ver) < vec![14] { continue; }
                out.push(Pkg {
                    url: format!("https://nodejs.org/dist/{tag}/node-{tag}-win-x64.zip"), lazy: format!("https://nodejs.org/dist/{tag}/SHASUMS256.txt"),
                    id: ver.clone(), dir: ver.clone(), major: major_of(&ver, 1), lts: n["lts"].is_string(), version: ver, ..Default::default()
                });
            }
        }
        "python" => {
            let v = get_json(&c, "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest").await?;
            let re = regex::Regex::new(r"^cpython-([^+]+)\+\d+-x86_64-pc-windows-msvc-install_only\.tar\.gz$").unwrap();
            for a in v["assets"].as_array().into_iter().flatten() {
                let Some(m) = re.captures(a["name"].as_str().unwrap_or("")) else { continue };
                let ver = m[1].to_string();
                out.push(Pkg {
                    url: s(&a["browser_download_url"]), sum: gh_digest(a), size: a["size"].as_u64().unwrap_or(0),
                    id: ver.clone(), dir: ver.clone(), major: major_of(&ver, 2), pre: ver.contains(|c: char| c.is_ascii_alphabetic()), version: ver, ..Default::default()
                });
            }
        }
        "go" => {
            let v = get_json(&c, "https://go.dev/dl/?mode=json&include=all").await?;
            for g in v.as_array().into_iter().flatten() {
                let ver = s(&g["version"]).trim_start_matches("go").to_string();
                if vkey(&ver) < vec![1, 18] { continue; }
                let Some(f) = g["files"].as_array().into_iter().flatten().find(|f| f["os"] == "windows" && f["arch"] == "amd64" && f["kind"] == "archive") else { continue };
                out.push(Pkg {
                    url: format!("https://go.dev/dl/{}", s(&f["filename"])), sum: Some((false, s(&f["sha256"]))), size: f["size"].as_u64().unwrap_or(0),
                    id: ver.clone(), dir: ver.clone(), major: major_of(&ver, 2), pre: g["stable"].as_bool() == Some(false), version: ver, ..Default::default()
                });
            }
        }
        "dotnet" => {
            let v = get_json(&c, "https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json").await?;
            for r in v["releases-index"].as_array().into_iter().flatten() {
                let phase = s(&r["support-phase"]);
                if phase == "eol" { continue; }
                let ver = s(&r["latest-sdk"]);
                out.push(Pkg {
                    lazy: s(&r["releases.json"]), id: s(&r["channel-version"]), dir: ver.clone(), major: s(&r["channel-version"]),
                    lts: r["release-type"].as_str() == Some("lts"), pre: phase == "preview" || phase == "go-live", version: ver, ..Default::default()
                });
            }
        }
        "zig" => {
            let v = get_json(&c, "https://ziglang.org/download/index.json").await?;
            for (ver, r) in v.as_object().into_iter().flatten() {
                if ver == "master" { continue; }
                let Some(w) = r.get("x86_64-windows") else { continue };
                out.push(Pkg {
                    url: s(&w["tarball"]), sum: Some((false, s(&w["shasum"]))), size: s(&w["size"]).parse().unwrap_or(0),
                    id: ver.clone(), dir: ver.clone(), major: major_of(ver, 2), version: ver.clone(), ..Default::default()
                });
            }
        }
        "kotlin" => {
            let v = get_json(&c, "https://api.github.com/repos/JetBrains/kotlin/releases?per_page=60").await?;
            for r in v.as_array().into_iter().flatten() {
                let ver = s(&r["tag_name"]).trim_start_matches('v').to_string();
                let Some(a) = r["assets"].as_array().into_iter().flatten().find(|a| a["name"].as_str() == Some(&format!("kotlin-compiler-{ver}.zip"))) else { continue };
                out.push(Pkg {
                    url: s(&a["browser_download_url"]), sum: gh_digest(a), size: a["size"].as_u64().unwrap_or(0),
                    id: ver.clone(), dir: ver.clone(), major: major_of(&ver, 2), pre: r["prerelease"].as_bool() == Some(true), version: ver, ..Default::default()
                });
            }
        }
        "rust" => {
            for (ch, pre) in [("stable", false), ("beta", true), ("nightly", true)] {
                out.push(Pkg { id: ch.into(), version: ch.into(), dir: ch.into(), major: ch.into(), pre, lts: ch == "stable", ..Default::default() });
            }
        }
        _ => return Err("tipo de SDK desconhecido".into()),
    }
    // mais nova primeiro (as fontes listam por data, e o .NET por canal)
    if kind != "rust" { out.sort_by(|a, b| vkey(&b.version).cmp(&vkey(&a.version))); }
    Ok(out)
}

static CATALOG: LazyLock<Mutex<HashMap<String, (Instant, Vec<Pkg>)>>> = LazyLock::new(Default::default);
/// versões disponíveis (guardadas por 1 hora)
pub async fn versions(kind: &str, fresh: bool) -> Result<Vec<Pkg>, String> {
    if !fresh { if let Some((t, v)) = CATALOG.lock().get(kind) { if t.elapsed() < Duration::from_secs(3600) { return Ok(v.clone()); } } }
    let v = catalog(kind).await?;
    CATALOG.lock().insert(kind.into(), (Instant::now(), v.clone()));
    Ok(v)
}

/// endereço e soma finais (algumas fontes só dizem na hora: foojay, .NET, Node, Gradle, Maven)
async fn resolve(kind: &str, p: &Pkg, c: &reqwest::Client) -> Result<(String, Option<Sum>), String> {
    let to_sum = |(big, h): (bool, String)| if big { Sum::Sha512(h) } else { Sum::Sha256(h) };
    let first_word = |t: String| t.split_whitespace().next().unwrap_or("").to_string();
    Ok(match kind {
        "jdk" => {
            let v = get_json(c, &format!("https://api.foojay.io/disco/v3.0/ids/{}", p.lazy)).await?;
            let r = &v["result"][0];
            let url = s(&r["direct_download_uri"]);
            if url.is_empty() { return Err("o foojay não informou o endereço do pacote".into()); }
            let sum = (r["checksum_type"].as_str() == Some("sha256")).then(|| s(&r["checksum"])).filter(|h| !h.is_empty()).map(Sum::Sha256);
            (url, sum)
        }
        "dotnet" => {
            let v = get_json(c, &p.lazy).await?;
            let rel = v["releases"].as_array().into_iter().flatten().find(|r| r["sdk"]["version"].as_str() == Some(&p.version) || r["sdks"].as_array().is_some_and(|a| a.iter().any(|x| x["version"].as_str() == Some(&p.version))))
                .ok_or("a versão do .NET não está no índice")?;
            let sdk = rel["sdks"].as_array().into_iter().flatten().find(|x| x["version"].as_str() == Some(&p.version)).unwrap_or(&rel["sdk"]);
            let f = sdk["files"].as_array().into_iter().flatten().find(|f| f["rid"] == "win-x64" && s(&f["name"]).ends_with(".zip")).ok_or("sem pacote zip do .NET para Windows x64")?;
            (s(&f["url"]), f["hash"].as_str().map(|h| Sum::Sha512(h.to_string())))
        }
        "node" => {
            // a soma é publicada: sem conseguir baixá-la (ou sem o pacote nela), não instala sem conferir
            let file = p.url.rsplit('/').next().unwrap_or("").to_string();
            let sums = get_text(c, &p.lazy).await.map_err(|e| format!("não deu para baixar a soma publicada do Node.js ({e}); nada foi instalado"))?;
            let sum = sums.lines().find(|l| l.ends_with(&file)).map(|l| Sum::Sha256(first_word(l.to_string()))).ok_or_else(|| format!("{file} não está na lista de somas publicada; nada foi instalado"))?;
            (p.url.clone(), Some(sum))
        }
        "gradle" | "maven" => {
            // com soma publicada (lazy), ela tem de chegar e ser legível; sem ela, o download segue sem conferir (avisado)
            let t = if p.lazy.is_empty() { String::new() } else { get_text(c, &p.lazy).await.map_err(|e| format!("não deu para baixar a soma publicada ({e}); nada foi instalado"))? };
            let h = first_word(t);
            let sum = if h.len() == 128 { Some(Sum::Sha512(h)) } else if h.len() == 64 { Some(Sum::Sha256(h)) } else { None };
            if !p.lazy.is_empty() && sum.is_none() { return Err("a soma publicada veio num formato inesperado; nada foi instalado".into()); }
            (p.url.clone(), sum)
        }
        _ => (p.url.clone(), p.sum.clone().map(to_sum)),
    })
}

pub fn job_id(kind: &str, id: &str) -> String { format!("sdk:{kind}:{id}") }

/// começa a baixar (ou devolve o andamento, se já está baixando)
pub fn install(kind: &str, id: &str) -> Result<Value, String> {
    let k = kind_of(kind)?;
    let job = job_id(kind, id);
    if let Some(running) = begin(&job) { return Ok(json!({ "job": job, "status": running })); }
    let (id, job2) = (id.to_string(), job.clone());
    tokio::spawn(async move {
        let r = run_install(k, &id, &job2).await;
        crate::build::detect::forget_which();
        // um runtime novo pode liberar servidores de linguagem (npm, pip, go...) e o jdtls (Java novo)
        let _ = tokio::task::spawn_blocking(|| crate::rpc::tools(true)).await;
        finish(&job2, r.err());
    });
    Ok(json!({ "job": job, "status": crate::install::status(&job) }))
}
fn kind_of(id: &str) -> Result<&'static Kind, String> { find_kind(id).ok_or_else(|| "tipo de SDK desconhecido".to_string()) }

async fn run_install(k: &'static Kind, id: &str, job: &str) -> Result<(), String> {
    upd(job, |j| j.step = "Procurando o pacote…".into());
    let list = versions(k.id, false).await?;
    let p = list.iter().find(|p| p.id == id).cloned().ok_or("versão não encontrada na lista (atualize a lista)")?;
    let c = http()?;
    if k.id == "rust" { return rust(job, &p.id, &c).await; }
    let (url, sum) = resolve(k.id, &p, &c).await?;
    let name = url.rsplit('/').next().unwrap_or("pacote").to_string();
    line(job, &format!("{} {} · {url}", k.name, p.version));
    if sum.is_none() { line(job, "A fonte não publica soma para este pacote: baixando pelo HTTPS sem conferir."); }
    let dest = root(k.id).join(&p.dir);
    fetch(job, &c, &url, &name, p.size, sum, &dest, k.flatten).await?;
    // conferência: o programa principal tem de estar lá
    if !k.bins.iter().any(|b| { let d = if b.is_empty() { dest.clone() } else { dest.join(b) }; [exe(k.probe), format!("{}.cmd", k.probe), format!("{}.bat", k.probe)].iter().any(|f| d.join(f).is_file()) }) {
        return Err(format!("o pacote foi extraído em {}, mas não tem {}", dest.display(), k.probe));
    }
    if k.id == "python" {
        // o python-build-standalone traz o pip, mas sem os atalhos (Scripts\pip.exe), que as receitas dos servidores de
        // linguagem procuram: reinstalar o pip pelo próprio pip cria os atalhos
        let py = dest.join("python.exe").to_string_lossy().into_owned();
        upd(job, |j| j.step = "Preparando o pip…".into());
        if crate::install::run_cmd(job, &py, &["-m", "pip", "install", "--force-reinstall", "--no-deps", "--no-warn-script-location", "--disable-pip-version-check", "pip"]).await.is_err() {
            line(job, "Não deu para criar o pip.exe (sem internet?); use python -m pip.");
        }
    }
    Ok(())
}

/// Rust: o rustup é o instalador oficial. Já existe: instala o canal; senão baixa o rustup-init e roda sem perguntas.
async fn rust(job: &str, channel: &str, c: &reqwest::Client) -> Result<(), String> {
    if let Some(r) = rustup() {
        let r = r.to_string_lossy().into_owned();
        return crate::install::run_cmd(job, &r, &["toolchain", "install", channel, "--profile", "default"]).await;
    }
    let tmp = std::env::temp_dir().join(format!("rustup-init-{}.exe", std::process::id()));
    upd(job, |j| j.step = "Baixando o rustup-init…".into());
    let bytes = c.get("https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe").send().await.and_then(|r| r.error_for_status())
        .map_err(|e| format!("download: {e}"))?.bytes().await.map_err(|e| format!("download: {e}"))?;
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
    let t = tmp.to_string_lossy().into_owned();
    // -y sem perguntas; o PATH do Windows fica como está (a IDE já acha ~/.cargo/bin)
    let r = crate::install::run_cmd(job, &t, &["-y", "--no-modify-path", "--profile", "default", "--default-toolchain", channel]).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    if r.is_ok() && msvc_missing() { line(job, "Aviso: para compilar no Windows o Rust (MSVC) precisa do Visual Studio Build Tools (C++)."); }
    r
}

/// sem o C++ do Visual Studio (o Rust MSVC precisa do link.exe dele)
fn msvc_missing() -> bool {
    let vswhere = PathBuf::from(r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe");
    !vswhere.is_file() || run_out(&vswhere, &["-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]).trim().is_empty()
}

/// remove um SDK baixado pela IDE (os do sistema não são tocados)
pub async fn remove(kind: &str, path: &str) -> Result<(), String> {
    let k = kind_of(kind)?;
    if k.id == "rust" {
        let r = rustup().ok_or("rustup não encontrado")?;
        // o nome do toolchain nunca é uma opção do rustup
        if path.is_empty() || path.starts_with('-') { return Err("toolchain inválido".into()); }
        let mut c = tokio::process::Command::new(r);
        c.args(["toolchain", "uninstall", "--", path]);
        crate::install::hidden(&mut c);
        let ok = c.status().await.map(|s| s.success()).unwrap_or(false);
        return if ok { Ok(()) } else { Err("o rustup não conseguiu remover".into()) };
    }
    let p = absolute(&PathBuf::from(path));
    if !managed_dir(&p, k.id) { return Err("só dá para remover o que a IDE baixou".into()); }
    if explicit_default(k.id).is_some_and(|d| d == p) { set_default(k.id, "")?; }
    tokio::fs::remove_dir_all(&p).await.map_err(|e| format!("não deu para apagar (algum programa dela está aberto?): {e}"))?;
    crate::build::detect::forget_which();
    Ok(())
}

/// o SDK de que um servidor de linguagem precisa para a IDE conseguir instalá-lo (npm → Node.js, pip → Python...)
pub fn for_program(prog: &str) -> Option<&'static str> {
    Some(match prog {
        "npm" | "npx" | "node" | "yarn" | "pnpm" => "node",
        "pip" | "pip3" | "python" | "py" | "uv" => "python",
        "go" => "go",
        "dotnet" => "dotnet",
        "rustup" | "cargo" | "rustc" => "rust",
        "mvn" => "maven",
        "gradle" => "gradle",
        "java" | "javac" => "jdk",
        "zig" => "zig",
        "kotlinc" | "kotlin" => "kotlin",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn so_remove_o_que_baixou() {
        let r = root("node");
        assert!(managed_dir(&r.join("node-v20"), "node"));
        assert!(!managed_dir(&r, "node"));
        assert!(!managed_dir(&r.join("..").join("..").join("Documents"), "node"));
        assert!(!managed_dir(&r.join("node-v20").join("..").join("..").join("Documents"), "node"));
        assert!(!managed_dir(&r.join("a").join("b"), "node"));
        assert!(under(&r.join("x"), &r) && !under(&r.join("..").join("y"), &r));
    }
}
