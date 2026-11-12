// Motor dos nós "Automatizar site" e "Testar site" do Automator, e do gravador de passos.
// Abre o Edge (ou o Chrome) num perfil próprio e fala com ele pelo protocolo de depuração (CDP), sem dependências:
// precisa do Node.js 22 ou mais novo.
//   node site.js            roda os passos. Entrada (stdin): { node, params, input, data, secrets }.
//                           "site" devolve { url, title, values }; "test" devolve { port, value: resultado do teste }.
//   node site.js --record   grava: a pessoa usa o site e cada clique, texto digitado, campo lido ou conferência vira
//                           uma linha JSON na saída ({ do, on, value }). A primeira linha da entrada é { params, data }.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'), { spawn } = require('child_process');

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
  const label = (e) => [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title'), e.getAttribute('name')].filter(x => typeof x === 'string').map(x => x.trim().replace(/\\s+/g, ' ').toLowerCase());
  const groups = ['button, a, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], [role=menuitem]', 'input, textarea, select, label, summary', 'h1, h2, h3, h4, li, td, th, span, p, div'];
  for (const exact of [true, false]) for (const g of groups) {
    const hit = [...document.querySelectorAll(g)].filter(seen).filter(e => label(e).some(t => exact ? t === want : t.includes(want)));
    if (hit.length) return hit.sort((a, b) => a.innerText.length - b.innerText.length)[0];
  }
  return null;
}`;
const TEXT_OF = `String('value' in el && el.value !== undefined && el.tagName !== 'LI' ? el.value : el.innerText || el.textContent || '').trim()`;
const KEYS = { enter: ['Enter', 13, '\r'], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27], backspace: ['Backspace', 8], delete: ['Delete', 46], espaco: [' ', 32, ' '], 'espaço': [' ', 32, ' '], space: [' ', 32, ' '],
  arrowdown: ['ArrowDown', 40], arrowup: ['ArrowUp', 38], arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39], baixo: ['ArrowDown', 40], cima: ['ArrowUp', 38], pagedown: ['PageDown', 34], pageup: ['PageUp', 33], home: ['Home', 36], end: ['End', 35] };
const ACTION = { goto: 'Ir para', click: 'Clicar', type: 'Digitar', wait: 'Esperar aparecer', read: 'Ler campo', key: 'Apertar tecla', sleep: 'Esperar', shot: 'Capturar tela', select: 'Escolher opção',
  hover: 'Passar o mouse', see: 'Conferir que aparece', gone: 'Conferir que sumiu', text: 'Conferir texto', url: 'Conferir endereço', title: 'Conferir título', count: 'Conferir quantidade', look: 'Comparar com a referência', a11y: 'Checar acessibilidade' };
const DEVICES = { desktop: [1280, 900, false], wide: [1920, 1080, false], tablet: [820, 1180, true], phone: [390, 844, true] };

// ---------- PNG (para comparar a tela com a imagem de referência, sem dependências) ----------
function pngRead(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('PNG num formato que não sei comparar'); }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error('PNG num formato que não sei comparar');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, data = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0, o = 0; y < h; y++) {
    const f = raw[o++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[o++];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, j = x * bpp; data[i] = cur[j]; data[i + 1] = cur[j + 1]; data[i + 2] = cur[j + 2]; data[i + 3] = bpp === 4 ? cur[j + 3] : 255; }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data };
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function pngWrite(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(type, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Quantos % dos pontos mudaram entre duas telas; devolve também a imagem com as diferenças em vermelho. */
function pngDiff(base, now) {
  const a = pngRead(base), b = pngRead(now);
  if (a.w !== b.w || a.h !== b.h) return { percent: 100, why: `o tamanho mudou: a referência tem ${a.w}x${a.h} e a tela agora tem ${b.w}x${b.h}` };
  const out = Buffer.alloc(a.data.length); let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 32) { diff++; out[i] = 235; out[i + 1] = 40; out[i + 2] = 60; }
    else { const g = 200 + (((b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3) >> 2) - 32; out[i] = out[i + 1] = out[i + 2] = Math.min(255, g); }
    out[i + 3] = 255;
  }
  return { percent: Math.round(diff / (a.w * a.h) * 10000) / 100, image: pngWrite(a.w, a.h, out) };
}

// ---------- navegador ----------
async function openBrowser(data, hidden) {
  if (typeof WebSocket === 'undefined') die('Este nó precisa do Node.js 22 ou mais novo (o instalado é ' + process.version + ').');
  const exe = findBrowser();
  if (!exe) die('Não achei o Microsoft Edge nem o Google Chrome neste PC.');
  const profile = path.join(data || os.tmpdir(), hidden ? 'perfil-oculto' : 'perfil');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const alive = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
  const portOf = () => { try { return parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10) || 0; } catch { return 0; } };
  // janela deixada aberta por uma execução anterior: aproveita (o perfil só aceita um navegador por vez)
  let port = portOf(), child = null;
  if (!port || !(await alive(port))) {
    try { fs.rmSync(portFile, { force: true }); } catch {}
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,900'];
    if (hidden) args.push('--headless=new');
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
  const goto = async (to) => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(to)) to = 'https://' + to;
    const loaded = once('Page.loadEventFired', 30000);
    const r = await send('Page.navigate', { url: to });
    if (r.errorText) throw new Error(`o endereço não abriu (${r.errorText})`);
    await loaded;
  };
  const close = async (keep) => {
    if (!keep) { try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch {} try { ws.close(); } catch {} if (child) { try { process.kill(child.pid); } catch {} } }
    else { try { ws.close(); } catch {} }
  };
  return { ws, send, once, evaluate, goto, close, on: (fn) => listeners.add(fn) };
}

// ---------- rodar os passos ----------
async function run() {
  const req = JSON.parse(await readStdin());
  const p = req.params || {}, test = req.node === 'test';
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
  const hidden = p.show === 'no';
  const B = await openBrowser(req.data, hidden);
  const { send, evaluate, goto } = B;
  const call = (sel, body) => evaluate(`(() => { const el = (${FIND})(${JSON.stringify(sel)}); if (!el) return { missing: true }; ${body} })()`);
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
  // repete a conferência até valer ou o tempo acabar; devolve o que viu por último, para a mensagem
  const until = async (probe, ok) => {
    const end = Date.now() + stepTimeout; let seen;
    for (;;) { try { seen = await probe(); if (ok(seen)) return seen; } catch {} if (Date.now() > end) return { failed: true, seen }; await sleep(200); }
  };
  const settle = async () => { await sleep(350); for (let i = 0; i < 40; i++) { try { if (await evaluate('document.readyState') !== 'loading') return; } catch {} await sleep(150); } };
  const shot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  const has = (hay, needle) => String(hay ?? '').replace(/\s+/g, ' ').toLowerCase().includes(String(needle).replace(/\s+/g, ' ').trim().toLowerCase());

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const evidence = path.join(req.data || os.tmpdir(), 'evidencias', stamp);
  const values = {}, results = [], jsErrors = [], badRequests = [];
  let failure = null;
  const began = Date.now();

  async function doStep(s, n) {
    const where = String(s.on || '').trim(), value = String(s.value ?? '');
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
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, await shot());
      values[`imagem${n}`] = path.resolve(file);
    } else if (s.do === 'url' || s.do === 'title') {
      const want = value || where;
      if (!want) throw new Error('diga o trecho que deve aparecer');
      const r = await until(() => evaluate(s.do === 'url' ? 'location.href' : 'document.title'), (v) => has(v, want));
      if (r && r.failed) throw new Error(`esperava "${want}", mas ${s.do === 'url' ? 'o endereço é' : 'o título é'} "${r.seen ?? ''}"`);
    } else if (s.do === 'gone') {
      if (!where) throw new Error('diga o que deve sumir (um seletor, ou texto=...)');
      const r = await until(() => call(where, `const b = el.getBoundingClientRect(); return { there: b.width > 0 && b.height > 0 };`), (v) => !v || v.missing || !v.there);
      if (r && r.failed) throw new Error(`continua na tela depois de ${stepTimeout / 1000} s`);
    } else if (s.do === 'count') {
      if (/^texto\s*=/i.test(where)) throw new Error('para contar, use um seletor CSS (ex.: .item, table tr)');
      const want = parseInt(value, 10);
      if (!Number.isFinite(want)) throw new Error('diga quantos devem existir (um número)');
      const r = await until(() => evaluate(`document.querySelectorAll(${JSON.stringify(where)}).length`), (v) => v === want);
      if (r && r.failed) throw new Error(`esperava ${want}, mas há ${r.seen ?? 0}`);
    } else if (s.do === 'look') {
      // comparação visual: a primeira execução grava a referência; as seguintes comparam com ela
      const file = path.resolve(value || where || path.join(req.data || os.tmpdir(), 'referencias', `passo-${n}.png`));
      const limit = Math.max(0, Number(String(p.tolerance ?? 0.5).replace(',', '.')) || 0);
      await settle();
      const now = await shot();
      if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, now); values[`referencia${n}`] = file; return 'referência criada'; }
      const d = pngDiff(fs.readFileSync(file), now);
      values[`diferenca${n}`] = d.percent;
      if (d.percent > limit) {
        fs.mkdirSync(evidence, { recursive: true });
        const out = path.join(evidence, `passo-${n}-diferenca.png`);
        fs.writeFileSync(out, d.image || now); fs.writeFileSync(path.join(evidence, `passo-${n}-agora.png`), now);
        const e = new Error(d.why || `a tela mudou ${String(d.percent).replace('.', ',')}% em relação à referência (o limite é ${String(limit).replace('.', ',')}%)`);
        e.shot = out; throw e;
      }
    } else if (s.do === 'a11y') {
      const issues = await evaluate(`(() => {
        const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, out = [], name = (e) => (e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || e.value || (e.querySelector('img[alt]') || {}).alt || '').trim();
        const add = (list, msg) => { const n = list.filter(seen).length; if (n) out.push(n + ' ' + msg); };
        if (!document.documentElement.lang) out.push('a página não diz o idioma (atributo lang)');
        if (!document.title.trim()) out.push('a página não tem título');
        add([...document.querySelectorAll('img:not([alt])')], 'imagem(ns) sem texto alternativo (alt)');
        add([...document.querySelectorAll('button, a[href], [role=button]')].filter(e => !name(e)), 'botão(ões) ou link(s) sem nome');
        add([...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')].filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.getAttribute('title')), 'campo(s) de formulário sem rótulo');
        if (!document.querySelector('h1')) out.push('a página não tem um título principal (h1)');
        return out;
      })()`);
      values[`acessibilidade${n}`] = issues;
      if (issues.length) throw new Error(issues.join('; '));
    } else {
      await waitFor(where);
      if (s.do === 'click') { await call(where, `el.scrollIntoView({ block: 'center' }); el.click(); return {};`); await settle(); }
      else if (s.do === 'hover') {
        const r = await call(where, `el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); await sleep(250);
      } else if (s.do === 'type') {
        // limpa pelo setter nativo (React e afins percebem) e digita como o teclado faria
        await call(where, `el.scrollIntoView({ block: 'center' }); el.focus(); if ('value' in el) { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d && d.set ? d.set.call(el, '') : (el.value = ''); el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) el.textContent = ''; return {};`);
        await send('Input.insertText', { text: secret(value) });
      } else if (s.do === 'select') {
        const r = await call(where, `const want = ${JSON.stringify(value.trim().toLowerCase())}; const o = [...(el.options || [])].find(o => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want); if (!o) return { none: true }; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return {};`);
        if (r && r.none) throw new Error(`a lista não tem a opção "${value}"`);
      } else if (s.do === 'read') {
        const r = await call(where, `return { text: ${TEXT_OF} };`);
        values[value.trim() || `texto${n}`] = r.text;
      } else if (s.do === 'text') {
        if (!value.trim()) throw new Error('diga o texto que deve aparecer ali');
        const r = await until(() => call(where, `return { text: ${TEXT_OF} };`), (v) => v && has(v.text, secret(value)));
        if (r && r.failed) throw new Error(`esperava "${value}", mas está "${String(r.seen?.text ?? '').slice(0, 200)}"`);
      } else if (s.do !== 'wait' && s.do !== 'see') throw new Error('ação desconhecida: ' + s.do);
    }
  }

  try {
    await send('Page.enable'); await send('Runtime.enable');
    if (test) {
      // erros de JavaScript e pedidos que falharam, para o relatório
      await send('Network.enable').catch(() => {});
      B.on((m) => {
        if (m.method === 'Runtime.exceptionThrown') jsErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'erro').split('\n')[0].slice(0, 300));
        else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400 && badRequests.length < 30) badRequests.push({ status: m.params.response.status, url: m.params.response.url.slice(0, 300) });
      });
    }
    const dev = DEVICES[p.device];
    if (dev && p.device !== 'desktop') await send('Emulation.setDeviceMetricsOverride', { width: dev[0], height: dev[1], deviceScaleFactor: dev[2] ? 2 : 1, mobile: dev[2] }).catch(() => {});
    try { await send('Page.bringToFront'); } catch {}
    if (url) {
      const t = Date.now();
      try { await goto(secret(url)); if (test) results.push({ n: 0, do: 'goto', name: 'Abrir o site', on: url, ok: true, ms: Date.now() - t }); }
      catch (e) { if (!test) throw e; results.push({ n: 0, do: 'goto', name: 'Abrir o site', on: url, ok: false, ms: Date.now() - t, error: e.message }); failure = e; }
    }
    let n = 0, stopped = !!failure;
    for (const s of steps) {
      n++;
      const where = String(s.on || '').trim(), row = { n, do: s.do, name: ACTION[s.do] || s.do, on: where, value: String(s.value ?? '') };
      if (stopped) { results.push({ ...row, skipped: true }); continue; }
      const t = Date.now();
      try {
        const note = await doStep(s, n);
        results.push({ ...row, ok: true, ms: Date.now() - t, ...(note ? { note } : {}) });
      } catch (e) {
        const msg = `passo ${n} (${ACTION[s.do] || s.do}${where ? ' "' + where + '"' : ''}): ${e.message}`;
        if (!test) throw new Error(msg);
        // a evidência: como a tela estava na hora da falha
        let img = e.shot || '';
        if (!img) { try { fs.mkdirSync(evidence, { recursive: true }); img = path.join(evidence, `passo-${n}.png`); fs.writeFileSync(img, await shot()); } catch { img = ''; } }
        results.push({ ...row, ok: false, ms: Date.now() - t, error: e.message, shot: img });
        failure = failure || new Error(msg);
        if (p.on_fail !== 'continue') stopped = true;
      }
    }
    await settle();
    const info = await evaluate('({ url: location.href, title: document.title })').catch(() => ({}));
    if (!test) {
      await B.close(p.after === 'keep' && !hidden);
      process.stdout.write(JSON.stringify({ url: info.url || '', title: info.title || '', values }));
      process.exit(0);
    }
    if (p.js_errors === 'fail' && jsErrors.length) results.push({ n: n + 1, do: 'js', name: 'Sem erros de JavaScript', on: '', ok: false, ms: 0, error: jsErrors.slice(0, 3).join(' | ') });
    const failed = results.filter(r => r.ok === false).length, passed = results.filter(r => r.ok === true).length;
    const out = { ok: failed === 0, name: String(p.name || '').trim() || info.title || url, passed, failed, skipped: results.filter(r => r.skipped).length, total: results.length, ms: Date.now() - began,
      url: info.url || '', title: info.title || '', values, steps: results, js_errors: jsErrors.slice(0, 20), bad_requests: badRequests, report: '' };
    try { out.report = writeReport(req.data || os.tmpdir(), stamp, out); } catch { /* sem relatório, o resultado ainda vale */ }
    // falhou com a janela à vista: ela fica aberta, para dar para ver onde parou
    await B.close(!hidden && (failed ? p.after !== 'close_always' : p.after === 'keep'));
    process.stdout.write(JSON.stringify({ port: failed ? 'false' : 'true', value: out }));
    process.exit(0);
  } catch (e) {
    await B.close(!hidden);
    die(e.message);
  }
}

