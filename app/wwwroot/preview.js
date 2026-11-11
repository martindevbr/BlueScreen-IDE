'use strict';
// ===== Visualização ao lado do editor (Markdown e HTML), como no IntelliJ =====
// Três modos, escolhidos nos botões do canto do editor e lembrados por tipo de arquivo:
// só editor, editor + visualização (padrão) e só visualização. Ctrl+Shift+V liga/desliga.
// Markdown: renderizado aqui mesmo, por blocos (só o bloco editado é refeito) e com rolagem sincronizada.
// HTML: num iframe isolado (sandbox, sem acesso ao BlueScreen), com o texto ainda não salvo; CSS, imagens e
// scripts relativos vêm do projeto por /api/preview/<chave>/. Troca sem piscar e mantém a rolagem da página.
const PV = { kind: null, tab: null, timer: null, keys: {}, scroll: {}, over: false, lead: null, leadT: 0, frame: null, seq: 0, ratio: store.get('pvRatio', .5) };
const pvKind = (path) => /\.(md|markdown)$/i.test(path) ? 'md' : /\.html?$/i.test(path) ? 'html' : null;
const pvActiveKind = () => S.active?.mode === 'editor' && $('#welcome').hidden ? pvKind(S.active.path) : null;
const pvMode = (k) => store.get('pv.' + k, 'split');
const PV_MODES = [
  ['editor', 'Só editor', '<path d="M4 6h16M4 10h16M4 14h10M4 18h13"/>'],
  ['split', 'Editor e visualização', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 9h3M6 12h3M6 15h3"/>'],
  ['preview', 'Só visualização', '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'],
];

(function pvInit() {
  const mon = $('#mon');
  const pv = document.createElement('div'); pv.id = 'pv'; pv.hidden = true;
  pv.innerHTML = '<div id="pvSplit" title="Arraste para redimensionar (duplo clique divide ao meio)"></div><div id="pvBody"></div>';
  mon.appendChild(pv);
  const seg = document.createElement('span'); seg.id = 'pvModes'; seg.className = 'pv-seg'; seg.hidden = true;
  seg.innerHTML = PV_MODES.map(([m, t, d]) => `<button class="icon-btn" data-m="${m}" title="${t} (Ctrl+Shift+V liga/desliga)"><svg class="i" viewBox="0 0 24 24">${d}</svg></button>`).join('');
  $('#crumbs .tools').prepend(seg);
  seg.onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) pvSetMode(b.dataset.m); };
  pv.addEventListener('pointerenter', () => { PV.over = true; }); pv.addEventListener('pointerleave', () => { PV.over = false; });
  $('#pvBody').addEventListener('scroll', () => { if (PV.kind === 'md' && PV.over) pvScrollEditor(); }, { passive: true });
  // divisória: arrastar ajusta a proporção (lembrada); duplo clique volta a 50%
  $('#pvSplit').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault(); document.body.classList.add('resizing');
    const r = mon.getBoundingClientRect();
    const move = (ev) => { PV.ratio = Math.max(.15, Math.min(.85, (ev.clientX - r.left) / r.width)); pvLayout(); };
    const up = () => { document.body.classList.remove('resizing'); store.set('pvRatio', PV.ratio); };
    pointerDrag(e, move, up);
  });
  $('#pvSplit').ondblclick = () => { PV.ratio = .5; store.set('pvRatio', .5); pvLayout(); };
  // a página do iframe avisa onde está rolada, para a próxima atualização voltar ao mesmo ponto
  window.addEventListener('message', (e) => { const d = e.data && e.data['bs-pv']; if (d && PV.frame && e.source === PV.frame.contentWindow && PV.tab) PV.scroll[PV.tab.key] = d; });
})();

BS.hooks.on('editor:ready', (ed) => {
  ed.onDidChangeModelContent(() => { if (PV.kind && PV.tab === S.active) pvQueue(); });
  ed.onDidScrollChange((e) => { if (e.scrollTopChanged && PV.kind === 'md' && !PV.over) pvScrollPreview(); });
});
BS.hooks.on('tab:activate', () => pvSync());
BS.hooks.on('tab:close', (t) => { delete PV.scroll[t.key]; setTimeout(pvSync); });
function pvToggle() {
  const kind = pvActiveKind();
  if (!kind) return false;
  pvSetMode(pvMode(kind) === 'editor' ? 'split' : 'editor');
}
BS.keys.add('Ctrl+Shift+V', pvToggle);
BS.actions.add([{ label: 'Visualização ao lado (Markdown/HTML)', k: 'Ctrl+Shift+V', run: () => pvActiveKind() ? pvToggle() : toast('Abra um arquivo .md ou .html') }]);

