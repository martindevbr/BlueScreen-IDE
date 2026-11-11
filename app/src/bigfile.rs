//! Arquivos grandes (logs, dumps, CSVs de GB): o editor só vê uma janela de linhas, lida direto do disco.
//! - Índice esparso: a posição de uma linha a cada STEP (1024). Um arquivo de 10 milhões de linhas custa ~80 KB de
//!   memória. É montado em segundo plano (memchr, na casa de GB/s) e a página já mostra o começo enquanto isso.
//! - Ler as linhas [from, from+count): pula para o marco mais próximo e anda no máximo STEP linhas.
//! - Arquivo que só cresceu (log sendo escrito) continua o índice de onde parou, sem reler o começo.
//! - Busca no arquivo inteiro, em blocos de 4 MB, com regex de bytes (literal, sem diferenciar maiúsculas ou regex);
//!   uma busca nova no mesmo arquivo cancela a anterior.
//! - Linhas gigantes (JSON minificado de 200 MB numa linha só) são cortadas em MAX_COL para exibição.
//!
//! Edição (tabela de remendos): o arquivo no disco não muda enquanto você edita. Cada edição vira um remendo
//! "troque as linhas originais [o0, o1) por estas", guardado aqui em memória e ordenado; ler, buscar e contar linhas já
//! enxergam o arquivo editado (o original + remendos), então editar uma linha de um arquivo de 5 GB custa o tamanho da
//! linha, não do arquivo. Desfazer/refazer guardam a lista de remendos (as linhas são compartilhadas, cópia barata).
//! Salvar escolhe o caminho mais barato:
//! - "patch": todos os remendos têm o mesmo tamanho em bytes do trecho trocado: grava só esses bytes no lugar;
//! - "tail": do primeiro remendo até o fim há no máximo TAIL_INPLACE: reescreve só esse rabo, no lugar;
//! - "rewrite": monta o arquivo novo ao lado (cópia em blocos grandes do original + remendos) e troca de uma vez
//!   (rename): se algo falhar no meio, o original continua intacto.
//! Depois de salvar, o índice continua do marco anterior ao primeiro remendo (o começo do arquivo não mudou).
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Instant, SystemTime};

const STEP: u64 = 1024;
const CHUNK: usize = 4 << 20;
/// caracteres de uma linha mostrados (o resto vira "… +N")
const MAX_COL: usize = 4000;
const MAX_LINES: u64 = 5000;
/// linhas inteiras (sem corte) pedidas de uma vez pelo trecho em edição, e o limite em bytes desse trecho
const MAX_FULL_LINES: u64 = 50_000;
const MAX_FULL_BYTES: usize = 64 << 20;
const MAX_HITS: usize = 5000;
const MAX_UNDO: usize = 300;
/// até este tamanho do primeiro remendo ao fim, salvar reescreve só o rabo no lugar
const TAIL_INPLACE: u64 = 64 << 20;

#[derive(Default)]
struct Index {
    size: u64,
    mtime: Option<SystemTime>,
    /// bytes já indexados e quebras de linha achadas neles
    scanned: u64,
    newlines: u64,
    /// checkpoints[k] = posição do começo da linha k*STEP (base 0)
    checkpoints: Vec<u64>,
    last_byte_nl: bool,
    /// últimos bytes indexados: confere que o arquivo só cresceu antes de continuar o índice
    tail: Vec<u8>,
    building: bool,
    error: Option<String>,
    /// muda quando o índice recomeça do zero (o arquivo foi reescrito por fora): remendos antigos deixam de valer
    epoch: u64,
    /// linhas que o arquivo tem depois de salvar, enquanto o índice ainda refaz o fim (a contagem não encolhe na tela)
    expect: u64,
}
impl Index {
    fn done(&self) -> bool { !self.building && self.scanned >= self.size }
    /// linhas conhecidas até agora (a última sem \n também conta)
    fn lines(&self) -> u64 {
        let n = self.newlines + u64::from(self.scanned > 0 && !self.last_byte_nl && self.done());
        if self.building { n.max(self.expect) } else { n }
    }
    /// marco mais próximo antes da linha: (posição, linha do marco)
    fn mark(&self, line: u64) -> (u64, u64) {
        let k = ((line / STEP) as usize).min(self.checkpoints.len().saturating_sub(1));
        (self.checkpoints.get(k).copied().unwrap_or(0), k as u64 * STEP)
    }
}

/// troca as linhas originais [o0, o1) por `lines`
#[derive(Clone)]
struct Patch { o0: u64, o1: u64, lines: Arc<Vec<String>> }
impl Patch { fn delta(&self) -> i64 { self.lines.len() as i64 - (self.o1 - self.o0) as i64 } }

