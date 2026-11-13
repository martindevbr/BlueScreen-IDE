/* BlueScreen: Terminal embutido (Alt+F12, como no IntelliJ). Painel embaixo do editor com abas; cada aba é um
   shell de verdade num pseudoconsole do Windows (ConPTY), ligado por WebSocket a /api/terminal/ws. O botão + abre
   o shell padrão; a setinha ao lado escolhe outro (PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL, MSYS2,
   Cygwin, Nushell, prompts do Visual Studio e perfis do Windows Terminal). O shell padrão fica lembrado.
   Ctrl+C copia quando há seleção (senão interrompe), Ctrl+V cola, botão direito abre o menu.
   Ctrl + roda do mouse sobre o terminal, Ctrl++ e Ctrl+- mudam o tamanho da letra só dele (Ctrl+0 volta).
   Expõe bs.terminal: open(cwd, shellId), run(texto) e shells(). */
(function (bs) {

const TM = { list: [], active: null, shells: null, seq: 0, def: store.get('termShell', null) };
const TERM_ICO = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>';
const KIND_ICO = {
  ps: '<svg class="i" viewBox="0 0 24 24"><path d="M5 5h16l-3 14H2z"/><path d="M8 9l4 3-5 3M12 15h3"/></svg>',
  cmd: TERM_ICO, vs: '<svg class="i" viewBox="0 0 24 24"><path d="M17 3l4 2v14l-4 2-10-9 10-7z"/><path d="M7 12l-4 3V9z"/></svg>',
  bash: '<svg class="i" viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M9 10l2 2-2 2M12 14h3"/></svg>',
  wsl: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 10l2 2-2 2M12 14h4"/></svg>',
  nu: '<svg class="i" viewBox="0 0 24 24"><path d="M4 18V6l8 12V6M15 9v5a3 3 0 0 0 6 0V9"/></svg>',
  wt: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 13l2 2-2 2"/></svg>',
};
const PLUS = '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const MINUS = '<svg class="i" viewBox="0 0 24 24"><path d="M5 12h14"/></svg>';
const CARET = '<svg class="i" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

bs.ui.panel(`<div id="termCon" hidden>
  <div id="tmResize" title="Arraste para ajustar a altura"></div>
  <div class="head"><span class="ttl">Terminal</span><div class="tm-tabs" id="tmTabs" role="tablist"></div>
    <button class="icon-btn" id="tmNew" title="Novo terminal (Ctrl+Shift+T)">${PLUS}</button><button class="icon-btn tm-pick" id="tmPick" title="Escolher o shell">${CARET}</button>
    <span class="spacer"></span>
    <button class="icon-btn" id="tmClear" title="Limpar">${I.refresh}</button>
    <button class="icon-btn" id="tmHide" title="Esconder (Alt+F12)"><svg class="i" viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button></div>
  <div class="tm-body" id="tmBody"></div>
</div>`);

// ----- cores: seguem o tema do BlueScreen (fundo e texto) com a paleta ANSI do IntelliJ -----
const ANSI_DARK = { black: '#1E1F22', red: '#F0524F', green: '#5C962C', yellow: '#A68A0D', blue: '#3993D4', magenta: '#A771BF', cyan: '#00A3A3', white: '#808080', brightBlack: '#595959', brightRed: '#FF4050', brightGreen: '#4FC414', brightYellow: '#E5BF00', brightBlue: '#1FB0FF', brightMagenta: '#ED7EED', brightCyan: '#00E5E5', brightWhite: '#FFFFFF' };
const ANSI_LIGHT = { black: '#000000', red: '#C91B00', green: '#00A600', yellow: '#8C6C00', blue: '#0225C7', magenta: '#C930C7', cyan: '#00A6B2', white: '#8C8C8C', brightBlack: '#686868', brightRed: '#E5534B', brightGreen: '#3A9A2A', brightYellow: '#A68A0D', brightBlue: '#3D62F5', brightMagenta: '#B04AB0', brightCyan: '#0E9AA7', brightWhite: '#3E4450' };
function tmTheme() {
  const cs = getComputedStyle(document.documentElement); const v = (k) => cs.getPropertyValue('--' + k).trim();
  const light = document.documentElement.dataset.theme === 'light';
  return { background: v('bg'), foreground: v('fg-2'), cursor: v('fg'), cursorAccent: v('bg'), selectionBackground: v('sel'), selectionForeground: v('fg'), scrollbarSliderBackground: v('line-2') + '99', ...(light ? ANSI_LIGHT : ANSI_DARK) };
}
// tamanho da letra do terminal: o do código, mais o zoom próprio (Ctrl + roda do mouse e Ctrl + / Ctrl - com o terminal em foco)
TM.zoom = store.get('termZoom', 0);
const tmFont = () => Math.max(8, Math.min(40, (S.fontSize || 13) + TM.zoom));
function tmRefont() { TM.list.forEach(t => { t.term.options.fontSize = tmFont(); try { t.fit.fit(); } catch {} }); }
function tmZoom(step) {
  const before = tmFont(); TM.zoom = step === 0 ? 0 : TM.zoom + step; let now = tmFont();
  if (step && now === before) { TM.zoom -= step; return; } // já está no limite
  store.set('termZoom', TM.zoom); tmRefont(); toast(`Fonte do terminal: ${now}px`, null, 'font');
}
bs.zoom = Object.assign(bs.zoom || {}, { terminal: tmZoom });
new MutationObserver(() => { const th = tmTheme(); TM.list.forEach(t => { t.term.options.theme = th; }); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

async function tmShells(fresh) {
  if (TM.shells && !fresh) return TM.shells;
  try { TM.shells = (await api('terminal/shells', { fresh: fresh ? '1' : null })).shells || []; } catch (e) { toast('Terminal: ' + e.message); TM.shells = []; }
  return TM.shells;
}
const tmDefault = () => (TM.shells || []).find(s => s.id === TM.def) || (TM.shells || [])[0];

// ----- abrir / fechar -----
function tmShow(on) {
  const con = $('#termCon'); const show = on ?? con.hidden;
  con.hidden = !show; tmStripState();
  if (show) { if (!TM.list.length) tmOpen(); else tmFocus(TM.active); }
  else (S.active && S.active.mode === 'diff' ? diffEditor?.getModifiedEditor() : editor)?.focus();
}
function tmStripState() { document.querySelector('#strip [data-tool="terminal"]')?.classList.toggle('on', !$('#termCon').hidden); }
async function tmOpen(cwd, shellId) {
  if (!window.Terminal) { toast('Terminal: xterm.js não carregou'); return; }
  $('#termCon').hidden = false; tmStripState();
  await tmShells();
  const sh = (TM.shells || []).find(s => s.id === shellId) || tmDefault();
  if (!sh) { toast('Nenhum shell encontrado'); return; }
  const dir = cwd || (S.project && S.project.path) || '';
  const n = TM.list.filter(t => t.shell.id === sh.id).length;
  const t = { id: ++TM.seq, shell: sh, cwd: dir, title: sh.name + (n ? ` (${n + 1})` : ''), alive: false, started: Date.now() };
  t.el = document.createElement('div'); t.el.className = 'tm-pane'; t.el.dataset.zoom = 'terminal'; $('#tmBody').appendChild(t.el);
  t.term = new Terminal({ fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace", fontSize: tmFont(), lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback: 10000, allowProposedApi: true, theme: tmTheme(), windowsPty: { backend: 'conpty' }, rightClickSelectsWord: false, macOptionIsMeta: true });
  t.fit = new FitAddon.FitAddon(); t.term.loadAddon(t.fit);
  try { t.term.loadAddon(new Unicode11Addon.Unicode11Addon()); t.term.unicode.activeVersion = '11'; } catch {}
  // links: http(s) abre no navegador; caminho:linha de arquivo do projeto abre no editor
  try { t.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank'))); } catch {}
  tmFileLinks(t);
  t.term.open(t.el);
  t.term.attachCustomKeyEventHandler((e) => tmKey(t, e));
  t.term.onData((d) => tmSend(t, { i: d }));
  t.term.onResize(({ cols, rows }) => tmSend(t, { r: [cols, rows] }));
  t.term.onTitleChange((s) => { if (s && s.trim()) { t.osTitle = s.trim(); tmTabs(); } });
  t.el.addEventListener('contextmenu', (e) => tmMenu(e, t));
  // teclas do terminal não disparam os atalhos da IDE, só os de janela (Alt+número, Alt+F12, F11)
  t.el.addEventListener('keydown', (e) => { const k = keyCombo(e); if (!/^Alt\+(\d|F12|P)$|^F11$|^Ctrl\+Shift\+T$/.test(k)) e.stopPropagation(); });
  TM.list.push(t); tmActivate(t);
  t.fit.fit();
  tmConnect(t);
  return t;
}
function tmConnect(t) {
  const u = new URL('/api/terminal/ws', location.origin); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('shell', t.shell.id); if (t.cwd) u.searchParams.set('cwd', t.cwd);
  u.searchParams.set('cols', t.term.cols); u.searchParams.set('rows', t.term.rows);
  const ws = t.ws = new WebSocket(u); ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { t.term.write(new Uint8Array(ev.data)); return; }
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.ready) { t.alive = true; t.pid = m.ready.pid; tmTabs(); if (t.pending) { tmSend(t, { i: t.pending }); t.pending = null; } }
    if (m.error) { t.term.write(`\r\n\x1b[31m${m.error}\x1b[0m\r\n`); }
    if ('exit' in m) tmExited(t, m.exit);
  };
  ws.onclose = () => { if (t.alive) tmExited(t, null); };
  ws.onerror = () => { if (!t.alive && !t.closed) t.term.write('\r\n\x1b[31mNão foi possível abrir o terminal (só funciona no PC local).\x1b[0m\r\n'); };
}
function tmExited(t, code) {
  if (!t.alive && code === null) return; t.alive = false;
  // como no IntelliJ: "exit" fecha a aba; se o shell caiu logo ao abrir, a aba fica para mostrar o erro
  if (Date.now() - t.started > 3000 && (code === 0 || code === null)) { tmClose(t); return; }
  t.term.write(`\r\n\x1b[90m[processo encerrado${code != null ? ', código ' + code : ''}. Enter abre de novo]\x1b[0m\r\n`); tmTabs();
}
function tmSend(t, msg) { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify(msg)); }
function tmClose(t) {
  t.closed = true; try { t.ws && t.ws.close(); } catch {}
  t.term.dispose(); t.el.remove();
  const i = TM.list.indexOf(t); TM.list.splice(i, 1);
  if (TM.active === t) { TM.active = null; const n = TM.list[i] || TM.list[i - 1]; if (n) tmActivate(n); }
  if (!TM.list.length) tmShow(false); else tmTabs();
}
function tmActivate(t) {
  TM.active = t; TM.list.forEach(x => x.el.classList.toggle('on', x === t));
  tmTabs(); requestAnimationFrame(() => { try { t.fit.fit(); } catch {} tmFocus(t); });
}
function tmFocus(t) { if (t) t.term.focus(); }
function tmTabs() {
  $('#tmTabs').innerHTML = TM.list.map(t => `<div class="tm-tab ${t === TM.active ? 'on' : ''} ${t.alive ? '' : 'dead'}" data-id="${t.id}" title="${esc(t.shell.name + (t.cwd ? '\n' + t.cwd : '') + (t.pid ? '\nPID ' + t.pid : ''))}">${KIND_ICO[t.shell.kind] || TERM_ICO}<span class="nm">${esc(t.title)}</span><button class="x" title="Fechar">${I.x}</button></div>`).join('');
  $('#tmTabs').querySelectorAll('.tm-tab').forEach(el => {
    const t = TM.list.find(x => x.id === +el.dataset.id);
    el.onclick = () => tmActivate(t);
    el.onauxclick = (e) => { if (e.button === 1) tmClose(t); };
    el.ondblclick = () => tmRename(t, el);
    el.querySelector('.x').onclick = (e) => { e.stopPropagation(); tmClose(t); };
    el.oncontextmenu = (e) => showMenu(e, [
      { label: 'Renomear', icon: I.edit, action: () => tmRename(t, el) },
      { label: 'Fechar', icon: I.x, action: () => tmClose(t) },
      { label: 'Fechar os outros', icon: I.x, action: () => TM.list.filter(x => x !== t).forEach(tmClose) },
    ], t.shell.name);
  });
}
function tmRename(t, el) {
  const nm = el.querySelector('.nm'); const inp = document.createElement('input'); inp.className = 'tm-ren'; inp.value = t.title; nm.replaceWith(inp); inp.focus(); inp.select();
  const done = (ok) => { if (ok && inp.value.trim()) t.title = inp.value.trim(); tmTabs(); tmFocus(t); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
}
const TM_ZOOM = { 'Ctrl+=': 1, 'Ctrl++': 1, 'Ctrl+Shift+=': 1, 'Ctrl+Shift++': 1, 'Ctrl+Add': 1, 'Ctrl+-': -1, 'Ctrl+Subtract': -1, 'Ctrl+Shift+-': -1, 'Ctrl+Shift+_': -1, 'Ctrl+0': 0 };
function tmKey(t, e) {
  if (e.type !== 'keydown') return true;
  const k = keyCombo(e);
  if (!t.alive && !t.closed && k === 'Enter' && t.ws && t.ws.readyState > 1) { tmRestart(t); return false; }
  if ((k === 'Ctrl+C' && t.term.hasSelection()) || k === 'Ctrl+Shift+C') { if (t.term.hasSelection()) copyText(t.term.getSelection()); t.term.clearSelection(); return false; }
  // Ctrl+V: o navegador faz a colagem (evento paste), o xterm só não manda ^V para o shell
  if (k === 'Ctrl+V' || k === 'Ctrl+Shift+V' || k === 'Shift+Insert') return false;
  if (k === 'Ctrl+Shift+T') return false;
  // zoom do terminal: não vai para o shell
  const z = TM_ZOOM[k]; if (z !== undefined) { tmZoom(z); e.preventDefault(); return false; }
  return true;
}
function tmRestart(t) { t.term.write('\r\n'); t.started = Date.now(); tmConnect(t); }
async function tmPaste(t) { try { const s = await navigator.clipboard.readText(); if (s) t.term.paste(s); } catch { toast('Não foi possível ler a área de transferência'); } }
function tmMenu(e, t) {
  showMenu(e, [
    { label: 'Copiar', icon: I.copy, k: 'Ctrl+C', action: () => { if (t.term.hasSelection()) copyText(t.term.getSelection()); } },
    { label: 'Colar', icon: I.copy, k: 'Ctrl+V', action: () => tmPaste(t) },
    { label: 'Selecionar tudo', icon: I.edit, action: () => t.term.selectAll() },
    '-',
    { label: 'Aumentar a letra', icon: PLUS, k: 'Ctrl++', action: () => tmZoom(1) },
    { label: 'Diminuir a letra', icon: MINUS, k: 'Ctrl+-', action: () => tmZoom(-1) },
    ...(TM.zoom ? [{ label: 'Letra do tamanho do código', icon: I.refresh, k: 'Ctrl+0', action: () => tmZoom(0) }] : []),
    '-',
    { label: 'Limpar', icon: I.refresh, action: () => t.term.clear() },
    { label: 'Novo terminal', icon: PLUS, k: 'Ctrl+Shift+T', action: () => tmOpen(t.cwd) },
    { label: 'Mostrar a pasta no Explorer', icon: I.explorer || I.open, action: () => reveal(t.cwd) },
  ], t.title);
}
async function tmPick(e) {
  await tmShells();
  const r = (e.currentTarget || e.target).getBoundingClientRect();
  const ev = { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} };
  const def = tmDefault();
  showMenu(ev, [
    ...TM.shells.map(s => ({ label: s.name + (def && s.id === def.id ? '  ·  padrão' : ''), icon: KIND_ICO[s.kind] || TERM_ICO, action: () => tmOpen(null, s.id) })),
    '-',
    ...(TM.shells.length > 1 ? [{ label: 'Shell padrão…', icon: I.edit, action: () => tmPickDefault(ev) }] : []),
    { label: 'Procurar shells de novo', icon: I.refresh, action: async () => { await tmShells(true); toast(TM.shells.length + ' shell(s) encontrados'); } },
  ], 'Abrir com');
}
function tmPickDefault(ev) {
  showMenu(ev, TM.shells.map(s => ({ label: s.name, icon: KIND_ICO[s.kind] || TERM_ICO, action: () => { TM.def = s.id; store.set('termShell', s.id); toast('Shell padrão: ' + s.name); } })), 'Shell padrão');
}
// caminho:linha na saída (javac, tsc, eslint, cargo...) vira link para o arquivo do projeto
function tmFileLinks(t) {
  const re = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.$@-]+[\\/])*[\w.$@-]+\.[A-Za-z]{1,8}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))/g;
  t.term.registerLinkProvider({ provideLinks(y, cb) {
    const line = t.term.buffer.active.getLine(y - 1); if (!line || !S.project) return cb(undefined);
    const text = line.translateToString(true); const out = []; let m; re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const raw = m[0]; const lm = /[:(](\d+)(?:[:,](\d+))?\)?$/.exec(raw); const file = raw.slice(0, lm.index);
      const root = S.project.path.replace(/\\/g, '/').toLowerCase();
      let rel = file.replace(/\\/g, '/'); if (rel.toLowerCase().startsWith(root + '/')) rel = rel.slice(root.length + 1); else if (/^[A-Za-z]:\//.test(rel)) continue;
      rel = rel.replace(/^\.\//, '');
      const start = m.index + 1;
      out.push({ range: { start: { x: start, y }, end: { x: start + raw.length - 1, y } }, text: raw, activate: () => openFile(rel, 'editor', +lm[1]) });
    }
    cb(out.length ? out : undefined);
  } });
}

// ----- painel: altura, botões, teclas -----
$('#tmResize').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; e.preventDefault(); const con = $('#termCon'); const y0 = e.clientY, h0 = con.offsetHeight; document.body.classList.add('resizing-v');
  const move = (ev) => { con.style.height = Math.max(120, Math.min(innerHeight - 160, h0 + (y0 - ev.clientY))) + 'px'; };
  const up = () => { document.body.classList.remove('resizing-v'); store.set('termH', con.offsetHeight); TM.active?.fit.fit(); };
  pointerDrag(e, move, up);
});
$('#termCon').style.height = store.get('termH', 280) + 'px';
new ResizeObserver(() => { const t = TM.active; if (t && !$('#termCon').hidden) try { t.fit.fit(); } catch {} }).observe($('#tmBody'));
$('#tmNew').onclick = () => tmOpen();
$('#tmPick').onclick = tmPick;
$('#tmClear').onclick = () => { if (TM.active) { TM.active.term.clear(); tmFocus(TM.active); } };
$('#tmHide').onclick = () => tmShow(false);
$('#tmTabs').ondblclick = (e) => { if (e.target.id === 'tmTabs') tmOpen(); };

