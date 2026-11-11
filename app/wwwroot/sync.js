'use strict';
// ===== Arquivos alterados fora da IDE =====
// O núcleo vigia a pasta do projeto com a API do Windows (watch.rs) e avisa por /api/watch (long-poll). Aqui:
// - aba sem alteração em andamento: recarrega do disco sem perder cursor, rolagem e desfazer (só o trecho que mudou);
// - aba com alteração em andamento: merge de três vias. Base = o que a aba leu do disco por último, a sua = o editor,
//   a de fora = o disco agora. Trechos que não se sobrepõem entram sozinhos; trechos que se sobrepõem são conflito:
//   fica a sua versão, marcada em amarelo, e o diff EXTERNO mostra disco (esquerda) × editor (direita), com as setas
//   do meio para trazer cada trecho do disco. Salvar com conflito pendente = ficar com a sua versão.
// - a árvore, as Alterações e as marcas da margem acompanham (inclusive commit, checkout e pull feitos fora).
// A regra para abas com alteração em andamento fica em store 'extRule' e troca pelo Buscar em tudo (Ctrl+Shift+A):
//   'diff'  mescla o que dá e, se houver conflito, abre o diff EXTERNO (padrão)
//   'merge' mescla o que dá e só avisa os conflitos na faixa do editor
//   'ask'   não mescla nada: mantém o editor como está e abre o diff EXTERNO para você decidir
// Sem vigia (outra plataforma) ou se a pasta não puder ser vigiada, confere as abas abertas a cada 2 s e ao voltar à janela.
const XS = { seq: null, for: null, native: false, ctl: null, busy: new Map(), refreshT: null, vcs: false, treeT: null, treeDirs: new Set(), rule: store.get('extRule', 'diff') };
const XS_RULES = { diff: 'mesclar e abrir o diff nos conflitos', merge: 'mesclar e só avisar os conflitos', ask: 'não mesclar, sempre abrir o diff' };
const xsSleep = (ms) => new Promise(r => setTimeout(r, ms));
const xsName = (t) => t.path.split('/').pop();
const xsStamp = (st) => st ? st.mtime + ':' + st.size : null;
// o Monaco guarda o texto com o fim de linha do modelo; o disco pode vir com outro
const xsNorm = (s, model) => s.replace(/\r\n|\r|\n/g, model.getEOL());

// ----- diff e merge por linhas -----
// trechos de a trocados em b: [{ s, e, lines }] = a[s..e) vira lines (LCS depois de cortar começo e fim iguais)
function xsHunks(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q), n = A.length, m = B.length;
  if (!n && !m) return [];
  if (n * m > 4e6) return [{ s: p, e: p + n, lines: B }]; // grande demais: um trecho só
  const W = m + 1, dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const out = []; let cur = null, i = 0, j = 0;
  const open = () => cur || (cur = { s: p + i, e: p + i, lines: [] });
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { if (cur) { out.push(cur); cur = null; } i++; j++; }
    else if (j >= m || (i < n && dp[(i + 1) * W + j] >= dp[i * W + j + 1])) { open().e = p + i + 1; i++; }
    else { open().lines.push(B[j]); j++; }
  }
  if (cur) out.push(cur);
  return out;
}
// merge de três vias (como o git): { text, conflicts: [{ start, end }] (linhas da sua versão no resultado), theirs: n }
function xsMerge3(base, mine, theirs) {
  const O = base.split('\n'), eq = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
  const hs = [...xsHunks(O, mine.split('\n')).map(h => ({ ...h, a: 1 })), ...xsHunks(O, theirs.split('\n')).map(h => ({ ...h, a: 0 }))].sort((x, y) => x.s - y.s || x.e - y.e);
  const out = [], conflicts = []; let pos = 0, k = 0, applied = 0;
  while (k < hs.length) {
    const g = [hs[k]]; let gs = hs[k].s, ge = hs[k].e; k++;
    // trechos que se tocam ou se sobrepõem formam um grupo (encostados também contam, como no git)
    while (k < hs.length && hs[k].s <= ge) { g.push(hs[k]); ge = Math.max(ge, hs[k].e); k++; }
    out.push(...O.slice(pos, gs));
    const side = (a) => { const r = []; let at = gs; g.filter(h => h.a === a).forEach(h => { r.push(...O.slice(at, h.s), ...h.lines); at = h.e; }); r.push(...O.slice(at, ge)); return r; };
    const hasMine = g.some(h => h.a === 1), hasTheirs = g.some(h => h.a === 0);
    if (!hasTheirs) out.push(...side(1));
    else if (!hasMine) { out.push(...side(0)); applied++; }
    else {
      const rm = side(1), rt = side(0);
      if (!eq(rm, rt)) conflicts.push({ start: out.length + 1, end: out.length + rm.length });
      out.push(...rm);
    }
    pos = ge;
  }
  out.push(...O.slice(pos));
  return { text: out.join('\n'), conflicts, theirs: applied };
}

