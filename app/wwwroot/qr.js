/* QR code (ISO 18004) em JavaScript puro, para mostrar endereços da IDE na tela (Configurações › Rede local).
   Modo byte (UTF-8), correção M, versões 1 a 10 (até 213 bytes: sobra para qualquer endereço). A máscara é a de
   menor penalidade, como manda a norma. Uso: BS_QR.svg('http://192.168.0.10:4748/instalar') -> '<svg ...>'. */
(function () {
  'use strict';
  // correção M: [palavras de correção por bloco, número de blocos], da versão 1 à 10
  const ECC_M = [null, [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]];

  // ---- aritmética em GF(256), polinômio 0x11D ----
  function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z & 0xFF;
  }
  function rsDivisor(n) {
    const r = new Array(n).fill(0); r[n - 1] = 1;
    let root = 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) { r[j] = mul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; }
      root = mul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = new Array(div.length).fill(0);
    for (const b of data) {
      const f = b ^ r.shift(); r.push(0);
      for (let i = 0; i < div.length; i++) r[i] ^= mul(div[i], f);
    }
    return r;
  }
  // módulos que sobram para dados e correção (tudo menos os padrões fixos), em bits
  function rawModules(v) {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function alignPos(v) {
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2, size = v * 4 + 17;
    const step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
    const r = [6];
    for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p);
    return r;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const [ecc, blocks] = ECC_M[v];
      const dataCw = Math.floor(rawModules(v) / 8) - ecc * blocks;
      const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCw * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('texto longo demais para o QR code');
    const [ecc, numBlocks] = ECC_M[ver];
    const rawCw = Math.floor(rawModules(ver) / 8), dataCw = rawCw - ecc * numBlocks;

    // ---- bits: modo byte, tamanho, dados, terminador e enchimento ----
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
    put(0, Math.min(4, dataCw * 8 - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < dataCw * 8; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // ---- blocos com correção, intercalados ----
    const numShort = numBlocks - rawCw % numBlocks, shortLen = Math.floor(rawCw / numBlocks);
    const div = rsDivisor(ecc), blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - ecc + (i < numShort ? 0 : 1)); k += dat.length;
      const blk = dat.concat(rsRemainder(dat, div));
      if (i < numShort) blk.splice(shortLen - ecc, 0, -1); // lugar vazio: os blocos curtos ficam do tamanho dos longos
      blocks.push(blk);
    }
    const cw = [];
    for (let i = 0; i < blocks[0].length; i++) for (const b of blocks) if (b[i] !== -1) cw.push(b[i]);

    // ---- matriz ----
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const ap = alignPos(ver), last = ap.length - 1;
    for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask) => {
      const d = (0 << 3) | mask; // correção M = 00
      let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0); // reserva o lugar
    if (ver >= 7) {
      let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const b = (ver << 12) | r;
      for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
    }
    // dados em zigue-zague, de baixo para cima, duas colunas por vez
    for (let right = size - 1, i = 0; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < cw.length * 8) { mod[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
    ];
    const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      const line = (get) => {
        for (let a = 0; a < size; a++) {
          let run = 1;
          for (let b = 1; b <= size; b++) {
            if (b < size && get(a, b) === get(a, b - 1)) run++;
            else { if (run >= 5) p += run - 2; run = 1; }
          }
          for (let b = 0; b + 11 <= size; b++) {
            const s = Array.from({ length: 11 }, (_, k) => get(a, b + k) ? 1 : 0).join('');
            if (s === '10111010000' || s === '00001011101') p += 40;
          }
        }
      };
      line((a, b) => mod[a][b]); line((a, b) => mod[b][a]);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (mod[y][x]) dark++;
        if (x < size - 1 && y < size - 1) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
      }
      const total = size * size;
      return p + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const pe = penalty(); if (pe < bestP) { bestP = pe; best = m; }
      applyMask(m); // desfaz (a máscara é um XOR)
    }
    applyMask(best); drawFormat(best);
    return mod;
  }

  /** SVG com margem de 4 módulos (exigida pelos leitores); escuro sobre claro sempre, mesmo no tema escuro */
  function svg(text, { px = 176, dark = '#0B1020', light = '#FFFFFF', label = 'QR code' } = {}) {
    const m = encode(text), n = m.length + 8;
    let d = '';
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }

  const api = { encode, svg };
  if (typeof module === 'object' && module.exports) module.exports = api; else window.BS_QR = api;
})();
