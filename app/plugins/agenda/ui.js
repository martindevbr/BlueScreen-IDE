/* Agenda: o mês, os próximos dias e lembretes que viram aviso do Windows (e podem rodar um fluxo do Automator).
   Abre pelo rodapé, no meio da tela. Compromissos novos em uma linha ("Reunião amanhã 14h").
   Agendas de fora (Google, Microsoft/Outlook, ou qualquer link ICS) entram só para leitura: o link secreto fica
   guardado cifrado (plugin.secrets), o plugin lê e expande as repetições aqui e manda os próximos compromissos para
   o núcleo, que avisa na hora marcada mesmo com o BlueScreen na bandeja. Quem dispara é o núcleo, a cada 5 s. */
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  app: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'), prev: svg('<path d="M15 6l-6 6 6 6"/>'), next: svg('<path d="M9 6l6 6-6 6"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), undo: svg('<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2"/>'),
  later: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), trash: svg('<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'), more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  repeat: svg('<path d="M17 2l4 4-4 4M3 12V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 12v3a3 3 0 0 1-3 3H3"/>'), flow: svg('<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h5a3 3 0 0 1 3 3v4"/>'),
  pin: svg('<path d="M12 21s-6-5.6-6-10a6 6 0 0 1 12 0c0 4.400-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>'), link: svg('<path d="M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5"/>'),
  bell: svg('<path d="M6 9a6 6 0 0 1 12 0c0 6 2.500 7 2.500 7h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0"/>'), cloud: svg('<path d="M7 18a4.500 4.500 0 0 1-.6-8.960A6 6 0 0 1 18 10.500 3.800 3.800 0 0 1 17.500 18z"/>'),
  sync: svg('<path d="M20 11a8 8 0 0 0-14.900-3M4 4v4h4M4 13a8 8 0 0 0 14.900 3M20 20v-4h-4"/>'), send: svg('<path d="M4 12l16-8-6 16-3-6z"/>'),
};
const esc = bs.esc, DAY = 864e5, MIN = 6e4;
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { bs.toast('Agenda: ' + e.message, 'err'); } };
const post = (body) => bs.api('agenda/events', {}, { method: 'POST', body: JSON.stringify(body) });

