'use strict';
// ===== Markdown: barra de formatação e atalhos (Ctrl+B negrito, Ctrl+I itálico, Ctrl+K link...) =====
// Com um .md aberto no editor, aparece uma barra em cima do texto: títulos, negrito, itálico, riscado, código, link,
// imagem, listas, tarefa, citação, bloco de código, tabela e linha. Cada botão age na seleção (ou na palavra do
// cursor) e desfaz o que já estava aplicado: negrito em cima de **texto** tira o negrito. Enter numa lista continua
// a lista; Enter num item vazio sai dela. Os atalhos só valem em arquivos Markdown.
(function mdInit() {
const svg = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  h: svg('<path d="M5 5v14M13 5v14M5 12h8"/><path d="M17 11l3-2v10"/>'),
  bold: svg('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" stroke-width="2.1"/>'),
  italic: svg('<path d="M10 5h8M6 19h8M14 5l-4 14"/>'),
  strike: svg('<path d="M4 12h16M16 7.5C15.4 6 14 5 12 5c-2.4 0-4 1.3-4 3.2 0 1.2.6 2 1.6 2.6M8 16.2C8.500 17.900 10 19 12.200 19c2.400 0 4-1.300 4-3.300 0-.6-.1-1.100-.4-1.600"/>'),
  code: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>'),
  image: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.500" cy="10" r="1.500"/><path d="M21 16l-5-5-8 8"/>'),
  ul: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.500" cy="6" r="1"/><circle cx="4.500" cy="12" r="1"/><circle cx="4.500" cy="18" r="1"/>'),
  ol: svg('<path d="M10 6h10M10 12h10M10 18h10M4 4.500l1.500-.5v4M4 15.500c0-1.300 2.500-1.300 2.500 0 0 1-2.500 1.500-2.500 3h2.500"/>'),
  task: svg('<rect x="3.500" y="4.500" width="6" height="6" rx="1.200"/><path d="M5 7.500l1.200 1.200L8.300 6.500M13 7.500h8M13 16.500h8"/><rect x="3.500" y="13.500" width="6" height="6" rx="1.200"/>'),
  quote: svg('<path d="M5 6v12M10 8h10M10 12h10M10 16h6"/>'),
  block: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 9.500L7.500 12l2.500 2.500M14 9.500l2.500 2.500-2.500 2.500"/>'),
  table: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 14.500h18M9.500 5v14M15 5v14"/>'),
  hr: svg('<path d="M4 12h16M8 7h8M8 17h8" stroke-dasharray="0"/><path d="M4 12h16" stroke-width="2.200"/>'),
  caret: '<svg class="i" viewBox="0 0 24 24" style="width:10px;height:10px"><path d="M6 9l6 6 6-6"/></svg>',
};
// [id, título, ícone, atalho (Monaco) | null, rótulo do atalho]
const TOOLS = [
  ['bold', 'Negrito', IC.bold, 'Ctrl+B'], ['italic', 'Itálico', IC.italic, 'Ctrl+I'], ['strike', 'Riscado', IC.strike, 'Ctrl+Shift+X'], ['code', 'Código', IC.code, 'Ctrl+E'], '-',
  ['link', 'Link', IC.link, 'Ctrl+K'], ['image', 'Imagem', IC.image, 'Ctrl+Shift+I'], '-',
  ['ul', 'Lista', IC.ul, 'Ctrl+Shift+8'], ['ol', 'Lista numerada', IC.ol, 'Ctrl+Shift+7'], ['task', 'Lista de tarefas', IC.task, 'Ctrl+Shift+9'], ['quote', 'Citação', IC.quote, 'Ctrl+Shift+.'], '-',
  ['block', 'Bloco de código', IC.block, 'Ctrl+Shift+K'], ['table', 'Tabela', IC.table, null], ['hr', 'Linha divisória', IC.hr, null],
];
const HEADS = [[1, 'Título 1', 'Ctrl+Alt+1'], [2, 'Título 2', 'Ctrl+Alt+2'], [3, 'Título 3', 'Ctrl+Alt+3'], [4, 'Título 4', 'Ctrl+Alt+4'], [0, 'Texto normal', 'Ctrl+Alt+0']];

const bar = document.createElement('div'); bar.id = 'mdBar'; bar.hidden = true; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Formatação do Markdown');
bar.innerHTML = `<button type="button" class="md-b md-h" data-t="heading" title="Título (Ctrl+Alt+1 a 4)" aria-haspopup="menu">${IC.h}${IC.caret}</button><i class="md-sep"></i>`
  + TOOLS.map(t => t === '-' ? '<i class="md-sep"></i>' : `<button type="button" class="md-b" data-t="${t[0]}" title="${t[1]}${t[3] ? ` (${t[3]})` : ''}" aria-label="${t[1]}">${t[2]}</button>`).join('');
$('#mon').appendChild(bar);
// o clique não tira o foco (nem a seleção) do editor
bar.addEventListener('mousedown', (e) => e.preventDefault());
bar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  if (b.dataset.t === 'heading') { const r = b.getBoundingClientRect(); return showMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, HEADS.map(([n, l, k]) => ({ label: l, k, action: () => run('h' + n) }))); }
  run(b.dataset.t);
});

