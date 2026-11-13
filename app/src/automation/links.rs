//! Nós de conexão do Automator: SSH e SFTP (o OpenSSH do Windows), e-mail por SMTP e IMAP, FTP e MQTT (o curl do
//! Windows), banco de dados (SqlClient e ODBC, pelo PowerShell), Telegram, ping e Wake-on-LAN.
//! Senha nenhuma vai em argumento de programa: o ssh pergunta a este mesmo executável (SSH_ASKPASS), o curl lê a
//! configuração pela entrada padrão e o PowerShell recebe por variável de ambiente. Nos campos, a senha vem de
//! `{{cred:nome}}` (Credenciais do Automator): quem troca pelo valor e o tira da saída é o `run_node`.
use super::{list_of, number_of, stringify, text_of};
use crate::util::*;
use base64::Engine;
use serde_json::{Value, json};
use std::time::Duration;

pub(super) fn catalog() -> Value {
    let cred = "Use {{cred:nome}}, uma credencial do Automator. A senha não fica escrita no fluxo nem aparece no histórico.";
    let host = |ph: &str| json!({"name":"host","label":"Servidor","kind":"text","placeholder":ph});
    let user = json!({"name":"user","label":"Usuário","kind":"text","placeholder":"{{cred:nome.user}} ou o nome"});
    let pass = json!({"name":"password","label":"Senha","kind":"text","placeholder":"{{cred:nome}}","help":cred});
    let timeout = json!({"name":"timeout_s","label":"Tempo limite (segundos)","kind":"number","min":5,"max":3600});
    let ssh_key = json!({"name":"key","label":"Arquivo da chave privada","kind":"text","pick":"file","placeholder":"vazio: senha, ou as chaves da sua pasta .ssh","help":"Com chave, o campo Senha é a senha da chave (vazio se ela não tiver)."});
    json!([
        {"type":"ssh.run","name":"SSH: rodar comando","category":"Conexões","desc":"Entra num servidor por SSH, roda um comando e entrega o que ele escreveu.","inputs":["in"],"outputs":["out"],
         "params":{"host":"","port":22,"user":"","password":"","key":"","command":"uptime","on_fail":"stop","timeout_s":60},
         "fields":[
            host("servidor.exemplo.com ou 192.168.0.10"), {"name":"port","label":"Porta","kind":"number","min":1,"max":65535}, user.clone(), pass.clone(), ssh_key.clone(),
            {"name":"command","label":"Comando","kind":"area","code":"shell","help":"Roda no servidor. Várias linhas valem como um script. Na primeira conexão o servidor é anotado como conhecido; se a identidade dele mudar depois, o nó recusa."},
            {"name":"on_fail","label":"Se o comando sair com erro","kind":"select","options":[{"value":"stop","label":"Parar o fluxo"},{"value":"continue","label":"Seguir e entregar o código de saída"}]},
            timeout.clone()
         ]},
        {"type":"ssh.copy","name":"SSH: enviar ou baixar arquivo","category":"Conexões","desc":"Copia um arquivo ou uma pasta entre este PC e um servidor, por SFTP.","inputs":["in"],"outputs":["out"],
         "params":{"host":"","port":22,"user":"","password":"","key":"","direction":"upload","local":"","remote":"","timeout_s":300},
         "fields":[
            host("servidor.exemplo.com"), {"name":"port","label":"Porta","kind":"number","min":1,"max":65535}, user.clone(), pass.clone(), ssh_key,
            {"name":"direction","label":"Sentido","kind":"select","options":[{"value":"upload","label":"Enviar daqui para o servidor"},{"value":"download","label":"Baixar do servidor para cá"}]},
            {"name":"local","label":"Aqui no PC","kind":"text","pick":"any","placeholder":"C:\\pasta\\arquivo.zip"},
            {"name":"remote","label":"No servidor","kind":"text","placeholder":"/home/usuario/arquivo.zip","help":"Uma pasta é copiada com tudo o que tem dentro."},
            timeout.clone()
         ]},
        {"type":"mail.send","name":"Enviar e-mail","category":"Conexões","desc":"Envia um e-mail por SMTP, com anexos se quiser.","inputs":["in"],"outputs":["out"],
         "params":{"host":"","port":587,"security":"starttls","user":"","password":"","from":"","to":[],"cc":[],"bcc":[],"subject":"","body":"{{input}}","format":"text","attachments":[],"timeout_s":60},
         "fields":[
            host("smtp.gmail.com, smtp.office365.com…"), {"name":"port","label":"Porta","kind":"number","min":1,"max":65535,"help":"587 com STARTTLS ou 465 com SSL, na maioria dos provedores."},
            {"name":"security","label":"Segurança","kind":"select","options":[{"value":"starttls","label":"STARTTLS (porta 587)"},{"value":"ssl","label":"SSL/TLS direto (porta 465)"},{"value":"none","label":"Nenhuma (só em rede interna)"}]},
            user.clone(), {"name":"password","label":"Senha","kind":"text","placeholder":"{{cred:nome}}","help":"Use {{cred:nome}}. No Gmail e no Outlook com verificação em duas etapas, é a \"senha de app\" criada na conta."},
            {"name":"from","label":"De","kind":"text","placeholder":"Nome <voce@exemplo.com>","help":"Vazio: o usuário."},
            {"name":"to","label":"Para","kind":"lines","help":"Um endereço por linha."},
            {"name":"cc","label":"Cópia","kind":"lines"}, {"name":"bcc","label":"Cópia oculta","kind":"lines"},
            {"name":"subject","label":"Assunto","kind":"text"},
            {"name":"body","label":"Mensagem","kind":"area"},
            {"name":"format","label":"Formato","kind":"select","options":[{"value":"text","label":"Texto simples"},{"value":"html","label":"HTML"}]},
            {"name":"attachments","label":"Anexos","kind":"lines","pick":"file","help":"Um arquivo por linha (até 25 MB somados)."},
            timeout.clone()
         ]},
        {"type":"mail.read","name":"Ler e-mails","category":"Conexões","desc":"Busca mensagens de uma caixa de e-mail por IMAP: remetente, assunto, texto e anexos.","inputs":["in"],"outputs":["out"],
         "params":{"host":"","port":993,"security":"ssl","user":"","password":"","folder":"INBOX","which":"unseen","from":"","subject":"","limit":10,"mark":"read","save_dir":"","timeout_s":60},
         "fields":[
            host("imap.gmail.com, outlook.office365.com…"), {"name":"port","label":"Porta","kind":"number","min":1,"max":65535},
            {"name":"security","label":"Segurança","kind":"select","options":[{"value":"ssl","label":"SSL/TLS direto (porta 993)"},{"value":"starttls","label":"STARTTLS (porta 143)"},{"value":"none","label":"Nenhuma (só em rede interna)"}]},
            user.clone(), pass.clone(),
            {"name":"folder","label":"Pasta","kind":"text","placeholder":"INBOX"},
            {"name":"which","label":"Quais","kind":"select","options":[{"value":"unseen","label":"Só as não lidas"},{"value":"all","label":"Todas"}]},
            {"name":"from","label":"Remetente contém","kind":"text","placeholder":"vazio: qualquer um"},
            {"name":"subject","label":"Assunto contém","kind":"text","placeholder":"vazio: qualquer um"},
            {"name":"limit","label":"Até quantas (as mais novas)","kind":"number","min":1,"max":50},
            {"name":"mark","label":"Depois de ler","kind":"select","options":[{"value":"read","label":"Marcar como lida"},{"value":"keep","label":"Deixar como não lida"}]},
            {"name":"save_dir","label":"Salvar os anexos em","kind":"text","pick":"folder","placeholder":"vazio: não salvar"},
            timeout.clone()
         ]},
        {"type":"ftp.files","name":"FTP","category":"Conexões","desc":"Lista, baixa, envia ou apaga arquivos num servidor FTP ou FTPS.","inputs":["in"],"outputs":["out"],
         "params":{"op":"list","protocol":"ftp","host":"","port":21,"user":"","password":"","remote":"/","local":"","verify":"yes","timeout_s":120},
         "fields":[
            {"name":"op","label":"Ação","kind":"select","options":[{"value":"list","label":"Listar uma pasta"},{"value":"download","label":"Baixar um arquivo"},{"value":"upload","label":"Enviar um arquivo"},{"value":"delete","label":"Apagar um arquivo"}]},
            {"name":"protocol","label":"Protocolo","kind":"select","options":[{"value":"ftp","label":"FTP (sem criptografia)"},{"value":"ftps","label":"FTPS explícito (TLS na porta 21)"},{"value":"ftps_implicit","label":"FTPS implícito (porta 990)"}],"help":"Para SFTP, use o nó SSH: enviar ou baixar arquivo."},
            host("ftp.exemplo.com"), {"name":"port","label":"Porta","kind":"number","min":1,"max":65535}, {"name":"user","label":"Usuário","kind":"text","placeholder":"vazio: anônimo"}, pass.clone(),
            {"name":"remote","label":"No servidor","kind":"text","placeholder":"/pasta/arquivo.txt"},
            {"name":"local","label":"Aqui no PC","kind":"text","pick":"any","show":{"op":["download","upload"]},"placeholder":"C:\\pasta\\arquivo.txt"},
            {"name":"verify","label":"Certificado do servidor","kind":"select","show":{"protocol":["ftps","ftps_implicit"]},"options":[{"value":"yes","label":"Conferir"},{"value":"no","label":"Aceitar qualquer um (autoassinado)"}]},
            timeout.clone()
         ]},
        {"type":"db.query","name":"Banco de dados (SQL)","category":"Conexões","desc":"Roda uma consulta ou um comando SQL e entrega as linhas.","inputs":["in"],"outputs":["out"],
         "params":{"kind":"sqlserver","server":"","database":"","user":"","password":"","trust":"no","connection":"","sql":"SELECT 1 AS ok","values":[],"max_rows":1000,"timeout_s":60},
         "fields":[
            {"name":"kind","label":"Banco","kind":"select","options":[{"value":"sqlserver","label":"SQL Server"},{"value":"odbc","label":"Outro, por ODBC (MySQL, PostgreSQL, Oracle, Access…)"}]},
            {"name":"server","label":"Servidor","kind":"text","show":{"kind":["sqlserver"]},"placeholder":"servidor\\instancia ou servidor,1433"},
            {"name":"database","label":"Banco","kind":"text","show":{"kind":["sqlserver"]}},
            {"name":"user","label":"Usuário","kind":"text","show":{"kind":["sqlserver"]},"placeholder":"vazio: a sua conta do Windows"},
            {"name":"password","label":"Senha","kind":"text","show":{"kind":["sqlserver"]},"placeholder":"{{cred:nome}}","help":cred},
            {"name":"trust","label":"Certificado do servidor","kind":"select","show":{"kind":["sqlserver"]},"options":[{"value":"no","label":"Conferir"},{"value":"yes","label":"Confiar sem conferir"}]},
            {"name":"connection","label":"Texto de conexão ODBC","kind":"area","show":{"kind":["odbc"]},"placeholder":"Driver={MySQL ODBC 8.0 Unicode Driver};Server=…;Database=…;Uid=…;Pwd={{cred:nome}};","help":"O driver ODBC do banco precisa estar instalado no Windows (64 bits). Também vale DSN=nome."},
            {"name":"sql","label":"SQL","kind":"area","code":"sql","help":"Valores que vêm de fora vão em Valores, não colados no SQL: no SQL Server use @p1, @p2…; no ODBC, um ? para cada um."},
            {"name":"values","label":"Valores","kind":"lines","help":"Um por linha, na ordem."},
            {"name":"max_rows","label":"Até quantas linhas","kind":"number","min":1,"max":100000},
            timeout.clone()
         ]},
        {"type":"mqtt.publish","name":"MQTT: publicar","category":"Conexões","desc":"Publica uma mensagem num tópico de um servidor MQTT (automação residencial, IoT).","inputs":["in"],"outputs":["out"],
         "params":{"host":"","port":1883,"security":"none","user":"","password":"","topic":"","message":"{{input}}","timeout_s":20},
         "fields":[
            host("192.168.0.20"), {"name":"port","label":"Porta","kind":"number","min":1,"max":65535},
            {"name":"security","label":"Segurança","kind":"select","options":[{"value":"none","label":"Nenhuma (porta 1883)"},{"value":"ssl","label":"TLS (porta 8883)"}]},
            {"name":"user","label":"Usuário","kind":"text","placeholder":"vazio: sem login"}, pass.clone(),
            {"name":"topic","label":"Tópico","kind":"text","placeholder":"casa/sala/luz"},
            {"name":"message","label":"Mensagem","kind":"area"},
            timeout.clone()
         ]},
        {"type":"notify.telegram","name":"Mensagem no Telegram","category":"Conexões","desc":"Manda uma mensagem por um bot do Telegram: um aviso no seu celular.","inputs":["in"],"outputs":["out"],
         "params":{"token":"","chat":"","text":"{{input}}"},
         "fields":[
            {"name":"token","label":"Token do bot","kind":"text","placeholder":"{{cred:telegram}}","help":"Crie o bot com o @BotFather e guarde o token em Credenciais."},
            {"name":"chat","label":"Conversa","kind":"text","placeholder":"o número do chat, ou @canal","help":"O seu número aparece ao mandar uma mensagem para o bot @userinfobot. Antes, mande um oi para o seu bot."},
            {"name":"text","label":"Mensagem","kind":"area"}
         ]},
        {"type":"net.ping","name":"Ping","category":"Conexões","desc":"Segue por sim se o computador ou servidor responde na rede.","inputs":["in"],"outputs":["true","false"],
         "params":{"host":"","count":2},
         "fields":[host("192.168.0.1 ou servidor.exemplo.com"), {"name":"count","label":"Tentativas","kind":"number","min":1,"max":10}]},
        {"type":"net.wol","name":"Ligar computador pela rede","category":"Conexões","desc":"Manda o sinal de Wake-on-LAN para ligar um computador da sua rede.","inputs":["in"],"outputs":["out"],
         "params":{"mac":"","broadcast":"255.255.255.255","port":9},
         "fields":[
            {"name":"mac","label":"Endereço MAC","kind":"text","placeholder":"AA:BB:CC:DD:EE:FF","help":"O da placa de rede do computador a ligar, que precisa estar com Wake-on-LAN ativado."},
            {"name":"broadcast","label":"Enviar para","kind":"text","help":"O endereço de difusão da rede. 255.255.255.255 serve na maioria das redes de casa."},
            {"name":"port","label":"Porta","kind":"number","min":1,"max":65535}
         ]},
    ])
}
pub(super) fn io_doc(kind: &str) -> Option<(&'static str, &'static str, Value)> {
    let any = "Qualquer dado, para usar nos campos com {{input}}.";
    Some(match kind {
        "ssh.run" => (any, "Objeto com o que o comando escreveu e o código de saída.", json!({"out": "texto que o comando escreveu", "err": "", "code": 0, "ok": true})),
        "ssh.copy" => (any, "Objeto com os dois caminhos.", json!({"local": "C:\\pasta\\arquivo.zip", "remote": "/home/usuario/arquivo.zip", "direction": "upload"})),
        "mail.send" => ("Qualquer dado, para usar no assunto e na mensagem.", "Objeto com o que foi enviado.", json!({"sent": true, "to": ["ana@exemplo.com"], "subject": "Relatório", "attachments": 1})),
        "mail.read" => ("Nada em especial.", "Lista de mensagens, da mais nova para a mais antiga.",
            json!([{"uid": 4812, "from": "Ana <ana@exemplo.com>", "from_email": "ana@exemplo.com", "to": "voce@exemplo.com", "subject": "Nota fiscal", "date": "2026-11-12T09:30:00-03:00", "text": "Segue a nota.", "html": "", "attachments": [{"name": "nota.pdf", "size": 48211, "path": "C:\\Notas\\nota.pdf"}]}])),
        "ftp.files" => (any, "Listar: lista com os nomes. Baixar e enviar: objeto com os caminhos. Apagar: objeto com o que saiu.", json!({"op": "download", "remote": "/pasta/arquivo.txt", "local": "C:\\pasta\\arquivo.txt"})),
        "db.query" => ("Qualquer dado, para usar nos Valores.", "Objeto com as linhas (cada uma um objeto, com os nomes das colunas) e quantas linhas o comando alterou.", json!({"rows": [{"id": 1, "nome": "Ana"}], "count": 1, "affected": -1, "more": false})),
        "mqtt.publish" => ("Qualquer dado, para usar na mensagem.", "Objeto com o tópico e a mensagem publicada.", json!({"topic": "casa/sala/luz", "message": "on"})),
        "notify.telegram" => ("Qualquer dado, para usar na mensagem.", "A mesma entrada, sem mudar.", Value::Null),
        "net.ping" => ("Nada em especial.", "Objeto com o teste, pela saída sim (respondeu) ou não.", json!({"host": "192.168.0.1", "alive": true, "ms": 3, "sent": 2, "received": 2})),
        "net.wol" => ("Qualquer dado.", "Objeto com o endereço para onde o sinal foi.", json!({"mac": "AA:BB:CC:DD:EE:FF", "sent_to": "255.255.255.255:9"})),
        _ => return None,
    })
}
pub(super) fn io_kind(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "mail.read" => ("any", "list"),
        "notify.telegram" => ("any", "same"),
        "ssh.run" | "ssh.copy" | "mail.send" | "ftp.files" | "db.query" | "mqtt.publish" | "net.ping" | "net.wol" => ("any", "object"),
        _ => return None,
    })
}

