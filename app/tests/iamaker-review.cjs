// Exercita o ponto de aplicação do plugin com os serviços da IDE simulados.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugins/iamaker/ui.js'), 'utf8');
const applySource = source.slice(source.indexOf('async function apply() {'), source.indexOf('// botões das mensagens'));

async function attempt(decision, changed = false, cfg = { reviewBeforeApply: true }, agents = true) {
  let loaded = 0, fixes = 0, asked = 0;
  const context = {
    M: { id: 'demo', cfg, conv: { msgs: [] }, place: 'outro' }, IN: {},
    $: () => ({ hidden: false }), entry: () => null, stamp: async () => ({}), changed: () => changed,
    pdir: () => 'D:\\plugin', busy() {}, push() {}, saveConv: async () => {},
    api: async route => { assert.equal(route, 'agents/reviews'); asked++; return decision; },
    broken: () => { fixes++; }, reveal: async () => true,
    addEventListener() {}, removeEventListener() {}, setTimeout() {},
    bs: { bubble: { badge() {} }, plugins: { list: agents ? [{ id: 'agents', enabled: true }] : [], reload: async () => { loaded++; return { enabled: true, ui: true, name: 'Demo', version: '1' }; } } },
  };
  vm.createContext(context); vm.runInContext(applySource, context); await context.apply();
  return { loaded, fixes, asked, pending: context.M.pending };
}

(async () => {
  assert.equal((await attempt({ approved: true, reviews: [] })).loaded, 1);
  let result = await attempt({ approved: false, reviews: [{ provider: 'codex', result: { reason: 'Corrigir o plugin' } }] });
  assert.equal(result.loaded, 0); assert.equal(result.fixes, 1);
  result = await attempt({ approved: false, reviews: [{ provider: 'codex', error: 'Login necessário' }] });
  assert.equal(result.loaded, 0); assert.equal(result.fixes, 0); assert(result.pending);
  result = await attempt({ approved: true, reviews: [] }, true);
  assert.equal(result.loaded, 0); assert(result.pending);
  // revisão desligada (o padrão): carrega direto, sem chamar os agentes
  result = await attempt({ approved: false, reviews: [] }, false, {});
  assert.equal(result.loaded, 1); assert.equal(result.asked, 0);
  // revisão ligada com o plugin Conselho de agentes desligado: não carrega e não fica preso
  result = await attempt({ approved: true, reviews: [] }, false, { reviewBeforeApply: true }, false);
  assert.equal(result.loaded, 0); assert.equal(result.asked, 0); assert(result.pending);
  console.log('OK: IAMaker carrega direto sem revisão; com revisão, só após aprovação da versão atual, e não tenta corrigir falhas de login');
})().catch(e => { console.error(e); process.exitCode = 1; });
