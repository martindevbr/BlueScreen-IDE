/* Conselho de agentes: uma proposta é revisada, de forma independente e só com leitura, pelo Codex e pelo Claude
   Code. Só vale como aprovada quando todos os escolhidos aprovam; falha, divergência ou pedido de ajuste bloqueia. */
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  app: svg('<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20v-2a5.5 5.5 0 0 1 11 0v2M15 14.2a4.5 4.5 0 0 1 6.5 4V20"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), stop: svg('<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>'),
};
const esc = bs.esc;
const NAME = { codex: 'Codex', claude: 'Claude Code' };
const VERDICT = { approve: ['aprova', 'ok'], revise: ['pede ajustes', 'warn'], reject: ['rejeita', 'bad'] };
let root, records = [], busy = false, since = 0, clock = null;
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { bs.toast('Agentes: ' + e.message, 'err'); } };
const when = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function refresh() { records = await bs.api('agents/reviews', {}, { quiet: true }); paintHistory(); }
function paintHistory() {
  if (!root) return;
  const list = root.querySelector('.ac-list');
  list.innerHTML = records.map(r => `<article class="ac-rec ${r.approved ? 'ok' : 'bad'}">
      <header><span class="ac-badge">${r.approved ? IC.ok + 'Aprovada' : IC.stop + 'Bloqueada'}</span><time>${esc(when(r.at))}</time></header>
      <p class="ac-prop">${esc(r.proposal)}</p>
      ${r.reviews.map(v => { const d = v.error ? ['não respondeu', 'bad'] : VERDICT[v.result?.verdict] || ['sem parecer', 'bad']; return `<div class="ac-rev"><b>${esc(NAME[v.provider] || v.provider)}</b><span class="ac-v ${d[1]}">${d[0]}</span><p>${esc(String(v.error || v.result?.reason || ''))}</p></div>`; }).join('')}
    </article>`).join('') || '<p class="ac-none">Nenhuma revisão ainda.</p>';
  list.querySelectorAll('.ac-prop').forEach(p => { p.onclick = () => p.classList.toggle('open'); });
}
function paintBusy() {
  const b = root.querySelector('.ac-go'), st = root.querySelector('.ac-st');
  b.disabled = busy; b.querySelector('span').textContent = busy ? 'Revisando…' : 'Pedir revisão';
  st.textContent = busy ? `${Math.floor((Date.now() - since) / 1000)} s · cada agente tem até 3 minutos` : '';
  bs.bubble.badge('agents', busy ? 'busy' : null);
}
const submit = guard(async () => {
  if (busy) return;
  const text = root.querySelector('.ac-text'), proposal = text.value.trim();
  const providers = ['codex', 'claude'].filter(p => root.querySelector(`[data-p=${p}]`).checked);
  if (!proposal) { text.focus(); throw new Error('escreva a proposta que os agentes devem revisar.'); }
  if (!providers.length) throw new Error('escolha pelo menos um agente.');
  busy = true; since = Date.now(); paintBusy(); clock = setInterval(paintBusy, 1000);
  try {
    const r = await bs.api('agents/reviews', {}, { method: 'POST', body: JSON.stringify({ proposal, cwd: root.querySelector('.ac-cwd').value.trim(), providers }) });
    text.value = '';
    bs.toast(r.approved ? 'Proposta aprovada por todos os revisores.' : 'Proposta bloqueada: veja os pareceres.', r.approved ? 'ok' : 'err');
    await refresh();
    if (!bs.bubble.isOpen('agents')) busy = false; // terminou com a janela fechada: o ponto no balão avisa (ver o finally)
  } finally { const dot = !busy; busy = false; clearInterval(clock); paintBusy(); if (dot) bs.bubble.badge('agents', 'dot'); }
});
function mount(pane) {
  root = pane; pane.classList.add('ac');
  pane.innerHTML = `<form class="ac-form">
      <label class="ac-lbl" for="acText">Proposta</label>
      <textarea class="ac-text" id="acText" rows="6" placeholder="Descreva a decisão, o contexto e a solução proposta. Os agentes procuram erros e riscos antes de você decidir."></textarea>
      <label class="ac-lbl" for="acCwd">Pasta que eles podem ler</label>
      <input class="ac-cwd" id="acCwd" type="text" spellcheck="false" placeholder="vazio: sua pasta de usuário">
      <div class="ac-row"><span class="ac-picks"><label><input type="checkbox" data-p="codex" checked><span>Codex</span></label><label><input type="checkbox" data-p="claude" checked><span>Claude Code</span></label></span>
        <span class="ac-st" aria-live="polite"></span><button class="chip primary ac-go" type="submit">${IC.app}<span>Pedir revisão</span></button></div>
      <p class="ac-hint">Cada agente analisa sozinho, só com leitura, usando o programa e o login que já estão neste PC. A proposta só é aprovada quando todos aprovam.</p>
    </form>
    <section class="ac-hist"><h4>Revisões</h4><div class="ac-list"></div></section>`;
  pane.querySelector('.ac-cwd').value = bs.S.project?.path || '';
  pane.querySelector('form').onsubmit = (e) => { e.preventDefault(); submit(); };
  pane.querySelector('.ac-text').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } };
  paintHistory();
}
bs.bubble.register({ id: 'agents', title: 'Conselho de agentes', icon: IC.app, order: 62, width: 620, height: 700, render: mount, show: () => { if (!busy) bs.bubble.badge('agents', null); guard(refresh)(); } });
bs.actions.add([{ label: 'Agentes: revisar uma proposta', icon: IC.app, run: () => bs.bubble.open('agents') }]);
// a pasta acompanha o projeto aberto, enquanto o campo não foi mexido à mão
bs.hooks.on('project:select', (p) => { const f = root?.querySelector('.ac-cwd'); if (f && document.activeElement !== f) f.value = p?.path || ''; });
plugin.onUnload(() => clearInterval(clock));
