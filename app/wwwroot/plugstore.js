/* BlueScreen: Loja de plugins. O catálogo oficial é o repositório github.com/martindevbr/BlueScreen-Plugins
   (plugins/remote.rs baixa o zip do branch num pedido só e guarda com o ETag). O painel Plugins (Alt+7) fica com os
   plugins instalados na esquerda e a loja abre como aba fixa na área grande: busca, filtros, cartões e a página de
   cada plugin (README, nós do Automator, arquivos). Instalar e atualizar não recarregam a janela.
   Alguns segundos depois de abrir, e de meia em meia hora, a IDE pergunta à loja: havendo versão maior de um plugin
   instalado, aparece o selo "Plugins" no topo e o número na aba, e eles ficam lá até atualizar. */
(function (bs) {
const { $, esc, toast } = bs;
const P = { remote: null, busy: new Set(), at: 0, q: '', tab: 'all', cat: '', sel: null, about: new Map(), aboutBusy: new Set(), loading: false, el: null, dkey: '', enterKey: '' };
const REPO = 'https://github.com/martindevbr/BlueScreen-Plugins';
// as categorias do repositório de plugins (CATEGORIAS em ferramentas/plugins.mjs, lá); uma desconhecida aparece pela chave
const CATS = { ia: 'Inteligência artificial', desenvolvimento: 'Desenvolvimento', qualidade: 'Qualidade e testes', produtividade: 'Produtividade', integracoes: 'Integrações', midia: 'Música e mídia', aparencia: 'Aparência', outros: 'Outros' };
const catName = (c) => CATS[c] || c || '';
const post = (path, body) => bs.api(path, {}, { method: 'POST', body: JSON.stringify(body || {}) });
const IC = {
  up: '<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  store: '<svg class="i" viewBox="0 0 24 24"><path d="M4 9l1.5-5h13L20 9M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M9.5 20v-5h5v5"/></svg>',
  node: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h3a2 2 0 0 1 2 2v5"/></svg>',
  back: '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  link: '<svg class="i" viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5"/></svg>',
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  bug: '<svg class="i" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 11v9M9 4.5l1.5 2.5M15 4.5L13.5 7M3.5 12H7M17 12h3.5M4.5 18l3-1.5M19.5 18l-3-1.5M4.5 6.5l3 2M19.5 6.5l-3 2"/></svg>',
  idea: '<svg class="i" viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M8.5 14.5a6 6 0 1 1 7 0c-.9.7-1.5 1.6-1.5 2.5h-4c0-.9-.6-1.8-1.5-2.5z"/></svg>',
};
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const size = (n) => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
// tamanho no cartão: instalado, o espaço que ele ocupa no disco (medido ao instalar); na loja, o tamanho do pacote
const sizeOf = (p) => p.installed && p.disk ? `<span title="Espaço ocupado no disco, medido na instalação">${size(p.disk)} no disco</span>` : p.size ? `<span title="Tamanho do pacote">${size(p.size)}</span>` : '';
// quem fez: o autor do primeiro commit da pasta do plugin (quem publicou) e, menor, quem editou por último
const when = (iso) => { const t = Date.parse(iso || ''); if (!t) return ''; const d = Math.floor((Date.now() - t) / 864e5); return d < 1 ? 'hoje' : d === 1 ? 'ontem' : d < 30 ? `há ${d} dias` : d < 60 ? 'há 1 mês' : d < 365 ? `há ${Math.floor(d / 30)} meses` : new Date(t).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }); };
const day = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : ''; };
const nameOf = (a) => (a && (a.login || a.name)) || '';
const face = (a) => a && a.avatar ? `<img class="ps-av" src="${esc(a.avatar)}${String(a.avatar).includes('?') ? '&' : '?'}s=48" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ps-av" aria-hidden="true">${esc((nameOf(a) || '?').slice(0, 1).toUpperCase())}</span>`;
function byline(p, big) {
  const m = p.made, f = m && m.first, l = m && m.last;
  if (!f || !nameOf(f)) return p.author ? `<div class="ps-by${big ? ' big' : ''}">${face({ name: p.author })}<span class="ps-who"><b>${esc(p.author)}</b></span></div>` : '';
  const edited = l && l.sha !== f.sha && nameOf(l);
  return `<div class="ps-by${big ? ' big' : ''}">${face(f)}<span class="ps-who"><b title="Autor do primeiro commit do plugin${f.name && f.login ? ' (' + esc(f.name) + ')' : ''}, em ${esc(day(f.date))}">${esc(nameOf(f))}</b>`
    + (edited ? `<small title="Último commit do plugin, em ${esc(day(l.date))}">última edição: ${esc(nameOf(l))}, ${esc(when(l.date))}</small>` : `<small title="${esc(day(f.date))}">publicou ${esc(when(f.date))}</small>`) + '</span></div>';
}

