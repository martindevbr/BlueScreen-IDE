// QAutils: cenários do QA (plugin nativo, só interface). Usa o índice e a busca do núcleo, a pasta de dados do plugin e o
// console de Build; nada de servidor próprio. O painel QA (Alt+9) tem uma aba fixa na área do editor (quadro de
// execução por status e cobertura por chamado, tag ou pasta) e mostra os cenários
// (Gherkin/Cucumber): features por pasta e por chamado, busca por texto, @tag ou chamado,
//   tags e o andamento da execução manual. No editor (.feature): autocompletar com os passos do projeto e as step
//   definitions, aviso de passo parecido, Contexto automático, renumeração dos CTs, formatação (Shift+Alt+F); acima de
//   cada cenário o status (Passou/Falhou/Bloqueado), as evidências coladas e "Copiar"; relatório de evidências (HTML)
//   e casos de teste (CSV). Em projetos automatizados: steps sem definição, F12, gerar a definição e ▶ executar. Cenário que falhou: relatório de bug já preenchido
const { S, api, esc, toast, store, $ } = bs;
// onde o mouse clicou por último: os menus abertos pelo editor (CodeLens) aparecem ali
const mouse = { x: innerWidth / 2, y: innerHeight / 3 };
document.addEventListener('mousedown', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, true);
const atMouse = () => ({ preventDefault() {}, stopPropagation() {}, clientX: mouse.x, clientY: mouse.y + 8 });

const ICO = {
  qa: '<svg class="i" viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  cam: '<svg class="i" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  doc: '<svg class="i" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
  csv: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/></svg>',
  chev: '<svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  fail: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  block: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>',
  link: '<svg class="i" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  folder: '<svg class="i" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  bug: '<svg class="i" viewBox="0 0 24 24"><path d="M8 8h8v8a4 4 0 0 1-8 0zM9 8a3 3 0 0 1 6 0M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2"/></svg>',
  feat: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9 9h.01M14 8h.01M12 12h.01M9 15h.01M15 14h.01"/></svg>',
};
const STATUS = {
  pass: { label: 'Passou', ico: ICO.ok, sym: '✓' },
  fail: { label: 'Falhou', ico: ICO.fail, sym: '✗' },
  blocked: { label: 'Bloqueado', ico: ICO.block, sym: '⊘' },
};

// ---------- Gherkin ----------
const KW = {
  en: { feature: ['Feature', 'Business Need', 'Ability'], rule: ['Rule'], background: ['Background'], scenario: ['Scenario', 'Example'], outline: ['Scenario Outline', 'Scenario Template'], examples: ['Examples', 'Scenarios'], given: ['Given'], when: ['When'], then: ['Then'], and: ['And'], but: ['But'] },
  pt: { feature: ['Funcionalidade', 'Característica', 'Caracteristica'], rule: ['Regra'], background: ['Contexto', 'Cenário de Fundo', 'Cenario de Fundo', 'Fundo'], scenario: ['Cenário', 'Cenario', 'Exemplo'], outline: ['Esquema do Cenário', 'Esquema do Cenario', 'Delineação do Cenário', 'Delineacao do Cenario'], examples: ['Exemplos', 'Cenários', 'Cenarios'], given: ['Dado', 'Dada', 'Dados', 'Dadas'], when: ['Quando'], then: ['Então', 'Entao'], and: ['E'], but: ['Mas'] },
  es: { feature: ['Característica', 'Necesidad del negocio', 'Requisito'], rule: ['Regla', 'Regla de negocio'], background: ['Antecedentes'], scenario: ['Escenario', 'Ejemplo'], outline: ['Esquema del escenario'], examples: ['Ejemplos'], given: ['Dado', 'Dada', 'Dados', 'Dadas'], when: ['Cuando'], then: ['Entonces'], and: ['Y', 'E'], but: ['Pero'] },
};
const HEADS = ['feature', 'rule', 'background', 'outline', 'scenario', 'examples'];
const STEPS = ['given', 'when', 'then', 'and', 'but'];
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RX = {};
function rx(lang) {
  if (RX[lang]) return RX[lang];
  const K = KW[lang];
  const heads = HEADS.flatMap(h => K[h].map(w => [w, h])).sort((a, b) => b[0].length - a[0].length);
  const steps = STEPS.flatMap(s => K[s].map(w => [w, s])).sort((a, b) => b[0].length - a[0].length);
  return RX[lang] = {
    head: new RegExp(`^(\\s*)(${heads.map(x => reEsc(x[0])).join('|')})\\s*:\\s?(.*)$`), headOf: new Map(heads),
    step: new RegExp(`^(\\s*)(${steps.map(x => reEsc(x[0])).join('|')}|\\*)\\s+(.*)$`), stepOf: new Map(steps),
  };
}
// idioma: "# language: pt" ou o das palavras-chave usadas (muita feature em português usa Feature/Scenario)
function detLang(text) {
  const m = /^\s*#\s*language\s*:\s*([\w-]+)/m.exec(text);
  if (m) { const l = m[1].toLowerCase().split('-')[0]; return KW[l] ? l : 'en'; }
  for (const ln of text.split('\n', 400)) for (const l of ['en', 'pt', 'es']) if (rx(l).head.test(ln)) return l;
  return null;
}
const langOf = (text) => detLang(text) || 'en';
// idioma de um arquivo ainda sem palavras-chave: o da configuração ou o da maioria das features do projeto (sem features: português)
function projLang() {
  if (P.settings.lang && P.settings.lang !== 'auto') return P.settings.lang;
  // só contam features com palavras-chave (um arquivo ainda vazio não decide nada)
  const c = { pt: 0, en: 0, es: 0 }; for (const f of P.files.values()) if (f.doc.det) c[f.doc.det]++;
  return c.pt + c.es >= c.en ? (c.es > c.pt ? 'es' : 'pt') : 'en';
}
const unaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
// troca as palavras-chave de idioma (Feature -> Funcionalidade, Given -> Dado...) e acerta o "# language:"
function translate(text, to) {
  const A = rx(langOf(text)); const T = KW[to]; let inSc = false, inDoc = null;
  const out = [];
  for (const raw of text.split('\n')) {
    const cr = raw.endsWith('\r') ? '\r' : ''; const ln = raw.slice(0, raw.length - cr.length); const t = ln.trim();
    if (inDoc) { if (t.startsWith(inDoc)) inDoc = null; out.push(raw); continue; }
    if (t.startsWith('"""') || t.startsWith('```')) { inDoc = t.slice(0, 3); out.push(raw); continue; }
    if (/^#\s*language\s*:/.test(t)) continue;
    let m = A.head.exec(ln);
    if (m) { const k = A.headOf.get(m[2]); inSc = ['background', 'scenario', 'outline'].includes(k); out.push(m[1] + T[k][0] + ':' + (m[3] ? ' ' + m[3] : '') + cr); continue; }
    m = inSc && A.step.exec(ln);
    if (m && m[2] !== '*') { out.push(m[1] + T[A.stepOf.get(m[2])][0] + ' ' + m[3] + cr); continue; }
    out.push(raw);
  }
  const s = out.join('\n');
  return to === 'en' ? s : `# language: ${to}${text.includes('\r\n') ? '\r\n' : '\n'}${s}`;
}
const cells = (ln) => ln.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim());
// lê a feature: funcionalidade, contexto, cenários (com passos, tags e Exemplos), tags e comentários
function parse(text) {
  const det = detLang(text); const lang = det || 'en'; const R = rx(lang);
  const lines = text.split('\n');
  const doc = { lang, det, lines, feature: null, background: null, scenarios: [], rules: [], tags: [], comments: [] };
  let tags = [], cur = null, lastStep = null, prim = 'given', inDoc = null, ex = null, rule = null;
  const close = (i) => { if (cur && cur.end == null) cur.end = i - 1; };
  lines.forEach((raw, i) => {
    const ln = raw.replace(/\r$/, '');
    const t = ln.trim();
    if (inDoc) { if (t.startsWith(inDoc)) inDoc = null; else if (lastStep) lastStep.doc.push(ln); return; }
    if (t.startsWith('"""') || t.startsWith('```')) { inDoc = t.slice(0, 3); if (lastStep) lastStep.doc = []; return; }
    if (!t) return;
    if (t.startsWith('#')) { doc.comments.push({ line: i, text: t }); return; }
    if (t.startsWith('@')) { for (const x of t.split(/\s+/)) if (x.startsWith('@')) { tags.push(x); doc.tags.push({ tag: x, line: i }); } else break; return; }
    let m = R.head.exec(ln);
    if (m) {
      const kind = R.headOf.get(m[2]); const name = m[3].trim();
      if (kind === 'feature') doc.feature = { line: i, name, kw: m[2], tags, desc: [] };
      else if (kind === 'rule') { close(i); cur = null; rule = { line: i, name, kw: m[2], tags }; doc.rules.push(rule); }
      else if (kind === 'background') { close(i); cur = { kind, line: i, name, kw: m[2], tags: [], steps: [], examples: [], rule }; doc.background = cur; }
      else if (kind === 'scenario' || kind === 'outline') { close(i); cur = { kind, line: i, name, kw: m[2], tags, steps: [], examples: [], rule }; doc.scenarios.push(cur); }
      else if (kind === 'examples' && cur) { ex = { line: i, kw: m[2], header: null, rows: [], rowLines: [], tags }; cur.examples.push(ex); }
      tags = []; lastStep = null; prim = 'given'; if (kind !== 'examples') ex = null;
      return;
    }
    m = R.step.exec(ln);
    if (m && cur) {
      const kw = m[2]; const raw2 = m[2] === '*' ? 'and' : R.stepOf.get(kw);
      if (raw2 === 'given' || raw2 === 'when' || raw2 === 'then') prim = raw2;
      lastStep = { kw, raw: raw2, type: prim, text: m[3].trim(), line: i, col: m[1].length + kw.length + 2, table: [], doc: null };
      cur.steps.push(lastStep); ex = null; return;
    }
    if (t.startsWith('|')) {
      if (ex) { if (!ex.header) ex.header = cells(t); else { ex.rows.push(cells(t)); ex.rowLines.push(i); } }
      else if (lastStep) lastStep.table.push({ cells: cells(t), line: i });
      return;
    }
    if (doc.feature && !cur && !rule && !doc.scenarios.length) doc.feature.desc.push(t);
  });
  close(lines.length);
  return doc;
}
// texto do passo para conferir com as definições: <coluna> vira o valor da 1ª linha dos Exemplos
function concrete(step, sc) {
  if (!/<[^<>]+>/.test(step.text)) return step.text;
  const ex = sc && sc.examples.find(e => e.header && e.rows.length);
  return step.text.replace(/<([^<>]+)>/g, (all, n) => { const k = ex ? ex.header.indexOf(n) : -1; return k >= 0 ? ex.rows[0][k] : 'x'; });
}
const norm = (s) => s.trim().replace(/\s+/g, ' ');
const plain = (s) => norm(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// chamado no nome do arquivo: INC1753202, PRB0068833, SDIGBSID00-2429 (Jira)
const TICKET = /\b(?:INC|PRB|RITM|CHG|TASK|SCTASK|REQ)\d{5,}\b|\b[A-Z][A-Z0-9]{1,15}-\d{1,7}\b/g;
const fileName = (rel) => rel.split('/').pop();
const stemOf = (rel) => fileName(rel).replace(/\.feature$/i, '');
const dirOf = (rel) => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
const ticketsOf = (rel) => [...new Set(stemOf(rel).match(TICKET) || [])];
function titleOf(rel) {
  const t = stemOf(rel).replace(TICKET, '').replace(/^[\s\-_–.\[\]]+|[\s\-_–.\[\]]+$/g, '').replace(/\s*[-–]\s*[-–]\s*/g, ' - ').replace(/^[-–\s]+/, '');
  return t || stemOf(rel);
}
// CT001 do nome do cenário (ou um nome curto para arquivos de evidência)
function scKey(sc) {
  const m = /^\s*([A-Za-z]{1,6})\s*[-_]?\s*(\d{1,5})\b/.exec(sc.name);
  if (m) return (m[1] + m[2]).toUpperCase();
  return (sc.name || 'cenario').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'cenario';
}

// ---------- índice do projeto: features, passos e step definitions ----------
const P = { for: null, files: new Map(), steps: new Map(), tags: new Map(), defs: [], all: [], runner: null, loading: null, at: 0, status: {}, settings: {} };
const proj = () => S.project && S.project.path;
const absOf = (rel) => proj().replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\');
const rawUrl = (rel) => '/api/raw?project=' + encodeURIComponent(proj()) + '&file=' + encodeURIComponent(rel);
const docFor = (rel) => { const t = S.tabs.find(x => x.project === proj() && x.path === rel && x.model); return t ? parse(t.model.getValue()) : (P.files.get(rel) || {}).doc; };

async function settings() { try { P.settings = await plugin.settings.get(); } catch { P.settings = {}; } return P.settings; }
plugin.settings.onChange((v) => { P.settings = v || {}; refreshAll(); });
const automation = () => P.settings.mode === 'automation' || (P.settings.mode !== 'doc' && P.defs.length > 0);

async function index(fresh) {
  const pp = proj(); if (!pp) return;
  if (P.loading && P.for === pp && !fresh) return P.loading;
  if (P.for !== pp) { P.for = pp; P.files = new Map(); P.status = {}; }
  P.loading = (async () => {
    await settings();
    let ix = []; try { ix = await api('index', { project: pp, fresh: fresh ? '1' : null }); } catch { return; }
    if (proj() !== pp) return;
    P.all = ix;
    const feats = ix.filter(f => /\.feature$/i.test(f.p));
    const keep = new Set(feats.map(f => f.p));
    for (const k of [...P.files.keys()]) if (!keep.has(k)) P.files.delete(k);
    const todo = feats.filter(f => { const c = P.files.get(f.p); return !c || c.mtime !== f.mtime; });
    // leitura em paralelo, 8 de cada vez
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(todo.slice(i, i + 8).map(async f => {
        try { const r = await api('file', { project: pp, file: f.p }); if (!r.binary && !r.tooBig) P.files.set(f.p, { mtime: f.mtime, doc: parse(r.content) }); } catch {}
      }));
    }
    catalog();
    await Promise.all([findDefs(pp), loadStatus(pp)]);
    P.runner = detectRunner(ix);
    P.at = Date.now();
  })();
  try { await P.loading; } finally { P.loading = null; }
  if (proj() === pp) { redraw(); fireLens(); S.tabs.forEach(t => isFeature(t) && diagnose(t.model)); }
}
// passos únicos (com quantas vezes aparecem e onde) e tags
function catalog() {
  P.steps = new Map(); P.tags = new Map();
  for (const [rel, f] of P.files) {
    const d = f.doc;
    for (const t of d.tags) P.tags.set(t.tag, (P.tags.get(t.tag) || 0) + 1);
    for (const sc of [d.background, ...d.scenarios].filter(Boolean)) for (const st of sc.steps) {
      const k = norm(st.text);
      let e = P.steps.get(k); if (!e) P.steps.set(k, e = { text: k, n: 0, types: {}, uses: [] });
      e.n++; e.types[st.type] = (e.types[st.type] || 0) + 1; if (e.uses.length < 200) e.uses.push({ rel, line: st.line, kw: st.kw });
    }
  }
}