// >>> ics
// Leitura de agendas no formato iCalendar (.ics): os compromissos, os fusos e as repetições (RRULE).
// tests/ics.test.js roda este trecho no Node.
function icsCore() {
  const DAY = 864e5;
  // nomes de fuso do Windows (o Outlook usa) para os do IANA (o que o Intl entende)
  const WIN_TZ = { 'E. South America Standard Time': 'America/Sao_Paulo', 'Central Brazilian Standard Time': 'America/Cuiaba', 'SA Eastern Standard Time': 'America/Fortaleza', 'SA Western Standard Time': 'America/Manaus', 'SA Pacific Standard Time': 'America/Bogota',
    'Tocantins Standard Time': 'America/Araguaina', 'Bahia Standard Time': 'America/Bahia', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires', 'Montevideo Standard Time': 'America/Montevideo', 'Paraguay Standard Time': 'America/Asuncion', 'Pacific SA Standard Time': 'America/Santiago',
    'Venezuela Standard Time': 'America/Caracas', 'UTC': 'UTC', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
    'Central European Standard Time': 'Europe/Warsaw', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow', 'Israel Standard Time': 'Asia/Jerusalem', 'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata',
    'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore', 'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney', 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Atlantic Standard Time': 'America/Halifax', 'Central Standard Time (Mexico)': 'America/Mexico_City' };
  const fmts = new Map();
  function fmtOf(tz) {
    if (fmts.has(tz)) return fmts.get(tz);
    let f = null; try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { f = null; }
    fmts.set(tz, f); return f;
  }
  // quanto o fuso está adiantado em relação ao UTC naquele instante (ms)
  function tzOffset(tz, t) {
    const p = {}; for (const x of fmtOf(tz).formatToParts(new Date(t))) p[x.type] = +x.value;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  }
  /** Data "de parede" ({ y, mo, d, h, mi, s }) num fuso -> instante (ms). Sem fuso conhecido, vale o do computador. */
  function wallToMs(w, zone) {
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    if (zone.utc) return guess;
    if (zone.iana) return guess - tzOffset(zone.iana, guess - tzOffset(zone.iana, guess));
    if (zone.offset != null) return guess - zone.offset;
    return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  }
  function zoneOf(tzid, zones) {
    tzid = String(tzid || '').replace(/^\/[^/]+\/[^/]+\//, '').trim(); // "/freeassociation.sourceforge.net/Tzfile/America/Sao_Paulo"
    if (!tzid) return {};
    if (/^(utc|gmt|z)$/i.test(tzid)) return { utc: true };
    if (tzid.includes('/') && fmtOf(tzid)) return { iana: tzid };
    const w = WIN_TZ[tzid]; if (w && fmtOf(w)) return { iana: w };
    if (zones[tzid] != null) return { offset: zones[tzid] };
    return {};
  }
  const unesc = (s) => String(s || '').replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
  // linhas dobradas viram uma; cada uma: NOME;PARAM=valor:conteúdo
  function props(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean).map((l) => {
      let i = 0, q = false; for (; i < l.length; i++) { const c = l[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
      const head = l.slice(0, i).split(';'), params = {};
      for (const p of head.slice(1)) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
      return { name: head[0].toUpperCase(), params, value: l.slice(i + 1) };
    });
  }
  function dateOf(value, params, zones) {
    const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(String(value || '').trim()); if (!m) return null;
    const allDay = m[4] === undefined;
    return { wall: { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) }, allDay, zone: allDay ? {} : m[7] ? { utc: true } : zoneOf(params && params.TZID, zones) };
  }
  // dia inteiro: a meia-noite daqui (o compromisso é "do dia", em qualquer fuso)
  const ms = (d) => (d.allDay ? new Date(d.wall.y, d.wall.mo - 1, d.wall.d).getTime() : wallToMs(d.wall, d.zone));
  function duration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim()); if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1000);
  }
  const offsetOf = (v) => { const m = /^([+-])(\d\d)(\d\d)/.exec(String(v || '').trim()); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 36e5 + +m[3] * 6e4) : null; };
  const plain = (s) => unesc(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  function linkOf(e) {
    const all = [e.url, e.location, e.notes].join(' ').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
    return all.find(u => /teams\.microsoft|meet\.google|zoom\.us|webex|whereby|jit\.si/i.test(u)) || (e.url && /^https?:/i.test(e.url) ? e.url : '') || all[0] || '';
  }
  /** Texto de um .ics -> { name, events: [{ uid, title, start, dur, location, notes, link, rrule, exdates, rid, cancelled }] } */
  function parse(text) {
    const list = props(text);
    if (!list.some(p => p.name === 'BEGIN' && p.value.toUpperCase() === 'VCALENDAR')) throw new Error('o endereço não devolveu uma agenda (.ics)');
    // primeiro os fusos declarados no arquivo (VTIMEZONE): o deslocamento do horário padrão de cada um
    const zones = {}; let tz = null, std = false;
    for (const p of list) {
      const v = p.value.toUpperCase();
      if (p.name === 'BEGIN' && v === 'VTIMEZONE') tz = { id: '', off: null };
      else if (p.name === 'END' && v === 'VTIMEZONE') { if (tz && tz.id && tz.off != null) zones[tz.id] = tz.off; tz = null; }
      else if (tz) { if (p.name === 'TZID') tz.id = p.value.trim(); else if (p.name === 'BEGIN') std = v === 'STANDARD'; else if (p.name === 'TZOFFSETTO' && (std || tz.off == null)) tz.off = offsetOf(p.value); }
    }
    const out = { name: '', events: [] }; let e = null, depth = 0;
    for (const p of list) {
      if (p.name === 'X-WR-CALNAME' && !e) out.name = unesc(p.value).trim();
      if (p.name === 'BEGIN') { if (p.value.toUpperCase() === 'VEVENT' && !e) { e = { uid: '', title: '', start: null, endAt: null, dur: null, location: '', notes: '', url: '', rrule: null, exdates: [], rid: null, cancelled: false }; depth = 0; } else if (e) depth++; continue; }
      if (p.name === 'END') {
        if (e && depth > 0) { depth--; continue; }
        if (e && p.value.toUpperCase() === 'VEVENT') {
          if (e.start) {
            const at = ms(e.start);
            e.dur = e.endAt ? Math.max(0, ms(e.endAt) - at) : e.dur != null ? Math.max(0, e.dur) : e.start.allDay ? DAY : 0;
            e.link = linkOf(e); e.title = e.title || '(sem título)'; e.uid = e.uid || `${at}-${e.title}`;
            delete e.endAt; delete e.url; out.events.push(e);
          }
          e = null;
        }
        continue;
      }
      if (!e || depth > 0) continue; // dentro de um VALARM e parecidos: não é do compromisso
      switch (p.name) {
        case 'UID': e.uid = p.value.trim(); break;
        case 'SUMMARY': e.title = plain(p.value).replace(/\s*\n\s*/g, ' '); break;
        case 'LOCATION': e.location = plain(p.value).replace(/\s*\n\s*/g, ', '); break;
        case 'DESCRIPTION': e.notes = plain(p.value).slice(0, 2000); break;
        case 'URL': e.url = p.value.trim(); break;
        case 'STATUS': e.cancelled = p.value.trim().toUpperCase() === 'CANCELLED'; break;
        case 'DTSTART': e.start = dateOf(p.value, p.params, zones); break;
        case 'DTEND': e.endAt = dateOf(p.value, p.params, zones); break;
        case 'DURATION': e.dur = duration(p.value); break;
        case 'RRULE': e.rrule = Object.fromEntries(p.value.split(';').map(x => { const i = x.indexOf('='); return [x.slice(0, i).toUpperCase(), x.slice(i + 1)]; })); break;
        case 'EXDATE': for (const v of p.value.split(',')) { const d = dateOf(v, p.params, zones); if (d) e.exdates.push(ms(d)); } break;
        case 'RECURRENCE-ID': { const d = dateOf(p.value, p.params, zones); if (d) e.rid = ms(d); break; }
      }
    }
    return out;
  }
  const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const utc = (y, mo, d) => new Date(Date.UTC(y, mo, d)), addDays = (d, n) => new Date(d.getTime() + n * DAY);
  /** As datas de uma repetição (RRULE: DAILY, WEEKLY, MONTHLY, YEARLY com INTERVAL, COUNT, UNTIL, BYDAY e BYMONTHDAY) até `to`. */
  function recur(e, from, to) {
    const r = e.rrule, w0 = e.start.wall, int = Math.max(1, parseInt(r.INTERVAL, 10) || 1), count = parseInt(r.COUNT, 10) || Infinity, out = [];
    let until = Infinity;
    if (r.UNTIL) { const u = dateOf(r.UNTIL, {}, {}); if (u) until = u.allDay ? ms(u) + DAY - 1 : u.zone.utc ? ms(u) : ms({ ...u, zone: e.start.zone }); }
    const byday = String(r.BYDAY || '').split(',').map(x => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim()); return m && WD.includes(m[2]) ? { n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2]) } : null; }).filter(Boolean);
    const bymd = String(r.BYMONTHDAY || '').split(',').map(Number).filter(n => n && Math.abs(n) <= 31);
    const base = utc(w0.y, w0.mo - 1, w0.d), first = ms(e.start);
    const at = (d) => ms({ wall: { ...w0, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }, allDay: e.start.allDay, zone: e.start.zone });
    const inMonth = (y, mo, b) => {
      const days = []; for (let d = utc(y, mo, 1); d.getUTCMonth() === (mo % 12 + 12) % 12; d = addDays(d, 1)) if (d.getUTCDay() === b.wd) days.push(d);
      return b.n === 0 ? days : b.n > 0 ? days.slice(b.n - 1, b.n) : days.slice(days.length + b.n, days.length + b.n + 1 || undefined);
    };
    // sem COUNT, dá para pular direto para perto da janela pedida (uma reunião diária de anos atrás)
    const span = { DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 28 * DAY, YEARLY: 365 * DAY }[r.FREQ]; if (!span) return out;
    let k = count === Infinity ? Math.max(0, Math.floor((from - first) / (span * int)) - 2) : 0, n = 0;
    for (let guard = 0; guard < 20000; guard++, k++) {
      let days;
      if (r.FREQ === 'DAILY') days = [addDays(base, k * int)];
      else if (r.FREQ === 'WEEKLY') { const wk = addDays(base, k * int * 7), mon = addDays(wk, -((wk.getUTCDay() + 6) % 7)); days = (byday.length ? byday.map(b => b.wd) : [base.getUTCDay()]).map(wd => addDays(mon, (wd + 6) % 7)); }
      else if (r.FREQ === 'MONTHLY') {
        const t = w0.mo - 1 + k * int, y = w0.y + Math.floor(t / 12), mo = t % 12;
        days = byday.length ? byday.flatMap(b => inMonth(y, mo, b)) : (bymd.length ? bymd : [w0.d]).map(d => (d > 0 ? utc(y, mo, d) : utc(y, mo + 1, d + 1))).filter(d => d.getUTCMonth() === mo);
      } else { const d = utc(w0.y + k * int, w0.mo - 1, w0.d); days = d.getUTCMonth() === w0.mo - 1 ? [d] : []; }
      days.sort((a, b) => a - b);
      for (const d of days) {
        const t = at(d);
        if (t < first) continue;
        if (t > until || n >= count || t >= to) return out;
        n++; out.push(t);
      }
    }
    return out;
  }
  /** Os compromissos de uma agenda lida (parse) que tocam o intervalo [from, to): cada repetição vira um. */
  function occurrences(parsed, from, to, max = 3000) {
    const out = [], moved = new Map(); // repetições trocadas por uma exceção (RECURRENCE-ID): a original não aparece
    for (const e of parsed.events) if (e.rid != null) { if (!moved.has(e.uid)) moved.set(e.uid, new Set()); moved.get(e.uid).add(e.rid); }
    for (const e of parsed.events) {
      if (e.cancelled) continue;
      const push = (at) => { if (at + Math.max(e.dur, 1) > from && at < to) out.push({ uid: e.uid, at, end: at + e.dur, allDay: e.start.allDay, title: e.title, location: e.location, notes: e.notes, link: e.link }); };
      if (!e.rrule || e.rid != null) { push(ms(e.start)); continue; }
      const ex = new Set(e.exdates), sk = moved.get(e.uid);
      for (const at of recur(e, from - e.dur, to)) { if (!ex.has(at) && !(sk && sk.has(at))) push(at); if (out.length >= max) break; }
      if (out.length >= max) break;
    }
    return out.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
  }
  return { parse, occurrences, wallToMs, props };
}
// <<< ics
const ICS = icsCore();

