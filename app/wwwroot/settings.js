/* BlueScreen: Configurações. Uma janela só (a engrenagem do topo, Ctrl+,) para o que antes estava espalhado em botões
   da barra de cima: salvamento automático, aparência (theme.js desenha dentro dela), teclas de atalho (dá para trocar
   cada uma) e rede local (share.js), mais as preferências do editor, do terminal e os dados da instalação.
   Cada preferência vale na hora, sem botão de salvar.
     bs.settings.open(seção?)   seções: geral, editor, aparencia, atalhos, rede, terminal, sobre
     bs.settings.close()        bs.settings.section({ id, title, icon, order, render(el), show?(), hide?() })  (plugins) */
(function (bs) {
const { $, esc, store, toast } = bs;
const svg = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  general: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  editor: svg('<path d="M8 6l-5 6 5 6M16 6l5 6-5 6M13.5 4l-3 16"/>'),
  look: svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10.5" cy="7.5" r="1.1"/><circle cx="15" cy="7.5" r="1.1"/>'),
  keys: svg('<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10"/>'),
  net: svg('<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>'),
  term: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>'),
  about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  undo: svg('<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
};
const C = { open: false, sec: store.get('cfgSec', 'geral'), secs: [], q: '', capture: null };

// ---------- o botão do topo e a janela ----------
const btn = $('#btnSettings');
document.body.insertAdjacentHTML('beforeend', `<div id="cfgBack" class="scrim" hidden><section id="cfg" role="dialog" aria-modal="true" aria-label="Configurações">
  <nav class="cfg-nav" aria-label="Seções"><h2>Configurações</h2><div class="cfg-items" role="tablist"></div></nav>
  <div class="cfg-main"><header class="cfg-top"><h3 id="cfgTitle"></h3><span class="cfg-sub" id="cfgSub"></span><button class="icon-btn" id="cfgClose" title="Fechar (Esc)">${bs.I.x}</button></header>
    <div class="cfg-panes"></div></div></section></div>`);
const back = $('#cfgBack'), box = $('#cfg'), panes = box.querySelector('.cfg-panes');
back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
$('#cfgClose').onclick = () => close();

/** Uma seção: { id, title, icon, order, sub?, render(el) uma vez, show?() a cada vez que aparece, hide?() } */
function section(def) {
  if (!def || !def.id || !def.title) throw new Error('seção precisa de id e title');
  if (bs.plugins.current && !def.plugin) def.plugin = bs.plugins.current;
  C.secs = C.secs.filter(s => s.id !== def.id); C.secs.push(def); C.secs.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  if (C.open) paintNav();
  return def;
}
function paneOf(s) {
  if (s.el) return s.el;
  s.el = document.createElement('div'); s.el.className = 'cfg-pane'; s.el.dataset.sec = s.id; s.el.hidden = true; panes.appendChild(s.el);
  try { s.render && s.render(s.el); } catch (e) { console.error('configurações ' + s.id, e); s.el.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  return s.el;
}
function paintNav() {
  const nav = box.querySelector('.cfg-items');
  nav.innerHTML = C.secs.map(s => `<button type="button" role="tab" data-sec="${esc(s.id)}" class="${s.id === C.sec ? 'on' : ''}" aria-selected="${s.id === C.sec}">${s.icon || IC.gear}<span>${esc(s.title)}</span></button>`).join('');
  nav.querySelectorAll('button').forEach(b => b.onclick = () => show(b.dataset.sec));
}
function show(id) {
  const cur = C.secs.find(s => s.id === id) || C.secs[0]; if (!cur) return;
  const old = C.secs.find(s => s.id === C.shown && s !== cur);
  if (old && old.el) { old.el.hidden = true; try { old.hide && old.hide(); } catch (e) { console.error(e); } }
  C.sec = C.shown = cur.id; store.set('cfgSec', cur.id);
  paintNav();
  $('#cfgTitle').textContent = cur.title; $('#cfgSub').textContent = cur.sub || '';
  box.dataset.sec = cur.id;
  paneOf(cur).hidden = false; panes.scrollTop = 0;
  try { cur.show && cur.show(); } catch (e) { console.error(e); }
  box.querySelector('.cfg-items .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function open(id) {
  C.open = true; back.hidden = false;
  show(id || C.sec);
  btn && btn.classList.add('on');
}
function close() {
  if (!C.open) return;
  stopCapture();
  const cur = C.secs.find(s => s.id === C.shown);
  if (cur && cur.el) { cur.el.hidden = true; try { cur.hide && cur.hide(); } catch (e) { console.error(e); } }
  C.shown = null; C.open = false; back.hidden = true;
  btn && btn.classList.remove('on');
}
if (btn) btn.onclick = () => (C.open ? close() : open());

// ---------- peças de formulário ----------
// linha: nome e explicação à esquerda, o controle à direita
const row = (label, desc, control, cls = '') => `<div class="cfg-row ${cls}"><div class="cfg-tx"><b>${esc(label)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</div><div class="cfg-ct">${control}</div></div>`;
const sw = (key, on) => `<button type="button" class="toggle${on ? ' on' : ''}" role="switch" aria-checked="${!!on}" data-sw="${esc(key)}"><span class="sw"></span></button>`;
const seg = (key, val, opts) => `<span class="seg" data-seg="${esc(key)}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(String(v))}" class="${String(v) === String(val) ? 'on' : ''}">${esc(l)}</button>`).join('')}</span>`;
const sel = (key, val, opts) => `<select data-sel="${esc(key)}">${opts.map(([v, l]) => `<option value="${esc(String(v))}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const group = (title, rows) => `<section class="cfg-grp"><h4>${esc(title)}</h4><div class="cfg-card">${rows.join('')}</div></section>`;
/** Liga os controles de um painel: handlers = { chave: (valor) => ... }; depois de cada mudança o painel é redesenhado. */
function bind(el, handlers, repaint) {
  const run = (k, v) => { try { handlers[k] && handlers[k](v); } catch (e) { toast(e.message, 'err'); } repaint && repaint(); };
  el.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => run(b.dataset.sw, !b.classList.contains('on')));
  el.querySelectorAll('[data-seg] button').forEach(b => b.onclick = () => run(b.parentElement.dataset.seg, b.dataset.v));
  el.querySelectorAll('[data-sel]').forEach(s => s.onchange = () => run(s.dataset.sel, s.value));
}

// ---------- Geral ----------
section({ id: 'geral', title: 'Geral', icon: IC.general, order: 10, sub: 'Arquivos e árvore do projeto',
  render(el) { this.paint = () => {
    el.innerHTML = group('Arquivos', [
      row('Salvar automaticamente', 'Grava ao parar de digitar, trocar de aba ou sair da janela.', sw('autoSave', S.autoSave)),
      row('Arquivo aberto mudou por fora', 'O que fazer quando outro programa altera um arquivo que você está editando.', sel('extRule', XS.rule, [['diff', 'Mesclar e abrir o diff nos conflitos'], ['merge', 'Mesclar e só avisar os conflitos'], ['ask', 'Não mesclar, sempre abrir o diff']])),
      row('Desminificar ao abrir', 'Arquivos minificados (JS, CSS, JSON, HTML) abrem já formatados para leitura.', sw('unmin', UM.auto)),
    ]) + group('Árvore do projeto', [
      row('Abrir arquivo com um clique', 'Desligado, um clique seleciona e dois abrem.', sw('single', S.singleClick)),
      row('Compactar pacotes intermediários', 'Pastas com uma única pasta dentro viram uma linha só (com.empresa.app).', sw('compact', S.compact)),
      row('Ordem', '', seg('sort', S.sortRecent ? '1' : '0', [['1', 'Recentes primeiro'], ['0', 'A-Z']])),
    ]);
    bind(el, {
      autoSave: (v) => setAutoSave(v),
      extRule: (v) => { XS.rule = v; store.set('extRule', v); },
      unmin: (v) => { UM.auto = v; store.set('unminAuto', v); },
      single: (v) => { S.singleClick = v; store.set('singleClick', v); },
      compact: (v) => { S.compact = v; store.set('compact', v); S.tree = {}; if (S.tool === 'project') bs.renderTool(); },
      sort: (v) => { S.sortRecent = v === '1'; store.set('sortRecent', S.sortRecent); if (S.tool === 'project') bs.renderTool(); },
    }, this.paint);
  }; },
  show() { this.paint(); },
});

// ---------- Editor ----------
section({ id: 'editor', title: 'Editor', icon: IC.editor, order: 20, sub: 'Como o código aparece e se comporta',
  render(el) { this.paint = () => {
    const p = bs.editorPrefs.get(), keep = el.querySelector('input[type=range]') === document.activeElement;
    if (keep) { el.querySelector('.cfg-fs b').textContent = S.fontSize + 'px'; return; } // arrastando o tamanho: não troca o controle no meio
    el.innerHTML = group('Texto', [
      row('Tamanho da letra', 'Ctrl + roda do mouse sobre o código faz o mesmo.', `<span class="rng cfg-fs"><input type="range" min="9" max="36" step="1" value="${S.fontSize}" aria-label="Tamanho da letra"><b>${S.fontSize}px</b></span>`),
      row('Quebra de linha', 'Linhas compridas continuam embaixo, sem rolar para o lado.', sw('wrap', S.wrap)),
      row('Espaços em branco', '', sel('whitespace', p.whitespace, [['none', 'Não mostrar'], ['trailing', 'Só os do fim da linha'], ['boundary', 'Entre palavras, só os repetidos'], ['all', 'Todos']])),
      row('Cursor', '', seg('cursor', p.cursor, [['line', 'Barra'], ['block', 'Bloco'], ['underline', 'Sublinhado']])),
      row('Animações suaves', 'Rolagem e cursor deslizam em vez de pular.', sw('smooth', p.smooth)),
    ]) + group('Margem e guias', [
      row('Números de linha', '', seg('lineNumbers', p.lineNumbers, [['on', 'Normais'], ['relative', 'Relativos'], ['off', 'Sem']])),
      row('Minimapa', 'Miniatura do arquivo na borda direita.', sw('minimap', p.minimap)),
      row('Cabeçalho fixo', 'A classe e o método em que você está ficam presos no topo ao rolar.', sw('sticky', p.sticky)),
      row('Guias de indentação', '', sw('guides', p.guides)),
      row('Parênteses coloridos por nível', '', sw('brackets', p.brackets)),
      row('Dobrar blocos', 'Setas na margem para recolher métodos, classes e regiões.', sw('folding', p.folding)),
      row('Dicas embutidas', 'Nomes de parâmetros e tipos inferidos, quando a linguagem informa.', sw('inlay', p.inlay)),
    ]) + group('Indentação', [
      row('Largura', '', seg('tabSize', p.tabSize, [[2, '2'], [4, '4'], [8, '8']])),
      row('Indentar com', '', seg('insertSpaces', p.insertSpaces ? '1' : '0', [['1', 'Espaços'], ['0', 'Tab']])),
      row('Seguir o arquivo', 'Usa a indentação que o arquivo aberto já tem, quando dá para descobrir.', sw('detectIndent', p.detectIndent)),
    ]) + group('Digitação', [
      row('Fechar parênteses e aspas', '', sw('autoClose', p.autoClose)),
      row('Formatar ao colar', '', sw('formatOnPaste', p.formatOnPaste)),
    ]) + group('Git', [
      row('Autor no fim da linha', 'Quem mexeu por último na linha do cursor, e quando.', sw('blame', VC.blame.on)),
      row('Diff', '', seg('inline', S.inline ? '1' : '0', [['0', 'Lado a lado'], ['1', 'Em linha']])),
    ]) + `<p class="cfg-foot"><a data-reset>Voltar o editor ao padrão</a></p>`;
    const set = (k) => (v) => bs.editorPrefs.set(k, v);
    bind(el, {
      wrap: (v) => { if (S.wrap !== v) $('#btnWrap').click(); }, inline: (v) => { if (S.inline !== (v === '1')) $('#btnInline').click(); },
      blame: (v) => { VC.blame.on = v; store.set('blameInline', v); blameInline(); },
      whitespace: set('whitespace'), cursor: set('cursor'), smooth: set('smooth'), lineNumbers: set('lineNumbers'), minimap: set('minimap'), sticky: set('sticky'), guides: set('guides'), brackets: set('brackets'),
      folding: set('folding'), inlay: set('inlay'), detectIndent: set('detectIndent'), autoClose: set('autoClose'), formatOnPaste: set('formatOnPaste'),
      tabSize: (v) => bs.editorPrefs.set('tabSize', +v), insertSpaces: (v) => bs.editorPrefs.set('insertSpaces', v === '1'),
    }, this.paint);
    const r = el.querySelector('input[type=range]');
    r.oninput = () => { codeFont(+r.value, true); r.nextElementSibling.textContent = r.value + 'px'; };
    el.querySelector('[data-reset]').onclick = () => { bs.editorPrefs.reset(); this.paint(); toast('Editor de volta ao padrão', 'ok'); };
  }; },
  show() { this.paint(); },
});

// ---------- Aparência: o painel é do theme.js, que desenha em #apr ----------
section({ id: 'aparencia', title: 'Aparência', icon: IC.look, order: 30, sub: 'Temas, cores, fontes e forma',
  render(el) { el.classList.add('cfg-flush'); el.innerHTML = '<div id="apr"></div>'; },
  show() { bs.appearance && bs.appearance.mounted(true); },
  hide() { bs.appearance && bs.appearance.mounted(false); },
});

// ---------- Atalhos ----------
const kbd = (c) => String(c).split(' ').map(x => (x === '+' ? ['+'] : x.replace(/\+\+$/, '+＋').split('+').map(y => y === '＋' ? '+' : y)).map(y => `<kbd>${esc(y)}</kbd>`).join('')).join('<i>depois</i>');
function keyGroups() {
  const tools = bs.tools.list().filter(t => t.key).map(t => [t.title, t.key]);
  const groups = [
    ['Navegar', [['Buscar em tudo', 'Shift Shift', true], ['Classes', 'Ctrl+N'], ['Arquivos', 'Ctrl+P'], ['Texto em todos os arquivos', 'Ctrl+Shift+F'], ['Ações', 'Ctrl+Shift+A'], ['Trocar projeto', 'Alt+P'], ['Selecionar o arquivo aberto na árvore', 'Alt+F1']]],
    ['Painéis', tools],
    ['Editor', [['Salvar', 'Ctrl+S'], ['Salvar todos', 'Ctrl+Shift+S'], ['Fechar aba', 'Ctrl+W'], ['Próxima alteração do diff', 'Alt+ArrowDown'], ['Alteração anterior do diff', 'Alt+ArrowUp'], ['Próximo arquivo alterado', 'Alt+ArrowRight'], ['Arquivo alterado anterior', 'Alt+ArrowLeft'],
      ['Commit mais antigo', 'Alt+PageDown'], ['Commit mais novo', 'Alt+PageUp'], ['Lint do arquivo', 'Ctrl+Alt+L'], ['Aumentar a letra', 'Ctrl+='], ['Diminuir a letra', 'Ctrl+-'], ['Letra no tamanho padrão', 'Ctrl+0'], ['Apresentar em tela cheia', 'F11']]],
    ['Geral', [['Configurações', 'Ctrl+,'], ['Aparência', 'Ctrl+Alt+S'], ['Teclas de atalho', 'F1'], ['Atualizar o projeto', 'F5'], ['Fechar menus e buscas', 'Escape', true]]],
  ];
  const known = new Set(groups.flatMap(g => g[1].map(x => bs.keys.norm(x[1]))));
  const extra = bs.actions.list().filter(a => a.k && !/\s/.test(a.k) && !known.has(bs.keys.norm(a.k)) && bs.keys.map.has(bs.keys.norm(a.k)));
  const seen = new Set(), uniq = extra.filter(a => { const k = bs.keys.norm(a.k); if (seen.has(k)) return false; seen.add(k); return true; });
  if (uniq.length) groups.push(['Plugins e ferramentas', uniq.map(a => [a.label, a.k])]);
  return groups.map(([t, list]) => [t, list.map(([label, combo, fixed]) => ({ label, base: fixed ? combo : bs.keys.norm(combo), fixed: !!fixed }))]);
}
const PRETTY = { ArrowDown: '↓', ArrowUp: '↑', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ' ': 'Espaço', PageDown: 'PgDn', PageUp: 'PgUp', Delete: 'Del' };
const pretty = (c) => c.split('+').map(p => PRETTY[p] || p).join('+').replace(/\+$/, '++');
function stopCapture() { if (!C.capture) return; removeEventListener('keydown', C.capture.fn, true); C.capture = null; }
section({ id: 'atalhos', title: 'Teclas de atalho', icon: IC.keys, order: 40, sub: 'Clique numa tecla para trocar',
  render(el) {
    el.innerHTML = `<div class="cfg-kbar"><label class="cfg-search">${IC.search}<input type="search" placeholder="Buscar ação ou tecla" aria-label="Buscar ação ou tecla" spellcheck="false"></label><button type="button" class="chip" data-all hidden>${IC.undo}Voltar todas ao padrão</button></div><div class="cfg-keys"></div>`;
    const q = el.querySelector('input'); q.oninput = () => { C.q = q.value; this.paint(); };
    el.querySelector('[data-all]').onclick = () => { bs.keys.resetAll(); this.paint(); toast('Atalhos de volta ao padrão', 'ok'); };
    this.paint = () => {
      const words = C.q.trim().toLowerCase().split(/\s+/).filter(Boolean), custom = bs.keys.custom();
      el.querySelector('[data-all]').hidden = !Object.keys(custom).length;
      const groups = keyGroups().map(([t, list]) => [t, list.filter(k => { const cur = pretty(custom[k.base] || k.base); return words.every(w => (k.label + ' ' + cur).toLowerCase().includes(w)); })]).filter(g => g[1].length);
      el.querySelector('.cfg-keys').innerHTML = groups.map(([t, list]) => `<section class="cfg-grp"><h4>${esc(t)}</h4><div class="cfg-card">${list.map(k => {
        const cur = custom[k.base] || k.base, changed = !!custom[k.base], cap = C.capture && C.capture.base === k.base;
        return `<div class="cfg-row cfg-key${changed ? ' changed' : ''}"><div class="cfg-tx"><b>${esc(k.label)}</b></div><div class="cfg-ct">${changed ? `<button type="button" class="icon-btn" data-undo="${esc(k.base)}" title="Voltar ao padrão (${esc(pretty(k.base))})">${IC.undo}</button>` : ''}`
          + (k.fixed ? `<span class="cfg-kb fixed" title="Este atalho é fixo">${kbd(pretty(cur))}</span>` : `<button type="button" class="cfg-kb${cap ? ' cap' : ''}" data-key="${esc(k.base)}" title="Trocar a tecla">${cap ? 'Aperte a nova combinação…' : kbd(pretty(cur))}</button>`) + '</div></div>';
      }).join('')}</div></section>`).join('') || `<p class="cfg-none">Nenhum atalho com "${esc(C.q)}".</p>`;
      el.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => { bs.keys.rebind(b.dataset.undo, null); this.paint(); });
      el.querySelectorAll('[data-key]').forEach(b => b.onclick = () => this.capture(b.dataset.key));
    };
    // espera a próxima combinação: Esc desiste; precisa de Ctrl ou Alt (ou ser uma tecla de função)
    this.capture = (base) => {
      stopCapture();
      const fn = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        if (e.key === 'Escape') { stopCapture(); return this.paint(); }
        const c = bs.keys.combo(e);
        if (!/^(Ctrl\+|Alt\+)/.test(c) && !/^(Shift\+)?F\d{1,2}$/.test(c)) return toast('Use Ctrl ou Alt na combinação (ou uma tecla F1 a F12)');
        const all = keyGroups().flatMap(g => g[1]), cur = bs.keys.custom();
        const taken = all.find(k => k.base !== base && (cur[k.base] || k.base) === c);
        if (taken) return toast(`${pretty(c)} já é de "${taken.label}"`, 'err');
        stopCapture(); bs.keys.rebind(base, c === base ? null : c); this.paint();
      };
      C.capture = { base, fn }; addEventListener('keydown', fn, true); this.paint();
    };
  },
  show() { this.paint(); }, hide() { stopCapture(); },
});

// ---------- Rede: o conteúdo é o #netPop do index.html, mantido pelo share.js ----------
section({ id: 'rede', title: 'Rede local', icon: IC.net, order: 50, sub: 'Abrir este BlueScreen no celular ou em outro PC',
  render(el) { const p = $('#netPop'); if (p) el.appendChild(p); },
  show() { const p = $('#netPop'); if (p) { p.hidden = false; bs.hooks.run('net:pop', true); } },
  hide() { const p = $('#netPop'); if (p) { p.hidden = true; bs.hooks.run('net:pop', false); } },
});

// ---------- Terminal ----------
section({ id: 'terminal', title: 'Terminal', icon: IC.term, order: 60, sub: 'Shell e letra do terminal embutido',
  render(el) { this.paint = async () => {
    const t = bs.terminal; if (!t || !t.prefs) { el.innerHTML = '<p class="cfg-none">O terminal só funciona no PC local.</p>'; return; }
    let shells = []; try { shells = await t.shells(); } catch { /* sem shells: a lista fica vazia */ }
    const def = t.prefs.shell();
    el.innerHTML = group('Terminal', [
      row('Shell padrão', 'O que abre no + e no Ctrl+Shift+T.', shells.length ? sel('shell', def || shells[0].id, shells.map(s => [s.id, s.name])) : '<span class="cfg-dim">Nenhum shell encontrado</span>'),
      row('Tamanho da letra', 'Parte do tamanho do código. Ctrl + roda do mouse sobre o terminal faz o mesmo.', `<span class="cfg-step"><button type="button" class="icon-btn" data-z="-1" title="Diminuir">${svg('<path d="M5 12h14"/>')}</button><b>${t.prefs.font()}px</b><button type="button" class="icon-btn" data-z="1" title="Aumentar">${svg('<path d="M12 5v14M5 12h14"/>')}</button></span>`),
    ]);
    bind(el, { shell: (v) => t.prefs.setShell(v) }, null);
    el.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { t.prefs.zoom(+b.dataset.z); el.querySelector('.cfg-step b').textContent = t.prefs.font() + 'px'; });
  }; },
  show() { this.paint(); },
});

// ---------- Sobre ----------
section({ id: 'sobre', title: 'Sobre', icon: IC.about, order: 90,
  render(el) { this.paint = () => {
    const home = (bs.plugins.dirs || []).map(String).find(d => /[\\/]\.bluescreen[\\/]plugins$/i.test(d)), data = home ? home.replace(/[\\/]plugins$/i, '') : '';
    const on = bs.plugins.list.filter(p => p.enabled).length;
    el.innerHTML = `<div class="cfg-about"><img src="icon.svg" alt=""><div><b>BlueScreen</b><small>Versão ${esc(bs.version || '?')}</small></div>${bs.update ? `<button type="button" class="chip" data-upd>${bs.I.refresh}Procurar atualização</button>` : ''}</div>`
      + group('Esta instalação', [
        row('Plugins', `${on} ligado${on === 1 ? '' : 's'} de ${bs.plugins.list.length}`, '<button type="button" class="chip" data-plug>Abrir a loja</button>'),
        ...(data ? [row('Pasta de dados', data, `<button type="button" class="chip" data-data>${IC.folder}Mostrar</button>`), row('Registro', 'O que o BlueScreen anotou enquanto rodava (erros de plugins, atualizações).', '<button type="button" class="chip" data-log>Abrir</button>')] : []),
      ]);
    const on1 = (s, fn) => { const b = el.querySelector(s); if (b) b.onclick = fn; };
    on1('[data-upd]', () => bs.update.check(true, false));
    on1('[data-plug]', () => { close(); bs.openTool('plugins'); });
    on1('[data-data]', () => bs.reveal(data));
    on1('[data-log]', () => { close(); Promise.resolve(bs.openOutside(data, 'bluescreen.log')).catch((e) => toast(e.message)); });
  }; },
  show() { this.paint(); },
});

// ---------- registro ----------
bs.settings = { open, close, section, get isOpen() { return C.open; }, dropPlugin(id) { C.secs.filter(s => s.plugin === id).forEach(s => bs.settings.remove(s.id)); }, remove(id) { const s = C.secs.find(x => x.id === id); if (s && s.el) s.el.remove(); C.secs = C.secs.filter(x => x.id !== id); if (C.open) show(C.sec); } };
bs.keys.add('Ctrl+,', () => (C.open ? close() : open()));
bs.keys.add('F1', () => open('atalhos'));
bs.hooks.on('escape', () => { if (C.open && !C.capture) close(); });
bs.actions.add([
  { label: 'Configurações', k: 'Ctrl+,', run: () => open(), icon: IC.gear },
  { label: 'Configurações: teclas de atalho', k: 'F1', run: () => open('atalhos'), icon: IC.keys },
  { label: 'Configurações: rede local', run: () => open('rede'), icon: IC.net },
  { label: 'Configurações: editor', run: () => open('editor'), icon: IC.editor },
]);
})(window.BS);
