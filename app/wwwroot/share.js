'use strict';
// ===== Espaço de trabalho compartilhado (Rede local) =====
// Conectar: lista os BlueScreen que anunciam na rede (share.rs) e abre o do outro PC nesta mesma janela, sem
//   navegador: a página local confere o endereço (/api/network/probe) e pede à janela (desktop.rs) para trocar
//   de página. Na página do outro PC, "Desconectar" (ou "Voltar ao meu BlueScreen") volta para a deste PC.
// Espelhar: cada janela com o espelho ligado entra em /api/mirror/ws e repete o que as outras fazem:
//   projeto aberto, abas (abrir, trocar, fechar), painel lateral, edição, salvar, cursor/seleção e rolagem.
//   As mensagens são idempotentes (abrir a aba que já está na frente não faz nada), então não há eco infinito.
//   Edição: cada lote de trocas leva o tamanho do texto depois dela; se não bater (alguém digitou ao mesmo tempo,
//   ou a aba abriu do disco sem as alterações em andamento), a janela pede o texto inteiro ('need' -> 'full').
const NET = { pollT: null, addr: store.get('netAddr', '') };
const MR = { on: store.get('mirror', false), ws: null, peers: 0, quiet: 0, lastLocal: 0, retryT: null, wantState: false, bound: new WeakSet(), opening: new Map(), selT: null, scrollT: null };
const inDesktop = () => !!(window.BS_DESKTOP && window.ipc);
// esta página é a de outro PC (acesso pela rede)? Vale antes do login, quando S.remote ainda não chegou
const netAway = !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

// ----- Conectar -----
function netRenderJoin(list, error) {
  const box = $('#netFound');
  if (!list.length) { box.innerHTML = `<p class="net-empty">${esc(error || 'Nenhum espaço de trabalho aberto na rede. No outro PC, ligue "Permitir acesso pela rede".')}</p>`; return; }
  box.innerHTML = list.map(w => `<div class="net-ws"><div><b>${esc(w.host || 'BlueScreen')}${w.project ? ' · ' + esc(w.project) : ''}</b><small>${esc(w.url)}</small></div><button class="chip" data-u="${esc(w.url)}">Conectar</button></div>`).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => netConnect(b.dataset.u));
}
async function netPoll() {
  clearTimeout(NET.pollT);
  if ($('#netPop').hidden || $('#netJoin').hidden) return;
  try { const r = await api('network/discover'); netRenderJoin(r.found || [], r.error); } catch (e) { netRenderJoin([], e.message); }
  NET.pollT = setTimeout(netPoll, 2000);
}
async function netConnect(addr) {
  addr = String(addr || '').trim(); if (!addr) return $('#netAddr').focus();
  $('#netErr').textContent = ''; $('#netGo').disabled = true;
  try {
    const r = await api('network/probe', { addr });
    NET.addr = addr; store.set('netAddr', addr);
    toast('Conectando a ' + r.url.replace('http://', '') + '…');
    if (inDesktop()) desktop({ type: 'connect', url: r.url }); else location.href = r.url + '/';
  } catch (e) { $('#netErr').textContent = e.message; }
  finally { $('#netGo').disabled = false; }
}
const netLeave = () => desktop({ type: 'disconnect' });
function netRenderSide() {
  // página de outro PC aberta na janela do aplicativo: mostra de onde é e como voltar
  const away = netAway && inDesktop();
  $('#netRemote').hidden = !away; $('#netRemoteHost').textContent = S.hostName || location.host;
  $('#loginBack').hidden = !away;
  $('#netJoin').hidden = netAway; // conectar a partir de uma página remota não faz sentido: volte primeiro
  if (away) { $('#btnSettings').classList.add('net-on'); $('#btnSettings').title = 'Configurações · conectado a ' + (S.hostName || location.host); }
}
$('#netAddrForm').onsubmit = (e) => { e.preventDefault(); netConnect($('#netAddr').value); };
$('#netAddr').value = NET.addr;
$('#netLeave').onclick = netLeave;
$('#loginBack').onclick = netLeave;
BS.hooks.on('net:pop', (open) => { netRenderSide(); if (open) { $('#netErr').textContent = ''; netPoll(); netStatusPoll(); } else { clearTimeout(NET.pollT); clearTimeout(NET.statusT); } });

