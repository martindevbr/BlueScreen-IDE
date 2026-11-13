// O gravador de passos do nó Navegador. Roda dentro da página (em toda navegação): uma barra flutuante mostra que
// está gravando e troca o modo do próximo clique: gravar a ação, ler um campo (devolver o texto dele) ou conferir o
// texto que está ali. Cada passo vai para o núcleo pela função bsRec (browser.rs). É a mesma função do site.js do
// plugin Navegador.
function REC() {
  if (window.top !== window || window.__bsRec) return; window.__bsRec = true;
  const say = (s) => { try { window.bsRec(JSON.stringify(s)); } catch (e) { /* o gravador saiu */ } };
  let mode = 'rec', pending = null, lastTyped = null;
  const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const stable = (id) => !!id && !/\d{4,}|^[0-9a-f-]{16,}$|^:r|^ember|^react|^mui-|^radix-/i.test(id);
  // o jeito mais firme de achar o elemento de novo: id, atributos de teste, nome, texto do botão, rótulo; por último, o caminho
  function selectorOf(el) {
    if (stable(el.id) && uniq('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id']) { const v = el.getAttribute(a); if (v && uniq('[' + a + '="' + q(v) + '"]')) return '[' + a + '="' + q(v) + '"]'; }
    const tag = el.tagName.toLowerCase(), by = (a) => { const v = el.getAttribute(a); const s = v ? tag + '[' + a + '="' + q(v) + '"]' : ''; return s && uniq(s) ? s : ''; };
    const txt = (el.innerText || (/^(submit|button)$/.test(el.type) ? el.value : '') || '').trim().replace(/\s+/g, ' ');
    if (by('name')) return by('name');
    if ((/^(button|a|summary)$/.test(tag) || /^(button|link|tab|menuitem)$/.test(el.getAttribute('role') || '') || /^(submit|button)$/.test(el.type)) && txt && txt.length <= 40) return 'texto=' + txt;
    if (by('aria-label')) return by('aria-label');
    if (by('placeholder')) return by('placeholder');
    for (const c of Array.prototype.slice.call(el.classList || [])) { if (/^[a-z][\w-]*$/i.test(c) && !/\d{3,}/.test(c) && uniq(tag + '.' + c)) return tag + '.' + c; }
    const parts = []; let e = el;
    while (e && e.nodeType === 1 && e !== document.documentElement && parts.length < 6) {
      if (stable(e.id) && uniq('#' + CSS.escape(e.id))) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase(); const sib = e.parentElement ? Array.prototype.filter.call(e.parentElement.children, (x) => x.tagName === e.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(p);
      if (uniq(parts.join(' > '))) break;
      e = e.parentElement;
    }
    return parts.join(' > ');
  }
  const textOf = (el) => String('value' in el && el.value !== undefined && el.tagName !== 'LI' ? el.value : el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const isField = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(submit|button|checkbox|radio|file|image|reset|range|color)$/.test(el.type)) || el.isContentEditable);

  // barra (em shadow DOM, para o CSS do site não mexer nela)
  const host = document.createElement('div'); host.id = 'bs-rec-bar';
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
    '<span class="tools"><button data-m="read" title="Clique depois no texto ou campo que o teste deve devolver">Ler campo</button><button data-m="check" title="Clique depois no texto que deve continuar aparecendo">Conferir</button><button data-m="pause" title="Usar o site sem gravar">Pausar</button></span>' +
    '<form><span class="hint">Nome do campo:</span><input maxlength="40" placeholder="saldo"><button type="submit" class="on">OK</button></form>' +
    '<button class="end" data-m="end" title="Fecha o navegador e leva os passos para o Automator">Concluir</button><button data-m="move" title="Levar a barra para o outro lado da tela">⇅</button></div>';
  const bar = sh.querySelector('.bar'), st = sh.querySelector('.st'), form = sh.querySelector('form'), name = sh.querySelector('input');
  const box = document.createElement('div');
  box.style.cssText = 'all:initial;position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4c8dff;background:#4c8dff22;border-radius:4px;display:none;';
  const mount = () => { if (!document.documentElement) return; if (!host.isConnected) document.documentElement.appendChild(host); if (!box.isConnected) document.documentElement.appendChild(box); };
  mount(); document.addEventListener('DOMContentLoaded', mount); setInterval(mount, 1500);
  let low = false;
  const place = (down) => { low = down; host.style.top = down ? 'auto' : '10px'; host.style.bottom = down ? '10px' : 'auto'; try { sessionStorage.setItem('bsRecLow', down ? '1' : ''); } catch (e) { /* página sem armazenamento */ } };
  try { if (sessionStorage.getItem('bsRecLow')) place(true); } catch (e) { /* idem */ }
  const LABEL = { rec: 'Gravando', read: 'Clique no campo para ler', check: 'Clique no texto para conferir', pause: 'Pausado' };
  function setMode(m) {
    mode = m; st.textContent = LABEL[m]; bar.classList.toggle('pause', m === 'pause'); bar.classList.remove('ask'); box.style.display = 'none';
    sh.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    sh.querySelector('[data-m=pause]').textContent = m === 'pause' ? 'Continuar' : 'Pausar';
  }
  window.__bsRecCount = (n) => { sh.querySelector('.n').textContent = n + (n === 1 ? ' passo' : ' passos'); };
  sh.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    if (b.dataset.m === 'end') return say({ done: true });
    if (b.dataset.m === 'move') { place(!low); return; }
    setMode(mode === b.dataset.m ? 'rec' : b.dataset.m);
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (pending) say({ do: 'read', on: pending, value: name.value.trim() || 'campo' }); pending = null; name.value = ''; setMode('rec'); });
  const mine = (e) => e.composedPath && e.composedPath().indexOf(host) >= 0;
  const flushTyped = (el) => {
    if (!isField(el) || el.tagName === 'SELECT') return;
    const v = el.isContentEditable ? el.innerText : el.value, on = selectorOf(el);
    if (lastTyped && lastTyped[0] === on && lastTyped[1] === v) return;
    lastTyped = [on, v];
    // senha nunca vai para o fluxo: fica a referência do Cofre, para a pessoa guardar o valor lá
    say({ do: 'type', on: on, value: el.type === 'password' ? '{{cred:senha}}' : v });
  };
  document.addEventListener('mousemove', (e) => {
    if (mode !== 'read' && mode !== 'check') return;
    const el = e.target; if (!el || mine(e) || !el.getBoundingClientRect) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect(); box.style.display = 'block'; box.style.left = r.left - 2 + 'px'; box.style.top = r.top - 2 + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }, true);
  document.addEventListener('click', (e) => {
    if (mine(e) || mode === 'pause' || !e.isTrusted) return;
    const raw = e.target;
    if (mode === 'read' || mode === 'check') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (raw === document.body || raw === document.documentElement) return;
      const on = selectorOf(raw);
      if (mode === 'read') { pending = on; bar.classList.add('ask'); box.style.display = 'none'; setTimeout(() => name.focus(), 30); mode = 'ask'; }
      else { const t = textOf(raw).slice(0, 80); say(t ? { do: 'text', on: on, value: t } : { do: 'see', on: on }); setMode('rec'); }
      return;
    }
    if (mode !== 'rec') return;
    const el = raw.closest('button, a, [role=button], [role=link], [role=tab], [role=menuitem], input, select, textarea, label, summary, [onclick]') || raw;
    if (el === document.body || el === document.documentElement) return; // clique no fundo da página não é um passo
    if (isField(el)) return; // o que foi digitado entra quando o campo perde o foco
    if (el.tagName === 'LABEL' && el.control) return; // o clique no rótulo vira o clique no campo dele
    say({ do: 'click', on: selectorOf(el) });
  }, true);
  document.addEventListener('change', (e) => {
    if (mine(e) || mode !== 'rec') return;
    const el = e.target;
    if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; say({ do: 'select', on: selectorOf(el), value: o ? o.text.trim() : el.value }); }
    else flushTyped(el);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (mine(e) || mode !== 'rec' || e.key !== 'Enter' || !isField(e.target) || e.target.tagName === 'TEXTAREA') return;
    flushTyped(e.target); say({ do: 'key', value: 'Enter' });
  }, true);
}