function pvSetMode(m) {
  const kind = pvActiveKind();
  if (!kind || !PV_MODES.some(([mode]) => mode === m)) return;
  store.set('pv.' + kind, m); pvSync();
  if (m !== 'preview') editor?.focus();
}

// mostra/esconde a visualização conforme a aba ativa e o modo escolhido
function pvSync() {
  const t = S.active;
  const kind = pvActiveKind();
  const mode = kind ? pvMode(kind) : 'editor';
  $('#pvModes').hidden = !kind;
  if (kind) $('#pvModes').querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
  const show = !!kind && mode !== 'editor';
  const changed = PV.tab !== t || PV.kind !== (show ? kind : null);
  PV.kind = show ? kind : null; $('#pv').hidden = !show; $('#pv').classList.toggle('only', mode === 'preview');
  const ed = $('#ed'); if (ed) { ed.style.display = !t || t.mode !== 'editor' ? 'none' : mode === 'preview' && show ? 'none' : ''; }
  pvLayout();
  if (!show) { PV.tab = null; pvClearFrame(); $('#pvBody').innerHTML = ''; return; }
  if (changed) { PV.tab = t; $('#pvBody').innerHTML = ''; PV.frame = null; $('#pvBody').className = 'pv-' + kind; pvRender(); }
}
function pvLayout() {
  const pv = $('#pv'), ed = $('#ed'); const split = !pv.hidden && !pv.classList.contains('only');
  const pct = (PV.ratio * 100).toFixed(2) + '%';
  pv.style.left = split ? pct : '0';
  if (ed) ed.style.right = split ? (100 - PV.ratio * 100).toFixed(2) + '%' : '0';
}
function pvQueue() { clearTimeout(PV.timer); PV.timer = setTimeout(pvRender, PV.kind === 'html' ? 450 : 120); }
function pvRender() {
  const t = PV.tab; if (!t || !PV.kind) return;
  try { if (PV.kind === 'md') pvMarkdown(t); else pvHtml(t); }
  catch (e) { $('#pvBody').innerHTML = `<div class="pv-err">Não foi possível visualizar: ${esc(e.message)}</div>`; }
}