#[derive(Default)]
struct Edits {
    /// ordenados e separados por pelo menos uma linha original intacta
    patches: Vec<Patch>,
    undo: Vec<Vec<Patch>>,
    redo: Vec<Vec<Patch>>,
    /// geração do índice em que os remendos foram feitos
    epoch: u64,
}

static INDEXES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<Index>>>>> = LazyLock::new(Default::default);
static EDITS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<Edits>>>>> = LazyLock::new(Default::default);
static SEARCH_GEN: LazyLock<Mutex<HashMap<PathBuf, Arc<AtomicU64>>>> = LazyLock::new(Default::default);

fn edits(path: &Path) -> Arc<Mutex<Edits>> { EDITS.lock().entry(path.to_path_buf()).or_default().clone() }

/// índice do arquivo, (re)montando em segundo plano se o arquivo mudou
fn index(path: &Path) -> std::io::Result<Arc<Mutex<Index>>> {
    let md = std::fs::metadata(path)?;
    let (size, mtime) = (md.len(), md.modified().ok());
    let ix = INDEXES.lock().entry(path.to_path_buf()).or_default().clone();
    let start = {
        let mut i = ix.lock();
        if i.building || (i.size == size && i.mtime == mtime && i.scanned >= size) { return Ok(ix.clone()); }
        // cresceu (log) e o fim antigo continua igual: continua de onde parou; senão recomeça
        let grew = size > i.scanned && i.scanned > 0 && i.error.is_none() && tail_matches(path, i.scanned, &i.tail);
        if !grew { let epoch = i.epoch + 1; *i = Index { checkpoints: vec![0], epoch, ..Default::default() }; }
        i.size = size; i.mtime = mtime; i.building = true;
        i.scanned
    };
    spawn_build(path, &ix, start);
    Ok(ix)
}

fn spawn_build(path: &Path, ix: &Arc<Mutex<Index>>, start: u64) {
    let (ix2, p) = (ix.clone(), path.to_path_buf());
    let _ = std::thread::Builder::new().name("bs-bigfile".into()).spawn(move || {
        // erro interno no meio do índice: o arquivo fica com erro (o gancho de main.rs anota no log), não "indexando" para sempre
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(&p, &ix2, start)));
        let mut i = ix2.lock();
        i.building = false;
        match r { Ok(Err(e)) => i.error = Some(e.to_string()), Err(_) => i.error = Some("erro interno ao indexar o arquivo".into()), Ok(Ok(_)) => {} }
    });
}

/// depois de salvar: o arquivo é igual ao antigo até `from`; refaz o índice só a partir do marco anterior
fn reindex_from(path: &Path, from: u64, expect: u64) -> std::io::Result<()> {
    let md = std::fs::metadata(path)?;
    let ix = INDEXES.lock().entry(path.to_path_buf()).or_default().clone();
    let start = {
        let mut i = ix.lock();
        let k = i.checkpoints.partition_point(|&c| c <= from).saturating_sub(1);
        i.checkpoints.truncate(k + 1);
        if i.checkpoints.is_empty() { i.checkpoints.push(0); }
        i.newlines = k as u64 * STEP; i.scanned = i.checkpoints[k];
        i.size = md.len(); i.mtime = md.modified().ok(); i.error = None; i.building = true;
        i.last_byte_nl = false; i.tail.clear(); i.expect = expect;
        i.scanned
    };
    spawn_build(path, &ix, start);
    Ok(())
}

fn tail_matches(path: &Path, end: u64, tail: &[u8]) -> bool {
    let mut b = vec![0u8; tail.len()];
    std::fs::File::open(path).and_then(|mut f| { f.seek(SeekFrom::Start(end - tail.len() as u64))?; f.read_exact(&mut b) }).is_ok() && b == tail
}

fn build(path: &Path, ix: &Mutex<Index>, start: u64) -> std::io::Result<()> {
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(start))?;
    let end = ix.lock().size;
    let mut buf = vec![0u8; CHUNK];
    let mut pos = start;
    while pos < end {
        let want = ((end - pos) as usize).min(CHUNK);
        let n = f.read(&mut buf[..want])?;
        if n == 0 { break; }
        let block = &buf[..n];
        // marcos coletados fora do lock; a página lê o índice enquanto ele cresce
        let mut nl = ix.lock().newlines;
        let mut cps = vec![];
        for i in memchr::memchr_iter(b'\n', block) {
            nl += 1;
            if nl % STEP == 0 { cps.push(pos + i as u64 + 1); }
        }
        let mut i = ix.lock();
        i.newlines = nl; i.checkpoints.extend(cps);
        pos += n as u64; i.scanned = pos; i.last_byte_nl = block[n - 1] == b'\n';
        i.tail = block[n.saturating_sub(64)..].to_vec();
    }
    Ok(())
}