/** Relatório do teste numa página só (as evidências vão embutidas), para anexar num chamado. */
function writeReport(data, stamp, r) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const secs = (ms) => ms == null ? '' : (ms / 1000).toFixed(1).replace('.', ',') + ' s';
  const img = (f) => { try { return f && fs.existsSync(f) ? `<a href="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" target="_blank"><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" alt="Tela na hora da falha"></a>` : ''; } catch { return ''; } };
  const rows = r.steps.map(s => `<tr class="${s.skipped ? 'skip' : s.ok ? 'ok' : 'bad'}"><td class="st">${s.skipped ? '–' : s.ok ? '✓' : '✕'}</td><td class="n">${s.n || ''}</td><td><b>${esc(s.name)}</b>${s.on ? ` <code>${esc(s.on)}</code>` : ''}${s.value && !/vault:/.test(s.value) ? ` <span class="v">${esc(s.value)}</span>` : ''}${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}${s.error ? `<div class="err">${esc(s.error)}</div>${img(s.shot)}` : ''}</td><td class="ms">${s.skipped ? 'não rodou' : secs(s.ms)}</td></tr>`).join('');
  const vals = Object.entries(r.values || {});
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.name)} · relatório de teste</title><style>
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--fg:#1c1f26;--mu:#6b7385;--ln:#e3e7ef;--ok:#1f9d61;--bad:#d6453d}@media(prefers-color-scheme:dark){:root{--bg:#14161c;--card:#1e2129;--fg:#e6e8ee;--mu:#8a92a3;--ln:#2c313d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI",system-ui,sans-serif}main{max-width:920px;margin:0 auto;padding:28px 16px 48px}
h1{margin:0 0 4px;font-size:22px;overflow-wrap:anywhere}.sub{color:var(--mu);font-size:13px;overflow-wrap:anywhere}.kp{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
.k{flex:1 1 120px;background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:12px 14px}.k b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.k span{color:var(--mu);font-size:12px}
.k.res b{color:${r.ok ? 'var(--ok)' : 'var(--bad)'}}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--ln);border-radius:12px;overflow:hidden}
td{padding:9px 10px;border-top:1px solid var(--ln);vertical-align:top;overflow-wrap:anywhere}tr:first-child td{border-top:0}.st{width:28px;font-weight:700;text-align:center}.ok .st{color:var(--ok)}.bad .st{color:var(--bad)}
.n,.ms{color:var(--mu);white-space:nowrap;font-variant-numeric:tabular-nums}.ms{text-align:right}.skip{opacity:.55}code{font:12px Consolas,monospace;background:var(--bg);padding:1px 5px;border-radius:5px}
.v{color:var(--mu)}.err{margin-top:4px;color:var(--bad)}.note{color:var(--mu);font-size:12.5px}img{display:block;max-width:100%;margin-top:8px;border:1px solid var(--ln);border-radius:8px}h2{font-size:14px;margin:24px 0 8px}ul{margin:0;padding-left:20px}
</style><main><h1>${esc(r.name)}</h1><div class="sub">${esc(new Date().toLocaleString('pt-BR'))} · ${esc(r.url)}</div>
<div class="kp"><div class="k res"><b>${r.ok ? 'Passou' : 'Falhou'}</b><span>resultado</span></div><div class="k"><b>${r.passed}</b><span>passaram</span></div><div class="k"><b>${r.failed}</b><span>falharam</span></div><div class="k"><b>${secs(r.ms)}</b><span>duração</span></div></div>
<table>${rows}</table>
${vals.length ? `<h2>Campos lidos da tela</h2><table>${vals.map(([k, v]) => `<tr><td class="n">${esc(k)}</td><td>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</table>` : ''}
${r.js_errors.length ? `<h2>Erros de JavaScript na página</h2><ul>${r.js_errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
${r.bad_requests.length ? `<h2>Pedidos que falharam</h2><ul>${r.bad_requests.map(b => `<li><b>${b.status}</b> ${esc(b.url)}</li>`).join('')}</ul>` : ''}
</main></html>`;
  const dir = path.join(data, 'relatorios'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `teste-${stamp}.html`); fs.writeFileSync(file, html);
  return file;
}

// ---------- gravador ----------
// Roda dentro da página (em toda navegação). Uma barra flutuante mostra que está gravando e troca o modo do próximo
// clique: gravar a ação, ler um campo (devolver o texto dele) ou conferir o texto que está ali.
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
    say({ do: 'type', on: on, value: el.type === 'password' ? '{{vault:senha}}' : v });
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

async function record() {
  // a primeira linha da entrada é o pedido; quando a entrada fecha (o Automator parou a gravação), o navegador fecha
  let first = '', got;
  const ready = new Promise(r => { got = r; });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { if (first !== null) { first += d; if (first.includes('\n')) { const line = first.slice(0, first.indexOf('\n')); first = null; got(line); } } });
  const req = JSON.parse(await ready);
  const p = req.params || {};
  const B = await openBrowser(req.data, false);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let count = 0, ended = false;
  const end = async () => { if (ended) return; ended = true; await B.close(false); process.exit(0); };
  process.stdin.on('end', end);
  B.ws.onclose = () => { if (!ended) { ended = true; process.exit(0); } };
  await B.send('Page.enable'); await B.send('Runtime.enable');
  await B.send('Runtime.addBinding', { name: 'bsRec' });
  await B.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${REC.toString()})()` });
  const url = String(p.url || '').trim();
  let needUrl = !url;
  B.on((m) => {
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'bsRec') {
      let s; try { s = JSON.parse(m.params.payload); } catch { return; }
      if (s.done) return end();
      count++; out(s);
      B.evaluate(`window.__bsRecCount && window.__bsRecCount(${count})`).catch(() => {});
    } else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      const u = m.params.frame.url;
      // sem endereço no nó: o primeiro site que a pessoa abrir vira o endereço do teste
      if (needUrl && /^https?:/i.test(u)) { needUrl = false; out({ url: u }); }
      setTimeout(() => B.evaluate(`window.__bsRecCount && window.__bsRecCount(${count})`).catch(() => {}), 400);
    }
  });
  try { await B.send('Page.bringToFront'); } catch {}
  if (url) { try { await B.goto(url); } catch (e) { out({ warn: e.message }); } }
  else await B.evaluate(`(${REC.toString()})()`).catch(() => {});
  out({ ready: true });
}

(process.argv.includes('--record') ? record() : run()).catch(e => die(e.message));
