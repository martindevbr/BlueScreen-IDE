/* Automator: fluxos de automação em nós, no modelo do editor de Fluxos do HexLab.
   Quadro com câmera (arrastar o fundo, roda do mouse), nós em DOM com geometria fixa, fios em SVG puxados de uma
   bolinha até a outra, seleção (clique, Shift, laço), desfazer/refazer e execução acompanhada nó a nó.
   O documento usa os mesmos campos do HexLab: nodes/edges/position/from_port/to_port. */
const NODE_W = 232, HEAD = 37, PAD = 6, ROW = 24, ZMIN = 0.2, ZMAX = 2.5, GRID = 12;
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (d, extra = '') => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const IC = {
  app: svg('<rect x="2.5" y="3.5" width="7" height="6" rx="1.5"/><rect x="14.5" y="14.5" width="7" height="6" rx="1.5"/><path d="M9.5 6.5H15a3 3 0 0 1 3 3v5M6 9.5V15a3 3 0 0 0 3 3h5.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  play: svg('<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>'),
  undo: svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12h-1" transform="translate(0 -5)"/>'),
  redo: svg('<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 0 0 0 12h1" transform="translate(0 -5)"/>'),
  fit: svg('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>'),
  tidy: svg('<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="3" y="15" width="6" height="5" rx="1"/><rect x="15" y="9.5" width="6" height="5" rx="1"/><path d="M9 6.5h3v11H9M12 12h3"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  list: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  err: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.1"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  trash: svg('<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>'),
};
// ícone e cor de cada categoria da paleta
const CATS = {
  'Gatilhos': { c: '#E3A63A', i: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>') },
  'Dados': { c: 'var(--accent-2)', i: svg('<path d="M5 6h14M5 12h14M5 18h9"/>') },
  'Lógica': { c: 'var(--j-enum)', i: svg('<path d="M6 3v6a6 6 0 0 0 6 6h6M6 9v12M15 12l3 3-3 3"/>') },
  'Windows': { c: 'var(--ico-web)', i: svg('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9l3 2.5L7 14M12.5 14H16"/>') },
  'Rede': { c: 'var(--add)', i: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>') },
  'IA': { c: '#E879B9', i: IC.spark },
  'Arquivos': { c: '#D9A441', i: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>') },
  'Texto': { c: '#9AA7F5', i: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>') },
  'Imagem': { c: '#5CC8A1', i: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>') },
  'Áudio': { c: '#F0A35E', i: svg('<path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/>') },
  'Vídeo': { c: '#E36F8E', i: svg('<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>') },
  'Segurança': { c: '#E0685E', i: svg('<path d="M12 3l7 3v5c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V6z"/><path d="M9 12l2.2 2.2L15 10.5"/>') },
  'Auditoria': { c: '#59B8C4', i: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8.5 11l1.8 1.8L13.5 9.5"/>') },
  'Integrações': { c: '#B58DF2', i: svg('<path d="M9 7H6a4 4 0 0 0 0 8h3M15 7h3a4 4 0 0 1 0 8h-3M8 11h8"/>') },
  'Navegador': { c: '#4FB6E8', i: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.1M10 6.5h.1"/>') },
};
// categoria que um plugin inventou: cor e ícone neutros
const PLUG_CAT = { c: 'var(--muted)', i: svg('<path d="M9 3h6v4h3a2 2 0 0 1 2 2v3h-2.5a2 2 0 1 0 0 4H20v3a2 2 0 0 1-2 2h-4v-2.5a2 2 0 1 0-4 0V21H6a2 2 0 0 1-2-2v-4h2.5a2 2 0 1 0 0-4H4V9a2 2 0 0 1 2-2h3z"/>') };
// gatilhos que disparam sozinhos: valem com o interruptor "Ligado" do fluxo
const AUTO = ['trigger.schedule', 'trigger.startup', 'trigger.file', 'trigger.webhook'];
// endereço que chama um Endpoint HTTP
const hookUrl = (name) => `${location.origin}/api/automator/hook?e=${encodeURIComponent(String(name || '').trim())}`;
const PORT_LABEL = { in: 'entrada', out: 'saída', true: 'sim', false: 'não' };
const STATUS = { running: 'executando', queued: 'na fila', completed: 'concluído', failed: 'falhou', cancelled: 'parado', interrupted: 'interrompido', skipped: 'pulado' };

const esc = bs.esc;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clone = (v) => JSON.parse(JSON.stringify(v));
const uid = (p = 'n') => p + crypto.randomUUID().replaceAll('-', '').slice(0, 10);
const post = (route, body) => bs.api(route, {}, { method: 'POST', body: JSON.stringify(body) });
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { bs.toast('Automator: ' + e.message, 'err'); } };
const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace('.', ',') + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round(ms % 60000 / 1000) + ' s';
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function fmtWhen(t) {
  const d = new Date(t), now = new Date(), hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, now)) return 'hoje ' + hm;
  if (sameDay(d, new Date(now.getTime() + 864e5))) return 'amanhã ' + hm;
  if (sameDay(d, new Date(now.getTime() - 864e5))) return 'ontem ' + hm;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}
const show = (v) => v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
// um elemento: el('div.a.b', { atributos }, filhos...)
function el(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'html') e.innerHTML = v;
    else if (k === 'style') { for (const [p, x] of Object.entries(v)) if (x != null) p.startsWith('--') ? e.style.setProperty(p, x) : (e.style[p] = x); }
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') || (k in e && k !== 'list')) e[k] = v;
    else if (v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
}

// ---------- estado ----------
const A = {
  specs: [], byType: new Map(), flows: [], flow: null, saved: '', runs: [], runSig: '',
  sel: new Set(), selEdge: null, cam: { x: 40, y: 40, z: 1 }, undo: [], redo: [], clip: null, drag: null, loaded: false, pane: null,
};
let root, R = {}, nodeEls = new Map(), edgeEls = new Map(), timers = [], picker = null, busyRun = false;
const spec = (t) => A.byType.get(t);
const node = (id) => A.flow?.nodes.find(n => n.id === id);
const titleOf = (n) => n.title || spec(n.type)?.name || n.type;
const catOf = (n) => CATS[spec(n.type)?.category] || PLUG_CAT;
const hasSchedule = (f = A.flow) => !!f?.nodes.some(n => AUTO.includes(n.type) && !n.disabled);
const doc = () => A.flow ? JSON.stringify({ name: A.flow.name, description: A.flow.description || '', active: !!A.flow.active, nodes: A.flow.nodes, edges: A.flow.edges }) : '';
const isDirty = () => !!A.flow && doc() !== A.saved;
// ---------- trancar: o fluxo inteiro (só visualização) ou nós escolhidos (não movem, não editam, não saem) ----------
const flowLocked = () => !!A.flow?.locked;
const nodeLocked = (id) => flowLocked() || !!node(id)?.locked;
let deniedAt = 0;
function denied(what) {
  if (Date.now() - deniedAt > 2500) { deniedAt = Date.now(); bs.toast(what === 'node' ? 'Este nó está trancado. Destranque para mexer nele.' : 'Fluxo trancado: só visualização. Destranque no cadeado para editar.'); }
}
const currentRun = () => A.runs.find(r => r.status === 'running') || A.runs.find(r => r.status === 'queued') || A.runs[0] || null;
const isRunning = () => ['running', 'queued'].includes(currentRun()?.status);

// ---------- perguntas (diálogo da IDE no lugar do confirm do navegador) ----------
function ask(title, text, buttons) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, box) => { if (done) return; done = true; if (box) box.hidden = true; resolve(v); };
    const html = `<div class="dlg-hd"><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div></div><div class="actions">${buttons.map((b, i) => `<button class="chip ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    dialog('amAsk', html, (box) => {
      box.querySelectorAll('[data-i]').forEach(b => b.onclick = () => finish(buttons[+b.dataset.i].value, box));
      box.querySelector('.chip.primary')?.focus();
    });
    const box = document.getElementById('amAsk');
    const mo = new MutationObserver(() => { if (box.hidden) { mo.disconnect(); finish(null); } });
    mo.observe(box, { attributes: true, attributeFilter: ['hidden'] });
  });
}
/** Antes de trocar de fluxo: salvar, descartar ou ficar. Devolve true se pode seguir. */
async function leave() {
  if (!isDirty()) return true;
  const r = await ask('Alterações não salvas', `"${A.flow.name || 'Fluxo sem nome'}" tem alterações que ainda não foram salvas.`, [
    { label: 'Cancelar', value: null }, { label: 'Descartar', value: 'drop', cls: 'danger' }, { label: 'Salvar', value: 'save', cls: 'primary' }]);
  if (r === 'save') { try { return !!(await save()); } catch (e) { bs.toast('Automator: ' + e.message, 'err'); return false; } }
  return r === 'drop';
}

// ---------- histórico ----------
function commit() {
  if (!A.flow) return;
  A.undo.push(doc()); if (A.undo.length > 80) A.undo.shift();
  A.redo = [];
}
function travel(from, to) {
  if (flowLocked()) return denied();
  if (!A.flow || !from.length) return;
  to.push(doc());
  Object.assign(A.flow, JSON.parse(from.pop()));
  A.sel = new Set([...A.sel].filter(id => node(id))); A.selEdge = null;
  renderAll(); changed(true);
}