// >>> texto
// "Reunião com a Ana amanhã 14h30" -> { title, at, repeat }: o dia e a hora saem do texto, o resto é o título.
function quickParse(text, now = new Date()) {
  let s = ' ' + String(text || '').trim() + ' ', day = null, time = null, repeat = 0;
  const cut = (re, fn) => { const m = re.exec(s); if (!m) return false; s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); fn(m); return true; };
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const plus = (n) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  const WEEK = ['domingo', 'segunda', 'ter[cç]a', 'quarta', 'quinta', 'sexta', 's[aá]bado'];
  cut(/\s(todo dia|todos os dias|diariamente)\s/i, () => { repeat = 1440; }) || cut(/\s(toda semana|semanalmente)\s/i, () => { repeat = 10080; }) || cut(/\s(toda hora|a cada hora)\s/i, () => { repeat = 60; });
  // daqui a pouco: "em 20 min", "daqui a 2 horas"
  let rel = null;
  cut(/\s(?:em|daqui a)\s+(\d+)\s*(min(?:utos?)?|h(?:oras?)?|dias?)\s/i, (m) => { const n = +m[1], u = m[2][0].toLowerCase(); rel = new Date(now.getTime() + n * (u === 'm' ? 6e4 : u === 'h' ? 36e5 : 864e5)); });
  cut(/\sdepois de amanh[ãa]\s/i, () => { day = plus(2); }) || cut(/\samanh[ãa]\s/i, () => { day = plus(1); }) || cut(/\shoje\s/i, () => { day = plus(0); });
  if (!day) cut(/\s(?:dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/, (m) => { let y = m[3] ? +m[3] : base.getFullYear(); if (y < 100) y += 2000; day = new Date(y, +m[2] - 1, +m[1]); if (!m[3] && day < base) day = new Date(y + 1, +m[2] - 1, +m[1]); });
  if (!day) cut(/\sdia\s+(\d{1,2})\s/i, (m) => { day = new Date(base.getFullYear(), base.getMonth(), +m[1]); if (day < base) day = new Date(base.getFullYear(), base.getMonth() + 1, +m[1]); });
  if (!day) for (let i = 0; i < 7; i++) if (cut(new RegExp(`\\s(?:n[ao]\\s+|pr[oó]xim[ao]\\s+)?${WEEK[i]}(?:-feira)?\\s`, 'i'), () => { day = plus(((i - base.getDay() + 7) % 7) || 7); })) break;
  cut(/\s(?:[àa]s?\s+)?(\d{1,2})(?::|h)(\d{2})\s*(?:h(?:oras?)?)?\s/i, (m) => { time = [+m[1], +m[2]]; }) || cut(/\s(?:[àa]s?\s+)?(\d{1,2})\s*h(?:oras?)?\s/i, (m) => { time = [+m[1], 0]; }) || cut(/\s[àa]s?\s+(\d{1,2})\s/i, (m) => { time = [+m[1], 0]; })
    || cut(/\s(?:ao\s+)?meio[- ]dia\s/i, () => { time = [12, 0]; }) || cut(/\s(?:de\s+|pela\s+)?manh[ãa]\s/i, () => { time = [9, 0]; }) || cut(/\s(?:de\s+|[àa]\s+)?tarde\s/i, () => { time = [15, 0]; }) || cut(/\s(?:de\s+|[àa]\s+)?noite\s/i, () => { time = [20, 0]; });
  if (time && (time[0] > 23 || time[1] > 59)) time = null;
  const title = s.replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').replace(/\s(?:[àa]s?|em|no|na|dia)$/i, '');
  let at;
  if (rel) at = rel;
  else {
    const d = day || base;
    at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time ? time[0] : 9, time ? time[1] : 0);
    // só a hora, e ela já passou hoje: é amanhã; sem dia nem hora: a próxima hora cheia
    if (!day && time && at <= now) at = new Date(at.getTime() + 864e5);
    if (!day && !time) at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
  }
  return { title, at: at.getTime(), repeat, guessed: !!(day || time || rel) };
}
// <<< texto

// ---------- estado ----------
const G = { events: [], flows: [], cals: [], feeds: new Map(), month: new Date(), day: new Date(), view: 'month', loaded: false, syncing: false };
let root;
const REPEATS = [[0, 'Não repete'], [60, 'A cada hora'], [1440, 'Todo dia'], [10080, 'Toda semana']];
const ALERTS = [[0, 'Na hora'], [5, '5 min antes'], [10, '10 min antes'], [15, '15 min antes'], [30, '30 min antes'], [60, '1 hora antes'], [1440, '1 dia antes']];
const COLORS = ['#4C8DFF', '#3FB37F', '#E3A63A', '#E0617A', '#A78BFA', '#2EC4C6', '#F0884D'];
const KINDS = {
  google: { name: 'Google Agenda', steps: ['No Google Agenda (no computador), abra <b>Configurações</b> e clique na agenda, na lista da esquerda.', 'Desça até <b>Integrar agenda</b>.', 'Copie o <b>Endereço secreto no formato iCal</b> e cole aqui.'], open: 'https://calendar.google.com/calendar/u/0/r/settings', hint: 'https://calendar.google.com/calendar/ical/…/basic.ics' },
  microsoft: { name: 'Microsoft (Outlook)', steps: ['No Outlook na Web, abra <b>Configurações › Calendário › Calendários compartilhados</b>.', 'Em <b>Publicar um calendário</b>, escolha a agenda e <b>Pode exibir todos os detalhes</b>, e clique em Publicar.', 'Copie o link <b>ICS</b> e cole aqui.'], open: 'https://outlook.office.com/calendar/options/calendar/SharedCalendars', hint: 'https://outlook.office365.com/owa/calendar/…/calendar.ics' },
  ics: { name: 'Outra (link ICS)', steps: ['Qualquer agenda que ofereça um link <b>.ics</b> (iCloud, Zoho, Nextcloud, feriados…).', 'Cole o link aqui.'], open: '', hint: 'https://…/agenda.ics' },
};
const repeatText = (m) => !m ? '' : (REPEATS.find(r => r[0] === m)?.[1] || (m % 1440 === 0 ? `A cada ${m / 1440} dias` : m % 60 === 0 ? `A cada ${m / 60} h` : `A cada ${m} min`)).toLowerCase();
const calOf = (id) => G.cals.find(c => c.id === id);

