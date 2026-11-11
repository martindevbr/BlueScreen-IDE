/* Agenda: calendário do mês, compromissos do dia e lembretes que viram aviso do Windows (e podem rodar um fluxo
   do Automator). Quem dispara é o núcleo, a cada 5 s, inclusive com o BlueScreen na bandeja. */
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  app: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'), prev: svg('<path d="M15 6l-6 6 6 6"/>'), next: svg('<path d="M9 6l6 6-6 6"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), undo: svg('<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2"/>'),
  later: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), trash: svg('<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  repeat: svg('<path d="M17 2l4 4-4 4M3 12V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 12v3a3 3 0 0 1-3 3H3"/>'), flow: svg('<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h5a3 3 0 0 1 3 3v4"/>'),
};
const esc = bs.esc, DAY = 864e5, MIN = 6e4;
const G = { events: [], flows: [], month: new Date(), day: new Date(), loaded: false };
let root;
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { bs.toast('Agenda: ' + e.message, 'err'); } };
const post = (body) => bs.api('agenda/events', {}, { method: 'POST', body: JSON.stringify(body) });
const REPEATS = [[0, 'Não repete'], [60, 'A cada hora'], [1440, 'Todo dia'], [10080, 'Toda semana']];
const repeatText = (m) => !m ? '' : (REPEATS.find(r => r[0] === m)?.[1] || (m % 1440 === 0 ? `A cada ${m / 1440} dias` : m % 60 === 0 ? `A cada ${m / 60} h` : `A cada ${m} min`)).toLowerCase();

/** Horário do compromisso dentro do dia (o próximo, para os que repetem), ou null se ele não cai nesse dia. */
function occurrence(e, dayStart) {
  const end = dayStart + DAY;
  if (!e.repeat_minutes || e.done) return e.at >= dayStart && e.at < end ? e.at : null;
  if (e.at >= end) return null;
  const step = e.repeat_minutes * MIN, t = e.at + Math.max(0, Math.ceil((dayStart - e.at) / step)) * step;
  return t < end ? t : null;
}
const eventsOn = (d) => { const s = startOf(d); return G.events.map(e => ({ e, at: occurrence(e, s) })).filter(x => x.at != null).sort((a, b) => a.at - b.at); };
// passou do horário, já avisou e ninguém concluiu
const overdue = () => G.events.filter(e => !e.done && !e.repeat_minutes && e.at < Date.now()).sort((a, b) => b.at - a.at);

function ask(title, text, okLabel) {
  return new Promise((resolve) => {
    let done = false; const finish = (v, box) => { if (done) return; done = true; if (box) box.hidden = true; resolve(v); };
    dialog('agAsk', `<div class="dlg-hd"><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div></div><div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary danger" id="agAskOk">${esc(okLabel)}</button></div>`,
      (box) => { box.querySelector('#agAskOk').onclick = () => finish(true, box); box.querySelector('#agAskOk').focus(); });
    const box = document.getElementById('agAsk');
    const mo = new MutationObserver(() => { if (box.hidden) { mo.disconnect(); finish(false); } }); mo.observe(box, { attributes: true, attributeFilter: ['hidden'] });
  });
}

async function refresh() {
  G.events = await bs.api('agenda/events', {}, { quiet: true });
  // os fluxos só existem com o Automator ligado
  try { G.flows = bs.plugins.list.some(p => p.id === 'automator' && p.enabled) ? await bs.api('automator/flows', {}, { quiet: true }) : []; } catch { G.flows = []; }
  G.loaded = true; paint();
}
const saveEvent = guard(async (e) => { await post({ event: e }); await refresh(); });

