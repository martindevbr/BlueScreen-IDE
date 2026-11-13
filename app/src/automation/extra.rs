//! Nós do dia a dia de escritório, sem programa de fora: contas, formatação de números, listas sem repetidos,
//! procura numa lista, planilhas do Excel (.xlsx, lidas e gravadas direto no arquivo, sem o Excel instalado),
//! compactar e descompactar, e a foto da tela.
use super::{br_num, dig, list_of, path_of, run_ps, stringify, text_of};
use crate::util::*;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub(super) fn catalog() -> Value {
    json!([
        {"type":"math.calc","name":"Calcular","category":"Dados","desc":"Faz uma conta com dois números: somar, tirar, multiplicar, dividir, porcentagem, arredondar.","inputs":["in"],"outputs":["out"],
         "params":{"a":"{{input}}","op":"add","b":"","decimals":2},
         "fields":[
            {"name":"a","label":"Primeiro número","kind":"text","help":"Vale escrito como aqui: 1.234,56, R$ 10,50 ou 12%."},
            {"name":"op","label":"Conta","kind":"select","options":[
                {"value":"add","label":"mais"},{"value":"sub","label":"menos"},{"value":"mul","label":"vezes"},{"value":"div","label":"dividido por"},
                {"value":"pct_of","label":"por cento de (10 por cento de 200 = 20)"},{"value":"pct","label":"é quantos por cento de (20 é 10% de 200)"},
                {"value":"round","label":"só arredondar"},{"value":"max","label":"o maior dos dois"},{"value":"min","label":"o menor dos dois"}]},
            {"name":"b","label":"Segundo número","kind":"text","show":{"op":["add","sub","mul","div","pct_of","pct","max","min"]}},
            {"name":"decimals","label":"Casas depois da vírgula","kind":"number","min":0,"max":10}
         ]},
        {"type":"text.number","name":"Formatar número","category":"Texto","desc":"Escreve um número como dinheiro, com ponto de milhar ou como porcentagem.","inputs":["in"],"outputs":["out"],
         "params":{"value":"{{input}}","style":"money","decimals":2},
         "fields":[
            {"name":"value","label":"Número","kind":"text"},
            {"name":"style","label":"Como","kind":"select","options":[{"value":"money","label":"R$ 1.234,56"},{"value":"number","label":"1.234,56"},{"value":"percent","label":"12,5%"}]},
            {"name":"decimals","label":"Casas depois da vírgula","kind":"number","min":0,"max":10}
         ]},
        {"type":"list.dedupe","name":"Remover repetidos","category":"Dados","desc":"Fica com um só de cada item repetido da lista.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","field":""},
         "fields":[
            {"name":"list","label":"Lista","kind":"text"},
            {"name":"field","label":"Comparar pelo campo","kind":"text","placeholder":"vazio: o item inteiro","paths":"list","item":true,"help":"Maiúsculas e espaços nas pontas não contam como diferença. Fica o primeiro que aparecer."}
         ]},
        {"type":"list.lookup","name":"Procurar na lista","category":"Dados","desc":"Acha na lista o item em que um campo tem o valor procurado (como o PROCV do Excel).","inputs":["in"],"outputs":["true","false"],
         "params":{"list":"{{input}}","field":"","equals":""},
         "fields":[
            {"name":"list","label":"Lista","kind":"text"},
            {"name":"field","label":"Campo","kind":"text","placeholder":"vazio: o item inteiro","paths":"list","item":true},
            {"name":"equals","label":"Valor procurado","kind":"text","help":"Pela saída sim sai o item achado; pela saída não, o valor procurado."}
         ]},
        {"type":"data.excel","name":"Ler planilha Excel","category":"Dados","desc":"Lê um arquivo .xlsx e entrega uma linha por item, sem precisar do Excel instalado.","inputs":["in"],"outputs":["out"],
         "params":{"path":"","sheet":"","header":"yes"},
         "fields":[
            {"name":"path","label":"Planilha (.xlsx)","kind":"text","pick":"file","placeholder":"C:\\pasta\\planilha.xlsx"},
            {"name":"sheet","label":"Aba","kind":"text","placeholder":"vazio: a primeira"},
            {"name":"header","label":"A primeira linha","kind":"select","options":[{"value":"yes","label":"Tem os nomes das colunas"},{"value":"no","label":"Já é um item (colunas A, B, C…)"}]}
         ]},
        {"type":"data.xlsx","name":"Gravar planilha Excel","category":"Dados","desc":"Grava uma lista num arquivo .xlsx: cada item vira uma linha e cada campo, uma coluna.","inputs":["in"],"outputs":["out"],
         "params":{"list":"{{input}}","path":"","sheet":"Planilha"},
         "fields":[
            {"name":"list","label":"Lista","kind":"text"},
            {"name":"path","label":"Gravar em","kind":"text","pick":"save","placeholder":"C:\\pasta\\relatorio.xlsx","help":"Se o arquivo já existe, é substituído. Feche ele no Excel antes."},
            {"name":"sheet","label":"Nome da aba","kind":"text"}
         ]},
        {"type":"file.zip","name":"Compactar ou descompactar","category":"Arquivos","desc":"Junta um arquivo ou uma pasta num .zip, ou abre um .zip numa pasta.","inputs":["in"],"outputs":["out"],
         "params":{"op":"zip","from":"{{input}}","to":""},
         "fields":[
            {"name":"op","label":"Ação","kind":"select","options":[{"value":"zip","label":"Compactar"},{"value":"unzip","label":"Descompactar"}]},
            {"name":"from","label":"Arquivo ou pasta","kind":"text","pick":"any"},
            {"name":"to","label":"Gravar em","kind":"text","pick":"any","placeholder":"vazio: ao lado do original","help":"Ao compactar, o arquivo .zip; ao descompactar, a pasta."}
         ]},
        {"type":"windows.screenshot","name":"Capturar a tela","category":"Windows","desc":"Tira uma foto da tela do PC e grava num arquivo de imagem.","inputs":["in"],"outputs":["out"],
         "params":{"path":""},
         "fields":[{"name":"path","label":"Gravar em","kind":"text","pick":"save","placeholder":"vazio: na pasta Imagens, com a data e a hora","help":"Arquivo .png. Pega todos os monitores."}]}
    ])
}
pub(super) fn io_doc(kind: &str) -> Option<(&'static str, &'static str, Value)> {
    let n = Value::Null;
    Some(match kind {
        "math.calc" => ("Um número, ou qualquer dado para usar nos campos.", "O resultado da conta (número).", n),
        "text.number" => ("Um número.", "O número escrito do jeito escolhido (texto).", n),
        "list.dedupe" => ("Uma lista.", "A lista sem os repetidos.", n),
        "list.lookup" => ("Uma lista (de objetos ou de valores).", "O item achado, pela saída sim; o valor procurado, pela saída não.", n),
        "data.excel" => ("Nada em especial: o arquivo vem do campo.", "Lista de objetos, um por linha da planilha, com os nomes das colunas como campos.", json!([{"Tarefa": "Enviar proposta", "Prazo": "25/12/2026", "Dono": "Ana"}])),
        "data.xlsx" => ("Uma lista de objetos.", "O caminho da planilha gravada (texto).", n),
        "file.zip" => ("Nada em especial: os caminhos vêm dos campos.", "O caminho do .zip gravado, ou da pasta aberta (texto).", n),
        "windows.screenshot" => ("Nada.", "O caminho da imagem gravada (texto).", n),
        _ => return None,
    })
}
pub(super) fn io_kind(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "math.calc" => ("any", "number"),
        "text.number" => ("any", "text"),
        "list.dedupe" => ("list", "list"),
        "list.lookup" => ("list", "any"),
        "data.excel" => ("any", "list"),
        "data.xlsx" => ("list", "file"),
        "file.zip" => ("any", "file"),
        "windows.screenshot" => ("any", "image"),
        _ => return None,
    })
}