// troca o texto do modelo mexendo só no trecho que mudou: cursor, rolagem, dobras e desfazer continuam valendo
function xsApply(model, text) {
  const cur = model.getValue(); if (cur === text) return [];
  const n = Math.min(cur.length, text.length);
  let p = 0; while (p < n && cur.charCodeAt(p) === text.charCodeAt(p)) p++;
  let q = 0; while (q < n - p && cur.charCodeAt(cur.length - 1 - q) === text.charCodeAt(text.length - 1 - q)) q++;
  if (p > 0 && cur[p - 1] === '\r') p--; // não corta um \r\n ao meio
  if (q > 0 && cur[cur.length - q] === '\n' && cur[cur.length - q - 1] === '\r' && cur.length - q - 1 >= p) q--;
  const before = cur.split('\n');
  model.pushStackElement();
  XS.applying = true; // o espelho (share.js) não repassa: cada janela lê o disco sozinha
  try { model.pushEditOperations([], [{ range: monaco.Range.fromPositions(model.getPositionAt(p), model.getPositionAt(cur.length - q)), text: text.slice(p, text.length - q) }], () => null); }
  finally { XS.applying = false; }
  model.pushStackElement();
  // linhas que vieram de fora, para piscar
  const after = text.split('\n'); let delta = 0; const lines = [];
  xsHunks(before, after).forEach(h => { const at = h.s + delta + 1; lines.push([at, Math.max(at, at + h.lines.length - 1)]); delta += h.lines.length - (h.e - h.s); });
  return lines;
}
function xsFlash(model, ranges) {
  if (!ranges.length || model.isDisposed()) return;
  const max = model.getLineCount();
  const ids = model.deltaDecorations([], ranges.map(([a, b]) => ({ range: new monaco.Range(Math.min(a, max), 1, Math.min(b, max), 1), options: { isWholeLine: true, className: 'ext-flash', linesDecorationsClassName: 'ext-flash-gut' } })));
  setTimeout(() => { if (!model.isDisposed()) model.deltaDecorations(ids, []); }, 2600);
}

