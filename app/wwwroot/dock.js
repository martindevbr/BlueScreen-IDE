// ===== Dock: os painéis (Terminal, Depurar, Build, Problemas, os de plugins e as janelas do balão) dividem a tela =====
// Há quatro regiões em volta do editor: embaixo (a de sempre), em cima, à esquerda e à direita. Cada painel continua
// dono do seu `hidden` (aberto/fechado); a região só decide qual aparece e desenha as abas. Painel aberto vira aba; o
// que acabou de abrir fica na frente; fechar a da frente passa para a vizinha. Clicar na aba da frente recolhe a
// região até a barra; arrastar a borda ajusta o tamanho.
// Arrastar a aba de um painel (ou o topo de uma janela do balão, ou o cabeçalho do painel de arquivos) mostra os alvos:
// soltar num deles leva o painel para aquela região (ou para uma janela flutuante). Onde cada um ficou é lembrado.
//   BS.layout.move(id, 'bottom' | 'top' | 'left' | 'right' | 'float')   BS.layout.sideOf(id)
//   BS.layout.draggable(alça, { id, title, icon, sides, drop(side) })   gancho 'layout:move' (id, de, para)
(() => {
  const { $, esc, store, I } = BS;
  const GEAR = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>';
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // como cada painel conhecido aparece na aba; um painel sem entrada usa data-dock-title / o .ttl dele e um ícone genérico
  const META = {
    termCon: { tool: 'terminal', title: 'Terminal', hideTtl: true, close: '#tmHide',
      watch: ['#tmTabs'], status: () => { const n = $('#tmTabs').children.length; return { count: n > 1 ? n : 0 }; } },
    dbgCon: { tool: 'debug', title: 'Depurar', hideTtl: true, close: '#dbHide',
      watch: ['#dbState'], status: () => { const c = $('#dbState').className; return { dot: /pause/.test(c) ? 'warn' : /run/.test(c) ? 'ok' : /busy/.test(c) ? 'busy' : '' }; } },
    buildCon: { tool: 'build', title: 'Build', close: '#bcClose',
      watch: ['#bcState'], status: () => { const s = $('#bcState .bst'); const c = s ? s.className : ''; return { dot: /running/.test(c) ? 'busy' : /failed/.test(c) ? 'err' : /\bok\b/.test(c) ? 'ok' : '' }; } },
    problems: { tool: 'problems', title: 'Problemas', hideTtl: true, close: '#btnProbClose',
      watch: ['#probList'], status: () => { const all = $('#probList').querySelectorAll('.prob'); return { count: all.length, err: !!$('#probList .sev.error') }; } },
  };
  const metaOf = (p) => META[p.id] || { title: p.dataset.dockTitle || ((p.querySelector('.head .ttl') || {}).textContent || '').trim() || p.id, icon: p.dataset.dockIcon || null, tool: p.dataset.dockTool || null, hideTtl: p.hasAttribute('data-dock-hide-ttl') };
  const iconOf = (m) => m.icon || (m.tool && BS.tools.get(m.tool) || {}).icon || GEAR;
  const SIDE_NAME = { bottom: 'embaixo', top: 'em cima', left: 'à esquerda', right: 'à direita', float: 'janela flutuante' };

  // o que ficou onde: { panels: { id: lado }, tool: 'left' | 'right' }
  const L = Object.assign({ panels: {}, tool: 'left' }, store.get('layout', null) || {});
  const saveLayout = () => store.set('layout', L);

  // ----- regiões -----
  const SIZE = { bottom: ['dockH', 280], top: ['dockTopH', 220], left: ['dockLeftW', 320], right: ['dockRightW', 380] };
  function mkRegion(side) {
    const s = document.createElement('section');
    s.id = 'dock-' + side; s.className = `dk-region dk-${side} island`; s.hidden = true; s.dataset.region = side;
    s.innerHTML = `<div class="dk-resize" title="Arraste para ajustar (duplo clique volta ao padrão)"></div>
      <div class="dk-bar"><div class="dk-tabs" role="tablist" aria-label="Painéis ${SIDE_NAME[side]}"></div><span class="dk-ink" aria-hidden="true"></span></div>
      <div class="dk-body"></div>`;
    $('#app').appendChild(s);
    return { el: s, bar: s.querySelector('.dk-bar'), tabs: s.querySelector('.dk-tabs'), ink: s.querySelector('.dk-ink'), body: s.querySelector('.dk-body'), resize: s.querySelector('.dk-resize') };
  }
  const R = {};
  function region(side, parts) {
    const G = { side, ...parts, active: null, min: false, horiz: side === 'bottom' || side === 'top' };
    const panels = () => [...G.body.children].filter(p => p.id);
    const isOpen = (p) => !p.hidden;
    // tamanho: altura (embaixo, em cima) ou largura (esquerda, direita, numa variável do #app)
    const [key, def] = SIZE[side];
    G.setSize = (n) => { if (G.horiz) G.h = n; else G.w = n; G.sync(); };
    // o tamanho lembrado vale até onde a janela deixa: numa janela menor que da última vez, o painel não cobre o editor
    G.sync = () => {
      if (side === 'left' || side === 'right') $('#app').style.setProperty(side === 'left' ? '--lw' : '--rw', G.el.hidden ? '0px' : Math.max(160, Math.min(innerWidth - 420, G.w || def)) + 'px');
      else if (G.h != null) G.el.style.setProperty(side === 'bottom' ? '--dh' : '--th', Math.max(90, Math.min(innerHeight - 180, G.h)) + 'px');
    };
    addEventListener('resize', () => G.sync());
    G.render = () => {
      const open = panels().filter(isOpen);
      if (!open.length) { G.active = null; if (!G.el.hidden) { G.el.hidden = true; G.sync(); } return; }
      if (!open.some(p => p.id === G.active)) G.active = open[open.length - 1].id;
      const known = new Set([...G.tabs.children].map(t => t.dataset.p));
      G.tabs.innerHTML = open.map((p, i) => {
        const m = metaOf(p);
        return `<button class="dk-tab${p.id === G.active ? ' on' : ''}${known.has(p.id) ? '' : ' new'}" role="tab" aria-selected="${p.id === G.active}" data-p="${esc(p.id)}" style="--i:${i}" title="${esc(m.title)} (arraste para levar a outro lugar)">${iconOf(m)}<span class="nm">${esc(m.title)}</span><span class="ct" hidden></span><span class="dot" hidden></span><span class="x" title="Fechar">${I.x}</span></button>`;
      }).join('');
      open.forEach(p => { p.classList.toggle('dock-on', p.id === G.active); p.classList.toggle('dock-ttl', !!metaOf(p).hideTtl); });
      panels().filter(p => !isOpen(p)).forEach(p => p.classList.remove('dock-on'));
      if (G.el.hidden) { G.el.hidden = false; G.sync(); G.el.classList.remove('rise'); void G.el.offsetWidth; G.el.classList.add('rise'); }
      G.el.classList.toggle('min', G.min);
      open.forEach(G.updStatus);
      requestAnimationFrame(G.moveInk);
    };
    G.moveInk = () => {
      const t = G.tabs.querySelector('.dk-tab.on'); if (!t) return;
      G.ink.style.transform = `translateX(${t.offsetLeft - G.tabs.scrollLeft}px)`; G.ink.style.width = t.offsetWidth + 'px';
      G.el.style.setProperty('--tabs-w', G.bar.offsetWidth + 'px');
    };
    G.updStatus = (p) => {
      const m = META[p.id], t = G.tabs.querySelector(`[data-p="${CSS.escape(p.id)}"]`); if (!m || !m.status || !t) return;
      let s; try { s = m.status(); } catch { return; }
      const ct = t.querySelector('.ct'), dot = t.querySelector('.dot');
      const n = s.count || 0, was = ct.textContent;
      ct.hidden = !n; ct.textContent = n || ''; ct.classList.toggle('err', !!s.err);
      if (n && String(n) !== was && was !== '') { ct.classList.remove('bump'); void ct.offsetWidth; ct.classList.add('bump'); }
      dot.hidden = !s.dot; dot.className = 'dot ' + (s.dot || '');
      requestAnimationFrame(G.moveInk);
    };
    G.activate = (id) => {
      const prev = G.active; G.active = id; G.min = false;
      const open = panels().filter(isOpen), a = open.findIndex(p => p.id === prev), b = open.findIndex(p => p.id === id);
      G.render();
      const p = $('#' + CSS.escape(id));
      if (p && prev !== id) { p.style.setProperty('--dir', b < a ? -1 : 1); p.classList.remove('dock-in'); void p.offsetWidth; p.classList.add('dock-in'); }
    };
    G.close = (id) => {
      const p = $('#' + CSS.escape(id)); if (!p) return;
      const m = metaOf(p), btn = m.close && $(m.close);
      if (G.active === id) { const open = panels().filter(isOpen), i = open.indexOf(p); const n = open[i + 1] || open[i - 1]; G.active = n ? n.id : null; }
      if (btn) btn.click(); else p.hidden = true;
    };
    G.tabs.addEventListener('click', (e) => {
      const t = e.target.closest('.dk-tab'); if (!t || G.dragged) return;
      if (e.target.closest('.x')) { G.close(t.dataset.p); return; }
      if (t.dataset.p === G.active) { G.min = !G.min; G.render(); return; }
      G.activate(t.dataset.p);
    });
    G.tabs.addEventListener('auxclick', (e) => { const t = e.target.closest('.dk-tab'); if (t && e.button === 1) G.close(t.dataset.p); });
    G.tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const all = [...G.tabs.children], i = all.indexOf(document.activeElement); if (i < 0) return;
      const n = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]; G.activate(n.dataset.p); G.tabs.querySelector(`[data-p="${CSS.escape(n.dataset.p)}"]`).focus();
    });
    G.tabs.addEventListener('scroll', () => requestAnimationFrame(G.moveInk));
    // arrastar uma aba leva o painel para outro lugar
    G.tabs.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('.dk-tab'); if (!t || e.button !== 0 || e.target.closest('.x')) return;
      const p = $('#' + CSS.escape(t.dataset.p)); if (!p) return;
      const m = metaOf(p);
      startDrag(e, { id: p.id, title: m.title, icon: iconOf(m), from: side, onStart: () => { G.dragged = true; }, onEnd: () => setTimeout(() => { G.dragged = false; }, 0), drop: (to) => move(p.id, to) });
    });

    // quem abre/fecha: os próprios painéis, mudando `hidden`
    const watched = new WeakSet();
    const onHidden = new MutationObserver((recs) => {
      for (const r of recs) {
        const p = r.target, was = r.oldValue !== null;
        if (!was || !isOpen(p) || p.parentElement !== G.body) continue;
        // lembrado como janela flutuante: abre direto nela
        if (L.panels[p.id] === 'float') { floatPanel(p); G.render(); return; }
        G.activate(p.id); return;
      }
      G.render();
    });
    const onInner = new MutationObserver((recs) => { const seen = new Set(); recs.forEach(r => { const p = r.target.closest && r.target.closest('.dock-panel') || r.target.parentElement?.closest('.dock-panel'); if (p && !seen.has(p)) { seen.add(p); G.updStatus(p); } }); });
    G.adopt = () => {
      panels().forEach(p => {
        p.classList.add('dock-panel');
        // o layout lembrado manda este painel para outra região (painel de plugin que chegou agora)
        const want = L.panels[p.id];
        if (want && want !== side && want !== 'float' && R[want]) { R[want].body.appendChild(p); return; }
        if (watched.has(p)) return; watched.add(p);
        onHidden.observe(p, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
        (META[p.id]?.watch || []).forEach(sel => { const el = $(sel); if (el) onInner.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] }); });
      });
      G.render();
    };
    new MutationObserver(G.adopt).observe(G.body, { childList: true });
    new ResizeObserver(() => requestAnimationFrame(G.moveInk)).observe(G.tabs);

    // tamanho: arrastar a borda (bem pequeno recolhe), duplo clique volta ao padrão
    G.w = side === 'left' || side === 'right' ? store.get(key, def) : null;
    if (G.horiz) G.setSize(store.get(key, def));
    G.resize.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, s0 = G.horiz ? (G.min ? 0 : G.el.offsetHeight) : G.el.offsetWidth;
      document.body.classList.add(G.horiz ? 'resizing-v' : 'resizing-h', 'dock-drag');
      const move = (ev) => {
        const d = side === 'bottom' ? y0 - ev.clientY : side === 'top' ? ev.clientY - y0 : side === 'left' ? ev.clientX - x0 : x0 - ev.clientX;
        const n = s0 + d;
        if (G.horiz && n < 90) { if (!G.min) { G.min = true; G.render(); } return; }
        if (G.min) { G.min = false; G.render(); }
        G.setSize(Math.round(Math.max(G.horiz ? 90 : 220, Math.min((G.horiz ? innerHeight - 180 : innerWidth - 420), n))));
      };
      const up = () => { document.body.classList.remove('resizing-v', 'resizing-h', 'dock-drag'); if (!G.min) store.set(key, G.horiz ? G.el.offsetHeight : G.w); dispatchEvent(new Event('resize')); };
      pointerDrag(e, move, up);
    });
    G.resize.addEventListener('dblclick', () => { G.min = false; G.setSize(def); store.set(key, def); G.render(); });
    return G;
  }
  R.bottom = region('bottom', { el: $('#dock'), bar: $('#dockBar'), tabs: $('#dockTabs'), ink: $('#dockInk'), body: $('#dockBody'), resize: $('#dockResize') });
  for (const s of ['top', 'left', 'right']) R[s] = region(s, mkRegion(s));
  const regionOf = (el) => Object.values(R).find(g => el && el.parentElement === g.body) || null;

  // ----- levar um painel para outro lugar -----
  function move(id, to) {
    const p = $('#' + CSS.escape(id));
    // janela do balão (ou painel dentro de uma): quem cuida é o balão
    if (BS.bubble && BS.bubble.owns && BS.bubble.owns(id)) { BS.bubble.dockTo(id, to); return; }
    if (!p) return;
    const from = regionOf(p);
    if (to === 'float') { floatPanel(p); return; }
    const g = R[to]; if (!g) return;
    L.panels[id] = to; saveLayout();
    if (from === g) return;
    const open = !p.hidden;
    g.body.appendChild(p);
    if (open) { p.hidden = false; g.activate(id); }
    land(g.el);
    if (from) from.render();
    announce(id, from ? from.side : 'float', to);
  }
  // a região que acabou de receber um painel acende por um instante
  function land(el) { if (!el || el.hidden || reduce()) return; el.classList.remove('ly-land'); void el.offsetWidth; el.classList.add('ly-land'); setTimeout(() => el.classList.remove('ly-land'), 700); }
  function announce(id, from, to) {
    BS.hooks.run('layout:move', id, from, to);
    requestAnimationFrame(() => dispatchEvent(new Event('resize')));
  }
  // painel de região numa janela flutuante do balão: fechar a janela devolve o painel para a região de onde veio
  function floatPanel(p) {
    if (!BS.bubble) return;
    const from = regionOf(p) || R.bottom, m = metaOf(p), home = from.side === 'float' ? 'bottom' : from.side;
    const wid = 'panel:' + p.id;
    L.panels[p.id] = 'float'; saveLayout();
    p.hidden = false;
    let ob = null; // vigia do botão de fechar do próprio painel; sai quando a janela fecha (por qualquer caminho)
    BS.bubble.register({
      id: wid, title: m.title, icon: iconOf(m), order: 500, width: 620, height: 380, panel: p.id,
      render(el) { el.appendChild(p); p.classList.add('dock-on', 'dock-floating'); },
      // fechada: o painel volta para casa, fechado
      closed() { ob?.disconnect(); p.classList.remove('dock-floating'); L.panels[p.id] = home; saveLayout(); R[home].body.appendChild(p); p.hidden = true; queueMicrotask(() => BS.bubble.unregister(wid)); },
    });
    BS.bubble.open(wid);
    from.render();
    // o painel fechado por dentro (botão dele): fecha a janela
    ob = new MutationObserver(() => { if (p.hidden && p.classList.contains('dock-floating')) { ob.disconnect(); BS.bubble.close(wid); } });
    ob.observe(p, { attributes: true, attributeFilter: ['hidden'] });
    announce(p.id, from.side, 'float');
  }

  // ----- o painel de arquivos (Projeto, Alterações...) troca de lado -----
  function toolSide(side) {
    L.tool = side === 'right' ? 'right' : 'left'; saveLayout();
    $('#app').classList.toggle('tool-right', L.tool === 'right');
    land($('#tool'));
    announce('tool', null, L.tool);
  }
  $('#app').classList.toggle('tool-right', L.tool === 'right');
  $('#tool .head').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, a')) return;
    startDrag(e, { id: 'tool', title: $('#toolTitle').textContent || 'Projeto', icon: (BS.tools.get(BS.S.tool) || {}).icon || GEAR, sides: ['left', 'right'], from: L.tool, edges: true, drop: toolSide });
  });
  $('#tool .head').title = 'Arraste para levar o painel para o outro lado';

  // ----- arrastar: nada no meio da tela. Faixas finas nas bordas do editor acendem quando o ponteiro chega perto,
  // e a prévia cresce a partir da borda; soltar no meio do editor faz o painel flutuar (a prévia segue o ponteiro) -----
  document.body.insertAdjacentHTML('beforeend', `<div id="lyOver" class="ly-over" hidden>
      <div class="ly-preview" id="lyPreview"></div>
      ${['top', 'left', 'right', 'bottom'].map(s => `<div class="ly-edge ly-e-${s}" data-side="${s}"></div>`).join('')}
    </div>
    <div id="lyChip" class="ly-chip" hidden></div>`);
  const over = $('#lyOver'), preview = $('#lyPreview'), chip = $('#lyChip');
  const D = { on: false, opt: null, side: null };
  const ALL = ['top', 'left', 'float', 'right', 'bottom'];
  // onde os destinos ficam: as bordas do editor (as da janela inteira, para o painel de arquivos)
  const frame = () => (D.opt && D.opt.edges ? $('#app') : $('#editor')).getBoundingClientRect();
  // a área de cada destino, para a prévia
  function areaOf(side, x, y) {
    const ed = $('#editor').getBoundingClientRect(), app = $('#app').getBoundingClientRect();
    if (D.opt && D.opt.id === 'tool') { const tw = $('#tool').offsetWidth || 300; return side === 'right' ? { x: app.right - tw - 6, y: ed.top, w: tw, h: ed.height } : { x: app.left + 52, y: ed.top, w: tw, h: ed.height }; }
    const t = Math.min(ed.height * .4, 260), w = Math.min(ed.width * .4, 380);
    if (side === 'left') return { x: ed.left, y: ed.top, w, h: ed.height };
    if (side === 'right') return { x: ed.right - w, y: ed.top, w, h: ed.height };
    if (side === 'top') return { x: ed.left, y: ed.top, w: ed.width, h: t };
    if (side === 'bottom') return { x: ed.left, y: ed.bottom - t, w: ed.width, h: t };
    if (side === 'float') return { x: x - 170, y: y - 18, w: 340, h: 220 };
    return null;
  }
  function placeEdges() {
    const r = frame(), sides = D.opt.sides || ALL;
    over.querySelectorAll('.ly-edge').forEach(e => {
      const sd = e.dataset.side, ok = sides.includes(sd) && sd !== D.opt.from;
      e.hidden = !ok || (D.opt.edges && (sd === 'top' || sd === 'bottom'));
      const v = sd === 'left' || sd === 'right';
      Object.assign(e.style, v
        ? { left: (sd === 'left' ? r.left + 5 : r.right - 9) + 'px', top: (r.top + r.height * .18) + 'px', width: '4px', height: (r.height * .64) + 'px' }
        : { left: (r.left + r.width * .2) + 'px', top: (sd === 'top' ? r.top + 5 : r.bottom - 9) + 'px', width: (r.width * .6) + 'px', height: '4px' });
    });
  }
  function show(opt) {
    D.on = true; D.opt = opt; D.side = null;
    placeEdges();
    over.hidden = false; over.classList.remove('in'); void over.offsetWidth; over.classList.add('in');
    preview.classList.remove('on', 'float');
    if (opt.chip !== false) { chip.innerHTML = `${opt.icon || GEAR}<span>${esc(opt.title || '')}</span>`; chip.hidden = false; }
  }
  function hover(x, y) {
    if (!D.on) return null;
    if (!chip.hidden) chip.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
    const sides = D.opt.sides || ALL, r = frame();
    // faixa de cada borda: larga o bastante para achar sem mirar, sem chegar ao meio
    const E = Math.max(48, Math.min(110, Math.min(r.width, r.height) * .16));
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    let side = null;
    if (inside) {
      const d = { left: x - r.left, right: r.right - x, top: D.opt.edges ? Infinity : y - r.top, bottom: D.opt.edges ? Infinity : r.bottom - y };
      const near = Object.keys(d).filter(k => d[k] < E && sides.includes(k)).sort((p, q) => d[p] - d[q])[0];
      if (near) side = near;
      // no meio: flutuar, depois de sair da região de onde o painel veio (um arraste curto não faz nada)
      else if (sides.includes('float') && D.opt.from !== 'float') {
        const home = R[D.opt.from] && R[D.opt.from].el.getBoundingClientRect();
        const inHome = home && x >= home.left && x <= home.right && y >= home.top && y <= home.bottom;
        if (!inHome) side = 'float';
      }
    }
    if (side === D.opt.from && side !== 'float') side = null;
    if (side !== D.side) {
      D.side = side;
      over.querySelectorAll('.ly-edge').forEach(e => e.classList.toggle('hot', e.dataset.side === side));
      preview.classList.toggle('float', side === 'float');
      if (side) { preview.dataset.label = SIDE_NAME[side]; preview.classList.add('on'); } else preview.classList.remove('on');
    }
    const ar = side && areaOf(side, x, y);
    if (ar) Object.assign(preview.style, { left: ar.x + 'px', top: ar.y + 'px', width: ar.w + 'px', height: ar.h + 'px' });
    return side;
  }
  function hide() {
    D.on = false; chip.hidden = true;
    over.classList.remove('in'); preview.classList.remove('on');
    setTimeout(() => { if (!D.on) over.hidden = true; }, reduce() ? 0 : 160);
    const s = D.side; D.side = null; return s;
  }
  // um arraste começa depois de 6 px; um clique simples não mostra nada
  function startDrag(e, opt) {
    const x0 = e.clientX, y0 = e.clientY; let started = false;
    const mv = (ev) => {
      if (!started) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return; started = true; opt.onStart && opt.onStart(); show(opt); document.body.classList.add('ly-dragging'); }
      ev.preventDefault(); hover(ev.clientX, ev.clientY);
    };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('keydown', esc_);
      document.body.classList.remove('ly-dragging');
      if (!started) return;
      const side = hide(); opt.onEnd && opt.onEnd();
      if (side) opt.drop(side);
    };
    const esc_ = (ev) => { if (ev.key === 'Escape') { D.side = null; hide(); started = false; up(); } };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('keydown', esc_);
  }

  // botão da barra da esquerda: painel aberto atrás de outro (ou região recolhida) vem para a frente em vez de fechar
  BS.dock = {
    claim(toolId) {
      const id = Object.keys(META).find(k => META[k].tool === toolId) || [...document.querySelectorAll('[data-dock-tool]')].find(p => p.dataset.dockTool === toolId)?.id;
      const p = id && $('#' + CSS.escape(id)); const g = regionOf(p);
      if (!p || !g || p.hidden || (g.active === id && !g.min)) return false;
      g.activate(id); return true;
    },
    activate(id) { const g = regionOf($('#' + CSS.escape(id))); if (g) g.activate(id); },
    close(id) { const g = regionOf($('#' + CSS.escape(id))); if (g) g.close(id); },
    get active() { return R.bottom.active; },
    region: (side) => R[side] || null,
  };
  BS.layout = {
    sides: ['bottom', 'top', 'left', 'right', 'float'],
    move: (id, to) => id === 'tool' ? toolSide(to) : move(id, to),
    sideOf(id) {
      if (id === 'tool') return L.tool;
      if (BS.bubble && BS.bubble.sideOf) { const s = BS.bubble.sideOf(id); if (s) return s; }
      const g = regionOf($('#' + CSS.escape(id))); return g ? g.side : (L.panels[id] || null);
    },
    remember(id, side) { if (side) L.panels[id] = side; else delete L.panels[id]; saveLayout(); },
    remembered: (id) => L.panels[id] || null,
    // qualquer elemento vira alça de arrastar: soltar num alvo chama drop(lado)
    draggable(handle, opt) { handle.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('button, input, select, textarea, a')) return; startDrag(e, opt); }); },
    // para quem já arrasta por conta própria (as janelas do balão): mostrar os alvos, acompanhar e soltar
    show, hover, hide, land,
    body: (side) => R[side] ? R[side].body : null,
  };
  Object.values(R).forEach(g => g.adopt());
  addEventListener('resize', () => Object.values(R).forEach(g => requestAnimationFrame(g.moveInk)));
})();