/// 1234.5 -> "1.234,50"
fn br_format(v: f64, decimals: usize) -> String {
    let s = format!("{:.*}", decimals, v.abs());
    let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
    let mut out = String::new();
    for (i, c) in int.chars().enumerate() { if i > 0 && (int.len() - i) % 3 == 0 { out.push('.'); } out.push(c); }
    let neg = v < 0.0 && s.bytes().any(|b| (b'1'..=b'9').contains(&b));
    format!("{}{out}{}{frac}", if neg { "-" } else { "" }, if frac.is_empty() { "" } else { "," })
}
fn number(p: &Value, k: &str, label: &str) -> ApiResult<f64> {
    let t = text_of(p, k);
    br_num(&t).ok_or_else(|| fail(if t.trim().is_empty() { format!("falta o {label}") } else { format!("\"{}\" não é um número ({label})", t.chars().take(60).collect::<String>()) }, 400))
}
/// O número como JSON: inteiro quando não tem casas, para não sair "20.0".
fn num_json(v: f64) -> Value { if v.fract() == 0.0 && v.abs() < 9e15 { json!(v as i64) } else { json!(v) } }
fn key_of(item: &Value, field: &str) -> String {
    let v = if field.trim().is_empty() { item.clone() } else { dig(item, field.trim()).unwrap_or(Value::Null) };
    stringify(&v).trim().to_lowercase()
}