/// estado do índice e das edições, numa olhada: (linhas originais, pronto, geração, remendos válidos, remendos antigos?)
struct View { orig: u64, done: bool, size: u64, epoch: u64, patches: Vec<Patch>, stale: bool, undo: usize, redo: usize }
fn view(path: &Path) -> Result<(Arc<Mutex<Index>>, View), String> {
    let ix = index(path).map_err(|e| e.to_string())?;
    let (orig, done, size, epoch) = { let i = ix.lock(); (i.lines(), i.done(), i.size, i.epoch) };
    let e = edits(path);
    let e = e.lock();
    // o arquivo foi reescrito por fora: os remendos apontam para linhas que não existem mais
    let stale = !e.patches.is_empty() && e.epoch != epoch;
    Ok((ix, View { orig, done, size, epoch, patches: if stale { vec![] } else { e.patches.clone() }, stale, undo: e.undo.len(), redo: e.redo.len() }))
}
fn v_total(patches: &[Patch], orig: u64) -> u64 { (orig as i64 + patches.iter().map(Patch::delta).sum::<i64>()).max(0) as u64 }

pub fn info(path: &Path) -> Result<Value, String> {
    let (ix, v) = view(path)?;
    let i = ix.lock();
    let pending = v.patches.len() + usize::from(v.stale);
    Ok(json!({
        "size": i.size, "lines": v_total(&v.patches, v.orig), "orig": v.orig, "done": i.done(), "scanned": i.scanned,
        "progress": if i.size == 0 { 1.0 } else { i.scanned as f64 / i.size as f64 }, "error": i.error,
        "dirty": pending > 0, "edits": v.patches.len(), "stale": v.stale, "undo": v.undo, "redo": v.redo,
    }))
}

/// um pedaço do arquivo editado: linhas do original ou de um remendo
enum Piece<'a> { Orig { from: u64, n: u64 }, New { p: &'a Patch, from: usize, n: usize } }
/// percorre as linhas [v_from, v_to) do arquivo editado
fn pieces(patches: &[Patch], orig: u64, v_from: u64, v_to: u64) -> Vec<Piece<'_>> {
    let (mut out, mut v, mut o) = (vec![], 0u64, 0u64);
    for p in patches.iter().map(Some).chain([None]) {
        if v >= v_to { break; }
        // linhas originais intactas [o, fim) ↔ editado [v, v+n)
        let n = p.map_or(orig, |p| p.o0).saturating_sub(o);
        let (a, b) = (v.max(v_from), (v + n).min(v_to));
        if a < b { out.push(Piece::Orig { from: o + (a - v), n: b - a }); }
        v += n;
        if let Some(p) = p {
            let n = p.lines.len() as u64;
            let (a, b) = (v.max(v_from), (v + n).min(v_to));
            if a < b { out.push(Piece::New { p, from: (a - v) as usize, n: (b - a) as usize }); }
            v += n; o = p.o1;
        }
    }
    out
}

/// linhas [from, from+count) (base 0) do arquivo editado; { from, lines: [texto], cut: [[linha, caracteres a mais]],
/// edited: [[linha, quantas]] (linhas vindas de remendos) }. full: linhas inteiras, sem corte (para editar)
pub fn lines(path: &Path, from: u64, count: u64, full: bool) -> Result<Value, String> {
    let (ix, v) = view(path)?;
    let total = v_total(&v.patches, v.orig);
    let count = count.min(if full { MAX_FULL_LINES } else { MAX_LINES });
    let (mut out, mut cut, mut edited) = (Vec::<String>::new(), Vec::<(usize, u64)>::new(), Vec::<(usize, usize)>::new());
    let mut bytes = 0usize;
    for pc in pieces(&v.patches, v.orig, from, from.saturating_add(count)) {
        match pc {
            Piece::Orig { from, n } => {
                let (cp, base) = ix.lock().mark(from);
                read_orig(path, cp, base, from, n, full, &mut out, &mut cut, &mut bytes)?;
                if full && bytes > MAX_FULL_BYTES { return Err("Trecho grande demais para editar de uma vez (linhas enormes); edite menos linhas.".into()); }
            }
            Piece::New { p, from, n } => {
                edited.push((out.len(), n));
                for l in &p.lines[from..from + n] {
                    let chars = if full { 0 } else { l.chars().count() };
                    if !full && chars > MAX_COL { cut.push((out.len(), (chars - MAX_COL) as u64)); out.push(l.chars().take(MAX_COL).collect()); }
                    else { out.push(l.clone()); }
                }
            }
        }
    }
    Ok(json!({ "from": from, "lines": out, "cut": cut, "edited": edited, "total": total, "done": v.done }))
}