// ---------- o que os nós têm em comum ----------
struct Out { code: i32, out: Vec<u8>, err: String }
fn lossy(b: &[u8]) -> String { String::from_utf8_lossy(b).into_owned() }
/// Roda um programa sem janela, com tempo limite. Cancelar o fluxo solta este futuro, e o programa é finalizado.
async fn exec(program: &str, args: &[String], env: &[(&str, String)], stdin: Option<Vec<u8>>, secs: u64) -> ApiResult<Out> {
    use tokio::io::AsyncWriteExt;
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (k, v) in env { cmd.env(k, v); }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| fail(format!("não deu para abrir {program}: {e}"), 500))?;
    if let (Some(s), Some(mut w)) = (stdin, child.stdin.take()) { tokio::spawn(async move { let _ = w.write_all(&s).await; let _ = w.shutdown().await; }); }
    match tokio::time::timeout(Duration::from_secs(secs), child.wait_with_output()).await {
        Ok(Ok(o)) => Ok(Out { code: o.status.code().unwrap_or(-1), out: o.stdout, err: lossy(&o.stderr).trim().to_string() }),
        Ok(Err(e)) => Err(fail(format!("{program}: {e}"), 500)),
        Err(_) => Err(fail(format!("passou do tempo limite de {secs} s"), 408)),
    }
}
/// Um programa que vem com o Windows, pelo caminho completo (o PATH pode ter outro de mesmo nome na frente).
fn system_tool(sub: &str, name: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let p = std::path::Path::new(&root).join("System32").join(sub).join(name);
    if p.is_file() { p.to_string_lossy().into_owned() } else { name.trim_end_matches(".exe").to_string() }
}
fn need(p: &Value, k: &str, what: &str) -> ApiResult<String> {
    let t = text_of(p, k);
    let t = t.trim();
    if t.is_empty() { Err(fail(format!("informe {what}"), 400)) } else { Ok(t.to_string()) }
}
/// Nome de servidor: sem espaço, sem começar por hífen (viraria opção do programa) e sem caracteres de comando.
fn host_of(p: &Value) -> ApiResult<String> {
    let h = need(p, "host", "o servidor")?;
    if h.starts_with('-') || !h.chars().all(|c| c.is_alphanumeric() || ".-_:[]".contains(c)) { return Err(fail(format!("servidor inválido: {h}"), 400)); }
    Ok(h)
}
fn port_of(p: &Value, default: u16) -> ApiResult<u16> {
    match &p["port"] { Value::Null => Ok(default), Value::String(s) if s.trim().is_empty() => Ok(default),
        v => number_of(v).filter(|n| (1.0..=65535.0).contains(n) && n.fract() == 0.0).map(|n| n as u16).ok_or_else(|| fail("a porta vai de 1 a 65535", 400)) }
}
fn secs_of(p: &Value, default: u64) -> u64 { number_of(&p["timeout_s"]).map(|n| n as u64).unwrap_or(default).clamp(5, 3600) }
/// Itens de um campo de lista: uma lista de verdade, ou texto separado por linha, vírgula ou ponto e vírgula.
fn items(v: &Value) -> Vec<String> {
    list_of(v).iter().flat_map(|x| stringify(x).split(['\n', ',', ';']).map(|s| s.trim().to_string()).collect::<Vec<_>>()).filter(|s| !s.is_empty()).collect()
}

