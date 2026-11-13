/* BlueScreen: Cofre (plugins/vault.rs). Tokens que você guarda uma vez e libera para os plugins que quiser.
   O valor nunca passa por esta tela: é digitado numa janela nativa do Windows aberta pelo núcleo, com os campos que o
   plugin pediu (token, usuário e senha...; "fields" no plugin.json), e fica cifrado (DPAPI).
   Gravar, liberar um plugin e acrescentar sites ou programas pedem um "Sim" numa caixa nativa do Windows, que o
   JavaScript da página não clica; tirar acesso e apagar não pedem. Abre pelo ícone da chave na barra da esquerda
   (Alt+8), pela faixa no topo da aba Plugins, pelo Buscar em tudo ("Cofre") e por plugin.vault.request(nome). */
(function (bs) {
if (bs.doc) return;
const { $, esc, toast, api } = bs;
const KEY = '<svg class="i" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M14 9l2 2"/></svg>';
const V = { data: null, focus: null, form: null, edit: null, adding: false, openEnt: new Set() };

const post = async (body, wait) => {
  // as ações que ampliam acesso esperam o "Sim" na caixa do Windows
  if (wait) toast(body.action === 'enter' ? 'Digite na janela do Windows…' : 'Confirme na janela do Windows…', '', 'vault-ask');
  V.data = await api('vault', {}, { method: 'POST', body: JSON.stringify(body) });
  return V.data;
};
const load = async () => { V.data = await api('vault'); mark(); return V.data; };
const pending = () => (V.data ? V.data.requests : []).filter(r => !r.granted || (r.reveal && !r.revealGranted));
// número no ícone da barra lateral e faixa da aba Plugins: pedidos de plugins ainda não liberados; e a tela de
// configuração de um plugin (gate) aberta é redesenhada se o que ela mostra mudou
function mark() {
  const n = pending().filter(r => !r.granted).length;
  const b = $('#badge-vault'); if (b) { b.hidden = !n; b.textContent = n; }
  const ban = $('.vt-wrap'); if (ban) ban.outerHTML = banner();
  bindBanner(document);
  const t = G.tool && bs.tools.get(G.tool);
  if (t && bs.S.tool === G.tool && gateSig(t.plugin) !== G.sig) bs.renderTool();
}
// faixa no topo da aba Plugins: o que tem no cofre e o que os plugins pedem
function banner() {
  const d = V.data; const n = d ? d.entries.length : 0; const p = pending().filter(r => !r.granted).length;
  const sub = !d ? 'Tokens e senhas que os plugins usam sem ver o valor.' : `${n ? `${n} credencia${n > 1 ? 'is' : 'l'} guardada${n > 1 ? 's' : ''}` : 'Nada guardado ainda'}${p ? ` · <b>${p} pedido${p > 1 ? 's' : ''} de plugin</b>` : ''}`;
  return `<div class="vt-wrap"><div class="vt-banner ${p ? 'ask' : ''}"><span class="vt-key">${KEY}</span><div class="vt-tx"><div class="vt-bt">Cofre de credenciais</div><div class="vt-bs">${sub}</div></div><button class="chip ${p ? 'primary' : ''}" data-vault-open>Abrir cofre</button></div></div>`;
}
function bindBanner(root) { root.querySelectorAll('[data-vault-open]').forEach(b => b.onclick = () => open()); }

const chips = (list, empty) => list && list.length ? list.map(h => `<span class="vt-chip">${esc(h)}</span>`).join('') : `<span class="vt-none">${esc(empty)}</span>`;
// campos que o plugin pede (token, usuário e senha...): os rótulos para mostrar e a união de vários pedidos
const TOKEN = [{ key: 'value', label: 'Token', secret: true }];
// tipos prontos (token, usuário e senha, AWS, chave PEM...): vêm do núcleo (vault.rs, KINDS)
const kinds = () => (V.data && V.data.kinds) || [{ id: 'token', label: 'Um token (ou chave de API)', fields: TOKEN }];
const kindChips = (id) => ((kinds().find(k => k.id === id) || kinds()[0]).fields || []).map(x => `<span class="vt-chip">${esc(x.label || x.key)}${x.optional ? ' (opcional)' : ''}</span>`).join('');
const fieldsTxt = (f) => (f && f.length ? f : TOKEN).map(x => typeof x === 'string' ? x : x.label || x.key).join(' + ');
const mergeFields = (list) => { const out = []; for (const r of list) for (const f of r.fields || []) if (!out.some(x => x.key === f.key)) out.push(f); return out; };
const pname = (id) => (bs.plugins.list.find(p => p.id === id) || { name: id }).name;
const picon = (id) => bs.plugIcon(bs.plugins.list.find(p => p.id === id) || { id, name: id }, 'vt-pi');

// ----- a janela: o que os plugins esperam (um botão resolve cada pedido), as credenciais guardadas e "Nova credencial" -----
// O dia a dia cabe em três gestos: Guardar (o que um plugin pediu), Trocar o valor e Apagar. Sites, programas e
// "ver o valor" ficam em Detalhes, para quem precisa.
const stateOf = (r) => !r.exists ? 'new' : !r.granted ? 'allow' : 'reveal';
function requestCard(g) {
  const r = g.list[0], many = g.list.length > 1, st = stateOf(r);
  const same = st === 'new' ? [...new Set(g.list.flatMap(x => x.sameHosts || []))] : [];
  const what = r.label || r.key;
  const title = many ? `<b>${g.list.length} plugins</b> precisam de ${esc(fieldsTxt(mergeFields(g.list)).toLowerCase())} de ${chips(g.hosts)}`
    : st === 'reveal' ? `<b>${esc(r.pluginName)}</b> quer ler o valor de <b>${esc(r.entry || r.key)}</b>` : `<b>${esc(r.pluginName)}</b> precisa de <b>${esc(what)}</b>`;
  const btn = st === 'new' ? `${same.map(n => `<button class="chip primary" data-use="${esc(n)}" title="Já existe uma credencial para este site">Usar “${esc(n)}”</button>`).join('')}<button class="chip ${same.length ? '' : 'primary'}" data-go>${KEY}${same.length ? 'Guardar outra…' : 'Guardar…'}</button>`
    : st === 'allow' ? '<button class="chip primary" data-go>Permitir</button>' : '<button class="chip" data-go>Deixar ler</button>';
  const hint = st === 'new' ? (many ? 'Uma credencial só serve a todos.' : '') : st === 'allow' ? `Você já tem <b>${esc(r.entry || r.key)}</b> guardada: falta permitir este plugin.` : '';
  const warn = g.list.some(x => x.reveal) ? (st === 'reveal' ? 'O plugin passa a enxergar o valor. Só permita se confia nele.' : 'Este plugin também pede para ler o valor (você decide depois de guardar).') : '';
  return `<div class="vt-req ${V.focus && g.list.some(x => x.plugin === V.focus.plugin && x.key === V.focus.key) ? 'focus' : ''}" data-rq="${esc(g.list.map(x => x.plugin + '\u0001' + x.key).join('\u0002'))}">
    ${many ? `<span class="vt-key">${KEY}</span>` : picon(r.plugin)}
    <div class="vt-tx"><div>${title}</div>
      ${many ? `<div class="vt-why">${g.list.map(x => esc(x.pluginName)).join(', ')}</div>` : r.why ? `<div class="vt-why">${esc(r.why)}</div>` : ''}
      ${hint ? `<div class="vt-why">${hint}</div>` : ''}${warn ? `<div class="vt-warn">${warn}</div>` : ''}</div>
    <div class="vt-gbtns">${btn}</div></div>`;
}
// pedidos ainda sem credencial para os mesmos sites: um cartão só (um token serve a todos)
const hostKey = (r) => (r.hosts || []).map(h => String(h).toLowerCase()).sort().join(',');
function grouped(reqs) {
  const out = [], by = new Map();
  for (const r of reqs) {
    const k = !r.exists && hostKey(r);
    if (!k) { out.push({ list: [r] }); continue; }
    if (!by.has(k)) { const g = { hosts: r.hosts, list: [] }; by.set(k, g); out.push(g); }
    by.get(k).list.push(r);
  }
  return out;
}
// nome para a credencial comum: o fim igual dos nomes (rastro.dynatrace, drilltrace.dynatrace -> dynatrace) ou o site
function suggestName(list) {
  if (list.length === 1) return list[0].key;
  const tails = list.map(r => r.key.split(/[.\-_:]/).pop().toLowerCase());
  if (tails.every(t => t === tails[0]) && tails[0].length > 2) return tails[0];
  const h = String((list[0].hosts || [])[0] || '').replace(/^\*\./, '').split('.');
  return h.length > 1 ? h[h.length - 2] : list[0].key;
}
function entryCard(e) {
  const grants = Object.entries(e.grants || {}).filter(([, g]) => g.use || g.reveal);
  const open = V.openEnt.has(e.name), editing = V.edit === e.name;
  const others = bs.plugins.list.filter(p => !grants.some(([id]) => id === p.id));
  const used = e.lastUsed ? `usada ${esc(bs.ago(e.lastUsed))} por ${esc(pname(e.lastBy))}` : 'ainda não foi usada';
  return `<div class="vt-ent${open ? ' open' : ''}" data-name="${esc(e.name)}">
    <div class="vt-hd"><span class="vt-key">${KEY}</span><div class="vt-tx"><div class="vt-nm"><b>${esc(e.label || e.name)}</b>${e.label ? `<code>${esc(e.name)}</code>` : ''}</div>
      <div class="vt-meta">${e.fields && e.fields.length > 1 ? `${esc(e.fields.map(f => f.label || f.key).join(' + '))} · ` : ''}trocada ${esc(bs.ago(e.updated))} · ${used}</div></div>
      <div class="vt-acts"><button class="chip" data-act="change" title="Abre a janela do Windows para digitar o valor novo">Trocar valor</button><button class="icon-btn" data-act="del" title="Apagar do cofre">${TRASH}</button></div></div>
    <div class="vt-use">${grants.length ? `<span class="vt-ul">Quem usa</span>${grants.map(([id, g]) => `<span class="vt-pl" data-plugin="${esc(id)}" title="${esc(pname(id))}${g.as && g.as !== e.name ? ' (chama de ' + esc(g.as) + ')' : ''}${g.reveal ? ' · lê o valor' : ''}">${picon(id)}<span>${esc(pname(id))}</span>${g.reveal ? '<i class="vt-eye" title="Este plugin lê o valor">lê o valor</i>' : ''}<button data-g="off" title="Tirar o acesso de ${esc(pname(id))}">${bs.I.x}</button></span>`).join('')}` : '<span class="vt-none">Nenhum plugin usa ainda.</span>'}
      <button class="vt-more" data-act="more" aria-expanded="${open}">${open ? 'Menos' : 'Detalhes'}</button></div>
    ${!open ? '' : `<div class="vt-det">
      ${editing ? `<label class="fld">Descrição<input data-f="label" value="${esc(e.label || '')}" spellcheck="false"></label>
        <label class="fld">Sites para onde ela pode ir <small class="pl-help">separados por vírgula; *.dominio.com vale para os subdomínios</small><input data-f="hosts" value="${esc((e.hosts || []).join(', '))}" spellcheck="false" placeholder="api.github.com"></label>
        <label class="fld">Programas que podem recebê-la <small class="pl-help">numa variável de ambiente: gh, git</small><input data-f="programs" value="${esc((e.programs || []).join(', '))}" spellcheck="false"></label>
        <label class="fld">Anotação<input data-f="note" value="${esc(e.note || '')}" spellcheck="false"></label>
        <div class="vt-btns"><button class="chip" data-act="cancel">Cancelar</button><button class="chip primary" data-act="save">Salvar</button></div>`
      : `<div class="vt-row"><span class="vt-rl">Sites</span>${chips(e.hosts, 'nenhum')}</div>
        <div class="vt-row"><span class="vt-rl">Programas</span>${chips(e.programs, 'nenhum')}</div>
        ${e.note ? `<div class="vt-row"><span class="vt-rl">Anotação</span><span>${esc(e.note)}</span></div>` : ''}
        ${grants.map(([id, g]) => `<label class="chk vt-chk" data-plugin="${esc(id)}"><input type="checkbox" data-g="reveal" ${g.reveal ? 'checked' : ''}> ${esc(pname(id))} pode ler o valor <span class="vt-mut">(só para plugins em que você confia)</span></label>`).join('')}
        <div class="vt-btns left">${others.length ? `<select class="vt-add" aria-label="Liberar para um plugin"><option value="">Liberar para um plugin…</option>${others.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>` : ''}<button class="chip" data-act="edit">Editar sites e programas</button></div>`}
    </div>`}</div>`;
}
const TRASH = '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
function newForm() {
  const f = V.form || {};
  return `<div class="vt-new"><div class="vt-nt"><b>Nova credencial</b><span>O valor é digitado numa janela do Windows e vai direto para o cofre.</span></div>
    <div class="vt-2"><label class="fld">Nome<input id="vtName" value="${esc(f.name || '')}" spellcheck="false" placeholder="github" autocomplete="off"></label>
      <label class="fld">O que é<select id="vtKind">${kinds().map(k => `<option value="${esc(k.id)}" ${k.id === (f.kind || 'token') ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></label></div>
    <details class="vt-adv" ${f.adv ? 'open' : ''}><summary>Onde ela pode ser usada</summary>
      <label class="fld">Descrição<input id="vtLabel" value="${esc(f.label || '')}" spellcheck="false" placeholder="Token do GitHub"></label>
      <label class="fld">Sites <small class="pl-help">para onde o token pode ir, em HTTPS: api.github.com, *.atlassian.net</small><input id="vtHosts" value="${esc((f.hosts || []).join(', '))}" spellcheck="false"></label>
      <label class="fld">Programas <small class="pl-help">recebem o token numa variável de ambiente: gh, git</small><input id="vtProgs" value="${esc((f.programs || []).join(', '))}" spellcheck="false"></label>
      <p class="vt-why">Em branco, você libera depois, quando um plugin pedir.</p></details>
    <p class="err" id="vtErr"></p>
    <div class="vt-btns"><button class="chip" id="vtCancel">Cancelar</button><button class="chip primary" id="vtPaste">${KEY}Digitar e guardar…</button></div></div>`;
}

function render() {
  const d = V.data || { entries: [], requests: [], audit: [] };
  const reqs = grouped(pending());
  return `<div class="dlg-hd"><span class="dlg-ic">${KEY}</span><div><h3>Cofre de credenciais</h3><p>Tokens e senhas guardados neste PC, cifrados. Os plugins usam sem ver o valor.</p></div></div>
    <div class="vt-body">
    ${reqs.length ? `<div class="vt-sub">Esperando você <span class="vt-n">${reqs.length}</span></div>${reqs.map(requestCard).join('')}` : ''}
    <div class="vt-sub">Guardadas${d.entries.length ? ` <span class="vt-n">${d.entries.length}</span>` : ''}<span class="spacer"></span>${V.adding ? '' : `<button class="chip vt-plus" id="vtAdd">${PLUS}Nova credencial</button>`}</div>
    ${V.adding ? newForm() : ''}
    ${d.entries.length ? d.entries.map(entryCard).join('') : V.adding ? '' : `<div class="vt-zero">${KEY}<b>Nada guardado ainda</b><span>${reqs.length ? 'Use Guardar num dos pedidos acima, ou crie uma por conta própria.' : 'Quando um plugin precisar de um token, o pedido aparece aqui.'}</span></div>`}
    ${d.audit.length ? `<details class="vt-log"><summary>Registro de uso <span class="vt-n">${d.audit.length}</span></summary>${d.audit.slice(0, 60).map(a => `<div class="${a.ok ? '' : 'bad'}"><span>${esc(bs.ago(a.at))}</span><b>${esc(pname(a.plugin))}</b> <code>${esc(a.name)}</code> ${esc(a.target || '')}${a.ok ? '' : ` · <em>${esc(a.why)}</em>`}</div>`).join('')}</details>` : ''}
    </div>
    <div class="actions"><span class="vt-file" title="${esc(d.file || '')}">~/.bluescreen/vault.json</span><span class="spacer"></span><button class="chip" data-close>Fechar</button></div>`;
}
const PLUS = '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

async function act(fn, wait) {
  try { await fn(); } catch (e) { if (e.message !== 'cancelado') toast(e.message); else toast('Cancelado'); }
  draw();
}
function draw() {
  const old = document.querySelector('#vaultDlg .dlg-scroll'), top = old ? old.scrollTop : 0;
  const el = window.dialog('vaultDlg', render(), bind);
  el.querySelector('.dlg-box').classList.add('vt-box');
  const sc = el.querySelector('.dlg-scroll'); if (sc) sc.scrollTop = top; // a lista não pula para o topo a cada clique
  mark();
}
function bind(el) {
  const val = (id) => (el.querySelector('#' + id) || {}).value || '';
  const grantAll = (name, list) => post({ action: 'grantMany', name, grants: list.map(x => ({ plugin: x.plugin, as: x.key, use: true, reveal: false })) }, true);
  // um pedido: Guardar abre direto a janela do Windows (com os sites que o plugin pediu) e já libera o plugin
  el.querySelectorAll('.vt-req').forEach(c => {
    const ids = c.dataset.rq.split('\u0002').map(x => x.split('\u0001'));
    const list = ids.map(([pl, key]) => V.data.requests.find(x => x.plugin === pl && x.key === key)).filter(Boolean); if (!list.length) return;
    const r = list[0], st = stateOf(r);
    c.querySelector('[data-go]').onclick = () => act(async () => {
      if (st === 'allow') return post({ action: 'grant', name: r.entry || r.key, plugin: r.plugin, as: r.key, use: true }, true);
      if (st === 'reveal') return post({ action: 'grant', name: r.entry || r.key, plugin: r.plugin, as: r.key, use: true, reveal: true }, true);
      const name = suggestName(list), label = list.length > 1 ? String(r.label || '').replace(/^[^:]+:\s*/, '') : r.label || '';
      await post({ action: 'enter', name, label, hosts: r.hosts || [], programs: r.programs || [], fields: mergeFields(list) }, true);
      await grantAll(name, list);
      toast(`"${label || name}" guardada no cofre`, 'ok');
    });
    c.querySelectorAll('[data-use]').forEach(b => b.onclick = () => act(() => grantAll(b.dataset.use, list)));
  });
  el.querySelectorAll('.vt-ent').forEach(c => {
    const name = c.dataset.name, e = V.data.entries.find(x => x.name === name), on = (sel, fn) => { const b = c.querySelector(sel); if (b) b.onclick = fn; };
    on('[data-act="change"]', () => act(() => post({ action: 'enter', name }, true)));
    on('[data-act="more"]', () => { V.openEnt.has(name) ? V.openEnt.delete(name) : V.openEnt.add(name); if (V.edit === name) V.edit = null; draw(); });
    on('[data-act="edit"]', () => { V.edit = name; draw(); });
    on('[data-act="cancel"]', () => { V.edit = null; draw(); });
    on('[data-act="save"]', () => { const f = (k) => c.querySelector(`[data-f="${k}"]`).value; V.edit = null; act(() => post({ action: 'edit', name, label: f('label'), note: f('note'), hosts: f('hosts'), programs: f('programs') }, true)); });
    on('[data-act="del"]', () => window.dialog('vtDel', `<div class="dlg-hd"><span class="dlg-ic del">${bs.I.x}</span><div><h3>Apagar "${esc(e.label || name)}" do cofre?</h3><p>Os plugins que usam esta credencial param de funcionar até você guardar outra com o mesmo nome.</p></div></div>
      <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary danger" id="vtDelOk">Apagar</button></div>`, (d) => { d.querySelector('#vtDelOk').onclick = () => { d.hidden = true; V.openEnt.delete(name); act(() => post({ action: 'delete', name })); }; }));
    c.querySelectorAll('.vt-pl').forEach(g => { g.querySelector('[data-g="off"]').onclick = () => act(() => post({ action: 'grant', name, plugin: g.dataset.plugin, use: false, reveal: false })); });
    c.querySelectorAll('.vt-chk[data-plugin] input').forEach(cb => cb.onchange = () => act(() => post({ action: 'grant', name, plugin: cb.closest('[data-plugin]').dataset.plugin, use: true, reveal: cb.checked }, cb.checked)));
    const add = c.querySelector('.vt-add');
    if (add) add.onchange = () => add.value && act(() => post({ action: 'grant', name, plugin: add.value, use: true }, true));
  });
  const addBtn = el.querySelector('#vtAdd');
  if (addBtn) addBtn.onclick = () => { V.adding = true; V.form = null; draw(); document.querySelector('#vtName')?.focus(); };
  const cancel = el.querySelector('#vtCancel');
  if (cancel) cancel.onclick = () => { V.adding = false; V.form = null; draw(); };
  const paste = el.querySelector('#vtPaste');
  if (paste) {
    const go = () => {
      const name = val('vtName').trim(), kind = val('vtKind') || 'token';
      const list = (id) => val(id).split(',').map(s => s.trim()).filter(Boolean);
      V.form = { name, kind, label: val('vtLabel'), hosts: list('vtHosts'), programs: list('vtProgs'), adv: !!el.querySelector('.vt-adv')?.open };
      if (!name) { el.querySelector('#vtErr').textContent = 'Dê um nome à credencial (ex.: github).'; return el.querySelector('#vtName').focus(); }
      if (V.data.entries.some(x => x.name === name)) { el.querySelector('#vtErr').textContent = `Já existe uma credencial chamada ${name}. Use Trocar valor nela.`; return; }
      act(async () => { await post({ action: 'enter', name, label: V.form.label, hosts: V.form.hosts, programs: V.form.programs, kind }, true); V.form = null; V.adding = false; toast(`"${name}" guardada no cofre`, 'ok'); });
    };
    paste.onclick = go;
    el.querySelector('#vtName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  }
}

async function open(focus) {
  V.focus = focus || null;
  try { await load(); } catch (e) { return toast('Cofre: ' + e.message); }
  draw();
  // veio de um plugin: o pedido dele fica em destaque e à vista
  if (focus) document.querySelector('#vaultDlg .vt-req.focus')?.scrollIntoView({ block: 'nearest' });
}

// ---------- tela de configuração no lugar do painel de um plugin que só funciona com um token do Cofre ----------
// O plugin marca o que é obrigatório no plugin.json: "vault": [{ "key": "...", "required": true, ... }]. Enquanto faltar
// algo, o painel dele mostra os passos (criar, permitir, deixar ver o valor) e confere sozinho até ficar pronto.
const G = { tool: null, timer: null, sig: '' };
const needs = (id) => { const p = bs.plugins.list.find(x => x.id === id); return p && Array.isArray(p.vaultKeys) ? p.vaultKeys.filter(v => v && v.required && v.key) : []; };
const ready = (r) => r.exists && r.granted && (!r.reveal || r.revealGranted);
function gateItems(id) {
  return needs(id).map(d => ({ ...d, ...((V.data && V.data.requests.find(r => r.plugin === id && r.key === d.key)) || { key: d.key, plugin: id, pluginName: pname(id), reveal: !!d.reveal, exists: false, granted: false }) , title: d.title, revealWhy: d.revealWhy }));
}
const gateSig = (id) => gateItems(id).map(r => [r.exists, r.granted, r.revealGranted].join()).join('|');
function stopGate() { clearInterval(G.timer); G.timer = null; G.tool = null; }
function gate(id, body, tool) {
  if (!needs(id).length) return false;
  if (!V.data) { body.innerHTML = '<div class="empty">Conferindo o Cofre…</div>'; load().then(() => { if (bs.S.tool === tool.id) bs.renderTool(); }).catch(() => {}); return true; }
  const items = gateItems(id);
  if (items.every(ready)) { if (G.tool === tool.id) stopGate(); return false; }
  const name = pname(id);
  const step = (n, on, cur, title, desc, extra = '') => `<li class="vg-st ${on ? 'done' : cur ? 'cur' : ''}"><span class="vg-n">${on ? '✓' : n}</span><div><b>${title}</b>${extra}<div class="vg-d">${desc}</div></div></li>`;
  body.innerHTML = `<div class="vg">${items.map(r => {
    const what = r.title || `Configure ${r.label ? 'o ' + String(r.label).replace(/^[^:]+:\s*/, '') : 'a credencial ' + r.key}`;
    const same = !r.exists && (r.sameHosts || [])[0];
    const s = [r.exists, r.granted, !r.reveal || r.revealGranted];
    const cur = s.findIndex(x => !x);
    let n = 0;
    return `<div class="vg-card"><div class="vg-hd"><span class="vg-ic">${KEY}</span><div><h4>${esc(what)}</h4><p>O ${esc(name)} só abre com ele${r.why ? ': ' + esc(r.why) : ''}.</p></div></div>
      <ol class="vg-steps">
        ${step(++n, s[0], cur === 0, 'Guardar a credencial', same ? `Já existe <b>${esc(same)}</b> para o mesmo site: no Cofre, “Usar ${esc(same)}”.` : `No Cofre, Guardar: abre uma janela para digitar ${esc(fieldsTxt(r.fields).toLowerCase())}.`, `<div><code>${esc(r.key)}</code></div>`)}
        ${step(++n, s[1], cur === 1, `Permitir o ${esc(name)}`, 'Guardar já faz isso; se a credencial já existia, é o botão Permitir.')}
        ${r.reveal ? step(++n, s[2], cur === 2, 'Deixar ler o valor', esc(r.revealWhy || `O servidor do ${name} usa o valor direto.`)) : ''}
        ${step(++n, false, false, `Lido pelo ${esc(name)}`, 'Confere sozinho; não precisa reabrir nada.')}
      </ol>
      <button class="chip primary vg-go" data-key="${esc(r.key)}">${KEY}Abrir no Cofre</button></div>`;
  }).join('')}</div>`;
  body.querySelectorAll('.vg-go').forEach(b => b.onclick = () => open({ plugin: id, key: b.dataset.key }));
  // confere sozinho: quando o que falta é liberado (aqui ou no Cofre), o painel do plugin aparece
  G.tool = tool.id; G.sig = gateSig(id);
  if (!G.timer) G.timer = setInterval(async () => {
    if (bs.S.tool !== G.tool || document.hidden) { if (bs.S.tool !== G.tool) stopGate(); return; }
    try { await load(); } catch {}
  }, 2500);
  return true;
}

bs.vault = { open, refresh: load, banner, bindBanner, gate };
bs.actions.add({ label: 'Cofre de credenciais (tokens dos plugins)', icon: KEY, run: () => open() });
// ícone próprio na barra da esquerda, junto de Plugins: abre o cofre (não é um painel)
bs.tools.register({ id: 'vault', title: 'Cofre de credenciais', icon: KEY, key: 'Alt+8', order: 990, bottom: true, render() {}, toggle() { open(); } });
bs.hooks.on('refresh', () => load().catch(() => {}));
// depois de os plugins carregarem: o ponto na chave avisa pedidos pendentes
setTimeout(() => load().catch(() => {}), 1500);
})(window.BS);
