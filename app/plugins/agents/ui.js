/* Conselho de agentes: uma proposta é revisada, de forma independente e só com leitura, pelos agentes escolhidos
   (Codex, Claude Code e os que o usuário cadastrou). Você escolhe o foco da revisão e se a aprovação exige todos
   ou a maioria. Falha de um agente conta como "não aprovou". */
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  app: svg('<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20v-2a5.5 5.5 0 0 1 11 0v2M15 14.2a4.5 4.5 0 0 1 6.5 4V20"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), stop: svg('<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>'),
  again: svg('<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/>'), copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
};
const esc = bs.esc;
const NAME = { codex: 'Codex', claude: 'Claude Code' };
let clis = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }];
const GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>');
const VERDICT = { approve: ['aprova', 'ok'], revise: ['pede ajustes', 'warn'], reject: ['rejeita', 'bad'] };
const FOCUS = [['general', 'Geral'], ['security', 'Segurança'], ['quality', 'Qualidade e testes'], ['cost', 'Custo e risco'], ['ux', 'Quem usa']];
let root, records = [], busy = false, since = 0, clock = null, asked = [];
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { bs.toast('Conselho: ' + e.message, 'err'); } };
const when = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const secs = (ms) => ms == null ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;
const nameOf = (v) => v.name || NAME[v.provider] || v.provider;
const post = (b) => bs.api('agents/reviews', {}, { method: 'POST', body: JSON.stringify(b) });