// ----- conflito: estado da aba, marcas e faixa no editor -----
function xsSetConflict(tab, disk, conflicts) {
  tab.conflict = { disk, n: conflicts ? conflicts.length : 0, at: Date.now() };
  tab.conflictDecos = tab.model.deltaDecorations(tab.conflictDecos || [], (conflicts || []).map(c => ({
    range: new monaco.Range(c.start, 1, Math.max(c.start, c.end), 1),
    options: { isWholeLine: true, className: 'ext-conflict', linesDecorationsClassName: 'ext-conflict-gut', overviewRuler: { color: '#E3A63A', position: monaco.editor.OverviewRulerLane.Full }, hoverMessage: { value: '**Conflito:** este trecho também mudou fora da IDE. Ficou a sua versão; veja o diff EXTERNO para trazer a do disco.' } },
  })));
  const x = xsExtTab(tab); if (x && x.original.getValue() !== disk) x.original.setValue(disk);
  // abre o diff só se a aba está na frente; nas outras, a faixa aparece quando você chegar nelas
  if (XS.rule !== 'merge' && S.active === tab) xsOpenExt(tab);
  xsBar();
}
function xsClearConflict(tab) {
  if (!tab.conflict && !tab.conflictDecos) return;
  tab.conflict = null;
  if (!tab.model.isDisposed()) tab.conflictDecos = tab.model.deltaDecorations(tab.conflictDecos || [], []);
  xsBar();
}
const xsExtTab = (tab) => S.tabs.find(t => t.owner === tab);
// diff EXTERNO: disco (só leitura) × o mesmo modelo da aba (editar aqui é editar a aba)
function xsOpenExt(tab) {
  ensureEditors();
  let x = xsExtTab(tab);
  if (!x) {
    const disk = tab.conflict ? tab.conflict.disk : tab.saved;
    x = { key: tab.path + '::ext', path: tab.path, mode: 'diff', owner: tab, project: tab.project, lang: tab.lang, changeMode: 'ext', editable: true, model: tab.model, original: monaco.editor.createModel(disk, tab.lang) };
    Object.defineProperty(x, 'problems', { get: () => tab.problems });
    Object.defineProperty(x, 'dirty', { get: () => tab.dirty, set() {} });
    S.tabs.splice(S.tabs.indexOf(tab) + 1, 0, x);
  }
  activate(x);
}
function xsBar() {
  const bar = $('#extBar'); if (!bar) return;
  const a = S.active, t = a && (a.owner || a);
  const show = t && (t.conflict || t.gone || a.owner) && $('#welcome').hidden;
  bar.hidden = !show; if (!show) return;
  const inExt = !!a.owner;
  if (!t.conflict && !t.gone) {
    bar.innerHTML = `<span class="xi">≠</span><div class="xt">${a.cmpNote || `<b>${esc(xsName(t))}</b>: esquerda é o disco, direita é o seu editor. As setas do meio trazem cada trecho do disco.`}</div><button class="chip" data-a="edit">Voltar ao editor</button>`; // cmpNote: Comparar com… (vcs.js)
  } else if (t.gone) {
    bar.innerHTML = `<span class="xi">!</span><div class="xt"><b>${esc(xsName(t))}</b> foi apagado ou movido fora da IDE. O texto continua aqui; salve para recriar o arquivo.</div><button class="chip" data-a="close">Fechar aba</button>`;
  } else {
    const c = t.conflict;
    const what = c.n ? `${c.n} ${c.n === 1 ? 'trecho em conflito ficou' : 'trechos em conflito ficaram'} com a sua versão.` : 'Suas alterações em andamento foram mantidas.';
    bar.innerHTML = `<span class="xi">!</span><div class="xt"><b>${esc(xsName(t))}</b> mudou fora da IDE enquanto você editava. ${what}${inExt ? '<span class="xs">Esquerda: disco · direita: o seu editor. As setas do meio trazem cada trecho do disco.</span>' : ''}</div>`
      + (inExt ? '<button class="chip" data-a="edit">Voltar ao editor</button>' : '<button class="chip primary" data-a="diff">Ver diff</button>')
      + '<button class="chip" data-a="disk" title="Descarta as suas alterações em andamento">Usar a do disco</button><button class="chip" data-a="mine" title="Fica com o editor; salvar grava por cima do disco">Manter a minha</button>';
  }
  bar.querySelectorAll('[data-a]').forEach(b => b.onclick = () => xsAct(t, b.dataset.a));
}
function xsAct(t, a) {
  if (a === 'diff') return xsOpenExt(t);
  if (a === 'edit') return activate(t);
  if (a === 'close') return closeTab(t);
  if (a === 'disk' && t.conflict) { const disk = t.conflict.disk; t.saved = disk; xsFlash(t.model, xsApply(t.model, disk)); markDirty(t.model); toast('Ficou a versão do disco: ' + xsName(t), 'ok'); }
  if (a === 'mine') toast('Ficou a sua versão. Salve (Ctrl+S) para gravar por cima do disco.');
  xsClearConflict(t);
  const x = xsExtTab(t); if (x) closeTab(x);
  if (S.active !== t && S.tabs.includes(t)) activate(t);
}

