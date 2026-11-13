'use strict';
// ===== Alterações em tela grande: a aba fixa do painel Alterações =====
// O painel da esquerda (vcs.js) cuida de um commit por vez; esta tela mostra o período inteiro, de todos os
// repositórios da pasta aberta (ela mesma, se for um, e os que estiverem dentro dela, Git ou SVN):
// - linha do tempo: uma faixa por repositório (ou por pessoa, num repositório só), um ponto por commit, do tamanho da
//   mudança; as tags (versões) aparecem como losangos;
// - lista dos commits por dia, com busca por mensagem, autor, arquivo ou hash; o commit abre os arquivos ali mesmo e o
//   clique no arquivo abre o diff (no projeto aberto, o painel acompanha; nos outros repositórios, aba só de leitura);
// - ao lado: os repositórios (clique filtra, botão direito tem as ações), os arquivos mais mexidos e quem mexeu.
// Investigar incidente: você diz quando o problema começou e, se quiser, cola o erro ou o stack trace. A tela tira
// dali os nomes (classes, arquivos, métodos, tabelas), procura esses nomes nas linhas que os commits do período
// somaram ou removeram (rota scan) e ordena os commits por suspeita, dizendo o porquê de cada um em português:
// quão perto do início entrou, o tamanho, se mexe em configuração, banco ou implantação, se a mensagem tem cara de
// correção às pressas e se toca no que o erro cita. Dá para descartar um suspeito e copiar o relatório para o chamado.
(function cxInit() {
if (BS.doc) return;
const { dayLabel, avatar, statBar, chgRow } = BS.vcs;
const DAY = 86400000, HOUR = 3600000;
const WINS = [[1, '24 h'], [3, '3 dias'], [7, '7 dias'], [30, '30 dias']];
const CX = { el: null, win: store.get('cxWin', 7), q: '', repos: [], commits: [], loading: false, for: null, at: 0, seq: 0, open: new Set(), repo: null, inc: null, more: 150, afterOpen: false };
const IC = {
  fire: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-1.6.6-2.8 1.5-3.8.3 1.5 1.2 2.3 2 2.5C10 9 10.500 5.500 12 3z"/></svg>',
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  chev: (open) => `<svg class="i cx-chev" viewBox="0 0 24 24"><path d="${open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'}"/></svg>`,
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const keyOf = (c) => c.repo.path + '|' + c.id;
const same = (a, b) => String(a).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === String(b).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const absTime = (ts) => new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const linesOf = (c) => c.files.reduce((a, f) => a + (f.add || 0) + (f.del || 0), 0);
const totOf = (c) => c.files.reduce((a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }), { add: 0, del: 0 });
const span = (ms) => { const h = ms / HOUR; return h < 1 ? Math.max(1, Math.round(ms / 60000)) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' dias'; };
// o período: sem incidente, os últimos N dias; com incidente, N dias antes do início até agora
const untilMs = () => Date.now();
const sinceMs = () => (CX.inc ? Math.min(CX.inc.at, Date.now()) : Date.now()) - CX.win * DAY;
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

// ----- dados -----
async function load(force) {
  if (!CX.el) return;
  if (!S.project) { CX.repos = []; CX.commits = []; CX.for = null; return paint(); }
  const p = S.project.path;
  if (!force && CX.for === p && Date.now() - CX.at < 90000) return paint();
  const seq = ++CX.seq;
  CX.loading = true; if (CX.for !== p) { CX.repos = []; CX.commits = []; CX.repo = null; CX.open.clear(); incRestore(p); } paint();
  const repos = await BS.vcs.repos(force);
  const since = Math.floor(sinceMs() / 1000);
  const lists = await pool(repos, 6, (r) => api('timeline', { project: r.path, since, n: 500 }, { quiet: true }).then(l => l.map(c => Object.assign(c, { repo: r }))).catch(() => []));
  if (seq !== CX.seq) return;
  CX.repos = repos; CX.commits = lists.flat().sort((a, b) => (b.ts || 0) - (a.ts || 0)); CX.for = p; CX.at = Date.now(); CX.loading = false; CX.more = 150;
  if (CX.inc && CX.inc.terms.length) await scan(seq);
  if (seq === CX.seq) paint();
}
async function scan(seq) {
  const inc = CX.inc; inc.hits = new Map(); if (!inc.terms.length) return;
  inc.busy = true; paint();
  const since = Math.floor(sinceMs() / 1000), terms = inc.terms.map(t => t.toLowerCase());
  await pool(CX.repos.filter(r => CX.commits.some(c => c.repo === r)), 4, async (r) => {
    try {
      const hits = await api('scan', { project: r.path, since }, { method: 'POST', body: JSON.stringify({ terms }), quiet: true });
      for (const h of hits) { const k = r.path + '|' + h.commit; if (!inc.hits.has(k)) inc.hits.set(k, []); inc.hits.get(k).push(h); }
    } catch { /* um repositório que não respondeu não derruba os outros */ }
  });
  if (CX.inc === inc) inc.busy = false;
  if (seq !== undefined && seq !== CX.seq) return;
}

// ----- incidente: termos do erro e suspeita -----
const LIB = /\b(java|javax|jakarta|sun|jdk|kotlin|scala)\.|org\.(springframework|apache|hibernate|junit|eclipse|jboss)|com\.(fasterxml|google|zaxxer|mysql|oracle|microsoft)|io\.(netty|micrometer|reactivex)|node:internal|node_modules|site-packages|\/lib\/python|System\.|Microsoft\./;
const GENERIC = /^(NullPointer|IllegalArgument|IllegalState|Runtime|IO|ClassCast|IndexOutOfBounds|ArrayIndexOutOfBounds|StringIndexOutOfBounds|NumberFormat|Timeout|SQL|Type|Value|Key|Attribute|Reference|Syntax|Range|Assertion|UnsupportedOperation|Interrupted|Execution|NoSuchElement|ConcurrentModification|StackOverflow|OutOfMemory)(Exception|Error)$/;
const STOP = new Set(['error', 'exception', 'caused', 'null', 'undefined', 'true', 'false', 'unknown', 'source', 'native', 'method', 'thread', 'main', 'java', 'line', 'file', 'module', 'object', 'string', 'traceback', 'internal', 'anonymous', 'promise', 'async', 'function', 'class', 'http', 'https', 'localhost', 'warn', 'info', 'debug', 'trace', 'stacktrace', 'invoke', 'process', 'execute', 'handle', 'apply', 'accept', 'doFilter', 'service', 'call']);
function extractTerms(text) {
  const out = new Map();
  const add = (t) => { t = String(t || '').trim().replace(/^[.$]+|[.$]+$/g, ''); const k = t.toLowerCase(); if (t.length < 3 || t.length > 60 || STOP.has(k) || GENERIC.test(t) || /^\d+$/.test(t) || out.has(k)) return; out.set(k, t); };
  text = String(text || '');
  // poucas palavras numa linha só: são os termos, separados por vírgula ou espaço
  if (text.length < 160 && !/\n/.test(text.trim()) && !/\bat\s|\(|Exception\b|Error\b|:\d+/.test(text)) { text.split(/[,;\s]+/).forEach(add); return [...out.values()].slice(0, 12); }
  for (const ln of text.split('\n')) {
    if (LIB.test(ln)) continue; // quadros de biblioteca não dizem onde o seu código mudou
    let m;
    if ((m = /\bat\s+(?:[\w$]+\.)*([A-Z][\w$]*)\.([\w$<>]+)\s*\(/.exec(ln))) { add(m[1].replace(/\$.*$/, '')); if (!/^<|^lambda\$/.test(m[2])) add(m[2]); }       // Java, C#
    if ((m = /File "([^"]+)", line \d+(?:, in ([\w<>]+))?/.exec(ln))) { add(m[1].split(/[\\/]/).pop().replace(/\.py$/, '')); if (m[2] && !m[2].startsWith('<')) add(m[2]); } // Python
    if ((m = /\bat\s+(?:async\s+)?([\w$.]+)\s+\((?!native)/.exec(ln)) && !/^[a-z]+(\.[a-z]+)+\./.test(m[1])) add(m[1].split('.').pop());                             // JavaScript
    for (const f of ln.matchAll(/([\w$-]{3,})\.(java|kt|kts|scala|groovy|py|js|jsx|mjs|cjs|ts|tsx|cs|go|rb|php|rs|sql|xml|ya?ml|properties|json|c|cc|cpp|h|hpp|vue|svelte|html|jsp|feature)\b/g)) add(f[1]);
    for (const f of ln.matchAll(/\b(?:from|into|update|table|join)\s+([A-Za-z_][\w.]{2,})/gi)) add(f[1].split('.').pop());
    for (const f of ln.matchAll(/["'`]([A-Za-z_][\w.-]{3,40})["'`]/g)) add(f[1]);
    for (const f of ln.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]+)\b/g)) add(f[1]);
  }
  return [...out.values()].slice(0, 12);
}
const RISK = [
  [/(^|\/)(application|bootstrap|settings|config|appsettings|web|logback|log4j2?)[^/]*\.(ya?ml|properties|json|toml|ini|conf|xml)$|(^|\/)\.env(\.|$)|(^|\/)(pom\.xml|build\.gradle(\.kts)?|package(-lock)?\.json|requirements\.txt|Cargo\.toml|go\.mod)$/i, 'configuração ou dependências', 8],
  [/\.sql$|(^|\/)(migrations?|flyway|liquibase)\//i, 'banco de dados', 9],
  [/(^|\/)(Dockerfile|docker-compose[^/]*|Jenkinsfile|\.gitlab-ci\.yml|Procfile)$|(^|\/)\.github\/workflows\/|(^|\/)(k8s|helm|deploy|infra|terraform)\//i, 'implantação', 7],
];
const RUSH = /\b(hotfix|urgente?|revert|rollback|workaround|gambiarra|tempor[aá]ri[oa]|quick ?fix|paliativ[oa]|emerg[eê]ncia)\b/i;
// 0 a 100, com os motivos. Depois do início não é suspeito (after)
function suspect(c) {
  const inc = CX.inc, ts = (c.ts || 0) * 1000;
  if (ts > inc.at) return { after: true, n: 0, why: [], hits: [] };
  const why = []; let n = 0;
  const gap = inc.at - ts, h = gap / HOUR;
  n += 38 * Math.exp(-h / 10);
  if (h <= 24) why.push(['time', `${span(gap)} antes do início`]);
  const lines = linesOf(c);
  n += Math.min(12, Math.log2(1 + lines) * 1.5);
  if (lines >= 200 || c.files.length >= 12) why.push(['size', `mudança grande: ${plural(c.files.length, 'arquivo', 'arquivos')}, ${num(lines)} linhas`]);
  const kinds = new Set();
  for (const f of c.files) for (const [re, label, w] of RISK) if (!kinds.has(label) && re.test(f.path)) { kinds.add(label); n += w; }
  for (const k of kinds) why.push(['risk', 'mexe em ' + k]);
  if (RUSH.test(c.subject)) { n += 6; why.push(['msg', 'mensagem de correção às pressas']); }
  const hits = inc.hits.get(keyOf(c)) || [], shown = (t) => inc.terms.find(x => x.toLowerCase() === t) || t;
  const inLines = [...new Set(hits.map(x => x.term))];
  const inPath = inc.terms.filter(t => !inLines.includes(t.toLowerCase()) && c.files.some(f => f.path.split('/').pop().toLowerCase().replace(/\.[a-z0-9]+$/, '').includes(t.toLowerCase())));
  if (inLines.length) { n += Math.min(60, inLines.length * 32); why.push(['hit', `mudou linhas com ${inLines.map(t => '«' + shown(t) + '»').join(', ')}`]); }
  if (inPath.length) { n += Math.min(40, inPath.length * 22); why.push(['hit', `mexe em ${inPath.map(t => '«' + t + '»').join(', ')}, citado no erro`]); }
  if (c.merge && !c.files.length) n *= .2;
  return { after: false, n: Math.max(1, Math.round(Math.min(100, n))), why, hits };
}
const incKey = (p) => 'cxInc:' + p;
function incRestore(p) { const s = store.get(incKey(p), null); CX.inc = s && s.at ? { at: s.at, text: s.text || '', terms: s.terms || [], off: new Set(s.off || []), hits: new Map(), busy: false } : null; syncInc(); }
function incSave() { if (!S.project) return; const i = CX.inc; store.set(incKey(S.project.path), i ? { at: i.at, text: i.text, terms: i.terms, off: [...i.off] } : null); }
const localInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
function syncInc() {
  const el = CX.el; if (!el) return;
  el.classList.toggle('inc-on', !!CX.incOpen || !!CX.inc);
  el.querySelector('.cx-inc-btn').classList.toggle('on', !!CX.inc);
  const w = el.querySelector('.cx-when'), t = el.querySelector('.cx-text');
  if (CX.inc) { w.value = localInput(CX.inc.at); if (document.activeElement !== t) t.value = CX.inc.text; }
  else if (!w.value) w.value = localInput(Date.now());
}
async function investigate() {
  const el = CX.el, w = el.querySelector('.cx-when').value, at = w ? new Date(w).getTime() : Date.now();
  if (!isFinite(at)) return toast('Diga quando o problema começou');
  const text = el.querySelector('.cx-text').value;
  const prev = CX.inc;
  CX.inc = { at: Math.min(at, Date.now()), text, terms: prev && prev.text === text ? prev.terms : extractTerms(text), off: prev ? prev.off : new Set(), hits: new Map(), busy: false };
  CX.incOpen = true; CX.open.clear(); incSave(); syncInc();
  await load(true);
}
function endIncident() { CX.inc = null; CX.incOpen = false; incSave(); const el = CX.el; el.querySelector('.cx-text').value = ''; el.querySelector('.cx-when').value = localInput(Date.now()); syncInc(); load(true); }
function report() {
  const inc = CX.inc; if (!inc) return;
  const all = filtered().map(c => ({ c, s: suspect(c) })).filter(x => !x.s.after && !inc.off.has(keyOf(x.c))).sort((a, b) => b.s.n - a.s.n);
  const top = all.filter((x, i) => i < 3 || x.s.n >= 25).slice(0, 8);
  const multi = CX.repos.length > 1;
  const md = [`## Incidente: início em ${new Date(inc.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`, '',
    `Analisados ${plural(all.length, 'commit', 'commits')} dos ${CX.win === 1 ? 'últimas 24 h' : CX.win + ' dias'} antes do início${multi ? `, em ${CX.repos.length} repositórios` : ''}.`,
    ...(inc.terms.length ? [`Procurado nas linhas que mudaram: ${inc.terms.map(t => '`' + t + '`').join(', ')}.`] : []), '', '### Suspeitos', '',
    ...(top.length ? top.flatMap(({ c, s }, i) => [
      `${i + 1}. ${multi ? `**${c.repo.name}** ` : ''}\`${c.hash}\` ${c.subject} (${c.author}, ${absTime(c.ts)}, ${span(inc.at - c.ts * 1000)} antes) · suspeita ${s.n}/100`,
      ...(s.why.length ? [`   - Por quê: ${s.why.map(w => w[1]).join('; ')}`] : []),
      ...(c.files.length ? [`   - Arquivos: ${c.files.slice(0, 6).map(f => `${f.path}${f.add || f.del ? ` (+${f.add || 0} −${f.del || 0})` : ''}`).join(', ')}${c.files.length > 6 ? ` e mais ${c.files.length - 6}` : ''}`] : []),
      ...s.hits.slice(0, 3).map(h => `   - \`${h.file}:${h.line}\` ${h.sign} ${h.text}`),
    ]) : ['Nenhum commit no período.']), ''].join('\n');
  copyText(md);
}

// ----- desenho -----
function filtered() {
  const q = CX.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return CX.commits.filter(c => (!CX.repo || c.repo.path === CX.repo) && (!q.length || q.every(w => (c.subject + ' ' + c.author + ' ' + c.hash + ' ' + c.id + ' ' + c.repo.name + ' ' + c.refs.join(' ')).toLowerCase().includes(w) || c.files.some(f => f.path.toLowerCase().includes(w)))));
}
const multi = () => CX.repos.length > 1;
const tagsOf = (c) => c.refs.filter(r => r.startsWith('tag: ')).map(r => r.slice(5));
function lanesHtml(list, sus) {
  const t0 = sinceMs(), t1 = untilMs(), x = (ms) => Math.max(0, Math.min(100, (ms - t0) * 100 / (t1 - t0)));
  let lanes;
  if (multi()) lanes = CX.repos.filter(r => !CX.repo || r.path === CX.repo).map(r => ({ name: r.rel || r.name, title: r.path, items: list.filter(c => c.repo === r) })).filter(l => l.items.length || CX.repos.length <= 12);
  else {
    const by = new Map(); for (const c of list) { if (!by.has(c.author)) by.set(c.author, []); by.get(c.author).push(c); }
    const top = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
    lanes = top.slice(0, 6).map(([name, items]) => ({ name, title: name, items }));
    if (top.length > 6) lanes.push({ name: `mais ${top.length - 6}`, title: top.slice(6).map(t => t[0]).join(', '), items: top.slice(6).flatMap(t => t[1]) });
  }
  if (!lanes.length) return '';
  const dot = (c) => {
    const n = linesOf(c), sz = n > 400 ? 4 : n > 120 ? 3 : n > 30 ? 2 : 1, s = sus && sus.get(keyOf(c)), tag = tagsOf(c);
    const cls = !s ? '' : s.after ? ' after' : CX.inc.off.has(keyOf(c)) ? ' off' : s.n >= 60 ? ' hot' : s.n >= 35 ? ' warm' : ' cool';
    return `<i class="cx-dot z${sz}${cls}${tag.length ? ' tag' : ''}${CX.open.has(keyOf(c)) ? ' sel' : ''}" style="left:${x((c.ts || 0) * 1000).toFixed(2)}%" data-k="${esc(keyOf(c))}" title="${esc(`${c.subject}\n${c.author} · ${absTime(c.ts)}${tag.length ? ' · ' + tag.join(', ') : ''}${s && !s.after ? ' · suspeita ' + s.n : ''}`)}"></i>`;
  };
  // marcas do eixo: de 3 em 3 h, de 12 em 12 h, por dia ou de 5 em 5 dias
  const step = CX.win <= 1 ? 3 * HOUR : CX.win <= 3 ? 12 * HOUR : CX.win <= 10 ? DAY : 5 * DAY, ticks = [];
  const first = new Date(t0); first.setMinutes(0, 0, 0); if (step >= DAY) first.setHours(0);
  for (let t = first.getTime(); t <= t1; t += step) { if (t < t0) continue; const d = new Date(t); ticks.push([x(t), step < DAY ? (d.getHours() === 0 ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : String(d.getHours()).padStart(2, '0') + 'h') : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })]); }
  const grid = ticks.map(([p]) => `<i class="cx-grid" style="left:${p.toFixed(2)}%"></i>`).join('');
  const mark = CX.inc ? `<i class="cx-mark" style="left:${x(CX.inc.at).toFixed(2)}%"><b>início</b></i>` : '';
  return `<div class="cx-lanes">${lanes.map(l => `<div class="cx-lane"><span class="cx-ln" title="${esc(l.title)}">${esc(l.name)}</span><div class="cx-track">${grid}${l.items.map(dot).join('')}${mark}</div></div>`).join('')}
    <div class="cx-lane axis"><span class="cx-ln"></span><div class="cx-track">${ticks.map(([p, t]) => `<span class="cx-tick" style="left:${p.toFixed(2)}%">${t}</span>`).join('')}<span class="cx-tick now">agora</span></div></div></div>`;
}
function commitHtml(c, s) {
  const k = keyOf(c), open = CX.open.has(k), tot = totOf(c), tag = tagsOf(c), off = s && CX.inc.off.has(k);
  const files = !open ? '' : `<div class="cx-files">${c.files.map(f => {
      const hs = s ? s.hits.filter(h => h.file === f.path) : [];
      return chgRow(f, { dir: true }) + hs.map(h => `<div class="cx-hit ${h.sign === '+' ? 'a' : 'd'}" data-p="${esc(f.path)}" data-l="${h.line}" title="Abrir o diff nesta linha"><span class="ln">${h.sign}${h.line}</span><code>${esc(h.text)}</code></div>`).join('');
    }).join('') || `<div class="empty">${c.merge ? 'Merge: as mudanças estão nos commits que ele trouxe.' : 'Sem arquivos nesta pasta.'}</div>`}
      <div class="cx-acts">${same(c.repo.path, S.project.path) && S.project.vcs ? '<button class="chip" data-a="panel">Abrir no painel</button><button class="chip" data-a="since">O que mudou desde ele</button>' : ''}<button class="chip" data-a="hash">Copiar hash</button>${s && !s.after ? `<button class="chip" data-a="off">${off ? 'Voltar a suspeitar' : 'Descartar'}</button>` : ''}</div></div>`;
  return `<article class="cx-c${open ? ' open' : ''}${s && s.after ? ' after' : ''}${off ? ' off' : ''}" data-k="${esc(k)}">
    <div class="cx-ch">${s && !s.after ? `<span class="cx-score ${s.n >= 60 ? 'hot' : s.n >= 35 ? 'warm' : 'cool'}" title="Suspeita de 0 a 100">${s.n}</span>` : ''}${avatar(c.author)}
      <div class="cx-ct"><div class="subj" title="${esc(c.subject)}">${esc(c.subject)}</div>
        <div class="m"><code>${esc(c.hash)}</code>${multi() ? `<span class="cx-repo">${esc(c.repo.name)}</span>` : ''}<span class="who">${esc(c.author)}</span><time title="${esc(absTime(c.ts))}">${esc(c.when)}</time>${tag.map(t => `<span class="cx-tagc" title="Tag">${esc(t)}</span>`).join('')}${c.files.length ? `<span class="nf">${plural(c.files.length, 'arquivo', 'arquivos')}</span>${statHtml(tot)}${statBar(tot)}` : c.merge ? '<span class="nf">merge</span>' : ''}</div>
        ${s && s.why.length ? `<div class="cx-why">${s.why.map(([kind, text]) => `<span class="w-${kind}">${esc(text)}</span>`).join('')}</div>` : ''}</div>${IC.chev(open)}</div>${files}</article>`;
}
function listHtml(list, sus) {
  if (CX.inc) {
    const rows = list.map(c => ({ c, s: sus.get(keyOf(c)) }));
    const before = rows.filter(x => !x.s.after && !CX.inc.off.has(keyOf(x.c))).sort((a, b) => b.s.n - a.s.n || (b.c.ts || 0) - (a.c.ts || 0));
    const off = rows.filter(x => !x.s.after && CX.inc.off.has(keyOf(x.c))), after = rows.filter(x => x.s.after);
    const cut = before.slice(0, CX.more);
    return (before.length ? `<h3 class="cx-h">Suspeitos<small>${plural(before.length, 'commit', 'commits')} antes do início, do mais para o menos suspeito</small></h3>` + cut.map(x => commitHtml(x.c, x.s)).join('') + (before.length > cut.length ? `<button class="chip cx-more" data-a="more">Mostrar mais ${before.length - cut.length}</button>` : '')
        : `<div class="cx-none"><b>Nada mudou antes do início</b><p>Nenhum commit em ${WINS.find(w => w[0] === CX.win)[1]} antes do incidente${CX.q || CX.repo ? ' com esse filtro' : ''}. Tente um período maior.</p></div>`)
      + (off.length ? `<h3 class="cx-h">Descartados</h3>` + off.map(x => commitHtml(x.c, x.s)).join('') : '')
      + (after.length ? `<h3 class="cx-h fold" data-a="after">${IC.chev(CX.afterOpen)}Depois do início<small>${plural(after.length, 'commit', 'commits')}</small></h3>` + (CX.afterOpen ? after.map(x => commitHtml(x.c, x.s)).join('') : '') : '');
  }
  if (!list.length) return `<div class="cx-none"><b>${CX.q || CX.repo ? 'Nenhum commit com esse filtro' : 'Nenhum commit no período'}</b><p>${CX.q || CX.repo ? 'Limpe a busca ou escolha outro repositório.' : 'Escolha um período maior.'}</p></div>`;
  let day = null, html = '';
  for (const c of list.slice(0, CX.more)) { const d = dayLabel(c.ts); if (d !== day) { day = d; html += `<h3 class="cx-h">${esc(d)}</h3>`; } html += commitHtml(c, null); }
  return html + (list.length > CX.more ? `<button class="chip cx-more" data-a="more">Mostrar mais ${list.length - CX.more}</button>` : '');
}
function sideHtml(list) {
  let html = '';
  if (multi() || (S.project && !S.project.vcs)) {
    const n = new Map(); for (const c of CX.commits) n.set(c.repo.path, (n.get(c.repo.path) || 0) + 1);
    html += `<section><h3 class="cx-h">Repositórios</h3>${CX.repos.map(r => `<div class="cx-r${CX.repo === r.path ? ' on' : ''}" data-r="${esc(r.path)}" title="${esc(r.path)}"><span class="nm">${esc(r.rel || r.name)}</span><span class="pill ${r.vcs}">${r.vcs}</span>${r.branch ? `<span class="br">${esc(r.branch)}</span>` : ''}<span class="meta">${r.dirty ? `<b class="dirty" title="${plural(r.dirty, 'alteração local', 'alterações locais')}">${r.dirty}</b>` : ''}<span title="Commits no período">${n.get(r.path) || 0}</span></span></div>`).join('')}</section>`;
  }
  const hot = new Map();
  for (const c of list) for (const f of c.files) { const k = c.repo.path + '|' + f.path, e = hot.get(k) || { path: f.path, repo: c.repo, n: 0, lines: 0 }; e.n++; e.lines += (f.add || 0) + (f.del || 0); hot.set(k, e); }
  const top = [...hot.values()].sort((a, b) => b.n - a.n || b.lines - a.lines).slice(0, 8), max = top[0] ? top[0].n : 1;
  if (top.length) html += `<section><h3 class="cx-h">Mais mexidos</h3>${top.map(e => `<div class="cx-hot" data-q="${esc(e.path.split('/').pop())}" title="${esc((multi() ? e.repo.name + '/' : '') + e.path)}\nClique para ver só os commits que mexeram nele"><span class="nm">${esc(e.path.split('/').pop())}</span><span class="bar"><i style="width:${Math.round(e.n * 100 / max)}%"></i></span><span class="n">${e.n}×</span></div>`).join('')}</section>`;
  const who = new Map(); for (const c of list) who.set(c.author, (who.get(c.author) || 0) + 1);
  const people = [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8), pm = people[0] ? people[0][1] : 1;
  if (people.length > 1) html += `<section><h3 class="cx-h">Quem mexeu</h3>${people.map(([name, k]) => `<div class="cx-hot who" data-q="${esc(name)}" title="Clique para ver só os commits de ${esc(name)}">${avatar(name)}<span class="nm">${esc(name)}</span><span class="bar"><i style="width:${Math.round(k * 100 / pm)}%"></i></span><span class="n">${k}</span></div>`).join('')}</section>`;
  return html;
}
function paint() {
  const el = CX.el; if (!el || !el.isConnected) return;
  const body = el.querySelector('.cx-body'), sub = el.querySelector('.cx-sub');
  el.querySelectorAll('.cx-win button').forEach(b => b.classList.toggle('on', +b.dataset.w === CX.win));
  syncInc();
  if (!S.project) { sub.textContent = ''; body.innerHTML = '<div class="cx-none"><b>Nenhum projeto aberto</b><p>Abra uma pasta para ver as alterações dela.</p></div>'; return; }
  if (CX.loading && !CX.commits.length) { sub.textContent = ''; body.innerHTML = '<div class="cx-none"><span class="spin"></span><p>Lendo os repositórios…</p></div>'; return; }
  if (!CX.repos.length) { sub.textContent = ''; body.innerHTML = '<div class="cx-none"><b>Sem Git nem SVN por aqui</b><p>Esta pasta não é um repositório e não tem repositórios dentro dela.</p></div>'; return; }
  const list = filtered(), sus = CX.inc ? new Map(list.map(c => [keyOf(c), suspect(c)])) : null;
  const tot = list.reduce((a, c) => { const t = totOf(c); return { add: a.add + t.add, del: a.del + t.del }; }, { add: 0, del: 0 });
  sub.innerHTML = [multi() ? plural(CX.repos.length, 'repositório', 'repositórios') : '', plural(list.length, 'commit', 'commits'), plural(new Set(list.map(c => c.author)).size, 'pessoa', 'pessoas'), tot.add || tot.del ? `<span class="stat"><span class="a">+${num(tot.add)}</span><span class="d">−${num(tot.del)}</span></span>` : ''].filter(Boolean).join('<i>·</i>') + (CX.loading || (CX.inc && CX.inc.busy) ? '<span class="spin"></span>' : '');
  // termos procurados (incidente)
  const terms = el.querySelector('.cx-terms');
  terms.innerHTML = CX.inc && CX.inc.terms.length ? `<span class="cx-lb">Procurando nas linhas que mudaram:</span>${CX.inc.terms.map((t, i) => `<span class="cx-term">${esc(t)}<button data-term="${i}" title="Tirar da busca">${IC.x}</button></span>`).join('')}` : CX.inc ? '<span class="cx-lb">Sem termos: a ordem usa só a hora, o tamanho e o tipo de arquivo.</span>' : '';
  el.querySelector('[data-a="report"]').hidden = !CX.inc; el.querySelector('[data-a="end"]').hidden = !CX.inc;
  const sc = getComputedStyle(body).overflowY === "visible" ? body.parentElement : body, top = sc.scrollTop;
  body.innerHTML = lanesHtml(list, sus) + `<div class="cx-cols"><main class="cx-list">${listHtml(list, sus)}</main><aside class="cx-side">${sideHtml(list)}</aside></div>`;
  sc.scrollTop = top;
}
const byKey = (k) => CX.commits.find(c => keyOf(c) === k);
function openFileAt(c, path, line) {
  if (S.project && S.project.vcs && same(c.repo.path, S.project.path)) return BS.vcs.openAtCommit(c, path, line);
  return BS.vcs.repoDiff(c.repo, path, { mode: 'last', rev: c.id }, line);
}
function toggle(k, scroll) {
  CX.open.has(k) ? CX.open.delete(k) : CX.open.add(k); paint();
  if (scroll && CX.open.has(k)) CX.el.querySelector(`.cx-c[data-k="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function mount(el) {
  CX.el = el; el.classList.add('cx');
  el.innerHTML = `<div class="cx-wrap"><header class="cx-top">
      <div class="cx-title"><h1>Alterações</h1><span class="cx-sub"></span></div>
      <div class="cx-bar">
        <label class="cx-search">${IC.search}<input type="search" placeholder="Mensagem, autor, arquivo ou hash" aria-label="Filtrar commits" spellcheck="false"></label>
        <span class="seg cx-win" title="Período">${WINS.map(([d, t]) => `<button type="button" data-w="${d}">${t}</button>`).join('')}</span>
        <button class="chip cx-inc-btn" data-a="inc" title="Diga quando o problema começou e veja os commits mais suspeitos">${IC.fire}Investigar incidente</button>
        <button class="icon-btn" data-a="refresh" title="Ler de novo">${I.refresh}</button>
      </div>
      <section class="cx-inc">
        <div class="cx-inc-grid">
          <label class="cx-f when"><span>Começou</span><input type="datetime-local" class="cx-when"><span class="cx-quick"><button type="button" data-ago="0">agora</button><button type="button" data-ago="60">há 1 h</button><button type="button" data-ago="180">há 3 h</button><button type="button" data-ago="day">hoje cedo</button></span></label>
          <label class="cx-f text"><span>Erro, stack trace ou palavras do chamado <em>opcional</em></span><textarea class="cx-text" rows="3" spellcheck="false" placeholder="Cole aqui. A tela tira os nomes citados (classes, arquivos, métodos, tabelas) e procura nas linhas que mudaram."></textarea></label>
        </div>
        <div class="cx-inc-act"><div class="cx-terms"></div><button class="chip" data-a="end" hidden>Encerrar</button><button class="chip" data-a="report" hidden title="Copia os suspeitos em Markdown, para o chamado">Copiar relatório</button><button class="chip primary" data-a="go">Investigar</button></div>
      </section>
    </header>
    <div class="cx-body"></div></div>`;
  const q = el.querySelector('.cx-search input');
  let qt = 0; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { CX.q = q.value; CX.more = 150; paint(); }, 120); };
  q.onkeydown = (e) => { if (e.key === 'Escape' && q.value) { e.stopPropagation(); q.value = ''; CX.q = ''; paint(); } };
  el.querySelector('.cx-text').onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); investigate(); } };
  el.addEventListener('click', (e) => {
    const t = e.target;
    const w = t.closest('.cx-win button'); if (w) { CX.win = +w.dataset.w; store.set('cxWin', CX.win); return load(true); }
    const ago = t.closest('[data-ago]'); if (ago) { const d = new Date(); if (ago.dataset.ago === 'day') d.setHours(8, 0, 0, 0); else d.setTime(d.getTime() - ago.dataset.ago * 60000); el.querySelector('.cx-when').value = localInput(Math.min(d.getTime(), Date.now())); return; }
    const term = t.closest('[data-term]'); if (term && CX.inc) { CX.inc.terms.splice(+term.dataset.term, 1); incSave(); return load(true); }
    const dot = t.closest('.cx-dot'); if (dot) { const k = dot.dataset.k; if (!CX.open.has(k)) { const c = byKey(k); if (CX.inc && c && (c.ts || 0) * 1000 > CX.inc.at) CX.afterOpen = true; CX.more = Math.max(CX.more, filtered().indexOf(c) + 20); } return toggle(k, true); }
    const r = t.closest('.cx-r'); if (r) { CX.repo = CX.repo === r.dataset.r ? null : r.dataset.r; CX.more = 150; return paint(); }
    const hot = t.closest('.cx-hot'); if (hot) { q.value = CX.q === hot.dataset.q ? '' : hot.dataset.q; CX.q = q.value; CX.more = 150; return paint(); }
    const art = t.closest('.cx-c'), c = art && byKey(art.dataset.k);
    const a = t.closest('[data-a]');
    if (a) {
      const act = a.dataset.a;
      if (act === 'inc') { if (CX.inc) return; CX.incOpen = !CX.incOpen; syncInc(); if (CX.incOpen) el.querySelector('.cx-text').focus(); return; }
      if (act === 'refresh') return load(true);
      if (act === 'go') return investigate();
      if (act === 'end') return endIncident();
      if (act === 'report') return report();
      if (act === 'more') { CX.more += 300; return paint(); }
      if (act === 'after') { CX.afterOpen = !CX.afterOpen; return paint(); }
      if (!c) return;
      if (act === 'panel') return BS.vcs.openAtCommit(c).then(() => openTool('changes'));
      if (act === 'since') return BS.vcs.compare(c.id, null);
      if (act === 'hash') return copyText(c.id || c.hash);
      if (act === 'off') { const k = keyOf(c); CX.inc.off.has(k) ? CX.inc.off.delete(k) : CX.inc.off.add(k); incSave(); return paint(); }
      return;
    }
    if (!c) return;
    const hit = t.closest('.cx-hit'); if (hit) return openFileAt(c, hit.dataset.p, +hit.dataset.l);
    const row = t.closest('.row.chg'); if (row) return openFileAt(c, row.dataset.p);
    if (t.closest('.cx-ch')) toggle(art.dataset.k);
  });
  el.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.cx-r'); if (r) { const repo = CX.repos.find(x => x.path === r.dataset.r); return repo && BS.vcs.repoMenu(e, repo); }
    const art = e.target.closest('.cx-c'), c = art && byKey(art.dataset.k); if (!c) return;
    const row = e.target.closest('.row.chg, .cx-hit');
    if (row) {
      if (S.project && S.project.vcs && same(c.repo.path, S.project.path)) return fileMenu(e, row.dataset.p, false);
      return BS.vcs.repoFileMenu(e, c.repo, row.dataset.p, { mode: 'last', rev: c.id });
    }
    const mine = S.project && S.project.vcs && same(c.repo.path, S.project.path);
    showMenu(e, [
      ...(mine ? [{ label: 'Abrir no painel', icon: I.commit, action: () => BS.vcs.openAtCommit(c).then(() => openTool('changes')) }, { label: 'Comparar com o local', icon: I.diff, action: () => BS.vcs.compare(c.id, null) }, '-'] : [{ label: 'Abrir o repositório como projeto', icon: I.open, action: () => openProject(c.repo.path) }, '-']),
      { label: 'Copiar hash', icon: I.copy, action: () => copyText(c.id || c.hash) },
      { label: 'Copiar mensagem', icon: I.copy, action: () => copyText(c.subject) },
      { label: 'Só os commits de ' + c.author, icon: IC.search, action: () => { q.value = CX.q = c.author; paint(); } },
      ...(CX.inc && (c.ts || 0) * 1000 <= CX.inc.at ? ['-', { label: CX.inc.off.has(keyOf(c)) ? 'Voltar a suspeitar' : 'Descartar como suspeito', icon: IC.x, action: () => { const k = keyOf(c); CX.inc.off.has(k) ? CX.inc.off.delete(k) : CX.inc.off.add(k); incSave(); paint(); } }] : []),
    ], `${multi() ? c.repo.name + ' · ' : ''}${c.hash} · ${c.author}`);
  });
  paint();
}

const tool = BS.tools.get('changes'); if (tool) tool.page = 'changes';
BS.pages.register({ id: 'changes', title: 'Alterações', icon: I.changes, pinned: true, render: mount, show() { load(); } });
BS.hooks.on('project:select', () => { CX.seq++; CX.loading = false; if (BS.pages.isActive('changes')) load(true); });
BS.hooks.on('vcs:focus', (r) => { CX.repo = r.path; if (CX.for === (S.project && S.project.path)) paint(); });
BS.actions.add([{ label: 'Investigar incidente: o que mudou antes do problema', icon: IC.fire, run: () => { openTool('changes'); BS.pages.open('changes'); CX.incOpen = true; syncInc(); CX.el && CX.el.querySelector('.cx-text').focus(); } }]);
BS.changes = { load, state: CX, extractTerms };
})();