// ---------- fluxo ----------
function blank(name = 'Novo fluxo') {
  return { id: '', name, description: '', active: false, ui: {}, nodes: [{ id: uid(), type: 'trigger.manual', params: { sample: '' }, position: [60, 80], disabled: false }], edges: [] };
}
function normalize(f) {
  f.nodes = Array.isArray(f.nodes) ? f.nodes : []; f.edges = Array.isArray(f.edges) ? f.edges : [];
  f.ui = f.ui && typeof f.ui === 'object' ? f.ui : {};
  f.nodes.forEach((n, i) => {
    if (!Array.isArray(n.position) || n.position.length !== 2 || !n.position.every(Number.isFinite)) n.position = [60 + (i % 4) * 280, 60 + Math.floor(i / 4) * 150];
    n.params = { ...clone(spec(n.type)?.params || {}), ...(n.params && typeof n.params === 'object' ? n.params : {}) };
    n.disabled = !!n.disabled; n.locked = !!n.locked;
  });
  const ids = new Set(f.nodes.map(n => n.id));
  f.edges = f.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  f.edges.forEach(e => { e.id ||= uid('e'); });
  return f;
}
/** Abre um fluxo no quadro. `fresh`: ainda não foi salvo (modelo, importado, gerado), então já nasce "não salvo". */
function open(f, fresh = false) {
  A.flow = f ? normalize(clone(f)) : null;
  A.saved = fresh ? '' : doc();
  A.sel.clear(); A.selEdge = null; A.undo = []; A.redo = []; A.runs = []; A.runSig = '';
  const c = A.flow?.ui?.camera;
  A.cam = c && [c.x, c.y, c.z].every(Number.isFinite) ? { x: c.x, y: c.y, z: clamp(c.z, ZMIN, ZMAX) } : null;
  renderAll();
  if (!A.cam) { A.cam = { x: 40, y: 40, z: 1 }; applyCam(); requestAnimationFrame(fit); }
  changed(true); paintList(); pollRuns();
}
async function pick(f) { bs.pages.open('automator'); if (f && f.id === A.flow?.id) return; if (await leave()) open(f); }
async function create(make) { bs.pages.open('automator'); if (!(await leave())) return; open(make(), true); if (A.flow.nodes.length > 1) requestAnimationFrame(() => { arrange(false); fit(); }); R.name.focus(); R.name.select(); }
async function refreshFlows() { A.flows = await bs.api('automator/flows'); paintList(); const me = A.flows.find(f => f.id === A.flow?.id); if (me && A.flow) { A.flow.next_run = me.next_run; paintBar(); } }
async function save() {
  if (!A.flow) return null;
  if (!A.flow.name.trim()) { R.name.focus(); bs.toast('Dê um nome ao fluxo antes de salvar.', 'err'); return null; }
  A.flow.ui = { ...A.flow.ui, camera: { x: Math.round(A.cam.x), y: Math.round(A.cam.y), z: +A.cam.z.toFixed(3) } };
  const sent = doc();
  const saved = await post('automator/flows', { flow: A.flow });
  Object.assign(A.flow, { id: saved.id, next_run: saved.next_run, updated_at: saved.updated_at });
  A.saved = sent;
  await refreshFlows(); changed();
  return saved;
}
async function removeFlow(f = A.flow) {
  if (!f) return;
  // outro fluxo da lista (botão direito): exclui sem mexer no que está aberto
  if (f.id && f.id !== A.flow?.id) {
    const r = await ask('Excluir fluxo', `"${f.name}" e o histórico de execuções dele saem da lista. Compromissos da Agenda que rodam este fluxo passam a só notificar.`, [{ label: 'Cancelar', value: null }, { label: 'Excluir', value: 'ok', cls: 'primary danger' }]);
    if (r !== 'ok') return;
    await post('automator/flows', { action: 'delete', id: f.id });
    return refreshFlows();
  }
  if (A.flow.id) {
    const r = await ask('Excluir fluxo', `"${A.flow.name}" e o histórico de execuções dele saem da lista. Compromissos da Agenda que rodam este fluxo passam a só notificar.`, [{ label: 'Cancelar', value: null }, { label: 'Excluir', value: 'ok', cls: 'primary danger' }]);
    if (r !== 'ok') return;
    await post('automator/flows', { action: 'delete', id: A.flow.id });
  }
  A.flow = null; A.saved = '';
  await refreshFlows(); open(A.flows[0] || null);
}
function exportFlow(flow = A.flow) {
  if (!flow) return;
  const { next_run, updated_at, ...f } = flow;
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(f, null, 2)], { type: 'application/json' })), download: (flow.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'fluxo') + '.json' });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importFlow(file) {
  const f = JSON.parse(await file.text());
  if (!f || !Array.isArray(f.nodes) || !Array.isArray(f.edges)) throw new Error('o arquivo não é um fluxo (faltam os nós e as conexões)');
  const unknown = [...new Set(f.nodes.filter(n => !spec(n.type)).map(n => n.type))];
  if (unknown.length) throw new Error('este fluxo usa nós que o Automator não tem: ' + unknown.join(', '));
  if (!(await leave())) return;
  open({ ...f, id: '', active: false, next_run: null, name: f.name || file.name.replace(/\.json$/i, '') }, true);
  bs.toast('Fluxo importado. Confira e salve.', 'ok');
}

