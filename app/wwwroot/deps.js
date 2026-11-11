/* BlueScreen: dependências não instaladas. Ao abrir/atualizar o projeto, pergunta ao núcleo (deps/check) se os
   manifestos (package.json, requirements.txt, composer.json, *.csproj, pubspec.yaml...) já têm o que pedem baixado.
   Faltando algo, um aviso no canto inferior direito oferece o comando (npm install, uv sync, dotnet restore...),
   que roda no terminal da IDE, na pasta certa. Enquanto instala, o aviso confere sozinho e comemora quando acaba;
   aí os servidores de linguagem são reiniciados para os erros antigos sumirem.
   Erros típicos de pacote faltando no editor ("Cannot find module", "Type annotations can only be used in TypeScript
   files.", "No module named"...) fazem o aviso voltar mesmo depois de "Depois". */
(function (bs) {
const { $, esc, store, api, toast } = bs;

const DEP_RX = /cannot find module|could not find a declaration file|type annotations can only be used in typescript|cannot find name '(?:require|process|module|describe|it|expect)'|no module named|import ".*" could not be resolved|unresolved import|is not resolved|package .* is not in (?:goroot|std)|could not import|class ".*" not found|the type or namespace name .* could not be found/i;
const ICO = {
  box: '<svg class="i" viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  term: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>',
};
const KIND_COLOR = { node: '#7CC36E', python: '#F2C94C', php: '#8E9BFF', dotnet: '#A97BFF', dart: '#4FC3F7', ruby: '#F0606E', go: '#4DD0E1' };

const D = { project: null, items: [], snoozed: new Set(), running: new Map(), poll: null, last: 0, busy: false, hint: '' };
const sig = (it) => it.kind + '|' + it.dir;
const never = () => new Set(store.get('depsNever', []));

const el = document.createElement('section');
el.id = 'depsCard'; el.hidden = true; el.setAttribute('role', 'alert');
document.body.appendChild(el);

// ----- verificar -----
async function check(force) {
  const p = bs.S.project; if (!p || D.busy || bs.doc) return;
  if (!force && Date.now() - D.last < 4000 && D.project === p.path) return;
  D.busy = true; D.last = Date.now();
  try {
    const items = await api('deps/check', { project: p.path });
    if (bs.S.project !== p) return;
    if (D.project !== p.path) { D.project = p.path; D.running.clear(); D.snoozed.clear(); D.hint = ''; }
    const before = new Set(D.items.map(sig)); D.items = items || [];
    const now = new Set(D.items.map(sig));
    for (const k of [...D.running.keys()]) if (!now.has(k)) { D.running.set(k, 'done'); }
    render(before);
  } catch (e) { console.warn('deps', e); }
  finally { D.busy = false; }
}

// ----- desenhar -----
function visibleItems() {
  const nv = never(); return D.items.filter(it => !nv.has(D.project + '|' + sig(it)) && !D.snoozed.has(sig(it)));
}
function render(before) {
  const items = visibleItems();
  const done = [...D.running.entries()].filter(([, s]) => s === 'done').map(([k]) => k);
  const anyRunning = [...D.running.values()].some(s => s === 'run');
  if (!items.length && !done.length) { if (!el.classList.contains('celebrate')) hide(); return; }  // a comemoração sai sozinha
  if (!items.length && done.length && !anyRunning) { celebrate(); return; }
  const nm = (it) => it.dir ? it.dir : bs.S.project.name;
  const rows = items.map((it, i) => {
    const k = sig(it), st = D.running.get(k);
    const color = KIND_COLOR[it.kind] || 'var(--accent-2)';
    return `<div class="dp-row ${st === 'run' ? 'run' : ''} ${before && !before.has(k) ? 'new' : ''}" data-k="${esc(k)}" style="--i:${i};--kc:${color}">
      <div class="dp-row-top"><span class="dp-kind">${esc(it.label)}</span><span class="dp-dir" title="${esc(it.dir || '/')}">${esc(nm(it))}</span>${st === 'run' ? '' : `<button class="dp-link dp-ign" data-dir="${esc(it.dir)}" title="Não avisar mais sobre ${esc(it.dir ? 'esta pasta' : 'a raiz do projeto')} (vale para todas as janelas)">Ignorar</button>`}</div>
      <div class="dp-reason">${esc(it.reason)}${it.sample && it.sample.length ? `<span class="dp-sample">${it.sample.map(esc).join(', ')}${it.missing > it.sample.length ? '…' : ''}</span>` : ''}</div>
      <div class="dp-cmd"><code>${it.commands.map(esc).join('<br>')}</code>
        ${st === 'run' ? '<span class="dp-spin"></span>' : `<button class="dp-go" data-k="${esc(k)}" ${it.tool_ok ? '' : 'disabled'} title="${it.tool_ok ? 'Rodar no terminal, nesta pasta' : esc(it.tool) + ' não está no PATH'}">${ICO.play}<span>Instalar</span></button>`}</div>
      ${it.tool_ok ? '' : `<div class="dp-warn">${esc(it.tool)} não foi encontrado no PATH. Instale-o e clique em verificar de novo.</div>`}
    </div>`;
  }).join('') + done.map(k => `<div class="dp-row ok" data-k="${esc(k)}"><span class="dp-okic">${ICO.ok}</span><span>${esc(k.split('|')[1] || bs.S.project.name)}: instalado</span></div>`).join('');
  const runnable = items.filter(it => it.tool_ok && D.running.get(sig(it)) !== 'run');
  el.innerHTML = `
    ${anyRunning ? '<div class="dp-progress"></div>' : ''}
    <header><span class="dp-ic">${ICO.box}</span><div class="dp-ttl"><b>${anyRunning ? 'Instalando dependências…' : 'Dependências não instaladas'}</b>
      <span>${anyRunning ? 'Acompanhe no terminal; este aviso confere sozinho.' : esc(D.hint || 'Sem elas o editor acusa erros que não são do seu código.')}</span></div>
      <button class="icon-btn dp-x" title="Depois">${ICO.x}</button></header>
    <div class="dp-list">${rows}</div>
    <footer><button class="dp-link dp-never">Não avisar neste projeto</button><span class="spacer"></span>
      <button class="chip dp-later">Depois</button>
      ${runnable.length ? `<button class="chip primary dp-all">${ICO.term}<span>${runnable.length > 1 ? 'Instalar tudo' : 'Instalar'}</span></button>` : ''}</footer>`;
  show();
  el.querySelectorAll('.dp-go').forEach(b => b.onclick = () => install([D.items.find(it => sig(it) === b.dataset.k)]));
  el.querySelector('.dp-all')?.addEventListener('click', () => install(runnable));
  // ignorar a pasta: guardado no núcleo (~/.bluescreen/deps-ignore.json), some daqui e das outras janelas
  el.querySelectorAll('.dp-ign').forEach(b => b.onclick = async () => {
    try { await api('deps/ignore', { project: D.project }, { method: 'POST', body: JSON.stringify({ dir: b.dataset.dir, ignore: true }) }); }
    catch (e) { toast('Dependências: ' + e.message); return; }
    const d = b.dataset.dir; D.items = D.items.filter(it => !(it.dir === d || (d && it.dir.startsWith(d + '/')))); render();
    toast(`Não vou mais avisar sobre ${b.dataset.dir || 'a raiz do projeto'}. "Verificar dependências do projeto" volta a conferir.`);
  });
  el.querySelector('.dp-x').onclick = el.querySelector('.dp-later').onclick = () => { items.forEach(it => D.snoozed.add(sig(it))); hide(); };
  el.querySelector('.dp-never').onclick = () => {
    const nv = never(); items.forEach(it => nv.add(D.project + '|' + sig(it))); store.set('depsNever', [...nv]);
    hide(); toast('Não vou mais avisar sobre dependências deste projeto.');
  };
}
function show() {
  if (!el.hidden) return;
  el.hidden = false; el.classList.remove('out'); el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
}
function hide() {
  if (el.hidden || el.classList.contains('out')) return;
  el.classList.add('out'); setTimeout(() => { if (el.classList.contains('out')) { el.hidden = true; el.classList.remove('out'); } }, 260);
}
function celebrate() {
  stopPoll();
  const n = [...D.running.values()].filter(s => s === 'done').length; D.running.clear();
  el.innerHTML = `<div class="dp-done"><span class="dp-burst">${ICO.ok}</span><div><b>Dependências instaladas</b>
    <span>${n > 1 ? n + ' pastas resolvidas. ' : ''}Os servidores de linguagem foram reiniciados.</span></div></div>`;
  show(); el.classList.add('celebrate');
  restartLsp();
  setTimeout(() => { el.classList.remove('celebrate'); hide(); }, 3800);
}
function restartLsp() {
  if (!bs.lsp) return;
  const seen = new Set();
  for (const t of bs.S.tabs || []) {
    try { const c = bs.lsp.clientFor(t); if (c && c.tool && !seen.has(c.tool.id)) { seen.add(c.tool.id); bs.lsp.restart(c.tool, t.project); } } catch {}
  }
}

// ----- instalar: roda no terminal, na pasta do manifesto -----
async function install(list) {
  const root = bs.S.project.path.replace(/[\\/]+$/, '');
  for (const it of list) {
    if (!it) continue;
    const cwd = it.dir ? root + '\\' + it.dir.replace(/\//g, '\\') : root;
    D.running.set(sig(it), 'run');
    try {
      await bs.terminal.run(it.commands[0], cwd);
      for (const line of it.commands.slice(1)) await bs.terminal.run(line);
    } catch (e) { toast('Terminal: ' + e.message); D.running.delete(sig(it)); }
  }
  render(); startPoll();
}
function startPoll() {
  stopPoll(); const t0 = Date.now();
  D.poll = setInterval(() => { if (Date.now() - t0 > 20 * 60e3) { stopPoll(); D.running.clear(); render(); return; } check(true); }, 3500);
}
function stopPoll() { if (D.poll) { clearInterval(D.poll); D.poll = null; } }

// ----- gatilhos -----
bs.hooks.on('project:select', (p) => { stopPoll(); D.items = []; D.running.clear(); hide(); if (p) setTimeout(() => check(true), 1200); });
bs.hooks.on('project:refresh', () => check(false));
bs.hooks.on('tab:save', (t) => { if (/(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Pipfile|environment\.ya?ml|composer\.json|pubspec\.yaml|Gemfile|go\.mod|[^/]+\.(cs|fs|vb)proj)$/i.test(t.path || '')) check(true); });
// erro de pacote faltando no editor: traz o aviso de volta (mesmo depois de "Depois") e diz por quê
bs.hooks.on('editor:ready', () => {
  const monaco = bs.monaco; if (!monaco) return;
  let tm = null;
  monaco.editor.onDidChangeMarkers((uris) => {
    clearTimeout(tm); tm = setTimeout(() => {
      for (const u of uris) {
        const m = monaco.editor.getModelMarkers({ resource: u }).find(x => DEP_RX.test(x.message));
        if (!m) continue;
        const msg = m.message.split('\n')[0].slice(0, 120);
        if (D.hint.includes(msg)) return;
        D.hint = `Erros como “${msg}” costumam sumir depois de instalar.`; D.snoozed.clear(); check(true); return;
      }
    }, 600);
  });
});
bs.actions.add({ label: 'Verificar dependências do projeto', icon: ICO.box, run: async () => {
  const nv = never(); [...nv].filter(k => k.startsWith(D.project + '|')).forEach(k => nv.delete(k)); store.set('depsNever', [...nv]); D.snoozed.clear();
  // as pastas ignoradas voltam a ser conferidas
  if (bs.S.project) try { await api('deps/ignore', { project: bs.S.project.path }, { method: 'POST', body: JSON.stringify({ clear: true }) }); } catch {}
  check(true).then(() => { if (!visibleItems().length) toast('Todas as dependências estão instaladas.'); });
} });
// projeto restaurado ao abrir a IDE: os ganchos de seleção podem ter rodado antes deste arquivo carregar
setTimeout(() => { if (bs.S.project && D.project !== bs.S.project.path) check(true); }, 1500);
bs.deps = { check, items: () => D.items };
})(window.BS);
