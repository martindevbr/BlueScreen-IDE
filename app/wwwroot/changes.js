'use strict';
// ===== Alterações em tela grande: a aba fixa do painel Alterações =====
// O painel da esquerda (vcs.js) cuida de um commit por vez; esta tela mostra o período inteiro, de todos os
// repositórios da pasta aberta (ela mesma, se for um, e os que estiverem dentro dela, Git ou SVN):
// - linha do tempo: uma faixa por repositório (ou por pessoa, num repositório só), um ponto por commit, do tamanho da
//   mudança; as tags (versões) aparecem como losangos;
// - lista dos commits por dia, com busca por mensagem, autor, arquivo ou hash; o commit abre os arquivos ali mesmo e o
//   clique no arquivo abre o diff (no projeto aberto, o painel acompanha; nos outros repositórios, aba só de leitura);
// - em cima, o quadro dos repositórios (agrupados pela pasta de cima): branch, último commit local, o que falta enviar
//   e baixar e o último commit do origin; clique filtra, clique no commit abre ele, "Consultar origin" faz o fetch
//   de todos. Com remota, a lista também traz os commits do origin ainda não baixados, e filtra Não enviados/Não baixados;
// - ao lado: os arquivos mais mexidos e quem mexeu.
(function cxInit() {
if (BS.doc) return;
const { dayLabel, avatar, statBar, chgRow, midName, repoGroups, syncHtml } = BS.vcs;
const DAY = 86400000, HOUR = 3600000;
const WINS = [[1, '24 h'], [3, '3 dias'], [7, '7 dias'], [30, '30 dias']];
const CX = { el: null, win: store.get('cxWin', 7), q: '', repos: [], commits: [], loading: false, for: null, at: 0, seq: 0, open: new Set(), repo: null, more: 150, where: '', fetching: null };
const IC = {
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  chev: (open) => `<svg class="i cx-chev" viewBox="0 0 24 24"><path d="${open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'}"/></svg>`,
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5"/><path d="M12 11v9M8.5 16.5 12 20l3.5-3.5"/></svg>',
};
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const keyOf = (c) => c.repo.path + '|' + c.id;
const same = (a, b) => String(a).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === String(b).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const absTime = (ts) => new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const linesOf = (c) => c.files.reduce((a, f) => a + (f.add || 0) + (f.del || 0), 0);
const totOf = (c) => c.files.reduce((a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }), { add: 0, del: 0 });
// o período: os últimos N dias
const untilMs = () => Date.now();
const sinceMs = () => Date.now() - CX.win * DAY;
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

// ----- dados -----
async function load(force) {
  if (!CX.el) return;
  if (!S.project) { CX.repos = []; CX.commits = []; CX.for = null; return paint(); }
  const p = S.project.path;
  if (!force && CX.for === p && Date.now() - CX.at < 90000) return paint();
  const seq = ++CX.seq;
  CX.loading = true; if (CX.for !== p) { CX.repos = []; CX.commits = []; CX.repo = null; CX.open.clear(); } paint();
  const repos = await BS.vcs.repos(force);
  const since = Math.floor(sinceMs() / 1000);
  const lists = await pool(repos, 6, (r) => api('timeline', { project: r.path, since, n: 500 }, { quiet: true }).then(l => l.map(c => Object.assign(c, { repo: r }))).catch(() => []));
  if (seq !== CX.seq) return;
  CX.repos = repos; CX.commits = lists.flat().sort((a, b) => (b.ts || 0) - (a.ts || 0)); CX.for = p; CX.at = Date.now(); CX.loading = false; CX.more = 150;
  if (seq === CX.seq) paint();
}
// ----- desenho -----
function filtered() {
  const q = CX.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return CX.commits.filter(c => (!CX.repo || c.repo.path === CX.repo) && (!CX.where || c.place === CX.where) && (!q.length || q.every(w => (c.subject + ' ' + c.author + ' ' + c.hash + ' ' + c.id + ' ' + c.repo.name + ' ' + c.refs.join(' ')).toLowerCase().includes(w) || c.files.some(f => f.path.toLowerCase().includes(w)))));
}
const multi = () => CX.repos.length > 1;
const tagsOf = (c) => c.refs.filter(r => r.startsWith('tag: ')).map(r => r.slice(5));
function lanesHtml(list) {
  const t0 = sinceMs(), t1 = untilMs(), x = (ms) => Math.max(0, Math.min(100, (ms - t0) * 100 / (t1 - t0)));
  let lanes;
  list = list.filter(c => !c.extra);
  if (multi()) lanes = CX.repos.filter(r => !CX.repo || r.path === CX.repo).map(r => ({ name: r.name, html: midName(r.name), title: r.path, items: list.filter(c => c.repo === r) })).filter(l => l.items.length || CX.repos.length <= 12);
  else {
    const by = new Map(); for (const c of list) { if (!by.has(c.author)) by.set(c.author, []); by.get(c.author).push(c); }
    const top = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
    lanes = top.slice(0, 6).map(([name, items]) => ({ name, title: name, items }));
    if (top.length > 6) lanes.push({ name: `mais ${top.length - 6}`, title: top.slice(6).map(t => t[0]).join(', '), items: top.slice(6).flatMap(t => t[1]) });
  }
  if (!lanes.length) return '';
  const dot = (c) => {
    const n = linesOf(c), sz = n > 400 ? 4 : n > 120 ? 3 : n > 30 ? 2 : 1, tag = tagsOf(c);
    return `<i class="cx-dot z${sz}${tag.length ? ' tag' : ''}${CX.open.has(keyOf(c)) ? ' sel' : ''}" style="left:${x((c.ts || 0) * 1000).toFixed(2)}%" data-k="${esc(keyOf(c))}" title="${esc(`${c.subject}\n${c.author} · ${absTime(c.ts)}${tag.length ? ' · ' + tag.join(', ') : ''}`)}"></i>`;
  };
  // marcas do eixo: de 3 em 3 h, de 12 em 12 h, por dia ou de 5 em 5 dias
  const step = CX.win <= 1 ? 3 * HOUR : CX.win <= 3 ? 12 * HOUR : CX.win <= 10 ? DAY : 5 * DAY, ticks = [];
  const first = new Date(t0); first.setMinutes(0, 0, 0); if (step >= DAY) first.setHours(0);
  for (let t = first.getTime(); t <= t1; t += step) { if (t < t0) continue; const d = new Date(t); ticks.push([x(t), step < DAY ? (d.getHours() === 0 ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : String(d.getHours()).padStart(2, '0') + 'h') : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })]); }
  const grid = ticks.map(([p]) => `<i class="cx-grid" style="left:${p.toFixed(2)}%"></i>`).join('');
  return `<div class="cx-lanes">${lanes.map(l => `<div class="cx-lane"><span class="cx-ln" title="${esc(l.title)}">${l.html || esc(l.name)}</span><div class="cx-track">${grid}${l.items.map(dot).join('')}</div></div>`).join('')}
    <div class="cx-lane axis"><span class="cx-ln"></span><div class="cx-track">${ticks.map(([p, t]) => `<span class="cx-tick" style="left:${p.toFixed(2)}%">${t}</span>`).join('')}<span class="cx-tick now">agora</span></div></div></div>`;
}
function commitHtml(c) {
  const k = keyOf(c), open = CX.open.has(k), tot = totOf(c), tag = tagsOf(c);
  const files = !open ? '' : `<div class="cx-files">${c.files.map(f => chgRow(f, { dir: true })).join('') || `<div class="empty">${c.merge ? 'Merge: as mudanças estão nos commits que ele trouxe.' : 'Sem arquivos nesta pasta.'}</div>`}
      <div class="cx-acts">${same(c.repo.path, S.project.path) && S.project.vcs ? '<button class="chip" data-a="panel">Abrir no painel</button><button class="chip" data-a="since">O que mudou desde ele</button>' : ''}<button class="chip" data-a="hash">Copiar hash</button></div></div>`;
  return `<article class="cx-c${open ? ' open' : ''}" data-k="${esc(k)}">
    <div class="cx-ch">${avatar(c.author)}
      <div class="cx-ct"><div class="subj" title="${esc(c.subject)}">${esc(c.subject)}</div>
        <div class="m"><code>${esc(c.hash)}</code>${multi() ? `<span class="cx-repo" title="${esc(c.repo.rel || c.repo.name)}">${midName(c.repo.name)}</span>` : ''}${c.place === 'local' ? '<span class="cx-place up" title="Commit só no seu PC: ainda não foi enviado (push)">↑ não enviado</span>' : c.place === 'remote' ? '<span class="cx-place dn" title="Commit que está no origin e ainda não foi baixado (pull)">↓ só no origin</span>' : ''}<span class="who">${esc(c.author)}</span><time title="${esc(absTime(c.ts))}">${esc(c.when)}</time>${tag.map(t => `<span class="cx-tagc" title="Tag">${esc(t)}</span>`).join('')}${c.files.length ? `<span class="nf">${plural(c.files.length, 'arquivo', 'arquivos')}</span>${statHtml(tot)}${statBar(tot)}` : c.merge ? '<span class="nf">merge</span>' : ''}</div>
</div>${IC.chev(open)}</div>${files}</article>`;
}
function listHtml(list) {
  const fil = CX.q || CX.repo || CX.where;
  if (!list.length) return `<div class="cx-none"><b>${CX.where === 'local' && !CX.q ? 'Nada para enviar' : CX.where === 'remote' && !CX.q ? 'Nada para baixar' : fil ? 'Nenhum commit com esse filtro' : 'Nenhum commit no período'}</b><p>${CX.where ? 'No período escolhido' + (CX.where === 'remote' ? ', pelo último "Consultar origin".' : '.') : fil ? 'Limpe a busca ou escolha outro repositório.' : 'Escolha um período maior.'}</p></div>`;
  let day = null, html = '';
  for (const c of list.slice(0, CX.more)) { const d = dayLabel(c.ts); if (d !== day) { day = d; html += `<h3 class="cx-h">${esc(d)}</h3>`; } html += commitHtml(c); }
  return html + (list.length > CX.more ? `<button class="chip cx-more" data-a="more">Mostrar mais ${list.length - CX.more}</button>` : '');
}
function sideHtml(list) {
  let html = '';
  const hot = new Map();
  for (const c of list) for (const f of c.files) { const k = c.repo.path + '|' + f.path, e = hot.get(k) || { path: f.path, repo: c.repo, n: 0, lines: 0 }; e.n++; e.lines += (f.add || 0) + (f.del || 0); hot.set(k, e); }
  const top = [...hot.values()].sort((a, b) => b.n - a.n || b.lines - a.lines).slice(0, 8), max = top[0] ? top[0].n : 1;
  if (top.length) html += `<section><h3 class="cx-h">Mais mexidos</h3>${top.map(e => `<div class="cx-hot" data-q="${esc(e.path.split('/').pop())}" title="${esc((multi() ? e.repo.name + '/' : '') + e.path)}\nClique para ver só os commits que mexeram nele"><span class="nm">${esc(e.path.split('/').pop())}</span><span class="bar"><i style="width:${Math.round(e.n * 100 / max)}%"></i></span><span class="n">${e.n}×</span></div>`).join('')}</section>`;
  const who = new Map(); for (const c of list) who.set(c.author, (who.get(c.author) || 0) + 1);
  const people = [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8), pm = people[0] ? people[0][1] : 1;
  if (people.length > 1) html += `<section><h3 class="cx-h">Quem mexeu</h3>${people.map(([name, k]) => `<div class="cx-hot who" data-q="${esc(name)}" title="Clique para ver só os commits de ${esc(name)}">${avatar(name)}<span class="nm">${esc(name)}</span><span class="bar"><i style="width:${Math.round(k * 100 / pm)}%"></i></span><span class="n">${k}</span></div>`).join('')}</section>`;
  return html;
}
// ----- quadro dos repositórios: onde cada um está, local e no origin -----
const lcHtml = (r, cm, kind) => cm ? `<button type="button" class="cx-lc" data-a="cm" data-kind="${kind}" data-r="${esc(r.path)}" title="${esc(`${cm.subject}\n${cm.hash} · ${cm.author} · ${cm.ts ? absTime(cm.ts) : cm.when}\nClique para abrir o commit`)}"><code>${esc(cm.hash)}</code><span class="s">${esc(cm.subject)}</span><time>${esc(cm.when)}</time></button>` : '';
function ovHtml() {
  const n = new Map(); for (const c of CX.commits) if (!c.extra) n.set(c.repo.path, (n.get(c.repo.path) || 0) + 1);
  const ups = CX.repos.filter(r => r.upstream), fetched = Math.min(...ups.map(r => r.fetched || 0));
  const inRepo = CX.commits.filter(c => !CX.repo || c.repo.path === CX.repo);
  const nl = inRepo.filter(c => c.place === 'local').length, nr = inRepo.filter(c => c.place === 'remote').length;
  const row = (r) => {
    const l = r.last, rl = r.remote_last, same = rl && l && (rl.id ? rl.id === l.id : rl.hash === l.hash);
    return `<div class="cx-ovr${CX.repo === r.path ? ' on' : ''}" data-r="${esc(r.path)}" title="${esc(r.path)}">
      <div class="c-nm"><div class="l1">${midName(r.name)}<span class="pill ${r.vcs}">${r.vcs}</span>${r.dirty ? `<b class="dirty" title="${plural(r.dirty, 'alteração local', 'alterações locais')} (sem commit)">${r.dirty}</b>` : ''}</div>${r.branch ? `<span class="br" title="Branch ${esc(r.branch)}">${esc(r.branch)}</span>` : ''}</div>
      <div class="c-lc">${lcHtml(r, l, 'last') || '<span class="none">sem commits</span>'}</div>
      <div class="c-rm">${r.remoteErr ? `<span class="err" title="${esc(r.remoteErr)}">não respondeu</span>` : r.upstream ? syncHtml(r, true) + (rl && !same ? lcHtml(r, rl, 'remote') : '') : `<span class="none">${r.vcs === 'svn' ? 'consulte o servidor' : 'sem remota'}</span>`}</div>
      <div class="c-n" title="Commits no período">${n.get(r.path) || 0}</div></div>`;
  };
  const groups = repoGroups(CX.repos), grouped = groups.length > 1 || groups[0][0];
  const fb = CX.fetching;
  return `<section class="cx-ov">
    <header class="cx-ovhd"><h3 class="cx-h">${plural(CX.repos.length, 'Repositório', 'Repositórios')}</h3>
      <small>${ups.length ? (fetched ? 'origin consultado ' + (ago(fetched * 1000) === 'agora' ? 'agora' : 'há ' + ago(fetched * 1000)) : 'origin ainda não consultado') : ''}</small><span class="sp"></span>
      ${ups.length || CX.where ? `<span class="seg cx-where" title="Onde o commit está">
        <button type="button" data-where=""${!CX.where ? ' class="on"' : ''}>Todos</button>
        <button type="button" data-where="local"${CX.where === 'local' ? ' class="on"' : ''} title="Commits só no seu PC (falta push)">↑ Não enviados${nl ? ` <i>${nl}</i>` : ''}</button>
        <button type="button" data-where="remote"${CX.where === 'remote' ? ' class="on"' : ''} title="Commits do origin que você ainda não baixou (falta pull)">↓ Não baixados${nr ? ` <i>${nr}</i>` : ''}</button></span>` : ''}
      <button class="chip" data-a="fetch"${fb ? ' disabled' : ''} title="Faz fetch de todos (no SVN, consulta o servidor) para saber o que falta enviar e baixar">${fb ? `<span class="spin"></span>Consultando ${fb[0]}/${fb[1]}` : `${IC.down}Consultar origin`}</button></header>
    <div class="cx-ovt"><div class="cx-ovh"><span>Repositório</span><span>Último commit local</span><span>Origin</span><span title="Commits no período">Período</span></div>
      ${grouped ? groups.map(([g, list]) => `<div class="cx-ovg">${esc(g || 'na raiz')}</div>${list.map(row).join('')}`).join('') : CX.repos.map(row).join('')}</div></section>`;
}
async function openRepoCommit(r, cm) {
  if (!cm) return;
  const hit = (x) => x.repo.path === r.path && (cm.id ? x.id === cm.id : x.hash === cm.hash);
  let c = CX.commits.find(hit);
  if (!c && cm.ts) {
    // fora do período: busca só esse commit e põe na lista
    const l = await api('timeline', { project: r.path, since: cm.ts - 1, until: cm.ts + 1, n: 50 }, { quiet: true }).catch(() => []);
    c = l.map(x => Object.assign(x, { repo: r, extra: true })).find(hit);
    if (c) { CX.commits.push(c); CX.commits.sort((a, b) => (b.ts || 0) - (a.ts || 0)); }
  }
  if (!c) return toast('Não achei esse commit');
  CX.repo = r.path; if (CX.where && c.place !== CX.where) CX.where = '';
  if (CX.q) { CX.q = ''; CX.el.querySelector('.cx-search input').value = ''; }
  const k = keyOf(c); CX.open.add(k); CX.more = Math.max(CX.more, filtered().indexOf(c) + 20); paint();
  CX.el.querySelector(`.cx-c[data-k="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
async function fetchAll() {
  if (CX.fetching || !CX.repos.length) return;
  CX.fetching = [0, CX.repos.length]; paint();
  await BS.vcs.remoteAll(CX.repos, (d, n) => { CX.fetching = [d, n]; paint(); });
  CX.fetching = null;
  await load(true);
}
function paint() {
  const el = CX.el; if (!el || !el.isConnected) return;
  const body = el.querySelector('.cx-body'), sub = el.querySelector('.cx-sub');
  el.querySelectorAll('.cx-win button').forEach(b => b.classList.toggle('on', +b.dataset.w === CX.win));
  if (!S.project) { sub.textContent = ''; body.innerHTML = '<div class="cx-none"><b>Nenhum projeto aberto</b><p>Abra uma pasta para ver as alterações dela.</p></div>'; return; }
  if (CX.loading && !CX.commits.length) { sub.textContent = ''; body.innerHTML = '<div class="cx-none"><span class="spin"></span><p>Lendo os repositórios…</p></div>'; return; }
  if (!CX.repos.length) { sub.textContent = ''; body.innerHTML = '<div class="cx-none"><b>Sem Git nem SVN por aqui</b><p>Esta pasta não é um repositório e não tem repositórios dentro dela.</p></div>'; return; }
  const list = filtered();
  const tot = list.reduce((a, c) => { const t = totOf(c); return { add: a.add + t.add, del: a.del + t.del }; }, { add: 0, del: 0 });
  sub.innerHTML = [plural(list.filter(c => !c.extra).length, 'commit', 'commits'), plural(new Set(list.map(c => c.author)).size, 'pessoa', 'pessoas'), tot.add || tot.del ? `<span class="stat"><span class="a">+${num(tot.add)}</span><span class="d">−${num(tot.del)}</span></span>` : ''].filter(Boolean).join('<i>·</i>') + (CX.loading ? '<span class="spin"></span>' : '');
  const sc = getComputedStyle(body).overflowY === "visible" ? body.parentElement : body, top = sc.scrollTop;
  body.innerHTML = ovHtml() + lanesHtml(list) + `<div class="cx-cols"><main class="cx-list">${listHtml(list)}</main><aside class="cx-side">${sideHtml(list)}</aside></div>`;
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
        <button class="icon-btn" data-a="refresh" title="Ler de novo">${I.refresh}</button>
      </div>
    </header>
    <div class="cx-body"></div></div>`;
  const q = el.querySelector('.cx-search input');
  let qt = 0; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { CX.q = q.value; CX.more = 150; paint(); }, 120); };
  q.onkeydown = (e) => { if (e.key === 'Escape' && q.value) { e.stopPropagation(); q.value = ''; CX.q = ''; paint(); } };
  el.addEventListener('click', (e) => {
    const t = e.target;
    const w = t.closest('.cx-win button'); if (w) { CX.win = +w.dataset.w; store.set('cxWin', CX.win); return load(true); }
    const dot = t.closest('.cx-dot'); if (dot) { const k = dot.dataset.k; if (!CX.open.has(k)) { const c = byKey(k); CX.more = Math.max(CX.more, filtered().indexOf(c) + 20); } return toggle(k, true); }
    const wh = t.closest('[data-where]'); if (wh) { CX.where = wh.dataset.where; CX.more = 150; return paint(); }
    const lc = t.closest('.cx-lc'); if (lc) { const r = CX.repos.find(x => x.path === lc.dataset.r); return r && openRepoCommit(r, lc.dataset.kind === 'remote' ? r.remote_last : r.last); }
    if (t.closest('[data-a="fetch"]')) return fetchAll();
    const r = t.closest('.cx-ovr'); if (r) { CX.repo = CX.repo === r.dataset.r ? null : r.dataset.r; CX.more = 150; return paint(); }
    const hot = t.closest('.cx-hot'); if (hot) { q.value = CX.q === hot.dataset.q ? '' : hot.dataset.q; CX.q = q.value; CX.more = 150; return paint(); }
    const art = t.closest('.cx-c'), c = art && byKey(art.dataset.k);
    const a = t.closest('[data-a]');
    if (a) {
      const act = a.dataset.a;
      if (act === 'refresh') return load(true);
      if (act === 'more') { CX.more += 300; return paint(); }
      if (!c) return;
      if (act === 'panel') return BS.vcs.openAtCommit(c).then(() => openTool('changes'));
      if (act === 'since') return BS.vcs.compare(c.id, null);
      if (act === 'hash') return copyText(c.id || c.hash);
      return;
    }
    if (!c) return;
    const row = t.closest('.row.chg'); if (row) return openFileAt(c, row.dataset.p);
    if (t.closest('.cx-ch')) toggle(art.dataset.k);
  });
  el.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.cx-ovr'); if (r) { const repo = CX.repos.find(x => x.path === r.dataset.r); return repo && BS.vcs.repoMenu(e, repo); }
    const art = e.target.closest('.cx-c'), c = art && byKey(art.dataset.k); if (!c) return;
    const row = e.target.closest('.row.chg');
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
    ], `${multi() ? c.repo.name + ' · ' : ''}${c.hash} · ${c.author}`);
  });
  paint();
}

const tool = BS.tools.get('changes'); if (tool) tool.page = 'changes';
BS.pages.register({ id: 'changes', title: 'Alterações', icon: I.changes, pinned: true, render: mount, show() { load(); } });
BS.hooks.on('project:select', () => { CX.seq++; CX.loading = false; if (BS.pages.isActive('changes')) load(true); });
BS.hooks.on('vcs:focus', (r) => { CX.repo = r.path; if (CX.for === (S.project && S.project.path)) paint(); });
BS.changes = { load, state: CX };
})();
