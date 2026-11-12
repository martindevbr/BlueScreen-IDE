// ===== Balão flutuante: um lançador de janelas que ficam por cima da IDE (o IAMaker e as que os plugins registrarem) =====
// O balão (ícone de menu) é arrastado para qualquer lugar e gruda na borda quando chega perto. Um clique abre a lista
// de ferramentas; cada uma abre na própria janela, que nasce do balão e pode ser movida pelo topo, redimensionada
// pelas bordas, maximizada (duplo clique no topo), minimizada de volta para o balão e fechada. Várias ficam abertas
// ao mesmo tempo; posição, tamanho e quais estavam abertas ficam lembrados. Sem ferramentas, o balão não aparece.
//   bs.bubble.register({ id, title, icon, order, width, height, render(el), show(), hide() })   render roda no registro
//   bs.bubble.open(id) / minimize(id) / close(id) / toggle(id) / isOpen(id) / windowOf(id) / unregister(id)
//   bs.bubble.badge(id, 'busy' | 'dot' | null)   bs.bubble.placeholder(texto) -> item "criando…" na lista (remove())
(() => {
  const { $, esc, store, I } = BS;
  const TOOL = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>';
  const MIN = '<svg class="i" viewBox="0 0 24 24"><path d="M6 12h12"/></svg>';
  const MAX = '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
  const RESTORE = '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/></svg>';
  const SIZE = 42, EDGE = 12, SNAP = 48, MINW = 300, MINH = 220, TOP = 44, BOTTOM = 30;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.body.insertAdjacentHTML('beforeend', `
    <button id="bb" class="bb" type="button" hidden title="Janelas flutuantes (arraste para mover)" aria-haspopup="menu" aria-expanded="false">
      <span class="bb-burger" aria-hidden="true"><i></i><i></i><i></i></span><span class="bb-badge" hidden></span></button>
    <div id="bbMenu" class="bb-menu" role="menu" hidden>
      <div class="bb-mhd"><span>Janelas</span><span class="bb-mct" id="bbCount"></span></div>
      <div class="bb-list" id="bbList"></div>
      <div class="bb-mft"><button type="button" class="bb-mbtn" id="bbTidy">Organizar</button><button type="button" class="bb-mbtn" id="bbMinAll">Minimizar todas</button></div>
    </div>`);
  const btn = $('#bb'), menu = $('#bbMenu'), listEl = $('#bbList');

  const D = new Map();        // id -> def
  const W = new Map();        // id -> { el, pane, state: 'closed' | 'open' | 'min', max: rect | null }
  const badges = new Map(), ghosts = new Set();
  let z = 60;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const vw = () => innerWidth, vh = () => innerHeight;
  const sorted = () => [...D.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  // ----- o balão: posição em frações da janela (sobrevive a mudar de tamanho) -----
  function bubbleXY() {
    const p = store.get('bbPos', null) || { fx: 1, fy: 1 };
    return { x: clamp(p.fx * (vw() - SIZE), EDGE, vw() - SIZE - EDGE), y: clamp(p.fy * (vh() - SIZE), TOP, vh() - SIZE - BOTTOM) };
  }
  function placeBubble(x, y, save) {
    btn.style.transform = `translate(${x}px, ${y}px)`; btn.dataset.x = x; btn.dataset.y = y;
    if (save) store.set('bbPos', { fx: x / Math.max(1, vw() - SIZE), fy: y / Math.max(1, vh() - SIZE) });
  }
  const center = () => ({ x: +btn.dataset.x + SIZE / 2, y: +btn.dataset.y + SIZE / 2 });
  function snap(x, y) {
    if (x < SNAP) x = EDGE; else if (x > vw() - SIZE - SNAP) x = vw() - SIZE - EDGE;
    if (y < TOP + SNAP) y = TOP; else if (y > vh() - SIZE - BOTTOM - SNAP) y = vh() - SIZE - BOTTOM;
    return { x, y };
  }

  // ----- a lista do balão -----
  function placeMenu() {
    const c = center(), r = menu.getBoundingClientRect(), w = r.width || 280, h = r.height || 200;
    const left = c.x > vw() / 2, up = c.y > vh() / 2;
    const x = clamp(left ? c.x + SIZE / 2 - w : c.x - SIZE / 2, EDGE, vw() - w - EDGE);
    const y = clamp(up ? c.y - SIZE / 2 - 10 - h : c.y + SIZE / 2 + 10, TOP, vh() - h - 8);
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    menu.style.transformOrigin = `${c.x - x}px ${c.y - y}px`;
  }
  const STATE = { open: 'aberta', min: 'minimizada' };
  const SIDE = { bottom: 'embaixo', top: 'em cima', left: 'à esquerda', right: 'à direita' };
  const stateText = (w) => w.state === 'docked' ? 'na tela, ' + (SIDE[w.side] || '') : w.state === 'dockedOff' ? 'encaixada ' + (SIDE[w.side] || '') + ', fechada' : STATE[w.state];
  function renderMenu() {
    const all = sorted();
    btn.hidden = !all.length;
    const open = [...W.values()].filter(w => w.state === 'open' || w.state === 'min' || w.state === 'docked').length;
    $('#bbCount').textContent = open ? `${open} aberta${open > 1 ? 's' : ''}` : '';
    listEl.innerHTML = all.map(d => {
      const w = W.get(d.id) || {}, st = w.state || 'closed', b = badges.get(d.id);
      return `<div class="bb-item ${st}" role="menuitem" tabindex="0" data-id="${esc(d.id)}">
        <span class="bb-iic">${d.icon || TOOL}</span><span class="bb-it"><b>${esc(d.title)}</b>${stateText(w) ? `<small>${stateText(w)}</small>` : ''}</span>
        ${b ? `<span class="bb-idot ${b === 'busy' ? 'busy' : ''}"></span>` : ''}
        ${st === 'open' || st === 'min' || st === 'docked' ? `<button type="button" class="bb-ix" data-close title="Fechar ${esc(d.title)}">${I.x}</button>` : ''}</div>`;
    }).join('');
    ghosts.forEach(g => listEl.appendChild(g));
    $('#bbMinAll').disabled = ![...W.values()].some(w => w.state === 'open');
    paintBadge();
  }
  function paintBadge() {
    const v = [...badges.values()];
    btn.classList.toggle('busy', v.includes('busy') || ghosts.size > 0);
    btn.querySelector('.bb-badge').hidden = !v.includes('dot');
  }
  function toggleMenu(on) {
    on = on ?? menu.hidden;
    if (!on) { if (menu.hidden) return; menu.classList.add('out'); btn.classList.remove('on'); btn.setAttribute('aria-expanded', 'false'); setTimeout(() => { menu.hidden = true; menu.classList.remove('out'); }, reduce() ? 0 : 160); return; }
    renderMenu(); menu.hidden = false; menu.classList.remove('out'); placeMenu();
    menu.classList.remove('in'); void menu.offsetWidth; menu.classList.add('in');
    btn.classList.add('on'); btn.setAttribute('aria-expanded', 'true');
    listEl.querySelector('.bb-item')?.focus({ preventScroll: true });
  }
  listEl.addEventListener('click', (e) => {
    const it = e.target.closest('.bb-item[data-id]'); if (!it) return;
    if (e.target.closest('[data-close]')) { close(it.dataset.id); renderMenu(); return; }
    toggleMenu(false); open(it.dataset.id);
  });
  listEl.addEventListener('keydown', (e) => {
    const it = e.target.closest('.bb-item'); if (!it) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.click(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const all = [...listEl.querySelectorAll('.bb-item[data-id]')]; all[(all.indexOf(it) + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus(); }
  });
  $('#bbMinAll').onclick = () => { W.forEach((w, id) => { if (w.state === 'open') minimize(id); }); toggleMenu(false); };
  $('#bbTidy').onclick = () => { tidy(); toggleMenu(false); };
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) toggleMenu(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { toggleMenu(false); btn.focus(); } });

  // ----- arrastar o balão (um clique sem arrastar abre a lista) -----
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY, bx = +btn.dataset.x, by = +btn.dataset.y;
    let moved = false;
    btn.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) { moved = true; btn.classList.add('dragging'); toggleMenu(false); }
      placeBubble(clamp(bx + dx, EDGE, vw() - SIZE - EDGE), clamp(by + dy, TOP, vh() - SIZE - BOTTOM));
    };
    const up = () => {
      btn.removeEventListener('pointermove', move); btn.removeEventListener('pointerup', up); btn.removeEventListener('pointercancel', up);
      btn.classList.remove('dragging');
      if (!moved) { toggleMenu(); return; }
      const s = snap(+btn.dataset.x, +btn.dataset.y);
      btn.classList.add('springing'); placeBubble(s.x, s.y, true);
      setTimeout(() => btn.classList.remove('springing'), 450);
    };
    btn.addEventListener('pointermove', move); btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
  });

  // ----- janelas -----
  function makeWin(def) {
    const el = document.createElement('section');
    el.className = 'bb-win'; el.hidden = true; el.dataset.id = def.id;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', def.title);
    el.innerHTML = `<header class="bb-hd" title="Arraste para mover; duplo clique maximiza">
        <span class="bb-hic">${def.icon || TOOL}</span><span class="bb-ttl">${esc(def.title)}</span><span class="bb-sp"></span>
        <button type="button" class="bb-hb" data-a="min" title="Minimizar no balão">${MIN}</button>
        <button type="button" class="bb-hb" data-a="max" title="Maximizar">${MAX}</button>
        <button type="button" class="bb-hb bb-hx" data-a="close" title="Fechar">${I.x}</button></header>
      <div class="bb-pane"></div>
      ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => `<i class="bb-rz bb-rz-${d}" data-d="${d}"></i>`).join('')}`;
    document.body.appendChild(el);
    const w = { el, pane: el.querySelector('.bb-pane'), state: 'closed', max: null };
    el.addEventListener('pointerdown', () => focus(def.id), true);
    el.querySelector('.bb-hd').addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'min') minimize(def.id); else if (a.dataset.a === 'max') maximize(def.id); else close(def.id);
    });
    el.querySelector('.bb-hd').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) maximize(def.id); });
    el.querySelector('.bb-hd').addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, textarea')) return;
      if (w.max) return;
      drag(def.id, e, (r0, dx, dy) => ({ x: clamp(r0.left + dx, 80 - r0.width, vw() - 80), y: clamp(r0.top + dy, TOP - 8, vh() - 40), w: r0.width, h: r0.height }), true);
    });
    el.querySelectorAll('.bb-rz').forEach(h => h.addEventListener('pointerdown', (e) => {
      if (w.max) return;
      const d = h.dataset.d;
      drag(def.id, e, (r0, dx, dy) => {
        let x = r0.left, y = r0.top, ww = r0.width, hh = r0.height;
        if (d.includes('e')) ww = clamp(r0.width + dx, MINW, vw() - x - 4);
        if (d.includes('s')) hh = clamp(r0.height + dy, MINH, vh() - y - 4);
        if (d.includes('w')) { ww = clamp(r0.width - dx, MINW, r0.right - 4); x = r0.right - ww; }
        if (d.includes('n')) { hh = clamp(r0.height - dy, MINH, r0.bottom - TOP); y = r0.bottom - hh; }
        return { x, y, w: ww, h: hh };
      });
    }));
    return w;
  }
  // mover (dock = true): passando de uns pixels, aparecem os alvos do layout; soltar num deles encaixa a janela
  function drag(id, e, rect, dock) {
    e.preventDefault();
    const w = W.get(id), r0 = box(w), x0 = e.clientX, y0 = e.clientY, d = D.get(id);
    let shown = false;
    document.body.classList.add('bb-dragging'); w.el.classList.add('moving');
    const move = (ev) => {
      place(w, rect(r0, ev.clientX - x0, ev.clientY - y0));
      if (!dock || !BS.layout) return;
      if (!shown && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 12) { shown = true; BS.layout.show({ id, title: d.title, icon: d.icon, from: 'float', chip: false }); }
      if (shown) w.el.classList.toggle('docking', !!BS.layout.hover(ev.clientX, ev.clientY));
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.body.classList.remove('bb-dragging'); w.el.classList.remove('moving', 'docking');
      const side = shown ? BS.layout.hide() : null;
      if (side && side !== 'float') { place(w, { x: r0.left, y: r0.top, w: r0.width, h: r0.height }); dockTo(id, side); return; }
      saveRect(id);
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  const place = (w, r) => Object.assign(w.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  // a caixa da janela sem as animações (getBoundingClientRect inclui a escala de abrir e minimizar)
  function box(w) {
    const left = parseFloat(w.el.style.left) || 0, top = parseFloat(w.el.style.top) || 0, width = w.el.offsetWidth, height = w.el.offsetHeight;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  function saveRect(id) { const r = box(W.get(id)); store.set('bbWin:' + id, { x: r.left, y: r.top, w: r.width, h: r.height }); }
  // onde abrir: onde ficou da última vez; na primeira vez, junto do balão (para o lado em que há espaço), em cascata
  function rectFor(id) {
    const d = D.get(id), s = store.get('bbWin:' + id, null);
    const w = clamp((s && s.w) || d.width || 440, MINW, vw() - 2 * EDGE), h = clamp((s && s.h) || d.height || 560, MINH, vh() - TOP - 8);
    if (s) return { x: clamp(s.x, EDGE - w + 120, vw() - 120), y: clamp(s.y, TOP - 8, vh() - 60), w, h };
    const c = center(), n = [...W.values()].filter(x => x.state === 'open').length, off = n * 28;
    const left = c.x > vw() / 2, up = c.y > vh() / 2;
    let x = left ? c.x + SIZE / 2 - w - off : c.x - SIZE / 2 + off, y = up ? c.y - SIZE / 2 - 12 - h + off : c.y + SIZE / 2 + 12 + off;
    if (y < TOP || y + h > vh() - 8) { y = clamp(c.y - h / 2 + off, TOP, vh() - h - 8); x = left ? c.x - SIZE / 2 - 12 - w - off : c.x + SIZE / 2 + 12 + off; }
    return { x: clamp(x, EDGE, vw() - w - EDGE), y: clamp(y, TOP, vh() - h - 8), w, h };
  }
  function focus(id) {
    const w = W.get(id); if (!w || w.state !== 'open') return;
    if (+w.el.style.zIndex !== z) {
      // a pilha não cresce sem parar: menus e diálogos (z-index 90) ficam sempre por cima das janelas
      if (z >= 84) { z = 60; [...W.values()].filter(x => x !== w).sort((a, b) => (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0)).forEach(x => { x.el.style.zIndex = ++z; }); }
      w.el.style.zIndex = ++z;
    }
    W.forEach(x => x.el.classList.toggle('front', x === w));
  }
  // as animações saem do balão e voltam para ele
  function aim(w) {
    const r = box(w), c = center();
    w.el.style.setProperty('--ox', (c.x - r.left) + 'px'); w.el.style.setProperty('--oy', (c.y - r.top) + 'px');
    w.el.style.setProperty('--tx', (c.x - (r.left + r.width / 2)) + 'px'); w.el.style.setProperty('--ty', (c.y - (r.top + r.height / 2)) + 'px');
  }
  function anim(w, cls, after) {
    w.el.classList.remove('opening', 'minimizing', 'closing'); void w.el.offsetWidth;
    if (reduce()) { after && after(); return; }
    w.el.classList.add(cls);
    const done = () => { w.el.removeEventListener('animationend', done); w.el.classList.remove(cls); after && after(); };
    w.el.addEventListener('animationend', done);
  }
  function saveStates() { const s = {}; W.forEach((w, id) => { if (w.state === 'open' || w.state === 'min') s[id] = w.state; }); store.set('bbOpen', s); }
  const call = (id, fn) => { const d = D.get(id); try { d && d[fn] && d[fn](); } catch (e) { console.error('balão ' + id, e); } };

  function open(id) {
    const w = W.get(id); if (!w) return;
    if (isDocked(w)) { const wrap = $('#' + CSS.escape(wrapId(id))); if (wrap) { wrap.hidden = false; BS.dock && BS.dock.activate(wrap.id); } return; }
    if (w.state === 'open') { focus(id); return; }
    if (!w.max) place(w, rectFor(id));
    w.el.hidden = false; w.state = 'open';
    focus(id); aim(w); anim(w, 'opening');
    call(id, 'show'); saveStates(); renderMenu();
  }
  function minimize(id) {
    const w = W.get(id); if (w && w.state === 'docked') return close(id);
    if (!w || w.state !== 'open') return;
    w.state = 'min'; call(id, 'hide'); aim(w);
    anim(w, 'minimizing', () => { if (w.state === 'min') w.el.hidden = true; });
    btn.classList.remove('gulp'); void btn.offsetWidth; btn.classList.add('gulp');
    saveStates(); renderMenu();
  }
  function close(id) {
    const w = W.get(id); if (!w || w.state === 'closed') return;
    if (isDocked(w)) { const wrap = $('#' + CSS.escape(wrapId(id))); if (wrap) wrap.hidden = true; return; }
    const was = w.state; w.state = 'closed';
    if (was === 'open') { call(id, 'hide'); anim(w, 'closing', () => { if (w.state === 'closed') w.el.hidden = true; }); } else w.el.hidden = true;
    saveStates(); renderMenu();
    call(id, 'closed');
  }
  function maximize(id) {
    const w = W.get(id); if (!w || w.state !== 'open') return;
    const b = w.el.querySelector('[data-a="max"]');
    w.el.classList.add('resizing');
    if (w.max) { place(w, w.max); w.max = null; b.innerHTML = MAX; b.title = 'Maximizar'; }
    else { const r = box(w); w.max = { x: r.left, y: r.top, w: r.width, h: r.height }; place(w, { x: 8, y: TOP - 4, w: vw() - 16, h: vh() - TOP - BOTTOM + 2 }); b.innerHTML = RESTORE; b.title = 'Restaurar'; }
    w.el.classList.toggle('maxed', !!w.max);
    setTimeout(() => w.el.classList.remove('resizing'), 260);
  }
  // as abertas em cascata, a partir do canto de cima à esquerda da área do editor
  function tidy() {
    let i = 0;
    W.forEach((w, id) => {
      if (w.state !== 'open') return;
      if (w.max) maximize(id);
      const r = box(w);
      w.el.classList.add('resizing');
      place(w, { x: clamp(80 + i * 32, EDGE, vw() - r.width - EDGE), y: clamp(TOP + 16 + i * 32, TOP, vh() - r.height - 8), w: r.width, h: r.height });
      setTimeout(() => { w.el.classList.remove('resizing'); saveRect(id); }, 260);
      focus(id); i++;
    });
  }
  // ----- encaixada numa região do layout (dock.js): a área da janela vai para um painel com aba -----
  const FLOAT = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="7" width="14" height="13" rx="2"/><path d="M8 4h11a2 2 0 0 1 2 2v9"/></svg>';
  const wrapId = (id) => 'bbd-' + id;
  const bubbleOf = (pid) => { if (W.has(pid)) return pid; const p = String(pid).startsWith('bbd-') ? pid.slice(4) : null; return p && W.has(p) ? p : null; };
  function dockTo(pid, side) {
    const id = bubbleOf(pid); if (!id || !BS.layout) return;
    if (side === 'float') return undock(id);
    const w = W.get(id), d = D.get(id), body = BS.layout.body(side); if (!body) return;
    // janela que leva um painel de região (Terminal, Build...): o painel volta para uma região e a janela some
    if (d.panel) {
      d.closed = null;
      const p = $('#' + CSS.escape(d.panel));
      BS.layout.move(d.panel, side);
      if (p) { p.classList.remove('dock-floating'); p.hidden = false; BS.dock && BS.dock.activate(p.id); }
      BS.bubble.unregister(id);
      return;
    }
    let wrap = $('#' + CSS.escape(wrapId(id)));
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = wrapId(id); wrap.className = 'bb-docked'; wrap.hidden = true;
      wrap.dataset.dockTitle = d.title; if (d.icon) wrap.dataset.dockIcon = d.icon; wrap.setAttribute('data-dock-hide-ttl', '');
      wrap.innerHTML = `<div class="head"><span class="ttl">${esc(d.title)}</span><span class="spacer"></span><button type="button" class="icon-btn bb-unfloat" title="Voltar a flutuar">${FLOAT}</button></div>`;
      wrap.querySelector('.bb-unfloat').onclick = () => undock(id);
      // a aba fechada (x): a janela fica guardada no balão, encaixada
      new MutationObserver(() => {
        if (w.state === 'docked' && wrap.hidden) { call(id, 'hide'); w.state = 'dockedOff'; renderMenu(); }
        else if (w.state === 'dockedOff' && !wrap.hidden) { w.state = 'docked'; call(id, 'show'); renderMenu(); }
      }).observe(wrap, { attributes: true, attributeFilter: ['hidden'] });
    }
    const was = w.state;
    wrap.appendChild(w.pane);
    body.appendChild(wrap);
    w.el.hidden = true; w.state = 'docked'; w.side = side;
    wrap.hidden = false;
    BS.dock && BS.dock.activate(wrap.id);
    BS.layout.land && BS.layout.land(body.closest('.dk-region, #dock'));
    BS.layout.remember('bb:' + id, side);
    if (was !== 'open' && was !== 'docked') call(id, 'show');
    saveStates(); renderMenu();
    BS.hooks.run('layout:move', id, was === 'docked' ? 'region' : 'float', side);
    requestAnimationFrame(() => dispatchEvent(new Event('resize')));
  }
  function undock(id) {
    const w = W.get(id); if (!w) return;
    const wrap = $('#' + CSS.escape(wrapId(id)));
    w.el.insertBefore(w.pane, w.el.querySelector('.bb-rz'));
    if (wrap) wrap.remove();
    const was = w.state; w.state = 'closed'; w.side = null;
    if (BS.layout) BS.layout.remember('bb:' + id, null);
    if (was === 'docked') call(id, 'hide');
    open(id);
    BS.hooks.run('layout:move', id, 'region', 'float');
  }
  const isDocked = (w) => w.state === 'docked' || w.state === 'dockedOff';

  const toggle = (id) => { const w = W.get(id); if (!w) return; if ((w.state === 'open' && w.el.classList.contains('front')) || w.state === 'docked') minimize(id); else open(id); };

  addEventListener('resize', () => {
    const b = bubbleXY(); placeBubble(b.x, b.y);
    W.forEach(w => {
      if (w.state !== 'open') return;
      if (w.max) { place(w, { x: 8, y: TOP - 4, w: vw() - 16, h: vh() - TOP - BOTTOM + 2 }); return; }
      const r = box(w);
      place(w, { x: clamp(r.left, EDGE - r.width + 120, vw() - 120), y: clamp(r.top, TOP - 8, vh() - 60), w: Math.min(r.width, vw() - 2 * EDGE), h: Math.min(r.height, vh() - TOP - 8) });
    });
    if (!menu.hidden) placeMenu();
  });

  const remembered = store.get('bbOpen', {}) || {};
  BS.bubble = {
    // as janelas registradas, na ordem do menu: [{ id, title, icon }]
    list: () => [...D.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)).map(d => ({ id: d.id, title: d.title, icon: d.icon, footer: !!d.footer })),
    register(def) {
      if (!def || !def.id || !def.title) throw new Error('janela do balão precisa de id e title');
      if (BS.plugins.current && !def.plugin) def.plugin = BS.plugins.current;
      if (D.has(def.id)) BS.bubble.unregister(def.id);
      D.set(def.id, def);
      const w = makeWin(def); W.set(def.id, w);
      try { def.render && def.render(w.pane); } catch (e) { console.error('balão ' + def.id, e); w.pane.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
      if (def.plugin && BS.plugins.owned) { const o = BS.plugins.owned[def.plugin] = BS.plugins.owned[def.plugin] || {}; (o.bubbles = o.bubbles || []).push(def.id); }
      renderMenu();
      // estava aberta (ou minimizada) da última vez: volta assim
      const docked = BS.layout && BS.layout.remembered('bb:' + def.id);
      if (docked && !def.panel) setTimeout(() => dockTo(def.id, docked), 0);
      else if (remembered[def.id] === 'open') setTimeout(() => open(def.id), 0);
      else if (remembered[def.id] === 'min') { w.state = 'min'; renderMenu(); }
      delete remembered[def.id];
      return def;
    },
    unregister(id) {
      const w = W.get(id); if (!w) return;
      if (w.state === 'open' || w.state === 'docked') call(id, 'hide');
      $('#' + CSS.escape(wrapId(id)))?.remove();
      w.el.remove(); W.delete(id); D.delete(id); badges.delete(id);
      renderMenu();
    },
    open, minimize, close, toggle, maximize, dockTo, undock,
    // o layout (dock.js) pergunta se um painel é uma janela do balão e onde ela está
    owns: (pid) => !!bubbleOf(pid),
    sideOf(pid) { const id = bubbleOf(pid); if (!id) return null; const w = W.get(id); return isDocked(w) ? w.side : 'float'; },
    isOpen: (id) => { const w = W.get(id); return !!w && (w.state === 'open' || w.state === 'docked'); },
    windowOf: (id) => { const w = W.get(id); if (!w) return null; return w.state === 'docked' ? $('#' + CSS.escape(wrapId(id))) : w.el; },
    badge(id, v) { if (v == null || v === false) badges.delete(id); else badges.set(id, v); renderMenu(); },
    // item "criando…" na lista enquanto alguém monta uma janela nova; remove() tira
    placeholder(text) {
      const g = document.createElement('div'); g.className = 'bb-item bb-ghost';
      g.innerHTML = `<span class="bb-iic">${TOOL}</span><span class="bb-it"><b>${esc(text || 'criando…')}</b><small>criando…</small></span>`;
      ghosts.add(g); listEl.appendChild(g); paintBadge();
      const rm = g.remove.bind(g); g.remove = () => { ghosts.delete(g); rm(); paintBadge(); };
      return g;
    },
    get button() { return btn; }, get menu() { return menu; },
  };
  const b = bubbleXY(); placeBubble(b.x, b.y);
})();