// modelos prontos
const T = (type, params, title) => ({ id: uid(), type, params: { ...clone(spec(type)?.params || {}), ...params }, position: [0, 0], disabled: false, ...(title ? { title } : {}) });
const chain = (name, description, nodes, extra = []) => ({ ...blank(name), description, nodes, edges: [...nodes.slice(1).map((n, i) => ({ id: uid('e'), from: nodes[i].id, from_port: 'out', to: n.id, to_port: 'in' })), ...extra] });
const TEMPLATES = [
  { label: 'Lembrete de pausa', hint: 'a cada hora, um aviso', make: () => chain('Lembrete de pausa', 'Avisa de hora em hora para levantar um pouco.', [T('trigger.schedule', { mode: 'interval', every_minutes: 60 }), T('windows.notify', { title: 'Hora de uma pausa', message: 'Levante, alongue e descanse os olhos.' })]) },
  { label: 'Rodar um comando e avisar', hint: 'programa, depois notificação', make: () => chain('Comando com aviso', 'Roda um programa e mostra o que ele respondeu.', [T('trigger.manual', {}), T('windows.command', { program: 'powershell', args: ['-NoProfile', '-Command', 'Get-Date -Format "dd/MM/yyyy HH:mm"'] }), T('windows.notify', { title: 'Comando concluído', message: '{{input}}' })]) },
  { label: 'Vigiar um site', hint: 'todo dia, avisa se cair', make: () => {
    const t = T('trigger.schedule', { mode: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), h = T('http.request', { url: 'https://example.com', method: 'GET' }), c = T('logic.if', { value: '{{input}}', op: 'empty', equals: '' }, 'Veio vazio?'), n = T('windows.notify', { title: 'Site sem resposta', message: 'A página respondeu vazia.' }), o = T('util.output', {});
    const f = chain('Vigiar um site', 'Confere o endereço nos dias úteis e avisa se a resposta vier vazia. Se o site não responder, a execução falha e aparece no histórico.', [t, h, c]);
    f.nodes.push(n, o); f.edges.push({ id: uid('e'), from: c.id, from_port: 'true', to: n.id, to_port: 'in' }, { id: uid('e'), from: c.id, from_port: 'false', to: o.id, to_port: 'in' });
    return f;
  } },
  { label: 'Avisar quando chegar arquivo', hint: 'vigia uma pasta', make: () => chain('Arquivo novo na pasta', 'Avisa quando um arquivo é criado ou alterado na pasta. Informe a pasta no primeiro nó e ligue o fluxo.', [T('trigger.file', { path: '' }), T('windows.notify', { title: 'Arquivo novo', message: '{{input.name}}' })]) },
  { label: 'Diário num arquivo', hint: 'data e hora, depois grava', make: () => chain('Diário num arquivo', 'Acrescenta uma linha com a data e a hora num arquivo de texto. Informe o arquivo no último nó.', [T('trigger.manual', { sample: 'anotação' }), T('data.datetime', { format: '%d/%m/%Y %H:%M' }), T('file.write', { path: '', content: '{{input}}', mode: 'append' })]) },
  { label: 'Automatizar um site', hint: 'abrir, clicar, digitar, ler', need: 'plugin.navegador.site', make: () => chain('Automatizar um site', 'Abre o site, faz os passos e mostra o que leu. Troque o endereço e os passos pelos do seu site; senhas vão como {{vault:site}}.', [T('trigger.manual', {}), T('plugin.navegador.site', { url: 'https://example.com', steps: [{ do: 'wait', on: 'h1', value: '' }, { do: 'read', on: 'h1', value: 'titulo' }], show: 'yes' }), T('util.output', {})]) },
  { label: 'Endpoint com token', hint: 'recebe uma chamada e responde', make: () => {
    const t = T('trigger.webhook', { name: 'meu-endpoint', method: 'POST' }), s = T('sec.token', { got: '{{input.token}}', expected: '' }), l = T('sec.rate', { max: 30, per_s: 60, key: '{{input.token}}' }), q = T('sec.require', { value: '{{input.body}}', fields: ['nome'] });
    return chain('Endpoint com token', 'Recebe um POST com JSON, confere o token e os campos e responde. Preencha o token esperado no nó "Exigir token" (de preferência {{vault:nome}}) e ligue o fluxo.', [t, s, l, q, T('http.respond', { status: 200, type: 'json', body: '{"ok": true, "ola": "{{nodes.' + t.id + '.out.body.nome}}"}' })]);
  } },
  { label: 'Auditoria de um site', hint: 'no ar, certificado, cabeçalhos', make: () => {
    const t = T('trigger.schedule', { mode: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }), up = T('audit.http', { url: 'https://example.com' }), tls = T('audit.tls', { host: 'example.com' }), few = T('logic.if', { value: '{{input.days}}', op: 'lt', equals: '21' }, 'Vence em menos de 21 dias?');
    const hd = T('audit.headers', { url: 'https://example.com' }), down = T('windows.notify', { title: 'Site fora do ar', message: '{{input.url}}: {{input.reason}}' }), warn = T('windows.notify', { title: 'Certificado perto de vencer', message: '{{input.host}} vence em {{input.days}} dias ({{input.expires}})' }), res = T('util.output', {});
    const E = (a, port, b) => ({ id: uid('e'), from: a.id, from_port: port, to: b.id, to_port: 'in' });
    return { ...blank('Auditoria de um site'), description: 'Nos dias úteis, confere se o site responde, quando o certificado vence e os cabeçalhos de segurança. Troque example.com pelo seu site e ligue o fluxo.', nodes: [t, up, down, tls, few, warn, hd, res], edges: [E(t, 'out', up), E(up, 'false', down), E(up, 'true', tls), E(tls, 'out', few), E(few, 'true', warn), E(up, 'true', hd), E(hd, 'out', res)] };
  } },
  { label: 'Relatório de problemas do Dynatrace', hint: 'lista, tabela e aviso no chat', make: () => chain('Problemas abertos no Dynatrace', 'Todo dia útil, lista os problemas abertos e manda uma tabela para o canal. Preencha o ambiente, guarde o token no Cofre e ponha o webhook do canal.', [T('trigger.schedule', { mode: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), T('dynatrace.problems', { env: '', secret: 'dynatrace', status: 'open' }), T('data.table', { list: '{{input.problems}}', format: 'markdown' }), T('notify.chat', { service: 'slack', url: '', text: 'Problemas abertos:\n{{input}}' })]) },
  { label: 'Resumo do Git com IA', hint: 'git log, depois Codex ou Claude', make: () => chain('Resumo do Git com IA', 'Pega os commits recentes do projeto e pede um resumo à IA.', [T('trigger.manual', {}), T('windows.command', { program: 'git', args: ['log', '--oneline', '-20'], cwd: bs.S.project?.path || '' }, 'Commits recentes'), T('agent.cli', { provider: 'claude', prompt: 'Resuma em poucos tópicos, em português, o que mudou nestes commits:\n\n{{input}}', cwd: bs.S.project?.path || '' }), T('util.output', {})]) },
];

// ---------- quadro: câmera ----------
function applyCam() {
  const { x, y, z } = A.cam;
  R.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  const g = GRID * 2 * z;
  R.cv.style.backgroundSize = `${g}px ${g}px`;
  R.cv.style.backgroundPosition = `${x}px ${y}px`;
  R.cv.classList.toggle('far', z < 0.45);
  R.zoom.textContent = Math.round(z * 100) + '%';
}
function zoomAt(sx, sy, factor) {
  const z2 = clamp(A.cam.z * factor, ZMIN, ZMAX), k = z2 / A.cam.z;
  A.cam = { x: sx - (sx - A.cam.x) * k, y: sy - (sy - A.cam.y) * k, z: z2 };
  applyCam();
}
const zoomBy = (f) => { const r = R.cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, f); };
const toWorld = (cx, cy) => { const r = R.cv.getBoundingClientRect(); return [(cx - r.left - A.cam.x) / A.cam.z, (cy - r.top - A.cam.y) / A.cam.z]; };
const rectOf = (n) => ({ x: n.position[0], y: n.position[1], w: NODE_W, h: nodeEls.get(n.id)?.offsetHeight || 96 });
function fit() {
  if (!R.cv) return;
  const r = R.cv.getBoundingClientRect(), nodes = A.flow?.nodes || [];
  if (!nodes.length || !r.width) { A.cam = { x: 40, y: 40, z: 1 }; applyCam(); return; }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of nodes) { const b = rectOf(n); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  const m = r.width < 560 ? 24 : 56;
  // abaixo de ~50% o texto dos nós fica ilegível: mostra o começo do fluxo em vez de encolher tudo
  const z = clamp(Math.min((r.width - m * 2) / (x2 - x1), (r.height - m * 2) / (y2 - y1)), 0.5, 1);
  const w = (x2 - x1) * z, hh = (y2 - y1) * z;
  A.cam = { z, x: w <= r.width - m * 2 ? (r.width - w) / 2 - x1 * z : m - x1 * z, y: hh <= r.height - m * 2 ? (r.height - hh) / 2 - y1 * z : m - y1 * z };
  applyCam();
}

// ---------- quadro: nós ----------
function ports(n) { const s = spec(n.type); return { ins: s?.inputs || [], outs: s?.outputs || [] }; }
function portPos(id, dir, name) {
  const n = node(id); if (!n) return [0, 0];
  const p = ports(n), i = Math.max(0, (dir === 'in' ? p.ins : p.outs).indexOf(name));
  return [n.position[0] + (dir === 'in' ? 0 : NODE_W), n.position[1] + HEAD + PAD + i * ROW + ROW / 2];
}
const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
// nome do agente de IA (Codex, Claude Code ou um que o usuário cadastrou em Agentes de IA)
const cliName = (id) => spec('agent.cli')?.fields.find(f => f.name === 'provider')?.options.find(o => o.value === id)?.label || id || '';
function summary(n) {
  const p = n.params || {}, one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  switch (n.type) {
    case 'trigger.manual': return one(p.sample);
    case 'trigger.schedule': {
      if (p.mode !== 'daily') { const m = +p.every_minutes || 0; return m % 1440 === 0 && m ? `a cada ${m / 1440} dia${m > 1440 ? 's' : ''}` : m % 60 === 0 && m ? `a cada ${m / 60} h` : `a cada ${m} min`; }
      const d = (p.days || []).slice().sort((a, b) => (a || 7) - (b || 7));
      return `${p.time || '--:--'} · ${!d.length || d.length === 7 ? 'todo dia' : d.join() === '1,2,3,4,5' ? 'dias úteis' : d.map(i => DAYS[i]).join(', ')}`;
    }
    case 'logic.if': { const o = spec(n.type).fields.find(f => f.name === 'op').options.find(x => x.value === (p.op || 'eq')); return `${one(p.value)} ${o?.label || ''}${['empty', 'not_empty', 'true'].includes(p.op) ? '' : ' ' + one(p.equals)}`; }
    case 'util.delay': return `${p.seconds} s`;
    case 'windows.command': return one([p.program, ...(Array.isArray(p.args) ? p.args : [])].join(' '));
    case 'windows.notify': return one(p.message) || one(p.title);
    case 'http.request': return `${p.method || 'GET'} ${one(p.url)}`;
    case 'mcp.call': return one(p.tool) || one(p.url);
    case 'agent.cli': return `${cliName(p.provider)}${p.model ? ' (' + one(p.model) + ')' : ''} · ${one(p.prompt)}`;
    case 'ai.openrouter': return one(p.model) || 'escolha o modelo';
    case 'agent.review': return (p.providers || []).map(cliName).join(', ');
    case 'util.text': return one(p.text);
    case 'trigger.file': case 'file.read': case 'file.write': case 'file.list': case 'file.exists': return one(p.path);
    case 'file.manage': return `${{ copy: 'copiar', move: 'mover', trash: 'Lixeira' }[p.op] || ''} ${one(p.from)}`;
    case 'windows.open': return one(p.target);
    case 'windows.powershell': return one(p.script);
    case 'windows.clipboard': return p.op === 'write' ? 'copiar: ' + one(p.text) : 'ler o que está copiado';
    case 'http.download': return one(p.url);
    case 'text.replace': return `${one(p.find)} → ${one(p.replace)}`;
    case 'text.extract': return one(p.pattern);
    case 'text.split': return { line: 'por linha', comma: 'por vírgula', semicolon: 'por ponto e vírgula' }[p.by] || 'por ' + one(p.separator);
    case 'data.datetime': return one(p.format);
    case 'data.set': return Object.keys(p.value || {}).join(', ');
    case 'logic.stop': return one(p.message);
    // nó de plugin: o primeiro texto preenchido e, se houver, quantos passos
    default: { const rows = Object.values(p).find(v => Array.isArray(v) && v.length && typeof v[0] === 'object'); return [one(Object.values(p).find(v => typeof v === 'string' && v.trim() && !/^(yes|no|close|keep)$/.test(v))), rows ? rows.length + (rows.length === 1 ? ' passo' : ' passos') : ''].filter(Boolean).join(' · '); }
  }
}
function fillNode(e, n) {
  const s = spec(n.type), cat = catOf(n), { ins, outs } = ports(n), rows = Math.max(ins.length, outs.length, 1);
  e.className = 'am-node' + (A.sel.has(n.id) ? ' selected' : '') + (n.disabled ? ' disabled' : '') + (s ? '' : ' unknown');
  e.style.setProperty('--cat', cat.c);
  e.setAttribute('aria-label', titleOf(n));
  const used = new Set(A.flow.edges.filter(x => x.from === n.id).map(x => x.from_port));
  const body = el('div.am-ports', { style: { height: rows * ROW + PAD * 2 + 'px' } });
  for (let i = 0; i < rows; i++) {
    const a = ins[i], b = outs[i], top = PAD + i * ROW + ROW / 2 + 'px';
    // rótulo só quando o lado tem mais de uma bolinha: "entrada" e "saída" sozinhas não dizem nada
    body.append(...[el('div.am-row', el('span.am-pl', ins.length > 1 && a ? PORT_LABEL[a] || a : ''), el('span.am-pl.out', outs.length > 1 && b ? PORT_LABEL[b] || b : '')),
      a && el('span.am-port.in', { dataset: { port: a, dir: 'in' }, style: { top }, title: 'Entrada: arraste até uma saída' }),
      b && el('span.am-port.out', { dataset: { port: b, dir: 'out' }, style: { top }, title: `Saída${outs.length > 1 ? ' "' + (PORT_LABEL[b] || b) + '"' : ''}: arraste até a entrada de outro nó` }),
      b && !used.has(b) && el('button.am-plus', { type: 'button', dataset: { plus: b }, style: { top }, title: 'Continuar o fluxo a partir daqui', html: IC.plus })].filter(Boolean));
  }
  e.replaceChildren(
    el('div.am-head', el('span.am-ico', { html: cat.i }), el('span.am-title', { title: titleOf(n) }, titleOf(n)), n.locked && el('span.am-nlock', { html: IC.lock, title: 'Nó trancado' }), n.disabled && el('span.am-off', 'desligado'), el('span.am-state')),
    body, el('div.am-sum', s ? summary(n) : 'Este tipo de nó não existe mais.'), el('div.am-run'));
  paintRun(n.id);
}
function makeNode(n) {
  const e = el('div.am-node', { dataset: { id: n.id } });
  nodeEls.set(n.id, e);
  fillNode(e, n);
  e.style.transform = `translate(${n.position[0]}px, ${n.position[1]}px)`;
  return e;
}
function refreshNode(id) { const n = node(id), e = nodeEls.get(id); if (n && e) { fillNode(e, n); touch([id]); } }
function setPos(n, x, y) { n.position = [x, y]; nodeEls.get(n.id).style.transform = `translate(${x}px, ${y}px)`; }

// ---------- quadro: fios ----------
const curve = ([x1, y1], [x2, y2]) => { const dx = Math.max(36, Math.abs(x2 - x1) * 0.5); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };
function makeEdge(e) {
  const g = document.createElementNS(SVGNS, 'g'), hit = document.createElementNS(SVGNS, 'path'), p = document.createElementNS(SVGNS, 'path');
  g.classList.add('am-edge'); g.dataset.id = e.id; hit.classList.add('am-hit'); p.classList.add('am-wire');
  g.append(hit, p); R.svg.append(g);
  edgeEls.set(e.id, { g, p, hit });
  pathEdge(e);
}
function pathEdge(e) {
  const x = edgeEls.get(e.id); if (!x) return;
  const d = curve(portPos(e.from, 'out', e.from_port), portPos(e.to, 'in', e.to_port));
  x.p.setAttribute('d', d); x.hit.setAttribute('d', d);
  x.g.classList.toggle('selected', A.selEdge === e.id);
}
function touch(ids) { const s = new Set(ids); for (const e of A.flow.edges) if (s.has(e.from) || s.has(e.to)) pathEdge(e); }
function renderAll() {
  if (!R.cv) return;
  nodeEls.clear(); edgeEls.clear();
  R.nodes.replaceChildren(); R.svg.replaceChildren(R.ghost);
  const f = A.flow;
  R.stage.classList.toggle('none', !f);
  if (f) { R.nodes.append(...f.nodes.map(makeNode)); f.edges.forEach(makeEdge); }
  R.empty.hidden = !f || f.nodes.length > 0;
  if (A.cam) applyCam();
  paintRuns();
}

// ---------- seleção e edição ----------
function select(ids, add = false) {
  if (!add) A.sel.clear();
  for (const id of ids) A.sel.add(id);
  A.selEdge = null; paintSel();
}
function paintSel() {
  for (const [id, e] of nodeEls) e.classList.toggle('selected', A.sel.has(id));
  for (const [id, x] of edgeEls) x.g.classList.toggle('selected', A.selEdge === id);
  renderInspector();
}
/** Depois de qualquer mudança no documento: indicadores de "não salvo" e botões. `full`: redesenha o painel da direita. */
function changed(full = false) { paintBar(); if (full) renderInspector(); }
function freeSpot(x, y) {
  x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID;
  const hits = () => A.flow.nodes.some(n => Math.abs(n.position[0] - x) < NODE_W + 12 && Math.abs(n.position[1] - y) < 84);
  for (let i = 0; i < 40 && hits(); i++) y += 96;
  return [x, y];
}
function addNode(type, at, link) {
  if (flowLocked()) return denied();
  const s = spec(type); if (!s) return null;
  if (!A.flow) { A.flow = normalize(blank()); A.flow.nodes = []; A.saved = ''; A.cam = { x: 40, y: 40, z: 1 }; renderAll(); paintList(); }
  commit();
  if (!at) { const r = R.cv.getBoundingClientRect(); at = toWorld(r.left + r.width / 2 - NODE_W * A.cam.z / 2, r.top + r.height / 3); }
  const n = { id: uid(), type, params: clone(s.params || {}), position: freeSpot(at[0], at[1]), disabled: false };
  A.flow.nodes.push(n);
  R.nodes.append(makeNode(n)); R.empty.hidden = true;
  if (link) { const err = link.dir === 'out' ? connect(link.node, link.port, n.id, s.inputs[0], false) : connect(n.id, s.outputs[0], link.node, link.port, false); if (err) bs.toast(err, 'err'); }
  select([n.id]); changed(); reveal(n);
  return n;
}
/** Nó novo que caiu fora da área visível: a câmera anda o mínimo para mostrá-lo inteiro. */
function reveal(n) {
  const r = R.cv.getBoundingClientRect(), b = rectOf(n), m = 24, z = A.cam.z;
  const x1 = b.x * z + A.cam.x, y1 = b.y * z + A.cam.y, x2 = x1 + b.w * z, y2 = y1 + b.h * z;
  const dx = x2 > r.width - m ? r.width - m - x2 : x1 < m ? m - x1 : 0, dy = y2 > r.height - m ? r.height - m - y2 : y1 < m ? m - y1 : 0;
  if (dx || dy) { A.cam.x += dx; A.cam.y += dy; applyCam(); }
}
function reaches(from, target) {
  const seen = new Set(), stack = [from];
  while (stack.length) { const id = stack.pop(); if (id === target) return true; if (seen.has(id)) continue; seen.add(id); for (const e of A.flow.edges) if (e.from === id) stack.push(e.to); }
  return false;
}
/** Liga uma saída a uma entrada; devolve o motivo quando não dá. */
function connect(from, fromPort, to, toPort, record = true) {
  if (!fromPort || !toPort) return 'Este nó não tem bolinha desse lado.';
  if (from === to) return 'Um nó não se liga a ele mesmo.';
  if (reaches(to, from)) return 'Essa ligação fecharia um ciclo: o fluxo voltaria para um nó anterior.';
  if (A.flow.edges.some(e => e.from === from && e.from_port === fromPort && e.to === to && e.to_port === toPort)) return null;
  if (record) commit();
  const e = { id: uid('e'), from, from_port: fromPort, to, to_port: toPort };
  A.flow.edges.push(e); makeEdge(e); refreshNode(from); changed();
  return null;
}
function removeEdge(id, record = true) {
  if (flowLocked()) return denied();
  const e = A.flow.edges.find(x => x.id === id); if (!e) return;
  if (record) commit();
  A.flow.edges = A.flow.edges.filter(x => x.id !== id);
  edgeEls.get(id)?.g.remove(); edgeEls.delete(id);
  if (A.selEdge === id) A.selEdge = null;
  refreshNode(e.from); changed(true);
}
function removeNodes(ids) {
  if (flowLocked()) return denied();
  ids = [...ids].filter(node); if (!ids.length) return;
  if (ids.some(nodeLocked)) { denied('node'); ids = ids.filter(id => !nodeLocked(id)); if (!ids.length) return; }
  commit();
  const gone = new Set(ids), touched = new Set();
  for (const e of A.flow.edges) if (gone.has(e.from) || gone.has(e.to)) { edgeEls.get(e.id)?.g.remove(); edgeEls.delete(e.id); if (!gone.has(e.from)) touched.add(e.from); }
  A.flow.edges = A.flow.edges.filter(e => !gone.has(e.from) && !gone.has(e.to));
  A.flow.nodes = A.flow.nodes.filter(n => !gone.has(n.id));
  for (const id of ids) { nodeEls.get(id)?.remove(); nodeEls.delete(id); A.sel.delete(id); }
  touched.forEach(refreshNode);
  R.empty.hidden = A.flow.nodes.length > 0;
  changed(true);
}
function deleteSelection() { if (A.selEdge) removeEdge(A.selEdge); else removeNodes(A.sel); }
function toggleNodeLock(ids) {
  if (flowLocked()) return denied();
  ids = [...ids].filter(node); if (!ids.length) return;
  commit();
  const on = ids.some(id => !node(id).locked);
  for (const id of ids) { node(id).locked = on; refreshNode(id); }
  changed(true);
}
function toggleDisabled(ids) {
  if (flowLocked()) return denied();
  ids = [...ids].filter(node); if (!ids.length) return;
  if (ids.some(nodeLocked)) { denied('node'); ids = ids.filter(id => !nodeLocked(id)); if (!ids.length) return; }
  commit();
  const off = ids.some(id => !node(id).disabled);
  for (const id of ids) { node(id).disabled = off; refreshNode(id); }
  changed(true);
}
function copySel() { const ids = new Set(A.sel); if (!ids.size) return; A.clip = { nodes: clone(A.flow.nodes.filter(n => ids.has(n.id))), edges: clone(A.flow.edges.filter(e => ids.has(e.from) && ids.has(e.to))) }; }
function paste(offset = 36) {
  if (flowLocked()) return denied();
  if (!A.clip?.nodes.length || !A.flow) return;
  commit();
  const map = new Map(), fresh = [];
  for (const n of clone(A.clip.nodes)) { const id = uid(); map.set(n.id, id); n.id = id; n.position = [n.position[0] + offset, n.position[1] + offset]; A.flow.nodes.push(n); R.nodes.append(makeNode(n)); fresh.push(id); }
  for (const e of clone(A.clip.edges)) { const x = { ...e, id: uid('e'), from: map.get(e.from), to: map.get(e.to) }; A.flow.edges.push(x); makeEdge(x); }
  A.clip.nodes.forEach(n => { n.position = [n.position[0] + offset, n.position[1] + offset]; });
  fresh.forEach(refreshNode); select(fresh); changed();
}
/** Arruma em colunas, da esquerda para a direita, pela ordem das ligações. */
function arrange(record = true) {
  if (flowLocked()) return denied();
  // nó trancado fica onde está: os outros se arrumam em volta
  const nodes = (A.flow?.nodes || []).filter(n => !n.locked); if (!nodes.length) return;
  if (record) commit();
  const depth = new Map(nodes.map(n => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of A.flow.edges) { const d = depth.get(e.from) + 1; if (d > depth.get(e.to)) { depth.set(e.to, d); moved = true; } }
    if (!moved) break;
  }
  const cols = new Map();
  for (const n of nodes) { const d = depth.get(n.id); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); }
  for (const [d, list] of cols) { list.sort((a, b) => a.position[1] - b.position[1]); let y = 48; for (const n of list) { setPos(n, 60 + d * (NODE_W + 60), y); y += (nodeEls.get(n.id)?.offsetHeight || 96) + 36; } }
  touch(nodes.map(n => n.id)); changed();
}

