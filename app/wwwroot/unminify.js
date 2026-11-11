'use strict';
// ===== Arquivos minificados (.min.js, bundles, CSS de uma linha, JSON compactado) =====
// Ao abrir um arquivo minificado, a IDE abre ao lado a versão desminificada, só de leitura (unminify.worker.js:
// JavaScript volta a ter if/else e uma instrução por linha; CSS, HTML e JSON são reindentados). O arquivo original
// continua aberto e editável na sua aba.
// - Ctrl+Alt+U (ou o "Minificado" na barra de status) alterna entre as duas abas na mesma posição do código: o mapa
//   que o worker devolve liga cada identificador e literal do formatado ao lugar dele no original.
// - Editou o original: a aba formatada se refaz quando você volta para ela.
// - "Aplicar no arquivo" troca o conteúdo do original pelo formatado (desfaz com Ctrl+Z).
// - Diff de um minificado (uma linha só que mudou) ganha "Comparar desminificado": o diff dos dois lados formatados.
// - Arquivo minificado grande demais para o editor (> 2 MB, abre no leitor de linhas): até 32 MB, abre formatado.
const UM = { worker: null, seq: 0, wait: new Map(), auto: store.get('unminAuto', true) };
const UM_MAX = 32 << 20;
const UM_KIND = { javascript: 'js', typescript: 'js', json: 'json', css: 'css', scss: 'css', less: 'css', html: 'html', xml: 'html', jsp: 'html' };
const umKind = (lang) => UM_KIND[lang] || null;

function umRun(text, kind) {
  if (!UM.worker) {
    UM.worker = new Worker('unminify.worker.js');
    UM.worker.onmessage = (e) => { const w = UM.wait.get(e.data.id); if (!w) return; UM.wait.delete(e.data.id); e.data.error && e.data.how == null ? w.reject(new Error(e.data.error)) : w.resolve(e.data); };
    UM.worker.onerror = (e) => { for (const w of UM.wait.values()) w.reject(new Error(e.message || 'falha no desminificador')); UM.wait.clear(); UM.worker = null; };
  }
  const id = ++UM.seq, indent = (editor && editor.getModel() && editor.getModel().getOptions().tabSize) || 4;
  return new Promise((resolve, reject) => { UM.wait.set(id, { resolve, reject }); UM.worker.postMessage({ id, text, kind, indent }); });
}

// minificado: a maior parte do texto está em linhas muito longas (o .min.js de uma linha, o bundle com poucas linhas
// gigantes, o CSS compactado). Licença no topo e um "\n" no fim não atrapalham.
function umIsMinified(text) {
  if (!text || text.length < 200) return false;
  let long = 0, start = 0, lines = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) { const n = i - start; lines++; if (n >= 300) long += n; start = i + 1; }
  }
  return long / text.length > 0.6 || (lines <= 3 && text.length >= 300 && text.length / lines > 250);
}

// ----- posição: original <-> formatado -----
// map: [linhaGerada, colunaGerada, linhaOriginal, colunaOriginal, ...] (linhas a partir de 1, colunas a partir de 0)
function umIndex(map, gen) {
  const n = map.length / 4, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  const a = gen ? 0 : 2;
  idx.sort((x, y) => map[x * 4 + a] - map[y * 4 + a] || map[x * 4 + a + 1] - map[y * 4 + a + 1]);
  return idx;
}
// o ponto do mapa mais perto antes de pos (pos: { lineNumber, column } do Monaco)
function umLookup(map, idx, gen, pos) {
  const a = gen ? 0 : 2, l = pos.lineNumber, c = pos.column - 1;
  let lo = 0, hi = idx.length;
  while (lo < hi) { const m = (lo + hi) >> 1, k = idx[m] * 4; if (map[k + a] < l || map[k + a] === l && map[k + a + 1] <= c) lo = m + 1; else hi = m; }
  if (!lo) return { lineNumber: 1, column: 1 };
  const k = idx[lo - 1] * 4, b = gen ? 2 : 0;
  return { lineNumber: map[k + b], column: map[k + b + 1] + 1 };
}
// sem mapa (CSS/HTML/JSON, ou JS que só foi reindentado): os dois textos têm os mesmos caracteres fora os espaços
function umByChars(fromModel, toModel, pos) {
  const a = fromModel.getValue(), b = toModel.getValue(), off = fromModel.getOffsetAt(pos);
  let n = 0; for (let i = 0; i < off && i < a.length; i++) if (a.charCodeAt(i) > 32) n++;
  let j = 0; for (; j < b.length && n > 0; j++) if (b.charCodeAt(j) > 32) n--;
  while (j < b.length && b.charCodeAt(j) <= 32) j++;
  return toModel.getPositionAt(j);
}
function umMapPos(ft, toFormatted, pos) {
  const u = ft.unmin, src = u.src;
  if (u.map && u.map.length) {
    if (toFormatted) { u.idxO = u.idxO || umIndex(u.map, false); return umLookup(u.map, u.idxO, false, pos); }
    u.idxG = u.idxG || umIndex(u.map, true); return umLookup(u.map, u.idxG, true, pos);
  }
  return toFormatted ? umByChars(src.model, ft.model, pos) : umByChars(ft.model, src.model, pos);
}