// selo no topo, ao lado do de atualização do BlueScreen
const pill = document.createElement('button');
pill.id = 'plugPill'; pill.className = 'chip'; pill.hidden = true;
pill.innerHTML = `${IC.up}<span class="pp-txt">Plugins</span>`;
($('#updPill') || $('#btnSettings')).before(pill);
pill.onclick = () => { P.tab = 'upd'; bs.openTool('plugins'); paint(); };

const catalog = () => (P.remote && P.remote.plugins) || [];
const updates = () => catalog().filter(p => p.update);
function mark() {
  const n = updates().length;
  pill.hidden = !n;
  pill.querySelector('.pp-txt').textContent = n === 1 ? `${updates()[0].name} v${updates()[0].version}` : `${n} plugins para atualizar`;
  pill.title = updates().map(p => `${p.name}: v${p.installed} → v${p.version}`).join('\n');
  const b = $('#badge-plugins'); if (b) { b.hidden = !n; b.textContent = n; }
}
async function check(fresh, quiet = true) {
  P.loading = true; if (!P.remote) paint();
  try {
    P.remote = await bs.api('plugins/remote', { fresh: fresh ? '1' : null }, { quiet: true }); P.at = Date.now(); P.error = '';
    const before = pill.hidden; mark();
    if (before && !pill.hidden) { pill.classList.remove('up-enter'); void pill.offsetWidth; pill.classList.add('up-enter'); }
    if (!quiet) toast(updates().length ? plural(updates().length, 'atualização de plugin', 'atualizações de plugins') : 'Plugins em dia', 'ok');
    movedNotice();
  } catch (e) { P.error = e.message; if (!quiet) toast('Loja de plugins: ' + e.message); }
  P.loading = false;
  if (bs.S.tool === 'plugins') bs.renderTool();
  paint();
}

// QAutils e IAMaker deixaram de vir junto com o BlueScreen: agora são instalados pela loja. Quem já usava (tem dados
// guardados do plugin) recebe o convite uma vez, e os dados continuam onde estavam.
const MOVED = ['qautils', 'iamaker'];
async function movedNotice() {
  if (bs.doc || movedNotice.done || bs.store.get('movedAsk', false)) return; movedNotice.done = true;
  const had = [];
  for (const id of MOVED) {
    const o = catalog().find(p => p.id === id); if (!o || o.installed || bs.plugins.list.some(p => p.id === id)) continue;
    try { const i = await bs.api('plugin/info', { plugin: id }, { method: 'POST', body: '{}', quiet: true }); if (i && i.exists) had.push(o); } catch { /* sem dados: não usava */ }
  }
  if (!had.length) return;
  const names = had.map(p => p.name).join(' e ');
  window.dialog('movedDlg', `<div class="dlg-hd"><span class="dlg-ic">${IC.store}</span><div><h3>${esc(names)}: agora pela loja</h3><p>${had.length > 1 ? 'Eles deixaram' : 'Ele deixou'} de vir junto com o BlueScreen e ${had.length > 1 ? 'passaram' : 'passou'} para a loja de plugins. O que você tinha guardado (configurações e dados) continua no lugar.</p></div></div>
    <div class="actions"><button class="chip" data-close>Agora não</button><button class="chip primary" id="movedGo">${IC.down}Instalar ${esc(names)}</button></div>`, (el) => {
    bs.store.set('movedAsk', true);
    el.querySelector('#movedGo').onclick = () => { el.hidden = true; install(had); };
  });
}