/** Horário do compromisso dentro do dia (o próximo, para os que repetem), ou null se ele não cai nesse dia. */
function occurrence(e, dayStart) {
  const end = dayStart + DAY;
  if (!e.repeat_minutes || e.done) return e.at >= dayStart && e.at < end ? e.at : null;
  if (e.at >= end) return null;
  const step = e.repeat_minutes * MIN, t = e.at + Math.max(0, Math.ceil((dayStart - e.at) / step)) * step;
  return t < end ? t : null;
}
// os de fora, de todas as agendas ligadas, num intervalo
function external(from, to) {
  const out = [];
  for (const c of G.cals) { if (c.on === false) continue; const f = G.feeds.get(c.id); if (!f || !f.parsed) continue; for (const o of ICS.occurrences(f.parsed, from, to)) out.push({ ...o, cal: c.id }); }
  return out;
}
/** Tudo o que cai num dia, em ordem: os de dia inteiro primeiro. Cada item: { at, e (local) | x (de fora) } */
function itemsOn(d) {
  const s = startOf(d);
  const local = G.events.map(e => ({ e, at: occurrence(e, s) })).filter(x => x.at != null);
  const ext = external(s, s + DAY).map(x => ({ x, at: Math.max(x.at, s) }));
  return [...local, ...ext].sort((a, b) => ((b.x && b.x.allDay) ? 1 : 0) - ((a.x && a.x.allDay) ? 1 : 0) || a.at - b.at);
}
// passou do horário, já avisou e ninguém concluiu
const overdue = () => G.events.filter(e => !e.done && !e.repeat_minutes && e.at < Date.now()).sort((a, b) => b.at - a.at);
const until = (t) => { const m = Math.round((t - Date.now()) / MIN); return m < 0 ? '' : m < 1 ? 'agora' : m < 60 ? `em ${m} min` : m < 1440 ? `em ${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : ''; };

function ask(title, text, okLabel) {
  return new Promise((resolve) => {
    let done = false; const finish = (v, box) => { if (done) return; done = true; if (box) box.hidden = true; resolve(v); };
    dialog('agAsk', `<div class="dlg-hd"><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div></div><div class="actions"><button class="chip" data-close>Cancelar</button><button class="chip primary danger" id="agAskOk">${esc(okLabel)}</button></div>`,
      (box) => { box.querySelector('#agAskOk').onclick = () => finish(true, box); box.querySelector('#agAskOk').focus(); });
    const box = document.getElementById('agAsk');
    const mo = new MutationObserver(() => { if (box.hidden) { mo.disconnect(); finish(false); } }); mo.observe(box, { attributes: true, attributeFilter: ['hidden'] });
  });
}

// ---------- dados ----------
async function loadLocal() { G.events = (await bs.api('agenda/events', {}, { quiet: true })).filter(e => !e.calendar); }
async function refresh() {
  await loadLocal();
  // os fluxos só existem com o Automator ligado
  try { G.flows = bs.plugins.list.some(p => p.id === 'automator' && p.enabled) ? await bs.api('automator/flows', {}, { quiet: true }) : []; } catch { G.flows = []; }
  G.loaded = true; paint(); footer();
}
const saveEvent = guard(async (e) => { await post({ event: e }); await refresh(); });
const secretOf = (id) => 'ics-' + id;
async function loadCals() { try { G.cals = (await plugin.data.get('calendars', [])) || []; } catch { G.cals = []; } }
const saveCals = () => plugin.data.set('calendars', G.cals);
/** Lê uma agenda de fora (o link fica no cofre do plugin: a página pede pelo nome, nunca vê o endereço de volta). */
async function fetchCal(c) {
  const f = G.feeds.get(c.id) || {}; G.feeds.set(c.id, f);
  try {
    const r = await plugin.fetch(`{{secret:${secretOf(c.id)}}}`, { timeout: 30000, headers: { Accept: 'text/calendar, text/plain, */*' } });
    if (!r.ok) throw new Error(r.status === 404 ? 'o link não existe mais (404): gere outro na agenda de origem' : r.status === 401 || r.status === 403 ? 'a agenda recusou o acesso: confira se o link é o secreto/publicado' : `a agenda respondeu ${r.status}`);
    f.parsed = ICS.parse(r.text()); f.error = ''; f.at = Date.now(); f.count = f.parsed.events.length;
  } catch (e) { f.error = String(e.message || e).replace(/\{\{secret:[^}]+\}\}:?\s*/g, ''); f.at = Date.now(); }
  return f;
}
// manda ao núcleo os próximos 14 dias de cada agenda de fora: é ele quem avisa, mesmo com a IDE na bandeja
async function pushReminders(c) {
  const f = G.feeds.get(c.id), now = Date.now(), alert = c.alert == null ? 10 : +c.alert;
  const list = c.on === false || alert < 0 || !f || !f.parsed ? [] : ICS.occurrences(f.parsed, now, now + 14 * DAY).filter(o => o.at > now - MIN).slice(0, 300).map(o => ({
    id: `${c.id}:${o.uid}:${o.at}`, title: o.title, notes: '', at: o.allDay ? o.at + 9 * 36e5 : o.at, end: o.end, all_day: o.allDay, location: o.location || '', link: o.link || '', alert_minutes: o.allDay ? 0 : alert }));
  try { await post({ action: 'sync', calendar: c.id, events: list }); } catch { /* fica para a próxima leitura */ }
}
async function syncAll(force) {
  if (G.syncing) return; G.syncing = true; if (root) root.classList.add('ag-syncing');
  try {
    await Promise.all(G.cals.filter(c => c.on !== false).map(async (c) => { const f = G.feeds.get(c.id); if (!force && f && f.parsed && Date.now() - f.at < 9 * MIN) return; await fetchCal(c); await pushReminders(c); }));
  } finally { G.syncing = false; if (root) root.classList.remove('ag-syncing'); }
  paint(); footer();
}

// Rodapé: o próximo compromisso de hoje (seu ou de uma agenda ligada), ou quantos estão atrasados. Um clique abre a Agenda.
function footer() {
  const f = typeof BS !== 'undefined' && BS.footer; if (!f) return;
  const now = Date.now(), late = overdue().length;
  const next = itemsOn(new Date()).filter(i => i.at >= now && !(i.e && i.e.done) && !(i.x && i.x.allDay)), name = (i) => (i.e || i.x).title;
  const day = new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  const text = late ? `${late} ${late === 1 ? 'atrasado' : 'atrasados'}${next[0] ? ` · ${hm(next[0].at)} ${name(next[0])}` : ''}`
    : next[0] ? `${hm(next[0].at)} ${name(next[0])}${next.length > 1 ? ` (+${next.length - 1})` : ''}` : `${day} · nada marcado`;
  f.set('agenda', { icon: IC.app, text, title: 'Agenda: ' + (next.length ? `${next.length} ${next.length === 1 ? 'compromisso' : 'compromissos'} ainda hoje` : 'sem compromissos para o resto do dia'), run: () => bs.bubble.toggle('agenda') });
}
const footerTick = async () => { try { await loadLocal(); footer(); } catch { /* tenta de novo no próximo minuto */ } };

// ---------- enviar um compromisso para o Google ou o Outlook, ou como arquivo .ics ----------
const stamp = (t) => new Date(t).toISOString().replace(/[-:]|\.\d{3}/g, '');
const endOf = (e) => (e.end && e.end > e.at ? e.end : e.at + 30 * MIN);
const googleUrl = (e) => 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${stamp(e.at)}/${stamp(endOf(e))}`, details: e.notes || '', location: e.location || '' });
const outlookUrl = (e, work) => `https://outlook.${work ? 'office' : 'live'}.com/calendar/0/deeplink/compose?` + new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: e.title, startdt: new Date(e.at).toISOString(), enddt: new Date(endOf(e)).toISOString(), body: e.notes || '', location: e.location || '' });
const icsText = (e) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BlueScreen//Agenda//PT', 'BEGIN:VEVENT', `UID:${e.id || Date.now()}@bluescreen`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(e.at)}`, `DTEND:${stamp(endOf(e))}`,
  `SUMMARY:${String(e.title).replace(/([,;\\])/g, '\\$1')}`, ...(e.notes ? [`DESCRIPTION:${String(e.notes).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n')}`] : []), ...(e.location ? [`LOCATION:${String(e.location).replace(/([,;\\])/g, '\\$1')}`] : []),
  ...(e.repeat_minutes === 1440 ? ['RRULE:FREQ=DAILY'] : e.repeat_minutes === 10080 ? ['RRULE:FREQ=WEEKLY'] : e.repeat_minutes === 60 ? ['RRULE:FREQ=HOURLY'] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const saveIcs = guard(async (e) => {
  const name = (String(e.title).normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'compromisso') + '.ics';
  await plugin.files.write('exportados/' + name, icsText(e));
  const info = await bs.api('plugin/info', { plugin: 'agenda' }, { method: 'POST', body: '{}' });
  bs.toast(`${name} gravado: dois cliques nele abrem no Outlook ou na agenda do Windows`, 'ok');
  if (info && info.filesDir) bs.reveal(info.filesDir + '\\exportados\\' + name);
});
const sendMenu = (e) => [
  { label: 'Abrir no Google Agenda', icon: IC.send, action: () => window.open(googleUrl(e), '_blank') },
  { label: 'Abrir no Outlook (conta do trabalho)', icon: IC.send, action: () => window.open(outlookUrl(e, true), '_blank') },
  { label: 'Abrir no Outlook.com', icon: IC.send, action: () => window.open(outlookUrl(e, false), '_blank') },
  { label: 'Gravar como arquivo .ics', icon: IC.link, action: () => saveIcs(e) },
];

// ---------- editar ----------
function editor(ev, preset) {
  const base = ev ? new Date(ev.at) : preset && preset.at ? new Date(preset.at) : new Date(G.day.getFullYear(), G.day.getMonth(), G.day.getDate(), Math.min(23, new Date().getHours() + 1), 0);
  const custom = ev && ev.repeat_minutes && !REPEATS.some(r => r[0] === ev.repeat_minutes);
  const dur = ev && ev.end > ev.at ? Math.round((ev.end - ev.at) / MIN) : 0, alert = ev ? ev.alert_minutes || 0 : 0;
  dialog('agEdit', `<div class="dlg-hd"><div class="dlg-ic">${IC.app}</div><div><h3>${ev ? 'Editar compromisso' : 'Novo compromisso'}</h3><p>O aviso do Windows chega mesmo com o BlueScreen na bandeja.</p></div></div>
    <label class="fld">Título<input id="agTitle" maxlength="200" autocomplete="off"></label>
    <div class="ag-three"><label class="fld">Dia<input id="agDate" type="date"></label><label class="fld">Hora<input id="agTime" type="time"></label>
      <label class="fld">Duração<select id="agDur">${[[0, 'Sem fim'], [15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hora'], [90, '1 h 30'], [120, '2 horas'], [240, '4 horas']].concat(dur && ![0, 15, 30, 45, 60, 90, 120, 240].includes(dur) ? [[dur, dur + ' min']] : []).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label></div>
    <div class="ag-two"><label class="fld">Avisar<select id="agAlert">${ALERTS.concat(ALERTS.some(a => a[0] === alert) ? [] : [[alert, alert + ' min antes']]).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="fld">Repetição<select id="agRep">${REPEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}<option value="-1">Outro intervalo…</option></select></label></div>
    <label class="fld" id="agEveryBox" hidden>Repetir a cada quantos minutos<input id="agEvery" type="number" min="1" max="525600"></label>
    <label class="fld">Onde <small class="pl-help">sala, endereço ou link da reunião</small><input id="agWhere" maxlength="300" autocomplete="off"></label>
    <label class="fld">Notas<textarea id="agNotes" rows="3"></textarea></label>
    ${G.flows.length ? `<label class="fld">Na hora, rodar também<select id="agFlow"><option value="">Nada, só o aviso</option>${G.flows.map(f => `<option value="${esc(f.id)}">Fluxo: ${esc(f.name)}</option>`).join('')}</select></label>` : ''}
    <p class="err" id="agErr"></p>
    <div class="actions">${ev ? `<button class="chip" id="agSend" title="Levar este compromisso para outra agenda">${IC.send}Enviar para…</button>` : ''}<span class="ag-grow"></span><button class="chip" data-close>Cancelar</button><button class="chip primary" id="agSave">Salvar</button></div>`, (box) => {
    const $ = (s) => box.querySelector(s);
    $('#agTitle').value = ev?.title || preset?.title || ''; $('#agDate').value = key(base); $('#agTime').value = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
    $('#agDur').value = String(dur); $('#agAlert').value = String(alert);
    const rep0 = ev ? ev.repeat_minutes : preset?.repeat || 0;
    $('#agRep').value = custom ? '-1' : String(rep0 || 0); $('#agEvery').value = custom ? ev.repeat_minutes : 30; $('#agEveryBox').hidden = !custom;
    $('#agWhere').value = ev?.location || ''; $('#agNotes').value = ev?.notes || ''; if ($('#agFlow')) $('#agFlow').value = ev?.flow_id || '';
    $('#agRep').onchange = () => { $('#agEveryBox').hidden = $('#agRep').value !== '-1'; };
    const read = () => {
      const title = $('#agTitle').value.trim(), at = new Date(`${$('#agDate').value}T${$('#agTime').value}`).getTime();
      const rep = $('#agRep').value === '-1' ? Math.round(+$('#agEvery').value) : +$('#agRep').value, d = +$('#agDur').value, where = $('#agWhere').value.trim();
      if (!title) { $('#agErr').textContent = 'Dê um título ao compromisso.'; $('#agTitle').focus(); return null; }
      if (!Number.isFinite(at)) { $('#agErr').textContent = 'Escolha o dia e a hora.'; return null; }
      if (!Number.isFinite(rep) || rep < 0 || rep > 525600) { $('#agErr').textContent = 'O intervalo vai de 1 a 525600 minutos.'; $('#agEvery').focus(); return null; }
      // mudou o horário (ou é novo): volta a avisar
      const moved = !ev || ev.at !== at || (ev.alert_minutes || 0) !== +$('#agAlert').value;
      return { id: ev?.id || '', title, at, end: d ? at + d * MIN : 0, alert_minutes: +$('#agAlert').value, location: where, link: (/https?:\/\/\S+/.exec(where) || [''])[0], notes: $('#agNotes').value, repeat_minutes: rep, flow_id: $('#agFlow')?.value || null, done: moved ? false : !!ev.done, notified: moved ? false : !!ev.notified };
    };
    const go = async () => {
      const e = read(); if (!e) return;
      $('#agSave').disabled = true;
      try { await post({ event: e }); box.hidden = true; G.day = new Date(e.at); G.month = new Date(e.at); await refresh(); }
      catch (err) { $('#agErr').textContent = err.message; } finally { $('#agSave').disabled = false; }
    };
    $('#agSave').onclick = go;
    if ($('#agSend')) $('#agSend').onclick = () => { const e = read(); if (!e) return; const r = $('#agSend').getBoundingClientRect(); bs.showMenu({ clientX: r.left, clientY: r.top - 150, preventDefault() {}, stopPropagation() {} }, sendMenu(e), e.title); };
    $('#agTitle').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    $('#agTitle').focus();
  });
}

// ---------- agendas de fora ----------
function calendars(adding) {
  const rowOf = (c) => {
    const f = G.feeds.get(c.id) || {}, k = KINDS[c.kind] || KINDS.ics;
    const st = c.on === false ? 'desligada' : f.error ? f.error : f.parsed ? `${f.count} ${f.count === 1 ? 'compromisso' : 'compromissos'} · lida ${bs.ago(f.at)}` : 'lendo…';
    return `<div class="ag-cal-row${f.error && c.on !== false ? ' bad' : ''}" data-id="${esc(c.id)}"><i class="ag-dot" style="background:${esc(c.color)}"></i><div class="ag-cal-tx"><b>${esc(c.name)}</b><small>${esc(k.name)} · ${esc(st)}</small></div>
      <select data-a="alert" title="Aviso do Windows antes de cada compromisso desta agenda" aria-label="Aviso">${[[-1, 'Sem aviso'], ...ALERTS.slice(0, 6)].map(([v, l]) => `<option value="${v}" ${(c.alert == null ? 10 : +c.alert) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="toggle${c.on === false ? '' : ' on'}" data-a="on" role="switch" aria-checked="${c.on !== false}" title="Mostrar esta agenda"><span class="sw"></span></button>
      <button type="button" class="icon-btn" data-a="del" title="Desligar e esquecer o link">${IC.trash}</button></div>`;
  };
  const form = () => {
    const kind = calendars.kind || 'google', k = KINDS[kind];
    return `<div class="ag-cal-new"><div class="seg ag-kinds">${Object.entries(KINDS).map(([id, x]) => `<button type="button" data-kind="${id}" class="${id === kind ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
      <ol class="ag-steps">${k.steps.map(s => `<li>${s}</li>`).join('')}</ol>
      ${k.open ? `<a class="ag-open" href="${esc(k.open)}" target="_blank" rel="noopener">${IC.link}Abrir as configurações do ${esc(k.name)}</a>` : ''}
      <label class="fld">Link da agenda<input id="agUrl" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(k.hint)}"></label>
      <div class="ag-two"><label class="fld">Nome<input id="agCalName" maxlength="60" autocomplete="off" placeholder="${kind === 'ics' ? 'Feriados' : 'Trabalho'}"></label>
        <div class="fld">Cor<div class="ag-colors">${COLORS.map((c, i) => `<button type="button" class="ag-color${i === (G.cals.length % COLORS.length) ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Cor ${i + 1}"></button>`).join('')}</div></div></div>
      <p class="ag-note">${IC.bell}O link vale como uma senha: fica cifrado neste PC e só é usado para ler a agenda. A leitura se repete a cada 10 minutos; compromissos criados aqui não vão para lá.</p>
      <p class="err" id="agCalErr"></p>
      <div class="ag-cal-btns"><button class="chip" id="agCalCancel" type="button">Cancelar</button><button class="chip primary" id="agCalAdd" type="button">Conectar</button></div></div>`;
  };
  dialog('agCals', `<div class="dlg-hd"><div class="dlg-ic">${IC.cloud}</div><div><h3>Agendas conectadas</h3><p>Compromissos do Google e da Microsoft aparecem na Agenda e avisam na hora, só para leitura.</p></div></div>
    ${G.cals.length ? `<div class="ag-cal-list">${G.cals.map(rowOf).join('')}</div>` : adding ? '' : '<p class="ag-cal-none">Nenhuma agenda conectada ainda.</p>'}
    ${adding ? form() : ''}
    <div class="actions">${adding ? '' : `<button class="chip" id="agCalNew">${IC.plus}Conectar uma agenda</button>${G.cals.length ? `<button class="chip" id="agCalSync">${IC.sync}Ler agora</button>` : ''}`}<span class="ag-grow"></span><button class="chip" data-close>Fechar</button></div>`, (box) => {
    const $ = (s) => box.querySelector(s), again = (a) => calendars(a);
    box.querySelectorAll('.ag-cal-row').forEach(r => {
      const c = calOf(r.dataset.id); if (!c) return;
      r.querySelector('[data-a=on]').onclick = guard(async () => { c.on = c.on === false; await saveCals(); if (c.on) await fetchCal(c); await pushReminders(c); paint(); footer(); again(adding); });
      r.querySelector('[data-a=alert]').onchange = guard(async (ev) => { c.alert = +ev.target.value; await saveCals(); await pushReminders(c); });
      r.querySelector('[data-a=del]').onclick = guard(async () => {
        if (!(await ask('Desligar agenda', `"${c.name}" some da Agenda e o link guardado é apagado. Na agenda de origem nada muda.`, 'Desligar'))) return calendars(adding);
        G.cals = G.cals.filter(x => x.id !== c.id); G.feeds.delete(c.id);
        await saveCals(); await plugin.secrets.remove(secretOf(c.id)).catch(() => {}); await post({ action: 'sync', calendar: c.id, events: [] }).catch(() => {});
        paint(); footer(); again(false);
      });
    });
    if ($('#agCalNew')) $('#agCalNew').onclick = () => again(true);
    if ($('#agCalSync')) $('#agCalSync').onclick = guard(async () => { $('#agCalSync').disabled = true; await syncAll(true); again(false); });
    if (!adding) return;
    box.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { calendars.kind = b.dataset.kind; again(true); });
    box.querySelectorAll('.ag-color').forEach(b => b.onclick = () => { box.querySelectorAll('.ag-color').forEach(x => x.classList.toggle('on', x === b)); });
    $('#agCalCancel').onclick = () => again(false);
    $('#agCalAdd').onclick = async () => {
      const err = $('#agCalErr'), kind = calendars.kind || 'google'; let url = $('#agUrl').value.trim().replace(/^webcal:\/\//i, 'https://');
      if (!/^https?:\/\/\S+$/i.test(url)) { err.textContent = 'Cole o link da agenda (começa com https://).'; return $('#agUrl').focus(); }
      const c = { id: 'c' + Date.now().toString(36), name: $('#agCalName').value.trim(), kind, color: box.querySelector('.ag-color.on')?.dataset.color || COLORS[0], on: true, alert: 10 };
      $('#agCalAdd').disabled = true; err.textContent = 'Lendo a agenda…';
      try {
        await plugin.secrets.set(secretOf(c.id), url);
        const f = await fetchCal(c);
        if (f.error || !f.parsed) { await plugin.secrets.remove(secretOf(c.id)).catch(() => {}); G.feeds.delete(c.id); throw new Error(f.error || 'não deu para ler a agenda'); }
        c.name = c.name || f.parsed.name || KINDS[kind].name;
        G.cals.push(c); await saveCals(); await pushReminders(c);
        bs.toast(`${c.name} conectada: ${f.count} ${f.count === 1 ? 'compromisso' : 'compromissos'}`, 'ok'); paint(); footer(); again(false);
      } catch (e) { err.textContent = e.message; $('#agCalAdd').disabled = false; }
    };
    $('#agUrl').focus();
  });
}

// ---------- desenho ----------
function card(i, late) {
  const e = i.e, x = i.x, row = document.createElement('article');
  if (x) {
    const c = calOf(x.cal) || { name: '', color: COLORS[0] }, now = Date.now(), live = !x.allDay && x.at <= now && x.end > now;
    row.className = 'ag-ev ext' + (!x.allDay && x.end <= now ? ' past' : '') + (live ? ' live' : ''); row.style.setProperty('--ag-c', c.color);
    row.innerHTML = `<time>${x.allDay ? 'dia todo' : esc(hm(i.at))}${!x.allDay && x.end > x.at ? `<small>${esc(hm(x.end))}</small>` : ''}</time><div class="ag-ev-tx"><b>${esc(x.title)}</b>
      <small>${live ? '<span class="ag-live">agora</span>' : until(x.at) ? `<span class="ag-soon">${esc(until(x.at))}</span>` : ''}${x.location ? `${IC.pin}<span>${esc(x.location.replace(/https?:\/\/\S+/g, '').replace(/^[\s,;]+|[\s,;]+$/g, '').slice(0, 80) || 'online')}</span>` : ''}<span class="ag-from">${esc(c.name)}</span></small></div>
      <div class="ag-ev-acts">${x.link ? `<a class="chip ag-join" href="${esc(x.link)}" target="_blank" rel="noopener" title="${esc(x.link)}">${IC.link}Abrir</a>` : ''}</div>`;
    if (x.notes) row.title = x.notes.slice(0, 600);
    return row;
  }
  const flow = e.flow_id && G.flows.find(f => f.id === e.flow_id);
  const when = late ? new Date(e.at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm(e.at) : hm(i.at);
  row.className = 'ag-ev' + (e.done ? ' done' : '') + (!e.done && !e.repeat_minutes && e.at < Date.now() ? ' late' : '');
  const soon = !e.done && !late ? until(i.at) : '';
  row.innerHTML = `<time>${esc(when)}${!late && e.end > e.at ? `<small>${esc(hm(i.at + (e.end - e.at)))}</small>` : ''}</time><div class="ag-ev-tx"><b>${esc(e.title)}</b>${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
      <small>${soon ? `<span class="ag-soon">${esc(soon)}</span>` : ''}${e.location ? `${IC.pin}<span>${esc(e.location.replace(/https?:\/\/\S+/g, '').trim().slice(0, 80) || 'online')}</span>` : ''}${e.alert_minutes ? `${IC.bell}<span>${esc((ALERTS.find(a => a[0] === e.alert_minutes) || [0, e.alert_minutes + ' min antes'])[1].toLowerCase())}</span>` : ''}${e.repeat_minutes ? `${IC.repeat}<span>${esc(repeatText(e.repeat_minutes))}${e.done ? ', parado' : ''}</span>` : ''}${flow ? `${IC.flow}<span>${esc(flow.name)}</span>` : ''}</small></div>
    <div class="ag-ev-acts">${e.link ? `<a class="icon-btn" href="${esc(e.link)}" target="_blank" rel="noopener" title="Abrir ${esc(e.link)}">${IC.link}</a>` : ''}<button class="icon-btn" data-a="done" title="${e.repeat_minutes ? (e.done ? 'Voltar a repetir' : 'Parar de repetir') : e.done ? 'Reabrir' : 'Concluir'}">${e.done ? IC.undo : e.repeat_minutes ? IC.pause : IC.ok}</button>${e.done || e.repeat_minutes ? '' : `<button class="icon-btn" data-a="later" title="Adiar">${IC.later}</button>`}<button class="icon-btn" data-a="more" title="Editar, enviar para outra agenda, excluir">${IC.more}</button></div>`;
  const snooze = (ms) => saveEvent({ ...e, at: Date.now() + ms, end: e.end > e.at ? Date.now() + ms + (e.end - e.at) : 0, done: false, notified: false });
  const menuAt = (b, items) => { const r = b.getBoundingClientRect(); bs.showMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, items, e.title); };
  row.querySelector('[data-a=done]').onclick = () => saveEvent({ ...e, done: !e.done });
  const later = row.querySelector('[data-a=later]');
  if (later) later.onclick = () => menuAt(later, [{ label: 'Daqui a 10 minutos', action: () => snooze(10 * MIN) }, { label: 'Daqui a 1 hora', action: () => snooze(60 * MIN) }, { label: 'Amanhã, nesta hora', action: () => snooze(DAY) }]);
  const more = row.querySelector('[data-a=more]');
  more.onclick = () => menuAt(more, [{ label: 'Editar', icon: IC.edit, action: () => editor(e) }, '-', ...sendMenu(e), '-',
    { label: 'Excluir', icon: IC.trash, action: guard(async () => { if (!(await ask('Excluir compromisso', `"${e.title}"${e.repeat_minutes ? ' e todas as repetições dele' : ''} sai da agenda.`, 'Excluir'))) return; await post({ action: 'delete', id: e.id }); await refresh(); }) }]);
  row.ondblclick = (ev) => { if (!ev.target.closest('button, a')) editor(e); };
  return row;
}
const colorOf = (i) => (i.x ? (calOf(i.x.cal) || {}).color : '') || '';
function paintMonth() {
  const y = G.month.getFullYear(), m = G.month.getMonth(), today = key(new Date()), sel = key(G.day);
  const grid = root.querySelector('.ag-grid'); grid.replaceChildren();
  for (const d of ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']) { const h = document.createElement('span'); h.className = 'ag-wd'; h.textContent = d; grid.append(h); }
  // semanas inteiras: os dias do mês vizinho aparecem apagados
  const first = new Date(y, m, 1), from = new Date(y, m, 1 - first.getDay()), cells = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7) * 7;
  for (let i = 0; i < cells; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i), k = key(d), list = itemsOn(d).filter(x => !(x.e && x.e.done));
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'ag-day' + (d.getMonth() !== m ? ' out' : '') + (k === today ? ' today' : '') + (k === sel ? ' selected' : '');
    b.setAttribute('aria-label', `${d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}, ${list.length} compromisso${list.length === 1 ? '' : 's'}`);
    b.innerHTML = `<span class="ag-num">${d.getDate()}</span>${list.slice(0, 3).map(x => `<span class="ag-chip${x.x ? ' ext' : ''}"${x.x ? ` style="--ag-c:${esc(colorOf(x))}"` : ''}>${x.x && x.x.allDay ? '' : `<i>${esc(hm(x.at))}</i>`}${esc((x.e || x.x).title)}</span>`).join('')}${list.length > 3 ? `<span class="ag-more">+${list.length - 3}</span>` : ''}${list.length ? '<i class="ag-pip"></i>' : ''}`;
    b.onclick = () => { G.day = d; if (d.getMonth() !== m) G.month = new Date(d.getFullYear(), d.getMonth(), 1); paint(); };
    b.ondblclick = () => editor(null);
    grid.append(b);
  }
}
// os próximos 14 dias que têm alguma coisa, um bloco por dia
function paintList() {
  const box = root.querySelector('.ag-up'), today = startOf(new Date()), out = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today + i * DAY + 36e5 * 12); const list = itemsOn(d).filter(x => !(x.e && x.e.done) && (i > 0 || (x.x ? x.x.end : x.at) >= Date.now() - 30 * MIN || (x.x && x.x.allDay)));
    if (!list.length) continue;
    const sec = document.createElement('section'); sec.className = 'ag-upday';
    const h = document.createElement('h4'); h.innerHTML = `<b>${i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : esc(d.toLocaleDateString('pt-BR', { weekday: 'long' }))}</b><span>${esc(d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }))}</span>`;
    sec.append(h, ...list.map(x => card(x))); out.push(sec);
  }
  box.replaceChildren(...out);
  if (!out.length) box.innerHTML = `<div class="ag-zero">${IC.app}<b>Nada nos próximos 14 dias</b><span>Escreva um compromisso na linha de cima, ou conecte a agenda do Google ou da Microsoft.</span></div>`;
}
function paint() {
  if (!root) return;
  const today = key(new Date()), sel = key(G.day), list = G.view === 'list';
  root.querySelector('.ag-month').textContent = list ? 'Próximos 14 dias' : G.month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  root.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === G.view));
  root.querySelector('.ag-grid').hidden = list; root.querySelector('.ag-up').hidden = !list;
  root.querySelectorAll('[data-a=prev], [data-a=next], [data-a=today]').forEach(b => { b.hidden = list; });
  if (list) paintList(); else paintMonth();
  const bad = G.cals.filter(c => c.on !== false && (G.feeds.get(c.id) || {}).error).length, cb = root.querySelector('[data-a=cals]');
  cb.classList.toggle('bad', bad > 0); cb.querySelector('span').textContent = G.cals.length ? `${G.cals.length} ${G.cals.length === 1 ? 'agenda' : 'agendas'}` : 'Conectar agenda';
  cb.title = bad ? `${bad} agenda${bad > 1 ? 's' : ''} não respondeu: clique para ver` : 'Agendas do Google e da Microsoft';
  root.querySelector('.ag-daytitle').textContent = sel === today ? 'Hoje' : G.day.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const day = root.querySelector('.ag-daylist'), items = itemsOn(G.day);
  day.replaceChildren(...items.map(x => card(x)));
  if (!items.length) day.innerHTML = `<p class="ag-none">${G.loaded ? 'Nada marcado neste dia.' : 'Carregando…'}</p>`;
  const late = overdue().filter(e => key(new Date(e.at)) !== sel), box = root.querySelector('.ag-late');
  box.hidden = !late.length;
  root.querySelector('.ag-latelist').replaceChildren(...late.map(e => card({ e, at: e.at }, true)));
}