// ---------- SSH e SFTP (OpenSSH do Windows) ----------
/// As opções comuns ao ssh e ao scp, as variáveis de ambiente (a senha vai por aqui: o ssh pergunta a este mesmo
/// executável, que responde com o valor de BLUESCREEN_ASKPASS e sai; ver main.rs) e o destino `usuario@servidor`.
fn ssh_base(p: &Value, scp: bool) -> ApiResult<(Vec<String>, Vec<(&'static str, String)>, String)> {
    let host = host_of(p)?;
    let user = text_of(p, "user").trim().to_string();
    if user.starts_with('-') || user.chars().any(|c| c.is_whitespace() || "@:/\\\"'`$;&|<>".contains(c)) { return Err(fail("usuário inválido", 400)); }
    let (pass, key) = (text_of(p, "password"), text_of(p, "key").trim().trim_matches('"').to_string());
    let mut a: Vec<String> = vec![if scp { "-P" } else { "-p" }.into(), port_of(p, 22)?.to_string()];
    for o in ["StrictHostKeyChecking=accept-new", "ConnectTimeout=15", "ServerAliveInterval=15", "ServerAliveCountMax=4"] { a.push("-o".into()); a.push(o.into()); }
    if !key.is_empty() {
        if !std::path::Path::new(&key).is_file() { return Err(fail(format!("não achei o arquivo da chave: {key}"), 400)); }
        a.extend(["-i".into(), key.clone(), "-o".into(), "IdentitiesOnly=yes".into()]);
    }
    let mut env = vec![];
    if pass.is_empty() {
        a.extend(["-o".into(), "BatchMode=yes".into()]);
    } else {
        let exe = std::env::current_exe().map_err(|e| fail(format!("não achei o executável: {e}"), 500))?;
        env.extend([("SSH_ASKPASS", exe.to_string_lossy().into_owned()), ("SSH_ASKPASS_REQUIRE", "force".into()), ("DISPLAY", "bluescreen:0".into()), ("BLUESCREEN_ASKPASS", pass)]);
        a.extend(["-o".into(), "NumberOfPasswordPrompts=1".into()]);
        if key.is_empty() { a.extend(["-o".into(), "PubkeyAuthentication=no".into(), "-o".into(), "PreferredAuthentications=password,keyboard-interactive".into()]); }
    }
    Ok((a, env, if user.is_empty() { host } else { format!("{user}@{host}") }))
}
/// O erro do ssh em português, quando dá para reconhecer; senão, o que ele disse.
fn ssh_error(err: &str, code: i32) -> ApiError {
    let low = err.to_lowercase();
    let why = if low.contains("permission denied") { "o servidor recusou o login: confira o usuário e a senha (ou a chave)".to_string() }
        else if low.contains("host key verification failed") || low.contains("remote host identification has changed") { "a identidade do servidor mudou desde a última conexão. Se a troca foi feita por você (servidor reinstalado), tire a linha dele do arquivo known_hosts da sua pasta .ssh.".to_string() }
        else if low.contains("could not resolve hostname") { "não achei esse servidor: confira o nome".to_string() }
        else if low.contains("connection refused") { "o servidor recusou a conexão: confira a porta e se o SSH está ligado nele".to_string() }
        else if low.contains("timed out") { "o servidor não respondeu: confira o endereço, a porta e o firewall".to_string() }
        else if low.contains("no such file or directory") { format!("arquivo ou pasta não existe: {}", err.lines().last().unwrap_or("")) }
        else if err.is_empty() { format!("saiu com código {code}") } else { err.lines().filter(|l| !l.starts_with("Warning: Permanently added")).collect::<Vec<_>>().join("\n").chars().take(1500).collect() };
    fail(why, 422)
}
async fn ssh_run(p: &Value) -> ApiResult<Value> {
    let (mut args, env, target) = ssh_base(p, false)?;
    let command = need(p, "command", "o comando")?;
    args.extend(["-T".into(), target, command.replace("\r\n", "\n")]);
    let o = exec(&system_tool("OpenSSH", "ssh.exe"), &args, &env, None, secs_of(p, 60)).await?;
    let out = lossy(&o.out).trim_end().to_string();
    // 255 é o código do próprio ssh (não conectou, login recusado); o resto é o código do comando no servidor
    if o.code == 255 { return Err(ssh_error(&o.err, o.code)); }
    let err: String = o.err.lines().filter(|l| !l.starts_with("Warning: Permanently added")).collect::<Vec<_>>().join("\n");
    if o.code != 0 && p["on_fail"] != "continue" {
        let said = if err.trim().is_empty() { out.clone() } else { err.clone() };
        return Err(fail(format!("o comando saiu com código {}{}", o.code, if said.trim().is_empty() { String::new() } else { format!(": {}", said.trim().chars().take(1500).collect::<String>()) }), 422));
    }
    Ok(json!({"out": out, "err": err, "code": o.code, "ok": o.code == 0}))
}
async fn ssh_copy(p: &Value) -> ApiResult<Value> {
    let (mut args, env, target) = ssh_base(p, true)?;
    let local = need(p, "local", "o caminho aqui no PC")?.trim_matches('"').to_string();
    let remote = need(p, "remote", "o caminho no servidor")?;
    let up = p["direction"] != "download";
    let there = format!("{target}:{remote}");
    if up {
        let path = std::path::Path::new(&local);
        if !path.exists() { return Err(fail(format!("não achei {local}"), 400)); }
        if path.is_dir() { args.push("-r".into()); }
        args.extend([local.clone(), there]);
    } else {
        if let Some(dir) = std::path::Path::new(&local).parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(dir)?; }
        args.extend(["-r".into(), there, local.clone()]);
    }
    let o = exec(&system_tool("OpenSSH", "scp.exe"), &args, &env, None, secs_of(p, 300)).await?;
    if o.code != 0 { return Err(ssh_error(&o.err, o.code)); }
    Ok(json!({"local": local, "remote": remote, "direction": if up { "upload" } else { "download" }}))
}