// ---- Markdown: um bloco por token de nível superior, marcado com a linha de origem (data-line) ----
function pvMarkdown(t) {
  const body = $('#pvBody'); const dir = t.path.split('/').slice(0, -1).join('/');
  let art = body.querySelector('article.md'); if (!art) { body.innerHTML = '<article class="md"></article>'; art = body.firstChild; }
  if (!window.marked) { art.innerHTML = `<pre>${esc(t.model.getValue())}</pre>`; return; }
  const toks = marked.lexer(t.model.getValue(), { gfm: true });
  // blocos que não mudaram são reaproveitados: nada pisca e o código colorido não é refeito
  const pool = new Map(); for (const el of art.children) { const q = pool.get(el._h); if (q) q.push(el); else pool.set(el._h, [el]); }
  const out = []; let line = 1;
  for (const tok of toks) {
    if (tok.type !== 'space' && tok.type !== 'def') {
      const one = [tok]; one.links = toks.links;
      const h = marked.parser(one, { gfm: true });
      let el = pool.get(h)?.shift();
      if (!el) {
        el = document.createElement('div'); el.className = 'pvb'; el._h = h;
        el.innerHTML = window.DOMPurify ? DOMPurify.sanitize(h, { ADD_ATTR: ['target'] }) : esc(h);
        mdBind(el, art, dir, t.project);
      }
      el.dataset.line = line; out.push(el);
    }
    line += (tok.raw.match(/\n/g) || []).length;
  }
  art.replaceChildren(...out);
  if (!out.length) art.innerHTML = '<p class="pv-empty">Arquivo vazio.</p>';
  pvScrollPreview();
}
// linha do editor (com fração) que está no topo da tela
function pvTopLine() {
  const r = editor.getVisibleRanges()[0]; if (!r) return 1;
  const n = r.startLineNumber; const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
  return n + Math.max(0, Math.min(1, (editor.getScrollTop() - editor.getTopForLineNumber(n)) / lh));
}
const pvBlocks = () => [...$('#pvBody').querySelectorAll('.pvb')];
function pvScrollPreview() {
  if (!editor || PV.kind !== 'md' || PV.lead === 'pv' && Date.now() - PV.leadT < 120) return;
  const body = $('#pvBody'); const bl = pvBlocks(); if (!bl.length) return;
  const L = pvTopLine(); let i = 0; while (i + 1 < bl.length && +bl[i + 1].dataset.line <= L) i++;
  const a = bl[i], b = bl[i + 1]; const la = +a.dataset.line, lb = b ? +b.dataset.line : PV.tab.model.getLineCount() + 1;
  const ya = a.offsetTop, yb = b ? b.offsetTop : a.offsetTop + a.offsetHeight;
  const f = L <= la ? 0 : Math.min(1, (L - la) / Math.max(1, lb - la));
  PV.lead = 'ed'; PV.leadT = Date.now();
  body.scrollTop = L < 1.01 ? 0 : ya + (yb - ya) * f - 12;
}
function pvScrollEditor() {
  if (!editor || PV.lead === 'ed' && Date.now() - PV.leadT < 120) return;
  const body = $('#pvBody'); const y = body.scrollTop + 12; const bl = pvBlocks(); if (!bl.length) return;
  let i = 0; while (i + 1 < bl.length && bl[i + 1].offsetTop <= y) i++;
  const a = bl[i], b = bl[i + 1]; const ya = a.offsetTop, yb = b ? b.offsetTop : a.offsetTop + a.offsetHeight;
  const la = +a.dataset.line, lb = b ? +b.dataset.line : PV.tab.model.getLineCount() + 1;
  const L = la + (lb - la) * Math.max(0, Math.min(1, (y - ya) / Math.max(1, yb - ya)));
  const n = Math.floor(L); const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
  PV.lead = 'pv'; PV.leadT = Date.now();
  editor.setScrollTop(body.scrollTop <= 0 ? 0 : editor.getTopForLineNumber(n) + (L - n) * lh);
}

// ---- HTML: iframe isolado, montado com o texto do editor ----
async function pvHtml(t) {
  const seq = ++PV.seq;
  let key = PV.keys[t.project];
  if (!key) { try { key = PV.keys[t.project] = (await api('preview', { project: t.project })).key; } catch (e) { $('#pvBody').innerHTML = `<div class="pv-err">${esc(e.message)}</div>`; return; } }
  if (seq !== PV.seq || PV.tab !== t) return;
  const dir = t.path.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  const base = `${location.origin}/api/preview/${key}/${dir ? dir + '/' : ''}`;
  const pos = PV.scroll[t.key];
  // <base> resolve os caminhos relativos; o script devolve a rolagem ao recarregar e avisa quando ela muda
  const inject = `<base href="${esc(base)}"><script>(function(){var p=${JSON.stringify(pos || null)};function go(){if(p)scrollTo(p[0],p[1])}document.addEventListener('DOMContentLoaded',go);addEventListener('load',go);var w;addEventListener('scroll',function(){clearTimeout(w);w=setTimeout(function(){parent.postMessage({'bs-pv':[scrollX,scrollY]},'*')},60)},{passive:true})})()<\/script>`;
  const src = t.model.getValue();
  const at = (re) => { const m = re.exec(src); return m ? m.index + m[0].length : -1; };
  let i = at(/<head[^>]*>/i); if (i < 0) i = at(/<html[^>]*>/i); if (i < 0) i = at(/^\s*<!doctype[^>]*>/i); if (i < 0) i = 0;
  const doc = src.slice(0, i) + inject + src.slice(i);
  // monta o novo iframe por baixo e só troca quando terminou de carregar: sem tela branca a cada tecla
  const body = $('#pvBody'); const old = PV.frame;
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads'); // janelas abertas pela página continuam isoladas
  f.title = 'Visualização de ' + t.path; f.className = old ? 'pv-frame loading' : 'pv-frame';
  let done = false;
  const swap = () => { if (done) return; done = true; if (seq !== PV.seq) { f.remove(); return; } f.classList.remove('loading'); body.querySelectorAll('iframe').forEach(x => x !== f && x.remove()); };
  f.onload = swap; setTimeout(swap, 1500);
  f.srcdoc = doc; body.appendChild(f); PV.frame = f;
}
function pvClearFrame() { PV.frame = null; PV.seq++; }