const isMd = () => typeof pvActiveKind === 'function' && pvActiveKind() === 'md';
let ctx = null;
function sync() {
  const on = isMd() && !($('#pv') && !$('#pv').hidden && $('#pv').classList.contains('only'));
  bar.hidden = !on; $('#mon').classList.toggle('md-on', on);
  if (ctx) ctx.set(isMd());
}
BS.hooks.on('tab:activate', () => setTimeout(sync));
BS.hooks.on('tab:close', () => setTimeout(sync, 20));
// trocar o modo de visualização (só editor, lado a lado, só visualização) muda quem aparece
const basePvSync = window.pvSync; if (typeof basePvSync === 'function') window.pvSync = function () { const r = basePvSync.apply(this, arguments); sync(); return r; };

// ---------- edição ----------
const ed = () => (typeof editor !== 'undefined' ? editor : null);
/** Envolve a seleção (ou a palavra do cursor) com a marca; se já está envolvida, tira. Sem texto, deixa o cursor no meio. */
function wrap(mark, close = mark) {
  const e = ed(), m = e.getModel(), edits = [], sels = [];
  for (const s0 of e.getSelections()) {
    let s = s0;
    if (s.isEmpty()) { const w = m.getWordAtPosition(s.getPosition()); if (w) s = new monaco.Selection(s.startLineNumber, w.startColumn, s.startLineNumber, w.endColumn); }
    const text = m.getValueInRange(s);
    const before = m.getValueInRange(new monaco.Range(s.startLineNumber, Math.max(1, s.startColumn - mark.length), s.startLineNumber, s.startColumn));
    const after = m.getValueInRange(new monaco.Range(s.endLineNumber, s.endColumn, s.endLineNumber, s.endColumn + close.length));
    // itálico (*) encostado em negrito (**) não conta como itálico já aplicado
    const lone = (str, i, c) => mark !== '*' && mark !== '_' ? true : str[i] !== c;
    if (text.length >= mark.length + close.length && text.startsWith(mark) && text.endsWith(close) && lone(text, mark.length, mark) ) {
      const inner = text.slice(mark.length, text.length - close.length);
      edits.push({ range: s, text: inner }); sels.push(new monaco.Selection(s.startLineNumber, s.startColumn, s.endLineNumber, s.endLineNumber === s.startLineNumber ? s.startColumn + inner.length : s.endColumn - close.length));
    } else if (before === mark && after === close && lone(m.getLineContent(s.startLineNumber), s.startColumn - mark.length - 2, mark)) {
      edits.push({ range: new monaco.Range(s.startLineNumber, s.startColumn - mark.length, s.endLineNumber, s.endColumn + close.length), text });
      const one = s.startLineNumber === s.endLineNumber;
      sels.push(new monaco.Selection(s.startLineNumber, s.startColumn - mark.length, s.endLineNumber, one ? s.endColumn - mark.length : s.endColumn));
    } else {
      edits.push({ range: s, text: mark + text + close });
      const one = s.startLineNumber === s.endLineNumber;
      sels.push(new monaco.Selection(s.startLineNumber, s.startColumn + mark.length, s.endLineNumber, one ? s.endColumn + mark.length : s.endColumn));
    }
  }
  apply(edits, sels);
}
function apply(edits, sels) { const e = ed(); e.pushUndoStop(); e.executeEdits('markdown', edits, sels); e.pushUndoStop(); e.focus(); }
const PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;
/** Troca o começo das linhas da seleção: kind = 'ul' | 'ol' | 'task' | 'quote' | 'h1'..'h6' | 'h0' (texto normal). Repetir tira. */
function lines(kind) {
  const e = ed(), m = e.getModel(), s = e.getSelection();
  const from = s.startLineNumber, to = s.endColumn === 1 && s.endLineNumber > from ? s.endLineNumber - 1 : s.endLineNumber;
  const want = (i) => kind === 'ul' ? '- ' : kind === 'ol' ? `${i + 1}. ` : kind === 'task' ? '- [ ] ' : kind === 'quote' ? '> ' : kind === 'h0' ? '' : '#'.repeat(+kind.slice(1)) + ' ';
  const is = (p) => !p ? kind === 'h0' : kind === 'ul' ? /^[-*+]\s+$/.test(p) : kind === 'ol' ? /^\d+[.)]\s+$/.test(p) : kind === 'task' ? /^[-*+]\s+\[/.test(p) : kind === 'quote' ? p[0] === '>' : p.trim() === want(0).trim();
  const rows = []; for (let n = from; n <= to; n++) { const t = m.getLineContent(n), x = PREFIX.exec(t); rows.push({ n, t, ind: x[1], pre: x[2] || '' }); }
  const real = rows.filter(r => r.t.trim() || rows.length === 1);
  const off = kind !== 'h0' && real.every(r => is(r.pre)); // todas já estão assim: tira
  let i = 0; const edits = [];
  for (const r of rows) {
    if (!r.t.trim() && rows.length > 1) continue;
    edits.push({ range: new monaco.Range(r.n, 1, r.n, r.ind.length + r.pre.length + 1), text: r.ind + (off ? '' : want(i++)) });
  }
  const last = rows[rows.length - 1];
  apply(edits, null);
  const len = m.getLineMaxColumn(last.n);
  e.setSelection(rows.length > 1 ? new monaco.Selection(from, 1, last.n, len) : new monaco.Selection(last.n, len, last.n, len));
}
function link(image) {
  const e = ed(), m = e.getModel(); let s = e.getSelection();
  if (s.isEmpty()) { const w = m.getWordAtPosition(s.getPosition()); if (w && !image) s = new monaco.Selection(s.startLineNumber, w.startColumn, s.startLineNumber, w.endColumn); }
  const text = m.getValueInRange(s), isUrl = /^(https?:\/\/|www\.|\.{0,2}\/)\S+$/i.test(text.trim()) || (image && /\.(png|jpe?g|gif|svg|webp)$/i.test(text.trim()));
  const label = isUrl ? (image ? 'descrição' : 'texto') : (text || (image ? 'descrição' : 'texto')), url = isUrl ? text.trim() : (image ? 'caminho/da/imagem.png' : 'https://');
  const out = `${image ? '!' : ''}[${label}](${url})`, col = s.startColumn + (image ? 1 : 0);
  // fica selecionado o que falta preencher: o endereço (havia texto) ou o texto (havia endereço)
  const pick = isUrl || !text ? [col + 1, col + 1 + label.length] : [col + label.length + 3, col + label.length + 3 + url.length];
  apply([{ range: s, text: out }], [new monaco.Selection(s.startLineNumber, text && !isUrl ? pick[0] : col + 1, s.startLineNumber, text && !isUrl ? pick[1] : col + 1 + label.length)]);
}
function block() {
  const e = ed(), m = e.getModel(), s = e.getSelection();
  if (s.isEmpty()) {
    const n = s.startLineNumber, empty = !m.getLineContent(n).trim();
    const text = (empty ? '' : '\n') + '```\n\n```' + (n < m.getLineCount() && !m.getLineContent(n + 1).trim() ? '' : '\n');
    const at = empty ? new monaco.Range(n, 1, n, m.getLineMaxColumn(n)) : new monaco.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n));
    const fence = empty ? n : n + 1;
    return apply([{ range: at, text }], [new monaco.Selection(fence, 4, fence, 4)]); // cursor depois das crases: digite a linguagem
  }
  const from = s.startLineNumber, to = s.endColumn === 1 && s.endLineNumber > from ? s.endLineNumber - 1 : s.endLineNumber;
  const open = from > 1 && /^\s*```/.test(m.getLineContent(from - 1)), shut = to < m.getLineCount() && /^\s*```\s*$/.test(m.getLineContent(to + 1));
  if (open && shut) return apply([{ range: new monaco.Range(to, m.getLineMaxColumn(to), to + 1, m.getLineMaxColumn(to + 1)), text: '' }, { range: new monaco.Range(from - 1, 1, from, 1), text: '' }], null);
  const body = m.getValueInRange(new monaco.Range(from, 1, to, m.getLineMaxColumn(to)));
  apply([{ range: new monaco.Range(from, 1, to, m.getLineMaxColumn(to)), text: '```\n' + body + '\n```' }], [new monaco.Selection(from, 4, from, 4)]);
}
/** Insere um bloco em linhas próprias (tabela, linha divisória), com uma linha em branco antes e depois. */
function insertBlock(text, pick) {
  const e = ed(), m = e.getModel(), n = e.getSelection().endLineNumber, cur = m.getLineContent(n);
  const empty = !cur.trim(), blankBefore = empty ? (n === 1 || !m.getLineContent(n - 1).trim()) : false;
  const lead = empty ? (blankBefore ? '' : '\n') : '\n\n', first = n + (empty ? (blankBefore ? 0 : 1) : 2);
  const at = empty ? new monaco.Range(n, 1, n, m.getLineMaxColumn(n)) : new monaco.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n));
  apply([{ range: at, text: lead + text + '\n' }], [pick ? new monaco.Selection(first, pick[0], first, pick[1]) : new monaco.Selection(first + text.split('\n').length, 1, first + text.split('\n').length, 1)]);
}
const ACTIONS = {
  bold: () => wrap('**'), italic: () => wrap('*'), strike: () => wrap('~~'), code: () => wrap('`'), link: () => link(false), image: () => link(true),
  ul: () => lines('ul'), ol: () => lines('ol'), task: () => lines('task'), quote: () => lines('quote'), block,
  table: () => insertBlock('| Coluna 1 | Coluna 2 | Coluna 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', [3, 11]),
  hr: () => insertBlock('---'),
};
for (const [n] of HEADS) ACTIONS['h' + n] = () => lines('h' + n);
function run(id) {
  const e = ed(); if (!e || !isMd() || !e.getModel()) return;
  if (e.getOption(monaco.editor.EditorOption.readOnly)) return toast('Este arquivo está aberto só para leitura');
  try { ACTIONS[id] && ACTIONS[id](); } catch (err) { console.error('markdown ' + id, err); }
}