// ---------- planilha do Excel: um .zip com XML dentro ----------
fn unxml(t: &str) -> String { t.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#10;", "\n").replace("&#13;", "").replace("&amp;", "&") }
fn xml(t: &str) -> String { t.chars().filter(|c| *c == '\n' || *c == '\t' || !c.is_control()).collect::<String>().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }
fn attr(tag: &str, name: &str) -> Option<String> {
    let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
    Some(unxml(&tag[at..at + tag[at..].find('"')?]))
}
type Book = zip::ZipArchive<std::fs::File>;
fn entry(z: &mut Book, name: &str) -> Option<String> {
    let mut s = String::new();
    z.by_name(name).ok()?.take(200 << 20).read_to_string(&mut s).ok()?;
    Some(s)
}
/// Os textos de dentro de `<t>…</t>` de um trecho (um texto pode vir em vários pedaços, um por formatação).
fn texts(part: &str) -> String {
    static T: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t>").unwrap());
    static PH: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<rPh.*?</rPh>").unwrap());
    T.captures_iter(&PH.replace_all(part, "")).map(|c| unxml(&c[1])).collect()
}
/// Coluna "AB" -> 27 (A é 0)
fn col_index(cell: &str) -> usize { cell.bytes().take_while(u8::is_ascii_alphabetic).fold(0usize, |a, b| a * 26 + (b.to_ascii_uppercase() - b'A') as usize + 1).saturating_sub(1) }
fn col_name(mut i: usize) -> String { let mut s = String::new(); loop { s.insert(0, (b'A' + (i % 26) as u8) as char); if i < 26 { break; } i = i / 26 - 1; } s }
/// O número de data do Excel como a pessoa vê: dia, dia e hora, ou só a hora.
fn excel_date(v: f64, clock: bool) -> Option<String> {
    let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    let t = base + chrono::Duration::milliseconds((v * 86_400_000.0).round() as i64);
    Some(if v < 1.0 { t.format("%H:%M").to_string() } else if clock && v.fract() > 0.0 { t.format("%d/%m/%Y %H:%M").to_string() } else { t.format("%d/%m/%Y").to_string() })
}
fn read_xlsx(path: &Path, want: &str, header: bool) -> ApiResult<Value> {
    if !path.is_file() { return Err(fail(format!("arquivo não encontrado: {}", path.display()), 404)); }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "xls" { return Err(fail("este é o formato antigo do Excel (.xls). Abra no Excel e salve como .xlsx.", 400)); }
    if ext == "csv" { return Err(fail("este arquivo é um CSV: use Ler arquivo e depois Ler CSV.", 400)); }
    let mut z = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|_| fail("o arquivo não é uma planilha .xlsx (ou está protegido com senha)", 400))?;
    let book = entry(&mut z, "xl/workbook.xml").ok_or_else(|| fail("o arquivo não é uma planilha .xlsx", 400))?;
    static SHEET: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<sheet\s[^>]*>").unwrap());
    static REL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<Relationship\s[^>]*>").unwrap());
    let sheets: Vec<(String, String)> = SHEET.find_iter(&book).filter_map(|m| Some((attr(m.as_str(), "name")?, attr(m.as_str(), "r:id")?))).collect();
    let (_, rid) = if want.trim().is_empty() { sheets.first() } else { sheets.iter().find(|s| s.0.trim().to_lowercase() == want.trim().to_lowercase()) }
        .ok_or_else(|| fail(format!("a planilha não tem a aba \"{}\". Abas: {}", want.trim(), sheets.iter().map(|s| s.0.clone()).collect::<Vec<_>>().join(", ")), 404))?;
    let rels = entry(&mut z, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let target = REL.find_iter(&rels).find(|m| attr(m.as_str(), "Id").as_deref() == Some(rid.as_str())).and_then(|m| attr(m.as_str(), "Target")).unwrap_or_else(|| "worksheets/sheet1.xml".into());
    let target = target.trim_start_matches('/').to_string();
    let data = entry(&mut z, &if target.starts_with("xl/") { target.clone() } else { format!("xl/{target}") }).ok_or_else(|| fail("não consegui abrir a aba da planilha", 500))?;
    // textos da planilha (cada célula de texto aponta para um deles)
    static SI: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<si>(.*?)</si>|<si/>").unwrap());
    let shared: Vec<String> = entry(&mut z, "xl/sharedStrings.xml").map(|s| SI.captures_iter(&s).map(|c| c.get(1).map(|m| texts(m.as_str())).unwrap_or_default()).collect()).unwrap_or_default();
    // quais estilos de célula são data ou hora (para o número virar 25/12/2026)
    static FMT: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<numFmt\s[^>]*>").unwrap());
    static XFS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<cellXfs[^>]*>(.*?)</cellXfs>").unwrap());
    static XF: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<xf\s[^>]*>").unwrap());
    static QUOTED: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#""[^"]*"|\[[^\]]*\]|\\."#).unwrap());
    let styles = entry(&mut z, "xl/styles.xml").unwrap_or_default();
    let custom: HashMap<u32, String> = FMT.find_iter(&styles).filter_map(|m| Some((attr(m.as_str(), "numFmtId")?.parse().ok()?, QUOTED.replace_all(&attr(m.as_str(), "formatCode")?.to_lowercase(), "").to_string()))).collect();
    // (é data, mostra a hora)
    let dates: Vec<(bool, bool)> = XFS.captures(&styles).map(|c| XF.find_iter(&c[1]).map(|m| {
        let id: u32 = attr(m.as_str(), "numFmtId").and_then(|v| v.parse().ok()).unwrap_or(0);
        match custom.get(&id) { Some(code) => (code.contains('y') || code.contains('d') || code.contains('h'), code.contains('h')), None => (matches!(id, 14..=22 | 45..=47), matches!(id, 18..=22 | 45..=47)) }
    }).collect()).unwrap_or_default();
    static ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<row[^>]*?(?:/>|>(.*?)</row>)").unwrap());
    static CELL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<c(\s[^>]*?)?(?:/>|>(.*?)</c>)").unwrap());
    static V: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?s)<v(?:\s[^>]*)?>(.*?)</v>").unwrap());
    let mut rows: Vec<Vec<Value>> = vec![];
    for r in ROW.captures_iter(&data) {
        let Some(body) = r.get(1) else { continue };
        let mut row: Vec<Value> = vec![];
        for (n, c) in CELL.captures_iter(body.as_str()).enumerate() {
            let tag = format!("{} ", c.get(1).map(|m| m.as_str()).unwrap_or(""));
            let inner = c.get(2).map(|m| m.as_str()).unwrap_or("");
            let at = attr(&tag, "r").map(|r| col_index(&r)).unwrap_or(n).min(2000);
            let raw = V.captures(inner).map(|v| unxml(&v[1])).unwrap_or_default();
            let value = match attr(&tag, "t").as_deref() {
                Some("s") => json!(raw.trim().parse::<usize>().ok().and_then(|i| shared.get(i)).cloned().unwrap_or_default()),
                Some("inlineStr") => json!(texts(inner)),
                Some("b") => json!(raw.trim() == "1"),
                Some("str") | Some("e") => json!(raw),
                _ => match raw.trim().parse::<f64>() {
                    Ok(v) => { let style = attr(&tag, "s").and_then(|s| s.parse::<usize>().ok()).and_then(|i| dates.get(i)).copied().unwrap_or((false, false)); if style.0 { excel_date(v, style.1).map(|d| json!(d)).unwrap_or_else(|| num_json(v)) } else { num_json(v) } }
                    Err(_) => json!(raw),
                },
            };
            if row.len() <= at { row.resize(at + 1, json!("")); }
            row[at] = value;
        }
        if row.iter().any(|v| !stringify(v).trim().is_empty()) { rows.push(row); }
        if rows.len() > 100_000 { return Err(fail("planilha grande demais: até 100 mil linhas", 413)); }
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let names: Vec<String> = if header && !rows.is_empty() {
        let first = rows.remove(0);
        let mut names: Vec<String> = vec![];
        for i in 0..width { let mut n = first.get(i).map(|v| stringify(v).trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| format!("coluna {}", col_name(i))); while names.contains(&n) { n.push_str(&format!(" ({})", col_name(i))); } names.push(n); }
        names
    } else { (0..width).map(col_name).collect() };
    Ok(Value::Array(rows.into_iter().map(|r| { let mut o = serde_json::Map::new(); for (i, n) in names.iter().enumerate() { o.insert(n.clone(), r.get(i).cloned().unwrap_or(json!(""))); } Value::Object(o) }).collect()))
}
fn write_xlsx(path: &Path, list: &[Value], sheet: &str) -> ApiResult<()> {
    // as colunas, na ordem em que os campos aparecem
    let mut cols: Vec<String> = vec![];
    for item in list { match item { Value::Object(o) => for k in o.keys() { if !cols.contains(k) { cols.push(k.clone()); } }, _ => if cols.is_empty() { cols.push("valor".into()); } } }
    if cols.len() > 1000 { return Err(fail("colunas demais para uma planilha: até mil", 413)); }
    let cell = |c: usize, r: usize, v: &Value| -> String {
        let at = format!("{}{r}", col_name(c));
        match v {
            Value::Null => String::new(),
            Value::Number(n) => format!("<c r=\"{at}\"><v>{n}</v></c>"),
            Value::Bool(b) => format!("<c r=\"{at}\" t=\"b\"><v>{}</v></c>", *b as u8),
            // número escrito como texto ("1.234,56") entra como número, para o Excel somar; código com zero na frente fica texto
            Value::String(s) if s.contains(',') && !s.trim().starts_with('0') && s.trim().chars().all(|ch| ch.is_ascii_digit() || ".,-".contains(ch)) && br_num(s).is_some() => format!("<c r=\"{at}\"><v>{}</v></c>", br_num(s).unwrap_or(0.0)),
            o => { let t = stringify(o); let t: String = t.chars().take(32000).collect(); if t.is_empty() { String::new() } else { format!("<c r=\"{at}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>", xml(&t)) } }
        }
    };
    let mut data = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><sheetData>");
    data.push_str("<row r=\"1\">");
    for (c, name) in cols.iter().enumerate() { data.push_str(&format!("<c r=\"{}1\" t=\"inlineStr\" s=\"1\"><is><t xml:space=\"preserve\">{}</t></is></c>", col_name(c), xml(name))); }
    data.push_str("</row>");
    for (i, item) in list.iter().enumerate() {
        let r = i + 2;
        data.push_str(&format!("<row r=\"{r}\">"));
        match item { Value::Object(o) => for (c, k) in cols.iter().enumerate() { if let Some(v) = o.get(k) { data.push_str(&cell(c, r, v)); } }, v => data.push_str(&cell(0, r, v)) }
        data.push_str("</row>");
    }
    data.push_str("</sheetData></worksheet>");
    let name: String = sheet.trim().chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
    let name = if name.is_empty() { "Planilha".to_string() } else { name };
    if let Some(d) = path.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
    let bad = |e: zip::result::ZipError| fail(format!("não deu para gravar a planilha: {e}"), 500);
    let mut z = zip::ZipWriter::new(std::fs::File::create(path)?);
    let opt = zip::write::SimpleFileOptions::default();
    let parts: [(&str, String); 6] = [
        ("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>".into()),
        ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>".into()),
        ("xl/workbook.xml", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>", xml(&name))),
        ("xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>".into()),
        // estilo 1: negrito, para a linha dos nomes das colunas
        ("xl/styles.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs></styleSheet>".into()),
        ("xl/worksheets/sheet1.xml", data),
    ];
    for (file, text) in parts { z.start_file(file, opt).map_err(bad)?; z.write_all(text.as_bytes())?; }
    z.finish().map_err(bad)?;
    Ok(())
}

// ---------- compactar e descompactar ----------
fn zip_files(from: &Path, to: &Path) -> ApiResult<usize> {
    let bad = |e: zip::result::ZipError| fail(format!("não deu para compactar: {e}"), 500);
    let mut files: Vec<(PathBuf, String)> = vec![];
    if from.is_dir() {
        // a pasta entra com o nome dela na frente, como o Windows faz em "Enviar para > Pasta compactada"
        let top = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut stack = vec![(from.to_path_buf(), top)];
        while let Some((dir, name)) = stack.pop() {
            for e in std::fs::read_dir(&dir)?.flatten() {
                let (p, n) = (e.path(), format!("{name}/{}", e.file_name().to_string_lossy()));
                if p == to { continue; }
                if p.is_dir() { stack.push((p, n)); } else if p.is_file() { files.push((p, n)); }
                if files.len() > 50_000 { return Err(fail("arquivos demais para um .zip só: até 50 mil", 413)); }
            }
        }
    } else { files.push((from.to_path_buf(), from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "arquivo".into()))); }
    if let Some(d) = to.parent().filter(|d| !d.as_os_str().is_empty()) { std::fs::create_dir_all(d)?; }
    let mut z = zip::ZipWriter::new(std::fs::File::create(to)?);
    let opt = zip::write::SimpleFileOptions::default().large_file(true);
    files.sort_by(|a, b| a.1.cmp(&b.1));
    for (p, n) in &files { z.start_file(n.as_str(), opt).map_err(bad)?; std::io::copy(&mut std::fs::File::open(p)?, &mut z)?; }
    z.finish().map_err(bad)?;
    Ok(files.len())
}

const SHOT_PS: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System.Runtime.InteropServices; public class BsDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][BsDpi]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try { $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save($env:BS_OUT, [System.Drawing.Imaging.ImageFormat]::Png) }
finally { $g.Dispose(); $bmp.Dispose() }
"#;

