'use strict';
/* BlueScreen: aviso de log pesado. Um arquivo de log com mais de 1 MB (o da própria IDE em ~/.bluescreen, o dos
   plugins em plugin-data e os .log do projeto aberto, até 4 pastas abaixo) acende um aviso na barra de baixo e,
   na primeira vez, um toast. O clique no aviso lista os logs: abrir (arquivos grandes abrem no leitor de arquivos
   grandes, sem travar), mostrar no Explorer, esvaziar deixando só o final (os últimos 256 KB) ou só deixar de avisar
   até ele crescer mais 1 MB. Consulta ao abrir a IDE, ao trocar de projeto e a cada 10 minutos (no núcleo, sem ler
   o conteúdo dos arquivos: só o tamanho). Desliga em Configurações › Geral › Desempenho. */
(function logWatch(bs) {
if (bs.doc) return;
const MB = 1048576, LIMIT = MB, KEEP = 256 * 1024;
const L = { files: [], warned: new Set(), timer: 0, busy: false };
const on = () => store.get('logWarn', true);
// "não avisar até crescer": guarda o tamanho de quando a pessoa pediu
const snoozed = () => store.get('logSnooze', {}) || {};
const quiet = (f) => { const s = snoozed()[f.path]; return s && f.size < s + MB; };
const size = (n) => n >= MB ? (n / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB' : Math.round(n / 1024) + ' KB';
const KIND = { ide: 'da IDE', plugin: 'de plugin', project: 'do projeto' };
const WARN = '<svg class="i" viewBox="0 0 24 24"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>';
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, ''), nameOf = (p) => p.split(/[\\/]/).pop();
const el = bs.status.add({ id: 'stLogs', onclick: (e) => menu(e) });
el.classList.add('st-logs');

async function check() {
  if (L.busy) return;
  if (!on()) { L.files = []; return paint(); }
  L.busy = true;
  try {
    const r = await api('logs/heavy', { project: S.project ? S.project.path : '', min: LIMIT }, { quiet: true });
    L.files = r.files || [];
  } catch { /* sem resposta: fica como estava */ }
  L.busy = false;
  paint();
  const fresh = L.files.filter(f => !quiet(f) && !L.warned.has(f.path));
  fresh.forEach(f => L.warned.add(f.path));
  if (fresh.length) toast(fresh.length === 1 ? `Log pesado: ${fresh[0].name} (${KIND[fresh[0].kind]}) está com ${size(fresh[0].size)}. Veja no aviso da barra de baixo.` : `${fresh.length} logs passaram de 1 MB. Veja no aviso da barra de baixo.`);
}
function paint() {
  const list = L.files.filter(f => !quiet(f));
  el.hidden = !list.length;
  if (!list.length) return;
  el.innerHTML = `${WARN}${list.length === 1 ? `${esc(list[0].name)} ${size(list[0].size)}` : `${list.length} logs pesados`}`;
  el.title = 'Logs com mais de 1 MB:\n' + list.map(f => `${f.name} · ${size(f.size)} · ${KIND[f.kind]}`).join('\n') + '\nClique para abrir, esvaziar ou deixar de avisar';
}
function open(f) { bs.openFile(nameOf(f.path), 'editor', null, false, dirOf(f.path)); }
async function trim(f) {
  try {
    const r = await api('logs/trim', { project: S.project ? S.project.path : '' }, { method: 'POST', body: JSON.stringify({ path: f.path, keep: KEEP }) });
    toast(`${f.name}: de ${size(f.size)} para ${size(r.size)} (ficou o final)`, 'ok');
  } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  check();
}
function snooze(f) { const s = snoozed(); s[f.path] = f.size; store.set('logSnooze', s); paint(); toast(`${f.name}: aviso de novo só quando passar de ${size(f.size + MB)}`); }
function menu(e) {
  const list = L.files.filter(f => !quiet(f)); if (!list.length) return;
  const items = [];
  for (const f of list) {
    if (items.length) items.push('-');
    items.push(
      { label: `Abrir ${f.name} (${size(f.size)}, ${KIND[f.kind]})`, icon: bs.I.open, action: () => open(f) },
      { label: `Esvaziar, deixando só o final (${size(KEEP)})`, icon: bs.I.edit, action: () => trim(f) },
      { label: 'Mostrar no Explorer', icon: bs.I.explorer, action: () => bs.reveal(f.path) },
      { label: 'Não avisar até crescer mais 1 MB', icon: bs.I.copy, action: () => snooze(f) },
    );
  }
  showMenu(e, items, list.length === 1 ? 'Log com mais de 1 MB' : `${list.length} logs com mais de 1 MB`);
}
function arm() { clearInterval(L.timer); L.timer = setInterval(check, 10 * 60000); }
bs.hooks.on('project:select', () => setTimeout(check, 1500));
setTimeout(check, 6000); arm();
bs.logWatch = { check, get files() { return L.files; }, set(v) { store.set('logWarn', !!v); check(); }, get on() { return on(); } };
})(window.BS);
