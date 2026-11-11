/* BlueScreen: depurador, pelo Debug Adapter Protocol (o mesmo do VS Code). O BlueScreen não depura sozinho: ele
   conduz o depurador oficial de cada linguagem (debugpy, Delve, lldb-dap, CodeLLDB, netcoredbg, java-debug, js-debug,
   rdbg), aberto pelo núcleo e ligado por WebSocket (/api/rpc/ws), como o servidor de linguagem.
   Atalhos do IntelliJ: clique na margem ou Ctrl+F8 marca breakpoint (botão direito: condição, desativar), Shift+F9
   depura o arquivo aberto, F9 continua, F8 passa por cima, F7 entra, Shift+F8 sai, Alt+F9 roda até o cursor, Ctrl+F2 para.
   Modo de depuração: barra flutuante sobre o editor, linha atual destacada, valores das variáveis escritos no fim das
   linhas (como o IntelliJ), e o painel embaixo com pilha (frames de bibliotecas recolhidos), breakpoints, exceções,
   variáveis (cor por tipo, o que mudou desde a última parada pisca), expressões vigiadas e console que avalia no frame.
   Código que não está no projeto (o JDK, node:internal...) abre numa aba só de leitura, pedido ao depurador ou ao jdtls.
   Expõe bs.debug: start(tab), stop(), session(). */