// ----- este PC na rede: PIN (trocado por excesso de tentativas) e aparelhos conectados -----
// Com o popover aberto, confere a cada 3 s; fechado, a cada 20 s (o PIN novo vira aviso e a lista fica pronta)
const netWhen = (ms) => { if (!ms) return ''; const d = new Date(ms); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR'); };
function netRenderDevs(list) {
  const box = $('#netDevs'); box.hidden = !list.length;
  $('#netDevList').innerHTML = list.map(s => `<div class="net-dev"><div><b>${esc(s.ip || 'endereço desconhecido')}</b><small>entrou às ${esc(netWhen(s.since))} · último acesso ${esc(ago(s.last) === 'agora' ? 'agora' : 'há ' + ago(s.last))}</small></div><button class="chip" data-id="${esc(s.id)}" title="Encerra a sessão: o aparelho precisa do PIN de novo">Desconectar</button></div>`).join('');
  $('#netDevList').querySelectorAll('button').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const r = await api('network/sessions', {}, { method: 'POST', body: JSON.stringify({ revoke: b.dataset.id }) }); netRenderDevs(r.sessions || []); toast('Aparelho desconectado'); }
    catch (e) { b.disabled = false; toast(e.message); }
  });
}
async function netStatusPoll() {
  clearTimeout(NET.statusT);
  if (netAway || S.remote) return;
  const open = !$('#netPop').hidden;
  try {
    if (open || (S.net && S.net.enabled)) { S.net = await api('network', {}, { quiet: true }); renderNet(); }
    if (open && S.net && S.net.enabled) netRenderDevs((await api('network/sessions', {}, { quiet: true })).sessions || []);
    else if (open) netRenderDevs([]);
  } catch {}
  NET.statusT = setTimeout(netStatusPoll, open ? 3000 : 20000);
}
setTimeout(netStatusPoll, 5000);

// conectado a outro PC: se ele sumir (fechou, desligou a rede), avisa e oferece voltar em vez de deixar a tela parada
let netFails = 0;
async function netHeartbeat() {
  try { const r = await fetch('/api/session', { cache: 'no-store' }); if (!r.ok && r.status !== 401) throw 0; netFails = 0; $('#netLost')?.setAttribute('hidden', ''); }
  catch {
    if (++netFails >= 2) {
      let el = $('#netLost');
      if (!el) {
        el = document.createElement('div'); el.id = 'netLost';
        el.innerHTML = `<span>A conexão com <b>${esc(S.hostName || location.host)}</b> caiu.</span><button class="chip" data-a="retry">Tentar de novo</button><button class="chip primary" data-a="back">Voltar ao meu BlueScreen</button>`;
        el.querySelector('[data-a=retry]').onclick = () => location.reload();
        el.querySelector('[data-a=back]').onclick = netLeave;
        document.body.appendChild(el);
      }
      el.hidden = false;
    }
  }
  setTimeout(netHeartbeat, 3000);
}

// o anúncio na rede mostra o projeto aberto neste PC
const netAnnounce = () => { if (!netAway) api('network', {}, { method: 'POST', body: JSON.stringify({ project: S.project ? S.project.name : null }) }).catch(() => {}); };
BS.hooks.on('project:select', netAnnounce);

// ----- Espelhar -----
const mrSend = (m) => { if (MR.on && !MR.quiet && MR.ws && MR.ws.readyState === 1) MR.ws.send(JSON.stringify(m)); };
// aplica o que veio de outra janela sem mandar de volta
function mrQuiet(fn) { MR.quiet++; try { return fn(); } finally { MR.quiet--; } }
async function mrQuietAsync(fn) { MR.quiet++; try { return await fn(); } finally { MR.quiet--; } }
const mrTab = (k) => S.tabs.find(t => t.key === k && !t.owner);
const mrSeen = (t) => t && !t.owner && t.project && (t.mode === 'editor' || t.mode === 'diff' || t.mode === 'view');
// o que conta como "mexer aqui": o que a pessoa faz nesta janela tem prioridade sobre cursor e rolagem de fora
['keydown', 'mousedown', 'wheel', 'touchstart'].forEach(ev => addEventListener(ev, () => { MR.lastLocal = Date.now(); }, true));
const mrIdle = (ms) => Date.now() - MR.lastLocal > ms;

