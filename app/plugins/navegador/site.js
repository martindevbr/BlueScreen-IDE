// Nó "Automatizar site" do Automator: abre o Edge (ou o Chrome) num perfil próprio e segue os passos do nó.
// Fala com o navegador pelo protocolo de depuração (CDP), sem dependências: precisa do Node.js 22 ou mais novo.
// Entrada (stdin): { params, input, data, secrets }. Saída (stdout): { url, title, values }.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const die = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };
const readStdin = () => new Promise(r => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s)); });

function findBrowser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const names = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const n of names) for (const r of roots) { const p = path.join(r, n); if (fs.existsSync(p)) return p; }
  return null;
}

// Procura o elemento na página. "texto=Entrar" acha pelo texto visível (botões e links primeiro); o resto é seletor CSS.
const FIND = `(sel) => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const m = /^texto\\s*=\\s*(.+)$/i.exec(sel);
  if (!m) { const list = [...document.querySelectorAll(sel)]; return list.find(seen) || list[0] || null; }
  const want = m[1].trim().toLowerCase();
  const label = (e) => [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title'), e.getAttribute('name')].filter(x => typeof x === 'string').map(x => x.trim().toLowerCase());
  const groups = ['button, a, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], [role=menuitem]', 'input, textarea, select, label, summary', 'h1, h2, h3, h4, li, td, th, span, p, div'];
  for (const exact of [true, false]) for (const g of groups) {
    const hit = [...document.querySelectorAll(g)].filter(seen).filter(e => label(e).some(t => exact ? t === want : t.includes(want)));
    if (hit.length) return hit.sort((a, b) => a.innerText.length - b.innerText.length)[0];
  }
  return null;
}`;
const KEYS = { enter: ['Enter', 13, '\r'], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27], backspace: ['Backspace', 8], delete: ['Delete', 46], espaco: [' ', 32, ' '], 'espaço': [' ', 32, ' '], space: [' ', 32, ' '],
  arrowdown: ['ArrowDown', 40], arrowup: ['ArrowUp', 38], arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39], baixo: ['ArrowDown', 40], cima: ['ArrowUp', 38], pagedown: ['PageDown', 34], pageup: ['PageUp', 33], home: ['Home', 36], end: ['End', 35] };
const ACTION = { goto: 'Ir para', click: 'Clicar', type: 'Digitar', wait: 'Esperar aparecer', read: 'Ler texto', key: 'Apertar tecla', sleep: 'Esperar', shot: 'Capturar tela', select: 'Escolher opção' };