/// lê do original as linhas [from, from+n), partindo do marco (cp = posição da linha `base`)
#[allow(clippy::too_many_arguments)]
fn read_orig(path: &Path, cp: u64, base: u64, from: u64, n: u64, full: bool, out: &mut Vec<String>, cut: &mut Vec<(usize, u64)>, bytes: &mut usize) -> Result<(), String> {
    let mut r = BufReader::with_capacity(256 << 10, std::fs::File::open(path).map_err(|e| e.to_string())?);
    r.seek(SeekFrom::Start(cp)).map_err(|e| e.to_string())?;
    skip_lines(&mut r, from - base).map_err(|e| e.to_string())?;
    let cap = if full { usize::MAX } else { MAX_COL * 4 };
    let mut cur: Vec<u8> = Vec::new();
    for _ in 0..n {
        cur.clear();
        let (more, eof) = read_line(&mut r, &mut cur, cap).map_err(|e| e.to_string())?;
        if eof && cur.is_empty() && more == 0 { break; }
        let mut s = String::from_utf8_lossy(&cur).into_owned();
        if s.ends_with('\r') { s.pop(); }
        if more > 0 { cut.push((out.len(), more)); }
        *bytes += s.len();
        out.push(s);
        if eof || (full && *bytes > MAX_FULL_BYTES) { break; }
    }
    Ok(())
}

/// pula n linhas; devolve os bytes andados
fn skip_lines<R: BufRead>(r: &mut R, mut n: u64) -> std::io::Result<u64> {
    let mut walked = 0u64;
    while n > 0 {
        let buf = r.fill_buf()?;
        if buf.is_empty() { break; }
        let mut used = buf.len();
        for i in memchr::memchr_iter(b'\n', buf) { n -= 1; if n == 0 { used = i + 1; break; } }
        r.consume(used); walked += used as u64;
    }
    Ok(walked)
}

/// lê uma linha guardando no máximo `cap` bytes; devolve (bytes que sobraram sem guardar, chegou ao fim)
fn read_line<R: BufRead>(r: &mut R, keep: &mut Vec<u8>, cap: usize) -> std::io::Result<(u64, bool)> {
    let mut dropped = 0u64;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() { return Ok((dropped, true)); }
        let (part, found) = match memchr::memchr(b'\n', buf) { Some(i) => (&buf[..i], i + 1), None => (buf, 0) };
        let room = cap.saturating_sub(keep.len());
        keep.extend_from_slice(&part[..part.len().min(room)]);
        dropped += part.len().saturating_sub(room) as u64;
        let used = if found > 0 { found } else { buf.len() };
        r.consume(used);
        if found > 0 { return Ok((dropped, false)); }
    }
}

// ----- edição -----

/// troca as linhas [v0, v1) do arquivo editado por `new`. Um remendo que encosta ou cruza o trecho é absorvido
/// (o pedaço dele fora do trecho vai junto), então os remendos continuam ordenados e sem se tocar.
fn apply(patches: &mut Vec<Patch>, orig: u64, v0: u64, v1: u64, new: Vec<String>) -> Result<(), String> {
    let total = v_total(patches, orig);
    if v0 > v1 || v1 > total { return Err(format!("Linhas fora do arquivo ({v0}–{v1} de {total})")); }
    // começo de cada remendo no arquivo editado
    let mut vs = Vec::with_capacity(patches.len());
    let mut cum = 0i64;
    for p in patches.iter() { vs.push((p.o0 as i64 + cum) as u64); cum += p.delta(); }
    let inside = |v: u64| (0..patches.len()).find(|&i| v >= vs[i] && v <= vs[i] + patches[i].lines.len() as u64);
    // linha do editado fora de remendos → linha original (descontando o que os remendos antes dela mudaram)
    let to_orig = |v: u64| { let d: i64 = patches.iter().zip(&vs).filter(|(p, s)| *s + p.lines.len() as u64 <= v).map(|(p, _)| p.delta()).sum(); (v as i64 - d) as u64 };
    let (o0, mut lines) = match inside(v0) { Some(i) => (patches[i].o0, patches[i].lines[..(v0 - vs[i]) as usize].to_vec()), None => (to_orig(v0), vec![]) };
    lines.extend(new);
    let o1 = match inside(v1) { Some(i) => { lines.extend_from_slice(&patches[i].lines[(v1 - vs[i]) as usize..]); patches[i].o1 } None => to_orig(v1) };
    patches.retain(|p| p.o1 < o0 || p.o0 > o1);
    if o0 == o1 && lines.is_empty() { return Ok(()); }
    let at = patches.partition_point(|p| p.o0 < o0);
    patches.insert(at, Patch { o0, o1, lines: Arc::new(lines) });
    Ok(())
}