// ----- conferir uma aba contra o disco -----
// uma conferência por aba de cada vez (o vigia, o foco da janela e o salvar podem pedir juntos)
async function xsCheck(tab, st) {
  while (XS.busy.has(tab)) await XS.busy.get(tab);
  const p = xsCheckNow(tab, st); XS.busy.set(tab, p);
  try { await p; } finally { if (XS.busy.get(tab) === p) XS.busy.delete(tab); }
}
async function xsCheckNow(tab, st) {
  if (!tab.editable || tab.owner || tab.model.isDisposed()) return;
  try {
    if (st === undefined) st = (await api('file/stat', { project: tab.project }, { method: 'POST', body: JSON.stringify({ files: [tab.path] }) })).files[tab.path];
    if (!st) { xsGone(tab); return; }
    if (tab.stamp && xsStamp(st) === tab.stamp && !tab.gone) return;
    const f = await api('file', { project: tab.project, file: tab.path });
    if (f.binary || f.tooBig || tab.model.isDisposed()) return;
    tab.stamp = f.mtime + ':' + f.size; tab.enc = f.encoding; tab.bom = f.bom;
    if (tab.gone) { tab.gone = false; tab.saved = tab.goneSaved; markDirty(tab.model); xsBar(); } // voltou (ex.: git checkout)
    xsResolve(tab, xsNorm(f.content, tab.model));
  } catch (e) { if (e.message !== 'login') console.warn('ext check', tab.path, e); }
}
function xsGone(tab) {
  if (tab.gone) return;
  tab.gone = true; tab.stamp = null; tab.goneSaved = tab.saved; tab.saved = '\u0000'; markDirty(tab.model); // fica "não salvo": salvar recria
  toast(`${xsName(tab)} foi apagado ou movido fora da IDE`, 'err', 'ext:' + tab.key);
  xsBar();
}
// a regra: o disco mudou para `disk`; decide o que fazer com o editor
function xsResolve(tab, disk) {
  if (disk === tab.saved || disk === tab.pending) return; // nada de novo (ou é a gravação desta própria aba)
  const mine = tab.model.getValue(), name = xsName(tab);
  if (mine === disk) { tab.saved = disk; markDirty(tab.model); xsClearConflict(tab); return; }
  if (!tab.dirty || mine === tab.saved) {
    tab.saved = disk; xsFlash(tab.model, xsApply(tab.model, disk)); markDirty(tab.model); xsClearConflict(tab);
    xsAfter(tab); toast('Atualizado do disco: ' + name, null, 'ext:' + tab.key);
    return;
  }
  const base = tab.saved;
  tab.saved = disk; // daqui em diante "não salvo" = o que difere do disco
  if (XS.rule === 'ask') { markDirty(tab.model); xsSetConflict(tab, disk, null); xsAfter(tab); return; }
  const m = xsMerge3(base, mine, disk);
  xsFlash(tab.model, xsApply(tab.model, m.text)); markDirty(tab.model);
  if (m.conflicts.length) { xsSetConflict(tab, disk, m.conflicts); toast(`${name}: ${m.conflicts.length} ${m.conflicts.length === 1 ? 'conflito' : 'conflitos'} com a versão do disco`, 'err', 'ext:' + tab.key); }
  else { xsClearConflict(tab); toast(`${name}: alterações de fora mescladas com as suas`, 'ok', 'ext:' + tab.key); }
  xsAfter(tab);
}
// marcas da margem e diff de trabalho acompanham o texto novo
function xsAfter(tab) {
  if (S.active === tab && tab.base) gutterMarks(tab);
  const x = xsExtTab(tab); if (x && tab.conflict && x.original.getValue() !== tab.conflict.disk) x.original.setValue(tab.conflict.disk);
  renderTabs();
}
// antes de salvar: se o disco mudou desde a última leitura, mescla primeiro e só grava se não sobrou conflito novo
async function xsBeforeSave(tab) {
  let st; try { st = (await api('file/stat', { project: tab.project }, { method: 'POST', body: JSON.stringify({ files: [tab.path] }) })).files[tab.path]; } catch { return true; }
  if (st && tab.stamp && xsStamp(st) !== tab.stamp) {
    const had = tab.conflict && tab.conflict.at;
    await xsCheck(tab, st);
    if (tab.conflict && tab.conflict.at !== had) { toast(`${xsName(tab)} mudou fora da IDE: confira o diff antes de salvar`, 'err', 'ext:' + tab.key); return false; }
  }
  xsClearConflict(tab); // salvar com conflito pendente = ficar com a sua versão
  const x = xsExtTab(tab); if (x) closeTab(x);
  if (tab.gone) { tab.gone = false; xsBar(); }
  return true;
}

