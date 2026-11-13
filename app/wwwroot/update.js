/* BlueScreen: atualização (update.rs). Instalado: baixa a versão pronta do GitHub Releases (o GitHub Actions compila
   e publica uma a cada push); rodando do código-fonte, ou sem Release: pelo repositório git de origem. Alguns segundos depois de abrir, pergunta ao
   núcleo se chegaram commits; havendo, aparece o selo "Atualização" no topo. O diálogo mostra o que mudou e o
   tamanho da atualização: só interface (git pull e a página recarrega) ou núcleo (git pull, compila, troca os
   arquivos e reinicia). O progresso vem de update/status. "Pular esta versão" esconde o selo até o próximo commit. */
(function (bs) {
const { $, esc, store, toast } = bs;
const post = (p) => bs.api(p, {}, { method: 'POST', headers: { 'X-BlueScreen': 'ui' } });
const IC = {
  up: '<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  commit: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M3 12h5.8M15.2 12H21"/></svg>',
  bolt: '<svg class="i" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  gear: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const U = { info: null, poll: null };

// selo no topo, ao lado da engrenagem
const pill = document.createElement('button');
pill.id = 'updPill'; pill.className = 'chip'; pill.hidden = true;
pill.innerHTML = `<span class="up-dot"></span>${IC.up}<span class="up-txt">Atualização</span>`;
$('#btnSettings').before(pill);
pill.onclick = () => openDialog();

const back = document.createElement('div');
back.id = 'updBack'; back.hidden = true;
back.innerHTML = '<section id="upd" role="dialog" aria-modal="true" aria-label="Atualizar o BlueScreen"></section>';
document.body.appendChild(back);
const box = back.firstElementChild;
back.addEventListener('mousedown', (e) => { if (e.target === back && !U.poll) close(); });
bs.hooks.on('escape', () => { if (!back.hidden && !U.poll) close(); });

async function check(fresh, quiet = true) {
  try {
    const i = await bs.api('update/check', { fresh: fresh ? '1' : null });
    U.info = i;
    const has = i.available && i.behind > 0;
    const skipped = has && store.get('updSkip', '') === i.remoteHead;
    pill.hidden = !has || skipped;
    if (has && !skipped) {
      pill.querySelector('.up-txt').textContent = i.remoteVersion && i.remoteVersion !== i.version ? 'v' + i.remoteVersion : `${i.behind} ${i.behind > 1 ? 'novidades' : 'novidade'}`;
      pill.classList.remove('up-enter'); void pill.offsetWidth; pill.classList.add('up-enter');
      if (!quiet) openDialog();
    } else if (!quiet) toast(i.available ? (i.offline ? 'Sem conexão com o repositório remoto.' : 'O BlueScreen está atualizado.') : i.reason);
  } catch (e) { if (!quiet) toast('Atualização: ' + e.message); }
}

function close() { box.classList.add('out'); setTimeout(() => { back.hidden = true; box.classList.remove('out'); }, 180); }
function openDialog() {
  const i = U.info; if (!i || !i.available) return;
  const build = i.needsBuild, rel = i.mode === 'release';
  const mb = (n) => (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  const ver = i.remoteVersion && i.remoteVersion !== i.version ? `<span class="v-old">v${esc(i.version)}</span><span class="v-arrow">→</span><span class="v-new">v${esc(i.remoteVersion)}</span>` : `<span class="v-new">${i.behind} ${i.behind > 1 ? 'alterações novas' : 'alteração nova'}</span>`;
  box.innerHTML = `
    <header class="up-hero"><div class="up-glow"></div><span class="up-mark">;)</span>
      <div class="up-badge">${IC.up}</div>
      <div class="up-h"><small>Nova versão do BlueScreen</small><div class="up-ver">${ver}</div>
      <div class="up-meta">${rel ? `${esc(i.upstream)}${i.size ? ' · ' + mb(i.size) : ''}` : `${esc(i.upstream)} · ${i.behind} commit${i.behind > 1 ? 's' : ''} · ${i.files} arquivo${i.files > 1 ? 's' : ''}`}</div></div>
      <button class="icon-btn up-x" title="Fechar">${IC.x}</button></header>
    ${rel ? `<div class="up-kind quick">${IC.bolt}<div><b>Versão pronta: baixa e reinicia, sem compilar</b>
      <span>Pacote compilado pelo GitHub Actions${i.size ? ` (${mb(i.size)})` : ''}, conferido pela soma SHA-256 antes de trocar os arquivos. Seus arquivos abertos são salvos antes de reiniciar.</span></div></div>`
    : `<div class="up-kind ${build ? 'build' : 'quick'}">${build ? IC.gear : IC.bolt}<div><b>${build ? 'Inclui o núcleo: compila e reinicia' : 'Só interface: aplica na hora'}</b>
      <span>${build ? 'git pull, compilação (30 s a 2 min) e troca dos arquivos. Seus arquivos abertos são salvos antes de reiniciar.' : 'git pull e a página recarrega, sem compilar nem reiniciar.'}</span></div></div>`}
    ${i.dirty ? `<div class="up-warn">O repositório tem alterações locais. Elas são guardadas e reaplicadas depois do pull (autostash).</div>` : ''}
    ${i.ahead ? `<div class="up-warn">O branch local tem ${i.ahead} commit(s) que não estão no remoto: o pull só avança se não houver conflito.</div>` : ''}
    <div class="up-log-h">O que mudou</div>
    <ol class="up-log">${(i.commits || []).map((c, k) => `<li style="--i:${Math.min(k, 14)}">${IC.commit}<div><span class="s">${esc(c.subject)}</span><span class="m">${[c.author, c.when].filter(Boolean).map(esc).join(' · ')}${c.author || c.when ? ' · ' : ''}${c.hash ? `<code>${esc(c.hash)}</code>` : ''}</span></div></li>`).join('')}</ol>
    <footer><button class="up-link up-skip">Pular esta versão</button><span class="spacer"></span>
      <button class="chip up-later">Agora não</button><button class="chip primary up-go">${IC.up}<span>Atualizar</span></button></footer>`;
  back.hidden = false;
  box.querySelector('.up-x').onclick = box.querySelector('.up-later').onclick = close;
  box.querySelector('.up-skip').onclick = () => { store.set('updSkip', i.remoteHead); pill.hidden = true; close(); };
  box.querySelector('.up-go').onclick = start;
}

async function start() {
  try { await post('update/apply'); } catch (e) { toast('Atualização: ' + e.message); return; }
  box.innerHTML = `
    <header class="up-hero slim"><div class="up-glow"></div><div class="up-badge spin">${IC.up}</div>
      <div class="up-h"><small id="upSub">Atualizando o BlueScreen</small><div class="up-ver"><span class="v-new" id="upPct">0%</span></div></div>
      <span class="up-time" id="upTime">00:00</span></header>
    <div class="up-bar"><i id="upBar"></i></div>
    <ol class="up-steps" id="upSteps"></ol>
    <div class="up-line" id="upLine"></div>
    <pre class="up-tail" id="upTail" hidden></pre>
    <footer id="upFoot"><button class="up-link" id="upMore">Ver detalhes</button><span class="spacer"></span></footer>`;
  $('#upMore').onclick = () => { const t = $('#upTail'); t.hidden = !t.hidden; $('#upMore').textContent = t.hidden ? 'Ver detalhes' : 'Esconder detalhes'; };
  U.shown = 0;
  U.poll = setInterval(tick, 400); tick();
}
async function tick() {
  let s; try { s = await bs.api('update/status'); } catch { return; }
  const steps = $('#upSteps'); if (!steps) return;
  const cur = s.done ? s.steps.length : s.step;
  // só redesenha quando a etapa muda (senão a animação do check recomeça a cada consulta)
  const key = cur + '|' + !!s.error;
  if (steps.dataset.k !== key) {
    steps.dataset.k = key;
    steps.innerHTML = s.steps.map((t, k) => `<li class="${s.error && k === cur ? 'bad' : k < cur ? 'ok' : k === cur ? 'run' : ''}"><span class="st">${k < cur ? IC.ok : s.error && k === cur ? IC.x : ''}</span>${esc(t)}</li>`).join('');
  }
  // com as dependências já compiladas o cargo mostra poucas linhas "Compiling": o tempo também empurra a barra
  const prog = s.restart && !s.release && s.step === 1 && !s.done ? Math.max(s.progress, 0.08 + 0.7 * (1 - Math.exp(-s.elapsed / 150))) : s.progress;
  $('#upBar').style.width = (prog * 100).toFixed(1) + '%'; $('#upPct').textContent = Math.floor(prog * 100) + '%';
  $('#upTime').textContent = String(Math.floor(s.elapsed / 60)).padStart(2, '0') + ':' + String(s.elapsed % 60).padStart(2, '0');
  $('#upLine').textContent = s.line || '';
  const tail = $('#upTail'); tail.textContent = (s.tail || []).join('\n'); if (!tail.hidden) tail.scrollTop = tail.scrollHeight;
  if (s.error) { clearInterval(U.poll); U.poll = null; failed(s); }
  else if (s.done) { clearInterval(U.poll); U.poll = null; finished(s); }
}
function failed(s) {
  box.classList.add('err'); $('#upSub').textContent = 'A atualização não terminou';
  box.querySelector('.up-badge').classList.remove('spin'); box.querySelector('.up-badge').innerHTML = IC.x;
  $('#upLine').textContent = s.error; $('#upLine').classList.add('bad');
  $('#upTail').hidden = false; $('#upMore').textContent = 'Esconder detalhes';
  $('#upFoot').insertAdjacentHTML('beforeend', '<button class="chip up-close">Fechar</button>');
  box.querySelector('.up-close').onclick = () => { box.classList.remove('err'); close(); };
}
function finished(s) {
  box.classList.add('done'); const badge = box.querySelector('.up-badge'); badge.classList.remove('spin'); badge.innerHTML = IC.ok;
  pill.hidden = true;
  if (!s.restart) {
    $('#upSub').textContent = 'Interface atualizada'; $('#upLine').textContent = 'Recarregando…';
    setTimeout(() => location.reload(), 1300);
    return;
  }
  $('#upSub').textContent = 'Versão nova pronta';
  const dirty = (bs.S.tabs || []).filter(t => t.dirty).length;
  $('#upLine').textContent = dirty ? `${dirty} arquivo(s) sem salvar serão salvos antes de reiniciar.` : 'Reinicie para usar a versão nova.';
  $('#upFoot').insertAdjacentHTML('beforeend', '<button class="chip up-later">Depois</button><button class="chip primary up-restart">Reiniciar agora</button>');
  box.querySelector('.up-later').onclick = () => { close(); toast('A versão nova entra no próximo início do BlueScreen.'); };
  box.querySelector('.up-restart').onclick = restart;
}
async function restart() {
  try { if (bs.saveAll) await bs.saveAll(); } catch {}
  if ((bs.S.tabs || []).some(t => t.dirty)) { toast('Alguns arquivos não foram salvos. Salve-os e tente de novo.'); return; }
  box.innerHTML = `<div class="up-bye"><div class="up-badge spin">${IC.up}</div><b>Reiniciando…</b><span>A versão nova abre em instantes.</span></div>`;
  try { await post('update/restart'); } catch (e) { toast('Reiniciar: ' + e.message); }
}

bs.actions.add({ label: 'Procurar atualizações do BlueScreen', icon: IC.up, run: () => check(true, false) });
// quem deixa a IDE aberta o dia todo também recebe: pergunta de novo a cada 30 min e ao voltar para a janela
// (no máximo a cada 15 min; o núcleo guarda a resposta por 10 min e o GitHub limita as consultas)
if (!bs.doc) {
  let last = 0;
  const again = (ms) => { if (U.poll || Date.now() - last < ms) return; last = Date.now(); check(true); };
  setTimeout(() => { last = Date.now(); check(false); }, 6000);
  setInterval(() => again(25 * 60e3), 30 * 60e3);
  addEventListener('focus', () => again(15 * 60e3));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(15 * 60e3); });
}
bs.update = { check, open: openDialog };
})(window.BS);