// instala/atualiza (um ou vários) e liga o plugin na hora, sem recarregar a janela
async function install(list) {
  list = list.filter(p => p && !P.busy.has(p.id)); if (!list.length) return;
  list.forEach(p => P.busy.add(p.id)); paint(); if (bs.S.tool === 'plugins') bs.renderTool();
  let done = 0;
  for (const p of list) {
    try {
      const got = await post('plugins/install', { server: p.server, id: p.id, version: p.version }); p.disk = got && got.disk;
      const r = await bs.plugins.reload(p.id); done++;
      if (r && r.error) toast(`${p.name}: ${r.error}`, 'err');
    } catch (e) { toast(`${p.name}: ${e.message}`, 'err'); }
    P.busy.delete(p.id);
  }
  if (done) toast(done > 1 ? `${done} plugins instalados` : `${list[0].name} ${list[0].installed ? 'atualizado' : 'instalado'}${list[0].disk ? ` · ocupa ${size(list[0].disk)} no disco` : ''}`, 'ok');
  await check(true);
}

// ----- painel Plugins (esquerda): versão, origem e "Atualizar" nos instalados -----
function decorate(body) {
  const rp = new Map(catalog().map(p => [p.id, p]));
  body.querySelectorAll('.plug[data-id]').forEach(el => {
    const p = bs.plugins.list.find(x => x.id === el.dataset.id), o = rp.get(el.dataset.id); if (!p) return;
    el.querySelector('.nm').insertAdjacentHTML('beforeend', `<span class="pl-ver">v${esc(p.version)}</span>`);
    if (o) { const nm = el.querySelector('.pl-name'); nm.classList.add('pl-link'); nm.title = 'Ver na loja'; nm.onclick = () => open(o.id); }
    if (o && o.update) {
      const b = document.createElement('button'); b.className = 'chip pl-upd'; b.disabled = P.busy.has(p.id);
      b.innerHTML = `${IC.up}${P.busy.has(p.id) ? 'Atualizando…' : 'Atualizar para v' + esc(o.version)}`;
      b.title = `v${p.version} → v${o.version}`;
      b.onclick = (e) => { e.stopPropagation(); install([o]); };
      el.querySelector('.tx').appendChild(b); el.classList.add('has-upd');
    }
  });
  const ups = updates();
  if (ups.length > 1) {
    body.insertAdjacentHTML('afterbegin', `<div class="pl-banner">${IC.up}<span>${ups.length} plugins têm versão nova</span><button class="chip" data-all>Atualizar todos</button></div>`);
    body.querySelector('[data-all]').onclick = () => install(ups);
  }
  // o painel abriu e a última consulta é velha: pergunta de novo
  if (!P.loading && (!P.remote || Date.now() - P.at > 120000)) { P.at = Date.now(); check(false); }
}
// itens extras no botão direito de um plugin instalado
function menu(p) {
  const o = catalog().find(x => x.id === p.id), items = [];
  if (o && o.update) items.push({ label: `Atualizar para v${o.version}`, icon: bs.I.refresh, action: () => install([o]) });
  if (o) items.push({ label: 'Ver na loja', icon: IC.store, action: () => open(o.id) });
  return items.length ? ['-', ...items] : [];
}