function mount(pane) {
  root = pane; pane.classList.add('ag');
  pane.innerHTML = `<div class="ag-grid2"><section class="ag-cal">
      <header class="ag-bar"><b class="ag-month"></b><span class="ag-sp"></span>
        <span class="seg ag-views"><button type="button" data-view="month">Mês</button><button type="button" data-view="list">Próximos</button></span>
        <button class="chip" data-a="today" type="button">Hoje</button><button class="icon-btn" data-a="prev" type="button" title="Mês anterior">${IC.prev}</button><button class="icon-btn" data-a="next" type="button" title="Próximo mês">${IC.next}</button>
        <button class="chip ag-calbtn" data-a="cals" type="button">${IC.cloud}<span>Conectar agenda</span></button></header>
      <div class="ag-grid"></div><div class="ag-up" hidden></div>
    </section>
    <section class="ag-side">
      <form class="ag-quick" autocomplete="off"><span class="ag-qi">${IC.plus}</span><input name="q" maxlength="200" placeholder="Novo: Reunião amanhã 14h" aria-label="Novo compromisso, com o dia e a hora no texto" spellcheck="false"><button class="icon-btn" type="button" data-a="new" title="Abrir o formulário completo">${IC.edit}</button></form>
      <p class="ag-qhint" hidden></p>
      <header class="ag-bar ag-dayhd"><b class="ag-daytitle"></b></header>
      <div class="ag-scroll"><div class="ag-daylist"></div><div class="ag-late" hidden><h4>Passaram do horário</h4><div class="ag-latelist"></div></div></div>
    </section></div>`;
  const move = (n) => { G.month = new Date(G.month.getFullYear(), G.month.getMonth() + n, 1); paint(); };
  const q = pane.querySelector('.ag-quick input'), hint = pane.querySelector('.ag-qhint');
  const acts = { prev: () => move(-1), next: () => move(1), today: () => { G.day = new Date(); G.month = new Date(); paint(); }, cals: () => calendars(!G.cals.length),
    new: () => { const p = q.value.trim() ? quickParse(q.value) : null; q.value = ''; hint.hidden = true; editor(null, p && { title: p.title, at: p.at, repeat: p.repeat }); } };
  pane.addEventListener('click', (e) => { const v = e.target.closest('[data-view]'); if (v) { G.view = v.dataset.view; bs.store.set('agView', G.view); return paint(); } const b = e.target.closest('[data-a]'); if (b && acts[b.dataset.a]) acts[b.dataset.a](); });
  // a linha de cima: enquanto você escreve, mostra o que entendeu; Enter grava
  const fmtWhen = (t) => { const d = new Date(t), k = key(d); return (k === key(new Date()) ? 'hoje' : k === key(new Date(Date.now() + DAY)) ? 'amanhã' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '')) + ' às ' + hm(t); };
  q.oninput = () => { const v = q.value.trim(); if (!v) { hint.hidden = true; return; } const p = quickParse(v); hint.hidden = false; hint.innerHTML = p.title ? `<b>${esc(p.title)}</b> · ${esc(fmtWhen(p.at))}${p.repeat ? ' · ' + esc(repeatText(p.repeat)) : ''} <kbd>Enter</kbd>` : 'Escreva o que é, e quando: <i>Dentista sexta 15h</i>'; };
  pane.querySelector('.ag-quick').onsubmit = guard(async (ev) => {
    ev.preventDefault(); const p = quickParse(q.value); if (!p.title) return q.focus();
    await post({ event: { id: '', title: p.title, at: p.at, notes: '', repeat_minutes: p.repeat, flow_id: null, done: false, notified: false } });
    q.value = ''; hint.hidden = true; G.day = new Date(p.at); G.month = new Date(p.at); bs.toast(`${p.title}: ${fmtWhen(p.at)}`, 'ok'); await refresh();
  });
  G.view = bs.store.get('agView', 'month') === 'list' ? 'list' : 'month';
  paint();
}
bs.bubble.register({ id: 'agenda', title: 'Agenda', footer: true, icon: IC.app, order: 61, width: 1040, height: 700, render: mount, show: guard(async () => { await refresh(); syncAll(false); }) });
bs.actions.add([{ label: 'Agenda: compromissos e lembretes', icon: IC.app, run: () => bs.bubble.open('agenda') }, { label: 'Agenda: conectar Google ou Microsoft', icon: IC.cloud, run: () => { bs.bubble.open('agenda'); calendars(true); } }]);

// ao abrir a IDE: o rodapé, as agendas de fora e os lembretes delas; depois, o rodapé a cada minuto e as agendas a cada 10
(async () => { await loadCals(); await footerTick(); if (G.cals.length) syncAll(true); })();
const footerClock = setInterval(footerTick, 60000), feedClock = setInterval(() => { if (G.cals.length && !document.hidden) syncAll(false); }, 10 * MIN);
// um lembrete que disparou muda de estado sozinho: a janela aberta acompanha
const timer = setInterval(() => { if (root?.isConnected && bs.bubble.isOpen('agenda') && document.getElementById('agEdit')?.hidden !== false && document.getElementById('agCals')?.hidden !== false && document.activeElement?.name !== 'q') refresh().catch(() => {}); }, 15000);
plugin.onUnload(() => { clearInterval(timer); clearInterval(footerClock); clearInterval(feedClock); typeof BS !== 'undefined' && BS.footer && BS.footer.remove('agenda'); for (const id of ['agEdit', 'agAsk', 'agCals']) document.getElementById(id)?.remove(); });