function mrConnect() {
  clearTimeout(MR.retryT);
  if (!MR.on || MR.ws) return;
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/mirror/ws');
  MR.ws = ws;
  ws.onopen = () => { MR.wantState = true; ws.send(JSON.stringify({ t: 'hello' })); mrRender(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } mrRecv(m).catch(err => console.warn('espelho', m.t, err)); };
  ws.onclose = () => { if (MR.ws === ws) MR.ws = null; MR.peers = 0; mrRender(); if (MR.on) MR.retryT = setTimeout(mrConnect, 2000); };
}
function mrSet(on) {
  MR.on = on; store.set('mirror', on);
  if (on) mrConnect(); else { clearTimeout(MR.retryT); const ws = MR.ws; MR.ws = null; ws && ws.close(); MR.peers = 0; }
  mrRender();
}
const mrStatus = BS.status.add({ id: 'stMirror', title: 'Espelhar ações (Rede local)', onclick: () => BS.settings && BS.settings.open('rede') });
function mrRender() {
  $('#mirrorToggle').classList.toggle('on', MR.on);
  const others = Math.max(0, MR.peers - 1), live = MR.ws && MR.ws.readyState === 1;
  $('#mirrorInfo').textContent = !MR.on ? 'Projeto, abas, edição, cursor e rolagem se repetem em todas as janelas com o espelho ligado.'
    : !live ? 'Ligando o espelho…'
    : others ? `Espelhando com ${others} ${others === 1 ? 'outra janela' : 'outras janelas'}.`
    : 'Espelho ligado. Ligue também na outra janela (aqui ou no outro PC).';
  mrStatus.hidden = !MR.on; mrStatus.className = 's' + (live && others ? ' mirror-on' : '');
  mrStatus.textContent = live ? `espelho · ${others}` : 'espelho · …';
}
$('#mirrorToggle').onclick = () => mrSet(!MR.on);

// estado desta janela, para quem acabou de entrar
function mrState() {
  const a = S.active && (S.active.owner || S.active);
  return { t: 'state', project: S.project ? S.project.path : null, tool: S.tool, toolHidden: $('#app').classList.contains('no-tool'), tab: mrSeen(a) ? { k: a.key, path: a.path, mode: a.mode, project: a.project, dirty: !!a.dirty } : null };
}
async function mrRecv(m) {
  switch (m.t) {
    case 'peers': MR.peers = m.n; mrRender(); return;
    case 'hello': if (S.project) mrSend(mrState()); return;
    case 'state':
      if (!MR.wantState) return; MR.wantState = false;
      if (m.project && (!S.project || S.project.path !== m.project)) await mrQuietAsync(() => openProject(m.project));
      if (m.tool) mrTool(m.tool, !m.toolHidden);
      if (m.tab) { await mrOpen(m.tab); if (m.tab.dirty) mrSend({ t: 'need', k: m.tab.k }); }
      return;
    case 'project':
      if (!m.path) { if (S.project) mrQuiet(closeProject); return; }
      if (!S.project || S.project.path !== m.path) await mrQuietAsync(() => openProject(m.path));
      return;
    case 'tool': mrTool(m.id, m.show); return;
    case 'open': return mrOpen(m);
    case 'close': { const t = mrTab(m.k); if (t) mrQuiet(() => closeTab(t)); return; }
    case 'edit': return mrEdit(m);
    case 'need': { const t = mrTab(m.k); if (t && t.model && !t.model.isDisposed()) mrSend({ t: 'full', k: m.k, x: t.model.getValue() }); return; }
    case 'full': { const t = mrTab(m.k); if (t && t.model && !t.model.isDisposed() && t.editable) mrQuiet(() => { xsApply(t.model, m.x); markDirty(t.model); }); return; }
    case 'save': {
      // a outra janela gravou: se o texto daqui é o mesmo, esta aba também fica salva (sem gravar de novo)
      const t = mrTab(m.k); if (!t || !t.model || t.model.isDisposed()) return;
      const v = t.model.getValue(); if (mrHash(v) !== m.h) return;
      t.saved = v; if (m.stamp) t.stamp = m.stamp; markDirty(t.model); renderTabs();
      return;
    }
    case 'sel': return mrSel(m);
    case 'scroll': return mrScroll(m);
  }
}
function mrTool(id, show) {
  const def = BS.tools.get(id); if (!def || def.toggle) return;
  const hidden = $('#app').classList.contains('no-tool');
  mrQuiet(() => {
    if (!show) { if (!hidden && S.tool === id) { $('#app').classList.add('no-tool'); btnState(); } }
    else if (hidden || S.tool !== id) openTool(id);
  });
}
async function mrOpen(m) {
  if (S.active && S.active.key === m.k) return;
  const t = mrTab(m.k);
  if (t) return mrQuiet(() => activate(t));
  if (MR.opening.has(m.k)) return MR.opening.get(m.k);
  const p = mrQuietAsync(async () => {
    if (m.project && (!S.project || S.project.path !== m.project)) await openProject(m.project);
    if (!S.project || S.project.path !== m.project) return;
    await openFile(m.path, m.mode === 'diff' ? 'diff' : 'editor'); // sem o modo, a aba nasce com o editor escondido
  });
  MR.opening.set(m.k, p);
  try { await p; } finally { MR.opening.delete(m.k); }
}