// ----- projeto: árvore, Alterações e bases do diff -----
function xsTree(paths) {
  if (!S.project) return;
  if (paths === null) XS.treeDirs.add('*');
  else paths.forEach(p => { const segs = p.split('/'); for (let i = segs.length - 1; i >= 0; i--) XS.treeDirs.add(segs.slice(0, i).join('/')); });
  clearTimeout(XS.treeT);
  XS.treeT = setTimeout(async () => {
    const proj = S.project && S.project.path; if (!proj) return;
    const all = XS.treeDirs.has('*');
    const dirs = Object.keys(S.tree).filter(k => all || XS.treeDirs.has(k)); XS.treeDirs.clear();
    SE.index = null; SE.indexFor = null; // Buscar em tudo relê a lista de arquivos
    // busca as pastas novas antes de trocar: a árvore não pisca nem fecha
    const got = await Promise.all(dirs.map(d => api('tree', { project: proj, dir: d, compact: S.compact ? '1' : '0' }).then(items => [d, items]).catch(() => null)));
    if (!S.project || S.project.path !== proj) return;
    got.filter(Boolean).forEach(([d, items]) => { S.tree[d] = items; });
    if ($('#treeRoot')) renderTree();
  }, 350);
}
function xsRefresh(vcs) {
  XS.vcs = XS.vcs || vcs;
  clearTimeout(XS.refreshT);
  XS.refreshT = setTimeout(async () => {
    const proj = S.project && S.project.path, all = XS.vcs; XS.vcs = false; if (!proj) return;
    await refreshProject();
    if (!S.project || S.project.path !== proj || !S.project.vcs) return;
    // marcas da margem: base nova depois de commit, checkout, stash...
    const work = new Map(S.workFiles.map(c => [c.path, c.code]));
    for (const t of S.tabs.filter(t => t.project === proj && !t.owner)) {
      const code = work.get(t.path);
      if (t.mode === 'editor') {
        if (code && code !== '?') api('diff', { project: proj, file: t.path, mode: 'working' }).then(d => { if (t.model.isDisposed()) return; t.base = d.original; if (S.active === t) gutterMarks(t); }).catch(() => {});
        else if (t.base || all) { t.base = null; if (S.active === t && editor) t.decos = editor.deltaDecorations(t.decos || [], []); }
      } else if (t.changeMode === 'working') {
        api('diff', { project: proj, file: t.path, mode: 'working' }).then(d => { if (!t.original.isDisposed() && t.original.getValue() !== d.original) t.original.setValue(d.original); }).catch(() => {});
      }
    }
  }, 600);
}
function xsEvents(proj, r) {
  const touched = new Set((r.files || []).map(f => f.p));
  const tabs = S.tabs.filter(t => t.project === proj && t.editable && !t.owner);
  tabs.filter(t => r.all || touched.has(t.path)).forEach(t => xsCheck(t));
  const struct = (r.files || []).filter(f => f.k !== 'change').map(f => f.p);
  if (r.all) xsTree(null); else if (struct.length) xsTree(struct);
  if (r.vcs || touched.size) xsRefresh(!!r.vcs);
  BS.hooks.run('files:changed', proj, r); // visualizador de imagens e outros recarregam o que mudou
}
// confere de uma vez todas as abas do projeto (sem vigia, ou ao voltar para a janela)
async function xsCheckAll() {
  const proj = S.project && S.project.path; if (!proj) return;
  const tabs = S.tabs.filter(t => t.project === proj && t.editable && !t.owner); if (!tabs.length) return;
  let st; try { st = (await api('file/stat', { project: proj }, { method: 'POST', body: JSON.stringify({ files: [...new Set(tabs.map(t => t.path))] }) })).files; } catch { return; }
  tabs.forEach(t => { const s = st[t.path]; if (!s || !t.stamp || xsStamp(s) !== t.stamp || t.gone) xsCheck(t, s); });
}

