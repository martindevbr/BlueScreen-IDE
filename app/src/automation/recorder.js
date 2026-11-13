// O gravador de passos do nó Navegador. Roda dentro da página (em toda navegação): uma barra flutuante mostra que
// está gravando e troca o modo do próximo clique: gravar a ação, ler um campo (devolver o texto dele), ler uma tabela
// ou conferir o texto que está ali. Cada passo vai para o núcleo pela função bsRec (browser.rs). Os quadros (iframes)
// da mesma origem gravam junto: a barra fica só na página de fora e o modo é um só para todos.
function REC() {
  if (window.__bsRec) return;
  const TOP = window.top === window;
  // o estado é da página de fora; um quadro de outra origem não o alcança e fica sem gravar (o motor também não entra nele)
  let S;
  if (TOP) S = window.__bsRecS = { mode: 'rec', pages: 0 };
  else { try { S = window.top.__bsRecS; } catch (e) { return; } if (!S) return; }
  window.__bsRec = true;
  const say = (s) => { try { (window.bsRec || window.top.bsRec)(JSON.stringify(s)); } catch (e) { /* o gravador saiu */ } };
  let lastTyped = null;
  const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const rootOf = (el) => (el.getRootNode && el.getRootNode()) || document;
  const uniq = (sel, root) => { try { return (root || document).querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  // id que o site gera sozinho (muda a cada visita) não serve para achar o elemento de novo
  const stable = (id) => !!id && !/\d{4,}|^[0-9a-f-]{16,}$|^:r|^«|^_r_|^ember|^react|^mui-|^radix-|^headlessui-|[-_:]\d+$/i.test(id);
  const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  // um seletor gravado dentro de um quadro não pode casar também com a página de fora (o motor olha ela primeiro)
  const clash = (s) => { if (TOP) return false; try { return !!window.top.document.querySelector(s); } catch (e) { return false; } };
  const one = (s, root) => uniq(s, root) && !clash(s);
  // o mesmo critério do motor para "texto=...": só vale gravar pelo texto se ele for achar este elemento de novo
  const GROUPS = ['button, a, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=treeitem]', 'input, textarea, select, label, summary', 'h1, h2, h3, h4, li, td, th, span, p, div'];
  const labels = (e) => [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title'), e.getAttribute('name')].filter((x) => typeof x === 'string').map((x) => norm(x).toLowerCase());
  function byText(el, root) {
    const t = norm(el.innerText || (/^(submit|button)$/.test(el.type) ? el.value : '')); if (!t || t.length > 40) return '';
    const want = t.toLowerCase();
    for (const g of GROUPS) {
      let hit; try { hit = Array.prototype.filter.call(root.querySelectorAll(g), (e) => (e.textContent || '').length < 400 && labels(e).indexOf(want) >= 0 && seen(e)); } catch (e) { return ''; }
      if (hit.length) { const first = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o))).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]; return first === el || first.contains(el) || el.contains(first) ? 'texto=' + t : ''; }
    }
    return '';
  }
  // classe gerada (muda a cada versão do site) ou de estado (muda conforme o uso) não serve
  const hashy = (c) => /^(css|sc|jss|emotion|styled|tw)-/i.test(c) || /^(is|has)-|^(active|selected|open|focus|focused|hover|disabled|checked)$/i.test(c) || c.split(/[-_]+/).some((p) => p.length >= 4 && /\d/.test(p) && /[a-z]/i.test(p));
  // o jeito mais firme de achar o elemento de novo: id, atributos de teste, nome, o texto que aparece, rótulo; por último, o
  // caminho. `value`: o elemento é um valor que muda (um campo lido), então o texto dele não serve para achá-lo.
  const TEST = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id', 'data-dtname', 'data-dt-name'];
  function selectorOf(el, value) {
    const root = rootOf(el);
    if (stable(el.id) && one('#' + CSS.escape(el.id), root)) return '#' + CSS.escape(el.id);
    for (const a of TEST) { const v = el.getAttribute(a); if (v && one('[' + a + '="' + q(v) + '"]', root)) return '[' + a + '="' + q(v) + '"]'; }
    const tag = el.tagName.toLowerCase(), by = (a) => { const v = el.getAttribute(a); const s = v ? tag + '[' + a + '="' + q(v) + '"]' : ''; return s && one(s, root) ? s : ''; };
    const txt = norm(el.innerText || (/^(submit|button)$/.test(el.type) ? el.value : ''));
    if (by('name')) return by('name');
    // texto com contador ("Problemas 3") muda de um dia para o outro: o nome acessível dura mais
    if (/\d/.test(txt) && by('aria-label')) return by('aria-label');
    if (!value && (/^(button|a|summary)$/.test(tag) || /^(button|link|tab|menuitem|option|checkbox|switch|treeitem)$/.test(el.getAttribute('role') || '') || /^(submit|button)$/.test(el.type)) && txt && txt.length <= 40) { const t = byText(el, root); if (t) return t; }
    if (by('aria-label')) return by('aria-label');
    if (by('placeholder')) return by('placeholder');
    // sites feitos em React e afins trocam as classes a cada versão: o texto da tela dura mais
    if (!value && el.children.length <= 3) { const t = byText(el, root); if (t) return t; }
    for (const c of Array.prototype.slice.call(el.classList || [])) { if (/^[a-z][\w-]*$/i.test(c) && !hashy(c) && one(tag + '.' + CSS.escape(c), root)) return tag + '.' + CSS.escape(c); }
    const parts = []; let e = el;
    while (e && e.nodeType === 1 && e !== document.documentElement && parts.length < 6) {
      if (stable(e.id) && uniq('#' + CSS.escape(e.id), root)) { parts.unshift('#' + CSS.escape(e.id)); break; }
      // um ancestral com atributo firme ancora o caminho
      const a = e !== el && TEST.concat('aria-label').find((x) => e.getAttribute(x) && uniq('[' + x + '="' + q(e.getAttribute(x)) + '"]', root));
      if (a) { parts.unshift('[' + a + '="' + q(e.getAttribute(a)) + '"]'); break; }
      let p = e.tagName.toLowerCase(); const sib = e.parentElement ? Array.prototype.filter.call(e.parentElement.children, (x) => x.tagName === e.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(p);
      if (one(parts.join(' > '), root)) break;
      e = e.parentElement;
    }
    return parts.join(' > ');
  }
  // "rotulo=Tempo de resposta": o valor que fica ao lado de um texto fixo da tela. É a mesma busca do motor (browser.rs).
  const near = (want, root) => {
    const n = (t) => String(t || '').trim().replace(/\s+/g, ' ').replace(/:$/, '').toLowerCase(); want = n(want);
    const leaf = (e) => !Array.prototype.some.call(e.children, (c) => (c.innerText || '').trim());
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const L of root.querySelectorAll('label,dt,th,td,span,div,p,strong,b,h3,h4,h5,h6')) {
      if ((L.textContent || '').length > 200 || !leaf(L) || n(L.innerText) !== want || !vis(L)) continue;
      if (L.htmlFor && root.getElementById && root.getElementById(L.htmlFor)) return root.getElementById(L.htmlFor);
      if (L.id) { const x = root.querySelector('[aria-labelledby~="' + CSS.escape(L.id) + '"]'); if (x) return x; }
      for (let A = L.parentElement, up = 0; A && up < 4; A = A.parentElement, up++)
        for (const e of A.querySelectorAll('*'))
          if ((L.compareDocumentPosition(e) & 4) && !L.contains(e) && vis(e) && (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) || (leaf(e) && n(e.innerText) && n(e.innerText) !== want))) return e;
    }
    return null;
  };
  // o rótulo que leva de volta a este valor, se houver um por perto
  function labelOf(el) {
    const root = rootOf(el), ok = (t) => { const v = near(t, root); return v && (v === el || v.contains(el) || el.contains(v)); };
    const c = [];
    (el.getAttribute('aria-labelledby') || '').split(/\s+/).forEach((id) => { const x = id && root.getElementById && root.getElementById(id); if (x) c.push(x.innerText); });
    if (el.labels && el.labels[0]) c.push(el.labels[0].innerText);
    for (let A = el.parentElement, up = 0; A && up < 4; A = A.parentElement, up++)
      Array.prototype.filter.call(A.querySelectorAll('*'), (e) => (e.compareDocumentPosition(el) & 4) && !e.contains(el)).reverse().slice(0, 6).forEach((e) => c.push(e.innerText));
    for (const t of c.map(norm)) if (t && t.length <= 40 && !/^[\d\s.,:%$R-]+$/.test(t) && ok(t)) return 'rotulo=' + t.replace(/:$/, '');
    return '';
  }
  const textOf = (el) => norm(/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.value : el.innerText || el.textContent || '');
  const isField = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(submit|button|checkbox|radio|file|image|reset|range|color)$/.test(el.type)) || el.isContentEditable);
  // campo de senha, mesmo com o "mostrar senha" ligado: o valor nunca sai da página
  const secret = (el) => el.type === 'password' || /pass|senha|pin\b|otp|token|cvv/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || ''));
  // o elemento de verdade, mesmo dentro de um componente (shadow DOM)
  const real = (e) => (e.composedPath && e.composedPath()[0] && e.composedPath()[0].nodeType === 1 ? e.composedPath()[0] : e.target);

  const box = document.createElement('div');
  box.style.cssText = 'all:initial;position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4c8dff;background:#4c8dff22;border-radius:4px;display:none;';
  let host = null;
  if (TOP) {
    // barra (em shadow DOM, para o CSS do site não mexer nela)
    host = document.createElement('div'); host.id = 'bs-rec-bar';
    host.style.cssText = 'all:initial;position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = '<style>' +
      '.bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:12px;background:#14161cf2;color:#e6e8ee;font:13px "Segoe UI",system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 1px #ffffff22;user-select:none;white-space:nowrap}' +
      '.dot{width:10px;height:10px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 0 #e5484d99;animation:p 1.4s infinite}.bar.pause .dot{background:#8a92a3;animation:none}@keyframes p{70%{box-shadow:0 0 0 7px #e5484d00}100%{box-shadow:0 0 0 0 #e5484d00}}' +
      '.st{padding:0 6px 0 2px;font-weight:600}.n{color:#8a92a3;padding-right:4px;font-variant-numeric:tabular-nums}' +
      'button{all:unset;cursor:pointer;padding:5px 10px;border-radius:8px;background:#ffffff14;font:inherit}button:hover{background:#ffffff26}button.on{background:#4c8dff;color:#fff}button.end{background:#2ea66b;color:#fff;font-weight:600}' +
      'form{display:none;align-items:center;gap:6px}.ask form{display:flex}.ask .tools{display:none}.tools{display:flex;gap:6px}' +
      'input{all:unset;width:150px;padding:5px 8px;border-radius:8px;background:#fff;color:#111;font:inherit}.hint{color:#b4bac6;font-size:12px;padding:0 4px}</style>' +
      '<div class="bar"><span class="dot"></span><span class="st">Gravando</span><span class="n">0 passos</span>' +
      '<span class="tools"><button data-m="read" title="Clique depois no texto ou campo que o fluxo deve devolver">Ler campo</button><button data-m="table" title="Clique depois numa tabela: o fluxo recebe uma linha por item">Ler tabela</button><button data-m="page" title="Guarda tudo o que está escrito na página, para tratar depois ou mandar a uma IA">Ler a página</button><button data-m="check" title="Clique depois no texto que deve continuar aparecendo">Conferir</button><button data-m="pause" title="Usar o site sem gravar">Pausar</button></span>' +
      '<form><span class="hint">Nome do campo:</span><input maxlength="40" placeholder="saldo"><button type="submit" class="on">OK</button></form>' +
      '<button class="end" data-m="end" title="Fecha o navegador e leva os passos para o Automator">Concluir</button><button data-m="move" title="Levar a barra para o outro lado da tela">⇅</button></div>';
    const bar = sh.querySelector('.bar'), st = sh.querySelector('.st'), form = sh.querySelector('form'), name = sh.querySelector('input');
    const mount = () => { if (!document.documentElement) return; if (!host.isConnected) document.documentElement.appendChild(host); if (!box.isConnected) document.documentElement.appendChild(box); };
    mount(); document.addEventListener('DOMContentLoaded', mount); setInterval(mount, 1500);
    let low = false, pending = null;
    const place = (down) => { low = down; host.style.top = down ? 'auto' : '10px'; host.style.bottom = down ? '10px' : 'auto'; try { sessionStorage.setItem('bsRecLow', down ? '1' : ''); } catch (e) { /* página sem armazenamento */ } };
    try { if (sessionStorage.getItem('bsRecLow')) place(true); } catch (e) { /* idem */ }
    const LABEL = { rec: 'Gravando', read: 'Clique no campo para ler', table: 'Clique na tabela para ler', check: 'Clique no texto para conferir', pause: 'Pausado' };
    S.set = (m) => {
      S.mode = m; st.textContent = LABEL[m]; bar.classList.toggle('pause', m === 'pause'); bar.classList.remove('ask'); box.style.display = 'none';
      sh.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      sh.querySelector('[data-m=pause]').textContent = m === 'pause' ? 'Continuar' : 'Pausar';
    };
    // um quadro de dentro pede o nome do campo lido: a pergunta aparece na barra, aqui fora
    S.ask = (on) => { pending = on; bar.classList.add('ask'); box.style.display = 'none'; setTimeout(() => name.focus(), 30); S.mode = 'ask'; };
    S.note = (t) => { st.textContent = t; };
    window.__bsRecCount = (n) => { sh.querySelector('.n').textContent = n + (n === 1 ? ' passo' : ' passos'); };
    sh.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]'); if (!b) return;
      if (b.dataset.m === 'end') return say({ done: true });
      if (b.dataset.m === 'move') { place(!low); return; }
      if (b.dataset.m === 'page') { S.pages++; say({ do: 'page', on: '', value: S.pages > 1 ? 'pagina' + S.pages : 'pagina' }); S.set('rec'); S.note('Página guardada'); setTimeout(() => { if (S.mode === 'rec') S.note(LABEL.rec); }, 1500); return; }
      S.set(S.mode === b.dataset.m ? 'rec' : b.dataset.m);
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); if (pending) say({ do: 'read', on: pending, value: name.value.trim() || 'campo' }); pending = null; name.value = ''; S.set('rec'); });
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { pending = null; name.value = ''; S.set('rec'); } });
  } else {
    const mount = () => { if (document.documentElement && !box.isConnected) document.documentElement.appendChild(box); };
    mount(); document.addEventListener('DOMContentLoaded', mount); setInterval(mount, 1500);
  }
  const mine = (e) => !!host && e.composedPath && e.composedPath().indexOf(host) >= 0;
  const picking = () => S.mode === 'read' || S.mode === 'check' || S.mode === 'table';
  const TABLE = 'table, [role=grid], [role=table], [role=treegrid]';
  const flushTyped = (el) => {
    if (!isField(el) || el.tagName === 'SELECT') return;
    const v = el.isContentEditable ? el.innerText : el.value, on = selectorOf(el, true);
    if (lastTyped && lastTyped[0] === on && lastTyped[1] === v) return;
    lastTyped = [on, v];
    // senha nunca vai para o fluxo: fica a referência da credencial, para a pessoa guardar o valor lá
    say({ do: 'type', on: on, value: secret(el) ? '{{cred:senha}}' : v });
  };
  document.addEventListener('mousemove', (e) => {
    if (!picking()) { box.style.display = 'none'; return; }
    let el = real(e); if (!el || mine(e) || !el.getBoundingClientRect) { box.style.display = 'none'; return; }
    if (S.mode === 'table') el = el.closest(TABLE) || el;
    const r = el.getBoundingClientRect(); box.style.display = 'block'; box.style.left = r.left - 2 + 'px'; box.style.top = r.top - 2 + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }, true);
  document.addEventListener('mouseleave', () => { box.style.display = 'none'; }, true);
  document.addEventListener('click', (e) => {
    if (mine(e) || S.mode === 'pause' || !e.isTrusted) return;
    let raw = real(e);
    if (picking()) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      box.style.display = 'none';
      if (raw === document.body || raw === document.documentElement) return;
      if (S.mode === 'table') {
        const t = raw.closest(TABLE);
        if (!t) { S.note('Isso não é uma tabela: clique numa'); return; }
        say({ do: 'table', on: selectorOf(t, true), value: 'tabela' }); S.set('rec'); return;
      }
      if (S.mode === 'read') { S.ask(labelOf(raw) || selectorOf(raw, true)); return; }
      const on = selectorOf(raw, true), t = secret(raw) ? '' : textOf(raw).slice(0, 80);
      say(t ? { do: 'text', on: on, value: t } : { do: 'see', on: on }); S.set('rec');
      return;
    }
    if (S.mode !== 'rec') return;
    // o desenho de um ícone não é o alvo: quem responde ao clique é o que está em volta dele
    const svg = raw.closest && raw.closest('svg'); if (svg && svg.parentElement) raw = svg.parentElement;
    const el = raw.closest('button, a, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=treeitem], input, select, textarea, label, summary, [onclick]') || raw;
    if (el === document.body || el === document.documentElement) return; // clique no fundo da página não é um passo
    if (isField(el)) return; // o que foi digitado entra quando o campo perde o foco
    if (el.tagName === 'LABEL' && el.control) return; // o clique no rótulo vira o clique no campo dele
    if (el.tagName === 'INPUT' && /^(checkbox|radio|file)$/.test(el.type)) return; // esses entram pelo "change", com o estado certo
    say({ do: 'click', on: selectorOf(el) });
    // link que abre em outra aba: o fluxo segue para ela
    if (el.tagName === 'A' && el.target === '_blank') say({ do: 'tab' });
  }, true);
  document.addEventListener('change', (e) => {
    if (mine(e) || S.mode !== 'rec') return;
    const el = real(e);
    if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; say({ do: 'select', on: selectorOf(el, true), value: o ? o.text.trim() : el.value }); }
    else if (el.type === 'checkbox' || el.type === 'radio') say({ do: 'check', on: selectorOf(el, true), value: el.checked ? 'sim' : 'não' });
    else if (el.type === 'file') say({ do: 'upload', on: selectorOf(el, true), value: '' });
    else flushTyped(el);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (mine(e) || S.mode !== 'rec') return;
    const el = real(e);
    if (e.key === 'Escape') { say({ do: 'key', value: 'Escape' }); return; } // fecha uma janela do site: sem ele o próximo clique não alcança
    if (e.key !== 'Enter' || !isField(el) || el.tagName === 'TEXTAREA') return;
    flushTyped(el); say({ do: 'key', value: 'Enter' });
  }, true);
}