// ----- edição -----
const mrHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + s.length; };
function mrWatch(tab) {
  const model = tab.model; if (!model || MR.bound.has(model)) return;
  MR.bound.add(model);
  model.onDidChangeContent((e) => {
    // texto vindo do disco (sync.js) ou de outra janela não volta para o espelho; setValue (isFlush) também não
    if (!MR.on || MR.quiet || XS.applying || e.isFlush || !model._tab || model._tab.owner) return;
    mrSend({ t: 'edit', k: model._tab.key, ch: e.changes.map(c => ({ r: [c.range.startLineNumber, c.range.startColumn, c.range.endLineNumber, c.range.endColumn], x: c.text })), n: model.getValueLength() });
  });
}
async function mrEdit(m) {
  // a aba ainda está abrindo (o arquivo vem do disco, sem esta edição): espera e pede o texto inteiro
  if (!mrTab(m.k) && MR.opening.has(m.k)) { await MR.opening.get(m.k); return mrSend({ t: 'need', k: m.k }); }
  const t = mrTab(m.k); if (!t || !t.model || t.model.isDisposed() || !t.editable) return;
  const model = t.model;
  mrQuiet(() => {
    try { model.pushEditOperations([], m.ch.map(c => ({ range: new monaco.Range(c.r[0], c.r[1], c.r[2], c.r[3]), text: c.x, forceMoveMarkers: true })), () => null); }
    catch { /* faixa fora do texto: o 'need' abaixo traz tudo */ }
    markDirty(model);
  });
  if (model.getValueLength() !== m.n) mrSend({ t: 'need', k: m.k });
}

// ----- cursor e rolagem -----
const mrEditorOf = (t) => !t ? null : t.mode === 'editor' ? editor : t.mode === 'diff' ? diffEditor && diffEditor.getModifiedEditor() : null;
function mrBindEditor(ed) {
  if (!ed || MR.bound.has(ed)) return;
  MR.bound.add(ed);
  ed.onDidChangeCursorSelection((e) => {
    if (!MR.on || MR.quiet || e.source === 'api' || e.source === 'modelChange') return;
    const t = S.active; if (!mrSeen(t) || mrEditorOf(t) !== ed) return;
    clearTimeout(MR.selT);
    MR.selT = setTimeout(() => mrSend({ t: 'sel', k: t.key, s: ed.getSelections().map(s => [s.selectionStartLineNumber, s.selectionStartColumn, s.positionLineNumber, s.positionColumn]) }), 60);
  });
  ed.onDidScrollChange((e) => {
    if (!MR.on || MR.quiet || !e.scrollTopChanged || mrIdle(800)) return; // só a rolagem feita aqui (não a de quem segue)
    const t = S.active; if (!mrSeen(t) || mrEditorOf(t) !== ed) return;
    clearTimeout(MR.scrollT);
    MR.scrollT = setTimeout(() => { const r = ed.getVisibleRanges()[0]; if (r) mrSend({ t: 'scroll', k: t.key, line: r.startLineNumber }); }, 50);
  });
}
function mrSel(m) {
  const t = S.active; if (!t || t.key !== m.k || !mrIdle(600)) return;
  const ed = mrEditorOf(t); if (!ed || !m.s || !m.s.length) return;
  mrQuiet(() => { ed.setSelections(m.s.map(s => new monaco.Selection(s[0], s[1], s[2], s[3]))); });
}
function mrScroll(m) {
  const t = S.active; if (!t || t.key !== m.k || !mrIdle(600)) return;
  const ed = mrEditorOf(t); if (!ed) return;
  mrQuiet(() => ed.setScrollTop(ed.getTopForLineNumber(m.line), monaco.editor.ScrollType.Immediate));
}

// ----- o que esta janela faz vira mensagem -----
BS.hooks.on('project:select', (p) => mrSend({ t: 'project', path: p ? p.path : null }));
BS.hooks.on('tool:show', (id, show) => mrSend({ t: 'tool', id, show }));
BS.hooks.on('tab:open', (t) => mrWatch(t));
BS.hooks.on('tab:activate', (t) => {
  mrBindEditor(editor); if (diffEditor) mrBindEditor(diffEditor.getModifiedEditor());
  mrWatch(t);
  if (mrSeen(t)) mrSend({ t: 'open', k: t.key, path: t.path, mode: t.mode, project: t.project });
});
BS.hooks.on('tab:close', (t) => { if (mrSeen(t)) mrSend({ t: 'close', k: t.key }); });
BS.hooks.on('tab:save', (t) => { if (t.model && !t.model.isDisposed()) mrSend({ t: 'save', k: t.key, h: mrHash(t.saved), stamp: t.stamp }); });

// ----- início -----
setTimeout(() => {
  netRenderSide();
  if (netAway && inDesktop()) netHeartbeat();
  mrRender();
  if (MR.on) mrConnect();
}, 0);