/// troca as linhas [from, to) do arquivo editado pelo texto (linhas separadas por \n); None apaga as linhas
pub fn edit(path: &Path, from: u64, to: u64, text: Option<&str>) -> Result<Value, String> {
    let (_, v) = view(path)?;
    if !v.done { return Err("Espere terminar de indexar o arquivo para editar.".into()); }
    if v.stale { return Err("O arquivo mudou no disco depois das suas edições; descarte-as para continuar.".into()); }
    let lines: Vec<String> = text.map(|t| t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()).unwrap_or_default();
    {
        let e = edits(path);
        let mut e = e.lock();
        let before = e.patches.clone();
        if before.is_empty() { e.epoch = v.epoch; }
        apply(&mut e.patches, v.orig, from, to, lines)?;
        e.undo.push(before);
        if e.undo.len() > MAX_UNDO { e.undo.remove(0); }
        e.redo.clear();
    }
    info(path)
}

/// desfazer (dir < 0), refazer (dir > 0) ou descartar tudo (dir == 0; volta com desfazer)
pub fn history(path: &Path, dir: i32) -> Result<Value, String> {
    {
        let e = edits(path);
        let mut e = e.lock();
        match dir {
            // descartar também pode ser desfeito
            0 => if !e.patches.is_empty() { let cur = std::mem::take(&mut e.patches); e.undo.push(cur); e.redo.clear(); },
            d if d < 0 => if let Some(p) = e.undo.pop() { let cur = std::mem::replace(&mut e.patches, p); e.redo.push(cur); },
            _ => if let Some(p) = e.redo.pop() { let cur = std::mem::replace(&mut e.patches, p); e.undo.push(cur); },
        }
    }
    info(path)
}

/// posição (byte) do começo da linha original `line` (o tamanho do arquivo se passar do fim)
fn line_start(path: &Path, ix: &Mutex<Index>, line: u64, orig: u64, size: u64) -> std::io::Result<u64> {
    if line >= orig { return Ok(size); }
    let (cp, base) = ix.lock().mark(line);
    let mut r = BufReader::with_capacity(64 << 10, std::fs::File::open(path)?);
    r.seek(SeekFrom::Start(cp))?;
    Ok(cp + skip_lines(&mut r, line - base)?)
}

/// grava as edições no disco, pelo caminho mais barato (ver o começo do arquivo)
pub fn save(path: &Path) -> Result<Value, String> {
    let t0 = Instant::now();
    let (ix, v) = view(path)?;
    if v.stale { return Err("O arquivo mudou no disco depois das suas edições; não dá para aplicá-las.".into()); }
    if v.patches.is_empty() { return Ok(json!({ "saved": false })); }
    if !v.done { return Err("Espere terminar de indexar o arquivo.".into()); }
    let e = edits(path);
    let mut e = e.lock();
    let (mtime, final_nl) = { let i = ix.lock(); (i.mtime, i.last_byte_nl) };
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if md.len() != v.size || md.modified().ok() != mtime { return Err("O arquivo mudou no disco agora há pouco; tente de novo.".into()); }
    let size = v.size;
    let io = |e: std::io::Error| e.to_string();
    let eol: &[u8] = if crlf(path) { b"\r\n" } else { b"\n" };
    // cada remendo: (começo, fim) em bytes no original e os bytes novos
    let mut segs: Vec<(u64, u64, Vec<u8>)> = vec![];
    for p in &e.patches {
        let (a, b) = (line_start(path, &ix, p.o0, v.orig, size).map_err(io)?, line_start(path, &ix, p.o1, v.orig, size).map_err(io)?);
        let mut nb = Vec::new();
        // inserir depois da última linha de um arquivo sem \n no fim: termina a linha antiga primeiro
        if p.o0 >= v.orig && v.orig > 0 && !final_nl && !p.lines.is_empty() { nb.extend_from_slice(eol); }
        for (k, l) in p.lines.iter().enumerate() {
            nb.extend_from_slice(l.as_bytes());
            // a última linha do arquivo continua sem \n se já não tinha
            if !(k + 1 == p.lines.len() && p.o1 >= v.orig && !final_nl) { nb.extend_from_slice(eol); }
        }
        segs.push((a, b, nb));
    }
    let first = segs[0].0;
    let mode;
    if segs.iter().all(|(a, b, nb)| nb.len() as u64 == b - a) {
        // mesmo tamanho: só os bytes trocados
        let mut f = std::fs::OpenOptions::new().write(true).open(path).map_err(io)?;
        for (a, _, nb) in &segs { f.seek(SeekFrom::Start(*a)).map_err(io)?; f.write_all(nb).map_err(io)?; }
        f.sync_all().map_err(io)?;
        mode = "patch";
    } else if size - first <= TAIL_INPLACE {
        // perto do fim: monta o rabo novo na memória e grava por cima a partir do primeiro remendo
        let mut src = std::fs::File::open(path).map_err(io)?;
        let mut tail = Vec::with_capacity((size - first) as usize + segs.iter().map(|s| s.2.len()).sum::<usize>());
        compose(&mut src, first, size, &segs, &mut tail).map_err(io)?;
        drop(src);
        let mut f = std::fs::OpenOptions::new().write(true).open(path).map_err(io)?;
        f.seek(SeekFrom::Start(first)).map_err(io)?;
        f.write_all(&tail).map_err(io)?;
        f.set_len(first + tail.len() as u64).map_err(io)?;
        f.sync_all().map_err(io)?;
        mode = "tail";
    } else {
        // arquivo novo ao lado e troca atômica: uma falha no meio não estraga o original
        let tmp = path.with_file_name(format!(".{}.bs-save~", path.file_name().and_then(|n| n.to_str()).unwrap_or("arquivo")));
        let r = (|| -> std::io::Result<()> {
            let mut src = std::fs::File::open(path)?;
            let mut out = BufWriter::with_capacity(CHUNK, std::fs::File::create(&tmp)?);
            compose(&mut src, 0, size, &segs, &mut out)?;
            let f = out.into_inner().map_err(|e| e.into_error())?;
            f.sync_all()?;
            drop((f, src));
            std::fs::rename(&tmp, path)
        })();
        if let Err(err) = r { let _ = std::fs::remove_file(&tmp); return Err(format!("Não deu para salvar: {err}")); }
        mode = "rewrite";
    }
    let lines_now = v_total(&e.patches, v.orig);
    e.patches.clear(); e.undo.clear(); e.redo.clear();
    drop(e);
    reindex_from(path, first, lines_now).map_err(io)?;
    let md = std::fs::metadata(path).ok();
    Ok(json!({ "saved": true, "mode": mode, "ms": t0.elapsed().as_millis() as u64, "size": md.as_ref().map(|m| m.len()), "mtime": md.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64) }))
}