// ----- abas -----
const umName = (path) => { const n = path.split('/').pop(), i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i).replace(/\.min$/, '') + '.formatado' + n.slice(i) : n + '.formatado'; };
const umKey = (t) => 'unmin:' + t.project + ':' + t.path;
const umHow = (r) => r.how === 'ast' ? 'desminificado' : 'reindentado' + (r.error ? ' (o parser de JavaScript não entendeu: ' + r.error + ')' : '');

async function umOpen(src, pos) {
  const kind = umKind(src.lang); if (!kind || !src.model) return toast('Desminificar: só JavaScript, TypeScript, JSON, CSS e HTML');
  let ft = src.unminTab && S.tabs.includes(src.unminTab) ? src.unminTab : null;
  const ver = src.model.getAlternativeVersionId();
  if (!ft || ft.unmin.ver !== ver) {
    let r; try { r = await umRun(src.model.getValue(), kind); } catch (e) { return toast('Não deu para desminificar: ' + e.message); }
    if (ft) { ft.model.setValue(r.code); ft.saved = r.code; }
    else {
      ft = openVirtual(umKey(src), umName(src.path), r.code, src.lang, 0, `${src.path} · ${umHow(r)} (só leitura)`);
      src.unminTab = ft;
    }
    ft.unmin = { src, map: r.map, ver, how: r.how }; ft.idxG = ft.idxO = null;
    if (r.unpacked) toast('Desempacotado (packer eval(function(p,a,c,k,e,d)...))', 'ok');
  }
  if (S.active !== ft) activate(ft);
  if (pos) { const p = umMapPos(ft, true, pos); revealAt(editor, p.lineNumber, p.column); }
  umStatus();
  return ft;
}
function umToggle() {
  const t = S.active; if (!t) return;
  if (t.unmin) { // formatado -> original, na mesma posição
    const src = t.unmin.src; if (!S.tabs.includes(src)) return openFile(src.path, 'editor', undefined, undefined, src.project);
    if (!src.model) return activate(src); // leitor de arquivo grande: sem modelo para mapear a posição
    const p = umMapPos(t, false, editor.getPosition()); activate(src); revealAt(editor, p.lineNumber, p.column); return;
  }
  if (t.mode === 'diff') return umDiff(t);
  if (t.mode === 'editor' && !t.virtual) umOpen(t, editor.getPosition());
}
// troca o conteúdo do arquivo pelo formatado (uma edição só no histórico: Ctrl+Z volta ao minificado)
function umApply() {
  const t = S.active; if (!t || !t.unmin) return;
  const src = t.unmin.src; if (!S.tabs.includes(src) || !src.editable) return toast('O arquivo original não está aberto para edição');
  const m = src.model, code = t.model.getValue();
  m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: code }], () => null); m.pushStackElement();
  closeTab(t); activate(src); toast('Formatado aplicado ao arquivo (Ctrl+Z desfaz)', 'ok');
}

// diff de minificado: os dois lados desminificados numa aba de diff só de leitura
async function umDiff(t) {
  const kind = umKind(t.lang); if (!kind) return toast('Desminificar: só JavaScript, TypeScript, JSON, CSS e HTML');
  const k = 'unmindiff:' + t.key; let d = S.tabs.find(x => x.key === k);
  if (!d) {
    let a, b; try { [a, b] = await Promise.all([umRun(t.original.getValue(), kind), umRun(t.model.getValue(), kind)]); } catch (e) { return toast('Não deu para desminificar: ' + e.message); }
    d = { key: k, path: t.path, title: t.path + ' · diff desminificado (só leitura)', mode: 'diff', virtual: true, editable: false, project: t.project, lang: t.lang, changeMode: t.changeMode, rev: t.rev, unminDiff: t };
    d.original = monaco.editor.createModel(a.code, t.lang); d.model = monaco.editor.createModel(b.code, t.lang); d.saved = b.code; d.model._tab = d;
    S.tabs.push(d);
  }
  activate(d);
}