pub(super) async fn node(kind: &str, p: &Value, _input: &Value) -> Option<ApiResult<Value>> {
    let out = |r: ApiResult<Value>| r.map(|v| json!({"out": v}));
    Some(match kind {
        "math.calc" => out((|| {
            let dec = p["decimals"].as_u64().unwrap_or(2).min(10) as i32;
            let op = p["op"].as_str().unwrap_or("add");
            let a = number(p, "a", "primeiro número")?;
            let b = if op == "round" { 0.0 } else { number(p, "b", "segundo número")? };
            let v = match op {
                "add" => a + b, "sub" => a - b, "mul" => a * b, "pct_of" => a * b / 100.0, "max" => a.max(b), "min" => a.min(b), "round" => a,
                "div" | "pct" => { if b == 0.0 { return Err(fail("não dá para dividir por zero: o segundo número é 0", 400)); } if op == "div" { a / b } else { a / b * 100.0 } }
                o => return Err(fail(format!("conta desconhecida: {o}"), 400)),
            };
            let k = 10f64.powi(dec);
            Ok(num_json((v * k).round() / k))
        })()),
        "text.number" => out((|| {
            let dec = p["decimals"].as_u64().unwrap_or(2).min(10) as usize;
            let v = number(p, "value", "número")?;
            Ok(json!(match p["style"].as_str().unwrap_or("money") { "money" => format!("R$ {}", br_format(v, dec)), "percent" => format!("{}%", br_format(v, dec)), _ => br_format(v, dec) }))
        })()),
        "list.dedupe" => {
            let field = text_of(p, "field");
            let mut seen = std::collections::HashSet::new();
            out(Ok(Value::Array(list_of(&p["list"]).into_iter().filter(|x| seen.insert(key_of(x, &field))).collect())))
        }
        "list.lookup" => {
            let (field, want) = (text_of(p, "field"), text_of(p, "equals"));
            let key = want.trim().to_lowercase();
            // texto igual, ou o mesmo número escrito de outro jeito ("10" e "10,0")
            let same = |x: &Value| { let k = key_of(x, &field); k == key || (!k.starts_with('0') && matches!((br_num(&k), br_num(&key)), (Some(a), Some(b)) if a == b)) };
            Ok(match list_of(&p["list"]).into_iter().find(same) { Some(item) => json!({"true": item}), None => json!({"false": want}) })
        }
        "data.excel" => out((|| read_xlsx(&path_of(p, "path")?, &text_of(p, "sheet"), p["header"] != "no"))()),
        "data.xlsx" => out((|| {
            let path = path_of(p, "path")?;
            let path = if path.extension().is_none() { path.with_extension("xlsx") } else { path };
            write_xlsx(&path, &list_of(&p["list"]), &text_of(p, "sheet"))?;
            Ok(json!(path.to_string_lossy()))
        })()),
        "file.zip" => out((|| {
            let from = path_of(p, "from")?;
            if !from.exists() { return Err(fail(format!("não encontrei {}", from.display()), 404)); }
            let to = text_of(p, "to"); let to = to.trim().trim_matches('"');
            if p["op"] == "unzip" {
                let dir = if to.is_empty() { from.with_extension("") } else { PathBuf::from(to) };
                let mut z = zip::ZipArchive::new(std::fs::File::open(&from)?).map_err(|_| fail("o arquivo não é um .zip (ou está protegido com senha)", 400))?;
                std::fs::create_dir_all(&dir)?;
                z.extract(&dir).map_err(|e| fail(format!("não deu para descompactar: {e}"), 500))?;
                Ok(json!(dir.to_string_lossy()))
            } else {
                let mut zip = if to.is_empty() { PathBuf::from(format!("{}.zip", from.with_extension("").to_string_lossy())) } else { PathBuf::from(to) };
                // "Gravar em" pode ser uma pasta: o .zip leva o nome do original
                if zip.is_dir() { zip = zip.join(format!("{}.zip", from.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "arquivos".into()))); }
                if zip.extension().is_none() { zip = zip.with_extension("zip"); }
                zip_files(&from, &zip)?;
                Ok(json!(zip.to_string_lossy()))
            }
        })()),
        "windows.screenshot" => {
            let path = text_of(p, "path"); let path = path.trim().trim_matches('"');
            let file = if path.is_empty() { dirs::picture_dir().unwrap_or_else(std::env::temp_dir).join(format!("tela-{}.png", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"))) } else { let f = PathBuf::from(path); if f.extension().is_none() { f.with_extension("png") } else { f } };
            if let Some(d) = file.parent().filter(|d| !d.as_os_str().is_empty()) && let Err(e) = std::fs::create_dir_all(d) { return Some(Err(e.into())); }
            out(run_ps(SHOT_PS, &Value::Null, &json!(30000), json!({"BS_OUT": file.to_string_lossy()})).await
                .map(|_| json!(file.to_string_lossy())).map_err(|e| fail(e.msg.replace("o programa falhou: ", "não deu para capturar a tela: "), e.status)))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_are_written_the_local_way() {
        assert_eq!(br_format(1234.5, 2), "1.234,50");
        assert_eq!(br_format(-1234567.891, 1), "-1.234.567,9");
        assert_eq!(br_format(0.004, 2), "0,00");
        assert_eq!(br_format(12.0, 0), "12");
        assert_eq!(col_name(0), "A"); assert_eq!(col_name(26), "AA"); assert_eq!(col_index("AB12"), 27);
    }
    #[test]
    fn xlsx_round_trip_keeps_names_numbers_and_dates() {
        let dir = std::env::temp_dir().join(format!("bs-xlsx-{}", super::super::id()));
        let file = dir.join("t.xlsx");
        let list = vec![json!({"Tarefa": "Enviar <proposta> & contrato", "Valor": "1.234,56", "Feito": true, "Código": "00123"}), json!({"Tarefa": "Ligar", "Valor": 10, "Dono": "Ana"})];
        write_xlsx(&file, &list, "Tarefas").unwrap();
        let back = read_xlsx(&file, "tarefas", true).unwrap();
        assert_eq!(back[0]["Tarefa"], "Enviar <proposta> & contrato");
        assert_eq!(back[0]["Valor"], 1234.56);
        assert_eq!(back[0]["Feito"], true);
        assert_eq!(back[0]["Código"], "00123");
        assert_eq!(back[1]["Valor"], 10);
        assert_eq!(back[1]["Dono"], "Ana");
        assert!(read_xlsx(&file, "Outra", true).is_err());
        assert_eq!(excel_date(46381.0, false).unwrap(), "25/12/2026");
        let z = dir.join("pasta.zip");
        assert_eq!(zip_files(&file, &z).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