// ---------- curl (SMTP, IMAP, FTP, MQTT) ----------
/// Um valor entre aspas para o arquivo de configuração do curl. Quebra de linha viraria outra opção: é recusada.
fn cq(s: &str) -> ApiResult<String> {
    if s.contains(['\n', '\r', '\0']) { return Err(fail("um dos campos tem quebra de linha onde não pode", 400)); }
    Ok(format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
}
fn login(p: &Value) -> ApiResult<Option<String>> {
    let (user, pass) = (text_of(p, "user").trim().to_string(), text_of(p, "password"));
    if user.is_empty() { return Ok(None); }
    if user.contains(':') { return Err(fail("o usuário não pode ter dois-pontos", 400)); }
    Ok(Some(format!("user = {}\n", cq(&format!("{user}:{pass}"))?)))
}
/// Roda o curl com a configuração pela entrada padrão (endereço, usuário e senha não aparecem na lista de processos).
async fn curl(config: String, secs: u64, what: &str) -> ApiResult<Vec<u8>> {
    let config = format!("silent\nshow-error\nconnect-timeout = 20\nmax-time = {secs}\n{config}");
    let o = exec(&system_tool("", "curl.exe"), &["-q".into(), "-K".into(), "-".into()], &[], Some(config.into_bytes()), secs + 10).await?;
    if o.code == 0 { return Ok(o.out); }
    let why = match o.code {
        6 => "não achei esse servidor: confira o nome",
        7 => "o servidor recusou a conexão: confira o endereço e a porta",
        28 => "o servidor não respondeu a tempo",
        35 | 4 => "a conexão segura (TLS) não fechou: confira a opção de segurança e a porta",
        60 | 51 => "o certificado do servidor não passou na conferência",
        67 => "o servidor recusou o login: confira o usuário e a senha",
        9 | 78 | 19 => "arquivo ou pasta não existe no servidor, ou sem permissão",
        25 | 63 => "o servidor recusou o envio do arquivo",
        55 | 56 => "a conexão caiu no meio",
        _ => "",
    };
    let said = o.err.trim_start_matches("curl: ").trim();
    Err(fail(if why.is_empty() { format!("{what}: {said}") } else { format!("{what}: {why} ({said})") }, 422))
}
/// Cabeçalho com acento vira =?UTF-8?B?...?= (RFC 2047).
fn mime_word(s: &str) -> String {
    if s.is_ascii() { s.to_string() } else { format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(s)) }
}
/// "Nome <a@b>" ou "a@b" -> (cabeçalho, endereço).
fn address(s: &str) -> ApiResult<(String, String)> {
    let s = s.trim();
    let (name, addr) = match (s.rfind('<'), s.rfind('>')) { (Some(a), Some(b)) if a < b => (s[..a].trim().trim_matches('"'), s[a + 1..b].trim()), _ => ("", s) };
    if addr.is_empty() || !addr.contains('@') || addr.chars().any(|c| c.is_whitespace() || "<>\"".contains(c)) { return Err(fail(format!("endereço de e-mail inválido: {s}"), 400)); }
    Ok((if name.is_empty() { addr.to_string() } else { format!("{} <{addr}>", mime_word(name)) }, addr.to_string()))
}
fn b64_lines(data: &[u8]) -> String {
    let e = base64::engine::general_purpose::STANDARD.encode(data);
    e.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join("\r\n")
}
async fn mail_send(p: &Value) -> ApiResult<Value> {
    let host = host_of(p)?;
    let security = p["security"].as_str().unwrap_or("starttls");
    let port = port_of(p, if security == "ssl" { 465 } else { 587 })?;
    let user = text_of(p, "user").trim().to_string();
    let from_raw = { let f = text_of(p, "from"); if f.trim().is_empty() { user.clone() } else { f } };
    let (from_h, from_a) = address(&from_raw).map_err(|_| fail("informe o remetente (campo De) com um endereço de e-mail", 400))?;
    let mut rcpt = vec![];
    let mut heads = vec![format!("From: {from_h}")];
    for (k, label) in [("to", "To"), ("cc", "Cc"), ("bcc", "")] {
        let list = items(&p[k]).iter().map(|x| address(x)).collect::<ApiResult<Vec<_>>>()?;
        if !label.is_empty() && !list.is_empty() { heads.push(format!("{label}: {}", list.iter().map(|x| x.0.clone()).collect::<Vec<_>>().join(", "))); }
        rcpt.extend(list.into_iter().map(|x| x.1));
    }
    if rcpt.is_empty() { return Err(fail("informe pelo menos um destinatário em Para", 400)); }
    let subject = text_of(p, "subject").replace(['\r', '\n'], " ");
    let stamp = format!("{}.{}", super::now(), super::id());
    heads.push(format!("Subject: {}", mime_word(subject.trim())));
    heads.push(format!("Date: {}", chrono::Local::now().to_rfc2822()));
    heads.push(format!("Message-ID: <{stamp}@{}>", from_a.rsplit('@').next().unwrap_or("bluescreen")));
    heads.push("MIME-Version: 1.0".into());
    let body = text_of(p, "body");
    let text_part = format!("Content-Type: text/{}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n", if p["format"] == "html" { "html" } else { "plain" }, b64_lines(body.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes()));
    let files = items(&p["attachments"]);
    let mut msg = heads.join("\r\n");
    if files.is_empty() { msg.push_str("\r\n"); msg.push_str(&text_part); } else {
        let bound = format!("bs-{stamp}");
        msg.push_str(&format!("\r\nContent-Type: multipart/mixed; boundary=\"{bound}\"\r\n\r\n--{bound}\r\n{text_part}"));
        let mut total = 0u64;
        for f in &files {
            let path = std::path::Path::new(f.trim_matches('"'));
            let data = std::fs::read(path).map_err(|e| fail(format!("anexo {f}: {e}"), 400))?;
            total += data.len() as u64;
            if total > 25 * 1024 * 1024 { return Err(fail("os anexos passam de 25 MB somados", 400)); }
            let name = mime_word(&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "anexo".into()).replace('"', ""));
            msg.push_str(&format!("--{bound}\r\nContent-Type: application/octet-stream; name=\"{name}\"\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n", b64_lines(&data)));
        }
        msg.push_str(&format!("--{bound}--\r\n"));
    }
    let file = std::env::temp_dir().join(format!("bluescreen-mail-{}.eml", super::id()));
    std::fs::write(&file, msg)?;
    let mut cfg = format!("url = {}\n", cq(&format!("{}://{host}:{port}", if security == "ssl" { "smtps" } else { "smtp" }))?);
    if security == "starttls" { cfg.push_str("ssl-reqd\n"); }
    if let Some(u) = login(p)? { cfg.push_str(&u); }
    cfg.push_str(&format!("mail-from = {}\n", cq(&format!("<{from_a}>"))?));
    for r in &rcpt { cfg.push_str(&format!("mail-rcpt = {}\n", cq(&format!("<{r}>"))?)); }
    cfg.push_str(&format!("upload-file = {}\n", cq(&file.to_string_lossy())?));
    let r = curl(cfg, secs_of(p, 60), "o envio do e-mail falhou").await;
    let _ = std::fs::remove_file(&file);
    r?;
    Ok(json!({"sent": true, "to": rcpt, "subject": subject.trim(), "attachments": files.len()}))
}