async function refresh() { records = await bs.api('agents/reviews', {}, { quiet: true }); paintHistory(); }
/** O parecer de todos, em texto, para colar num chamado ou numa conversa. */
function asText(r) {
  return [`Proposta: ${r.proposal}`, `Resultado: ${r.approved ? 'aprovada' : 'bloqueada'}`, ...r.reviews.map(v => {
    const d = v.error ? 'não respondeu' : (VERDICT[v.result?.verdict] || ['sem parecer'])[0], issues = (v.result?.issues || []).map(i => `  - ${i}`).join('\n');
    return `\n${nameOf(v)}: ${d}\n${v.error || v.result?.reason || ''}${issues ? '\n' + issues : ''}`;
  })].join('\n');
}
function paintHistory() {
  if (!root) return;
  const list = root.querySelector('.ac-list');
  root.querySelector('.ac-clear').hidden = !records.length;
  // enquanto revisa: um cartão com quem está analisando
  const live = busy ? `<article class="ac-rec live"><header><span class="ac-badge"><i class="ac-spin"></i>Revisando</span><time class="ac-st"></time></header>
      <div class="ac-who">${asked.map(n => `<span><i class="ac-spin"></i>${esc(n)}</span>`).join('')}</div></article>` : '';
  list.innerHTML = live + (records.map((r, i) => {
    const total = r.total ?? r.reviews.length, yes = r.approvals ?? r.reviews.filter(v => v.result?.verdict === 'approve').length;
    const focus = FOCUS.find(f => f[0] === r.focus && f[0] !== 'general')?.[1];
    return `<article class="ac-rec ${r.approved ? 'ok' : 'bad'}" data-i="${i}">
      <header><span class="ac-badge">${r.approved ? IC.ok + 'Aprovada' : IC.stop + 'Bloqueada'}</span>
        <span class="ac-count">${yes} de ${total} ${yes === 1 ? 'aprova' : 'aprovam'}${r.rule === 'majority' ? ' · maioria' : ''}${focus ? ' · ' + esc(focus) : ''}</span>
        <time>${esc(when(r.at))}</time>
        <span class="ac-acts"><button class="icon-btn" data-a="again" type="button" title="Revisar de novo: a proposta volta para o campo, pronta para ajustar">${IC.again}</button><button class="icon-btn" data-a="copy" type="button" title="Copiar os pareceres">${IC.copy}</button><button class="icon-btn" data-a="del" type="button" title="Tirar do histórico">${IC.x}</button></span></header>
      <p class="ac-prop" title="Clique para ver inteira">${esc(r.proposal)}</p>
      ${r.reviews.map(v => { const d = v.error ? ['não respondeu', 'bad'] : VERDICT[v.result?.verdict] || ['sem parecer', 'bad'], issues = Array.isArray(v.result?.issues) ? v.result.issues.filter(x => typeof x === 'string' && x.trim()).slice(0, 12) : [];
        return `<div class="ac-rev"><b>${esc(nameOf(v))}</b><span class="ac-v ${d[1]}">${d[0]}</span><span class="ac-ms">${esc(secs(v.ms))}</span><p>${esc(String(v.error || v.result?.reason || ''))}</p>${issues.length ? `<ul>${issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`; }).join('')}
    </article>`;
  }).join('') || (busy ? '' : '<p class="ac-none">Nenhuma revisão ainda. Escreva a proposta acima e peça a revisão.</p>'));
  list.querySelectorAll('.ac-prop').forEach(p => { p.onclick = () => p.classList.toggle('open'); });
  list.querySelectorAll('.ac-rec[data-i]').forEach(card => {
    const r = records[+card.dataset.i];
    card.querySelector('[data-a=again]').onclick = () => { const t = root.querySelector('.ac-text'); t.value = r.proposal; t.focus(); root.scrollTop = 0; setFocus(r.focus || 'general'); };
    card.querySelector('[data-a=copy]').onclick = () => { bs.copyText(asText(r)); bs.toast('Pareceres copiados', 'ok'); };
    card.querySelector('[data-a=del]').onclick = guard(async () => { await post({ action: 'delete', id: r.id }); await refresh(); });
  });
  paintBusy();
}
const getFocus = () => root.querySelector('.ac-focus .on')?.dataset.f || 'general';
function setFocus(f) { root.querySelectorAll('.ac-focus button').forEach(b => { const on = b.dataset.f === f; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); }
// os revisores: Codex e Claude Code vêm marcados; os que o usuário cadastrou em Agentes de IA entram desmarcados
function paintPicks() {
  const box = root?.querySelector('.ac-picks'); if (!box) return;
  const had = box.childElementCount > 0, on = new Set([...box.querySelectorAll('input:checked')].map(c => c.dataset.p));
  box.innerHTML = clis.map(c => `<label><input type="checkbox" data-p="${esc(c.id)}"${(had ? on.has(c.id) : c.id === 'codex' || c.id === 'claude') ? ' checked' : ''}><span>${esc(c.name)}</span></label>`).join('');
  box.querySelectorAll('input').forEach(c => { c.onchange = paintRule; });
  paintRule();
}
// "a maioria" só faz diferença com três ou mais revisores
function paintRule() {
  const n = root.querySelectorAll('.ac-picks input:checked').length, rule = root.querySelector('.ac-rule');
  rule.hidden = n < 3; if (n < 3) rule.value = 'all';
}
async function loadClis() { try { clis = await bs.aiClis.list(); paintPicks(); } catch {} }
function paintBusy() {
  if (!root) return;
  const b = root.querySelector('.ac-go'), st = root.querySelector('.ac-rec.live .ac-st');
  b.disabled = busy; b.querySelector('span').textContent = busy ? 'Revisando…' : 'Pedir revisão';
  if (st) st.textContent = `${Math.floor((Date.now() - since) / 1000)} s · até 3 min por agente`;
  bs.bubble.badge('agents', busy ? 'busy' : null);
}
const submit = guard(async () => {
  if (busy) return;
  const text = root.querySelector('.ac-text'), proposal = text.value.trim();
  const picked = [...root.querySelectorAll('.ac-picks input:checked')], providers = picked.map(c => c.dataset.p);
  if (!proposal) { text.focus(); throw new Error('escreva a proposta que os agentes devem revisar.'); }
  if (!providers.length) throw new Error('escolha pelo menos um agente.');
  if (providers.length > 4) throw new Error('escolha até quatro agentes.');
  asked = picked.map(c => c.nextElementSibling.textContent);
  busy = true; since = Date.now(); paintHistory(); clock = setInterval(paintBusy, 1000);
  try {
    const r = await post({ proposal, cwd: root.querySelector('.ac-cwd').value.trim(), providers, focus: getFocus(), rule: root.querySelector('.ac-rule').value });
    text.value = '';
    bs.toast(r.approved ? 'Proposta aprovada.' : 'Proposta bloqueada: veja os pareceres.', r.approved ? 'ok' : 'err');
    busy = false; await refresh();
    if (!bs.bubble.isOpen('agents')) bs.bubble.badge('agents', 'dot'); // terminou com a janela fechada: o ponto no balão avisa
  } finally { busy = false; clearInterval(clock); paintHistory(); }
});
function mount(pane) {
  root = pane; pane.classList.add('ac');
  pane.innerHTML = `<form class="ac-form">
      <textarea class="ac-text" id="acText" rows="5" aria-label="Proposta" placeholder="O que você quer decidir? Descreva o contexto e a solução proposta. Os agentes procuram erros e riscos antes de você seguir."></textarea>
      <div class="ac-line"><span class="ac-k">Foco</span><span class="ac-focus" role="group" aria-label="Foco da revisão">${FOCUS.map(([v, l], i) => `<button type="button" data-f="${v}" class="${i ? '' : 'on'}" aria-pressed="${!i}">${l}</button>`).join('')}</span></div>
      <div class="ac-line"><span class="ac-k">Revisores</span><span class="ac-picks"></span><button class="icon-btn ac-cfg" type="button" title="Agentes de IA: modelo, esforço e programas">${GEAR}</button>
        <select class="ac-rule" aria-label="Aprova quando" hidden><option value="all">Todos aprovam</option><option value="majority">A maioria aprova</option></select></div>
      <div class="ac-line"><label class="ac-k" for="acCwd">Pasta</label><input class="ac-cwd" id="acCwd" type="text" spellcheck="false" placeholder="o que eles podem ler (vazio: sua pasta de usuário)">
        <button class="chip primary ac-go" type="submit" title="Ctrl+Enter">${IC.app}<span>Pedir revisão</span></button></div>
    </form>
    <section class="ac-hist"><h4>Revisões<button class="ac-clear" type="button" hidden>Limpar</button></h4><div class="ac-list"></div></section>`;
  pane.querySelector('.ac-cfg').onclick = () => bs.aiClis.open();
  pane.querySelectorAll('.ac-focus button').forEach(b => { b.onclick = () => setFocus(b.dataset.f); });
  pane.querySelector('.ac-clear').onclick = guard(async () => { await post({ action: 'clear' }); await refresh(); bs.toast('Histórico limpo', 'ok'); });
  paintPicks();
  pane.querySelector('.ac-cwd').value = bs.S.project?.path || '';
  pane.querySelector('form').onsubmit = (e) => { e.preventDefault(); submit(); };
  pane.querySelector('.ac-text').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } };
  paintHistory();
}
bs.bubble.register({ id: 'agents', title: 'Conselho de agentes', icon: IC.app, order: 62, width: 640, height: 720, render: mount, show: () => { if (!busy) bs.bubble.badge('agents', null); guard(refresh)(); loadClis(); } });
bs.hooks.on('aiclis:change', (list) => { clis = list; paintPicks(); });
bs.actions.add([{ label: 'Conselho: revisar uma proposta', icon: IC.app, run: () => bs.bubble.open('agents') }]);
// a pasta acompanha o projeto aberto, enquanto o campo não foi mexido à mão
bs.hooks.on('project:select', (p) => { const f = root?.querySelector('.ac-cwd'); if (f && document.activeElement !== f) f.value = p?.path || ''; });
plugin.onUnload(() => clearInterval(clock));