(function (bs) {

const DB = { s: null, all: [], bps: new Map(), decos: new Map(), cur: null, frames: [], frameId: null, vars: new Map(), open: new Set(), prev: new Map(), seen: new Map(),
  watches: store.get('dbWatch', []), hist: store.get('dbHist', []), hi: -1, temp: null, src: new Map(), libOpen: false, inline: [], threads: [] };
const BUG = '<svg class="i" viewBox="0 0 24 24"><path d="M8 8a4 4 0 0 1 8 0v1H8z"/><rect x="7" y="9" width="10" height="11" rx="5"/><path d="M12 13v7M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 20l3-2M20 20l-3-2"/></svg>';
const srcName = (src) => { if (!src) return ''; if (src.name) return src.name; const p = decodeURIComponent(src.path || ''); const c = p.match(/([\w$]+)\.class\b/); return c ? c[1] + '.java' : p.split(/[\\/]/).pop(); };
const IC = {
  go: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  over: '<svg class="i" viewBox="0 0 24 24"><path d="M4 14a8 8 0 0 1 15-4"/><path d="M19 5v5h-5"/><circle cx="12" cy="19" r="1.6"/></svg>',
  into: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3v11M7 9l5 5 5-5"/><circle cx="12" cy="19.5" r="1.6"/></svg>',
  out: '<svg class="i" viewBox="0 0 24 24"><path d="M12 15V4M7 9l5-5 5 5"/><circle cx="12" cy="19.5" r="1.6"/></svg>',
  cursor: '<svg class="i" viewBox="0 0 24 24"><path d="M4 12h11M11 7l5 5-5 5"/><path d="M20 5v14"/></svg>',
  stop: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  again: '<svg class="i" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8"/><path d="M20 3v5h-5"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  grip: '<svg class="i" viewBox="0 0 24 24"><circle cx="9" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="17" r="1.2"/><circle cx="15" cy="17" r="1.2"/></svg>',
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clear: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg>',
};
// controles: os mesmos na barra flutuante e no cabeçalho do painel (data-db)
const CTRL = [['go', 'Continuar', 'F9'], ['pause', 'Pausar', ''], ['over', 'Passar por cima', 'F8'], ['into', 'Entrar', 'F7'], ['out', 'Sair', 'Shift+F8'], ['cursor', 'Rodar até o cursor', 'Alt+F9'], ['again', 'Depurar de novo', 'Shift+F9'], ['stop', 'Parar', 'Ctrl+F2']];
const ctrls = (only) => CTRL.filter(c => !only || only.includes(c[0])).map(([id, t, k]) => `<button class="icon-btn dbc-${id}" data-db="${id}" title="${t}${k ? ' (' + k + ')' : ''}">${IC[id]}</button>`).join('');

bs.ui.panel(`<div id="dbgCon" hidden>
  <div id="dbResize" title="Arraste para ajustar a altura"></div>
  <div class="head"><span class="db-badge" id="dbBadge"><i></i><span id="dbState">parado</span></span><span class="db-where" id="dbWhere"></span><span class="spacer"></span>
    ${ctrls()}<span class="db-sep"></span>
    <button class="icon-btn" id="dbHide" title="Esconder"><svg class="i" viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button></div>
  <div class="db-body">
    <section class="db-col db-side">
      <div class="db-sec open" data-sec="frames"><h4><span class="ar"></span>Pilha<select id="dbThread" title="Thread" hidden></select></h4><div class="db-list" id="dbFrames"></div></div>
      <div class="db-sec open" data-sec="bps"><h4><span class="ar"></span>Breakpoints<span class="db-n" id="dbBpN"></span></h4><div class="db-list" id="dbBps"></div></div>
      <div class="db-sec" data-sec="exc"><h4><span class="ar"></span>Parar em exceções</h4><div class="db-list" id="dbExc"></div></div>
    </section>
    <section class="db-col"><h4>Variáveis<span class="spacer"></span><button class="db-mini" id="dbWatchAdd" title="Vigiar uma expressão em toda parada">${IC.eye}vigiar</button></h4><div class="db-list" id="dbVars"></div></section>
    <section class="db-col db-con"><h4>Console<span class="spacer"></span><button class="db-mini" id="dbClear" title="Limpar o console">${IC.clear}limpar</button></h4><div class="db-out" id="dbOut2"></div>
      <label class="db-repl"><span>›</span><input id="dbEval" placeholder="Avaliar no frame escolhido  (↑↓ histórico)" spellcheck="false" autocomplete="off"></label></section>
  </div>
</div>`);
// barra flutuante sobre o editor, só durante a sessão (arrastável pela alça)
document.getElementById('mon').insertAdjacentHTML('beforeend', `<div id="dbBar" hidden><span class="db-grip" title="Arraste para mover">${IC.grip}</span><span class="db-badge" id="dbBarBadge"><i></i><span id="dbBarState"></span></span>${ctrls(['go', 'pause', 'over', 'into', 'out', 'cursor', 'again', 'stop'])}</div>`);

// ----- caminhos -----
const absOf = (t) => t.project.replace(/[\\/]+$/, '') + '\\' + t.path.replace(/\//g, '\\');
const keyOf = (abs) => abs.replace(/\//g, '\\').toLowerCase();
const isDisk = (p) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p || '');
const relOf = (abs) => { if (!S.project || !isDisk(abs)) return null; const r = S.project.path.replace(/[\\/]+$/, '') + '\\'; return keyOf(abs).startsWith(keyOf(r)) ? abs.slice(r.length).replace(/\\/g, '/') : null; };
const tabFor = (abs) => S.tabs.find(t => t.mode === 'editor' && !t.virtual && keyOf(absOf(t)) === keyOf(abs));
const inProject = (f) => !!(f && f.source && f.source.path && relOf(f.source.path) != null);

// ----- breakpoints: guardados por projeto, desenhados na margem e levados junto quando o código muda de linha -----
const bpKey = () => 'bp:' + (S.project ? S.project.path : '');
function bpLoad() { DB.bps = new Map(); const o = store.get(bpKey(), {}); for (const [rel, list] of Object.entries(o)) DB.bps.set(rel, new Map(list.map(b => [b.line, b]))); renderBps(); }
function bpSave() { const o = {}; for (const [rel, m] of DB.bps) if (m.size) o[rel] = [...m.values()].map(({ verified, ...b }) => b); store.set(bpKey(), o); renderBps(); }
const bpsOf = (rel) => { if (!DB.bps.has(rel)) DB.bps.set(rel, new Map()); return DB.bps.get(rel); };
function bpPaint(tab) {
  if (!tab || tab.mode !== 'editor' || tab.virtual || !tab.model || tab.model.isDisposed()) return;
  const list = [...bpsOf(tab.path).values()];
  const decos = list.map(b => { const dis = b.enabled === false, off = !dis && b.verified === false; return { range: new monaco.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: 'bp-dot' + (b.condition ? ' cond' : '') + (off ? ' off' : '') + (dis ? ' dis' : ''), isWholeLine: true, className: dis || off ? undefined : 'bp-line',
    glyphMarginHoverMessage: { value: (dis ? 'Breakpoint desativado' : b.condition ? 'Breakpoint com condição: `' + b.condition + '`' : 'Breakpoint') + (off ? ' (o depurador não achou código nesta linha)' : '') + '\n\nClique remove · botão direito: condição, desativar' }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }; });
  DB.decos.set(tab.model.id, tab.model.deltaDecorations(DB.decos.get(tab.model.id) || [], decos));
}
// edições movem as decorações; as linhas dos breakpoints acompanham
function bpTrack(tab) {
  const ids = DB.decos.get(tab.model.id); if (!ids || !ids.length) return;
  const m = bpsOf(tab.path); const old = [...m.values()]; const next = new Map();
  ids.forEach((id, i) => { const r = tab.model.getDecorationRange(id); const b = old[i]; if (r && b) next.set(r.startLineNumber, { ...b, line: r.startLineNumber }); });
  DB.bps.set(tab.path, next); bpSave();
}
function bpToggle(tab, line, opts) {
  if (tab.virtual) { toast('Breakpoints ficam nos arquivos do projeto'); return; }
  const m = bpsOf(tab.path);
  if (m.has(line) && !opts) m.delete(line); else m.set(line, { line, ...(m.get(line) || {}), ...(opts || {}) });
  bpSave(); bpPaint(tab); bpSync(tab.path);
}
function bpCondition(tab, line) {
  const b = bpsOf(tab.path).get(line) || {};
  dialog('bpDlg', `<div class="dlg-hd"><span class="dlg-ic">${BUG}</span><div><h3>Condição do breakpoint</h3><p>Pausa na linha ${line} só quando a expressão for verdadeira. Vazio pausa sempre.</p></div></div>
    <label class="fld">Condição<input id="bpIn" spellcheck="false" autocomplete="off" value="${esc(b.condition || '')}" placeholder="i == 2"></label>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="bpOk">Salvar</button></div>`, (el) => {
    const go = () => { el.hidden = true; bpToggle(tab, line, { condition: $('#bpIn').value.trim() || undefined }); };
    $('#bpOk').onclick = go; $('#bpIn').onkeydown = (e) => { if (e.key === 'Enter') go(); }; $('#bpIn').focus();
  });
}
const absIn = (rel) => S.project.path.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\');
// com a sessão aberta, breakpoint novo vale na hora (desativados ficam de fora; "rodar até o cursor" entra junto)
async function bpSync(rel) {
  const s = DB.s; if (!s || !s.ready || !S.project) return;
  const list = [...bpsOf(rel).values()].filter(b => b.enabled !== false);
  const send = list.map(b => ({ line: b.line, condition: b.condition }));
  if (DB.temp && DB.temp.rel === rel && !list.some(b => b.line === DB.temp.line)) send.push({ line: DB.temp.line });
  const abs = absIn(rel);
  try {
    const r = await s.req('setBreakpoints', { source: { path: abs, name: rel.split('/').pop() }, breakpoints: send, sourceModified: false });
    (r.breakpoints || []).forEach((v, i) => { if (list[i]) list[i].verified = v.verified; });
    const t = tabFor(abs); if (t) bpPaint(t); renderBps();
  } catch {}
}
function renderBps() {
  const el = $('#dbBps'); if (!el) return;
  const all = [...DB.bps].flatMap(([rel, m]) => [...m.values()].map(b => ({ rel, b }))).sort((x, y) => x.rel.localeCompare(y.rel) || x.b.line - y.b.line);
  $('#dbBpN').textContent = all.length ? all.length : '';
  el.innerHTML = all.map(({ rel, b }, i) => `<div class="db-row bp ${b.enabled === false ? 'dis' : ''}" data-i="${i}" title="${esc(rel)}:${b.line}"><input type="checkbox" ${b.enabled === false ? '' : 'checked'} title="Ativo"><span class="bp-mini ${b.condition ? 'cond' : ''} ${b.verified === false ? 'off' : ''}"></span><b>${esc(rel.split('/').pop())}</b><span class="ln">:${b.line}</span>${b.condition ? `<span class="cd">${esc(b.condition)}</span>` : ''}<button class="db-x" title="Remover">${IC.x}</button></div>`).join('')
    || '<div class="db-empty">Clique na margem do editor (ou Ctrl+F8) para marcar.</div>';
  el.querySelectorAll('.bp').forEach(r => { const { rel, b } = all[+r.dataset.i];
    r.onclick = (e) => { if (e.target.closest('input,.db-x')) return; openFile(rel, 'editor', b.line); };
    r.querySelector('input').onchange = (e) => { b.enabled = e.target.checked ? undefined : false; bpSave(); const t = tabFor(absIn(rel)); if (t) bpPaint(t); bpSync(rel); };
    r.querySelector('.db-x').onclick = () => { bpsOf(rel).delete(b.line); bpSave(); const t = tabFor(absIn(rel)); if (t) bpPaint(t); bpSync(rel); };
  });
}

// ----- sessão DAP -----
class DapSession extends bs.lsp.RpcClient {
  constructor(tool, root) { super(tool, root); this.seq = 0; this.waiters = new Map(); this.events = {}; }
  req(command, args, ms = 30000) {
    const seq = ++this.seq; this.send({ seq, type: 'request', command, arguments: args });
    return new Promise((ok, fail) => { const t = setTimeout(() => { this.waiters.delete(seq); fail(new Error(command + ': sem resposta')); }, ms); this.waiters.set(seq, { ok: (b) => { clearTimeout(t); ok(b); }, fail: (e) => { clearTimeout(t); fail(e); } }); });
  }
  receive(m) {
    if (m.type === 'response') { const w = this.waiters.get(m.request_seq); if (!w) return; this.waiters.delete(m.request_seq); m.success ? w.ok(m.body || {}) : w.fail(new Error((m.body && m.body.error && m.body.error.format) || m.message || m.command)); return; }
    if (m.type === 'event') { const h = this.events[m.event]; h && h(m.body || {}); return; }
    // o js-debug abre uma sessão filha para cada processo (startDebugging): outra conexão na mesma porta
    if (m.type === 'request' && m.command === 'startDebugging' && this.onStartDebugging) { this.send({ seq: ++this.seq, type: 'response', request_seq: m.seq, command: m.command, success: true }); this.onStartDebugging(m.arguments || {}); return; }
    // outros pedidos do adaptador (runInTerminal): não suportados
    if (m.type === 'request') this.send({ seq: ++this.seq, type: 'response', request_seq: m.seq, command: m.command, success: false, message: 'não suportado pelo BlueScreen' });
  }
}

// configuração de "depurar este arquivo" para cada adaptador
async function launchArgs(tool, tab) {
  const abs = absOf(tab); const root = tab.project; const dir = abs.replace(/[\\/][^\\/]*$/, '');
  switch (tool.id) {
    case 'debugpy': return { type: 'python', request: 'launch', name: tab.path, program: abs, cwd: root, console: 'internalConsole', justMyCode: true, redirectOutput: true };
    case 'delve': return { request: 'launch', mode: 'debug', program: dir, cwd: root };
    case 'js-debug': return { type: 'pwa-node', request: 'launch', name: tab.path, program: abs, cwd: root, console: 'internalConsole', outputCapture: 'std', skipFiles: ['<node_internals>/**'] };
    // Java e Ruby depuram o programa rodando no console do Build: quem prepara é o plugin Runtimes
    case 'java-debug': case 'rdbg': toast('Para depurar ' + tab.lang + ', ative o plugin Runtimes (ele roda o programa com o depurador)'); return null;
    default: {
      // C, C++, Rust e .NET depuram o programa compilado: pergunta qual (e lembra)
      const k = 'dbgProgram:' + root; const guess = store.get(k, '') || (tool.id === 'netcoredbg' ? root + '\\bin\\Debug\\' : root + '\\target\\debug\\' + root.split(/[\\/]/).pop() + '.exe');
      const program = await new Promise((ok) => dialog('dbgProg', `<div class="dlg-hd"><span class="dlg-ic">${BUG}</span><div><h3>Programa a depurar</h3><p>${tool.id === 'netcoredbg' ? 'A .dll compilada do projeto (dotnet build gera em bin\\Debug).' : 'O executável compilado com símbolos de depuração (cargo build, cmake, make).'}</p></div></div>
        <label class="fld">Programa<input id="dpIn" spellcheck="false" autocomplete="off" value="${esc(guess)}"></label>
        <label class="fld">Argumentos<input id="dpArgs" spellcheck="false" autocomplete="off" value="${esc(store.get(k + ':args', ''))}"></label>
        <div class="actions"><button class="chip" data-close id="dpNo">Cancelar</button><button class="chip primary" id="dpOk">Depurar</button></div>`, (el) => {
        const go = () => { el.hidden = true; store.set(k, $('#dpIn').value.trim()); store.set(k + ':args', $('#dpArgs').value); ok($('#dpIn').value.trim()); };
        $('#dpOk').onclick = go; $('#dpNo').addEventListener('click', () => ok(null)); $('#dpIn').onkeydown = (e) => { if (e.key === 'Enter') go(); }; $('#dpIn').focus();
      }));
      if (!program) return null;
      const args = (store.get(k + ':args', '') || '').match(/"[^"]*"|\S+/g) || [];
      return tool.id === 'codelldb' ? { type: 'lldb', request: 'launch', program, args, cwd: root } : { request: 'launch', program, args, cwd: root, stopAtEntry: false };
    }
  }
}

// linguagens com um jeito próprio de depurar (o plugin Runtimes compila e roda o main com o agente de depuração):
// launchers[lang](tab) devolve false quando não cuida do arquivo, e aí vale o caminho de sempre
const launchers = {};
// depurador instalado (pelo id, ou o primeiro que atende a linguagem); sem ele, oferece instalar e devolve null
async function need(idOrLang) {
  const tools = await bs.lsp.tools();
  const cands = tools.filter(t => t.kind === 'dap' && (t.id === idOrLang || t.langs.includes(idOrLang)));
  const ok = cands.find(t => t.installed); if (ok) return ok;
  if (!cands.length) { toast('Ainda não há depurador para ' + idOrLang); return null; }
  const e = { clientX: innerWidth / 2 - 150, clientY: innerHeight / 3, preventDefault() {}, stopPropagation() {} };
  showMenu(e, cands.map(t => ({ label: 'Instalar ' + t.name, icon: BUG, action: () => {
    if (t.needs) return toast(t.name + ': ' + t.needs);
    if (t.auto && bs.lsp.install) return bs.lsp.install(t); // a IDE baixa sozinha, com progresso
    const c = t.install.split('  (')[0]; if (bs.terminal && /^(pip|go|winget|scoop|npm|dotnet|gem) /.test(c)) { bs.terminal.run(c); toast('Depois de instalar, use Shift+F9 de novo'); bs.lsp.tools(true); } else { copyText(t.install); toast(t.install); }
  } })), 'Sem depurador para ' + idOrLang);
  return null;
}
// o: { tool (id), args (do launch/attach), request, params (ex.: { port }), title }: vem dos lançadores
async function start(tab = S.active, o) {
  if (!tab || tab.mode !== 'editor' || tab.virtual) { toast('Abra o arquivo que quer depurar'); return; }
  if (!o && launchers[tab.lang]) { if (await launchers[tab.lang](tab) !== false) return; }
  if (DB.s) await stop(true);
  const tool = await need(o && o.tool || tab.lang); if (!tool) return;
  if (tab.dirty) await save();
  const args = o && o.args || await launchArgs(tool, tab); if (!args) return;
  DB.last = tab; DB.prev = new Map(); DB.src = new Map(); DB.t0 = Date.now();
  const s = DB.s = new DapSession(tool, tab.project); s.params = o && o.params; DB.all = [s];
  show(true); clearOut(); out(`${o && o.title || 'Depurando ' + tab.path} com ${tool.name}`, 'bs'); state('iniciando', 'busy');
  wire(s);
  try {
    const ready = await s.connect();
    // sessões filhas conectam na porta que a ponte abriu para esta
    s.onStartDebugging = (x) => child(s, tool, (s.params && s.params.port) || ready.port, x);
    await handshake(s, tool, (o && o.request) || args.request || 'launch', args);
    if (DB.s === s && !DB.cur) state('rodando', 'run');
  } catch (e) { out(e.message, 'stderr'); if (DB.s === s) end(); }
}
function wire(s) {
  s.events.output = (b) => { if (b.category !== 'telemetry') out(b.output, b.category); };
  s.events.stopped = (b) => { if (DB.s === s) onStopped(b); };
  s.events.continued = () => { if (DB.s === s) onContinued(); };
  s.events.terminated = () => { if (DB.s === s || DB.all[0] === s) end(); };
  s.events.exited = (b) => out(`Processo terminou com código ${b.exitCode}`, b.exitCode ? 'stderr' : 'bs');
  s.events.breakpoint = (b) => { const bp = b.breakpoint; if (!bp || !bp.source || !bp.source.path) return; const rel = relOf(bp.source.path); if (rel == null) return; const m = bpsOf(rel); const x = m.get(bp.line); if (x) { x.verified = bp.verified; const t = tabFor(bp.source.path); if (t) bpPaint(t); renderBps(); } };
  s.onclose = () => { if (DB.s === s || DB.all[0] === s) end(); };
}
// exceções: os filtros que o depurador oferece ("todas", "não tratadas"...), escolhidos por depurador
const excKey = (s) => 'dbExc:' + ((s && s.tool && s.tool.id) || '');
const excOn = (s) => { const f = (s.caps && s.caps.exceptionBreakpointFilters) || []; const saved = store.get(excKey(s), null); return saved || f.filter(x => x.default).map(x => x.filter); };
async function excSync(s = DB.s) { if (!s || !s.ready || !s.caps || !(s.caps.exceptionBreakpointFilters || []).length) return; try { await s.req('setExceptionBreakpoints', { filters: excOn(s) }); } catch {} }
function renderExc() {
  const s = DB.all[0], el = $('#dbExc'), f = (s && s.caps && s.caps.exceptionBreakpointFilters) || [];
  if (!f.length) { el.innerHTML = `<div class="db-empty">${s ? 'Este depurador não oferece filtros de exceção.' : 'As opções aparecem quando a depuração começa.'}</div>`; return; }
  const on = excOn(s);
  el.innerHTML = f.map(x => `<label class="db-row ex" title="${esc(x.description || x.label)}"><input type="checkbox" value="${esc(x.filter)}" ${on.includes(x.filter) ? 'checked' : ''}><span>${esc(x.label)}</span></label>`).join('');
  el.querySelectorAll('input').forEach(i => i.onchange = () => { store.set(excKey(s), [...el.querySelectorAll('input:checked')].map(x => x.value)); DB.all.forEach(excSync); });
}
async function handshake(s, tool, request, args) {
  s.tool = tool;
  const initialized = new Promise((ok) => { s.events.initialized = ok; });
  s.caps = await s.req('initialize', { clientID: 'bluescreen', clientName: 'BlueScreen', adapterID: tool.id, locale: 'pt-BR', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: true, supportsProgressReporting: false, supportsInvalidatedEvent: false });
  // launch/attach só responde depois do configurationDone: os breakpoints vão no meio
  const launched = s.req(request, args, 120000);
  await Promise.race([initialized, launched]);
  s.ready = true;
  for (const rel of DB.bps.keys()) await bpSync(rel);
  if ((s.caps.exceptionBreakpointFilters || []).length) await excSync(s); else { try { await s.req('setExceptionBreakpoints', { filters: [] }); } catch {} }
  if (s === DB.all[0]) renderExc();
  if (s.caps.supportsConfigurationDoneRequest !== false) await s.req('configurationDone', {});
  await launched;
}
// sessão filha (no js-debug, o processo do Node de verdade): passa a ser a sessão atual
async function child(parent, tool, port, a) {
  const c = new DapSession(tool, parent.root); c.params = { port }; DB.all.push(c);
  DB.s = c; wire(c); c.onStartDebugging = (x) => child(c, tool, port, x);
  try { await c.connect(); await handshake(c, tool, a.request || 'launch', a.configuration || {}); if (DB.s === c && !DB.cur) state('rodando', 'run'); }
  catch (e) { out(e.message, 'stderr'); }
}
async function stop(quiet) {
  if (!DB.s) return;
  // da filha mais nova para a sessão principal
  for (const s of [...DB.all].reverse()) {
    if (!s.alive) continue;
    try { await s.req(s.caps && s.caps.supportsTerminateRequest ? 'terminate' : 'disconnect', { terminateDebuggee: true }, 3000); } catch {}
    try { await s.req('disconnect', { terminateDebuggee: true }, 2000); } catch {}
    s.close();
  }
  if (!quiet) end();
}
function end() {
  if (!DB.s) return; DB.s = null; DB.cur = null; DB.temp = null; const all = DB.all; DB.all = []; all.forEach(s => s.close()); clearPaused();
  const secs = DB.t0 ? Math.round((Date.now() - DB.t0) / 100) / 10 : 0;
  state('encerrado', 'end'); $('#dbWhere').textContent = secs ? `em ${String(secs).replace('.', ',')} s` : '';
  $('#dbFrames').innerHTML = '<div class="db-empty">A sessão terminou. Shift+F9 depura de novo.</div>'; $('#dbVars').innerHTML = ''; $('#dbThread').hidden = true;
  renderExc(); buttons();
}
const step = (cmd) => { const s = DB.s; if (!s || !DB.cur) return false; s.req(cmd, { threadId: DB.cur.threadId }).catch(e => out(e.message, 'stderr')); onContinued(); };
// rodar até o cursor: um breakpoint de uma vez só na linha do cursor
function runToCursor() {
  const t = S.active; if (!DB.s || !DB.cur || !t || t.mode !== 'editor' || t.virtual) return false;
  DB.temp = { rel: t.path, line: editor.getPosition().lineNumber };
  bpSync(t.path).then(() => step('continue'));
}

// ----- pausado: pilha, variáveis e a linha no editor -----
async function onStopped(b) {
  const s = DB.s; if (!s) return;
  if (DB.temp) { const t = DB.temp; DB.temp = null; bpSync(t.rel); }
  let threadId = b.threadId;
  try { const t = await s.req('threads', {}); DB.threads = t.threads || []; } catch { DB.threads = []; }
  if (!threadId) threadId = DB.threads[0] && DB.threads[0].id;
  DB.cur = { threadId, reason: b.reason, text: b.text || b.description };
  await loadFrames(threadId);
}
async function loadFrames(threadId) {
  const s = DB.s; if (!s) return;
  DB.cur.threadId = threadId;
  let st; try { st = await s.req('stackTrace', { threadId, startFrame: 0, levels: 80 }); } catch (e) { out(e.message, 'stderr'); return; }
  DB.frames = st.stackFrames || [];
  const why = { breakpoint: 'breakpoint', step: 'passo', exception: 'exceção', pause: 'pausa', entry: 'início', goto: 'cursor', 'function breakpoint': 'breakpoint', 'data breakpoint': 'dado alterado' }[DB.cur.reason] || DB.cur.reason;
  const f0 = DB.frames[0];
  state('pausado · ' + why, DB.cur.reason === 'exception' ? 'exc' : 'pause');
  $('#dbWhere').textContent = f0 ? `${f0.name}  ·  ${srcName(f0.source)}${f0.line ? ':' + f0.line : ''}` : '';
  if (DB.cur.reason === 'exception' && DB.cur.text) out('⚠ ' + DB.cur.text, 'stderr');
  const th = $('#dbThread');
  th.hidden = DB.threads.length < 2;
  th.innerHTML = DB.threads.map(t => `<option value="${t.id}" ${t.id === threadId ? 'selected' : ''}>${esc(t.name || 'thread ' + t.id)}</option>`).join('');
  renderFrames(); buttons();
  // para no código do usuário: o primeiro frame do projeto quando o de cima é de biblioteca sem código
  if (f0) await selectFrame(f0);
}
function onContinued() { DB.cur = null; clearPaused(); state('rodando', 'run'); $('#dbWhere').textContent = ''; $('#dbVars').innerHTML = '<div class="db-empty">Rodando…</div>'; renderFrames(); buttons(); }
// pilha: frames de bibliotecas seguidos viram uma linha "N frames de bibliotecas" (abre com um clique)
function renderFrames() {
  const el = $('#dbFrames');
  if (!DB.cur) { el.innerHTML = DB.s ? '<div class="db-empty"><span class="db-spin"></span>Rodando… pausa num breakpoint, numa exceção ou no botão Pausar.</div>' : el.innerHTML; return; }
  const rows = []; let lib = [];
  const row = (f, i) => `<div class="db-row fr ${f.id === DB.frameId ? 'on' : ''} ${inProject(f) ? '' : 'ext'} ${f.presentationHint === 'subtle' ? 'subtle' : ''}" data-i="${i}" title="${esc(f.source && f.source.path || '')}"><span class="fi">${i === 0 ? '▶' : ''}</span><b>${esc(f.name)}</b><span class="loc">${esc(f.source ? srcName(f.source) + (f.line ? ':' + f.line : '') : '')}</span></div>`;
  const flush = () => { if (!lib.length) return; if (DB.libOpen || lib.length < 2 || lib.some(([f]) => f.id === DB.frameId)) lib.forEach(([f, i]) => rows.push(row(f, i))); else rows.push(`<div class="db-row lib" title="Frames sem código do projeto (bibliotecas, JDK, runtime)"><span class="fi">⋯</span>${lib.length} frames de bibliotecas</div>`); lib = []; };
  DB.frames.forEach((f, i) => { if (i > 0 && !inProject(f)) lib.push([f, i]); else { flush(); rows.push(row(f, i)); } });
  flush();
  el.innerHTML = rows.join('') || '<div class="db-empty">Sem frames.</div>';
  el.querySelectorAll('.fr').forEach(r => r.onclick = () => selectFrame(DB.frames[+r.dataset.i]));
  el.querySelectorAll('.lib').forEach(r => r.onclick = () => { DB.libOpen = true; renderFrames(); });
}
async function selectFrame(f) {
  const s = DB.s; if (!s) return;
  DB.frameId = f.id; DB.frame = f; renderFrames();
  await showLine(f);
  DB.vars = new Map(); DB.open = new Set([...DB.open].filter(k => typeof k === 'string'));
  try {
    const sc = await s.req('scopes', { frameId: f.id });
    DB.scopes = sc.scopes || [];
    // escopos locais já abertos, os globais fechados (como no IntelliJ)
    for (const x of DB.scopes) if (!x.expensive && !/global/i.test(x.name)) DB.open.add(x.variablesReference);
    await renderVars();
    inlineValues(f);
  } catch (e) { $('#dbVars').innerHTML = `<div class="db-empty">${esc(e.message)}</div>`; }
}
async function children(ref) {
  if (DB.vars.has(ref)) return DB.vars.get(ref);
  let v = []; try { v = (await DB.s.req('variables', { variablesReference: ref })).variables || []; } catch {}
  DB.vars.set(ref, v); return v;
}
// cor do valor pelo que ele é: texto, número, true/false/null, objeto
function kindOf(v) {
  const s = String(v.value == null ? '' : v.value), t = String(v.type || '').toLowerCase();
  if (/^(["'`]).*\1$/s.test(s) || /^(str|string|char|java\.lang\.string|&str)$/.test(t)) return 'str';
  if (/^-?(\d[\d_]*\.?\d*(e[+-]?\d+)?|0x[\da-f]+)[fdlu]?$/i.test(s)) return 'num';
  if (/^(true|false|null|nil|none|undefined|nullptr|nan)$/i.test(s)) return 'kw';
  return v.variablesReference ? 'obj' : '';
}
// variáveis em árvore; o que mudou desde a última parada fica marcado (chave: caminho de nomes)
async function renderVars() {
  if (!DB.s || !DB.cur) return;
  const rows = [], now = new Map();
  // expressões vigiadas: no topo, avaliadas no frame escolhido
  for (let i = 0; i < DB.watches.length; i++) {
    const w = DB.watches[i]; let r;
    try { r = await DB.s.req('evaluate', { expression: w, frameId: DB.frameId || undefined, context: 'watch' }, 5000); } catch (e) { r = { result: e.message, err: true }; }
    const v = { name: w, value: r.result, type: r.type, variablesReference: r.variablesReference || 0 };
    const key = 'w:' + w, open = v.variablesReference && DB.open.has(key);
    rows.push(varRow(v, 0, key, open, 'watch' + (r.err ? ' err' : ''), i)); now.set(key, String(v.value));
    if (open) await walk(await children(v.variablesReference), 1, key, rows, now);
  }
  await walk((DB.scopes || []).map(s => ({ name: s.name, variablesReference: s.variablesReference, value: null, scope: true })), 0, 's', rows, now);
  $('#dbVars').innerHTML = rows.join('') || '<div class="db-empty">Sem variáveis.</div>';
  for (const [k, v] of now) DB.seen.set(k, v);
  $('#dbVars').querySelectorAll('.va').forEach(r => r.onclick = async (e) => {
    if (e.target.closest('.db-x')) { DB.watches.splice(+r.dataset.w, 1); store.set('dbWatch', DB.watches); return renderVars(); }
    const key = r.dataset.key, ref = +r.dataset.ref; if (!ref) return;
    const k = key.startsWith('w:') ? key : ref; DB.open.has(k) ? DB.open.delete(k) : DB.open.add(k); await renderVars();
  });
  $('#dbVars').querySelectorAll('.va').forEach(r => r.oncontextmenu = (e) => { e.preventDefault(); const nm = r.dataset.expr; if (!nm) return;
    showMenu(e, [{ label: 'Copiar valor', icon: I.copy || BUG, action: () => copyText(r.querySelector('.vl')?.title || '') }, { label: 'Vigiar "' + nm + '"', icon: IC.eye, action: () => addWatch(nm) }], nm); });
}
async function walk(list, depth, parent, rows, now) {
  for (const v of list) {
    const key = parent + '/' + v.name, ref = v.variablesReference, open = ref && DB.open.has(ref);
    if (!v.scope) now.set(key, String(v.value));
    rows.push(varRow(v, depth, key, open, v.scope ? 'scope' : ''));
    if (open) await walk(await children(ref), depth + 1, key, rows, now);
  }
}
function varRow(v, depth, key, open, cls, wi) {
  const ref = v.variablesReference || 0, val = v.value == null ? '' : String(v.value);
  const was = DB.seen.get(key), chg = !v.scope && was !== undefined && was !== val;
  return `<div class="db-row va ${cls} ${chg ? 'chg' : ''}" style="padding-left:${8 + depth * 14}px" data-ref="${ref}" data-key="${esc(key)}" ${wi != null ? `data-w="${wi}"` : ''} data-expr="${esc(v.evaluateName || (depth === 0 && !v.scope ? v.name : ''))}">`
    + `<span class="ar ${ref ? (open ? 'open' : '') : 'leaf'}"></span>${cls.startsWith('watch') ? `<span class="wi">${IC.eye}</span>` : ''}<span class="nm">${esc(v.name)}</span>`
    + (val !== '' ? `<span class="eq">=</span><span class="vl ${kindOf(v)}" title="${esc(val)}">${esc(val)}</span>` : '')
    + (v.type && !v.scope ? `<span class="ty">${esc(v.type)}</span>` : '') + (wi != null ? `<button class="db-x" title="Parar de vigiar">${IC.x}</button>` : '') + '</div>';
}
function addWatch(expr) {
  expr = (expr || '').trim(); if (!expr || DB.watches.includes(expr)) return;
  DB.watches.push(expr); store.set('dbWatch', DB.watches); renderVars();
}
$('#dbWatchAdd').onclick = () => {
  const el = $('#dbVars'); if (el.querySelector('.db-wadd')) return el.querySelector('.db-wadd input').focus();
  el.insertAdjacentHTML('afterbegin', `<label class="db-wadd">${IC.eye}<input placeholder="Expressão a vigiar (Enter)" spellcheck="false" autocomplete="off"></label>`);
  const i = el.querySelector('.db-wadd input'); i.focus();
  i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { const v = i.value; i.parentElement.remove(); if (DB.cur) addWatch(v); else { DB.watches.push(v.trim()); store.set('dbWatch', DB.watches); toast('Vigiada: aparece na próxima parada'); } } if (e.key === 'Escape') i.parentElement.remove(); };
  i.onblur = () => setTimeout(() => i.parentElement && i.parentElement.remove(), 150);
};

// linha que abre uma função (def, fn, func, function, ou modificadores + tipo + nome( em Java, C#, C++...)
const DECL = /^\s*(?:(?:public|private|protected|internal|static|final|async|override|suspend|export)\s+)*(?:def|fn|func|fun|function|sub)|^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|virtual|override)\s+)+[\w<>\[\],.? ]+\s+\w+\s*\(/;
// valores das variáveis no fim das linhas, do começo da função até a linha atual (como o IntelliJ)
async function inlineValues(f) {
  const t = S.active, ed = editor; clearInline();
  if (!DB.s || !t || !t.model || !f.line || !DB.scopes) return;
  const vars = new Map();
  for (const sc of DB.scopes) { if (sc.expensive || /global/i.test(sc.name)) continue; for (const v of await children(sc.variablesReference)) if (v.value != null && v.value !== '' && /^[A-Za-z_$][\w$]*$/.test(v.name) && !vars.has(v.name)) vars.set(v.name, v); }
  if (!vars.size || !DB.paused || DB.paused.model !== t.model) return;
  const m = t.model, decos = [], from = Math.max(1, f.line - 50);
  for (let ln = f.line; ln >= from; ln--) {
    const text = m.getLineContent(ln).replace(/\/\/.*$|#(?![\w{]).*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
    const names = [...new Set(text.match(/[A-Za-z_$][\w$]*/g) || [])].filter(n => vars.has(n)).slice(0, 4);
    if (names.length) {
      const parts = names.map(n => { const v = vars.get(n), val = String(v.value); return { n, val: val.length > 36 ? val.slice(0, 35) + '…' : val, chg: DB.prev.has(n) && DB.prev.get(n) !== String(v.value) }; });
      // um pedaço por variável: só o valor que mudou fica destacado
      const col = m.getLineMaxColumn(ln);
      parts.forEach((p, k) => decos.push({ range: new monaco.Range(ln, col, ln, col), options: { after: { content: (k ? '  ' : '   ') + p.n + ': ' + p.val, inlineClassName: 'dbg-inl' + (p.chg ? ' chg' : '') }, showIfCollapsed: true } }));
    }
    // parou no começo da função: as linhas de cima são de outra
    if (ln < f.line && DECL.test(m.getLineContent(ln))) break;
  }
  for (const [n, v] of vars) DB.prev.set(n, String(v.value));
  DB.inline = { model: m, ids: m.deltaDecorations([], decos) };
  ed.render && ed.render();
}
function clearInline() { const x = DB.inline; if (x && x.model && !x.model.isDisposed()) x.model.deltaDecorations(x.ids, []); DB.inline = null; }

// abre o código do frame: do projeto no editor; de fora (JDK, node:internal, bibliotecas) numa aba só de leitura,
// com o texto pedido ao depurador (source), ao jdtls (jdt://) ou lido do disco. Nunca troca de projeto.
async function openSource(f) {
  const src = f.source; if (!src) return false;
  const p = src.path || '', rel = relOf(p);
  if (rel != null) { await openFile(rel, 'editor', f.line); return true; }
  const key = (src.sourceReference || '') + '|' + (p || src.name);
  let text = DB.src.get(key);
  if (text == null && src.sourceReference > 0) try { text = (await DB.s.req('source', { source: src, sourceReference: src.sourceReference }, 15000)).content; } catch {}
  if (text == null && /^jdt:/.test(p)) try { const c = await bs.lsp.clientFor({ lang: 'java', project: (S.project || {}).path }); if (c) text = await c.request('java/classFileContents', { uri: p }, 20000); } catch {}
  if (text == null && isDisk(p)) try { const dir = p.replace(/[\\/][^\\/]*$/, ''); text = (await api('file', { project: dir, file: p.slice(dir.length + 1) })).content; } catch {}
  if (text == null) { out(`Sem o código de ${srcName(src)}: só a pilha e as variáveis deste frame (F8/Shift+F8 voltam para o seu código)`, 'bs'); return false; }
  DB.src.set(key, text);
  const name = srcName(src);
  BS.openVirtual(key, name, text, null, f.line, /^jdt:/.test(p) ? 'JDK · ' + decodeURIComponent(p).replace(/^jdt:\/\/contents\/([^/]+)\/([^?]+).*$/, '$1 / $2') : (p || name));
  return true;
}
async function showLine(f) {
  clearPaused(); clearInline();
  if (!f.source || !f.line) return;
  if (!await openSource(f)) return;
  const t = S.active; if (!t || !t.model) return;
  const exc = DB.cur && DB.cur.reason === 'exception' && f === DB.frames[0];
  const top = f === DB.frames[0];
  DB.paused = { model: t.model, ids: t.model.deltaDecorations([], [{ range: new monaco.Range(f.line, 1, f.line, 1), options: { isWholeLine: true, className: 'dbg-line' + (exc ? ' exc' : '') + (top ? '' : ' up'), glyphMarginClassName: 'dbg-arrow' + (exc ? ' exc' : '') + (top ? '' : ' up'), overviewRuler: { color: exc ? '#E5484D' : '#F5B800', position: monaco.editor.OverviewRulerLane.Full } } }]) };
  revealAt(editor, f.line);
}
function clearPaused() { const p = DB.paused; if (p && !p.model.isDisposed()) p.model.deltaDecorations(p.ids, []); DB.paused = null; clearInline(); }

// ----- console -----
function clearOut() { $('#dbOut2').innerHTML = ''; }
function out(text, cat) {
  const el = $('#dbOut2'); const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  const d = document.createElement('div'); d.className = 'db-ln ' + (cat || 'stdout'); d.textContent = String(text).replace(/\n$/, ''); el.appendChild(d);
  while (el.childElementCount > 3000) el.firstElementChild.remove();
  if (atEnd) el.scrollTop = el.scrollHeight;
}
$('#dbClear').onclick = clearOut;
$('#dbEval').addEventListener('keydown', async (e) => {
  e.stopPropagation();
  const inp = $('#dbEval');
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const h = DB.hist; if (!h.length) return; DB.hi = Math.max(-1, Math.min(h.length - 1, DB.hi + (e.key === 'ArrowUp' ? 1 : -1))); inp.value = DB.hi < 0 ? '' : h[h.length - 1 - DB.hi]; return; }
  if (e.key !== 'Enter') return;
  const expr = inp.value.trim(); if (!expr) return; inp.value = ''; DB.hi = -1;
  DB.hist = [...DB.hist.filter(x => x !== expr), expr].slice(-100); store.set('dbHist', DB.hist);
  out('› ' + expr, 'in');
  if (!DB.s) { out('Nenhuma sessão de depuração aberta.', 'stderr'); return; }
  try { const r = await DB.s.req('evaluate', { expression: expr, frameId: DB.frameId || undefined, context: 'repl' }); out(r.result + (r.type ? '   (' + r.type + ')' : ''), 'res'); if (DB.cur) renderVars(); }
  catch (err) { out(err.message, 'stderr'); }
});

// ----- painel e barra -----
function show(on) { const c = $('#dbgCon'); c.hidden = !(on ?? c.hidden); document.querySelector('#strip [data-tool="debug"]')?.classList.toggle('on', !c.hidden); }
function state(text, kind) {
  for (const id of ['dbState', 'dbBarState']) $('#' + id).textContent = text;
  for (const id of ['dbBadge', 'dbBarBadge']) $('#' + id).className = 'db-badge ' + (kind || '');
  document.body.classList.toggle('debugging', !!DB.s);
  buttons();
}
function buttons() {
  const on = !!DB.s, paused = !!DB.cur;
  DB.ctx && DB.ctx.set(paused);
  const dis = { go: !paused, over: !paused, into: !paused, out: !paused, cursor: !paused, pause: !on || paused, stop: !on, again: !DB.last };
  document.querySelectorAll('[data-db]').forEach(b => { b.disabled = !!dis[b.dataset.db]; });
  // na barra, Continuar e Pausar dividem o lugar
  const bar = $('#dbBar'); bar.hidden = !on; bar.classList.toggle('paused', paused);
}
const ACT = { go: () => step('continue'), over: () => step('next'), into: () => step('stepIn'), out: () => step('stepOut'), cursor: () => runToCursor(), stop: () => stop(),
  pause: () => DB.s && DB.s.req('pause', { threadId: (DB.cur && DB.cur.threadId) || (DB.threads[0] && DB.threads[0].id) || 1 }).catch(() => {}),
  again: () => start(DB.last && S.tabs.includes(DB.last) ? DB.last : S.active) };
document.querySelectorAll('[data-db]').forEach(b => b.onclick = () => ACT[b.dataset.db]());
$('#dbHide').onclick = () => show(false);
$('#dbThread').onchange = (e) => { if (DB.cur) loadFrames(+e.target.value); };
document.querySelectorAll('#dbgCon .db-sec > h4').forEach(h => h.onclick = (e) => { if (e.target.closest('select')) return; h.parentElement.classList.toggle('open'); store.set('dbSec:' + h.parentElement.dataset.sec, h.parentElement.classList.contains('open')); });
document.querySelectorAll('#dbgCon .db-sec').forEach(s => { const v = store.get('dbSec:' + s.dataset.sec, null); if (v != null) s.classList.toggle('open', v); });
$('#dbResize').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; e.preventDefault(); const con = $('#dbgCon'); const y0 = e.clientY, h0 = con.offsetHeight; document.body.classList.add('resizing-v');
  const move = (ev) => { con.style.height = Math.max(160, Math.min(innerHeight - 160, h0 + (y0 - ev.clientY))) + 'px'; };
  const up = () => { document.body.classList.remove('resizing-v'); store.set('dbgH', con.offsetHeight); };
  pointerDrag(e, move, up);
});
// barra: arrastar pela alça (a posição fica guardada, em fração da largura)
(() => {
  const bar = $('#dbBar'), x = store.get('dbBarX', 0.5); bar.style.left = (x * 100) + '%';
  bar.querySelector('.db-grip').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault(); const mon = $('#mon').getBoundingClientRect(), dx = e.clientX - bar.getBoundingClientRect().left - bar.offsetWidth / 2;
    const move = (ev) => { const f = Math.max(0.08, Math.min(0.92, (ev.clientX - dx - mon.left) / mon.width)); bar.style.left = (f * 100) + '%'; bar.dataset.f = f; };
    const up = () => { if (bar.dataset.f) store.set('dbBarX', +bar.dataset.f); };
    pointerDrag(e, move, up);
  });
})();
$('#dbgCon').style.height = store.get('dbgH', 300) + 'px';
$('#dbFrames').innerHTML = '<div class="db-empty">Marque um breakpoint na margem e use Shift+F9 para depurar o arquivo aberto.</div>';
renderExc(); buttons();

