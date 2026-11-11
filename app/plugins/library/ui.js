/* Biblioteca: o catálogo dos servidores de plugins com busca e favoritos. Os favoritos formam uma coleção, um
   arquivo que a equipe troca para todos terem os mesmos plugins. Servidores, download e conferência de versão e
   hash são os da aba Plugins (núcleo): aqui não há outra loja, só outra forma de ver e compartilhar. */
const svg = (d, fill = 'none') => `<svg class="i" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const STAR = '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>';
const IC = {
  app: svg('<rect x="3" y="4" width="4.5" height="16" rx="1"/><rect x="9.75" y="4" width="4.5" height="16" rx="1"/><path d="M17 5.5l3.8 14"/>'),
  star: svg(STAR), starOn: svg(STAR, 'currentColor'), more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  down: svg('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'), ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};
const esc = bs.esc;
const L = { servers: [], plugins: [], favorites: [], q: '', tab: 'all', busy: new Set(), loaded: false, error: '' };
let root;
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { bs.toast('Biblioteca: ' + e.message, 'err'); } };
const post = (route, b) => bs.api(route, {}, { method: 'POST', body: JSON.stringify(b) });
const host = (u) => String(u || '').replace(/^https?:\/\//, '');
const isFav = (p) => L.favorites.includes(p.id);
const missing = () => L.plugins.filter(p => isFav(p) && !p.installed);

async function refresh(fresh = false) {
  try {
    const r = await bs.api('plugins/remote', fresh ? { fresh: '1' } : {}, { quiet: true });
    L.servers = r.servers || []; L.plugins = r.plugins || []; L.error = '';
  } catch (e) { L.error = e.message; }
  L.loaded = true; paint();
}
async function install(list) {
  list = list.filter(p => !L.busy.has(p.id)); if (!list.length) return;
  list.forEach(p => L.busy.add(p.id)); paint();
  let done = 0;
  for (const p of list) {
    try { await post('plugins/install', { server: p.server, id: p.id, version: p.version }); await bs.plugins.reload(p.id); done++; }
    catch (e) { bs.toast(`${p.name || p.id}: ${e.message}`, 'err'); }
    L.busy.delete(p.id);
  }
  if (done) bs.toast(done > 1 ? `${done} plugins instalados.` : `${list[0].name || list[0].id} instalado.`, 'ok');
  await refresh(true);
}
const setFav = guard(async (id, on) => { L.favorites = on ? [...new Set([...L.favorites, id])] : L.favorites.filter(x => x !== id); paint(); await plugin.data.set('favorites', L.favorites); });

function exportCollection() {
  const favs = L.plugins.filter(isFav);
  if (!favs.length) return bs.toast('Marque com a estrela os plugins que entram na coleção.', 'err');
  const used = new Set(favs.map(p => p.server));
  const data = { format: 'bluescreen-plugin-collection', version: 1, servers: L.servers.filter(s => used.has(s.url)).map(s => ({ url: s.url })), plugins: favs.map(p => ({ id: p.id, name: p.name, server: p.server })) };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'colecao-de-plugins.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importCollection(file) {
  const c = JSON.parse(await file.text());
  if (c?.format !== 'bluescreen-plugin-collection' || !Array.isArray(c.plugins) || !Array.isArray(c.servers)) throw new Error('o arquivo não é uma coleção de plugins do BlueScreen.');
  const urls = c.servers.map(s => String(s?.url || '')).filter(u => /^https?:\/\//i.test(u)), ids = c.plugins.map(p => p?.id).filter(id => typeof id === 'string' && id);
  const have = new Set(L.servers.map(s => s.url)), fresh = urls.filter(u => !have.has(u));
  // servidor novo é de onde o código dos plugins vai ser baixado: a pessoa vê o endereço antes de aceitar
  const html = `<div class="dlg-hd"><div class="dlg-ic">${IC.app}</div><div><h3>Importar coleção</h3><p>${ids.length} plugin${ids.length === 1 ? '' : 's'} entra${ids.length === 1 ? '' : 'm'} nos favoritos. Nada é instalado agora.</p></div></div>
    ${fresh.length ? `<p class="lb-dlg-p">A coleção também aponta ${fresh.length === 1 ? 'este servidor novo' : 'estes servidores novos'}. Só aceite se confia em quem mandou o arquivo:</p><ul class="lb-dlg-list">${fresh.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="lbImpOk">${fresh.length ? 'Adicionar servidores e favoritos' : 'Adicionar aos favoritos'}</button></div>`;
  dialog('lbImp', html, (box) => {
    box.querySelector('#lbImpOk').onclick = guard(async () => {
      box.hidden = true;
      if (fresh.length) await post('plugins/servers', { servers: [...L.servers.map(s => ({ url: s.url })), ...fresh.map(url => ({ url }))] });
      L.favorites = [...new Set([...L.favorites, ...ids])]; await plugin.data.set('favorites', L.favorites);
      L.tab = 'fav'; await refresh(true);
    });
  });
}
const addServer = guard(async (url) => { await post('plugins/servers', { servers: [...L.servers.map(s => ({ url: s.url })), { url }] }); await refresh(true); });