/// original de `from` a `end`, com os remendos no lugar dos trechos trocados
fn compose<W: Write>(src: &mut std::fs::File, from: u64, end: u64, segs: &[(u64, u64, Vec<u8>)], out: &mut W) -> std::io::Result<()> {
    fn copy<W: Write>(src: &mut std::fs::File, a: u64, b: u64, out: &mut W) -> std::io::Result<()> {
        if b > a { src.seek(SeekFrom::Start(a))?; std::io::copy(&mut Read::take(&mut *src, b - a), out)?; }
        Ok(())
    }
    let mut pos = from;
    for (a, b, nb) in segs { copy(src, pos, *a, out)?; out.write_all(nb)?; pos = *b; }
    copy(src, pos, end, out)
}

/// o arquivo usa \r\n? (olha a primeira quebra de linha)
fn crlf(path: &Path) -> bool {
    let mut b = vec![0u8; 64 << 10];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut b)).unwrap_or(0);
    memchr::memchr(b'\n', &b[..n]).is_some_and(|i| i > 0 && b[i - 1] == b'\r')
}

// ----- busca -----

/// um achado: linha, coluna e tamanho em caracteres, e o trecho em volta (linhas enormes)
fn hit(line: u64, block: &[u8], ls: usize, le: usize, ms: usize, me: usize) -> Value {
    let col = String::from_utf8_lossy(&block[ls..ms]).chars().count();
    let len = String::from_utf8_lossy(&block[ms..me.min(le)]).chars().count();
    let a = ms.saturating_sub(120).max(ls);
    let b = (me + 200).min(le);
    let mut text = String::from_utf8_lossy(&block[a..b]).trim_end_matches('\r').to_string();
    if a > ls { text.insert(0, '…'); }
    json!({ "line": line, "col": col, "len": len, "text": text, "tcol": String::from_utf8_lossy(&block[a..ms]).chars().count() + usize::from(a > ls) })
}