bs.tools.register({ id: 'terminal', title: 'Terminal', icon: TERM_ICO, key: 'Alt+F12', order: 90, bottom: true, toggle: (on) => tmShow(on) });
bs.keys.add('Ctrl+Shift+T', () => { tmOpen(); });
bs.actions.add([
  { label: 'Terminal', k: 'Alt+F12', run: () => tmShow(true), icon: TERM_ICO },
  { label: 'Novo terminal', k: 'Ctrl+Shift+T', run: () => tmOpen(), icon: TERM_ICO },
]);
// árvore: abrir um terminal na pasta (ou na pasta do arquivo)
bs.hooks.filter('menu:file', (items, ctx) => {
  if (!S.project || !ctx) return items;
  const rel = ctx.isDir ? ctx.rel : ctx.rel.split('/').slice(0, -1).join('/');
  return [...items, '-', { label: 'Abrir no terminal', icon: TERM_ICO, action: () => tmOpen(rel ? absPath(rel) : S.project.path) }];
});
bs.hooks.on('codefont', tmRefont);
window.addEventListener('beforeunload', () => TM.list.forEach(t => { try { t.ws.close(); } catch {} }));
bs.terminal = { prefs: { shell: () => (tmDefault() || {}).id || TM.def, setShell(id) { TM.def = id; store.set('termShell', id); }, font: () => tmFont(), zoom: (step) => tmZoom(step) },
  open: (cwd, shell) => tmOpen(cwd, shell), run: async (text, cwd) => { const t = (cwd ? null : TM.active) || await tmOpen(cwd); if (!t) return; if (t.alive) tmSend(t, { i: text + '\r' }); else t.pending = text + '\r'; }, shells: () => tmShells() };
})(window.BS);
