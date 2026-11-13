// Testes do leitor de agendas (.ics) e do "compromisso em uma linha" do plugin Agenda, sem a IDE:
//   node app/plugins/agenda/tests/ics.test.js
// Rodam os trechos entre "// >>> ics" / "// <<< ics" e "// >>> texto" / "// <<< texto" do ui.js.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
process.env.TZ = 'America/Sao_Paulo';
const src = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); assert(i >= 0 && j > i, 'marcas ' + a); return src.slice(i, j); };
const ICS = new Function(cut('// >>> ics', '// <<< ics') + '\nreturn icsCore();')();
const quickParse = new Function(cut('// >>> texto', '// <<< texto') + '\nreturn quickParse;')();

const tests = []; const test = (n, f) => tests.push([n, f]);
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const cal = (...ev) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Trabalho', ...ev.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (...l) => ['BEGIN:VEVENT', ...l, 'END:VEVENT'];
const when = (o) => o.map(x => new Date(x.at).toLocaleString('sv-SE').slice(0, 16));

test('compromisso simples em UTC, com lugar e link', () => {
  const p = ICS.parse(cal(ev('UID:1', 'SUMMARY:Reunião\\, com a Ana', 'DTSTART:20261116T170000Z', 'DTEND:20261116T180000Z', 'LOCATION:Sala 2', 'DESCRIPTION:Pauta\\nhttps://meet.google.com/abc-defg-hij')));
  assert.strictEqual(p.name, 'Trabalho');
  const o = ICS.occurrences(p, at(2026, 11, 16), at(2026, 11, 17));
  assert.strictEqual(o.length, 1);
  assert.deepStrictEqual([o[0].title, o[0].location, o[0].link, o[0].allDay], ['Reunião, com a Ana', 'Sala 2', 'https://meet.google.com/abc-defg-hij', false]);
  assert.deepStrictEqual(when(o), ['2026-11-16 14:00']); // 17h UTC = 14h em São Paulo
  assert.strictEqual(o[0].end - o[0].at, 36e5);
});

test('fuso pelo nome do IANA e pelo nome do Windows (Outlook)', () => {
  const p = ICS.parse(cal(
    ev('UID:a', 'SUMMARY:Lisboa', 'DTSTART;TZID=Europe/Lisbon:20261116T150000', 'DTEND;TZID=Europe/Lisbon:20261116T153000'),
    ev('UID:b', 'SUMMARY:Outlook', 'DTSTART;TZID="E. South America Standard Time":20261116T093000', 'DTEND;TZID="E. South America Standard Time":20261116T100000')));
  const o = ICS.occurrences(p, at(2026, 11, 16), at(2026, 11, 17));
  assert.deepStrictEqual(o.map(x => x.title + ' ' + when([x])[0].slice(11)), ['Outlook 09:30', 'Lisboa 12:00']);
});