// ---------- quadro: ponteiro ----------
function onDown(e) {
  if (e.button === 2) return;
  closePicker();
  if (e.target.closest('.am-zoom, .am-add')) return;
  R.cv.focus({ preventScroll: true });
  const plus = e.target.closest('.am-plus'), port = e.target.closest('.am-port'), nodeEl = e.target.closest('.am-node'), edge = e.target.closest('.am-edge');
  if (plus && nodeEl) return;
  if (!A.flow) return;
  const cap = () => { try { R.cv.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético */ } };
  if (port && nodeEl) {
    if (flowLocked()) return denied();
    e.preventDefault(); cap();
    const dir = port.dataset.dir, id = nodeEl.dataset.id;
    A.drag = { kind: 'wire', pid: e.pointerId, node: id, port: port.dataset.port, dir, anchor: portPos(id, dir, port.dataset.port) };
    R.cv.classList.add('wiring');
    for (const p of R.nodes.querySelectorAll('.am-port')) { const ok = p.dataset.dir !== dir && p.closest('.am-node').dataset.id !== id; p.classList.toggle('ok', ok); p.classList.toggle('no', !ok); }
  } else if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (e.shiftKey || e.ctrlKey) { if (A.sel.has(id)) { A.sel.delete(id); paintSel(); } else select([id], true); }
    else if (!A.sel.has(id)) select([id]);
    const list = [...A.sel].map(node).filter(n => n && !nodeLocked(n.id));
    if (!list.length) return;
    A.drag = { kind: 'move', pid: e.pointerId, sx: e.clientX, sy: e.clientY, list, start: list.map(n => [...n.position]), moved: false };
    cap();
  } else if (edge) {
    A.sel.clear(); A.selEdge = edge.dataset.id; paintSel();
  } else {
    e.preventDefault(); cap();
    if (e.shiftKey && e.button === 0) { const r = R.cv.getBoundingClientRect(); A.drag = { kind: 'marquee', pid: e.pointerId, sx: e.clientX - r.left, sy: e.clientY - r.top, base: new Set(A.sel) }; }
    else { A.drag = { kind: 'pan', pid: e.pointerId, sx: e.clientX, sy: e.clientY, cx: A.cam.x, cy: A.cam.y, moved: false }; R.cv.classList.add('panning'); }
  }
}
function onMove(e) {
  const d = A.drag; if (!d || d.pid !== e.pointerId) return;
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  if (d.kind === 'pan') { if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true; A.cam.x = d.cx + dx; A.cam.y = d.cy + dy; applyCam(); }
  else if (d.kind === 'move') {
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved) { commit(); d.moved = true; R.cv.classList.add('dragging'); }
    d.list.forEach((n, i) => { let x = d.start[i][0] + dx / A.cam.z, y = d.start[i][1] + dy / A.cam.z; if (!e.altKey) { x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID; } setPos(n, x, y); });
    touch(d.list.map(n => n.id));
  } else if (d.kind === 'marquee') {
    const r = R.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const x1 = Math.min(x, d.sx), y1 = Math.min(y, d.sy), w = Math.abs(x - d.sx), hh = Math.abs(y - d.sy);
    Object.assign(R.marquee.style, { left: x1 + 'px', top: y1 + 'px', width: w + 'px', height: hh + 'px' }); R.marquee.hidden = false;
    const wx1 = (x1 - A.cam.x) / A.cam.z, wy1 = (y1 - A.cam.y) / A.cam.z, wx2 = (x1 + w - A.cam.x) / A.cam.z, wy2 = (y1 + hh - A.cam.y) / A.cam.z;
    A.sel = new Set(d.base);
    for (const n of A.flow.nodes) { const b = rectOf(n); if (b.x < wx2 && b.x + b.w > wx1 && b.y < wy2 && b.y + b.h > wy1) A.sel.add(n.id); }
    for (const [id, x2] of nodeEls) x2.classList.toggle('selected', A.sel.has(id));
  } else if (d.kind === 'wire') {
    const w = toWorld(e.clientX, e.clientY);
    R.ghost.setAttribute('d', d.dir === 'out' ? curve(d.anchor, w) : curve(w, d.anchor));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.am-port.ok') || null;
    if (d.hover && d.hover !== over) d.hover.classList.remove('hover');
    d.hover = over; over?.classList.add('hover');
  }
}
function onUp(e) {
  const d = A.drag; if (!d || d.pid !== e.pointerId) return;
  A.drag = null;
  R.cv.classList.remove('panning', 'dragging', 'wiring');
  if (d.kind === 'pan' && !d.moved) { if (A.sel.size || A.selEdge) { A.sel.clear(); A.selEdge = null; paintSel(); } }
  else if (d.kind === 'move' && d.moved) changed();
  else if (d.kind === 'marquee') { R.marquee.hidden = true; A.selEdge = null; paintSel(); }
  else if (d.kind === 'wire') {
    R.ghost.setAttribute('d', '');
    for (const p of R.nodes.querySelectorAll('.am-port')) p.classList.remove('ok', 'no', 'hover');
    const target = document.elementFromPoint(e.clientX, e.clientY), port = target?.closest?.('.am-port');
    if (port) {
      const id = port.closest('.am-node').dataset.id;
      const err = port.dataset.dir === d.dir ? (d.dir === 'out' ? 'Solte a saída numa entrada (a bolinha da esquerda de outro nó).' : 'Solte a entrada numa saída (a bolinha da direita de outro nó).')
        : d.dir === 'out' ? connect(d.node, d.port, id, port.dataset.port) : connect(id, port.dataset.port, d.node, d.port);
      if (err) bs.toast(err, 'err');
    } else if (target && R.cv.contains(target) && !target.closest('.am-node, .am-zoom, .am-add')) {
      // fio solto no vazio: escolhe o próximo nó e já liga
      const at = toWorld(e.clientX, e.clientY);
      openPicker(e.clientX, e.clientY, (s) => addNode(s.type, [d.dir === 'out' ? at[0] : at[0] - NODE_W, at[1] - HEAD], d), d.dir === 'out' ? 'inputs' : 'outputs');
    }
  }
}
function onWheel(e) {
  if (e.target.closest('.am-pick')) return;
  e.preventDefault();
  const r = R.cv.getBoundingClientRect();
  // trackpad com dois dedos desloca; roda do mouse e pinça (Ctrl) dão zoom no ponto do cursor
  if (!e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 50) { A.cam.x -= e.deltaX; A.cam.y -= e.deltaY; applyCam(); return; }
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
}
function onContext(e) {
  e.preventDefault(); closePicker();
  const nodeEl = e.target.closest('.am-node'), edge = e.target.closest('.am-edge');
  if (edge) { A.sel.clear(); A.selEdge = edge.dataset.id; paintSel(); return bs.showMenu(e, [{ label: 'Remover conexão', icon: IC.trash, k: 'Del', action: () => removeEdge(edge.dataset.id) }]); }
  if (nodeEl) {
    const id = nodeEl.dataset.id; if (!A.sel.has(id)) select([id]);
    const many = A.sel.size > 1, off = [...A.sel].every(i => node(i)?.disabled);
    return bs.showMenu(e, [
      { label: many ? `Duplicar ${A.sel.size} nós` : 'Duplicar', icon: IC.copy, k: 'Ctrl+D', action: () => { copySel(); paste(); } },
      { label: off ? 'Ligar' : 'Desligar', action: () => toggleDisabled(A.sel) },
      { label: [...A.sel].every(i => node(i)?.locked) ? (many ? 'Destrancar os nós' : 'Destrancar o nó') : (many ? 'Trancar os nós' : 'Trancar o nó'), icon: IC.lock, action: () => toggleNodeLock(A.sel) },
      '-', { label: many ? `Excluir ${A.sel.size} nós` : 'Excluir', icon: IC.trash, k: 'Del', action: () => removeNodes(A.sel) }]);
  }
  const at = toWorld(e.clientX, e.clientY), cx = e.clientX, cy = e.clientY;
  bs.showMenu(e, [
    { label: 'Adicionar nó aqui…', icon: IC.plus, action: () => openPicker(cx, cy, (s) => addNode(s.type, at)) },
    ...(A.clip ? [{ label: 'Colar', k: 'Ctrl+V', action: () => paste() }] : []),
    '-', { label: 'Organizar em colunas', icon: IC.tidy, action: () => { arrange(); fit(); } }, { label: 'Enquadrar tudo', icon: IC.fit, k: 'F', action: fit }]);
}

