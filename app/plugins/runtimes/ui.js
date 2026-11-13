// Runtimes e execução. Tudo roda aqui, na página, sem servidor próprio (o motor fica no fim deste arquivo):
// - ▶ na margem de cada main (public static void main, fun main, if __name__ == "__main__", func main, fn main...).
//   Clique: menu com Executar, Executar com argumentos, Depurar e Copiar comando. Ctrl+Shift+F10 executa o main mais
//   perto do cursor. A execução usa o console do Build (com entrada para o programa).
// - Aviso em cima do editor quando falta o runtime da linguagem (ou a versão que o projeto pede): baixar pela IDE,
//   escolher outra versão, apontar uma pasta já instalada, instalar com winget/scoop ou abrir a página oficial.
// - Janela "Runtimes do projeto" (status bar, Buscar em tudo e resumo do projeto): cada linguagem do projeto e o que
//   ela precisa, com as mesmas ações.
const { S, api, esc, toast, store } = bs;
if (S.remote) return; // pela rede local não se executa nada nem se instala nada no PC

const ICO = {
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  args: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/><path d="M3 20h8" /></svg>',
  bug: '<svg class="i" viewBox="0 0 24 24"><path d="M8 8h8v8a4 4 0 0 1-8 0zM9 8a3 3 0 0 1 6 0M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2"/></svg>',
  copy: bs.I.copy,
  rt: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M10 8.5v5l4-2.5zM8 21h8"/></svg>',
  dl: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  folder: '<svg class="i" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  term: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>',
  ext: bs.I.ext,
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17v.5"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: bs.I.x,
  refresh: bs.I.refresh,
};
// o motor, ligado ao núcleo: arquivos do projeto (file/stat, file, tree, index), programas do PC (sdk/which, sdk/jdks,
// sdk/mavens, plugin.exec) e a pasta de trabalho (classes compiladas, executáveis, init script do Gradle) em files/run
const WIN = /Windows/i.test(navigator.userAgent);
const FIND_BIN_PS = `$p = $env:BS_DIR; if (-not (Test-Path -LiteralPath $p -PathType Container)) { 'NODIR'; exit }
$c = @($p, (Join-Path $p 'bin'), (Join-Path $p 'Scripts'))
$subs = [string[]]@(Get-ChildItem -LiteralPath $p -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
[Array]::Sort($subs, [StringComparer]::Ordinal); [Array]::Reverse($subs)
foreach ($s in ($subs | Select-Object -First 40)) { $c += (Join-Path $s 'bin'); $c += $s }
foreach ($d in $c) { foreach ($n in ($env:BS_PROGS -split ';')) { foreach ($x in 'exe', 'cmd', 'bat') { if (Test-Path -LiteralPath (Join-Path $d "$n.$x") -PathType Leaf) { 'BIN:' + $d; exit } } } }
'NONE'`;
const FIND_BIN_SH = `p="$BS_DIR"; [ -d "$p" ] || { echo NODIR; exit 0; }
has() { for n in $(echo "$BS_PROGS" | tr ';' ' '); do [ -f "$1/$n" ] && { echo "BIN:$1"; return 0; }; done; return 1; }
{ has "$p" || has "$p/bin" || has "$p/Scripts" || ls -1p "$p" 2>/dev/null | grep '/$' | sed 's#/$##' | LC_ALL=C sort -r | head -n 40 | while IFS= read -r s; do has "$p/$s/bin" || has "$p/$s"; done; } | head -n 1 | grep . || echo NONE`;
let workDir = null;
const R = runtimesCore({
  win: WIN,
  async stat(project, files) {
    const parts = [];
    for (let i = 0; i < files.length; i += 500) parts.push(api('file/stat', { project }, { method: 'POST', body: JSON.stringify({ files: files.slice(i, i + 500) }) }).then(r => r.files || {}, () => ({})));
    return Object.assign({}, ...(await Promise.all(parts)));
  },
  async read(project, file) { const r = await api('file', { project, file }); return r.binary || r.tooBig ? '' : r.content || ''; },
  async list(project, dir) { return (await api('tree', { project, dir, compact: 0 })).map(e => ({ name: e.name, dir: !!e.dir })); },
  async index(project) { return (await api('index', { project })).map(e => e.p); },
  exec: (program, args, opt) => plugin.exec(program, args, opt),
  which: (progs) => api('sdk/which', {}, { method: 'POST', body: JSON.stringify({ progs }) }),
  jdks: () => api('sdk/jdks'),
  mavens: () => api('sdk/mavens'),
  core: (route, q) => api(route, q, { method: 'POST' }), // sdk/default e sdk/path só aceitam POST
  async workDir() { if (!workDir) workDir = (await plugin.info()).filesDir.replace(/[\\/]+$/, '') + (WIN ? '\\' : '/') + 'run'; return workDir; },
  writeWork: (rel, content) => plugin.files.write('run/' + rel, content),
  // a pasta de programas dentro do que o usuário escolheu (a própria, bin, Scripts ou uma subpasta, a versão mais nova
  // primeiro): fica fora do projeto, então quem olha é o PowerShell (ou o sh), com o caminho numa variável de ambiente
  async findBin(path, progs) {
    const env = { BS_DIR: path, BS_PROGS: progs.join(';') };
    if (WIN) {
      // o caso comum (a própria pasta, bin ou Scripts) pelo where.exe, que é rápido; o PowerShell leva ~1 s para abrir
      const base = path.replace(/[\\/]+$/, '');
      const cands = [base, base + '\\bin', base + '\\Scripts'];
      const hits = (await Promise.all(progs.map(p => plugin.exec('where', ['$BS_CANDS:' + p], { env: { BS_CANDS: cands.join(';') }, timeout: 5000 }).catch(() => ({ out: '' })))))
        .flatMap(r => String(r.out || '').split(/\r?\n/)).filter(x => /\.(exe|cmd|bat)$/i.test(x)).map(x => x.replace(/[\\/][^\\/]+$/, '').toLowerCase());
      const dir = cands.find(c => hits.includes(c.toLowerCase()));
      if (dir) return { dir: true, bin: dir };
    }
    const r = WIN
      ? await plugin.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', FIND_BIN_PS], { env, timeout: 15000 })
      : await plugin.exec('sh', ['-c', FIND_BIN_SH], { env, timeout: 15000 });
    const out = String(r.out || '').trim().split(/\r?\n/).pop() || '';
    return { dir: out !== 'NODIR', bin: out.startsWith('BIN:') ? out.slice(4) : null };
  },
});
// extensões que o plugin conhece (as do catálogo do motor)
const EXTS = new Set(R.langs.flatMap(l => l.exts));
// linguagens em que "Depurar" funciona (depurador da IDE, debug.js; o que falta instalar ele oferece na hora)
const DEBUG = new Set(['java', 'python', 'javascript', 'typescript', 'go', 'rust', 'c', 'cpp', 'csharp', 'ruby']);
const extOf = (p) => String(p || '').toLowerCase().split('/').pop().split('.').slice(1).pop() || '';
const known = (t) => t && t.mode === 'editor' && !t.virtual && t.model && (EXTS.has(extOf(t.path)) || !!R.lang(t.path));
const LEFT = () => bs.monaco.editor.GlyphMarginLane.Left;