test('fuso só declarado no arquivo (VTIMEZONE)', () => {
  const p = ICS.parse(cal(['BEGIN:VTIMEZONE', 'TZID:Fuso da Empresa', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE'],
    ev('UID:z', 'SUMMARY:X', 'DTSTART;TZID=Fuso da Empresa:20261116T100000')));
  assert.deepStrictEqual(when(ICS.occurrences(p, at(2026, 11, 16), at(2026, 11, 17))), ['2026-11-16 12:00']); // 10h em UTC-5 = 12h em UTC-3
});

test('dia inteiro e linha dobrada', () => {
  const p = ICS.parse(cal(ev('UID:d', 'SUMMARY:Feriado da Procla', ' mação', 'DTSTART;VALUE=DATE:20261115', 'DTEND;VALUE=DATE:20261116')));
  const o = ICS.occurrences(p, at(2026, 11, 15), at(2026, 11, 16));
  assert.deepStrictEqual([o[0].title, o[0].allDay, when(o)[0]], ['Feriado da Proclamação', true, '2026-11-15 00:00']);
  assert.strictEqual(ICS.occurrences(p, at(2026, 11, 16), at(2026, 11, 17)).length, 0);
});

test('repetição semanal com BYDAY, exceção (EXDATE) e fim (UNTIL)', () => {
  const p = ICS.parse(cal(ev('UID:r', 'SUMMARY:Daily', 'DTSTART;TZID=America/Sao_Paulo:20261102T093000', 'DTEND;TZID=America/Sao_Paulo:20261102T094500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261114T030000Z', 'EXDATE;TZID=America/Sao_Paulo:20261106T093000')));
  assert.deepStrictEqual(when(ICS.occurrences(p, at(2026, 11, 1), at(2026, 12, 1))), ['2026-11-02 09:30', '2026-11-04 09:30', '2026-11-09 09:30', '2026-11-11 09:30', '2026-11-13 09:30']);
});

test('repetições diária com COUNT, mensal pela 2ª terça e anual', () => {
  const d = ICS.parse(cal(ev('UID:c', 'SUMMARY:C', 'DTSTART:20261110T120000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3')));
  assert.deepStrictEqual(when(ICS.occurrences(d, at(2026, 11, 1), at(2026, 12, 1))), ['2026-11-10 09:00', '2026-11-12 09:00', '2026-11-14 09:00']);
  const m = ICS.parse(cal(ev('UID:m', 'SUMMARY:M', 'DTSTART;TZID=America/Sao_Paulo:20260113T100000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU')));
  assert.deepStrictEqual(when(ICS.occurrences(m, at(2026, 11, 1), at(2027, 1, 1))), ['2026-11-10 10:00', '2026-12-08 10:00']);
  const y = ICS.parse(cal(ev('UID:y', 'SUMMARY:Aniversário', 'DTSTART;VALUE=DATE:20200229', 'RRULE:FREQ=YEARLY')));
  assert.deepStrictEqual(when(ICS.occurrences(y, at(2023, 1, 1), at(2029, 1, 1))), ['2024-02-29 00:00', '2028-02-29 00:00']);
});

test('uma repetição movida (RECURRENCE-ID) e compromisso cancelado', () => {
  const p = ICS.parse(cal(
    ev('UID:s', 'SUMMARY:Semanal', 'DTSTART:20261102T130000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ev('UID:s', 'SUMMARY:Semanal (mudou)', 'RECURRENCE-ID:20261109T130000Z', 'DTSTART:20261110T150000Z'),
    ev('UID:x', 'SUMMARY:Cancelado', 'DTSTART:20261103T130000Z', 'STATUS:CANCELLED')));
  assert.deepStrictEqual(ICS.occurrences(p, at(2026, 11, 1), at(2026, 12, 1)).map(o => o.title + ' ' + when([o])[0].slice(5)), ['Semanal 11-02 10:00', 'Semanal (mudou) 11-10 12:00', 'Semanal 11-16 10:00']);
});

test('o que não é uma agenda dá erro; alarme dentro do compromisso não confunde', () => {
  assert.throws(() => ICS.parse('<html>login</html>'), /agenda/);
  const p = ICS.parse(cal(ev('UID:v', 'SUMMARY:Com alarme', 'DTSTART:20261116T170000Z', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DESCRIPTION:Lembrete', 'END:VALARM')));
  assert.deepStrictEqual([p.events.length, p.events[0].title, p.events[0].notes], [1, 'Com alarme', '']);
});

test('compromisso em uma linha', () => {
  const now = new Date(2026, 10, 13, 10, 20); // sexta, 13/11/2026, 10:20
  const q = (t) => { const r = quickParse(t, now); return [r.title, new Date(r.at).toLocaleString('sv-SE').slice(0, 16), r.repeat]; };
  assert.deepStrictEqual(q('Reunião com a Ana amanhã 14h30'), ['Reunião com a Ana', '2026-11-14 14:30', 0]);
  assert.deepStrictEqual(q('Dentista sexta às 15h'), ['Dentista', '2026-11-20 15:00', 0]); // hoje é sexta: a próxima
  assert.deepStrictEqual(q('Ligar para o banco segunda-feira 9:15'), ['Ligar para o banco', '2026-11-16 09:15', 0]);
  assert.deepStrictEqual(q('Pagar boleto dia 25'), ['Pagar boleto', '2026-11-25 09:00', 0]);
  assert.deepStrictEqual(q('Entrega 02/12 às 18h'), ['Entrega', '2026-12-02 18:00', 0]);
  assert.deepStrictEqual(q('Tomar água em 30 min'), ['Tomar água', '2026-11-13 10:50', 0]);
  assert.deepStrictEqual(q('Standup todo dia 9h30'), ['Standup', '2026-11-14 09:30', 1440]); // 9h30 de hoje já passou
  assert.deepStrictEqual(q('Almoço hoje ao meio-dia'), ['Almoço', '2026-11-13 12:00', 0]);
  assert.deepStrictEqual(q('Revisar o PR'), ['Revisar o PR', '2026-11-13 11:00', 0]); // sem dia nem hora: a próxima hora cheia
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok    ' + name); }
    catch (err) { fail++; console.log('FALHA ' + name + '\n' + (err && err.stack || err)); }
  }
  console.log(`\n${tests.length - fail} de ${tests.length} passaram`);
  process.exit(fail ? 1 : 0);
})();