// ----- barra de status -----
function umStatus() {
  const el = $('#stMin'); if (!el) return;
  const t = S.active;
  const on = t && (t.unmin || t.unminDiff || t.minified);
  el.hidden = !on; if (!on) return;
  if (t.unmin) { el.textContent = t.unmin.how === 'ast' ? 'Desminificado' : 'Reindentado'; el.title = 'Voltar ao original na mesma posição (Ctrl+Alt+U). Botão direito: aplicar no arquivo'; }
  else if (t.unminDiff) { el.textContent = 'Diff desminificado'; el.title = 'Comparando os dois lados formatados'; }
  else { el.textContent = 'Minificado'; el.title = t.mode === 'diff' ? 'Comparar os dois lados desminificados (Ctrl+Alt+U)' : 'Ler desminificado na mesma posição (Ctrl+Alt+U)'; }
}
function umMenu(e) {
  e.preventDefault();
  showMenu(e, [
    S.active && S.active.unmin ? { label: 'Aplicar formatado no arquivo', icon: I.edit, action: umApply } : null,
    { label: (UM.auto ? '✓ ' : '') + 'Abrir minificados já desminificados', icon: I.edit, action: () => { UM.auto = !UM.auto; store.set('unminAuto', UM.auto); toast(UM.auto ? 'Minificados abrem desminificados ao lado' : 'Minificados abrem como estão (Ctrl+Alt+U desminifica)'); } },
  ].filter(Boolean), 'Minificado');
}

// ----- arquivo grande demais para o editor (leitor de linhas) -----
async function umBig(t) {
  if (!umKind(langOf(t.path))) return;
  const u = `/api/raw?project=${encodeURIComponent(t.project)}&file=${encodeURIComponent(t.path)}`;
  try {
    const head = await fetch(u + '&offset=0&len=65536'); const size = +head.headers.get('x-file-size') || 0;
    if (!size || size > UM_MAX || !umIsMinified(await head.text())) return;
    toast('Minificado grande: desminificando…', '', 'unmin');
    const text = await (await fetch(u)).text();
    const r = await umRun(text, umKind(langOf(t.path)));
    const ft = openVirtual(umKey(t), umName(t.path), r.code, langOf(t.path), 0, `${t.path} · ${umHow(r)} (só leitura)`);
    ft.unmin = { src: t, map: null, ver: 0, how: r.how }; umStatus();
    toast('Desminificado: ' + r.code.split('\n').length.toLocaleString('pt-BR') + ' linhas', 'ok', 'unmin');
  } catch (e) { toast('Não deu para desminificar: ' + e.message, 'err', 'unmin'); }
}

BS.hooks.on('tab:open', (t) => {
  if (t.virtual || t.unmin) return;
  if (t.mode === 'view') { if (t.kind === 'big' && UM.auto) setTimeout(() => umBig(t)); return; }
  if (!t.model || !umKind(t.lang) || !umIsMinified(t.model.getValue())) return;
  t.minified = true;
  // depois do openFile ativar a aba original (o worker responde depois disso)
  if (t.mode === 'editor' && UM.auto && !t.preview && !DOC) setTimeout(() => umOpen(t));
});
BS.hooks.on('tab:activate', (t) => {
  if (t.unmin && S.tabs.includes(t.unmin.src) && t.unmin.src.model && t.unmin.ver && t.unmin.src.model.getAlternativeVersionId() !== t.unmin.ver) umOpen(t.unmin.src); // o original mudou: refaz
  umStatus();
});
BS.hooks.on('tab:close', (t) => { if (t.unminTab && S.tabs.includes(t.unminTab)) setTimeout(() => closeTab(t.unminTab)); });
BS.hooks.on('editor:ready', (ed, dd) => {
  const kb = [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyU];
  ed.addAction({ id: 'bs.unmin', label: 'Ler desminificado / voltar ao original', keybindings: kb, contextMenuGroupId: 'navigation', contextMenuOrder: 5, run: umToggle });
  ed.addAction({ id: 'bs.unmin.apply', label: 'Aplicar formatado no arquivo', contextMenuGroupId: 'navigation', contextMenuOrder: 6, precondition: 'editorReadonly', run: umApply });
  dd.getModifiedEditor().addAction({ id: 'bs.unmin.diff', label: 'Comparar desminificado', keybindings: kb, contextMenuGroupId: 'navigation', contextMenuOrder: 3, run: umToggle });
});
BS.actions.add([{ label: 'Desminificar o arquivo aberto (ou voltar ao original)', k: 'Ctrl+Alt+U', run: umToggle }]);
{ const el = $('#stMin'); if (el) { el.onclick = umToggle; el.oncontextmenu = umMenu; } }
BS.unminify = { run: umRun, isMinified: umIsMinified, open: umOpen, toggle: umToggle };