// ---------- ler e-mail: o suficiente do formato MIME para remetente, assunto, texto e anexos ----------
/// Bytes num conjunto de caracteres para texto. UTF-8 e os latinos (os que aparecem em e-mail daqui).
fn decode_text(b: &[u8], charset: &str) -> String {
    let c = charset.trim().trim_matches('"').to_lowercase();
    if c.contains("8859") || c.contains("1252") || c == "latin1" || c == "us-ascii" && b.iter().any(|x| *x > 127) {
        // windows-1252 nos pontos em que difere do latin-1 (aspas curvas, travessão, euro)
        const HI: [char; 32] = ['€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ'];
        return b.iter().map(|x| if (0x80..0xA0).contains(x) { HI[(*x - 0x80) as usize] } else { *x as char }).collect();
    }
    lossy(b)
}
fn qp_decode(b: &[u8], header: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'=' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => { out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("3D"), 16).unwrap_or(b'=')); i += 3; }
            b'=' if b.get(i + 1) == Some(&b'\r') && b.get(i + 2) == Some(&b'\n') => i += 3,
            b'=' if b.get(i + 1) == Some(&b'\n') => i += 2,
            b'_' if header => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    out
}
fn b64_decode(b: &[u8]) -> Vec<u8> {
    let clean: Vec<u8> = b.iter().copied().filter(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/').collect();
    base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean).unwrap_or_default()
}
/// =?charset?B?...?= e =?charset?Q?...?= dentro de um cabeçalho.
fn decode_words(s: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"=\?([^?]+)\?([bBqQ])\?([^?]*)\?=").unwrap());
    // palavras codificadas vizinhas se juntam sem o espaço que as separa
    static GAP: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\?=\s+=\?").unwrap());
    let s = GAP.replace_all(s, "?==?");
    RE.replace_all(&s, |c: &regex::Captures| {
        let bytes = if c[2].eq_ignore_ascii_case("b") { b64_decode(c[3].as_bytes()) } else { qp_decode(c[3].as_bytes(), true) };
        decode_text(&bytes, &c[1])
    }).into_owned()
}
/// Parâmetro de um cabeçalho: `boundary="x"`, `charset=utf-8`, `filename="a.pdf"`.
fn header_param(value: &str, name: &str) -> Option<String> {
    let low = value.to_lowercase();
    let mut from = 0;
    while let Some(i) = low[from..].find(&format!("{name}=")) {
        let at = from + i;
        // tem que ser o nome inteiro (name= não é filename=)
        if at == 0 || !low.as_bytes()[at - 1].is_ascii_alphanumeric() {
            let rest = &value[at + name.len() + 1..];
            let v = if let Some(r) = rest.strip_prefix('"') { r.split('"').next().unwrap_or("") } else { rest.split([';', ' ', '\t']).next().unwrap_or("") };
            return Some(decode_words(v.trim()));
        }
        from = at + name.len() + 1;
    }
    None
}
struct Part { headers: Vec<(String, String)>, body: Vec<u8> }
impl Part {
    fn parse(raw: &[u8]) -> Part {
        let cut = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, i + 4)).or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|i| (i, i + 2))).unwrap_or((raw.len(), raw.len()));
        let mut headers: Vec<(String, String)> = vec![];
        for line in lossy(&raw[..cut.0]).replace("\r\n", "\n").split('\n') {
            if line.starts_with([' ', '\t']) { if let Some(last) = headers.last_mut() { last.1.push(' '); last.1.push_str(line.trim()); } }
            else if let Some((k, v)) = line.split_once(':') { headers.push((k.trim().to_lowercase(), v.trim().to_string())); }
        }
        Part { headers, body: raw[cut.1..].to_vec() }
    }
    fn header(&self, k: &str) -> &str { self.headers.iter().find(|h| h.0 == k).map(|h| h.1.as_str()).unwrap_or("") }
    fn content(&self) -> Vec<u8> {
        match self.header("content-transfer-encoding").trim().to_lowercase().as_str() { "base64" => b64_decode(&self.body), "quoted-printable" => qp_decode(&self.body, false), _ => self.body.clone() }
    }
    fn children(&self) -> Vec<Part> {
        let Some(b) = header_param(self.header("content-type"), "boundary") else { return vec![] };
        let mark = format!("--{b}").into_bytes();
        let mut cuts = vec![];
        let mut i = 0;
        while let Some(p) = self.body[i..].windows(mark.len()).position(|w| w == mark.as_slice()) { cuts.push(i + p); i += p + mark.len(); }
        cuts.windows(2).map(|w| { let seg = &self.body[w[0] + mark.len()..w[1]]; let seg = seg.strip_prefix(b"\r\n").or_else(|| seg.strip_prefix(b"\n")).unwrap_or(seg); Part::parse(seg.strip_suffix(b"\r\n").or_else(|| seg.strip_suffix(b"\n")).unwrap_or(seg)) }).collect()
    }
}
/// Uma mensagem inteira (RFC 822) em campos. Com `save_dir`, os anexos são gravados lá.
pub(super) fn parse_mail(raw: &[u8], save_dir: Option<&std::path::Path>) -> ApiResult<Value> {
    let root = Part::parse(raw);
    let (mut text, mut html, mut files) = (String::new(), String::new(), vec![]);
    let mut stack = vec![root];
    let mut head = None;
    while let Some(part) = stack.pop() {
        if head.is_none() { head = Some(part.headers.clone()); }
        let ctype = part.header("content-type").to_string();
        let kind = ctype.split(';').next().unwrap_or("").trim().to_lowercase();
        if kind.starts_with("multipart/") { let mut kids = part.children(); kids.reverse(); stack.extend(kids); continue; }
        let disp = part.header("content-disposition").to_string();
        let name = header_param(&disp, "filename").or_else(|| header_param(&ctype, "name"));
        if name.is_some() || disp.to_lowercase().starts_with("attachment") {
            let data = part.content();
            let clean: String = name.unwrap_or_else(|| "anexo".into()).chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
            let mut item = json!({"name": clean, "size": data.len()});
            if let Some(dir) = save_dir {
                std::fs::create_dir_all(dir)?;
                // não escreve por cima: nota.pdf, nota (2).pdf…
                let (stem, ext) = match clean.rsplit_once('.') { Some((a, b)) if !a.is_empty() => (a.to_string(), format!(".{b}")), _ => (clean.clone(), String::new()) };
                let mut path = dir.join(&clean);
                let mut k = 2;
                while path.exists() { path = dir.join(format!("{stem} ({k}){ext}")); k += 1; }
                std::fs::write(&path, &data)?;
                item["path"] = json!(path.to_string_lossy());
            }
            files.push(item);
        } else if kind == "text/html" && html.is_empty() {
            html = decode_text(&part.content(), &header_param(&ctype, "charset").unwrap_or_default());
        } else if (kind == "text/plain" || kind.is_empty()) && text.is_empty() {
            text = decode_text(&part.content(), &header_param(&ctype, "charset").unwrap_or_default());
        }
    }
    if text.trim().is_empty() && !html.is_empty() {
        static TAG: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?is)<(script|style)[^>]*>.*?</(script|style)>|<[^>]+>").unwrap());
        let t = html.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n").replace("</p>", "\n").replace("</div>", "\n");
        text = TAG.replace_all(&t, "").replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"");
    }
    let head = head.unwrap_or_default();
    let h = |k: &str| decode_words(head.iter().find(|x| x.0 == k).map(|x| x.1.as_str()).unwrap_or(""));
    let from = h("from");
    let from_email = match (from.rfind('<'), from.rfind('>')) { (Some(a), Some(b)) if a < b => from[a + 1..b].trim().to_string(), _ => from.trim().to_string() };
    let date = h("date");
    let iso = chrono::DateTime::parse_from_rfc2822(date.split(" (").next().unwrap_or("").trim()).map(|d| d.with_timezone(&chrono::Local).to_rfc3339_opts(chrono::SecondsFormat::Secs, false)).unwrap_or(date);
    Ok(json!({"from": from, "from_email": from_email, "to": h("to"), "cc": h("cc"), "subject": h("subject"), "date": iso, "text": text.replace("\r\n", "\n").trim(), "html": html, "attachments": files}))
}
async fn mail_read(p: &Value) -> ApiResult<Value> {
    let host = host_of(p)?;
    let security = p["security"].as_str().unwrap_or("ssl");
    let port = port_of(p, if security == "ssl" { 993 } else { 143 })?;
    let auth = login(p)?.ok_or_else(|| fail("informe o usuário da caixa de e-mail", 400))?;
    let folder = { let f = text_of(p, "folder"); if f.trim().is_empty() { "INBOX".to_string() } else { f.trim().to_string() } };
    let base = format!("{}://{host}:{port}/{}", if security == "ssl" { "imaps" } else { "imap" }, urlencoding::encode(&folder));
    let common = format!("{}{auth}", if security == "starttls" { "ssl-reqd\n" } else { "" });
    let secs = secs_of(p, 60);
    let mut search = String::from(if p["which"] == "all" { "ALL" } else { "UNSEEN" });
    for (k, word) in [("from", "FROM"), ("subject", "SUBJECT")] {
        let t = text_of(p, k);
        let t = t.trim();
        if t.is_empty() { continue; }
        if !t.is_ascii() || t.contains(['"', '\\']) { return Err(fail(format!("no filtro \"{}\", use um trecho sem acentos nem aspas", if k == "from" { "Remetente contém" } else { "Assunto contém" }), 400)); }
        search.push_str(&format!(" {word} \"{t}\""));
    }
    let found = curl(format!("url = {}\n{common}request = {}\n", cq(&base)?, cq(&format!("UID SEARCH {search}"))?), secs, "não deu para abrir a caixa de e-mail").await?;
    let mut uids: Vec<u64> = lossy(&found).lines().filter(|l| l.to_uppercase().starts_with("* SEARCH")).flat_map(|l| l.split_whitespace().skip(2).filter_map(|x| x.parse().ok()).collect::<Vec<u64>>()).collect();
    uids.sort_unstable();
    let limit = number_of(&p["limit"]).unwrap_or(10.0).clamp(1.0, 50.0) as usize;
    let dir = { let d = text_of(p, "save_dir"); let d = d.trim().trim_matches('"').to_string(); (!d.is_empty()).then(|| std::path::PathBuf::from(d)) };
    let mut out = vec![];
    for uid in uids.into_iter().rev().take(limit) {
        let raw = curl(format!("url = {}\n{common}", cq(&format!("{base}/;UID={uid}"))?), secs, "não deu para ler a mensagem").await?;
        let mut m = parse_mail(&raw, dir.as_deref())?;
        m["uid"] = json!(uid);
        out.push(m);
        // ler a mensagem inteira marca como lida; quem pediu para deixar como estava tem a marca tirada
        if p["mark"] == "keep" { let _ = curl(format!("url = {}\n{common}request = {}\n", cq(&base)?, cq(&format!("UID STORE {uid} -FLAGS (\\Seen)"))?), secs, "").await; }
    }
    Ok(json!(out))
}

