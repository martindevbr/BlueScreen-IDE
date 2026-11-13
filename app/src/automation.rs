//! Fluxos em nós (formato do HexLab), agenda persistente e revisão independente por CLIs.
use crate::plugins::{Reply, Req, RouteFn, ok, route_fn};
use crate::util::*;
use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

mod browser;
mod links;

static STORE: Mutex<()> = Mutex::new(());
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Flow {
    id: String,
    name: String,
    description: String,
    active: bool,
    /// trancado: só visualização. O núcleo recusa gravar mudanças (fora ligar, desligar e destrancar) e excluir.
    locked: bool,
    /// pasta da lista de fluxos (vazio: solto, fora de pasta)
    #[serde(skip_serializing_if = "String::is_empty")]
    folder: String,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    ui: Value,
    updated_at: Option<String>,
    next_run: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Node {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    position: [f32; 2],
    #[serde(default)]
    disabled: bool,
    /// nó trancado no editor (não move, não edita, não exclui); a execução não muda
    #[serde(default)]
    locked: bool,
    /// tamanho que o usuário deu ao nó no quadro: [largura, altura]; altura 0 = a do conteúdo
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<[f32; 2]>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Edge {
    #[serde(default)]
    id: String,
    from: String,
    from_port: String,
    to: String,
    to_port: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Agenda {
    id: String,
    title: String,
    notes: String,
    at: i64,
    repeat_minutes: u64,
    done: bool,
    notified: bool,
    flow_id: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Store {
    /// agentes de IA por linha de comando: os dois de fábrica (com o que o usuário mudou) e os que ele criou
    clis: Vec<Cli>,
    flows: Vec<Flow>,
    /// pastas da lista de fluxos, inclusive as vazias
    folders: Vec<String>,
    /// a cor que a pessoa deu a cada pasta (nome -> "#rrggbb")
    folder_colors: HashMap<String, String>,
    /// quantas execuções terminadas o histórico guarda, somando todos os fluxos (0: o padrão, 100)
    keep_runs: usize,
    events: Vec<Agenda>,
    runs: Vec<Value>,
    pending: Vec<Pending>,
}
/// Um agente de IA chamado por linha de comando. `kind` diz como falar com o programa: "claude" (Claude Code e
/// programas com as mesmas opções, como o OpenClaude), "codex", ou "custom" (os argumentos são os de `args`).
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Cli {
    id: String,
    name: String,
    kind: String,
    /// vazio: o programa de fábrica do tipo (claude, codex)
    program: String,
    model: String,
    effort: String,
    /// claude/codex: opções a mais. custom: todos os argumentos, com {prompt}, {model} e {effort}
    args: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    flow_id: String,
    scheduled: bool,
    at: i64,
    /// tipo do gatilho que disparou ("trigger.schedule", "trigger.file"...); vazio: pedido pela Agenda de compromissos
    #[serde(default)]
    via: String,
    /// o que o gatilho entrega ao primeiro nó (o arquivo que mudou, por exemplo)
    #[serde(default)]
    payload: Value,
}
pub(crate) fn file() -> std::path::PathBuf {
    std::env::var_os("BLUESCREEN_AUTOMATION_FILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| user_dir().join("automation.json"))
}
/// O arquivo de dados já lido e analisado, para não reler e reanalisar o JSON inteiro a cada consulta (a tela pergunta
/// pelas execuções o tempo todo, e o agendador olha os fluxos a cada 5 segundos). Vale enquanto o arquivo for o mesmo,
/// com a mesma data e o mesmo tamanho: se outro programa mexer nele, a próxima leitura percebe e relê.
struct Cached { path: std::path::PathBuf, stamp: (Option<std::time::SystemTime>, u64), store: Store, /// o mesmo conteúdo em JSON compacto, para comparar depois de uma edição
    compact: Option<String> }
static CACHE: LazyLock<Mutex<Option<Cached>>> = LazyLock::new(Default::default);
fn stamp_of(path: &std::path::Path) -> Option<(Option<std::time::SystemTime>, u64)> { std::fs::metadata(path).ok().map(|m| (m.modified().ok(), m.len())) }
/// Deixa o cache em dia com o arquivo e roda `f` com os dados, sem copiar nada.
fn with_store<T>(f: impl FnOnce(&Store, &mut Option<String>) -> T) -> ApiResult<T> {
    let path = file();
    let stamp = stamp_of(&path);
    let mut c = CACHE.lock();
    if let (Some(x), Some(st)) = (c.as_mut(), stamp) && x.path == path && x.stamp == st { return Ok(f(&x.store, &mut x.compact)); }
    let store: Store = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { *c = None; return Ok(f(&Store::default(), &mut None)); }
        Err(e) => return Err(e.into()),
    };
    // a data é a de antes da leitura: se o arquivo mudou no meio, a próxima consulta relê
    let x = c.insert(Cached { path, stamp: stamp.unwrap_or((None, 0)), store, compact: None });
    Ok(f(&x.store, &mut x.compact))
}
fn load() -> ApiResult<Store> { with_store(|s, _| s.clone()) }
fn edit<T>(f: impl FnOnce(&mut Store) -> ApiResult<T>) -> ApiResult<T> {
    let _g = STORE.lock();
    // os dados de agora e o JSON compacto deles (guardado da última vez, quando houver)
    let (mut s, before) = with_store(|s, compact| (s.clone(), compact.get_or_insert_with(|| serde_json::to_string(s).unwrap_or_default()).clone()))?;
    let out = f(&mut s)?;
    let after = serde_json::to_string(&s)?;
    if before == after {
        return Ok(out);
    }
    let path = file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(&path, &serde_json::to_string_pretty(&s)?)?;
    *CACHE.lock() = stamp_of(&path).map(|stamp| Cached { path, stamp, store: s, compact: Some(after) });
    Ok(out)
}
fn id() -> String {
    format!("{:016x}", rand::random::<u64>())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn enabled(id: &str) -> bool {
    crate::server::host()
        .get()
        .list
        .iter()
        .any(|p| p.id == id && p.enabled && p.error.is_none())
}
fn require_enabled(id: &str) -> ApiResult<()> {
    if enabled(id) {
        Ok(())
    } else {
        Err(fail(format!("ative o plugin {id}"), 409))
    }
}

fn builtin() -> Value {
    // `params`: valores padrão. `fields`: como o painel desenha cada parâmetro (kind: text, area, number, select,
    // json, lines, checks, time; `show` esconde o campo enquanto outro parâmetro não tiver o valor indicado).
    let cwd = json!({"name":"cwd","label":"Pasta de trabalho","kind":"text","pick":"folder","placeholder":"vazio: sua pasta de usuário"});
    let providers = cli_options();
    json!([
        {"type":"trigger.manual","name":"Iniciar manualmente","category":"Gatilhos","desc":"Começa quando você clica em Executar.","inputs":[],"outputs":["out"],
         "params":{"sample":""},"fields":[{"name":"sample","label":"Entrada de exemplo","kind":"area","help":"Texto entregue ao próximo nó."}]},
        {"type":"trigger.schedule","name":"Agenda","category":"Gatilhos","desc":"Começa sozinho, por intervalo ou num horário.","inputs":[],"outputs":["out"],
         "params":{"mode":"interval","every_minutes":60,"time":"09:00","days":[],"window":"all","from":"08:00","to":"18:00"},
         "fields":[
            {"name":"mode","label":"Quando","kind":"select","options":[{"value":"interval","label":"A cada intervalo"},{"value":"daily","label":"Num horário do dia"}]},
            {"name":"every_minutes","label":"Intervalo em minutos","kind":"number","min":1,"max":525600,"show":{"mode":["interval"]}},
            {"name":"time","label":"Horário","kind":"time","show":{"mode":["daily"]}},
            {"name":"window","label":"Em que parte do dia","kind":"select","show":{"mode":["interval"]},"options":[{"value":"all","label":"O dia inteiro"},{"value":"between","label":"Só entre dois horários"}]},
            {"name":"from","label":"Das","kind":"time","show":{"mode":["interval"],"window":["between"]}},
            {"name":"to","label":"Até as","kind":"time","show":{"mode":["interval"],"window":["between"]},"help":"Fora desse horário o fluxo não dispara; o próximo disparo fica para a hora em que ele recomeça. Um fim menor que o início atravessa a meia-noite."},
            {"name":"days","label":"Dias da semana","kind":"checks","help":"Nenhum marcado: todos os dias. Vale para os dois modos.",
             "options":[{"value":1,"label":"Seg"},{"value":2,"label":"Ter"},{"value":3,"label":"Qua"},{"value":4,"label":"Qui"},{"value":5,"label":"Sex"},{"value":6,"label":"Sáb"},{"value":0,"label":"Dom"}]}
         ]},
        {"type":"util.text","name":"Texto","category":"Texto","desc":"Monta um texto com o que chegou.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}"},"fields":[{"name":"text","label":"Texto","kind":"area"}]},
        {"type":"util.output","name":"Resultado","category":"Dados","desc":"Mostra o que chegou como resultado da execução.","inputs":["in"],"outputs":["out"],"params":{},"fields":[]},
        {"type":"logic.if","name":"Condição","category":"Lógica","desc":"Segue por um caminho ou pelo outro.","inputs":["in"],"outputs":["true","false"],
         "params":{"value":"{{input}}","op":"eq","equals":""},
         "fields":[
            {"name":"value","label":"Valor","kind":"text"},
            {"name":"op","label":"Comparação","kind":"select","options":[
                {"value":"eq","label":"é igual a"},{"value":"ne","label":"é diferente de"},{"value":"contains","label":"contém"},{"value":"not_contains","label":"não contém"},
                {"value":"gt","label":"é maior que"},{"value":"lt","label":"é menor que"},{"value":"empty","label":"está vazio"},{"value":"not_empty","label":"não está vazio"},{"value":"true","label":"é verdadeiro"}]},
            {"name":"equals","label":"Comparar com","kind":"text","show":{"op":["eq","ne","contains","not_contains","gt","lt"]}}
         ]},
        {"type":"util.delay","name":"Esperar","category":"Lógica","desc":"Pausa antes de continuar.","inputs":["in"],"outputs":["out"],
         "params":{"seconds":1},"fields":[{"name":"seconds","label":"Segundos","kind":"number","min":0,"max":3600}]},
        {"type":"flow.call","name":"Chamar fluxo","category":"Lógica","desc":"Roda outro fluxo salvo, do começo ao fim, e continua com o resultado dele.","inputs":["in"],"outputs":["out"],
         "params":{"flow":"","input":"{{input}}"},
         "fields":[
            {"name":"flow","label":"Fluxo","kind":"flow","help":"Um fluxo salvo. Ele roda inteiro dentro desta execução e também aparece no histórico dele."},
            {"name":"input","label":"O que entregar a ele","kind":"area","help":"Chega no primeiro nó do fluxo chamado, no lugar do que o gatilho dele entregaria. Vazio: o gatilho dele decide."}
         ]},
        {"type":"windows.command","name":"Executar programa","category":"Windows","desc":"Roda um programa e entrega o que ele escreveu.","inputs":["in"],"outputs":["out"],
         "params":{"program":"powershell","args":["-NoProfile","-Command","Get-Date"],"cwd":"","timeout":60000},
         "fields":[
            {"name":"program","label":"Programa","kind":"text","pick":"program","placeholder":"powershell, git, node…","help":"O nome de um programa instalado, ou escolha o arquivo dele em Procurar."},
            {"name":"args","label":"Argumentos","kind":"lines","help":"Um por linha."},
            cwd.clone(),
            {"name":"timeout","label":"Tempo limite (ms)","kind":"number","min":100,"max":3600000}
         ]},
        {"type":"windows.notify","name":"Notificação","category":"Windows","desc":"Mostra um aviso do Windows.","inputs":["in"],"outputs":["out"],
         "params":{"title":"BlueScreen","message":"{{input}}"},
         "fields":[{"name":"title","label":"Título","kind":"text"},{"name":"message","label":"Mensagem","kind":"area"}]},
        {"type":"http.request","name":"Requisição HTTP","category":"Rede","desc":"Chama um endereço e entrega a resposta.","inputs":["in"],"outputs":["out"],
         "params":{"url":"https://example.com","method":"GET","headers":{},"body":"","timeout":30000},
         "fields":[
            {"name":"url","label":"Endereço","kind":"text"},
            {"name":"method","label":"Método","kind":"select","options":["GET","POST","PUT","PATCH","DELETE","HEAD"]},
            {"name":"headers","label":"Cabeçalhos","kind":"json","help":"Objeto JSON. Tokens: {{cred:nome}} (Credenciais do Automator) ou {{vault:nome}} (Cofre da IDE)."},
            {"name":"body","label":"Corpo","kind":"area","show":{"method":["POST","PUT","PATCH","DELETE"]}},
            {"name":"timeout","label":"Tempo limite (ms)","kind":"number","min":1000,"max":600000}
         ]},
        {"type":"mcp.call","name":"Ferramenta MCP","category":"Rede","desc":"Chama uma ferramenta de um servidor MCP por HTTP.","inputs":["in"],"outputs":["out"],
         "params":{"url":"","tool":"","arguments":{},"headers":{}},
         "fields":[
            {"name":"url","label":"Endereço do servidor","kind":"text","placeholder":"https://…/mcp"},
            {"name":"tool","label":"Ferramenta","kind":"text"},
            {"name":"arguments","label":"Argumentos","kind":"json","help":"Objeto JSON."},
            {"name":"headers","label":"Cabeçalhos","kind":"json","help":"Objeto JSON. Tokens: {{vault:nome}}."}
         ]},
        {"type":"agent.cli","name":"Agente de IA","category":"IA","desc":"Roda o Codex, o Claude Code ou outro agente numa pasta: responde, ou edita arquivos e roda comandos.","inputs":["in"],"outputs":["out"],
         "params":{"provider":"codex","prompt":"{{input}}","cwd":"","access":"read","model":"","effort":"","timeout_min":10},
         "fields":[
            {"name":"provider","label":"Agente","kind":"select","options":providers.clone(),"clis":true},
            {"name":"prompt","label":"Pedido","kind":"area"},
            {"name":"cwd","label":"Pasta de trabalho","kind":"text","pick":"folder","placeholder":"vazio: sua pasta de usuário","help":"Onde o agente lê e, se puder, altera arquivos."},
            {"name":"access","label":"O que ele pode fazer","kind":"select","options":[
                {"value":"read","label":"Só ler e responder"},{"value":"edit","label":"Ler e alterar arquivos da pasta"},{"value":"full","label":"Tudo, sem perguntar (arquivos e comandos)"}],
             "help":"\"Tudo\" deixa o agente rodar qualquer comando no seu PC, sem confirmação. Use só com pedidos seus e numa pasta que possa ser refeita."},
            {"name":"model","label":"Modelo","kind":"text","placeholder":"vazio: o do agente"},
            {"name":"effort","label":"Esforço","kind":"select","options":[
                {"value":"","label":"O do agente"},{"value":"minimal","label":"Mínimo (Codex)"},{"value":"low","label":"Baixo"},{"value":"medium","label":"Médio"},
                {"value":"high","label":"Alto"},{"value":"xhigh","label":"Extra alto"},{"value":"max","label":"Máximo (Claude)"}]},
            {"name":"timeout_min","label":"Tempo limite (minutos)","kind":"number","min":1,"max":60}
         ]},
        {"type":"ai.openrouter","name":"OpenRouter","category":"IA","desc":"Envia um pedido a um modelo do OpenRouter.","inputs":["in"],"outputs":["out"],
         "params":{"model":"","prompt":"{{input}}","secret":"openrouter","max_tokens":2048},
         "fields":[
            {"name":"model","label":"Modelo","kind":"text","placeholder":"provedor/modelo"},
            {"name":"prompt","label":"Pedido","kind":"area"},
            {"name":"secret","label":"Token no Cofre","kind":"text","help":"Nome do segredo liberado para o Automator."},
            {"name":"max_tokens","label":"Limite de tokens","kind":"number","min":1,"max":32768}
         ]},
    ])
}
/// Nós de arquivo, texto, Windows e os gatilhos automáticos (separados do `builtin` para o `json!` não ficar enorme).
fn more() -> Value {
    json!([
        {"type":"trigger.startup","name":"Ao abrir o BlueScreen","category":"Gatilhos","desc":"Começa sozinho quando o BlueScreen é aberto.","inputs":[],"outputs":["out"],"params":{},"fields":[]},
        {"type":"trigger.file","name":"Quando um arquivo mudar","category":"Gatilhos","desc":"Começa quando o arquivo, ou algo na pasta, é criado ou alterado.","inputs":[],"outputs":["out"],
         "params":{"path":""},
         "fields":[{"name":"path","label":"Arquivo ou pasta","kind":"text","pick":"any","placeholder":"C:\\pasta\\relatorio.csv","help":"Numa pasta, olha os arquivos do primeiro nível. O próximo nó recebe path, name e files."}]},
        {"type":"data.set","name":"Montar objeto","category":"Dados","desc":"Monta um objeto com os campos que você definir.","inputs":["in"],"outputs":["out"],
         "params":{"value":{"campo":"{{input}}"}},"fields":[{"name":"value","label":"Campos","kind":"json","help":"Objeto JSON. Os valores aceitam expressões."}]},
        {"type":"data.datetime","name":"Data e hora","category":"Dados","desc":"Entrega a data e a hora de agora, no formato pedido.","inputs":["in"],"outputs":["out"],
         "params":{"format":"%d/%m/%Y %H:%M","offset_days":0},
         "fields":[
            {"name":"format","label":"Formato","kind":"text","help":"%d dia, %m mês, %Y ano, %H hora, %M minuto, %S segundo, %A dia da semana."},
            {"name":"offset_days","label":"Somar dias","kind":"number","min":-36500,"max":36500}
         ]},
        {"type":"text.replace","name":"Substituir texto","category":"Texto","desc":"Troca um trecho por outro.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}","find":"","replace":"","regex":"no"},
         "fields":[
            {"name":"text","label":"Texto","kind":"area"},
            {"name":"find","label":"Procurar","kind":"text"},
            {"name":"replace","label":"Trocar por","kind":"text"},
            {"name":"regex","label":"Como procurar","kind":"select","options":[{"value":"no","label":"Texto exato"},{"value":"yes","label":"Expressão regular"}]}
         ]},
        {"type":"text.extract","name":"Extrair do texto","category":"Texto","desc":"Pega o trecho que casa com uma expressão regular.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}","pattern":"","all":"first"},
         "fields":[
            {"name":"text","label":"Texto","kind":"area"},
            {"name":"pattern","label":"Expressão regular","kind":"text","placeholder":"pedido (\\d+)","help":"Com parênteses, entrega só o que está dentro deles."},
            {"name":"all","label":"Entregar","kind":"select","options":[{"value":"first","label":"O primeiro que casar"},{"value":"all","label":"Todos, numa lista"}]}
         ]},
        {"type":"text.split","name":"Dividir em lista","category":"Texto","desc":"Divide um texto em itens.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}","by":"line","separator":"|"},
         "fields":[
            {"name":"text","label":"Texto","kind":"area"},
            {"name":"by","label":"Dividir por","kind":"select","options":[{"value":"line","label":"Linha"},{"value":"comma","label":"Vírgula"},{"value":"semicolon","label":"Ponto e vírgula"},{"value":"custom","label":"Outro separador"}]},
            {"name":"separator","label":"Separador","kind":"text","show":{"by":["custom"]}}
         ]},
        {"type":"logic.stop","name":"Parar com erro","category":"Lógica","desc":"Encerra o fluxo como falha, com uma mensagem.","inputs":["in"],"outputs":[],
         "params":{"message":"{{input}}"},"fields":[{"name":"message","label":"Mensagem","kind":"area"}]},
        {"type":"file.read","name":"Ler arquivo","category":"Arquivos","desc":"Entrega o texto de um arquivo.","inputs":["in"],"outputs":["out"],
         "params":{"path":"","max_kb":1024},
         "fields":[{"name":"path","label":"Arquivo","kind":"text","pick":"file","placeholder":"C:\\pasta\\notas.txt"},{"name":"max_kb","label":"Ler até (KB)","kind":"number","min":1,"max":20480}]},
        {"type":"file.write","name":"Gravar arquivo","category":"Arquivos","desc":"Grava um texto num arquivo.","inputs":["in"],"outputs":["out"],
         "params":{"path":"","content":"{{input}}","mode":"replace"},
         "fields":[
            {"name":"path","label":"Arquivo","kind":"text","pick":"save","placeholder":"C:\\pasta\\saida.txt","help":"A pasta é criada se não existir."},
            {"name":"content","label":"Conteúdo","kind":"area"},
            {"name":"mode","label":"Se o arquivo já existe","kind":"select","options":[{"value":"replace","label":"Substituir"},{"value":"append","label":"Acrescentar no fim"}]}
         ]},
        {"type":"file.list","name":"Listar arquivos","category":"Arquivos","desc":"Entrega a lista dos arquivos de uma pasta.","inputs":["in"],"outputs":["out"],
         "params":{"path":"","pattern":"*"},
         "fields":[{"name":"path","label":"Pasta","kind":"text","pick":"folder"},{"name":"pattern","label":"Filtro","kind":"text","placeholder":"*.pdf","help":"* vale qualquer trecho; ? vale uma letra."}]},
        {"type":"file.exists","name":"Arquivo existe?","category":"Arquivos","desc":"Segue por sim ou por não conforme o arquivo ou a pasta existir.","inputs":["in"],"outputs":["true","false"],
         "params":{"path":"{{input}}"},"fields":[{"name":"path","label":"Arquivo ou pasta","kind":"text","pick":"any"}]},
        {"type":"file.manage","name":"Copiar, mover ou excluir","category":"Arquivos","desc":"Copia ou move um arquivo, ou manda para a Lixeira.","inputs":["in"],"outputs":["out"],
         "params":{"op":"copy","from":"{{input}}","to":""},
         "fields":[
            {"name":"op","label":"Ação","kind":"select","options":[{"value":"copy","label":"Copiar"},{"value":"move","label":"Mover"},{"value":"trash","label":"Mandar para a Lixeira"}]},
            {"name":"from","label":"Arquivo","kind":"text","pick":"file"},
            {"name":"to","label":"Destino","kind":"text","pick":"any","show":{"op":["copy","move"]},"help":"Um arquivo, ou uma pasta que já existe."}
         ]},
        {"type":"windows.open","name":"Abrir","category":"Windows","desc":"Abre um arquivo, uma pasta ou um site no programa padrão.","inputs":["in"],"outputs":["out"],
         "params":{"target":"{{input}}"},"fields":[{"name":"target","label":"Arquivo, pasta ou endereço","kind":"text","pick":"any","placeholder":"https://… ou C:\\pasta"}]},
        {"type":"windows.powershell","name":"Script PowerShell","category":"Windows","desc":"Roda um script e entrega o que ele escreveu.","inputs":["in"],"outputs":["out"],
         "params":{"script":"Get-Date","cwd":"","timeout":60000},
         "fields":[
            {"name":"script","label":"Script","kind":"area","code":"powershell","help":"O que chegou neste nó fica em $env:BS_INPUT. Senha ou token: escreva {{cred:nome}} no script, fora de aspas simples."},
            {"name":"cwd","label":"Pasta de trabalho","kind":"text","pick":"folder","placeholder":"vazio: sua pasta de usuário"},
            {"name":"timeout","label":"Tempo limite (ms)","kind":"number","min":100,"max":3600000}
         ]},
        {"type":"windows.clipboard","name":"Área de transferência","category":"Windows","desc":"Lê o texto copiado, ou copia um texto.","inputs":["in"],"outputs":["out"],
         "params":{"op":"read","text":"{{input}}"},
         "fields":[
            {"name":"op","label":"Ação","kind":"select","options":[{"value":"read","label":"Ler o que está copiado"},{"value":"write","label":"Copiar um texto"}]},
            {"name":"text","label":"Texto","kind":"area","show":{"op":["write"]}}
         ]},
        {"type":"http.download","name":"Baixar arquivo","category":"Rede","desc":"Baixa um endereço e grava num arquivo.","inputs":["in"],"outputs":["out"],
         "params":{"url":"","path":""},
         "fields":[{"name":"url","label":"Endereço","kind":"text","placeholder":"https://…"},{"name":"path","label":"Gravar em","kind":"text","pick":"save","placeholder":"C:\\pasta\\arquivo.zip"}]}
    ])
}
/// Nós de texto, imagem, áudio e vídeo. Imagem usa o System.Drawing do Windows (PowerShell); áudio e vídeo, o FFmpeg.
fn media() -> Value {
    let file = |label: &str| json!({"name":"file","label":label,"kind":"text","pick":"file"});
    let out = json!({"name":"out","label":"Gravar em","kind":"text","pick":"save","placeholder":"vazio: ao lado do original","help":"Um arquivo, ou uma pasta que já existe. O nó entrega o caminho do arquivo gravado."});
    let cut = json!([
        {"name":"start","label":"Começa em","kind":"text","placeholder":"0, 90 ou 00:01:30"},
        {"name":"duration","label":"Duração","kind":"text","placeholder":"vazio: até o fim","help":"Em segundos, ou como 00:01:30."}
    ]);
    json!([
        {"type":"text.case","name":"Ajustar texto","category":"Texto","desc":"Maiúsculas, minúsculas ou sem espaços sobrando.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}","mode":"trim"},
         "fields":[{"name":"text","label":"Texto","kind":"area"},{"name":"mode","label":"Como","kind":"select","options":[
            {"value":"trim","label":"Tirar espaços das pontas"},{"value":"upper","label":"TUDO EM MAIÚSCULAS"},{"value":"lower","label":"tudo em minúsculas"},{"value":"title","label":"Primeira Letra Maiúscula"},{"value":"lines","label":"Tirar linhas vazias"}]}]},
        {"type":"text.join","name":"Juntar lista","category":"Texto","desc":"Junta os itens de uma lista num texto só.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","by":"line","separator":", "},
         "fields":[{"name":"list","label":"Lista","kind":"text"},
            {"name":"by","label":"Separar com","kind":"select","options":[{"value":"line","label":"Quebra de linha"},{"value":"comma","label":"Vírgula"},{"value":"space","label":"Espaço"},{"value":"custom","label":"Outro"}]},
            {"name":"separator","label":"Separador","kind":"text","show":{"by":["custom"]}}]},
        {"type":"text.count","name":"Contar texto","category":"Texto","desc":"Conta letras, palavras e linhas.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}"},"fields":[{"name":"text","label":"Texto","kind":"area","help":"Entrega chars, words e lines."}]},

        {"type":"image.resize","name":"Redimensionar imagem","category":"Imagem","desc":"Muda o tamanho de uma imagem.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","width":1280,"height":0,"out":""},
         "fields":[file("Imagem"),{"name":"width","label":"Largura (px)","kind":"number","min":0,"max":20000},{"name":"height","label":"Altura (px)","kind":"number","min":0,"max":20000,"help":"Zero numa das medidas mantém a proporção."},out.clone()]},
        {"type":"image.convert","name":"Converter imagem","category":"Imagem","desc":"Grava a imagem em outro formato.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","format":"jpg","quality":85,"out":""},
         "fields":[file("Imagem"),{"name":"format","label":"Formato","kind":"select","options":[{"value":"jpg","label":"JPG"},{"value":"png","label":"PNG"},{"value":"bmp","label":"BMP"},{"value":"gif","label":"GIF"}]},
            {"name":"quality","label":"Qualidade do JPG","kind":"number","min":1,"max":100,"show":{"format":["jpg"]}},out.clone()]},
        {"type":"image.crop","name":"Cortar imagem","category":"Imagem","desc":"Recorta um retângulo da imagem.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","x":0,"y":0,"width":800,"height":600,"out":""},
         "fields":[file("Imagem"),{"name":"x","label":"Da esquerda (px)","kind":"number","min":0,"max":100000},{"name":"y","label":"Do topo (px)","kind":"number","min":0,"max":100000},
            {"name":"width","label":"Largura (px)","kind":"number","min":1,"max":100000},{"name":"height","label":"Altura (px)","kind":"number","min":1,"max":100000},out.clone()]},
        {"type":"image.rotate","name":"Girar imagem","category":"Imagem","desc":"Gira ou espelha a imagem.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","turn":"Rotate90FlipNone","out":""},
         "fields":[file("Imagem"),{"name":"turn","label":"Como","kind":"select","options":[
            {"value":"Rotate90FlipNone","label":"90° para a direita"},{"value":"Rotate270FlipNone","label":"90° para a esquerda"},{"value":"Rotate180FlipNone","label":"180°"},
            {"value":"RotateNoneFlipX","label":"Espelhar na horizontal"},{"value":"RotateNoneFlipY","label":"Espelhar na vertical"}]},out.clone()]},
        {"type":"image.info","name":"Dados da imagem","category":"Imagem","desc":"Entrega a largura e a altura.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}"},"fields":[file("Imagem")]},

        {"type":"audio.convert","name":"Converter áudio","category":"Áudio","desc":"Grava o áudio em outro formato.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","format":"mp3","bitrate":"192","out":""},
         "fields":[file("Áudio"),{"name":"format","label":"Formato","kind":"select","options":[{"value":"mp3","label":"MP3"},{"value":"wav","label":"WAV"},{"value":"m4a","label":"M4A (AAC)"},{"value":"ogg","label":"OGG"},{"value":"flac","label":"FLAC"}]},
            {"name":"bitrate","label":"Qualidade","kind":"select","show":{"format":["mp3","m4a","ogg"]},"options":[{"value":"96","label":"96 kbps (voz)"},{"value":"128","label":"128 kbps"},{"value":"192","label":"192 kbps"},{"value":"320","label":"320 kbps"}]},out.clone()]},
        {"type":"audio.trim","name":"Cortar áudio","category":"Áudio","desc":"Fica com um trecho do áudio.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","start":"0","duration":"","out":""},"fields":[file("Áudio"),cut[0],cut[1],out.clone()]},
        {"type":"audio.volume","name":"Ajustar volume","category":"Áudio","desc":"Aumenta, diminui ou nivela o volume.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","mode":"normalize","percent":150,"out":""},
         "fields":[file("Áudio"),{"name":"mode","label":"Como","kind":"select","options":[{"value":"normalize","label":"Nivelar (volume padrão)"},{"value":"percent","label":"Por porcentagem"}]},
            {"name":"percent","label":"Volume (%)","kind":"number","min":1,"max":1000,"show":{"mode":["percent"]},"help":"100 mantém; 200 dobra."},out.clone()]},

        {"type":"video.convert","name":"Converter vídeo","category":"Vídeo","desc":"Muda o formato, o tamanho e a qualidade do vídeo.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","format":"mp4","height":"0","quality":"medium","sound":"keep","out":""},
         "fields":[file("Vídeo"),{"name":"format","label":"Formato","kind":"select","options":[{"value":"mp4","label":"MP4 (H.264)"},{"value":"webm","label":"WebM (VP9)"},{"value":"mkv","label":"MKV (H.264)"},{"value":"gif","label":"GIF animado"}]},
            {"name":"height","label":"Tamanho","kind":"select","options":[{"value":"0","label":"O do original"},{"value":"1080","label":"1080p"},{"value":"720","label":"720p"},{"value":"480","label":"480p"},{"value":"360","label":"360p"}]},
            {"name":"quality","label":"Qualidade","kind":"select","show":{"format":["mp4","webm","mkv"]},"options":[{"value":"high","label":"Alta (arquivo maior)"},{"value":"medium","label":"Média"},{"value":"low","label":"Baixa (arquivo menor)"}]},
            {"name":"sound","label":"Som","kind":"select","show":{"format":["mp4","webm","mkv"]},"options":[{"value":"keep","label":"Manter"},{"value":"mute","label":"Tirar o som"}]},out.clone()]},
        {"type":"video.trim","name":"Cortar vídeo","category":"Vídeo","desc":"Fica com um trecho do vídeo.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","start":"0","duration":"","mode":"exact","out":""},
         "fields":[file("Vídeo"),cut[0],cut[1],{"name":"mode","label":"Corte","kind":"select","options":[{"value":"exact","label":"Exato (reprocessa o vídeo)"},{"value":"fast","label":"Rápido (pode começar um pouco antes)"}]},out.clone()]},
        {"type":"video.audio","name":"Extrair áudio do vídeo","category":"Vídeo","desc":"Grava só o som do vídeo.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","format":"mp3","out":""},
         "fields":[file("Vídeo"),{"name":"format","label":"Formato","kind":"select","options":[{"value":"mp3","label":"MP3"},{"value":"wav","label":"WAV"},{"value":"m4a","label":"M4A (AAC)"}]},out.clone()]},
        {"type":"video.frame","name":"Capturar quadro","category":"Vídeo","desc":"Grava uma imagem de um instante do vídeo.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}","time":"0","out":""},"fields":[file("Vídeo"),{"name":"time","label":"Instante","kind":"text","placeholder":"0, 90 ou 00:01:30"},out.clone()]},
        {"type":"media.info","name":"Dados do áudio ou vídeo","category":"Vídeo","desc":"Entrega duração, tamanho, formato e resolução.","inputs":["in"],"outputs":["out"],
         "params":{"file":"{{input}}"},"fields":[file("Áudio ou vídeo")]}
    ])
}
fn ops_catalog() -> Value {
    let compare = json!([
        {"value":"eq","label":"é igual a"},{"value":"ne","label":"é diferente de"},{"value":"contains","label":"contém"},{"value":"not_contains","label":"não contém"},
        {"value":"gt","label":"é maior que"},{"value":"lt","label":"é menor que"},{"value":"empty","label":"está vazio"},{"value":"not_empty","label":"não está vazio"},{"value":"true","label":"é verdadeiro"}]);
    let needs = json!({"op":["eq","ne","contains","not_contains","gt","lt"]});
    let url = json!({"name":"url","label":"Endereço","kind":"text","placeholder":"https://…"});
    let dt_env = json!({"name":"env","label":"Ambiente","kind":"text","placeholder":"https://abc12345.live.dynatrace.com"});
    let dt_secret = json!({"name":"secret","label":"Token no Cofre","kind":"text","help":"Nome do segredo com o API token. Libere para o Automator e para o endereço do ambiente."});
    let list = json!({"name":"list","label":"Lista","kind":"text"});
    json!([
        {"type":"trigger.webhook","name":"Endpoint HTTP","category":"Gatilhos","desc":"Começa quando alguém chama o endereço do fluxo. O fluxo responde.","inputs":[],"outputs":["out"],
         "params":{"name":"meu-endpoint","method":"any","who":"local","wait_s":30},
         "fields":[
            {"name":"name","label":"Nome do endpoint","kind":"text","help":"Letras, números e hífen. O próximo nó recebe a chamada inteira em campos: method, url, query, headers, cookies, body, form, raw, token, ip, user_agent, time e outros (a lista está em Saída, acima)."},
            {"name":"method","label":"Método","kind":"select","options":[{"value":"any","label":"Qualquer um"},{"value":"GET","label":"GET"},{"value":"POST","label":"POST"},{"value":"PUT","label":"PUT"},{"value":"DELETE","label":"DELETE"}]},
            {"name":"who","label":"Quem pode chamar","kind":"select","options":[{"value":"local","label":"Só este PC"},{"value":"lan","label":"A rede local também"}],"help":"Para outro aparelho da sua rede chamar (celular, outro PC), o endereço é o da rede, mostrado abaixo: o que começa com 127.0.0.1 só funciona neste PC. Ligar o fluxo com esta opção liga o acesso pela rede local do BlueScreen. Quem chama o endpoint não precisa do PIN: ponha um nó de Segurança (Exigir token) logo depois."},
            {"name":"wait_s","label":"Esperar a resposta por até (segundos)","kind":"number","min":1,"max":300}
         ]},
        {"type":"http.respond","name":"Responder ao endpoint","category":"Rede","desc":"Define o que o Endpoint HTTP devolve a quem chamou.","inputs":["in"],"outputs":["out"],
         "params":{"status":200,"type":"json","body":"{{input}}"},
         "fields":[
            {"name":"status","label":"Código HTTP","kind":"number","min":100,"max":599},
            {"name":"type","label":"Formato","kind":"select","options":[{"value":"json","label":"JSON"},{"value":"text","label":"Texto"},{"value":"html","label":"HTML"}]},
            {"name":"body","label":"Corpo","kind":"area"}
         ]},

        {"type":"sec.token","name":"Exigir token","category":"Segurança","desc":"Só continua se a chamada trouxer o token certo. Senão responde 401.","inputs":["in"],"outputs":["out"],
         "params":{"got":"{{input.token}}","expected":""},
         "fields":[{"name":"got","label":"Token recebido","kind":"text"},{"name":"expected","label":"Token esperado","kind":"text","placeholder":"{{vault:meu-endpoint}}","help":"Use {{cred:nome}} (Credenciais do Automator) ou {{vault:nome}} (Cofre da IDE). Um texto escrito aqui fica gravado no fluxo."}]},
        {"type":"sec.rate","name":"Limitar chamadas","category":"Segurança","desc":"Recusa com 429 quem chama demais.","inputs":["in"],"outputs":["out"],
         "params":{"max":30,"per_s":60,"key":"{{input.token}}"},
         "fields":[{"name":"max","label":"No máximo","kind":"number","min":1,"max":100000},{"name":"per_s","label":"A cada (segundos)","kind":"number","min":1,"max":86400},
            {"name":"key","label":"Contar por","kind":"text","help":"Um contador para cada valor (o token de quem chama, por exemplo). Vazio: todas as chamadas juntas."}]},
        {"type":"sec.hmac","name":"Conferir assinatura","category":"Segurança","desc":"Confere a assinatura HMAC-SHA256 do corpo (GitHub, Stripe e parecidos). Senão responde 401.","inputs":["in"],"outputs":["out"],
         "params":{"raw":"{{input.raw}}","signature":"{{input.headers.x-hub-signature-256}}","secret":""},
         "fields":[{"name":"raw","label":"Corpo recebido","kind":"text"},{"name":"signature","label":"Assinatura recebida","kind":"text","help":"Aceita com ou sem o prefixo sha256=."},
            {"name":"secret","label":"Segredo","kind":"text","placeholder":"{{vault:github-webhook}}","help":"Use {{cred:nome}} (Credenciais do Automator) ou {{vault:nome}} (Cofre da IDE)."}]},
        {"type":"sec.require","name":"Exigir campos","category":"Segurança","desc":"Só continua se os campos vierem preenchidos. Senão responde 400.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input.body}}","fields":["nome"]},
         "fields":[{"name":"value","label":"Onde procurar","kind":"text"},{"name":"fields","label":"Campos obrigatórios","kind":"lines","help":"Um por linha. Campo dentro de outro: cliente.email."}]},

        {"type":"logic.assert","name":"Garantir que","category":"Lógica","desc":"Falha o fluxo, com a sua mensagem, se a comparação não valer (um teste).","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","op":"eq","equals":"","message":""},
         "fields":[{"name":"value","label":"Valor","kind":"text"},{"name":"op","label":"Comparação","kind":"select","options":compare.clone()},
            {"name":"equals","label":"Comparar com","kind":"text","show":needs.clone()},{"name":"message","label":"Mensagem se falhar","kind":"text","placeholder":"vazio: diz o que esperava e o que veio"}]},

        {"type":"audit.http","name":"Site no ar?","category":"Auditoria","desc":"Chama o endereço e segue por sim (no ar) ou por não. Entrega status, tempo e tamanho.","inputs":["in"],"outputs":["true","false"],
         "params":{"url":"https://example.com","contains":"","max_ms":0},
         "fields":[url.clone(),{"name":"contains","label":"A página precisa conter","kind":"text","placeholder":"vazio: não confere"},{"name":"max_ms","label":"Tempo máximo (ms)","kind":"number","min":0,"max":120000,"help":"Zero: não confere o tempo."}]},
        {"type":"audit.headers","name":"Cabeçalhos de segurança","category":"Auditoria","desc":"Confere HTTPS, HSTS, CSP e os outros cabeçalhos de proteção da página.","inputs":["in"],"outputs":["out"],
         "params":{"url":"https://example.com"},"fields":[url.clone()]},
        {"type":"audit.tls","name":"Certificado HTTPS","category":"Auditoria","desc":"Entrega quando o certificado vence e quantos dias faltam.","inputs":["in"],"outputs":["out"],
         "params":{"host":"example.com","port":443},
         "fields":[{"name":"host","label":"Site","kind":"text","placeholder":"example.com ou https://example.com"},{"name":"port","label":"Porta","kind":"number","min":1,"max":65535}]},
        {"type":"audit.port","name":"Porta aberta?","category":"Auditoria","desc":"Tenta conectar no servidor e segue por sim ou por não.","inputs":["in"],"outputs":["true","false"],
         "params":{"host":"127.0.0.1","port":5432,"timeout_s":5},
         "fields":[{"name":"host","label":"Servidor","kind":"text"},{"name":"port","label":"Porta","kind":"number","min":1,"max":65535},{"name":"timeout_s","label":"Esperar até (segundos)","kind":"number","min":1,"max":60}]},
        {"type":"audit.links","name":"Links quebrados","category":"Auditoria","desc":"Abre a página e testa os links dela.","inputs":["in"],"outputs":["out"],
         "params":{"url":"https://example.com","max":50},
         "fields":[url.clone(),{"name":"max","label":"Testar até (links)","kind":"number","min":1,"max":300,"help":"Entrega checked, broken (a lista) e ok."}]},

        {"type":"notify.chat","name":"Mensagem no Slack, Teams ou Discord","category":"Integrações","desc":"Envia um texto para um canal pelo webhook de entrada dele.","inputs":["in"],"outputs":["out"],
         "params":{"service":"slack","url":"","text":"{{input}}"},
         "fields":[{"name":"service","label":"Serviço","kind":"select","options":[{"value":"slack","label":"Slack"},{"value":"teams","label":"Microsoft Teams"},{"value":"discord","label":"Discord"}]},
            {"name":"url","label":"Endereço do webhook","kind":"text","help":"Quem tem esse endereço publica no canal: trate como senha."},{"name":"text","label":"Mensagem","kind":"area"}]},
        {"type":"dynatrace.problems","name":"Dynatrace: problemas","category":"Integrações","desc":"Lista os problemas do ambiente (abertos, por padrão).","inputs":["in"],"outputs":["out"],
         "params":{"env":"","secret":"dynatrace","status":"open","limit":50},
         "fields":[dt_env.clone(),dt_secret.clone(),{"name":"status","label":"Quais","kind":"select","options":[{"value":"open","label":"Abertos"},{"value":"closed","label":"Fechados"},{"value":"all","label":"Todos"}]},
            {"name":"limit","label":"Até (problemas)","kind":"number","min":1,"max":500,"help":"Entrega total e problems (id, title, severity, impact, status, start, entities)."}]},
        {"type":"dynatrace.metric","name":"Dynatrace: métrica","category":"Integrações","desc":"Consulta uma métrica e entrega o último valor, a média e o máximo.","inputs":["in"],"outputs":["out"],
         "params":{"env":"","secret":"dynatrace","selector":"builtin:host.cpu.usage","from":"now-1h"},
         "fields":[dt_env.clone(),dt_secret.clone(),{"name":"selector","label":"Métrica","kind":"text","help":"O metricSelector do Dynatrace."},{"name":"from","label":"Desde","kind":"text","placeholder":"now-1h, now-1d"}]},
        {"type":"dynatrace.event","name":"Dynatrace: registrar evento","category":"Integrações","desc":"Marca um deploy, uma anotação ou um aviso no Dynatrace.","inputs":["in"],"outputs":["out"],
         "params":{"env":"","secret":"dynatrace","kind":"CUSTOM_DEPLOYMENT","title":"{{input}}","entity":"","properties":{}},
         "fields":[dt_env,dt_secret,{"name":"kind","label":"Tipo","kind":"select","options":[{"value":"CUSTOM_DEPLOYMENT","label":"Deploy"},{"value":"CUSTOM_ANNOTATION","label":"Anotação"},{"value":"CUSTOM_INFO","label":"Informação"},{"value":"CUSTOM_ALERT","label":"Alerta"}]},
            {"name":"title","label":"Título","kind":"text"},{"name":"entity","label":"Entidades","kind":"text","placeholder":"type(SERVICE),entityName(checkout)","help":"O entitySelector. Vazio: o ambiente todo."},
            {"name":"properties","label":"Propriedades","kind":"json","help":"Objeto JSON com textos (versão, autor, link)."}]},

        {"type":"data.csv","name":"Ler CSV","category":"Dados","desc":"Transforma um texto CSV numa lista, usando a primeira linha como nomes dos campos.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}","sep":"auto"},
         "fields":[{"name":"text","label":"Texto","kind":"area"},{"name":"sep","label":"Separador","kind":"select","options":[{"value":"auto","label":"Descobrir"},{"value":",","label":"Vírgula"},{"value":";","label":"Ponto e vírgula"},{"value":"\t","label":"Tabulação"}]}]},
        {"type":"data.filter","name":"Filtrar lista","category":"Dados","desc":"Fica com os itens que passam na comparação.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","field":"","op":"eq","equals":""},
         "fields":[list.clone(),{"name":"field","label":"Campo do item","kind":"text","placeholder":"vazio: o item inteiro","paths":"list","item":true},{"name":"op","label":"Comparação","kind":"select","options":compare},{"name":"equals","label":"Comparar com","kind":"text","show":needs}]},
        {"type":"data.stats","name":"Resumir números","category":"Dados","desc":"Conta, soma e tira média, mínimo e máximo de uma lista.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","field":""},
         "fields":[list.clone(),{"name":"field","label":"Campo com o número","kind":"text","placeholder":"vazio: o item é o número","paths":"list","item":true,"help":"Entrega count, sum, avg, min e max."}]},
        {"type":"data.table","name":"Montar tabela","category":"Dados","desc":"Transforma uma lista numa tabela para relatório.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","format":"markdown"},
         "fields":[list,{"name":"format","label":"Formato","kind":"select","options":[{"value":"markdown","label":"Markdown"},{"value":"csv","label":"CSV"},{"value":"html","label":"HTML"}]}]},

        {"type":"sys.info","name":"Saúde do PC","category":"Windows","desc":"Entrega o uso de CPU, de memória e o espaço livre nos discos.","inputs":["in"],"outputs":["out"],"params":{},"fields":[]},
        {"type":"sys.process","name":"Programa está rodando?","category":"Windows","desc":"Segue por sim ou por não conforme o programa estiver aberto.","inputs":["in"],"outputs":["true","false"],
         "params":{"name":""},"fields":[{"name":"name","label":"Nome do programa","kind":"text","placeholder":"chrome, node, nginx"}]}
    ])
}
/// Sons do Windows (C:\Windows\Media\*.wav): a biblioteca do nó Alarme.
fn system_sounds() -> Vec<String> {
    let dir = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into())).join("Media");
    let mut v: Vec<String> = std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.to_lowercase().ends_with(".wav")).collect();
    // os de alarme e de toque primeiro: são os que fazem sentido aqui
    v.sort_by_key(|n| { let l = n.to_lowercase(); (if l.starts_with("alarm") { 0 } else if l.starts_with("ring") { 1 } else { 2 }, l) });
    v
}
fn alarm_catalog() -> Value {
    let mut sounds = vec![json!({"value":"","label":"Sem som"})];
    sounds.extend(system_sounds().into_iter().map(|n| json!({"label": n.trim_end_matches(".wav").trim_end_matches(".WAV"), "value": n})));
    sounds.push(json!({"value":"custom","label":"Outro arquivo…"}));
    json!([
        {"type":"windows.alarm","name":"Alarme","category":"Windows","desc":"Abre um alerta no canto da tela, por cima de tudo, com som.","inputs":["in"],"outputs":["out"],
         "params":{"title":"Alarme","message":"{{input}}","level":"warn","sound":"Alarm01.wav","sound_file":"","repeat":"once","seconds":0,"wait":"no","button":"OK","button2":"",
                   "position":"br","width":380,"theme":"dark","color":"","opacity":100,"blink":"yes"},
         "fields":[
            {"name":"title","label":"Título","kind":"text"},
            {"name":"message","label":"Mensagem","kind":"area"},
            {"name":"level","label":"Tipo","kind":"select","options":[{"value":"info","label":"Informação (azul)"},{"value":"ok","label":"Sucesso (verde)"},{"value":"warn","label":"Aviso (âmbar)"},{"value":"error","label":"Erro (vermelho)"}]},
            {"name":"sound","label":"Som","kind":"select","options":sounds,"preview":"sound","help":"Os sons do Windows. O botão toca o escolhido."},
            {"name":"sound_file","label":"Arquivo de som (.wav)","kind":"text","pick":"file","show":{"sound":["custom"]}},
            {"name":"repeat","label":"Tocar","kind":"select","options":[{"value":"once","label":"Uma vez"},{"value":"loop","label":"Sem parar, até fechar"}]},
            {"name":"seconds","label":"Fechar sozinho depois de (segundos)","kind":"number","min":0,"max":86400,"help":"Zero: fica até alguém fechar."},
            {"name":"button","label":"Botão","kind":"text"},
            {"name":"button2","label":"Segundo botão","kind":"text","placeholder":"vazio: sem segundo botão (ex.: Adiar)"},
            {"name":"wait","label":"O fluxo","kind":"select","options":[{"value":"no","label":"Segue em frente"},{"value":"yes","label":"Espera o alarme fechar"}],"help":"Esperando, o nó entrega closed: o texto do botão clicado, ou timeout."},
            {"name":"position","label":"Onde aparece","kind":"select","options":[{"value":"br","label":"Canto de baixo, à direita"},{"value":"bl","label":"Canto de baixo, à esquerda"},{"value":"tr","label":"Canto de cima, à direita"},{"value":"tl","label":"Canto de cima, à esquerda"},{"value":"center","label":"Centro da tela"}]},
            {"name":"width","label":"Largura (px)","kind":"number","min":240,"max":900},
            {"name":"theme","label":"Fundo","kind":"select","options":[{"value":"dark","label":"Escuro"},{"value":"light","label":"Claro"}]},
            {"name":"color","label":"Cor de destaque","kind":"text","placeholder":"vazio: a do tipo (ex.: #E0685E)"},
            {"name":"opacity","label":"Opacidade (%)","kind":"number","min":30,"max":100},
            {"name":"blink","label":"Piscar a borda","kind":"select","options":[{"value":"yes","label":"Sim"},{"value":"no","label":"Não"}]}
         ]}
    ])
}
const ALARM_PS: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# janela que aparece sem tirar o foco de onde a pessoa está digitando
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'using System.Windows.Forms; public class BsAlarmForm : Form { protected override bool ShowWithoutActivation { get { return true; } } protected override CreateParams CreateParams { get { CreateParams p = base.CreateParams; p.ExStyle |= 0x08000008; return p; } } }'
$c = $env:BS_ALARM | ConvertFrom-Json
$col = { param($h) [System.Drawing.ColorTranslator]::FromHtml($h) }
$dark = $c.theme -ne 'light'
$bg = & $col $(if ($dark) { '#1C1F26' } else { '#FFFFFF' }); $fg = & $col $(if ($dark) { '#F2F4F8' } else { '#16181D' }); $muted = & $col $(if ($dark) { '#B4BAC6' } else { '#4A5160' })
$accent = & $col $c.color
$W = [int]$c.width; $pad = 16; $bar = 6
$f = New-Object BsAlarmForm
$f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'; $f.BackColor = $accent; $f.Opacity = [double]$c.opacity / 100; $f.Padding = New-Object System.Windows.Forms.Padding 2
$body = New-Object System.Windows.Forms.Panel; $body.Dock = 'Fill'; $body.BackColor = $bg; $f.Controls.Add($body)
$stripe = New-Object System.Windows.Forms.Panel; $stripe.BackColor = $accent; $stripe.SetBounds(0, 0, $bar, 2000); $body.Controls.Add($stripe)
$inner = $W - 4 - $bar - $pad * 2
$t = New-Object System.Windows.Forms.Label; $t.Text = $c.title; $t.ForeColor = $fg; $t.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11.5); $t.AutoSize = $true; $t.MaximumSize = New-Object System.Drawing.Size $inner, 0; $t.Location = New-Object System.Drawing.Point ($bar + $pad), 14; $t.UseMnemonic = $false; $body.Controls.Add($t)
$y = $t.Bottom + 6
if ($c.message) {
  $m = New-Object System.Windows.Forms.Label; $m.Text = $c.message; $m.ForeColor = $muted; $m.Font = New-Object System.Drawing.Font('Segoe UI', 9.75); $m.AutoSize = $true; $m.MaximumSize = New-Object System.Drawing.Size $inner, 420; $m.Location = New-Object System.Drawing.Point ($bar + $pad), $y; $m.UseMnemonic = $false; $body.Controls.Add($m)
  $y = $m.Bottom + 6
}
$script:closed = 'timeout'
$x = $W - 4 - $pad
# o botão principal fica na ponta direita; o segundo, à esquerda dele
foreach ($name in @($c.button, $c.button2)) {
  if (-not $name) { continue }
  $b = New-Object System.Windows.Forms.Button; $b.Text = $name; $b.FlatStyle = 'Flat'; $b.AutoSize = $true; $b.AutoSizeMode = 'GrowAndShrink'; $b.Padding = New-Object System.Windows.Forms.Padding 10, 3, 10, 3; $b.Font = New-Object System.Drawing.Font('Segoe UI', 9.25); $b.UseMnemonic = $false; $b.Cursor = 'Hand'
  if ($name -eq $c.button) { $b.BackColor = $accent; $b.ForeColor = [System.Drawing.Color]::White; $b.FlatAppearance.BorderSize = 0 } else { $b.BackColor = $bg; $b.ForeColor = $fg; $b.FlatAppearance.BorderColor = $muted }
  $body.Controls.Add($b); $x -= $b.PreferredSize.Width; $b.Location = New-Object System.Drawing.Point $x, ($y + 8); $x -= 8
  $b.Tag = $name; $b.Add_Click({ $script:closed = $this.Tag; $f.Close() })
  $bottom = $b.Bottom
}
$H = $(if ($bottom) { $bottom + 14 } else { $y + 12 }) + 4
$f.Size = New-Object System.Drawing.Size $W, $H
$gap = 16
# pilha: cada alarme aberto deixa um arquivo com canto, tamanho e hora; todos calculam a mesma fila,
# então um alarme novo entra por cima dos que já estão no canto e a pilha se ajeita quando um fecha
$slots = Join-Path ([IO.Path]::GetTempPath()) 'bluescreen-alarmes'; [void][IO.Directory]::CreateDirectory($slots)
$me = Join-Path $slots ($PID.ToString() + '.txt')
[IO.File]::WriteAllText($me, ($c.position, $W, $H, [DateTime]::UtcNow.Ticks -join '|'))
$place = {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $all = @()
  foreach ($file in [IO.Directory]::GetFiles($slots, '*.txt')) {
    try {
      $id = [int][IO.Path]::GetFileNameWithoutExtension($file)
      if ($id -ne $PID) {
        # alarme que morreu sem se despedir: o lugar dele volta para a fila
        $alive = $false; try { $alive = [Diagnostics.Process]::GetProcessById($id).ProcessName -match '^(powershell|pwsh)' } catch { }
        if (-not $alive) { [IO.File]::Delete($file); continue }
      }
      $s = [IO.File]::ReadAllText($file).Split('|'); if ($s.Count -lt 4 -or $s[0] -ne $c.position) { continue }
      $all += [pscustomobject]@{ id = $id; w = [int]$s[1]; h = [int]$s[2]; t = [long]$s[3]; col = 0; x = 0; y = 0 }
    } catch { }
  }
  # a fila enche uma coluna; quando não cabe mais na altura da tela, abre outra ao lado
  $room = $wa.Height - $gap * 2; $col = 0; $ox = 0; $oy = 0; $cw = 0; $tall = @{}; $mine = $null
  foreach ($a in ($all | Sort-Object t, id)) {
    if ($oy -gt 0 -and $oy + $a.h -gt $room) { $col++; $ox += $cw + $gap; $oy = 0; $cw = 0 }
    $a.col = $col; $a.x = $ox; $a.y = $oy; $tall[$col] = $oy + $a.h
    $oy += $a.h + $gap; if ($a.w -gt $cw) { $cw = $a.w }
    if ($a.id -eq $PID) { $mine = $a }
  }
  if (-not $mine) { $mine = [pscustomobject]@{ col = 0; x = 0; y = 0 }; $tall[0] = $H }
  $px = $(if ($c.position -in 'bl', 'tl') { $wa.Left + $gap + $mine.x } elseif ($c.position -eq 'center') { $wa.Left + ($wa.Width - $W) / 2 + $mine.x } else { $wa.Right - $W - $gap - $mine.x })
  $py = $(if ($c.position -in 'tr', 'tl') { $wa.Top + $gap + $mine.y } elseif ($c.position -eq 'center') { $wa.Top + ($wa.Height - $tall[$mine.col]) / 2 + $mine.y } else { $wa.Bottom - $H - $gap - $mine.y })
  # nunca para fora da tela, mesmo com alarmes demais
  $px = [Math]::Max($wa.Left, [Math]::Min($wa.Right - $W, $px)); $py = [Math]::Max($wa.Top, [Math]::Min($wa.Bottom - $H, $py))
  New-Object System.Drawing.Point ([int]$px), ([int]$py)
}
$script:goal = & $place
$f.Location = $script:goal
$look = New-Object System.Windows.Forms.Timer; $look.Interval = 250; $look.Add_Tick({ try { $script:goal = & $place } catch { } }); $look.Start()
# desliza até o lugar novo em vez de pular
$ease = { param($from, $to) $d = $to - $from; if ([Math]::Abs($d) -le 2) { $to } else { $from + [int][Math]::Round($d * 0.3) } }
$slide = New-Object System.Windows.Forms.Timer; $slide.Interval = 15; $slide.Add_Tick({ try { $at = $f.Location; if ($at -ne $script:goal) { $f.Location = New-Object System.Drawing.Point (& $ease $at.X $script:goal.X), (& $ease $at.Y $script:goal.Y) } } catch { } }); $slide.Start()
$player = $null
if ($c.sound_path) { try { $player = New-Object System.Media.SoundPlayer $c.sound_path; if ($c.repeat -eq 'loop') { $player.PlayLooping() } else { $player.Play() } } catch { $player = $null } }
if ([int]$c.seconds -gt 0) { $end = New-Object System.Windows.Forms.Timer; $end.Interval = [int]$c.seconds * 1000; $end.Add_Tick({ $end.Stop(); $f.Close() }); $end.Start() }
if ($c.blink -eq 'yes') { $script:on = $true; $bl = New-Object System.Windows.Forms.Timer; $bl.Interval = 550; $bl.Add_Tick({ $script:on = -not $script:on; $f.BackColor = $(if ($script:on) { $accent } else { $bg }) }); $bl.Start() }
[System.Windows.Forms.Application]::Run($f)
try { [IO.File]::Delete($me) } catch { }
if ($player) { $player.Stop() }
Write-Output (@{ closed = $script:closed } | ConvertTo-Json -Compress)
"#;
/// Nó Alarme: uma janela do PowerShell (WinForms), por cima de tudo, no canto escolhido.
async fn alarm_node(p: &Value, input: &Value) -> ApiResult<Value> {
    let sound = text_of(p, "sound");
    let sound_path = match sound.as_str() {
        "" => String::new(),
        "custom" => { let f = path_of(p, "sound_file").map_err(|_| fail("escolha o arquivo de som", 400))?; if !f.is_file() { return Err(fail(format!("arquivo de som não encontrado: {}", f.display()), 404)); } f.to_string_lossy().into_owned() }
        name => { if !system_sounds().iter().any(|s| s == name) { return Err(fail(format!("som do Windows não encontrado: {name}"), 404)); }
            std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into())).join("Media").join(name).to_string_lossy().into_owned() }
    };
    let custom = text_of(p, "color");
    let custom = custom.trim();
    let color = if custom.len() == 7 && custom.starts_with('#') && custom[1..].chars().all(|c| c.is_ascii_hexdigit()) { custom.to_string() }
        else if !custom.is_empty() { return Err(fail("a cor de destaque é no formato #RRGGBB", 400)); }
        else { match p["level"].as_str().unwrap_or("warn") { "info" => "#3B82F6", "ok" => "#2EA66B", "error" => "#E0483F", _ => "#E3A63A" }.to_string() };
    let seconds = p["seconds"].as_u64().unwrap_or(0).min(86400);
    let title = text_of(p, "title");
    let button = text_of(p, "button");
    let cfg = json!({
        "title": if title.trim().is_empty() { "Alarme".to_string() } else { title.chars().take(200).collect() }, "message": text_of(p, "message").chars().take(2000).collect::<String>(),
        "color": color, "theme": p["theme"].as_str().unwrap_or("dark"), "opacity": p["opacity"].as_u64().unwrap_or(100).clamp(30, 100), "width": p["width"].as_u64().unwrap_or(380).clamp(240, 900),
        "position": p["position"].as_str().unwrap_or("br"), "sound_path": sound_path, "repeat": p["repeat"].as_str().unwrap_or("once"), "seconds": seconds, "blink": p["blink"].as_str().unwrap_or("yes"),
        // sem botão nenhum e sem tempo, ninguém conseguiria fechar
        "button": if button.trim().is_empty() && seconds == 0 { "OK".to_string() } else { button.trim().chars().take(40).collect() }, "button2": text_of(p, "button2").trim().chars().take(40).collect::<String>(),
    });
    let env = json!({"BS_ALARM": cfg.to_string()});
    if p["wait"] == "yes" {
        let timeout = if seconds > 0 { seconds * 1000 + 20_000 } else { 3_600_000 };
        let r = run_ps(ALARM_PS, &Value::Null, &json!(timeout), env).await.map_err(|e| fail(e.msg.replace("o programa falhou: ", "o alarme não abriu: "), e.status))?;
        let v: Value = serde_json::from_str(r.as_str().unwrap_or("").lines().last().unwrap_or("").trim()).unwrap_or(json!({"closed":"timeout"}));
        return Ok(json!({"closed": v["closed"], "title": cfg["title"]}));
    }
    // sem esperar: o script fica num arquivo fixo (o processo ainda o usa depois que o nó termina)
    let file = std::env::temp_dir().join("bluescreen-alarme.ps1");
    let mut body = vec![0xEF, 0xBB, 0xBF];
    body.extend(ALARM_PS.as_bytes());
    if std::fs::read(&file).ok().as_deref() != Some(body.as_slice()) { std::fs::write(&file, body)?; }
    service("automator", "plugin/proc", json!({"action":"start","program":"powershell","args":["-NoProfile","-ExecutionPolicy","Bypass","-File",file.to_string_lossy()],"env":env,"label":"Alarme"})).await?;
    Ok(input.clone())
}
/// Nós que tratam JSON: o que sai de uma requisição, de um script ou de outro nó, sem escrever código.
fn json_catalog() -> Value {
    let value = json!({"name":"value","label":"Dado","kind":"text","help":"Objeto ou lista. Texto em JSON também vale."});
    let list = json!({"name":"list","label":"Lista","kind":"text"});
    json!([
        {"type":"json.get","name":"Pegar campo","category":"JSON","desc":"Tira um valor de dentro do JSON pelo caminho dele.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","path":"","missing":"error","default":""},
         "fields":[value.clone(),{"name":"path","label":"Caminho do campo","kind":"text","placeholder":"disks.0.free_gb","paths":"value","help":"Nomes separados por ponto; número é a posição na lista (começa em 0)."},
            {"name":"missing","label":"Se o campo não existir","kind":"select","options":[{"value":"error","label":"Parar com erro"},{"value":"null","label":"Seguir com vazio"},{"value":"default","label":"Usar um valor padrão"}]},
            {"name":"default","label":"Valor padrão","kind":"text","show":{"missing":["default"]}}]},
        {"type":"json.pick","name":"Escolher campos","category":"JSON","desc":"Monta um objeto só com os campos que interessam.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","fields":[]},
         "fields":[value.clone(),{"name":"fields","label":"Campos (um por linha)","kind":"lines","paths":"value","each":true,"help":"O caminho do campo, ou novo_nome = caminho. Numa lista, vale para cada item."}]},
        {"type":"json.omit","name":"Remover campos","category":"JSON","desc":"Devolve o mesmo JSON sem os campos indicados.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","fields":[]},
         "fields":[value.clone(),{"name":"fields","label":"Campos (um por linha)","kind":"lines","paths":"value","each":true,"help":"Numa lista, vale para cada item."}]},
        {"type":"json.set","name":"Definir campo","category":"JSON","desc":"Cria ou troca o valor de um campo do JSON.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","path":"","new":"","as":"auto"},
         "fields":[value.clone(),{"name":"path","label":"Caminho do campo","kind":"text","placeholder":"status ou dono.nome","paths":"value"},{"name":"new","label":"Novo valor","kind":"text"},
            {"name":"as","label":"Guardar como","kind":"select","options":[{"value":"auto","label":"Descobrir (número, sim/não, JSON ou texto)"},{"value":"text","label":"Sempre texto"}]}]},
        {"type":"json.merge","name":"Juntar objetos","category":"JSON","desc":"Junta dois objetos num só; em campo repetido vale o segundo.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","other":"","deep":"no"},
         "fields":[{"name":"value","label":"Primeiro objeto","kind":"text"},{"name":"other","label":"Segundo objeto","kind":"area","placeholder":"{{nodes.…}} ou { \"campo\": \"valor\" }"},
            {"name":"deep","label":"Objetos dentro de objetos","kind":"select","options":[{"value":"no","label":"O segundo substitui"},{"value":"yes","label":"Juntar também"}]}]},
        {"type":"json.parse","name":"Ler JSON","category":"JSON","desc":"Transforma um texto em JSON para os próximos nós usarem os campos.","inputs":["in"],"outputs":["out"],
         "params":{"text":"{{input}}","mode":"find"},
         "fields":[{"name":"text","label":"Texto","kind":"area"},{"name":"mode","label":"Como ler","kind":"select","options":[{"value":"find","label":"Achar o JSON no meio do texto"},{"value":"strict","label":"O texto inteiro tem que ser JSON"}],"help":"Achar no meio serve para respostas de IA e saídas de programas."}]},
        {"type":"json.text","name":"JSON para texto","category":"JSON","desc":"Escreve o JSON como texto, para gravar em arquivo ou enviar.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","format":"pretty"},
         "fields":[value.clone(),{"name":"format","label":"Formato","kind":"select","options":[{"value":"pretty","label":"Indentado, fácil de ler"},{"value":"compact","label":"Numa linha só"}]}]},
        {"type":"json.entries","name":"Listar campos","category":"JSON","desc":"Transforma um objeto numa lista de campo e valor.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}"},"fields":[value.clone()]},
        {"type":"json.pluck","name":"Extrair de cada item","category":"JSON","desc":"Fica só com um campo de cada item da lista.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","field":""},
         "fields":[list.clone(),{"name":"field","label":"Campo do item","kind":"text","placeholder":"drive","paths":"list","item":true}]},
        {"type":"json.sort","name":"Ordenar lista","category":"JSON","desc":"Ordena a lista e, se quiser, fica só com os primeiros.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","field":"","order":"asc","limit":0},
         "fields":[list.clone(),{"name":"field","label":"Ordenar pelo campo","kind":"text","placeholder":"vazio: o item inteiro","paths":"list","item":true},
            {"name":"order","label":"Ordem","kind":"select","options":[{"value":"asc","label":"Crescente (A a Z, menor primeiro)"},{"value":"desc","label":"Decrescente (Z a A, maior primeiro)"}]},
            {"name":"limit","label":"Ficar com quantos","kind":"number","min":0,"max":100000,"help":"Zero: todos."}]},
        {"type":"json.group","name":"Agrupar lista","category":"JSON","desc":"Agrupa os itens pelo valor de um campo e conta cada grupo.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","field":""},
         "fields":[list.clone(),{"name":"field","label":"Agrupar pelo campo","kind":"text","placeholder":"status","paths":"list","item":true}]},
        {"type":"json.count","name":"Contar itens","category":"JSON","desc":"Conta os itens da lista ou os campos do objeto.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}"},"fields":[value]}
    ])
}
/// O que cada nó espera receber e o que entrega, com um exemplo da saída quando ela é JSON.
/// A tela mostra isso no painel do nó e usa o exemplo para sugerir campos antes da primeira execução.
fn io_doc(kind: &str) -> Option<(&'static str, &'static str, Value)> {
    const SAME: &str = "A mesma entrada, sem mudar.";
    const FILE: &str = "O caminho do arquivo gerado (texto).";
    let n = Value::Null;
    Some(match kind {
        "trigger.manual" => ("Nada: é o começo do fluxo.", "O texto do campo Entrada de exemplo (vazio se não preencher).", n),
        "trigger.schedule" | "trigger.startup" => ("Nada: é o começo do fluxo.", "Objeto com a hora do disparo, em milissegundos.", json!({"at": 1794485263000u64})),
        "trigger.file" => ("Nada: é o começo do fluxo.", "Objeto com o caminho vigiado.", json!({"path": "C:\\pasta\\arquivo.txt"})),
        "trigger.webhook" => ("Nada: começa quando chamam o endereço.", "Objeto com a chamada inteira: método, endereço, parâmetros da URL, cabeçalhos, cookies, corpo (já como JSON quando for), formulário, token, quem chamou (ip, user_agent) e a hora.",
            json!({"endpoint": "meu-endpoint", "method": "POST", "url": "/api/automator/hook?e=meu-endpoint&id=42", "path": "/api/automator/hook", "query_string": "e=meu-endpoint&id=42", "query": {"id": "42"},
                "headers": {"content-type": "application/json", "user-agent": "curl/8.0"}, "cookies": {"sessao": "abc"}, "body": {"campo": "valor"}, "form": null, "raw": "{\"campo\":\"valor\"}",
                "content_type": "application/json", "content_length": 17, "is_json": true, "token": "", "auth": {"scheme": "", "user": ""},
                "ip": "192.168.0.25", "remote": true, "host": "192.168.0.10:4748", "user_agent": "curl/8.0", "referer": "", "origin": "", "language": "pt-BR",
                "time": "2026-11-12T14:30:00-03:00", "timestamp": 1794504600000u64})),
        "logic.if" => ("Qualquer dado. O que se compara é o campo Valor.", "A mesma entrada, pela saída sim ou pela saída não.", n),
        "util.delay" | "windows.notify" | "windows.open" | "notify.chat" => ("Qualquer dado.", SAME, n),
        "logic.stop" => ("Qualquer dado.", "Nada: o fluxo para com a mensagem de erro.", n),
        "logic.assert" | "sec.token" | "sec.rate" | "sec.hmac" | "sec.require" => ("O dado a conferir (em geral, a chamada do Endpoint HTTP).", "A mesma entrada quando passa; se não passar, o fluxo para com erro.", n),
        "util.text" => ("Qualquer dado, para usar dentro do texto com {{input}}.", "O texto montado.", n),
        "util.output" => ("Qualquer dado.", "A mesma entrada: serve para mostrar o resultado no fim.", n),
        "text.replace" | "text.case" => ("Um texto.", "O texto alterado.", n),
        "text.extract" => ("Um texto.", "O trecho achado (texto), ou a lista de todos os trechos.", n),
        "text.split" => ("Um texto.", "Lista de textos.", json!(["primeiro", "segundo"])),
        "text.join" => ("Uma lista.", "Um texto com os itens juntos.", n),
        "text.count" => ("Um texto.", "Objeto com as contagens.", json!({"chars": 120, "words": 21, "lines": 3})),
        "data.set" => ("Qualquer dado, para usar nos valores com {{input}}.", "O objeto montado com os campos definidos.", n),
        "data.datetime" => ("Nada em especial.", "A data e hora como texto, no formato escolhido.", n),
        "data.csv" => ("Texto CSV, com os nomes dos campos na primeira linha.", "Lista de objetos, um por linha do CSV.", json!([{"nome": "Ana", "idade": "31"}])),
        "data.filter" => ("Uma lista (de objetos ou de valores).", "Lista só com os itens que passaram.", n),
        "data.stats" => ("Uma lista de números, ou de objetos com um campo numérico.", "Objeto com o resumo.", json!({"count": 4, "sum": 100.0, "avg": 25.0, "min": 10.0, "max": 40.0})),
        "data.table" => ("Uma lista de objetos.", "A tabela como texto (Markdown, CSV ou HTML).", n),
        "file.read" => ("Nada em especial: o caminho vem do campo.", "O conteúdo do arquivo (texto).", n),
        "file.write" => ("O conteúdo a gravar (texto).", "O caminho do arquivo gravado (texto).", n),
        "file.list" => ("Nada em especial: a pasta vem do campo.", "Lista com o caminho de cada arquivo.", json!(["C:\\pasta\\a.txt", "C:\\pasta\\b.txt"])),
        "file.exists" => ("Qualquer dado.", "A mesma entrada, pela saída sim ou pela saída não.", n),
        "file.manage" => ("Nada em especial: os caminhos vêm dos campos.", "O caminho final do arquivo (texto).", n),
        "flow.call" => ("Qualquer dado: vira a entrada do fluxo chamado.", "O resultado do fluxo chamado: o que chegou no nó Resultado dele ou, sem esse nó, a saída do último nó que rodou.", n),
        "windows.command" => ("Qualquer dado, para usar nos argumentos.", "O que o programa escreveu na tela (texto). Se for JSON, ligue um Ler JSON.", n),
        "windows.powershell" => ("Qualquer dado: chega no script em $env:BS_INPUT.", "O que o script escreveu (texto). Se for JSON, ligue um Ler JSON.", n),
        "windows.clipboard" => ("O texto a copiar, quando for para gravar.", "Ao ler: o texto copiado. Ao gravar: a mesma entrada.", n),
        "windows.alarm" => ("Qualquer dado, para usar no título e na mensagem.", "A mesma entrada. Com Espera o alarme fechar: objeto com o botão clicado (ou timeout).", json!({"closed": "OK", "title": "Alarme"})),
        "sys.info" => ("Nada.", "Objeto com CPU, memória, discos e horas ligado.",
            json!({"cpu_percent": 12, "disks": [{"drive": "C:", "free_gb": 15.2, "total_gb": 222.5, "used_percent": 93}], "memory_free_gb": 18.6, "memory_percent": 41, "memory_total_gb": 31.4, "uptime_hours": 24})),
        "sys.process" => ("Nada em especial.", "Objeto com o programa, pela saída sim ou pela saída não.", json!({"name": "chrome", "running": true, "count": 12})),
        "http.request" => ("Qualquer dado, para usar no endereço, nos cabeçalhos e no corpo.", "A resposta do servidor: já como JSON quando for JSON, senão texto.", n),
        "http.download" => ("Nada em especial: o endereço vem do campo.", "O caminho do arquivo baixado (texto).", n),
        "http.respond" => ("O dado a devolver para quem chamou o endpoint.", "Objeto com o que foi respondido.", json!({"status": 200, "type": "json", "body": {"ok": true}})),
        "mcp.call" => ("Qualquer dado, para usar nos argumentos.", "A resposta da ferramenta MCP.", n),
        "agent.cli" | "ai.openrouter" => ("Qualquer dado, para usar no pedido com {{input}}.", "A resposta da IA (texto). Se pediu JSON, ligue um Ler JSON.", n),
        "audit.http" => ("Nada em especial: o endereço vem do campo.", "Objeto com a resposta do site, pela saída sim (no ar) ou não.", json!({"status": 200, "ms": 180, "size": 51234, "final_url": "https://exemplo.com/", "reason": ""})),
        "audit.headers" => ("Nada em especial: o endereço vem do campo.", "Objeto com a nota e os cabeçalhos que faltam.",
            json!({"url": "https://exemplo.com/", "https": true, "score": "5/7", "points": 5, "present": ["strict-transport-security"], "missing": [{"header": "content-security-policy", "why": "…"}]})),
        "audit.tls" => ("Nada em especial: o endereço vem do campo.", "Objeto com o certificado e quantos dias faltam.", json!({"host": "exemplo.com", "expires": "2027-03-01", "days": 108, "issuer": "CN=…", "subject": "CN=exemplo.com", "protocol": "Tls13"})),
        "audit.port" => ("Nada em especial.", "Objeto com o teste, pela saída sim (aberta) ou não.", json!({"host": "exemplo.com", "port": 443, "open": true, "ms": 22})),
        "audit.links" => ("Nada em especial: o endereço vem do campo.", "Objeto com quantos links foram testados e a lista dos quebrados.", json!({"url": "https://exemplo.com/", "checked": 40, "broken": [{"url": "https://exemplo.com/x", "reason": "404"}], "ok": false})),
        "dynatrace.problems" => ("Nada em especial.", "Objeto com o total e a lista de problemas.", json!({"total": 1, "problems": [{"id": "P-2611", "title": "Response time degradation", "severity": "PERFORMANCE", "impact": "SERVICES", "status": "OPEN", "start": "2026-11-12T09:00:00+00:00"}]})),
        "dynatrace.metric" => ("Nada em especial.", "Objeto com as séries da métrica.", json!({"metric": "builtin:service.response.time", "series": [{"dimensions": ["SERVICE-1"], "last": 120.5, "avg": 98.2, "max": 310.0, "points": 60}]})),
        "dynatrace.event" => ("Qualquer dado, para usar no título e nas propriedades.", "A resposta do Dynatrace ao registrar o evento.", n),
        "image.info" => ("Nada em especial: o arquivo vem do campo.", "Objeto com o tamanho da imagem.", json!({"width": 1920, "height": 1080})),
        "media.info" => ("Nada em especial: o arquivo vem do campo.", "Objeto com duração, tamanho e formatos.", json!({"seconds": 93.4, "duration": "00:01:33", "size": 10485760, "format": "mov,mp4", "width": 1920, "height": 1080, "video": "h264", "audio": "aac"})),
        k if k.starts_with("image.") || k.starts_with("audio.") || k.starts_with("video.") => ("Nada em especial: o arquivo vem do campo (pode ser a saída de outro nó).", FILE, n),
        "time.window" => ("Qualquer dado: segue adiante sem mudar.", "A mesma entrada, pela saída sim (é dia e horário) ou não (fora do horário, ou dia de folga).", n),
        "logic.each" => ("Uma lista (ou texto em JSON com uma lista).", "Pela saída item: um item por vez, que chega como {{input}} no trecho ligado ali ({{nodes.ID.index}} é a posição, {{nodes.ID.total}} o total). Pela saída done, uma vez no fim: a lista com o que o último nó do trecho entregou em cada volta.", n),
        "logic.repeat" => ("Qualquer dado.", "Pela saída loop: a mesma entrada, uma vez por volta ({{nodes.ID.index}} é o número da volta). Pela saída done, no fim: a lista com o resultado de cada volta.", n),
        "logic.while" => ("Qualquer dado.", "Pela saída loop: na primeira volta a entrada, depois o que a volta anterior entregou. Pela saída done, quando a condição deixa de valer: o último resultado.", n),
        "logic.break" | "logic.next" => ("Qualquer dado.", "Nada: o laço termina (Sair do laço) ou passa para o próximo item (Próximo item).", n),
        "logic.try" => ("Qualquer dado.", "Pela saída try: a mesma entrada, para o trecho protegido. Depois, pela saída ok: o que o último nó do trecho entregou; ou pela saída error: a mensagem do erro.", json!({"error": "Requisição HTTP: o servidor respondeu 500", "attempts": 3, "input": "o que tinha chegado"})),
        "logic.switch" => ("Qualquer dado. O que se compara é o campo Valor.", "A mesma entrada, pela saída do primeiro caso que casar (1 a 5) ou por other.", n),
        "logic.all" => ("Qualquer dado.", "A mesma entrada, pela saída sim ou pela saída não.", n),
        "logic.var" => ("Qualquer dado, para usar no valor.", "O valor que ficou guardado na variável.", n),
        "time.now" => ("Nada em especial.", "A data e a hora de agora em campos.", json!({"date": "12/11/2026", "time": "14:30", "iso": "2026-11-12T14:30:00-03:00", "weekday": 4, "weekday_name": "quinta", "weekend": false, "day": 12, "month": 11, "year": 2026, "hour": 14, "minute": 30, "timestamp": 1794504600000u64})),
        "time.compare" => ("Qualquer dado: segue adiante sem mudar.", "A mesma entrada, pela saída sim ou não conforme a comparação das datas.", n),
        "time.shift" => ("Qualquer dado, para usar no campo Data.", "A data calculada, como texto no formato escolhido (ou número, ou campos).", n),
        "time.until" => ("Qualquer dado: segue adiante sem mudar.", "A mesma entrada, depois da espera.", n),
        "qa.api" => ("Qualquer dado, para usar no endereço, nos cabeçalhos e no corpo.", "O resultado do teste, pela saída sim (passou) ou não (falhou): cada conferência, o status, o tempo e a resposta.",
            json!({"ok": true, "name": "GET https://exemplo.com/api", "passed": 2, "failed": 0, "total": 2, "status": 200, "ms": 180, "checks": [{"name": "Status", "ok": true, "got": 200, "expected": "200"}], "body": {"itens": []}})),
        "qa.data" => ("Nada.", "Um objeto com os dados gerados (ou uma lista, quando pede mais de um).", json!({"nome": "Ana Souza", "email": "ana.souza482@exemplo.com", "cpf": "529.982.247-25", "telefone": "(11) 98765-4321"})),
        "qa.load" => ("Nada em especial: o endereço vem do campo.", "As medidas da carga, pela saída sim (dentro dos limites) ou não.",
            json!({"ok": true, "name": "Carga em https://exemplo.com/", "requests": 50, "succeeded": 50, "failed": 0, "error_percent": 0.0, "avg_ms": 120, "p50_ms": 110, "p95_ms": 240, "max_ms": 310, "seconds": 1.4, "per_second": 35.7, "statuses": {"200": 50}, "error": ""})),
        "qa.report" => ("O resultado de Testar site ou Testar API, ou uma lista deles.", "Objeto com o caminho do arquivo gravado e os totais.", json!({"path": "C:\\Temp\\relatorio-testes.html", "ok": true, "passed": 5, "failed": 0, "skipped": 0, "total": 5})),
        "json.get" => ("Um objeto ou uma lista (texto em JSON também vale).", "O valor do campo: texto, número, objeto ou lista.", n),
        "json.pick" => ("Um objeto, ou uma lista de objetos.", "Objeto só com os campos escolhidos (ou a lista deles).", n),
        "json.omit" => ("Um objeto, ou uma lista de objetos.", "O mesmo JSON sem os campos removidos.", n),
        "json.set" => ("Um objeto (vazio: começa um novo).", "O objeto com o campo criado ou trocado.", n),
        "json.merge" => ("Dois objetos.", "Um objeto com os campos dos dois.", n),
        "json.parse" => ("Um texto com JSON dentro.", "O JSON lido: objeto ou lista, pronto para os outros nós.", n),
        "json.text" => ("Um objeto ou uma lista.", "O JSON escrito como texto.", n),
        "json.entries" => ("Um objeto (ou uma lista).", "Lista de objetos com key e value.", json!([{"key": "cpu_percent", "value": 12}])),
        "json.pluck" => ("Uma lista de objetos.", "Lista só com o valor daquele campo.", json!(["C:", "D:"])),
        "json.sort" => ("Uma lista.", "A lista ordenada (e cortada, se pediu um limite).", n),
        "json.group" => ("Uma lista de objetos.", "Lista de grupos, do maior para o menor.", json!([{"key": "OPEN", "count": 3, "items": []}])),
        "json.count" => ("Uma lista, um objeto ou um texto.", "Um número: itens da lista, campos do objeto ou letras do texto.", n),
        _ => return None,
    })
}
/// O formato do que o nó recebe e do que devolve, para a etiqueta nas bolinhas: text, object (JSON), list, number,
/// image, audio, video, file, any (qualquer dado), same (devolve o que recebeu) e none (não recebe ou não devolve).
fn io_kind(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "trigger.manual" => ("none", "text"),
        k if k.starts_with("trigger.") => ("none", "object"),
        "logic.stop" => ("any", "none"),
        "logic.if" | "logic.assert" | "util.delay" | "util.output" | "windows.notify" | "windows.open" | "windows.alarm" | "notify.chat" | "file.exists" | "time.window" | "time.compare" | "time.until" => ("any", "same"),
        "time.now" => ("none", "object"),
        "time.shift" => ("any", "text"),
        "logic.each" => ("list", "any"),
        "logic.break" | "logic.next" => ("any", "none"),
        "logic.repeat" | "logic.while" | "logic.try" | "logic.var" => ("any", "any"),
        "logic.switch" | "logic.all" => ("any", "same"),
        k if k.starts_with("sec.") => ("object", "same"),
        "util.text" | "data.datetime" | "file.read" | "windows.command" | "windows.powershell" | "windows.clipboard" | "agent.cli" | "ai.openrouter" => ("any", "text"),
        "text.replace" | "text.case" | "text.extract" => ("text", "text"),
        "text.split" | "data.csv" => ("text", "list"),
        "text.join" | "data.table" => ("list", "text"),
        "text.count" | "json.parse" => ("text", "object"),
        "data.set" | "sys.info" | "sys.process" | "http.request" | "http.respond" | "mcp.call" => ("any", "object"),
        k if k.starts_with("audit.") || k.starts_with("dynatrace.") => ("any", "object"),
        "data.filter" | "json.pluck" | "json.sort" | "json.group" => ("list", "list"),
        "data.stats" => ("list", "object"),
        "file.write" => ("text", "file"),
        "file.list" => ("any", "list"),
        "file.manage" | "http.download" => ("any", "file"),
        "image.info" => ("image", "object"),
        "media.info" => ("file", "object"),
        "video.audio" => ("video", "audio"),
        "video.frame" => ("video", "image"),
        k if k.starts_with("image.") => ("image", "image"),
        k if k.starts_with("audio.") => ("audio", "audio"),
        k if k.starts_with("video.") => ("video", "video"),
        "qa.api" | "qa.load" => ("any", "object"),
        "qa.data" => ("none", "object"),
        "qa.report" => ("object", "object"),
        "json.get" => ("object", "any"),
        "json.pick" | "json.omit" | "json.set" | "json.merge" => ("object", "object"),
        "json.text" => ("object", "text"),
        "json.entries" => ("object", "list"),
        "json.count" => ("any", "number"),
        _ => return None,
    })
}
/// Texto que é JSON (objeto ou lista) vira o valor; o resto fica como está.
fn json_in(v: &Value) -> Value {
    match v {
        Value::String(s) if s.trim_start().starts_with(['{', '[']) => serde_json::from_str(s.trim()).unwrap_or_else(|_| v.clone()),
        _ => v.clone(),
    }
}
/// Valor digitado num campo de texto: número, true/false e JSON são reconhecidos; o resto é texto.
fn auto_value(v: &Value) -> Value {
    match v { Value::String(s) if !s.trim().is_empty() => serde_json::from_str(s.trim()).unwrap_or_else(|_| v.clone()), _ => v.clone() }
}
fn set_path(root: &mut Value, path: &str, new: Value) -> ApiResult<()> {
    let keys: Vec<&str> = path.split('.').filter(|k| !k.is_empty()).collect();
    let Some((last, head)) = keys.split_last() else { return Err(fail("informe o caminho do campo", 400)) };
    let spot = |a: &[Value], k: &str| k.parse::<usize>().ok().filter(|i| *i < a.len()).ok_or_else(|| fail(format!("a lista não tem a posição {k}"), 400));
    let mut cur = root;
    for k in head {
        cur = match cur {
            Value::Array(a) => { let i = spot(a, k)?; &mut a[i] }
            other => { if !other.is_object() { *other = json!({}); } other.as_object_mut().unwrap().entry(k.to_string()).or_insert_with(|| json!({})) }
        };
    }
    match cur {
        Value::Array(a) => { if last.parse::<usize>().ok() == Some(a.len()) { a.push(new); } else { let i = spot(a, last)?; a[i] = new; } }
        other => { if !other.is_object() { *other = json!({}); } other.as_object_mut().unwrap().insert(last.to_string(), new); }
    }
    Ok(())
}
fn remove_path(root: &mut Value, path: &str) {
    let keys: Vec<&str> = path.split('.').filter(|k| !k.is_empty()).collect();
    let Some((last, head)) = keys.split_last() else { return };
    let mut cur = root;
    for k in head {
        cur = match cur {
            Value::Array(a) => match k.parse::<usize>().ok().and_then(|i| a.get_mut(i)) { Some(x) => x, None => return },
            Value::Object(o) => match o.get_mut(*k) { Some(x) => x, None => return },
            _ => return,
        };
    }
    match cur {
        Value::Object(o) => { o.remove(*last); }
        Value::Array(a) => { if let Some(i) = last.parse::<usize>().ok().filter(|i| *i < a.len()) { a.remove(i); } }
        _ => {}
    }
}
fn merge_into(a: &mut Value, b: &Value, deep: bool) {
    let (Value::Object(x), Value::Object(y)) = (a, b) else { return };
    for (k, v) in y {
        if deep && v.is_object() && x.get(k).is_some_and(Value::is_object) { merge_into(x.get_mut(k).unwrap(), v, true); } else { x.insert(k.clone(), v.clone()); }
    }
}
/// Ordem entre dois valores: números pelo valor ("10" depois de "9"), o resto pelo texto, sem diferenciar maiúsculas.
fn order_of(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (number_of(a), number_of(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        _ => stringify(a).to_lowercase().cmp(&stringify(b).to_lowercase()),
    }
}
fn json_node(kind: &str, p: &Value) -> ApiResult<Value> {
    let field = |k: &str| text_of(p, k).trim().to_string();
    let lines = |k: &str| -> Vec<String> { let all: Vec<String> = match &p[k] { Value::Array(a) => a.iter().map(stringify).collect(), v => stringify(v).lines().map(String::from).collect() }; all.into_iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect() };
    let at = |v: &Value, path: &str| if path.is_empty() { v.clone() } else { dig(v, path).unwrap_or(Value::Null) };
    let structured = |v: Value, what: &str| if v.is_object() || v.is_array() { Ok(v) } else { Err(fail(format!("{what}: o que chegou não é um JSON (objeto ou lista). Se for texto, ligue um Ler JSON antes."), 400)) };
    Ok(match kind {
        "json.get" => {
            let (v, path) = (json_in(&p["value"]), field("path"));
            match if path.is_empty() { Some(v.clone()) } else { dig(&v, &path) } {
                Some(x) => x,
                None => match p["missing"].as_str().unwrap_or("error") {
                    "null" => Value::Null,
                    "default" => auto_value(&p["default"]),
                    _ => return Err(fail(format!("o campo {path} não existe no dado que chegou"), 400)),
                },
            }
        }
        "json.pick" => {
            let picks: Vec<(String, String)> = lines("fields").into_iter().map(|l| match l.split_once('=') {
                Some((name, path)) => (name.trim().to_string(), path.trim().to_string()),
                None => (l.rsplit('.').next().unwrap_or(&l).to_string(), l.clone()),
            }).collect();
            if picks.is_empty() { return Err(fail("informe ao menos um campo", 400)); }
            let one = |v: &Value| Value::Object(picks.iter().map(|(name, path)| (name.clone(), dig(v, path).unwrap_or(Value::Null))).collect());
            match structured(json_in(&p["value"]), "Escolher campos")? { Value::Array(a) => Value::Array(a.iter().map(one).collect()), v => one(&v) }
        }
        "json.omit" => {
            let drop = lines("fields");
            let one = |mut v: Value| { for d in &drop { remove_path(&mut v, d); } v };
            match structured(json_in(&p["value"]), "Remover campos")? { Value::Array(a) => Value::Array(a.into_iter().map(one).collect()), v => one(v) }
        }
        "json.set" => {
            let mut v = json_in(&p["value"]);
            if v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()) { v = json!({}); }
            let mut v = structured(v, "Definir campo")?;
            set_path(&mut v, &field("path"), if p["as"] == "text" { json!(stringify(&p["new"])) } else { auto_value(&p["new"]) })?;
            v
        }
        "json.merge" => {
            let (mut a, b) = (json_in(&p["value"]), json_in(&p["other"]));
            if !a.is_object() || !b.is_object() { return Err(fail("Juntar objetos: os dois lados precisam ser objetos ({ \"campo\": valor })", 400)); }
            merge_into(&mut a, &b, p["deep"] == "yes");
            a
        }
        "json.parse" => {
            if p["text"].is_object() || p["text"].is_array() { return Ok(p["text"].clone()); }
            let text = stringify(&p["text"]);
            if p["mode"] == "strict" { return serde_json::from_str(text.trim()).map_err(|e| fail(format!("o texto não é um JSON válido: {e}"), 400)); }
            text.char_indices().filter(|(_, c)| matches!(c, '{' | '[')).find_map(|(i, _)| serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>().next().and_then(Result::ok))
                .ok_or_else(|| fail("não achei um JSON no texto", 400))?
        }
        "json.text" => {
            let v = json_in(&p["value"]);
            json!(if p["format"] == "compact" { v.to_string() } else { serde_json::to_string_pretty(&v)? })
        }
        "json.entries" => match structured(json_in(&p["value"]), "Listar campos")? {
            Value::Object(o) => Value::Array(o.into_iter().map(|(k, v)| json!({"key": k, "value": v})).collect()),
            Value::Array(a) => Value::Array(a.into_iter().enumerate().map(|(i, v)| json!({"key": i, "value": v})).collect()),
            _ => unreachable!(),
        },
        "json.pluck" => {
            let f = field("field");
            if f.is_empty() { return Err(fail("informe o campo do item", 400)); }
            Value::Array(list_of(&p["list"]).iter().map(|i| at(i, &f)).collect())
        }
        "json.sort" => {
            let f = field("field");
            let mut list = list_of(&p["list"]);
            list.sort_by(|a, b| order_of(&at(a, &f), &at(b, &f)));
            if p["order"] == "desc" { list.reverse(); }
            let limit = p["limit"].as_u64().unwrap_or(0) as usize;
            if limit > 0 { list.truncate(limit); }
            Value::Array(list)
        }
        "json.group" => {
            let f = field("field");
            if f.is_empty() { return Err(fail("informe o campo para agrupar", 400)); }
            let mut groups: Vec<(Value, Vec<Value>)> = vec![];
            for item in list_of(&p["list"]) {
                let key = at(&item, &f);
                match groups.iter_mut().find(|g| g.0 == key) { Some(g) => g.1.push(item), None => groups.push((key, vec![item])) }
            }
            groups.sort_by_key(|g| std::cmp::Reverse(g.1.len()));
            Value::Array(groups.into_iter().map(|(key, items)| json!({"key": key, "count": items.len(), "items": items})).collect())
        }
        "json.count" => json!(match json_in(&p["value"]) { Value::Array(a) => a.len(), Value::Object(o) => o.len(), Value::String(s) => s.chars().count(), Value::Null => 0, _ => 1 }),
        _ => return Err(fail(format!("tipo de nó desconhecido: {kind}"), 400)),
    })
}
const GEN_RULES: &str = "# Regras
- Comece por um gatilho (categoria Gatilhos). Use só os tipos, portas e parâmetros listados em 'Nós disponíveis', com os valores permitidos. Não invente tipo de nó nem parâmetro.
- Cada nó diz o que recebe e o que devolve (texto, JSON, lista, número, arquivo). Ligue a saída de um nó a outro que aceite aquele formato. Se um nó devolve texto e o próximo precisa de JSON, ponha um json.parse no meio; para tirar um campo de um JSON use json.get ou {{input.campo}}.
- Dados entre nós: {{input}} é o que chegou no nó; {{input.campo.sub}} é um campo do JSON que chegou; {{nodes.ID.out}} (ou {{nodes.ID.true}}) é a saída de um nó anterior. Não existe outra expressão: nada de {{now}}, {{trigger...}} ou {{ID.campo}}. Só use campos que aparecem em 'saída' do nó de origem.
- Nós com as portas true e false (Condição, Testar site, Testar API e parecidos) seguem por um caminho ou pelo outro: ligue from_port 'true' e/ou 'false'.
- Todo nó que não é gatilho precisa de uma conexão chegando nele. Sem ciclos: nenhuma conexão volta para um nó anterior.
- Para repetir um trecho use logic.each (uma vez por item de uma lista), logic.repeat (N vezes) ou logic.while (enquanto a condição valer). O trecho que repete é o que sai da porta 'item' (ou 'loop'); dentro dele {{input}} é o item da vez. O que vem depois do laço sai da porta 'done' e recebe a lista dos resultados. Um nó de dentro do laço não se liga a um nó de fora nem recebe conexão de fora: para ler um nó de fora use {{nodes.ID.out}}. logic.break sai do laço; logic.next pula para o próximo item.
- Para não parar o fluxo num erro (ou tentar de novo), use logic.try: o trecho protegido sai da porta 'try'; depois siga por 'ok' ou por 'error'. Para mais de dois caminhos use logic.switch; para várias condições juntas, logic.all. Para contar ou acumular entre as voltas, logic.var e {{vars.nome}}.
- Dê um title curto a cada nó, dizendo o que aquele passo faz neste fluxo.
- Preencha os parâmetros com o que o pedido informou (endereços, pastas, horários, textos). O que o pedido não informou e o usuário precisa preencher ou conferir vai em 'notes', uma frase curta por item, dizendo em qual nó.
- Senhas, tokens e chaves nunca ficam escritos no fluxo: use {{cred:nome}}, uma credencial do Automator ({{cred:nome.user}} é o usuário dela). Reaproveite as de 'Credenciais que já existem' quando servirem. O pedido pode trazer {{cred:nome}} no lugar de uma senha que o usuário escreveu: use exatamente essa referência onde a senha é usada. Se ainda houver uma senha ou token escrito no pedido, não o copie para o fluxo: dê um nome, use {{cred:nome}} e liste em 'secrets' como {\"name\":\"nome\",\"value\":\"o valor\"}.
- {{cred:nome}} funciona nos campos dos nós e dentro do script de windows.powershell (fora de aspas simples). Não funciona nos argumentos de windows.command.
- Dias e horários: para o fluxo rodar sozinho só em certos dias e horas, use trigger.schedule com 'days' e, no modo interval, window 'between' com 'from' e 'to'. Para decidir no meio do fluxo se agora é dia e hora de trabalho, use time.window (saídas true e false). Os dias são números: 1 segunda … 6 sábado, 0 domingo.\n- Prefira os nós prontos a scripts (windows.powershell e windows.command só quando nenhum nó faz o trabalho). Num script, o que chegou vem em $env:BS_INPUT e a saída é o que o script escrever.
- Sites: para entrar num site, clicar, preencher e ler o que está na tela, use browser.run. Cada passo é {\"do\":ação,\"on\":onde,\"value\":valor}; 'on' é um seletor CSS ou texto=Rótulo do botão. Vários browser.run no mesmo fluxo continuam na mesma página (deixe 'url' vazio nos seguintes). Se não souber os seletores do site, deixe os passos que souber e avise em 'notes' que o usuário pode completar com o botão Gravar.
- Servidores e serviços: ssh.run e ssh.copy (SSH e SFTP), mail.send e mail.read (e-mail), ftp.files, db.query (SQL), mqtt.publish, notify.telegram. Usuário e senha deles vêm de uma credencial: {{cred:nome.user}} e {{cred:nome}}.
- Não execute nada nem altere arquivos agora: só descreva o fluxo.";
const GEN_FORMAT: &str = "{\"name\":\"Nome\",\"description\":\"Para que serve\",\"notes\":[\"o que o usuário ainda precisa preencher ou conferir\"],\"secrets\":[],\"nodes\":[{\"id\":\"n1\",\"type\":\"trigger.manual\",\"title\":\"nome do passo\",\"params\":{\"sample\":\"\"},\"position\":[60,100]}],\"edges\":[{\"from\":\"n1\",\"from_port\":\"out\",\"to\":\"n2\",\"to_port\":\"in\"}]}";
const GEN_EXAMPLE: &str = "Pedido: A cada 30 minutos, chamar https://api.exemplo.com/status com o token {{cred:token-exemplo}} e me avisar se o campo ok vier falso.
Resposta: {\"name\":\"Vigiar a API\",\"description\":\"Chama o status a cada 30 minutos e avisa quando ok vem falso.\",\"notes\":[\"Consultar o status: confira se o token vai mesmo no cabeçalho Authorization.\"],\"secrets\":[],\"nodes\":[{\"id\":\"n1\",\"type\":\"trigger.schedule\",\"title\":\"A cada 30 minutos\",\"params\":{\"mode\":\"interval\",\"every_minutes\":30}},{\"id\":\"n2\",\"type\":\"http.request\",\"title\":\"Consultar o status\",\"params\":{\"url\":\"https://api.exemplo.com/status\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"Bearer {{cred:token-exemplo}}\"}}},{\"id\":\"n3\",\"type\":\"logic.if\",\"title\":\"ok veio falso?\",\"params\":{\"value\":\"{{input.ok}}\",\"op\":\"eq\",\"equals\":\"false\"}},{\"id\":\"n4\",\"type\":\"windows.notify\",\"title\":\"Avisar\",\"params\":{\"title\":\"API com problema\",\"message\":\"O status respondeu ok = falso.\"}}],\"edges\":[{\"from\":\"n1\",\"from_port\":\"out\",\"to\":\"n2\",\"to_port\":\"in\"},{\"from\":\"n2\",\"from_port\":\"out\",\"to\":\"n3\",\"to_port\":\"in\"},{\"from\":\"n3\",\"from_port\":\"true\",\"to\":\"n4\",\"to_port\":\"in\"}]}";
/// O pedido inteiro para a IA que monta (ou altera, com `current`) um fluxo.
fn gen_prompt(request: &str, current: Option<&Value>) -> String {
    let creds = crate::creds::names();
    let have = if creds.is_empty() { "nenhuma ainda".to_string() } else { creds.join(", ") };
    let task = match current {
        Some(f) => format!("Altere o fluxo de automação do BlueScreen abaixo conforme o pedido. Mantenha id, title, params e position dos nós que não mudam e devolva o fluxo INTEIRO, não só a diferença.\n\n# Fluxo atual\n{}", f.to_string().chars().take(40_000).collect::<String>()),
        None => "Monte um fluxo de automação Windows do BlueScreen.".to_string(),
    };
    // fluxos prontos que o nó flow.call pode chamar (fora o que está sendo alterado)
    let saved: Vec<String> = if cfg!(test) { vec![] } else { let _g = STORE.lock(); load().map(|s| s.flows).unwrap_or_default().iter().filter(|f| current.is_none_or(|c| c["id"] != f.id.as_str())).take(60)
        .map(|f| format!("- {} : \"{}\"{}", f.id, f.name, if f.description.trim().is_empty() { String::new() } else { format!(" ({})", f.description.trim().chars().take(120).collect::<String>()) })).collect() };
    let have = format!("{have}\n\n# Fluxos salvos (para o nó flow.call, pelo id)\n{}", if saved.is_empty() { "nenhum".to_string() } else { saved.join("\n") });
    format!("{task}\n\nRetorne SOMENTE JSON, neste formato: {GEN_FORMAT}\n\n{GEN_RULES}\n\n# Credenciais que já existem\n{have}\n\n# Exemplo de um fluxo bem montado\n{GEN_EXAMPLE}\n\n# Nós disponíveis\n{}\n\n# Pedido do usuário\n{request}", ai_guide())
}
/// Uma senha ou token achado num pedido à IA, ou que a IA apontou.
struct Secret { name: String, value: String, /// já há uma credencial com esse valor
    exists: bool, /// tirado do pedido aqui no PC: a IA não chegou a ver
    local: bool }
static TOKEN_SHAPE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\b(ghp_[A-Za-z0-9]{30,}|github_pat_\w{30,}|glpat-[\w-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})").unwrap());
/// Senhas e tokens escritos num texto: (início, fim, nome sugerido, valor). Pega tokens de formato conhecido (GitHub,
/// OpenAI, Slack, AWS, JWT) e o que vem depois de "senha", "token", "chave"... quando parece mesmo um valor: entre
/// aspas, depois de ":" ou "=", ou com número ou símbolo no meio. "a senha do usuário" não é uma senha.
fn find_secrets(text: &str) -> Vec<(usize, usize, String, String)> {
    static WORD: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)\b(senha|password|passwd|pwd|token|api[ _-]?key|chave de api|chave da api|chave|secret|segredo)\b(\s*(?::|=|é|eh)\s*|\s+)("[^"\n]{1,200}"|'[^'\n]{1,200}'|`[^`\n]{1,200}`|[^\s"'`]{1,200})"#).unwrap());
    static HOST: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)\b(?:https?://)?((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|br|gov|edu|co|me|ai))\b").unwrap());
    // de que site é: "app.loja.com.br" -> "app-loja"
    let site = HOST.captures(text).map(|c| c[1].to_lowercase().split('.').filter(|p| !matches!(*p, "www" | "com" | "net" | "org" | "io" | "dev" | "app" | "br" | "gov" | "edu" | "co" | "me" | "ai")).collect::<Vec<_>>().join("-")).filter(|s| !s.is_empty());
    let named = |base: &str| crate::creds::slug(&match &site { Some(s) => format!("{base}-{s}"), None => base.to_string() });
    let mut out: Vec<(usize, usize, String, String)> = vec![];
    for m in TOKEN_SHAPE.find_iter(text) {
        let v = m.as_str();
        let base = if v.starts_with("gh") { "token-github" } else if v.starts_with("glpat") { "token-gitlab" } else if v.starts_with("sk-") { "chave-api" } else if v.starts_with("xox") { "token-slack" } else if v.starts_with("AKIA") { "chave-aws" } else { "token" };
        out.push((m.start(), m.end(), if v.starts_with("gh") || v.starts_with("glpat") || v.starts_with("xox") || v.starts_with("AKIA") { base.to_string() } else { named(base) }, v.to_string()));
    }
    // "a senha do painel é X": até quatro palavras entre o nome e o valor, e aí só vale o que parece mesmo uma senha
    static FAR: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)\b(senha|password|passwd|pwd|token|api[ _-]?key|chave de api|chave da api|chave|secret|segredo)\b(?:\s+[\p{L}\d-]+){1,4}?(?:\s*[:=]\s*|\s+(?:é|eh)\s+)("[^"
]{1,200}"|'[^'
]{1,200}'|`[^`
]{1,200}`|[^\s"'`]{1,200})"#).unwrap());
    let near = WORD.captures_iter(text).map(|c| (c[1].to_lowercase(), c[2].trim().to_string(), c.get(3).unwrap()));
    let far = FAR.captures_iter(text).map(|c| (c[1].to_lowercase(), String::new(), c.get(2).unwrap()));
    for (word, sep, raw) in near.chain(far) {
        let quoted = raw.as_str().starts_with(['"', '\'', '`']);
        let value = if quoted { &raw.as_str()[1..raw.as_str().len() - 1] } else { raw.as_str().trim_end_matches(['.', ',', ';', ':', '!', '?', ')']) };
        let (start, end) = if quoted { (raw.start(), raw.end()) } else { (raw.start(), raw.start() + value.len()) };
        if value.contains("{{") || value.contains("}}") || out.iter().any(|o| start < o.1 && o.0 < end) { continue; }
        let n = value.chars().count();
        let odd = value.chars().any(|ch| ch.is_ascii_digit() || (!ch.is_alphanumeric() && ch != '-'));
        let sure = if quoted { n >= 3 } else if sep == ":" || sep == "=" { n >= 4 } else { n >= 6 && odd };
        if !sure { continue; }
        let base = match word.as_str() { "senha" | "password" | "passwd" | "pwd" => "senha", "token" => "token", "secret" | "segredo" => "segredo", _ => "chave" };
        out.push((start, end, named(base), value.to_string()));
    }
    out.sort_by_key(|o| o.0);
    out
}
/// O pedido sem as senhas: cada uma vira `{{cred:nome}}` antes de o texto ir para a IA. O nome é o de uma credencial
/// que já tem aquele valor, ou um novo, livre.
fn take_secrets(text: &str) -> (String, Vec<Secret>) {
    let mut secrets: Vec<Secret> = vec![];
    let (mut out, mut pos) = (String::new(), 0);
    for (start, end, base, value) in find_secrets(text) {
        let name = match secrets.iter().find(|s| s.value == value) {
            Some(s) => s.name.clone(),
            None => {
                let taken: Vec<String> = secrets.iter().map(|s| s.name.clone()).collect();
                let (name, exists) = crate::creds::plan_name(&base, &value, &taken);
                secrets.push(Secret { name: name.clone(), value, exists, local: true });
                name
            }
        };
        out.push_str(&text[pos..start]); out.push_str(&format!("{{{{cred:{name}}}}}")); pos = end;
    }
    out.push_str(&text[pos..]);
    (out, secrets)
}
fn swap_text(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) if s.contains(from) => *s = s.replace(from, to),
        Value::Array(a) => a.iter_mut().for_each(|x| swap_text(x, from, to)),
        Value::Object(o) => o.values_mut().for_each(|x| swap_text(x, from, to)),
        _ => {}
    }
}
/// O que a IA listou em `secrets` (uma senha que ela viu no pedido): o valor sai de `target` (os parâmetros do
/// fluxo, ou o script) e entra a referência; o nome que ela deu vira o nome livre de verdade.
fn ai_secrets(raw: &Value, target: &mut Value, secrets: &mut Vec<Secret>) {
    for s in raw.as_array().into_iter().flatten() {
        let Some(value) = s["value"].as_str().filter(|v| !v.is_empty() && !v.contains("{{")) else { continue };
        if secrets.iter().any(|x| x.value == value) { continue; }
        let given = crate::creds::slug(s["name"].as_str().unwrap_or(""));
        let taken: Vec<String> = secrets.iter().map(|x| x.name.clone()).collect();
        let (name, exists) = crate::creds::plan_name(if given.is_empty() { "credencial" } else { &given }, value, &taken);
        swap_text(target, value, &format!("{{{{cred:{name}}}}}"));
        if !given.is_empty() && given != name {
            swap_text(target, &format!("cred:{given}}}}}"), &format!("cred:{name}}}}}"));
            swap_text(target, &format!("cred:{given}."), &format!("cred:{name}."));
        }
        secrets.push(Secret { name, value: value.to_string(), exists, local: false });
    }
}
/// Guarda nas credenciais do Automator as senhas que o resultado usa de fato. Devolve o que a tela mostra de cada uma
/// (sem o valor) e os nomes que o resultado cita e não existem.
fn keep_secrets(secrets: &[Secret], text: &str, label: &str) -> (Vec<Value>, Vec<String>) {
    let mut report = vec![];
    for s in secrets {
        let used = text.contains(&format!("cred:{}}}}}", s.name)) || text.contains(&format!("cred:{}.", s.name));
        let (mut stored, mut error) = (s.exists, String::new());
        if used && !s.exists { match crate::creds::add(&s.name, &s.value, label, "ia") { Ok(()) => stored = true, Err(e) => error = e.msg } }
        report.push(json!({"name": s.name, "stored": stored, "used": used, "local": s.local, "existed": s.exists, "error": error}));
    }
    let have = crate::creds::names();
    let mut missing: Vec<String> = crate::creds::marks(text).into_iter().map(|m| m.1).filter(|n| !have.contains(n)).collect();
    missing.sort(); missing.dedup();
    (report, missing)
}
/// Pergunta a um agente de IA (CLI ou OpenRouter) e devolve o texto da resposta. `b`: { provider, model, cwd }.
async fn ai_ask(b: &Value, prompt: String) -> ApiResult<String> {
    let provider = b["provider"].as_str().unwrap_or("codex");
    let response = match provider {
        "openrouter" => execute_node(&Node{id:String::new(),kind:"ai.openrouter".into(),title:None,params:Value::Null,position:[0.,0.],disabled:false,locked:false,size:None},json!({"prompt":prompt,"model":b["model"],"secret":"openrouter","max_tokens":8192}),Value::Null).await?["out"].clone(),
        _ => {
            // modelo e esforço escolhidos na tela (vazio: os do agente); esforço alto demora, então dez minutos
            let v = cli("automator",provider,&prompt,&b["cwd"],&json!({"model": b["model"], "effort": b["effort"], "timeout_min": 10})).await?;
            if v["timedOut"]==true { return Err(fail("a IA passou de dez minutos sem responder; tente um esforço menor ou um pedido mais curto",422)); }
            if v["ok"]!=true { return Err(fail(format!("CLI falhou: {}",v["err"]),422)); }
            v["out"].clone()
        },
    };
    response.as_str().map(String::from).ok_or_else(||fail("IA respondeu sem texto",422))
}
/// Pedidos à IA em andamento (gerar fluxo, escrever script), pelo `job` que a tela inventou: (etapa, passo, início,
/// cancelar). A tela pergunta a etapa enquanto espera e pode cancelar: o agente é encerrado junto.
type AiJob = (String, u8, i64, Arc<AtomicBool>);
static AI_JOBS: LazyLock<Mutex<HashMap<String, AiJob>>> = LazyLock::new(Default::default);
fn ai_stage(b: &Value, step: u8, text: impl Into<String>) {
    if let Some(j) = b["job"].as_str() && let Some(x) = AI_JOBS.lock().get_mut(j) { x.0 = text.into(); x.1 = step; }
}
async fn ai_job(job: &str, work: impl std::future::Future<Output = ApiResult<Value>>) -> ApiResult<Value> {
    let cancel = Arc::new(AtomicBool::new(false));
    if !job.is_empty() { AI_JOBS.lock().insert(job.chars().take(40).collect(), ("Preparando o pedido".into(), 0, now(), cancel.clone())); }
    let stop = async { while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(200)).await; } };
    // cancelado: o pedido em andamento é largado aqui, e o programa do agente morre com ele (kill_on_drop)
    let r = tokio::select! { r = work => r, _ = stop => Err(fail("cancelado", 409)) };
    AI_JOBS.lock().remove(job);
    r
}
/// GET ?job= -> a etapa; POST { action: "cancel", job } cancela. None: é um pedido novo.
fn ai_job_route(r: &Req) -> ApiResult<Option<Value>> {
    if !r.is_post() {
        let g = AI_JOBS.lock();
        return Ok(Some(match g.get(r.q("job").unwrap_or("")) { Some(j) => json!({"running": true, "stage": j.0, "step": j.1, "ms": now() - j.2}), None => json!({"running": false}) }));
    }
    let b: Value = r.body_json()?;
    if b["action"] == "cancel" {
        if let Some(j) = AI_JOBS.lock().get(b["job"].as_str().unwrap_or("")) { j.3.store(true, Ordering::Relaxed); }
        return Ok(Some(json!({"ok": true})));
    }
    Ok(None)
}
const SCRIPT_PS: &str = "- O que chegou no nó vem em $env:BS_INPUT, sempre como texto; se for JSON, leia com ConvertFrom-Json.
- A saída do nó é o que o script escrever. Escreva só o resultado; com mais de um campo, um objeto com ConvertTo-Json -Compress -Depth 6.
- Roda sem ninguém olhando: nada de Read-Host, janelas ou confirmações. Em erro, use throw com uma mensagem clara em português.
- É o Windows PowerShell 5.1: sem &&, ||, operador ternário nem ?.
- Para usar uma senha ou token, escreva {{cred:nome}} direto no script, fora de aspas simples: na execução vira uma variável de ambiente com o valor.";
/// O script e o resumo dentro da resposta da IA: o script vem num bloco ``` e o resumo depois de "RESUMO:".
fn script_answer(out: &str) -> ApiResult<(String, String)> {
    let start = out.find("```").ok_or_else(|| fail("a IA respondeu sem o script", 422))?;
    let end = out.rfind("```").filter(|e| *e > start).ok_or_else(|| fail("a IA mandou o script pela metade", 422))?;
    let body = &out[start + 3..end];
    // a primeira linha do bloco é o nome da linguagem (ou vazia)
    let body = body.split_once('\n').map(|x| x.1).unwrap_or("");
    let script = body.replace("\r\n", "\n").trim_end().to_string();
    if script.trim().is_empty() { return Err(fail("a IA devolveu um script vazio", 422)); }
    let rest = out[end + 3..].trim();
    let summary = rest.split_once("RESUMO:").map(|x| x.1).unwrap_or(rest).trim().chars().take(600).collect();
    Ok((script, summary))
}
/// O catálogo escrito para a IA que monta fluxos: por categoria, o que cada nó faz, o que recebe e devolve, as portas,
/// os parâmetros com o valor padrão e os valores aceitos, e os campos da saída quando são conhecidos.
fn ai_guide() -> String {
    let kind = |k: &str| match k { "text" => "texto", "object" => "JSON", "list" => "lista", "number" => "número", "image" => "arquivo de imagem", "audio" => "arquivo de áudio", "video" => "arquivo de vídeo", "file" => "caminho de arquivo", "same" => "o mesmo que recebeu", "none" => "nada", _ => "qualquer dado" };
    let short = |v: &Value| { let t = v.to_string(); if t.chars().count() > 70 { format!("{}…", t.chars().take(70).collect::<String>()) } else { t } };
    let mut out = String::new();
    let mut cat = String::new();
    for s in catalog().as_array().into_iter().flatten() {
        let c = s["category"].as_str().unwrap_or("");
        if c != cat { cat = c.to_string(); out.push_str(&format!("\n## {cat}\n")); }
        let ports = |k: &str| s[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        out.push_str(&format!("- {} \"{}\": {} Recebe {} ({}); devolve {} ({}). Portas de entrada: [{}]; de saída: [{}].\n",
            s["type"].as_str().unwrap_or(""), s["name"].as_str().unwrap_or(""), s["desc"].as_str().unwrap_or(""),
            kind(s["takes"].as_str().unwrap_or("any")), s["expects"].as_str().unwrap_or(""), kind(s["gives"].as_str().unwrap_or("any")), s["returns"].as_str().unwrap_or(""), ports("inputs"), ports("outputs")));
        for (k, v) in s["params"].as_object().into_iter().flatten() {
            let f = s["fields"].as_array().into_iter().flatten().find(|f| f["name"] == k.as_str());
            let mut line = format!("    {k} = {}", short(v));
            if let Some(f) = f {
                line.push_str(&format!("  ({}", f["label"].as_str().unwrap_or("")));
                if let Some(o) = f["options"].as_array() {
                    let vals: Vec<String> = o.iter().take(14).map(|x| stringify(x.get("value").unwrap_or(x))).collect();
                    line.push_str(&format!("; valores: {}{}", vals.join(" | "), if o.len() > 14 { " | …" } else { "" }));
                }
                if f["kind"] == "flow" { line.push_str("; o id de um dos 'Fluxos salvos'"); }
                if let Some(c) = f["columns"].as_array() { line.push_str(&format!("; lista de objetos com: {}", c.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))); }
                if let Some(h) = f["help"].as_str() { line.push_str(&format!("; {}", h.chars().take(160).collect::<String>())); }
                line.push(')');
            }
            out.push_str(&line); out.push('\n');
        }
        if let Some(sample) = s.get("sample") { out.push_str(&format!("    saída: {}\n", sample.to_string().chars().take(420).collect::<String>())); }
    }
    out
}
/// O JSON do fluxo dentro da resposta da IA, já com os parâmetros que faltaram e a estrutura validada.
fn gen_flow(out: &str) -> ApiResult<(Flow, Value)> {
    let first = out.find('{').ok_or_else(|| fail("IA não retornou um fluxo JSON", 422))?;
    let last = out.rfind('}').ok_or_else(|| fail("JSON incompleto", 422))?;
    let raw: Value = serde_json::from_str(&out[first..=last]).map_err(|e| fail(format!("fluxo JSON inválido: {e}"), 422))?;
    // a IA às vezes devolve campos nulos (id, description) que aqui são texto: nulo conta como ausente
    let mut clean = raw.clone();
    if let Some(o) = clean.as_object_mut() { o.retain(|_, v| !v.is_null()); }
    let mut flow: Flow = serde_json::from_value(clean).map_err(|e| fail(format!("fluxo JSON inválido: {e}"), 422))?;
    flow.id.clear(); flow.active = false; flow.next_run = None;
    for (i, n) in flow.nodes.iter_mut().enumerate() {
        if n.position == [0., 0.] { n.position = [60. + (i % 3) as f32 * 240., 80. + (i / 3) as f32 * 180.]; }
        if let Some(s) = spec(&n.kind) { let mut params = s["params"].as_object().cloned().unwrap_or_default(); if let Some(p) = n.params.as_object() { params.extend(p.clone()); } n.params = json!(params); }
    }
    validate(&flow)?;
    Ok((flow, raw))
}
/// O que a estrutura não pega: parâmetro que o nó não tem, valor fora da lista, referência a nó que não existe ou que
/// não vem antes, campo que a saída do nó anterior não tem, e nó sem ninguém ligado nele.
fn flow_issues(f: &Flow) -> Vec<String> {
    static REF: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{\{\s*(input|nodes\.[\w-]+)((?:\.[\w-]+)*)\s*\}\}").unwrap());
    let specs: HashMap<String, Value> = catalog().as_array().into_iter().flatten().map(|s| (s["type"].as_str().unwrap_or("").to_string(), s.clone())).collect();
    let by_id: HashMap<&str, &Node> = f.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut out = vec![];
    for n in &f.nodes {
        let Some(s) = specs.get(&n.kind) else { continue };
        let name = format!("{} ({})", n.id, s["name"].as_str().unwrap_or(&n.kind));
        let sources: Vec<&str> = f.edges.iter().filter(|e| e.to == n.id).map(|e| e.from.as_str()).collect();
        if s["inputs"].as_array().is_some_and(|a| !a.is_empty()) && sources.is_empty() { out.push(format!("{name}: nenhum nó está ligado nele, então ele nunca roda")); }
        for (k, v) in n.params.as_object().into_iter().flatten() {
            if s["params"].get(k).is_none() { out.push(format!("{name}: o parâmetro '{k}' não existe neste nó")); continue; }
            let field = s["fields"].as_array().into_iter().flatten().find(|x| x["name"] == k.as_str());
            if let Some(o) = field.filter(|x| x["kind"] == "select").and_then(|x| x["options"].as_array()) {
                let ok = o.iter().any(|x| stringify(x.get("value").unwrap_or(x)) == stringify(v));
                if !ok && !stringify(v).contains("{{") { out.push(format!("{name}: '{k}' não aceita o valor {v}")); }
            }
        }
        // quem vem antes deste nó, por qualquer caminho
        let mut before: HashSet<&str> = HashSet::new();
        let mut stack = sources.clone();
        while let Some(x) = stack.pop() { if before.insert(x) { stack.extend(f.edges.iter().filter(|e| e.to == x).map(|e| e.from.as_str())); } }
        let text = n.params.to_string();
        for c in REF.captures_iter(&text) {
            let (base, path) = (&c[1], c[2].trim_start_matches('.'));
            let (origin, path) = if base == "input" { (sources.first().copied(), path.to_string()) } else {
                let id = &base[6..];
                if !by_id.contains_key(id) { out.push(format!("{name}: {{{{{base}}}}} aponta para um nó que não existe")); continue; }
                if !before.contains(id) { out.push(format!("{name}: {{{{{base}}}}} usa um nó que não vem antes deste no fluxo")); continue; }
                // nodes.ID.porta.campo: o primeiro pedaço é a porta
                (Some(id), path.split_once('.').map(|x| x.1).unwrap_or("").to_string())
            };
            let Some(src) = origin.and_then(|id| by_id.get(id)).and_then(|o| specs.get(&o.kind)) else { continue };
            let first = path.split('.').next().unwrap_or("");
            if first.is_empty() { continue; }
            if let Some(sample) = src.get("sample").and_then(Value::as_object) && !sample.contains_key(first) {
                out.push(format!("{name}: a saída de \"{}\" não tem o campo '{first}' (tem: {})", src["name"].as_str().unwrap_or(""), sample.keys().cloned().collect::<Vec<_>>().join(", ")));
            } else if matches!(src["gives"].as_str(), Some("text" | "number" | "file" | "image" | "audio" | "video")) && src.get("sample").is_none() {
                out.push(format!("{name}: \"{}\" devolve {}, que não tem campos; para ler um campo, ponha um json.parse antes", src["name"].as_str().unwrap_or(""), src["gives"].as_str().unwrap_or("")));
            }
        }
    }
    if !f.nodes.iter().any(|n| n.kind.starts_with("trigger.")) { out.push("o fluxo não tem gatilho: comece por um nó da categoria Gatilhos".into()); }
    static ANY: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap());
    for n in &f.nodes {
        let name = format!("{} ({})", n.id, specs.get(&n.kind).and_then(|s| s["name"].as_str()).unwrap_or(&n.kind));
        let text = n.params.to_string();
        for c in ANY.captures_iter(&text) {
            let k = &c[1];
            if !(k == "input" || ["input.", "nodes.", "vars.", "vault:", "cred:", "secret:"].iter().any(|p| k.starts_with(p))) {
                out.push(format!("{name}: {{{{{k}}}}} não é uma expressão que existe (use {{{{input}}}}, {{{{input.campo}}}} ou {{{{nodes.ID.out}}}})"));
            }
        }
        if n.kind == "windows.command" && { let a = n.params["args"].to_string() + &n.params["program"].to_string(); a.contains("cred:") || a.contains("vault:") } {
            out.push(format!("{name}: senha não vai em argumento de programa; use windows.powershell com {{{{cred:nome}}}} dentro do script"));
        }
        if n.kind == "flow.call" && !cfg!(test) {
            let want = n.params["flow"].as_str().unwrap_or("").trim();
            let known = { let _g = STORE.lock(); load().map(|s| s.flows).unwrap_or_default().iter().any(|x| x.id == want || x.name == want) };
            if !want.is_empty() && !known { out.push(format!("{name}: 'flow' tem que ser o id de um dos 'Fluxos salvos'")); }
            if want.is_empty() { out.push(format!("{name}: falta dizer qual fluxo chamar em 'flow' (o id de um dos 'Fluxos salvos')")); }
        }
        if TOKEN_SHAPE.is_match(&text) { out.push(format!("{name}: há um token escrito no nó; troque por {{{{cred:nome}}}} e liste o valor em 'secrets'")); }
    }
    out.sort(); out.dedup();
    out.truncate(20);
    out
}
/// Nós de lógica que organizam o fluxo: laços, tentativas, caminhos e variáveis. Os laços e o Tentar têm um trecho
/// "de dentro" (o que sai da primeira porta), que o motor roda várias vezes ou sob proteção (ver `Run::container`).
fn logic_catalog() -> Value {
    let ops = json!([{"value":"eq","label":"é igual a"},{"value":"ne","label":"é diferente de"},{"value":"contains","label":"contém"},{"value":"not_contains","label":"não contém"},{"value":"gt","label":"é maior que"},{"value":"lt","label":"é menor que"},{"value":"empty","label":"está vazio"},{"value":"not_empty","label":"não está vazio"},{"value":"true","label":"é verdadeiro"}]);
    json!([
        {"type":"logic.each","name":"Para cada item","category":"Lógica","desc":"Repete um trecho do fluxo uma vez para cada item de uma lista.","inputs":["in"],"outputs":["item","done"],
         "params":{"list":"{{input}}","on_error":"stop","wait_s":0,"max":1000},
         "fields":[
            {"name":"list","label":"Lista","kind":"text","help":"O que você ligar em \"cada item\" roda uma vez por item: lá, {{input}} é o item. O que ligar em \"fim\" roda uma vez só, depois de todos, e recebe a lista com o resultado de cada volta."},
            {"name":"on_error","label":"Se um item der erro","kind":"select","options":[{"value":"stop","label":"Parar o fluxo"},{"value":"continue","label":"Anotar e seguir para o próximo"}]},
            {"name":"wait_s","label":"Esperar entre os itens (segundos)","kind":"number","min":0,"max":3600},
            {"name":"max","label":"Limite de itens","kind":"number","min":1,"max":100000,"help":"Uma lista maior que isso para o fluxo, em vez de rodar sem fim."}
         ]},
        {"type":"logic.repeat","name":"Repetir","category":"Lógica","desc":"Repete um trecho do fluxo um número certo de vezes.","inputs":["in"],"outputs":["loop","done"],
         "params":{"times":3,"wait_s":0,"on_error":"stop"},
         "fields":[
            {"name":"times","label":"Quantas vezes","kind":"text","help":"Um número, ou uma expressão que vire número. O que você ligar em \"repetir\" roda esse tanto de vezes; \"fim\" roda depois."},
            {"name":"wait_s","label":"Esperar entre as voltas (segundos)","kind":"number","min":0,"max":3600},
            {"name":"on_error","label":"Se uma volta der erro","kind":"select","options":[{"value":"stop","label":"Parar o fluxo"},{"value":"continue","label":"Anotar e seguir"}]}
         ]},
        {"type":"logic.while","name":"Repetir enquanto","category":"Lógica","desc":"Repete um trecho do fluxo enquanto uma condição valer.","inputs":["in"],"outputs":["loop","done"],
         "params":{"value":"{{input}}","op":"not_empty","equals":"","wait_s":0,"max":100},
         "fields":[
            {"name":"value","label":"Valor","kind":"text","help":"Conferido antes de cada volta. Na primeira, {{input}} é o que chegou no nó; nas seguintes, o que a volta anterior entregou. Também dá para olhar uma variável: {{vars.nome}}."},
            {"name":"op","label":"Continua enquanto","kind":"select","options":ops.clone()},
            {"name":"equals","label":"Comparar com","kind":"text","show":{"op":["eq","ne","contains","not_contains","gt","lt"]}},
            {"name":"wait_s","label":"Esperar entre as voltas (segundos)","kind":"number","min":0,"max":3600},
            {"name":"max","label":"Limite de voltas","kind":"number","min":1,"max":10000,"help":"Proteção contra laço sem fim: ao passar disso, o fluxo para com erro."}
         ]},
        {"type":"logic.break","name":"Sair do laço","category":"Lógica","desc":"Encerra o laço agora e segue pelo \"fim\" dele.","inputs":["in"],"outputs":[],"params":{},"fields":[]},
        {"type":"logic.next","name":"Próximo item","category":"Lógica","desc":"Pula o resto desta volta e vai para o próximo item do laço.","inputs":["in"],"outputs":[],"params":{},"fields":[]},
        {"type":"logic.try","name":"Tentar","category":"Lógica","desc":"Roda um trecho e, se ele falhar, tenta de novo ou segue por outro caminho em vez de parar o fluxo.","inputs":["in"],"outputs":["try","ok","error"],
         "params":{"attempts":1,"wait_s":5},
         "fields":[
            {"name":"attempts","label":"Tentativas","kind":"number","min":1,"max":20,"help":"O que você ligar em \"tentar\" é o trecho protegido. Se ele falhar em todas as tentativas, o fluxo segue por \"deu erro\" (com a mensagem em {{input.error}}); sem nada ligado ali, o fluxo falha."},
            {"name":"wait_s","label":"Esperar antes de tentar de novo (segundos)","kind":"number","min":0,"max":3600}
         ]},
        {"type":"logic.switch","name":"Escolher caminho","category":"Lógica","desc":"Segue por uma saída diferente conforme o valor: até cinco casos e o caminho \"outro\".","inputs":["in"],"outputs":["1","2","3","4","5","other"],
         "params":{"value":"{{input}}","mode":"eq","cases":[]},
         "fields":[
            {"name":"value","label":"Valor","kind":"text"},
            {"name":"mode","label":"Como comparar","kind":"select","options":[{"value":"eq","label":"É igual ao caso"},{"value":"contains","label":"Contém o caso"},{"value":"regex","label":"Casa com a expressão regular"}]},
            {"name":"cases","label":"Casos","kind":"lines","help":"Um por linha, até cinco. A primeira linha é a saída 1, a segunda a saída 2… Se nenhum casar, segue por \"outro\"."}
         ]},
        {"type":"logic.all","name":"Várias condições","category":"Lógica","desc":"Confere várias condições de uma vez: todas, ou pelo menos uma.","inputs":["in"],"outputs":["true","false"],
         "params":{"mode":"all","rules":[]},
         "fields":[
            {"name":"mode","label":"Segue por sim quando","kind":"select","options":[{"value":"all","label":"Todas valem (E)"},{"value":"any","label":"Pelo menos uma vale (OU)"}]},
            {"name":"rules","label":"Condições","kind":"rows","add":"Condição","columns":[
                {"name":"value","placeholder":"Valor: {{input.campo}}"},
                {"name":"op","kind":"select","options":ops.clone()},
                {"name":"equals","placeholder":"Comparar com","hide":{"op":["empty","not_empty","true"]}}]}
         ]},
        {"type":"logic.var","name":"Variável","category":"Lógica","desc":"Guarda um valor com nome para usar em qualquer nó depois: um contador, um total, uma lista que cresce a cada volta.","inputs":["in"],"outputs":["out"],
         "params":{"name":"total","op":"set","value":"{{input}}"},
         "fields":[
            {"name":"name","label":"Nome","kind":"text","help":"Depois, em qualquer campo: {{vars.nome}}. Vale até o fim desta execução."},
            {"name":"op","label":"Ação","kind":"select","options":[{"value":"set","label":"Guardar o valor"},{"value":"add","label":"Somar ao número guardado"},{"value":"append","label":"Acrescentar à lista"},{"value":"get","label":"Só ler"},{"value":"clear","label":"Esvaziar"}]},
            {"name":"value","label":"Valor","kind":"text","show":{"op":["set","add","append"]},"help":"Para somar: vazio soma 1."}
         ]},
    ])
}
/// Nós de data e hora: saber se é dia e horário de trabalho, ler o agora em campos, comparar e calcular datas, esperar.
fn time_catalog() -> Value {
    let days = json!([{"value":1,"label":"Seg"},{"value":2,"label":"Ter"},{"value":3,"label":"Qua"},{"value":4,"label":"Qui"},{"value":5,"label":"Sex"},{"value":6,"label":"Sáb"},{"value":0,"label":"Dom"}]);
    let units = json!([{"value":"minutes","label":"minutos"},{"value":"hours","label":"horas"},{"value":"days","label":"dias"},{"value":"weeks","label":"semanas"},{"value":"months","label":"meses"}]);
    json!([
        {"type":"time.window","name":"Dentro do horário?","category":"Data e hora","desc":"Segue por sim se agora é um dos dias e está no horário escolhidos; senão, por não.","inputs":["in"],"outputs":["true","false"],
         "params":{"days":[1,2,3,4,5],"window":"between","from":"08:00","to":"18:00","except":[],"when":""},
         "fields":[
            {"name":"days","label":"Dias da semana","kind":"checks","options":days,"help":"Nenhum marcado: todos os dias."},
            {"name":"window","label":"Em que parte do dia","kind":"select","options":[{"value":"between","label":"Só entre dois horários"},{"value":"all","label":"O dia inteiro"}]},
            {"name":"from","label":"Das","kind":"time","show":{"window":["between"]}},
            {"name":"to","label":"Até as","kind":"time","show":{"window":["between"]},"help":"Um fim menor que o início atravessa a meia-noite (22:00 até 06:00), e o dia que conta é o do começo."},
            {"name":"except","label":"Dias de folga","kind":"lines","help":"Um por linha: 25/12 (todo ano), 02/11/2026 ou 2026-11-02. Nesses dias a resposta é não."},
            {"name":"when","label":"Conferir outro momento","kind":"text","placeholder":"vazio: agora","help":"Uma data e hora no lugar de agora, por exemplo {{input.criado_em}}."}
         ]},
        {"type":"time.now","name":"Agora","category":"Data e hora","desc":"Entrega a data e a hora de agora em campos: dia da semana, hora, se é fim de semana.","inputs":["in"],"outputs":["out"],
         "params":{},"fields":[]},
        {"type":"time.compare","name":"Comparar datas","category":"Data e hora","desc":"Segue por sim ou por não conforme uma data vem antes, depois ou está longe de outra.","inputs":["in"],"outputs":["true","false"],
         "params":{"value":"{{input}}","op":"before","other":"","amount":1,"unit":"days"},
         "fields":[
            {"name":"value","label":"Data","kind":"text","placeholder":"25/12/2026 14:30, 2026-12-25 ou {{input.data}}","help":"Aceita dia/mês/ano, ano-mês-dia, com ou sem hora, e o número de milissegundos."},
            {"name":"op","label":"Comparação","kind":"select","options":[
                {"value":"before","label":"é antes de"},{"value":"after","label":"é depois de"},{"value":"same_day","label":"é no mesmo dia que"},
                {"value":"older","label":"é mais antiga que (há mais de…)"},{"value":"newer","label":"é mais recente que (há menos de…)"}]},
            {"name":"amount","label":"Quanto","kind":"number","min":0,"max":100000,"show":{"op":["older","newer"]}},
            {"name":"unit","label":"Unidade","kind":"select","options":units.clone(),"show":{"op":["older","newer"]}},
            {"name":"other","label":"Comparar com","kind":"text","placeholder":"vazio: agora"}
         ]},
        {"type":"time.shift","name":"Calcular data","category":"Data e hora","desc":"Soma ou tira minutos, horas, dias, semanas ou meses de uma data e entrega no formato escolhido.","inputs":["in"],"outputs":["out"],
         "params":{"value":"","amount":1,"unit":"days","format":"date"},
         "fields":[
            {"name":"value","label":"Data","kind":"text","placeholder":"vazio: agora"},
            {"name":"amount","label":"Somar","kind":"number","min":-100000,"max":100000,"help":"Número negativo volta no tempo. Zero só muda o formato."},
            {"name":"unit","label":"Unidade","kind":"select","options":units},
            {"name":"format","label":"Entregar como","kind":"select","options":[
                {"value":"date","label":"dia/mês/ano"},{"value":"datetime","label":"dia/mês/ano hora:minuto"},{"value":"time","label":"hora:minuto"},
                {"value":"iso","label":"ano-mês-dia e hora (ISO)"},{"value":"timestamp","label":"número de milissegundos"},{"value":"fields","label":"campos (como o nó Agora)"}]}
         ]},
        {"type":"time.until","name":"Esperar até o horário","category":"Data e hora","desc":"Segura o fluxo até a próxima vez que o relógio marcar o horário, e segue com o que chegou.","inputs":["in"],"outputs":["out"],
         "params":{"time":"09:00","max_hours":24},
         "fields":[
            {"name":"time","label":"Horário","kind":"time"},
            {"name":"max_hours","label":"Esperar no máximo (horas)","kind":"number","min":1,"max":24,"help":"Se a espera passar disso, o nó falha em vez de segurar o fluxo. Enquanto espera, o fluxo conta como em execução."}
         ]}
    ])
}
/// Uma data escrita de um dos jeitos comuns: dia/mês/ano ou ano-mês-dia, com ou sem hora, ISO com fuso, ou o número
/// de segundos ou milissegundos. Vazio: agora.
fn parse_when(v: &Value) -> ApiResult<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone;
    let t = stringify(v);
    let t = t.trim();
    if t.is_empty() || t == "null" { return Ok(chrono::Local::now()); }
    if let Ok(n) = t.parse::<i64>() {
        let ms = if n.abs() < 100_000_000_000 { n * 1000 } else { n };
        return chrono::Local.timestamp_millis_opt(ms).single().ok_or_else(|| fail(format!("data fora do que dá para representar: {t}"), 400));
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(t) { return Ok(d.with_timezone(&chrono::Local)); }
    let local = |n: chrono::NaiveDateTime| chrono::Local.from_local_datetime(&n).earliest();
    for f in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"] {
        if let Some(d) = chrono::NaiveDateTime::parse_from_str(t, f).ok().and_then(local) { return Ok(d); }
    }
    for f in ["%Y-%m-%d", "%d/%m/%Y"] {
        if let Some(d) = chrono::NaiveDate::parse_from_str(t, f).ok().and_then(|d| d.and_hms_opt(0, 0, 0)).and_then(local) { return Ok(d); }
    }
    Err(fail(format!("não entendi a data \"{t}\": use dia/mês/ano ou ano-mês-dia, com ou sem hora"), 400))
}
/// A data em campos, para os nós seguintes usarem como {{input.weekday}}, {{input.hour}}...
fn time_fields(t: chrono::DateTime<chrono::Local>) -> Value {
    use chrono::{Datelike, Timelike};
    const NAMES: [&str; 7] = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    let wd = t.weekday().num_days_from_sunday();
    json!({"date": t.format("%d/%m/%Y").to_string(), "time": t.format("%H:%M").to_string(), "iso": t.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
        "weekday": wd, "weekday_name": NAMES[wd as usize], "weekend": wd == 0 || wd == 6,
        "day": t.day(), "month": t.month(), "year": t.year(), "hour": t.hour(), "minute": t.minute(), "timestamp": t.timestamp_millis()})
}
/// Soma `n` unidades a uma data (meses pelo calendário: 31/01 + 1 mês = último dia de fevereiro).
fn shift_time(t: chrono::DateTime<chrono::Local>, n: i64, unit: &str) -> Option<chrono::DateTime<chrono::Local>> {
    match unit {
        "minutes" => t.checked_add_signed(chrono::Duration::minutes(n)),
        "hours" => t.checked_add_signed(chrono::Duration::hours(n)),
        "weeks" => t.checked_add_signed(chrono::Duration::weeks(n)),
        "months" => if n >= 0 { t.checked_add_months(chrono::Months::new(n as u32)) } else { t.checked_sub_months(chrono::Months::new((-n) as u32)) },
        _ => t.checked_add_signed(chrono::Duration::days(n)),
    }
}
/// O dia é um dos "dias de folga"? Cada linha: 25/12 (todo ano), 02/11/2026 ou 2026-11-02.
fn day_off(t: chrono::DateTime<chrono::Local>, list: &Value) -> ApiResult<bool> {
    use chrono::Datelike;
    for line in list.as_array().into_iter().flatten().filter_map(|l| l.as_str()).map(str::trim).filter(|l| !l.is_empty()) {
        let hit = if let Some((d, m)) = line.split_once('/').filter(|x| !x.1.contains('/')) {
            let (d, m) = (d.trim().parse::<u32>(), m.trim().parse::<u32>());
            match (d, m) { (Ok(d), Ok(m)) => t.day() == d && t.month() == m, _ => return Err(fail(format!("dia de folga que não entendi: \"{line}\" (use 25/12, 02/11/2026 ou 2026-11-02)"), 400)) }
        } else {
            let d = chrono::NaiveDate::parse_from_str(line, "%d/%m/%Y").or_else(|_| chrono::NaiveDate::parse_from_str(line, "%Y-%m-%d"))
                .map_err(|_| fail(format!("dia de folga que não entendi: \"{line}\" (use 25/12, 02/11/2026 ou 2026-11-02)"), 400))?;
            t.date_naive() == d
        };
        if hit { return Ok(true); }
    }
    Ok(false)
}
async fn time_node(kind: &str, p: &Value, input: Value) -> ApiResult<Value> {
    let port = |yes: bool, v: Value| { let mut m = serde_json::Map::new(); m.insert(if yes { "true" } else { "false" }.to_string(), v); Value::Object(m) };
    Ok(match kind {
        "time.window" => {
            let t = parse_when(&p["when"])?;
            let (days, span) = window_of(p)?;
            // dentro: o intervalo que contém `t` (ou o próximo) já começou. O dia de folga é o do começo do intervalo.
            let inside = match work_window(t, &days, span) { Some((start, _)) if start <= t => !day_off(start, &p["except"])?, _ => false };
            port(inside, input)
        }
        "time.now" => json!({"out": time_fields(chrono::Local::now())}),
        "time.compare" => {
            let (a, b) = (parse_when(&p["value"])?, parse_when(&p["other"])?);
            if stringify(&p["value"]).trim().is_empty() { return Err(fail("informe a data a comparar", 400)); }
            let limit = || shift_time(b, -p["amount"].as_i64().unwrap_or(0).abs(), p["unit"].as_str().unwrap_or("days")).ok_or_else(|| fail("quantidade grande demais", 400));
            let yes = match p["op"].as_str().unwrap_or("before") {
                "after" => a > b,
                "same_day" => a.date_naive() == b.date_naive(),
                "older" => a < limit()?,
                "newer" => a >= limit()? && a <= b,
                _ => a < b,
            };
            port(yes, input)
        }
        "time.shift" => {
            let t = shift_time(parse_when(&p["value"])?, p["amount"].as_i64().unwrap_or(0), p["unit"].as_str().unwrap_or("days")).ok_or_else(|| fail("a data calculada sai do calendário", 400))?;
            json!({"out": match p["format"].as_str().unwrap_or("date") {
                "datetime" => json!(t.format("%d/%m/%Y %H:%M").to_string()),
                "time" => json!(t.format("%H:%M").to_string()),
                "iso" => json!(t.format("%Y-%m-%dT%H:%M:%S%:z").to_string()),
                "timestamp" => json!(t.timestamp_millis()),
                "fields" => time_fields(t),
                _ => json!(t.format("%d/%m/%Y").to_string()),
            }})
        }
        "time.until" => {
            use chrono::TimeZone;
            let (h, m) = clock(p["time"].as_str().unwrap_or("")).ok_or_else(|| fail("informe o horário como HH:MM", 400))?;
            let now = chrono::Local::now();
            let today = chrono::Local.from_local_datetime(&now.date_naive().and_hms_opt(h, m, 0).ok_or_else(|| fail("horário inválido", 400))?).earliest().ok_or_else(|| fail("horário inválido", 400))?;
            let at = if today > now { today } else { today + chrono::Duration::days(1) };
            let wait = (at - now).to_std().unwrap_or_default();
            let max = p["max_hours"].as_u64().unwrap_or(24).clamp(1, 24);
            if wait.as_secs() > max * 3600 { return Err(fail(format!("faltam mais de {max} h para as {h:02}:{m:02}; aumente o limite ou use a Agenda"), 400)); }
            tokio::time::sleep(wait).await;
            json!({"out": input})
        }
        _ => return Err(fail(format!("tipo de nó desconhecido: {kind}"), 400)),
    })
}
/// Ferramentas de QA que não precisam de navegador: teste de API, dados de teste, carga leve e relatório.
fn qa_catalog() -> Value {
    json!([
        {"type":"qa.api","name":"Testar API","category":"QA","desc":"Chama um endereço e confere a resposta: status, tempo, texto e campos do JSON.","inputs":["in"],"outputs":["true","false"],
         "params":{"name":"","method":"GET","url":"","headers":{},"body":"","checks":[{"what":"status","path":"","op":"eq","value":"200"}],"timeout_s":30},
         "fields":[{"name":"name","label":"Nome do teste","kind":"text","placeholder":"Lista de clientes responde"},
            {"name":"method","label":"Método","kind":"select","options":["GET","POST","PUT","PATCH","DELETE","HEAD"]},
            {"name":"url","label":"Endereço","kind":"text","placeholder":"https://…"},
            {"name":"headers","label":"Cabeçalhos","kind":"json","help":"Token: {\"Authorization\": \"Bearer {{vault:nome}}\"}."},
            {"name":"body","label":"Corpo","kind":"area","show":{"method":["POST","PUT","PATCH","DELETE"]}},
            {"name":"checks","label":"Conferências","kind":"rows","add":"Conferência","help":"Campo do JSON: o caminho, como itens.0.nome. Cabeçalho: o nome dele. O teste passa quando todas valem.",
             "columns":[
                {"name":"what","kind":"select","options":[{"value":"status","label":"Status","tone":"check"},{"value":"time","label":"Tempo (ms)","tone":"check"},{"value":"body","label":"Texto da resposta","tone":"check"},{"value":"field","label":"Campo do JSON","tone":"read"},{"value":"header","label":"Cabeçalho","tone":"read"}]},
                {"name":"path","placeholder":"itens.0.nome ou content-type","hide":{"what":["status","time","body"]}},
                {"name":"op","kind":"select","options":[{"value":"eq","label":"é igual a"},{"value":"ne","label":"é diferente de"},{"value":"contains","label":"contém"},{"value":"not_contains","label":"não contém"},{"value":"gt","label":"é maior que"},{"value":"lt","label":"é menor que"},{"value":"not_empty","label":"existe"},{"value":"empty","label":"está vazio"}]},
                {"name":"value","placeholder":"Valor esperado","hide":{"op":["not_empty","empty"]}}]},
            {"name":"timeout_s","label":"Tempo limite (segundos)","kind":"number","min":1,"max":300}]},
        {"type":"qa.data","name":"Dados de teste","category":"QA","desc":"Gera pessoas de mentira para preencher formulários: nome, e-mail, CPF válido, telefone, endereço.","inputs":["in"],"outputs":["out"],
         "params":{"fields":["nome","email","cpf","telefone"],"count":1},
         "fields":[{"name":"fields","label":"O que gerar","kind":"checks","options":[
                {"value":"nome","label":"Nome"},{"value":"email","label":"E-mail"},{"value":"cpf","label":"CPF válido"},{"value":"cnpj","label":"CNPJ válido"},{"value":"telefone","label":"Celular"},
                {"value":"nascimento","label":"Data de nascimento"},{"value":"cep","label":"CEP"},{"value":"endereco","label":"Endereço"},{"value":"empresa","label":"Empresa"},{"value":"senha","label":"Senha forte"},{"value":"uuid","label":"Identificador (UUID)"},{"value":"texto","label":"Frase"}]},
            {"name":"count","label":"Quantos","kind":"number","min":1,"max":500,"help":"Um: entrega um objeto, para usar como {{input.nome}}. Mais de um: entrega uma lista."}]},
        {"type":"qa.load","name":"Teste de carga leve","category":"QA","desc":"Faz várias chamadas ao mesmo tempo e mede tempo e erros. Use só em sistemas seus.","inputs":["in"],"outputs":["true","false"],
         "params":{"url":"","total":50,"concurrency":5,"max_p95_ms":0,"max_error_percent":0,"timeout_s":15},
         "fields":[{"name":"url","label":"Endereço","kind":"text","placeholder":"https://…","help":"Só GET. Use em sistemas seus, ou com autorização de quem cuida do sistema."},
            {"name":"total","label":"Chamadas","kind":"number","min":1,"max":500},
            {"name":"concurrency","label":"Ao mesmo tempo","kind":"number","min":1,"max":20},
            {"name":"max_p95_ms","label":"Reprova se 95% passarem de (ms)","kind":"number","min":0,"max":600000,"help":"Zero: não confere o tempo."},
            {"name":"max_error_percent","label":"Erros aceitos (%)","kind":"number","min":0,"max":100},
            {"name":"timeout_s","label":"Tempo limite de cada chamada (segundos)","kind":"number","min":1,"max":120}]},
        {"type":"qa.report","name":"Relatório de testes","category":"QA","desc":"Junta resultados de teste num arquivo: página HTML, JUnit (para CI) ou Markdown.","inputs":["in"],"outputs":["out"],
         "params":{"results":"{{input}}","title":"Relatório de testes","format":"html","path":""},
         "fields":[{"name":"results","label":"Resultados","kind":"text","help":"O resultado de Testar site ou Testar API, ou uma lista deles."},
            {"name":"title","label":"Título","kind":"text"},
            {"name":"format","label":"Formato","kind":"select","options":[{"value":"html","label":"Página HTML"},{"value":"junit","label":"JUnit XML (Jenkins, GitLab, Azure)"},{"value":"markdown","label":"Markdown"}]},
            {"name":"path","label":"Gravar em","kind":"text","pick":"save","placeholder":"vazio: pasta temporária"}]}
    ])
}
/// CPF ou CNPJ com os dígitos verificadores certos (para formulário aceitar; não é de ninguém de propósito).
fn fake_doc(n: usize) -> String {
    let rnd = |m: u32| rand::random::<u32>() % m;
    let mut d: Vec<u32> = (0..n).map(|_| rnd(10)).collect();
    if n == 12 { d[8] = 0; d[9] = 0; d[10] = 0; d[11] = 1; } // CNPJ: matriz 0001
    for _ in 0..2 {
        let len = d.len();
        let sum: u32 = if n == 9 { d.iter().enumerate().map(|(i, x)| x * (len as u32 + 1 - i as u32)).sum() } else { d.iter().rev().enumerate().map(|(i, x)| x * (2 + (i as u32 % 8))).sum() };
        let r = sum % 11;
        d.push(if r < 2 { 0 } else { 11 - r });
    }
    let t: String = d.iter().map(|x| char::from_digit(*x, 10).unwrap()).collect();
    if n == 9 { format!("{}.{}.{}-{}", &t[0..3], &t[3..6], &t[6..9], &t[9..11]) } else { format!("{}.{}.{}/{}-{}", &t[0..2], &t[2..5], &t[5..8], &t[8..12], &t[12..14]) }
}
fn fake_person(fields: &[String]) -> Value {
    const FIRST: [&str; 24] = ["Ana", "Bruno", "Carla", "Diego", "Eduarda", "Felipe", "Gabriela", "Henrique", "Isabela", "João", "Karina", "Lucas", "Mariana", "Nicolas", "Olívia", "Pedro", "Rafaela", "Samuel", "Tatiana", "Vinícius", "Yasmin", "Caio", "Lívia", "Thiago"];
    const LAST: [&str; 20] = ["Silva", "Santos", "Oliveira", "Souza", "Pereira", "Costa", "Rodrigues", "Almeida", "Nascimento", "Lima", "Araújo", "Fernandes", "Carvalho", "Gomes", "Martins", "Rocha", "Ribeiro", "Alves", "Monteiro", "Barbosa"];
    const STREET: [&str; 10] = ["Rua das Flores", "Avenida Brasil", "Rua Sete de Setembro", "Rua XV de Novembro", "Avenida Paulista", "Rua da Praia", "Rua São João", "Avenida Independência", "Rua Bela Vista", "Travessa do Sol"];
    const CITY: [(&str, &str); 8] = [("São Paulo", "SP"), ("Rio de Janeiro", "RJ"), ("Belo Horizonte", "MG"), ("Porto Alegre", "RS"), ("Curitiba", "PR"), ("Salvador", "BA"), ("Recife", "PE"), ("Fortaleza", "CE")];
    const COMPANY: [&str; 8] = ["Aurora Tecnologia", "Mercado Bom Preço", "Clínica Vida", "Transportes Rota Sul", "Padaria Pão Quente", "Estúdio Prisma", "Construtora Horizonte", "Escola Saber"];
    const WORDS: [&str; 16] = ["teste", "pedido", "cliente", "entrega", "urgente", "confirmar", "cadastro", "novo", "sistema", "ajuste", "verificar", "pagamento", "contato", "amanhã", "relatório", "suporte"];
    let rnd = |m: usize| rand::random::<u32>() as usize % m;
    let (first, last) = (FIRST[rnd(FIRST.len())], LAST[rnd(LAST.len())]);
    let plain = |t: &str| t.to_lowercase().chars().map(|c| match c { 'á' | 'ã' | 'â' => 'a', 'é' | 'ê' => 'e', 'í' => 'i', 'ó' | 'õ' | 'ô' => 'o', 'ú' => 'u', 'ç' => 'c', c => c }).collect::<String>();
    let mut o = serde_json::Map::new();
    for f in fields {
        let v = match f.as_str() {
            "nome" => format!("{first} {last}"),
            "email" => format!("{}.{}{}@exemplo.com", plain(first), plain(last), rnd(900) + 100),
            "cpf" => fake_doc(9),
            "cnpj" => fake_doc(12),
            "telefone" => format!("({}) 9{:04}-{:04}", [11, 21, 31, 41, 51, 61, 71, 81][rnd(8)], rnd(10000), rnd(10000)),
            "nascimento" => format!("{:02}/{:02}/{}", rnd(28) + 1, rnd(12) + 1, 1960 + rnd(45)),
            "cep" => format!("{:05}-{:03}", rnd(89999) + 10000, rnd(1000)),
            "endereco" => { let c = CITY[rnd(CITY.len())]; format!("{}, {} - {}/{}", STREET[rnd(STREET.len())], rnd(1900) + 10, c.0, c.1) }
            "empresa" => COMPANY[rnd(COMPANY.len())].to_string(),
            "senha" => { const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; let mut t: String = (0..10).map(|_| A[rnd(A.len())] as char).collect(); t.push_str(["!7", "@4", "#9", "$2"][rnd(4)]); t }
            "uuid" => { let (a, b) = (rand::random::<u64>(), rand::random::<u64>()); format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}", a >> 32, (a >> 16) & 0xffff, a & 0xfff, 0x8000 | (b >> 48) & 0x3fff, b & 0xffff_ffff_ffff) }
            "texto" => { let n = 5 + rnd(5); let mut t = (0..n).map(|_| WORDS[rnd(WORDS.len())]).collect::<Vec<_>>().join(" "); if let Some(c) = t.get_mut(0..1) { c.make_ascii_uppercase(); } t.push('.'); t }
            _ => continue,
        };
        o.insert(f.clone(), json!(v));
    }
    Value::Object(o)
}
/// Casos de teste a partir de um resultado (ou de uma lista): os passos de Testar site, as conferências de Testar
/// API, ou o resultado sozinho. Cada caso: (grupo, nome, passou, ms, erro).
fn qa_cases(v: &Value) -> Vec<(String, String, Option<bool>, u64, String)> {
    let mut out = vec![];
    for r in list_of(&json_in(v)) {
        let r = json_in(&r);
        let suite = r["name"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("Teste").to_string();
        let rows = r["steps"].as_array().or_else(|| r["checks"].as_array());
        match rows {
            Some(rows) if !rows.is_empty() => for x in rows {
                let name = [x["n"].as_u64().filter(|n| *n > 0).map(|n| format!("{n}.")).unwrap_or_default(), stringify(&x["name"]), x["on"].as_str().unwrap_or("").to_string()].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ");
                out.push((suite.clone(), name, if x["skipped"] == true { None } else { Some(x["ok"] == true) }, x["ms"].as_u64().unwrap_or(0), x["error"].as_str().unwrap_or("").to_string()));
            },
            _ => out.push((suite.clone(), suite, Some(r["ok"] == true || r["failed"].as_u64() == Some(0)), r["ms"].as_u64().unwrap_or(0), r["error"].as_str().unwrap_or("").to_string())),
        }
    }
    out
}
async fn qa_node(kind: &str, p: &Value) -> ApiResult<Value> {
    let branch = |ok: bool, v: Value| if ok { json!({"true": v}) } else { json!({"false": v}) };
    match kind {
        "qa.api" => {
            let url = text_of(p, "url");
            if url.trim().is_empty() { return Err(fail("informe o endereço da API", 400)); }
            let method = p["method"].as_str().unwrap_or("GET").to_uppercase();
            let mut req = json!({"url": url.trim(), "method": method, "headers": p["headers"], "timeout": p["timeout_s"].as_u64().unwrap_or(30).clamp(1, 300) * 1000});
            let body = text_of(p, "body");
            if !matches!(method.as_str(), "GET" | "HEAD") && !body.is_empty() { req["body"] = json!(body); }
            let began = std::time::Instant::now();
            let v = service("automator", "plugin/fetch", req).await?;
            let ms = began.elapsed().as_millis() as u64;
            let text = v["body"].as_str().unwrap_or("");
            let parsed = serde_json::from_str::<Value>(text).ok();
            let mut checks = vec![];
            for c in p["checks"].as_array().into_iter().flatten() {
                let (what, path, op) = (c["what"].as_str().unwrap_or("status"), text_of(c, "path"), c["op"].as_str().unwrap_or("eq"));
                let path = path.trim();
                let (label, got) = match what {
                    "time" => ("Tempo (ms)".to_string(), json!(ms)),
                    "body" => ("Texto da resposta".to_string(), json!(text)),
                    "field" => (format!("Campo {path}"), parsed.as_ref().and_then(|j| dig(j, path)).unwrap_or(Value::Null)),
                    "header" => (format!("Cabeçalho {path}"), v["headers"].as_object().and_then(|h| h.iter().find(|(k, _)| k.eq_ignore_ascii_case(path)).map(|(_, x)| x.clone())).unwrap_or(Value::Null)),
                    _ => ("Status".to_string(), v["status"].clone()),
                };
                let ok = condition(&json!({"value": got, "op": op, "equals": c["value"]})).unwrap_or(false);
                let shown = stringify(&got).chars().take(160).collect::<String>();
                let rule = match op { "ne" => "ser diferente de", "contains" => "conter", "not_contains" => "não conter", "gt" => "ser maior que", "lt" => "ser menor que", "not_empty" => "existir", "empty" => "estar vazio", _ => "ser igual a" };
                let mut row = json!({"name": label, "ok": ok, "got": got, "expected": c["value"]});
                if what == "body" { row["got"] = json!(shown); }
                if !ok { row["error"] = json!(if matches!(op, "not_empty" | "empty") { format!("devia {rule}, mas veio \"{shown}\"") } else { format!("devia {rule} \"{}\", mas veio \"{shown}\"", stringify(&c["value"])) }); }
                checks.push(row);
            }
            let failed = checks.iter().filter(|c| c["ok"] != true).count();
            let name = text_of(p, "name");
            Ok(branch(failed == 0, json!({"ok": failed == 0, "name": if name.trim().is_empty() { format!("{method} {}", url.trim()) } else { name }, "passed": checks.len() - failed, "failed": failed, "total": checks.len(),
                "status": v["status"], "ms": ms, "checks": checks,
                // resposta grande não vai inteira para o histórico: fica o começo dela
                "body": match parsed { Some(j) if text.len() <= 8_000 => j, _ => json!(text.chars().take(2000).collect::<String>()) }})))
        }
        "qa.data" => {
            let fields: Vec<String> = p["fields"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            if fields.is_empty() { return Err(fail("escolha pelo menos um dado para gerar", 400)); }
            let count = p["count"].as_u64().unwrap_or(1).clamp(1, 500);
            Ok(json!({"out": if count == 1 { fake_person(&fields) } else { Value::Array((0..count).map(|_| fake_person(&fields)).collect()) }}))
        }
        "qa.load" => {
            use futures_util::StreamExt;
            let url = reqwest::Url::parse(text_of(p, "url").trim()).ok().filter(|u| matches!(u.scheme(), "http" | "https")).ok_or_else(|| fail("informe o endereço completo, com http:// ou https://", 400))?;
            let total = p["total"].as_u64().unwrap_or(50).clamp(1, 500) as usize;
            let conc = p["concurrency"].as_u64().unwrap_or(5).clamp(1, 20) as usize;
            let limit = Duration::from_secs(p["timeout_s"].as_u64().unwrap_or(15).clamp(1, 120));
            let began = std::time::Instant::now();
            let hits: Vec<(u16, u64)> = futures_util::stream::iter(0..total).map(|_| { let u = url.clone(); async move {
                let t = std::time::Instant::now();
                let status = match tokio::time::timeout(limit, async { let r = AUDIT.get(u).send().await?; let s = r.status().as_u16(); let _ = r.bytes().await; Ok::<u16, reqwest::Error>(s) }).await { Ok(Ok(s)) => s, _ => 0 };
                (status, t.elapsed().as_millis() as u64)
            } }).buffer_unordered(conc).collect().await;
            let secs = began.elapsed().as_secs_f64().max(0.001);
            let mut times: Vec<u64> = hits.iter().map(|h| h.1).collect();
            times.sort_unstable();
            let at = |q: f64| times[((times.len() as f64 * q).ceil() as usize).clamp(1, times.len()) - 1];
            let failed = hits.iter().filter(|h| h.0 == 0 || h.0 >= 400).count();
            let mut statuses = serde_json::Map::new();
            for h in &hits { let k = if h.0 == 0 { "sem resposta".to_string() } else { h.0.to_string() }; let n = statuses.get(&k).and_then(Value::as_u64).unwrap_or(0); statuses.insert(k, json!(n + 1)); }
            let err_pct = failed as f64 * 100.0 / total as f64;
            let (max_p95, max_err) = (p["max_p95_ms"].as_u64().unwrap_or(0), p["max_error_percent"].as_f64().unwrap_or(0.0));
            let mut why = vec![];
            if err_pct > max_err { why.push(format!("{err_pct:.1}% das chamadas falharam (o aceito é {max_err}%)")); }
            if max_p95 > 0 && at(0.95) > max_p95 { why.push(format!("95% das chamadas levaram até {} ms (o limite é {max_p95} ms)", at(0.95))); }
            Ok(branch(why.is_empty(), json!({"ok": why.is_empty(), "name": format!("Carga em {url}"), "requests": total, "succeeded": total - failed, "failed": failed, "error_percent": (err_pct * 10.0).round() / 10.0,
                "avg_ms": times.iter().sum::<u64>() / total as u64, "p50_ms": at(0.5), "p95_ms": at(0.95), "max_ms": times[times.len() - 1], "seconds": (secs * 10.0).round() / 10.0, "per_second": (total as f64 / secs * 10.0).round() / 10.0,
                "statuses": statuses, "error": why.join("; ")})))
        }
        "qa.report" => {
            let cases = qa_cases(&p["results"]);
            if cases.is_empty() { return Err(fail("não chegou nenhum resultado de teste", 400)); }
            let title = text_of(p, "title");
            let title = if title.trim().is_empty() { "Relatório de testes".to_string() } else { title };
            let (pass, bad, skip) = (cases.iter().filter(|c| c.2 == Some(true)).count(), cases.iter().filter(|c| c.2 == Some(false)).count(), cases.iter().filter(|c| c.2.is_none()).count());
            let e = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
            let secs = |ms: u64| format!("{:.1}", ms as f64 / 1000.0);
            let fmt = p["format"].as_str().unwrap_or("html");
            let (ext, body) = match fmt {
                "junit" => ("xml", {
                    let mut suites: Vec<String> = vec![];
                    let mut names: Vec<&String> = vec![];
                    for c in &cases { if !names.contains(&&c.0) { names.push(&c.0); } }
                    for s in names {
                        let mine: Vec<_> = cases.iter().filter(|c| &c.0 == s).collect();
                        suites.push(format!("  <testsuite name=\"{}\" tests=\"{}\" failures=\"{}\" skipped=\"{}\" time=\"{}\">\n{}\n  </testsuite>", e(s), mine.len(), mine.iter().filter(|c| c.2 == Some(false)).count(), mine.iter().filter(|c| c.2.is_none()).count(), secs(mine.iter().map(|c| c.3).sum()),
                            mine.iter().map(|c| format!("    <testcase classname=\"{}\" name=\"{}\" time=\"{}\">{}</testcase>", e(s), e(&c.1), secs(c.3), match c.2 { Some(true) => String::new(), None => "<skipped/>".into(), Some(false) => format!("<failure message=\"{}\"/>", e(&c.4)) })).collect::<Vec<_>>().join("\n")));
                    }
                    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites name=\"{}\" tests=\"{}\" failures=\"{bad}\">\n{}\n</testsuites>\n", e(&title), cases.len(), suites.join("\n"))
                }),
                "markdown" => ("md", format!("# {title}\n\n**{}** · {pass} passaram · {bad} falharam{}\n\n| | Teste | Passo | Tempo | Erro |\n|---|---|---|---|---|\n{}\n", if bad == 0 { "Passou" } else { "Falhou" }, if skip > 0 { format!(" · {skip} não rodaram") } else { String::new() },
                    cases.iter().map(|c| format!("| {} | {} | {} | {} s | {} |", match c.2 { Some(true) => "✓", Some(false) => "✕", None => "–" }, c.0.replace('|', "\\|"), c.1.replace('|', "\\|"), secs(c.3).replace('.', ","), c.4.replace('|', "\\|").replace('\n', " "))).collect::<Vec<_>>().join("\n"))),
                _ => ("html", format!("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{t}</title><style>:root{{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--fg:#1c1f26;--mu:#6b7385;--ln:#e3e7ef;--ok:#1f9d61;--bad:#d6453d}}@media(prefers-color-scheme:dark){{:root{{--bg:#14161c;--card:#1e2129;--fg:#e6e8ee;--mu:#8a92a3;--ln:#2c313d}}}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 \"Segoe UI\",system-ui,sans-serif}}main{{max-width:920px;margin:0 auto;padding:28px 16px 48px}}h1{{margin:0 0 4px;font-size:22px;overflow-wrap:anywhere}}.sub{{color:var(--mu);font-size:13px}}.kp{{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}}.k{{flex:1 1 120px;background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:12px 14px}}.k b{{display:block;font-size:22px}}.k span{{color:var(--mu);font-size:12px}}.res b{{color:var(--{rc})}}table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--ln);border-radius:12px;overflow:hidden}}td{{padding:9px 10px;border-top:1px solid var(--ln);vertical-align:top;overflow-wrap:anywhere}}tr:first-child td{{border-top:0}}.st{{width:28px;font-weight:700;text-align:center}}.ok .st{{color:var(--ok)}}.bad .st{{color:var(--bad)}}.mu{{color:var(--mu);white-space:nowrap}}.err{{color:var(--bad);margin-top:3px}}.skip{{opacity:.55}}</style><main><h1>{t}</h1><div class=\"sub\">{when}</div><div class=\"kp\"><div class=\"k res\"><b>{res}</b><span>resultado</span></div><div class=\"k\"><b>{pass}</b><span>passaram</span></div><div class=\"k\"><b>{bad}</b><span>falharam</span></div><div class=\"k\"><b>{n}</b><span>conferências</span></div></div><table>{rows}</table></main></html>",
                    t = e(&title), rc = if bad == 0 { "ok" } else { "bad" }, res = if bad == 0 { "Passou" } else { "Falhou" }, n = cases.len(), when = chrono::Local::now().format("%d/%m/%Y %H:%M"),
                    rows = cases.iter().map(|c| format!("<tr class=\"{}\"><td class=\"st\">{}</td><td class=\"mu\">{}</td><td><b>{}</b>{}</td><td class=\"mu\">{} s</td></tr>", match c.2 { Some(true) => "ok", Some(false) => "bad", None => "skip" }, match c.2 { Some(true) => "✓", Some(false) => "✕", None => "–" }, e(&c.0), e(&c.1), if c.4.is_empty() { String::new() } else { format!("<div class=\"err\">{}</div>", e(&c.4)) }, secs(c.3).replace('.', ","))).collect::<String>())),
            };
            let path = if text_of(p, "path").trim().is_empty() { std::env::temp_dir().join(format!("relatorio-testes-{}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S"))) } else { path_of(p, "path")? };
            if let Some(d) = path.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
            std::fs::write(&path, body)?;
            Ok(json!({"out": {"path": path.to_string_lossy(), "ok": bad == 0, "passed": pass, "failed": bad, "skipped": skip, "total": cases.len()}}))
        }
        _ => Err(fail(format!("tipo de nó desconhecido: {kind}"), 400)),
    }
}
/// Gravador de um nó de plugin (`"record": { "args": [...] }` no automator.json): o programa fica rodando e cada linha
/// JSON que ele escreve é um passo. A tela busca as linhas novas com "poll" e encerra com "stop" (a entrada do
/// programa fecha; se ele não sair sozinho em alguns segundos, é finalizado).
struct Rec { id: String, lines: Arc<Mutex<Vec<Value>>>, done: Arc<std::sync::atomic::AtomicBool>, err: Arc<Mutex<String>>, stdin: Option<tokio::process::ChildStdin>, child: Option<tokio::process::Child>,
    /// gravador do nó Navegador do núcleo: avisar aqui encerra a gravação
    stop: Option<tokio::sync::oneshot::Sender<()>> }
static REC: LazyLock<Mutex<Option<Rec>>> = LazyLock::new(Default::default);
fn rec_stop() {
    if let Some(mut r) = REC.lock().take() {
        drop(r.stdin.take());
        if let Some(s) = r.stop.take() { let _ = s.send(()); }
        if let Some(mut child) = r.child.take() { tokio::spawn(async move { tokio::time::sleep(Duration::from_secs(4)).await; let _ = child.start_kill(); }); }
    }
}
async fn record(b: &Value) -> ApiResult<Value> {
    use std::sync::atomic::Ordering::Relaxed;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let action = b["action"].as_str().unwrap_or("");
    if action == "start" {
        let s = spec(b["type"].as_str().unwrap_or("")).ok_or_else(|| fail("o plugin deste nó está desligado ou foi removido", 409))?;
        if s["record"]["core"] == true {
            rec_stop();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let rec = Rec { id: id(), lines: Default::default(), done: Default::default(), err: Default::default(), stdin: None, child: None, stop: Some(tx) };
            tokio::spawn(browser::record(b["params"].clone(), rec.lines.clone(), rec.done.clone(), rec.err.clone(), rx));
            let rid = rec.id.clone();
            *REC.lock() = Some(rec);
            return Ok(json!({"id": rid}));
        }
        let args: Vec<String> = s["record"]["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        if args.is_empty() { return Err(fail("este nó não tem gravador", 400)); }
        rec_stop();
        let program = s["run"]["program"].as_str().unwrap_or("node").to_string();
        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&args).current_dir(s["dir"].as_str().unwrap_or(".")).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // sem janela de console
        let mut child = cmd.spawn().map_err(|e| fail(format!("não deu para abrir o gravador ({program}): {e}"), 500))?;
        let mut stdin = child.stdin.take();
        if let Some(i) = stdin.as_mut() { i.write_all(format!("{}\n", json!({"params": b["params"], "data": s["data"]})).as_bytes()).await?; i.flush().await?; }
        let (out, errs) = (child.stdout.take(), child.stderr.take());
        let rec = Rec { id: id(), lines: Default::default(), done: Default::default(), err: Default::default(), stdin, child: Some(child), stop: None };
        let (lines, done, err) = (rec.lines.clone(), rec.done.clone(), rec.err.clone());
        if let Some(out) = out {
            tokio::spawn(async move {
                let mut r = tokio::io::BufReader::new(out).lines();
                while let Ok(Some(l)) = r.next_line().await { if let Ok(v) = serde_json::from_str::<Value>(l.trim()) { let mut g = lines.lock(); if g.len() < 2000 { g.push(v); } } }
                done.store(true, Relaxed);
            });
        }
        if let Some(mut e) = errs {
            tokio::spawn(async move { let mut t = String::new(); let _ = e.read_to_string(&mut t).await; *err.lock() = t.trim().chars().take(600).collect(); });
        }
        let rid = rec.id.clone();
        *REC.lock() = Some(rec);
        return Ok(json!({"id": rid}));
    }
    let from = b["from"].as_u64().unwrap_or(0) as usize;
    let (lines, done, err) = {
        let g = REC.lock();
        match g.as_ref().filter(|r| b["id"] == r.id.as_str()) {
            Some(r) => (r.lines.lock().iter().skip(from).cloned().collect::<Vec<_>>(), r.done.load(Relaxed), r.err.lock().clone()),
            None => (vec![], true, String::new()),
        }
    };
    if action == "stop" { rec_stop(); }
    Ok(json!({"lines": lines, "done": done, "error": err}))
}
/// Nós que os plugins ligados acrescentam. O plugin põe um `automator.json` na pasta dele:
/// `{ "nodes": [{ "type", "name", "category", "desc", "inputs", "outputs", "params", "fields", "run": { "program", "args", "timeout" } }] }`.
/// O tipo vira `plugin.<id do plugin>.<type>` e quem roda é o programa do plugin (ver `run_plugin_node`).
fn plugin_nodes() -> Vec<Value> {
    if cfg!(test) { return vec![]; }
    let reg = crate::server::host().get();
    let mut out = vec![];
    for p in reg.list.iter().filter(|p| p.enabled && p.error.is_none()) {
        let doc = read_json(&std::path::Path::new(&p.path).join("automator.json"));
        for n in doc["nodes"].as_array().into_iter().flatten() {
            let (Some(kind), Some(name)) = (n["type"].as_str(), n["name"].as_str()) else { continue };
            let valid = !kind.is_empty() && kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            if !valid || n["run"]["program"].as_str().is_none_or(|s| s.trim().is_empty()) { continue; }
            let list = |k: &str, d: Value| if n[k].is_array() { n[k].clone() } else { d };
            out.push(json!({
                "type": format!("plugin.{}.{}", p.id, kind), "name": name, "category": n["category"].as_str().unwrap_or(&p.name), "desc": n["desc"].as_str().unwrap_or(""),
                "inputs": list("inputs", json!(["in"])), "outputs": list("outputs", json!(["out"])),
                "params": if n["params"].is_object() { n["params"].clone() } else { json!({}) }, "fields": list("fields", json!([])),
                "plugin": p.id, "plugin_name": p.name, "dir": p.path, "data": p.data_dir, "run": n["run"],
                "expects": n["expects"].as_str().unwrap_or(""), "returns": n["returns"].as_str().unwrap_or(""),
                "takes": n["takes"].as_str().unwrap_or("any"), "gives": n["gives"].as_str().unwrap_or("any"), "record": n["record"],
            }));
            if !n["sample"].is_null() && let Some(last) = out.last_mut() { last["sample"] = n["sample"].clone(); }
        }
    }
    out
}
pub fn catalog() -> Value {
    let mut all = builtin().as_array().cloned().unwrap_or_default();
    all.extend(more().as_array().cloned().unwrap_or_default());
    all.extend(media().as_array().cloned().unwrap_or_default());
    all.extend(ops_catalog().as_array().cloned().unwrap_or_default());
    all.extend(alarm_catalog().as_array().cloned().unwrap_or_default());
    all.extend(json_catalog().as_array().cloned().unwrap_or_default());
    all.extend(qa_catalog().as_array().cloned().unwrap_or_default());
    all.extend(time_catalog().as_array().cloned().unwrap_or_default());
    all.extend(logic_catalog().as_array().cloned().unwrap_or_default());
    all.extend(links::catalog().as_array().cloned().unwrap_or_default());
    all.extend(browser::catalog().as_array().cloned().unwrap_or_default());
    all.extend(plugin_nodes());
    // o que cada nó espera e entrega (o plugin pode trazer o dele no automator.json)
    for s in &mut all {
        let kind = s["type"].as_str().unwrap_or("");
        let Some((expects, returns, sample)) = io_doc(kind).or_else(|| links::io_doc(kind)).or_else(|| browser::io_doc(kind)) else { continue };
        if s["expects"].as_str().is_none_or(str::is_empty) { s["expects"] = json!(expects); }
        if s["returns"].as_str().is_none_or(str::is_empty) { s["returns"] = json!(returns); }
        if s.get("sample").is_none() && !sample.is_null() { s["sample"] = sample; }
    }
    for s in &mut all {
        let kind = s["type"].as_str().unwrap_or("");
        let Some((takes, gives)) = io_kind(kind).or_else(|| links::io_kind(kind)).or_else(|| (kind == "browser.run").then_some(("any", "object"))) else { continue };
        if s["takes"].as_str().is_none_or(str::is_empty) { s["takes"] = json!(takes); }
        if s["gives"].as_str().is_none_or(str::is_empty) { s["gives"] = json!(gives); }
    }
    // a paleta mostra um grupo por categoria, nesta ordem; as categorias dos plugins vêm depois, na ordem em que chegam
    const ORDER: [&str; 19] = ["Gatilhos", "Lógica", "Data e hora", "Texto", "Dados", "JSON", "Arquivos", "Windows", "Navegador", "Rede", "Conexões", "QA", "Segurança", "Auditoria", "Integrações", "IA", "Imagem", "Áudio", "Vídeo"];
    let mut extra: Vec<String> = vec![];
    for s in &all { let c = s["category"].as_str().unwrap_or(""); if !ORDER.contains(&c) && !extra.iter().any(|e| e == c) { extra.push(c.to_string()); } }
    all.sort_by_key(|s| { let c = s["category"].as_str().unwrap_or(""); ORDER.iter().position(|o| *o == c).unwrap_or_else(|| ORDER.len() + extra.iter().position(|e| e == c).unwrap_or(0)) });
    Value::Array(all)
}
fn spec(kind: &str) -> Option<Value> {
    catalog().as_array()?.iter().find(|s| s["type"] == kind).cloned()
}
fn schedule_node(f: &Flow) -> Option<&Node> { f.nodes.iter().find(|n| n.kind == "trigger.schedule" && !n.disabled) }
fn clock(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}
/// Estrutura do fluxo (nós, portas, ciclos); devolve a ordem de execução. Rascunho sem gatilho pode ser salvo:
/// quem exige o gatilho é a execução.
fn validate(f: &Flow) -> ApiResult<Vec<usize>> {
    if f.name.trim().is_empty() { return Err(fail("dê um nome ao fluxo", 400)); }
    if f.nodes.is_empty() { return Err(fail("o fluxo ainda não tem nós", 400)); }
    if f.nodes.len() > 200 || f.edges.len() > 1000 { return Err(fail("fluxo grande demais: até 200 nós e 1000 conexões", 400)); }
    let specs: HashMap<String, Value> = catalog().as_array().into_iter().flatten().map(|s| (s["type"].as_str().unwrap_or("").to_string(), s.clone())).collect();
    let mut ids = HashMap::new();
    for (i, n) in f.nodes.iter().enumerate() {
        if n.id.is_empty() || ids.insert(n.id.as_str(), i).is_some() { return Err(fail("identificador de nó vazio ou repetido", 400)); }
        if !specs.contains_key(&n.kind) { return Err(fail(format!("tipo de nó não suportado: {}", n.kind), 400)); }
        if n.kind == "trigger.file" && !n.disabled && n.params["path"].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(fail("\"Quando um arquivo mudar\": informe o arquivo ou a pasta", 400));
        }
        if n.kind == "trigger.webhook" && !n.disabled && !endpoint_name_ok(n.params["name"].as_str().unwrap_or("")) {
            return Err(fail("Endpoint HTTP: o nome aceita letras, números, hífen e sublinhado (até 60)", 400));
        }
        if n.kind == "trigger.schedule" && !n.disabled {
            if n.params["mode"] == "daily" {
                if clock(n.params["time"].as_str().unwrap_or("")).is_none() { return Err(fail("agenda: informe o horário como HH:MM", 400)); }
            } else if !(1..=525600).contains(&n.params["every_minutes"].as_u64().unwrap_or(0)) {
                return Err(fail("agenda: o intervalo vai de 1 a 525600 minutos", 400));
            } else if window_of(&n.params).is_err() {
                return Err(fail("agenda: informe os horários do intervalo como HH:MM", 400));
            }
        }
    }
    if f.nodes.iter().filter(|n| n.kind == "trigger.schedule" && !n.disabled).count() > 1 { return Err(fail("use uma única Agenda por fluxo", 400)); }
    let has = |s: &Value, side: &str, port: &str| s[side].as_array().is_some_and(|a| a.iter().any(|p| p == port));
    let mut degree = vec![0usize; f.nodes.len()];
    let mut next: Vec<Vec<usize>> = vec![vec![]; f.nodes.len()];
    let mut seen = HashSet::new();
    for e in &f.edges {
        let (&a, &b) = ids.get(e.from.as_str()).zip(ids.get(e.to.as_str())).ok_or_else(|| fail("conexão aponta para nó inexistente", 400))?;
        if !has(&specs[&f.nodes[a].kind], "outputs", &e.from_port) || !has(&specs[&f.nodes[b].kind], "inputs", &e.to_port) { return Err(fail("porta inválida na conexão", 400)); }
        if !seen.insert((&e.from, &e.from_port, &e.to, &e.to_port)) { return Err(fail("conexão repetida", 400)); }
        degree[b] += 1;
        next[a].push(b);
    }
    // ordem topológica estável: entre os nós prontos, o que aparece primeiro no documento
    let mut out = Vec::with_capacity(f.nodes.len());
    let mut done = vec![false; f.nodes.len()];
    while let Some(i) = (0..degree.len()).find(|&i| degree[i] == 0 && !done[i]) {
        done[i] = true;
        out.push(i);
        for &b in &next[i] { degree[b] -= 1; }
    }
    if out.len() != f.nodes.len() { return Err(fail("o fluxo tem um ciclo: uma conexão volta para um nó anterior. Para repetir um trecho, use Para cada item, Repetir ou Repetir enquanto.", 400)); }
    check_bodies(f)?;
    Ok(out)
}
/// Próximo disparo da Agenda do fluxo depois de `from` (ms): por intervalo, ou no horário local nos dias marcados.
/// Os dias da semana marcados num parâmetro (0 = domingo); vazio: todos.
fn week_days(v: &Value) -> Vec<u32> { v.as_array().map(|a| a.iter().filter_map(|d| d.as_u64().or_else(|| d.as_str().and_then(|t| t.parse().ok())).map(|d| d as u32)).collect()).unwrap_or_default() }
/// O intervalo de trabalho que contém `t`, ou o próximo: (início, fim). `days`: os dias em que o intervalo começa;
/// `span`: das HH:MM até as HH:MM (um fim menor ou igual ao início atravessa a meia-noite); sem `span`, o dia inteiro.
fn work_window(t: chrono::DateTime<chrono::Local>, days: &[u32], span: Option<((u32, u32), (u32, u32))>) -> Option<(chrono::DateTime<chrono::Local>, chrono::DateTime<chrono::Local>)> {
    use chrono::{Datelike, TimeZone};
    // começa por ontem: um intervalo que atravessa a meia-noite pode ainda estar valendo
    (-1..9).find_map(|d| {
        let date = t.date_naive() + chrono::Duration::days(d);
        if !days.is_empty() && !days.contains(&date.weekday().num_days_from_sunday()) { return None; }
        let (a, b) = span.unwrap_or(((0, 0), (0, 0)));
        let start = chrono::Local.from_local_datetime(&date.and_hms_opt(a.0, a.1, 0)?).earliest()?;
        let end_day = if b <= a { date + chrono::Duration::days(1) } else { date };
        let end = chrono::Local.from_local_datetime(&end_day.and_hms_opt(b.0, b.1, 0)?).earliest()?;
        (t < end).then_some((start, end))
    })
}
/// Dias e horário de um nó (Agenda, Dentro do horário?): os dias marcados e, se pedir "entre dois horários", o intervalo.
fn window_of(p: &Value) -> ApiResult<(Vec<u32>, Option<((u32, u32), (u32, u32))>)> {
    let span = if p["window"] == "between" {
        let get = |k: &str| clock(p[k].as_str().unwrap_or("")).ok_or_else(|| fail("informe os horários como HH:MM", 400));
        Some((get("from")?, get("to")?))
    } else { None };
    Ok((week_days(&p["days"]), span))
}
fn next_fire(f: &Flow, from: i64) -> Option<i64> {
    use chrono::{Datelike, TimeZone};
    let p = &schedule_node(f)?.params;
    if p["mode"] != "daily" {
        let at = from + p["every_minutes"].as_i64().filter(|n| *n > 0)? * 60000;
        // com dias ou horário escolhidos, o disparo que cairia fora fica para o começo do próximo intervalo
        let (days, span) = window_of(p).ok()?;
        if days.is_empty() && span.is_none() { return Some(at); }
        let (start, _) = work_window(chrono::Local.timestamp_millis_opt(at).single()?, &days, span)?;
        return Some(at.max(start.timestamp_millis()));
    }
    let (h, m) = clock(p["time"].as_str()?)?;
    let days = week_days(&p["days"]);
    let start = chrono::Local.timestamp_millis_opt(from).single()?;
    (0..8).find_map(|d| {
        let date = start.date_naive() + chrono::Duration::days(d);
        if !days.is_empty() && !days.contains(&date.weekday().num_days_from_sunday()) { return None; }
        let at = chrono::Local.from_local_datetime(&date.and_hms_opt(h, m, 0)?).earliest()?.timestamp_millis();
        (at > from).then_some(at)
    })
}
fn stringify(v: &Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}
/// `a.b.0.c` dentro de um valor: chaves de objeto e posições de lista. Texto que é JSON é lido como JSON.
fn dig(v: &Value, path: &str) -> Option<Value> {
    let mut cur = v.clone();
    for k in path.split('.').filter(|k| !k.is_empty()) {
        if let Value::String(s) = &cur { cur = serde_json::from_str(s).ok()?; }
        cur = match &cur {
            Value::Object(o) => o.get(k)?.clone(),
            Value::Array(a) => a.get(k.parse::<usize>().ok()?)?.clone(),
            _ => return None,
        };
    }
    Some(cur)
}
fn fill(v: &Value, input: &Value, outputs: &HashMap<String, Value>) -> ApiResult<Value> {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{\{\s*(input(?:\.[\w.-]+)?|nodes\.[\w.-]+|vars\.[\w.-]+)\s*\}\}").unwrap());
    match v {
        Value::String(s) => {
            let resolve = |key: &str| -> ApiResult<Value> {
                if key == "input" { return Ok(input.clone()); }
                if let Some(path) = key.strip_prefix("input.") {
                    return dig(input, path).ok_or_else(|| fail(format!("a entrada não tem o campo pedido em {{{{{key}}}}}"), 400));
                }
                if let Some(path) = key.strip_prefix("nodes.") {
                    let (node, rest) = path.split_once('.').unwrap_or((path, "out"));
                    let out = outputs.get(node).ok_or_else(|| fail(format!("{{{{{key}}}}}: esse nó ainda não rodou neste caminho"), 400))?;
                    return dig(out, rest).ok_or_else(|| fail(format!("{{{{{key}}}}}: saída ou campo não existe"), 400));
                }
                // variável que ainda não foi definida vale vazio (um contador começa do nada)
                if let Some(path) = key.strip_prefix("vars.") { return Ok(outputs.get("$vars").and_then(|v| dig(v, path)).unwrap_or_else(|| json!(""))); }
                Err(fail(format!("expressão desconhecida: {key}"), 400))
            };
            // Referências do cofre ({{vault:..}}) continuam intactas para os serviços do núcleo.
            if let Some(c) = RE.captures(s) && c.get(0).unwrap().as_str() == s.trim() { return resolve(&c[1]); }
            let mut out = String::new();
            let mut pos = 0;
            for c in RE.captures_iter(s) {
                let m = c.get(0).unwrap();
                out.push_str(&s[pos..m.start()]);
                out.push_str(&stringify(&resolve(&c[1])?));
                pos = m.end();
            }
            out.push_str(&s[pos..]);
            Ok(json!(out))
        }
        Value::Array(a) => Ok(Value::Array(a.iter().map(|v| fill(v, input, outputs)).collect::<ApiResult<_>>()?)),
        Value::Object(o) => Ok(Value::Object(o.iter().map(|(k, v)| Ok((k.clone(), fill(v, input, outputs)?))).collect::<ApiResult<_>>()?)),
        _ => Ok(v.clone()),
    }
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !matches!(s.trim().to_lowercase().as_str(), "" | "false" | "0" | "não" | "nao" | "no"),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}
/// A comparação do nó Condição. Texto e número se comparam pelo valor ("5" é igual a 5); "contém" ignora maiúsculas.
fn condition(p: &Value) -> ApiResult<bool> {
    let (a, b) = (&p["value"], &p["equals"]);
    let (sa, sb) = (stringify(a), stringify(b));
    let num = |s: &str| s.trim().replace(',', ".").parse::<f64>().ok();
    let same = || a == b || sa.trim() == sb.trim() || matches!((num(&sa), num(&sb)), (Some(x), Some(y)) if x == y);
    let empty = || a.is_null() || sa.trim().is_empty() || a.as_array().is_some_and(|v| v.is_empty()) || a.as_object().is_some_and(|v| v.is_empty());
    let pair = || num(&sa).zip(num(&sb)).ok_or_else(|| fail(format!("a condição compara números, mas recebeu \"{sa}\" e \"{sb}\""), 400));
    Ok(match p["op"].as_str().unwrap_or("eq") {
        "eq" => same(),
        "ne" => !same(),
        "contains" => sa.to_lowercase().contains(&sb.to_lowercase()),
        "not_contains" => !sa.to_lowercase().contains(&sb.to_lowercase()),
        "gt" => { let (x, y) = pair()?; x > y }
        "lt" => { let (x, y) = pair()?; x < y }
        "empty" => empty(),
        "not_empty" => !empty(),
        "true" => truthy(a),
        o => return Err(fail(format!("comparação desconhecida: {o}"), 400)),
    })
}
async fn service(plugin: &str, route: &str, b: Value) -> ApiResult<Value> {
    let f = crate::server::host()
        .core()
        .get(route)
        .cloned()
        .ok_or_else(|| fail("serviço indisponível", 500))?;
    let r = Req {
        query: HashMap::from([("plugin".into(), plugin.into())]),
        method: axum::http::Method::POST,
        headers: Default::default(),
        body: serde_json::to_vec(&b)?.into(),
        remote: false,
        internal: false,
    };
    match f(Arc::new(r)).await? {
        Reply::Json(v) => Ok(v),
        _ => Err(fail("resposta inválida", 500)),
    }
}
fn notify(title: &str, message: &str) {
    if let Some(ui) = crate::server::UI.get() {
        ui(crate::server::UiEvent::Notify(title.into(), message.into()));
    }
    log(format!("{title}: {message}"));
}

const EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
/// Os agentes de IA: Codex e Claude Code sempre existem (com o modelo, o esforço e o programa que o usuário tiver
/// trocado); depois, os que ele criou.
fn clis() -> Vec<Cli> {
    let saved = if cfg!(test) { vec![] } else { let _g = STORE.lock(); load().map(|s| s.clis).unwrap_or_default() };
    let mut out: Vec<Cli> = [("codex", "Codex"), ("claude", "Claude Code")].into_iter().map(|(id, name)| {
        let mut c = saved.iter().find(|c| c.id == id).cloned().unwrap_or_default();
        c.id = id.into();
        c.kind = id.into();
        if c.name.trim().is_empty() { c.name = name.into(); }
        c
    }).collect();
    out.extend(saved.into_iter().filter(|c| c.id != "codex" && c.id != "claude"));
    out
}
fn cli_options() -> Value {
    Value::Array(clis().iter().map(|c| json!({"value": c.id, "label": c.name})).collect())
}
/// Programa e argumentos da chamada. Devolve também se o pedido vai pela entrada padrão (o normal) ou num argumento.
/// `access`: "read" (só leitura, o padrão), "edit" (altera arquivos da pasta de trabalho) ou "full" (arquivos e
/// comandos, sem confirmação). Num programa personalizado, vira {access} nos argumentos: quem limita é o programa.
fn cli_command(c: &Cli, model: &str, effort: &str, prompt: &str, access: &str) -> ApiResult<(String, Vec<String>, bool)> {
    let (model, effort) = (model.trim(), effort.trim());
    let access = if access.is_empty() { "read" } else { access };
    if !matches!(access, "read" | "edit" | "full") { return Err(fail(format!("nível de acesso desconhecido: {access}"), 400)); }
    if !model.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-/:@[]".contains(ch)) { return Err(fail(format!("nome de modelo inválido: {model}"), 400)); }
    if !effort.is_empty() && !EFFORTS.contains(&effort) { return Err(fail(format!("esforço desconhecido: {effort}"), 400)); }
    let own = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let extra = c.args.iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
    let program = if c.program.trim().is_empty() { c.kind.clone() } else { c.program.trim().to_string() };
    Ok(match c.kind.as_str() {
        "codex" => {
            let mut a = own(&["exec", "--skip-git-repo-check"]);
            match access {
                "full" => a.push("--dangerously-bypass-approvals-and-sandbox".into()),
                "edit" => a.extend(own(&["--sandbox", "workspace-write"])),
                _ => a.extend(own(&["--sandbox", "read-only"])),
            }
            if !model.is_empty() { a.extend(["-m".to_string(), model.to_string()]); }
            if !effort.is_empty() { a.extend(["-c".to_string(), format!("model_reasoning_effort=\"{effort}\"")]); }
            a.extend(extra);
            a.push("-".into());
            (program, a, true)
        }
        "claude" => {
            let mut a = own(&["-p", "--output-format", "text"]);
            match access {
                "full" => a.push("--dangerously-skip-permissions".into()),
                "edit" => a.extend(own(&["--permission-mode", "acceptEdits"])),
                // só leitura: modo plan, só as ferramentas de ler, sem MCP nem comandos do usuário
                _ => a.extend(own(&["--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--disable-slash-commands"])),
            }
            if !model.is_empty() { a.extend(["--model".to_string(), model.to_string()]); }
            if !effort.is_empty() { a.extend(["--effort".to_string(), effort.to_string()]); }
            a.extend(extra);
            (program, a, true)
        }
        _ => {
            if c.program.trim().is_empty() { return Err(fail(format!("o agente {} não tem programa: configure em Agentes de IA", c.name), 400)); }
            let stdin = !c.args.iter().any(|a| a.contains("{prompt}"));
            // argumento que ficou vazio (o modelo não foi informado) sai, junto com a opção que vinha antes dele
            let mut a: Vec<String> = vec![];
            for raw in c.args.iter().map(|a| a.trim()).filter(|a| !a.is_empty()) {
                let v = raw.replace("{model}", model).replace("{effort}", effort).replace("{access}", access).replace("{prompt}", prompt);
                if v.is_empty() && raw != "{prompt}" { if a.last().is_some_and(|l| l.starts_with('-')) { a.pop(); } continue; }
                a.push(v);
            }
            (program, a, stdin)
        }
    })
}

async fn cli(plugin: &str, provider: &str, prompt: &str, cwd: &Value, over: &Value) -> ApiResult<Value> {
    let c = clis().into_iter().find(|c| c.id == provider).ok_or_else(|| fail(format!("agente de IA não encontrado: {provider}. Confira em Agentes de IA."), 400))?;
    // modelo e esforço: o que o nó pediu; sem isso, o do agente
    let pick = |v: &Value, d: &str| v.as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
    let (program, args, stdin) = cli_command(&c, &pick(&over["model"], &c.model), &pick(&over["effort"], &c.effort), prompt, over["access"].as_str().unwrap_or(""))?;
    // revisões e perguntas curtas: 3 minutos; o nó Agente de IA escolhe o tempo dele
    let timeout = over["timeout_min"].as_u64().map(|m| m.clamp(1, 60) * 60_000).unwrap_or(180_000);
    let mut b = json!({"program":program,"args":args,"cwd":cwd,"timeout":timeout});
    if stdin { b["stdinBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(prompt)); }
    service(plugin, "plugin/exec", b).await
}
fn rpc_body(v: &Value, expected: u64) -> ApiResult<Value> {
    if v["ok"] != true {
        return Err(fail(
            format!("MCP HTTP {}: {}", v["status"], v["body"]),
            502,
        ));
    }
    let body = v["body"].as_str().unwrap_or("");
    let parsed = serde_json::from_str::<Value>(body).ok().or_else(|| {
        body.replace("\r\n", "\n")
            .split("\n\n")
            .map(|event| {
                event
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim_start)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
            .find(|v| v["id"] == expected)
    });
    let parsed =
        parsed.ok_or_else(|| fail("MCP deve responder JSON ou SSE com resposta JSON-RPC", 502))?;
    if parsed["jsonrpc"] != "2.0" || parsed["id"] != expected {
        return Err(fail("resposta MCP não corresponde ao pedido", 502));
    }
    if let Some(e) = parsed.get("error") {
        return Err(fail(format!("MCP: {e}"), 422));
    }
    parsed
        .get("result")
        .cloned()
        .ok_or_else(|| fail("MCP respondeu sem resultado", 502))
}
async fn mcp(p: &Value) -> ApiResult<Value> {
    if p.get("arguments").is_some_and(|v| !v.is_object()) {
        return Err(fail("argumentos MCP devem ser um objeto JSON", 400));
    }
    let url = p["url"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| fail("URL HTTP do MCP obrigatória", 400))?;
    let tool = p["tool"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| fail("nome da ferramenta MCP obrigatório", 400))?;
    let mut headers = p["headers"].as_object().cloned().unwrap_or_default();
    headers.insert(
        "Accept".into(),
        json!("application/json, text/event-stream"),
    );
    let send = |headers: Value, body: Value| {
        service(
            "automator",
            "plugin/fetch",
            json!({"url":url,"method":"POST","headers":headers,"json":body,"timeout":120000}),
        )
    };
    let init=send(json!(headers),json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"BlueScreen Automator","version":env!("CARGO_PKG_VERSION")}}})).await?;
    let result = rpc_body(&init, 1)?;
    let protocol = result["protocolVersion"]
        .as_str()
        .ok_or_else(|| fail("MCP sem versão de protocolo", 502))?;
    if !matches!(protocol, "2025-03-26" | "2025-06-18" | "2025-11-25") {
        return Err(fail(format!("versão MCP não suportada: {protocol}"), 422));
    }
    headers.insert("MCP-Protocol-Version".into(), json!(protocol));
    if let Some(session) = init["headers"]["mcp-session-id"].as_str() {
        headers.insert("Mcp-Session-Id".into(), json!(session));
    }
    let ready = send(
        json!(headers),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await?;
    if ready["ok"] != true {
        return Err(fail("MCP recusou inicialização", 502));
    }
    let call=send(json!(headers),json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":p.get("arguments").cloned().unwrap_or(json!({}))}})).await;
    if headers.contains_key("Mcp-Session-Id") {
        let _ = service(
            "automator",
            "plugin/fetch",
            json!({"url":url,"method":"DELETE","headers":headers,"timeout":5000}),
        )
        .await;
    }
    let result = rpc_body(&call?, 2)?;
    if result["isError"] == true {
        return Err(fail(format!("ferramenta MCP falhou: {result}"), 422));
    }
    Ok(result)
}

fn text_of(p: &Value, k: &str) -> String {
    match &p[k] { Value::Null => String::new(), v => stringify(v) }
}
fn path_of(p: &Value, k: &str) -> ApiResult<std::path::PathBuf> {
    let s = text_of(p, k);
    let s = s.trim().trim_matches('"');
    if s.is_empty() { Err(fail("informe o caminho do arquivo ou da pasta", 400)) } else { Ok(std::path::PathBuf::from(s)) }
}
/// Filtro de nomes com `*` e `?`, sem diferenciar maiúsculas.
fn wildcard(pattern: &str, name: &str) -> bool {
    let p = pattern.trim();
    if p.is_empty() || p == "*" { return true; }
    let re = format!("(?i)^{}$", regex::escape(p).replace(r"\*", ".*").replace(r"\?", "."));
    regex::Regex::new(&re).is_ok_and(|r| r.is_match(name))
}
/// Resultado do `plugin/exec`: o que o programa escreveu, ou o motivo da falha.
fn exec_out(v: &Value) -> ApiResult<Value> {
    if v["ok"] != true {
        let err = v["err"].as_str().unwrap_or("").trim();
        let why = if v["timedOut"] == true { "passou do tempo limite".to_string() } else if err.is_empty() { format!("saiu com código {}", v["code"]) } else { err.chars().take(2000).collect() };
        return Err(fail(format!("o programa falhou: {why}"), 422));
    }
    Ok(json!(v["out"].as_str().unwrap_or("").trim_end()))
}
/// Arquivos (nome completo, data, tamanho) do caminho vigiado: o próprio arquivo, ou o primeiro nível da pasta.
fn snapshot(path: &str) -> Vec<(String, u64, u64)> {
    let one = |p: &std::path::Path| p.metadata().ok().filter(|m| m.is_file()).map(|m| (p.to_string_lossy().into_owned(), m.modified().map(|t| mtime_ms(t) as u64).unwrap_or(0), m.len()));
    let p = std::path::Path::new(path);
    if !p.is_dir() { return one(p).into_iter().collect(); }
    let mut v: Vec<_> = std::fs::read_dir(p).into_iter().flatten().flatten().filter_map(|e| one(&e.path())).take(5000).collect();
    v.sort();
    v
}
static WATCH: LazyLock<Mutex<HashMap<String, (String, Vec<(String, u64, u64)>)>>> = LazyLock::new(Default::default);
/// Gatilho "Quando um arquivo mudar": o que foi criado ou alterado desde a última olhada (a primeira só anota).
fn file_changes(f: &Flow) -> Option<Value> {
    let mut hit = None;
    let mut w = WATCH.lock();
    for n in f.nodes.iter().filter(|n| n.kind == "trigger.file" && !n.disabled) {
        let path = n.params["path"].as_str().unwrap_or("").trim().trim_matches('"').to_string();
        if path.is_empty() { continue; }
        let snap = snapshot(&path);
        let key = format!("{}/{}", f.id, n.id);
        if let Some((old_path, old)) = w.get(&key) && *old_path == path {
            let changed: Vec<&String> = snap.iter().filter(|e| !old.contains(e)).map(|e| &e.0).collect();
            if let Some(first) = changed.first() && hit.is_none() {
                let name = std::path::Path::new(first.as_str()).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                hit = Some(json!({"path": first, "name": name, "files": changed}));
            }
        }
        w.insert(key, (path, snap));
    }
    hit
}
/// As referências `{{vault:nome}}` e `{{cred:nome}}` de um texto, cada uma numa variável de ambiente: (variáveis,
/// referência -> nome da variável). A do Cofre da IDE segue como referência (quem resolve é o `plugin/exec`, com as
/// permissões do cofre); a credencial do Automator já vai com o valor.
fn secret_env(text: &str) -> ApiResult<(serde_json::Map<String, Value>, serde_json::Map<String, Value>)> {
    static MARK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{\{\s*(?:vault|cred):[^{}]+\}\}").unwrap());
    let creds = crate::creds::resolve_all(text)?;
    let (mut env, mut secrets) = (serde_json::Map::new(), serde_json::Map::new());
    for m in MARK.find_iter(text) {
        if secrets.contains_key(m.as_str()) { continue; }
        let name = format!("BS_SECRET_{}", secrets.len());
        let value = creds.iter().find(|c| c.0 == m.as_str()).map(|c| c.1.clone()).unwrap_or_else(|| m.as_str().to_string());
        env.insert(name.clone(), json!(value));
        secrets.insert(m.as_str().to_string(), json!(name));
    }
    Ok((env, secrets))
}
/// Roda o nó com as credenciais do Automator (`{{cred:nome}}`) no lugar e tira os valores do que ele devolve, saída e
/// erro, antes de seguir para os próximos nós e para o histórico.
async fn run_node(flow: &str, n: &Node, p: Value, input: Value) -> ApiResult<Value> {
    let text = p.to_string();
    if !text.contains("cred:") { return execute_node(n, p, input).await; }
    let who = format!("{flow} › {}", n.title.clone().filter(|t| !t.trim().is_empty()).or_else(|| spec(&n.kind).and_then(|s| s["name"].as_str().map(String::from))).unwrap_or_else(|| n.kind.clone()));
    let found = match crate::creds::resolve_all(&text) { Ok(f) => f, Err(e) => { crate::creds::note_use(&text, &who, false, &e.msg); return Err(e); } };
    if found.is_empty() { return execute_node(n, p, input).await; }
    if n.kind == "windows.command" && (p["args"].to_string().contains("cred:") || p["program"].to_string().contains("cred:")) {
        let e = fail("credencial não vai em argumento de programa (outros programas do PC conseguem ler). Use o nó Script PowerShell: lá {{cred:nome}} chega por variável de ambiente.", 400);
        crate::creds::note_use(&text, &who, false, "credencial em argumento de programa");
        return Err(e);
    }
    crate::creds::note_use(&text, &who, true, "");
    let values: Vec<String> = found.iter().map(|x| x.1.clone()).collect();
    // nó de plugin e script do PowerShell recebem por variável de ambiente (secret_env); os outros, no próprio campo
    let p = if n.kind.starts_with("plugin.") || n.kind == "windows.powershell" { p } else { crate::creds::fill(&p, &found) };
    match execute_node(n, p, input).await {
        Ok(v) => Ok(crate::creds::scrub_value(&v, &values)),
        Err(mut e) => { e.msg = crate::plugins::vault::scrub(&e.msg, &values); Err(e) }
    }
}
/// Nó de plugin: roda o programa do plugin na pasta dele. Pela entrada padrão vai um JSON
/// `{ node, params, input, data, secrets }`; a saída padrão (JSON, ou texto) é a saída do nó.
/// `{{vault:nome}}` nos parâmetros não vai no JSON: cada um vira uma variável de ambiente (`secrets` diz qual), e o
/// cofre só entrega se o segredo estiver liberado para o plugin e para o programa.
async fn run_plugin_node(kind: &str, p: Value, input: Value) -> ApiResult<Value> {
    let s = spec(kind).ok_or_else(|| fail("o plugin deste nó está desligado ou foi removido", 409))?;
    let plugin = s["plugin"].as_str().unwrap_or("");
    let text = p.to_string();
    let (env, secrets) = secret_env(&text)?;
    let stdin = json!({"node": kind.rsplit('.').next(), "params": p, "input": input, "data": s["data"], "secrets": secrets}).to_string();
    let run = &s["run"];
    let v = service(plugin, "plugin/exec", json!({
        "program": run["program"], "args": run["args"], "cwd": s["dir"], "env": env,
        "stdinBase64": base64::engine::general_purpose::STANDARD.encode(stdin),
        "timeout": run["timeout"].as_u64().unwrap_or(120_000),
    })).await?;
    let out = exec_out(&v)?;
    let text = out.as_str().unwrap_or("").trim();
    let val = serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!(text));
    // mais de uma saída: o programa escolhe a porta com { "port": "nome", "value": ... }
    let ports: Vec<&str> = s["outputs"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
    if ports != ["out"] {
        let port = val["port"].as_str().filter(|p| ports.contains(p)).ok_or_else(|| fail("o programa do nó não disse por qual saída seguir ({\"port\":\"nome\",\"value\":...})", 422))?;
        let mut m = serde_json::Map::new();
        m.insert(port.to_string(), val["value"].clone());
        return Ok(Value::Object(m));
    }
    Ok(json!({"out": val}))
}

/// Roda um script do PowerShell por um arquivo temporário com BOM (acentos certos, blocos de várias linhas).
async fn run_ps(script: &str, cwd: &Value, timeout: &Value, env: Value) -> ApiResult<Value> {
    let file = std::env::temp_dir().join(format!("bluescreen-{}.ps1", id()));
    let mut body = vec![0xEF, 0xBB, 0xBF];
    body.extend(script.as_bytes());
    std::fs::write(&file, body)?;
    let v = service("automator", "plugin/exec", json!({
        "program": "powershell", "args": ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file.to_string_lossy()],
        "cwd": cwd, "timeout": timeout, "env": env,
    })).await;
    let _ = std::fs::remove_file(&file);
    exec_out(&v?)
}
/// O arquivo de entrada de um nó de mídia (tem que existir).
fn media_in(p: &Value) -> ApiResult<std::path::PathBuf> {
    let f = path_of(p, "file").map_err(|_| fail("informe o arquivo", 400))?;
    if !f.is_file() { return Err(fail(format!("arquivo não encontrado: {}", f.display()), 404)); }
    Ok(f)
}
/// Onde gravar: o que o nó pediu (arquivo, ou pasta que já existe); sem isso, ao lado do original com um sufixo.
fn media_out(p: &Value, input: &std::path::Path, suffix: &str, ext: &str) -> ApiResult<std::path::PathBuf> {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "arquivo".into());
    let name = format!("{stem}{suffix}.{ext}");
    let asked = text_of(p, "out");
    let asked = asked.trim().trim_matches('"');
    let out = if asked.is_empty() { input.with_file_name(&name) } else {
        let o = std::path::PathBuf::from(asked);
        if o.is_dir() { o.join(&name) } else { o }
    };
    if out == input { return Err(fail("o arquivo de saída é o mesmo da entrada: escolha outro nome em \"Gravar em\"", 400)); }
    if let Some(d) = out.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
    Ok(out)
}
/// Instante ou duração para o FFmpeg: segundos (90, 1.5) ou hh:mm:ss.
fn time_arg(p: &Value, k: &str) -> ApiResult<Option<String>> {
    let t = text_of(p, k).trim().replace(',', ".");
    if t.is_empty() { return Ok(None); }
    if !t.chars().all(|c| c.is_ascii_digit() || c == ':' || c == '.') || !t.chars().any(|c| c.is_ascii_digit()) { return Err(fail(format!("tempo inválido: {t} (use segundos, ou 00:01:30)"), 400)); }
    Ok(Some(t))
}
async fn ffmpeg(program: &str, args: Vec<String>) -> ApiResult<String> {
    let mut all: Vec<String> = if program == "ffmpeg" { ["-hide_banner", "-loglevel", "error", "-y"].iter().map(|s| s.to_string()).collect() } else { vec![] };
    all.extend(args);
    let v = match service("automator", "plugin/exec", json!({"program": program, "args": all, "timeout": 3_600_000})).await {
        Err(e) if e.status == 404 => return Err(fail("o FFmpeg não está instalado. No terminal: winget install Gyan.FFmpeg (e reabra o BlueScreen).", 404)),
        r => r?,
    };
    if v["ok"] != true {
        let err = v["err"].as_str().unwrap_or("").trim();
        let why = if v["timedOut"] == true { "passou de uma hora".to_string() } else if err.is_empty() { format!("saiu com código {}", v["code"]) } else { err.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ") };
        return Err(fail(format!("o FFmpeg não conseguiu: {why}"), 422));
    }
    Ok(v["out"].as_str().unwrap_or("").to_string())
}
const IMAGE_PS: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = $null; $dst = $null
try { $src = [System.Drawing.Image]::FromFile($env:BS_IN) }
catch { [Console]::Error.WriteLine('o arquivo não é uma imagem que o Windows abra (use png, jpg, bmp, gif ou tif)'); exit 1 }
try {
  $w = [int]$env:BS_W; $h = [int]$env:BS_H
  switch ($env:BS_OP) {
    'info' { Write-Output ('{"width":' + $src.Width + ',"height":' + $src.Height + '}'); return }
    'resize' {
      if ($w -le 0 -and $h -le 0) { throw 'informe a largura ou a altura' }
      if ($w -le 0) { $w = [int][math]::Max(1, [math]::Round($src.Width * $h / $src.Height)) }
      if ($h -le 0) { $h = [int][math]::Max(1, [math]::Round($src.Height * $w / $src.Width)) }
      $dst = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($dst)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($src, 0, 0, $w, $h); $g.Dispose()
    }
    'crop' {
      $x = [int]$env:BS_X; $y = [int]$env:BS_Y
      $w = [math]::Min($w, $src.Width - $x); $h = [math]::Min($h, $src.Height - $y)
      if ($w -le 0 -or $h -le 0) { throw ('o recorte ficou fora da imagem, que tem ' + $src.Width + ' x ' + $src.Height) }
      $dst = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($dst)
      $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle $x, $y, $w, $h), [System.Drawing.GraphicsUnit]::Pixel); $g.Dispose()
    }
    'rotate' { $dst = New-Object System.Drawing.Bitmap $src; $dst.RotateFlip([System.Drawing.RotateFlipType]$env:BS_TURN) }
    default { $dst = New-Object System.Drawing.Bitmap $src }
  }
  $src.Dispose(); $src = $null
  $ext = [IO.Path]::GetExtension($env:BS_OUT).ToLower()
  if ($ext -eq '.jpg' -or $ext -eq '.jpeg') {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$env:BS_Q)
    $dst.Save($env:BS_OUT, $codec, $ep)
  } else {
    $fmt = @{ '.png' = 'Png'; '.bmp' = 'Bmp'; '.gif' = 'Gif'; '.tif' = 'Tiff'; '.tiff' = 'Tiff' }[$ext]
    if (-not $fmt) { throw ('formato de imagem sem suporte: ' + $ext + ' (use png, jpg, bmp ou gif)') }
    $dst.Save($env:BS_OUT, [System.Drawing.Imaging.ImageFormat]::$fmt)
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { if ($src) { $src.Dispose() }; if ($dst) { $dst.Dispose() } }
"#;
/// Nós de imagem, áudio e vídeo. Devolve o caminho do arquivo gravado (ou os dados, nos nós de "Dados").
async fn media_node(kind: &str, p: &Value) -> ApiResult<Value> {
    let input = media_in(p)?;
    let src = input.to_string_lossy().into_owned();
    let own = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let num = |k: &str| p[k].as_i64().or_else(|| p[k].as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0);
    let done = |out: std::path::PathBuf| Ok(json!(out.to_string_lossy()));
    if let Some(op) = kind.strip_prefix("image.") {
        let ext_in = input.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "png".into());
        let (suffix, ext) = match op {
            "resize" => ("-redimensionada", ext_in.as_str()), "crop" => ("-recorte", ext_in.as_str()), "rotate" => ("-girada", ext_in.as_str()),
            "convert" => ("", match p["format"].as_str().unwrap_or("jpg") { f @ ("png" | "bmp" | "gif") => f, _ => "jpg" }),
            "info" => ("", ext_in.as_str()),
            _ => return Err(fail("nó não suportado", 400)),
        };
        let out = if op == "info" { input.clone() } else { media_out(p, &input, suffix, ext)? };
        let turn = p["turn"].as_str().filter(|t| ["Rotate90FlipNone", "Rotate270FlipNone", "Rotate180FlipNone", "RotateNoneFlipX", "RotateNoneFlipY"].contains(t)).unwrap_or("Rotate90FlipNone");
        let env = json!({"BS_IN": src, "BS_OUT": out.to_string_lossy(), "BS_OP": op, "BS_W": num("width").to_string(), "BS_H": num("height").to_string(),
            "BS_X": num("x").to_string(), "BS_Y": num("y").to_string(), "BS_Q": num("quality").clamp(1, 100).to_string(), "BS_TURN": turn});
        let r = run_ps(IMAGE_PS, &Value::Null, &json!(120000), env).await.map_err(|e| fail(e.msg.replace("o programa falhou: ", "a imagem não pôde ser tratada: "), e.status))?;
        return if op == "info" { Ok(serde_json::from_str(r.as_str().unwrap_or("").trim()).unwrap_or(r)) } else { done(out) };
    }
    match kind {
        "media.info" => {
            let raw = ffmpeg("ffprobe", own(&["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &src])).await?;
            let j: Value = serde_json::from_str(&raw).map_err(|_| fail("o FFmpeg não reconheceu o arquivo", 422))?;
            let stream = |t: &str| j["streams"].as_array().into_iter().flatten().find(|s| s["codec_type"] == t).cloned().unwrap_or(Value::Null);
            let (v, a) = (stream("video"), stream("audio"));
            let secs = j["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
            Ok(json!({"seconds": (secs * 10.0).round() / 10.0, "duration": format!("{:02}:{:02}:{:02}", secs as u64 / 3600, secs as u64 / 60 % 60, secs as u64 % 60),
                "size": j["format"]["size"].as_str().and_then(|s| s.parse::<u64>().ok()), "format": j["format"]["format_name"],
                "width": v["width"], "height": v["height"], "video": v["codec_name"], "audio": a["codec_name"]}))
        }
        "audio.convert" | "video.audio" => {
            let fmt = match p["format"].as_str().unwrap_or("mp3") { f @ ("wav" | "m4a" | "ogg" | "flac") => f, _ => "mp3" };
            let out = media_out(p, &input, "", fmt)?;
            let mut a = own(&["-i", &src, "-vn"]);
            if matches!(fmt, "mp3" | "m4a" | "ogg") { let k = match p["bitrate"].as_str().unwrap_or("192") { k @ ("96" | "128" | "320") => k, _ => "192" }; a.extend(own(&["-b:a", &format!("{k}k")])); }
            a.push(out.to_string_lossy().into_owned());
            ffmpeg("ffmpeg", a).await?;
            done(out)
        }
        "audio.trim" | "video.trim" => {
            let ext = input.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "mp4".into());
            let out = media_out(p, &input, "-trecho", &ext)?;
            let mut a = vec![];
            if let Some(s) = time_arg(p, "start")? { a.extend(own(&["-ss", &s])); }
            a.extend(own(&["-i", &src]));
            if let Some(d) = time_arg(p, "duration")? { a.extend(own(&["-t", &d])); }
            if p["mode"] == "fast" { a.extend(own(&["-c", "copy"])); }
            a.push(out.to_string_lossy().into_owned());
            ffmpeg("ffmpeg", a).await?;
            done(out)
        }
        "audio.volume" => {
            let ext = input.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "mp3".into());
            let out = media_out(p, &input, "-volume", &ext)?;
            let filter = if p["mode"] == "percent" { format!("volume={:.2}", num("percent").clamp(1, 1000) as f64 / 100.0) } else { "loudnorm".to_string() };
            ffmpeg("ffmpeg", own(&["-i", &src, "-af", &filter, &out.to_string_lossy()])).await?;
            done(out)
        }
        "video.convert" => {
            let fmt = match p["format"].as_str().unwrap_or("mp4") { f @ ("webm" | "mkv" | "gif") => f, _ => "mp4" };
            let out = media_out(p, &input, if input.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(fmt)) { "-convertido" } else { "" }, fmt)?;
            let h = match p["height"].as_str().unwrap_or("0") { h @ ("1080" | "720" | "480" | "360") => h, _ => "" };
            let crf = match (fmt, p["quality"].as_str().unwrap_or("medium")) { ("webm", "high") => "26", ("webm", "low") => "40", ("webm", _) => "33", (_, "high") => "20", (_, "low") => "30", _ => "25" };
            let mut a = own(&["-i", &src]);
            if fmt == "gif" {
                a.extend(own(&["-vf", &format!("fps=12,scale=-1:{}:flags=lanczos", if h.is_empty() { "360" } else { h }), "-an"]));
            } else {
                if !h.is_empty() { a.extend(own(&["-vf", &format!("scale=-2:{h}")])); }
                if fmt == "webm" { a.extend(own(&["-c:v", "libvpx-vp9", "-crf", crf, "-b:v", "0"])); } else { a.extend(own(&["-c:v", "libx264", "-crf", crf, "-preset", "medium", "-pix_fmt", "yuv420p"])); }
                if p["sound"] == "mute" { a.push("-an".into()); } else if fmt == "webm" { a.extend(own(&["-c:a", "libopus"])); } else { a.extend(own(&["-c:a", "aac"])); }
            }
            a.push(out.to_string_lossy().into_owned());
            ffmpeg("ffmpeg", a).await?;
            done(out)
        }
        "video.frame" => {
            let out = media_out(p, &input, "-quadro", "png")?;
            let t = time_arg(p, "time")?.unwrap_or_else(|| "0".into());
            ffmpeg("ffmpeg", own(&["-ss", &t, "-i", &src, "-frames:v", "1", &out.to_string_lossy()])).await?;
            if !out.is_file() { return Err(fail("esse instante fica depois do fim do vídeo", 422)); }
            done(out)
        }
        _ => Err(fail("nó não suportado", 400)),
    }
}

/// Quantas execuções terminadas ficam no histórico: o que a pessoa escolheu, de 5 a 1000 (padrão 100).
fn keep_runs(s: &Store) -> usize { if s.keep_runs == 0 { 100 } else { s.keep_runs.clamp(5, 1000) } }
/// Corta o histórico no limite. Execuções em andamento ficam sempre: as longas continuam visíveis mesmo depois de
/// muitos fluxos rápidos.
fn trim_runs(s: &mut Store) {
    let (keep, mut finished) = (keep_runs(s), 0);
    s.runs.retain(|r| r["status"] == "running" || { finished += 1; finished <= keep });
}
/// Caminho de pasta da lista de fluxos ("Financeiro/Mensal"): até 6 níveis, cada um com até 60 caracteres. None:
/// vazio ou inválido (fluxo solto).
fn folder_name(s: &str) -> Option<String> {
    let parts: Vec<&str> = s.split('/').map(str::trim).collect();
    let ok = parts.len() <= 6 && parts.iter().all(|p| !p.is_empty() && p.chars().count() <= 60 && !p.contains('\\') && !p.chars().any(char::is_control));
    ok.then(|| parts.join("/"))
}
/// As pastas, na ordem em que a pessoa deixou. Pasta que só aparece num fluxo (arquivo antigo, importado) entra no
/// fim, e a pasta de cima de uma subpasta sempre existe, antes dela.
fn folder_list(s: &Store) -> Vec<String> {
    let mut l: Vec<String> = vec![];
    for n in s.folders.iter().chain(s.flows.iter().filter(|f| !f.folder.is_empty()).map(|f| &f.folder)) {
        let mut at = 0;
        while let Some(i) = n[at..].find('/') { let up = &n[..at + i]; if !l.iter().any(|x| x == up) { l.push(up.to_string()); } at += i + 1; }
        if !l.contains(n) { l.push(n.clone()); }
    }
    l
}
fn endpoint_name_ok(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty() && s.len() <= 60 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
/// Um parâmetro que pode ser `{{vault:nome}}`: o valor sai do cofre (se o segredo está liberado para o Automator) e
/// é usado só aqui dentro, para comparar; nunca vai para a saída do nó.
fn secret_value(v: &Value) -> ApiResult<String> {
    let s = text_of(v, "");
    let t = s.trim();
    match t.strip_prefix("{{vault:").and_then(|r| r.strip_suffix("}}")) {
        Some(name) => crate::plugins::vault::resolve(&crate::plugins::vault::Caller { plugin: "automator".into(), verified: false }, name.trim()),
        None => Ok(s),
    }
}
/// Comparação que não revela, pelo tempo que leva, onde os textos começam a diferir.
fn same_secret(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let (x, y) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    x.iter().zip(y.iter()).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}
fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut k = [0u8; 64];
    if key.len() > 64 { k[..32].copy_from_slice(&Sha256::digest(key)); } else { k[..key.len()].copy_from_slice(key); }
    let pad = |b: u8| k.iter().map(|x| x ^ b).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(msg).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().iter().map(|b| format!("{b:02x}")).collect()
}
static RATE: LazyLock<Mutex<HashMap<String, std::collections::VecDeque<i64>>>> = LazyLock::new(Default::default);
static AUDIT: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent("BlueScreen-Automator/1.0").build().unwrap_or_default());
/// Lista de um parâmetro: lista de verdade, texto em JSON, ou um valor só.
fn list_of(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::String(s) => match serde_json::from_str::<Value>(s) { Ok(Value::Array(a)) => a, _ if s.trim().is_empty() => vec![], _ => vec![json!(s)] },
        Value::Null => vec![],
        o => vec![o.clone()],
    }
}
fn number_of(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().replace(',', ".").parse().ok()))
}
fn parse_csv(text: &str, sep: char) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut cell, mut quoted) = (vec![], vec![], String::new(), false);
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if quoted {
            if c == '"' { if it.peek() == Some(&'"') { cell.push('"'); it.next(); } else { quoted = false; } } else { cell.push(c); }
        } else if c == '"' && cell.is_empty() { quoted = true; }
        else if c == sep { row.push(std::mem::take(&mut cell)); }
        else if c == '\n' { row.push(std::mem::take(&mut cell)); rows.push(std::mem::take(&mut row)); }
        else if c != '\r' { cell.push(c); }
    }
    if !cell.is_empty() || !row.is_empty() { row.push(cell); rows.push(row); }
    rows.into_iter().filter(|r: &Vec<String>| r.iter().any(|c| !c.trim().is_empty())).collect()
}
fn host_of(s: &str) -> String {
    let t = s.trim();
    if t.contains("://") { reqwest::Url::parse(t).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default() } else { t.split('/').next().unwrap_or("").split(':').next().unwrap_or("").to_string() }
}
fn http_url(p: &Value) -> ApiResult<reqwest::Url> {
    let t = text_of(p, "url");
    let t = t.trim();
    let full = if t.contains("://") { t.to_string() } else { format!("https://{t}") };
    reqwest::Url::parse(&full).ok().filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some()).ok_or_else(|| fail(format!("endereço inválido: {t}"), 400))
}
/// Chamada à API do Dynatrace. O token sai do cofre no `plugin/fetch`, que confere se o endereço está liberado.
async fn dynatrace(p: &Value, method: &str, path: &str, body: Option<Value>) -> ApiResult<Value> {
    let env = text_of(p, "env");
    let env = env.trim().trim_end_matches('/');
    if !env.starts_with("https://") { return Err(fail("informe o ambiente do Dynatrace, começando com https://", 400)); }
    let secret = p["secret"].as_str().unwrap_or("dynatrace").trim().to_string();
    if secret.is_empty() || !secret.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c)) { return Err(fail("nome do segredo inválido", 400)); }
    let mut b = json!({"url": format!("{env}{path}"), "method": method, "headers": {"Authorization": format!("Api-Token {{{{vault:{secret}}}}}"), "Accept": "application/json"}, "timeout": 60000});
    if let Some(j) = body { b["json"] = j; }
    let v = service("automator", "plugin/fetch", b).await?;
    let text = v["body"].as_str().unwrap_or("");
    if v["ok"] != true {
        let msg = serde_json::from_str::<Value>(text).ok().and_then(|j| j["error"]["message"].as_str().map(String::from)).unwrap_or_else(|| text.chars().take(300).collect());
        return Err(fail(format!("o Dynatrace respondeu {}: {msg}", v["status"]), 422));
    }
    Ok(serde_json::from_str(text).unwrap_or(Value::Null))
}
const TLS_PS: &str = r#"$ErrorActionPreference = 'Stop'
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.ReceiveTimeout = 10000; $c.SendTimeout = 10000
  $c.Connect($env:BS_HOST, [int]$env:BS_PORT)
  $s = New-Object Net.Security.SslStream($c.GetStream(), $false, ([Net.Security.RemoteCertificateValidationCallback] { $true }))
  $s.AuthenticateAsClient($env:BS_HOST)
  $x = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $s.RemoteCertificate
  $o = [ordered]@{ host = $env:BS_HOST; expires = $x.NotAfter.ToString('yyyy-MM-dd'); days = [int][math]::Floor(($x.NotAfter - (Get-Date)).TotalDays); issuer = $x.Issuer; subject = $x.Subject; protocol = [string]$s.SslProtocol }
  $c.Close()
  Write-Output ($o | ConvertTo-Json -Compress)
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
"#;
const SYS_PS: &str = r#"$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ drive = $_.DeviceID; free_gb = [math]::Round($_.FreeSpace / 1GB, 1); total_gb = [math]::Round($_.Size / 1GB, 1); used_percent = if ($_.Size) { [int][math]::Round(100 - 100 * $_.FreeSpace / $_.Size) } else { 0 } } })
$o = [ordered]@{ cpu_percent = [int]$cpu; memory_percent = [int][math]::Round(100 - 100 * $os.FreePhysicalMemory / $os.TotalVisibleMemorySize); memory_free_gb = [math]::Round($os.FreePhysicalMemory / 1MB, 1); memory_total_gb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1); disks = $disks; uptime_hours = [int]((Get-Date) - $os.LastBootUpTime).TotalHours }
Write-Output ($o | ConvertTo-Json -Compress -Depth 4)
"#;
/// Nós de endpoint, segurança, auditoria, integrações, dados e saúde do PC. `None`: o tipo não é daqui.
async fn ops_node(n: &Node, p: &Value, input: &Value) -> Option<ApiResult<Value>> {
    let branch = |yes: bool, v: Value| if yes { json!({"true": v}) } else { json!({"false": v}) };
    let out = |v: Value| json!({"out": v});
    Some(async {
        Ok(match n.kind.as_str() {
            "trigger.webhook" => out(json!({"method":"GET","query":{},"headers":{},"body":null,"raw":"","token":""})),
            "http.respond" => {
                let status = p["status"].as_u64().filter(|s| (100..=599).contains(s)).unwrap_or(200);
                out(json!({"status": status, "type": p["type"].as_str().unwrap_or("json"), "body": p["body"]}))
            }
            "sec.token" => {
                let expected = secret_value(&json!({"": p["expected"]}))?;
                if expected.trim().is_empty() { return Err(fail("Exigir token: informe o token esperado", 500)); }
                if !same_secret(text_of(p, "got").trim(), expected.trim()) { return Err(fail("token ausente ou inválido", 401)); }
                out(input.clone())
            }
            "sec.rate" => {
                let (max, per) = (p["max"].as_u64().unwrap_or(30).max(1) as usize, p["per_s"].as_i64().unwrap_or(60).clamp(1, 86400) * 1000);
                let key = format!("{}|{}", n.id, text_of(p, "key"));
                let mut g = RATE.lock();
                if g.len() > 5000 { g.retain(|_, q| q.back().is_some_and(|t| now() - *t < 86_400_000)); }
                let q = g.entry(key).or_default();
                while q.front().is_some_and(|t| now() - *t >= per) { q.pop_front(); }
                if q.len() >= max { return Err(fail(format!("chamadas demais: o limite é {max} a cada {} s", per / 1000), 429)); }
                q.push_back(now());
                out(input.clone())
            }
            "sec.hmac" => {
                let secret = secret_value(&json!({"": p["secret"]}))?;
                if secret.is_empty() { return Err(fail("Conferir assinatura: informe o segredo", 500)); }
                let got = text_of(p, "signature").trim().to_lowercase();
                let got = got.strip_prefix("sha256=").unwrap_or(&got);
                if got.is_empty() || !same_secret(got, &hmac_sha256_hex(secret.as_bytes(), text_of(p, "raw").as_bytes())) { return Err(fail("assinatura ausente ou inválida", 401)); }
                out(input.clone())
            }
            "sec.require" => {
                for f in p["fields"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(str::trim).filter(|f| !f.is_empty()) {
                    let v = dig(&p["value"], f);
                    if v.as_ref().is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty())) { return Err(fail(format!("campo obrigatório ausente: {f}"), 400)); }
                }
                out(input.clone())
            }
            "logic.assert" => {
                if !condition(p)? {
                    let m = text_of(p, "message");
                    return Err(fail(if m.trim().is_empty() { format!("a verificação falhou: veio \"{}\"{}", text_of(p, "value").chars().take(200).collect::<String>(), if p["equals"].is_null() || text_of(p, "equals").is_empty() { String::new() } else { format!(", comparado com \"{}\"", text_of(p, "equals")) }) } else { m }, 422));
                }
                out(input.clone())
            }
            "audit.http" => {
                let url = http_url(p)?;
                let began = std::time::Instant::now();
                let (mut info, ok) = match AUDIT.get(url.clone()).send().await {
                    Ok(r) => {
                        let status = r.status().as_u16();
                        let last = r.url().to_string();
                        let body = r.text().await.unwrap_or_default();
                        let ms = began.elapsed().as_millis() as u64;
                        let (want, max) = (text_of(p, "contains"), p["max_ms"].as_u64().unwrap_or(0));
                        let has = want.trim().is_empty() || body.contains(want.trim());
                        let fast = max == 0 || ms <= max;
                        let why = if !(200..400).contains(&status) { format!("respondeu {status}") } else if !has { "a página não tem o texto esperado".into() } else if !fast { format!("demorou {ms} ms") } else { String::new() };
                        (json!({"status": status, "ms": ms, "size": body.len(), "final_url": last, "reason": why}), (200..400).contains(&status) && has && fast)
                    }
                    Err(e) => (json!({"status": 0, "ms": began.elapsed().as_millis() as u64, "reason": format!("não respondeu: {}", e.without_url())}), false),
                };
                info["url"] = json!(url.to_string());
                info["ok"] = json!(ok);
                branch(ok, info)
            }
            "audit.headers" => {
                let url = http_url(p)?;
                let r = AUDIT.get(url.clone()).send().await.map_err(|e| fail(format!("o site não respondeu: {}", e.without_url()), 502))?;
                let https = r.url().scheme() == "https";
                let h = r.headers();
                let checks = [
                    ("strict-transport-security", "HSTS: obriga o navegador a usar HTTPS"), ("content-security-policy", "CSP: limita de onde a página carrega scripts"),
                    ("x-content-type-options", "impede o navegador de adivinhar o tipo dos arquivos"), ("x-frame-options", "impede a página de ser embutida em outro site (clickjacking)"),
                    ("referrer-policy", "controla o que vai no Referer para outros sites"), ("permissions-policy", "limita câmera, microfone e localização"),
                ];
                // frame-ancestors na CSP vale pelo X-Frame-Options
                let csp = h.get("content-security-policy").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
                let has = |name: &str| h.contains_key(name) || (name == "x-frame-options" && csp.contains("frame-ancestors"));
                let present: Vec<&str> = checks.iter().filter(|c| has(c.0)).map(|c| c.0).collect();
                let missing: Vec<Value> = checks.iter().filter(|c| !has(c.0)).map(|c| json!({"header": c.0, "why": c.1})).collect();
                let points = present.len() + https as usize;
                out(json!({"url": r.url().to_string(), "https": https, "score": format!("{points}/7"), "points": points, "present": present, "missing": missing,
                    "server": h.get("server").and_then(|v| v.to_str().ok()), "ok": missing.is_empty() && https}))
            }
            "audit.tls" => {
                let host = host_of(&text_of(p, "host"));
                if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') { return Err(fail("informe o site (por exemplo: example.com)", 400)); }
                let port = p["port"].as_u64().filter(|n| (1..=65535).contains(n)).unwrap_or(443);
                let r = run_ps(TLS_PS, &Value::Null, &json!(30000), json!({"BS_HOST": host, "BS_PORT": port.to_string()})).await.map_err(|e| fail(e.msg.replace("o programa falhou: ", "não deu para ler o certificado: "), e.status))?;
                let mut v: Value = serde_json::from_str(r.as_str().unwrap_or("").trim()).map_err(|_| fail("resposta ilegível ao ler o certificado", 502))?;
                v["expired"] = json!(v["days"].as_i64().unwrap_or(0) < 0);
                out(v)
            }
            "audit.port" => {
                let host = host_of(&text_of(p, "host"));
                let port = p["port"].as_u64().filter(|n| (1..=65535).contains(n)).ok_or_else(|| fail("porta inválida", 400))? as u16;
                if host.is_empty() { return Err(fail("informe o servidor", 400)); }
                let began = std::time::Instant::now();
                let open = tokio::time::timeout(Duration::from_secs(p["timeout_s"].as_u64().unwrap_or(5).clamp(1, 60)), tokio::net::TcpStream::connect((host.as_str(), port))).await.is_ok_and(|r| r.is_ok());
                branch(open, json!({"host": host, "port": port, "open": open, "ms": began.elapsed().as_millis() as u64}))
            }
            "audit.links" => {
                use futures_util::StreamExt;
                let url = http_url(p)?;
                let page = AUDIT.get(url.clone()).send().await.map_err(|e| fail(format!("o site não respondeu: {}", e.without_url()), 502))?;
                let base = page.url().clone();
                let html = page.text().await.unwrap_or_default();
                static HREF: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)"#).unwrap());
                let mut seen = HashSet::new();
                let links: Vec<reqwest::Url> = HREF.captures_iter(&html).filter_map(|c| base.join(c[1].trim()).ok()).filter(|u| matches!(u.scheme(), "http" | "https")).filter(|u| seen.insert(u.to_string()))
                    .take(p["max"].as_u64().unwrap_or(50).clamp(1, 300) as usize).collect();
                let results: Vec<(String, Option<String>)> = futures_util::stream::iter(links).map(|u| async move {
                    let r = tokio::time::timeout(Duration::from_secs(12), AUDIT.get(u.clone()).send()).await;
                    let bad = match r { Ok(Ok(r)) if r.status().as_u16() < 400 => None, Ok(Ok(r)) => Some(format!("respondeu {}", r.status().as_u16())), Ok(Err(e)) => Some(format!("{}", e.without_url())), Err(_) => Some("não respondeu em 12 s".into()) };
                    (u.to_string(), bad)
                }).buffer_unordered(8).collect().await;
                let broken: Vec<Value> = results.iter().filter_map(|(u, b)| b.as_ref().map(|b| json!({"url": u, "reason": b}))).collect();
                out(json!({"url": base.to_string(), "checked": results.len(), "broken": broken, "ok": broken.is_empty()}))
            }
            "notify.chat" => {
                let url = text_of(p, "url");
                if !url.trim().starts_with("https://") { return Err(fail("informe o endereço do webhook (https://…)", 400)); }
                let text = text_of(p, "text");
                let body = if p["service"] == "discord" { json!({"content": text.chars().take(2000).collect::<String>()}) } else { json!({"text": text}) };
                let v = service("automator", "plugin/fetch", json!({"url": url.trim(), "method": "POST", "json": body, "timeout": 30000})).await?;
                if v["ok"] != true { return Err(fail(format!("o serviço respondeu {}: {}", v["status"], v["body"].as_str().unwrap_or("").chars().take(200).collect::<String>()), 422)); }
                out(input.clone())
            }
            "dynatrace.problems" => {
                let limit = p["limit"].as_u64().unwrap_or(50).clamp(1, 500);
                let sel = match p["status"].as_str().unwrap_or("open") { "closed" => "&problemSelector=status(%22closed%22)", "all" => "", _ => "&problemSelector=status(%22open%22)" };
                let j = dynatrace(p, "GET", &format!("/api/v2/problems?pageSize={limit}{sel}"), None).await?;
                let problems: Vec<Value> = j["problems"].as_array().into_iter().flatten().map(|x| json!({
                    "id": x["displayId"], "title": x["title"], "severity": x["severityLevel"], "impact": x["impactLevel"], "status": x["status"],
                    "start": x["startTime"].as_i64().and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.to_rfc3339()),
                    "entities": x["affectedEntities"].as_array().into_iter().flatten().filter_map(|e| e["name"].as_str()).collect::<Vec<_>>(),
                })).collect();
                out(json!({"total": j["totalCount"].as_u64().unwrap_or(problems.len() as u64), "problems": problems}))
            }
            "dynatrace.metric" => {
                let sel = text_of(p, "selector");
                if sel.trim().is_empty() { return Err(fail("informe a métrica", 400)); }
                let from = text_of(p, "from");
                let j = dynatrace(p, "GET", &format!("/api/v2/metrics/query?metricSelector={}&from={}", urlencoding::encode(sel.trim()), urlencoding::encode(if from.trim().is_empty() { "now-1h" } else { from.trim() })), None).await?;
                let series: Vec<Value> = j["result"].as_array().into_iter().flatten().flat_map(|r| r["data"].as_array().cloned().unwrap_or_default()).map(|d| {
                    let vals: Vec<f64> = d["values"].as_array().into_iter().flatten().filter_map(|v| v.as_f64()).collect();
                    json!({"dimensions": d["dimensions"], "last": vals.last(), "avg": if vals.is_empty() { None } else { Some(vals.iter().sum::<f64>() / vals.len() as f64) }, "max": vals.iter().cloned().reduce(f64::max), "points": vals.len()})
                }).collect();
                out(json!({"metric": sel.trim(), "series": series}))
            }
            "dynatrace.event" => {
                let title = text_of(p, "title");
                if title.trim().is_empty() { return Err(fail("dê um título ao evento", 400)); }
                let mut body = json!({"eventType": p["kind"].as_str().unwrap_or("CUSTOM_DEPLOYMENT"), "title": title.trim()});
                let entity = text_of(p, "entity");
                if !entity.trim().is_empty() { body["entitySelector"] = json!(entity.trim()); }
                if let Some(o) = p["properties"].as_object().filter(|o| !o.is_empty()) { body["properties"] = Value::Object(o.iter().map(|(k, v)| (k.clone(), json!(stringify(v)))).collect()); }
                out(dynatrace(p, "POST", "/api/v2/events/ingest", Some(body)).await?)
            }
            "data.csv" => {
                let text = text_of(p, "text");
                let first = text.lines().next().unwrap_or("");
                let sep = match p["sep"].as_str().unwrap_or("auto") { "," => ',', ";" => ';', "\t" => '\t', _ => [';', '\t', ','].into_iter().max_by_key(|c| first.matches(*c).count()).unwrap_or(',') };
                let rows = parse_csv(&text, sep);
                let Some((head, rest)) = rows.split_first() else { return Ok(out(json!([]))) };
                out(Value::Array(rest.iter().map(|r| Value::Object(head.iter().enumerate().map(|(i, h)| (h.trim().to_string(), json!(r.get(i).map(|c| c.trim()).unwrap_or("")))).collect())).collect()))
            }
            "data.filter" => {
                let field = text_of(p, "field");
                let mut keep = vec![];
                for item in list_of(&p["list"]) {
                    let v = if field.trim().is_empty() { item.clone() } else { dig(&item, field.trim()).unwrap_or(Value::Null) };
                    if condition(&json!({"value": v, "op": p["op"], "equals": p["equals"]})).unwrap_or(false) { keep.push(item); }
                }
                out(Value::Array(keep))
            }
            "data.stats" => {
                let field = text_of(p, "field");
                let nums: Vec<f64> = list_of(&p["list"]).iter().filter_map(|i| number_of(&if field.trim().is_empty() { i.clone() } else { dig(i, field.trim()).unwrap_or(Value::Null) })).collect();
                let sum: f64 = nums.iter().sum();
                out(json!({"count": nums.len(), "sum": sum, "avg": if nums.is_empty() { None } else { Some(sum / nums.len() as f64) }, "min": nums.iter().cloned().reduce(f64::min), "max": nums.iter().cloned().reduce(f64::max)}))
            }
            "data.table" => {
                let rows = list_of(&p["list"]);
                let mut cols: Vec<String> = vec![];
                for r in rows.iter().take(200) { if let Some(o) = r.as_object() { for k in o.keys() { if !cols.contains(k) { cols.push(k.clone()); } } } }
                if cols.is_empty() { cols.push("valor".into()); }
                let cell = |r: &Value, c: &str| match r { Value::Object(o) => o.get(c).map(|v| if v.is_null() { String::new() } else { stringify(v) }).unwrap_or_default(), v => stringify(v) };
                let fmt = p["format"].as_str().unwrap_or("markdown");
                out(json!(match fmt {
                    "csv" => { let q = |s: &str| if s.contains([';', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
                        std::iter::once(cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(";")).chain(rows.iter().map(|r| cols.iter().map(|c| q(&cell(r, c))).collect::<Vec<_>>().join(";"))).collect::<Vec<_>>().join("\r\n") }
                    "html" => { let e = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                        format!("<table>\n<thead><tr>{}</tr></thead>\n<tbody>\n{}\n</tbody>\n</table>", cols.iter().map(|c| format!("<th>{}</th>", e(c))).collect::<String>(), rows.iter().map(|r| format!("<tr>{}</tr>", cols.iter().map(|c| format!("<td>{}</td>", e(&cell(r, c)))).collect::<String>())).collect::<Vec<_>>().join("\n")) }
                    _ => { let m = |s: &str| s.replace('|', "\\|").replace('\n', " ");
                        std::iter::once(format!("| {} |", cols.iter().map(|c| m(c)).collect::<Vec<_>>().join(" | "))).chain(std::iter::once(format!("|{}|", cols.iter().map(|_| "---").collect::<Vec<_>>().join("|"))))
                            .chain(rows.iter().map(|r| format!("| {} |", cols.iter().map(|c| m(&cell(r, c))).collect::<Vec<_>>().join(" | ")))).collect::<Vec<_>>().join("\n") }
                }))
            }
            "sys.info" => {
                let r = run_ps(SYS_PS, &Value::Null, &json!(30000), json!({})).await?;
                out(serde_json::from_str(r.as_str().unwrap_or("").trim()).unwrap_or(r))
            }
            "sys.process" => {
                let name = text_of(p, "name");
                let name = name.trim().trim_end_matches(".exe").trim_end_matches(".EXE");
                if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || " ._-+".contains(c)) { return Err(fail("informe o nome do programa (sem a pasta)", 400)); }
                let r = run_ps("@(Get-Process -Name $env:BS_NAME -ErrorAction SilentlyContinue).Count", &Value::Null, &json!(20000), json!({"BS_NAME": name})).await?;
                let count = r.as_str().unwrap_or("0").trim().parse::<u64>().unwrap_or(0);
                branch(count > 0, json!({"name": name, "running": count > 0, "count": count}))
            }
            _ => return Err(fail("\u{0}", 0)),
        })
    }.await).filter(|r| !r.as_ref().is_err_and(|e| e.status == 0))
}

async fn execute_node(n: &Node, p: Value, input: Value) -> ApiResult<Value> {
    if n.kind.starts_with("qa.") { return qa_node(&n.kind, &p).await; }
    if n.kind.starts_with("time.") { return time_node(&n.kind, &p, input).await; }
    if n.kind.starts_with("browser.") { return browser::node(&n.kind, &p).await; }
    if let Some(r) = links::node(&n.kind, &p, &input).await { return r; }
    if let Some(r) = ops_node(n, &p, &input).await { return r; }
    let out = match n.kind.as_str() {
        "trigger.manual" => p.get("sample").cloned().unwrap_or(Value::Null),
        "trigger.schedule" | "trigger.startup" => json!({"at":now()}),
        "trigger.file" => json!({"path":p["path"]}),
        "util.text" => p["text"].clone(),
        "util.output" => input,
        k if k.starts_with("json.") => json_node(k, &p)?,
        "logic.if" => {
            let pass = condition(&p)?;
            return Ok(if pass {
                json!({"true":input})
            } else {
                json!({"false":input})
            });
        }
        "logic.switch" => {
            // o primeiro caso que casar decide a saída; nenhum: "outro"
            let (value, mode) = (stringify(&p["value"]), p["mode"].as_str().unwrap_or("eq"));
            let cases = list_of(&p["cases"]);
            if cases.len() > 5 { return Err(fail("Escolher caminho aceita até 5 casos; para mais, encadeie outro nó na saída \"outro\"", 400)); }
            let hit = cases.iter().position(|c| {
                let c = stringify(c);
                if c.trim().is_empty() { return false; }
                match mode {
                    "contains" => value.to_lowercase().contains(&c.trim().to_lowercase()),
                    "regex" => regex::Regex::new(c.trim()).is_ok_and(|r| r.is_match(&value)),
                    _ => condition(&json!({"value": value, "op": "eq", "equals": c})).unwrap_or(false),
                }
            });
            let port = hit.map(|i| (i + 1).to_string()).unwrap_or_else(|| "other".into());
            let mut m = serde_json::Map::new();
            m.insert(port, input);
            return Ok(Value::Object(m));
        }
        "logic.all" => {
            let rules: Vec<Value> = list_of(&p["rules"]).into_iter().filter(|r| r.is_object()).collect();
            if rules.is_empty() { return Err(fail("adicione pelo menos uma condição", 400)); }
            let mut passed = vec![];
            for r in &rules { passed.push(condition(&json!({"value": r["value"], "op": r["op"].as_str().unwrap_or("eq"), "equals": r["equals"]}))?); }
            let pass = if p["mode"] == "any" { passed.iter().any(|x| *x) } else { passed.iter().all(|x| *x) };
            return Ok(if pass { json!({"true": input}) } else { json!({"false": input}) });
        }
        "util.delay" => {
            let secs = p["seconds"]
                .as_u64()
                .filter(|n| *n <= 3600)
                .ok_or_else(|| fail("espera deve ser de 0 a 3600 segundos", 400))?;
            tokio::time::sleep(Duration::from_secs(secs)).await;
            input
        }
        "windows.command" => {
            exec_out(&service("automator", "plugin/exec", p).await?)?
        }
        "http.request" => {
            let mut p = p;
            // GET e HEAD não levam corpo; corpo vazio também não vai
            let method = p["method"].as_str().unwrap_or("GET").to_uppercase();
            if matches!(method.as_str(), "GET" | "HEAD") || p["body"].as_str().is_some_and(str::is_empty) {
                if let Some(o) = p.as_object_mut() { o.remove("body"); }
            }
            let v = service("automator", "plugin/fetch", p).await?;
            let body = v["body"].as_str().unwrap_or("");
            if v["ok"] != true {
                return Err(fail(format!("o servidor respondeu {}: {}", v["status"], body.chars().take(500).collect::<String>()), 422));
            }
            // resposta em JSON já chega como objeto: {{input.campo}} funciona no próximo nó
            serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!(body))
        }
        "windows.notify" => {
            notify(
                p["title"].as_str().unwrap_or("BlueScreen"),
                &stringify(&p["message"]),
            );
            input
        }
        "agent.cli" => {
            let v = cli(
                "automator",
                p["provider"].as_str().unwrap_or("codex"),
                p["prompt"]
                    .as_str()
                    .ok_or_else(|| fail("prompt deve ser texto", 400))?,
                &p["cwd"],
                &p,
            )
            .await?;
            if v["ok"] != true {
                let err = v["err"].as_str().unwrap_or("").trim();
                let why = if v["timedOut"] == true { "passou do tempo limite".to_string() } else if err.is_empty() { format!("saiu com código {}", v["code"]) } else { err.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect() };
                return Err(fail(format!("o agente falhou: {why}"), 422));
            }
            json!(v["out"].as_str().unwrap_or("").trim_end())
        }
        "ai.openrouter" => {
            let model = p["model"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| fail("informe o modelo do OpenRouter", 400))?;
            let secret = p["secret"].as_str().unwrap_or("openrouter");
            if secret.is_empty()
                || !secret
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            {
                return Err(fail("nome de secret inválido", 400));
            }
            let body = json!({"model":model,"messages":[{"role":"user","content":p["prompt"]}],"max_tokens":p["max_tokens"].as_u64().unwrap_or(2048).clamp(1,32768)});
            let v=service("automator","plugin/fetch",json!({"url":"https://openrouter.ai/api/v1/chat/completions","method":"POST","headers":{"Authorization":format!("Bearer {{{{vault:{secret}}}}}"),"Content-Type":"application/json"},"bodyBase64":base64::engine::general_purpose::STANDARD.encode(body.to_string()),"timeout":120000})).await?;
            if v["ok"] != true {
                return Err(fail(
                    format!("OpenRouter {}: {}", v["status"], v["body"]),
                    502,
                ));
            }
            let body: Value = serde_json::from_str(v["body"].as_str().unwrap_or(""))?;
            body["choices"][0]["message"]["content"]
                .as_str()
                .map(|s| json!(s))
                .ok_or_else(|| fail("OpenRouter respondeu sem conteúdo", 502))?
        }
        "mcp.call" => mcp(&p).await?,
        "data.set" => p["value"].clone(),
        "data.datetime" => {
            let fmt = text_of(&p, "format");
            let fmt = if fmt.trim().is_empty() { "%d/%m/%Y %H:%M".to_string() } else { fmt };
            let items: Vec<_> = chrono::format::StrftimeItems::new(&fmt).collect();
            if items.iter().any(|i| matches!(i, chrono::format::Item::Error)) { return Err(fail(format!("formato de data inválido: {fmt}"), 400)); }
            let t = chrono::Local::now() + chrono::Duration::days(p["offset_days"].as_i64().unwrap_or(0).clamp(-36500, 36500));
            json!(t.format_with_items(items.iter()).to_string())
        }
        "text.replace" => {
            let (text, find, to) = (text_of(&p, "text"), text_of(&p, "find"), text_of(&p, "replace"));
            if find.is_empty() { return Err(fail("informe o que procurar", 400)); }
            if p["regex"] == "yes" {
                let re = regex::Regex::new(&find).map_err(|e| fail(format!("expressão regular inválida: {e}"), 400))?;
                json!(re.replace_all(&text, to.as_str()))
            } else { json!(text.replace(&find, &to)) }
        }
        "text.extract" => {
            let (text, pattern) = (text_of(&p, "text"), text_of(&p, "pattern"));
            if pattern.is_empty() { return Err(fail("informe a expressão regular", 400)); }
            let re = regex::Regex::new(&pattern).map_err(|e| fail(format!("expressão regular inválida: {e}"), 400))?;
            let pick = |c: &regex::Captures| c.get(1).or_else(|| c.get(0)).map(|m| m.as_str().to_string()).unwrap_or_default();
            if p["all"] == "all" { json!(re.captures_iter(&text).map(|c| pick(&c)).collect::<Vec<_>>()) } else { json!(re.captures(&text).map(|c| pick(&c)).unwrap_or_default()) }
        }
        "text.split" => {
            let (text, custom) = (text_of(&p, "text"), text_of(&p, "separator"));
            let sep = match p["by"].as_str().unwrap_or("line") { "comma" => ",", "semicolon" => ";", "custom" => custom.as_str(), _ => "\n" };
            if sep.is_empty() { return Err(fail("informe o separador", 400)); }
            json!(text.split(sep).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>())
        }
        "logic.stop" => {
            let m = text_of(&p, "message");
            return Err(fail(if m.trim().is_empty() { "fluxo parado".to_string() } else { m }, 422));
        }
        "file.read" => {
            let path = path_of(&p, "path")?;
            if !path.is_file() { return Err(fail(format!("arquivo não encontrado: {}", path.display()), 404)); }
            json!(read_text(&path, p["max_kb"].as_u64().unwrap_or(1024).clamp(1, 20480) * 1024))
        }
        "file.write" => {
            let (path, content) = (path_of(&p, "path")?, text_of(&p, "content"));
            if let Some(d) = path.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
            if p["mode"] == "append" {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
                f.write_all(content.as_bytes())?;
                if !content.ends_with('\n') { f.write_all(b"\r\n")?; }
            } else { std::fs::write(&path, content)?; }
            json!(path.to_string_lossy())
        }
        "file.list" => {
            let dir = path_of(&p, "path")?;
            if !dir.is_dir() { return Err(fail(format!("pasta não encontrada: {}", dir.display()), 404)); }
            let pattern = text_of(&p, "pattern");
            let mut v: Vec<String> = std::fs::read_dir(&dir)?.flatten().map(|e| e.path()).filter(|f| f.is_file())
                .filter(|f| wildcard(&pattern, &f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
                .map(|f| f.to_string_lossy().into_owned()).collect();
            v.sort_by_key(|a| a.to_lowercase());
            json!(v)
        }
        "file.exists" => {
            let yes = path_of(&p, "path")?.exists();
            return Ok(if yes { json!({"true":input}) } else { json!({"false":input}) });
        }
        "file.manage" => {
            let from = path_of(&p, "from")?;
            if !from.exists() { return Err(fail(format!("não encontrado: {}", from.display()), 404)); }
            if p["op"] == "trash" {
                let list = vec![from.clone()];
                tokio::task::spawn_blocking(move || crate::server::to_trash(&list)).await.map_err(|e| fail(e.to_string(), 500))?.map_err(|e| fail(format!("não deu para excluir: {e}"), 500))?;
                json!(from.to_string_lossy())
            } else {
                if from.is_dir() { return Err(fail("copiar e mover valem para arquivos; para uma pasta inteira, use Executar programa com robocopy", 400)); }
                let mut to = path_of(&p, "to").map_err(|_| fail("informe o destino", 400))?;
                if to.is_dir() && let Some(name) = from.file_name() { to = to.join(name); }
                if let Some(d) = to.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
                if p["op"] == "move" {
                    if std::fs::rename(&from, &to).is_err() { std::fs::copy(&from, &to)?; std::fs::remove_file(&from)?; }
                } else { std::fs::copy(&from, &to)?; }
                json!(to.to_string_lossy())
            }
        }
        "windows.open" => {
            let t = text_of(&p, "target");
            if t.trim().is_empty() { return Err(fail("informe o que abrir", 400)); }
            open_url(t.trim());
            input
        }
        "windows.powershell" => {
            let script = text_of(&p, "script");
            if script.trim().is_empty() { return Err(fail("o script está vazio", 400)); }
            // {{cred:nome}} e {{vault:nome}} no script viram ${env:BS_SECRET_n}: o valor não fica escrito no arquivo
            let (mut env, secrets) = secret_env(&script)?;
            let mut script = script;
            for (mark, var) in &secrets { script = script.replace(mark, &format!("${{env:{}}}", var.as_str().unwrap_or(""))); }
            env.insert("BS_INPUT".into(), json!(stringify(&input)));
            run_ps(&script, &p["cwd"], &p["timeout"], Value::Object(env)).await?
        }
        "windows.alarm" => alarm_node(&p, &input).await?,
        "text.case" => {
            let t = text_of(&p, "text");
            match p["mode"].as_str().unwrap_or("trim") {
                "upper" => json!(t.to_uppercase()),
                "lower" => json!(t.to_lowercase()),
                "title" => json!(t.split_inclusive(char::is_whitespace).map(|w| { let mut c = w.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default() }).collect::<String>()),
                "lines" => json!(t.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")),
                _ => json!(t.trim()),
            }
        }
        "text.join" => {
            let custom = text_of(&p, "separator");
            let sep = match p["by"].as_str().unwrap_or("line") { "comma" => ", ", "space" => " ", "custom" => custom.as_str(), _ => "\n" };
            // a lista pode chegar como lista de verdade ou como texto em JSON; um valor só vira uma lista de um
            let list = match &p["list"] { Value::String(s) => serde_json::from_str::<Value>(s).ok().filter(Value::is_array).unwrap_or_else(|| json!([s])), v => v.clone() };
            json!(list.as_array().map(|a| a.iter().map(stringify).collect::<Vec<_>>().join(sep)).unwrap_or_else(|| stringify(&list)))
        }
        "text.count" => {
            let t = text_of(&p, "text");
            json!({"chars": t.chars().count(), "words": t.split_whitespace().count(), "lines": t.lines().count()})
        }
        k if k.starts_with("image.") || k.starts_with("audio.") || k.starts_with("video.") || k == "media.info" => media_node(k, &p).await?,
        "windows.clipboard" => {
            let ps = |cmd: &str, text: String| service("automator", "plugin/exec", json!({"program":"powershell","args":["-NoProfile","-NonInteractive","-Command",cmd],"timeout":15000,"env":{"BS_TEXT":text}}));
            if p["op"] == "write" {
                exec_out(&ps("Set-Clipboard -Value $env:BS_TEXT", text_of(&p, "text")).await?)?;
                input
            } else { exec_out(&ps("Get-Clipboard -Raw", String::new()).await?)? }
        }
        "http.download" => {
            let path = path_of(&p, "path")?;
            let v = service("automator", "plugin/fetch", json!({"url":p["url"],"method":"GET","timeout":120000,"as":"base64"})).await?;
            if v["ok"] != true { return Err(fail(format!("o servidor respondeu {}", v["status"]), 422)); }
            let bytes = match v["bodyBase64"].as_str() {
                Some(b) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| fail("resposta ilegível", 502))?,
                None => v["body"].as_str().unwrap_or("").as_bytes().to_vec(),
            };
            if let Some(d) = path.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
            std::fs::write(&path, bytes)?;
            json!(path.to_string_lossy())
        }
        k if k.starts_with("plugin.") => return run_plugin_node(k, p, input).await,
        _ => return Err(fail("nó não suportado", 400)),
    };
    Ok(json!({"out":out}))
}
/// O que fica no histórico: saídas grandes (uma página inteira, um log) entram cortadas, para o arquivo de
/// automações não crescer sem limite. O próximo nó recebe o valor inteiro.
fn brief(v: &Value) -> Value {
    const MAX: usize = 16_000;
    let cut = |v: &Value| {
        let s = stringify(v);
        if s.len() <= MAX { return v.clone(); }
        let mut end = MAX;
        while !s.is_char_boundary(end) { end -= 1; }
        json!(format!("{}\n… (cortado no histórico: {} caracteres ao todo)", &s[..end], s.chars().count()))
    };
    match v {
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), cut(v))).collect()),
        _ => cut(v),
    }
}
/// Histórico de uma chamada de endpoint: tokens, cookies e assinaturas não ficam gravados.
fn redact(v: &Value) -> Value {
    const HIDE: [&str; 9] = ["token", "authorization", "x-api-key", "cookie", "cookies", "set-cookie", "x-hub-signature", "x-hub-signature-256", "proxy-authorization"];
    match v {
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), if HIDE.contains(&k.to_lowercase().as_str()) && !v.is_null() && v != "" { json!("••••••") } else { redact(v) })).collect()),
        Value::Array(a) => Value::Array(a.iter().map(redact).collect()),
        // a entrada costuma seguir adiante como texto em JSON cortado: o token some dali também
        Value::String(s) if s.contains("\"token\"") || s.to_lowercase().contains("\"authorization\"") => json!("(chamada de endpoint: conteúdo omitido do histórico)"),
        o => o.clone(),
    }
}
fn update_run(run_id: &str, f: impl FnOnce(&mut Value)) -> ApiResult<()> {
    edit(|s| {
        if let Some(r) = s.runs.iter_mut().find(|r| r["id"] == run_id) {
            f(r);
        }
        Ok(())
    })
}
/// Nós que têm um trecho do fluxo dentro deles: o que sai da porta indicada roda várias vezes (laços) ou sob
/// proteção (Tentar). As outras portas do nó seguem depois que o trecho termina.
fn body_port(kind: &str) -> Option<&'static str> {
    match kind { "logic.each" => Some("item"), "logic.while" | "logic.repeat" => Some("loop"), "logic.try" => Some("try"), _ => None }
}
/// Os nós alcançados a partir de um nó (por uma porta, ou por todas), por qualquer caminho.
fn reach(f: &Flow, from: &str, port: Option<&str>) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut stack: Vec<&str> = f.edges.iter().filter(|e| e.from == from && port.is_none_or(|p| e.from_port == p)).map(|e| e.to.as_str()).collect();
    while let Some(x) = stack.pop() { if seen.insert(x.to_string()) { stack.extend(f.edges.iter().filter(|e| e.from == x).map(|e| e.to.as_str())); } }
    seen
}
fn node_title(n: &Node) -> String {
    n.title.clone().filter(|t| !t.trim().is_empty()).or_else(|| spec(&n.kind).and_then(|s| s["name"].as_str().map(String::from))).unwrap_or_else(|| n.kind.clone())
}
/// Laços e Tentar: o trecho de dentro não pode se misturar com o que vem depois nem receber conexão de fora (o de
/// dentro roda várias vezes, o de fora uma só); Sair do laço e Próximo item só existem dentro de um laço.
fn check_bodies(f: &Flow) -> ApiResult<()> {
    let title = |id: &str| f.nodes.iter().find(|n| n.id == id).map(node_title).unwrap_or_default();
    let loops: Vec<HashSet<String>> = f.nodes.iter().filter(|n| !n.disabled && matches!(n.kind.as_str(), "logic.each" | "logic.while" | "logic.repeat")).map(|n| reach(f, &n.id, body_port(&n.kind))).collect();
    for n in f.nodes.iter().filter(|n| !n.disabled) {
        if matches!(n.kind.as_str(), "logic.break" | "logic.next") && !loops.iter().any(|b| b.contains(&n.id)) {
            return Err(fail(format!("\"{}\" só funciona dentro de um laço: ligue-o depois da saída de repetição de Para cada item, Repetir ou Repetir enquanto", node_title(n)), 400));
        }
        let Some(port) = body_port(&n.kind) else { continue };
        let body = reach(f, &n.id, Some(port));
        let inside = match port { "item" => "cada item", "loop" => "repetir", _ => "tentar" };
        for e in f.edges.iter().filter(|e| e.from == n.id && e.from_port != port) {
            let mut after = reach(f, &e.to, None);
            after.insert(e.to.clone());
            if let Some(x) = after.iter().find(|x| body.contains(*x)) {
                return Err(fail(format!("\"{}\": o nó \"{}\" está ligado ao trecho de dentro (saída {inside}) e também ao que vem depois dele. Separe os dois caminhos.", node_title(n), title(x)), 400));
            }
        }
        if let Some(e) = f.edges.iter().find(|e| body.contains(&e.to) && e.from != n.id && !body.contains(&e.from)) {
            return Err(fail(format!("\"{}\": o nó \"{}\" roda dentro dele (saída {inside}) e recebe uma conexão de fora. Dentro do trecho, leia um nó de fora com {{{{nodes.ID.out}}}} em vez de ligar.", node_title(n), title(&e.to)), 400));
        }
    }
    Ok(())
}
/// Como um trecho do fluxo terminou: seguiu, pediu para sair do laço, pediu o próximo item, falhou ou foi cancelado.
enum Step { Go, Break, Next, Fail(String), Cancel }
enum Halt { Err(ApiError), Step(Step) }
impl From<ApiError> for Halt { fn from(e: ApiError) -> Self { Halt::Err(e) } }
tokio::task_local! { /// a execução (do histórico) em que o nó está rodando: o navegador do fluxo é guardado por ela
    pub(crate) static RUN_ID: String; }
/// Até quantas voltas de um laço o histórico guarda nó por nó (as seguintes só aparecem se falharem).
const LOUD_ROUNDS: usize = 20;
struct Run<'a> {
    f: &'a Flow, via: &'a str, payload: &'a Value, rid: &'a str, cancel: &'a Arc<AtomicBool>, stack: Vec<String>,
    order: Vec<usize>, trigger: String,
    /// a saída de cada nó que já rodou (id -> { porta: valor }); "$vars" guarda as variáveis do nó Variável
    outputs: HashMap<String, Value>,
    /// o resultado do fluxo, para quem o chamou: o que chegou no nó Resultado, ou a saída do último nó
    shown: Option<Value>, last_out: Value,
    /// dentro de um laço, depois das primeiras voltas: o histórico não anota mais nó por nó
    quiet: bool, round: Option<usize>,
}
impl<'a> Run<'a> {
    fn stopped(&self) -> bool { self.cancel.load(Ordering::Relaxed) || !enabled("automator") }
    /// Anota um nó no histórico da execução; devolve a posição da anotação, para completar depois.
    fn push(&self, mut v: Value) -> Option<usize> {
        if self.quiet { return None; }
        if let Some(k) = self.round { v["round"] = json!(k); }
        let mut at = None;
        let _ = update_run(self.rid, |r| { if let Some(a) = r["nodes"].as_array_mut() && a.len() < 3000 { a.push(v); at = Some(a.len() - 1); } });
        at
    }
    fn patch(&self, at: Option<usize>, patch: Value) {
        let Some(at) = at else { return };
        let _ = update_run(self.rid, |r| { if let Some(node) = r["nodes"].get_mut(at).and_then(Value::as_object_mut) && let Some(p) = patch.as_object() { node.extend(p.clone()); } });
    }
    /// A falha sempre fica no histórico, mesmo nas voltas que não são anotadas.
    fn failed(&self, at: Option<usize>, n: &Node, ms: u64, error: &str, code: u16) {
        if at.is_some() { return self.patch(at, json!({"status":"failed","ms":ms,"error":error,"code":code})); }
        let mut v = json!({"id":n.id,"status":"failed","ms":ms,"error":error,"code":code});
        if let Some(k) = self.round { v["round"] = json!(k); }
        let _ = update_run(self.rid, |r| { if let Some(a) = r["nodes"].as_array_mut() && a.len() < 3200 { a.push(v); } });
    }
    fn clear(&mut self, body: &[usize]) { for j in body { self.outputs.remove(&self.f.nodes[*j].id); } }
    /// Espera que dá para cancelar. `false`: a execução foi cancelada no meio.
    async fn nap(&self, secs: f64) -> bool {
        let end = std::time::Instant::now() + Duration::from_secs_f64(secs.clamp(0.0, 3600.0));
        while std::time::Instant::now() < end { if self.stopped() { return false; } tokio::time::sleep(Duration::from_millis(100)).await; }
        !self.stopped()
    }
    /// Roda os nós de `list` na ordem. Os nós de dentro de um laço (ou de um Tentar) rodam pelo nó que os contém.
    fn steps<'b>(&'b mut self, list: Vec<usize>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Step> + Send + 'b>> {
        Box::pin(async move {
            let f = self.f;
            let mut inner: HashSet<usize> = HashSet::new();
            for i in list {
                if inner.contains(&i) { continue; }
                if self.stopped() { return Step::Cancel; }
                let n = &f.nodes[i];
                let incoming: Vec<Value> = f.edges.iter().filter(|e| e.to == n.id)
                    .filter_map(|e| self.outputs.get(&e.from).and_then(|o| o.get(&e.from_port)).cloned())
                    .collect();
                let is_trigger = n.kind.starts_with("trigger.");
                if n.disabled || (is_trigger && n.kind != self.trigger) || (!is_trigger && incoming.is_empty()) {
                    if self.round.is_none() { self.push(json!({"id":n.id,"status":"skipped"})); }
                    continue;
                }
                let input = if incoming.len() == 1 { incoming[0].clone() } else { json!(incoming) };
                let at = self.push(json!({"id":n.id,"status":"running","started_at":now()}));
                let began = std::time::Instant::now();
                let done = if let Some(port) = body_port(&n.kind) {
                    let set = reach(f, &n.id, Some(port));
                    let body: Vec<usize> = self.order.iter().copied().filter(|j| set.contains(&f.nodes[*j].id)).collect();
                    inner.extend(body.iter().copied());
                    self.container(n, body, input, at).await
                } else {
                    self.single(n, input, is_trigger).await
                };
                let ms = began.elapsed().as_millis() as u64;
                match done {
                    Ok(v) => {
                        let shown = if self.via == "trigger.webhook" { redact(&brief(&v)) } else { brief(&v) };
                        let first = v.as_object().and_then(|o| o.values().next()).cloned().unwrap_or(Value::Null);
                        if n.kind == "util.output" { self.shown = Some(first.clone()); }
                        self.last_out = first;
                        self.outputs.insert(n.id.clone(), v);
                        self.patch(at, json!({"status":"completed","ms":ms,"output":shown}));
                    }
                    Err(Halt::Step(Step::Cancel)) => { self.patch(at, json!({"status":"cancelled","ms":ms})); return Step::Cancel; }
                    Err(Halt::Err(_)) if self.cancel.load(Ordering::Relaxed) => { self.patch(at, json!({"status":"cancelled","ms":ms})); return Step::Cancel; }
                    Err(Halt::Err(e)) => { self.failed(at, n, ms, &e.to_string(), e.status); return Step::Fail(format!("{}: {e}", node_title(n))); }
                    // a falha veio de um nó de dentro do trecho: a mensagem já diz qual
                    Err(Halt::Step(Step::Fail(msg))) => { self.failed(at, n, ms, &msg, 422); return Step::Fail(msg); }
                    Err(Halt::Step(s)) => { self.patch(at, json!({"status":"completed","ms":ms})); return s; }
                }
            }
            Step::Go
        })
    }
    /// Um nó comum.
    async fn single(&mut self, n: &'a Node, input: Value, is_trigger: bool) -> Result<Value, Halt> {
        let p = fill(&n.params, &input, &self.outputs)?;
        if is_trigger && !self.payload.is_null() { return Ok(json!({"out": self.payload.clone()})); }
        match n.kind.as_str() {
            "logic.break" => return Err(Halt::Step(Step::Break)),
            "logic.next" => return Err(Halt::Step(Step::Next)),
            "logic.var" => return Ok(self.var(&p)?),
            "flow.call" => return Ok(call_flow(&self.f.name, &p, self.cancel, &self.stack).await?),
            _ => {}
        }
        let cancel = self.cancel;
        let stop = async { while !cancel.load(Ordering::Relaxed) && enabled("automator") { tokio::time::sleep(Duration::from_millis(200)).await; } };
        tokio::select! { r = RUN_ID.scope(self.rid.to_string(), run_node(&self.f.name, n, p, input)) => Ok(r?), _ = stop => Err(Halt::Step(Step::Cancel)) }
    }
    /// O nó Variável: um valor com nome que vale até o fim da execução ({{vars.nome}} em qualquer campo).
    fn var(&mut self, p: &Value) -> ApiResult<Value> {
        let name = text_of(p, "name");
        let name = name.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') { return Err(fail("dê um nome à variável: letras, números, _ ou -", 400)); }
        let vars = self.outputs.entry("$vars".into()).or_insert_with(|| json!({}));
        let cur = vars.get(name).cloned().unwrap_or(Value::Null);
        let val = &p["value"];
        let blank = val.is_null() || val.as_str().is_some_and(|t| t.trim().is_empty());
        let new = match p["op"].as_str().unwrap_or("set") {
            "set" => val.clone(),
            "add" => {
                let step = if blank { 1.0 } else { number_of(val).ok_or_else(|| fail(format!("para somar, o valor tem que ser um número (chegou \"{}\")", stringify(val)), 400))? };
                let sum = number_of(&cur).unwrap_or(0.0) + step;
                if sum.fract() == 0.0 && sum.abs() < 9e15 { json!(sum as i64) } else { json!(sum) }
            }
            "append" => { let mut l = match cur { Value::Array(a) => a, Value::Null => vec![], o => vec![o] }; if !blank { l.push(val.clone()); } json!(l) }
            "get" => cur,
            "clear" => Value::Null,
            o => return Err(fail(format!("ação desconhecida: {o}"), 400)),
        };
        vars[name] = new.clone();
        Ok(json!({"out": new}))
    }
    /// Roda o trecho de dentro uma vez. Devolve como terminou e o que o último nó dele entregou.
    async fn round(&mut self, body: &[usize], k: usize, loud: bool) -> (Step, Value) {
        let (quiet, round, last) = (self.quiet, self.round, std::mem::take(&mut self.last_out));
        self.quiet = quiet || !loud;
        self.round = Some(k);
        let step = self.steps(body.to_vec()).await;
        let out = std::mem::replace(&mut self.last_out, last);
        self.quiet = quiet;
        self.round = round;
        (step, out)
    }
    /// Laços (Para cada item, Repetir, Repetir enquanto) e Tentar: rodam o trecho de dentro e entregam o que ficou.
    async fn container(&mut self, n: &'a Node, body: Vec<usize>, input: Value, at: Option<usize>) -> Result<Value, Halt> {
        let num = |v: &Value, d: f64| number_of(v).unwrap_or(d);
        match n.kind.as_str() {
            "logic.each" | "logic.repeat" => {
                let p = fill(&n.params, &input, &self.outputs)?;
                let each = n.kind == "logic.each";
                let items: Vec<Value> = if each { list_of(&p["list"]) } else {
                    let times = num(&p["times"], -1.0);
                    if !(0.0..=10000.0).contains(&times) { return Err(fail("diga quantas vezes repetir: de 0 a 10000", 400).into()); }
                    (0..times as usize).map(|_| input.clone()).collect()
                };
                let max = num(&p["max"], 1000.0).clamp(1.0, 100_000.0) as usize;
                if each && items.len() > max { return Err(fail(format!("a lista tem {} itens e o limite deste nó é {max}: aumente o limite, ou corte a lista antes", items.len()), 400).into()); }
                let (keep_going, wait, total) = (p["on_error"] == "continue", num(&p["wait_s"], 0.0), items.len());
                let (mut results, mut errors, mut seen) = (vec![], vec![], std::time::Instant::now());
                for (k, item) in items.into_iter().enumerate() {
                    if self.stopped() { return Err(Halt::Step(Step::Cancel)); }
                    if k > 0 && wait > 0.0 && !self.nap(wait).await { return Err(Halt::Step(Step::Cancel)); }
                    self.clear(&body);
                    let port = if each { "item" } else { "loop" };
                    self.outputs.insert(n.id.clone(), json!({(port): item, "index": k + 1, "total": total}));
                    if k == 0 || seen.elapsed() > Duration::from_secs(1) { seen = std::time::Instant::now(); self.patch(at, json!({"rounds": format!("{} de {total}", k + 1)})); }
                    match self.round(&body, k + 1, k < LOUD_ROUNDS).await {
                        (Step::Go, out) => results.push(out),
                        (Step::Next, _) => {}
                        (Step::Break, _) => break,
                        (Step::Cancel, _) => return Err(Halt::Step(Step::Cancel)),
                        (Step::Fail(msg), _) if keep_going => errors.push(json!({"index": k + 1, "item": item, "error": msg})),
                        (Step::Fail(msg), _) => return Err(Halt::Step(Step::Fail(format!("{} (na volta {} de {total})", msg, k + 1)))),
                    }
                }
                self.patch(at, json!({"rounds": format!("{total} de {total}")}));
                Ok(json!({"done": results, "total": total, "errors": errors}))
            }
            "logic.while" => {
                let max = num(&n.params["max"], 100.0).clamp(1.0, 10000.0) as usize;
                let (mut cur, mut k) = (input, 0usize);
                loop {
                    if self.stopped() { return Err(Halt::Step(Step::Cancel)); }
                    // a condição é lida de novo a cada volta: {{input}} é o que a volta anterior entregou
                    let p = fill(&n.params, &cur, &self.outputs)?;
                    if !condition(&p)? { break; }
                    if k >= max { return Err(fail(format!("passou de {max} voltas e a condição continua valendo. Se for isso mesmo, aumente o limite do nó."), 400).into()); }
                    if k > 0 && num(&p["wait_s"], 0.0) > 0.0 && !self.nap(num(&p["wait_s"], 0.0)).await { return Err(Halt::Step(Step::Cancel)); }
                    k += 1;
                    self.clear(&body);
                    self.outputs.insert(n.id.clone(), json!({"loop": cur, "index": k}));
                    self.patch(at, json!({"rounds": format!("volta {k}")}));
                    match self.round(&body, k, k <= LOUD_ROUNDS).await {
                        (Step::Go, out) => cur = out,
                        (Step::Next, _) => {}
                        (Step::Break, _) => break,
                        (Step::Cancel, _) => return Err(Halt::Step(Step::Cancel)),
                        (Step::Fail(msg), _) => return Err(Halt::Step(Step::Fail(format!("{msg} (na volta {k})")))),
                    }
                }
                Ok(json!({"done": cur, "rounds": k}))
            }
            _ => {
                let p = fill(&n.params, &input, &self.outputs)?;
                let attempts = num(&p["attempts"], 1.0).clamp(1.0, 20.0) as usize;
                let caught = self.f.edges.iter().any(|e| e.from == n.id && e.from_port == "error");
                let mut last = String::new();
                for a in 1..=attempts {
                    if a > 1 && !self.nap(num(&p["wait_s"], 0.0)).await { return Err(Halt::Step(Step::Cancel)); }
                    self.clear(&body);
                    self.outputs.insert(n.id.clone(), json!({"try": input, "attempt": a}));
                    if attempts > 1 { self.patch(at, json!({"rounds": format!("tentativa {a} de {attempts}")})); }
                    let (quiet, round) = (self.quiet, self.round);
                    let step = self.round(&body, round.unwrap_or(a), !quiet).await;
                    match step {
                        (Step::Go, out) => return Ok(json!({"ok": if body.is_empty() { input } else { out }, "attempts": a})),
                        (Step::Fail(msg), _) => last = msg,
                        (s, _) => return Err(Halt::Step(s)),
                    }
                }
                // ninguém ligado em "deu erro": a falha continua sendo falha do fluxo (o nó só serviu para tentar de novo)
                if !caught { return Err(Halt::Step(Step::Fail(if attempts > 1 { format!("{last} (depois de {attempts} tentativas)") } else { last }))); }
                Ok(json!({"error": {"error": last, "attempts": attempts, "input": input}}))
            }
        }
    }
}
/// Percorre os nós do fluxo na ordem, anotando cada um na execução `rid` do histórico. Devolve como terminou
/// ("completed", "failed", "cancelled"), o erro e o resultado (o que chegou no nó Resultado, ou a saída do último nó).
/// `stack`: os fluxos que estão rodando um dentro do outro até aqui (nó Chamar fluxo), para barrar laços.
fn run_steps<'a>(f: &'a Flow, order: Vec<usize>, via: &'a str, payload: &'a Value, rid: &'a str, cancel: &'a Arc<AtomicBool>, stack: Vec<String>)
    -> std::pin::Pin<Box<dyn std::future::Future<Output = (&'static str, Option<String>, Value)> + Send + 'a>> {
    Box::pin(async move {
        // disparo da agenda segue pela Agenda; o manual, pelo gatilho manual (ou pela Agenda, se for o único gatilho)
        // (sem gatilho manual, o botão Executar segue pelo primeiro gatilho que houver)
        let trigger = if !via.is_empty() { via.to_string() }
            else if f.nodes.iter().any(|n| n.kind == "trigger.manual" && !n.disabled) { "trigger.manual".to_string() }
            else { f.nodes.iter().find(|n| n.kind.starts_with("trigger.") && !n.disabled).map(|n| n.kind.clone()).unwrap_or_default() };
        let mut run = Run { f, via, payload, rid, cancel, stack, order: order.clone(), trigger, outputs: HashMap::new(), shown: None, last_out: Value::Null, quiet: false, round: None };
        let step = run.steps(order).await;
        // o navegador que os nós Navegador abriram nesta execução fecha (ou fica, se o nó pediu) quando ela termina
        browser::finish(rid).await;
        let (status, error) = match step {
            Step::Go => ("completed", None),
            Step::Cancel => ("cancelled", None),
            Step::Fail(msg) => ("failed", Some(msg)),
            Step::Break | Step::Next => ("failed", Some("Sair do laço e Próximo item só funcionam dentro de um laço".to_string())),
        };
        (status, error, run.shown.unwrap_or(run.last_out))
    })
}
/// O nó Chamar fluxo: roda outro fluxo salvo, do começo ao fim, dentro desta execução, e devolve o resultado dele.
/// A execução do fluxo chamado ganha uma entrada própria no histórico (via "flow.call").
async fn call_flow(caller: &str, p: &Value, cancel: &Arc<AtomicBool>, stack: &[String]) -> ApiResult<Value> {
    let want = p["flow"].as_str().unwrap_or("").trim().to_string();
    if want.is_empty() { return Err(fail("escolha o fluxo que este nó chama", 400)); }
    let child = { let _g = STORE.lock(); load()?.flows.into_iter().find(|f| f.id == want || f.name == want) }
        .ok_or_else(|| fail("o fluxo chamado não existe mais: escolha outro no nó", 404))?;
    if stack.contains(&child.id) { return Err(fail(format!("o fluxo \"{}\" acabaria chamando a si mesmo, sem fim", child.name), 400)); }
    if stack.len() >= 8 { return Err(fail("fluxos chamando fluxos em mais de oito níveis", 400)); }
    let order = validate(&child)?;
    if !child.nodes.iter().any(|n| n.kind.starts_with("trigger.") && !n.disabled) { return Err(fail(format!("o fluxo \"{}\" não tem gatilho", child.name), 400)); }
    // o que este nó entrega chega no lugar do que o gatilho de lá entregaria; vazio: o gatilho decide
    let payload = match &p["input"] { Value::String(t) if t.trim().is_empty() => Value::Null, v => v.clone() };
    let rid = id();
    edit(|s| { s.runs.insert(0, json!({"id":rid,"flow_id":child.id,"name":child.name,"started_at":now(),"status":"running","nodes":[],"scheduled":false,"via":"flow.call","called_by":caller})); Ok(()) })?;
    let mut inner = stack.to_vec();
    inner.push(child.id.clone());
    let (status, error, result) = run_steps(&child, order, "", &payload, &rid, cancel, inner).await;
    let _ = update_run(&rid, |r| { r["status"] = json!(status); r["error"] = json!(error); r["finished_at"] = json!(now()); });
    match status {
        "completed" => Ok(json!({"out": result})),
        "cancelled" => Err(fail("cancelado", 409)),
        _ => Err(fail(format!("o fluxo \"{}\" falhou em {}", child.name, error.unwrap_or_default()), 422)),
    }
}
/// Tudo o que dá para saber de uma chamada ao Endpoint HTTP, em campos, para o fluxo decidir o que fazer com ela.
fn hook_payload(r: &Req, endpoint: &str, raw: &str) -> Value {
    let head = |k: &str| r.headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ip = { let i = head("x-bluescreen-ip"); if i.is_empty() { "127.0.0.1".to_string() } else { i } };
    let url = head("x-bluescreen-url");
    let headers: serde_json::Map<String, Value> = r.headers.iter().filter(|(k, _)| !k.as_str().starts_with("x-bluescreen-")).filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_lowercase(), json!(v)))).collect();
    let query: serde_json::Map<String, Value> = r.query.iter().filter(|(k, _)| k.as_str() != "e" && k.as_str() != "plugin").map(|(k, v)| (k.clone(), json!(v))).collect();
    let pairs = |text: &str, sep: char| -> serde_json::Map<String, Value> {
        text.split(sep).filter_map(|kv| { let (k, v) = kv.trim().split_once('=').unwrap_or((kv.trim(), "")); (!k.is_empty()).then(|| (urlencoding::decode(&k.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_else(|_| k.to_string()), json!(urlencoding::decode(&v.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string())))) }).collect()
    };
    let auth = head("authorization");
    let token = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")).map(String::from)
        .or_else(|| headers.get("x-api-key").and_then(|v| v.as_str()).map(String::from)).or_else(|| r.q("token").map(String::from)).unwrap_or_default();
    // Authorization: Basic -> o usuário (a senha fica só no cabeçalho, para quem quiser conferir)
    let (scheme, rest) = auth.split_once(' ').unwrap_or((auth.as_str(), ""));
    let basic_user = if scheme.eq_ignore_ascii_case("basic") { base64::engine::general_purpose::STANDARD.decode(rest.trim()).ok().and_then(|b| String::from_utf8(b).ok()).map(|t| t.split(':').next().unwrap_or("").to_string()).unwrap_or_default() } else { String::new() };
    let ctype = head("content-type");
    let kind = ctype.split(';').next().unwrap_or("").trim().to_lowercase();
    let body = serde_json::from_str::<Value>(raw).unwrap_or_else(|_| if raw.is_empty() { Value::Null } else { json!(raw) });
    let form = if kind == "application/x-www-form-urlencoded" { Value::Object(pairs(raw, '&')) } else { Value::Null };
    let now = chrono::Local::now();
    let (path, query_string) = url.split_once('?').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((url.clone(), String::new()));
    json!({
        "endpoint": endpoint, "method": r.method.as_str(), "url": url, "path": path, "query_string": query_string, "query": query,
        "headers": headers, "cookies": pairs(&head("cookie"), ';'), "body": body, "form": form, "raw": raw,
        "content_type": kind, "content_length": r.body.len(), "is_json": body.is_object() || body.is_array(),
        "token": token.trim(), "auth": {"scheme": scheme, "user": basic_user},
        "ip": ip, "remote": r.remote, "host": head("host"), "user_agent": head("user-agent"), "referer": head("referer"), "origin": head("origin"), "language": head("accept-language"),
        "time": now.to_rfc3339_opts(chrono::SecondsFormat::Secs, false), "timestamp": now.timestamp_millis(),
    })
}
/// Um fluxo ligado tem um Endpoint HTTP que aceita a rede local, e o acesso pela rede do BlueScreen está desligado:
/// liga (é por ele que a chamada chega). Só quando esse pedido aparece: quem desligar a rede depois, à mão, fica
/// com ela desligada.
async fn ensure_lan() {
    static WANTED: AtomicBool = AtomicBool::new(false);
    let want = enabled("automator") && with_store(|s, _| s.flows.iter().any(|f| f.active && f.nodes.iter().any(|n| n.kind == "trigger.webhook" && !n.disabled && n.params["who"] == "lan"))).unwrap_or(false);
    if want && !WANTED.swap(want, Ordering::Relaxed) && !crate::server::lan_enabled() {
        match crate::server::lan_enable().await { Ok(_) => log("Automator: acesso pela rede local ligado para um Endpoint HTTP que aceita a rede."), Err(e) => log(format!("Automator: não deu para ligar o acesso pela rede local: {e}")) }
    }
    if !want { WANTED.store(false, Ordering::Relaxed); }
}
/// `via`: o tipo do gatilho que disparou sozinho; vazio quando alguém mandou executar. `payload`: o que esse gatilho
/// entrega ao primeiro nó (nulo: o próprio nó de gatilho decide).
fn start(f: Flow, via: &str, payload: Value) -> ApiResult<Value> {
    require_enabled("automator")?;
    let (scheduled, via) = (!via.is_empty(), via.to_string());
    let order = validate(&f)?;
    if !f.nodes.iter().any(|n| n.kind.starts_with("trigger.") && !n.disabled) {
        return Err(fail("o fluxo não tem gatilho: adicione Iniciar manualmente ou outro nó de Gatilhos", 400));
    }
    let permit = SLOTS
        .try_acquire()
        .map_err(|_| fail("já há quatro fluxos executando", 409))?;
    let run_id = id();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut g = RUNNING.lock();
        if g.contains_key(&f.id) {
            return Err(fail("este fluxo já está executando", 409));
        }
        g.insert(f.id.clone(), cancel.clone());
    }
    let record = json!({"id":run_id,"flow_id":f.id,"name":f.name,"started_at":now(),"status":"running","nodes":[],"scheduled":scheduled,"via":via});
    if let Err(e) = edit(|s| {
        s.runs.insert(0, record.clone());
        trim_runs(s);
        Ok(())
    }) {
        RUNNING.lock().remove(&f.id);
        return Err(e);
    }
    let rid = run_id.clone();
    tokio::spawn(async move {
        let _permit = permit;
        let (status, error, _) = run_steps(&f, order, &via, &payload, &rid, &cancel, vec![f.id.clone()]).await;
        let _ = update_run(&rid, |r| {
            r["status"] = json!(status);
            r["error"] = json!(error);
            r["finished_at"] = json!(now());
        });
        RUNNING.lock().remove(&f.id);
    });
    Ok(record)
}

/// Monta um fluxo novo ou, com `flow`, altera o que está aberto: { request, provider, model, effort, cwd, flow, job }.
async fn generate_flow(b: Value) -> ApiResult<Value> {
        let asked=b["request"].as_str().filter(|s|!s.trim().is_empty()).ok_or_else(||fail("descreva a automação",400))?;
        // senha ou token escrito no pedido sai dele aqui: a IA recebe {{cred:nome}} no lugar
        let (request, mut secrets) = take_secrets(asked);
        // com `flow`, o pedido é para alterar o fluxo que está aberto
        let current = b.get("flow").filter(|f| f["nodes"].as_array().is_some_and(|a| !a.is_empty())).map(|f| json!({"id": f["id"].as_str().unwrap_or(""), "name": f["name"], "description": f["description"], "nodes": f["nodes"], "edges": f["edges"]}));
        let prompt = gen_prompt(&request, current.as_ref());
        ai_stage(&b, 0, if current.is_some() { "A IA está alterando o fluxo" } else { "A IA está montando o fluxo" });
        let mut answer = ai_ask(&b, prompt.clone()).await?;
        ai_stage(&b, 1, "Conferindo nós, ligações e expressões");
        let mut parsed = gen_flow(&answer);
        // o que a conferência achar volta para a IA, com o fluxo que ela mandou: até duas rodadas
        let mut rounds = 0;
        for _ in 0..2 {
            let problems = match &parsed { Ok((f, _)) => flow_issues(f), Err(e) => vec![e.msg.clone()] };
            if problems.is_empty() { break; }
            ai_stage(&b, 2, format!("A IA está corrigindo {} (rodada {} de 2)", if problems.len() == 1 { "um ponto".to_string() } else { format!("{} pontos", problems.len()) }, rounds + 1));
            let fix = format!("{prompt}\n\n# Sua resposta anterior\n{}\n\n# Problemas encontrados nela\n- {}\n\nCorrija todos e retorne o fluxo inteiro de novo, SOMENTE o JSON.", answer.chars().take(20000).collect::<String>(), problems.join("\n- "));
            let Ok(second) = ai_ask(&b, fix).await else { break };
            let again = gen_flow(&second);
            if again.is_err() && parsed.is_ok() { break; }
            parsed = again; answer = second; rounds += 1;
        }
        let (mut flow, raw) = parsed?;
        ai_stage(&b, 3, "Guardando as credenciais e fechando o resultado");
        if let Some(cur) = &current && flow.name.trim().is_empty() { flow.name = cur["name"].as_str().unwrap_or("").to_string(); }
        let mut params = Value::Array(flow.nodes.iter().map(|n| n.params.clone()).collect());
        ai_secrets(&raw["secrets"], &mut params, &mut secrets);
        for (n, p) in flow.nodes.iter_mut().zip(params.as_array().cloned().unwrap_or_default()) { n.params = p; }
        let (report, missing) = keep_secrets(&secrets, &serde_json::to_string(&flow.nodes)?, &format!("Do fluxo \"{}\"", flow.name));
        let warnings = flow_issues(&flow);
        let values: Vec<String> = secrets.iter().map(|s| s.value.clone()).collect();
        let notes: Vec<String> = raw["notes"].as_array().into_iter().flatten().filter_map(|n| n.as_str()).map(|n| crate::plugins::vault::scrub(n.trim(), &values).chars().take(300).collect::<String>()).filter(|n| !n.is_empty()).take(8).collect();
        let mut out = serde_json::to_value(&flow)?;
        out["warnings"] = json!(warnings);
        out["notes"] = json!(notes);
        out["secrets"] = json!(report);
        out["missing_creds"] = json!(missing);
        out["rounds"] = json!(rounds);
        Ok(out)
}
/// A IA escreve ou altera o script de um nó (campo com `code`): { type, field, script, request, input, error, provider, model, effort, job }.
async fn script_ai(b: Value) -> ApiResult<Value> {
        let asked = b["request"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| fail("diga o que o script deve fazer ou o que mudar", 400))?;
        let s = spec(b["type"].as_str().unwrap_or("")).ok_or_else(|| fail("nó desconhecido", 400))?;
        let field = s["fields"].as_array().into_iter().flatten().find(|f| f["name"] == b["field"] && f["code"].is_string()).cloned().ok_or_else(|| fail("este campo não é um script", 400))?;
        let lang = field["code"].as_str().unwrap_or("");
        let script = b["script"].as_str().unwrap_or("");
        if script.len() > 60_000 { return Err(fail("script grande demais para editar com IA (até 60 mil caracteres)", 400)); }
        let (request, mut secrets) = take_secrets(asked);
        let cut = |v: &Value, n: usize| { let t = stringify(v); if t.chars().count() > n { format!("{}…", t.chars().take(n).collect::<String>()) } else { t } };
        let creds = crate::creds::names();
        let mut prompt = format!("Você escreve o script ({lang}) de um nó \"{}\" numa automação do BlueScreen, no Windows. {}\n\n# Regras\n{}\n- Mantenha o que o pedido não mandou mudar. Não execute nada nem altere arquivos agora: só escreva o script.\n- Se o pedido trouxer uma senha ou token escrito, não o copie: use {{{{cred:nome}}}} e, na última linha da resposta, escreva SEGREDOS: seguido de um JSON [{{\"name\":\"nome\",\"value\":\"o valor\"}}].\n- Responda com o script INTEIRO dentro de um único bloco ``` e, depois do bloco, uma linha começando com RESUMO: dizendo em uma ou duas frases o que o script faz ou o que mudou.\n\n# Credenciais que já existem\n{}\n",
            s["name"].as_str().unwrap_or(""), field["help"].as_str().unwrap_or(""), if lang == "powershell" { SCRIPT_PS } else { "- Siga o que a ajuda do campo diz sobre a entrada e a saída." },
            if creds.is_empty() { "nenhuma ainda".to_string() } else { creds.join(", ") });
        if script.trim().is_empty() { prompt.push_str("\n# Script atual\n(vazio: escreva do zero)\n"); } else { prompt.push_str(&format!("\n# Script atual\n```\n{script}\n```\n")); }
        if !b["input"].is_null() { prompt.push_str(&format!("\n# Exemplo do que chega no nó\n{}\n", cut(&b["input"], 3000))); }
        if b["error"].as_str().is_some_and(|e| !e.trim().is_empty()) { prompt.push_str(&format!("\n# Erro da última execução deste script\n{}\n", cut(&b["error"], 1500))); }
        prompt.push_str(&format!("\n# Pedido\n{request}"));
        ai_stage(&b, 0, if script.trim().is_empty() { "A IA está escrevendo o script" } else { "A IA está alterando o script" });
        let answer = ai_ask(&b, prompt).await?;
        ai_stage(&b, 1, "Conferindo o script e as credenciais");
        let (script, summary) = script_answer(&answer)?;
        let mut target = json!(script);
        let listed = answer.rsplit_once("SEGREDOS:").and_then(|x| serde_json::from_str::<Value>(x.1.trim().lines().next().unwrap_or("")).ok()).unwrap_or(Value::Null);
        ai_secrets(&listed, &mut target, &mut secrets);
        let script = target.as_str().unwrap_or("").to_string();
        let (report, missing) = keep_secrets(&secrets, &script, &format!("Do script de \"{}\"", s["name"].as_str().unwrap_or("")));
        let values: Vec<String> = secrets.iter().map(|s| s.value.clone()).collect();
        let summary = crate::plugins::vault::scrub(summary.split("SEGREDOS:").next().unwrap_or("").trim(), &values);
        Ok(json!({"script": script, "summary": summary, "secrets": report, "missing_creds": missing}))
}

pub fn add_routes(m: &mut HashMap<String, RouteFn>) {
    m.insert("automator/generate".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if let Some(v) = ai_job_route(&r)? { return ok(v); }
        let _slot=SLOTS.try_acquire().map_err(|_|fail("aguarde as execuções em andamento",409))?;
        let b:Value=r.body_json()?;
        let job = b["job"].as_str().unwrap_or("").to_string();
        ok(ai_job(&job, generate_flow(b)).await?)
    }));
    m.insert("automator/script".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if !r.is_post() { return Err(fail("use POST", 405)); }
        let _slot = SLOTS.try_acquire().map_err(|_| fail("aguarde as execuções em andamento", 409))?;
        let b: Value = r.body_json()?;
        let job = b["job"].as_str().unwrap_or("").to_string();
        ok(ai_job(&job, script_ai(b)).await?)
    }));
    // Credenciais do Automator (creds.rs): GET -> { entries (sem valores, com os fluxos que usam cada uma), audit, file }; POST { action, name, ... }
    m.insert("automator/creds".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if r.is_post() { let b: Value = r.body_json()?; crate::creds::manage(&b).await?; }
        let flows: Vec<(String, String)> = load()?.flows.iter().map(|f| (f.name.clone(), serde_json::to_string(&f.nodes).unwrap_or_default())).collect();
        let mut list = crate::creds::list();
        for c in list.as_array_mut().into_iter().flatten() {
            let name = c["name"].as_str().unwrap_or("").to_string();
            c["flows"] = json!(flows.iter().filter(|f| crate::creds::marks(&f.1).iter().any(|m| m.1 == name)).map(|f| f.0.clone()).collect::<Vec<_>>());
        }
        ok(json!({"entries": list, "audit": crate::creds::audit_log(), "file": crate::creds::file_path()}))
    }));
    // Exportar: abre a janela "Salvar como" do Windows e grava o JSON onde a pessoa escolher. { name, content } ->
    // { path } (nulo se ela desistiu). O caminho vem só da janela nativa: a página não escolhe onde gravar.
    m.insert("automator/export".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if !r.is_post() { return Err(fail("use POST", 405)); }
        let b: Value = r.body_json()?;
        let content = b["content"].as_str().ok_or_else(|| fail("nada para exportar", 400))?.to_string();
        if content.len() > 64 * 1024 * 1024 { return Err(fail("arquivo grande demais para exportar", 400)); }
        let name: String = b["name"].as_str().unwrap_or("fluxos").chars().filter(|c| !c.is_control() && !"\\/:*?\"<>|".contains(*c)).take(80).collect();
        let name = if name.trim().is_empty() { "fluxos".to_string() } else { name.trim().to_string() };
        let picked = tokio::task::spawn_blocking(move || {
            rfd::FileDialog::new().set_title("Exportar fluxos").set_file_name(format!("{name}.json")).add_filter("Fluxos do Automator (JSON)", &["json"]).save_file()
        }).await.map_err(|e| fail(e.to_string(), 500))?;
        let Some(mut path) = picked else { return ok(json!({"path": null})); };
        if path.extension().is_none() { path.set_extension("json"); }
        std::fs::write(&path, content).map_err(|e| fail(format!("não deu para gravar em {}: {e}", path.display()), 500))?;
        ok(json!({"path": path.to_string_lossy()}))
    }));
    // abre no programa padrão um arquivo que um nó gerou (relatório, evidência); só arquivos que existem, desses tipos
    m.insert("automator/open".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if !r.is_post() { return Err(fail("use POST", 405)); }
        let b: Value = r.body_json()?;
        let path = std::path::PathBuf::from(b["path"].as_str().unwrap_or(""));
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !path.is_absolute() || !path.is_file() || !["html", "htm", "png", "jpg", "jpeg", "xml", "md", "txt", "csv", "pdf"].contains(&ext.as_str()) { return Err(fail("arquivo não encontrado, ou de um tipo que não abro por aqui", 404)); }
        open_url(&path.to_string_lossy());
        ok(json!({"ok": true}))
    }));
    m.insert("automator/record".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if !r.is_post() { return Err(fail("use POST", 405)); }
        let b: Value = r.body_json()?;
        ok(record(&b).await?)
    }));
    m.insert(
        "automator/catalog".into(),
        route_fn(|r| async move {
            r.local_only()?;
            ok(catalog())
        }),
    );
    // Preferências do Automator: GET -> { keep_runs, runs }; POST { keep_runs } muda a retenção e já corta o histórico;
    // POST { action: "clear_runs", flow? } apaga as execuções terminadas (de um fluxo, ou de todos).
    // Os endereços pelos quais a rede local chama um Endpoint HTTP. POST { enable: true } liga o acesso pela rede.
    m.insert("automator/lan".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if r.is_post() && r.body_json::<Value>()?["enable"] == true { crate::server::lan_enable().await?; }
        let st = crate::server::lan_status();
        ok(json!({"enabled": st["enabled"], "port": st["port"], "urls": st["urls"].as_array().into_iter().flatten().filter_map(|u| u["url"].as_str()).collect::<Vec<_>>()}))
    }));
    m.insert("automator/settings".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if !r.is_post() { let _g = STORE.lock(); let s = load()?; return ok(json!({"keep_runs": keep_runs(&s), "runs": s.runs.len(), "folder_colors": s.folder_colors})); }
        let b: Value = r.body_json()?;
        edit(|s| {
            if b["action"] == "clear_runs" {
                let flow = b["flow"].as_str().filter(|f| !f.is_empty());
                s.runs.retain(|r| r["status"] == "running" || flow.is_some_and(|f| r["flow_id"] != f));
            } else {
                let n = b["keep_runs"].as_u64().filter(|n| (5..=1000).contains(n)).ok_or_else(|| fail("a retenção vai de 5 a 1000 execuções", 400))?;
                s.keep_runs = n as usize;
                trim_runs(s);
            }
            ok(json!({"keep_runs": keep_runs(s), "runs": s.runs.len()}))
        })
    }));
    // Pastas da lista de fluxos, em árvore: o nome é o caminho ("Financeiro/Mensal"). GET -> ["caminho", ...], na ordem
    // em que a pessoa deixou; POST { action: create | rename | delete | color | sort | move | order, name, to, id, folder }.
    // Mover um fluxo não mexe no fluxo em si, então vale também para fluxo trancado.
    m.insert("automator/folders".into(), route_fn(|r| async move {
        r.local_only()?; require_enabled("automator")?;
        if !r.is_post() { let _g = STORE.lock(); return ok(folder_list(&load()?)); }
        let b: Value = r.body_json()?;
        let name = folder_name(b["name"].as_str().unwrap_or(""));
        const BAD: &str = "dê um nome à pasta (até 60 caracteres por nível, até 6 níveis)";
        // `x` é a pasta `p` ou está dentro dela
        let within = |p: &str, x: &str| x == p || x.strip_prefix(p).is_some_and(|rest| rest.starts_with('/'));
        edit(|s| {
            match b["action"].as_str().unwrap_or("") {
                "create" => {
                    let n = name.clone().ok_or_else(|| fail(BAD, 400))?;
                    if folder_list(s).iter().any(|x| x.eq_ignore_ascii_case(&n)) { return Err(fail(format!("já existe a pasta \"{}\"", n.replace('/', " › ")), 409)); }
                    s.folders.push(n);
                }
                // renomear e mover para dentro de outra pasta são a mesma coisa: o caminho muda, e as subpastas e os
                // fluxos de dentro vão junto. A pasta fica no mesmo lugar da lista.
                "rename" => {
                    let from = name.clone().ok_or_else(|| fail("pasta não informada", 400))?;
                    let to = folder_name(b["to"].as_str().unwrap_or("")).ok_or_else(|| fail(BAD, 400))?;
                    if to != from {
                        if within(&from, &to) { return Err(fail("uma pasta não cabe dentro dela mesma", 400)); }
                        let all = folder_list(s);
                        if all.iter().any(|x| x.eq_ignore_ascii_case(&to) && !within(&from, x)) { return Err(fail(format!("já existe a pasta \"{}\"", to.replace('/', " › ")), 409)); }
                        if all.iter().filter(|x| within(&from, x)).any(|x| x.matches('/').count() - from.matches('/').count() + to.matches('/').count() >= 6) { return Err(fail("as pastas vão até 6 níveis", 400)); }
                        let swap = |x: &str| format!("{to}{}", &x[from.len()..]);
                        for f in s.flows.iter_mut().filter(|f| within(&from, &f.folder)) { f.folder = swap(&f.folder); }
                        s.folders = all.into_iter().map(|x| if within(&from, &x) { swap(&x) } else { x }).collect();
                        let moved: Vec<String> = s.folder_colors.keys().filter(|k| within(&from, k)).cloned().collect();
                        for k in moved { if let Some(c) = s.folder_colors.remove(&k) { s.folder_colors.insert(swap(&k), c); } }
                    }
                }
                // a pasta e as subpastas saem; os fluxos de dentro sobem para a pasta de cima (ou ficam sem pasta)
                "delete" => {
                    let n = name.clone().ok_or_else(|| fail("pasta não informada", 400))?;
                    let up = n.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                    let all = folder_list(s);
                    for f in s.flows.iter_mut().filter(|f| within(&n, &f.folder)) { f.folder = up.clone(); }
                    s.folders = all.into_iter().filter(|x| !within(&n, x)).collect();
                    s.folder_colors.retain(|k, _| !within(&n, k));
                }
                // a cor da pasta: { name, color: "#rrggbb" } (vazio: a cor padrão)
                "color" => {
                    let n = name.clone().ok_or_else(|| fail("pasta não informada", 400))?;
                    let c = b["color"].as_str().unwrap_or("").trim().to_lowercase();
                    if c.is_empty() { s.folder_colors.remove(&n); }
                    else if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()) { s.folder_colors.insert(n, c); }
                    else { return Err(fail("cor inválida: use #rrggbb", 400)); }
                }
                // de A a Z: { what: "flows" | "folders" }
                "sort" => {
                    if b["what"] == "folders" { let mut l = folder_list(s); l.sort_by_key(|x| x.to_lowercase()); s.folders = l; }
                    else { s.flows.sort_by_key(|f| f.name.to_lowercase()); }
                }
                "move" => {
                    let to = folder_name(b["folder"].as_str().unwrap_or(""));
                    let at = s.flows.iter().position(|f| Some(f.id.as_str()) == b["id"].as_str()).ok_or_else(|| fail("fluxo não encontrado", 404))?;
                    let mut f = s.flows.remove(at);
                    f.folder = to.clone().unwrap_or_default();
                    // `before` ou `after`: o fluxo ao lado de quem ele fica na lista; sem nenhum, vai para o fim
                    let near = |k: &str| b[k].as_str().and_then(|id| s.flows.iter().position(|x| x.id == id));
                    let i = near("before").or_else(|| near("after").map(|i| i + 1)).unwrap_or(s.flows.len());
                    s.flows.insert(i, f);
                    if let Some(t) = to && !s.folders.contains(&t) { s.folders.push(t); }
                }
                // a ordem das pastas: { names: [...] }; as que faltarem ficam no fim
                "order" => {
                    let all = folder_list(s);
                    let mut next: Vec<String> = vec![];
                    for n in b["names"].as_array().into_iter().flatten().filter_map(|n| n.as_str()) { if all.iter().any(|x| x == n) && !next.iter().any(|x| x == n) { next.push(n.to_string()); } }
                    for n in all { if !next.contains(&n) { next.push(n); } }
                    s.folders = next;
                }
                _ => return Err(fail("ação desconhecida", 400)),
            }
            ok(folder_list(s))
        })
    }));
    m.insert(
        "automator/flows".into(),
        route_fn(|r| async move {
            r.local_only()?;
            require_enabled("automator")?;
            if !r.is_post() {
                let _g = STORE.lock();
                return ok(load()?.flows);
            }
            let b: Value = r.body_json()?;
            if b["action"] == "delete" {
                return edit(|s| {
                    if RUNNING.lock().contains_key(b["id"].as_str().unwrap_or("")) {
                        return Err(fail("pare o fluxo antes de excluir", 409));
                    }
                    if s.flows.iter().any(|f| Some(f.id.as_str()) == b["id"].as_str() && f.locked) {
                        return Err(fail("este fluxo está trancado: destranque antes de excluir", 423));
                    }
                    s.flows.retain(|f| Some(f.id.as_str()) != b["id"].as_str());
                    s.pending
                        .retain(|p| Some(p.flow_id.as_str()) != b["id"].as_str());
                    for e in &mut s.events {
                        if e.flow_id.as_deref() == b["id"].as_str() {
                            e.flow_id = None;
                        }
                    }
                    ok(json!({"ok":true}))
                });
            }
            let mut f: Flow = serde_json::from_value(b.get("flow").cloned().unwrap_or(b))?;
            validate(&f)?;
            if f.id.is_empty() {
                f.id = id();
            }
            f.updated_at = Some(chrono::Utc::now().to_rfc3339());
            edit(|s| {
                let old = s.flows.iter().find(|v| v.id == f.id);
                // trancado continua trancado: só passa o que não é edição (ligar, desligar, a posição da vista)
                if let Some(o) = old && o.locked && f.locked {
                    let core = |x: &Flow| json!([x.name, x.description, x.nodes, x.edges]);
                    if core(o) != core(&f) { return Err(fail("este fluxo está trancado: destranque para editar", 423)); }
                }
                // agenda igual à que já estava valendo: mantém o disparo marcado; mudou (ou ligou agora): recalcula
                let same = old.is_some_and(|o| o.active && schedule_node(o).map(|n| &n.params) == schedule_node(&f).map(|n| &n.params));
                f.next_run = if !f.active { None } else if same { old.and_then(|o| o.next_run).or_else(|| next_fire(&f, now())) } else { next_fire(&f, now()) };
                if let Some(name) = folder_name(&f.folder) { if !s.folders.contains(&name) { s.folders.push(name.clone()); } f.folder = name; } else { f.folder.clear(); }
                // o fluxo fica onde estava na lista (a ordem é a que a pessoa arrumou); um novo entra no fim
                match s.flows.iter().position(|v| v.id == f.id) { Some(i) => s.flows[i] = f.clone(), None => s.flows.push(f.clone()) }
                ok(f)
            })
        }),
    );
    m.insert(
        "automator/run".into(),
        route_fn(|r| async move {
            r.local_only()?;
            if !r.is_post() {
                return Err(fail("use POST", 405));
            }
            let b: Value = r.body_json()?;
            if b["action"] == "stop" {
                edit(|s| {
                    s.pending
                        .retain(|p| Some(p.flow_id.as_str()) != b["flow_id"].as_str());
                    Ok(())
                })?;
                let g = RUNNING.lock();
                if let Some(c) = g.get(b["flow_id"].as_str().unwrap_or("")) {
                    c.store(true, Ordering::Relaxed);
                }
                return ok(json!({"ok":true}));
            }
            let f = {
                let _g = STORE.lock();
                load()?
                    .flows
                    .into_iter()
                    .find(|f| Some(f.id.as_str()) == b["flow_id"].as_str())
                    .ok_or_else(|| fail("fluxo não encontrado", 404))?
            };
            ok(start(f, "", Value::Null)?)
        }),
    );
    m.insert(
        "automator/runs".into(),
        route_fn(|r| async move {
            r.local_only()?;
            let (flow, limit) = (r.q("flow").map(String::from), r.q("limit").and_then(|n| n.parse::<usize>().ok()).unwrap_or(usize::MAX));
            let _g = STORE.lock();
            let s = load()?;
            let keep = |id: &str| flow.as_deref().is_none_or(|f| f == id);
            let mut runs: Vec<Value> = s.pending.iter().filter(|p| keep(&p.flow_id)).map(|p| json!({"id":format!("queued-{}",p.flow_id),"flow_id":p.flow_id,"name":s.flows.iter().find(|f|f.id==p.flow_id).map(|f|&f.name),"started_at":p.at,"status":"queued","nodes":[]})).collect();
            runs.extend(s.runs.into_iter().filter(|r| keep(r["flow_id"].as_str().unwrap_or(""))));
            runs.truncate(limit);
            ok(runs)
        }),
    );
    // Qualquer método, ?e=<nome>: dispara o fluxo ligado que tem o Endpoint HTTP com esse nome, espera terminar e
    // devolve o que o nó "Responder ao endpoint" definiu. Falha de um nó de Segurança vira 400/401/429.
    m.insert(
        "automator/hook".into(),
        route_fn(|r| async move {
            let reply = |code: u16, ctype: &str, body: String| -> ApiResult<Reply> {
                Ok(Reply::Raw(axum::http::Response::builder().status(code).header("content-type", ctype).header("cache-control", "no-store").body(axum::body::Body::from(body)).map_err(|e| fail(e.to_string(), 500))?))
            };
            let err = |code: u16, msg: &str| reply(code, "application/json; charset=utf-8", json!({"error": msg}).to_string());
            if !enabled("automator") { return err(503, "o Automator está desligado"); }
            let name = r.q("e").unwrap_or("").trim().to_string();
            let found = {
                let _g = STORE.lock();
                load()?.flows.into_iter().filter(|f| f.active).find_map(|f| {
                    let n = f.nodes.iter().find(|n| n.kind == "trigger.webhook" && !n.disabled && n.params["name"].as_str().map(str::trim) == Some(name.as_str()))?.clone();
                    Some((f, n))
                })
            };
            let Some((f, node)) = found.filter(|_| endpoint_name_ok(&name)) else { return err(404, "endpoint não encontrado, ou o fluxo dele está desligado") };
            let p = &node.params;
            if r.remote && p["who"] != "lan" { return err(403, "este endpoint só atende chamadas deste PC"); }
            let want = p["method"].as_str().unwrap_or("any");
            if want != "any" && !r.method.as_str().eq_ignore_ascii_case(want) { return err(405, "método não aceito por este endpoint"); }
            if r.body.len() > 1024 * 1024 { return err(413, "corpo grande demais (mais de 1 MB)"); }
            let raw = String::from_utf8_lossy(&r.body).into_owned();
            let payload = hook_payload(&r, &name, &raw);
            let kinds: HashMap<String, String> = f.nodes.iter().map(|n| (n.id.clone(), n.kind.clone())).collect();
            let rec = match start(f, "trigger.webhook", payload) {
                Ok(v) => v,
                Err(e) if e.status == 409 => return err(503, "ocupado com outra chamada: tente de novo em instantes"),
                Err(e) => return err(500, &e.msg),
            };
            let run_id = rec["id"].as_str().unwrap_or("").to_string();
            let deadline = std::time::Instant::now() + Duration::from_secs(p["wait_s"].as_u64().unwrap_or(30).clamp(1, 300));
            let run = loop {
                tokio::time::sleep(Duration::from_millis(80)).await;
                let cur = { let _g = STORE.lock(); load()?.runs.into_iter().find(|x| x["id"] == run_id.as_str()) };
                match cur {
                    Some(x) if x["status"] != "running" => break x,
                    None => return err(500, "a execução sumiu do histórico"),
                    _ if std::time::Instant::now() >= deadline => return reply(202, "application/json; charset=utf-8", json!({"status": "running", "run": run_id}).to_string()),
                    _ => {}
                }
            };
            let nodes = run["nodes"].as_array().cloned().unwrap_or_default();
            if let Some(x) = nodes.iter().rev().find(|x| x["status"] == "completed" && x["id"].as_str().and_then(|id| kinds.get(id)).is_some_and(|k| k == "http.respond")) {
                let o = &x["output"]["out"];
                let code = o["status"].as_u64().unwrap_or(200) as u16;
                return match o["type"].as_str().unwrap_or("json") {
                    "text" => reply(code, "text/plain; charset=utf-8", stringify(&o["body"])),
                    "html" => reply(code, "text/html; charset=utf-8", stringify(&o["body"])),
                    // JSON: texto que já é JSON vai como está; o resto é serializado
                    _ => reply(code, "application/json; charset=utf-8", match &o["body"] { Value::String(s) if serde_json::from_str::<Value>(s).is_ok() => s.clone(), v => v.to_string() }),
                };
            }
            if run["status"] != "completed" {
                let failed = nodes.iter().rev().find(|x| x["status"] == "failed");
                let code = failed.and_then(|x| x["code"].as_u64()).filter(|c| [400, 401, 403, 404, 429].contains(c)).unwrap_or(500) as u16;
                // 4xx: a mensagem é para quem chamou; o resto fica só no histórico
                return err(code, if code < 500 { failed.and_then(|x| x["error"].as_str()).unwrap_or("recusado") } else { "o fluxo falhou: veja o histórico no Automator" });
            }
            reply(200, "application/json; charset=utf-8", json!({"ok": true, "run": run_id}).to_string())
        }),
    );
    // GET ?name=Alarm01.wav -> o som do Windows (para ouvir antes de escolher, no nó Alarme)
    m.insert(
        "automator/sound".into(),
        route_fn(|r| async move {
            r.local_only()?;
            let name = r.require("name")?.to_string();
            if !system_sounds().iter().any(|s| *s == name) { return Err(fail("som não encontrado", 404)); }
            let bytes = std::fs::read(std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into())).join("Media").join(&name))?;
            Ok(Reply::Raw(axum::http::Response::builder().header("content-type", "audio/wav").header("cache-control", "max-age=3600").body(axum::body::Body::from(bytes)).map_err(|e| fail(e.to_string(), 500))?))
        }),
    );
    // POST ?kind=file|folder|save|program&start=&title= -> { path } (null: a pessoa cancelou). Seletor nativo do Windows.
    m.insert(
        "automator/pick".into(),
        route_fn(|r| async move {
            r.local_only()?;
            if !r.is_post() { return Err(fail("use POST", 405)); }
            let kind = r.q("kind").unwrap_or("file").to_string();
            let title = r.q("title").unwrap_or("Escolher").to_string();
            // começa na pasta do que já estava no campo, se existir
            let start = r.q("start").map(|s| std::path::PathBuf::from(s.trim().trim_matches('"'))).and_then(|p| if p.is_dir() { Some(p) } else { p.parent().filter(|d| d.is_dir()).map(|d| d.to_path_buf()) });
            let picked = tokio::task::spawn_blocking(move || {
                let mut d = rfd::FileDialog::new().set_title(&title);
                if let Some(s) = start { d = d.set_directory(s); }
                match kind.as_str() {
                    "folder" => d.pick_folder(),
                    "save" => d.save_file(),
                    "program" => d.add_filter("Programas", &["exe", "cmd", "bat", "com", "ps1", "lnk"]).add_filter("Todos os arquivos", &["*"]).pick_file(),
                    _ => d.pick_file(),
                }
            }).await.map_err(|e| fail(e.to_string(), 500))?;
            ok(json!({"path": picked.map(|p| p.to_string_lossy().into_owned())}))
        }),
    );
    // GET -> [{ id, name, kind, program, model, effort, args }] (Codex e Claude Code sempre vêm)
    // POST { cli } grava; { action: "delete", id } exclui (nos de fábrica, volta ao padrão); { action: "test", id } faz uma pergunta curta
    m.insert(
        "agents/clis".into(),
        route_fn(|r| async move {
            r.local_only()?;
            require_enabled("automator")?;
            if !r.is_post() { return ok(clis()); }
            let b: Value = r.body_json()?;
            let factory = |id: &str| id == "codex" || id == "claude";
            if b["action"] == "test" {
                let _slot = SLOTS.try_acquire().map_err(|_| fail("aguarde as execuções em andamento", 409))?;
                let id = b["id"].as_str().unwrap_or("");
                let began = std::time::Instant::now();
                let v = cli("automator", id, "Responda somente com a palavra: pronto", &Value::Null, &Value::Null).await?;
                let tail = |k: &str| { let t = v[k].as_str().unwrap_or("").trim(); t.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect::<String>() };
                return ok(json!({"ok": v["ok"], "out": tail("out"), "err": tail("err"), "timedOut": v["timedOut"], "ms": began.elapsed().as_millis() as u64}));
            }
            if b["action"] == "delete" {
                let id = b["id"].as_str().unwrap_or("").to_string();
                return edit(|s| { s.clis.retain(|c| c.id != id); ok(json!({"ok":true})) });
            }
            let mut c: Cli = serde_json::from_value(b.get("cli").cloned().unwrap_or(b))?;
            c.name = c.name.trim().to_string();
            if c.name.is_empty() || c.name.chars().count() > 60 { return Err(fail("dê um nome ao agente (até 60 letras)", 400)); }
            if factory(&c.id) { c.kind = c.id.clone(); }
            else {
                if !matches!(c.kind.as_str(), "claude" | "codex" | "custom") { return Err(fail("tipo de agente desconhecido", 400)); }
                if c.program.trim().is_empty() { return Err(fail("informe o programa (por exemplo: openclaude)", 400)); }
                if c.id.is_empty() || !c.id.chars().all(|ch| ch.is_ascii_alphanumeric()) { c.id = format!("cli{}", &id()[..8]); }
            }
            c.args.retain(|a| !a.trim().is_empty());
            if c.args.len() > 40 { return Err(fail("argumentos demais (até 40)", 400)); }
            // confere modelo e esforço já aqui, para o erro aparecer no formulário e não na execução
            cli_command(&c, &c.model, &c.effort, "", "")?;
            edit(|s| {
                if s.clis.iter().filter(|x| x.id != c.id).count() >= 20 { return Err(fail("até 20 agentes", 400)); }
                if s.clis.iter().any(|x| x.id != c.id && x.name.eq_ignore_ascii_case(&c.name)) || (!factory(&c.id) && ["codex", "claude code"].contains(&c.name.to_lowercase().as_str())) {
                    return Err(fail("já existe um agente com esse nome", 400));
                }
                s.clis.retain(|x| x.id != c.id);
                s.clis.push(c.clone());
                ok(c)
            })
        }),
    );
    m.insert(
        "agenda/events".into(),
        route_fn(|r| async move {
            r.local_only()?;
            require_enabled("agenda")?;
            if !r.is_post() {
                let _g = STORE.lock();
                return ok(load()?.events);
            }
            let b: Value = r.body_json()?;
            edit(|s| {
                if b["action"] == "delete" {
                    s.events.retain(|e| Some(e.id.as_str()) != b["id"].as_str());
                    return ok(json!({"ok":true}));
                }
                let mut e: Agenda = serde_json::from_value(b.get("event").cloned().unwrap_or(b))?;
                if e.title.trim().is_empty() || e.at <= 0 || e.repeat_minutes > 525600 {
                    return Err(fail(
                        "informe título, data válida e repetição de até um ano",
                        400,
                    ));
                }
                if let Some(fid) = &e.flow_id {
                    if !s.flows.iter().any(|f| &f.id == fid) {
                        return Err(fail("fluxo vinculado não encontrado", 400));
                    }
                }
                if e.id.is_empty() {
                    e.id = id();
                }
                s.events.retain(|v| v.id != e.id);
                s.events.push(e.clone());
                ok(e)
            })
        }),
    );
}

pub async fn scheduler() {
    let _ = edit(|s| {
        for r in &mut s.runs {
            if r["status"] == "running" {
                r["status"] = json!("interrupted");
                r["finished_at"] = json!(now());
            }
        }
        Ok(())
    });
    let mut boot = true;
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let first = std::mem::replace(&mut boot, false);
        ensure_lan().await;
        let (automator, agenda) = (enabled("automator"), enabled("agenda"));
        let quiet = !first && with_store(|s, _| {
            let t = now();
            s.pending.is_empty()
                && !(automator && s.flows.iter().any(|f| f.active && (f.next_run.is_some_and(|x| x <= t) || f.nodes.iter().any(|n| n.kind == "trigger.file" && !n.disabled))))
                && !(agenda && s.events.iter().any(|e| !e.done && !e.notified && e.at <= t))
        }).unwrap_or(false);
        if quiet { continue; }
        let due = edit(|s| {
            let mut flows: Vec<(Flow, String, Value)> = Vec::new();
            let mut notifications = Vec::new();
            if enabled("automator") {
                for f in &mut s.flows {
                    if !f.active { continue; }
                    if f.next_run.is_some_and(|t| t <= now()) {
                        f.next_run = next_fire(f, now());
                        if f.next_run.is_some() { flows.push((f.clone(), "trigger.schedule".into(), Value::Null)); }
                    }
                    if first && f.nodes.iter().any(|n| n.kind == "trigger.startup" && !n.disabled) { flows.push((f.clone(), "trigger.startup".into(), json!({"at":now()}))); }
                    if let Some(hit) = file_changes(f) { flows.push((f.clone(), "trigger.file".into(), hit)); }
                }
            }
            if enabled("agenda") {
                for e in &mut s.events {
                    if !e.done && !e.notified && e.at <= now() {
                        notifications.push((e.title.clone(), e.notes.clone()));
                        if let Some(fid) = &e.flow_id
                            && let Some(f) = s.flows.iter().find(|f| &f.id == fid)
                        {
                            flows.push((f.clone(), String::new(), Value::Null));
                        }
                        if e.repeat_minutes > 0 {
                            let step = e.repeat_minutes as i64 * 60000;
                            e.at += ((now() - e.at) / step + 1) * step;
                        } else {
                            e.notified = true;
                        }
                    }
                }
            }
            for (f, via, payload) in flows {
                if !s.pending.iter().any(|p| p.flow_id == f.id) {
                    s.pending.push(Pending { flow_id: f.id, scheduled: !via.is_empty(), at: now(), via, payload });
                }
            }
            Ok((s.pending.clone(), notifications))
        });
        match due {
            Ok((flows, notifications)) => {
                for (t, b) in notifications {
                    notify(&t, &b);
                }
                for pending in flows {
                    if !enabled("automator") {
                        break;
                    }
                    let flow = {
                        let _g = STORE.lock();
                        load()
                            .ok()
                            .and_then(|s| s.flows.into_iter().find(|f| f.id == pending.flow_id))
                    };
                    let result = match flow {
                        Some(f) if !pending.scheduled || f.active => {
                            // fila gravada por uma versão anterior: só dizia "agendado"
                            let via = if pending.via.is_empty() && pending.scheduled { "trigger.schedule" } else { pending.via.as_str() };
                            start(f, via, pending.payload.clone()).map(|_| ())
                        }
                        _ => Ok(()),
                    };
                    if result.as_ref().is_err_and(|e| e.status == 409) {
                        continue;
                    }
                    if let Err(e) = result {
                        let _ = edit(|s| {
                            s.runs.insert(0,json!({"id":id(),"flow_id":pending.flow_id,"started_at":pending.at,"finished_at":now(),"status":"failed","error":e.to_string(),"nodes":[]}));
                            Ok(())
                        });
                        log(format!("automator: {e}"));
                    }
                    let _ = edit(|s| {
                        s.pending.retain(|p| p.flow_id != pending.flow_id);
                        Ok(())
                    });
                }
            }
            Err(e) => log(format!("agenda: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_commands() {
        let c = |kind: &str, program: &str, args: &[&str]| Cli { id: "x".into(), name: "X".into(), kind: kind.into(), program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        let (p, a, stdin) = cli_command(&c("claude", "openclaude", &["--verbose"]), "opus", "high", "oi", "").unwrap();
        assert_eq!(p, "openclaude");
        assert!(stdin && a.windows(2).any(|w| w == ["--model", "opus"]) && a.windows(2).any(|w| w == ["--effort", "high"]) && a.last().unwrap() == "--verbose");
        let (p, a, _) = cli_command(&c("codex", "", &[]), "gpt-5", "low", "oi", "read").unwrap();
        assert_eq!(p, "codex");
        assert!(a.windows(2).any(|w| w == ["-m", "gpt-5"]) && a.contains(&"model_reasoning_effort=\"low\"".to_string()) && a.last().unwrap() == "-");
        // sem modelo nem esforço, as opções deles não vão
        let (_, a, _) = cli_command(&c("claude", "", &[]), "", "", "oi", "").unwrap();
        assert!(!a.contains(&"--model".to_string()) && !a.contains(&"--effort".to_string()) && a.contains(&"plan".to_string()));
        // acesso: só leitura é o padrão; "edit" e "full" tiram as travas de leitura
        let (_, a, _) = cli_command(&c("claude", "", &[]), "", "", "oi", "edit").unwrap();
        assert!(a.contains(&"acceptEdits".to_string()) && !a.contains(&"--tools".to_string()));
        let (_, a, _) = cli_command(&c("codex", "", &[]), "", "", "oi", "edit").unwrap();
        assert!(a.windows(2).any(|w| w == ["--sandbox", "workspace-write"]));
        let (_, a, _) = cli_command(&c("codex", "", &[]), "", "", "oi", "full").unwrap();
        assert!(a.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()) && !a.contains(&"--sandbox".to_string()));
        assert!(cli_command(&c("claude", "", &[]), "", "", "oi", "root").is_err());
        // personalizado: {prompt} num argumento tira o pedido da entrada padrão; modelo vazio leva a opção junto
        let (_, a, stdin) = cli_command(&c("custom", "meu", &["run", "--model", "{model}", "-p", "{prompt}"]), "", "", "oi", "").unwrap();
        assert!(!stdin);
        assert_eq!(a, ["run", "-p", "oi"]);
        let (_, a, stdin) = cli_command(&c("custom", "meu", &["--model", "{model}"]), "m1", "", "oi", "").unwrap();
        assert!(stdin);
        assert_eq!(a, ["--model", "m1"]);
        assert!(cli_command(&c("claude", "", &[]), "a b; rm", "", "", "").is_err());
        assert!(cli_command(&c("claude", "", &[]), "", "enorme", "", "").is_err());
        assert!(cli_command(&c("custom", "", &[]), "", "", "", "").is_err());
        assert_eq!(clis().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["codex", "claude"]);
    }
    #[test]
    fn wildcard_and_catalog() {
        assert!(wildcard("*.PDF", "nota.pdf") && wildcard("a?c.txt", "abc.txt") && wildcard("", "x") && !wildcard("*.pdf", "nota.pdf.bak"));
        let all = catalog();
        let kinds: Vec<&str> = all.as_array().unwrap().iter().filter_map(|s| s["type"].as_str()).collect();
        let unique: HashSet<&str> = kinds.iter().copied().collect();
        assert_eq!(kinds.len(), unique.len());
        for k in ["trigger.file", "file.write", "windows.powershell", "text.extract", "image.resize", "audio.convert", "video.trim", "text.join", "trigger.webhook", "sec.token", "audit.tls", "dynatrace.problems", "data.table", "windows.alarm", "json.get", "json.group", "qa.api", "qa.data", "qa.load", "qa.report", "flow.call", "time.window", "time.now", "time.compare", "time.shift", "time.until"] { assert!(unique.contains(k), "{k}"); }
        assert_eq!((folder_name("  Financeiro "), folder_name(" a / b "), folder_name(""), folder_name("a//b"), folder_name("1/2/3/4/5/6/7")), (Some("Financeiro".to_string()), Some("a/b".to_string()), None, None, None));
        let st = Store { folders: vec!["x/y/z".into(), "a".into()], ..Default::default() };
        assert_eq!(folder_list(&st), ["x", "x/y", "x/y/z", "a"]);
        // RFC 4231, caso 2
        assert_eq!(hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        assert!(same_secret("abc", "abc") && !same_secret("abc", "abd") && !same_secret("abc", "abcd"));
        assert_eq!(parse_csv("a;b\r\n1;\"x;y\"\n\n2;\"diz \"\"oi\"\"\"", ';'), vec![vec!["a", "b"], vec!["1", "x;y"], vec!["2", "diz \"oi\""]]);
        assert_eq!(host_of("https://exemplo.com.br:8443/x"), "exemplo.com.br");
        assert_eq!(host_of("exemplo.com/x"), "exemplo.com");
        assert!(endpoint_name_ok("meu-endpoint_2") && !endpoint_name_ok("a b") && !endpoint_name_ok(""));
        let r = redact(&json!({"token":"abc","headers":{"Authorization":"Bearer x","accept":"*/*"},"body":{"nome":"Ana"}}));
        assert_eq!(r, json!({"token":"••••••","headers":{"Authorization":"••••••","accept":"*/*"},"body":{"nome":"Ana"}}));
        assert_eq!(list_of(&json!("[1,2]")).len(), 2);
        assert_eq!(list_of(&json!("x")), vec![json!("x")]);
        // onde gravar: ao lado do original, com sufixo; nunca por cima da entrada
        let input = std::env::temp_dir().join("foto.png");
        assert_eq!(media_out(&json!({}), &input, "-recorte", "png").unwrap(), std::env::temp_dir().join("foto-recorte.png"));
        assert!(media_out(&json!({"out": input.to_string_lossy()}), &input, "", "png").is_err());
        assert_eq!(media_out(&json!({"out": std::env::temp_dir().to_string_lossy()}), &input, "", "jpg").unwrap(), std::env::temp_dir().join("foto.jpg"));
        assert_eq!(time_arg(&json!({"t":"1,5"}), "t").unwrap().as_deref(), Some("1.5"));
        assert!(time_arg(&json!({"t":"1; rm"}), "t").is_err() && time_arg(&json!({"t":""}), "t").unwrap().is_none());
    }
    #[test]
    fn file_trigger_sees_new_and_changed_files() {
        let dir = std::env::temp_dir().join(format!("bs-watch-{}", id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f: Flow = serde_json::from_value(json!({"id":"w","name":"W","nodes":[{"id":"t","type":"trigger.file","params":{"path":dir.to_string_lossy()}}]})).unwrap();
        assert!(file_changes(&f).is_none()); // a primeira olhada só anota
        std::fs::write(dir.join("novo.txt"), "a").unwrap();
        let hit = file_changes(&f).unwrap();
        assert_eq!(hit["name"], "novo.txt");
        assert!(file_changes(&f).is_none());
        std::fs::write(dir.join("novo.txt"), "maior").unwrap();
        assert_eq!(file_changes(&f).unwrap()["files"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
    fn flow() -> Flow {
        serde_json::from_value(json!({"name":"Teste","nodes":[{"id":"a","type":"trigger.manual"},{"id":"b","type":"util.output"}],"edges":[{"from":"a","from_port":"out","to":"b","to_port":"in"}]})).unwrap()
    }
    #[test]
    fn graph_validation() {
        let mut f = flow();
        assert_eq!(validate(&f).unwrap(), vec![0, 1]);
        f.edges[0].to_port = "bad".into();
        assert!(validate(&f).is_err());
        f.edges[0].to_port = "in".into();
        f.nodes[0].kind = "util.text".into();
        f.nodes.push(Node {
            id: "t".into(),
            kind: "trigger.manual".into(),
            title: None,
            params: json!({}),
            position: [0., 0.],
            disabled: false,
            locked: false,
            size: None,
        });
        f.edges.push(Edge {
            id: String::new(),
            from: "b".into(),
            from_port: "out".into(),
            to: "a".into(),
            to_port: "in".into(),
        });
        assert!(validate(&f).is_err());
    }
    #[test]
    fn references_keep_types_and_secrets() {
        let outputs = HashMap::from([("a".into(), json!({"out":{"ok":true}}))]);
        assert_eq!(
            fill(&json!("{{nodes.a.out}}"), &Value::Null, &outputs).unwrap(),
            json!({"ok":true})
        );
        assert_eq!(
            fill(
                &json!("Bearer {{vault:api}} {{input}}"),
                &json!(7),
                &outputs
            )
            .unwrap(),
            json!("Bearer {{vault:api}} 7")
        );
        assert!(fill(&json!("{{nodes.missing.out}}"), &Value::Null, &outputs).is_err());
    }
    #[test]
    fn mcp_checks_ids_and_multiline_sse() {
        assert!(
            rpc_body(
                &json!({"ok":true,"body":"{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}"}),
                2
            )
            .is_err()
        );
        let response = json!({"ok":true,"body":"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\r\ndata: \"result\":{\"content\":[]}}\r\n\r\n"});
        assert_eq!(rpc_body(&response, 2).unwrap(), json!({"content":[]}));
        assert!(rpc_body(&json!({"ok":true,"body":"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"message\":\"falhou\"}}"}),2).is_err());
    }
    #[tokio::test]
    async fn automation_routes_refuse_lan() {
        let mut routes = HashMap::new();
        add_routes(&mut routes);
        // o Endpoint HTTP é a exceção: atende a rede quando o fluxo dele permite (e recusa com 403 quando não)
        routes.remove("automator/hook");
        for route in routes.values() {
            let request = Req {
                query: HashMap::new(),
                method: axum::http::Method::GET,
                headers: Default::default(),
                body: Default::default(),
                remote: true,
                internal: false,
            };
            assert_eq!(route(Arc::new(request)).await.err().unwrap().status, 403);
        }
    }
    #[test]
    fn condition_compares_by_value() {
        let c = |v: Value, op: &str, e: Value| condition(&json!({"value":v,"op":op,"equals":e})).unwrap();
        // o que vem do painel é texto: "5" tem de valer como 5
        assert!(c(json!(5), "eq", json!("5")) && c(json!("5,0"), "eq", json!(5)) && !c(json!("a"), "eq", json!("b")));
        assert!(c(json!("10"), "gt", json!("9")) && c(json!(2), "lt", json!("10")));
        assert!(c(json!("Erro: Timeout"), "contains", json!("timeout")) && c(json!("ok"), "not_contains", json!("erro")));
        assert!(c(json!(""), "empty", json!("")) && c(json!([]), "empty", json!("")) && c(json!("x"), "not_empty", json!("")));
        assert!(c(json!("sim"), "true", json!("")) && !c(json!("false"), "true", json!("")) && !c(json!(0), "true", json!("")));
        assert!(condition(&json!({"value":"abc","op":"gt","equals":"1"})).is_err());
    }
    #[test]
    fn expressions_reach_inside_values() {
        let outputs = HashMap::from([("h".to_string(), json!({"out":{"itens":[{"nome":"a"},{"nome":"b"}]}}))]);
        assert_eq!(fill(&json!("{{nodes.h.out.itens.1.nome}}"), &Value::Null, &outputs).unwrap(), json!("b"));
        assert_eq!(fill(&json!("{{nodes.h}}"), &Value::Null, &outputs).unwrap(), json!({"itens":[{"nome":"a"},{"nome":"b"}]}));
        // saída de programa em JSON (texto) também abre por campo
        assert_eq!(fill(&json!("v={{input.versao}}"), &json!("{\"versao\":\"1.2\"}"), &outputs).unwrap(), json!("v=1.2"));
        assert!(fill(&json!("{{input.nada}}"), &json!({"a":1}), &outputs).is_err());
    }
    #[test]
    fn guia_e_conferencia_da_ia() {
        let g = ai_guide();
        assert!(g.contains("## JSON") && g.contains("json.get \"Pegar campo\"") && g.contains("valores: error | null | default"), "guia sem os nós JSON");
        assert!(g.contains("saída: {\"cpu_percent\""), "guia sem o exemplo da saída");
        let f: Flow = serde_json::from_value(json!({"name":"T","nodes":[
            {"id":"a","type":"trigger.manual","params":{}},
            {"id":"b","type":"sys.info","params":{}},
            {"id":"c","type":"util.text","params":{"text":"{{input.cpu}} {{nodes.z.out}} {{nodes.d.out}}","cor":"x"}},
            {"id":"d","type":"json.get","params":{"value":"{{input}}","path":"x","missing":"talvez"}},
            {"id":"e","type":"util.text","params":{"text":"{{input.nome}}"}}],
            "edges":[{"from":"a","from_port":"out","to":"b","to_port":"in"},{"from":"b","from_port":"out","to":"c","to_port":"in"},{"from":"c","from_port":"out","to":"d","to_port":"in"}]})).unwrap();
        let p = flow_issues(&f).join("
");
        for want in ["não tem o campo 'cpu'", "aponta para um nó que não existe", "não vem antes deste", "o parâmetro 'cor' não existe", "'missing' não aceita", "nenhum nó está ligado nele"] { assert!(p.contains(want), "faltou: {want}
{p}"); }
        let ok: Flow = serde_json::from_value(json!({"name":"T","nodes":[{"id":"a","type":"trigger.manual","params":{}},{"id":"b","type":"sys.info","params":{}},{"id":"c","type":"util.text","params":{"text":"{{input.cpu_percent}} {{nodes.b.out.disks}}"}}],
            "edges":[{"from":"a","from_port":"out","to":"b","to_port":"in"},{"from":"b","from_port":"out","to":"c","to_port":"in"}]})).unwrap();
        assert_eq!(flow_issues(&ok), Vec::<String>::new());
    }
    #[test]
    fn senhas_do_pedido_e_script_da_ia() {
        let t = "Entre em https://app.loja.com.br com usuário ana e senha Tr0ca!123, depois use o token ghp_abcdefghijklmnopqrstuvwxyz0123456789 e a chave: minhachave. A senha do usuário é obrigatória; api key 'x y z'.";
        let f = find_secrets(t);
        let got: Vec<(&str, &str)> = f.iter().map(|x| (x.2.as_str(), x.3.as_str())).collect();
        assert_eq!(got, [("senha-loja", "Tr0ca!123"), ("token-github", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"), ("chave-loja", "minhachave"), ("chave-loja", "x y z")], "{got:?}");
        let far: Vec<String> = find_secrets("A senha do painel é Xk9#mudar, a do jardim é girassol e o token do github: veja abaixo. A senha do usuário é obrigatória.").into_iter().map(|x| x.3).collect();
        assert_eq!(far, ["Xk9#mudar"]);
        for x in &f { assert_eq!(&t[x.0..x.1].trim_matches('\''), &x.3); }
        assert!(find_secrets("troque a senha do usuário e avise; o token do github já está em {{cred:gh}}; senha: {{cred:x}}").is_empty());
        let (s, r) = script_answer("Claro.\n```powershell\n$a = 1\nWrite-Output \"`n$a\"\n```\nRESUMO: escreve 1.").unwrap();
        assert_eq!((s.as_str(), r.as_str()), ("$a = 1\nWrite-Output \"`n$a\"", "escreve 1."));
        assert!(script_answer("sem bloco").is_err() && script_answer("```\n```").is_err());
        let mut v = json!([{"a": "senha abc123 aqui {{cred:velho}} {{cred:velho.user}}"}]);
        swap_text(&mut v, "abc123", "{{cred:novo}}"); swap_text(&mut v, "cred:velho}}", "cred:novo}}"); swap_text(&mut v, "cred:velho.", "cred:novo.");
        assert_eq!(v, json!([{"a": "senha {{cred:novo}} aqui {{cred:novo}} {{cred:novo.user}}"}]));
        // conferência: expressão inventada, senha em argumento, token escrito
        let f: Flow = serde_json::from_value(json!({"name":"T","nodes":[
            {"id":"a","type":"trigger.manual","params":{}},
            {"id":"b","type":"util.text","params":{"text":"{{now}} {{input}} {{cred:x}} ghp_abcdefghijklmnopqrstuvwxyz0123456789"}},
            {"id":"c","type":"windows.command","params":{"program":"curl","args":["-u","{{cred:x}}"]}}],
            "edges":[{"from":"a","from_port":"out","to":"b","to_port":"in"},{"from":"b","from_port":"out","to":"c","to_port":"in"}]})).unwrap();
        let p = flow_issues(&f).join("\n");
        for want in ["{{now}} não é uma expressão", "senha não vai em argumento", "há um token escrito"] { assert!(p.contains(want), "faltou: {want}\n{p}"); }
        let g = gen_prompt("oi", Some(&json!({"name":"X","nodes":[]})));
        assert!(g.contains("# Fluxo atual") && g.contains("# Credenciais que já existem") && g.contains("{{cred:token-exemplo}}"));
        // o exemplo do pedido tem que passar na própria conferência
        let ex = GEN_EXAMPLE.split_once("Resposta: ").unwrap().1;
        let (flow, raw) = gen_flow(ex).unwrap();
        assert_eq!(flow_issues(&flow), Vec::<String>::new());
        assert!(raw["notes"].is_array());
    }
    #[test]
    fn dados_em_memoria_acompanham_o_arquivo() {
        // sem arquivo: vazio, e nada fica guardado
        let dir = std::env::temp_dir().join(format!("bs-cache-{}", id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        assert!(stamp_of(&path).is_none());
        std::fs::write(&path, r#"{"flows":[{"id":"x","name":"Um","nodes":[],"edges":[]}]}"#).unwrap();
        let a = stamp_of(&path).unwrap();
        // outro tamanho: o carimbo muda, então quem compara relê
        std::fs::write(&path, r#"{"flows":[{"id":"x","name":"Um e meio","nodes":[],"edges":[]}]}"#).unwrap();
        let b = stamp_of(&path).unwrap();
        assert_ne!(a.1, b.1);
        let s: Store = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(s.clone().flows[0].name, "Um e meio");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn schedule_by_interval_and_by_clock() {
        use chrono::{Datelike, TimeZone, Timelike};
        let mut f = flow();
        f.nodes[0] = serde_json::from_value(json!({"id":"a","type":"trigger.schedule","params":{"mode":"interval","every_minutes":15}})).unwrap();
        assert_eq!(next_fire(&f, 1_000), Some(1_000 + 15 * 60_000));
        // quarta-feira 11/11/2026 10:00 local; agenda às 09:00 de segunda a sexta: a próxima é quinta 09:00
        let from = chrono::Local.with_ymd_and_hms(2026, 11, 11, 10, 0, 0).unwrap();
        f.nodes[0].params = json!({"mode":"daily","time":"09:00","days":[1,2,3,4,5]});
        let next = chrono::Local.timestamp_millis_opt(next_fire(&f, from.timestamp_millis()).unwrap()).unwrap();
        assert_eq!((next.day(), next.hour(), next.minute()), (12, 9, 0));
        // só aos domingos: pula para o dia 15
        f.nodes[0].params = json!({"mode":"daily","time":"23:30","days":[0]});
        let next = chrono::Local.timestamp_millis_opt(next_fire(&f, from.timestamp_millis()).unwrap()).unwrap();
        assert_eq!((next.day(), next.hour(), next.minute()), (15, 23, 30));
        // no mesmo dia, se o horário ainda não passou
        f.nodes[0].params = json!({"mode":"daily","time":"18:00","days":[]});
        let next = chrono::Local.timestamp_millis_opt(next_fire(&f, from.timestamp_millis()).unwrap()).unwrap();
        assert_eq!((next.day(), next.hour()), (11, 18));
        f.nodes[0].params = json!({"mode":"daily","time":"25:00"});
        assert!(validate(&f).is_err());
        // a cada 30 minutos, só de segunda a sexta das 08:00 às 18:00. Quarta 10:00: segue normal
        let at = |x: i64| chrono::Local.timestamp_millis_opt(x).unwrap();
        f.nodes[0].params = json!({"mode":"interval","every_minutes":30,"days":[1,2,3,4,5],"window":"between","from":"08:00","to":"18:00"});
        let next = at(next_fire(&f, from.timestamp_millis()).unwrap());
        assert_eq!((next.day(), next.hour(), next.minute()), (11, 10, 30));
        // quarta 17:50: o próximo cairia às 18:20, fora do horário, então fica para quinta 08:00
        let late = chrono::Local.with_ymd_and_hms(2026, 11, 11, 17, 50, 0).unwrap();
        let next = at(next_fire(&f, late.timestamp_millis()).unwrap());
        assert_eq!((next.day(), next.hour(), next.minute()), (12, 8, 0));
        // sexta 17:50: pula o fim de semana e vai para segunda 08:00
        let fri = chrono::Local.with_ymd_and_hms(2026, 11, 13, 17, 50, 0).unwrap();
        let next = at(next_fire(&f, fri.timestamp_millis()).unwrap());
        assert_eq!((next.day(), next.hour(), next.minute()), (16, 8, 0));
        // só os dias, o dia inteiro: sexta 23:50 + 30 min cai no sábado, vai para segunda 00:00
        f.nodes[0].params = json!({"mode":"interval","every_minutes":30,"days":[1,2,3,4,5],"window":"all"});
        let next = at(next_fire(&f, chrono::Local.with_ymd_and_hms(2026, 11, 13, 23, 50, 0).unwrap().timestamp_millis()).unwrap());
        assert_eq!((next.day(), next.hour(), next.minute()), (16, 0, 0));
        f.nodes[0].params = json!({"mode":"interval","every_minutes":30,"window":"between","from":"8h","to":"18:00"});
        assert!(validate(&f).is_err());
    }
    #[test]
    fn data_e_hora() {
        use chrono::{Datelike, TimeZone, Timelike};
        let when = |t: &str| parse_when(&json!(t)).unwrap();
        let d = when("11/11/2026 10:15");
        assert_eq!((d.year(), d.month(), d.day(), d.hour(), d.minute()), (2026, 11, 11, 10, 15));
        assert_eq!(when("2026-11-11").hour(), 0);
        assert_eq!(when("2026-11-11T10:15:00"), d);
        assert_eq!(parse_when(&json!(d.timestamp_millis())).unwrap(), d);
        assert_eq!(parse_when(&json!(d.timestamp())).unwrap(), d);
        assert!(parse_when(&json!("amanhã")).is_err());
        // dentro do horário: quarta 10:15, de segunda a sexta das 08:00 às 18:00
        let run = |p: Value| { let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap(); rt.block_on(time_node("time.window", &p, json!("x"))).unwrap() };
        let gate = |when: &str, extra: Value| { let mut p = json!({"days":[1,2,3,4,5],"window":"between","from":"08:00","to":"18:00","except":[],"when":when}); p.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap()); run(p) };
        assert_eq!(gate("11/11/2026 10:15", json!({})), json!({"true": "x"}));
        assert_eq!(gate("11/11/2026 18:00", json!({})), json!({"false": "x"}));
        assert_eq!(gate("11/11/2026 07:59", json!({})), json!({"false": "x"}));
        assert_eq!(gate("14/11/2026 10:15", json!({})), json!({"false": "x"}), "sábado");
        assert_eq!(gate("11/11/2026 10:15", json!({"except": ["25/12", "11/11/2026"]})), json!({"false": "x"}), "dia de folga");
        assert_eq!(gate("25/12/2026 10:15", json!({"except": ["25/12"]})), json!({"false": "x"}), "folga de todo ano");
        assert_eq!(gate("14/11/2026 10:15", json!({"days": [], "window": "all"})), json!({"true": "x"}));
        // turno da noite, 22:00 às 06:00, começando de segunda a sexta: sábado 02:00 ainda é o turno de sexta
        let night = json!({"from": "22:00", "to": "06:00"});
        assert_eq!(gate("14/11/2026 02:00", night.clone()), json!({"true": "x"}));
        assert_eq!(gate("14/11/2026 23:00", night.clone()), json!({"false": "x"}), "sábado à noite não começa turno");
        assert_eq!(gate("11/11/2026 12:00", night), json!({"false": "x"}));
        // contas e campos
        let f = time_fields(d);
        assert_eq!((f["weekday"].as_u64(), f["weekday_name"].as_str(), f["weekend"].as_bool(), f["time"].as_str()), (Some(3), Some("quarta"), Some(false), Some("10:15")));
        let jan = chrono::Local.with_ymd_and_hms(2026, 1, 31, 9, 0, 0).unwrap();
        assert_eq!(shift_time(jan, 1, "months").unwrap().day(), 28);
        assert_eq!(shift_time(jan, -2, "days").unwrap().day(), 29);
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let cmp = |p: Value| rt.block_on(time_node("time.compare", &p, json!(1))).unwrap();
        assert_eq!(cmp(json!({"value": "10/11/2026", "op": "before", "other": "11/11/2026"})), json!({"true": 1}));
        assert_eq!(cmp(json!({"value": "01/11/2026", "op": "older", "other": "11/11/2026", "amount": 7, "unit": "days"})), json!({"true": 1}));
        assert_eq!(cmp(json!({"value": "09/11/2026", "op": "newer", "other": "11/11/2026", "amount": 7, "unit": "days"})), json!({"true": 1}));
        assert_eq!(cmp(json!({"value": "11/11/2026 23:00", "op": "same_day", "other": "2026-11-11 01:00"})), json!({"true": 1}));
        let out = rt.block_on(time_node("time.shift", &json!({"value": "31/01/2026", "amount": 1, "unit": "months", "format": "date"}), Value::Null)).unwrap();
        assert_eq!(out, json!({"out": "28/02/2026"}));
    }
    #[tokio::test]
    async fn condition_selects_one_port() {
        let n = Node {
            id: "if".into(),
            kind: "logic.if".into(),
            title: None,
            params: Value::Null,
            position: [0., 0.],
            disabled: false,
            locked: false,
            size: None,
        };
        let out = execute_node(&n, json!({"value":1,"equals":2}), json!("x"))
            .await
            .unwrap();
        assert_eq!(out, json!({"false":"x"}));
    }
}