/// busca no arquivo todo (já com as edições): { hits: [{ line, col, len, text }], total, more, cancelled }
pub fn search(path: &Path, q: &str, case: bool, regex: bool) -> Result<Value, String> {
    if q.is_empty() { return Ok(json!({ "hits": [], "total": 0 })); }
    let pat = if regex { q.to_string() } else { regex::escape(q) };
    let re = regex::bytes::RegexBuilder::new(&pat).case_insensitive(!case).multi_line(true).size_limit(1 << 24).build().map_err(|e| format!("Regex inválida: {e}"))?;
    let turn = SEARCH_GEN.lock().entry(path.to_path_buf()).or_insert_with(|| Arc::new(AtomicU64::new(0))).clone();
    let me = turn.fetch_add(1, Ordering::SeqCst) + 1;
    let (_, v) = view(path)?;
    // remendos: (o0, o1, quanto as linhas depois deles andam no arquivo editado, começo no editado)
    let mut map = Vec::with_capacity(v.patches.len());
    let mut cum = 0i64;
    for p in &v.patches { let vs = (p.o0 as i64 + cum) as u64; cum += p.delta(); map.push((p.o0, p.o1, cum, vs)); }
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK + 4096);
    let mut chunk = vec![0u8; CHUNK];
    let (mut line_base, mut hits, mut total) = (0u64, Vec::<Value>::new(), 0u64);
    let mut mi = 0usize; // próximo remendo (os achados vêm em ordem de linha)
    let mut eof = false;
    while !eof {
        if turn.load(Ordering::SeqCst) != me { return Ok(json!({ "cancelled": true })); }
        let n = f.read(&mut chunk).map_err(|e| e.to_string())?;
        eof = n == 0;
        buf.extend_from_slice(&chunk[..n]);
        // processa só linhas completas; o pedaço final espera o próximo bloco (no fim, vai tudo)
        let upto = if eof { buf.len() } else { match memchr::memrchr(b'\n', &buf) { Some(i) => i + 1, None => continue } };
        let block = &buf[..upto];
        let (mut at, mut line) = (0usize, line_base);
        for m in re.find_iter(block) {
            if m.start() == m.end() { continue; }
            line += memchr::memchr_iter(b'\n', &block[at..m.start()]).count() as u64;
            at = m.start();
            while mi < map.len() && map[mi].1 <= line { mi += 1; }
            // linha trocada por um remendo: o achado no original não existe mais
            if mi < map.len() && line >= map[mi].0 { continue; }
            total += 1;
            if hits.len() < MAX_HITS {
                let vline = (line as i64 + if mi > 0 { map[mi - 1].2 } else { 0 }) as u64;
                let ls = memchr::memrchr(b'\n', &block[..m.start()]).map(|i| i + 1).unwrap_or(0);
                let le = memchr::memchr(b'\n', &block[m.start()..]).map(|i| m.start() + i).unwrap_or(block.len());
                hits.push(hit(vline, block, ls, le, m.start(), m.end()));
            }
        }
        line_base += memchr::memchr_iter(b'\n', block).count() as u64;
        buf.drain(..upto);
    }
    // achados dentro das linhas editadas
    let capped = hits.len() >= MAX_HITS;
    let last_orig = hits.last().and_then(|h| h["line"].as_u64());
    let mut extra = vec![];
    for (p, &(_, _, _, vs)) in v.patches.iter().zip(&map) {
        for (k, l) in p.lines.iter().enumerate() {
            let b = l.as_bytes();
            for m in re.find_iter(b) {
                if m.start() == m.end() { continue; }
                total += 1;
                if extra.len() < MAX_HITS { extra.push(hit(vs + k as u64, b, 0, b.len(), m.start(), m.end())); }
            }
        }
    }
    if !extra.is_empty() {
        hits.extend(extra);
        hits.sort_by_key(|h| (h["line"].as_u64(), h["col"].as_u64()));
        // a lista cortada continua sendo "os primeiros N" do arquivo
        if capped { if let Some(l) = last_orig { hits.retain(|h| h["line"].as_u64() <= Some(l)); } }
        hits.truncate(MAX_HITS);
    }
    Ok(json!({ "hits": hits, "total": total, "more": total as usize > hits.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wait(p: &Path) { for _ in 0..400 { if info(p).unwrap()["done"].as_bool() == Some(true) { return; } std::thread::sleep(std::time::Duration::from_millis(10)); } }
    fn all(p: &Path) -> Vec<String> { serde_json::from_value(lines(p, 0, 100_000, true).unwrap()["lines"].clone()).unwrap() }
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-big-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("a.log")
    }
    #[test]
    fn index_lines_search() {
        let p = tmp("read");
        let text: String = (0..5000).map(|i| format!("linha {i} valor={}\r\n", i * 3)).collect();
        std::fs::write(&p, &text).unwrap();
        wait(&p);
        assert_eq!(info(&p).unwrap()["lines"], 5000);
        let l = lines(&p, 2047, 3, false).unwrap();
        assert_eq!(l["lines"], json!(["linha 2047 valor=6141", "linha 2048 valor=6144", "linha 2049 valor=6147"]));
        let s = search(&p, "VALOR=6144", false, false).unwrap();
        assert_eq!(s["total"], 1);
        assert_eq!(s["hits"][0]["line"], 2048);
        assert_eq!(s["hits"][0]["col"], 11);
        assert_eq!(search(&p, r"linha 49\d\d ", true, true).unwrap()["total"], 100);
        // log que cresce: continua o índice
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        std::io::Write::write_all(&mut f, b"nova 1\nnova 2").unwrap();
        drop(f);
        std::thread::sleep(std::time::Duration::from_millis(20));
        wait(&p);
        assert_eq!(info(&p).unwrap()["lines"], 5002);
        assert_eq!(lines(&p, 5000, 10, false).unwrap()["lines"], json!(["nova 1", "nova 2"]));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    /// remendos aplicados num modelo simples (Vec de linhas) têm de dar o mesmo resultado
    #[test]
    fn edit_matches_model() {
        let orig: Vec<String> = (0..50).map(|i| format!("l{i}")).collect();
        let mut model = orig.clone();
        let mut patches = vec![];
        let mut seed = 7u64;
        let mut rnd = |n: u64| { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) % n.max(1) };
        for step in 0..400 {
            let len = model.len() as u64;
            let a = rnd(len + 1);
            let b = (a + rnd(4)).min(len);
            let new: Vec<String> = (0..rnd(4)).map(|k| format!("n{step}.{k}")).collect();
            apply(&mut patches, orig.len() as u64, a, b, new.clone()).unwrap();
            model.splice(a as usize..b as usize, new);
            // o editado (original + remendos) é igual ao modelo
            let mut got = vec![];
            for pc in pieces(&patches, orig.len() as u64, 0, u64::MAX) {
                match pc { Piece::Orig { from, n } => got.extend_from_slice(&orig[from as usize..(from + n) as usize]), Piece::New { p, from, n } => got.extend_from_slice(&p.lines[from..from + n]) }
            }
            assert_eq!(got, model, "passo {step}");
            assert_eq!(v_total(&patches, orig.len() as u64), model.len() as u64);
            // remendos ordenados e separados
            assert!(patches.windows(2).all(|w| w[0].o1 < w[1].o0), "passo {step}");
        }
    }

    #[test]
    fn edit_search_save() {
        for (name, eol, final_nl, n) in [("crlf", "\r\n", true, 3000u64), ("lf-sem-fim", "\n", false, 3000), ("vazio", "\n", false, 0)] {
            let p = tmp(name);
            let mut text: String = (0..n).map(|i| format!("linha {i}{eol}")).collect();
            if !final_nl && text.ends_with(eol) { text.truncate(text.len() - eol.len()); }
            std::fs::write(&p, &text).unwrap();
            wait(&p);
            let mut model: Vec<String> = all(&p);
            assert_eq!(model.len() as u64, n);
            let ed = |a: u64, b: u64, t: &str, model: &mut Vec<String>| {
                edit(&p, a, b, Some(t)).unwrap();
                model.splice(a as usize..b as usize, t.split('\n').map(String::from));
                assert_eq!(&all(&p), model);
            };
            if n > 0 {
                ed(10, 12, "trocada A\ntrocada B\nextra", &mut model);
                ed(2050, 2050, "inserida", &mut model);
                let end = model.len() as u64;
                ed(end, end, "no fim", &mut model);
                // apagar linhas (sem texto) e trocar por uma linha vazia ("") são coisas diferentes
                edit(&p, 2000, 2100, None).unwrap();
                model.drain(2000..2100);
                assert_eq!(all(&p), model);
                ed(500, 1500, "", &mut model);
                // a busca enxerga as edições e pula as linhas apagadas
                let s = search(&p, "linha 1600", true, false).unwrap();
                assert_eq!(s["total"], 1);
                assert_eq!(s["hits"][0]["line"].as_u64().unwrap() as usize, model.iter().position(|l| l == "linha 1600").unwrap());
                assert_eq!(search(&p, "linha 700", true, false).unwrap()["total"], 0);
                assert_eq!(search(&p, "trocada", true, false).unwrap()["total"], 2);
                // desfazer e refazer
                history(&p, -1).unwrap();
                assert_eq!(all(&p).len(), model.len() + 1000 - 1);
                history(&p, 1).unwrap();
                assert_eq!(all(&p), model);
            } else {
                ed(0, 0, "primeira\nsegunda", &mut model);
            }
            let r = save(&p).unwrap();
            assert_eq!(r["saved"], true);
            let disk = std::fs::read_to_string(&p).unwrap();
            let mut want = model.join(eol);
            if final_nl { want.push_str(eol); }
            assert_eq!(disk, want, "{name}");
            wait(&p);
            assert_eq!(all(&p), model, "{name} depois de salvar");
            assert_eq!(info(&p).unwrap()["dirty"], false);
            // mesmo tamanho: grava só os bytes trocados
            if n > 0 {
                edit(&p, 3, 4, Some("LINHA 3")).unwrap();
                assert_eq!(save(&p).unwrap()["mode"], "patch");
                wait(&p);
                assert_eq!(all(&p)[3], "LINHA 3");
            }
            let _ = std::fs::remove_dir_all(p.parent().unwrap());
        }
    }
}