async fn ftp(p: &Value) -> ApiResult<Value> {
    let host = host_of(p)?;
    let proto = p["protocol"].as_str().unwrap_or("ftp");
    let port = port_of(p, if proto == "ftps_implicit" { 990 } else { 21 })?;
    let op = p["op"].as_str().unwrap_or("list");
    let remote = text_of(p, "remote").trim().replace('\\', "/");
    let enc = |path: &str| path.split('/').map(|s| urlencoding::encode(s).into_owned()).collect::<Vec<_>>().join("/");
    let root = format!("{}://{host}:{port}/", if proto == "ftps_implicit" { "ftps" } else { "ftp" });
    let mut cfg = String::new();
    if proto == "ftps" { cfg.push_str("ssl-reqd\n"); }
    if proto != "ftp" && p["verify"] == "no" { cfg.push_str("insecure\n"); }
    if let Some(u) = login(p)? { cfg.push_str(&u); }
    let secs = secs_of(p, 120);
    let rel = remote.trim_start_matches('/');
    let local = text_of(p, "local").trim().trim_matches('"').to_string();
    match op {
        "list" => {
            let dir = if rel.is_empty() || rel.ends_with('/') { rel.to_string() } else { format!("{rel}/") };
            let out = curl(format!("{cfg}url = {}\nlist-only\n", cq(&format!("{root}{}", enc(&dir)))?), secs, "não deu para listar a pasta").await?;
            Ok(json!(lossy(&out).lines().map(str::trim).filter(|l| !l.is_empty() && *l != "." && *l != "..").collect::<Vec<_>>()))
        }
        "download" => {
            if rel.is_empty() || rel.ends_with('/') { return Err(fail("diga qual arquivo do servidor baixar", 400)); }
            if local.is_empty() { return Err(fail("diga onde gravar o arquivo aqui no PC", 400)); }
            let name = rel.rsplit('/').next().unwrap_or("arquivo");
            let target = if std::path::Path::new(&local).is_dir() || local.ends_with(['\\', '/']) { std::path::Path::new(&local).join(name) } else { std::path::PathBuf::from(&local) };
            curl(format!("{cfg}url = {}\noutput = {}\ncreate-dirs\n", cq(&format!("{root}{}", enc(rel)))?, cq(&target.to_string_lossy())?), secs, "não deu para baixar").await?;
            Ok(json!({"op": op, "remote": remote, "local": target.to_string_lossy()}))
        }
        "upload" => {
            let path = std::path::Path::new(&local);
            if !path.is_file() { return Err(fail(format!("não achei o arquivo {local}"), 400)); }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let there = if rel.is_empty() || rel.ends_with('/') { format!("{rel}{name}") } else { rel.to_string() };
            curl(format!("{cfg}url = {}\nupload-file = {}\nftp-create-dirs\n", cq(&format!("{root}{}", enc(&there)))?, cq(&local)?), secs, "não deu para enviar").await?;
            Ok(json!({"op": op, "remote": format!("/{there}"), "local": local}))
        }
        "delete" => {
            if rel.is_empty() || rel.ends_with('/') { return Err(fail("diga qual arquivo do servidor apagar", 400)); }
            curl(format!("{cfg}url = {}\nlist-only\nquote = {}\n", cq(&root)?, cq(&format!("DELE {rel}"))?), secs, "não deu para apagar").await?;
            Ok(json!({"op": op, "remote": remote, "deleted": true}))
        }
        o => Err(fail(format!("ação desconhecida: {o}"), 400)),
    }
}
async fn mqtt(p: &Value) -> ApiResult<Value> {
    let host = host_of(p)?;
    let tls = p["security"] == "ssl";
    let port = port_of(p, if tls { 8883 } else { 1883 })?;
    let topic = need(p, "topic", "o tópico")?;
    if topic.contains(['#', '+']) { return Err(fail("o tópico para publicar não leva # nem +", 400)); }
    let message = text_of(p, "message");
    let file = std::env::temp_dir().join(format!("bluescreen-mqtt-{}.txt", super::id()));
    std::fs::write(&file, &message)?;
    let topic_url = topic.split('/').map(|s| urlencoding::encode(s).into_owned()).collect::<Vec<_>>().join("/");
    let mut cfg = format!("url = {}\ndata-binary = {}\n", cq(&format!("{}://{host}:{port}/{topic_url}", if tls { "mqtts" } else { "mqtt" }))?, cq(&format!("@{}", file.to_string_lossy()))?);
    if let Some(u) = login(p)? { cfg.push_str(&u); }
    let r = curl(cfg, secs_of(p, 20), "não deu para publicar").await;
    let _ = std::fs::remove_file(&file);
    r?;
    Ok(json!({"topic": topic, "message": message}))
}

