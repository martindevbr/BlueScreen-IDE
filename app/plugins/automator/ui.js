/* Automator: fluxos de automação em nós, no modelo do editor de Fluxos do HexLab.
   Quadro com câmera (arrastar o fundo, roda do mouse), nós em DOM com geometria fixa, fios em SVG puxados de uma
   bolinha até a outra, seleção (clique, Shift, laço), desfazer/refazer e execução acompanhada nó a nó.
   O documento usa os mesmos campos do HexLab: nodes/edges/position/from_port/to_port. */
const NODE_MIN = 168, NODE_MAX = 720, NODE_W = 232, HEAD = 37, PAD = 6, ROW = 24, ZMIN = 0.2, ZMAX = 2.5, GRID = 12;
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
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  folderPlus: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>'),
  chev: svg('<path d="M9 6l6 6-6 6"/>'),
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
  'Data e hora': { c: '#38BDF8', i: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
  'QA': { c: '#3FC98A', i: svg('<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M8 15h8"/>') },
  'JSON': { c: '#F2C55C', i: svg('<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/>') },
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
  'Conexões': { c: '#7FD1AE', i: svg('<path d="M8 12h8M5 8.5h2.5a3.5 3.5 0 0 1 0 7H5M19 8.5h-2.5a3.5 3.5 0 0 0 0 7H19"/><path d="M5 8.5v7M19 8.5v7"/>') },
  'Navegador': { c: '#4FB6E8', i: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.1M10 6.5h.1"/>') },
};
// formato do dado que entra e sai de cada nó: a etiqueta ao lado das bolinhas e na lista de nós
const TYPES = {
  text: { l: 'Texto', c: '#9AA7F5', d: 'Um texto simples' },
  object: { l: 'JSON', c: '#F2C55C', d: 'Dados com campos (um objeto JSON), como { "nome": "Ana" }' },
  list: { l: 'Lista', c: '#59B8C4', d: 'Vários itens em sequência' },
  number: { l: 'Número', c: '#F0A35E', d: 'Um número' },
  image: { l: 'Imagem', c: '#5CC8A1', d: 'Um arquivo de imagem (PNG, JPG…)' },
  audio: { l: 'Áudio', c: '#E8A84F', d: 'Um arquivo de som (MP3, WAV…)' },
  video: { l: 'Vídeo', c: '#E36F8E', d: 'Um arquivo de vídeo (MP4…)' },
  file: { l: 'Arquivo', c: '#D9A441', d: 'O caminho de um arquivo no PC' },
  any: { l: 'Qualquer', c: '', d: 'Aceita qualquer tipo de dado' },
  same: { l: 'O mesmo', c: '', d: 'Passa adiante exatamente o que recebeu' },
};
const typeOf = (s, side) => TYPES[s?.[side]] ? s[side] : null;
/** Etiqueta do formato: "Texto", "JSON", "Imagem"… com a cor do tipo. */
function typeChip(t, side) {
  const T = TYPES[t]; if (!T) return null;
  return el('span.am-type' + (T.c ? '' : '.soft'), { style: T.c ? { '--tc': T.c } : {}, title: (side === 'takes' ? 'Recebe: ' : side === 'gives' ? 'Devolve: ' : '') + T.d }, T.l);
}
/** "Texto → JSON": o que o nó recebe e o que devolve, numa linha. */
function typeFlow(s) {
  const a = typeOf(s, 'takes'), b = typeOf(s, 'gives'); if (!a && !b) return null;
  return el('span.am-tflow', a ? typeChip(a, 'takes') : el('span.am-type.soft', { title: 'Não recebe nada: é onde o fluxo começa' }, 'Começa'), el('i', '→'), b ? typeChip(b, 'gives') : el('span.am-type.soft', { title: 'Não devolve nada: o fluxo termina aqui' }, 'Fim'));
}
// categoria que um plugin inventou: cor e ícone neutros
const PLUG_CAT = { c: 'var(--muted)', i: svg('<path d="M9 3h6v4h3a2 2 0 0 1 2 2v3h-2.5a2 2 0 1 0 0 4H20v3a2 2 0 0 1-2 2h-4v-2.5a2 2 0 1 0-4 0V21H6a2 2 0 0 1-2-2v-4h2.5a2 2 0 1 0 0-4H4V9a2 2 0 0 1 2-2h3z"/>') };
// gatilhos que disparam sozinhos: valem com o interruptor "Ligado" do fluxo
const AUTO = ['trigger.schedule', 'trigger.startup', 'trigger.file', 'trigger.webhook'];
// endereço que chama um Endpoint HTTP
const hookUrl = (name) => `${location.origin}/api/automator/hook?e=${encodeURIComponent(String(name || '').trim())}`;
// Os endereços de um Endpoint HTTP: o deste PC e, se o nó aceita a rede local, os da rede (IP do PC na rede e a
// porta do acesso pela rede, que é outra). A.lan vem do núcleo; enquanto não chega, só o deste PC aparece.
function hookBlock(n) {
  const q = `/api/automator/hook?e=${encodeURIComponent(String(n.params.name || '').trim())}`;
  const row = (label, url) => el('div.am-hookrow', el('span.am-hooklab', label), el('div.am-hook', el('code', url), el('button.icon-btn', { type: 'button', title: 'Copiar o endereço', html: IC.copy, onclick: () => { bs.copyText(url); bs.toast('Endereço copiado', 'ok'); } })));
  const box = el('div.am-hooks', row('Neste PC', location.origin + q));
  if (n.params.who !== 'lan') { box.append(el('p.am-hint', 'Para chamar de outro aparelho da sua rede, escolha "A rede local também" em Quem pode chamar.')); return box; }
  const draw = () => {
    const lan = A.lan;
    box.querySelectorAll('.am-lan').forEach(x => x.remove());
    if (!lan) return;
    if (lan.enabled && lan.urls.length) lan.urls.forEach(u => { const r = row('Na rede', u + q); r.classList.add('am-lan'); box.append(r); });
    else box.append(el('div.am-lan', el('p.am-hint', lan.enabled ? 'Não achei o endereço deste PC na rede: confira se ele está conectado.' : 'O acesso pela rede local está desligado: sem ele, outros aparelhos não chegam neste endpoint.'),
      !lan.enabled && el('button.chip.am-wide', { type: 'button', onclick: guard(async () => { A.lan = await post('automator/lan', { enable: true }); draw(); }) }, 'Ligar o acesso pela rede')));
    if (lan.enabled) box.append(el('p.am-hint.am-lan', 'De outro aparelho, use o endereço "Na rede" (o do 127.0.0.1 só funciona neste PC). O fluxo precisa estar ligado. Se não responder, libere o BlueScreen no Firewall do Windows.'));
  };
  draw();
  bs.api('automator/lan', {}, { quiet: true }).then(v => { A.lan = v; if (box.isConnected) draw(); }).catch(() => {});
  return box;
}
const PORT_LABEL = { in: 'entrada', out: 'saída', true: 'sim', false: 'não', item: 'cada item', loop: 'repetir', done: 'fim', try: 'tentar', ok: 'deu certo', error: 'deu erro', other: 'outro' };
// o nome de uma saída no quadro: em Escolher caminho, a saída leva o texto do caso dela
const switchCases = (n) => (Array.isArray(n?.params?.cases) ? n.params.cases : String(n?.params?.cases || '').split('\n')).map(c => String(c ?? '').trim());
const portName = (n, p) => n?.type === 'logic.switch' && /^[1-5]$/.test(p) ? (switchCases(n)[p - 1] || 'caso ' + p).slice(0, 18) : PORT_LABEL[p] || p;
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
  sel: new Set(), selEdge: null, cam: { x: 40, y: 40, z: 1 }, undo: [], redo: [], clip: null, drag: null, loaded: false, pane: null, creds: [], folders: [], folderColors: {}, keepRuns: 100,
  // salvar sozinho: cada alteração é gravada logo depois que a pessoa para de mexer
  autoSave: (() => { try { return localStorage.getItem('bs.automator.autoSave') === '1'; } catch { return false; } })(),
  // a lista de execuções só é buscada e desenhada quando a pessoa pede (fica mais leve)
  showRuns: (() => { try { return localStorage.getItem('bs.automator.showRuns') === '1'; } catch { return false; } })(),
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
    if (Array.isArray(n.size) && n.size.length === 2 && n.size.every(Number.isFinite) && n.size[0] >= NODE_MIN) n.size = [Math.min(NODE_MAX, n.size[0]), Math.max(0, n.size[1])]; else delete n.size;
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
async function refreshFlows() { [A.flows, A.folders] = await Promise.all([bs.api('automator/flows'), bs.api('automator/folders').catch(() => A.folders)]); paintList(); const me = A.flows.find(f => f.id === A.flow?.id); if (me && A.flow) { A.flow.next_run = me.next_run; paintBar(); } }
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
/** Exporta um JSON: abre o "Salvar como" do Windows para a pessoa escolher onde gravar. Devolve o caminho, ou
    null se ela desistiu. */
async function saveJson(name, data) {
  const r = await post('automator/export', { name, content: JSON.stringify(data, null, 2) });
  return r.path || null;
}
const exportFlow = guard(async (flow = A.flow) => {
  if (!flow || !flow.nodes) return;
  const { next_run, updated_at, ...f } = flow;
  const path = await saveJson(flow.name || 'fluxo', f);
  if (path) bs.toast('Fluxo exportado para ' + path, 'ok');
});
/** Vários fluxos num arquivo só, com as pastas, as cores e a ordem. `folder`: só os dessa pasta. As credenciais
    não vão: o arquivo leva só os nomes delas ({{cred:nome}}). */
const exportFlows = guard(async (folder) => {
  const list = A.flows.filter(f => folder == null || within(folder, f.folder || ''));
  if (!list.length) return bs.toast(folder == null ? 'Ainda não há fluxos salvos para exportar.' : 'Esta pasta não tem fluxos.');
  const folders = A.folders.filter(g => list.some(f => within(g, f.folder || '')));
  const path = await saveJson(folder == null ? 'fluxos do Automator' : leafOf(folder), {
    bluescreen: 'automator-flows', version: 1, exported_at: new Date().toISOString(), folders,
    folder_colors: Object.fromEntries(folders.filter(g => A.folderColors[g]).map(g => [g, A.folderColors[g]])),
    flows: list.map(({ next_run, updated_at, ...f }) => f),
  });
  if (path) bs.toast(`${list.length} ${list.length === 1 ? 'fluxo exportado' : 'fluxos exportados'} para ${path}. As senhas não vão no arquivo: só os nomes das credenciais.`, 'ok');
});
/** Importa o arquivo de vários fluxos: cada um entra desligado, na pasta em que estava; quem chamava outro fluxo do
    mesmo arquivo passa a chamar a cópia importada. */
async function importFlows(pack) {
  const flows = pack.flows.filter(f => f && Array.isArray(f.nodes) && Array.isArray(f.edges));
  if (!flows.length) throw new Error('o arquivo não tem nenhum fluxo');
  const unknown = [...new Set(flows.flatMap(f => f.nodes).filter(n => !spec(n.type)).map(n => n.type))];
  if (unknown.length) throw new Error('o arquivo usa nós que o Automator não tem: ' + unknown.join(', '));
  if (!(await ask(`Importar ${flows.length} ${flows.length === 1 ? 'fluxo' : 'fluxos'}?`, 'Eles entram desligados, nas pastas em que estavam. Os fluxos que você já tem não mudam.', [{ label: 'Cancelar', value: false }, { label: 'Importar', value: true, cls: 'primary' }]))) return;
  const ids = new Map(), saved = [];
  for (const f of flows) {
    const got = await post('automator/flows', { flow: { ...f, id: '', active: false, locked: false, next_run: null, name: f.name || 'Fluxo importado' } });
    if (f.id) ids.set(f.id, got.id);
    saved.push(got);
  }
  // nó Chamar fluxo: o id antigo vira o do fluxo que acabou de entrar
  for (const g of saved) {
    let touched = false;
    for (const n of g.nodes) if (n.type === 'flow.call' && ids.has(n.params?.flow)) { n.params.flow = ids.get(n.params.flow); touched = true; }
    if (touched) await post('automator/flows', { flow: g });
  }
  for (const [name, color] of Object.entries(pack.folder_colors || {})) {
    if (A.folderColors[name]) continue;
    try { await post('automator/folders', { action: 'color', name, color }); A.folderColors[name] = color; } catch { /* cor estranha: a pasta fica com a padrão */ }
  }
  await refreshFlows();
  bs.toast(`${saved.length} ${saved.length === 1 ? 'fluxo importado' : 'fluxos importados'}, desligados. Confira as credenciais que eles usam.`, 'ok');
}
async function importFlow(file) {
  const f = JSON.parse(await file.text());
  if (f && Array.isArray(f.flows)) return importFlows(f);
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
  { label: 'Alarme num horário', hint: 'alerta com som no canto da tela', make: () => chain('Alarme', 'Todo dia, no horário marcado, abre um alerta com som no canto da tela. Ajuste o horário e a mensagem e ligue o fluxo.', [T('trigger.schedule', { mode: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), T('windows.alarm', { title: 'Reunião diária', message: 'Começa em 5 minutos.', level: 'warn', sound: 'Alarm01.wav', repeat: 'loop', button2: 'Adiar' })]) },
  { label: 'Avisar quando chegar arquivo', hint: 'vigia uma pasta', make: () => chain('Arquivo novo na pasta', 'Avisa quando um arquivo é criado ou alterado na pasta. Informe a pasta no primeiro nó e ligue o fluxo.', [T('trigger.file', { path: '' }), T('windows.notify', { title: 'Arquivo novo', message: '{{input.name}}' })]) },
  { label: 'Diário num arquivo', hint: 'data e hora, depois grava', make: () => chain('Diário num arquivo', 'Acrescenta uma linha com a data e a hora num arquivo de texto. Informe o arquivo no último nó.', [T('trigger.manual', { sample: 'anotação' }), T('data.datetime', { format: '%d/%m/%Y %H:%M' }), T('file.write', { path: '', content: '{{input}}', mode: 'append' })]) },
  { label: 'Automatizar um site', hint: 'abrir, clicar, digitar, ler', make: () => chain('Automatizar um site', 'Abre o site, faz os passos e mostra o que leu. Troque o endereço e clique em Gravar, no nó Navegador, para fazer os passos no próprio site; senhas vão como {{cred:senha}}.', [T('trigger.manual', {}), T('browser.run', { url: 'https://example.com', steps: [{ do: 'wait', on: 'h1', value: '' }, { do: 'read', on: 'h1', value: 'titulo' }], show: 'yes' }), T('util.output', {})]) },
  { label: 'Repetir para cada arquivo', hint: 'um laço sobre uma lista', make: () => {
    const t = T('trigger.manual', {}), l = T('file.list', { path: '', pattern: '*' }, 'Arquivos da pasta'), e = T('logic.each', { list: '{{input}}' }), n = T('windows.notify', { title: 'Arquivo', message: '{{input}}' }, 'Fazer algo com o arquivo'), o = T('util.output', {}, 'Depois de todos');
    const f = chain('Para cada arquivo', 'Lista os arquivos de uma pasta e repete um trecho para cada um. Informe a pasta em "Arquivos da pasta" e troque a notificação pelo que quiser fazer com cada arquivo: o que sai de "cada item" roda uma vez por arquivo; o que sai de "fim", uma vez só.', [t, l, e]);
    f.nodes.push(n, o); f.edges.push({ id: uid('e'), from: e.id, from_port: 'item', to: n.id, to_port: 'in' }, { id: uid('e'), from: e.id, from_port: 'done', to: o.id, to_port: 'in' });
    return f;
  } },
  { label: 'Endpoint com token', hint: 'recebe uma chamada e responde', make: () => {
    const t = T('trigger.webhook', { name: 'meu-endpoint', method: 'POST' }), s = T('sec.token', { got: '{{input.token}}', expected: '' }), l = T('sec.rate', { max: 30, per_s: 60, key: '{{input.token}}' }), q = T('sec.require', { value: '{{input.body}}', fields: ['nome'] });
    return chain('Endpoint com token', 'Recebe um POST com JSON, confere o token e os campos e responde. Preencha o token esperado no nó "Exigir token" (de preferência {{cred:nome}}) e ligue o fluxo.', [t, s, l, q, T('http.respond', { status: 200, type: 'json', body: '{"ok": true, "ola": "{{nodes.' + t.id + '.out.body.nome}}"}' })]);
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
// largura do nó: a que o usuário deu ao redimensionar, ou a padrão
const widthOf = (n) => n?.size?.[0] || NODE_W;
const rectOf = (n) => ({ x: n.position[0], y: n.position[1], w: widthOf(n), h: nodeEls.get(n.id)?.offsetHeight || 96 });
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
function ports(n) {
  const s = spec(n.type), outs = s?.outputs || [];
  if (n.type !== 'logic.switch') return { ins: s?.inputs || [], outs };
  // Escolher caminho: só as saídas dos casos preenchidos (e as que já têm fio), mais "outro"
  const cases = switchCases(n), used = new Set((A.flow?.edges || []).filter(e => e.from === n.id).map(e => e.from_port));
  return { ins: s?.inputs || [], outs: outs.filter(o => o === 'other' || used.has(o) || cases[o - 1] || o === '1') };
}
function portPos(id, dir, name) {
  const n = node(id); if (!n) return [0, 0];
  const p = ports(n), i = Math.max(0, (dir === 'in' ? p.ins : p.outs).indexOf(name));
  return [n.position[0] + (dir === 'in' ? 0 : widthOf(n)), n.position[1] + HEAD + PAD + i * ROW + ROW / 2];
}
const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
// nome do agente de IA (Codex, Claude Code ou um que o usuário cadastrou em Agentes de IA)
const cliName = (id) => spec('agent.cli')?.fields.find(f => f.name === 'provider')?.options.find(o => o.value === id)?.label || id || '';
function summary(n) {
  const p = n.params || {}, one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  switch (n.type) {
    case 'trigger.manual': return one(p.sample);
    case 'trigger.schedule': {
      const d = (p.days || []).slice().sort((a, b) => (a || 7) - (b || 7));
      const days = !d.length || d.length === 7 ? 'todo dia' : d.join() === '1,2,3,4,5' ? 'dias úteis' : d.map(i => DAYS[i]).join(', ');
      if (p.mode !== 'daily') {
        const m = +p.every_minutes || 0, every = m % 1440 === 0 && m ? `a cada ${m / 1440} dia${m > 1440 ? 's' : ''}` : m % 60 === 0 && m ? `a cada ${m / 60} h` : `a cada ${m} min`;
        return [every, p.window === 'between' ? `${p.from || '--:--'} às ${p.to || '--:--'}` : '', d.length && d.length < 7 ? days : ''].filter(Boolean).join(' · ');
      }
      return `${p.time || '--:--'} · ${days}`;
    }
    case 'time.window': {
      const d = (p.days || []).slice().sort((a, b) => (a || 7) - (b || 7));
      const days = !d.length || d.length === 7 ? 'todo dia' : d.join() === '1,2,3,4,5' ? 'dias úteis' : d.map(i => DAYS[i]).join(', ');
      const off = (p.except || []).filter(Boolean).length;
      return [days, p.window === 'all' ? 'o dia inteiro' : `${p.from || '--:--'} às ${p.to || '--:--'}`, off ? `${off} ${off === 1 ? 'folga' : 'folgas'}` : ''].filter(Boolean).join(' · ');
    }
    case 'time.compare': { const o = spec(n.type).fields.find(f => f.name === 'op').options.find(x => x.value === (p.op || 'before')); const far = ['older', 'newer'].includes(p.op); return `${one(p.value)} ${far ? (p.op === 'older' ? 'há mais de' : 'há menos de') + ` ${p.amount} ${spec(n.type).fields.find(f => f.name === 'unit').options.find(x => x.value === p.unit)?.label || ''}` : (o?.label || '') + ' ' + (one(p.other) || 'agora')}`; }
    case 'time.shift': { const u = spec(n.type).fields.find(f => f.name === 'unit').options.find(x => x.value === p.unit)?.label || ''; return `${one(p.value) || 'agora'}${+p.amount ? ` ${p.amount > 0 ? '+' : '−'} ${Math.abs(p.amount)} ${u}` : ''}`; }
    case 'time.until': return 'até as ' + (p.time || '--:--');
    case 'flow.call': return A.flows.find(x => x.id === p.flow || x.name === p.flow)?.name || (p.flow ? 'fluxo que não existe mais' : 'escolha o fluxo');
    case 'logic.if': { const o = spec(n.type).fields.find(f => f.name === 'op').options.find(x => x.value === (p.op || 'eq')); return `${one(p.value)} ${o?.label || ''}${['empty', 'not_empty', 'true'].includes(p.op) ? '' : ' ' + one(p.equals)}`; }
    case 'util.delay': return `${p.seconds} s`;
    case 'logic.each': return 'cada item de ' + (one(p.list) || 'uma lista');
    case 'logic.repeat': return `${one(p.times) || 0} ${String(p.times) === '1' ? 'vez' : 'vezes'}`;
    case 'logic.while': { const o = spec(n.type).fields.find(f => f.name === 'op').options.find(x => x.value === (p.op || 'not_empty')); return `enquanto ${one(p.value)} ${o?.label || ''}${['empty', 'not_empty', 'true'].includes(p.op) ? '' : ' ' + one(p.equals)}`; }
    case 'logic.try': return +p.attempts > 1 ? `até ${p.attempts} tentativas` : 'se falhar, segue por "deu erro"';
    case 'logic.switch': { const k = switchCases(n).filter(Boolean).length; return `${one(p.value)} · ${k} ${k === 1 ? 'caso' : 'casos'}`; }
    case 'logic.all': { const k = (p.rules || []).length; return k ? `${k} ${k === 1 ? 'condição' : 'condições'} · ${p.mode === 'any' ? 'pelo menos uma' : 'todas'}` : 'sem condições ainda'; }
    case 'logic.var': return `${{ set: 'guardar em', add: 'somar em', append: 'acrescentar a', get: 'ler', clear: 'esvaziar' }[p.op] || ''} ${one(p.name)}`;
    case 'logic.break': case 'logic.next': return '';
    case 'browser.run': { const k = (p.steps || []).length; return [one(p.url) || 'na página aberta', k ? k + (k === 1 ? ' passo' : ' passos') : 'sem passos ainda'].join(' · '); }
    case 'ssh.run': return [one(p.host), one(p.command)].filter(Boolean).join(' · ');
    case 'ssh.copy': return `${p.direction === 'download' ? 'baixar' : 'enviar'} ${one(p.direction === 'download' ? p.remote : p.local)}`;
    case 'mail.send': { const to = Array.isArray(p.to) ? p.to : [p.to]; return [to.filter(Boolean).length ? 'para ' + one(to.filter(Boolean).join(', ')) : 'sem destinatário', one(p.subject)].filter(Boolean).join(' · '); }
    case 'mail.read': return [one(p.user) || one(p.host), p.which === 'all' ? 'todas' : 'não lidas', one(p.subject) && 'assunto: ' + one(p.subject)].filter(Boolean).join(' · ');
    case 'ftp.files': return `${{ list: 'listar', download: 'baixar', upload: 'enviar', delete: 'apagar' }[p.op] || ''} ${one(p.remote)}`;
    case 'db.query': return one(p.sql);
    case 'mqtt.publish': return [one(p.topic), one(p.message)].filter(Boolean).join(' · ');
    case 'notify.telegram': return one(p.text);
    case 'net.ping': return one(p.host);
    case 'net.wol': return one(p.mac);
    case 'windows.command': return one([p.program, ...(Array.isArray(p.args) ? p.args : [])].join(' '));
    case 'windows.notify': return one(p.message) || one(p.title);
    case 'http.request': return `${p.method || 'GET'} ${one(p.url)}`;
    case 'mcp.call': return one(p.tool) || one(p.url);
    case 'agent.cli': return `${cliName(p.provider)}${p.model ? ' (' + one(p.model) + ')' : ''} · ${one(p.prompt)}`;
    case 'ai.openrouter': return one(p.model) || 'escolha o modelo';
    case 'util.text': return one(p.text);
    case 'trigger.file': case 'file.read': case 'file.write': case 'file.list': case 'file.exists': return one(p.path);
    case 'file.manage': return `${{ copy: 'copiar', move: 'mover', trash: 'Lixeira' }[p.op] || ''} ${one(p.from)}`;
    case 'windows.open': return one(p.target);
    case 'windows.alarm': return [one(p.title), p.sound && p.sound !== 'custom' ? String(p.sound).replace(/\.wav$/i, '') : ''].filter(Boolean).join(' · ');
    case 'windows.powershell': return one(p.script);
    case 'windows.clipboard': return p.op === 'write' ? 'copiar: ' + one(p.text) : 'ler o que está copiado';
    case 'http.download': return one(p.url);
    case 'text.replace': return `${one(p.find)} → ${one(p.replace)}`;
    case 'text.extract': return one(p.pattern);
    case 'text.split': return { line: 'por linha', comma: 'por vírgula', semicolon: 'por ponto e vírgula' }[p.by] || 'por ' + one(p.separator);
    case 'data.datetime': return one(p.format);
    case 'data.set': return Object.keys(p.value || {}).join(', ');
    case 'logic.stop': return one(p.message);
    case 'plugin.navegador.test': case 'plugin.navegador.site': { const k = (p.steps || []).length; return [one(p.name) || one(p.url), k ? k + (k === 1 ? ' passo' : ' passos') : 'sem passos ainda'].filter(Boolean).join(' · '); }
    case 'qa.api': return [one(p.name), `${p.method || 'GET'} ${one(p.url)}`].filter(Boolean).join(' · ');
    case 'qa.data': return (p.fields || []).join(', ') + (p.count > 1 ? ` × ${p.count}` : '');
    case 'qa.load': return `${p.total} chamadas, ${p.concurrency} por vez · ${one(p.url)}`;
    case 'qa.report': return { html: 'página HTML', junit: 'JUnit XML', markdown: 'Markdown' }[p.format] || '';
    case 'json.get': case 'json.set': return one(p.path);
    case 'json.pick': case 'json.omit': return (p.fields || []).join(', ');
    case 'json.pluck': case 'json.group': return one(p.field);
    case 'json.sort': return [one(p.field), p.order === 'desc' ? 'decrescente' : 'crescente', +p.limit ? 'os ' + p.limit + ' primeiros' : ''].filter(Boolean).join(' · ');
    case 'json.parse': case 'json.text': case 'json.entries': case 'json.count': case 'json.merge': return '';
    // nó de plugin: o primeiro texto preenchido e, se houver, quantos passos
    default: { const rows = Object.values(p).find(v => Array.isArray(v) && v.length && typeof v[0] === 'object'); return [one(Object.values(p).find(v => typeof v === 'string' && v.trim() && !/^(yes|no|close|keep)$/.test(v))), rows ? rows.length + (rows.length === 1 ? ' passo' : ' passos') : ''].filter(Boolean).join(' · '); }
  }
}
function fillNode(e, n) {
  const s = spec(n.type), cat = catOf(n), { ins, outs } = ports(n), rows = Math.max(ins.length, outs.length, 1);
  e.className = 'am-node' + (A.sel.has(n.id) ? ' selected' : '') + (n.disabled ? ' disabled' : '') + (n.locked ? ' locked' : '') + (n.size ? ' sized' : '') + (s ? '' : ' unknown');
  applySize(e, n);
  e.style.setProperty('--cat', cat.c);
  e.setAttribute('aria-label', titleOf(n));
  const used = new Set(A.flow.edges.filter(x => x.from === n.id).map(x => x.from_port));
  const body = el('div.am-ports', { style: { height: rows * ROW + PAD * 2 + 'px' } });
  for (let i = 0; i < rows; i++) {
    const a = ins[i], b = outs[i], top = PAD + i * ROW + ROW / 2 + 'px';
    // rótulo só quando o lado tem mais de uma bolinha: "entrada" e "saída" sozinhas não dizem nada
    // ao lado de cada bolinha, o formato do dado: o que entra (esquerda) e o que sai (direita)
    const ta = a && typeOf(s, 'takes'), tb = b && typeOf(s, 'gives'), tint = (t) => TYPES[t]?.c ? { top, '--cat': TYPES[t].c } : { top };
    body.append(...[el('div.am-row', el('span.am-pl', ins.length > 1 && a ? PORT_LABEL[a] || a : '', ta && typeChip(ta, 'takes')), el('span.am-pl.out', outs.length > 1 && b ? portName(n, b) : '', tb && typeChip(tb, 'gives'))),
      a && el('span.am-port.in', { dataset: { port: a, dir: 'in' }, style: tint(ta), title: 'Entrada: arraste até uma saída' }),
      b && el('span.am-port.out', { dataset: { port: b, dir: 'out' }, style: tint(tb), title: `Saída${outs.length > 1 ? ' "' + (portName(n, b)) + '"' : ''}: arraste até a entrada de outro nó` }),
      b && !used.has(b) && el('button.am-plus', { type: 'button', dataset: { plus: b }, style: { top }, title: 'Continuar o fluxo a partir daqui', html: IC.plus })].filter(Boolean));
  }
  e.replaceChildren(
    el('div.am-head', el('span.am-ico', { html: cat.i }), el('span.am-title', { title: titleOf(n) }, titleOf(n)), n.locked && el('span.am-nlock', { html: IC.lock, title: 'Nó trancado' }), n.disabled && el('span.am-off', 'desligado'), el('span.am-state')),
    body, el('div.am-sum', s ? summary(n) : 'Este tipo de nó não existe mais.'), el('div.am-run'), el('span.am-grip', { title: 'Arraste para redimensionar. Duplo clique volta ao tamanho padrão' }));
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
// altura mínima de um nó: o cabeçalho e as bolinhas nunca ficam cortados
const baseHeight = (n) => { const p = ports(n); return HEAD + Math.max(p.ins.length, p.outs.length, 1) * ROW + PAD * 2 + 10; };
function applySize(e, n) {
  e.style.width = widthOf(n) + 'px';
  e.style.height = n.size && n.size[1] > 0 ? Math.max(baseHeight(n), n.size[1]) + 'px' : '';
}
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
// ---------- salvar sozinho ----------
let autoTimer = 0, autoBusy = false, autoFailed = '';
/** Marca uma gravação para daqui a pouco, se o salvar sozinho está ligado e há o que gravar. Cada alteração empurra
    a hora para frente, então digitar ou arrastar não dispara uma gravação por tecla. */
function autosaveSoon() {
  clearTimeout(autoTimer);
  if (!A.autoSave || !A.flow || flowLocked() || !isDirty()) return;
  autoTimer = setTimeout(async () => {
    if (!A.autoSave || !A.flow || flowLocked() || !isDirty()) return;
    // no meio de um arrasto, com outra gravação andando ou sem nome: tenta de novo logo depois
    if (A.drag || autoBusy) return autosaveSoon();
    if (!A.flow.name.trim()) return;
    const now = doc();
    if (now === autoFailed) return;   // o mesmo conteúdo que o núcleo já recusou: espera a pessoa mexer
    autoBusy = true; paintBar();
    try { await save(); autoFailed = ''; }
    catch (e) { autoFailed = now; bs.toast('Salvar sozinho não conseguiu gravar: ' + e.message, 'err'); }
    finally { autoBusy = false; paintBar(); }
  }, 900);
}
function toggleAutoSave() {
  A.autoSave = !A.autoSave; autoFailed = '';
  try { localStorage.setItem('bs.automator.autoSave', A.autoSave ? '1' : '0'); } catch { /* vale só agora */ }
  bs.toast(A.autoSave ? 'Salvar sozinho ligado: cada alteração é gravada em seguida.' : 'Salvar sozinho desligado: use Salvar ou Ctrl+S.', 'ok');
  paintBar();
}
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
  const all = A.flow.nodes, wide = (d) => Math.max(NODE_W, ...all.filter(n => depth.get(n.id) === d).map(widthOf)), colX = new Map();
  { let x = 60; for (const d of [...cols.keys()].sort((a, b) => a - b)) { colX.set(d, x); x += wide(d) + 60; } }
  for (const [d, list] of cols) { list.sort((a, b) => a.position[1] - b.position[1]); let y = 48; for (const n of list) { setPos(n, colX.get(d), y); y += (nodeEls.get(n.id)?.offsetHeight || 96) + 36; } }
  touch(nodes.map(n => n.id)); changed();
}

// ---------- quadro: ponteiro ----------
function onDown(e) {
  bs.closeMenu();
  if (e.button === 2) return;
  closePicker();
  if (e.target.closest('.am-zoom, .am-add')) return;
  R.cv.focus({ preventScroll: true });
  const plus = e.target.closest('.am-plus'), port = e.target.closest('.am-port'), nodeEl = e.target.closest('.am-node'), edge = e.target.closest('.am-edge');
  if (plus && nodeEl) return;
  if (!A.flow) return;
  const grip = e.target.closest('.am-grip');
  if (grip && nodeEl) {
    const n = node(nodeEl.dataset.id); if (!n) return;
    if (nodeLocked(n.id)) return denied(flowLocked() ? '' : 'node');
    e.preventDefault(); try { R.cv.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético */ }
    if (!A.sel.has(n.id)) select([n.id]);
    A.drag = { kind: 'size', pid: e.pointerId, sx: e.clientX, sy: e.clientY, n, w0: widthOf(n), h0: nodeEl.offsetHeight, had: n.size ? [...n.size] : null, moved: false };
    return;
  }
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
  } else if (d.kind === 'size') {
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved) { commit(); d.moved = true; R.cv.classList.add('sizing'); }
    const snap = (v) => e.altKey ? Math.round(v) : Math.round(v / GRID) * GRID;
    const w = clamp(snap(d.w0 + dx / A.cam.z), NODE_MIN, NODE_MAX);
    // quem só puxa para o lado não fixa a altura: ela continua a do conteúdo
    const tall = Math.abs(dy) >= 6 ? Math.max(baseHeight(d.n), snap(d.h0 + dy / A.cam.z)) : (d.had?.[1] || 0);
    d.n.size = [w, tall];
    const elN = nodeEls.get(d.n.id); elN.classList.add('sized'); applySize(elN, d.n); touch([d.n.id]);
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
  R.cv.classList.remove('panning', 'dragging', 'wiring', 'sizing');
  if (d.kind === 'size') { if (d.moved) changed(); return; }
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
const maker = () => bs.plugins.list.some(p => p.id === 'iamaker' && p.enabled);
/** Abre o IAMaker num plugin novo, com o pedido de um nó para o Automator já começado. */
function newNodeWithAi(want) {
  bs.hooks.run('iamaker:compose', { text: `Crie um nó para o Automator${want ? ` chamado "${want}"` : ''}.\nO que ele faz: \nO que recebe: \nO que devolve: \nCampos que o usuário preenche: ` });
}
// nós de plugin criados (ou removidos) depois que a tela abriu: a lista se atualiza quando a paleta abre
const syncCatalog = async () => { try { const sp = await bs.api('automator/catalog', {}, { quiet: true }); if (JSON.stringify(sp.map(s => s.type)) !== JSON.stringify(A.specs.map(s => s.type))) { A.specs = sp; A.byType = new Map(sp.map(s => [s.type, s])); if (A.flow) for (const n of A.flow.nodes) refreshNode(n.id); } } catch { /* fica a lista que já tinha */ } };
/** `need`: só os nós que têm bolinha desse lado ('inputs' ou 'outputs'), para o fio solto no vazio. */
function openPicker(cx, cy, onPick, need) {
  closePicker();
  if (flowLocked()) return denied();
  syncCatalog();
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
        el('span.am-ico', { html: (CATS[s.category] || PLUG_CAT).i }), el('span.am-pick-tx', el('b', s.name), el('small', s.desc || ''), typeFlow(s))));
    });
    if (!items.length) body.append(el('p.am-hint', 'Nenhum nó com esse nome.'));
    // não achou o que precisa: o IAMaker cria um plugin com o nó novo
    if (maker()) body.append(el('button.am-pick-it.am-pick-new', { type: 'button', onclick: () => { const want = input.value.trim(); closePicker(); newNodeWithAi(want); } },
      el('span.am-ico', { html: IC.spark }), el('span.am-pick-tx', el('b', q ? `Criar o nó "${input.value.trim()}" com IA` : 'Criar um nó novo com IA'), el('small', 'O IAMaker escreve um plugin com o nó; ele aparece aqui quando ficar pronto.'))));
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
// ---------- o dado que cada nó conhece: a última execução dele, ou o exemplo do catálogo ----------
const asJson = (v) => { if (typeof v !== 'string') return v; const t = v.trim(); if (!/^[{\[]/.test(t)) return v; try { return JSON.parse(t); } catch { return v; } };
function knownOutput(id, port) {
  const u = node(id); if (!u) return undefined;
  const r = currentRun()?.nodes?.find(x => x.id === id);
  if (r?.status === 'completed' && r.output) { const k = port && port in r.output ? port : Object.keys(r.output)[0]; if (k !== undefined) return asJson(r.output[k]); }
  return spec(u.type)?.sample;
}
function incoming(n) { const e = A.flow.edges.find(x => x.to === n.id); return e ? knownOutput(e.from, e.from_port) : undefined; }
const digPath = (v, path) => path.split('.').filter(Boolean).reduce((c, k) => { c = asJson(c); return c == null ? undefined : c[k]; }, v);
/** O valor que uma expressão inteira ({{input}}, {{nodes.x.out}}) teria, pelo que já se conhece. */
function resolveExpr(n, text) {
  const m = /^\s*\{\{\s*(input(?:\.[\w.-]+)?|nodes\.[\w.-]+)\s*\}\}\s*$/.exec(String(text ?? '')); if (!m) return asJson(text);
  if (m[1].startsWith('input')) { const base = incoming(n); return m[1] === 'input' ? base : digPath(base, m[1].slice(6)); }
  const [id, port = 'out', ...rest] = m[1].slice(6).split('.'), base = knownOutput(id, port);
  return rest.length ? digPath(base, rest.join('.')) : base;
}
/** Caminhos de um JSON (campo.sub.0.x); das listas entra o primeiro item, que representa os outros. */
function pathsOf(v, max = 40) {
  const out = [];
  const walk = (x, path, depth) => {
    if (out.length >= max || depth > 4 || x == null || typeof x !== 'object') return;
    if (Array.isArray(x)) { if (x.length) { const p = path ? path + '.0' : '0'; out.push({ path: p, value: x[0] }); walk(x[0], p, depth + 1); } return; }
    for (const [k, val] of Object.entries(x)) { if (out.length >= max) break; if (!/^[\w-]+$/.test(k)) continue; const p = path ? path + '.' + k : k; out.push({ path: p, value: val }); walk(val, p, depth + 1); }
  };
  walk(asJson(v), '', 0); return out;
}
const peek = (v) => { const t = v == null ? 'vazio' : Array.isArray(v) ? `lista (${v.length})` : typeof v === 'object' ? 'objeto' : String(v).replace(/\s+/g, ' '); return t.length > 26 ? t.slice(0, 26) + '…' : t; };
const pathItems = (list, pickPath) => list.map(p => ({ label: `${p.path}  ·  ${peek(p.value)}`, action: () => pickPath(p.path) }));
/** O que o nó espera e o que entrega, no alto do painel. */
function ioBlock(s) {
  if (!s || (!s.expects && !s.returns)) return null;
  return el('section.am-io',
    s.inputs.length > 0 && s.expects && el('div.am-io-row', el('span.am-io-k', 'Recebe'), el('span', typeChip(typeOf(s, 'takes'), 'takes'), ' ', s.expects)),
    s.returns && el('div.am-io-row', el('span.am-io-k.out', 'Devolve'), el('span', typeChip(typeOf(s, 'gives'), 'gives'), ' ', s.returns)),
    s.sample !== undefined && el('details.am-io-ex', el('summary', 'Exemplo da saída'), el('pre.am-out', JSON.stringify(s.sample, null, 2))));
}
/** Saída em JSON: atalhos para ligar o nó que trata esse dado. */
function treatRow(id, r) {
  const n = node(id), port = Object.keys(r.output || {})[0]; if (!n || !port || flowLocked()) return null;
  const raw = r.output[port], v = asJson(raw);
  const types = Array.isArray(v) ? ['data.filter', 'json.sort', 'json.pluck', 'json.group', 'data.stats', 'data.table']
    : v && typeof v === 'object' ? ['json.get', 'json.pick', 'json.set', 'json.entries', 'json.text']
    : typeof raw === 'string' && /[{\[][\s\S]*[}\]]/.test(raw) ? ['json.parse'] : [];
  if (!types.length) return null;
  const add = (type, params) => { const x = addNode(type, [n.position[0] + widthOf(n) + 60, n.position[1]], { node: id, port, dir: 'out' }); if (x && params) { Object.assign(x.params, params); refreshNode(x.id); renderInspector(); changed(); } };
  return el('div.am-treat', el('span.am-hint', Array.isArray(v) ? 'Saiu uma lista. Tratar com:' : types[0] === 'json.parse' ? 'Parece ter JSON no texto:' : 'Saiu um JSON. Tratar com:'),
    el('div.am-treat-b', {}, types.filter(t => spec(t)).map(t => el('button.chip', { type: 'button', title: spec(t).desc,
      onclick: (e) => { const list = t === 'json.get' ? pathsOf(v) : []; list.length ? bs.showMenu(e, pathItems(list, (path) => add(t, { path })), 'Qual campo?') : add(t); } }, spec(t).name))));
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
  let input, extra = null, above = null;
  if (f.kind === 'select') {
    input = el('select', {}, f.options.map(o => el('option', { value: String(o.value ?? o), selected: String(o.value ?? o) === String(cur) }, o.label ?? o)));
    input.onchange = () => { set(input.value); renderInspector(); };
  } else if (f.kind === 'flow') {
    // um fluxo salvo (fora este), agrupado pelas pastas da lista
    const others = A.flows.filter(x => x.id && x.id !== A.flow?.id), hit = others.find(x => x.id === cur || x.name === cur);
    const opt = (x) => el('option', { value: x.id, selected: x === hit }, x.name || 'Fluxo sem nome');
    input = el('select', {}, el('option', { value: '' }, others.length ? 'Escolha um fluxo…' : 'Nenhum outro fluxo salvo ainda'),
      cur && !hit && el('option', { value: cur, selected: true }, 'Fluxo que não existe mais'),
      ...others.filter(x => !x.folder).map(opt),
      ...A.folders.filter(g => others.some(x => x.folder === g)).map(g => el('optgroup', { label: pathLabel(g) }, ...others.filter(x => x.folder === g).map(opt))));
    input.onchange = () => { set(input.value); renderInspector(); };
    if (hit) extra = el('button.am-link', { type: 'button', title: 'Abrir o fluxo chamado no quadro', onclick: () => pick(hit) }, 'abrir');
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
      const tone = (f.columns[0].options || []).find(o => o.value === r[f.columns[0].name])?.tone;
      return el('div.am-step' + (tone ? '.t-' + tone : ''), el('span.am-step-n', String(i + 1)), el('div.am-step-cells', {}, cells),
        el('div.am-step-acts', i > 0 && el('button.icon-btn', { type: 'button', title: 'Subir', html: IC.up, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); push(); draw(); } }),
          el('button.icon-btn', { type: 'button', title: 'Remover', html: IC.x, onclick: () => { rows.splice(i, 1); push(); draw(); } })));
    }), el('button.chip.am-step-add', { type: 'button', onclick: () => { rows.push(Object.fromEntries(f.columns.map(c => [c.name, c.kind === 'select' ? c.options[0].value : '']))); push(); draw(); } }, el('span', { html: IC.plus }), el('span', f.add || 'Linha')));
    input = el('div.am-steps'); draw();
    // gravador: o site abre de verdade e cada ação da pessoa chega aqui como um passo
    if (f.recorder && spec(n.type)?.record) {
      const btn = el('button.chip.am-rec', { type: 'button' }, el('i.am-rec-dot'), el('span', 'Gravar no navegador'));
      const note = el('small.am-hint', { hidden: true });
      let rec = null;
      const take = (res) => {
        let added = 0;
        for (const l of res.lines || []) {
          rec.from++;
          if (l.url && !String(n.params.url || '').trim()) { n.params.url = l.url; rec.url = true; }
          if (l.warn) bs.toast('Gravador: ' + l.warn, 'err');
          if (l.do) { rows.push({ do: l.do, on: l.on || '', value: l.value || '' }); added++; rec.count++; }
        }
        if (added || rec.url) { push(); draw(); input.lastElementChild?.scrollIntoView({ block: 'nearest' }); }
        note.textContent = `Gravando: ${rec.count} ${rec.count === 1 ? 'passo' : 'passos'}. Use o site; ao terminar, clique em Concluir lá ou em Parar aqui.`;
        return res;
      };
      const stop = async () => {
        if (!rec) return; const r = rec; clearInterval(r.timer);
        try { take(await post('automator/record', { action: 'stop', id: r.id, from: r.from })); } catch { /* o gravador já saiu */ }
        rec = null; A.recStop = null;
        btn.classList.remove('on'); btn.lastChild.textContent = 'Gravar no navegador';
        note.textContent = r.count ? `${r.count} ${r.count === 1 ? 'passo gravado' : 'passos gravados'}. Confira o roteiro e clique em Executar.` : 'Nada foi gravado.';
        if (r.count) renderInspector();
        if (r.url) renderInspector();
      };
      btn.onclick = guard(async () => {
        if (rec) return stop();
        if (nodeLocked(n.id)) return denied(flowLocked() ? '' : 'node');
        A.recStop?.();
        const r = await post('automator/record', { action: 'start', type: n.type, params: n.params });
        rec = { id: r.id, from: 0, count: 0 }; A.recStop = stop;
        btn.classList.add('on'); btn.lastChild.textContent = 'Parar a gravação'; note.hidden = false;
        note.textContent = 'Abrindo o navegador…';
        rec.timer = setInterval(async () => {
          if (!rec) return;
          try { const res = take(await post('automator/record', { action: 'poll', id: rec.id, from: rec.from })); if (res.done) { if (res.error && !rec.count) bs.toast('Gravador: ' + res.error, 'err'); stop(); } } catch { /* tenta de novo */ }
        }, 700);
      });
      above = el('div.am-rec-line', btn, note);
    }
  } else if (f.kind === 'area') {
    input = el('textarea' + (f.code ? '.mono' : ''), { rows: f.code ? 9 : 4, spellcheck: !f.code, value: cur ?? '', placeholder: f.placeholder || '' }); input.oninput = () => set(input.value);
    // campo de script: a IA escreve ou altera, e a mudança aparece para conferir antes de entrar no nó
    if (f.code) above = el('div.am-rec-line', el('button.chip.am-ai-btn', { type: 'button', onclick: () => nodeLocked(n.id) ? denied(flowLocked() ? '' : 'node') : scriptAi(n, f, input, set) }, el('span', { html: IC.spark }), el('span', String(cur ?? '').trim() ? 'Editar com IA' : 'Escrever com IA')));
  } else {
    input = el('input', { type: 'text', value: cur ?? '', placeholder: f.placeholder || '', spellcheck: false }); input.oninput = () => set(input.value);
  }
  let control = above ? el('div.am-rec-wrap', above, input) : input;
  // biblioteca de sons: o botão toca o escolhido
  if (f.preview === 'sound') {
    const b = el('button.icon-btn.am-browse', { type: 'button', title: 'Ouvir', html: IC.play });
    b.onclick = () => { const v = input.value; if (!v || v === 'custom') return bs.toast(v ? 'Escolha o arquivo no campo de baixo.' : 'Sem som.'); A.audio?.pause(); A.audio = new Audio('/api/automator/sound?name=' + encodeURIComponent(v)); A.audio.play().catch(() => bs.toast('Não deu para tocar esse som.', 'err')); };
    control = el('div.am-browse-line', input, b);
  }
  // campo de caminho: o botão abre o seletor do Windows (arquivo, pasta, onde gravar ou um programa)
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
    extra.onclick = (e) => { const inside = pathsOf(incoming(n), 14); bs.showMenu(e, [
      { label: 'O que chegou neste nó', k: '{{input}}', action: () => insertAt(input, '{{input}}') },
      ...upstream(n.id).flatMap(u => (spec(u.type)?.outputs || []).map(p => ({ label: `Saída de ${titleOf(u)}${spec(u.type).outputs.length > 1 ? ' (' + (portName(u, p)) + ')' : ''}`, action: () => insertAt(input, `{{nodes.${u.id}.${p}}}`) }))),
      // os campos do JSON que chega aqui (da última execução, ou do exemplo do nó anterior)
      ...(inside.length ? ['-', ...pathItems(inside, (path) => insertAt(input, `{{input.${path}}}`))] : []),
      // senhas e tokens guardados no Automator: entra só o nome, o valor fica cifrado
      '-', ...A.creds.flatMap(c => [{ label: 'Credencial: ' + c.name, k: c.label || 'senha ou token', action: () => insertAt(input, `{{cred:${c.name}}}`) }, ...(c.user ? [{ label: 'Usuário de ' + c.name, k: c.user, action: () => insertAt(input, `{{cred:${c.name}.user}}`) }] : [])]),
      { label: A.creds.length ? 'Credenciais…' : 'Guardar uma senha ou token…', icon: IC.key, action: () => credsDialog() },
    ]); };
  }
  // campo que é um caminho dentro do JSON: a lista dos campos conhecidos, para não digitar
  if (f.paths) {
    extra = el('button.am-link', { type: 'button', title: 'Escolher entre os campos do dado' }, 'campos');
    extra.onclick = (e) => {
      let src = resolveExpr(n, n.params[f.paths] ?? s.params[f.paths]);
      if ((f.item || f.each) && Array.isArray(src)) src = src[0];
      const list = pathsOf(src);
      if (!list.length) return bs.toast('Ainda não conheço os campos desse dado. Execute o fluxo uma vez e eles aparecem aqui.');
      bs.showMenu(e, pathItems(list, (path) => { input.value = f.kind === 'lines' ? (input.value.trim() ? input.value.replace(/\n*$/, '\n') : '') + path : path; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }), 'Campos do dado');
    };
  }
  if (f.clis) extra = el('button.am-link', { type: 'button', title: 'Modelo, esforço e programas de cada agente', onclick: () => bs.aiClis.open(typeof n.params[f.name] === 'string' ? n.params[f.name] : undefined) }, 'configurar');
  const id = 'amf-' + uid('');
  // referência a uma credencial que ainda não foi guardada: o fluxo pararia neste nó
  const lacking = [...new Set([...JSON.stringify(cur ?? '').matchAll(/\{\{\s*cred:\s*([\w-]+)/g)].map(m => m[1]))].filter(c => !A.creds.some(x => x.name === c));
  if (lacking.length) { err.hidden = false; err.replaceChildren(...lacking.map(c => el('span.am-need', `A credencial "${c}" ainda não existe. `, el('button.am-link', { type: 'button', onclick: guard(async () => { await credEnter(c); renderInspector(); }) }, 'Guardar agora')))); }
  const group = f.kind === 'checks' || f.kind === 'rows';
  if (!group) input.id = id;
  return el('div.am-field', el('div.am-flabel', el('label', group ? {} : { htmlFor: id }, f.label), extra), control, f.help && el('small.am-hint', f.help), err);
}
// ---------- resultado de teste (Testar site, Testar API): passou ou falhou, passo a passo ----------
const isQa = (o) => !!o && typeof o === 'object' && typeof o.passed === 'number' && typeof o.failed === 'number' && (Array.isArray(o.steps) || Array.isArray(o.checks));
const openFile = guard(async (path) => { await post('automator/open', { path }); });
function qaView(o) {
  const rows = o.steps || o.checks, ok = o.failed === 0, vals = Object.entries(o.values || {}).filter(([, v]) => typeof v !== 'object' || v === null);
  return el('div.am-qa' + (ok ? '.ok' : '.bad'),
    el('div.am-qa-top', el('span.am-qa-res', { html: ok ? IC.ok : IC.err }), el('b', ok ? 'Passou' : 'Falhou'),
      el('span.am-qa-n', `${o.passed} de ${o.total ?? rows.length} ${o.passed === 1 ? 'passou' : 'passaram'}${o.ms != null ? ' · ' + fmtMs(o.ms) : ''}`)),
    el('div.am-qa-bar', {}, rows.map(s => el('i' + (s.skipped ? '.skip' : s.ok ? '.ok' : '.bad'), { title: [s.n ? s.n + '.' : '', s.name, s.on].filter(Boolean).join(' ') }))),
    el('ol.am-qa-list', {}, rows.map(s => el('li' + (s.skipped ? '.skip' : s.ok ? '.ok' : '.bad'),
      el('span.am-qa-st', s.skipped ? '–' : s.ok ? '✓' : '✕'),
      el('div.am-qa-tx', el('b', s.name || ''), s.on && el('code', s.on), s.note && el('small', s.note), s.error && el('p', s.error),
        s.shot && el('button.am-link', { type: 'button', onclick: () => openFile(s.shot) }, 'Ver a tela na hora da falha')),
      el('span.am-qa-ms', s.skipped ? '' : s.ms != null ? fmtMs(s.ms) : '')))),
    vals.length > 0 && el('div.am-qa-vals', el('h5', 'Campos lidos da tela'), vals.map(([k, v]) => el('div', el('span', k), el('b', String(v))))),
    (o.js_errors?.length > 0 || o.bad_requests?.length > 0) && el('p.am-qa-warn', [o.js_errors?.length ? `${o.js_errors.length} ${o.js_errors.length === 1 ? 'erro' : 'erros'} de JavaScript na página` : '', o.bad_requests?.length ? `${o.bad_requests.length} ${o.bad_requests.length === 1 ? 'pedido falhou' : 'pedidos falharam'}` : ''].filter(Boolean).join(' · ')),
    o.report && el('button.chip.am-wide', { type: 'button', onclick: () => openFile(o.report) }, 'Abrir o relatório'));
}
function runBlock(id) {
  const r = currentRun()?.nodes?.find(x => x.id === id); if (!r || r.status === 'skipped') return null;
  const out = r.output && Object.keys(r.output).length === 1 ? Object.values(r.output)[0] : r.output;
  return el('section.am-sec', el('h4', 'Última execução', el('span.am-tag.' + r.status, STATUS[r.status] + (r.ms != null ? ' · ' + fmtMs(r.ms) : ''))),
    r.error ? el('pre.am-out.err', r.error) : r.status === 'completed' ? (isQa(out) ? [qaView(out), el('details.am-io-ex', el('summary', 'Ver o JSON completo'), el('pre.am-out', show(out)))] : el('pre.am-out', show(out) || '(vazio)')) : null,
    r.status === 'completed' && !nodeLocked(id) ? treatRow(id, r) : null);
}
/** Execuções do fluxo: ocultas até a pessoa pedir. Aberta, traz a lista, a retenção e o botão de limpar. */
function runsSection() {
  const toggle = el('button.am-link', { type: 'button', 'aria-pressed': String(A.showRuns), title: A.showRuns ? 'Parar de buscar e mostrar a lista' : 'Buscar e mostrar as últimas execuções',
    onclick: () => { A.showRuns = !A.showRuns; try { localStorage.setItem('bs.automator.showRuns', A.showRuns ? '1' : '0'); } catch { /* vale só agora */ } A.runSig = ''; renderInspector(); pollRuns(); } }, A.showRuns ? 'ocultar' : 'mostrar');
  if (!A.showRuns) return el('section.am-sec', el('h4', 'Execuções', toggle), el('p.am-hint', 'Ocultas, para a tela ficar leve. O resultado da última continua em cada nó.'));
  const keep = el('input', { type: 'number', min: 5, max: 1000, value: A.keepRuns, 'aria-label': 'Quantas execuções guardar' }), note = el('small.am-ferr', { hidden: true });
  keep.onchange = async () => {
    const n = Number(keep.value);
    if (!Number.isInteger(n) || n < 5 || n > 1000) { note.hidden = false; note.textContent = 'Use um número de 5 a 1000.'; return; }
    note.hidden = true;
    try { A.keepRuns = (await post('automator/settings', { keep_runs: n })).keep_runs; A.runSig = ''; pollRuns(); bs.toast(`O histórico guarda as ${A.keepRuns} execuções mais recentes.`, 'ok'); } catch (e) { note.hidden = false; note.textContent = e.message; }
  };
  const clear = el('button.am-link', { type: 'button', title: 'Apagar as execuções terminadas deste fluxo', onclick: guard(async () => {
    if (!A.flow?.id || !(await ask('Limpar o histórico deste fluxo?', 'As execuções terminadas deste fluxo saem do histórico. Os fluxos e os nós não mudam.', [{ label: 'Cancelar', value: false }, { label: 'Limpar', value: true, cls: 'primary' }]))) return;
    await post('automator/settings', { action: 'clear_runs', flow: A.flow.id }); A.runSig = ''; await pollRuns(); renderInspector();
  }) }, 'limpar');
  return el('section.am-sec', el('h4', 'Execuções', toggle), runsBlock(),
    el('div.am-keep', el('span', 'Guardar no máximo'), keep, el('span', 'execuções, somando todos os fluxos'), A.runs.length ? clear : null), note);
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
      d.append(el('div.am-rnode' + (x.round ? '.in' : ''), el('b', n ? titleOf(n) : 'nó removido', x.round ? el('i.am-round', ' · volta ' + x.round) : '', x.rounds ? el('i.am-round', ' · ' + x.rounds) : ''), el('span.am-tag.' + x.status, STATUS[x.status] + (x.ms != null ? ' · ' + fmtMs(x.ms) : ''))));
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
  A.recStop?.(); // trocou de nó no meio de uma gravação: ela para
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
        ioBlock(s),
        el('label.am-field', el('span.am-flabel', el('span', 'Nome')), title),
        (s?.fields || []).filter(visible).map(f2 => field(n, f2)),
        n.type === 'ai.openrouter' && el('button.chip.am-wide', { type: 'button', onclick: () => plugin.vault.request('openrouter') }, el('span', { html: IC.key }), 'Guardar o token no Cofre'),
        n.type === 'trigger.webhook' && hookBlock(n),
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
      runsSection(),
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
    if (isQa(out)) { const rows = out.steps || out.checks; box.replaceChildren(el('div.am-qa-mini' + (out.failed ? '.bad' : '.ok'), el('b', out.failed ? `${out.failed} ${out.failed === 1 ? 'falhou' : 'falharam'}` : 'Passou'), el('span', `${out.passed} de ${out.total ?? rows.length}`), el('div.am-qa-bar', {}, rows.map(s => el('i' + (s.skipped ? '.skip' : s.ok ? '.ok' : '.bad')))))); }
    else box.replaceChildren(...(leaf && text ? [el('div.am-prev', text.length > 600 ? text.slice(0, 600) + '…' : text)] : []));
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
  // com a lista oculta, basta a execução mais recente (o estado dos nós no quadro)
  let runs; try { runs = await bs.api('automator/runs', { flow: id, limit: A.showRuns ? 20 : 2 }, { quiet: true }); } catch { return; }
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
  R.save.textContent = !A.autoSave ? 'Salvar' : autoBusy ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo';
  R.save.title = A.autoSave ? 'Salvar sozinho está ligado: cada alteração é gravada em seguida (desligue no menu ⋯)' : 'Salvar (Ctrl+S)';
  R.save.classList.toggle('auto', A.autoSave);
  autosaveSoon();
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
    ...(() => { const sib = siblings(f), i = sib.findIndex(x => x.id === f.id); return [
      ...(i > 0 ? [{ label: 'Mover para cima', icon: IC.up, action: () => moveFlow(f.id, f.folder || '', { before: sib[i - 1].id }) }] : []),
      ...(i >= 0 && i < sib.length - 1 ? [{ label: 'Mover para baixo', action: () => moveFlow(f.id, f.folder || '', { after: sib[i + 1].id }) }] : []),
    ]; })(),
    { label: 'Mover para uma pasta…', icon: IC.folder, action: () => bs.showMenu(e, [
      ...A.folders.filter(g => g !== (f.folder || '')).map(g => ({ label: '\u2003'.repeat(g.split('/').length - 1) + leafOf(g), icon: dot(folderColor(g)), action: () => moveFlow(f.id, g) })),
      ...(A.folders.some(g => g !== (f.folder || '')) ? ['-'] : []),
      { label: 'Nova pasta…', icon: IC.folderPlus, action: () => newFolder(f.id) },
      ...(f.folder ? [{ label: 'Tirar da pasta', action: () => moveFlow(f.id, '') }] : []),
    ], 'Mover "' + (f.name || 'fluxo') + '"') },
    { label: 'Renomear', action: async () => { if (f.locked) return denied(); await pick(f); if (A.flow?.id === f.id) { R.name.focus(); R.name.select(); } } },
    { label: 'Duplicar', icon: IC.copy, action: () => create(() => ({ ...clone(f), id: '', active: false, next_run: null, name: f.name + ' (cópia)' })) },
    { label: 'Exportar…', action: () => exportFlow(cur ? A.flow : f) },
    '-',
    { label: 'Excluir…', icon: IC.trash, action: guard(() => f.locked ? denied() : removeFlow(cur ? A.flow : f)) },
  ], f.name);
}
// ---------- lista de fluxos, com pastas e subpastas ----------
// O nome de uma pasta é o caminho dela: "Financeiro/Mensal". A.folders traz todos os caminhos, na ordem da pessoa.
const FOLD_KEY = 'bs.automator.folds';
const folds = (() => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } })();   // pastas fechadas
const keepFolds = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folds])); } catch { /* só não lembra da próxima vez */ } };
const leafOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const within = (p, x) => x === p || x.startsWith(p + '/');   // x é a pasta p, ou está dentro dela
const kidsOf = (p) => A.folders.filter(g => parentOf(g) === p);
const pathLabel = (p) => p.split('/').join(' › ');
const FOLDER_COLORS = [['Âmbar', '#e3a63a'], ['Azul', '#5b9df9'], ['Verde', '#3fc98a'], ['Roxo', '#a78bfa'], ['Rosa', '#e879b9'], ['Vermelho', '#ef6b6b'], ['Ciano', '#38bdf8'], ['Cinza', '#9aa4b2']];
/** A cor da pasta: a dela ou, sem uma, a da pasta de cima. */
const folderColor = (name) => { for (let p = name; p; p = parentOf(p)) if (A.folderColors[p]) return A.folderColors[p]; return FOLDER_COLORS[0][1]; };
const dot = (c) => `<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="${c}"/></svg>`;
/** Uma pergunta de uma linha (nome de pasta). Devolve o texto, ou null se a pessoa desistiu. */
function askText(title, text, label, value = '', okLabel = 'Salvar') {
  return new Promise((resolve) => {
    let done = false;
    const html = `<div class="dlg-hd"><div class="dlg-ic">${IC.folder}</div><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div></div>
      <label class="fld">${esc(label)}<input id="amAskIn" value="${esc(value)}" maxlength="60" spellcheck="false"></label>
      <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="amAskOk">${esc(okLabel)}</button></div>`;
    const box = dialog('amAskText', html, () => {});
    const input = box.querySelector('#amAskIn'), clean = () => input.value.replace(/[\\/]+/g, '-').trim() || null, finish = (v) => { if (done) return; done = true; box.hidden = true; resolve(v); };
    box.querySelector('#amAskOk').onclick = () => finish(clean());
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(clean()); } };
    new MutationObserver(() => { if (box.hidden) finish(null); }).observe(box, { attributes: true, attributeFilter: ['hidden'] });
    input.focus(); input.select();
  });
}
/** Põe o fluxo numa pasta ('' = fora) e, com `near` ({ before: id } ou { after: id }), ao lado de outro fluxo. */
const moveFlow = guard(async (id, folder, near = {}) => {
  A.folders = await post('automator/folders', { action: 'move', id, folder, ...near });
  if (A.flow?.id === id) A.flow.folder = folder;
  for (let p = folder; p; p = parentOf(p)) folds.delete(p);
  keepFolds();
  await refreshFlows();
});
/** Cria uma pasta (dentro de `parent`, se vier); com `flowId`, o fluxo já vai para dentro dela. */
const newFolder = guard(async (flowId, parent = '') => {
  const typed = await askText(parent ? 'Nova subpasta' : 'Nova pasta', parent ? `Fica dentro de "${pathLabel(parent)}".` : 'Pastas organizam a lista de fluxos. Arraste um fluxo ou outra pasta para dentro, ou use o menu.', 'Nome da pasta', '', 'Criar');
  if (!typed) return;
  const name = (parent ? parent + '/' : '') + typed;
  A.folders = await post('automator/folders', { action: 'create', name });
  for (let p = name; p; p = parentOf(p)) folds.delete(p);
  keepFolds();
  if (typeof flowId === 'string' && flowId) return moveFlow(flowId, name);
  paintList();
});
/** Troca o caminho de uma pasta (renomear, ou mover para dentro de outra): o que a tela lembra dela vai junto. */
async function repathFolder(from, to) {
  if (from === to) return;
  A.folders = await post('automator/folders', { action: 'rename', name: from, to });
  const swap = (x) => to + x.slice(from.length);
  for (const g of [...folds]) if (within(from, g)) { folds.delete(g); folds.add(swap(g)); }
  for (let p = parentOf(to); p; p = parentOf(p)) folds.delete(p);
  keepFolds();
  for (const k of Object.keys(A.folderColors)) if (within(from, k)) { A.folderColors[swap(k)] = A.folderColors[k]; delete A.folderColors[k]; }
  if (A.flow?.folder && within(from, A.flow.folder)) A.flow.folder = swap(A.flow.folder);
  await refreshFlows();
}
/** Leva a pasta para dentro de `parent` ('' = para fora de todas). */
const moveFolder = guard((name, parent) => within(name, parent) ? bs.toast('Uma pasta não cabe dentro dela mesma.') : repathFolder(name, (parent ? parent + '/' : '') + leafOf(name)));
const orderFolders = guard(async (names) => { A.folders = await post('automator/folders', { action: 'order', names }); paintList(); });
/** Os vizinhos do fluxo na lista: os da mesma pasta (ou os soltos), na ordem em que aparecem. */
const siblings = (f) => A.flows.filter(x => (x.folder || '') === (f.folder || ''));
/** O menu de organizar a lista: pastas, recolher e expandir, ordem de A a Z, exportar e importar. */
function listMenu(e) {
  const anyOpen = A.folders.some(g => !folds.has(g));
  const sort = (what) => guard(async () => { A.folders = await post('automator/folders', { action: 'sort', what }); await refreshFlows(); });
  bs.showMenu(e, [
    { label: 'Nova pasta…', icon: IC.folderPlus, action: () => newFolder() },
    ...(A.folders.length ? [{ label: anyOpen ? 'Recolher todas as pastas' : 'Expandir todas as pastas', action: () => { anyOpen ? A.folders.forEach(g => folds.add(g)) : folds.clear(); keepFolds(); paintList(); } }] : []),
    '-',
    { label: 'Ordenar os fluxos de A a Z', action: sort('flows') },
    ...(A.folders.length > 1 ? [{ label: 'Ordenar as pastas de A a Z', action: sort('folders') }] : []),
    '-',
    { label: 'Exportar todos os fluxos…', action: () => exportFlows() },
    { label: 'Importar fluxos…', action: () => R.file.click() },
  ], 'Organizar a lista');
}
function folderMenu(e, name) {
  const inside = A.flows.filter(f => within(name, f.folder || '')), subs = A.folders.filter(g => g !== name && within(name, g));
  const up = parentOf(name), sib = kidsOf(up), at = sib.indexOf(name);
  const swap = (d) => { const l = [...A.folders], a = l.indexOf(name), b = l.indexOf(sib[at + d]); [l[a], l[b]] = [l[b], l[a]]; orderFolders(l); };
  const targets = A.folders.filter(g => !within(name, g) && g !== up);
  bs.showMenu(e, [
    { label: 'Novo fluxo aqui', icon: IC.plus, action: () => { folds.delete(name); keepFolds(); create(() => ({ ...blank(), folder: name })); } },
    { label: 'Nova subpasta…', icon: IC.folderPlus, action: () => newFolder('', name) },
    '-',
    ...(at > 0 ? [{ label: 'Mover para cima', icon: IC.up, action: () => swap(-1) }] : []),
    ...(at >= 0 && at < sib.length - 1 ? [{ label: 'Mover para baixo', action: () => swap(1) }] : []),
    ...(targets.length || up ? [{ label: 'Mover para dentro de…', icon: IC.folder, action: () => bs.showMenu(e, [
      ...(up ? [{ label: 'Fora de todas as pastas', action: () => moveFolder(name, '') }, '-'] : []),
      ...targets.map(g => ({ label: '\u2003'.repeat(g.split('/').length - 1) + leafOf(g), icon: dot(folderColor(g)), action: () => moveFolder(name, g) })),
    ], 'Mover "' + leafOf(name) + '"') }] : []),
    '-',
    { label: 'Cor da pasta…', icon: dot(folderColor(name)), action: () => bs.showMenu(e, FOLDER_COLORS.map(([label, c], k) => ({ label: ((A.folderColors[name] || (k === 0 && !A.folderColors[name] && folderColor(name) === c ? c : '')) === c ? '✓ ' : '') + label, icon: dot(c), action: guard(async () => {
      await post('automator/folders', { action: 'color', name, color: c });
      A.folderColors[name] = c;
      paintList();
    }) })), 'Cor de "' + leafOf(name) + '"') },
    { label: 'Renomear…', action: guard(async () => {
      const typed = await askText('Renomear a pasta', 'Os fluxos e as subpastas continuam dentro dela.', 'Nome da pasta', leafOf(name));
      if (typed) await repathFolder(name, (up ? up + '/' : '') + typed);
    }) },
    { label: 'Exportar a pasta…', action: () => exportFlows(name) },
    '-',
    { label: 'Excluir a pasta…', icon: IC.trash, action: guard(async () => {
      if (inside.length || subs.length) {
        const what = [inside.length ? (inside.length === 1 ? 'O fluxo de dentro vai' : 'Os ' + inside.length + ' fluxos de dentro vão') + (up ? ` para "${pathLabel(up)}"` : ' para fora de pasta') + '. Nenhum fluxo é apagado.' : '', subs.length ? (subs.length === 1 ? 'A subpasta dela também sai.' : 'As ' + subs.length + ' subpastas dela também saem.') : ''].filter(Boolean).join(' ');
        if (!(await ask(`Excluir a pasta "${leafOf(name)}"?`, what, [{ label: 'Cancelar', value: false }, { label: 'Excluir a pasta', value: true, cls: 'primary' }]))) return;
      }
      A.folders = await post('automator/folders', { action: 'delete', name });
      for (const g of [...folds]) if (within(name, g)) folds.delete(g);
      keepFolds();
      for (const k of Object.keys(A.folderColors)) if (within(name, k)) delete A.folderColors[k];
      if (A.flow?.folder && within(name, A.flow.folder)) A.flow.folder = up;
      await refreshFlows();
    }) },
  ], pathLabel(name));
}
function paintList() {
  if (!R.list) return;
  const q = R.search.value.trim().toLowerCase();
  const clearMarks = () => { R.list.querySelectorAll('.drop, .drop-before, .drop-after').forEach(x => x.classList.remove('drop', 'drop-before', 'drop-after')); R.list.classList.remove('drop'); };
  // alvo que recebe um fluxo ou uma pasta inteiros (o miolo de uma pasta, a seção "Sem pasta", o espaço livre)
  const drop = (target, folder) => {
    target.ondragover = (e) => { if (!A.dragFlow && !(A.dragFolder && !within(A.dragFolder, folder))) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; target.classList.add('drop'); };
    target.ondragleave = () => target.classList.remove('drop');
    target.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation(); target.classList.remove('drop');
      if (A.dragFolder) { const from = A.dragFolder; A.dragFolder = null; if (parentOf(from) !== folder) moveFolder(from, folder); return; }
      const id = A.dragFlow; A.dragFlow = null; const f = A.flows.find(x => x.id === id); if (f && (f.folder || '') !== folder) moveFlow(id, folder);
    };
  };
  const row = (f) => {
    const cur = f === A.flow || (f.id && f.id === A.flow?.id), running = cur && isRunning();
    const state = !f.id ? 'rascunho, ainda não salvo' : f.active && f.next_run ? 'agenda · ' + fmtWhen(f.next_run) : hasSchedule(f) ? (f.active ? 'ligado' : 'desligado') : 'manual';
    // na busca a lista é corrida, então a pasta aparece ao lado do estado
    const meta = q && f.folder ? pathLabel(f.folder) + ' · ' + state : state;
    const tone = running ? '.run' : !f.id ? '.draft' : f.active ? '.live' : '';
    const b = el('button.am-flow' + (cur ? '.current' : ''), { type: 'button', draggable: !!f.id, onclick: () => f.id && pick(A.flows.find(x => x.id === f.id)), oncontextmenu: (e) => { e.preventDefault(); if (f.id) flowMenu(e, A.flows.find(x => x.id === f.id) || f); } },
      el('i.am-fdot' + tone, { title: running ? 'Executando' : f.active ? 'Ligado: roda sozinho' : '' }),
      el('span.am-ftx', el('span.am-fname', el('span', f.name || 'Fluxo sem nome'), f.locked && el('span.am-flock', { html: IC.lock, title: 'Trancado: só visualização' }), el('i.am-fdirty', { hidden: !(cur && isDirty()), title: 'Alterações não salvas' })), el('span.am-fmeta' + (f.active ? '.live' : ''), meta)));
    b.ondragstart = (e) => { e.stopPropagation(); A.dragFlow = f.id; A.dragFolder = null; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name || ''); b.classList.add('dragging'); };
    b.ondragend = () => { A.dragFlow = null; b.classList.remove('dragging'); clearMarks(); };
    // soltar sobre outro fluxo: fica antes ou depois dele (metade de cima ou de baixo), na pasta dele
    if (f.id) {
      const half = (e) => { const r = b.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; };
      b.ondragover = (e) => { if (!A.dragFlow || A.dragFlow === f.id) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; const h = half(e); b.classList.toggle('drop-before', h === 'before'); b.classList.toggle('drop-after', h === 'after'); };
      b.ondragleave = () => b.classList.remove('drop-before', 'drop-after');
      b.ondrop = (e) => { if (!A.dragFlow || A.dragFlow === f.id) return; e.preventDefault(); e.stopPropagation(); const h = half(e), id = A.dragFlow; A.dragFlow = null; b.classList.remove('drop-before', 'drop-after'); moveFlow(id, f.folder || '', { [h]: f.id }); };
    }
    return b;
  };
  const draft = A.flow && !A.flow.id ? [A.flow] : [];
  if (q) {
    const hits = [...draft, ...A.flows].filter(f => (f.name || '').toLowerCase().includes(q) || (f.folder || '').toLowerCase().includes(q));
    R.list.replaceChildren(...hits.map(row));
    if (!hits.length) R.list.append(el('p.am-hint', 'Nenhum fluxo ou pasta com esse nome.'));
    return;
  }
  const all = [...draft, ...A.flows];
  const isCur = (f) => f === A.flow || (f.id && f.id === A.flow?.id);
  const folder = (name) => {
    const own = all.filter(f => f.folder === name), total = all.filter(f => within(name, f.folder || '')).length, subs = kidsOf(name);
    const shut = folds.has(name), hasCur = all.some(f => isCur(f) && within(name, f.folder || ''));
    const act = (title, icon, fn) => el('span.am-fd-act', { role: 'button', tabIndex: -1, title, html: icon, onclick: (e) => { e.stopPropagation(); fn(e); } });
    const head = el('button.am-folder' + (shut ? '' : '.open') + (shut && hasCur ? '.has-cur' : ''), { type: 'button', draggable: true, title: shut ? 'Abrir a pasta' : 'Fechar a pasta', 'aria-expanded': String(!shut),
      onclick: () => { shut ? folds.delete(name) : folds.add(name); keepFolds(); paintList(); }, oncontextmenu: (e) => { e.preventDefault(); folderMenu(e, name); } },
      el('span.am-chev', { html: IC.chev }), el('span.am-fd-ic', { html: IC.folder }), el('span.am-fd-name', leafOf(name)), el('small', String(total)),
      el('span.am-fd-acts', act('Novo fluxo nesta pasta', IC.plus, () => { folds.delete(name); keepFolds(); create(() => ({ ...blank(), folder: name })); }), act('Subpasta, cor, mover, renomear, excluir', IC.more, (e) => folderMenu(e, name))));
    // uma pasta recebe um fluxo (entra nela) e outra pasta: no meio entra nela; nas bordas, fica antes ou depois
    const zone = (e) => { const r = head.getBoundingClientRect(), y = (e.clientY - r.top) / r.height; return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'in'; };
    const mark = (z) => { head.classList.toggle('drop-before', z === 'before'); head.classList.toggle('drop-after', z === 'after'); head.classList.toggle('drop', z === 'in'); };
    head.ondragstart = (e) => { e.stopPropagation(); A.dragFolder = name; A.dragFlow = null; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', leafOf(name)); head.classList.add('dragging'); };
    head.ondragend = () => { A.dragFolder = null; head.classList.remove('dragging'); clearMarks(); };
    head.ondragover = (e) => {
      if (A.dragFlow) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; return mark('in'); }
      if (!A.dragFolder || within(A.dragFolder, name)) return;
      e.preventDefault(); e.stopPropagation(); mark(zone(e));
    };
    head.ondragleave = () => mark('');
    head.ondrop = guard(async (e) => {
      e.preventDefault(); e.stopPropagation(); mark('');
      if (A.dragFlow) { const id = A.dragFlow; A.dragFlow = null; const f = A.flows.find(x => x.id === id); if (f && (f.folder || '') !== name) moveFlow(id, name); return; }
      const from = A.dragFolder, z = zone(e); A.dragFolder = null;
      if (!from || within(from, name)) return;
      if (z === 'in') return moveFolder(from, name);
      // ao lado desta: mesma pasta de cima que ela, na posição escolhida
      const up = parentOf(name), moved = (up ? up + '/' : '') + leafOf(from);
      if (parentOf(from) !== up) await repathFolder(from, moved);
      const l = A.folders.filter(x => x !== moved); l.splice(l.indexOf(name) + (z === 'after' ? 1 : 0), 0, moved); orderFolders(l);
    });
    const group = el('div.am-fgroup' + (shut ? '' : '.open'), { style: { '--fd': folderColor(name) } }, head);
    if (!shut) {
      const kids = el('div.am-fkids', {}, subs.length || own.length ? [...subs.map(folder), ...own.map(row)] : [el('p.am-folder-empty', 'Vazia. Arraste um fluxo ou uma pasta para cá.')]);
      drop(kids, name);
      group.append(kids);
    }
    return group;
  };
  const out = kidsOf('').map(folder);
  const loose = all.filter(f => !f.folder || !A.folders.includes(f.folder));
  if (A.folders.length && (loose.length || A.flows.length)) {
    const label = el('div.am-loose', el('span', 'Sem pasta'), el('small', String(loose.length)));
    drop(label, '');
    out.push(label);
  }
  out.push(...loose.map(row));
  R.list.replaceChildren(...out);
  // soltar no espaço livre da lista tira o fluxo (ou a pasta) de dentro das pastas
  drop(R.list, '');
  if (!R.list.childElementCount) R.list.append(el('div.am-list-empty', el('span', { html: IC.app }), el('b', 'Nenhum fluxo ainda'), el('small', 'Crie um em "Novo fluxo", comece de um modelo ou peça à IA.')));
}

