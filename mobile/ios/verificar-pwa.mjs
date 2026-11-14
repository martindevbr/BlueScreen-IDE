// Etapa "iOS" da esteira: o app do iPhone é a própria interface servida pelo PC (PWA, "Adicionar à Tela de Início"),
// então não há o que compilar. Esta conferência garante que o que o Safari precisa para instalar está no lugar:
// manifesto, ícones nos tamanhos certos (o da Tela de Início sem transparência), as tags do iOS nas páginas,
// a rota /instalar no servidor e o QR code. Roda com Node 18+, sem dependências:  node mobile/ios/verificar-pwa.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const www = join(raiz, 'app', 'wwwroot');
const erros = [];
const ok = (cond, msg) => { if (!cond) erros.push(msg); };
const ler = (p) => readFileSync(join(raiz, p), 'utf8');

// PNG: largura, altura e tipo de cor do cabeçalho IHDR (2 = RGB sem alfa, 6 = RGBA)
function png(rel) {
  const p = join(www, rel);
  if (!existsSync(p)) { erros.push(`falta app/wwwroot/${rel}`); return null; }
  const b = readFileSync(p);
  if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') { erros.push(`${rel} não é PNG`); return null; }
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), cor: b[25] };
}

// ---- manifesto ----
let man = null;
try { man = JSON.parse(ler('app/wwwroot/manifest.webmanifest')); } catch (e) { erros.push('manifest.webmanifest inválido: ' + e.message); }
if (man) {
  ok(man.name && man.short_name, 'manifesto sem name/short_name');
  ok(man.display === 'standalone', 'manifesto: display precisa ser "standalone" (abre sem a barra do navegador)');
  ok(man.start_url === '/' && man.scope === '/', 'manifesto: start_url e scope devem ser "/"');
  ok(/^#[0-9a-f]{6}$/i.test(man.theme_color || '') && /^#[0-9a-f]{6}$/i.test(man.background_color || ''), 'manifesto: theme_color/background_color');
  for (const [tam, finalidade] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
    const ic = (man.icons || []).find((i) => i.sizes === tam && (i.purpose || 'any').split(' ').includes(finalidade));
    ok(ic, `manifesto sem ícone ${tam} (${finalidade})`);
    if (ic) { const i = png(ic.src); if (i) ok(`${i.w}x${i.h}` === tam, `${ic.src} tem ${i.w}x${i.h}, o manifesto diz ${tam}`); }
  }
}
const apple = png('icons/apple-touch-icon.png');
if (apple) {
  ok(apple.w === 180 && apple.h === 180, `apple-touch-icon.png tem ${apple.w}x${apple.h} (o iPhone usa 180x180)`);
  ok(apple.cor === 2, 'apple-touch-icon.png com transparência: o iOS pinta o transparente de preto');
}
const mask = png('icons/maskable-512.png');
if (mask) ok(mask.cor === 2, 'maskable-512.png deve ser opaco (a máscara corta as bordas)');

// ---- páginas ----
const TAGS = [
  [/<link rel="manifest" href="manifest\.webmanifest">/, 'link do manifesto'],
  [/<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/, 'apple-touch-icon'],
  [/<meta name="apple-mobile-web-app-capable" content="yes">/, 'apple-mobile-web-app-capable'],
  [/<meta name="apple-mobile-web-app-title" content="BlueScreen">/, 'apple-mobile-web-app-title'],
  [/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/, 'status bar translúcida'],
  [/viewport-fit=cover/, 'viewport-fit=cover (o CSS usa as margens seguras)'],
];
for (const pag of ['index.html', 'instalar.html']) {
  const h = ler(`app/wwwroot/${pag}`);
  for (const [re, nome] of TAGS) ok(re.test(h), `${pag}: falta ${nome}`);
  ok(/<script src="qr\.js"><\/script>/.test(h), `${pag}: falta qr.js`);
}
ok(/env\(safe-area-inset-top/.test(ler('app/wwwroot/app.css')), 'app.css sem as margens seguras (safe-area-inset)');
ok(/id="netQr"/.test(ler('app/wwwroot/index.html')), 'index.html: falta o QR code da Rede local');

// ---- servidor ----
const srv = ler('app/src/server.rs');
ok(/"\/instalar"/.test(srv), 'server.rs: falta a rota /instalar');
ok(/"webmanifest" => "application\/manifest\+json"/.test(srv), 'server.rs: tipo do .webmanifest');
ok(/"apk" => "application\/vnd\.android\.package-archive"/.test(srv), 'server.rs: tipo do .apk');

// ---- QR code: estrutura (os três padrões de canto) e tamanho por versão ----
const qr = createRequire(import.meta.url)(join(www, 'qr.js'));
for (const [txt, versao] of [['http://192.168.0.10:4748/instalar', 3], ['http://10.0.0.5:4748', 2], ['x'.repeat(150), 8]]) {
  const m = qr.encode(txt), n = m.length;
  ok(n === versao * 4 + 17, `QR de ${txt.length} caracteres: esperava a versão ${versao} (${versao * 4 + 17} módulos), veio ${n}`);
  const canto = (x, y) => [0, 6].every((d) => m[y][x + d] && m[y + d][x] && m[y + 6][x + d] && m[y + d][x + 6]) && m[y + 3][x + 3] && !m[y + 1][x + 1];
  ok(canto(0, 0) && canto(n - 7, 0) && canto(0, n - 7), `QR de ${txt.length} caracteres sem os padrões de canto`);
}
ok(/<svg[^>]+viewBox="0 0 37 37"/.test(qr.svg('http://192.168.0.10:4748/instalar')), 'QR em SVG: margem de 4 módulos');

if (erros.length) {
  console.error(`PWA do iOS: ${erros.length} problema(s)\n` + erros.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('PWA do iOS: manifesto, ícones, páginas, rota /instalar e QR code conferidos.');