// ---------- banco de dados ----------
const DB_PS: &str = r#"$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Data
  $vals = @(); if ($env:BS_VALUES) { $vals = @((ConvertFrom-Json $env:BS_VALUES) | ForEach-Object { $_ }) }
  if ($env:BS_KIND -eq 'sqlserver') {
    $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $b['Data Source'] = $env:BS_SERVER
    if ($env:BS_DB) { $b['Initial Catalog'] = $env:BS_DB }
    if ($env:BS_USER) { $b['User ID'] = $env:BS_USER; $b['Password'] = $env:BS_PASS } else { $b['Integrated Security'] = $true }
    $b['Connect Timeout'] = 15
    if ($env:BS_TRUST -eq '1') { $b['TrustServerCertificate'] = $true }
    $c = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString
  } else { $c = New-Object System.Data.Odbc.OdbcConnection $env:BS_CONN }
  $c.Open()
  $cmd = $c.CreateCommand(); $cmd.CommandText = $env:BS_SQL; $cmd.CommandTimeout = [int]$env:BS_TIMEOUT
  $i = 0
  foreach ($v in $vals) { $i++; $q = $cmd.CreateParameter(); $q.ParameterName = "@p$i"; if ($null -eq $v) { $q.Value = [DBNull]::Value } else { $q.Value = $v }; [void]$cmd.Parameters.Add($q) }
  $r = $cmd.ExecuteReader()
  $rows = New-Object System.Collections.ArrayList; $max = [int]$env:BS_MAX; $more = $false
  do {
    while ($r.Read()) {
      if ($rows.Count -ge $max) { $more = $true; break }
      $o = [ordered]@{}
      for ($k = 0; $k -lt $r.FieldCount; $k++) {
        $n = $r.GetName($k); if (-not $n) { $n = "col$($k + 1)" }
        $v = $r.GetValue($k)
        if ($v -is [DBNull]) { $v = $null } elseif ($v -is [datetime]) { $v = $v.ToString('yyyy-MM-ddTHH:mm:ss') } elseif ($v -is [byte[]]) { $v = [Convert]::ToBase64String($v) } elseif ($v -is [decimal]) { $v = [double]$v } elseif ($v -is [guid] -or $v -is [timespan]) { $v = [string]$v }
        $o[$n] = $v
      }
      [void]$rows.Add($o)
    }
  } while (-not $more -and $r.NextResult())
  $aff = $r.RecordsAffected; $r.Close(); $c.Close()
  $json = ConvertTo-Json ([ordered]@{ rows = @($rows); count = $rows.Count; affected = $aff; more = $more }) -Compress -Depth 6
  Write-Output ([regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
} catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; [Console]::Error.WriteLine($e.Message); exit 1 }
"#;
async fn db(p: &Value) -> ApiResult<Value> {
    let sql = need(p, "sql", "o SQL")?;
    let kind = p["kind"].as_str().unwrap_or("sqlserver");
    let mut env = serde_json::Map::new();
    env.insert("BS_KIND".into(), json!(kind));
    if kind == "sqlserver" {
        env.insert("BS_SERVER".into(), json!(need(p, "server", "o servidor do banco")?));
        for (k, name) in [("database", "BS_DB"), ("user", "BS_USER"), ("password", "BS_PASS")] { env.insert(name.into(), json!(text_of(p, k).trim())); }
        env.insert("BS_TRUST".into(), json!(if p["trust"] == "yes" { "1" } else { "0" }));
    } else {
        env.insert("BS_CONN".into(), json!(need(p, "connection", "o texto de conexão ODBC")?.replace(['\r', '\n'], "")));
    }
    // número que parece número vai como número; o resto, como texto
    let values: Vec<Value> = list_of(&p["values"]).into_iter().map(|v| match &v { Value::String(s) => s.trim().parse::<i64>().map(|n| json!(n)).or_else(|_| s.trim().parse::<f64>().map(|n| json!(n))).unwrap_or(v.clone()), _ => v }).collect();
    let secs = secs_of(p, 60);
    env.insert("BS_VALUES".into(), json!(if values.is_empty() { String::new() } else { serde_json::to_string(&values)? }));
    env.insert("BS_SQL".into(), json!(sql));
    env.insert("BS_TIMEOUT".into(), json!(secs.to_string()));
    env.insert("BS_MAX".into(), json!((number_of(&p["max_rows"]).unwrap_or(1000.0).clamp(1.0, 100_000.0) as u64).to_string()));
    let out = super::run_ps(DB_PS, &Value::Null, &json!((secs + 30) * 1000), Value::Object(env)).await.map_err(|mut e| { e.msg = e.msg.replacen("o programa falhou", "o banco recusou", 1); e })?;
    serde_json::from_str(out.as_str().unwrap_or("")).map_err(|_| fail("o banco respondeu algo que não entendi", 422))
}

