/* BlueScreen: servidores de plugins (plugins/remote.rs e app/plugin-server). A aba Plugins (Alt+7) ganha os
   servidores apontados, os plugins que eles oferecem (Instalar) e, nos instalados, "Atualizar para vX". Alguns
   segundos depois de abrir, e de meia em meia hora, a IDE pergunta aos servidores: havendo versão maior de um
   plugin instalado, aparece o selo "Plugins" no topo e o número na aba, e eles ficam lá até atualizar.
   Os servidores são só de leitura (nada é publicado daqui). Botão direito num plugin: atualizar e desinstalar. */
(function (bs) {
const { $, esc, store, toast } = bs;
const P = { remote: null, busy: new Set(), at: 0 };
const post = (path, body) => bs.api(path, {}, { method: 'POST', body: JSON.stringify(body || {}) });
const IC = {
  up: '<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  server: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
};

// selo no topo, ao lado do de atualização do BlueScreen
const pill = document.createElement('button');
pill.id = 'plugPill'; pill.className = 'chip'; pill.hidden = true;
pill.innerHTML = `${IC.up}<span class="pp-txt">Plugins</span>`;
($('#updPill') || $('#btnNet')).before(pill);
pill.onclick = () => bs.openTool('plugins');

const updates = () => (P.remote && P.remote.plugins || []).filter(p => p.update);
function mark() {
  const n = updates().length;
  pill.hidden = !n;
  pill.querySelector('.pp-txt').textContent = n === 1 ? `${updates()[0].name} v${updates()[0].version}` : `${n} plugins para atualizar`;
  pill.title = updates().map(p => `${p.name}: v${p.installed} → v${p.version}`).join('\n');
  const b = $('#badge-plugins'); if (b) { b.hidden = !n; b.textContent = n; }
}
async function check(fresh, quiet = true) {
  try {
    P.remote = await bs.api('plugins/remote', { fresh: fresh ? '1' : null }); P.at = Date.now();
    const before = pill.hidden; mark();
    if (before && !pill.hidden) { pill.classList.remove('up-enter'); void pill.offsetWidth; pill.classList.add('up-enter'); }
    if (bs.S.tool === 'plugins') bs.renderTool();
    if (!quiet) toast(updates().length ? `${updates().length} atualização(ões) de plugin` : 'Plugins atualizados', 'ok');
  } catch (e) { if (!quiet) toast('Servidores de plugins: ' + e.message); }
}

// instala/atualiza (um ou vários) e recarrega a página para os plugins novos entrarem
async function install(list) {
  if (!list.length) return;
  list.forEach(p => P.busy.add(p.id)); if (bs.S.tool === 'plugins') bs.renderTool();
  let done = 0;
  for (const p of list) {
    try { toast(`Instalando ${p.name} v${p.version}…`, '', 'plug-inst'); await post('plugins/install', { server: p.server, id: p.id, version: p.version }); done++; }
    catch (e) { toast(`${p.name}: ${e.message}`); }
    P.busy.delete(p.id);
  }
  if (!done) { if (bs.S.tool === 'plugins') bs.renderTool(); return; }
  store.set('reopenTool', 'plugins'); toast(done > 1 ? `${done} plugins instalados. Recarregando…` : 'Plugin instalado. Recarregando…', 'ok');
  reloadSaved(400); // grava as abas com alterações antes (app.js)
}
async function setServers(list) {
  try { await post('plugins/servers', { servers: list }); await check(true); }
  catch (e) { toast(e.message); }
}
const servers = () => (P.remote && P.remote.servers) || [];

// ----- aba Plugins: acrescenta versão, origem, atualização, catálogo e servidores -----
function decorate(body) {
  const r = P.remote, rp = new Map(((r && r.plugins) || []).map(p => [p.id, p]));
  // linhas dos instalados: versão, de onde veio e "Atualizar"
  body.querySelectorAll('.plug[data-id]').forEach(el => {
    const p = bs.plugins.list.find(x => x.id === el.dataset.id), o = rp.get(el.dataset.id); if (!p) return;
    const nm = el.querySelector('.nm');
    nm.insertAdjacentHTML('beforeend', `<span class="pl-ver">v${esc(p.version)}</span>${p.origin && p.origin.server ? `<span class="pl-src" title="Instalado de ${esc(p.origin.server)}">${IC.server}${esc(p.origin.server.replace(/^https?:\/\//, ''))}</span>` : ''}`);
    if (o && o.update) {
      const b = document.createElement('button'); b.className = 'chip pl-upd'; b.disabled = P.busy.has(p.id);
      b.innerHTML = `${IC.up}${P.busy.has(p.id) ? 'Atualizando…' : 'Atualizar para v' + esc(o.version)}`;
      b.title = `v${p.version} → v${o.version} (${o.server})`;
      b.onclick = (e) => { e.stopPropagation(); install([o]); };
      el.querySelector('.tx').appendChild(b); el.classList.add('has-upd');
    }
  });
  const ups = updates();
  if (ups.length > 1) {
    body.insertAdjacentHTML('afterbegin', `<div class="pl-banner">${IC.up}<span>${ups.length} plugins têm versão nova</span><button class="chip" data-all>Atualizar todos</button></div>`);
    body.querySelector('[data-all]').onclick = () => install(ups);
  }
  // catálogo: o que os servidores oferecem e ainda não está instalado
  const avail = ((r && r.plugins) || []).filter(p => !p.installed);
  let html = '';
  if (avail.length) html += `<div class="pl-sec">Disponíveis nos servidores</div>` + avail.map(p => `
    <div class="plug pl-remote" data-rid="${esc(p.id)}" title="${esc(p.description || '')}">${bs.plugIcon(p)}
      <div class="tx"><div class="nm"><span class="pl-name">${esc(p.name)}</span><span class="pl-ver">v${esc(p.version)}</span><span class="pl-src">${IC.server}${esc(p.server.replace(/^https?:\/\//, ''))}</span></div><div class="ds">${esc(p.description || '')}</div>
      <button class="chip pl-upd" data-inst ${P.busy.has(p.id) ? 'disabled' : ''}>${IC.down}${P.busy.has(p.id) ? 'Instalando…' : 'Instalar'}</button></div></div>`).join('');
  // servidores apontados
  html += `<div class="pl-sec">Servidores de plugins <button class="icon-btn" data-recheck title="Procurar atualizações agora">${bs.I.refresh}</button></div>`
    + servers().map(s => `<div class="pl-srv" data-url="${esc(s.url)}"><span class="pl-dot ${s.ok ? 'ok' : 'err'}"></span>
        <div class="tx"><div class="nm">${esc(s.name || s.url)}</div><div class="ds">${esc(s.url)} · ${s.ok ? `${s.count} plugin${s.count === 1 ? '' : 's'}` : esc(s.error || 'sem resposta')}</div></div>
        <button class="icon-btn" data-del title="Deixar de usar este servidor">${bs.I.x}</button></div>`).join('')
    + (r ? '' : '<div class="pl-hint">Consultando os servidores…</div>')
    + `<form class="pl-add" data-add><input name="url" placeholder="Endereço do servidor (ex.: http://servidor:4900)" spellcheck="false" required><button class="chip">Adicionar</button></form>`;
  const box = document.createElement('div'); box.className = 'pl-store'; box.innerHTML = html; body.appendChild(box);
  box.querySelectorAll('[data-rid]').forEach(el => { const p = rp.get(el.dataset.rid); el.querySelector('[data-inst]').onclick = () => install([p]); });
  box.querySelector('[data-recheck]').onclick = () => check(true, false);
  box.querySelectorAll('.pl-srv').forEach(el => {
    const url = el.dataset.url;
    el.querySelector('[data-del]').onclick = () => setServers(servers().filter(s => s.url !== url).map(s => ({ url: s.url })));
  });
  box.querySelector('[data-add]').onsubmit = (e) => {
    e.preventDefault(); const f = e.target;
    const add = { url: f.url.value.trim() };
    toast('Consultando ' + add.url + '…', '', 'plug-srv');
    setServers([...servers().map(s => ({ url: s.url })), add]);
  };
  // o painel abriu e a última consulta é velha: pergunta de novo
  if (!r || Date.now() - P.at > 120000) { P.at = Date.now(); check(false); }
}
// itens extras no botão direito de um plugin instalado
function menu(p) {
  const items = [];
  const o = P.remote && P.remote.plugins.find(x => x.id === p.id);
  if (o && o.update) items.push({ label: `Atualizar para v${o.version}`, icon: bs.I.refresh, action: () => install([o]) });
  return items.length ? ['-', ...items] : [];
}

bs.pluginStore = { check, decorate, menu, install, get state() { return P.remote; } };
// consulta logo depois de abrir, de meia em meia hora e ao voltar para a janela depois de um tempo
if (!bs.doc) {
  setTimeout(() => check(false), 4000);
  setInterval(() => check(true), 30 * 60000);
  window.addEventListener('focus', () => { if (Date.now() - P.at > 10 * 60000) check(true); });
}
bs.actions.add([{ label: 'Plugins: procurar atualizações nos servidores', icon: bs.I.plug, run: () => check(true, false) }]);
})(window.BS);