// laço do vigia: long-poll em /api/watch; sem fetch de api() para não acender a barra de "carregando"
async function xsLoop() {
  for (;;) {
    const proj = S.project && S.project.path;
    if (!proj) { XS.seq = null; await xsSleep(800); continue; }
    if (XS.for !== proj) XS.seq = null;
    XS.ctl = new AbortController();
    let r;
    try {
      const u = new URL('/api/watch', location.origin); u.searchParams.set('project', proj);
      if (XS.seq != null) u.searchParams.set('since', XS.seq);
      const res = await fetch(u, { signal: XS.ctl.signal });
      if (res.status === 401) { await xsSleep(5000); continue; }
      r = await res.json(); if (!r || r.error) throw new Error(r && r.error);
    } catch (e) { if (e.name !== 'AbortError') await xsSleep(3000); continue; }
    if (!S.project || S.project.path !== proj) continue;
    const first = XS.seq == null; XS.seq = r.seq; XS.for = proj; XS.native = !!r.native;
    if (!r.native) { await xsSleep(2000); xsCheckAll(); continue; }
    if (first) { xsCheckAll(); continue; } // o que mudou enquanto ninguém vigiava
    xsEvents(proj, r);
  }
}

(function xsInit() {
  const bar = document.createElement('div'); bar.id = 'extBar'; bar.hidden = true; bar.setAttribute('role', 'alert');
  $('#mon').appendChild(bar);
  BS.ext = { beforeSave: xsBeforeSave, check: xsCheck, checkAll: xsCheckAll, merge3: xsMerge3, openDiff: xsOpenExt, get rule() { return XS.rule; } };
  BS.hooks.on('tab:activate', () => xsBar());
  BS.hooks.on('tab:close', () => setTimeout(xsBar));
  BS.hooks.on('tab:open', (t) => { if (t.model) t.model.onDidChangeContent(() => { if (t.conflict && t.model.getValue() === t.saved) xsClearConflict(t); }); });
  BS.hooks.on('project:select', () => { XS.seq = null; XS.ctl && XS.ctl.abort(); xsBar(); });
  BS.hooks.on('refresh', () => xsCheckAll());
  // de volta à janela: confere já (cobre pastas ignoradas pelo vigia e arquivos fora do projeto)
  window.addEventListener('focus', () => xsCheckAll());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) xsCheckAll(); });
  const setRule = (r) => { XS.rule = r; store.set('extRule', r); toast('Alterações de fora com edição em andamento: ' + XS_RULES[r], 'ok'); };
  BS.actions.add([
    ...Object.entries(XS_RULES).map(([k, v]) => ({ label: 'Alterações externas: ' + v, run: () => setRule(k), icon: I.diff })),
    { label: 'Ver diff com a versão do disco (alteração externa)', run: () => { const t = S.active && (S.active.owner || S.active); if (t && t.editable) xsOpenExt(t); }, icon: I.diff },
    { label: 'Conferir abas abertas com o disco', run: () => xsCheckAll(), icon: I.refresh },
  ]);
  xsLoop();
})();