async function main() {
  if (typeof WebSocket === 'undefined') die('Este nó precisa do Node.js 22 ou mais novo (o instalado é ' + process.version + ').');
  const req = JSON.parse(await readStdin());
  const p = req.params || {};
  // {{vault:nome}}: o valor chega numa variável de ambiente, e só se o cofre liberou para este plugin
  const secret = (v) => String(v ?? '').replace(/\{\{vault:[^}]+\}\}/g, (m) => {
    const name = (req.secrets || {})[m];
    if (!name || process.env[name] == null) die(`O cofre não entregou ${m}. Libere esse segredo para o plugin Navegador e para o programa node.`);
    return process.env[name];
  });
  const stepTimeout = Math.max(1, Math.min(300, Number(p.wait_s) || 15)) * 1000;
  const steps = (Array.isArray(p.steps) ? p.steps : []).filter(s => s && s.do);
  const url = String(p.url || '').trim();
  if (!url && !steps.length) die('Informe o endereço do site ou pelo menos um passo.');

  const exe = findBrowser();
  if (!exe) die('Não achei o Microsoft Edge nem o Google Chrome neste PC.');
  const profile = path.join(req.data || os.tmpdir(), p.show === 'no' ? 'perfil-oculto' : 'perfil');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const alive = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
  const portOf = () => { try { return parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10) || 0; } catch { return 0; } };

  // janela deixada aberta por uma execução anterior: aproveita (o perfil só aceita um navegador por vez)
  let port = portOf(), child = null;
  if (!port || !(await alive(port))) {
    try { fs.rmSync(portFile, { force: true }); } catch {}
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,900'];
    if (p.show === 'no') args.push('--headless=new');
    args.push('about:blank');
    child = spawn(exe, args, { stdio: 'ignore', detached: true });
    child.unref();
    for (let i = 0; i < 100 && !(port = portOf()); i++) await sleep(150);
    if (!port || !(await alive(port))) die('O navegador não abriu a porta de controle. Feche as janelas dele abertas por este nó e tente de novo.');
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('não deu para falar com o navegador')); });
  let seq = 0; const waiting = new Map(), listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const { ok, no } = waiting.get(m.id); waiting.delete(m.id); m.error ? no(new Error(m.error.message)) : ok(m.result); }
    else if (m.method) for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, { ok, no }); ws.send(JSON.stringify({ id, method, params })); });
  const once = (method, ms) => new Promise((ok) => { const fn = (m) => { if (m.method === method) { listeners.delete(fn); ok(true); } }; listeners.add(fn); setTimeout(() => { listeners.delete(fn); ok(false); }, ms); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'erro na página');
    return r.result.value;
  };
  const call = (sel, body) => evaluate(`(() => { const el = (${FIND})(${JSON.stringify(sel)}); if (!el) return { missing: true }; ${body} })()`);
  const goto = async (to) => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(to)) to = 'https://' + to;
    const loaded = once('Page.loadEventFired', 30000);
    const r = await send('Page.navigate', { url: to });
    if (r.errorText) throw new Error(`o endereço não abriu (${r.errorText})`);
    await loaded;
  };
  // espera o elemento aparecer; a página pode trocar no meio (um clique que navega), então erro de contexto é só "ainda não"
  const waitFor = async (sel) => {
    if (!sel) throw new Error('diga onde (um seletor, ou texto=...)');
    const end = Date.now() + stepTimeout;
    for (;;) {
      try { const r = await call(sel, `const b = el.getBoundingClientRect(); return { ok: b.width > 0 && b.height > 0 };`); if (r && r.ok) return; } catch {}
      if (Date.now() > end) throw new Error(`não apareceu em ${stepTimeout / 1000} s`);
      await sleep(200);
    }
  };
  const settle = async () => { await sleep(350); for (let i = 0; i < 40; i++) { try { if (await evaluate('document.readyState') !== 'loading') return; } catch {} await sleep(150); } };

  const values = {};
  let failure = null;
  const finish = async (keep) => {
    if (!keep) { try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch {} try { ws.close(); } catch {} if (child) { try { process.kill(child.pid); } catch {} } }
    else { try { ws.close(); } catch {} }
  };
  try {
    await send('Page.enable'); await send('Runtime.enable');
    try { await send('Page.bringToFront'); } catch {}
    if (url) await goto(secret(url));
    let n = 0;
    for (const s of steps) {
      n++;
      const where = String(s.on || '').trim(), value = String(s.value ?? '');
      try {
        if (s.do === 'goto') await goto(secret(value || where));
        else if (s.do === 'sleep') await sleep(Math.max(0, Math.min(600, Number(String(value || where).replace(',', '.')) || 1)) * 1000);
        else if (s.do === 'key') {
          const k = KEYS[(value || where).trim().toLowerCase()];
          if (!k) throw new Error(`tecla desconhecida: ${value || where} (use Enter, Tab, Escape, Espaço, setas...)`);
          const ev = { key: k[0], code: k[0] === ' ' ? 'Space' : k[0], windowsVirtualKeyCode: k[1], nativeVirtualKeyCode: k[1], ...(k[2] ? { text: k[2] } : {}) };
          await send('Input.dispatchKeyEvent', { type: k[2] ? 'keyDown' : 'rawKeyDown', ...ev });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
          await settle();
        } else if (s.do === 'shot') {
          const file = value || where;
          if (!file) throw new Error('diga em que arquivo gravar a imagem');
          const r = await send('Page.captureScreenshot', { format: 'png' });
          fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
          fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
          values[`imagem${n}`] = path.resolve(file);
        } else {
          await waitFor(where);
          if (s.do === 'click') { await call(where, `el.scrollIntoView({ block: 'center' }); el.click(); return {};`); await settle(); }
          else if (s.do === 'type') {
            // limpa pelo setter nativo (React e afins percebem) e digita como o teclado faria
            await call(where, `el.scrollIntoView({ block: 'center' }); el.focus(); if ('value' in el) { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d && d.set ? d.set.call(el, '') : (el.value = ''); el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) el.textContent = ''; return {};`);
            await send('Input.insertText', { text: secret(value) });
          } else if (s.do === 'select') {
            const r = await call(where, `const want = ${JSON.stringify(value.trim().toLowerCase())}; const o = [...(el.options || [])].find(o => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want); if (!o) return { none: true }; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return {};`);
            if (r && r.none) throw new Error(`a lista não tem a opção "${value}"`);
          } else if (s.do === 'read') {
            const r = await call(where, `return { text: String('value' in el && el.value !== undefined && el.tagName !== 'LI' ? el.value : el.innerText || el.textContent || '').trim() };`);
            values[value.trim() || `texto${n}`] = r.text;
          } else if (s.do !== 'wait') throw new Error('ação desconhecida: ' + s.do);
        }
      } catch (e) {
        throw new Error(`passo ${n} (${ACTION[s.do] || s.do}${where ? ' "' + where + '"' : ''}): ${e.message}`);
      }
    }
    await settle();
    const info = await evaluate('({ url: location.href, title: document.title })').catch(() => ({}));
    await finish(p.after === 'keep' && p.show !== 'no');
    process.stdout.write(JSON.stringify({ url: info.url || '', title: info.title || '', values }));
  } catch (e) {
    failure = e;
    // falhou: a janela visível fica aberta, para dar para ver onde parou
    await finish(p.show !== 'no');
  }
  if (failure) die(failure.message);
  process.exit(0);
}
main().catch(e => die(e.message));