// ---------- credenciais do Automator: senhas e tokens que os fluxos usam como {{cred:nome}} ----------
// A tela segue a do Cofre da IDE (vault.js): cartões, "Nova credencial", registro de uso e o arquivo no rodapé.
const CR = { edit: null, log: [], file: '' };
function paintCredsBtn() { if (R.credsBtn) R.credsBtn.textContent = A.creds.length ? String(A.creds.length) : ''; }
function takeCreds(d) { A.creds = d.entries || []; CR.log = d.audit || []; CR.file = d.file || ''; paintCredsBtn(); }
async function loadCreds() { try { takeCreds(await bs.api('automator/creds', {}, { quiet: true })); } catch { /* fica a lista que já tinha */ } }
/** Abre a janela do BlueScreen (fora da página) para digitar o usuário e a senha ou token. */
async function credEnter(name, label) { takeCreds(await post('automator/creds', { action: 'enter', name, ...(label != null ? { label } : {}) })); }
const credSlug = (t) => t.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const credAgo = (t) => (bs.ago ? bs.ago(t) : '') || 'agora';
function credCard(c) {
  const flows = c.flows || [], ref = (t) => `<button type="button" class="vt-chip am-cr-copy" data-copy="${esc(t)}" title="Copiar para colar num campo">${esc(t)}</button>`;
  return `<div class="vt-ent" data-name="${esc(c.name)}">
    <div class="vt-hd"><span class="vt-key">${IC.key}</span><div class="vt-tx"><div><b>${esc(c.name)}</b>${c.label ? ` <span class="vt-lbl">${esc(c.label)}</span>` : ''}</div>
      <div class="vt-meta">${c.user ? 'usuário + senha · ' : ''}${c.length} caracteres · trocada ${esc(credAgo(c.updated))}${c.lastUsed ? ` · usada ${esc(credAgo(c.lastUsed))} por ${esc(c.lastBy || '')}` : ' · nunca usada'}</div></div>
      <button class="icon-btn" data-act="menu" title="Mais">${IC.more}</button></div>
    ${CR.edit === c.name ? `<div class="vt-form"><label class="fld">Descrição<input data-f="label" value="${esc(c.label || '')}" spellcheck="false" maxlength="120"></label>
        <div class="vt-btns"><button class="chip" data-act="cancel">Cancelar</button><button class="chip primary" data-act="save">Salvar</button></div></div>`
    : `<div class="vt-row">Nos campos dos nós: ${ref(`{{cred:${c.name}}}`)}${c.user ? ' ' + ref(`{{cred:${c.name}.user}}`) : ''}</div>
       ${c.user ? `<div class="vt-row">Usuário: <span class="vt-chip">${esc(c.user)}</span></div>` : ''}
       <div class="vt-row">Fluxos que usam: ${flows.length ? flows.map(f => `<span class="vt-chip">${esc(f)}</span>`).join(' ') : '<span class="vt-none">nenhum fluxo salvo</span>'}</div>
       ${c.origin === 'ia' ? '<div class="vt-why">Veio de um pedido feito à IA: o valor saiu do texto e foi guardado aqui.</div>' : ''}`}
  </div>`;
}
function credsDialog(keep) {
  if (!keep) CR.edit = null;
  const html = `<div class="dlg-hd"><span class="dlg-ic">${IC.key}</span><div><h3>Cofre do Automator</h3><p>Senhas e tokens que os fluxos usam sem ver o valor. Ficam cifrados neste PC e são só do Automator: o Cofre da IDE é outro, com outras regras.</p></div></div>
    <div class="vt-body">
    <div class="vt-sub">Credenciais${A.creds.length ? ` <span class="vt-n">${A.creds.length}</span>` : ''}</div>
    ${A.creds.length ? A.creds.map(credCard).join('') : '<div class="vt-none vt-empty">O cofre do Automator está vazio.</div>'}
    <div class="vt-new"><div class="vt-sub">Nova credencial</div>
      <p class="vt-why">Clique em <b>Digitar e guardar</b>: abre uma janela do BlueScreen pedindo o usuário (opcional) e a senha ou token. Digite ou cole ali (Ctrl+V). O que você digita vai direto para o cofre, sem passar por esta tela. Uma senha escrita num pedido de "Criar com IA" também vem parar aqui.</p>
      <div class="vt-2"><label class="fld">Nome<input id="amCrName" spellcheck="false" maxlength="40" placeholder="senha-portal"></label>
        <label class="fld">Descrição<input id="amCrLabel" spellcheck="false" maxlength="120" placeholder="Login do portal de notas"></label></div>
      <div class="vt-row">Depois use nos nós como <span class="vt-chip">{{cred:nome}}</span> e, para o usuário, <span class="vt-chip">{{cred:nome.user}}</span></div>
      <p class="am-gen-st" id="amCrSt" aria-live="polite"></p>
      <div class="vt-btns"><button class="chip primary" id="amCrAdd" type="button">${IC.key}Digitar e guardar…</button></div></div>
    ${CR.log.length ? `<details class="vt-log"><summary>Registro de uso <span class="vt-n">${CR.log.length}</span></summary>${CR.log.slice(0, 60).map(a => `<div class="${a.ok ? '' : 'bad'}"><span>${esc(credAgo(a.at))}</span><b>${esc(a.by || '')}</b> <code>${esc(a.name)}</code>${a.ok ? '' : ` · <em>${esc(a.why)}</em>`}</div>`).join('')}</details>` : ''}
    </div>
    <div class="actions"><span class="vt-file" title="${esc(CR.file)}">${esc(CR.file.split(/[\\/]/).pop() || 'automator-credentials.json')}</span><span class="spacer"></span><button class="chip" data-close>Fechar</button></div>`;
  const box = dialog('amCreds', html, () => {}) || document.getElementById('amCreds');
  box.querySelector('.dlg-box').classList.add('vt-box');
  const $ = (q) => box.querySelector(q), st = $('#amCrSt');
  const say = (t, bad) => { st.textContent = t; st.classList.toggle('bad', !!bad); };
  const redraw = (msg) => { const y = box.querySelector('.dlg-scroll')?.scrollTop || 0; credsDialog(true); const b = document.getElementById('amCreds'); const sc = b.querySelector('.dlg-scroll'); if (sc) sc.scrollTop = y; if (msg) { const s2 = b.querySelector('#amCrSt'); s2.textContent = msg; } if (A.flow) renderInspector(); };
  const quiet = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'cancelado') say('Não deu: ' + e.message, true); } };
  box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => bs.toast('Copiado: ' + b.dataset.copy, 'ok')).catch(() => {}));
  box.querySelectorAll('.vt-ent').forEach(card => {
    const name = card.dataset.name, c = A.creds.find(x => x.name === name);
    const act = (a) => card.querySelector(`[data-act=${a}]`);
    act('menu').onclick = (e) => bs.showMenu(e, [
      { label: 'Trocar o valor ou o usuário…', icon: IC.key, action: quiet(async () => { await credEnter(name); redraw(`"${name}" atualizada.`); }) },
      { label: 'Editar a descrição', action: () => { CR.edit = name; redraw(); } },
      { label: 'Copiar a referência', icon: IC.copy, action: () => navigator.clipboard?.writeText(`{{cred:${name}}}`).then(() => bs.toast(`Copiado: {{cred:${name}}}`, 'ok')).catch(() => {}) },
      '-',
      { label: 'Apagar do cofre…', icon: IC.trash, action: quiet(async () => {
        const used = (c.flows || []).length;
        const yes = await ask(`Apagar "${name}" do cofre do Automator?`, used ? `Ela é usada em ${c.flows.join(', ')}. Sem ela, esses fluxos param no nó que a usa, até você guardar outra com o mesmo nome.` : 'Nenhum fluxo salvo usa esta credencial.', [{ label: 'Cancelar', value: false }, { label: 'Apagar', value: true, cls: 'primary' }]);
        if (yes) takeCreds(await post('automator/creds', { action: 'delete', name }));
        redraw(yes ? `"${name}" apagada.` : '');
      }) },
    ]);
    if (act('cancel')) act('cancel').onclick = () => { CR.edit = null; redraw(); };
    if (act('save')) act('save').onclick = quiet(async () => { takeCreds(await post('automator/creds', { action: 'label', name, label: card.querySelector('[data-f=label]').value })); CR.edit = null; redraw(); });
  });
  $('#amCrAdd').onclick = quiet(async () => {
    const name = credSlug($('#amCrName').value);
    if (!name) { say('Dê um nome à credencial.', true); return $('#amCrName').focus(); }
    if (A.creds.some(c => c.name === name)) { say(`Já existe "${name}". Para mudar o valor, use o menu dela: Trocar o valor.`, true); return; }
    say('Digite o valor na janela que abriu.');
    await credEnter(name, $('#amCrLabel').value.trim());
    redraw(`Guardada. Use {{cred:${name}}} nos campos dos nós.`);
  });
  $('#amCrName').onkeydown = (e) => { if (e.key === 'Enter') $('#amCrAdd').click(); };
}