// ---------- rede ----------
async fn telegram(p: &Value, input: &Value) -> ApiResult<Value> {
    let token = need(p, "token", "o token do bot")?;
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || ":_-".contains(c)) { return Err(fail("o token do bot tem um formato estranho: confira a credencial", 400)); }
    let chat = need(p, "chat", "a conversa (o número do chat, ou @canal)")?;
    let text: String = text_of(p, "text").chars().take(4096).collect();
    if text.trim().is_empty() { return Err(fail("a mensagem está vazia", 400)); }
    let base = std::env::var("BLUESCREEN_TELEGRAM_API").unwrap_or_else(|_| "https://api.telegram.org".into());
    let r = super::AUDIT.post(format!("{base}/bot{token}/sendMessage")).json(&json!({"chat_id": chat, "text": text})).send().await
        .map_err(|e| fail(format!("não deu para falar com o Telegram: {}", e.without_url()), 502))?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() || v["ok"] != true {
        let why = v["description"].as_str().unwrap_or("");
        let hint = if status.as_u16() == 401 || status.as_u16() == 404 { " (token do bot inválido)" } else if why.contains("chat not found") { " (conversa não encontrada: mande um oi para o bot antes e confira o número)" } else { "" };
        return Err(fail(format!("o Telegram recusou ({}): {why}{hint}", status.as_u16()), 422));
    }
    Ok(json!({"out": input}))
}
async fn ping(p: &Value) -> ApiResult<Value> {
    let host = host_of(p)?;
    let count = number_of(&p["count"]).unwrap_or(2.0).clamp(1.0, 10.0) as u32;
    let o = exec(&system_tool("", "ping.exe"), &["-n".into(), count.to_string(), "-w".into(), "2000".into(), host.clone()], &[], None, 60).await?;
    let text = lossy(&o.out);
    static MS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[=<]\s*(\d+)\s*ms\s+TTL=").unwrap());
    let times: Vec<u64> = MS.captures_iter(&text).filter_map(|c| c[1].parse().ok()).collect();
    let alive = !times.is_empty();
    let v = json!({"host": host, "alive": alive, "ms": if alive { json!(times.iter().sum::<u64>() / times.len() as u64) } else { Value::Null }, "sent": count, "received": times.len()});
    Ok(if alive { json!({"true": v}) } else { json!({"false": v}) })
}
fn wol(p: &Value) -> ApiResult<Value> {
    let mac = need(p, "mac", "o endereço MAC")?;
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 || mac.chars().any(|c| !c.is_ascii_hexdigit() && !":-. ".contains(c)) { return Err(fail("endereço MAC inválido: são 12 dígitos, como AA:BB:CC:DD:EE:FF", 400)); }
    let bytes: Vec<u8> = (0..6).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0)).collect();
    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 { packet.extend(&bytes); }
    let to = { let b = text_of(p, "broadcast"); if b.trim().is_empty() { "255.255.255.255".to_string() } else { b.trim().to_string() } };
    let port = port_of(p, 9)?;
    let addr: std::net::IpAddr = to.parse().map_err(|_| fail(format!("endereço inválido em Enviar para: {to}"), 400))?;
    let sock = std::net::UdpSocket::bind(if addr.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })?;
    sock.set_broadcast(true)?;
    for _ in 0..3 { sock.send_to(&packet, (addr, port))?; }
    Ok(json!({"mac": bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":"), "sent_to": format!("{to}:{port}")}))
}

/// Roda um nó de conexão. `None`: o tipo não é daqui.
pub(super) async fn node(kind: &str, p: &Value, input: &Value) -> Option<ApiResult<Value>> {
    let out = |r: ApiResult<Value>| r.map(|v| json!({"out": v}));
    Some(match kind {
        "ssh.run" => out(ssh_run(p).await),
        "ssh.copy" => out(ssh_copy(p).await),
        "mail.send" => out(mail_send(p).await),
        "mail.read" => out(mail_read(p).await),
        "ftp.files" => out(ftp(p).await),
        "db.query" => out(db(p).await),
        "mqtt.publish" => out(mqtt(p).await),
        "notify.telegram" => telegram(p, input).await,
        "net.ping" => ping(p).await,
        "net.wol" => out(wol(p)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mensagem_de_email_em_campos() {
        let raw = "From: =?UTF-8?B?Sm/Do28=?= <joao@exemplo.com>\r\nTo: voce@exemplo.com\r\nSubject: =?iso-8859-1?Q?Reuni=E3o_de?=\r\n =?iso-8859-1?Q?_amanh=E3?=\r\nDate: Thu, 12 Nov 2026 09:30:00 -0300\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"xx\"\r\n\r\n--xx\r\nContent-Type: multipart/alternative; boundary=yy\r\n\r\n--yy\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOl=E1, segue a nota=\r\n fiscal.\r\n--yy\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Olá</p>\r\n--yy--\r\n--xx\r\nContent-Type: application/pdf; name=\"nota.pdf\"\r\nContent-Disposition: attachment; filename=\"nota.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0x\r\nLjQ=\r\n--xx--\r\n";
        let dir = std::env::temp_dir().join(format!("bs-mail-{}", super::super::id()));
        let m = parse_mail(raw.as_bytes(), Some(&dir)).unwrap();
        assert_eq!(m["from"], "João <joao@exemplo.com>");
        assert_eq!(m["from_email"], "joao@exemplo.com");
        assert_eq!(m["subject"], "Reunião de amanhã");
        assert_eq!(m["text"], "Olá, segue a nota fiscal.");
        assert_eq!(m["html"], "<p>Olá</p>");
        assert_eq!(m["attachments"][0]["name"], "nota.pdf");
        assert_eq!(std::fs::read(m["attachments"][0]["path"].as_str().unwrap()).unwrap(), b"%PDF-1.4");
        // de novo: o anexo não é gravado por cima
        let again = parse_mail(raw.as_bytes(), Some(&dir)).unwrap();
        assert!(again["attachments"][0]["path"].as_str().unwrap().ends_with("nota (2).pdf"));
        let _ = std::fs::remove_dir_all(&dir);
        // mensagem simples, só HTML
        let m = parse_mail(b"Subject: Oi\nContent-Type: text/html\n\n<div>Linha 1<br>Linha 2</div>", None).unwrap();
        assert_eq!(m["text"], "Linha 1\nLinha 2");
    }
    #[test]
    fn configuracao_do_curl_nao_aceita_quebra_de_linha() {
        assert_eq!(cq("a\"b\\c").unwrap(), "\"a\\\"b\\\\c\"");
        assert!(cq("senha\nurl = \"http://outro\"").is_err());
        assert!(address("Ana <ana@exemplo.com>").unwrap().1 == "ana@exemplo.com" && address("sem arroba").is_err());
    }
    #[test]
    fn pacote_de_wake_on_lan() {
        let sock = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let port = sock.local_addr().unwrap().port();
        let r = wol(&json!({"mac": "aa-bb-cc-dd-ee-ff", "broadcast": "127.0.0.1", "port": port})).unwrap();
        assert_eq!(r["mac"], "AA:BB:CC:DD:EE:FF");
        let mut buf = [0u8; 200];
        let n = sock.recv(&mut buf).unwrap();
        assert_eq!(n, 102);
        assert!(buf[..6].iter().all(|b| *b == 0xFF) && buf[6..12] == [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF] && buf[96..102] == [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert!(wol(&json!({"mac": "AA:BB"})).is_err());
    }
}
