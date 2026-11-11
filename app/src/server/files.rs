//! Rotas dos projetos e arquivos: abrir/criar projeto, árvore, ler/gravar/criar/mover/excluir, arquivos grandes, vigia, índice, busca, lint, resumo, arquivo cru e preview.
//! Separadas de server.rs só por assunto: as funções de apoio (project, in_project, blocking...) ficam lá.
use super::*;

pub(super) fn add_routes(m: &mut HashMap<String, RouteFn>) {
    let mut add = |name: &str, f: RouteFn| { m.insert(name.into(), f); };
    add("projects", route_fn(|r| async move {
        let root = absolute(&r.q("root").map(PathBuf::from).unwrap_or_else(|| app().root.clone()));
        if !root.is_dir() { return Err(fail(format!("Pasta não existe: {}", root.display()), 400)); }
        let rr = root.clone();
        let projects = blocking(move || vcs::list_projects(&rr)).await??;
        ok(json!({ "root": root, "projects": projects }))
    }));
    // ---------- abrir e criar projetos em qualquer pasta (como o Open / New Project do IntelliJ) ----------
    add("project/info", route_fn(|r| async move {
        let dir = absolute(Path::new(r.require("path")?));
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string_lossy().into_owned());
        ok(json!({ "path": dir, "name": name, "exists": dir.is_dir(), "vcs": if dir.is_dir() { vcs::detect(&dir) } else { None } }))
    }));
    // seletor de pasta nativo do Windows; devolve { path: null } quando o usuário cancela
    add("project/pick", route_fn(|r| async move {
        r.local_only()?;
        let start = r.q("start").map(PathBuf::from).filter(|p| p.is_dir()).unwrap_or_else(|| app().root.clone());
        let title = r.q_or("title", "Abrir projeto").to_string();
        let picked = blocking(move || rfd::FileDialog::new().set_title(&title).set_directory(&start).pick_folder()).await?;
        ok(json!({ "path": picked.map(|p| absolute(&p)) }))
    }));
    // POST { parent, name, git, readme }: cria a pasta do projeto (e, se pedido, o repositório Git e o README.md)
    add("project/new", route_fn(|r| async move {
        r.local_only()?;
        if !r.is_post() { return Err(fail("POST", 405)); }
        let b: Value = r.body_json()?;
        let parent = absolute(Path::new(b["parent"].as_str().unwrap_or("").trim()));
        let name = b["name"].as_str().unwrap_or("").trim().to_string();
        let bad = name.is_empty() || name == "." || name == ".." || name.ends_with('.') || name.chars().any(|c| "\\/:*?\"<>|".contains(c) || c.is_control());
        if bad { return Err(fail("Nome de projeto inválido (não use \\ / : * ? \" < > |)", 400)); }
        // a pasta de projetos (ex.: Projects) nasce no primeiro projeto; um caminho com várias pastas faltando é erro de digitação
        if !parent.is_dir() && parent.parent().is_some_and(|p| p.is_dir()) { tokio::fs::create_dir(&parent).await.map_err(|e| fail(format!("Não deu para criar {}: {e}", parent.display()), 500))?; }
        if !parent.is_dir() { return Err(fail(format!("A pasta {} não existe", parent.display()), 400)); }
        let dir = parent.join(&name);
        if dir.exists() { return Err(fail(format!("Já existe {}", dir.display()), 400)); }
        tokio::fs::create_dir(&dir).await.map_err(|e| fail(format!("Não deu para criar {}: {e}", dir.display()), 500))?;
        let mut warn = None;
        if b["readme"].as_bool().unwrap_or(false) { tokio::fs::write(dir.join("README.md"), format!("# {name}\n")).await?; }
        if b["git"].as_bool().unwrap_or(false) {
            let g = run("git", &["init"], &dir, 30000).await;
            if !g.ok { warn = Some("Projeto criado, mas o git init falhou (o Git está instalado?)".to_string()); }
        }
        ok(json!({ "path": dir, "warning": warn }))
    }));
    add("tree", route_fn(|r| async move {
        let (p, abs, _) = in_project(&r, "dir")?;
        let p = absolute(&p);
        let rel = rel(&p, &abs);
        let rel = if rel == "." { String::new() } else { rel };
        let (compact, fresh) = (r.q("compact") != Some("0"), r.flag("fresh"));
        ok(blocking(move || workspace::tree(&p, &rel, compact, fresh)).await??)
    }));
    add("file", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        if r.method == Method::PUT {
            // o editor manda o texto em UTF-8 e diz como o arquivo estava (?encoding=windows-1252, ?bom=1): grava do mesmo
            // jeito. Sem esses parâmetros os bytes vão como vieram (planilhas e imagens dos plugins já mandam prontos).
            // ?expectMtime=&expectSize=: como o editor leu o arquivo. Mudou no disco desde então (outro programa, git
            // checkout entre a conferência do sync.js e esta gravação): 409, e o editor mostra o conflito em vez de gravar
            // por cima. Sem os parâmetros (plugins, arquivo novo), grava como antes.
            if let (Some(m), Some(s)) = (r.q("expectMtime").and_then(|v| v.parse::<f64>().ok()), r.q("expectSize").and_then(|v| v.parse::<u64>().ok())) {
                if let Ok(md) = tokio::fs::metadata(&abs).await {
                    let now = md.modified().map(mtime_ms).unwrap_or(0.0);
                    if !stamp_matches(now, md.len(), m, s) {
                        return Ok(Reply::Raw(json_resp(409, &json!({ "error": "o arquivo mudou no disco depois de aberto", "conflict": true, "mtime": now, "size": md.len() }))));
                    }
                }
            }
            let (enc, bom) = (r.q_or("encoding", "utf-8"), r.flag("bom"));
            if !matches!(enc, "utf-8" | "windows-1252") { return Err(fail(format!("codificação desconhecida: {enc}"), 400)); }
            let bytes: std::borrow::Cow<[u8]> = if enc == "utf-8" && !bom { std::borrow::Cow::Borrowed(&r.body[..]) } else {
                let text = std::str::from_utf8(&r.body).map_err(|_| fail("o texto não veio em UTF-8", 400))?;
                std::borrow::Cow::Owned(encode_text(text, enc, bom).map_err(|c| fail(format!("o arquivo é Windows-1252 e \"{c}\" não existe nessa codificação: troque o caractere ou converta o arquivo para UTF-8"), 422))?)
            };
            write_replace(&abs, &bytes).await?;
            let md = tokio::fs::metadata(&abs).await.ok();
            return ok(json!({ "saved": true, "mtime": md.as_ref().and_then(|m| m.modified().ok()).map(mtime_ms), "size": md.map(|m| m.len()) }));
        }
        let md = tokio::fs::metadata(&abs).await.map_err(|e| fail(e.to_string(), 404))?;
        let mtime = md.modified().map(mtime_ms).unwrap_or(0.0);
        if md.len() > MAX_FILE { return ok(json!({ "content": "", "tooBig": true, "size": md.len(), "mtime": mtime })); }
        let buf = tokio::fs::read(&abs).await?;
        let binary = looks_binary(&buf);
        // encoding/bom: como o arquivo está no disco; o editor manda de volta ao salvar, para gravar igual
        let (content, encoding, bom) = if binary { (String::new(), "utf-8", false) } else { decode_text(&buf) };
        ok(json!({ "content": content, "binary": binary, "size": md.len(), "mtime": mtime, "encoding": encoding, "bom": bom }))
    }));
    // POST { files: [rel...] }: data e tamanho de cada arquivo (null = não existe mais), para conferir as abas abertas
    add("file/stat", route_fn(|r| async move {
        let p = absolute(&project(&r)?);
        let b: Value = r.body_json()?;
        let mut out = serde_json::Map::new();
        for f in b["files"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).take(500) {
            let abs = absolute(&p.join(f));
            if !within(&p, &abs) { continue; }
            let st = tokio::fs::metadata(&abs).await.ok().filter(|m| m.is_file()).map(|m| json!({ "mtime": m.modified().map(mtime_ms).unwrap_or(0.0), "size": m.len() }));
            out.insert(f.to_string(), st.unwrap_or(Value::Null));
        }
        ok(json!({ "files": out }))
    }));
    // POST { path, dir, content }: cria arquivo (ou pasta, com dir: true) e as pastas no caminho; nunca grava por cima
    add("file/new", route_fn(|r| async move {
        if !r.is_post() { return Err(fail("POST", 405)); }
        let p = absolute(&project(&r)?);
        let b: Value = r.body_json()?;
        let rel = norm(b["path"].as_str().unwrap_or("").trim()).trim_matches('/').to_string();
        valid_rel(&rel)?;
        let abs = absolute(&p.join(&rel));
        if !within(&p, &abs) { return Err(fail("fora do projeto", 400)); }
        if abs.exists() { return Err(fail(format!("Já existe {rel}"), 409)); }
        if b["dir"].as_bool().unwrap_or(false) {
            tokio::fs::create_dir_all(&abs).await.map_err(|e| fail(format!("Não deu para criar {rel}: {e}"), 500))?;
        } else {
            if let Some(d) = abs.parent() { tokio::fs::create_dir_all(d).await.map_err(|e| fail(format!("Não deu para criar a pasta: {e}"), 500))?; }
            let mut f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&abs).await.map_err(|e| fail(format!("Não deu para criar {rel}: {e}"), 500))?;
            use tokio::io::AsyncWriteExt;
            f.write_all(b["content"].as_str().unwrap_or("").as_bytes()).await?;
        }
        ok(json!({ "path": rel }))
    }));
    // POST { from, to }: move/renomeia dentro do projeto (ex.: classe para o pacote certo); cria as pastas do destino
    add("file/move", route_fn(|r| async move {
        if !r.is_post() { return Err(fail("POST", 405)); }
        let p = absolute(&project(&r)?);
        let b: Value = r.body_json()?;
        let (from, to) = (norm(b["from"].as_str().unwrap_or("")), norm(b["to"].as_str().unwrap_or("").trim()).trim_matches('/').to_string());
        valid_rel(&to)?;
        let (src, dst) = (absolute(&p.join(&from)), absolute(&p.join(&to)));
        if !within(&p, &src) || !within(&p, &dst) || src == p { return Err(fail("fora do projeto", 400)); }
        if !src.exists() { return Err(fail(format!("{from} não existe"), 404)); }
        // só maiúsculas/minúsculas (main.java -> Main.java): no Windows o destino "já existe", porque é o próprio arquivo
        let same = src.to_string_lossy().to_lowercase() == dst.to_string_lossy().to_lowercase();
        if src == dst { return ok(json!({ "path": to })); }
        if dst.exists() && !same { return Err(fail(format!("Já existe {to}"), 409)); }
        if let Some(d) = dst.parent() { tokio::fs::create_dir_all(d).await?; }
        tokio::fs::rename(&src, &dst).await.map_err(|e| fail(format!("Não deu para mover: {e}"), 500))?;
        ok(json!({ "path": to }))
    }));
    // POST { paths: [rel] }: exclui arquivos/pastas do projeto mandando para a Lixeira (só pelo PC local)
    add("file/delete", route_fn(|r| async move {
        if !r.is_post() { return Err(fail("POST", 405)); }
        r.local_only()?;
        let p = absolute(&project(&r)?);
        let b: Value = r.body_json()?;
        let mut list = vec![];
        for rel in b["paths"].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
            let rel = norm(rel).trim_matches('/').to_string();
            let abs = absolute(&p.join(&rel));
            if rel.is_empty() || !within(&p, &abs) || abs == p { return Err(fail(format!("fora do projeto: {rel}"), 400)); }
            if !abs.exists() { return Err(fail(format!("{rel} não existe"), 404)); }
            list.push(abs);
        }
        if list.is_empty() { return Err(fail("nada para excluir", 400)); }
        let n = list.len();
        tokio::task::spawn_blocking(move || to_trash(&list)).await.map_err(|e| fail(e.to_string(), 500))?.map_err(|e| fail(format!("Não deu para excluir: {e}"), 500))?;
        ok(json!({ "deleted": n }))
    }));
    // pacote Java de uma pasta: { root, kind, pkg } (pkg só existe dentro de um source root de código, src ou test)
    add("file/pkg", route_fn(|r| async move {
        let (p, _, rel) = in_project(&r, "dir")?;
        let p = absolute(&p);
        let rel = norm(&rel).trim_matches('/').to_string();
        let m = blocking(move || workspace::model(&p, false)).await?;
        let Some((root, kind)) = workspace::root_of(&m, &rel) else { return ok(json!({ "root": null })) };
        let pkg = if !matches!(kind, "src" | "test") { None } else if rel == root { Some(String::new()) } else { Some(rel[root.len() + 1..].replace('/', ".")) };
        ok(json!({ "root": root, "kind": kind, "pkg": pkg }))
    }));
    // arquivos grandes, lidos em janelas de linhas (ver bigfile.rs)
    add("big/info", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        ok(blocking(move || crate::bigfile::info(&abs)).await?.map_err(|e| fail(e, 404))?)
    }));
    add("big/lines", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        let (from, count) = (r.q("from").and_then(|v| v.parse().ok()).unwrap_or(0), r.q("count").and_then(|v| v.parse().ok()).unwrap_or(500));
        let full = r.flag("full");
        ok(blocking(move || crate::bigfile::lines(&abs, from, count, full)).await?.map_err(|e| fail(e, 400))?)
    }));
    add("big/search", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        let (q, case, re) = (r.q_or("q", "").to_string(), r.flag("case"), r.flag("regex"));
        ok(blocking(move || crate::bigfile::search(&abs, &q, case, re)).await?.map_err(|e| fail(e, 400))?)
    }));
    // edição: POST com o texto novo das linhas [from, to) no corpo; fica em memória até salvar
    add("big/edit", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        let (from, to) = (r.q("from").and_then(|v| v.parse().ok()).unwrap_or(0), r.q("to").and_then(|v| v.parse().ok()).unwrap_or(0));
        // del: apaga as linhas (corpo vazio seria "uma linha vazia")
        let text = if r.flag("del") { None } else { Some(String::from_utf8_lossy(&r.body).into_owned()) };
        ok(blocking(move || crate::bigfile::edit(&abs, from, to, text.as_deref())).await?.map_err(|e| fail(e, 409))?)
    }));
    // a = undo | redo | discard
    add("big/history", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        let dir = match r.q_or("a", "") { "undo" => -1, "redo" => 1, "discard" => 0, _ => return Err(fail("a: undo, redo ou discard", 400)) };
        ok(blocking(move || crate::bigfile::history(&abs, dir)).await?.map_err(|e| fail(e, 400))?)
    }));
    add("big/save", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        ok(blocking(move || crate::bigfile::save(&abs)).await?.map_err(|e| fail(e, 409))?)
    }));
    // alterações feitas fora da IDE (long-poll; ver watch.rs)
    add("watch", route_fn(|r| async move {
        let p = absolute(&project(&r)?);
        if !p.is_dir() { return Err(fail("pasta não existe", 404)); }
        ok(crate::watch::poll(p, r.q("since").and_then(|s| s.parse().ok())).await)
    }));
    // a lista de arquivos (o formato de sempre, que os plugins usam); passou de MAX_INDEX arquivos, o resto ficou de fora:
    // avisado no cabeçalho x-index-truncated e, com ?meta=1, em { files, truncated, limit }
    add("index", route_fn(|r| async move {
        let p = absolute(&project(&r)?);
        let ix = workspace::file_index(&p, r.flag("fresh")).await;
        let cut = workspace::index_truncated(&p);
        if r.flag("meta") { return ok(json!({ "files": &*ix, "truncated": cut, "limit": workspace::MAX_INDEX })); }
        let mut resp = json_resp(200, &serde_json::to_value(&*ix)?);
        if cut { resp.headers_mut().insert("x-index-truncated", HeaderValue::from(workspace::MAX_INDEX)); }
        Ok(Reply::Raw(resp))
    }));
    add("search", route_fn(|r| async move { ok(workspace::search_text(&absolute(&project(&r)?), r.q_or("q", ""), r.flag("case"), r.flag("regex")).await?) }));
    // POST com o texto no corpo: lint ao vivo do editor (o texto ainda não salvo)
    add("lint", route_fn(|r| async move {
        let (p, _, rel) = in_project(&r, "file")?;
        if r.is_post() { return ok(lint::lint_live(&p, &rel, &r.body_text()).await); }
        ok(lint::lint(&p, &rel).await)
    }));
    // visão geral do projeto (tela sem abas): README, linguagens e sistemas de build
    add("overview", route_fn(|r| async move { ok(workspace::overview(&absolute(&project(&r)?)).await) }));
    // arquivo do projeto como veio (imagens do README, visualizador de imagens, PDF, áudio, vídeo e fontes).
    // Lê só um trecho quando pedido: cabeçalho Range (áudio e vídeo pulam para o meio sem ler o arquivo todo)
    // ou ?offset=&len= (visualizador hexadecimal). O tamanho total vai em x-file-size.
    add("raw", route_fn(|r| async move {
        let (_, abs, _) = in_project(&r, "file")?;
        let size = tokio::fs::metadata(&abs).await.map_err(|e| fail(e.to_string(), 404))?.len();
        let range = r.headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| parse_range(v, size));
        let chunk = r.q("len").map(|l| {
            let off = r.q("offset").and_then(|o| o.parse::<u64>().ok()).unwrap_or(0).min(size);
            (off, (off + l.parse::<u64>().unwrap_or(65536).min(MAX_CHUNK)).min(size))
        });
        // Range que não cabe no arquivo (ex.: começa depois do fim): 416, como manda o HTTP, em vez do arquivo inteiro
        if range.is_none() && size > 0 && r.headers.get(header::RANGE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.trim().starts_with("bytes=")) {
            let mut resp = Response::new(Body::empty());
            *resp.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            resp.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
            return Ok(Reply::Raw(resp));
        }
        let (start, end, partial) = match (range, chunk) { (Some((a, b)), _) => (a, b, true), (None, Some((a, b))) => (a, b, false), _ => (0, size, false) };
        // o arquivo inteiro vai aos pedaços (um vídeo de 2 GB não passa pela memória); trechos são pequenos (MAX_CHUNK)
        let whole = range.is_none() && chunk.is_none();
        let body = if whole { stream_file(&abs).await.map_err(|e| fail(e.to_string(), 500))? } else { Body::from(read_slice(&abs, start, end).await.map_err(|e| fail(e.to_string(), 500))?) };
        let mut resp = ([(header::CONTENT_TYPE, mime(&abs)), (header::CACHE_CONTROL, "no-cache")], body).into_response();
        let h = resp.headers_mut();
        if whole { h.insert(header::CONTENT_LENGTH, HeaderValue::from(size)); }
        h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        h.insert("x-file-size", HeaderValue::from(size));
        // HTML/SVG aberto direto (nova janela, link) não roda com a origem da IDE; o PDF fica de fora porque o leitor
        // de PDF do WebView2 não abre em página isolada
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        if mime(&abs) != "application/pdf" { h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SANDBOX_CSP)); }
        if partial {
            h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {start}-{}/{size}", end.saturating_sub(1))).unwrap());
            *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
        }
        Ok(Reply::Raw(resp))
    }));
    // chave do preview de HTML do editor: /api/preview/<chave>/<arquivo> serve os arquivos do projeto com caminhos
    // relativos (css, imagens, scripts). A chave substitui o cookie, que não vai junto de um iframe isolado (sandbox).
    add("preview", route_fn(|r| async move {
        let p = absolute(&project(&r)?);
        let mut m = previews().lock();
        // chaves sem uso há PREVIEW_TTL saem; e no máximo PREVIEW_MAX (as usadas há mais tempo saem primeiro)
        m.retain(|_, v| v.1.elapsed() < PREVIEW_TTL);
        while m.len() >= PREVIEW_MAX { let Some(k) = m.iter().min_by_key(|(_, v)| v.1).map(|(k, _)| k.clone()) else { break }; m.remove(&k); }
        let key = match m.iter_mut().find(|(_, v)| v.0 == p) {
            Some((k, v)) => { v.1 = std::time::Instant::now(); k.clone() }
            None => { let k: String = (0..32).map(|_| format!("{:x}", rand::random_range(0..16u8))).collect(); m.insert(k.clone(), (p, std::time::Instant::now())); k }
        };
        ok(json!({ "key": key }))
    }));
}