function editor(ev) {
  const base = ev ? new Date(ev.at) : new Date(G.day.getFullYear(), G.day.getMonth(), G.day.getDate(), Math.min(23, new Date().getHours() + 1), 0);
  const custom = ev && ev.repeat_minutes && !REPEATS.some(r => r[0] === ev.repeat_minutes);
  dialog('agEdit', `<div class="dlg-hd"><div class="dlg-ic">${IC.app}</div><div><h3>${ev ? 'Editar compromisso' : 'Novo compromisso'}</h3><p>Na hora marcada chega um aviso do Windows.</p></div></div>
    <label class="fld">Título<input id="agTitle" maxlength="200" autocomplete="off"></label>
    <div class="ag-two"><label class="fld">Dia<input id="agDate" type="date"></label><label class="fld">Hora<input id="agTime" type="time"></label></div>
    <label class="fld">Repetição<select id="agRep">${REPEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}<option value="-1">Outro intervalo…</option></select></label>
    <label class="fld" id="agEveryBox" hidden>Repetir a cada quantos minutos<input id="agEvery" type="number" min="1" max="525600"></label>
    <label class="fld">Notas<textarea id="agNotes" rows="3"></textarea></label>
    ${G.flows.length ? `<label class="fld">Na hora, rodar também<select id="agFlow"><option value="">Nada, só o aviso</option>${G.flows.map(f => `<option value="${esc(f.id)}">Fluxo: ${esc(f.name)}</option>`).join('')}</select></label>` : ''}
    <p class="err" id="agErr"></p>
    <div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary" id="agSave">Salvar</button></div>`, (box) => {
    const $ = (s) => box.querySelector(s);
    $('#agTitle').value = ev?.title || ''; $('#agDate').value = key(base); $('#agTime').value = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
    $('#agRep').value = custom ? '-1' : String(ev?.repeat_minutes || 0); $('#agEvery').value = custom ? ev.repeat_minutes : 30; $('#agEveryBox').hidden = !custom;
    $('#agNotes').value = ev?.notes || ''; if ($('#agFlow')) $('#agFlow').value = ev?.flow_id || '';
    $('#agRep').onchange = () => { $('#agEveryBox').hidden = $('#agRep').value !== '-1'; };
    const go = async () => {
      const title = $('#agTitle').value.trim(), at = new Date(`${$('#agDate').value}T${$('#agTime').value}`).getTime();
      const rep = $('#agRep').value === '-1' ? Math.round(+$('#agEvery').value) : +$('#agRep').value;
      if (!title) { $('#agErr').textContent = 'Dê um título ao compromisso.'; return $('#agTitle').focus(); }
      if (!Number.isFinite(at)) { $('#agErr').textContent = 'Escolha o dia e a hora.'; return; }
      if (!Number.isFinite(rep) || rep < 0 || rep > 525600) { $('#agErr').textContent = 'O intervalo vai de 1 a 525600 minutos.'; return $('#agEvery').focus(); }
      $('#agSave').disabled = true;
      try {
        // mudou o horário (ou é novo): volta a avisar
        const moved = !ev || ev.at !== at;
        await post({ event: { id: ev?.id || '', title, at, notes: $('#agNotes').value, repeat_minutes: rep, flow_id: $('#agFlow')?.value || null, done: moved ? false : !!ev.done, notified: moved ? false : !!ev.notified } });
        box.hidden = true; G.day = new Date(at); G.month = new Date(at); await refresh();
      } catch (e) { $('#agErr').textContent = e.message; } finally { $('#agSave').disabled = false; }
    };
    $('#agSave').onclick = go;
    $('#agTitle').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    $('#agTitle').focus();
  });
}

function card(e, at, late) {
  const flow = e.flow_id && G.flows.find(f => f.id === e.flow_id);
  const when = late ? new Date(e.at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm(e.at) : hm(at);
  const row = document.createElement('article');
  row.className = 'ag-ev' + (e.done ? ' done' : '') + (!e.done && !e.repeat_minutes && e.at < Date.now() ? ' late' : '');
  row.innerHTML = `<time>${esc(when)}</time><div class="ag-ev-tx"><b>${esc(e.title)}</b>${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
      <small>${[e.repeat_minutes ? `${IC.repeat}<span>${esc(repeatText(e.repeat_minutes))}${e.done ? ', parado' : ''}</span>` : '', flow ? `${IC.flow}<span>${esc(flow.name)}</span>` : ''].join('')}</small></div>
    <div class="ag-ev-acts"><button class="icon-btn" data-a="done" title="${e.repeat_minutes ? (e.done ? 'Voltar a repetir' : 'Parar de repetir') : e.done ? 'Reabrir' : 'Concluir'}">${e.done ? IC.undo : e.repeat_minutes ? IC.pause : IC.ok}</button>${e.done || e.repeat_minutes ? '' : `<button class="icon-btn" data-a="later" title="Adiar">${IC.later}</button>`}<button class="icon-btn" data-a="edit" title="Editar">${IC.edit}</button><button class="icon-btn" data-a="del" title="Excluir">${IC.trash}</button></div>`;
  const snooze = (ms) => saveEvent({ ...e, at: Date.now() + ms, done: false, notified: false });
  row.querySelector('[data-a=done]').onclick = () => saveEvent({ ...e, done: !e.done });
  const later = row.querySelector('[data-a=later]');
  if (later) later.onclick = (ev) => { const r = later.getBoundingClientRect(); bs.showMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [{ label: 'Daqui a 10 minutos', action: () => snooze(10 * MIN) }, { label: 'Daqui a 1 hora', action: () => snooze(60 * MIN) }, { label: 'Amanhã, nesta hora', action: () => snooze(DAY) }]); };
  row.querySelector('[data-a=edit]').onclick = () => editor(e);
  row.querySelector('[data-a=del]').onclick = guard(async () => { if (!(await ask('Excluir compromisso', `"${e.title}"${e.repeat_minutes ? ' e todas as repetições dele' : ''} sai da agenda.`, 'Excluir'))) return; await post({ action: 'delete', id: e.id }); await refresh(); });
  return row;
}