// ----- a loja (aba fixa do painel Plugins) -----
const TABS = [['all', 'Todos'], ['inst', 'Instalados'], ['upd', 'Atualizações'], ['nodes', 'Com nós']];
const matches = (p) => {
  if (P.tab === 'inst' && !p.installed) return false;
  if (P.tab === 'upd' && !p.update) return false;
  if (P.tab === 'nodes' && !p.nodes) return false;
  if (P.cat && p.category !== P.cat) return false;
  const q = P.q.trim().toLowerCase();
  return !q || q.split(/\s+/).every(w => [p.name, p.description, p.author, p.id, catName(p.category), ...(p.keywords || []), ...(p.contributors || []), p.made && nameOf(p.made.first), p.made && p.made.first && p.made.first.name].join(' ').toLowerCase().includes(w));
};
const stateBtn = (p, big) => {
  const busy = P.busy.has(p.id);
  if (busy) return `<button class="chip primary ps-act" disabled><span class="spin"></span>${p.installed ? 'Atualizando…' : 'Instalando…'}</button>`;
  // a versão da loja pede um BlueScreen mais novo (minBlueScreen): no lugar do botão, o que falta
  if (p.incompatible && p.installed !== p.version) return `<span class="ps-need" title="${p.installed ? `Você tem a v${esc(p.installed)}. ` : ''}A v${esc(p.version)} precisa do BlueScreen ${esc(p.minBlueScreen)} ou mais novo: atualize o BlueScreen primeiro.">Precisa do BlueScreen ${esc(p.minBlueScreen)}</span>`;
  if (p.update) return `<button class="chip primary ps-act" data-a="install" title="v${esc(p.installed)} → v${esc(p.version)}">${IC.up}Atualizar${big ? ' para v' + esc(p.version) : ''}</button>`;
  if (p.installed) return `<span class="ps-done">${IC.ok}Instalado</span>`;
  return `<button class="chip primary ps-act" data-a="install">${IC.down}Instalar</button>`;
};
const tags = (p) => `${p.nodes ? `<span class="ps-tag node" title="Acrescenta ${plural(p.nodes, 'nó', 'nós')} ao Automator">${IC.node}${plural(p.nodes, 'nó', 'nós')}</span>` : ''}${p.runtime ? `<span class="ps-tag" title="O servidor do plugin roda com ${esc(p.runtime)}">${esc(p.runtime)}</span>` : ''}`;
function card(p, i) {
  const sub = [`v${esc(p.installed && p.update ? p.installed : p.version)}`, p.category ? esc(catName(p.category)) : '', sizeOf(p)].filter(Boolean).join(' · ');
  return `<article class="ps-card${P.sel === p.id ? ' sel' : ''}${p.update ? ' upd' : ''}" data-id="${esc(p.id)}" tabindex="0" style="--i:${Math.min(i, 16)}">
    <header>${bs.plugIcon(p)}<div class="ps-nm"><b>${esc(p.name)}</b><small>${sub}</small></div>${p.update ? `<span class="ps-new" title="v${esc(p.installed)} → v${esc(p.version)}">nova versão</span>` : ''}</header>
    <p>${esc(p.description || 'Sem descrição.')}</p>
    <footer>${byline(p)}<span class="ps-end"><span class="ps-tags">${tags(p)}</span>${stateBtn(p)}</span></footer>
  </article>`;
}
function paint() {
  const el = P.el; if (!el || !el.isConnected) return;
  const st = P.remote && P.remote.store, all = catalog();
  el.querySelectorAll('.ps-seg button').forEach(b => { b.classList.toggle('on', b.dataset.tab === P.tab); if (b.dataset.tab === 'upd') { const n = updates().length; b.innerHTML = 'Atualizações' + (n ? `<i>${n}</i>` : ''); } });
  const note = el.querySelector('.ps-note');
  note.innerHTML = [
    P.error ? `<p class="bad">Não deu para consultar a loja: ${esc(P.error)}</p>` : '',
    st && !st.ok ? `<p class="bad">Não deu para falar com o GitHub: ${esc(st.error || 'sem resposta')}. <a data-a="retry">Tentar de novo</a></p>` : '',
    st && st.stale ? `<p>Sem conexão com o GitHub (${esc(st.stale)}): mostrando o catálogo guardado da última vez. <a data-a="retry">Tentar de novo</a></p>` : '',
    st && st.local ? '<p>Catálogo lido de uma pasta local (BLUESCREEN_PLUGIN_REPO), não do GitHub.</p>' : '',
  ].join('');
  note.hidden = !note.innerHTML;
  // resumo do catálogo no topo
  const inst = all.filter(p => p.installed).length, nodes = all.filter(p => p.nodes).length;
  el.querySelector('.ps-sub').innerHTML = P.remote ? [plural(all.length, 'plugin', 'plugins'), inst ? `${inst} ${inst === 1 ? 'instalado' : 'instalados'}` : '', nodes ? `${nodes} com nós no Automator` : ''].filter(Boolean).map(s => `<span>${s}</span>`).join('') : '<span>Abrindo a loja…</span>';
  // categorias que existem no catálogo, em chips com a contagem; sem categoria nenhuma, a fileira some
  const cats = [...new Set(all.map(p => p.category).filter(Boolean))].sort((x, y) => catName(x).localeCompare(catName(y), 'pt-BR'));
  if (P.cat && !cats.includes(P.cat)) P.cat = '';
  const row = el.querySelector('.ps-cats');
  row.hidden = cats.length < 2;
  const chips = [['', 'Todas', all.length], ...cats.map(c => [c, catName(c), all.filter(p => p.category === c).length])]
    .map(([c, n, k]) => `<button type="button" data-cat="${esc(c)}" class="${P.cat === c ? 'on' : ''}" aria-pressed="${P.cat === c}">${esc(n)}<i>${k}</i></button>`).join('');
  if (row.dataset.html !== chips) { row.innerHTML = chips; row.dataset.html = chips; }
  const list = all.filter(matches), grid = el.querySelector('.ps-grid'), empty = el.querySelector('.ps-empty');
  el.querySelector('.ps-count').textContent = P.remote && list.length !== all.length ? `${list.length} de ${all.length}` : '';
  // plugins com versão nova, fora da aba Atualizações: um aviso com "Atualizar todos"
  const ups = updates(), upbar = el.querySelector('.ps-upbar');
  upbar.hidden = !ups.length || P.tab === 'upd';
  if (!upbar.hidden) upbar.innerHTML = `<span class="ps-upic">${IC.up}</span><span>${ups.length === 1 ? `${esc(ups[0].name)} tem versão nova (v${esc(ups[0].version)})` : `${ups.length} plugins têm versão nova`}</span><button class="chip primary" data-a="upall"${ups.every(p => P.busy.has(p.id)) ? ' disabled' : ''}>${IC.up}${ups.length === 1 ? 'Atualizar' : 'Atualizar todos'}</button>`;
  grid.innerHTML = list.map(card).join('');
  // os cartões entram com animação quando a lista muda de verdade (aba, categoria, a loja chegou); digitar na busca não anima
  const k = `${P.tab}|${P.cat}|${!!P.remote}`;
  if (P.enterKey !== k) { P.enterKey = k; grid.classList.remove('enter'); void grid.offsetWidth; grid.classList.add('enter'); clearTimeout(P.enterT); P.enterT = setTimeout(() => grid.classList.remove('enter'), 900); }
  grid.hidden = !list.length; empty.hidden = !!list.length;
  if (!list.length) empty.innerHTML = !P.remote ? '<span class="spin"></span><p>Abrindo a loja…</p>'
    : !all.length ? `<b>A loja não respondeu</b><p>Confira a conexão e tente de novo.</p><button class="chip primary" data-a="retry">${bs.I.refresh}Tentar de novo</button>`
    : `<span class="ps-emptyic">${IC.search}</span><b>${P.tab === 'upd' ? 'Tudo em dia' : 'Nada por aqui'}</b><p>${P.tab === 'upd' ? 'Nenhum plugin instalado tem versão nova.' : P.tab === 'inst' ? (P.q ? 'Nenhum instalado com esse nome.' : 'Nenhum plugin da loja está instalado ainda.') : P.cat && !P.q ? 'Nenhum plugin desta categoria com este filtro.' : 'Nenhum plugin com esse nome.'}</p><p>Não achou o que queria? <a href="${REPO}/issues/new?template=ideia.yml" target="_blank" rel="noopener">Sugira um plugin</a> ou <a href="${REPO}/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">escreva o seu</a>.</p>`;
  paintDetail();
}