// ----- editor: margem dos breakpoints, valor no hover -----
bs.hooks.on('editor:ready', (ed) => {
  ed.updateOptions({ glyphMargin: true });
  // com o foco no editor o Monaco fica com F7/F8/F9 (F8 é "próximo problema"): pausado, as teclas são da depuração
  DB.ctx = ed.createContextKey('bsDebugPaused', false);
  const K = monaco.KeyMod, C = monaco.KeyCode;
  ed.addCommand(C.F9, () => step('continue'), 'bsDebugPaused');
  ed.addCommand(C.F8, () => step('next'), 'bsDebugPaused');
  ed.addCommand(C.F7, () => step('stepIn'), 'bsDebugPaused');
  ed.addCommand(K.Shift | C.F8, () => step('stepOut'), 'bsDebugPaused');
  ed.addCommand(K.Alt | C.F9, () => runToCursor(), 'bsDebugPaused');
  ed.addCommand(K.CtrlCmd | C.F2, () => stop());
  ed.addCommand(K.Shift | C.F9, () => start());
  ed.addCommand(K.CtrlCmd | C.F8, () => { const t = S.active; if (t && t.mode === 'editor') bpToggle(t, ed.getPosition().lineNumber); });
  const GM = monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
  // a faixa da esquerda da margem é dos plugins (ex.: ▶ do main, do plugin runtimes); a do meio é dos breakpoints
  const LEFT = monaco.editor.GlyphMarginLane.Left;
  const OTHER_LANE = (e) => { const m = ed.getModel(); return !!(m && e.target.detail && e.target.detail.glyphMarginLane === LEFT && e.target.position && m.getLineDecorations(e.target.position.lineNumber).some(d => d.options.glyphMargin && d.options.glyphMargin.position === LEFT)); };
  ed.onMouseDown((e) => { if (e.target.type === GM && !OTHER_LANE(e) && e.event.leftButton && S.active && S.active.mode === 'editor') bpToggle(S.active, e.target.position.lineNumber); });
  ed.onContextMenu((e) => { if (e.target.type !== GM || OTHER_LANE(e) || !S.active || S.active.virtual) return; const line = e.target.position.lineNumber; const t = S.active; const b = bpsOf(t.path).get(line);
    showMenu(e.event.browserEvent, [{ label: b ? 'Remover breakpoint' : 'Adicionar breakpoint', icon: BUG, action: () => bpToggle(t, line) }, { label: 'Condição…', icon: I.edit, action: () => bpCondition(t, line) },
      ...(b ? [{ label: b.enabled === false ? 'Ativar' : 'Desativar', icon: BUG, action: () => bpToggle(t, line, { enabled: b.enabled === false ? undefined : false }) }] : []),
      ...(DB.cur ? [{ label: 'Rodar até esta linha', k: 'Alt+F9', icon: IC.cursor, action: () => { ed.setPosition({ lineNumber: line, column: 1 }); runToCursor(); } }] : [])], 'Linha ' + line); });
  // prévia do breakpoint ao passar pela margem
  let ghost = [];
  ed.onMouseMove((e) => { const m = ed.getModel(); if (!m) return; const line = e.target.type === GM && !OTHER_LANE(e) && S.active && !S.active.virtual ? e.target.position.lineNumber : 0; const has = line && bpsOf(S.active.path).has(line); ghost = m.deltaDecorations(ghost, line && !has ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-ghost' } }] : []); });
  ed.onMouseLeave(() => { const m = ed.getModel(); if (m) ghost = m.deltaDecorations(ghost, []); });
  ed.onDidChangeModelContent(() => { if (S.active && S.active.mode === 'editor' && !S.active.virtual) bpTrack(S.active); });
  ed.addAction({ id: 'bs.debug', label: 'Depurar este arquivo', keybindings: [], contextMenuGroupId: 'navigation', contextMenuOrder: 3, run: () => start() });
  ed.addAction({ id: 'bs.debug.watch', label: 'Depuração: vigiar a seleção', contextMenuGroupId: 'navigation', contextMenuOrder: 4, precondition: 'bsDebugPaused', run: () => { const s = ed.getSelection(), m = ed.getModel(); const tx = s && !s.isEmpty() ? m.getValueInRange(s) : (m.getWordAtPosition(ed.getPosition()) || {}).word; addWatch(tx); } });
  // pausado: o valor da expressão sob o mouse (objetos mostram os primeiros campos)
  const hov = { provideHover: async (model, pos) => {
    if (!DB.s || !DB.cur) return null; const w = model.getWordAtPosition(pos); if (!w) return null;
    const line = model.getLineContent(pos.lineNumber); let a = w.startColumn - 1; while (a > 0 && /[\w.$]/.test(line[a - 1])) a--;
    const expr = line.slice(a, w.endColumn - 1);
    try {
      const r = await DB.s.req('evaluate', { expression: expr, frameId: DB.frameId || undefined, context: 'hover' }, 3000);
      let md = '**' + expr + '**' + (r.type ? '  ·  _' + r.type + '_' : '') + '\n```\n' + String(r.result).slice(0, 500) + '\n```';
      if (r.variablesReference) { const kids = (await children(r.variablesReference)).slice(0, 12); if (kids.length) md += '\n' + kids.map(k => '- `' + k.name + '` = `' + String(k.value).replace(/`/g, "'").slice(0, 80) + '`').join('\n'); }
      return { range: new monaco.Range(pos.lineNumber, a + 1, pos.lineNumber, w.endColumn), contents: [{ value: md }] };
    } catch { return null; }
  } };
  for (const l of ['python', 'go', 'c', 'cpp', 'rust', 'csharp', 'java', 'javascript', 'typescript', 'ruby', 'kotlin', 'php']) monaco.languages.registerHoverProvider(l, hov);
});
bs.hooks.on('tab:activate', (t) => bpPaint(t));
bs.hooks.on('tab:open', (t) => setTimeout(() => bpPaint(t)));
bs.hooks.on('project:select', () => bpLoad());
bpLoad();

// ----- teclas e registro -----
const ifDbg = (fn) => () => { if (!DB.s) return false; fn(); };
bs.keys.add('Shift+F9', () => { start(); });
bs.keys.add('F9', ifDbg(() => step('continue')));
bs.keys.add('F8', ifDbg(() => step('next')));
bs.keys.add('F7', ifDbg(() => step('stepIn')));
bs.keys.add('Shift+F8', ifDbg(() => step('stepOut')));
bs.keys.add('Alt+F9', ifDbg(() => runToCursor()));
bs.keys.add('Ctrl+F2', ifDbg(() => stop()));
bs.keys.add('Ctrl+F8', () => { const t = S.active; if (!t || t.mode !== 'editor') return false; bpToggle(t, editor.getPosition().lineNumber); });
bs.tools.register({ id: 'debug', title: 'Depurar', icon: BUG, order: 85, bottom: true, toggle: (on) => show(on) });
bs.actions.add([
  { label: 'Depurar o arquivo aberto', k: 'Shift+F9', run: () => start(), icon: BUG },
  { label: 'Marcar ou tirar breakpoint', k: 'Ctrl+F8', run: () => { const t = S.active; if (t && t.mode === 'editor') bpToggle(t, editor.getPosition().lineNumber); }, icon: BUG },
  { label: 'Depuração: rodar até o cursor', k: 'Alt+F9', run: () => runToCursor(), icon: BUG },
  { label: 'Parar a depuração', k: 'Ctrl+F2', run: () => stop(), icon: BUG },
  { label: 'Remover todos os breakpoints', run: () => { const rels = [...DB.bps.keys()]; DB.bps = new Map(); bpSave(); S.tabs.forEach(bpPaint); rels.forEach(bpSync); }, icon: BUG },
]);
window.addEventListener('beforeunload', () => { if (DB.s) DB.s.close(); });
bs.debug = { start, stop, need, launchers, session: () => DB.s };
})(window.BS);