// ---------- IA: agente, modelo e esforço; a espera com etapa, tempo e cancelar ----------
const WHO_KEY = 'bs.automator.ai';
const whoSaved = () => { try { const v = JSON.parse(localStorage.getItem(WHO_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
function whoHtml(id) {
  const saved = whoSaved();
  const opts = [...(spec('agent.cli')?.fields.find(f => f.name === 'provider')?.options || []).map(o => [o.value, o.label]), ['openrouter', 'OpenRouter']];
  const cur = opts.some(o => o[0] === saved.last) ? saved.last : opts.some(o => o[0] === 'claude') ? 'claude' : opts[0][0];
  const efforts = spec('agent.cli')?.fields.find(f => f.name === 'effort')?.options || [];
  return `<div class="am-who" id="${id}Who">
    <label class="fld">Agente<select data-w="provider">${opts.map(o => `<option value="${esc(o[0])}"${o[0] === cur ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>
    <label class="fld">Modelo<input data-w="model" list="${id}Models" spellcheck="false" autocomplete="off"><datalist id="${id}Models"></datalist></label>
    <label class="fld" data-w="effortBox">Esforço<select data-w="effort">${efforts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>
    <button type="button" class="am-link am-who-cfg" title="Programas, modelo e esforço padrão de cada agente">Agentes…</button></div>`;
}
/** Liga os campos de `whoHtml`; devolve a função que lê a escolha (e reclama se faltar o modelo do OpenRouter). */
function whoBind(box, id) {
  const root = box.querySelector(`#${id}Who`), $ = (k) => root.querySelector(`[data-w=${k}]`), saved = whoSaved();
  let clis = [];
  const hints = () => {
    const p = $('provider').value, cli = clis.find(c => c.id === p), or = p === 'openrouter';
    $('model').placeholder = or ? 'provedor/modelo' : cli?.model ? `o do agente: ${cli.model}` : 'o do agente';
    $('effortBox').hidden = or;
    const first = $('effort').options[0]; if (first) first.textContent = cli?.effort ? `O do agente (${cli.effort})` : 'O do agente';
    root.querySelector('datalist').innerHTML = ((cli?.kind || p) === 'claude' ? ['opus', 'sonnet', 'haiku'] : []).map(m => `<option value="${m}">`).join('');
  };
  const load = () => { const mine = saved[$('provider').value] || {}; $('model').value = mine.model || ''; $('effort').value = mine.effort || ''; hints(); };
  $('provider').onchange = load; load();
  root.querySelector('.am-who-cfg').onclick = () => bs.aiClis.open($('provider').value === 'openrouter' ? undefined : $('provider').value);
  bs.api('agents/clis', {}, { quiet: true }).then(l => { clis = Array.isArray(l) ? l : []; hints(); }).catch(() => {});
  return () => {
    const provider = $('provider').value, model = $('model').value.trim(), effort = provider === 'openrouter' ? '' : $('effort').value;
    if (provider === 'openrouter' && !model) { $('model').focus(); throw new Error('informe o modelo do OpenRouter, no formato provedor/modelo.'); }
    try { localStorage.setItem(WHO_KEY, JSON.stringify({ ...saved, last: provider, [provider]: { model, effort } })); } catch { /* só não lembra da próxima vez */ }
    return { provider, model, effort, cwd: bs.S.project?.path || '' };
  };
}
const fmtClock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
/** Manda o pedido à IA e troca o miolo da janela pela espera: a etapa vem do núcleo, o tempo corre e dá para
    cancelar (o agente é encerrado). Fechar a janela também cancela. Devolve a resposta, ou lança o erro. */
async function aiRun(box, route, body, steps) {
  const job = uid('j'), began = Date.now(), scroll = box.querySelector('.dlg-scroll');
  const stage = el('b.am-wait-stage', 'Preparando o pedido'), clock = el('span.am-wait-time', '0:00');
  const list = el('ol.am-wait-steps', {}, steps.map((t, i) => el('li' + (i === 0 ? '.on' : ''), el('i'), el('span', t))));
  const stop = el('button.chip', { type: 'button' }, 'Cancelar');
  const wait = el('div.am-wait', { role: 'status', 'aria-live': 'polite' }, el('div.am-wait-art', el('i'), el('i'), el('i')), stage, clock, list, stop, el('small.am-hint', 'Pode levar alguns minutos. Esforço mais alto demora mais.'));
  let cancelled = false;
  const cancel = () => { if (cancelled) return; cancelled = true; stop.disabled = true; stage.textContent = 'Cancelando…'; post('automator/generate', { action: 'cancel', job }).catch(() => {}); };
  stop.onclick = cancel;
  scroll.append(wait); box.classList.add('am-busy');
  const timer = setInterval(async () => {
    clock.textContent = fmtClock(Date.now() - began);
    if (box.hidden) return cancel();
    if (cancelled) return;
    try {
      const st = await bs.api('automator/generate', { job }, { quiet: true });
      if (!st.running || cancelled) return;
      stage.textContent = st.stage;
      [...list.children].forEach((li, i) => { li.classList.toggle('done', i < st.step); li.classList.toggle('on', i === st.step); });
    } catch { /* a próxima volta tenta de novo */ }
  }, 1000);
  try { return await post(route, { ...body, job }); }
  catch (e) { throw cancelled ? new Error('cancelado') : e; }
  finally { clearInterval(timer); wait.remove(); box.classList.remove('am-busy'); }
}
/** O que aconteceu com as senhas do pedido, em frases: [tom, texto]. */
function secretLines(res) {
  return (res.secrets || []).map(x => x.error ? ['bad', `Não deu para guardar a credencial "${x.name}": ${x.error}`]
    : !x.used ? ['warn', 'Uma senha escrita no pedido não foi usada, então não foi guardada.']
    : x.existed ? ['key', `A senha do pedido já estava em Credenciais como "${x.name}". O valor não foi enviado para a IA.`]
    : x.local ? ['key', `Senha guardada em Credenciais como "${x.name}". Ela saiu do pedido antes de ele ir para a IA.`]
    : ['warn', `Senha guardada em Credenciais como "${x.name}". A IA chegou a ver o valor: ele estava escrito de um jeito que o BlueScreen não reconheceu sozinho.`]);
}
const doneList = (lines) => lines.map(([tone, text]) => `<li class="${tone}">${tone === 'key' ? IC.key : IC.err}<span>${esc(text)}</span></li>`).join('');
/** Depois de a IA montar ou ajustar um fluxo: credenciais, o que falta preencher e o que a conferência achou. */
function aiDone(title, res) {
  const lines = secretLines(res), miss = res.missing_creds || [], notes = res.notes || [], warnings = res.warnings || [];
  if (!lines.length && !miss.length && !notes.length && !warnings.length) return false;
  const html = `<div class="dlg-hd"><div class="dlg-ic">${IC.spark}</div><div><h3>${esc(title)}</h3><p>Confira os pontos abaixo antes de salvar e executar.</p></div></div>
    ${lines.length || miss.length ? `<h4 class="am-done-h">Credenciais</h4><ul class="am-done">${doneList(lines)}${miss.map(m => `<li class="warn">${IC.key}<span>O fluxo usa a credencial "${esc(m)}", que ainda não existe.</span><button class="chip" data-cred="${esc(m)}" type="button">Guardar agora</button></li>`).join('')}</ul>` : ''}
    ${notes.length ? `<h4 class="am-done-h">Falta preencher ou conferir</h4><ul class="am-warn">${notes.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${warnings.length ? `<h4 class="am-done-h">A conferência automática achou</h4><ul class="am-warn">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><span class="spacer"></span><button class="chip primary" data-close>Entendi</button></div>`;
  dialog('amGenDone', html, (box) => box.querySelectorAll('[data-cred]').forEach(b => b.onclick = guard(async () => { await credEnter(b.dataset.cred); b.closest('li').className = 'key'; b.previousElementSibling.textContent = `Credencial "${b.dataset.cred}" guardada.`; b.remove(); if (A.flow) renderInspector(); })));
  return true;
}
/** Troca o fluxo aberto pelo que a IA devolveu, num passo só do desfazer. Nó que já existia fica onde estava. */
function applyAi(flow) {
  commit();
  const old = new Map(A.flow.nodes.map(n => [n.id, n]));
  let added = 0;
  flow.nodes = flow.nodes.map(n => {
    const o = old.get(n.id);
    if (!o || o.type !== n.type) { added++; return n; }
    if (o.locked) return clone(o);
    return { ...n, position: o.position, disabled: o.disabled, locked: o.locked, ...(o.size ? { size: o.size } : {}) };
  });
  Object.assign(A.flow, { name: flow.name || A.flow.name, description: flow.description || A.flow.description || '', nodes: flow.nodes, edges: flow.edges });
  normalize(A.flow); A.sel.clear(); A.selEdge = null;
  renderAll(); changed(true);
  if (added) requestAnimationFrame(() => { arrange(false); fit(); });
}
const AI_NOTE = `<p class="am-gen-note">${IC.key}<span>Pode escrever senha ou token no pedido, de preferência entre aspas. O valor vai para o cofre do Automator e a IA recebe só o nome.</span></p>`;
const AI_STEPS = ['A IA escreve o fluxo', 'O BlueScreen confere', 'A IA corrige o que foi achado', 'Credenciais e resultado'];
/** Criar com IA: um fluxo novo a partir de uma descrição. */
function generate() {
  const EX = [
    ['Rotina com horário', 'Todo dia útil às 9h, rodar git pull na pasta do projeto e me avisar se der erro.'],
    ['Pasta vigiada', 'Quando chegar um PDF na pasta Downloads, mover para Documentos\\Notas e mostrar uma notificação.'],
    ['Site no ar', 'A cada 10 minutos, testar se https://meusite.com.br responde em menos de 2 segundos e me avisar quando falhar.'],
    ['Login e leitura', 'Entrar em https://portal.exemplo.com com o usuário ana e a senha "troque-aqui", ler o saldo da tela e me mostrar.'],
  ];
  const html = `<div class="dlg-hd"><div class="dlg-ic am-ai-ic">${IC.spark}</div><div><h3>Criar fluxo com IA</h3><p>Descreva a automação com as suas palavras. A IA monta, o BlueScreen confere e o resultado abre no quadro para você revisar antes de salvar.</p></div></div>
    <label class="fld">O que o fluxo deve fazer<textarea id="amGenReq" rows="5" placeholder="Conte quando o fluxo começa, o que ele faz e o que você quer ver no final."></textarea></label>
    <div class="am-ex-h">Ideias para começar</div>
    <div class="am-ex" id="amGenEx">${EX.map((x, i) => `<button type="button" data-ex="${i}"><b>${esc(x[0])}</b><span>${esc(x[1])}</span></button>`).join('')}</div>
    ${whoHtml('amGen')}
    ${AI_NOTE}
    <p class="am-gen-st" id="amGenSt" aria-live="polite"></p>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="amGenGo">${IC.spark}<span>Gerar fluxo</span></button></div>`;
  const box = dialog('amGen', html, () => {});
  box.querySelector('.dlg-box').classList.add('am-ai-box');
  const $ = (q) => box.querySelector(q), go = $('#amGenGo'), st = $('#amGenSt'), req = $('#amGenReq'), who = whoBind(box, 'amGen');
  box.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => { req.value = EX[+b.dataset.ex][1]; req.focus(); });
  req.focus();
  go.onclick = async () => {
    const request = req.value.trim();
    st.classList.remove('bad');
    if (!request) { st.textContent = 'Descreva o que o fluxo deve fazer.'; return req.focus(); }
    let body;
    try { body = { request, ...who() }; } catch (e) { st.textContent = 'Falta ' + e.message; return; }
    st.textContent = '';
    try {
      const res = await aiRun(box, 'automator/generate', body, AI_STEPS);
      loadCreds();
      const flow = { ...res }; for (const k of ['warnings', 'notes', 'secrets', 'missing_creds', 'rounds']) delete flow[k];
      box.hidden = true;
      if (!(await leave())) return;
      open(flow, true); requestAnimationFrame(() => { arrange(false); fit(); });
      if (!aiDone('Fluxo criado', res)) bs.toast('Fluxo criado e conferido. Veja os nós e salve.', 'ok');
    } catch (e) { st.textContent = e.message === 'cancelado' ? 'Cancelado. Nada foi criado.' : 'Não deu: ' + e.message; st.classList.toggle('bad', e.message !== 'cancelado'); }
  };
}
/** Ajustar com IA: muda o fluxo que está aberto. Fica na barra do fluxo, separado de criar um novo. */
function adjustAi() {
  if (!A.flow) return;
  if (flowLocked()) return denied();
  const f = A.flow, trig = f.nodes.find(n => n.type.startsWith('trigger.'));
  const QUICK = ['Avisar quando der erro', 'Rodar todo dia às 8h', 'Guardar o resultado num arquivo', 'Dar nomes claros aos passos'];
  const html = `<div class="dlg-hd"><div class="dlg-ic am-ai-ic">${IC.spark}</div><div><h3>Ajustar com IA</h3><p>Diga o que mudar neste fluxo. Os nós que não mudam ficam onde estão, nó trancado não é alterado e Ctrl+Z desfaz o ajuste inteiro.</p></div></div>
    <div class="am-ai-flow"><span class="am-ai-flow-ic">${IC.app}</span><div><b>${esc(f.name || 'Fluxo sem nome')}</b><small>${f.nodes.length} ${f.nodes.length === 1 ? 'nó' : 'nós'}${trig ? ' · começa por ' + esc(titleOf(trig)) : ' · sem gatilho'}${isDirty() ? ' · com alterações não salvas' : ''}</small></div></div>
    <label class="fld">O que mudar<textarea id="amAdjReq" rows="4" placeholder="Depois de baixar, mandar também uma mensagem no Slack. E trocar o horário para 8h."></textarea></label>
    <div class="am-quick" id="amAdjQuick">${QUICK.map(t => `<button type="button">${esc(t)}</button>`).join('')}</div>
    ${whoHtml('amAdj')}
    ${AI_NOTE}
    <p class="am-gen-st" id="amAdjSt" aria-live="polite"></p>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="amAdjGo">${IC.spark}<span>Ajustar fluxo</span></button></div>`;
  const box = dialog('amAdj', html, () => {});
  box.querySelector('.dlg-box').classList.add('am-ai-box');
  const $ = (q) => box.querySelector(q), go = $('#amAdjGo'), st = $('#amAdjSt'), req = $('#amAdjReq'), who = whoBind(box, 'amAdj');
  box.querySelectorAll('#amAdjQuick button').forEach(b => b.onclick = () => { const t = req.value.trim(); req.value = (t ? t.replace(/[.;]?$/, '. ') : '') + b.textContent + '.'; req.focus(); });
  req.focus();
  go.onclick = async () => {
    const request = req.value.trim();
    st.classList.remove('bad');
    if (!request) { st.textContent = 'Diga o que mudar no fluxo.'; return req.focus(); }
    let body;
    try { body = { request, ...who(), flow: { name: f.name, description: f.description || '', nodes: f.nodes, edges: f.edges } }; } catch (e) { st.textContent = 'Falta ' + e.message; return; }
    st.textContent = '';
    try {
      const res = await aiRun(box, 'automator/generate', body, ['A IA altera o fluxo', ...AI_STEPS.slice(1)]);
      loadCreds();
      const flow = { ...res }; for (const k of ['warnings', 'notes', 'secrets', 'missing_creds', 'rounds']) delete flow[k];
      box.hidden = true;
      if (A.flow !== f) return bs.toast('O fluxo aberto mudou enquanto a IA trabalhava; o ajuste não foi aplicado.', 'err');
      applyAi(flow);
      aiDone('Fluxo ajustado', res);
      bs.toast('Fluxo ajustado. Ctrl+Z desfaz.', 'ok');
    } catch (e) { st.textContent = e.message === 'cancelado' ? 'Cancelado. O fluxo ficou como estava.' : 'Não deu: ' + e.message; st.classList.toggle('bad', e.message !== 'cancelado'); }
  };
}

// ---------- script com IA: escreve ou altera o script do nó e mostra a mudança antes de aplicar ----------
function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  if (!a.trim()) return y.map(t => ['+', t]);
  if (x.length * y.length > 400000) return y.map(t => [' ', t]);
  const w = y.length + 1, dp = new Uint16Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < x.length && j < y.length) { if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]); }
  while (i < x.length) out.push(['-', x[i++]]);
  while (j < y.length) out.push(['+', y[j++]]);
  return out;
}
function scriptAi(n, f, input, set) {
  const original = input.value.replace(/\r\n/g, '\n'), fresh = !original.trim();
  const last = currentRun()?.nodes?.find(x => x.id === n.id), lastErr = last?.status === 'failed' ? String(last.error || '') : '';
  let proposal = null;
  const html = `<div class="dlg-hd"><div class="dlg-ic">${IC.spark}</div><div><h3>Script com IA</h3><p>${fresh ? 'Diga o que o script deve fazer.' : 'Diga o que mudar no script.'} Você vê a mudança antes de ela entrar no nó.</p></div></div>
    <label class="fld"><span id="amScLabel">${fresh ? 'O que o script deve fazer' : 'O que mudar'}</span><textarea id="amScReq" rows="3" placeholder="${fresh ? 'Listar os 5 maiores arquivos da pasta Downloads, com nome e tamanho em MB, em JSON.' : 'Ignorar arquivos ocultos e ordenar do maior para o menor.'}"></textarea></label>
    ${lastErr ? `<label class="am-check"><input type="checkbox" id="amScErr" checked><span>Mandar junto o erro da última execução, para a IA corrigir</span></label>` : ''}
    ${whoHtml('amSc')}
    <div id="amScOut" hidden><p class="am-sc-sum" id="amScSum"></p><ul class="am-done" id="amScSec"></ul><div class="am-diff-hd"><span id="amScCount"></span><span class="am-diff-key"><i class="add"></i>entra<i class="del"></i>sai</span></div><pre class="am-diff" id="amScDiff"></pre></div>
    <p class="am-gen-st" id="amScSt" aria-live="polite"></p>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="amScGo">${fresh ? 'Escrever' : 'Alterar'}</button><button class="chip primary" id="amScUse" hidden>Aplicar no nó</button></div>`;
  dialog('amScript', html, (box) => {
    const $ = (q) => box.querySelector(q), go = $('#amScGo'), use = $('#amScUse'), st = $('#amScSt'), req = $('#amScReq'), who = whoBind(box, 'amSc');
    req.focus();
    go.onclick = async () => {
      const request = req.value.trim();
      if (!request) { st.textContent = 'Escreva o pedido.'; return req.focus(); }
      let body;
      try { body = { type: n.type, field: f.name, script: proposal ?? original, request, input: incoming(n) ?? null, error: $('#amScErr')?.checked ? lastErr : '', ...who() }; } catch (e) { st.textContent = 'Falta ' + e.message; return; }
      go.disabled = use.disabled = true; st.textContent = '';
      try {
        const res = await aiRun(box, 'automator/script', body, ['A IA escreve o script', 'O BlueScreen confere']);
        loadCreds();
        proposal = res.script;
        const diff = lineDiff(original, proposal), plus = diff.filter(d => d[0] === '+').length, minus = diff.filter(d => d[0] === '-').length;
        $('#amScSum').textContent = res.summary || '';
        $('#amScSec').innerHTML = doneList([...secretLines(res), ...(res.missing_creds || []).map(m => ['warn', `O script usa a credencial "${m}", que ainda não existe. Guarde em Credenciais antes de executar.`])]);
        $('#amScCount').textContent = fresh ? `${plus} ${plus === 1 ? 'linha' : 'linhas'}` : `${plus} ${plus === 1 ? 'linha entra' : 'linhas entram'}, ${minus} ${minus === 1 ? 'sai' : 'saem'}`;
        $('#amScDiff').replaceChildren(...diff.map(([k, t]) => el('span' + (k === '+' ? '.add' : k === '-' ? '.del' : ''), (k === ' ' ? '  ' : k + ' ') + t + '\n')));
        $('#amScOut').hidden = false; use.hidden = false;
        go.classList.remove('primary'); go.textContent = 'Pedir outra mudança';
        $('#amScLabel').textContent = 'Quer mudar mais alguma coisa?'; req.value = ''; req.placeholder = 'Opcional: o que ajustar na proposta abaixo.';
        const e = $('#amScErr'); if (e) { e.checked = false; e.closest('label').hidden = true; }
        st.textContent = '';
      } catch (e) { st.textContent = e.message === 'cancelado' ? 'Cancelado.' : 'Não deu: ' + e.message; } finally { go.disabled = use.disabled = false; }
    };
    use.onclick = () => {
      if (proposal == null || !node(n.id)) return;
      input.value = proposal; set(proposal); box.hidden = true; renderInspector();
      bs.toast('Script aplicado. Ctrl+Z desfaz; execute o fluxo para testar.', 'ok');
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
      <div class="am-side-row am-search-row"><input class="am-search" type="search" placeholder="Buscar fluxo ou pasta" aria-label="Buscar fluxo ou pasta" spellcheck="false"><button class="icon-btn" data-a="folder" type="button" title="Nova pasta">${IC.folderPlus}</button><button class="icon-btn" data-a="listmenu" type="button" title="Organizar a lista: recolher, expandir, ordenar">${IC.list}</button></div>
      <div class="am-list"></div>
      <button class="am-creds-btn" data-a="creds" type="button" title="Senhas e tokens que os fluxos usam sem mostrar">${IC.key}<span>Credenciais</span><small></small></button>
    </aside>
    <div class="am-main">
      <div class="am-bar">
        <input class="am-name" type="text" placeholder="Nome do fluxo" aria-label="Nome do fluxo" spellcheck="false" maxlength="120">
        <i class="am-dirty" hidden title="Alterações não salvas"></i>
        <span class="am-sp"></span>
        <label class="am-sched" hidden title="Ligado, o fluxo roda sozinho (na hora marcada, ao abrir o BlueScreen, quando o arquivo mudar ou quando chamam o endpoint) enquanto o BlueScreen estiver aberto, inclusive na bandeja"><input type="checkbox" class="am-active"><span class="am-switch"></span><span>Ligado</span><small class="am-next"></small></label>
        <button class="chip am-aibtn" data-a="aiedit" type="button" title="Dizer à IA o que mudar neste fluxo">${IC.spark}<span>Ajustar com IA</span></button>
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
    lockbtn: $('[data-a=lock]'), credsBtn: $('.am-creds-btn small'), undo: $('[data-a=undo]'), redo: $('[data-a=redo]'), save: $('.am-save'), run: $('.am-runbtn'), stage: $('.am-stage'), cv: $('.am-cv'), world: $('.am-world'), svg: $('.am-wires'), nodes: $('.am-nodes'),
    marquee: $('.am-marquee'), empty: $('.am-empty'), zoom: $('.am-zval'), insp: $('.am-insp'), file: $('.am-file') };
  R.ghost = document.createElementNS(SVGNS, 'path'); R.ghost.classList.add('am-wire', 'ghost'); R.svg.append(R.ghost);

  const acts = {
    new: () => create(() => blank()),
    tpl: (e) => bs.showMenu(e, TEMPLATES.filter(t => !t.need || spec(t.need)).map(t => ({ label: t.label, k: t.hint, action: () => create(t.make) }))),
    ai: generate, aiedit: adjustAi, folder: () => newFolder(), listmenu: listMenu, creds: () => credsDialog(), save: guard(save), run, lock: () => toggleLock(),
    undo: () => travel(A.undo, A.redo), redo: () => travel(A.redo, A.undo),
    tidy: () => { arrange(); fit(); }, fit, zin: () => zoomBy(1.25), zout: () => zoomBy(0.8), z100: () => zoomBy(1 / A.cam.z),
    add: (e) => { const r = e.currentTarget.getBoundingClientRect(); openPicker(r.left, r.bottom + 6, (s) => addNode(s.type)); },
    more: (e) => bs.showMenu(e, [
      { label: (A.autoSave ? '✓ ' : '') + 'Salvar sozinho a cada alteração', action: toggleAutoSave },
      '-',
      { label: 'Importar fluxo ou fluxos…', action: () => R.file.click() },
      { label: 'Exportar todos os fluxos…', action: () => exportFlows() },
      ...(A.flow && !flowLocked() ? [{ label: 'Ajustar com IA…', icon: IC.spark, action: adjustAi }] : []),
      { label: 'Agentes de IA…', icon: IC.spark, action: () => bs.aiClis.open() },
      ...(A.flow ? [{ label: 'Exportar fluxo…', action: () => exportFlow() }, { label: 'Duplicar fluxo', icon: IC.copy, action: () => { const f = clone(A.flow); create(() => ({ ...f, id: '', active: false, next_run: null, name: f.name + ' (cópia)' })); } }, '-', { label: 'Excluir fluxo…', icon: IC.trash, action: guard(() => flowLocked() ? denied() : removeFlow()) }] : [])]),
  };
  // a lista de fluxos mora no painel da esquerda da IDE (no lugar do painel de arquivos), fora da aba
  R.side.remove();
  loadCreds();
  bs.api('automator/settings', {}, { quiet: true }).then(v => { A.keepRuns = v.keep_runs || 100; A.folderColors = v.folder_colors || {}; paintList(); }).catch(() => {});
  const onClick = (e) => {
    const b = e.target.closest('[data-a]');
    if (b && acts[b.dataset.a]) { const r = b.getBoundingClientRect(); acts[b.dataset.a]({ currentTarget: b, target: b, clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }); return; }
    const plus = e.target.closest('.am-plus');
    if (plus) { const id = plus.closest('.am-node').dataset.id, r = plus.getBoundingClientRect(), n = node(id); openPicker(r.right + 8, r.top - 12, (s) => addNode(s.type, [n.position[0] + widthOf(n) + 60, n.position[1]], { node: id, port: plus.dataset.plus, dir: 'out' }), 'inputs'); }
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
    const grip = e.target.closest('.am-grip');
    if (grip && A.flow) { const n = node(grip.closest('.am-node').dataset.id); if (!n || !n.size) return; if (nodeLocked(n.id)) return denied(flowLocked() ? '' : 'node'); commit(); delete n.size; refreshNode(n.id); changed(); return; }
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