// ---------- seletor de nós ----------
function closePicker() { if (picker) { picker.remove(); picker = null; } }
/** `need`: só os nós que têm bolinha desse lado ('inputs' ou 'outputs'), para o fio solto no vazio. */
function openPicker(cx, cy, onPick, need) {
  closePicker();
  if (flowLocked()) return denied();
  const list = A.specs.filter(s => !need || (s[need] || []).length);
  const input = el('input', { type: 'search', placeholder: 'Buscar nó', 'aria-label': 'Buscar nó', spellcheck: false });
  const body = el('div.am-pick-list');
  let items = [], cur = 0;
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    // com busca: quem tem o termo no nome vem antes de quem só o tem na descrição (e a lista deixa de ser por categoria)
    const rank = (s) => s.name.toLowerCase().startsWith(q) ? 0 : s.name.toLowerCase().includes(q) ? 1 : s.category.toLowerCase().includes(q) ? 2 : (s.desc || '').toLowerCase().includes(q) ? 3 : 9;
    items = q ? list.map(s => [rank(s), s]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0]).map(x => x[1]) : list;
    cur = clamp(cur, 0, Math.max(0, items.length - 1));
    body.replaceChildren();
    let cat = null;
    items.forEach((s, i) => {
      if (!q && s.category !== cat) { cat = s.category; body.append(el('div.am-pick-cat', cat)); }
      body.append(el('button.am-pick-it' + (i === cur ? '.on' : ''), { type: 'button', style: { '--cat': (CATS[s.category] || PLUG_CAT).c }, onclick: () => { closePicker(); onPick(s); }, onpointerenter: () => { cur = i; body.querySelectorAll('.am-pick-it').forEach((b, j) => b.classList.toggle('on', j === i)); } },
        el('span.am-ico', { html: (CATS[s.category] || PLUG_CAT).i }), el('span.am-pick-tx', el('b', s.name), el('small', s.desc || ''))));
    });
    if (!items.length) body.append(el('p.am-hint', 'Nenhum nó com esse nome.'));
  };
  input.oninput = () => { cur = 0; paint(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cur = (cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length); paint(); body.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); const s = items[cur]; if (s) { closePicker(); onPick(s); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); R.cv.focus(); }
  };
  picker = el('div.am-pick', { role: 'dialog', 'aria-label': 'Adicionar nó' }, input, body);
  picker.onpointerdown = (e) => e.stopPropagation();
  root.append(picker); paint();
  const r = root.getBoundingClientRect(), w = picker.offsetWidth, hh = picker.offsetHeight;
  picker.style.left = clamp(cx - r.left, 8, Math.max(8, r.width - w - 8)) + 'px';
  picker.style.top = clamp(cy - r.top, 8, Math.max(8, r.height - hh - 8)) + 'px';
  input.focus();
}