// ---------- step definitions (Java, Kotlin, JS/TS, Ruby, Python, C#) ----------
const DEF_EXT = /\.(java|kt|groovy|scala|js|mjs|cjs|ts|mts|rb|py|cs)$/i;
const DEF_SEARCH = String.raw`@(?:Given|When|Then|And|But|Step|Dado|Dada|Dados|Dadas|Quando|Entao|Então|E|Mas|Cuando|Entonces|Y|Pero|given|when|then|step)\s*\(|^\s*(?:Given|When|Then|And|But|Dado|Quando|Entao|Então|E|Mas|defineStep|Step)\s*\(\s*['"/` + '`' + String.raw`]|\[(?:Given|When|Then|StepDefinition)\s*\(\s*@?"`;
async function findDefs(pp) {
  let hits = [];
  try { hits = (await api('search', { project: pp, q: DEF_SEARCH, regex: '1', case: '1' })).hits || []; } catch {}
  const defs = [];
  for (const h of hits) {
    if (!DEF_EXT.test(h.p)) continue;
    const d = defLine(h.text, h.p); if (!d) continue;
    defs.push({ ...d, rel: h.p, line: h.line });
  }
  P.defs = defs;
}
const PT = { int: '-?\\d+', float: '-?\\d*[.,]?\\d+', double: '-?\\d*[.,]?\\d+', bigdecimal: '-?\\d*[.,]?\\d+', long: '-?\\d+', short: '-?\\d+', byte: '-?\\d+', biginteger: '-?\\d+', word: '[^\\s]+', string: '"[^"]*"|\'[^\']*\'', '': '.*' };
// expressão do Cucumber ("tenho {int} itens(s) no carrinho/cesto") -> regex
function cucumberExpr(src) {
  const part = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { out += reEsc(s[++i]); continue; }
      if (c === '{') { const j = s.indexOf('}', i); const name = s.slice(i + 1, j < 0 ? s.length : j); out += `(${PT[name] ?? '.*'})`; i = j < 0 ? s.length : j; continue; }
      if (c === '(') { const j = s.indexOf(')', i); out += `(?:${reEsc(s.slice(i + 1, j < 0 ? s.length : j))})?`; i = j < 0 ? s.length : j; continue; }
      out += reEsc(c);
    }
    return out;
  };
  return src.split(' ').map(tok => /(?<!\\)\//.test(tok) && !/[{]/.test(tok) ? `(?:${tok.split(/(?<!\\)\//).map(part).join('|')})` : part(tok)).join(' ');
}
function defLine(text, rel) {
  const m = /(?:@|\[|^\s*)([A-Za-zÀ-ú]+)\s*\(\s*(?:value\s*=\s*)?(@"(?:[^"]|"")*"|[rRuUbB]?"(?:[^"\\]|\\.)*"|[rRuUbB]?'(?:[^'\\]|\\.)*'|`[^`]*`|\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/.exec(text);
  if (!m) return null;
  const kw = m[1]; let lit = m[2]; const ext = (rel.split('.').pop() || '').toLowerCase();
  let src, kind = 'expr';
  try {
    if (lit.startsWith('/')) { const k = lit.lastIndexOf('/'); src = lit.slice(1, k); kind = 'regex'; }
    else {
      const verbatim = lit.startsWith('@'); const raw = /^[rR]/.test(lit);
      lit = lit.replace(/^[@rRuUbB]+/, ''); let s = lit.slice(1, -1);
      if (verbatim) s = s.replace(/""/g, '"'); else if (!raw) s = s.replace(/\\(["'\\`])/g, '$1');
      // ^...$ é regex (regra do Cucumber); SpecFlow (C#) também é regex; behave usa {nome} como parâmetro
      if (/^\^|\$$/.test(s) || (ext === 'cs' && /[()\\[\]]/.test(s))) { src = s.replace(/^\^/, '').replace(/\$$/, ''); kind = 'regex'; }
      else if (ext === 'py') src = s.split(/\{[^}]*\}/).map(reEsc).join('(.+?)');
      else src = cucumberExpr(s);
      lit = s;
    }
    const re = new RegExp('^(?:' + src + ')$');
    // começo literal (para descartar rápido o que não tem chance)
    const pre = kind === 'expr' ? plain(lit.split(/[{(\\/]/)[0]).split(' ').slice(0, -1).join(' ') : '';
    return { kw, pattern: lit, re, kind, pre };
  } catch { return null; }
}
function defsFor(text) { const p = plain(text); return P.defs.filter(d => (!d.pre || p.startsWith(d.pre)) && d.re.test(text)); }

// ---------- execução manual (status por cenário) ----------
const stKey = (rel, sc) => rel + '::' + norm(sc.name || ('linha ' + (sc.line + 1)));
async function loadStatus(pp) { try { P.status = (await plugin.data.get('st:' + pp)) || {}; } catch { P.status = {}; } }
async function setStatus(rel, sc, s, note) {
  const k = stKey(rel, sc);
  if (s) P.status[k] = { s, at: Date.now(), by: P.settings.qaName || '', note: note || (P.status[k] && P.status[k].note) || '' }; else delete P.status[k];
  try { await plugin.data.set('st:' + proj(), P.status); } catch (e) { toast(e.message); }
  fireLens(); redraw();
}
const statusOf = (rel, sc) => P.status[stKey(rel, sc)] || null;

// ---------- evidências: <pasta da feature>/<evidencias>/<nome da feature>/CT001_1.png ----------
const evDir = (rel) => { const d = dirOf(rel); const e = (P.settings.evidenceDir || 'evidencias').replace(/[\\/]+$/, ''); return (d ? d + '/' : '') + e + '/' + stemOf(rel); };
const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;
function evidences(rel, sc) {
  const dir = evDir(rel) + '/'; const key = scKey(sc) + '_';
  return P.all.filter(f => f.p.startsWith(dir) && fileName(f.p).startsWith(key) && IMG.test(f.p)).map(f => f.p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
async function ensureDir(dir) { try { await api('file/new', { project: proj() }, { method: 'POST', body: JSON.stringify({ path: dir, dir: true }) }); } catch (e) { if (!/existe/i.test(e.message)) throw e; } }
async function saveEvidence(rel, sc, blob, ext) {
  const dir = evDir(rel); await ensureDir(dir);
  const used = evidences(rel, sc).map(p => +((/_(\d+)\.\w+$/.exec(p) || [])[1] || 0));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  const path = `${dir}/${scKey(sc)}_${n}.${ext}`;
  await api('file', { project: proj(), file: path }, { method: 'PUT', body: blob });
  P.all.push({ p: path, size: blob.size, mtime: Date.now() });
  return path;
}

// ---------- texto, CSV e relatório ----------
const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
function scenarioText(rel, d, sc) {
  const out = [`${sc.name}`];
  if (d.background && d.background.steps.length) out.push(...d.background.steps.map(s => `${s.kw} ${s.text}`), '—');
  for (const s of sc.steps) { out.push(`${s.kw} ${s.text}`); for (const r of s.table) out.push('  | ' + r.cells.join(' | ') + ' |'); }
  for (const ex of sc.examples) if (ex.header) { out.push(`${ex.kw}:`, '  | ' + ex.header.join(' | ') + ' |', ...ex.rows.map(r => '  | ' + r.join(' | ') + ' |')); }
  const st = statusOf(rel, sc);
  if (st) out.push('', `Resultado: ${STATUS[st.s].sym} ${STATUS[st.s].label} em ${fmtDate(st.at)}${st.by ? ' (' + st.by + ')' : ''}${st.note ? ' — ' + st.note : ''}`);
  return out.join('\n');
}
function csvOf(rels, keep) {
  const q = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['Chamado', 'Arquivo', 'Funcionalidade', 'ID', 'Cenário', 'Tags', 'Pré-condições', 'Passos', 'Resultado esperado', 'Exemplos', 'Status', 'Executado em', 'QA', 'Observação']];
  for (const rel of rels) {
    const d = docFor(rel); if (!d) continue;
    const bg = d.background ? d.background.steps.map(s => `${s.kw} ${s.text}`) : [];
    for (const sc of d.scenarios) {
      if (keep && !keep(rel, sc)) continue;
      const by = (t) => sc.steps.filter(s => s.type === t).map(s => `${s.kw} ${s.text}`);
      const st = statusOf(rel, sc); const id = /^([A-Za-z]{1,6}\s*-?\s*\d+)/.exec(sc.name);
      rows.push([ticketsOf(rel).join(' '), rel, d.feature ? d.feature.name : '', id ? id[1].replace(/\s+/g, '') : '', id ? sc.name.slice(id[0].length).replace(/^[\s\-–:]+/, '') : sc.name,
        [...(d.feature ? d.feature.tags : []), ...sc.tags].join(' '), [...bg, ...by('given')].join('\n'), by('when').join('\n'), by('then').join('\n'),
        sc.examples.reduce((n, e) => n + e.rows.length, 0) || '', st ? STATUS[st.s].label : 'Não executado', st ? fmtDate(st.at) : '', st ? st.by : '', st ? st.note : '']);
    }
  }
  return '\uFEFF' + rows.map(r => r.map(q).join(';')).join('\r\n') + '\r\n';
}
function relFrom(fromDir, to) {
  const a = fromDir ? fromDir.split('/') : [], b = to.split('/');
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].map(encodeURIComponent).join('/');
}
function ticketLink(id) {
  for (const line of String(P.settings.ticketUrl || '').split('\n')) { const m = /^\s*([^=\s]+)\s*=\s*(\S+)/.exec(line); if (m && id.toUpperCase().startsWith(m[1].toUpperCase())) return m[2].replace(/\{id\}/g, encodeURIComponent(id)); }
  return null;
}
// relatório de evidências em HTML (abre no navegador; dá para imprimir em PDF); as imagens ficam com caminho relativo
function reportHtml(rels, outDir, keep) {
  const h = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let pass = 0, fail = 0, blocked = 0, none = 0;
  const parts = rels.map(rel => {
    const d = docFor(rel); if (!d) return '';
    const tk = ticketsOf(rel).map(id => { const u = ticketLink(id); return u ? `<a href="${h(u)}">${h(id)}</a>` : h(id); }).join(' · ');
    const bg = d.background && d.background.steps.length ? `<div class="bg"><b>${h(d.background.kw)}</b>${d.background.steps.map(s => `<div class="st"><b>${h(s.kw)}</b> ${h(s.text)}</div>`).join('')}</div>` : '';
    const scs = d.scenarios.filter(sc => !keep || keep(rel, sc)).map(sc => {
      const st = statusOf(rel, sc); if (!st) none++; else if (st.s === 'pass') pass++; else if (st.s === 'fail') fail++; else blocked++;
      const ev = evidences(rel, sc).map(p => `<figure><img src="${relFrom(outDir, p)}" alt=""><figcaption>${h(fileName(p))}</figcaption></figure>`).join('');
      const steps = sc.steps.map(s => `<div class="st"><b>${h(s.kw)}</b> ${h(s.text).replace(/&lt;([^&]+)&gt;/g, '<i>&lt;$1&gt;</i>')}${s.table.length ? `<table>${s.table.map(r => `<tr>${r.cells.map(c => `<td>${h(c)}</td>`).join('')}</tr>`).join('')}</table>` : ''}</div>`).join('');
      const exs = sc.examples.filter(e => e.header).map(e => `<div class="ex"><b>${h(e.kw)}</b><table><tr>${e.header.map(c => `<th>${h(c)}</th>`).join('')}</tr>${e.rows.map(r => `<tr>${r.map(c => `<td>${h(c)}</td>`).join('')}</tr>`).join('')}</table></div>`).join('');
      return `<section class="sc ${st ? st.s : 'none'}"><header><h3>${h(sc.name)}</h3><span class="badge">${st ? STATUS[st.s].sym + ' ' + STATUS[st.s].label : 'Não executado'}</span></header>
        ${sc.tags.length ? `<div class="tags">${sc.tags.map(h).join(' ')}</div>` : ''}${steps}${exs}
        ${st ? `<p class="meta">${h(fmtDate(st.at))}${st.by ? ' · ' + h(st.by) : ''}${st.note ? ' · ' + h(st.note) : ''}</p>` : ''}${ev ? `<div class="ev">${ev}</div>` : ''}</section>`;
    }).join('');
    return `<article><h2>${h(d.feature ? d.feature.name : titleOf(rel))}</h2><p class="file">${tk ? tk + ' · ' : ''}${h(rel)}</p>${d.feature && d.feature.desc.length ? `<p class="desc">${d.feature.desc.map(h).join('<br>')}</p>` : ''}${bg}${scs}</article>`;
  }).join('');
  const total = pass + fail + blocked + none;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relatório de evidências</title><style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;color:#1d2330;max-width:1000px;margin:24px auto;padding:0 16px;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 2px;border-bottom:2px solid #e3e7ee;padding-bottom:4px}h3{font-size:15px;margin:0}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 4px}.sum span{padding:4px 10px;border-radius:999px;background:#f1f3f7;font-weight:600}
.sum .p{background:#e3f6ea;color:#17703f}.sum .f{background:#fde7e7;color:#a32020}.sum .b{background:#fff3d6;color:#8a5a00}
.file,.meta{color:#667;font-size:12px;margin:0}.desc{color:#445}.sc{border:1px solid #e3e7ee;border-left:5px solid #c5ccd8;border-radius:8px;padding:10px 14px;margin:12px 0;break-inside:avoid}
.sc.pass{border-left-color:#2fa35c}.sc.fail{border-left-color:#d93636}.sc.blocked{border-left-color:#e3a21a}
.sc header{display:flex;justify-content:space-between;gap:10px;align-items:center}.badge{font-size:12px;font-weight:700;white-space:nowrap}
.pass .badge{color:#17703f}.fail .badge{color:#a32020}.blocked .badge{color:#8a5a00}.none .badge{color:#778}
.st{margin:2px 0 2px 8px}.st b{color:#2357b5}.bg{background:#f7f8fb;border-radius:6px;padding:6px 10px;margin:8px 0}.tags{color:#7a4fc0;font-size:12px}
table{border-collapse:collapse;margin:4px 0 4px 16px;font-size:13px}td,th{border:1px solid #d8dde6;padding:2px 8px}th{background:#f1f3f7}
.ev{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-top:10px}figure{margin:0}img{width:100%;border:1px solid #d8dde6;border-radius:6px}
figcaption{font-size:11px;color:#778}@media print{body{margin:0}.sc{page-break-inside:avoid}}</style></head><body>
<h1>Relatório de evidências</h1><p class="meta">${h(fmtDate(Date.now()))}${P.settings.qaName ? ' · QA: ' + h(P.settings.qaName) : ''} · ${h(S.project.name || '')}</p>
<div class="sum"><span>${total} cenário(s)</span><span class="p">✓ ${pass} passou</span><span class="f">✗ ${fail} falhou</span><span class="b">⊘ ${blocked} bloqueado</span><span>${none} não executado</span></div>
${parts}</body></html>`;
}
async function openOutside(rel) { try { await plugin.exec('explorer.exe', [absOf(rel)], { timeout: 15000 }); } catch (e) { toast(e.message); } }
async function writeText(rel, text) {
  const dir = dirOf(rel); if (dir) await ensureDir(dir);
  await api('file', { project: proj(), file: rel }, { method: 'PUT', body: text });
  if (!P.all.some(f => f.p === rel)) P.all.push({ p: rel, size: text.length, mtime: Date.now() });
}
const featuresIn = (dir) => [...P.files.keys()].filter(r => !dir || r === dir || r.startsWith(dir + '/')).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
async function makeReport(target, isDir) {
  await index();
  const rels = isDir ? featuresIn(target) : [target]; if (!rels.length) return toast('Nenhuma feature aqui');
  const out = isDir ? (target ? target + '/' : '') + 'relatorio-evidencias.html' : evDir(target) + '/relatorio.html';
  try { await writeText(out, reportHtml(rels, dirOf(out))); toast('Relatório gerado: ' + out, 'ok'); openOutside(out); } catch (e) { toast(e.message); }
}
async function exportCsv(target, isDir) {
  await index();
  const rels = isDir ? featuresIn(target) : [target]; if (!rels.length) return toast('Nenhuma feature aqui');
  const out = isDir ? (target ? target + '/' : '') + 'casos-de-teste.csv' : (dirOf(target) ? dirOf(target) + '/' : '') + stemOf(target) + ' - casos de teste.csv';
  try { await writeText(out, csvOf(rels)); toast(`${rels.length === 1 ? 'Casos de teste exportados' : rels.length + ' features exportadas'}: ${out}`, 'ok'); bs.openFile(out, 'editor'); } catch (e) { toast(e.message); }
}

// ---------- formatação (Shift+Alt+F): recuo padrão e tabelas alinhadas ----------
function format(text) {
  const d = parse(text); const R = rx(d.lang);
  const lines = text.replace(/\r/g, '').split('\n');
  const out = []; let inDoc = null, docIn = 0, docBase = 0, ruleDepth = 0, level = 0, blank = 0;
  const pad = (n) => ' '.repeat(n);
  const tableAt = (i) => { let j = i; while (j < lines.length && lines[j].trim().startsWith('|')) j++; return j; };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], t = ln.trim();
    if (inDoc) { out.push(t.startsWith(inDoc) ? pad(docIn) + t : (ln.length - ln.trimStart().length >= docBase ? pad(docIn) + ln.slice(docBase) : pad(docIn) + ln.trimStart()).replace(/\s+$/, '')); if (t.startsWith(inDoc)) inDoc = null; continue; }
    if (!t) { if (++blank <= 1 && out.length) out.push(''); continue; }
    blank = 0;
    if (t.startsWith('"""') || t.startsWith('```')) { inDoc = t.slice(0, 3); docIn = level + 2; docBase = ln.length - ln.trimStart().length; out.push(pad(docIn) + t); continue; }
    if (t.startsWith('|')) {
      const end = tableAt(i); const rows = lines.slice(i, end).map(cells);
      const w = []; rows.forEach(r => r.forEach((c, k) => { w[k] = Math.max(w[k] || 0, [...c].length); }));
      const ind = level + 2;
      for (const r of rows) out.push(pad(ind) + '| ' + w.map((n, k) => (r[k] ?? '') + ' '.repeat(n - [...(r[k] ?? '')].length)).join(' | ') + ' |');
      i = end - 1; continue;
    }
    const m = R.head.exec(ln);
    if (m) {
      const kind = R.headOf.get(m[2]);
      if (kind === 'feature') { level = 0; ruleDepth = 0; }
      else if (kind === 'rule') { level = 2; ruleDepth = 2; }
      else if (kind === 'examples') level = 4 + ruleDepth;
      else level = 2 + ruleDepth;
      // tags e comentários logo acima ficam no recuo do que vem a seguir
      for (let k = out.length - 1; k >= 0 && /^\s*[@#]/.test(out[k]) && !/^\s*#\s*language/.test(out[k]); k--) out[k] = pad(level) + out[k].trim();
      out.push(pad(level) + `${m[2]}:${m[3].trim() ? ' ' + m[3].trim() : ''}`);
      if (kind !== 'examples') level += 2; else level += 0;
      continue;
    }
    if (R.step.test(ln)) { const s = R.step.exec(ln); out.push(pad(level) + `${s[2]} ${s[3].trim()}`); continue; }
    if (/^#\s*language/.test(t)) { out.push(t); continue; }
    out.push(pad(t.startsWith('@') || t.startsWith('#') ? level : level) + t);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n') + '\n';
}

// ---------- refatorações ----------
// passos que abrem todos os cenários do mesmo jeito -> Contexto
function commonPrefix(d) {
  const scs = d.scenarios.filter(s => !s.rule);
  if (scs.length < 2 || scs.some(s => !s.steps.length)) return [];
  const out = [];
  for (let i = 0; ; i++) {
    // só pré-condições (Dado/Given e os E/And que as seguem): ação e resultado continuam no cenário
    const first = scs[0].steps[i]; if (!first || first.type !== 'given') break;
    if (!scs.every(s => s.steps[i] && norm(s.steps[i].text) === norm(first.text) && s.steps[i].type === first.type && s.steps.length > i + 1)) break;
    out.push(first);
  }
  return out;
}
function toBackgroundEdits(model, d) {
  const n = commonPrefix(d).length; if (!n) return null;
  const K = KW[d.lang];
  const edits = [];
  const steps = d.scenarios[0].steps.slice(0, n);
  const ind = (l) => (d.lines[l].match(/^\s*/) || [''])[0];
  // o 1º passo que sobra em cada cenário não pode começar com E/And: vira a palavra principal
  for (const sc of d.scenarios) {
    const lastSt = sc.steps[n - 1]; const first = sc.steps[0].line, last = lastSt.table.length ? lastSt.table[lastSt.table.length - 1].line : lastSt.line;
    edits.push({ range: new bs.monaco.Range(first + 1, 1, last + 2, 1), text: '' });
    const next = sc.steps[n];
    if (next && (next.raw === 'and' || next.raw === 'but')) edits.push({ range: new bs.monaco.Range(next.line + 1, next.col - next.kw.length - 1, next.line + 1, next.col - 1), text: K[next.type][0] });
  }
  const sc0 = d.scenarios[0]; let at = sc0.line; while (at > 0 && /^\s*[@#]/.test(d.lines[at - 1])) at--;
  const kwOf = (s, i) => i === 0 && (s.raw === 'and' || s.raw === 'but') ? K[s.type][0] : s.kw;
  const head = ind(sc0.line);
  const bgText = `${head}${K.background[0]}:\n` + steps.map((s, i) => `${ind(s.line)}${kwOf(s, i)} ${s.text}\n${s.table.map(r => d.lines[r.line] + '\n').join('')}`).join('') + '\n';
  if (d.background) {
    const lastBg = d.background.steps[d.background.steps.length - 1];
    const line = lastBg ? lastBg.line + 1 + lastBg.table.length : d.background.line + 1;
    edits.push({ range: new bs.monaco.Range(line + 1, 1, line + 1, 1), text: steps.map(s => `${ind(s.line)}${s.raw === 'given' && lastBg ? K.and[0] : s.kw} ${s.text}\n`).join('') });
  } else edits.push({ range: new bs.monaco.Range(at + 1, 1, at + 1, 1), text: bgText });
  return edits;
}
// CT001, CT002... na ordem do arquivo (mantém o prefixo e a largura que já existem)
function renumberEdits(d) {
  const pre = (P.settings.prefix || 'CT').trim() || 'CT';
  const ex = d.scenarios.map(s => /^\s*([A-Za-z]{1,6})(\s*[-_]?\s*)(\d{1,5})(\s*[-–:]?\s*)/.exec(s.name));
  const width = Math.max(3, ...ex.filter(Boolean).map(m => m[3].length));
  const prefix = (ex.find(Boolean) || [null, pre])[1];
  const edits = [];
  d.scenarios.forEach((s, i) => {
    const id = prefix + String(i + 1).padStart(width, '0');
    const m = ex[i]; const ln = d.lines[s.line]; const col = ln.indexOf(':') + 1 + (ln[ln.indexOf(':') + 1] === ' ' ? 1 : 0);
    const name = m ? s.name.slice(m[0].length) : s.name;
    const text = `${id}${m ? (m[4] || ' ') : ' '}${name}`.replace(/\s+$/, '');
    if (text !== s.name) edits.push({ range: new bs.monaco.Range(s.line + 1, col + 1, s.line + 1, ln.length + 1), text });
  });
  return edits;
}
const nextId = (d) => {
  const ns = d.scenarios.map(s => /^\s*([A-Za-z]{1,6})\s*[-_]?\s*(\d{1,5})/.exec(s.name)).filter(Boolean);
  const pre = ns.length ? ns[ns.length - 1][1] : (P.settings.prefix || 'CT');
  const w = ns.length ? ns[ns.length - 1][2].length : 3;
  return pre + String((ns.length ? Math.max(...ns.map(m => +m[2])) : 0) + 1).padStart(w, '0');
};

// ---------- passo parecido (o padrão é o mais usado no projeto) ----------
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < best) best = cur[j]; }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
let pool = null, poolAt = 0;
// Parecido = as mesmas palavras, na mesma ordem, com até 2 delas diferentes só por digitação ou acento. Palavra a
// mais ou a menos ("não", "nenhum") e número diferente mudam o sentido do teste: nunca contam como parecido.
function similarTo(text) {
  if (!pool || poolAt !== P.at) { pool = [...P.steps.values()].filter(e => e.n >= 2).sort((a, b) => b.n - a.n).slice(0, 1500).map(e => ({ e, p: plain(e.text), w: plain(e.text).split(' ') })); poolAt = P.at; }
  const p = plain(text); const w = p.split(' '); const own = P.steps.get(norm(text)); const ownN = own ? own.n : 0;
  let best = null;
  for (const c of pool) {
    if (c.e.n <= ownN || c.e.text === norm(text) || c.w.length !== w.length) continue;
    if (c.p === p) return { e: c.e, dist: 0 }; // só acento, maiúscula ou espaço
    let diff = 0, dist = 0;
    for (let i = 0; i < w.length && diff <= 2; i++) {
      if (w[i] === c.w[i]) continue;
      if (/\d|["'<]/.test(w[i] + c.w[i])) { diff = 9; break; }
      const max = Math.max(1, Math.floor(Math.min(w[i].length, c.w[i].length) / 4));
      const d = lev(w[i], c.w[i], max); if (d > max) { diff = 9; break; }
      diff++; dist += d;
    }
    if (diff <= 2 && (!best || dist < best.dist || (dist === best.dist && c.e.n > best.e.n))) best = { e: c.e, dist };
  }
  return best;
}

// ---------- editor ----------
const isFeature = (t) => t && t.model && /\.feature$/i.test(t.path || '');
const relOfModel = (m) => (m && m._tab && m._tab.project === proj()) ? m._tab.path : null;
const hold = new WeakMap(); // modelo -> { doc, marks }
const lensEmitter = { list: new Set(), fire() { this.list.forEach(f => { try { f(); } catch {} }); } };
// com outra aba na frente (o quadro, por exemplo) o editor está escondido e o Monaco não troca o texto das lentes da feature:
// quando ela volta (tab:activate), desenha o editor (as lentes voltam a contar como visíveis) e pede as lentes de novo
let lensLate = false;
const fireLens = () => { lensEmitter.fire(); if (!isFeature(S.active)) lensLate = true; S.tabs.forEach(t => isFeature(t) && paint(t.model)); };
// faixa colorida na margem esquerda de cada cenário executado (verde Passou, vermelho Falhou, amarelo Bloqueado)
const painted = new WeakMap(); // modelo -> ids das decorações
function paint(model, d) {
  if (!model || model.isDisposed()) return;
  const rel = relOfModel(model); d = d || parse(model.getValue());
  const deco = [];
  if (rel) for (const sc of d.scenarios) {
    const st = statusOf(rel, sc); if (!st) continue;
    // até o último passo/linha útil: linhas vazias, comentários e tags do cenário seguinte ficam de fora
    let end = sc.end == null ? d.lines.length - 1 : sc.end;
    while (end > sc.line && (!d.lines[end].trim() || /^[#@]/.test(d.lines[end].trim()))) end--;
    deco.push({ range: { startLineNumber: sc.line + 1, startColumn: 1, endLineNumber: end + 1, endColumn: 1 }, options: { isWholeLine: true, linesDecorationsClassName: 'qa-ln qa-ln-' + st.s, overviewRuler: { color: { pass: '#2fa35c', fail: '#d94a4a', blocked: '#e0a526' }[st.s], position: 1 }, stickiness: 1 } });
  }
  painted.set(model, model.deltaDecorations(painted.get(model) || [], deco));
}
const watched = new WeakSet();
function watch(tab) {
  if (!isFeature(tab) || watched.has(tab.model)) return;
  watched.add(tab.model);
  let tm = null;
  tab.model.onDidChangeContent(() => { clearTimeout(tm); tm = setTimeout(() => diagnose(tab.model), 350); });
  diagnose(tab.model);
}
function diagnose(model) {
  const monaco = bs.monaco; if (!monaco || model.isDisposed()) return;
  const d = parse(model.getValue()); paint(model, d);
  const marks = []; const data = [];
  const auto = automation(); const sim = P.settings.similar !== false;
  const mk = (line, c1, c2, sev, msg, code, extra) => { marks.push({ startLineNumber: line + 1, startColumn: c1, endLineNumber: line + 1, endColumn: c2, severity: sev, message: msg, source: 'Cucumber', code }); data.push({ line, code, ...extra }); };
  for (const sc of [d.background, ...d.scenarios].filter(Boolean)) for (const st of sc.steps) {
    const c1 = st.col, c2 = d.lines[st.line].replace(/\s+$/, '').length + 1;
    if (auto && P.defs.length) {
      const defs = defsFor(concrete(st, sc));
      if (!defs.length) mk(st.line, c1, c2, monaco.MarkerSeverity.Warning, 'Passo sem definição (step definition). Alt+Enter cria.', 'undefined', { st, sc });
      else if (defs.length > 1) mk(st.line, c1, c2, monaco.MarkerSeverity.Warning, `Passo ambíguo: ${defs.length} definições (${defs.slice(0, 3).map(x => fileName(x.rel) + ':' + x.line).join(', ')})`, 'ambiguous', {});
      continue;
    }
    if (sim && P.steps.size) {
      const s = similarTo(st.text);
      if (s) mk(st.line, c1, c2, monaco.MarkerSeverity.Info, `Parecido com o passo padrão “${s.e.text}” (usado ${s.e.n} vezes no projeto). Alt+Enter troca.`, 'similar', { to: s.e.text });
    }
  }
  // palavras-chave em português/espanhol sem "# language:": o Cucumber lê como inglês e não acha nada
  if (d.lang !== 'en' && d.feature && !/^\s*#\s*language\s*:/m.test(model.getValue())) mk(d.feature.line, 1, d.lines[d.feature.line].length + 1, auto ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Hint, `Falta "# language: ${d.lang}" na primeira linha: sem ele o Cucumber não reconhece ${KW[d.lang].feature[0]}, ${KW[d.lang].scenario[0]}, ${KW[d.lang].given[0]}... Alt+Enter adiciona.`, 'no-language', { lang: d.lang });
  // comentário que parece uma tag (#Sistema_E2E_...): vira @tag
  for (const c of d.comments) if (/^#[A-Za-zÀ-ú][\w.\-À-ú]{3,}$/.test(c.text) && !/^#\s*language/i.test(c.text)) mk(c.line, 1, d.lines[c.line].length + 1, monaco.MarkerSeverity.Hint, 'Comentário com cara de tag: como tag (@...) ele filtra execução e aparece no painel QA. Alt+Enter converte.', 'comment-tag', { tag: '@' + c.text.slice(1) });
  monaco.editor.setModelMarkers(model, 'cucumber', marks);
  hold.set(model, { doc: d, data });
}

function stepAt(d, line) {
  for (const sc of [d.background, ...d.scenarios].filter(Boolean)) { const st = sc.steps.find(s => s.line === line); if (st) return { st, sc }; }
  return null;
}
async function modelForRel(rel) {
  const monaco = bs.monaco; const uri = monaco.Uri.parse(bs.lsp.pathToUri(absOf(rel)));
  let m = monaco.editor.getModel(uri);
  if (!m) { try { const f = await api('file', { project: proj(), file: rel }); if (!f.binary) m = monaco.editor.createModel(f.content, undefined, uri); } catch {} }
  return m;
}

// definição do passo (código), com Java/Kotlin/JS... no idioma da feature
function exprFrom(text) {
  const params = []; let n = 0;
  let expr = text.replace(/\\/g, '\\\\').replace(/([(){}/])/g, '\\$1');
  expr = expr.replace(/"[^"]*"|'[^']*'|-?\b\d+(?:[.,]\d+)?\b|<[^<>]+>/g, (m) => {
    if (m.startsWith('"') || m.startsWith("'") || m.startsWith('<')) { params.push(['string', 'String', 'string' + (++n > 1 ? n : '')]); return '{string}'; }
    const f = /[.,]/.test(m); params.push(f ? ['float', 'Double', 'double' + (++n)] : ['int', 'Integer', 'int' + (++n)]); return f ? '{float}' : '{int}';
  });
  return { expr, params };
}
function methodName(text) {
  const w = text.replace(/"[^"]*"|'[^']*'|<[^<>]+>|-?\d+(?:[.,]\d+)?/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 10);
  const s = w.map((x, i) => i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase()).join('');
  return /^[a-z]/.test(s) ? s : 'passo' + s;
}
function defLanguage() {
  const exts = P.defs.map(d => d.rel.split('.').pop().toLowerCase());
  const most = exts.sort((a, b) => exts.filter(x => x === b).length - exts.filter(x => x === a).length)[0];
  if (most) return { java: 'java', kt: 'kotlin', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', mts: 'ts', rb: 'ruby', py: 'python', cs: 'csharp' }[most] || 'java';
  return { maven: 'java', gradle: 'java', npm: 'js', ruby: 'ruby', behave: 'python' }[P.runner && P.runner.kind] || 'java';
}
function defCode(lang, flang, st) {
  const { expr, params } = exprFrom(st.text);
  const ptAnn = { given: 'Dado', when: 'Quando', then: 'Entao' }, enAnn = { given: 'Given', when: 'When', then: 'Then' }, esAnn = { given: 'Dado', when: 'Cuando', then: 'Entonces' };
  const ann = (flang === 'pt' ? ptAnn : flang === 'es' ? esAnn : enAnn)[st.type];
  const q = (s) => s.replace(/"/g, '\\"');
  switch (lang) {
    case 'kotlin': return { ann, pkg: `io.cucumber.java.${flang}.${ann}`, code: `\n    @${ann}("${q(expr)}")\n    fun ${methodName(st.text)}(${params.map(p => `${p[2]}: ${p[1] === 'Integer' ? 'Int' : p[1]}`).join(', ')}) {\n        // TODO: implementar\n        throw io.cucumber.java.PendingException()\n    }\n` };
    case 'js': case 'ts': return { code: `\n${enAnn[st.type]}('${expr.replace(/'/g, "\\'")}', async function (${params.map(p => p[2] + (lang === 'ts' ? ': ' + (p[0] === 'string' ? 'string' : 'number') : '')).join(', ')}) {\n  // TODO: implementar\n  return 'pending';\n});\n` };
    case 'ruby': return { code: `\n${ann}('${expr.replace(/'/g, "\\'")}') do |${params.map(p => p[2]).join(', ')}|\n  pending # TODO: implementar\nend\n` };
    case 'python': { let k = 0; return { code: `\n@${enAnn[st.type].toLowerCase()}('${expr.replace(/\{(string|int|float)\}/g, () => '{p' + (++k) + '}').replace(/'/g, "\\'")}')\ndef step_impl(context${params.map((_, i) => ', p' + (i + 1)).join('')}):\n    raise NotImplementedError('TODO: implementar')\n` }; }
    case 'csharp': return { code: `\n    [${enAnn[st.type]}("${q(expr)}")]\n    public void ${methodName(st.text).replace(/^./, c => c.toUpperCase())}(${params.map(p => (p[0] === 'string' ? 'string ' : p[0] === 'int' ? 'int ' : 'double ') + p[2]).join(', ')})\n    {\n        throw new PendingStepException();\n    }\n` };
    default: return { ann, pkg: `io.cucumber.java.${flang}.${ann}`, code: `\n    @${ann}("${q(expr)}")\n    public void ${methodName(st.text)}(${params.map(p => p[1] + ' ' + p[2]).join(', ')}) {\n        // TODO: implementar\n        throw new io.cucumber.java.PendingException();\n    }\n` };
  }
}
async function createDefinition(rel, line) {
  const t = S.tabs.find(x => x.path === rel && x.model); const d = t ? parse(t.model.getValue()) : docFor(rel); if (!d) return;
  const hit = stepAt(d, line); if (!hit) return;
  const lang = defLanguage(); const c = defCode(lang, d.lang, hit.st);
  const extRe = { java: /\.java$/, kotlin: /\.kt$/, js: /\.(js|mjs|cjs)$/, ts: /\.(ts|mts)$/, ruby: /\.rb$/, python: /\.py$/, csharp: /\.cs$/ }[lang];
  const files = [...new Set(P.defs.map(x => x.rel).filter(r => extRe.test(r)))];
  dialog('qaDef', `<div class="dlg-hd"><span class="dlg-ic">${ICO.qa}</span><div><h3>Criar definição do passo</h3><p>${esc(hit.st.kw + ' ' + hit.st.text)}</p></div></div>
    <pre class="qa-code">${esc(c.code.replace(/^\n/, ''))}</pre>
    <label class="fld">Onde colocar<select id="qaDefFile">${files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}<option value="">Só copiar o código</option></select></label>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="qaDefOk">${files.length ? 'Inserir' : 'Copiar'}</button></div>`, (el) => {
    const sel = el.querySelector('#qaDefFile'); const ok = el.querySelector('#qaDefOk');
    sel.onchange = () => { ok.textContent = sel.value ? 'Inserir' : 'Copiar'; };
    ok.onclick = async () => {
      if (!sel.value) { bs.copyText(c.code.replace(/^\n/, '')); el.hidden = true; return toast('Código copiado', 'ok'); }
      try {
        const f = await api('file', { project: proj(), file: sel.value }); let txt = f.content;
        if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
          const k = txt.lastIndexOf('}'); txt = k >= 0 ? txt.slice(0, k).replace(/\s*$/, '\n') + c.code + txt.slice(k) : txt + c.code;
          // import da anotação no idioma da feature (io.cucumber.java.pt.Dado)
          if (c.pkg && !txt.includes(c.pkg) && !txt.includes(c.pkg.replace(/\.\w+$/, '.*'))) { const im = [...txt.matchAll(/^import .*$/gm)].pop(); txt = im ? txt.slice(0, im.index + im[0].length) + `\nimport ${c.pkg}${lang === 'java' ? ';' : ''}` + txt.slice(im.index + im[0].length) : txt; }
        } else txt = txt.replace(/\s*$/, '\n') + c.code;
        // aberto numa aba: muda o texto da aba (dá para desfazer com Ctrl+Z) e salva; fechado: grava direto
        const open = S.tabs.find(x => x.path === sel.value && x.model);
        if (open) open.model.pushEditOperations([], [{ range: open.model.getFullModelRange(), text: txt }], () => null);
        else await api('file', { project: proj(), file: sel.value }, { method: 'PUT', body: txt });
        el.hidden = true; toast('Definição criada em ' + fileName(sel.value), 'ok');
        await bs.openFile(sel.value, 'editor', txt.slice(0, txt.lastIndexOf(c.code.trim())).split('\n').length);
        if (open) await bs.save();
        setTimeout(() => index(true), 600);
      } catch (e) { toast(e.message); }
    };
  });
}

// ---------- executar (projetos automatizados) ----------
function detectRunner(ix) {
  const has = (re) => ix.some(f => re.test(f.p));
  if (has(/^pom\.xml$/)) return { kind: 'maven', label: 'Maven' };
  if (has(/^build\.gradle(\.kts)?$/)) return { kind: 'gradle', label: 'Gradle', wrapper: has(/^gradlew\.bat$/) };
  if (has(/^package\.json$/) && P.defs.some(d => /\.(js|ts|mjs|cjs|mts)$/.test(d.rel))) return { kind: 'npm', label: 'cucumber-js' };
  if (has(/(^|\/)Gemfile$/) || P.defs.some(d => /\.rb$/.test(d.rel))) return { kind: 'ruby', label: 'Cucumber (Ruby)' };
  if (P.defs.some(d => /\.py$/.test(d.rel)) || has(/features\/steps\/.*\.py$/)) return { kind: 'behave', label: 'behave' };
  return null;
}
async function runner(target, tags, title) {
  const r = P.runner; if (!r) return toast('Não achei como rodar os testes (Maven, Gradle, npm, Ruby ou behave)');
  const cwd = proj(); const env = {};
  if (target) env.CUCUMBER_FEATURES = target; if (tags) env.CUCUMBER_FILTER_TAGS = tags;
  // classe que liga o Cucumber ao JUnit (@Suite, @RunWith(Cucumber.class), @CucumberOptions): roda só ela
  let runnerClass = null;
  if (r.kind === 'maven' || r.kind === 'gradle') {
    try { const h = (await api('search', { project: cwd, q: String.raw`@Suite\b|@RunWith\s*\(\s*Cucumber\.class|@CucumberOptions|@IncludeEngines\s*\(\s*"cucumber"`, regex: '1', case: '1' })).hits || []; const f = h.find(x => /\.(java|kt)$/.test(x.p)); if (f) runnerClass = fileName(f.p).replace(/\.(java|kt)$/, ''); } catch {}
  }
  let step;
  if (r.kind === 'maven') step = { kind: 'maven', label: 'mvn test', args: ['-f', cwd + '\\pom.xml', 'test', ...(target ? ['-Dcucumber.features=' + target] : []), ...(tags ? ['-Dcucumber.filter.tags=' + tags] : []), ...(runnerClass ? ['-Dtest=' + runnerClass, '-Dsurefire.failIfNoSpecifiedTests=false'] : [])], cwd, env, java: true };
  else if (r.kind === 'gradle') step = { program: r.wrapper ? cwd + '\\gradlew.bat' : 'gradle', args: ['cleanTest', 'test', ...(runnerClass ? ['--tests', runnerClass] : [])], cwd, env, java: true };
  else if (r.kind === 'npm') step = { program: 'npx', args: ['cucumber-js', ...(target ? [target] : []), ...(tags ? ['--tags', tags] : [])], cwd, env };
  else if (r.kind === 'ruby') step = { program: 'bundle', args: ['exec', 'cucumber', ...(target ? [target] : []), ...(tags ? ['--tags', tags] : [])], cwd, env };
  else step = { program: 'behave', args: [...(target ? [target] : []), ...(tags ? ['--tags', tags] : [])], cwd, env };
  bs.build.runSteps({ title: 'Cucumber · ' + title, steps: [step] });
}

// ---------- janelas: status, evidências, nova feature ----------
function statusMenu(e, rel, sc, extra = []) {
  const st = statusOf(rel, sc);
  bs.showMenu(e, [
    ...Object.entries(STATUS).map(([k, v]) => ({ label: v.label + (st && st.s === k ? ' ✓' : ''), icon: v.ico, action: () => setStatus(rel, sc, k) })),
    { label: 'Anotação…', icon: bs.I.edit, action: () => noteDialog(rel, sc) },
    { label: 'Abrir relatório de bug deste cenário…', icon: ICO.bug, action: () => bugFromScenario(rel, sc) },
    '-', { label: 'Não executado', icon: bs.I.x, action: () => setStatus(rel, sc, null) },
    ...extra,
  ], sc.name);
}
function copyScenario(rel, sc) { const d = docFor(rel); if (!d) return; bs.copyText(scenarioText(rel, d, sc)); toast('Cenário copiado (texto para o chamado)', 'ok'); }
function noteDialog(rel, sc) {
  const st = statusOf(rel, sc) || {};
  dialog('qaNote', `<div class="dlg-hd"><span class="dlg-ic">${ICO.qa}</span><div><h3>Anotação do cenário</h3><p>${esc(sc.name)}</p></div></div>
    <label class="fld">Observação (vai no relatório e no CSV)<textarea id="qaNoteIn" rows="4">${esc(st.note || '')}</textarea></label>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="qaNoteOk">Salvar</button></div>`, (el) => {
    el.querySelector('#qaNoteIn').focus();
    el.querySelector('#qaNoteOk').onclick = async () => { const v = el.querySelector('#qaNoteIn').value.trim(); el.hidden = true; const k = stKey(rel, sc); if (P.status[k]) { P.status[k].note = v; await plugin.data.set('st:' + proj(), P.status); fireLens(); pgSoon(); } else await setStatus(rel, sc, 'pass', v); };
  });
}
function evidenceDialog(rel, sc) {
  const draw = (el) => {
    const list = evidences(rel, sc);
    el.querySelector('.qa-evs').innerHTML = list.length ? list.map(p => `<figure data-p="${esc(p)}"><img src="${esc(rawUrl(p))}&t=${Date.now()}" alt="" loading="lazy"><figcaption>${esc(fileName(p))}<button class="icon-btn" data-del title="Excluir">${bs.I.x}</button></figcaption></figure>`).join('') : '<div class="qa-none">Nenhuma evidência ainda. Tire o print (Win+Shift+S) e cole aqui com Ctrl+V.</div>';
    el.querySelectorAll('figure').forEach(f => {
      f.querySelector('img').onclick = () => bs.openFile(f.dataset.p, 'editor');
      f.querySelector('[data-del]').onclick = async () => { try { await api('file/delete', { project: proj() }, { method: 'POST', body: JSON.stringify({ paths: [f.dataset.p] }) }); P.all = P.all.filter(x => x.p !== f.dataset.p); draw(el); fireLens(); pgSoon(); } catch (e) { toast(e.message); } };
    });
  };
  const add = async (el, files) => {
    for (const f of files) {
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
      if (!/^image\//.test(f.type)) continue;
      try { await saveEvidence(rel, sc, f, ext); } catch (e) { toast(e.message); }
    }
    draw(el); fireLens(); pgSoon();
  };
  const el = dialog('qaEv', `<div class="dlg-hd"><span class="dlg-ic">${ICO.cam}</span><div><h3>Evidências</h3><p>${esc(sc.name)}</p></div></div>
    <div class="qa-drop" tabindex="0">Cole um print (<b>Ctrl+V</b>), arraste imagens para cá ou <button class="chip" id="qaEvPick">escolha arquivos</button><input type="file" id="qaEvFile" accept="image/*" multiple hidden></div>
    <div class="qa-evs"></div>
    <div class="actions"><span class="qa-path">${esc(evDir(rel))}/</span><span class="spacer"></span><button class="chip" id="qaEvSt">Marcar status…</button><button class="chip primary" data-close>Pronto</button></div>`, (el) => {
    el.querySelector('.dlg-box').classList.add('qa-ev-box');
    draw(el);
    const drop = el.querySelector('.qa-drop'); drop.focus();
    el.querySelector('#qaEvPick').onclick = () => el.querySelector('#qaEvFile').click();
    el.querySelector('#qaEvFile').onchange = (e) => add(el, [...e.target.files]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('on'); };
    drop.ondragleave = () => drop.classList.remove('on');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('on'); add(el, [...e.dataTransfer.files]); };
    el.onpaste = (e) => { const fs = [...(e.clipboardData || {}).items || []].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean); if (fs.length) { e.preventDefault(); add(el, fs); } };
    el.querySelector('#qaEvSt').onclick = (e) => statusMenu(e, rel, sc);
  });
  return el;
}
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
// pasta do mês no estilo que o projeto já usa (OUTUBRO, OUTUBRO-2026, outubro_2026...)
function monthFolder(parent) {
  const kids = new Set(P.all.map(f => f.p).filter(p => (parent ? p.startsWith(parent + '/') : true)).map(p => (parent ? p.slice(parent.length + 1) : p).split('/')).filter(a => a.length > 1).map(a => a[0]));
  const ex = [...kids].map(k => ({ k, m: /^(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)([-_ ]?)(\d{4})?$/i.exec(k) })).filter(x => x.m);
  if (!ex.length) return null;
  const last = ex[ex.length - 1].m; const now = new Date();
  let name = MONTHS[now.getMonth()]; if (!/ç/i.test(ex.map(x => x.k).join('')) && ex.some(x => /marco/i.test(x.k))) name = name.replace('ç', 'c');
  if (last[1] === last[1].toUpperCase()) name = name.toUpperCase(); else if (last[1][0] === last[1][0].toUpperCase()) name = name[0].toUpperCase() + name.slice(1);
  return name + (last[3] ? (last[2] || '') + now.getFullYear() : '');
}
async function newFeature(dirHint) {
  await index();
  const dirs = [...new Set([...P.files.keys()].map(dirOf).flatMap(d => { const out = []; const a = d.split('/'); for (let i = 1; i <= a.length; i++) out.push(a.slice(0, i).join('/')); return out; }).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const flang = projLang();
  const start = dirHint ?? (S.active && isFeature(S.active) ? dirOf(S.active.path) : '');
  dialog('qaNew', `<div class="dlg-hd"><span class="dlg-ic">${ICO.feat}</span><div><h3>Nova feature</h3><p>Arquivo no padrão do time: <code>CHAMADO - Título.feature</code></p></div></div>
    <div class="qa-2"><label class="fld">Chamado / card<input id="qaTk" placeholder="INC1753202, PRB0068833, SDIG-123" spellcheck="false" autocomplete="off"></label>
      <label class="fld">Idioma<select id="qaLang"><option value="pt" ${flang === 'pt' ? 'selected' : ''}>Português</option><option value="en" ${flang === 'en' ? 'selected' : ''}>Inglês</option><option value="es" ${flang === 'es' ? 'selected' : ''}>Espanhol</option></select></label></div>
    <label class="fld">Título<input id="qaTitle" placeholder="Campanha não está respeitando o retorno do serviço" autocomplete="off"></label>
    <label class="fld">Pasta<input id="qaDir" list="qaDirs" value="${esc(start)}" spellcheck="false" autocomplete="off"><datalist id="qaDirs">${dirs.map(d => `<option value="${esc(d)}">`).join('')}</datalist></label>
    <label class="chk" id="qaMonthRow" hidden><input type="checkbox" id="qaMonth" checked> Na pasta do mês: <code id="qaMonthName"></code></label>
    <div class="qa-2"><label class="fld">Cenários<input id="qaN" type="number" min="1" max="50" value="1"></label><label class="fld">Tags (opcional)<input id="qaTags" placeholder="@regressao @portal" spellcheck="false"></label></div>
    <label class="chk"><input type="checkbox" id="qaStory" checked> História de usuário (Como / Eu quero / Para que)</label>
    <div class="qa-path" id="qaPrev"></div><div class="err" id="qaErr"></div>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="qaOk">Criar</button></div>`, (el) => {
    const $q = (s) => el.querySelector(s);
    const path = () => {
      const tk = $q('#qaTk').value.trim(), ti = $q('#qaTitle').value.trim().replace(/[\\/:*?"<>|]+/g, '-');
      let dir = $q('#qaDir').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const mf = monthFolder(dir);
      $q('#qaMonthRow').hidden = !mf || dir.split('/').pop() === mf; $q('#qaMonthName').textContent = mf || '';
      if (mf && !$q('#qaMonthRow').hidden && $q('#qaMonth').checked) dir = (dir ? dir + '/' : '') + mf;
      const name = [tk, ti].filter(Boolean).join(' - ') || 'nova';
      return (dir ? dir + '/' : '') + name + '.feature';
    };
    const upd = () => { $q('#qaPrev').textContent = path(); };
    el.querySelectorAll('input,select').forEach(i => { i.oninput = upd; i.onchange = upd; }); upd();
    $q('#qaTk').focus();
    $q('#qaOk').onclick = async () => {
      const L = KW[$q('#qaLang').value]; const tk = $q('#qaTk').value.trim(); const ti = $q('#qaTitle').value.trim();
      if (!tk && !ti) { $q('#qaErr').textContent = 'Informe o chamado ou o título.'; return; }
      const n = Math.max(1, Math.min(50, +$q('#qaN').value || 1)); const pre = (P.settings.prefix || 'CT').trim() || 'CT';
      const tags = [...new Set([...(tk ? ['@' + tk.replace(/\s+/g, '_')] : []), ...$q('#qaTags').value.split(/\s+/).filter(Boolean).map(t => t.startsWith('@') ? t : '@' + t)])];
      const es = $q('#qaLang').value === 'es';
      // a história segue o idioma das descrições que o time já escreve (muitos usam Feature: com o texto em português)
      const desc = [...P.files.values()].flatMap(f => f.doc.feature ? f.doc.feature.desc : []);
      const ptDesc = desc.filter(l => /^(como|eu quero|para que)\b/i.test(l)).length, enDesc = desc.filter(l => /^(as an?|i want|so that)\b/i.test(l)).length;
      const pt = $q('#qaLang').value === 'pt' || (!es && ptDesc > enDesc);
      const story = $q('#qaStory').checked ? (pt ?'  Como <papel>\n  Eu quero <objetivo>\n  Para que <benefício>\n' : es ? '  Como <rol>\n  Quiero <objetivo>\n  Para <beneficio>\n' : '  As a <role>\n  I want <goal>\n  So that <benefit>\n') : '';
      const sc = (i) => `\n  ${L.scenario[0]}: ${pre}${String(i).padStart(3, '0')} \n    ${L.given[0]} \n    ${L.when[0]} \n    ${L.then[0]} \n`;
      const text = `${$q('#qaLang').value === 'pt' ? '# language: pt\n' : es ? '# language: es\n' : ''}${tags.length ? tags.join(' ') + '\n' : ''}${L.feature[0]}: ${ti || tk}\n${story}${Array.from({ length: n }, (_, i) => sc(i + 1)).join('')}`;
      const p = path();
      try { await api('file/new', { project: proj() }, { method: 'POST', body: JSON.stringify({ path: p, content: text }) }); }
      catch (e) { $q('#qaErr').textContent = e.message; return; }
      el.hidden = true;
      await bs.refreshProject(); await bs.openFile(p, 'editor');
      const lines = text.split('\n'); const ln = lines.findIndex(l => l.trim().startsWith(L.given[0] + ' ')) + 1;
      if (bs.editor && ln) { bs.editor.setPosition({ lineNumber: ln, column: lines[ln - 1].length + 1 }); bs.editor.focus(); }
      index(true);
    };
  });
}

// ---------- provedores do Monaco ----------
let ready = false;
function setup() {
  const monaco = bs.monaco; if (ready || !monaco) return; ready = true;
  const L = monaco.languages; const R = monaco.Range;
  const cmd = (id, fn) => { try { monaco.editor.registerCommand(id, (_a, ...args) => fn(...args)); } catch {} };
  cmd('qa.status', (rel, line) => { const d = docFor(rel); const sc = d && d.scenarios.find(s => s.line === line); if (sc) statusMenu(atMouse(), rel, sc); });
  cmd('qa.evidence', (rel, line) => { const d = docFor(rel); const sc = d && d.scenarios.find(s => s.line === line); if (sc) evidenceDialog(rel, sc); });
  cmd('qa.copy', (rel, line) => { const d = docFor(rel); const sc = d && d.scenarios.find(s => s.line === line); if (sc) copyScenario(rel, sc); });
  cmd('qa.run', (rel, line, title) => runner(line != null ? `${rel}:${line + 1}` : rel, null, title));
  cmd('qa.report', (rel) => makeReport(rel, false));
  cmd('qa.csv', (rel) => exportCsv(rel, false));
  cmd('qa.createDef', (rel, line) => createDefinition(rel, line));

  // acima da funcionalidade e de cada cenário: status, evidências, copiar, executar
  L.registerCodeLensProvider('gherkin', {
    onDidChange: (fn) => { lensEmitter.list.add(fn); return { dispose: () => lensEmitter.list.delete(fn) }; },
    provideCodeLenses(model) {
      const rel = relOfModel(model); if (!rel) return { lenses: [], dispose() {} };
      const d = parse(model.getValue()); const lenses = [];
      const at = (line, title, id, args) => lenses.push({ range: new R(line + 1, 1, line + 1, 1), command: { id, title, arguments: args } });
      const run = automation() && P.runner;
      if (d.feature) {
        const sts = d.scenarios.map(s => statusOf(rel, s));
        const pass = sts.filter(s => s && s.s === 'pass').length, fail = sts.filter(s => s && s.s === 'fail').length, blk = sts.filter(s => s && s.s === 'blocked').length;
        if (run) at(d.feature.line, '▶ Executar feature', 'qa.run', [rel, null, titleOf(rel)]);
        at(d.feature.line, `${d.scenarios.length} cenário(s) · ✓ ${pass}  ✗ ${fail}  ⊘ ${blk}`, 'qa.report', [rel]);
        at(d.feature.line, 'Relatório de evidências', 'qa.report', [rel]);
        at(d.feature.line, 'Exportar CSV', 'qa.csv', [rel]);
      }
      for (const sc of d.scenarios) {
        const st = statusOf(rel, sc); const ev = evidences(rel, sc).length;
        if (run) at(sc.line, '▶ Executar', 'qa.run', [rel, sc.line, sc.name]);
        at(sc.line, st ? `${STATUS[st.s].sym} ${STATUS[st.s].label}` : '○ Não executado', 'qa.status', [rel, sc.line]);
        at(sc.line, ev ? `▣ Evidências (${ev})` : '▣ Evidência', 'qa.evidence', [rel, sc.line]);
        at(sc.line, 'Copiar', 'qa.copy', [rel, sc.line]);
      }
      return { lenses, dispose() {} };
    },
  });

  // autocompletar: palavras-chave, passos do projeto e das step definitions, tags e <colunas>
  L.registerCompletionItemProvider('gherkin', {
    triggerCharacters: ['@', '<', ' '],
    provideCompletionItems(model, pos) {
      const text = model.getValue(); const lang = detLang(text) || projLang(); const K = KW[lang];
      const M = L.CompletionItemKind; const S2 = L.CompletionItemInsertTextRule.InsertAsSnippet;
      const ln = model.getLineContent(pos.lineNumber); const before = ln.slice(0, pos.column - 1);
      const d = parse(text); const R2 = rx(lang);
      const items = []; const add = (o) => items.push(o);
      // @tag
      const tg = /(^|\s)@([\w.\-À-ú]*)$/.exec(before);
      if (tg) {
        const range = new R(pos.lineNumber, pos.column - tg[2].length - 1, pos.lineNumber, pos.column);
        const rel = relOfModel(model); const own = rel ? ticketsOf(rel).map(t => '@' + t) : [];
        [...new Set([...own, ...[...P.tags.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])])].slice(0, 300).forEach((t, i) => add({ label: t, kind: M.Keyword, insertText: t, range, detail: P.tags.get(t) ? `${P.tags.get(t)}× no projeto` : 'chamado deste arquivo', sortText: String(i).padStart(4, '0') }));
        return { suggestions: items };
      }
      // <coluna> dos Exemplos
      const lt = /<([^<>]*)$/.exec(before);
      if (lt) {
        const sc = d.scenarios.find(s => s.line < pos.lineNumber - 1 && (s.end == null || s.end >= pos.lineNumber - 1));
        const cols = sc ? [...new Set(sc.examples.flatMap(e => e.header || []))] : [];
        const range = new R(pos.lineNumber, pos.column - lt[1].length, pos.lineNumber, pos.column + (ln[pos.column - 1] === '>' ? 1 : 0));
        cols.forEach(c => add({ label: c, kind: M.Variable, insertText: c + '>', range }));
        return { suggestions: items };
      }
      // passo: depois da palavra-chave, o resto da linha vira o passo escolhido
      const sm = R2.step.exec(ln);
      if (sm && pos.column - 1 >= sm[1].length + sm[2].length) {
        const start = sm[1].length + sm[2].length + 2;
        const range = new R(pos.lineNumber, start, pos.lineNumber, ln.length + 1);
        const prev = (() => { const h = stepAt(d, pos.lineNumber - 1); return h ? h.st.type : R2.stepOf.get(sm[2]) || 'given'; })();
        const rel = relOfModel(model);
        let i = 0;
        const scored = [...P.steps.values()].map(e => ({ e, s: e.n * 3 + (e.types[prev] || 0) * 8 + (e.uses.some(u => u.rel === rel) ? 10 : 0) })).sort((a, b) => b.s - a.s).slice(0, 600);
        for (const { e } of scored) add({ label: { label: e.text, description: `${e.n}×` }, kind: M.Text, insertText: e.text, filterText: e.text, range, sortText: String(i++).padStart(4, '0'), detail: `Usado ${e.n} vez(es) no projeto` });
        if (automation()) for (const df of P.defs) {
          let k = 0; const snip = df.kind === 'expr' ? df.pattern.replace(/\\([(){}/])/g, '$1').replace(/\{(\w*)\}/g, (m, n) => n === 'string' ? `"\${${++k}:texto}"` : `\${${++k}:${n || 'valor'}}`).replace(/\(([^)]*)\)/g, '$1').replace(/(\S+)\/(\S+)/g, '$1')
            : df.pattern.replace(/^\^|\$$/g, '').replace(/"\([^)]*\)"/g, () => `"\${${++k}:texto}"`).replace(/\((?:\\d|-?\\d)[^)]*\)/g, () => `\${${++k}:0}`).replace(/\([^)]*\)/g, () => `\${${++k}:valor}`).replace(/\\(.)/g, '$1');
          add({ label: { label: snip.replace(/\$\{\d+:([^}]*)\}/g, '$1'), description: fileName(df.rel) }, kind: M.Function, insertText: snip, insertTextRules: S2, filterText: snip.replace(/\$\{\d+:([^}]*)\}/g, '$1'), range, sortText: 'z' + String(i++).padStart(4, '0'), detail: `${df.kw} · ${df.rel}:${df.line}` });
        }
        return { suggestions: items };
      }
      // primeira linha: "# language: pt"
      const lines0 = text.split('\n');
      if (/^\s*#\s*[\w:\s]*$/.test(before) && lines0.slice(0, pos.lineNumber - 1).every(x => !x.trim() || x.trim().startsWith('#'))
        && !/^\s*#\s*language\s*:/m.test(lines0.filter((x, j) => j !== pos.lineNumber - 1).join('\n'))) {
        const range = new R(pos.lineNumber, 1, pos.lineNumber, ln.length + 1);
        [['pt', 'Português: Funcionalidade, Cenário, Dado, Quando, Então'], ['es', 'Espanhol: Característica, Escenario, Dado, Cuando, Entonces']].forEach(([l, det], i) =>
          add({ label: `# language: ${l}`, kind: M.Keyword, insertText: `# language: ${l}`, filterText: `# language: ${l} idioma`, range, detail: det, sortText: (l === lang ? '0' : '1') + i }));
        return { suggestions: items };
      }
      // começo da linha: palavras-chave (passos dentro de cenário; cabeçalhos fora)
      if (/^\s*[\wÀ-ú]*$/.test(before)) {
        const w = /[\wÀ-ú]*$/.exec(before)[0]; const range = new R(pos.lineNumber, pos.column - w.length, pos.lineNumber, pos.column);
        const inSc = !!d.scenarios.concat(d.background || []).find(s => s.line < pos.lineNumber - 1 && (s.end == null || s.end >= pos.lineNumber - 2));
        let i = 0; const o = (n) => String(n).padStart(3, '0');
        // em português sem "# language: pt" o Cucumber lê o arquivo como inglês: a primeira palavra-chave escolhida já põe o cabeçalho
        const hdr = lang !== 'en' && !/^\s*#\s*language\s*:/m.test(text) ? `# language: ${lang}\n` : '';
        const first = hdr && pos.lineNumber === 1;
        const head = (o2) => {
          if (!hdr) return o2;
          if (first) return { ...o2, insertText: hdr.replace(/\$/g, '\\$') + o2.insertText, insertTextRules: S2 };
          return { ...o2, additionalTextEdits: [{ range: new R(1, 1, 1, 1), text: hdr }] };
        };
        // o filtro aceita o termo sem acento e o equivalente em inglês: "cenario" e "scen" acham Cenário
        const kw = (k, word, o2) => add(head({ ...o2, label: o2.label || word, filterText: o2.filterText || [word, unaccent(word), lang !== 'en' ? KW.en[k][0] : ''].filter(Boolean).join(' '), detail: [o2.detail, lang !== 'en' ? KW.en[k][0] : ''].filter(Boolean).join(' · ') }));
        const steps = lang === 'pt' ? [['given', 'Dado'], ['when', 'Quando'], ['then', 'Então'], ['and', 'E'], ['but', 'Mas'], ['given', 'Dada'], ['given', 'Dados'], ['given', 'Dadas']]
          : [['given', K.given[0]], ['when', K.when[0]], ['then', K.then[0]], ['and', K.and[0]], ['but', K.but[0]]];
        steps.forEach(([k, word]) => kw(k, word, { kind: M.Keyword, insertText: word + ' ', sortText: (inSc ? 'a' : 'b') + o(i++), command: { id: 'editor.action.triggerSuggest', title: '' }, detail: lang === 'pt' && /^Dad/.test(word) && word !== 'Dado' ? { Dada: 'feminino', Dados: 'plural', Dadas: 'feminino plural' }[word] : '' }));
        kw('scenario', K.scenario[0], { label: `${K.scenario[0]}: ${nextId(d)}`, kind: M.Snippet, insertText: `${K.scenario[0]}: ${nextId(d)} \${1:título}\n\t${K.given[0]} \${2}\n\t${K.when[0]} \${3}\n\t${K.then[0]} \${4}`, insertTextRules: S2, sortText: (inSc ? 'c' : 'a') + o(i++), detail: 'cenário novo com o próximo número' });
        kw('outline', K.outline[0], { kind: M.Snippet, insertText: `${K.outline[0]}: ${nextId(d)} \${1:título}\n\t${K.given[0]} \${2:passo com <valor>}\n\n\t${K.examples[0]}:\n\t\t| valor |\n\t\t| \${3:a}     |`, insertTextRules: S2, sortText: (inSc ? 'c' : 'a') + o(i++), detail: 'esquema com Exemplos' });
        if (!d.background) kw('background', K.background[0], { kind: M.Snippet, insertText: `${K.background[0]}:\n\t${K.given[0]} \${1}`, insertTextRules: S2, sortText: (inSc ? 'c' : 'a') + o(i++), detail: 'passos que valem para todos os cenários' });
        kw('examples', K.examples[0], { kind: M.Keyword, insertText: `${K.examples[0]}:\n\t| \${1:coluna} |\n\t| \${2:valor}  |`, insertTextRules: S2, sortText: 'c' + o(i++) });
        if (!d.feature) {
          const story = { pt: ['Como', 'Quero', 'Para'], es: ['Como', 'Quiero', 'Para'], en: ['As a', 'I want', 'So that'] }[lang];
          kw('feature', K.feature[0], { kind: M.Snippet, insertText: `${K.feature[0]}: \${1:título}\n`, insertTextRules: S2, sortText: 'a000' });
          kw('feature', K.feature[0], { label: `${K.feature[0]} com história`, kind: M.Snippet, insertText: `${K.feature[0]}: \${1:título}\n\t${story[0]} \${2:perfil}\n\t${story[1]} \${3:ação}\n\t${story[2]} \${4:benefício}\n\n`, insertTextRules: S2, sortText: 'a001', detail: story.join(' / ') });
          // arquivo ainda sem palavras-chave: o outro idioma também (Funcionalidade num projeto em inglês, Feature num em português)
          if (!detLang(text)) for (const l of ['pt', 'en']) if (l !== lang) {
            const w = KW[l].feature[0]; const h = l === 'en' ? '' : `# language: ${l}\n`;
            const o2 = { label: w, kind: M.Snippet, insertText: `${w}: \${1:título}\n`, insertTextRules: S2, sortText: 'a002', filterText: `${w} ${unaccent(w)}`, detail: l === 'pt' ? 'português · põe o # language: pt' : 'inglês' };
            add(!h ? o2 : pos.lineNumber === 1 ? { ...o2, insertText: h + o2.insertText } : { ...o2, additionalTextEdits: [{ range: new R(1, 1, 1, 1), text: h }] });
          }
        }
        kw('rule', K.rule[0], { kind: M.Keyword, insertText: `${K.rule[0]}: \${1:regra}\n`, insertTextRules: S2, sortText: 'd' + o(i++) });
        add({ label: 'tabela', kind: M.Snippet, insertText: '| ${1:coluna} | ${2:coluna} |\n| ${3:valor}  | ${4:valor}  |', insertTextRules: S2, range, sortText: 'd' + o(i++), detail: 'tabela de dados' });
        add({ label: 'docstring', kind: M.Snippet, insertText: '"""\n${1}\n"""', insertTextRules: S2, range, sortText: 'd' + o(i++), detail: 'texto em várias linhas' });
        items.forEach(x => { x.range = x.range || range; });
        return { suggestions: items };
      }
      return { suggestions: [] };
    },
  });

  // passar o mouse num passo: quantas vezes é usado e a definição (automação)
  L.registerHoverProvider('gherkin', {
    provideHover(model, pos) {
      const d = parse(model.getValue()); const h = stepAt(d, pos.lineNumber - 1); if (!h) return null;
      const e = P.steps.get(norm(h.st.text)); const parts = [];
      parts.push(`Usado **${e ? e.n : 1}** vez(es) no projeto${e && e.uses.length > 1 ? ` (${new Set(e.uses.map(u => u.rel)).size} arquivo(s))` : ''}`);
      if (automation() && P.defs.length) { const defs = defsFor(concrete(h.st, h.sc)); parts.push(defs.length ? defs.map(x => `\`${x.rel}:${x.line}\` · ${x.kw}(\`${x.pattern}\`)`).join('  \n') : '_Sem step definition_'); }
      return { contents: [{ value: parts.join('\n\n') }] };
    },
  });
  // F12 / Ctrl+clique: a step definition
  L.registerDefinitionProvider('gherkin', {
    async provideDefinition(model, pos) {
      if (!P.defs.length) return null;
      const d = parse(model.getValue()); const h = stepAt(d, pos.lineNumber - 1); if (!h) return null;
      const defs = defsFor(concrete(h.st, h.sc)); const out = [];
      for (const x of defs.slice(0, 10)) { const m = await modelForRel(x.rel); if (m) out.push({ uri: m.uri, range: new R(x.line, 1, x.line, 1) }); }
      return out;
    },
  });
  // Shift+F12: onde mais o passo é usado
  L.registerReferenceProvider('gherkin', {
    async provideReferences(model, pos) {
      const d = parse(model.getValue()); const h = stepAt(d, pos.lineNumber - 1); if (!h) return [];
      const e = P.steps.get(norm(h.st.text)); if (!e) return [];
      const out = [];
      for (const u of e.uses.slice(0, 80)) { const m = await modelForRel(u.rel); if (m) out.push({ uri: m.uri, range: new R(u.line + 1, 1, u.line + 1, m.getLineMaxColumn(u.line + 1)) }); }
      return out;
    },
  });
  // Shift+Alt+F
  L.registerDocumentFormattingEditProvider('gherkin', { provideDocumentFormattingEdits: (model) => { const t = format(model.getValue()); return t === model.getValue() ? [] : [{ range: model.getFullModelRange(), text: t }]; } });
  // Ctrl+F12, trilha e rolagem fixa: funcionalidade > cenários
  L.registerDocumentSymbolProvider('gherkin', {
    provideDocumentSymbols(model) {
      const d = parse(model.getValue()); const SK = L.SymbolKind; const n = model.getLineCount();
      const rng = (a, b) => new R(a + 1, 1, Math.min(n, (b ?? a) + 1), 1);
      const kids = [d.background, ...d.scenarios].filter(Boolean).map(s => ({ name: s.name || s.kw, detail: s.kw, kind: s.kind === 'background' ? SK.Constructor : SK.Method, range: rng(s.line, s.end), selectionRange: rng(s.line), tags: [], children: [] }));
      return d.feature ? [{ name: d.feature.name, detail: d.feature.kw, kind: SK.Class, range: rng(d.feature.line, n - 1), selectionRange: rng(d.feature.line), tags: [], children: kids }] : kids;
    },
  });
  // Alt+Enter
  L.registerCodeActionProvider('gherkin', {
    provideCodeActions(model, range, ctx) {
      const rel = relOfModel(model); const d = parse(model.getValue()); const actions = [];
      const st = hold.get(model);
      for (const mk of ctx.markers.filter(m => m.source === 'Cucumber')) {
        const info = st && st.data.find(x => x.line === mk.startLineNumber - 1 && x.code === mk.code);
        if (mk.code === 'similar' && info) actions.push({ title: `Trocar por “${info.to}”`, kind: 'quickfix', diagnostics: [mk], isPreferred: true, edit: { edits: [{ resource: model.uri, textEdit: { range: new R(mk.startLineNumber, mk.startColumn, mk.endLineNumber, mk.endColumn), text: info.to }, versionId: undefined }] } });
        if (mk.code === 'no-language' && info) actions.push({ title: `Adicionar "# language: ${info.lang}"`, kind: 'quickfix', diagnostics: [mk], isPreferred: true, edit: { edits: [{ resource: model.uri, textEdit: { range: new R(1, 1, 1, 1), text: `# language: ${info.lang}\n` } }] } });
        if (mk.code === 'undefined' && rel) actions.push({ title: 'Criar definição do passo…', kind: 'quickfix', diagnostics: [mk], isPreferred: true, command: { id: 'qa.createDef', title: '', arguments: [rel, mk.startLineNumber - 1] } });
        if (mk.code === 'comment-tag' && info && d.feature) {
          actions.push({ title: `Transformar em tag ${info.tag} (acima da funcionalidade)`, kind: 'quickfix', diagnostics: [mk], edit: { edits: [
            { resource: model.uri, textEdit: { range: new R(mk.startLineNumber, 1, mk.startLineNumber + 1, 1), text: '' } },
            { resource: model.uri, textEdit: { range: new R(d.feature.line + 1, 1, d.feature.line + 1, 1), text: info.tag + '\n' } },
          ] } });
        }
      }
      // refatorações: no cabeçalho da funcionalidade ou de um cenário
      const line = range.startLineNumber - 1;
      const onHead = (d.feature && d.feature.line === line) || d.scenarios.some(s => s.line === line) || (d.background && d.background.line === line);
      if (onHead) {
        const common = commonPrefix(d);
        if (common.length) { const edits = toBackgroundEdits(model, d); if (edits) actions.push({ title: `Mover ${common.length} passo(s) repetido(s) para o ${KW[d.lang].background[0]}`, kind: 'refactor', edit: { edits: edits.map(e => ({ resource: model.uri, textEdit: e })) } }); }
        const ren = renumberEdits(d); if (ren.length) actions.push({ title: 'Renumerar cenários (' + (P.settings.prefix || 'CT') + '001, 002...)', kind: 'refactor', edit: { edits: ren.map(e => ({ resource: model.uri, textEdit: e })) } });
        const f = format(model.getValue()); if (f !== model.getValue()) actions.push({ title: 'Formatar e alinhar tabelas', kind: 'refactor', edit: { edits: [{ resource: model.uri, textEdit: { range: model.getFullModelRange(), text: f } }] } });
      }
      if (d.feature && d.feature.line === line) {
        for (const [to, name] of [['pt', 'português (Funcionalidade, Cenário, Dado...)'], ['en', 'inglês (Feature, Scenario, Given...)']]) {
          if (to === d.lang) continue;
          const t = translate(model.getValue(), to);
          if (t !== model.getValue()) actions.push({ title: `Converter palavras-chave para ${name}`, kind: 'refactor', edit: { edits: [{ resource: model.uri, textEdit: { range: model.getFullModelRange(), text: t } }] } });
        }
      }
      return { actions, dispose() {} };
    },
  });
  S.tabs.forEach(watch);
}

// ---------- painel QA (Alt+9) ----------
// uma tela só: busca, resumo da execução (filtra por status), tags e as features com os cenários
const V = { q: '', st: null, shut: new Set(store.get('qaShut', [])), openFeat: new Set(store.get('qaOpenFeat', [])), sort: store.get('qaSort', 'name') };
function matches(rel, f, q) {
  if (!q) return true;
  const ql = q.toLowerCase();
  if (q.startsWith('@')) return f.doc.tags.some(t => t.tag.toLowerCase().startsWith(ql));
  if (rel.toLowerCase().includes(ql) || (f.doc.feature && f.doc.feature.name.toLowerCase().includes(ql))) return true;
  return f.doc.scenarios.some(s => s.name.toLowerCase().includes(ql) || s.steps.some(st => st.text.toLowerCase().includes(ql)));
}
function counts(rel, d) {
  const o = { pass: 0, fail: 0, blocked: 0, none: 0 };
  for (const s of d.scenarios) { const st = statusOf(rel, s); o[st ? st.s : 'none']++; }
  return o;
}
const bar = (c, total) => total ? `<span class="qa-bar">${['pass', 'fail', 'blocked'].map(k => c[k] ? `<i class="${k}" style="flex:${c[k]}"></i>` : '').join('')}<i class="none" style="flex:${c.none}"></i></span>` : '';
// cenários que aparecem: a busca (na feature inteira ou só no cenário) e o filtro de status
function visibleScs(rel, f, query = V.q, status = V.st) {
  const q = query.toLowerCase();
  const whole = !q || (q.startsWith('@') ? matches(rel, f, query) : rel.toLowerCase().includes(q) || (f.doc.feature && f.doc.feature.name.toLowerCase().includes(q)));
  return f.doc.scenarios.filter(s => {
    if (status) { const st = statusOf(rel, s); if ((st ? st.s : 'none') !== status) return false; }
    return whole || s.name.toLowerCase().includes(q) || s.steps.some(x => x.text.toLowerCase().includes(q));
  });
}
// anel de progresso: verde, vermelho e amarelo na proporção dos cenários
function ring(c, total) {
  const r = 21, C = 2 * Math.PI * r; let off = 0;
  const segs = ['pass', 'fail', 'blocked'].map(k => { const len = total ? C * c[k] / total : 0; const s = len ? `<circle r="${r}" cx="26" cy="26" class="${k}" stroke-dasharray="${len} ${C}" stroke-dashoffset="${-off}"/>` : ''; off += len; return s; }).join('');
  return `<svg class="qa-ring" viewBox="0 0 52 52"><circle r="${r}" cx="26" cy="26" class="bg"/><g transform="rotate(-90 26 26)">${segs}</g></svg>`;
}
const SFILTER = [['pass', 'Passou', '✓'], ['fail', 'Falhou', '✗'], ['blocked', 'Bloqueado', '⊘'], ['none', 'Pendente', '○']];
// o painel: os cenários (Gherkin)
function render() {
  const body = $('#toolBody');
  if (!S.project) { body.innerHTML = '<div class="empty">Abra um projeto.</div>'; return; }
  body.innerHTML = `<div class="qa"><div class="qa-top"><div class="qa-sub"></div></div><div class="qa-body"></div></div>`;
  const sub = body.querySelector('.qa-sub'), el = body.querySelector('.qa-body');
  $('#toolActions').innerHTML = ''; $('#toolSub').textContent = '';
  renderScenarios(sub, el);
}
function renderScenarios(sub, el) {
  if (P.for !== proj() || (!P.at && !P.loading)) { el.innerHTML = '<div class="empty">Lendo as features…</div>'; index(); return; }
  $('#toolSub').textContent = '';
  $('#toolActions').innerHTML = `<button class="icon-btn" id="qaNewBtn" title="Nova feature">${ICO.plus}</button><button class="icon-btn" id="qaExp" title="Relatório e CSV">${ICO.doc}</button><button class="icon-btn" id="qaRef" title="Ler de novo">${bs.I.refresh}</button>`;
  $('#qaNewBtn').onclick = () => newFeature(); $('#qaRef').onclick = () => index(true);
  $('#qaExp').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); bs.showMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.bottom + 4 }, [
    { label: 'Relatório de evidências (HTML)', icon: ICO.doc, action: () => runScope('report') },
    { label: 'Exportar casos de teste (CSV)', icon: ICO.csv, action: () => runScope('csv') },
  ], V.q ? 'Do que a busca encontrou' : 'De todas as features'); };
  sub.innerHTML = `<label class="qa-search"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="qa-q" placeholder="Buscar cenário, @tag ou chamado" value="${esc(V.q)}" spellcheck="false">${V.q ? `<button class="qa-clr" title="Limpar">${bs.I.x}</button>` : ''}</label>`;
  const qi = sub.querySelector('.qa-q');
  let tm = null;
  qi.oninput = () => { V.q = qi.value.trim(); clearTimeout(tm); tm = setTimeout(draw, 120); };
  qi.onkeydown = (e) => { if (e.key === 'Escape' && V.q) { V.q = ''; render(); } };
  const clr = sub.querySelector('.qa-clr'); if (clr) clr.onclick = () => { V.q = ''; render(); };
  const draw = () => { el.innerHTML = viewPanel(); bindView(el); const c = sub.querySelector('.qa-clr'); if (!!c !== !!V.q) { const pos = qi.selectionStart; render(); const n = $('#toolBody .qa-q'); n.focus(); n.setSelectionRange(pos, pos); } };
  draw();
}
function viewPanel() {
  if (!P.files.size) return `<div class="qa-empty">${ICO.feat}<b>Nenhuma feature ainda</b><span>Crie a primeira no padrão do time: <code>CHAMADO - Título.feature</code></span><button class="chip primary" data-new>${ICO.plus} Nova feature</button></div>`;
  // resumo (do que a busca encontrou)
  const all = [...P.files.entries()].filter(([rel, f]) => matches(rel, f, V.q));
  const tot = { pass: 0, fail: 0, blocked: 0, none: 0 };
  for (const [rel, f] of all) { const c = counts(rel, f.doc); for (const k in c) tot[k] += c[k]; }
  const total = tot.pass + tot.fail + tot.blocked + tot.none; const done = total - tot.none;
  // no centro do anel: aprovação (dos executados)
  const rate = done ? Math.round(tot.pass * 100 / done) : 0;
  const state = !total ? '' : tot.fail ? 'fail' : tot.blocked && !tot.none ? 'blocked' : done === total ? 'pass' : '';
  const msg = !total ? 'Nenhum cenário' : tot.fail ? `${tot.fail} falh${tot.fail > 1 ? 'aram' : 'ou'}` : done === total ? (tot.blocked ? `${tot.blocked} bloqueado${tot.blocked > 1 ? 's' : ''}` : 'Tudo passou') : `${tot.none} pendente${tot.none > 1 ? 's' : ''}`;
  const sum = `<div class="qa-hero ${state}">
    <div class="qa-hero-r">
      <div class="qa-ringw" title="${done ? rate + '% dos executados passaram' : 'Nada executado ainda'}">${ring(tot, total)}<span>${done ? `<em>${rate}<small>%</small></em>` : '–'}</span></div>
      <div class="qa-hero-t"><b>${msg}</b><small>${done} de ${total} executado${done === 1 ? '' : 's'}</small></div>
    </div>
    <div class="qa-stats">${SFILTER.map(([k, l]) => `<button class="qa-stat p-${k} ${V.st === k ? 'on' : ''} ${tot[k] ? '' : 'zero'}" data-st="${k}" title="${V.st === k ? 'Mostrar todos' : 'Só ' + l.toLowerCase()}"><b>${tot[k]}</b><span>${k === 'blocked' ? 'Bloq.' : l}</span></button>`).join('')}</div>
  </div>`;
  // tags
  const tags = [...P.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const run = automation() && P.runner;
  const tagRow = tags.length ? `<div class="qa-tagrow">${tags.map(([t, n]) => `<span class="qa-tag ${V.q === t ? 'on' : ''}" data-tag="${esc(t)}" title="${n} ocorrência(s)${run ? ' · botão direito: executar' : ''}">${esc(t)}</span>`).join('')}</div>` : '';
  // features
  const files = all.map(([rel, f]) => [rel, f, visibleScs(rel, f)]).filter(([, f, scs]) => scs.length || (!V.st && !f.doc.scenarios.length));
  if (V.sort === 'recent') files.sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0));
  else files.sort((a, b) => a[0].localeCompare(b[0], 'pt-BR', { numeric: true }));
  const filtering = !!V.q || !!V.st;
  const head = `<div class="qa-sec"><span>Features <em>${all.length}</em></span><button class="qa-sort" data-sort="${V.sort === 'recent' ? 'name' : 'recent'}" title="Ordenar">${V.sort === 'recent' ? 'Recentes' : 'Por pasta'} ${ICO.chev}</button></div>`;
  if (!files.length) return sum + tagRow + head + `<div class="qa-none">${V.st ? 'Nenhum cenário com esse status.' : 'Nada encontrado.'}</div>`;
  const autoOpen = filtering || files.length <= 3;
  const card = ([rel, f, scs]) => featCard(rel, f, scs, autoOpen || V.openFeat.has(rel));
  let list;
  if (V.sort === 'recent') list = files.map(card).join('');
  else {
    const groups = new Map(); for (const x of files) { const g = dirOf(x[0]); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
    list = [...groups.entries()].map(([g, xs]) => {
      if (groups.size === 1) return xs.map(card).join('');
      const shut = !filtering && V.shut.has(g);
      return `<div class="qa-dir ${shut ? '' : 'open'}" data-dir="${esc(g)}">${ICO.chev}<span class="qa-dn">${esc(g || 'raiz do projeto')}</span><em>${xs.length}</em></div>${shut ? '' : xs.map(card).join('')}`;
    }).join('');
  }
  return sum + tagRow + head + `<div class="qa-feats">${list}</div>`;
}
function featCard(rel, f, scs, open) {
  const d = f.doc; const c = counts(rel, d); const n = d.scenarios.length; const tk = ticketsOf(rel);
  const state = c.fail ? 'fail' : c.blocked ? 'blocked' : n && c.pass === n ? 'pass' : '';
  if (!n) open = false;
  const done = n - c.none;
  // selo à direita: o que mais importa primeiro (falhas, bloqueios, tudo ok, andamento)
  const badge = !n ? '<span class="qa-fb">vazia</span>'
    : c.fail ? `<span class="qa-fb fail">✗ ${c.fail}</span>`
    : c.blocked ? `<span class="qa-fb blocked">⊘ ${c.blocked}</span>`
    : c.pass === n ? `<span class="qa-fb pass">✓ ${n}</span>`
    : `<span class="qa-fb">${done}/${n}</span>`;
  const tip = n ? `${esc(rel)}\n${c.pass} passou · ${c.fail} falhou · ${c.blocked} bloqueado · ${c.none} pendente` : esc(rel) + '\nSem cenários: clique para abrir';
  return `<div class="qa-fc ${open ? 'open' : ''} ${state} ${n ? '' : 'nosc'}" data-rel="${esc(rel)}">
    <div class="qa-fh" data-tog title="${tip}">
      <span class="qa-chev">${n ? ICO.chev : ICO.feat}</span>
      <div class="qa-ft">${tk.map(t => `<span class="qa-tk" data-tk="${esc(t)}" title="${ticketLink(t) ? 'Abrir o chamado' : 'Copiar'}">${esc(t)}</span>`).join('')}<span class="qa-fn">${esc(titleOf(rel))}</span></div>
      <button class="qa-ico" data-openf title="Abrir a feature">${bs.I.edit}</button>
      ${badge}
    </div>
    ${n ? `<div class="qa-fbar">${bar(c, n)}</div>` : ''}
    ${open ? `<div class="qa-scs">${scs.map(s => scRow(rel, s)).join('') || '<div class="qa-none">Sem cenários.</div>'}</div>` : ''}
  </div>`;
}
function scRow(rel, s) {
  const st = statusOf(rel, s); const k = st ? st.s : 'none'; const ev = evidences(rel, s).length;
  return `<div class="qa-sc s-${k}" data-rel="${esc(rel)}" data-line="${s.line}" title="${st && st.note ? esc(st.note) : 'Abrir no editor · botão direito: mais opções'}">
    <i class="qa-dot">${k === 'none' ? '' : STATUS[k].sym}</i><span class="qa-scn">${esc(s.name || s.kw)}</span>${ev ? `<span class="qa-ev" title="evidências">${ICO.cam}${ev}</span>` : ''}
    <span class="qa-qs">${['pass', 'fail', 'blocked'].map(x => `<button class="q-${x} ${k === x ? 'on' : ''}" data-set="${x}" title="${k === x ? 'Desmarcar' : STATUS[x].label}">${STATUS[x].sym}</button>`).join('')}</span>
  </div>`;
}
// clique no chamado: abre o link configurado ou copia o número
function ticketGo(id) { const u = ticketLink(id); if (u) window.open(u, '_blank'); else { bs.copyText(id); toast('Copiado: ' + id); } }
function bindView(el) {
  el.querySelectorAll('[data-new]').forEach(b => b.onclick = () => newFeature());
  el.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { V.sort = b.dataset.sort; store.set('qaSort', V.sort); render(); });
  el.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { V.st = V.st === b.dataset.st ? null : b.dataset.st; render(); });
  el.querySelectorAll('.qa-dir').forEach(r => r.onclick = () => { const g = r.dataset.dir; V.shut.has(g) ? V.shut.delete(g) : V.shut.add(g); store.set('qaShut', [...V.shut].slice(0, 300)); render(); });
  el.querySelectorAll('.qa-fc').forEach(card => {
    const rel = card.dataset.rel;
    card.querySelector('.qa-fh').onclick = (e) => {
      const tk = e.target.closest('[data-tk]');
      if (tk) return ticketGo(tk.dataset.tk);
      if (e.target.closest('[data-openf]') || card.classList.contains('nosc')) return bs.openFile(rel, 'editor');
      const open = card.classList.contains('open');
      if (open) V.openFeat.delete(rel); else V.openFeat.add(rel);
      // com a busca/filtro ou poucas features elas já vêm abertas: fechar uma só some até o próximo render
      store.set('qaOpenFeat', [...V.openFeat].slice(0, 300));
      if (open) { card.classList.remove('open'); card.querySelector('.qa-scs')?.remove(); } else render();
    };
    card.querySelector('.qa-fh').oncontextmenu = (e) => featMenu(e, rel);
  });
  el.querySelectorAll('.qa-sc').forEach(r => {
    const sc = () => { const d = docFor(r.dataset.rel); return d && d.scenarios.find(s => s.line === +r.dataset.line); };
    r.onclick = (e) => {
      const b = e.target.closest('[data-set]');
      if (b) { const s = sc(); if (s) { const cur = statusOf(r.dataset.rel, s); setStatus(r.dataset.rel, s, cur && cur.s === b.dataset.set ? null : b.dataset.set); } return; }
      bs.openFile(r.dataset.rel, 'editor', +r.dataset.line + 1);
    };
    r.oncontextmenu = (e) => { const s = sc(); if (s) statusMenu(e, r.dataset.rel, s); };
  });
  el.querySelectorAll('.qa-tag').forEach(r => {
    r.onclick = () => { V.q = V.q === r.dataset.tag ? '' : r.dataset.tag; render(); };
    r.oncontextmenu = (e) => { e.preventDefault(); if (automation() && P.runner) bs.showMenu(e, [{ label: 'Executar ' + r.dataset.tag, icon: ICO.play, action: () => runner(null, r.dataset.tag, r.dataset.tag) }]); };
  });
}
// relatório/CSV do painel: o que a busca encontrou (ou tudo); a tela passa as features e os cenários do filtro dela
async function runScope(kind, rels = [...P.files.entries()].filter(([rel, f]) => matches(rel, f, V.q)).map(([rel]) => rel), keep) {
  if (!rels.length) return toast('Nenhuma feature');
  const dirs = rels.map(dirOf); let common = dirs[0] || '';
  for (const d of dirs) while (common && !(d === common || d.startsWith(common + '/'))) common = dirOf(common);
  if (kind === 'report') { const out = (common ? common + '/' : '') + 'relatorio-evidencias.html'; await writeText(out, reportHtml(rels, dirOf(out), keep)); toast('Relatório gerado: ' + out, 'ok'); openOutside(out); }
  else { const out = (common ? common + '/' : '') + 'casos-de-teste.csv'; await writeText(out, csvOf(rels, keep)); toast('CSV gerado: ' + out, 'ok'); bs.openFile(out, 'editor'); }
}
function featMenu(e, rel) {
  bs.showMenu(e, [
    { label: 'Abrir', icon: bs.I.edit, action: () => bs.openFile(rel, 'editor') },
    ...ticketsOf(rel).map(t => ({ label: (ticketLink(t) ? 'Abrir ' : 'Copiar ') + t, icon: ICO.link, action: () => { const u = ticketLink(t); if (u) window.open(u, '_blank'); else bs.copyText(t); } })),
    '-',
    { label: 'Relatório de evidências', icon: ICO.doc, action: () => makeReport(rel, false) },
    { label: 'Exportar casos de teste (CSV)', icon: ICO.csv, action: () => exportCsv(rel, false) },
    { label: 'Copiar todos os cenários (texto)', icon: bs.I.copy, action: () => { const d = docFor(rel); if (d) { bs.copyText(`${d.feature ? d.feature.kw + ': ' + d.feature.name + '\n\n' : ''}${d.scenarios.map(s => scenarioText(rel, d, s)).join('\n\n')}`); toast('Cenários copiados', 'ok'); } } },
    ...(automation() && P.runner ? [{ label: 'Executar feature', icon: ICO.play, action: () => runner(rel, null, titleOf(rel)) }] : []),
    '-', { label: 'Nova feature nesta pasta', icon: ICO.plus, action: () => newFeature(dirOf(rel)) },
  ], titleOf(rel));
}

// ====================================================================================================================
// Relatório de bug de um cenário que falhou (no menu do status): passos, esperado e chamado já preenchidos
// ====================================================================================================================
const copy = (v, what) => { bs.copyText(String(v)); toast((what || 'Copiado') + ': ' + (String(v).length > 60 ? String(v).slice(0, 60) + '…' : v), 'ok'); };
const pad = (n, w = 2) => String(n).padStart(w, '0');
// 2026-10-21-19-02 no horário local (nome de arquivo)
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
// ---------- relatório de bug ----------
const SEV = ['Bloqueante', 'Crítica', 'Alta', 'Média', 'Baixa'];
const envList = () => String(P.settings.envs || '').split('\n').map(l => /^\s*([^=]+?)\s*=\s*(\S+)/.exec(l)).filter(Boolean).map(m => ({ name: m[1], url: m[2] }));
function bugText(b, md) {
  const L = (t, v) => v ? (md ? `**${t}:** ${v}` : `${t}: ${v}`) : null;
  const sec = (t, v) => v ? (md ? `\n### ${t}\n${v}` : `\n${t.toUpperCase()}\n${v}`) : '';
  const steps = b.steps.split('\n').map(s => s.trim()).filter(Boolean).map((s, i) => /^\d+[.)]/.test(s) ? s : `${i + 1}. ${s}`).join('\n');
  return [md ? `## ${b.title}` : b.title, '', [L('Severidade', b.sev), L('Prioridade', b.prio), L('Ambiente', b.env), L('Navegador / dispositivo', b.device), L('Chamado relacionado', b.ticket), L('Cenário', b.scenario), L('Reportado por', b.by), L('Data', new Date().toLocaleString('pt-BR'))].filter(Boolean).join(md ? '  \n' : '\n'),
    sec('Pré-condição', b.pre), sec('Passos para reproduzir', steps), sec('Resultado esperado', b.expected), sec('Resultado obtido', b.actual), sec('Evidências', b.evidence)].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function bugDialog(seed = {}) {
  const envs = envList();
  dialog('qk_bug', `<div class="dlg-hd"><span class="dlg-ic">${ICO.bug}</span><div><h3>Relatório de bug</h3><p>` + 'Preencha e copie (texto para o chamado ou Markdown para Jira/Azure/GitHub), ou salve em ' + esc((P.settings.bugsDir || 'qa') + '/bugs') + `.</p></div></div>
    <div class="qk">
    <label class="fld">Título<input id="bT" value="${esc(seed.title || '')}" placeholder="Ao salvar o cadastro com CPF válido, a tela mostra erro 500"></label>
    <div class="qa-2"><label class="fld">Severidade<select id="bS">${SEV.map(s => `<option ${s === (seed.sev || 'Média') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="fld">Prioridade<select id="bP">${['Alta', 'Média', 'Baixa'].map(s => `<option ${s === 'Média' ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
    <div class="qa-2"><label class="fld">Ambiente<input id="bE" list="bEl" value="${esc(seed.env || (envs[1] || envs[0] || {}).name || '')}"><datalist id="bEl">${envs.map(e => `<option value="${esc(e.name)}">${esc(e.url)}</option>`).join('')}</datalist></label>
      <label class="fld">Navegador / dispositivo<input id="bD" value="${esc(seed.device || navigator.userAgent.match(/(Edg|Chrome|Firefox)\/[\d]+/)?.[0]?.replace('Edg', 'Edge') || '')}"></label></div>
    <div class="qa-2"><label class="fld">Chamado relacionado<input id="bK" value="${esc(seed.ticket || '')}" placeholder="INC1753202"></label><label class="fld">Cenário<input id="bC" value="${esc(seed.scenario || '')}" placeholder="CT002 ..."></label></div>
    <label class="fld">Pré-condição<textarea id="bPre" rows="2">${esc(seed.pre || '')}</textarea></label>
    <label class="fld">Passos para reproduzir <small class="pl-help">um por linha; a numeração entra sozinha</small><textarea id="bSt" rows="5">${esc(seed.steps || '')}</textarea></label>
    <div class="qa-2"><label class="fld">Resultado esperado<textarea id="bEx" rows="3">${esc(seed.expected || '')}</textarea></label><label class="fld">Resultado obtido<textarea id="bAc" rows="3">${esc(seed.actual || '')}</textarea></label></div>
    <label class="fld">Evidências <small class="pl-help">links, nomes dos prints, trecho de log</small><textarea id="bEv" rows="2">${esc(seed.evidence || '')}</textarea></label>
    <div class="qk-bar"><span class="spacer"></span><button class="chip" id="bCopyT">Copiar texto</button><button class="chip" id="bCopyM">Copiar Markdown</button><button class="chip primary" id="bSave">Salvar .md</button></div></div>
    <div class="actions"><span class="spacer"></span><button class="chip" data-close>Fechar</button></div>`, (el) => {
    el.querySelector('.dlg-box').classList.add('qk-box');
    const v = (id) => el.querySelector('#' + id).value.trim();
    const get = () => { const env = v('bE'); const e = envs.find(x => x.name === env); return { title: v('bT') || 'Bug sem título', sev: v('bS'), prio: v('bP'), env: e ? `${e.name} (${e.url})` : env, device: v('bD'), ticket: v('bK'), scenario: v('bC'), pre: v('bPre'), steps: v('bSt'), expected: v('bEx'), actual: v('bAc'), evidence: v('bEv'), by: P.settings.qaName || '' }; };
    el.querySelector('#bCopyT').onclick = () => copy(bugText(get(), false), 'Bug copiado (texto)');
    el.querySelector('#bCopyM').onclick = () => copy(bugText(get(), true), 'Bug copiado (Markdown)');
    el.querySelector('#bSave').onclick = async () => {
      const b = get(); const dir = (P.settings.bugsDir || 'qa').replace(/^\/+|\/+$/g, '') + '/bugs';
      const name = `${stamp().slice(0, 10)} -${(b.ticket ? b.ticket + ' - ' : '') + b.title}`.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
      try { await writeText(`${dir}/${name}.md`, bugText(b, true)); el.hidden = true; toast('Bug salvo em ' + dir, 'ok'); bs.openFile(`${dir}/${name}.md`, 'editor'); } catch (e) { toast(e.message); }
    };
    el.querySelector('#bT').focus();
  });
}
// bug de um cenário (Falhou): passos, esperado e chamado já preenchidos
function bugFromScenario(rel, sc) {
  const d = docFor(rel); if (!d) return bugDialog();
  const all = [...(d.background ? d.background.steps : []), ...sc.steps];
  const st = statusOf(rel, sc);
  bugDialog({
    title: `${scKey(sc)} falhou: ${sc.name.replace(/^\s*[A-Za-z]{1,6}\s*-?\s*\d+\s*[-–:]?\s*/, '')}`,
    ticket: ticketsOf(rel)[0] || '', scenario: sc.name, sev: 'Média',
    pre: all.filter(s => s.type === 'given').map(s => `${s.kw} ${s.text}`).join('\n'),
    steps: all.filter(s => s.type === 'when').map(s => `${s.kw} ${s.text}`).join('\n'),
    expected: all.filter(s => s.type === 'then').map(s => `${s.kw} ${s.text}`).join('\n'),
    actual: st && st.note || '',
    evidence: evidences(rel, sc).map(p => p).join('\n'),
  });
}

// ---------- tela grande (aba fixa do painel): quadro de execução e cobertura ----------
// Os cenários do filtro (busca, chamado, tag, pasta) em colunas por status: arrastar o cartão para outra coluna grava o
// status pelo setStatus, o mesmo do painel e do CodeLens. "Cobertura" agrupa por chamado, tag ou pasta, com as piores primeiro.
const COLS = [['none', 'Não executado'], ['pass', 'Passou'], ['fail', 'Falhou'], ['blocked', 'Bloqueado']];
const GROUPS = { ticket: ['Chamado', 'Sem chamado'], tag: ['Tag', 'Sem tag'], dir: ['Pasta', 'Raiz do projeto'] };
const PAGE = 60; // cartões desenhados por coluna de cada vez (projeto com centenas de cenários)
// '-' num filtro: os cenários sem chamado, sem tag ou na raiz do projeto
const B = { el: null, q: '', ticket: '', tag: '', dir: '', view: store.get('qaPgView', 'board'), by: store.get('qaPgBy', 'ticket'), more: {}, drag: null, tm: null };
if (!GROUPS[B.by]) B.by = 'ticket';
const scTags = (d, sc) => [...new Set([...(d.feature ? d.feature.tags : []), ...sc.tags])];
// "CT001 - Login válido" -> ['CT001', 'Login válido']
const scParts = (sc) => { const m = /^\s*[A-Za-z]{1,6}\s*[-_]?\s*\d{1,5}\b\s*[-–:]?\s*/.exec(sc.name); return m ? [scKey(sc), sc.name.slice(m[0].length) || sc.name] : ['', sc.name || sc.kw]; };
const inDir = (rel, dir) => !dir || (dir === '-' ? !dirOf(rel) : rel.startsWith(dir + '/'));
const hasOr = (list, v) => !v || (v === '-' ? !list.length : list.includes(v));
const pgFiltered = () => !!(B.q || B.ticket || B.tag || B.dir);
// os cenários do filtro, na ordem das features
function pgItems() {
  const out = [];
  for (const rel of featuresIn('')) {
    const f = P.files.get(rel); const d = f.doc; const tks = ticketsOf(rel);
    if (!hasOr(tks, B.ticket) || !inDir(rel, B.dir)) continue;
    for (const sc of visibleScs(rel, f, B.q, null)) {
      const tags = scTags(d, sc); if (!hasOr(tags, B.tag)) continue;
      const st = statusOf(rel, sc);
      out.push({ rel, sc, tks, tags, st, k: st ? st.s : 'none' });
    }
  }
  return out;
}
// o que os filtros oferecem: tudo o que existe no projeto (não só o que está filtrado)
function pgOptions() {
  const tks = new Set(), tags = new Set(), dirs = new Set(); let noTk = false, noTag = false, root = false, n = 0;
  for (const [rel, f] of P.files) {
    const t = ticketsOf(rel); t.forEach(x => tks.add(x)); if (!t.length) noTk = true;
    let d = dirOf(rel); if (!d) root = true; while (d) { dirs.add(d); d = dirOf(d); }
    for (const sc of f.doc.scenarios) { n++; const g = scTags(f.doc, sc); g.forEach(x => tags.add(x)); if (!g.length) noTag = true; }
  }
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  return { n, ticket: [sort(tks), noTk && tks.size], tag: [sort(tags), noTag && tags.size], dir: [sort(dirs), root && dirs.size] };
}
function pgCard(x) {
  const [id, name] = scParts(x.sc); const ev = evidences(x.rel, x.sc).length; const st = x.st;
  const tags = x.tags.slice(0, 3).map(t => `<span class="qa-tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('') + (x.tags.length > 3 ? `<span class="qa-kc-x" title="${esc(x.tags.slice(3).join(' '))}">+${x.tags.length - 3}</span>` : '');
  return `<article class="qa-kc s-${x.k}" draggable="true" tabindex="0" data-rel="${esc(x.rel)}" data-line="${x.sc.line}" title="${esc(x.rel)}">
    <div class="qa-kc-h">${id ? `<code>${esc(id)}</code>` : ''}${x.tks.map(t => `<span class="qa-tk" data-tk="${esc(t)}" title="${ticketLink(t) ? 'Abrir o chamado' : 'Copiar'}">${esc(t)}</span>`).join('')}<span class="spacer"></span>${ev ? `<span class="qa-ev" title="Evidências">${ICO.cam}${ev}</span>` : ''}</div>
    <div class="qa-kc-n">${esc(name)}</div>
    <div class="qa-kc-f">${esc(titleOf(x.rel))}</div>
    ${st && st.note ? `<div class="qa-kc-o">${esc(st.note)}</div>` : ''}
    ${tags || st ? `<div class="qa-kc-t">${tags}<span class="spacer"></span>${st ? `<time title="${esc(st.by || '')}">${esc(fmtDate(st.at))}</time>` : ''}</div>` : ''}
  </article>`;
}
function pgBoard(items) {
  return `<div class="qa-board">${COLS.map(([k, label]) => {
    const list = items.filter(x => x.k === k); const lim = B.more[k] || PAGE; const rest = list.length - lim;
    return `<section class="qa-col s-${k}" data-col="${k}"><header><i class="qa-dot">${k === 'none' ? '' : STATUS[k].sym}</i><b>${label}</b><em>${list.length}</em></header>
      <div class="qa-cards">${list.slice(0, lim).map(pgCard).join('')}${rest > 0 ? `<button class="chip qa-more" data-more="${k}">Mais ${Math.min(PAGE * 2, rest)} de ${rest}</button>` : ''}</div></section>`;
  }).join('')}</div>`;
}
// cobertura: uma linha por chamado, tag ou pasta; as piores primeiro (mais falhas, mais bloqueios, menos executado)
function pgCoverage(items) {
  const keys = B.by === 'tag' ? (x) => x.tags.length ? x.tags : ['-'] : B.by === 'dir' ? (x) => [dirOf(x.rel) || '-'] : (x) => x.tks.length ? x.tks : ['-'];
  const g = new Map();
  for (const x of items) for (const k of keys(x)) { let c = g.get(k); if (!c) g.set(k, c = { pass: 0, fail: 0, blocked: 0, none: 0, n: 0 }); c[x.k]++; c.n++; }
  const rows = [...g.entries()].sort(([ka, a], [kb, b]) => b.fail - a.fail || b.blocked - a.blocked || b.none / b.n - a.none / a.n || b.n - a.n || ka.localeCompare(kb, 'pt-BR', { numeric: true }));
  const lim = B.more.cov || 200; const [, none] = GROUPS[B.by];
  const seg = `<div class="qa-cov-h"><span class="seg">${Object.entries(GROUPS).map(([k, [l]]) => `<button class="${B.by === k ? 'on' : ''}" data-by="${k}">${l}</button>`).join('')}</span></div>`;
  return seg + `<div class="qa-cov">${rows.slice(0, lim).map(([k, c]) => {
    const done = c.n - c.none;
    return `<button class="qa-cv" data-k="${esc(k)}" title="${done} de ${c.n} executado${done === 1 ? '' : 's'} · ver no quadro">
      <span class="qa-cv-n ${k === '-' ? 'nil' : ''}">${esc(k === '-' ? none : k)}</span>${bar(c, c.n)}
      <span class="qa-cv-c">${SFILTER.map(([s, , sym]) => `<i class="p-${s} ${c[s] ? '' : 'zero'}"><b>${sym} ${c[s]}</b></i>`).join('')}</span>
    </button>`;
  }).join('')}${rows.length > lim ? `<button class="chip qa-more" data-more="cov">Mais ${rows.length - lim}</button>` : ''}</div>`;
}
function pgKpis(items) {
  const t = { pass: 0, fail: 0, blocked: 0, none: 0 }; for (const x of items) t[x.k]++;
  const n = items.length; const pct = n ? Math.round((n - t.none) * 100 / n) : 0;
  return `<div class="qa-kpi"><b>${n}</b><span>Cenários</span></div><div class="qa-kpi"><b>${pct || n === t.none ? pct : '&lt;1'}<small>%</small></b><span>Executado</span>${bar(t, n)}</div>`
    + COLS.slice(1).concat([COLS[0]]).map(([k, l]) => `<div class="qa-kpi p-${k} ${t[k] ? '' : 'zero'}"><b>${t[k]}</b><span>${l}</span></div>`).join('');
}
// lista de um filtro: só troca as opções quando elas mudam (não fecha a lista aberta num redesenho)
function pgSelect(sel, key, [list, none]) {
  if (B[key] && B[key] !== '-' && !list.includes(B[key])) B[key] = '';
  if (B[key] === '-' && !none) B[key] = '';
  const [label, nil] = GROUPS[key]; const sig = list.join('\n') + '|' + !!none;
  if (sel.dataset.sig !== sig) { sel.dataset.sig = sig; sel.innerHTML = `<option value="">${label}</option>${list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}${none ? `<option value="-">${nil}</option>` : ''}`; }
  sel.value = B[key]; sel.classList.toggle('on', !!B[key]); sel.hidden = list.length + (none ? 1 : 0) < 2; // uma opção só não filtra nada
}
function pgDraw() {
  clearTimeout(B.tm); B.tm = null;
  const el = B.el; if (!el || !el.isConnected) return;
  const main = el.querySelector('.qa-pg-main');
  const off = (html) => { el.classList.add('off'); main.innerHTML = html; const b = main.querySelector('[data-new]'); if (b) b.onclick = () => newFeature(); };
  if (!S.project) return off('<div class="qa-empty">' + ICO.qa + '<b>Nenhum projeto aberto</b><span>O quadro mostra os cenários das features do projeto.</span></div>');
  if (P.for !== proj() || (!P.at && !P.loading)) { off('<div class="empty">Lendo as features…</div>'); if (!P.loading) index(); return; }
  if (!P.files.size) return off(`<div class="qa-empty">${ICO.qa}<b>Quadro vazio</b><span>Os cenários das features do projeto aparecem aqui, por status.</span><button class="chip primary" data-new>${ICO.plus} Nova feature</button></div>`);
  const opt = pgOptions();
  if (!opt.n) return off(`<div class="qa-empty">${ICO.feat}<b>Nenhum cenário ainda</b><span>${P.files.size === 1 ? 'A feature do projeto ainda não tem' : `As ${P.files.size} features do projeto ainda não têm`} cenários.</span></div>`);
  el.classList.remove('off');
  for (const k of ['ticket', 'tag', 'dir']) pgSelect(el.querySelector(`[data-f="${k}"]`), k, opt[k]);
  const qi = el.querySelector('.qa-q'); if (qi.value.trim() !== B.q) qi.value = B.q;
  el.querySelector('.qa-clr').hidden = !B.q; el.querySelector('[data-clear]').hidden = !pgFiltered();
  el.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === B.view));
  const items = pgItems();
  el.querySelector('.qa-kpis').innerHTML = pgKpis(items);
  // a rolagem de cada coluna fica onde estava
  const keep = new Map([...main.querySelectorAll('[data-col] .qa-cards')].map(c => [c.parentNode.dataset.col, c.scrollTop]));
  main.classList.toggle('cov', B.view === 'cov');
  main.innerHTML = !items.length ? `<div class="qa-empty">${ICO.feat}<b>Nada com esse filtro</b><button class="chip" data-clear>Limpar filtro</button></div>` : B.view === 'cov' ? pgCoverage(items) : pgBoard(items);
  for (const [k, top] of keep) { const c = main.querySelector(`[data-col="${k}"] .qa-cards`); if (c) c.scrollTop = top; }
}
// vários avisos seguidos (índice, status, evidência) viram um desenho só; com a aba atrás, desenha quando ela voltar (show)
function pgSoon() { if (B.el && !B.tm && bs.pages.isActive('qa')) B.tm = setTimeout(pgDraw, 0); }
function redraw() { if (S.tool === 'qa') bs.renderTool(); pgSoon(); }
const pgClear = () => { B.q = B.ticket = B.tag = B.dir = ''; B.more = {}; pgDraw(); };
function pgScenario(card) { const d = card && docFor(card.dataset.rel); const sc = d && d.scenarios.find(s => s.line === +card.dataset.line); return sc ? [card.dataset.rel, sc] : null; }
function pgMount(el) {
  B.el = el; el.className += ' qa-pg';
  el.innerHTML = `<div class="qa-pgw">
    <div class="qa-pg-bar">
      <span class="seg"><button data-view="board">Quadro</button><button data-view="cov">Cobertura</button></span>
      <div class="qa-pg-flt"><label class="qa-search"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="qa-q" placeholder="Buscar cenário, passo ou @tag" spellcheck="false"><button class="qa-clr" title="Limpar" hidden>${bs.I.x}</button></label>
      <select data-f="ticket"></select><select data-f="tag"></select><select data-f="dir"></select>
      <button class="chip" data-clear hidden>${bs.I.x} Limpar</button></div>
      <div class="qa-pg-out"><button class="chip" data-out="report" title="Relatório de evidências (HTML) do que está filtrado">${ICO.doc}<span>Relatório</span></button><button class="chip" data-out="csv" title="Casos de teste (CSV) do que está filtrado">${ICO.csv}<span>CSV</span></button></div>
    </div>
    <div class="qa-kpis"></div>
    <div class="qa-pg-main"></div>
  </div>`;
  const qi = el.querySelector('.qa-q'); let tm = null;
  qi.oninput = () => { B.q = qi.value.trim(); B.more = {}; clearTimeout(tm); tm = setTimeout(pgDraw, 150); };
  qi.onkeydown = (e) => { if (e.key === 'Escape' && B.q) { e.stopPropagation(); B.q = ''; pgDraw(); } };
  el.querySelector('.qa-clr').onclick = () => { B.q = ''; pgDraw(); qi.focus(); };
  el.querySelectorAll('[data-f]').forEach(s => s.onchange = () => { B[s.dataset.f] = s.value; B.more = {}; pgDraw(); });
  el.addEventListener('click', (e) => {
    const on = (sel) => e.target.closest(sel); let b;
    if (b = on('[data-view]')) { B.view = b.dataset.view; store.set('qaPgView', B.view); B.more = {}; return pgDraw(); }
    if (b = on('[data-by]')) { B.by = b.dataset.by; store.set('qaPgBy', B.by); B.more = {}; return pgDraw(); }
    if (on('[data-clear]')) return pgClear();
    if (b = on('[data-more]')) { const k = b.dataset.more; B.more[k] = (B.more[k] || (k === 'cov' ? 200 : PAGE)) + (k === 'cov' ? 200 : PAGE * 2); return pgDraw(); }
    if (b = on('[data-out]')) {
      const items = pgItems(); if (!items.length) return toast('Nenhum cenário');
      const keys = new Set(items.map(x => stKey(x.rel, x.sc)));
      return runScope(b.dataset.out, [...new Set(items.map(x => x.rel))], pgFiltered() ? (rel, sc) => keys.has(stKey(rel, sc)) : undefined).catch(err => toast(err.message));
    }
    // linha da cobertura: vira o filtro do quadro
    if (b = on('.qa-cv')) { B[B.by] = b.dataset.k; B.view = 'board'; store.set('qaPgView', B.view); B.more = {}; return pgDraw(); }
    if (b = on('.qa-kc [data-tk]')) return ticketGo(b.dataset.tk);
    if (b = on('.qa-kc [data-tag]')) { B.tag = b.dataset.tag; B.more = {}; return pgDraw(); }
    if (b = on('.qa-kc')) bs.openFile(b.dataset.rel, 'editor', +b.dataset.line + 1);
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('qa-kc')) bs.openFile(e.target.dataset.rel, 'editor', +e.target.dataset.line + 1); });
  el.addEventListener('contextmenu', (e) => {
    const x = pgScenario(e.target.closest('.qa-kc')); if (!x) return;
    const [rel, sc] = x;
    statusMenu(e, rel, sc, ['-',
      { label: 'Evidências…', icon: ICO.cam, action: () => evidenceDialog(rel, sc) },
      { label: 'Copiar cenário (texto)', icon: bs.I.copy, action: () => copyScenario(rel, sc) },
      ...ticketsOf(rel).map(t => ({ label: (ticketLink(t) ? 'Abrir ' : 'Copiar ') + t, icon: ICO.link, action: () => ticketGo(t) })),
      ...(automation() && P.runner ? [{ label: 'Executar cenário', icon: ICO.play, action: () => runner(`${rel}:${sc.line + 1}`, null, sc.name) }] : []),
    ]);
  });
  // arrastar o cartão para outra coluna = mudar o status
  const over = (col) => el.querySelectorAll('.qa-col.over').forEach(c => c !== col && c.classList.remove('over'));
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('.qa-kc'); if (!card) return;
    B.drag = { rel: card.dataset.rel, line: +card.dataset.line, from: card.closest('.qa-col').dataset.col };
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.querySelector('.qa-kc-n').textContent);
    card.classList.add('drag'); el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => { B.drag = null; over(null); el.classList.remove('dragging'); el.querySelectorAll('.qa-kc.drag').forEach(c => c.classList.remove('drag')); });
  el.addEventListener('dragover', (e) => {
    if (!B.drag) return; const col = e.target.closest('.qa-col'); over(col);
    if (!col || col.dataset.col === B.drag.from) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('over');
  });
  el.addEventListener('drop', (e) => {
    const g = B.drag, col = e.target.closest('.qa-col'); if (!g || !col || col.dataset.col === g.from) return;
    e.preventDefault(); e.stopPropagation();
    const d = docFor(g.rel); const sc = d && d.scenarios.find(s => s.line === g.line); if (!sc) return toast('O cenário mudou de lugar: salve a feature e tente de novo');
    setStatus(g.rel, sc, col.dataset.col === 'none' ? null : col.dataset.col);
  });
  pgDraw();
}

// ---------- registro ----------
// o painel primeiro (com page), depois a tela: aba fixa, na primeira posição, enquanto o painel QA é o escolhido
bs.tools.register({ id: 'qa', title: 'QAutils', icon: ICO.qa, key: 'Alt+9', order: 75, page: 'qa', render });
bs.pages.register({ id: 'qa', title: 'QAutils', icon: ICO.qa, pinned: true, render: pgMount, show: pgDraw });
plugin.onUnload(() => clearTimeout(B.tm));
bs.actions.add([
  { label: 'QA: Nova feature (chamado)', icon: ICO.feat, run: () => newFeature() },
  { label: 'QA: Painel de features e execução', icon: ICO.qa, run: () => bs.openTool('qa') },
  { label: 'QA: Relatório de evidências do projeto', icon: ICO.doc, run: () => makeReport('', true) },
  { label: 'QA: Exportar casos de teste do projeto (CSV)', icon: ICO.csv, run: () => exportCsv('', true) },
  { label: 'QA: Formatar feature e alinhar tabelas', icon: ICO.feat, k: 'Shift+Alt+F', run: () => bs.editor && bs.editor.trigger('qa', 'editor.action.formatDocument') },
]);
// árvore: pasta -> nova feature, relatório, CSV; arquivo .feature -> relatório, CSV, copiar
bs.hooks.filter('menu:file', (items, ctx) => {
  if (!ctx || !ctx.rel) return items;
  if (ctx.isDir) return [...items, '-', { label: 'Nova feature aqui…', icon: ICO.feat, action: () => newFeature(ctx.rel) }, { label: 'Relatório de evidências da pasta', icon: ICO.doc, action: () => makeReport(ctx.rel, true) }, { label: 'Exportar casos de teste (CSV)', icon: ICO.csv, action: () => exportCsv(ctx.rel, true) }];
  if (/\.feature$/i.test(ctx.rel)) return [...items, '-', { label: 'Relatório de evidências', icon: ICO.doc, action: () => makeReport(ctx.rel, false) }, { label: 'Exportar casos de teste (CSV)', icon: ICO.csv, action: () => exportCsv(ctx.rel, false) }];
  return items;
});
// resumo do projeto: andamento dos cenários
bs.dashboard.card({
  id: 'qa', order: 45,
  html() {
    if (!S.project || P.for !== proj() || !P.files.size) return '';
    const t = { pass: 0, fail: 0, blocked: 0, none: 0 }; let n = 0;
    for (const [rel, f] of P.files) { const c = counts(rel, f.doc); for (const k in c) t[k] += c[k]; n += f.doc.scenarios.length; }
    return `<div class="qa-card"><h4>${ICO.qa} QAutils</h4><p>${P.files.size} features · ${n} cenários</p>${bar(t, n)}<p class="qa-mut">✓ ${t.pass} · ✗ ${t.fail} · ⊘ ${t.blocked} · ○ ${t.none}</p><button class="chip" data-qa-open>Abrir painel QA</button></div>`;
  },
  bind(el) { const b = el.querySelector('[data-qa-open]'); if (b) b.onclick = () => bs.openTool('qa'); },
});
// para outros plugins: ler features, reindexar e consultar o estado (features, passos, definições, status)
bs.qautils = { parse, index: () => index(true), state: () => P, defsFor, automation, bug: bugDialog };
function refreshAll() { S.tabs.forEach(t => isFeature(t) && diagnose(t.model)); fireLens(); redraw(); }
bs.hooks.on('editor:ready', setup); if (bs.monaco) setup();
bs.hooks.on('tab:open', (t) => { if (ready) watch(t); });
bs.hooks.on('tab:activate', (t) => { if (ready) watch(t); if (lensLate && isFeature(t)) { lensLate = false; setTimeout(() => { try { bs.editor.render(true); } catch {} lensEmitter.fire(); }, 60); } });
bs.hooks.on('project:select', () => { P.at = 0; P.for = null; if (S.project) setTimeout(() => index(), 800); });
bs.hooks.on('tab:save', (t) => {
  if (!t || !S.project) return;
  if (/\.feature$/i.test(t.path)) { P.files.set(t.path, { mtime: -1, doc: parse(t.model.getValue()) }); catalog(); P.at = Date.now(); redraw(); fireLens(); }
  else if (DEF_EXT.test(t.path)) setTimeout(() => index(true), 300);
});
// arquivos mudados por fora (git pull, outro editor): features e step definitions entram no índice
let ext = null;
bs.hooks.on('files:changed', (list) => {
  const rels = (Array.isArray(list) ? list : []).map(x => String(x && (x.path || x.rel || x) || '').replace(/\\/g, '/'));
  if (rels.length && !rels.some(r => /\.feature$/i.test(r) || DEF_EXT.test(r))) return;
  clearTimeout(ext); ext = setTimeout(() => index(true), 800);
});
bs.hooks.on('file:rename', () => setTimeout(() => index(true), 300));
bs.hooks.on('file:delete', () => setTimeout(() => index(true), 300));
if (S.project) setTimeout(() => index(), 1200);