// ---------- ▶ na margem ----------
const timers = new WeakMap();
function scanSoon(tab, ms = 450) {
  if (!known(tab)) return;
  clearTimeout(timers.get(tab));
  timers.set(tab, setTimeout(() => scan(tab), ms));
}
async function scan(tab) {
  if (!known(tab) || tab.model.isDisposed()) return;
  const ver = tab.model.getVersionId();
  let r; try { r = R.entries(tab.path, tab.model.getValue()); } catch { return; }
  if (tab.model.isDisposed() || tab.model.getVersionId() !== ver) return;
  const rt = tab._rt = tab._rt || { entries: [], decos: [] };
  rt.entries = r.entries || []; rt.lang = r.lang;
  const monaco = bs.monaco;
  rt.decos = tab.model.deltaDecorations(rt.decos, rt.entries.map(en => ({
    range: new monaco.Range(en.line, 1, en.line, 1),
    options: { glyphMarginClassName: 'rt-run', glyphMargin: { position: LEFT() }, glyphMarginHoverMessage: { value: `**Executar** \`${en.label}\` · Ctrl+Shift+F10  \nClique para executar, passar argumentos ou copiar o comando` }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
  })));
  if (S.active === tab && ctxKey) ctxKey.set(rt.entries.length > 0);
}
const entriesOf = (t) => (t && t._rt && t._rt.entries) || [];
// o main da linha do cursor, ou o último acima dela, ou o primeiro
function nearest(list, line) { return list.find(e => e.line === line) || [...list].reverse().find(e => e.line <= line) || list[0] || null; }
const argKey = (t, en) => t.project + '|' + t.path + '|' + (en ? en.target || en.label : '');

let ctxKey = null;
bs.hooks.on('editor:ready', (ed) => {
  const monaco = bs.monaco;
  ctxKey = ed.createContextKey('bsHasMain', false);
  const GM = monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
  ed.onMouseDown((e) => {
    if (e.target.type !== GM || !e.event.leftButton) return;
    const t = S.active; if (!t || !e.target.position) return;
    const onRun = (e.target.element && e.target.element.classList && e.target.element.classList.contains('rt-run')) || (e.target.detail && e.target.detail.glyphMarginLane === LEFT());
    if (!onRun) return;
    const en = entriesOf(t).find(x => x.line === e.target.position.lineNumber); if (!en) return;
    const be = e.event.browserEvent;
    // depois do mousedown do documento (que fecha os menus abertos)
    setTimeout(() => menu({ preventDefault() {}, stopPropagation() {}, clientX: be.clientX + 6, clientY: be.clientY + 4 }, t, en), 0);
  });
  ed.onDidChangeModelContent(() => { const t = S.active; if (t && t.model === ed.getModel()) scanSoon(t); });
  ed.addAction({ id: 'bs.runtimes.run', label: 'Executar o main', precondition: 'bsHasMain', contextMenuGroupId: 'navigation', contextMenuOrder: 2,
    run: () => runAtCursor() });
});
bs.hooks.on('tab:open', (t) => scanSoon(t, 50));
bs.hooks.on('tab:activate', (t) => { if (ctxKey) ctxKey.set(entriesOf(t).length > 0); if (known(t) && !t._rt) scanSoon(t, 0); checkSoon(t); });
bs.hooks.on('tab:save', (t) => scanSoon(t, 0));

function menu(ev, t, en) {
  const items = [
    { label: `Executar '${en.label}'`, k: 'Ctrl+Shift+F10', icon: ICO.play, action: () => run(t, en) },
    { label: 'Executar com argumentos…', icon: ICO.args, action: () => askArgs(t, en) },
  ];
  if (bs.debug && DEBUG.has(t.lang)) items.push({ label: `Depurar '${en.label}'`, k: 'Shift+F9', icon: ICO.bug, action: () => debug(t, en) });
  items.push('-', { label: 'Copiar o comando', icon: ICO.copy, action: () => copyCommand(t, en) });
  bs.showMenu(ev, items, en.label);
}

// ---------- executar ----------
async function run(t, en, args) {
  if (!S.project || !t) return;
  if (args == null) args = store.get('rtArgs', {})[argKey(t, en)] || '';
  if (t.dirty && S.active === t) await bs.save();
  let r;
  try { r = await R.plan(t.project, t.path, en ? en.line : 0, args); }
  catch (e) { toast(e.message); return; }
  if (r.missing) { needDialog(r, () => run(t, en, args)); return; }
  if (r.fallback || !r.plan) { if (bs.build && bs.build.runFile) bs.build.runFile(); return; }
  if (!bs.build || !bs.build.runSteps) { toast('O console de Build não está disponível'); return; }
  await bs.build.runSteps({ title: r.plan.title, steps: r.plan.steps, jdk: r.plan.jdk });
}
function runAtCursor() {
  const t = S.active; if (!t) return;
  const line = (bs.editor && bs.editor.getPosition() && bs.editor.getPosition().lineNumber) || 1;
  return run(t, nearest(entriesOf(t), line));
}
async function copyCommand(t, en) {
  try {
    const r = await R.plan(t.project, t.path, en.line, store.get('rtArgs', {})[argKey(t, en)] || '');
    if (!r.plan) return toast(r.missing ? 'Falta instalar: ' + r.missing.map(m => m.name).join(', ') : 'Sem comando próprio: o arquivo roda pela extensão (Ctrl+Shift+F10)');
    const q = (a) => /[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a;
    bs.copyText(r.plan.steps.map(s => (s.kind === 'maven' ? 'mvn' : q(s.program)) + ' ' + s.args.map(q).join(' ')).join('\n'));
  } catch (e) { toast(e.message); }
}
function askArgs(t, en) {
  const all = store.get('rtArgs', {}); const cur = all[argKey(t, en)] || '';
  dialog('rtArgsDlg', `<div class="dlg-hd"><span class="dlg-ic">${ICO.args}</span><div><h3>Executar ${esc(en.label)}</h3><p>Argumentos do programa (ficam guardados para as próximas execuções deste main).</p></div></div>
    <form class="rt-args" id="rtArgsF"><input id="rtArgsIn" value="${esc(cur)}" placeholder='ex.: entrada.txt --verbose "com espaço"' spellcheck="false" autocomplete="off">
    <div class="rt-dlg-go"><button type="button" class="chip" data-close>Cancelar</button><button class="chip primary">${ICO.play}Executar</button></div></form>`,
    (el) => {
      const inp = el.querySelector('#rtArgsIn'); setTimeout(() => { inp.focus(); inp.select(); }, 30);
      el.querySelector('#rtArgsF').onsubmit = (e) => {
        e.preventDefault(); const v = inp.value.trim(); const a = store.get('rtArgs', {});
        if (v) a[argKey(t, en)] = v; else delete a[argKey(t, en)];
        store.set('rtArgs', a); el.hidden = true; run(t, en, v);
      };
    });
}
// ---------- depurar ----------
// O plano de execução é o mesmo do Executar; muda como ele roda:
// - Java: o programa roda no console do Build com o agente JDWP (javac/java, Maven exec:java, Gradle bsRun) e o
//   java-debug (plugin do jdtls, o mesmo do VS Code) se liga nele. Entrada do programa continua no console.
// - Ruby: o mesmo, com o rdbg abrindo a porta junto do programa.
// - C, C++ e Rust (rustc / cargo): compila no console do Build e o LLDB abre o executável.
// - Python (debugpy), JavaScript/TypeScript (js-debug) e Go (Delve): o depurador abre o programa com os mesmos
//   interpretador, argumentos, pasta e ambiente do Executar.
// - C#: o caminho de sempre do debug.js (pergunta a .dll).
const freePort = () => 20000 + Math.floor(Math.random() * 40000);
const isProg = (p, n) => String(p || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '') === n;
// lê o console de uma execução até achar `re` (devolve o match) ou ela acabar (devolve o estado, ou null com re)
async function waitRun(id, re, ms = 300000) {
  let from = 0; const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let r; try { r = await api('build/read', { id, from }); } catch { return null; }
    for (const l of r.lines || []) { const m = re && re.exec(l); if (m) return m; }
    from = r.from + (r.lines || []).length;
    if (r.status !== 'running') return re ? null : r.status;
    await new Promise(ok => setTimeout(ok, 200));
  }
  return null;
}
async function planFor(t, en, args) {
  let r;
  try { r = await R.plan(t.project, t.path, en ? en.line : 0, args); }
  catch (e) { toast(e.message); return null; }
  if (r.missing) { needDialog(r, () => debug(t, en)); return false; }
  return r.plan || null;
}
async function debug(t, en) {
  if (!S.project || !t || !bs.debug) return;
  if (t.dirty) await bs.save();
  if (bs.debug.session()) await bs.debug.stop();
  const userArgs = store.get('rtArgs', {})[argKey(t, en)] || '';
  const title = `Depurar ${en ? en.label : t.path.split('/').pop()}`;
  // sem plano próprio (ou C#): o caminho de sempre do debug.js
  const plain = () => bs.debug.start(t, {}); // com o: {} o debug.js não chama o lançador de novo
  if (t.lang === 'csharp') return plain();
  const plan = await planFor(t, en, userArgs); if (plan === false) return; if (!plan) return plain();
  const steps = plan.steps.map(x => ({ ...x, args: [...(x.args || [])], env: { ...(x.env || {}) } }));
  const last = steps[steps.length - 1];
  const B = bs.build;
  const runInConsole = async (st, tt) => { const id = B && B.runSteps ? await B.runSteps({ title: tt, steps: st, jdk: plan.jdk }) : null; if (!id) toast('O console de Build não está disponível'); return id; };
  switch (t.lang) {
    case 'java': {
      const jd = await bs.debug.need('java-debug'); if (!jd) return;
      // o programa espera parado o depurador se ligar (suspend=y)
      const port = freePort(), agent = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`;
      if (last.kind === 'maven') last.env.MAVEN_OPTS = ((last.env.MAVEN_OPTS || '') + ' ' + agent).trim();
      else if (last.args.some(a => /:bsRun$/.test(a))) last.args.push('--debug-jvm'); // Gradle: porta 5005
      else if (isProg(last.program, 'java')) last.args.unshift(agent);
      else { toast('Este projeto roda por ' + (last.label || last.program).split(' ')[0] + ': a depuração de Java funciona com javac/java, Maven e Gradle'); return; }
      const dap = await javaDap(t); if (!dap) return;
      const id = await runInConsole(steps, title); if (!id) return;
      const m = await waitRun(id, /Listening for transport dt_socket at address: ?(?:[\d.]+:)?(\d+)/);
      if (!m) { toast('O programa não chegou a esperar o depurador (veja o console do Build)'); return; }
      return bs.debug.start(t, { tool: 'java-debug', params: { port: dap }, request: 'attach', title, args: { type: 'java', request: 'attach', name: title, hostName: '127.0.0.1', port: +m[1], timeout: 30000,
        // F7 não entra no JDK nem em código gerado (como o IntelliJ): System.out.println passa direto
        stepFilters: { classNameFilters: ['java.*', 'javax.*', 'jdk.*', 'sun.*', 'com.sun.*', 'junit.*', 'org.junit.*'], skipSynthetics: true, skipStaticInitializers: true, skipConstructors: false } } });
    }
    case 'ruby': {
      if (!await bs.debug.need('rdbg')) return;
      const port = freePort();
      const st = { ...last, program: 'rdbg', args: ['--open', `--port=${port}`, '--host=127.0.0.1', '--command', '--', last.program, ...last.args], label: `rdbg ${last.label}` };
      const id = await runInConsole([...steps.slice(0, -1), st], title); if (!id) return;
      if (!await waitRun(id, /Debugger can attach via TCP\/IP|wait for debugger connection/i)) { toast('O rdbg não abriu a porta (veja o console do Build)'); return; }
      return bs.debug.start(t, { tool: 'rdbg', params: { port }, request: 'attach', title, args: { type: 'rdbg', request: 'attach', name: title } });
    }
    case 'c': case 'cpp': case 'rust': {
      const tool = await bs.debug.need(t.lang); if (!tool) return;
      let build = steps.slice(0, -1), program = last.program, args = last.args, cwd = last.cwd;
      if (isProg(last.program, 'cargo')) {
        // cargo run -> cargo build; o executável fica em target/debug (exemplos em target/debug/examples)
        const a = last.args, cut = a.indexOf('--'), sel = a.slice(1, cut < 0 ? a.length : cut);
        args = cut < 0 ? [] : a.slice(cut + 1);
        build = [{ ...last, args: ['build', ...sel], label: 'cargo build ' + sel.join(' ') }];
        const bin = sel[sel.indexOf('--bin') + 1], ex = sel[sel.indexOf('--example') + 1];
        program = sel.includes('--bin') ? `${cwd}/target/debug/${bin}.exe` : sel.includes('--example') ? `${cwd}/target/debug/examples/${ex}.exe` : null;
      } else if (isProg(build[0] && build[0].program, 'rustc')) build[0].args.push('-g');
      if (build.length) {
        const id = await runInConsole(build, 'Compilar para depurar'); if (!id) return;
        if (await waitRun(id, null) !== 'ok') { toast('A compilação falhou (veja o console do Build)'); return; }
      }
      if (!program) return plain(); // cargo sem --bin: pergunta o executável (debug.js)
      const cfg = tool.id === 'codelldb' ? { type: 'lldb', request: 'launch', program, args, cwd } : { request: 'launch', program, args, cwd, stopOnEntry: false };
      return bs.debug.start(t, { tool: tool.id, title, args: cfg });
    }
    case 'python': {
      const tool = await bs.debug.need('python'); if (!tool) return;
      let a = last.args.filter(x => x !== '-u'); const pi = a.indexOf('python');
      if (pi >= 0 && !/python/i.test(last.program)) a = a.slice(pi + 1); // uv run python / poetry run python
      const mi = a.indexOf('-m');
      const target = mi >= 0 ? { module: a[mi + 1], args: a.slice(mi + 2) } : { program: a[0], args: a.slice(1) };
      // .venv do projeto: o programa roda com o Python dele (uv/poetry/py ficam com o Python do debugpy)
      const python = /python(\.exe)?$/i.test(last.program) && /[\\/]/.test(last.program) ? last.program : undefined;
      return bs.debug.start(t, { tool: tool.id, title, args: { type: 'python', request: 'launch', name: title, ...target, python, cwd: last.cwd, env: last.env, console: 'internalConsole', justMyCode: true, redirectOutput: true } });
    }
    case 'javascript': case 'typescript': {
      const tool = await bs.debug.need('js-debug'); if (!tool) return;
      const f = last.args.find(x => /\.[cm]?[jt]sx?$/i.test(x)) || ''; const rest = last.args.slice(last.args.indexOf(f) + 1);
      const rt = isProg(last.program, 'node') ? {} : isProg(last.program, 'npx') ? { runtimeExecutable: last.program, runtimeArgs: last.args.slice(0, last.args.indexOf(f)) }
        : isProg(last.program, 'tsx') ? { runtimeExecutable: last.program } : null;
      if (!rt) { toast('O js-debug depura programas do Node.js (este roda por ' + last.program + ')'); return; }
      return bs.debug.start(t, { tool: tool.id, title, args: { type: 'pwa-node', request: 'launch', name: title, program: f, args: rest, cwd: last.cwd, env: last.env, console: 'internalConsole', outputCapture: 'std', skipFiles: ['<node_internals>/**'], ...rt } });
    }
    case 'go': {
      const tool = await bs.debug.need('go'); if (!tool) return;
      const a = last.args; // run <arquivo|.> [args]
      const program = a[1] === '.' ? last.cwd : a[1];
      return bs.debug.start(t, { tool: tool.id, title, args: { request: 'launch', mode: 'debug', program, args: a.slice(2), cwd: last.cwd } });
    }
    default: return plain();
  }
}
// porta DAP do java-debug: o jdtls precisa ter subido com o plugin (senão reinicia com ele)
async function javaDap(t) {
  const L = bs.lsp; let c = L && await L.clientFor(t).catch(() => null);
  if (!c) { toast('A depuração de Java precisa do jdtls (servidor de linguagem do Java) ligado'); return null; }
  if (!(c.bundles || []).length) {
    toast('Reiniciando o jdtls com o depurador…');
    const tools = await L.tools(true); const jt = tools.find(x => x.id === 'jdtls');
    await L.restart(jt, t.project); c = await L.clientFor(t).catch(() => null);
    if (!c || !(c.bundles || []).length) { toast('O jdtls não carregou o plugin de depuração'); return null; }
  }
  try { return await c.request('workspace/executeCommand', { command: 'vscode.java.startDebugSession', arguments: [] }, 60000); }
  catch (e) { toast('O jdtls não abriu o depurador: ' + e.message); return null; }
}
// Shift+F9 e "Depurar este arquivo": o main mais perto do cursor; arquivo sem main segue o caminho de sempre
for (const l of DEBUG) if (l !== 'csharp') bs.debug && (bs.debug.launchers[l] = (t) => {
  if (!known(t) || !S.project || t.project !== S.project.path) return false;
  const list = entriesOf(t); if (!list.length) return false;
  const line = (bs.editor && bs.editor.getPosition() && bs.editor.getPosition().lineNumber) || 1;
  return debug(t, nearest(list, line));
});

// Ctrl+Shift+F10: o main mais perto do cursor; arquivo sem main nem runtime faltando segue o "Executar arquivo" do núcleo
const prevRun = bs.keys.map.get('Ctrl+Shift+F10');
bs.keys.add('Ctrl+Shift+F10', () => {
  const t = S.active;
  if (known(t) && S.project && t.project === S.project.path) { runAtCursor(); return; }
  return prevRun ? prevRun() : false;
});

// ---------- o que falta instalar ----------
const CHECK = new Map(); // projeto|linguagem -> { at, r }
const dismissed = () => new Set(store.get('rtDismiss', []));
const dkey = (n) => (S.project ? S.project.path : '') + '|' + n.id;
let checkTimer = null;
function checkSoon(t) { clearTimeout(checkTimer); checkTimer = setTimeout(() => check(t), 250); }
async function check(t, fresh) {
  t = t || S.active;
  if (!known(t) || !S.project || t.project !== S.project.path) { banner(null); status(null); return; }
  const k = t.project + '|' + extOf(t.path);
  let c = CHECK.get(k);
  if (!c || fresh || Date.now() - c.at > 60e3) {
    try { c = { at: Date.now(), r: await R.check(t.project, t.path) }; CHECK.set(k, c); } catch { return; }
  }
  if (S.active !== t) return;
  status(c.r);
  const nv = dismissed();
  banner(c.r.lang ? { ...c.r, needs: c.r.needs.filter(n => !n.ok && !nv.has(dkey(n))) } : null);
}
function recheckAll() { CHECK.clear(); return R.forget().catch(() => {}).then(() => { check(S.active, true); if (!$dlg().hidden) renderDialog(); }); }
bs.hooks.on('sdk:installed', () => recheckAll());
bs.hooks.on('project:select', () => { CHECK.clear(); banner(null); status(null); });

// texto do problema de um requisito
function problem(n, langName) {
  if (n.status === 'old') return { title: `${n.name} ${n.need ? n.need.version + ' ou mais novo' : 'mais novo'}`, text: `${n.need ? `O projeto pede ${esc(n.name)} ${esc(n.need.version)} (${esc(n.need.source)})` : 'Versão antiga'}, mas o encontrado é o ${esc(n.version || '?')}.` };
  const why = [langName ? `Necessário para compilar e executar ${esc(langName)}` : 'Necessário', n.need ? ` (o projeto pede ${esc(n.need.version)}, em ${esc(n.need.source)})` : ''].join('');
  return { title: `${n.name} não encontrado`, text: `${why}.${n.alts && n.alts.length ? ` Também serve: ${n.alts.map(esc).join(', ')}.` : ''}` };
}
const sdkLabel = (n) => {
  const nm = bs.sdk ? bs.sdk.name(n.sdk) : n.sdk;
  if (n.sdk === 'zig' && n.id !== 'zig') return 'Baixar Zig (compila C/C++)';
  return `Baixar ${n.id === 'jdk' ? 'JDK' : nm}${n.need ? ' ' + n.need.version : ''}`;
};
// botões das ações de um requisito
function actions(n, pm) {
  const b = [];
  if (n.sdk && bs.sdk) {
    b.push(`<button class="chip primary" data-a="dl">${ICO.dl}<span>${esc(sdkLabel(n))}</span></button>`);
    b.push(`<button class="chip" data-a="versions" title="Escolher fornecedor e versão">Outras versões…</button>`);
  }
  b.push(`<button class="chip" data-a="pick" title="Apontar a pasta de uma instalação que já existe">${ICO.folder}<span>Já tenho instalado…</span></button>`);
  if (n.winget && (!pm || pm.winget)) b.push(`<button class="chip" data-a="winget" title="winget install --id ${esc(n.winget)}">${ICO.term}<span>winget</span></button>`);
  if (n.scoop && pm && pm.scoop) b.push(`<button class="chip" data-a="scoop" title="scoop install ${esc(n.scoop)}">${ICO.term}<span>scoop</span></button>`);
  b.push(`<a class="chip" href="${esc(n.url)}" target="_blank" rel="noopener" title="${esc(n.url)}">${ICO.ext}<span>Página oficial</span></a>`);
  return b.join('');
}
// liga os botões de um bloco às ações; onDone depois de instalar/apontar
function bindActions(el, n, onDone) {
  const prog = el.querySelector('.rt-prog'), step = prog && prog.querySelector('.rt-step'), fill = prog && prog.querySelector('i');
  const busy = (on) => el.querySelectorAll('button').forEach(x => { if (x.dataset.a) x.disabled = on; });
  const show = (j) => { if (!prog) return; prog.hidden = false; prog.classList.toggle('indet', j.progress == null); if (fill) fill.style.width = j.progress == null ? '' : Math.round(j.progress * 100) + '%'; if (j.step && step) step.textContent = j.step; };
  el.querySelectorAll('[data-a]').forEach(btn => btn.onclick = async () => {
    const a = btn.dataset.a;
    if (a === 'versions') return bs.sdk.open(n.sdk);
    if (a === 'winget' || a === 'scoop') {
      const cmd = a === 'winget' ? `winget install --id ${n.winget} -e --accept-source-agreements --accept-package-agreements` : `scoop install ${n.scoop}`;
      try { await bs.terminal.run(cmd); toast('Instalando no terminal. Quando terminar, clique em "Verificar de novo".'); el.classList.add('rt-waiting'); } catch (e) { toast('Terminal: ' + e.message); }
      return;
    }
    if (a === 'pick') {
      let r; try { r = await api('project/pick', { title: `Pasta do ${n.name}`, start: n.path ? n.path.replace(/[\\/][^\\/]*$/, '') : null }); } catch (e) { return toast(e.message); }
      if (!r || !r.path) return;
      busy(true);
      try {
        const s = await R.select(n.id, r.path);
        toast(`${n.name}${s.version ? ' ' + s.version : ''}: ${s.path}`, 'ok');
        bs.hooks.run('sdk:installed', n.sdk || n.id);
        if (bs.lsp && bs.lsp.refresh) bs.lsp.refresh().catch(() => {});
        onDone && onDone();
      } catch (e) { toast(e.message); }
      busy(false);
      return;
    }
    if (a === 'dl') {
      busy(true); show({ step: 'Procurando a versão…' });
      const min = n.need ? (n.id === 'jdk' ? parseInt(n.need.version, 10) : parseFloat(n.need.version)) : undefined;
      try {
        const p = await bs.sdk.quick(n.sdk, { min: isNaN(min) ? undefined : min, onStep: show });
        toast(`${bs.sdk.name(n.sdk)} ${p.vendor_name ? p.vendor_name + ' ' : ''}${p.version} instalado`, 'ok');
        // um JDK baixado só vira o padrão quando escolhido: aqui ele foi pedido para este projeto, então vira
        if (n.sdk === 'jdk') { try { const k = await api('sdk/list'); const j = k.kinds.find(x => x.id === 'jdk'); const it = j && j.installed.find(x => x.path.toLowerCase().endsWith(p.dir.toLowerCase())); if (it) await api('sdk/default', { kind: 'jdk', path: it.path }, { method: 'POST' }); } catch {} }
        onDone && onDone();
      } catch (e) { show({ step: e.message, progress: null }); if (prog) prog.classList.add('err'); }
      busy(false);
    }
  });
}

// aviso no canto de cima do editor (como o de "mudou fora da IDE")
const ban = document.createElement('div'); ban.id = 'rtBanner'; ban.hidden = true; ban.setAttribute('role', 'alert');
document.getElementById('mon').appendChild(ban);
function banner(r) {
  if (!r || !r.needs || !r.needs.length) { ban.hidden = true; ban.innerHTML = ''; return; }
  const n = r.needs[0];
  const p = problem(n, r.name);
  ban.className = n.status === 'old' ? 'old' : '';
  ban.innerHTML = `<span class="rt-bi">${ICO.warn}</span>
    <div class="rt-bt"><b>${esc(p.title)}</b><span>${p.text}${r.needs.length > 1 ? ` <a data-more>e mais ${r.needs.length - 1}</a>` : ''}</span>
      <div class="rt-prog" hidden><div class="rt-bar"><i></i></div><span class="rt-step"></span></div></div>
    <div class="rt-ba">${actions(n, r.pm)}<button class="chip" data-recheck title="Depois de instalar por fora">${ICO.refresh}<span>Verificar de novo</span></button>
    <button class="icon-btn" data-dismiss title="Não avisar neste projeto">${ICO.x}</button></div>`;
  ban.hidden = false;
  bindActions(ban, n, () => recheckAll());
  ban.querySelector('[data-recheck]').onclick = () => recheckAll();
  ban.querySelector('[data-more]')?.addEventListener('click', () => openDialog());
  ban.querySelector('[data-dismiss]').onclick = () => { const d = dismissed(); r.needs.forEach(x => d.add(dkey(x))); store.set('rtDismiss', [...d]); banner(null); toast('Sem aviso neste projeto. Os runtimes continuam na status bar.'); };
}
// janela quando se tenta executar sem o runtime
function needDialog(r, retry) {
  const rows = r.missing.map((n, i) => { const p = problem(n, r.name); return `<div class="rt-need" data-i="${i}"><div class="rt-nt"><span class="rt-st ${n.status}">${ICO.warn}</span><div><b>${esc(p.title)}</b><span>${p.text}</span>${n.note ? `<small>${esc(n.note)}</small>` : ''}</div></div>
    <div class="rt-na">${actions(n, r.pm)}</div><div class="rt-prog" hidden><div class="rt-bar"><i></i></div><span class="rt-step"></span></div></div>`; }).join('');
  const el = dialog('rtNeedDlg', `<div class="dlg-hd"><span class="dlg-ic">${ICO.rt}</span><div><h3>Falta instalar para executar ${esc(r.name || '')}</h3><p>Baixe pela IDE (sem instalador e sem administrador), escolha outra versão ou aponte uma instalação que já existe.</p></div></div>
    <div class="rt-needs">${rows}</div><div class="rt-dlg-go"><button class="chip" data-close>Fechar</button><button class="chip" id="rtRe">${ICO.refresh}Verificar de novo</button><button class="chip primary" id="rtRetry">${ICO.play}Executar</button></div>`);
  r.missing.forEach((n, i) => bindActions(el.querySelector(`.rt-need[data-i="${i}"]`), n, () => { el.querySelector(`.rt-need[data-i="${i}"]`).classList.add('done'); recheckAll(); }));
  el.querySelector('#rtRe').onclick = () => recheckAll().then(() => toast('Verificado'));
  el.querySelector('#rtRetry').onclick = async () => { el.hidden = true; await R.forget().catch(() => {}); retry(); };
}

// ---------- status bar e janela do projeto ----------
const st = bs.status.add({ id: 'stRt', title: 'Runtime da linguagem (clique: runtimes do projeto)', onclick: () => openDialog() });
function status(r) {
  if (!r || !r.lang || !r.needs || !r.needs.length) { st.hidden = true; return; }
  const bad = r.needs.find(n => !n.ok);
  const main = bad || r.needs[0];
  st.hidden = false;
  st.className = 's rt-s' + (bad ? ' bad' : '');
  const ver = main.version ? ' ' + main.version : '';
  st.innerHTML = bad ? `${ICO.warn}<span>${esc(bad.status === 'old' ? `${bad.name}${ver} (pede ${bad.need ? bad.need.version : '?'})` : 'sem ' + bad.name)}</span>` : `<span>${esc(main.name.replace(/ \(JDK\)$/, '') + ver)}</span>`;
  st.title = r.needs.map(n => `${n.name}: ${n.ok ? (n.version || 'ok') + (n.path ? ' · ' + n.path : '') : n.status === 'old' ? 'versão antiga' : 'não encontrado'}`).join('\n') + '\n\nClique: runtimes do projeto';
}
const $dlg = () => document.getElementById('rtDlg') || { hidden: true };
function openDialog() {
  if (!S.project) return toast('Abra um projeto');
  dialog('rtDlg', `<div class="dlg-hd"><span class="dlg-ic">${ICO.rt}</span><div><h3>Runtimes do projeto</h3><p>O que cada linguagem de ${esc(S.project.name)} precisa para compilar e executar, e a versão que o projeto pede.</p></div></div>
    <div class="rt-list" id="rtList"><div class="empty"><span class="spin"></span> Procurando as linguagens…</div></div>
    <div class="rt-dlg-go"><button class="chip" id="rtSdks">SDKs e runtimes…</button><span class="spacer"></span><button class="chip" id="rtRe2">${ICO.refresh}Verificar de novo</button><button class="chip primary" data-close>Fechar</button></div>`,
    (el) => { el.querySelector('.dlg-box').classList.add('rt-box'); el.querySelector('#rtRe2').onclick = () => recheckAll(); el.querySelector('#rtSdks').onclick = () => bs.sdk && bs.sdk.open(); });
  renderDialog();
}
async function renderDialog() {
  const box = document.getElementById('rtList'); if (!box || !S.project) return;
  let r; try { r = await R.project(S.project.path); } catch (e) { box.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; return; }
  if (!r.langs.length) { box.innerHTML = '<div class="empty">Nenhum código de linguagem conhecida neste projeto.</div>'; return; }
  const rows = [];
  r.langs.forEach((l, li) => l.needs.forEach((n, ni) => rows.push({ l, n, key: li + '-' + ni })));
  box.innerHTML = r.langs.map((l, li) => `<div class="rt-lang"><div class="rt-lh"><b>${esc(l.name)}</b><span>${l.files} arquivo${l.files === 1 ? '' : 's'}</span></div>
    ${l.needs.map((n, ni) => `<div class="rt-row ${n.ok ? 'ok' : n.status}" data-k="${li}-${ni}">
      <span class="rt-st ${n.ok ? 'ok' : n.status}">${n.ok ? ICO.ok : ICO.warn}</span>
      <div class="rt-nm"><b>${esc(n.name)}${n.version ? ' <em>' + esc(n.version) + '</em>' : ''}</b>
        <small>${n.ok ? esc(n.path || '') : esc(problem(n, l.name).text.replace(/<[^>]+>/g, ''))}${n.need ? ` · pede ${esc(n.need.version)} (${esc(n.need.source)})` : ''}</small>
        ${n.id === 'jdk' && n.jdks && n.jdks.length > 1 ? `<label class="rt-jdk">JDK padrão da IDE <select data-jdk>${n.jdks.map(j => `<option value="${esc(j.home)}" ${j.home === n.path ? 'selected' : ''}>${esc((j.major || '?') + ' · ' + j.name)}</option>`).join('')}</select></label>` : ''}
        <div class="rt-prog" hidden><div class="rt-bar"><i></i></div><span class="rt-step"></span></div></div>
      <div class="rt-na">${n.ok ? `<button class="chip" data-a="pick" title="Usar outra instalação">${ICO.folder}<span>Trocar…</span></button>${n.sdk && bs.sdk ? `<button class="chip" data-a="versions">Versões…</button>` : ''}` : actions(n, r.pm)}</div></div>`).join('')}</div>`).join('');
  for (const x of rows) {
    const row = box.querySelector(`.rt-row[data-k="${x.key}"]`); if (!row) continue;
    bindActions(row, x.n, () => recheckAll());
    row.querySelector('[data-jdk]')?.addEventListener('change', async (e) => {
      try { await api('sdk/default', { kind: 'jdk', path: e.target.value }, { method: 'POST' }); toast('JDK padrão trocado', 'ok'); bs.hooks.run('sdk:installed', 'jdk'); } catch (er) { toast(er.message); }
    });
  }
}
bs.actions.add([
  { label: 'Runtimes do projeto…', k: '', icon: ICO.rt, run: () => openDialog() },
  { label: 'Executar o main deste arquivo', k: 'Ctrl+Shift+F10', icon: ICO.play, run: () => runAtCursor() },
  { label: 'Executar o main com argumentos…', k: '', icon: ICO.args, run: () => { const t = S.active; const en = t && nearest(entriesOf(t), (bs.editor && bs.editor.getPosition() && bs.editor.getPosition().lineNumber) || 1); if (en) askArgs(t, en); else toast('Este arquivo não tem main'); } },
]);
bs.dashboard.action({ label: 'Runtimes', icon: ICO.rt, title: 'O que cada linguagem do projeto precisa instalado', go: () => openDialog() });
// abas já abertas quando o plugin liga
setTimeout(() => { for (const t of S.tabs || []) scanSoon(t, 0); if (S.active) check(S.active); }, 600);

// ---------- motor ----------
// O que antes era o servidor em Rust (langs.rs, require.rs, entries.rs, plan.rs e bin/server.rs), com as mesmas
// respostas: o que cada linguagem precisa instalado (TOOLS, LANGS), a versão que o projeto pede (need), os pontos de
// entrada de um arquivo (find) e como executá-los (plan). Do PC, pergunta ao núcleo por `io` (sdk/which, sdk/jdks,
// sdk/mavens, plugin.exec); do projeto, file/stat, file, tree e index. Entre as marcas não há DOM nem `bs`:
// tests/motor.test.js roda este trecho no Node com um `io` que lê o disco de verdade.
// >>> motor
function runtimesCore(io) {
  const WIN = !!io.win, SEP = WIN ? '\\' : '/';

  // ---------- catálogo ----------
  // `progs` provam que a ferramenta está no PC (basta um); `sdk` é o tipo que o núcleo baixa sozinho (janela SDKs);
  // `winget`/`scoop`, o comando que instala pelo gerenciador do Windows; `url`, a página oficial
  const t = (id, name, progs, versionArgs, sdk, winget, scoop, url, note) => ({ id, name, progs, versionArgs, sdk, winget, scoop, url, note });
  const TOOLS = [
    t('jdk', 'Java (JDK)', ['javac'], [], 'jdk', 'EclipseAdoptium.Temurin.21.JDK', null, 'https://adoptium.net/', 'Só o JRE não compila: precisa do JDK (tem o javac).'),
    t('node', 'Node.js', ['node'], ['--version'], 'node', 'OpenJS.NodeJS.LTS', 'nodejs-lts', 'https://nodejs.org/', ''),
    t('deno', 'Deno', ['deno'], ['--version'], null, 'DenoLand.Deno', 'deno', 'https://deno.com/', ''),
    t('bun', 'Bun', ['bun'], ['--version'], null, 'Oven-sh.Bun', 'bun', 'https://bun.sh/', ''),
    t('python', 'Python', ['python', 'py', 'python3'], ['--version'], 'python', 'Python.Python.3.13', 'python', 'https://www.python.org/downloads/', 'O python.exe da Microsoft Store (atalho em WindowsApps) não conta: ele só abre a loja.'),
    t('go', 'Go', ['go'], ['version'], 'go', 'GoLang.Go', 'go', 'https://go.dev/dl/', ''),
    t('rust', 'Rust', ['cargo', 'rustc'], ['--version'], 'rust', 'Rustlang.Rustup', 'rustup', 'https://rustup.rs/', 'No Windows o Rust (MSVC) também precisa do Visual Studio Build Tools com C++ para o link.'),
    t('dotnet', '.NET SDK', ['dotnet'], ['--version'], 'dotnet', 'Microsoft.DotNet.SDK.9', 'dotnet-sdk', 'https://dotnet.microsoft.com/download', ''),
    t('kotlin', 'Kotlin', ['kotlinc'], [], 'kotlin', null, 'kotlin', 'https://kotlinlang.org/docs/command-line.html', 'Em projetos Gradle ou Maven o compilador vem pelo build; aqui é só para arquivos soltos.'),
    t('maven', 'Maven', ['mvn'], [], 'maven', null, 'maven', 'https://maven.apache.org/download.cgi', ''),
    t('gradle', 'Gradle', ['gradle'], [], 'gradle', null, 'gradle', 'https://gradle.org/install/', 'Projetos com gradlew não precisam: o wrapper baixa o Gradle certo.'),
    t('cc', 'Compilador C', ['gcc', 'clang'], ['--version'], 'zig', 'BrechtSanders.WinLibs.POSIX.UCRT', 'gcc', 'https://winlibs.com/', 'A IDE baixa o Zig, que compila C e C++ sozinho (zig cc), sem Visual Studio.'),
    t('cxx', 'Compilador C++', ['g++', 'clang++'], ['--version'], 'zig', 'BrechtSanders.WinLibs.POSIX.UCRT', 'gcc', 'https://winlibs.com/', 'A IDE baixa o Zig, que compila C e C++ sozinho (zig c++), sem Visual Studio.'),
    t('zig', 'Zig', ['zig'], ['version'], 'zig', 'zig.zig', 'zig', 'https://ziglang.org/download/', ''),
    t('ruby', 'Ruby', ['ruby'], ['--version'], null, 'RubyInstallerTeam.RubyWithDevKit.3.3', 'ruby', 'https://rubyinstaller.org/', ''),
    t('php', 'PHP', ['php'], ['--version'], null, null, 'php', 'https://windows.php.net/download/', ''),
    t('perl', 'Perl', ['perl'], ['-e', 'print $^V'], null, 'StrawberryPerl.StrawberryPerl', 'perl', 'https://strawberryperl.com/', ''),
    t('lua', 'Lua', ['lua', 'luajit', 'lua54'], ['-v'], null, null, 'lua', 'https://luabinaries.sourceforge.net/', ''),
    t('r', 'R', ['Rscript'], ['--version'], null, 'RProject.R', 'r', 'https://cran.r-project.org/bin/windows/base/', ''),
    t('julia', 'Julia', ['julia'], ['--version'], null, 'Julialang.Julia', 'julia', 'https://julialang.org/downloads/', ''),
    t('dart', 'Dart', ['dart'], ['--version'], null, null, 'dart', 'https://dart.dev/get-dart', 'O Flutter já traz o Dart.'),
    t('swift', 'Swift', ['swift'], ['--version'], null, 'Swift.Toolchain', null, 'https://www.swift.org/install/windows/', ''),
    t('scala', 'Scala', ['scala-cli', 'scala', 'sbt'], [], null, null, 'scala-cli', 'https://scala-cli.virtuslab.org/install', ''),
    t('groovy', 'Groovy', ['groovy'], [], null, null, 'groovy', 'https://groovy.apache.org/download.html', ''),
    t('clojure', 'Clojure', ['clojure', 'clj', 'lein'], [], null, null, 'leiningen', 'https://clojure.org/guides/install_clojure', ''),
    t('elixir', 'Elixir', ['elixir'], ['--version'], null, null, 'elixir', 'https://elixir-lang.org/install.html', 'O Elixir roda sobre o Erlang/OTP: instale os dois.'),
    t('erlang', 'Erlang/OTP', ['erl', 'escript'], [], null, 'Erlang.ErlangOTP', 'erlang', 'https://www.erlang.org/downloads', ''),
    t('haskell', 'Haskell (GHC)', ['runghc', 'ghc', 'stack'], ['--version'], null, null, 'ghc', 'https://www.haskell.org/ghcup/', ''),
    t('nim', 'Nim', ['nim'], ['--version'], null, null, 'nim', 'https://nim-lang.org/install_windows.html', ''),
    t('ocaml', 'OCaml', ['ocaml'], ['-version'], null, null, null, 'https://ocaml.org/install', ''),
    t('dlang', 'D', ['rdmd', 'dmd', 'ldc2'], ['--version'], null, null, 'dmd', 'https://dlang.org/download.html', ''),
    t('bash', 'Bash', ['bash'], ['--version'], null, 'Git.Git', 'git', 'https://git-scm.com/download/win', 'O Git para Windows traz o Bash (Git Bash).'),
    t('tex', 'LaTeX (latexmk)', ['latexmk'], ['--version'], null, 'MiKTeX.MiKTeX', null, 'https://miktex.org/download', ''),
  ];
  const tool = (id) => TOOLS.find(x => x.id === id) || null;
  // requisitos: cada um é uma lista de alternativas (basta uma); a primeira é a sugerida
  const l = (id, name, exts, needs) => ({ id, name, exts, needs });
  const LANGS = [
    l('java', 'Java', ['java'], [['jdk']]),
    l('kotlin', 'Kotlin', ['kt', 'kts'], [['jdk'], ['kotlin']]),
    l('scala', 'Scala', ['scala', 'sc'], [['jdk'], ['scala']]),
    l('groovy', 'Groovy', ['groovy', 'gvy'], [['jdk'], ['groovy']]),
    l('clojure', 'Clojure', ['clj', 'cljc'], [['jdk'], ['clojure']]),
    l('python', 'Python', ['py', 'pyw'], [['python']]),
    l('javascript', 'JavaScript', ['js', 'mjs', 'cjs', 'jsx'], [['node', 'deno', 'bun']]),
    l('typescript', 'TypeScript', ['ts', 'mts', 'cts', 'tsx'], [['node', 'deno', 'bun']]),
    l('go', 'Go', ['go'], [['go']]),
    l('rust', 'Rust', ['rs'], [['rust']]),
    l('csharp', 'C#', ['cs', 'csx'], [['dotnet']]),
    l('fsharp', 'F#', ['fs', 'fsx'], [['dotnet']]),
    l('vb', 'Visual Basic', ['vb'], [['dotnet']]),
    l('c', 'C', ['c'], [['cc', 'zig']]),
    l('cpp', 'C++', ['cpp', 'cc', 'cxx', 'c++'], [['cxx', 'zig']]),
    l('zig', 'Zig', ['zig'], [['zig']]),
    l('ruby', 'Ruby', ['rb'], [['ruby']]),
    l('php', 'PHP', ['php'], [['php']]),
    l('perl', 'Perl', ['pl', 'pm'], [['perl']]),
    l('lua', 'Lua', ['lua'], [['lua']]),
    l('r', 'R', ['r'], [['r']]),
    l('julia', 'Julia', ['jl'], [['julia']]),
    l('dart', 'Dart', ['dart'], [['dart']]),
    l('swift', 'Swift', ['swift'], [['swift']]),
    l('elixir', 'Elixir', ['ex', 'exs'], [['elixir'], ['erlang']]),
    l('erlang', 'Erlang', ['erl'], [['erlang']]),
    l('haskell', 'Haskell', ['hs'], [['haskell']]),
    l('nim', 'Nim', ['nim'], [['nim']]),
    l('ocaml', 'OCaml', ['ml'], [['ocaml']]),
    l('d', 'D', ['d'], [['dlang']]),
    l('shell', 'Shell', ['sh', 'bash'], [['bash']]),
    l('latex', 'LaTeX', ['tex'], [['tex']]),
    l('powershell', 'PowerShell', ['ps1'], []),
    l('batch', 'Batch', ['bat', 'cmd'], []),
    // pelo nome do arquivo (langOf): cada script do package.json é um ponto de execução
    l('npm', 'Scripts do package.json', [], [['node', 'bun']]),
  ];
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  // extensão como a do Rust: ".bashrc" não tem; "a.tar.gz" é "gz"
  const extOfName = (p) => { const n = baseName(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : null; };
  const langOf = (p) => { if (baseName(p).toLowerCase() === 'package.json') return LANGS.find(x => x.id === 'npm'); const e = extOfName(p); return e == null ? null : LANGS.find(x => x.exts.includes(e)) || null; };
  // todos os programas que o catálogo procura (uma consulta só ao núcleo)
  function allProgs() {
    const v = TOOLS.flatMap(x => x.progs).concat(['mvn', 'gradle', 'java', 'npx', 'tsx', 'sbt', 'lein', 'stack', 'bundle', 'scoop', 'winget', 'kotlin', 'flutter', 'npm', 'pnpm', 'yarn']);
    return [...new Set(v)].sort();
  }
  // Kotlin, Scala e Groovy dentro de um projeto Gradle/Maven/sbt não precisam do compilador solto: o build baixa o dele
  const needsFor = (lg, built) => lg.needs.filter(alts => !(built && ['kotlin', 'scala', 'groovy'].includes(alts[0])));

  // ---------- texto e caminhos ----------
  // as linhas como o str::lines do Rust (sem a vazia depois do último \n, sem o \r)
  function lines(s) { const a = String(s).split('\n'); if (a[a.length - 1] === '') a.pop(); return a.map(x => x.endsWith('\r') ? x.slice(0, -1) : x); }
  // caminhos do projeto são relativos, com "/" ("" é a raiz); absOf monta o caminho do PC
  const jn = (d, n) => d ? d + '/' + n : n;
  const parentOf = (r) => { const i = r.lastIndexOf('/'); return i < 0 ? '' : r.slice(0, i); };
  const under = (d, x) => x === '' || d === x || d.startsWith(x + '/');
  // pastas do arquivo até a raiz do projeto (a do arquivo primeiro)
  function upTo(dir) { const v = [dir]; while (dir) { dir = parentOf(dir); v.push(dir); } return v; }
  const trimSep = (p) => String(p).replace(/[\\/]+$/, '');
  const absOf = (root, r) => r ? trimSep(root) + SEP + r.split('/').join(SEP) : trimSep(root);
  const parentAbs = (p) => trimSep(p).replace(/[\\/][^\\/]*$/, '');
  function relOf(root, p) {
    let s = String(p || '').replace(/\\/g, '/');
    const r = trimSep(root).replace(/\\/g, '/');
    if (s.toLowerCase().startsWith(r.toLowerCase() + '/')) s = s.slice(r.length + 1);
    return s.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  }

  // Arquivos do projeto durante uma consulta: cada pergunta vai uma vez só ao núcleo, e as da cadeia de pastas vão
  // juntas num file/stat (warm)
  function projectFs(root) {
    const st = new Map(), rd = new Map(), ls = new Map();
    const fs = {
      root,
      abs: (r) => absOf(root, r),
      prefetch(rels) {
        const miss = [...new Set(rels)].filter(r => !st.has(r));
        if (!miss.length) return Promise.resolve();
        const p = Promise.resolve().then(() => io.stat(root, miss)).catch(() => ({}));
        for (const r of miss) st.set(r, p.then(m => !!(m && m[r])));
        return p.then(() => {});
      },
      isFile(r) { if (!st.has(r)) fs.prefetch([r]); return st.get(r); },
      read(r) { if (!rd.has(r)) rd.set(r, fs.isFile(r).then(ok => ok ? Promise.resolve().then(() => io.read(root, r)).catch(() => '') : '')); return rd.get(r); },
      // [{ name, dir }] da pasta, ou null se ela não existe
      list(r) { if (!ls.has(r)) ls.set(r, Promise.resolve().then(() => io.list(root, r)).catch(() => null)); return ls.get(r); },
      isDir: (r) => fs.list(r).then(x => x != null),
    };
    return fs;
  }
  // nomes que o motor procura em cada pasta da cadeia (do arquivo até a raiz)
  const CHAIN_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.sbt', '.java-version', '.sdkmanrc', '.tool-versions',
    '.nvmrc', '.node-version', 'package.json', '.python-version', 'pyproject.toml', 'runtime.txt', 'Pipfile', 'go.mod', 'rust-toolchain.toml', 'rust-toolchain', 'Cargo.toml',
    'global.json', '.ruby-version', 'Gemfile', 'composer.json', 'pubspec.yaml', 'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat', 'uv.lock', 'poetry.lock', '__init__.py',
    'build.zig', 'stack.yaml', 'deps.edn', 'project.clj'];
  const warm = (fs, dir) => fs.prefetch(upTo(dir).flatMap(d => CHAIN_FILES.map(n => jn(d, n))));

  // ---------- a versão que o projeto pede ----------
  // Procura da pasta do arquivo até a raiz do projeto (o mais perto vale). A versão é o mínimo: "21" aceita 21, 23 e 25.
  // "1.8" -> "8" (Java antigo); tira o "v" e espaços
  function normJava(v) { v = String(v).trim().replace(/^v+/, ''); if (v.startsWith('1.') && v.length > 2) v = v.slice(2); return v.split(/[.\-_+]/)[0] || ''; }
  // primeira versão numérica de uma faixa: ">=18.0.0" -> "18.0.0", "^3.10" -> "3.10", "~> 3.2" -> "3.2"
  const firstVersion = (s) => { const m = /(\d+(?:\.\d+){0,2})/.exec(s); return m ? m[1] : null; };
  function toolVersions(text, names) {
    for (const ln of lines(text)) { const [k, v] = ln.trim().split(/\s+/); if (names.includes(k) && v) return v; }
    return null;
  }
  const fromTv = async (fs, d, names, f = (x) => x) => { const v = toolVersions(await fs.read(jn(d, '.tool-versions')), names); const x = v && firstVersion(v); return x ? [f(x), '.tool-versions'] : null; };
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
  async function needIn(fs, toolId, d) {
    const rf = (n) => fs.read(jn(d, n));
    switch (toolId) {
      case 'jdk': {
        const pom = await rf('pom.xml');
        if (pom) for (const re of [/<maven\.compiler\.release>\s*([\d.]+)\s*</, /<release>\s*([\d.]+)\s*<\/release>/, /<java\.version>\s*([\d.]+)\s*</, /<maven\.compiler\.source>\s*([\d.]+)\s*</, /<maven\.compiler\.target>\s*([\d.]+)\s*</, /<source>\s*([\d.]+)\s*<\/source>/]) {
          const m = re.exec(pom); if (m) return [normJava(m[1]), 'pom.xml'];
        }
        for (const f of ['build.gradle.kts', 'build.gradle']) {
          const g = await rf(f); if (!g) continue;
          for (const re of [/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/, /jvmToolchain\(\s*(\d+)\s*\)/, /(?:sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_(\d+(?:_\d+)?)|['"]?([\d.]+)['"]?)/, /jvmTarget\.set\(\s*JvmTarget\.JVM_(\d+)/]) {
            const m = re.exec(g); if (m) return [normJava((m[1] ?? m[2] ?? '').replace(/_/g, '.')), f];
          }
        }
        const jv = (await rf('.java-version')).trim();
        if (jv) return [normJava(jv.split('-').pop()), '.java-version'];
        const sm = /^\s*java\s*=\s*([\d.]+)/m.exec(await rf('.sdkmanrc')); if (sm) return [normJava(sm[1]), '.sdkmanrc'];
        return fromTv(fs, d, ['java'], normJava);
      }
      case 'node': {
        for (const f of ['.nvmrc', '.node-version']) {
          const x = (await rf(f)).trim();
          if (x && !x.startsWith('lts') && !x.startsWith('node')) { const v = firstVersion(x); return v ? [v, f] : null; }
        }
        const pj = json(await rf('package.json'));
        const e = pj && pj.engines && pj.engines.node;
        if (typeof e === 'string') { const v = firstVersion(e); return v ? [v, 'package.json'] : null; }
        return fromTv(fs, d, ['nodejs', 'node']);
      }
      case 'python': {
        const pv = lines(await rf('.python-version'))[0]; const v1 = pv != null ? firstVersion(pv) : null; if (v1) return [v1, '.python-version'];
        const rp = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(await rf('pyproject.toml'));
        if (rp) {
          // ">=3.10,<4": o mínimo
          const spec = rp[1].split(',').find(p => p.includes('>=') || p.includes('~=') || p.includes('==') || p.trim().startsWith('^')) ?? rp[1];
          const v = firstVersion(spec); return v ? [v, 'pyproject.toml'] : null;
        }
        const rt = /python-(\d+\.\d+)/.exec(await rf('runtime.txt')); if (rt) return [rt[1], 'runtime.txt'];
        const pf = /python_version\s*=\s*["'](\d+\.\d+)/.exec(await rf('Pipfile')); if (pf) return [pf[1], 'Pipfile'];
        return fromTv(fs, d, ['python']);
      }
      case 'go': {
        const m = await rf('go.mod');
        const tc = /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(m); if (tc) return [tc[1], 'go.mod'];
        const g = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(m); return g ? [g[1], 'go.mod'] : null;
      }
      case 'rust': {
        const c = /channel\s*=\s*"(\d+\.\d+(?:\.\d+)?)"/.exec(await rf('rust-toolchain.toml')); if (c) return [c[1], 'rust-toolchain.toml'];
        const first = lines(await rf('rust-toolchain'))[0]; const tc = first != null ? first.trim() : '';
        if (/^\d/.test(tc)) return [tc, 'rust-toolchain'];
        const rv = /^\s*rust-version\s*=\s*"(\d+\.\d+(?:\.\d+)?)"/m.exec(await rf('Cargo.toml')); return rv ? [rv[1], 'Cargo.toml'] : null;
      }
      case 'dotnet': {
        const gj = json(await rf('global.json'));
        const s = gj && gj.sdk && gj.sdk.version;
        if (typeof s === 'string') { const x = firstVersion(s); return x ? [x, 'global.json'] : null; }
        // <TargetFramework>net8.0</TargetFramework> (ou net8.0-windows): precisa do SDK 8 ou mais novo
        let best = null;
        for (const e of (await fs.list(d)) || []) {
          if (!/.\.(csproj|fsproj|vbproj)$/.test(e.name)) continue;
          for (const c of (await fs.read(jn(d, e.name))).matchAll(/<TargetFrameworks?>([^<]+)</g)) {
            for (const tfm of c[1].split(';')) { const m = /^net(\d+)\.\d/.exec(tfm.trim()); if (m && +m[1] >= 5) best = Math.max(best ?? 0, +m[1]); }
          }
        }
        return best != null ? [String(best), 'csproj'] : null;
      }
      case 'ruby': {
        const rv = lines(await rf('.ruby-version'))[0]; const v1 = rv != null ? firstVersion(rv) : null; if (v1) return [v1, '.ruby-version'];
        const g = /^\s*ruby\s+['"]([^'"]+)['"]/m.exec(await rf('Gemfile')); if (g) { const v = firstVersion(g[1]); return v ? [v, 'Gemfile'] : null; }
        return fromTv(fs, d, ['ruby']);
      }
      case 'php': {
        const cj = json(await rf('composer.json'));
        const p = cj && cj.require && cj.require.php; const v = typeof p === 'string' ? firstVersion(p) : null;
        return v ? [v, 'composer.json'] : null;
      }
      case 'dart': { const m = /^\s*sdk\s*:\s*['"]?[>=^~ ]*(\d+\.\d+(?:\.\d+)?)/m.exec(await rf('pubspec.yaml')); return m ? [m[1], 'pubspec.yaml'] : null; }
      default: return null;
    }
  }
  // versão pedida para uma ferramenta do catálogo: { version, source } (source relativo ao projeto)
  async function need(fs, toolId, dir) {
    for (const d of upTo(dir)) { const r = await needIn(fs, toolId, d); if (r && r[0]) return { version: r[0], source: jn(d, r[1]) }; }
    return null;
  }
  // "21.0.2" atende "21"? "3.12.1" atende "3.11"? Compara só as partes pedidas (a versão pedida é o mínimo)
  function satisfies(found, want) {
    const nums = (s) => (String(s).match(/\d+/g) || []).map(Number);
    const f = nums(found), n = nums(want);
    if (!n.length || !f.length) return true;
    for (let i = 0; i < n.length; i++) { const a = f[i] || 0; if (a !== n[i]) return a > n[i]; }
    return true;
  }
  // versão de um texto de saída ("javac 21.0.2", "Python 3.12.1", "go version go1.22.1 windows/amd64", "v20.11.0")
  function parseVersion(out) { const m = /(?:go|v|version\s|\s|^)(\d+\.\d+(?:\.\d+)?(?:[-+._][0-9A-Za-z.]+)?)/.exec(out); return m ? m[1].replace(/[.,]+$/, '') : null; }

  // ---------- pontos de entrada ----------
  // Como o ▶ que o IntelliJ mostra na margem. Nas linguagens com chaves, comentários e textos são apagados antes (o main
  // dentro de um comentário não conta) e a profundidade das chaves diz em que classe o main está (classe aninhada vira
  // Externa$Interna, como na JVM).
  // Apaga comentários e conteúdo de textos (troca por espaços, mantém as quebras de linha). Caractere entre aspas
  // simples só conta com um caractere ou um escape ('a', '{', '\n'); no Rust, `'a` é tempo de vida.
  function clean(src, lang) {
    const b = Array.from(src), n = b.length, out = [];
    const triple = ['java', 'kotlin', 'scala', 'groovy', 'dart', 'swift'].includes(lang);
    const backtick = ['javascript', 'typescript', 'go'].includes(lang);
    const blank = (c) => out.push(c === '\n' ? '\n' : ' ');
    let i = 0;
    while (i < n) {
      const c = b[i], next = i + 1 < n ? b[i + 1] : '\0';
      if (c === '/' && next === '/') { while (i < n && b[i] !== '\n') { out.push(' '); i++; } continue; }
      if (c === '/' && next === '*') {
        out.push('  '); i += 2;
        while (i < n && !(b[i] === '*' && b[i + 1] === '/')) { blank(b[i]); i++; }
        if (i < n) { out.push('  '); i += 2; }
        continue;
      }
      if (triple && c === '"' && next === '"' && b[i + 2] === '"') {
        out.push('"""'); i += 3;
        while (i < n && !(b[i] === '"' && b[i + 1] === '"' && b[i + 2] === '"')) { blank(b[i]); i++; }
        if (i < n) { out.push('"""'); i += 3; }
        continue;
      }
      if (c === '"' || (backtick && c === '`')) {
        const q = c;
        // no Go, `...` é texto cru (sem escape); só o ` atravessa linhas
        const raw = q === '`' && lang === 'go';
        out.push(q); i++;
        while (i < n && b[i] !== q && (q === '`' || b[i] !== '\n')) {
          if (b[i] === '\\' && !raw) { out.push(' '); i++; if (i < n) { blank(b[i]); i++; } continue; }
          blank(b[i]); i++;
        }
        if (i < n && b[i] === q) { out.push(q); i++; }
        continue;
      }
      if (c === "'") {
        let end = null;
        if (next === '\\') { for (let j = i + 3; j < Math.min(n, i + 12); j++) if (b[j] === "'") { end = j; break; } }
        else if (next !== '\n' && next !== '\0' && b[i + 2] === "'") end = i + 2;
        if (end != null && !b.slice(i + 1, end).includes('\n')) {
          out.push("'"); for (let j = i + 1; j < end; j++) out.push(' '); out.push("'");
          i = end + 1;
          continue;
        }
      }
      out.push(c); i++;
    }
    return out.join('');
  }
  // nome do arquivo sem extensão
  const stem = (name) => baseName(name).split('.')[0];
  const qual = (pkg, name) => pkg ? `${pkg}.${name}` : name;
  // Varre o texto limpo; onde `main` casa, chama f(linha, texto da linha, pilha de tipos, profundidade) com a pilha
  // daquele ponto da linha. `sameLine`: a declaração sem `{` na mesma linha não tem corpo (Kotlin: `data class
  // P(val x: Int)`); no Java e no C# a chave pode vir embaixo. Cada tipo aberto: { name, depth, companion }.
  function walkTypes(cl, decl, main, sameLine, f) {
    let depth = 0, pending = null;
    const stack = [];
    lines(cl).forEach((line, n) => {
      // declarações da linha, pela posição onde terminam
      const decls = [...line.matchAll(decl)].map(c => ({ end: c.index + c[0].length, name: (c.groups && (c.groups.name ?? c.groups.cname)) || '', comp: !!(c.groups && c.groups.comp != null) }));
      const mm = main.exec(line), at = mm ? mm.index : -1;
      for (let idx = 0; idx < line.length; idx++) {
        if (at === idx) f(n + 1, line, stack, depth);
        const d = decls.find(x => x.end === idx); if (d) pending = { name: d.name, companion: d.comp };
        const ch = line[idx];
        if (ch === '{') { depth++; if (pending) { stack.push({ ...pending, depth }); pending = null; } }
        else if (ch === '}') { depth--; while (stack.length && stack[stack.length - 1].depth > depth) stack.pop(); }
        // declaração sem corpo (record de uma linha, typealias): não abre escopo
        else if (ch === ';') pending = null;
      }
      // a declaração termina no fim da linha (a chave vem embaixo)
      const last = decls[decls.length - 1]; if (last && last.end >= line.length) pending = { name: last.name, companion: last.comp };
      if (sameLine) pending = null;
    });
  }
  // binário (Externa$Interna) e legível (Externa.Interna)
  function jvmName(stack) { const names = stack.filter(s => !s.companion).map(s => s.name); return [names.join('$'), names.join('.')]; }
  // { line (1 = primeira), label (o que aparece no menu), target (classe da JVM/.NET, módulo do Clojure; sem ele, o
  // arquivo), instance (Java: main de instância ou fora de classe, Java 21+) }
  const entry = (line, label, target, instance) => { const e = { line, label }; if (target) e.target = target; if (instance) e.instance = true; return e; };
  // Pontos de entrada do texto de um arquivo (`file` dá o nome da classe implícita do Java e do FileKt do Kotlin)
  function find(lang, file, src) {
    const out = [];
    const name = baseName(file);
    const each = (text, re, mk) => lines(text).forEach((ln, i) => { if (re.test(ln)) out.push(mk(i + 1)); });
    const script = (comment, off) => { if (off) return; const i = lines(src).findIndex(x => x.trim() && !comment.test(x)); if (i >= 0) out.push(entry(i + 1, name, '')); };
    switch (lang) {
      case 'java': case 'groovy': {
        const cl = clean(src, lang);
        const pkg = (/^\s*package\s+([\w.]+)/m.exec(cl) || [])[1] || '';
        const decl = /\b(?:class|interface|enum|record)\s+(?<name>[A-Za-z_$][\w$]*)/g;
        const main = /(?<mods>(?:\b(?:public|protected|private|static|final|synchronized|strictfp)\s+)*)\bvoid\s+main\s*\(\s*(?:(?:final\s+)?String\s*(?:\[\s*\]|\.\.\.)\s*\w+|(?:final\s+)?String\s+\w+\s*\[\s*\])?\s*\)/;
        walkTypes(cl, decl, main, false, (n, line, stack) => {
          const c = main.exec(line); if (!c) return;
          const mods = c.groups.mods || '';
          const isStatic = mods.includes('static');
          // main de instância (Java 25 / JEP 512): sem static, mas não privado
          if (!isStatic && (mods.includes('private') || lang === 'groovy')) return;
          let [bin, shown] = jvmName(stack);
          // fora de qualquer classe é a classe implícita do arquivo (Java 21+, JEP 512), mesmo com static
          const implicit = !bin;
          if (implicit) bin = shown = stem(name);
          out.push(entry(n, `${shown}.main()`, qual(pkg, bin), !isStatic || implicit));
        });
        if (lang === 'groovy' && !out.length && !/^\s*(?:abstract\s+|final\s+|public\s+)*(?:class|interface|trait|enum)\b/m.test(cl)) {
          // script Groovy: roda o arquivo inteiro, a partir da primeira linha de código
          const n = lines(cl).findIndex(x => { const s = x.trimStart(); return s && !s.startsWith('import') && !s.startsWith('package'); });
          if (n >= 0) out.push(entry(n + 1, name, ''));
        }
        break;
      }
      case 'kotlin': {
        if (name.endsWith('.kts')) break;
        const cl = clean(src, lang);
        const pkg = (/^\s*package\s+([\w.]+)/m.exec(cl) || [])[1] || '';
        const jvmFile = /@file\s*:\s*JvmName\s*\(\s*"(\w+)"\s*\)/.exec(src);
        const s0 = stem(name);
        const facade = jvmFile ? jvmFile[1] : (s0 ? s0[0].toUpperCase() + s0.slice(1) : '') + 'Kt';
        const decl = /\b(?:(?<comp>companion)\s+object(?:\s+(?<cname>\w+))?|(?:class|interface|object)\s+(?<name>\w+))/g;
        const ls = lines(cl);
        walkTypes(cl, decl, /\bfun\s+main\s*\(/, true, (n, line, stack, depth) => {
          if (depth === 0 && !stack.length) { out.push(entry(n, `${stem(name)}.main()`, qual(pkg, facade))); return; }
          // dentro de object/companion: só roda pela JVM com @JvmStatic
          const annotated = line.includes('@JvmStatic') || (n >= 2 && ls[n - 2] != null && ls[n - 2].includes('@JvmStatic'));
          if (!annotated) return;
          const [bin, shown] = jvmName(stack);
          if (bin) out.push(entry(n, `${shown}.main()`, qual(pkg, bin)));
        });
        break;
      }
      case 'scala': {
        const cl = clean(src, lang);
        const pkg = (/^\s*package\s+([\w.]+)\s*$/m.exec(cl) || [])[1] || '';
        let lastObject = '';
        lines(cl).forEach((line, i) => {
          const o = /\bobject\s+(\w+)/.exec(line); if (o) lastObject = o[1];
          const m = /@main\s+def\s+(\w+)/.exec(line);
          if (m) out.push(entry(i + 1, `${m[1]}()`, qual(pkg, m[1])));
          else if (/\bobject\s+\w+\s+extends\s+App\b/.test(line)) out.push(entry(i + 1, lastObject, qual(pkg, lastObject)));
          else if (/\bdef\s+main\s*\(\s*\w+\s*:\s*Array\s*\[\s*String\s*\]\s*\)/.test(line) && lastObject) out.push(entry(i + 1, `${lastObject}.main()`, qual(pkg, lastObject)));
        });
        break;
      }
      case 'csharp': {
        const cl = clean(src, lang);
        const ns = (/^\s*namespace\s+([\w.]+)/m.exec(cl) || [])[1] || '';
        walkTypes(cl, /\b(?:class|struct|record)\s+(?<name>\w+)/g, /\bstatic\s+(?:async\s+)?(?:void|int|Task|Task\s*<\s*int\s*>)\s+Main\s*\(/, false, (n, _line, stack) => {
          const names = stack.map(s => s.name);
          if (names.length) out.push(entry(n, `${names.join('.')}.Main()`, qual(ns, names.join('+'))));
        });
        break;
      }
      case 'vb': {
        const ns = (/^\s*namespace\s+([\w.]+)/mi.exec(src) || [])[1] || '';
        let last = '';
        lines(src).forEach((line, i) => {
          const c = /^\s*(?:public\s+|friend\s+)?(?:module|class)\s+(\w+)/i.exec(line); if (c) last = c[1];
          if (/^\s*(?:(?:public|shared)\s+)*(?:sub|function)\s+main\s*\(/i.test(line)) out.push(entry(i + 1, `${last}.Main()`, qual(ns, last)));
        });
        break;
      }
      case 'fsharp':
        if (name.endsWith('.fsx')) { out.push(entry(1, name, '')); break; }
        lines(src).forEach((line, i) => { if (line.includes('[<EntryPoint>]')) out.push(entry(i + 1, 'main', '')); });
        break;
      case 'go': {
        const cl = clean(src, lang);
        if (!/^\s*package\s+main\b/m.test(cl)) break;
        each(cl, /^func\s+main\s*\(\s*\)/, (n) => entry(n, 'main()', ''));
        break;
      }
      case 'rust': case 'zig': case 'c': case 'cpp': case 'd': case 'dart': case 'swift': {
        const cl = clean(src, lang);
        const main = {
          rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+main\s*\(/,
          zig: /^\s*pub\s+fn\s+main\s*\(/,
          c: /^\s*(?:(?:static|extern)\s+)?(?:int|void|auto|INT|signed\s+int)\s+(?:__cdecl\s+|WINAPI\s+|APIENTRY\s+)?(?:w?main|_tmain|w?WinMain)\s*\(/,
          d: /^\s*(?:int|void)\s+main\s*\(/,
          dart: /^\s*(?:(?:Future\s*<\s*void\s*>|void|Future)\s+)?main\s*\(/,
          swift: /^\s*@main\b/,
        }[lang === 'cpp' ? 'c' : lang];
        let depth = 0;
        lines(cl).forEach((line, i) => {
          if (depth === 0 && main.test(line)) out.push(entry(i + 1, lang === 'swift' ? name : 'main()', ''));
          for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
          depth = Math.max(depth, 0);
        });
        break;
      }
      // Linguagens de script: havendo o "main" da linguagem (if __name__ == "__main__", require.main === module), o ▶
      // fica nele; sem ele, na primeira linha solta que executa alguma coisa (o arquivo roda inteiro)
      case 'python': {
        each(src, /^if\s+(?:__name__\s*==\s*['"]__main__['"]|['"]__main__['"]\s*==\s*__name__)\s*:/, (n) => entry(n, name, ''));
        if (!out.length && name !== '__init__.py') {
          const i = lines(src).findIndex(x => /^(?:[A-Za-z_][\w.]*\s*\(|(?:for|while|with|async\s+with|async\s+for|match)\b.*:\s*(?:#.*)?$|if\s+(?!TYPE_CHECKING\b|typing\.TYPE_CHECKING\b|sys\.version_info\b).*:\s*(?:#.*)?$|(?:print|await|raise|assert)\b)/.test(x) && !/^(?:def|class|import|from)\b/.test(x));
          if (i >= 0) out.push(entry(i + 1, name, ''));
        }
        break;
      }
      case 'ruby': {
        each(src, /^\s*(?:if|unless)\s+(?:__FILE__\s*==\s*\$(?:0|PROGRAM_NAME)|\$(?:0|PROGRAM_NAME)\s*==\s*__FILE__)/, (n) => entry(n, name, ''));
        if (!out.length) {
          const i = lines(src).findIndex(x => /^(?:puts|print|pp?|exit|abort|loop|system|exec)\b|^[a-z_]\w*[!?]?\s*\(|^[A-Z][\w:]*\.(?:new|run|call|start|main)\b/.test(x) && !/^(?:require|require_relative|load|include|extend|private|public|protected|alias|attr_\w+)\b/.test(x));
          if (i >= 0) out.push(entry(i + 1, name, ''));
        }
        break;
      }
      case 'javascript': case 'typescript': {
        const cl = clean(src, lang);
        each(cl, /\brequire\.main\s*===?\s*module\b|\bmodule\s*===?\s*require\.main\b|\bimport\.meta\.main\b|\bimport\.meta\.url\s*===?\s*(?:(?:url\.)?pathToFileURL\s*\(|`file:)/, (n) => entry(n, name, ''));
        if (!out.length) {
          // #!/usr/bin/env node na primeira linha, ou a chamada solta de main() / de uma função assíncrona imediata
          if (/^#!.*\b(?:node|deno|bun|tsx|ts-node)\b/.test(lines(src)[0] || '')) out.push(entry(1, name, ''));
          else { const i = lines(cl).findIndex(x => /^(?:await\s+|void\s+)?main\s*\(|^\(\s*async\s*(?:function\s*\w*\s*)?\(\s*\)\s*(?:=>)?\s*\{/.test(x)); if (i >= 0) out.push(entry(i + 1, name, '')); }
        }
        break;
      }
      // o arquivo é o programa: o ▶ fica na primeira linha que não é comentário (a do #!, quando existe)
      case 'shell': case 'perl': case 'r': script(/^\s*#(?!!)/, lang === 'perl' && !name.toLowerCase().endsWith('.pl')); break;
      case 'powershell': script(/^\s*#/); break;
      case 'batch': script(/^\s*(?:@?rem\b|::)/i); break;
      case 'lua': script(/^\s*--/); break;
      case 'ocaml': script(/^\s*\(\*/); break;
      case 'php': { const i = lines(src).findIndex(x => /<\?(?:php\b|=)/i.test(x)); if (i >= 0) out.push(entry(i + 1, name, '')); break; }
      case 'erlang': each(src, /^main\s*\(/, (n) => entry(n, 'main/1', '')); break;
      // package.json: um ▶ por script ("dev": "vite" roda com npm, pnpm, yarn ou bun, conforme o lockfile)
      case 'npm': {
        let inside = false;
        lines(src).forEach((ln, i) => {
          let text = ln;
          if (!inside) { const k = /^\s*"scripts"\s*:\s*\{/.exec(ln); if (!k) return; inside = true; text = ln.slice(k[0].length); }
          else if (/^\s*\}/.test(ln)) { inside = false; return; }
          const m = /^\s*"((?:[^"\\]|\\.)+)"\s*:\s*"/.exec(text); if (m) out.push(entry(i + 1, m[1], m[1]));
          if (text !== ln && text.includes('}')) inside = false;
        });
        break;
      }
      case 'nim': each(src, /^when\s+isMainModule\b/, (n) => entry(n, name, '')); break;
      case 'julia': each(src, /abspath\(PROGRAM_FILE\)\s*==\s*@__FILE__/, (n) => entry(n, name, '')); if (!out.length && !/^module\s/m.test(src)) script(/^\s*#/); break;
      case 'haskell': { const i = lines(src).findIndex(x => /^main\s*(?:::|=)/.test(x)); if (i >= 0) out.push(entry(i + 1, 'main', '')); break; }
      case 'clojure': {
        const ns = (/\(ns\s+([\w.\-*+!?]+)/.exec(src) || [])[1] || '';
        each(src, /\(defn-?\s+-main\b/, (n) => entry(n, `${ns}/-main`, ns));
        break;
      }
      case 'elixir': if (name.endsWith('.exs') && src.trim()) out.push(entry(1, name, '')); break;
    }
    return out;
  }

  // ---------- como executar ----------
  // Como o "Run" do IntelliJ: escolhe o caminho pelo projeto em volta do arquivo.
  // - Java/Kotlin/Scala num projeto Maven: `exec:java` com a classe (compila antes; classes de teste com o escopo test);
  //   num projeto Gradle: uma tarefa `bsRun` (JavaExec) acrescentada por um init script, sem mexer no build.gradle;
  //   arquivo solto: `javac` com o -sourcepath da raiz dos pacotes (acha as outras classes do projeto) e `java -cp`.
  //   O JDK é o que atende à versão que o projeto pede (o escolhido como padrão primeiro).
  // - Python: o .venv do projeto (uv/Poetry quando é o caso), como módulo (`-m pacote.mod`) dentro de pacotes.
  // - Rust: `cargo run` com --bin/--example certo; Go: `go run .` no pacote; C#/F#/VB: `dotnet run --project`;
  //   C/C++: compila o arquivo e os vizinhos sem main (gcc, clang ou zig cc); e o equivalente nas outras linguagens.
  // Devolve os passos no formato das tarefas do núcleo (TaskStep), que o console de Build roda.
  const exe = (n) => WIN ? n + '.exe' : n;
  // FNV-1a de 64 bits, os 32 de baixo em hexa (o mesmo nome de pasta que a versão em Rust gerava)
  function hash(s) {
    let h = 0xcbf29ce484222325n;
    for (const x of new TextEncoder().encode(String(s).toLowerCase())) { h ^= BigInt(x); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
    return (h & 0xffffffffn).toString(16).padStart(8, '0');
  }
  function step(program, args, cwd) { return { kind: 'cmd', label: `${baseName(program) || program} ${args.join(' ')}`.trim(), program, args, cwd, env: {} }; }
  // divide os argumentos do programa como um shell simples ("a b" fica junto)
  function splitArgs(s) {
    const out = []; let cur = '', q = null, any = false;
    for (const c of String(s)) {
      if (q) { if (c === q) q = null; else cur += c; }
      else if (c === '"' || c === "'") { q = c; any = true; }
      else if (/\s/.test(c)) { if (any || cur) { out.push(cur); cur = ''; any = false; } }
      else cur += c;
    }
    if (any || cur) out.push(cur);
    return out;
  }
  // sistema de build que compila este arquivo (o arquivo tem de estar em src/<conjunto>/ do módulo)
  async function buildOf(fs, file) {
    const chain = upTo(parentOf(file));
    const setOf = (mod) => { const rest = mod ? (file.startsWith(mod + '/') ? file.slice(mod.length + 1) : null) : file; if (rest == null) return null; const p = rest.split('/'); return p[0] === 'src' && p.length > 1 ? p[1] : null; };
    for (const d of chain) {
      if (await fs.isFile(jn(d, 'build.gradle')) || await fs.isFile(jn(d, 'build.gradle.kts'))) {
        const set = setOf(d); if (set == null) continue;
        // raiz do Gradle: a pasta mais de cima com settings.gradle (ou o próprio módulo)
        let root = null;
        for (const x of [...chain].reverse()) if (await fs.isFile(jn(x, 'settings.gradle')) || await fs.isFile(jn(x, 'settings.gradle.kts'))) { root = x; break; }
        if (root == null || !under(d, root)) root = d;
        return { kind: 'gradle', root, module: d, set };
      }
      if (await fs.isFile(jn(d, 'pom.xml'))) { const set = setOf(d); if (set == null) continue; return { kind: 'maven', pom: jn(d, 'pom.xml'), test: set === 'test' }; }
      if (await fs.isFile(jn(d, 'build.sbt'))) return { kind: 'sbt', root: d };
    }
    return { kind: 'none' };
  }
  // Init script do Gradle com a tarefa bsRun (JavaExec) em todo projeto com sourceSets: roda -Dbs.main com o classpath
  // do conjunto -Dbs.set (main, test...), com a entrada do console e os argumentos de -Dbs.args.
  const GRADLE_INIT = String.raw`// BlueScreen (plugin runtimes): tarefa bsRun para executar um main sem mexer no build do projeto
allprojects {
    afterEvaluate { p ->
        def sets = p.extensions.findByName('sourceSets')
        if (sets == null || p.tasks.findByName('bsRun') != null) return
        p.tasks.register('bsRun', JavaExec) { t ->
            t.group = 'bluescreen'
            t.description = 'Executa a classe -Dbs.main (BlueScreen)'
            def set = sets.findByName(System.getProperty('bs.set', 'main')) ?: sets.getByName('main')
            t.classpath = set.runtimeClasspath
            if (t.hasProperty('mainClass')) { t.mainClass.set(System.getProperty('bs.main')) } else { t.main = System.getProperty('bs.main') }
            t.standardInput = System.in
            t.workingDir = p.projectDir
            def a = System.getProperty('bs.args', '')
            if (a) { t.args((a =~ /"([^"]*)"|(\S+)/).collect { it[1] != null ? it[1] : it[2] }) }
            def j = System.getProperty('bs.jvm', '')
            if (j) { t.jvmArgs(j.split(' ').findAll { it }) }
        }
    }
}
`;
  const gradleInit = (work) => work + SEP + 'bs-run.gradle';
  // JDK que atende ao mínimo (o escolhido primeiro, como a lista vem)
  const pickJdk = (jdks, min) => jdks.find(j => j.major === 0 || j.major >= min) || (min === 0 ? jdks[0] : null) || null;
  const majorOf = (n) => n && /^\d+$/.test(n.version) ? +n.version : 0;

  // Como executar `en` do arquivo; null: o plugin não tem um jeito melhor (o núcleo executa o arquivo pela extensão).
  // env: { has(programa), jdks, work (pasta para classes compiladas, executáveis e o init script do Gradle), mkdir }
  async function plan(env, fs, file, lang, en, args) {
    const dir = parentOf(file), chain = upTo(dir);
    const fname = baseName(file), f = fs.abs(file), D = fs.abs(dir), ROOT = fs.abs('');
    const argv = splitArgs(args), has = env.has;
    const title = `Executar ${en.label}`;
    const done = (how, steps, jdk) => ({ title, how, steps, jdk });
    const withArgs = (a) => a.concat(argv);
    const firstIn = async (n) => { for (const d of chain) if (await fs.isFile(jn(d, n))) return d; return null; };
    switch (lang) {
      case 'java': case 'kotlin': case 'scala': case 'groovy': case 'clojure': return jvm(env, fs, file, lang, en, argv, args, title);
      case 'python': {
        let py = null;
        const venvs = chain.flatMap(d => ['.venv', 'venv', 'env', '.env'].map(v => jn(d, WIN ? `${v}/Scripts/python.exe` : `${v}/bin/python`)));
        await fs.prefetch(venvs);
        for (const p of venvs) if (await fs.isFile(p)) { py = [fs.abs(p), []]; break; }
        let how = 'Python';
        if (!py) {
          if (await firstIn('uv.lock') != null && has('uv')) { how = 'uv run'; py = ['uv', ['run', 'python']]; }
          else if (await firstIn('poetry.lock') != null && has('poetry')) { how = 'poetry run'; py = ['poetry', ['run', 'python']]; }
          else if (has('py')) py = ['py', []];
          else if (has('python')) py = ['python', []];
          else if (has('python3')) py = ['python3', []];
        } else how = 'Python (.venv)';
        if (!py) throw new Error('Python não encontrado');
        const [prog, a] = py;
        a.push('-u');
        // dentro de pacotes (pastas com __init__.py): roda como módulo, a partir da pasta acima do pacote de cima
        let cwd = D;
        if (await fs.isFile(jn(dir, '__init__.py'))) {
          let base = dir;
          while (base && await fs.isFile(jn(parentOf(base), '__init__.py'))) base = parentOf(base);
          const mod = file.replace(/\.[^./]*$/, '');
          let parts;
          if (base) { const up = parentOf(base); parts = (up ? mod.slice(up.length + 1) : mod).split('/'); cwd = fs.abs(up); }
          else { parts = [baseName(ROOT), ...mod.split('/')]; cwd = parentAbs(ROOT); } // o próprio projeto é um pacote
          a.push('-m', parts.join('.'));
        } else a.push(f);
        const st = step(prog, withArgs(a), cwd);
        st.env.PYTHONPATH = [ROOT].concat(await fs.isDir('src') ? [fs.abs('src')] : []).join(WIN ? ';' : ':');
        st.env.PYTHONIOENCODING = 'utf-8';
        st.env.PYTHONUNBUFFERED = '1';
        return done(how, [st]);
      }
      case 'javascript': case 'typescript': {
        const ts = lang === 'typescript';
        let tsx = null;
        if (ts) {
          const c = chain.map(d => jn(d, WIN ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx'));
          await fs.prefetch(c);
          for (const p of c) if (await fs.isFile(p)) { tsx = fs.abs(p); break; }
        }
        let r;
        if (!ts && has('node')) r = ['node', [f], 'Node.js'];
        else if (tsx) r = [tsx, [f], 'tsx do projeto'];
        else if (has('deno')) r = ['deno', ['run', '-A', f], 'Deno'];
        else if (has('bun')) r = ['bun', ['run', f], 'Bun'];
        else if (ts && has('npx')) r = ['npx', ['-y', 'tsx', f], 'npx tsx'];
        else throw new Error('Node.js não encontrado');
        return done(r[2], [step(r[0], withArgs(r[1]), ROOT)]);
      }
      case 'go': {
        const solo = lines(await fs.read(file)).slice(0, 20).some(x => x.startsWith('//go:build ignore') || x.startsWith('// +build ignore'));
        return done(solo ? 'go run (arquivo)' : 'go run (pacote)', [step('go', withArgs(solo ? ['run', f] : ['run', '.']), D)]);
      }
      case 'rust': return rust(fs, file, argv, title, env.work);
      case 'csharp': case 'fsharp': case 'vb': {
        if (fname.endsWith('.fsx')) return done('dotnet fsi', [step('dotnet', withArgs(['fsi', f]), D)]);
        const ext = { csharp: 'csproj', fsharp: 'fsproj' }[lang] || 'vbproj';
        let proj = null;
        for (const d of chain) {
          const v = ((await fs.list(d)) || []).map(e => e.name).filter(n => n.endsWith('.' + ext) && n.length > ext.length + 1).sort();
          if (v.length) { proj = jn(d, v[0]); break; }
        }
        if (proj) {
          const a = ['run', '--project', fs.abs(proj)];
          if (en.target && lang !== 'fsharp') a.push(`-p:StartupObject=${en.target}`);
          if (argv.length) a.push('--');
          return done('dotnet run', [step('dotnet', withArgs(a), fs.abs(parentOf(proj)))]);
        }
        // .NET 10: dotnet run arquivo.cs
        if (lang === 'csharp') return done('dotnet run (arquivo)', [step('dotnet', withArgs(['run', f]), D)]);
        throw new Error(`nenhum .${ext} acima de ${fname}`);
      }
      case 'c': case 'cpp': {
        const cpp = lang === 'cpp';
        let cc, pre;
        if (cpp) { if (has('g++')) [cc, pre] = ['g++', []]; else if (has('clang++')) [cc, pre] = ['clang++', []]; else if (has('zig')) [cc, pre] = ['zig', ['c++']]; else throw new Error('compilador C++ não encontrado'); }
        else if (has('gcc')) [cc, pre] = ['gcc', []]; else if (has('clang')) [cc, pre] = ['clang', []]; else if (has('zig')) [cc, pre] = ['zig', ['cc']]; else throw new Error('compilador C não encontrado');
        const exts = cpp ? ['cpp', 'cc', 'cxx', 'c++'] : ['c'];
        // os .c/.cpp da mesma pasta que não têm main entram junto (programa em vários arquivos)
        const sib = ((await fs.list(dir)) || []).map(e => e.name).filter(n => n !== fname && exts.includes(extOfName(n))).sort().slice(0, 60);
        const texts = await Promise.all(sib.map(n => fs.read(jn(dir, n))));
        const srcs = [f].concat(sib.filter((n, i) => !find(lang, n, texts[i]).length).map(n => fs.abs(jn(dir, n))));
        const out = env.work + SEP + exe(`${fname.replace(/\.[^.]*$/, '')}-${hash(f)}`);
        const a = pre.concat(srcs, ['-g', '-I', D], cpp ? ['-std=c++20'] : [], ['-o', out]);
        return done(`${cc} + executar`, [step(cc, a, D), step(out, argv.slice(), D)]);
      }
      case 'zig': {
        const b = await firstIn('build.zig');
        if (b != null) return done('zig build run', [step('zig', withArgs(['build', 'run'].concat(argv.length ? ['--'] : [])), fs.abs(b))]);
        return done('zig run', [step('zig', withArgs(['run', f].concat(argv.length ? ['--'] : [])), D)]);
      }
      case 'dart': return done('dart run', [step('dart', withArgs(['run', f]), D)]);
      case 'swift': return done('swift', [step('swift', withArgs([f]), D)]);
      case 'ruby': {
        const g = await firstIn('Gemfile');
        if (g != null && has('bundle')) return done('bundle exec ruby', [step('bundle', withArgs(['exec', 'ruby', f]), fs.abs(g))]);
        return done('ruby', [step('ruby', withArgs([f]), D)]);
      }
      case 'nim': return done('nim r', [step('nim', withArgs(['r', '--hints:off', f]), D)]);
      case 'julia': return done('julia', [step('julia', withArgs([f]), D)]);
      case 'haskell': {
        const s = await firstIn('stack.yaml');
        if (s != null && has('stack')) return done('stack runghc', [step('stack', withArgs(['runghc', f]), fs.abs(s))]);
        return done('runghc', [step('runghc', withArgs([f]), D)]);
      }
      case 'elixir': return done('elixir', [step('elixir', withArgs([f]), D)]);
      case 'd': return has('rdmd') ? done('rdmd', [step('rdmd', withArgs([f]), D)]) : done('dmd -run', [step('dmd', withArgs(['-run', f]), D)]);
      case 'npm': {
        let pm = 'npm';
        find: for (const d of chain) for (const [lock, prog] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']]) if (await fs.isFile(jn(d, lock)) && has(prog)) { pm = prog; break find; }
        const a = ['run', en.target]; if (argv.length) a.push(...(pm === 'npm' ? ['--'] : []), ...argv);
        return { title: `${pm} run ${en.target}`, how: pm, steps: [step(pm, a, D)] };
      }
      default: return null;
    }
  }

  async function jvm(env, fs, file, lang, en, argv, args, title) {
    const dir = parentOf(file), chain = upTo(dir), f = fs.abs(file), D = fs.abs(dir), ROOT = fs.abs('');
    const has = env.has;
    let min = majorOf(await need(fs, 'jdk', dir));
    // main de instância: Java 21+ (preview até o 24, padrão no 25)
    if (en.instance) min = Math.max(min, 21);
    const jdk = pickJdk(env.jdks, min);
    if (!jdk) throw new Error(min > 0 ? `nenhum JDK ${min} ou mais novo encontrado` : 'nenhum JDK encontrado');
    const javaBin = (p) => trimSep(jdk.home) + SEP + 'bin' + SEP + exe(p);
    const done = (how, steps) => ({ title, how, steps, jdk: jdk.home });
    const java = (s) => { s.java = true; return s; };
    const withArgs = (a) => a.concat(argv);
    const target = en.target || '';
    const b = await buildOf(fs, file);
    if (b.kind === 'maven' && lang !== 'clojure' && target) {
      const a = ['-q', '-f', fs.abs(b.pom), b.test ? 'test-compile' : 'compile', 'org.codehaus.mojo:exec-maven-plugin:3.5.0:java', `-Dexec.mainClass=${target}`, `-Dexec.classpathScope=${b.test ? 'test' : 'runtime'}`, '-Dexec.cleanupDaemonThreads=false'];
      if (args.trim()) a.push(`-Dexec.args=${args.trim()}`);
      return done('Maven (exec:java)', [{ kind: 'maven', label: `mvn ${a.join(' ')}`, program: '', args: a, cwd: '', env: {}, java: true }]);
    }
    if (b.kind === 'gradle' && lang !== 'clojure' && target) {
      const build = await fs.isFile(jn(b.module, 'build.gradle')) ? await fs.read(jn(b.module, 'build.gradle')) : await fs.read(jn(b.module, 'build.gradle.kts'));
      if (build.includes('com.android')) throw new Error('projeto Android: execute pelo Gradle (installDebug) ou pelo Android Studio');
      const wrapper = jn(b.root, WIN ? 'gradlew.bat' : 'gradlew');
      let prog;
      if (await fs.isFile(wrapper)) prog = fs.abs(wrapper); else if (has('gradle')) prog = 'gradle'; else throw new Error('Gradle não encontrado (o projeto não tem gradlew)');
      const path = (b.root ? b.module.slice(b.root.length + 1) : b.module).split('/').filter(Boolean).join(':');
      const a = ['--init-script', gradleInit(env.work), '-q', '--console=plain', path ? `:${path}:bsRun` : ':bsRun', `-Dbs.main=${target}`, `-Dbs.set=${b.set}`];
      if (args.trim()) a.push(`-Dbs.args=${args.trim()}`);
      return done('Gradle (bsRun)', [java(step(prog, a, fs.abs(b.root)))]);
    }
    if (b.kind === 'sbt' && lang === 'scala' && has('sbt')) {
      const cmd = target ? `runMain ${target}${argv.length ? ' ' : ''}${args.trim()}` : 'run';
      return done('sbt', [java(step('sbt', [cmd], fs.abs(b.root)))]);
    }
    switch (lang) {
      case 'java': {
        // raiz dos pacotes: a pasta do arquivo sem as pastas do "package a.b;"
        const pkg = (/^\s*package\s+([\w.]+)\s*;/m.exec(clean(await fs.read(file), 'java')) || [])[1] || '';
        const parts = pkg ? pkg.split('.') : [];
        const comps = D.split(/[\\/]/).filter(Boolean);
        const relParts = dir ? dir.split('/') : [];
        let srcRoot = D, srcRel = dir;
        if (parts.length <= comps.length && parts.every((p, i) => comps[comps.length - parts.length + i] === p)) {
          for (let i = 0; i < parts.length; i++) srcRoot = parentAbs(srcRoot);
          srcRel = parts.length <= relParts.length ? relParts.slice(0, relParts.length - parts.length).join('/') : null;
        }
        // bibliotecas soltas: lib/, libs/ e target/dependency (e a lib/ ao lado da raiz dos pacotes, se for do projeto)
        const libs = [];
        const libDirs = ['lib', 'libs', 'target/dependency'];
        if (srcRel) libDirs.push(jn(parentOf(srcRel), 'lib'));
        for (const d of libDirs) {
          const v = ((await fs.list(d)) || []).map(e => e.name).filter(n => /.\.jar$/.test(n)).map(n => fs.abs(jn(d, n))).sort();
          for (const j of v) if (!libs.includes(j)) libs.push(j);
        }
        const sep = WIN ? ';' : ':';
        const outName = `java-${hash(srcRoot)}`;
        const out = env.work + SEP + outName + SEP + 'classes';
        // o javac do JDK 8 não cria a pasta do -d ("directory not found")
        await env.mkdir(outName + '/classes');
        const jc = ['-encoding', 'UTF-8', '-g', '-d', out, '-sourcepath', srcRoot];
        if (libs.length) jc.push('-cp', libs.join(sep));
        const preview = !!en.instance && jdk.major >= 21 && jdk.major < 25;
        if (preview) jc.push('--enable-preview', '--release', String(jdk.major));
        jc.push(f);
        const ja = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];
        if (preview) ja.push('--enable-preview');
        ja.push('-cp', [out].concat(libs).join(sep), target);
        return done(`javac + java ${jdk.major > 0 ? jdk.major : jdk.name}`, [java(step(javaBin('javac'), jc, ROOT)), java(step(javaBin('java'), withArgs(ja), ROOT))]);
      }
      case 'kotlin': {
        if (!has('kotlinc')) throw new Error('compilador Kotlin (kotlinc) não encontrado');
        const jar = env.work + SEP + `kt-${hash(f)}.jar`;
        return done('kotlinc + java', [java(step('kotlinc', [f, '-include-runtime', '-d', jar], D)), java(step(javaBin('java'), withArgs(['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', jar, target]), D))]);
      }
      case 'scala': {
        const prog = has('scala-cli') ? 'scala-cli' : has('scala') ? 'scala' : null;
        if (!prog) throw new Error('Scala (scala-cli) não encontrado');
        const a = ['run', f];
        if (target) a.push('--main-class', target);
        if (argv.length) a.push('--');
        return done(`${prog} run`, [java(step(prog, withArgs(a), D))]);
      }
      case 'groovy': return done('groovy', [java(step('groovy', withArgs([f]), D))]);
      case 'clojure': {
        let r = null;
        for (const d of chain) if (await fs.isFile(jn(d, 'deps.edn'))) { if (has('clojure')) r = ['clojure', ['-M', '-m', target], fs.abs(d)]; break; }
        if (!r) for (const d of chain) if (await fs.isFile(jn(d, 'project.clj'))) { if (has('lein')) r = ['lein', ['run', '-m', target], fs.abs(d)]; break; }
        if (!r && has('clojure')) r = ['clojure', ['-M', f], D];
        if (!r) throw new Error('Clojure não encontrado');
        return done(r[0], [java(step(r[0], withArgs(r[1]), r[2]))]);
      }
      default: return null;
    }
  }

  async function rust(fs, file, argv, title, work) {
    const dir = parentOf(file);
    const done = (how, steps) => ({ title, how, steps });
    let cd = null;
    for (const d of upTo(dir)) if (await fs.isFile(jn(d, 'Cargo.toml'))) { cd = d; break; }
    if (cd != null) {
      const toml = await fs.read(jn(cd, 'Cargo.toml'));
      const rel = cd ? file.slice(cd.length + 1) : file;
      const r = rel.split('/');
      const stemRs = (s) => s.replace(/(\.rs)+$/, '');
      const norm = (p) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/\.\//g, '/');
      // [[bin]] com path apontando para o arquivo
      const bin = [...toml.matchAll(/\[\[bin\]\][^\[]*?name\s*=\s*"([^"]+)"[^\[]*?path\s*=\s*"([^"]+)"/gs)].find(c => norm(c[2]) === rel);
      const pkg = (/\[package\][^\[]*?name\s*=\s*"([^"]+)"/s.exec(toml) || [])[1];
      let sel = null;
      if (bin) sel = ['--bin', bin[1]];
      else if (r.length === 2 && r[0] === 'src' && r[1] === 'main.rs') sel = (toml.includes('[[bin]]') || await fs.isDir(jn(cd, 'src/bin'))) ? (pkg ? ['--bin', pkg] : []) : [];
      else if (r.length === 3 && r[0] === 'src' && r[1] === 'bin') sel = ['--bin', stemRs(r[2])];
      else if (r.length === 4 && r[0] === 'src' && r[1] === 'bin' && r[3] === 'main.rs') sel = ['--bin', r[2]];
      else if (r.length === 2 && r[0] === 'examples') sel = ['--example', stemRs(r[1])];
      else if (r.length === 3 && r[0] === 'examples' && r[2] === 'main.rs') sel = ['--example', r[1]];
      if (sel) {
        const a = ['run'].concat(sel);
        if (argv.length) a.push('--', ...argv);
        return done('cargo run', [step('cargo', a, fs.abs(cd))]);
      }
    }
    // arquivo solto (fora de um crate, ou que não é alvo dele): rustc e executa
    const f = fs.abs(file), D = fs.abs(dir);
    const out = work + SEP + exe(`${baseName(file).replace(/\.[^.]*$/, '')}-${hash(f)}`);
    return done('rustc + executar', [step('rustc', [f, '--edition', '2021', '-o', out], D), step(out, argv.slice(), D)]);
  }

  // ---------- o que há no PC (pelo núcleo) ----------
  let PC = null; // { at, p }: guardado por 20 s (abrir abas seguidas não repete a busca)
  const VERSIONS = new Map(); // "programa|args" -> Promise<versão>, até o "Verificar de novo"
  const SDK_LISTS = new Map(); // dotnet --list-sdks, idem
  const runOut = (prog, args) => Promise.resolve().then(() => io.exec(prog, args, { timeout: 6000 })).then(r => r && !r.timedOut ? `${r.out || ''}\n${r.err || ''}` : null).catch(() => null);
  function versionOf(path, args) {
    if (!args.length) return Promise.resolve(null);
    const k = path + '|' + args.join(' ');
    if (!VERSIONS.has(k)) VERSIONS.set(k, runOut(path, args).then(o => o == null ? null : parseVersion(o)));
    return VERSIONS.get(k);
  }
  const versionList = (path) => { if (!SDK_LISTS.has(path)) SDK_LISTS.set(path, runOut(path, ['--list-sdks'])); return SDK_LISTS.get(path); };
  function forgetHere() { PC = null; VERSIONS.clear(); SDK_LISTS.clear(); }
  async function pc() {
    if (PC && Date.now() - PC.at < 20e3) return PC.p;
    const progs = allProgs();
    const [w, jd, mv] = await Promise.all([io.which(progs), io.jdks(), Promise.resolve().then(() => io.mavens()).catch(() => null)]);
    const which = {};
    for (const x of progs) which[x] = w && typeof w[x] === 'string' ? w[x] : null;
    // o python.exe "da loja" (atalho em WindowsApps sem Python instalado) não é Python
    await Promise.all(Object.keys(which).filter(k => k.startsWith('python') && which[k] && which[k].toLowerCase().includes('\\windowsapps\\'))
      .map(async k => { if (await versionOf(which[k], ['--version']) == null) which[k] = null; }));
    const valid = Array.isArray(jd) && jd.every(j => j && typeof j.home === 'string' && Number.isInteger(j.major) && j.major >= 0 && typeof j.name === 'string');
    const jdks = valid ? jd.map(j => ({ home: j.home, major: j.major, name: j.name })) : [];
    // Mavens que o núcleo acha (~/Tools, C:\, MAVEN_HOME, SDKs, PATH): o build roda por eles
    const p = { which, jdks, mavens: Array.isArray(mv) ? mv.length : 0, find: (x) => which[x] || null, has: (x) => !!which[x] };
    PC = { at: Date.now(), p };
    return p;
  }
  // gerenciadores de pacotes do Windows que existem (para oferecer winget/scoop)
  const managers = (p) => ({ winget: p.has('winget'), scoop: p.has('scoop') });

  // ---------- estado de cada requisito ----------
  // { id, name, status: ok | missing | old (versão mais velha que a pedida), ok, path, version, need, sdk, winget, scoop,
  //   url, note, alts (outras opções que também resolvem: TypeScript com Deno ou Bun), jdks (Java: os achados) }
  async function toolStatus(tl, p, fs, dir) {
    const n = fs ? await need(fs, tl.id, dir) : null;
    const st = { id: tl.id, name: tl.name, status: 'missing', ok: false, path: undefined, version: undefined, need: n || undefined, sdk: tl.sdk, winget: tl.winget, scoop: tl.scoop, url: tl.url, note: tl.note, alts: [], jdks: undefined };
    if (tl.id === 'jdk') { st.jdks = p.jdks.length ? p.jdks.slice() : undefined; jdkPick(st, p); return st; }
    const prog = tl.progs.find(x => p.find(x));
    if (!prog) return st;
    const path = p.find(prog);
    st.path = path;
    st.status = 'ok';
    if (tl.id === 'dotnet') {
      // vários SDKs lado a lado: basta um que atenda
      const sdks = lines((await versionList(path)) || '').map(x => x.trim().split(/\s+/)[0]).filter(v => /^\d/.test(v));
      st.version = sdks[sdks.length - 1];
      if (!sdks.length) { st.status = 'missing'; st.note = 'Só o runtime do .NET está instalado: falta o SDK (dotnet build/run).'; }
      else if (n && !sdks.some(v => satisfies(v, n.version))) st.status = 'old';
    } else {
      st.version = (await versionOf(path, prog === 'py' ? ['--version'] : tl.versionArgs)) || undefined;
      if (st.version && n && !satisfies(st.version, n.version)) st.status = 'old';
    }
    st.ok = st.status === 'ok';
    return st;
  }
  // o JDK que atende ao `need` do status (o padrão primeiro), ou "old"/"missing"
  function jdkPick(st, p) {
    const j = pickJdk(p.jdks, majorOf(st.need));
    if (j) { st.status = 'ok'; st.path = j.home; st.version = j.major > 0 ? String(j.major) : j.name; }
    else if (p.jdks[0]) { st.status = 'old'; st.path = p.jdks[0].home; st.version = String(p.jdks[0].major); }
    else { st.status = 'missing'; st.path = undefined; st.version = undefined; }
    st.ok = st.status === 'ok';
  }
  // um requisito (lista de alternativas): a primeira que está ok; senão a sugerida, com as outras como opção
  async function requirement(alts, p, fs, dir) {
    const all = await Promise.all(alts.map(tool).filter(Boolean).map(x => toolStatus(x, p, fs, dir)));
    const good = all.find(s => s.ok); if (good) return good;
    // alguma instalada mas velha conta mais que nenhuma
    const s = all.find(x => x.status === 'old') || all[0];
    s.alts = all.filter(x => x.id !== s.id).map(x => x.name);
    return s;
  }
  async function needsOf(lg, p, fs, file) {
    const dir = file ? parentOf(file) : '';
    const b = file ? await buildOf(fs, file) : { kind: 'none' };
    const v = await Promise.all(needsFor(lg, b.kind !== 'none').map(alts => requirement(alts, p, fs, dir)));
    // o arquivo é compilado pelo Maven ou pelo Gradle: precisa deles (o wrapper do projeto basta)
    const wrapper = async (n) => { for (const d of upTo(dir)) if (await fs.isFile(jn(d, n))) return true; return false; };
    let extra = null;
    if (b.kind === 'maven' && !(await wrapper('mvnw.cmd') || await wrapper('mvnw') || p.has('mvn') || p.mavens > 0)) extra = tool('maven');
    else if (b.kind === 'gradle' && !(await wrapper('gradlew.bat') || await wrapper('gradlew') || p.has('gradle'))) extra = tool('gradle');
    if (extra) v.push(await toolStatus(extra, p, fs, dir));
    // main fora de classe ou de instância (classe implícita): o próprio arquivo pede Java 21+, mesmo sem pom/gradle
    if (file && extOfName(file) === 'java' && find('java', file, await fs.read(file)).some(e => e.instance)) {
      for (const st of v.filter(s => s.id === 'jdk')) {
        if (majorOf(st.need) < 21) { st.need = { version: '21', source: file + ' (main fora de classe)' }; jdkPick(st, p); }
      }
    }
    return v;
  }

  // ---------- o que a interface pede ----------
  const SKIP = ['node_modules', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'vendor', 'venv', '.venv', 'env', '__pycache__', '.git', '.svn', '.idea', '.gradle', '.vs', 'coverage', 'packages', '.dart_tool', 'zig-cache', '.zig-cache'];
  const needProject = (project) => { if (!project) throw new Error('project obrigatório'); return project; };
  return {
    langs: LANGS,
    // id da linguagem de um arquivo (pela extensão, ou pelo nome: package.json), ou null
    lang(file) { const lg = langOf(file || ''); return lg ? lg.id : null; },
    // { lang, entries: [{ line, label, target, instance }] } (o ▶ da margem)
    entries(file, text) {
      const lg = langOf(file || '');
      if (!lg) return { lang: null, entries: [] };
      text = String(text || '');
      return { lang: lg.id, entries: text.length > 4 << 20 ? [] : find(lg.id, file, text) };
    },
    // { lang, name, needs: [estado de cada requisito], pm }
    async check(project, file) {
      const root = needProject(project), rel = relOf(root, file);
      const lg = rel && langOf(rel);
      if (!lg) return { lang: null };
      const p = await pc();
      const fs = projectFs(root);
      await warm(fs, parentOf(rel));
      return { lang: lg.id, name: lg.name, needs: await needsOf(lg, p, fs, rel), pm: managers(p) };
    },
    // { langs: [{ lang, name, files, needs }], pm }: as linguagens do projeto, contadas pelos arquivos do índice
    async project(project) {
      const root = needProject(project);
      const [p, ix] = await Promise.all([pc(), io.index(root)]);
      const count = new Map();
      let seen = 0;
      for (const rel of ix || []) {
        const segs = String(rel).split('/'), dirs = segs.slice(0, -1);
        if (dirs.length > 8 || dirs.some(d => d.startsWith('.') || SKIP.includes(d))) continue;
        if (++seen > 40000) break;
        const lg = langOf(segs[segs.length - 1]); if (lg) count.set(lg.id, (count.get(lg.id) || 0) + 1);
      }
      const top = [...count].map(([id, n]) => ({ lg: LANGS.find(x => x.id === id), n })).sort((a, b) => b.n - a.n || (a.lg.name < b.lg.name ? -1 : a.lg.name > b.lg.name ? 1 : 0)).slice(0, 14);
      const fs = projectFs(root);
      await warm(fs, '');
      const langs = await Promise.all(top.map(async ({ lg, n }) => ({ lang: lg.id, name: lg.name, files: n, needs: await needsOf(lg, p, fs, null) })));
      return { langs, pm: managers(p) };
    },
    // { plan: { title, how, steps, jdk }, entry } | { missing: [...], lang, name, pm } | { fallback: true }
    async plan(project, file, line, args) {
      const root = needProject(project), rel = relOf(root, file);
      if (!rel) throw new Error('file obrigatório');
      const lg = langOf(rel);
      if (!lg) return { fallback: true };
      const p = await pc();
      const fs = projectFs(root);
      await warm(fs, parentOf(rel));
      const missing = (await needsOf(lg, p, fs, rel)).filter(s => !s.ok);
      if (missing.length) return { missing, lang: lg.id, name: lg.name, pm: managers(p) };
      if (!await fs.isFile(rel)) throw new Error(`não deu para ler ${fs.abs(rel)}`);
      const list = find(lg.id, rel, await fs.read(rel));
      // o main da linha pedida; senão o último acima dela; senão o primeiro
      line = +line || 0;
      const en = list.find(e => e.line === line) || [...list].reverse().find(e => e.line <= line) || list[0];
      if (!en) return { fallback: true };
      const work = await io.workDir();
      await io.writeWork('bs-run.gradle', GRADLE_INIT);
      const r = await plan({ has: p.has, jdks: p.jdks, work, mkdir: (d) => io.writeWork(d + '/.keep', '') }, fs, rel, lg.id, en, String(args || ''));
      if (!r) return { fallback: true };
      for (const s of r.steps) if (!Object.keys(s.env).length) delete s.env;
      if (r.jdk === undefined) delete r.jdk;
      return { plan: r, entry: en };
    },
    // aponta uma instalação que já existe: SDKs que o núcleo conhece viram o padrão do tipo (JAVA_HOME, PATH, JDK do
    // build); o resto entra no PATH de tudo o que a IDE abre
    async select(toolId, path) {
      const tl = tool(toolId);
      if (!tl) throw new Error('ferramenta desconhecida');
      if (!path) throw new Error('path obrigatório');
      const progs = tl.id === 'jdk' ? ['javac'] : tl.progs;
      const r = await io.findBin(path, progs);
      if (!r.dir) throw new Error(`A pasta ${path} não existe`);
      if (!r.bin) throw new Error(`Não achei ${progs.join(' ou ')} em ${path} (nem em bin/ ou nas subpastas). Escolha a pasta onde ${tl.name} foi instalado.`);
      const bin = r.bin;
      let route, q;
      if (tl.sdk === tl.id && ['jdk', 'node', 'python', 'go', 'dotnet', 'zig', 'kotlin', 'maven', 'gradle'].includes(tl.id)) {
        // a pasta do SDK: a de cima do bin (JDK, Go, Kotlin, Maven, Gradle), a de cima do Scripts (Python) ou a própria
        // (Node, .NET, Zig e Python têm o programa na raiz)
        const last = baseName(bin).toLowerCase();
        const home = (last === 'bin' && ['jdk', 'go', 'kotlin', 'maven', 'gradle'].includes(tl.id)) || (last === 'scripts' && tl.id === 'python') ? parentAbs(bin) : bin;
        route = 'sdk/default'; q = { kind: tl.id, path: home };
      } else { route = 'sdk/path'; q = { name: `runtimes-${tl.id}`, path: bin }; }
      await io.core(route, q);
      forgetHere();
      const st = await toolStatus(tl, await pc(), null, '');
      return { ok: true, path: q.path, version: st.version, status: st };
    },
    // esquece o que já foi procurado (depois de instalar por fora)
    async forget() { await Promise.resolve().then(() => io.core('sdk/forget', {})).catch(() => {}); forgetHere(); return { ok: true }; },
    // para os testes
    _: { find, clean, need, satisfies, parseVersion, splitArgs, hash, buildOf, plan, projectFs, warm, normJava, langOf, tool, needsFor, GRADLE_INIT },
  };
}
// <<< motor