// ----- painel de detalhes (direita): desliza ao abrir e fechar; trocar de plugin faz só um esmaecer curto -----
const TRASH = '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
const dActions = (p, local) => `${stateBtn(p, true)}${local && local.user ? `<button class="icon-btn" data-a="remove" title="Remover ${esc(p.name)}">${TRASH}</button>` : ''}<button class="icon-btn ps-x" data-a="close" title="Fechar (Esc)">${IC.x}</button>`;
function facts(p) {
  const rows = [
    ['Versão', `v${esc(p.version)}${p.installed && p.installed !== p.version ? ` <small>você tem a v${esc(p.installed)}</small>` : ''}`],
    p.category && ['Categoria', esc(catName(p.category))],
    p.license && ['Licença', p.license === 'NOASSERTION' ? '<span title="O autor ainda não escolheu a licença: até lá, o código não pode ser reaproveitado">a definir</span>' : esc(p.license)],
    ['Pacote', `${plural(p.files || 0, 'arquivo', 'arquivos')} · ${size(p.size || 0)}`],
    p.installed && p.disk && ['No disco', size(p.disk)],
    p.runtime && ['Roda com', esc(p.runtime)],
    p.minBlueScreen && ['BlueScreen', `${esc(p.minBlueScreen)} ou mais novo`],
    p.requires && p.requires.length && ['Precisa de', p.requires.map(esc).join(', ')],
    p.made && p.made.commits > 1 && ['Commits', String(p.made.commits)],
    p.contributors && p.contributors.length && ['Colaboradores', p.contributors.map(esc).join(', ')],
  ].filter(Boolean);
  return rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}