// ---------- painel da direita ----------
/** Nós que vêm antes deste (para oferecer a saída deles nas expressões). */
function upstream(id) {
  const seen = new Set(), stack = [id];
  while (stack.length) { const x = stack.pop(); for (const e of A.flow.edges) if (e.to === x && !seen.has(e.from)) { seen.add(e.from); stack.push(e.from); } }
  return A.flow.nodes.filter(n => seen.has(n.id));
}
function insertAt(input, text) {
  const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
  input.setRangeText(text, a, b, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
}
function field(n, f) {
  const s = spec(n.type), cur = n.params[f.name] ?? s.params[f.name];
  let started = false;
  // um passo no desfazer por campo editado (não um por tecla)
  const set = (v) => { if (!started) { commit(); started = true; } n.params[f.name] = v; const e = nodeEls.get(n.id); if (e) { e.querySelector('.am-sum').textContent = summary(n); } changed(); };
  const err = el('small.am-ferr', { hidden: true });
  let input, extra = null;
  if (f.kind === 'select') {
    input = el('select', {}, f.options.map(o => el('option', { value: String(o.value ?? o), selected: String(o.value ?? o) === String(cur) }, o.label ?? o)));
    input.onchange = () => { set(input.value); renderInspector(); };
  } else if (f.kind === 'checks') {
    const on = new Set(Array.isArray(cur) ? cur : []);
    input = el('div.am-checks', {}, f.options.map(o => { const c = el('input', { type: 'checkbox', checked: on.has(o.value) }); c.onchange = () => { c.checked ? on.add(o.value) : on.delete(o.value); set(f.options.map(x => x.value).filter(v => on.has(v))); }; return el('label', c, el('span', o.label)); }));
  } else if (f.kind === 'number') {
    input = el('input', { type: 'number', value: cur ?? '', min: f.min, max: f.max });
    input.oninput = () => { const v = Number(input.value); const bad = input.value === '' || !Number.isFinite(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max); err.hidden = !bad; err.textContent = bad ? `Use um número de ${f.min ?? 0} a ${f.max ?? '∞'}.` : ''; if (!bad) set(v); };
  } else if (f.kind === 'time') {
    input = el('input', { type: 'time', value: cur || '09:00' }); input.oninput = () => { if (input.value) set(input.value); };
  } else if (f.kind === 'json') {
    input = el('textarea.mono', { rows: 3, spellcheck: false, value: JSON.stringify(cur ?? {}, null, 2) });
    input.oninput = () => { try { const v = JSON.parse(input.value || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('precisa ser um objeto: { "chave": "valor" }'); err.hidden = true; set(v); } catch (e) { err.hidden = false; err.textContent = 'JSON inválido: ' + e.message; } };
  } else if (f.kind === 'lines') {
    input = el('textarea.mono', { rows: Math.max(2, Math.min(6, (Array.isArray(cur) ? cur.length : 1))), spellcheck: false, value: (Array.isArray(cur) ? cur : []).join('\n') });
    input.oninput = () => set(input.value.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1));
  } else if (f.kind === 'rows') {
    // lista de linhas (os passos de um roteiro): cada coluna é um campo; `hide` esconde a coluna conforme outra
    const rows = Array.isArray(cur) ? clone(cur) : [];
    const push = () => set(clone(rows));
    const draw = () => input.replaceChildren(...rows.map((r, i) => {
      const cells = f.columns.map(c => {
        if (c.hide && Object.entries(c.hide).some(([k, list]) => list.includes(r[k]))) return null;
        if (c.kind === 'select') { const sel = el('select', {}, c.options.map(o => el('option', { value: String(o.value), selected: o.value === r[c.name] }, o.label))); sel.onchange = () => { r[c.name] = sel.value; push(); draw(); }; return sel; }
        const t = el('input', { type: 'text', value: r[c.name] ?? '', placeholder: c.placeholder || '', spellcheck: false }); t.oninput = () => { r[c.name] = t.value; push(); }; return t;
      });
      return el('div.am-step', el('span.am-step-n', String(i + 1)), el('div.am-step-cells', {}, cells),
        el('div.am-step-acts', i > 0 && el('button.icon-btn', { type: 'button', title: 'Subir', html: IC.up, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); push(); draw(); } }),
          el('button.icon-btn', { type: 'button', title: 'Remover', html: IC.x, onclick: () => { rows.splice(i, 1); push(); draw(); } })));
    }), el('button.chip.am-step-add', { type: 'button', onclick: () => { rows.push(Object.fromEntries(f.columns.map(c => [c.name, c.kind === 'select' ? c.options[0].value : '']))); push(); draw(); } }, el('span', { html: IC.plus }), el('span', f.add || 'Linha')));
    input = el('div.am-steps'); draw();
  } else if (f.kind === 'area') {
    input = el('textarea', { rows: 4, value: cur ?? '', placeholder: f.placeholder || '' }); input.oninput = () => set(input.value);
  } else {
    input = el('input', { type: 'text', value: cur ?? '', placeholder: f.placeholder || '', spellcheck: false }); input.oninput = () => set(input.value);
  }
  // campo de caminho: o botão abre o seletor do Windows (arquivo, pasta, onde gravar ou um programa)
  let control = input;
  if (f.pick) {
    const go = guard(async (kind) => {
      const r = await bs.api('automator/pick', { kind, start: /\{\{/.test(input.value) ? '' : input.value, title: f.label }, { method: 'POST' });
      if (r.path) { input.value = r.path; set(r.path); }
    });
    const b = el('button.icon-btn.am-browse', { type: 'button', title: 'Procurar no PC', html: CATS['Arquivos'].i });
    b.onclick = (e) => f.pick === 'any' ? bs.showMenu(e, [{ label: 'Escolher um arquivo…', action: () => go('file') }, { label: 'Escolher uma pasta…', action: () => go('folder') }]) : go(f.pick);
    control = el('div.am-browse-line', input, b);
  }
  // expressões: o que chegou neste nó e a saída dos nós anteriores, sem decorar identificadores
  if (['area', 'text', 'json', 'lines'].includes(f.kind) && s.inputs.length) {
    extra = el('button.am-link', { type: 'button', title: 'Usar o que veio de outro nó' }, '+ dado');
    extra.onclick = (e) => bs.showMenu(e, [
      { label: 'O que chegou neste nó', k: '{{input}}', action: () => insertAt(input, '{{input}}') },
      ...upstream(n.id).flatMap(u => (spec(u.type)?.outputs || []).map(p => ({ label: `Saída de ${titleOf(u)}${spec(u.type).outputs.length > 1 ? ' (' + (PORT_LABEL[p] || p) + ')' : ''}`, action: () => insertAt(input, `{{nodes.${u.id}.${p}}}`) }))),
    ]);
  }
  if (f.clis) extra = el('button.am-link', { type: 'button', title: 'Modelo, esforço e programas de cada agente', onclick: () => bs.aiClis.open(typeof n.params[f.name] === 'string' ? n.params[f.name] : undefined) }, 'configurar');
  const id = 'amf-' + uid('');
  const group = f.kind === 'checks' || f.kind === 'rows';
  if (!group) input.id = id;
  return el('div.am-field', el('div.am-flabel', el('label', group ? {} : { htmlFor: id }, f.label), extra), control, f.help && el('small.am-hint', f.help), err);
}
function runBlock(id) {
  const r = currentRun()?.nodes?.find(x => x.id === id); if (!r || r.status === 'skipped') return null;
  const out = r.output && Object.keys(r.output).length === 1 ? Object.values(r.output)[0] : r.output;
  return el('section.am-sec', el('h4', 'Última execução', el('span.am-tag.' + r.status, STATUS[r.status] + (r.ms != null ? ' · ' + fmtMs(r.ms) : ''))),
    r.error ? el('pre.am-out.err', r.error) : r.status === 'completed' ? el('pre.am-out', show(out) || '(vazio)') : null);
}
function runsBlock() {
  const box = el('div.am-runs');
  if (!A.runs.length) { box.append(el('p.am-hint', A.flow?.id ? 'Nenhuma execução ainda. Clique em Executar.' : 'As execuções aparecem aqui depois de salvar e executar.')); return box; }
  for (const r of A.runs.slice(0, 12)) {
    const dur = r.finished_at ? fmtMs(r.finished_at - r.started_at) : '';
    const d = el('details.am-runrow.' + r.status, {}, el('summary', el('i.am-dot'), el('span.am-rwhen', fmtWhen(r.started_at)), el('span.am-rst', STATUS[r.status] || r.status), el('span.am-rdur', [r.scheduled ? 'automático' : '', dur].filter(Boolean).join(' · '))));
    if (r.error && !(r.nodes || []).some(x => x.error)) d.append(el('pre.am-out.err', r.error));
    for (const x of r.nodes || []) {
      if (x.status === 'skipped') continue;
      const n = node(x.id), out = x.output && Object.keys(x.output).length === 1 ? Object.values(x.output)[0] : x.output;
      d.append(el('div.am-rnode', el('b', n ? titleOf(n) : 'nó removido'), el('span.am-tag.' + x.status, STATUS[x.status] + (x.ms != null ? ' · ' + fmtMs(x.ms) : ''))));
      if (x.error) d.append(el('pre.am-out.err', x.error)); else if (x.status === 'completed' && show(out)) d.append(el('pre.am-out', show(out)));
    }
    box.append(d);
  }
  return box;
}
function renderInspector() {
  renderInspectorInner();
  if (!R.insp || !A.flow) return;
  const one = A.sel.size === 1 ? node([...A.sel][0]) : null, whole = flowLocked();
  if (one && !whole) {
    // cadeado do nó, ao lado do fechar
    const x = R.insp.querySelector('.am-ihd .icon-btn');
    if (x) x.before(el('button.icon-btn' + (one.locked ? '.on' : ''), { type: 'button', title: one.locked ? 'Destrancar o nó' : 'Trancar o nó (não move, não edita, não exclui)', html: one.locked ? IC.lock : IC.unlock, onclick: () => toggleNodeLock([one.id]) }));
  }
  if (!whole && !one?.locked) return;
  R.insp.querySelectorAll('input, select, textarea, button').forEach(x => { if (!x.closest('.am-ihd')) x.disabled = true; });
  const note = el('p.am-locknote', el('span', { html: IC.lock }), el('span', whole ? 'Fluxo trancado: só visualização.' : 'Nó trancado.'), el('button.am-link', { type: 'button', onclick: () => whole ? toggleLock() : toggleNodeLock([one.id]) }, 'Destrancar'));
  const hd = R.insp.querySelector('.am-ihd'); if (hd) hd.after(note); else R.insp.prepend(note);
}
function renderInspectorInner() {
  if (!R.insp) return;
  const keep = R.insp.scrollTop, f = A.flow;
  R.insp.classList.toggle('has-node', A.sel.size > 0);
  if (!f) { R.insp.replaceChildren(); return; }
  if (A.sel.size > 1) {
    R.insp.replaceChildren(el('header.am-ihd', el('b', `${A.sel.size} nós selecionados`), el('button.icon-btn', { type: 'button', title: 'Fechar', html: IC.x, onclick: () => select([]) })),
      el('div.am-ibody', el('div.am-acts', el('button.chip', { type: 'button', onclick: () => { copySel(); paste(); } }, 'Duplicar'), el('button.chip', { type: 'button', onclick: () => toggleDisabled(A.sel) }, 'Ligar ou desligar'), el('button.chip.danger', { type: 'button', onclick: () => removeNodes(A.sel) }, 'Excluir')),
        el('p.am-hint', 'Arraste qualquer um deles para mover todos. Shift + arrastar no fundo seleciona por laço.')));
    return;
  }
  const n = node([...A.sel][0]);
  if (n) {
    const s = spec(n.type), cat = catOf(n);
    let named = false;
    const title = el('input', { type: 'text', value: n.title || '', placeholder: s?.name || n.type, 'aria-label': 'Nome do nó' });
    title.oninput = () => { if (!named) { commit(); named = true; } if (title.value.trim()) n.title = title.value; else delete n.title; const e = nodeEls.get(n.id)?.querySelector('.am-title'); if (e) e.textContent = e.title = titleOf(n); changed(); };
    const visible = (f2) => !f2.show || Object.entries(f2.show).every(([k, v]) => [].concat(v).map(String).includes(String(n.params[k] ?? s.params[k])));
    R.insp.replaceChildren(
      el('header.am-ihd', { style: { '--cat': cat.c } }, el('span.am-ico', { html: cat.i }), el('div.am-ihd-tx', el('b', s?.name || n.type), el('small', s?.desc || '')), el('button.icon-btn', { type: 'button', title: 'Fechar', html: IC.x, onclick: () => select([]) })),
      el('div.am-ibody',
        el('label.am-field', el('span.am-flabel', el('span', 'Nome')), title),
        (s?.fields || []).filter(visible).map(f2 => field(n, f2)),
        n.type === 'ai.openrouter' && el('button.chip.am-wide', { type: 'button', onclick: () => plugin.vault.request('openrouter') }, el('span', { html: IC.key }), 'Guardar o token no Cofre'),
        n.type === 'trigger.webhook' && el('div.am-hook', el('code', hookUrl(n.params.name)), el('button.icon-btn', { type: 'button', title: 'Copiar o endereço', html: IC.copy, onclick: () => { bs.copyText(hookUrl(n.params.name)); bs.toast('Endereço copiado', 'ok'); } })),
        AUTO.includes(n.type) && el('p.am-hint', f.active ? `Ligado${n.type === 'trigger.schedule' && f.next_run ? ': próxima execução ' + fmtWhen(f.next_run) : ''}.` : 'Este gatilho só dispara com o interruptor "Ligado" aceso, na barra de cima.'),
        runBlock(n.id),
        el('div.am-acts', el('button.chip', { type: 'button', onclick: () => toggleDisabled([n.id]) }, n.disabled ? 'Ligar nó' : 'Desligar nó'), el('button.chip.danger', { type: 'button', onclick: () => removeNodes([n.id]) }, 'Excluir nó'))));
    R.insp.scrollTop = keep;
    return;
  }
  let described = false;
  const desc = el('textarea', { rows: 2, value: f.description || '', placeholder: 'Para que serve este fluxo' });
  desc.oninput = () => { if (!described) { commit(); described = true; } f.description = desc.value; changed(); };
  R.insp.replaceChildren(
    el('div.am-ibody',
      el('label.am-field', el('span.am-flabel', el('span', 'Descrição')), desc),
      el('section.am-sec', el('h4', 'Execuções'), runsBlock()),
      el('section.am-sec.am-tips', el('h4', 'Como montar'),
        el('p', 'Arraste da bolinha de um nó até a bolinha de outro para ligar. Solte no vazio para escolher o próximo nó.'),
        el('p', 'Duplo clique no fundo adiciona um nó. Clique num fio e Delete para remover.'),
        el('p', 'Shift + arrastar seleciona vários. Ctrl+Z desfaz, Ctrl+D duplica, F enquadra.'))));
  R.insp.scrollTop = keep;
}

// ---------- execução ----------
function paintRun(id) {
  const e = nodeEls.get(id); if (!e) return;
  const r = currentRun()?.nodes?.find(x => x.id === id), state = e.querySelector('.am-state'), box = e.querySelector('.am-run');
  e.classList.remove('st-running', 'st-completed', 'st-failed', 'st-skipped', 'st-cancelled');
  if (!r) { state.replaceChildren(); box.replaceChildren(); return; }
  e.classList.add('st-' + r.status);
  if (r.status === 'running') { state.replaceChildren(el('span.am-spin')); box.replaceChildren(); }
  else if (r.status === 'completed') {
    state.replaceChildren(el('span.am-ok', { html: IC.ok }), el('span.am-ms', fmtMs(r.ms)));
    // nó do meio não repete o resultado no quadro: quem mostra é o último de cada caminho
    const leaf = !A.flow.edges.some(x => x.from === id), out = r.output && Object.keys(r.output).length === 1 ? Object.values(r.output)[0] : r.output, text = show(out);
    box.replaceChildren(...(leaf && text ? [el('div.am-prev', text.length > 600 ? text.slice(0, 600) + '…' : text)] : []));
  } else if (r.status === 'failed') { state.replaceChildren(el('span.am-bad', { html: IC.err })); box.replaceChildren(el('div.am-err', { title: r.error || '' }, r.error || 'falhou')); }
  else if (r.status === 'cancelled') { state.replaceChildren(el('span.am-ms', 'parado')); box.replaceChildren(); }
  else { state.replaceChildren(); box.replaceChildren(); }
}
function paintRuns() {
  if (!A.flow) return;
  const run = currentRun(), st = new Map((run?.nodes || []).map(x => [x.id, x.status]));
  for (const id of nodeEls.keys()) paintRun(id);
  for (const e of A.flow.edges) { const x = edgeEls.get(e.id); if (!x) continue; const a = st.get(e.from), b = st.get(e.to); x.g.classList.toggle('hot', a === 'completed' && b === 'running'); x.g.classList.toggle('lit', a === 'completed' && b === 'completed'); }
}
async function pollRuns() {
  if (!A.flow?.id) { if (A.runs.length) { A.runs = []; A.runSig = ''; paintRuns(); renderInspector(); } return; }
  const id = A.flow.id;
  let runs; try { runs = await bs.api('automator/runs', { flow: id, limit: 20 }, { quiet: true }); } catch { return; }
  if (A.flow?.id !== id) return;
  const sig = runs.map(r => r.id + r.status + (r.nodes || []).map(n => n.status).join('')).join('|');
  if (sig === A.runSig) return;
  const was = isRunning();
  A.runs = runs; A.runSig = sig;
  paintRuns(); paintBar();
  // o painel só é redesenhado se ninguém estiver digitando nele
  if (!R.insp.contains(document.activeElement) || !document.activeElement.matches('input, textarea, select')) renderInspector();
  if (was && !isRunning()) { const r = runs[0]; if (r?.status === 'failed') bs.toast('Fluxo falhou: ' + (r.error || ''), 'err'); refreshFlows().catch(() => {}); }
}
const run = guard(async () => {
  if (!A.flow || busyRun) return;
  busyRun = true;
  try {
    if (isRunning()) { await post('automator/run', { action: 'stop', flow_id: A.flow.id }); }
    else {
      if (!A.flow.nodes.some(n => n.type.startsWith('trigger.') && !n.disabled)) throw new Error('o fluxo não tem gatilho. Adicione "Iniciar manualmente" ou "Agenda".');
      if (isDirty() || !A.flow.id) { if (!(await save())) return; }
      await post('automator/run', { flow_id: A.flow.id });
    }
    await pollRuns();
  } finally { busyRun = false; paintBar(); }
});

// ---------- barra e lista ----------
function paintBar() {
  if (!R.bar) return;
  const f = A.flow, dirty = isDirty(), running = isRunning();
  R.bar.classList.toggle('none', !f);
  if (R.name.value !== (f?.name || '') && document.activeElement !== R.name) R.name.value = f?.name || '';
  R.dirty.hidden = !dirty; bs.pages.dirty('automator', dirty);
  R.save.disabled = !f || !dirty;
  const locked = flowLocked();
  R.undo.disabled = locked || !A.undo.length; R.redo.disabled = locked || !A.redo.length;
  root.classList.toggle('ro', locked); R.name.disabled = locked;
  R.lockbtn.innerHTML = locked ? IC.lock : IC.unlock; R.lockbtn.classList.toggle('on', locked);
  R.lockbtn.title = locked ? 'Trancado: só visualização. Clique para destrancar' : 'Trancar o fluxo (só visualização)';
  R.sched.hidden = !hasSchedule();
  R.active.checked = !!f?.active;
  R.next.textContent = f?.active && f.next_run && !dirty ? fmtWhen(f.next_run) : '';
  R.run.classList.toggle('stop', running);
  R.run.innerHTML = running ? `${IC.stop}<span>Parar</span>` : `${IC.play}<span>Executar</span>`;
  R.run.title = running ? 'Parar a execução' : 'Salvar e executar agora';
  const cur = R.list?.querySelector('.am-flow.current .am-fdirty'); if (cur) cur.hidden = !dirty;
}
// trancar e destrancar grava na hora (não é uma edição do desenho). Trancar o fluxo aberto salva o que estiver pendente.
const toggleLock = guard(async (f = A.flow) => {
  if (!f) return;
  const to = !f.locked;
  if (f === A.flow) {
    A.flow.locked = to;
    if (!(await save())) { A.flow.locked = !to; paintBar(); return; }
    for (const n of A.flow.nodes) refreshNode(n.id);
    renderInspector();
  } else { await post('automator/flows', { flow: { ...f, locked: to } }); await refreshFlows(); }
  bs.toast(to ? `"${f.name}" trancado: só visualização.` : `"${f.name}" destrancado.`, 'ok');
});
// botão direito num fluxo da lista: o que dá para fazer sem abrir (rodar, ligar) e o que abre antes (renomear)
function flowMenu(e, f) {
  const cur = f.id === A.flow?.id, running = cur && isRunning();
  bs.showMenu(e, [
    ...(cur ? [] : [{ label: 'Abrir', action: () => pick(f) }]),
    { label: f.locked ? 'Destrancar' : 'Trancar (só visualização)', icon: f.locked ? IC.unlock : IC.lock, action: () => toggleLock(cur ? A.flow : f) },
    { label: running ? 'Parar' : 'Executar', icon: running ? IC.stop : IC.play, action: guard(async () => {
      if (cur) return run();
      await post('automator/run', { flow_id: f.id }); bs.toast(`"${f.name}" começou a rodar.`, 'ok');
    }) },
    ...(hasSchedule(f) ? [{ label: f.active ? 'Desligar' : 'Ligar', action: guard(async () => {
      if (cur) { R.active.checked = !A.flow.active; return R.active.onchange(); }
      const saved = await post('automator/flows', { flow: { ...f, active: !f.active } });
      await refreshFlows(); bs.toast(saved.active ? `"${f.name}" ligado${saved.next_run ? ': próxima execução ' + fmtWhen(saved.next_run) : ''}.` : `"${f.name}" desligado.`, 'ok');
    }) }] : []),
    '-',
    { label: 'Renomear', action: async () => { if (f.locked) return denied(); await pick(f); if (A.flow?.id === f.id) { R.name.focus(); R.name.select(); } } },
    { label: 'Duplicar', icon: IC.copy, action: () => create(() => ({ ...clone(f), id: '', active: false, next_run: null, name: f.name + ' (cópia)' })) },
    { label: 'Exportar', action: () => exportFlow(cur ? A.flow : f) },
    '-',
    { label: 'Excluir…', icon: IC.trash, action: guard(() => f.locked ? denied() : removeFlow(cur ? A.flow : f)) },
  ], f.name);
}
function paintList() {
  if (!R.list) return;
  const q = R.search.value.trim().toLowerCase();
  const items = A.flows.filter(f => !q || f.name.toLowerCase().includes(q));
  const draft = A.flow && !A.flow.id ? [A.flow] : [];
  R.list.replaceChildren(...[...draft, ...items].map(f => {
    const cur = f === A.flow || (f.id && f.id === A.flow?.id);
    const meta = !f.id ? 'rascunho, ainda não salvo' : f.active && f.next_run ? 'agenda · ' + fmtWhen(f.next_run) : hasSchedule(f) ? (f.active ? 'ligado' : 'desligado') : 'manual';
    return el('button.am-flow' + (cur ? '.current' : ''), { type: 'button', onclick: () => f.id && pick(A.flows.find(x => x.id === f.id)), oncontextmenu: (e) => { e.preventDefault(); if (f.id) flowMenu(e, A.flows.find(x => x.id === f.id) || f); } },
      el('span.am-fname', el('span', f.name || 'Fluxo sem nome'), f.locked && el('span.am-flock', { html: IC.lock, title: 'Trancado: só visualização' }), el('i.am-fdirty', { hidden: !(cur && isDirty()), title: 'Alterações não salvas' })), el('span.am-fmeta' + (f.active ? '.live' : ''), meta));
  }));
  if (!R.list.childElementCount) R.list.append(el('p.am-hint', q ? 'Nenhum fluxo com esse nome.' : 'Nenhum fluxo ainda.'));
}

// ---------- criar com IA ----------
function generate() {
  const html = `<div class="dlg-hd"><div class="dlg-ic">${IC.spark}</div><div><h3>Criar fluxo com IA</h3><p>Descreva a automação. A proposta abre no quadro para você conferir antes de salvar.</p></div></div>
    <label class="fld">O que o fluxo deve fazer<textarea id="amGenReq" rows="5" placeholder="Todo dia útil às 9h, rodar git pull na pasta do projeto e me avisar se der erro."></textarea></label>
    <label class="fld">Quem monta<select id="amGenWho">${(spec('agent.cli')?.fields.find(f => f.name === 'provider')?.options || []).map(o => `<option value="${esc(o.value)}"${o.value === 'claude' ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}<option value="openrouter">OpenRouter</option></select></label>
    <label class="fld" id="amGenModelBox" hidden>Modelo do OpenRouter<input id="amGenModel" placeholder="provedor/modelo" spellcheck="false"></label>
    <p class="am-gen-st" id="amGenSt" aria-live="polite"></p>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="amGenGo">Gerar proposta</button></div>`;
  dialog('amGen', html, (box) => {
    const $ = (s) => box.querySelector(s), go = $('#amGenGo'), st = $('#amGenSt');
    $('#amGenWho').onchange = (e) => { $('#amGenModelBox').hidden = e.target.value !== 'openrouter'; };
    $('#amGenReq').focus();
    go.onclick = async () => {
      const request = $('#amGenReq').value.trim(), provider = $('#amGenWho').value, model = $('#amGenModel').value.trim();
      if (!request) { st.textContent = 'Descreva o que o fluxo deve fazer.'; return $('#amGenReq').focus(); }
      if (provider === 'openrouter' && !model) { st.textContent = 'Informe o modelo do OpenRouter.'; return $('#amGenModel').focus(); }
      go.disabled = true; st.textContent = 'Montando a proposta… pode levar até 3 minutos.';
      try {
        const flow = await post('automator/generate', { request, provider, model, cwd: bs.S.project?.path || '' });
        box.hidden = true;
        if (!(await leave())) return;
        open(flow, true); requestAnimationFrame(() => { arrange(false); fit(); });
        bs.toast('Proposta pronta. Confira os nós e salve.', 'ok');
      } catch (e) { st.textContent = 'Não deu: ' + e.message; } finally { go.disabled = false; }
    };
  });
}

// ---------- montagem ----------
function mount(pane) {
  root = pane; A.pane = pane; pane.classList.add('am');
  pane.innerHTML = `<div class="am-grid">
    <aside class="am-side">
      <div class="am-side-hd"><button class="chip primary am-grow" data-a="new" type="button">${IC.plus}<span>Novo fluxo</span></button></div>
      <div class="am-side-row"><button class="chip am-grow" data-a="tpl" type="button">Modelos</button><button class="chip am-grow" data-a="ai" type="button">${IC.spark}<span>Criar com IA</span></button></div>
      <input class="am-search" type="search" placeholder="Buscar fluxo" aria-label="Buscar fluxo" spellcheck="false">
      <div class="am-list"></div>
    </aside>
    <div class="am-main">
      <div class="am-bar">
        <input class="am-name" type="text" placeholder="Nome do fluxo" aria-label="Nome do fluxo" spellcheck="false" maxlength="120">
        <i class="am-dirty" hidden title="Alterações não salvas"></i>
        <span class="am-sp"></span>
        <label class="am-sched" hidden title="Ligado, o fluxo roda sozinho (na hora marcada, ao abrir o BlueScreen, quando o arquivo mudar ou quando chamam o endpoint) enquanto o BlueScreen estiver aberto, inclusive na bandeja"><input type="checkbox" class="am-active"><span class="am-switch"></span><span>Ligado</span><small class="am-next"></small></label>
        <button class="icon-btn am-lockbtn" data-a="lock" type="button"></button><span class="am-group"><button class="icon-btn" data-a="undo" type="button" title="Desfazer (Ctrl+Z)">${IC.undo}</button><button class="icon-btn" data-a="redo" type="button" title="Refazer (Ctrl+Shift+Z)">${IC.redo}</button><button class="icon-btn" data-a="tidy" type="button" title="Organizar em colunas">${IC.tidy}</button><button class="icon-btn" data-a="more" type="button" title="Importar, exportar, excluir">${IC.more}</button></span>
        <button class="chip am-save" data-a="save" type="button" title="Salvar (Ctrl+S)">Salvar</button>
        <button class="chip primary am-runbtn" data-a="run" type="button"></button>
      </div>
      <div class="am-stage none">
        <div class="am-cv" tabindex="0" role="application" aria-label="Quadro do fluxo">
          <div class="am-world"><svg class="am-wires"></svg><div class="am-nodes"></div></div>
          <div class="am-marquee" hidden></div>
          <div class="am-empty" hidden><p>Este fluxo está vazio</p><small>Duplo clique no quadro ou use "Adicionar nó".</small></div>
          <button class="chip am-add" data-a="add" type="button">${IC.plus}<span>Adicionar nó</span></button>
          <div class="am-zoom"><button class="icon-btn" data-a="zout" type="button" title="Afastar">−</button><button class="am-zval" data-a="z100" type="button" title="Voltar para 100%">100%</button><button class="icon-btn" data-a="zin" type="button" title="Aproximar">+</button><button class="icon-btn" data-a="fit" type="button" title="Enquadrar tudo (F)">${IC.fit}</button></div>
        </div>
        <div class="am-noflow"><span class="am-noflow-ic">${IC.app}</span><b>Monte uma automação</b><p>Ligue gatilhos, programas, HTTP, avisos e IA num fluxo que roda quando você mandar ou na hora marcada.</p><div><button class="chip primary" data-a="new" type="button">${IC.plus}<span>Novo fluxo</span></button><button class="chip" data-a="tpl" type="button">Começar de um modelo</button></div></div>
      </div>
    </div>
    <aside class="am-insp" aria-label="Detalhes"></aside>
    </div><input type="file" class="am-file" accept=".json,application/json" hidden>`;
  const $ = (s) => pane.querySelector(s);
  R = { side: $('.am-side'), list: $('.am-list'), search: $('.am-search'), bar: $('.am-bar'), name: $('.am-name'), dirty: $('.am-dirty'), sched: $('.am-sched'), active: $('.am-active'), next: $('.am-next'),
    lockbtn: $('[data-a=lock]'), undo: $('[data-a=undo]'), redo: $('[data-a=redo]'), save: $('.am-save'), run: $('.am-runbtn'), stage: $('.am-stage'), cv: $('.am-cv'), world: $('.am-world'), svg: $('.am-wires'), nodes: $('.am-nodes'),
    marquee: $('.am-marquee'), empty: $('.am-empty'), zoom: $('.am-zval'), insp: $('.am-insp'), file: $('.am-file') };
  R.ghost = document.createElementNS(SVGNS, 'path'); R.ghost.classList.add('am-wire', 'ghost'); R.svg.append(R.ghost);

  const acts = {
    new: () => create(() => blank()),
    tpl: (e) => bs.showMenu(e, TEMPLATES.filter(t => !t.need || spec(t.need)).map(t => ({ label: t.label, k: t.hint, action: () => create(t.make) }))),
    ai: generate, save: guard(save), run, lock: () => toggleLock(),
    undo: () => travel(A.undo, A.redo), redo: () => travel(A.redo, A.undo),
    tidy: () => { arrange(); fit(); }, fit, zin: () => zoomBy(1.25), zout: () => zoomBy(0.8), z100: () => zoomBy(1 / A.cam.z),
    add: (e) => { const r = e.currentTarget.getBoundingClientRect(); openPicker(r.left, r.bottom + 6, (s) => addNode(s.type)); },
    more: (e) => bs.showMenu(e, [
      { label: 'Importar fluxo…', action: () => R.file.click() },
      { label: 'Agentes de IA…', icon: IC.spark, action: () => bs.aiClis.open() },
      ...(A.flow ? [{ label: 'Exportar fluxo', action: exportFlow }, { label: 'Duplicar fluxo', icon: IC.copy, action: () => { const f = clone(A.flow); create(() => ({ ...f, id: '', active: false, next_run: null, name: f.name + ' (cópia)' })); } }, '-', { label: 'Excluir fluxo…', icon: IC.trash, action: guard(() => flowLocked() ? denied() : removeFlow()) }] : [])]),
  };
  // a lista de fluxos mora no painel da esquerda da IDE (no lugar do painel de arquivos), fora da aba
  R.side.remove();
  const onClick = (e) => {
    const b = e.target.closest('[data-a]');
    if (b && acts[b.dataset.a]) { const r = b.getBoundingClientRect(); acts[b.dataset.a]({ currentTarget: b, target: b, clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }); return; }
    const plus = e.target.closest('.am-plus');
    if (plus) { const id = plus.closest('.am-node').dataset.id, r = plus.getBoundingClientRect(), n = node(id); openPicker(r.right + 8, r.top - 12, (s) => addNode(s.type, [n.position[0] + NODE_W + 60, n.position[1]], { node: id, port: plus.dataset.plus, dir: 'out' }), 'inputs'); }
  };
  pane.addEventListener('click', onClick); R.side.addEventListener('click', onClick);
  pane.addEventListener('pointerdown', (e) => { if (picker && !picker.contains(e.target) && !e.target.closest('[data-a=add], .am-plus')) closePicker(); });
  R.name.oninput = () => { if (!A.flow || flowLocked()) return; A.flow.name = R.name.value; paintBar(); const cur = R.list.querySelector('.am-flow.current .am-fname span'); if (cur) cur.textContent = A.flow.name || 'Fluxo sem nome'; };
  R.name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); R.cv.focus(); } };
  R.search.oninput = paintList;
  R.active.onchange = guard(async () => { if (!A.flow) return; A.flow.active = R.active.checked; paintBar(); if (await save()) bs.toast(A.flow.active ? `Fluxo ligado${A.flow.next_run ? ': próxima execução ' + fmtWhen(A.flow.next_run) : ''}.` : 'Fluxo desligado.', 'ok'); });
  R.file.onchange = guard(async () => { const f = R.file.files[0]; R.file.value = ''; if (f) await importFlow(f); });
  R.cv.addEventListener('pointerdown', onDown); R.cv.addEventListener('pointermove', onMove); R.cv.addEventListener('pointerup', onUp); R.cv.addEventListener('pointercancel', onUp);
  R.cv.addEventListener('wheel', onWheel, { passive: false });
  R.cv.addEventListener('contextmenu', onContext);
  R.cv.addEventListener('dblclick', (e) => {
    if (!A.flow || e.target.closest('.am-node, .am-zoom, .am-add, .am-pick')) { if (e.target.closest('.am-node')) R.insp.querySelector('.am-field textarea, .am-field input')?.focus(); return; }
    if (e.target.closest('.am-edge')) return removeEdge(e.target.closest('.am-edge').dataset.id);
    const at = toWorld(e.clientX, e.clientY); openPicker(e.clientX, e.clientY, (s) => addNode(s.type, [at[0] - NODE_W / 2, at[1] - HEAD / 2]));
  });
  // teclas do Automator não vazam para os atalhos da IDE
  pane.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, typing = e.target.closest('input, textarea, select');
    const eat = (fn) => { e.preventDefault(); e.stopPropagation(); fn && fn(); };
    if (ctrl && k === 's') return eat(guard(save));
    if (typing) { if (e.key === 'Escape' && !picker) eat(() => R.cv.focus()); return; }
    if (e.key === 'Escape') return eat(() => { if (picker) closePicker(); else if (A.sel.size || A.selEdge) { A.sel.clear(); A.selEdge = null; paintSel(); } });
    if (!A.flow) return;
    if (e.key === 'Delete' || e.key === 'Backspace') return eat(deleteSelection);
    if (ctrl && k === 'z') return eat(() => e.shiftKey ? travel(A.redo, A.undo) : travel(A.undo, A.redo));
    if (ctrl && k === 'y') return eat(() => travel(A.redo, A.undo));
    if (ctrl && k === 'a') return eat(() => select(A.flow.nodes.map(n => n.id)));
    if (ctrl && k === 'c') return eat(copySel);
    if (ctrl && k === 'v') return eat(() => paste());
    if (ctrl && k === 'd') return eat(() => { copySel(); paste(); });
    if (!ctrl && k === 'f') return eat(fit);
  });
  new ResizeObserver(() => { if (A.cam && R.cv.offsetWidth) applyCam(); }).observe(R.cv);
  paintBar();
}
const load = guard(async () => {
  const first = !A.loaded;
  if (first) { A.specs = await bs.api('automator/catalog'); A.byType = new Map(A.specs.map(s => [s.type, s])); A.loaded = true; }
  await refreshFlows();
  if (first) open(A.flows[0] || null); else pollRuns();
});

// (registrado antes da tela: ao reabrir a aba num recarregamento, o núcleo já acha o painel dela)
// o painel da esquerda é a lista de fluxos: entra no lugar do painel de arquivos enquanto a aba do Automator está na frente
bs.tools.register({ id: 'automator', title: 'Automator', icon: IC.app, order: 60, page: 'automator', render() { if (!R.side) return; bs.$('#toolBody').replaceChildren(R.side); load(); } });
// O Automator é uma tela inteira: abre numa aba do editor, pelo ícone da barra da esquerda.
// O ponto de "não salvo" da aba, o Ctrl+S, o "Salvar tudo" e a pergunta ao fechar ou sair são os da IDE.
bs.pages.register({
  id: 'automator', title: 'Automator', icon: IC.app, render: mount,
  show: () => { load(); bs.pages.dirty('automator', isDirty()); requestAnimationFrame(() => { if (A.flow && !root.contains(document.activeElement)) R.cv.focus({ preventScroll: true }); }); },
  save: guard(save),
  discard: () => { if (A.flow) open(A.flows.find(f => f.id === A.flow.id) || A.flows[0] || null); },
  unsaved: () => A.flow ? `Fluxo "${A.flow.name || 'sem nome'}"` : '',
});
// a lista de agentes mudou (janela Agentes de IA): os nós que escolhem um agente passam a oferecer os novos
bs.hooks.on('aiclis:change', guard(async () => { if (!A.loaded) return; A.specs = await bs.api('automator/catalog'); A.byType = new Map(A.specs.map(s => [s.type, s])); for (const [id, e] of nodeEls) { const n = node(id), sm = e.querySelector('.am-sum'); if (n && sm) sm.textContent = summary(n); } renderInspector(); }));
bs.actions.add([{ label: 'Automator: fluxos de automação', icon: IC.app, run: () => bs.pages.open('automator') }]);
// execução em andamento atualiza a cada segundo; parado, de vez em quando (a agenda pode ter disparado)
let tick = 0;
timers.push(setInterval(() => { if (!root?.isConnected || !bs.pages.isActive('automator') || !A.loaded) return; tick++; if (isRunning() || tick % 4 === 0) pollRuns(); if (tick % 30 === 0) refreshFlows().catch(() => {}); }, 1000));
plugin.onUnload(() => { timers.forEach(clearInterval); closePicker(); document.getElementById('amAsk')?.remove(); document.getElementById('amGen')?.remove(); });