function paint() {
  if (!root) return;
  const y = G.month.getFullYear(), m = G.month.getMonth(), today = key(new Date()), sel = key(G.day);
  root.querySelector('.ag-month').textContent = G.month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const grid = root.querySelector('.ag-grid'); grid.replaceChildren();
  for (const d of ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']) { const h = document.createElement('span'); h.className = 'ag-wd'; h.textContent = d; grid.append(h); }
  // semanas inteiras: os dias do mês vizinho aparecem apagados
  const first = new Date(y, m, 1), from = new Date(y, m, 1 - first.getDay()), cells = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7) * 7;
  for (let i = 0; i < cells; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i), k = key(d), list = eventsOn(d).filter(x => !x.e.done);
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'ag-day' + (d.getMonth() !== m ? ' out' : '') + (k === today ? ' today' : '') + (k === sel ? ' selected' : '');
    b.setAttribute('aria-label', `${d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}, ${list.length} compromisso${list.length === 1 ? '' : 's'}`);
    b.innerHTML = `<span class="ag-num">${d.getDate()}</span>${list.slice(0, 2).map(x => `<span class="ag-chip">${esc(x.e.title)}</span>`).join('')}${list.length > 2 ? `<span class="ag-more">+${list.length - 2}</span>` : ''}${list.length ? '<i class="ag-pip"></i>' : ''}`;
    b.onclick = () => { G.day = d; if (d.getMonth() !== m) G.month = new Date(d.getFullYear(), d.getMonth(), 1); paint(); };
    b.ondblclick = () => editor(null);
    grid.append(b);
  }
  root.querySelector('.ag-daytitle').textContent = sel === today ? 'Hoje' : G.day.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const day = root.querySelector('.ag-daylist'), list = eventsOn(G.day);
  day.replaceChildren(...list.map(x => card(x.e, x.at)));
  if (!list.length) day.innerHTML = `<p class="ag-none">${G.loaded ? 'Nada marcado neste dia.' : 'Carregando…'}</p>`;
  const late = overdue().filter(e => key(new Date(e.at)) !== sel), box = root.querySelector('.ag-late');
  box.hidden = !late.length;
  root.querySelector('.ag-latelist').replaceChildren(...late.map(e => card(e, e.at, true)));
}

function mount(pane) {
  root = pane; pane.classList.add('ag');
  pane.innerHTML = `<div class="ag-grid2"><section class="ag-cal">
      <header class="ag-bar"><b class="ag-month"></b><span class="ag-sp"></span><button class="chip" data-a="today" type="button">Hoje</button><button class="icon-btn" data-a="prev" type="button" title="Mês anterior">${IC.prev}</button><button class="icon-btn" data-a="next" type="button" title="Próximo mês">${IC.next}</button></header>
      <div class="ag-grid"></div>
    </section>
    <section class="ag-side">
      <header class="ag-bar"><b class="ag-daytitle"></b><span class="ag-sp"></span><button class="chip primary" data-a="new" type="button">${IC.plus}<span>Novo</span></button></header>
      <div class="ag-scroll"><div class="ag-daylist"></div><div class="ag-late" hidden><h4>Passaram do horário</h4><div class="ag-latelist"></div></div></div>
    </section></div>`;
  const move = (n) => { G.month = new Date(G.month.getFullYear(), G.month.getMonth() + n, 1); paint(); };
  const acts = { prev: () => move(-1), next: () => move(1), today: () => { G.day = new Date(); G.month = new Date(); paint(); }, new: () => editor(null) };
  pane.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b && acts[b.dataset.a]) acts[b.dataset.a](); });
  paint();
}
bs.bubble.register({ id: 'agenda', title: 'Agenda', icon: IC.app, order: 61, width: 960, height: 680, render: mount, show: guard(refresh) });
bs.actions.add([{ label: 'Agenda: compromissos e lembretes', icon: IC.app, run: () => bs.bubble.open('agenda') }]);
// um lembrete que disparou muda de estado sozinho: a janela aberta acompanha
const timer = setInterval(() => { if (root?.isConnected && bs.bubble.isOpen('agenda') && document.getElementById('agEdit')?.hidden !== false) refresh().catch(() => {}); }, 15000);
plugin.onUnload(() => { clearInterval(timer); document.getElementById('agEdit')?.remove(); document.getElementById('agAsk')?.remove(); });