const links = (p, a) => `${a && a.web ? `<a class="ps-link" href="${esc(a.web)}" target="_blank" rel="noopener">${IC.link}Código no GitHub</a>` : ''}${p.server === STORE ? `<a class="ps-link" href="${esc(issue(p, 'problema'))}" target="_blank" rel="noopener" title="Abre uma issue no repositório de plugins, já com o nome e a versão">${IC.bug}Relatar problema</a><a class="ps-link" href="${esc(issue(p, 'ideia'))}" target="_blank" rel="noopener" title="Abre uma issue com a sua ideia para este plugin">${IC.idea}Sugerir melhoria</a>` : ''}`;
function paintDetail() {
  const el = P.el; if (!el) return;
  const wrap = el.firstElementChild, pane = el.querySelector('.ps-dpane');
  const p = P.sel && catalog().find(x => x.id === P.sel);
  wrap.classList.toggle('has-detail', !!p);
  if (!p) {
    // fechou: o conteúdo some depois que o painel terminou de deslizar
    P.dkey = ''; clearTimeout(P.dclear); P.dclear = setTimeout(() => { if (!P.sel) pane.innerHTML = ''; }, 420);
    return;
  }
  clearTimeout(P.dclear);
  const a = P.about.get(p.id + '@' + p.version), local = bs.plugins.list.find(x => x.id === p.id);
  const key = [p.id, p.version, p.installed, p.update, p.incompatible, p.disk, P.busy.has(p.id), !!a, !!(local && local.user)].join('|');
  if (key === P.dkey) return; // nada mudou para este plugin (digitar na busca, por exemplo): o painel fica como está
  const same = (P.dkey || '').split('|')[0] === p.id && P.dkey.split('|')[7] === String(!!a);
  P.dkey = key;
  if (same && pane.querySelector('.ps-dhead')) {
    // o mesmo plugin mudou de estado (instalou, atualizou): só os botões e a ficha, sem redesenhar o README
    pane.querySelector('.ps-dact').innerHTML = dActions(p, local);
    pane.querySelector('.ps-dnm small').innerHTML = dSub(p);
    pane.querySelector('.ps-facts').innerHTML = facts(p);
    return;
  }
  const swap = (pane.dataset.id || '') !== p.id && pane.innerHTML !== '';
  pane.dataset.id = p.id;
  pane.innerHTML = `<div class="ps-dhead">
      ${bs.plugIcon(p, 'lg')}
      <div class="ps-dnm"><h2>${esc(p.name)}</h2><small>${dSub(p)}</small></div>
      <div class="ps-dact">${dActions(p, local)}</div>
    </div>
    <div class="ps-dbody">
      <p class="ps-desc">${esc(p.description || '')}</p>
      ${byline(p, true)}
      <dl class="ps-facts">${facts(p)}</dl>
      <div class="ps-links">${links(p, a)}</div>
      ${a && a.nodes && a.nodes.length ? `<section class="ps-nodes"><h3>${IC.node}${plural(a.nodes.length, 'nó', 'nós')} no Automator</h3><div>${a.nodes.map(n => `<div class="ps-node"><b>${esc(n.name || '')}</b>${n.desc ? `<p>${esc(n.desc)}</p>` : ''}${n.category && n.category !== p.name ? `<span>${esc(n.category)}</span>` : ''}</div>`).join('')}</div></section>` : ''}
      <article class="md ps-readme">${a ? '' : '<div class="ps-skel" aria-label="Carregando"><i></i><i></i><i></i><i></i><i></i></div>'}</article>
    </div>`;
  const body = pane.querySelector('.ps-dbody'), head = pane.querySelector('.ps-dhead');
  body.onscroll = () => head.classList.toggle('lifted', body.scrollTop > 4);
  if (swap) { pane.classList.remove('swap'); void pane.offsetWidth; pane.classList.add('swap'); }
  if (a) readme(pane.querySelector('.ps-readme'), p, a, pane); else about(p);
}
const dSub = (p) => [`v${esc(p.version)}`, p.installed && p.update ? `você tem a v${esc(p.installed)}` : '', p.made && p.made.last && p.made.last.date ? `atualizado ${esc(when(p.made.last.date))}` : ''].filter(Boolean).join(' · ');
function readme(art, p, a, pane) {
  if (!(a.readme && a.readme.trim())) { art.innerHTML = '<div class="empty">Este plugin não tem README.</div>'; return; }
  // a ficha gerada no repositório (autor, versão, licença...) repete a ficha de cima: fica só no GitHub
  const md = a.readme.replace(/<!-- ficha:inicio[\s\S]*?<!-- ficha:fim -->\s*/, '');
  art.innerHTML = window.DOMPurify ? DOMPurify.sanitize(window.marked ? marked.parse(md, { gfm: true, breaks: false }) : `<pre>${esc(a.readme)}</pre>`, { ADD_ATTR: ['target'] }) : esc(a.readme);
  // o README costuma abrir com a mesma frase da descrição: uma vez só
  const d = (p.description || '').replace(/\s+/g, ' ').trim().slice(0, 60); if (d && art.textContent.replace(/\s+/g, ' ').includes(d)) pane.querySelector('.ps-desc')?.remove();
  // imagens e links relativos apontam para o repositório; os outros abrem no navegador
  const raw = (a.web || '').replace('github.com', 'raw.githubusercontent.com').replace('/tree/', '/');
  art.querySelectorAll('img').forEach(img => { const s = img.getAttribute('src') || ''; if (raw && !/^([a-z]+:|\/\/|data:)/i.test(s)) img.src = raw + '/' + s.replace(/^\.?\//, ''); img.loading = 'lazy'; });
  const secoes = new Map(); art.querySelectorAll('h1, h2, h3, h4').forEach(h => { const k = slug(h.textContent); if (!secoes.has(k)) secoes.set(k, h); });
  art.querySelectorAll('a[href]').forEach(l => { const h = l.getAttribute('href'); if (h.startsWith('#')) { let k = h.slice(1); try { k = decodeURIComponent(k); } catch { /* âncora com % solto */ } const alvo = secoes.get(k.toLowerCase()); l.removeAttribute('href'); if (alvo) { l.classList.add('ps-anchor'); l.onclick = (e) => { e.preventDefault(); alvo.scrollIntoView({ block: 'start', behavior: 'smooth' }); }; } return; } if (!/^[a-z]+:/i.test(h) && a.web) l.href = a.web + '/' + h.replace(/^\.?\//, ''); l.target = '_blank'; l.rel = 'noopener'; });
  const h1 = art.querySelector('h1'); if (h1 && h1.textContent.trim().toLowerCase() === String(p.name).toLowerCase()) h1.remove(); // o nome já está no topo
  art.classList.add('in');
}
// issue no repositório de plugins com o modelo e o campo "plugin" já preenchidos (formulários de issue do GitHub)
const STORE = 'github:martindevbr/BlueScreen-Plugins';
const issue = (p, modelo) => `${REPO}/issues/new?${new URLSearchParams(modelo === 'problema'
  ? { template: 'problema.yml', title: `[${p.id}] `, plugin: `${p.name} ${p.installed || p.version}` }
  : { template: 'ideia.yml', title: `[${p.id}] `, plugin: p.id })}`;
// links do sumário do README (#seção): mesmo formato de âncora do GitHub, rolando dentro da página do plugin
const slug = (t) => t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
async function about(p) {
  const k = p.id + '@' + p.version; if (P.about.has(k) || P.aboutBusy.has(k)) return;
  P.aboutBusy.add(k);
  try { P.about.set(k, await bs.api('plugins/about', { id: p.id }, { quiet: true })); } catch (e) { P.about.set(k, { readme: '', nodes: [], error: e.message }); }
  P.aboutBusy.delete(k);
  if (P.sel === p.id) paintDetail();
}
function select(id) {
  P.sel = id;
  P.el && P.el.querySelectorAll('.ps-card').forEach(c => c.classList.toggle('sel', c.dataset.id === id));
  paintDetail();
  const b = P.el && P.el.querySelector('.ps-dbody'); if (b && id) b.scrollTop = 0;
}
function open(id) {
  bs.openTool('plugins'); bs.pages.open('plugins'); paint(); select(id);
  const c = P.el && P.el.querySelector(`.ps-card[data-id="${CSS.escape(id)}"]`); if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function mount(el) {
  P.el = el; el.classList.add('ps');
  el.innerHTML = `<div class="ps-wrap"><div class="ps-main">
      <header class="ps-top">
        <div class="ps-hero">
          <span class="ps-logo">${IC.store}</span>
          <div class="ps-title"><h1>Loja de plugins</h1><p class="ps-sub"></p></div>
          <div class="ps-tools">
            <a class="ps-link" href="${REPO}" target="_blank" rel="noopener" title="martindevbr/BlueScreen-Plugins">${IC.link}Repositório</a>
            <a class="ps-link" href="${REPO}/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener" title="Como escrever um plugin e mandar para a loja">Publicar um plugin</a>
            <button class="icon-btn" data-a="retry" title="Consultar a loja de novo">${bs.I.refresh}</button>
          </div>
        </div>
        <div class="ps-bar">
          <label class="ps-search">${IC.search}<input type="search" placeholder="Buscar por nome, autor ou assunto" aria-label="Buscar plugin" spellcheck="false"><span class="ps-count"></span></label>
          <span class="seg ps-seg">${TABS.map(([k, t]) => `<button type="button" data-tab="${k}">${t}</button>`).join('')}</span>
        </div>
        <div class="ps-cats" aria-label="Categorias" hidden></div>
      </header>
      <div class="ps-note" hidden></div>
      <div class="ps-scroll"><div class="ps-upbar" hidden></div><div class="ps-grid"></div><div class="ps-empty" hidden></div></div>
    </div>
    <aside class="ps-detail" aria-label="Detalhes do plugin"><div class="ps-dpane"></div></aside></div>`;
  const q = el.querySelector('.ps-search input');
  q.oninput = () => { P.q = q.value; paint(); };
  q.onkeydown = (e) => { if (e.key === 'Escape' && q.value) { e.stopPropagation(); q.value = ''; P.q = ''; paint(); } };
  el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]'); if (tab) { P.tab = tab.dataset.tab; return paint(); }
    const cat = e.target.closest('[data-cat]'); if (cat) { P.cat = cat.dataset.cat; return paint(); }
    const a = e.target.closest('[data-a]'), c = e.target.closest('.ps-card');
    const p = catalog().find(x => x.id === (c ? c.dataset.id : P.sel));
    if (a) {
      const act = a.dataset.a;
      if (act === 'install' && p) return install([p]);
      if (act === 'upall') return install(updates());
      if (act === 'retry') return check(true, false);
      if (act === 'close') return select(null);
      if (act === 'remove' && p) { const l = bs.plugins.list.find(x => x.id === p.id); return l && bs.pluginRemove(l); }
      return;
    }
    if (c && !e.target.closest('a')) select(P.sel === c.dataset.id ? null : c.dataset.id);
  });
  el.addEventListener('keydown', (e) => {
    const c = e.target.closest && e.target.closest('.ps-card');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(c.dataset.id); }
    if (e.key === 'Escape' && P.sel) { e.stopPropagation(); select(null); }
  });
  el.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.ps-card'); if (!c) return;
    const p = catalog().find(x => x.id === c.dataset.id); if (!p) return;
    bs.showMenu(e, [
      ...(p.update ? [{ label: `Atualizar para v${p.version}`, icon: IC.up, action: () => install([p]) }] : !p.installed ? [{ label: 'Instalar', icon: IC.down, action: () => install([p]) }] : []),
      { label: 'Ver detalhes', icon: IC.store, action: () => select(p.id) },
      '-', { label: 'Copiar id', icon: bs.I.copy, action: () => bs.copyText(p.id) },
    ], `${p.name} v${p.version}`);
  });
  paint();
}

bs.pluginStore = { check, decorate, menu, install, open, get state() { return P.remote; } };
if (!bs.doc) {
  // a loja é a aba fixa do painel Plugins: o painel (app.js) ganha a tela
  const tool = bs.tools.get('plugins'); if (tool) tool.page = 'plugins';
  bs.pages.register({ id: 'plugins', title: 'Loja de plugins', icon: IC.store, pinned: true, render: mount, show() { paint(); if (!P.loading && (!P.remote || Date.now() - P.at > 120000)) check(false); } });
  // consulta logo depois de abrir, de meia em meia hora e ao voltar para a janela depois de um tempo
  setTimeout(() => check(false), 4000);
  setInterval(() => check(true), 30 * 60000);
  window.addEventListener('focus', () => { if (Date.now() - P.at > 10 * 60000) check(true); });
}
bs.actions.add([
  { label: 'Loja de plugins', icon: IC.store, run: () => { bs.openTool('plugins'); } },
  { label: 'Plugins: procurar atualizações', icon: bs.I.plug, run: () => check(true, false) },
]);
})(window.BS);