// Enter numa lista continua a lista (com o próximo número); num item vazio, sai dela
const ITEM = /^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?|(\d+)([.)])\s+|(>)\s?)/;
function enter() {
  const e = ed(), m = e.getModel(), s = e.getSelection();
  const plain = () => e.trigger('keyboard', 'type', { text: '\n' });
  if (!s.isEmpty() || e.getSelections().length > 1) return plain();
  const n = s.startLineNumber, t = m.getLineContent(n), x = ITEM.exec(t);
  if (!x || s.startColumn <= x[0].length) return plain();
  if (!t.slice(x[0].length).trim()) return apply([{ range: new monaco.Range(n, 1, n, m.getLineMaxColumn(n)), text: '' }], [new monaco.Selection(n, 1, n, 1)]); // item vazio: sai da lista
  const next = x[6] ? '> ' : x[4] ? `${+x[4] + 1}${x[5]} ` : `${x[2]} ${x[3] ? '[ ] ' : ''}`;
  apply([{ range: s, text: '\n' + x[1] + next }], [new monaco.Selection(n + 1, x[1].length + next.length + 1, n + 1, x[1].length + next.length + 1)]);
}

BS.hooks.on('editor:ready', (e) => {
  ctx = e.createContextKey('bsMarkdown', isMd());
  const K = monaco.KeyMod, C = monaco.KeyCode;
  const CODES = { B: C.KeyB, I: C.KeyI, X: C.KeyX, E: C.KeyE, K: C.KeyK, 7: C.Digit7, 8: C.Digit8, 9: C.Digit9, '.': C.Period, 0: C.Digit0, 1: C.Digit1, 2: C.Digit2, 3: C.Digit3, 4: C.Digit4 };
  const chord = (s) => s.split('+').reduce((n, p) => n | (p === 'Ctrl' ? K.CtrlCmd : p === 'Shift' ? K.Shift : p === 'Alt' ? K.Alt : CODES[p]), 0);
  for (const t of TOOLS) if (t !== '-' && t[3]) e.addAction({ id: 'bs.md.' + t[0], label: 'Markdown: ' + t[1], keybindings: [chord(t[3])], precondition: 'bsMarkdown', run: () => run(t[0]) });
  for (const [n, l, k] of HEADS) e.addAction({ id: 'bs.md.h' + n, label: 'Markdown: ' + l, keybindings: [chord(k)], precondition: 'bsMarkdown', run: () => run('h' + n) });
  e.addAction({ id: 'bs.md.enter', label: 'Markdown: continuar a lista', keybindings: [C.Enter], precondition: 'bsMarkdown && editorTextFocus && !suggestWidgetVisible && !inSnippetMode && !editorReadonly && !renameInputVisible', run: enter });
  sync();
});
BS.markdown = { run, tools: () => TOOLS.filter(t => t !== '-').map(t => ({ id: t[0], title: t[1], key: t[3] })) };
sync();
})();