function paint() {
  if (!root) return;
  root.querySelectorAll('.lb-seg button').forEach(b => b.classList.toggle('on', b.dataset.tab === L.tab));
  const q = L.q.trim().toLowerCase();
  const list = L.plugins.filter(p => (L.tab === 'all' || (L.tab === 'fav' ? isFav(p) : !!p.installed)) && (!q || [p.name, p.description, p.author, p.id].join(' ').toLowerCase().includes(q)));
  const bad = L.servers.filter(s => !s.ok), miss = missing();
  const note = root.querySelector('.lb-note');
  note.innerHTML = [
    L.error ? `<p class="lb-warn">Não deu para consultar os servidores: ${esc(L.error)}</p>` : '',
    ...bad.map(s => `<p class="lb-warn">${esc(host(s.url))} não respondeu: ${esc(s.error || 'sem resposta')}</p>`),
    miss.length ? `<p class="lb-miss"><span>${miss.length === 1 ? '1 favorito ainda não está instalado' : miss.length + ' favoritos ainda não estão instalados'}</span><button class="chip primary" data-a="missing" type="button">${IC.down}<span>Instalar ${miss.length === 1 ? '' : 'todos'}</span></button></p>` : '',
  ].join('');
  note.hidden = !note.innerHTML;
  const cards = root.querySelector('.lb-cards'), empty = root.querySelector('.lb-empty');
  cards.innerHTML = list.map(p => {
    const busy = L.busy.has(p.id), label = busy ? 'Instalando…' : p.update ? `Atualizar para v${esc(p.version)}` : p.installed ? 'Instalado' : 'Instalar';
    return `<article class="lb-card" data-id="${esc(p.id)}">
      <header>${bs.plugIcon(p)}<div class="lb-nm"><b title="${esc(p.name || p.id)}">${esc(p.name || p.id)}</b><small>v${esc(p.update && p.installed ? p.installed : p.version)}${p.author ? ' · ' + esc(p.author) : ''}</small></div>
        <button class="icon-btn lb-fav${isFav(p) ? ' on' : ''}" data-a="fav" type="button" title="${isFav(p) ? 'Tirar dos favoritos' : 'Favoritar (entra na coleção)'}" aria-pressed="${isFav(p)}">${isFav(p) ? IC.starOn : IC.star}</button></header>
      <p title="${esc(p.description || '')}">${esc(p.description || 'Sem descrição.')}</p>
      <footer><span class="lb-src" title="${esc(p.server)}">${esc(host(p.server))}</span><button class="chip${p.installed && !p.update ? ' lb-done' : ' primary'}" data-a="install" type="button" ${busy || (p.installed && !p.update) ? 'disabled' : ''}>${p.installed && !p.update ? IC.ok : IC.down}<span>${label}</span></button></footer>
    </article>`;
  }).join('');
  const none = !list.length;
  empty.hidden = !none; cards.hidden = none;
  if (none) {
    const noServer = L.loaded && !L.servers.length;
    empty.innerHTML = !L.loaded ? '<p>Consultando os servidores…</p>'
      : noServer ? `<b>Nenhum servidor de plugins ainda</b><p>Aponte o servidor da sua equipe para ver o catálogo dele aqui. É a mesma lista de servidores da aba Plugins.</p><form class="lb-add"><input name="url" type="text" placeholder="http://servidor:4900" spellcheck="false" required><button class="chip primary" type="submit">Adicionar</button></form>`
      : `<p>${L.tab === 'fav' ? (q ? 'Nenhum favorito com esse nome.' : 'Nenhum favorito ainda. Marque um plugin com a estrela.') : L.tab === 'inst' ? 'Nenhum plugin dos servidores está instalado.' : q ? 'Nenhum plugin com esse nome.' : 'Os servidores não têm plugins publicados.'}</p>`;
    const f = empty.querySelector('form'); if (f) f.onsubmit = (e) => { e.preventDefault(); addServer(f.url.value.trim()); };
  }
}
function mount(pane) {
  root = pane; pane.classList.add('lb');
  pane.innerHTML = `<header class="lb-bar">
      <input class="lb-search" type="search" placeholder="Buscar plugin" aria-label="Buscar plugin" spellcheck="false">
      <span class="seg lb-seg"><button type="button" data-tab="all">Todos</button><button type="button" data-tab="fav">Favoritos</button><button type="button" data-tab="inst">Instalados</button></span>
      <button class="icon-btn" data-a="refresh" type="button" title="Consultar os servidores de novo">${bs.I.refresh}</button><button class="icon-btn" data-a="more" type="button" title="Coleção e servidores">${IC.more}</button>
    </header>
    <div class="lb-note" hidden></div>
    <div class="lb-body"><div class="lb-cards"></div><div class="lb-empty" hidden></div></div>
    <input type="file" class="lb-file" accept=".json,application/json" hidden>`;
  const file = pane.querySelector('.lb-file');
  file.onchange = guard(async () => { const f = file.files[0]; file.value = ''; if (f) await importCollection(f); });
  pane.querySelector('.lb-search').oninput = (e) => { L.q = e.target.value; paint(); };
  pane.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]'); if (tab) { L.tab = tab.dataset.tab; return paint(); }
    const b = e.target.closest('[data-a]'); if (!b) return;
    const p = L.plugins.find(x => x.id === b.closest('.lb-card')?.dataset.id);
    if (b.dataset.a === 'fav' && p) setFav(p.id, !isFav(p));
    else if (b.dataset.a === 'install' && p) install([p]);
    else if (b.dataset.a === 'missing') install(missing());
    else if (b.dataset.a === 'refresh') guard(refresh)(true);
    else if (b.dataset.a === 'more') { const r = b.getBoundingClientRect(); bs.showMenu({ clientX: r.right - 230, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [
      { label: 'Exportar coleção (favoritos)', action: exportCollection }, { label: 'Importar coleção…', action: () => file.click() }, '-',
      { label: 'Servidores de plugins…', icon: bs.I.plug, k: 'aba Plugins', action: () => bs.openTool('plugins') }]); }
  });
  paint();
}
bs.bubble.register({ id: 'library', title: 'Biblioteca de plugins', icon: IC.app, order: 63, width: 900, height: 660, render: mount,
  show: guard(async () => { if (!L.loaded) L.favorites = (await plugin.data.get('favorites', [])) || []; await refresh(); }) });
bs.actions.add([{ label: 'Biblioteca: catálogo e coleções de plugins', icon: IC.app, run: () => bs.bubble.open('library') }]);
plugin.onUnload(() => document.getElementById('lbImp')?.remove());
