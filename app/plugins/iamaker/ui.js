// IAMaker: cria e altera plugins conversando com uma IA de linha de comando (Claude Code, Gemini CLI ou Codex CLI).
// Uma janela do balão flutuante (Alt+0). Cada pedido roda a IA escolhida na pasta do plugin (~/.bluescreen/plugins/<id>),
// com as instruções do GUIA.md e o pedido pela entrada padrão; a saída (JSON por linha) vira a conversa na tela.
// Quando a IA termina, o IAMaker confere o plugin.json e a sintaxe do ui.js e carrega o plugin na página aberta
// (bs.plugins.reload), sem recarregar a IDE. Plugin com erro: pede a correção sozinho (até 2 vezes). Sem servidor próprio.
const { S, api, $, esc, toast, store, I } = bs;

const ICO = {
  spark: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  send: '<svg class="i" viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5 20 4"/></svg>',
  stop: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  code: '<svg class="i" viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>',
  tool: '<svg class="i" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
};

// as IAs: programa, onde ficam os argumentos e o modelo nas configurações, e como instalar
const AIS = {
  claude: { name: 'Claude Code', prog: 'claude', args: 'argsClaude', model: 'modelClaude', resume: true,
    effort: (e) => ['--effort', e],
    install: 'npm install -g @anthropic-ai/claude-code', login: 'claude' },
  gemini: { name: 'Gemini CLI', prog: 'gemini', args: 'argsGemini', model: 'modelGemini',
    effort: (e, cfg) => e === 'low' && !cfg.modelGemini ? ['--model', 'gemini-2.5-flash'] : [],
    install: 'npm install -g @google/gemini-cli', login: 'gemini' },
  codex: { name: 'Codex CLI', prog: 'codex', args: 'argsCodex', model: 'modelCodex', stdinDash: true,
    effort: (e) => ['-c', 'model_reasoning_effort=' + e],
    install: 'npm install -g @openai/codex', login: 'codex login' },
};
// quanto a IA pensa antes de escrever: rápido é o padrão; troca no topo do IAMaker a qualquer momento
const EFFORTS = { low: 'Rápido', medium: 'Equilibrado', high: 'Caprichado' };
// arquivos que mudam o que a IDE carrega: mudou algum, carrega o plugin de novo
const WATCH = ['plugin.json', 'ui.js', 'style.css', 'icon.svg', 'icon.png', 'server.js', 'server.py'];
const MAX_MSGS = 300, MAX_FIXES = 2;
// onde o componente vai aparecer: a IA avisa na primeira mensagem (IAMAKER-LUGAR: status), o IAMaker mostra um
// carregamento ali e, quando o plugin carrega, revela o que o plugin criou nesse lugar
const PLACES = { balao: 'balão flutuante', status: 'barra de status', esquerda: 'barra da esquerda', baixo: 'painel embaixo do editor', resumo: 'resumo do projeto', menu: 'menu de contexto', editor: 'editor', outro: 'IDE' };
const IN = { balao: 'no balão flutuante', status: 'na barra de status', esquerda: 'na barra da esquerda', baixo: 'no painel embaixo do editor', resumo: 'no resumo do projeto', menu: 'no menu de contexto', editor: 'no editor' };
const PLACE_RE = /^[ \t>*_`-]*IAMAKER-LUGAR:\s*([a-zçã]+)[`*_ \t]*\r?\n?/im;
const EXAMPLES = [
  'No balão flutuante, uma calculadora com histórico das contas',
  'Um painel embaixo do editor com um cronômetro Pomodoro de 25 minutos',
  'Um item na barra de status com a hora e quantas abas estão abertas',
  'No menu da árvore, "Contar linhas" mostra quantas linhas tem o arquivo',
  'Um painel na barra da esquerda com anotações por projeto, salvas sozinhas',
];

const M = {
  cfg: null, ai: null, id: null, conv: null, run: null, guide: null,
  made: [], forks: {}, fixes: 0, pending: false,
};

// ----- a ferramenta no balão flutuante (bubble.js do núcleo) -----
if (!bs.bubble) { console.warn('IAMaker: esta versão do BlueScreen não tem o balão flutuante'); return; }
const con = document.createElement('div');
con.id = 'iam-con';
con.innerHTML = `
  <div class="iam-bar">
    <select class="iam-sel" id="iam-plug" title="Plugin que a IA está construindo"></select>
    <select class="iam-sel" id="iam-ai" title="Qual IA usar"></select>
    <select class="iam-sel iam-eff" id="iam-effort" title="Esforço: Rápido pensa menos e termina antes; Caprichado pensa mais"></select>
    <span class="iam-state" id="iam-state"></span>
    <span class="spacer"></span>
    <button class="icon-btn" id="iam-apply" title="Aplicar: carregar o plugin agora" hidden>${I.refresh}</button>
    <button class="icon-btn" id="iam-code" title="Ver o código do plugin (abre a pasta como projeto)">${ICO.code}</button>
    <button class="icon-btn" id="iam-dir" title="Mostrar a pasta do plugin">${I.explorer}</button>
    <button class="icon-btn" id="iam-clear" title="Nova conversa (o plugin continua)">${ICO.plus}</button>
    <button class="icon-btn" id="iam-cfg" title="Configurações do IAMaker">${I.gear}</button></div>
  <div class="iam-log" id="iam-log"></div>
  <form class="iam-in" id="iam-form">
    <textarea id="iam-q" rows="2" spellcheck="false" placeholder="Descreva o plugin ou a mudança. Enter envia, Shift+Enter quebra a linha."></textarea>
    <button type="submit" class="chip primary" id="iam-send" title="Enviar (Enter)">${ICO.send}<span>Enviar</span></button>
    <button type="button" class="chip" id="iam-stop" title="Parar a IA" hidden>${ICO.stop}<span>Parar</span></button>
  </form>`;
bs.bubble.register({
  id: 'iamaker', title: 'IAMaker', icon: ICO.spark, order: 10, width: 460, height: 600,
  render(el) { el.appendChild(con); },
  show() { if (!M.run) bs.bubble.badge('iamaker', null); render(); setTimeout(() => q.focus(), 60); },
});
const log = $('#iam-log'), q = $('#iam-q');

// Alt+0 abre a janela do IAMaker (ou minimiza, se ela já está na frente)
function show(on) {
  if (on === false) return bs.bubble.minimize('iamaker');
  if (on === undefined) return bs.bubble.toggle('iamaker');
  bs.bubble.open('iamaker');
}
bs.keys.add('Alt+0', () => show());
bs.actions.add([{ label: 'IAMaker: criar um plugin com IA', k: 'Alt+0', icon: ICO.spark, run: () => { show(true); pick(null); } }]);
// "Editar com o IAMaker" no cartão e no botão direito de cada plugin, na aba Plugins
const editWith = (id) => { show(true); pick(id); };
bs.hooks.filter('plugin:buttons', (items, p) => p.id === plugin.id ? items : [...items, { label: 'Editar com o IAMaker', icon: ICO.spark, action: () => editWith(p.id) }]);

// ----- pastas e plugins -----
const userDir = () => (bs.plugins.dirs || [])[1] || '';
const sep = () => userDir().includes('\\') ? '\\' : '/';
const pdir = (id) => userDir() + sep() + id;
const entry = (id) => bs.plugins.list.find(p => p.id === id) || null;
// plugins que dá para editar: todos menos o próprio IAMaker, mais os recém-criados que ainda não estão na lista.
// Os que vêm com o BlueScreen (app: true) nunca são editados: a IA trabalha numa versão sua (veja derive)
function editable() {
  const out = bs.plugins.list.filter(p => p.id !== plugin.id).map(p => ({ id: p.id, name: p.name || p.id, app: !p.user }));
  const fresh = [...M.made, ...Object.values(M.forks)].filter(id => id === M.id && !out.some(p => p.id === id));
  for (const id of fresh) out.push({ id, name: id, app: false });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
const robocopy = async (from, to) => {
  const r = await plugin.exec('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 60000 });
  // robocopy: até 7 é sucesso
  if (r.code == null || r.code >= 8) throw new Error((r.err || r.out || 'robocopy ' + r.code).trim());
};
// Plugin que não é seu (vem com o BlueScreen): a IA nunca mexe nele nem põe nada por cima dele com o mesmo id. O
// IAMaker cria uma versão sua, um plugin à parte com id próprio (runtimes-meu), copiado do original junto com a
// pasta de dados; o original fica intacto e só é desligado, para os dois não registrarem os mesmos painéis e
// atalhos. Devolve o id da versão sua (a que já existe, se for o caso), ou null se o plugin já é seu.
async function derive(id) {
  const p = entry(id);
  if (!p || p.user) return null;
  const have = M.forks[id];
  if (have) { try { await api('file', { project: pdir(have), file: 'plugin.json' }); return have; } catch {} }
  const to = slug(id + '-meu');
  try { await robocopy(p.path, pdir(to)); } catch (e) { throw new Error('não deu para criar a sua versão do plugin: ' + e.message); }
  const m = JSON.parse((await api('file', { project: pdir(to), file: 'plugin.json' })).content);
  m.basedOn = { id, version: m.version || '' };
  m.id = to;
  m.name = `${m.name || id} (minha versão)`;
  await api('file', { project: pdir(to), file: 'plugin.json' }, { method: 'PUT', body: JSON.stringify(m, null, 2) + '\n' });
  // configurações e dados do original vêm junto (a pasta de dados é por id; sem pasta, o robocopy falha e tudo bem)
  try { const data = (await plugin.info()).dataDir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, ''); await robocopy(data + sep() + id, data + sep() + to); } catch {}
  M.forks = { ...M.forks, [id]: to };
  await plugin.data.set('forks', M.forks);
  // o original sai da página e fica desligado enquanto a versão sua existir
  try { await api('plugins', {}, { method: 'POST', body: JSON.stringify({ id, enabled: false }) }); await bs.plugins.reload(id); } catch {}
  const deps = bs.plugins.list.filter(x => x.enabled && (x.requires || []).includes(id)).map(x => x.name || x.id);
  push({ role: 'sys', text: `${p.name} vem com o BlueScreen e não é alterado: a IA trabalha em "${m.name}" (pasta ${to}), uma versão sua copiada dele. O original continua instalado e fica desligado enquanto a sua versão existir; para voltar a ele, remova a sua versão na aba Plugins.${deps.length ? ` Atenção: ${deps.join(', ')} depende de ${p.name} e não vai carregar com ele desligado.` : ''}` });
  return to;
}
// a versão sua foi removida (aba Plugins): o original volta a ser ligado
async function healForks() {
  let changed = false;
  for (const [orig, mine] of Object.entries(M.forks)) {
    if (bs.plugins.list.some(p => p.id === mine)) continue;
    try { await api('file', { project: pdir(mine), file: 'plugin.json' }); continue; } catch {}
    const o = entry(orig);
    if (o && !o.enabled) { try { await api('plugins', {}, { method: 'POST', body: JSON.stringify({ id: orig, enabled: true }) }); await bs.plugins.reload(orig); } catch {} }
    delete M.forks[orig]; changed = true;
  }
  if (changed) await plugin.data.set('forks', M.forks);
}
// livre: um id que pode continuar sendo usado (o do próprio plugin, ao renomear)
function slug(name, free) {
  const s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plugin';
  const taken = new Set([...bs.plugins.list.map(p => p.id), ...M.made]); taken.delete(free);
  let id = s, n = 2; while (taken.has(id)) id = `${s}-${n++}`;
  return id;
}
// sem nome: id provisório (novo-plugin), e a IA escolhe o nome (veja christen)
const UNNAMED = 'Novo plugin';
async function createPlugin(name) {
  name = name || UNNAMED;
  const id = slug(name);
  const manifest = { id, name, description: 'Criado com o IAMaker.', version: '0.1.0', author: 'IAMaker', order: 100 };
  await api('file/new', { project: userDir() }, { method: 'POST', body: JSON.stringify({ path: `${id}/plugin.json`, content: JSON.stringify(manifest, null, 2) + '\n' }) });
  M.made = [...new Set([...M.made, id])];
  await plugin.data.set('made', M.made);
  return id;
}

// ----- conversa (uma por plugin, na pasta de dados do IAMaker) -----
async function loadConv(id) {
  M.conv = id ? await plugin.data.get('conv:' + id, null) : null;
  if (!M.conv) M.conv = { msgs: [], sessions: {} };
  M.place = M.conv.place || null;
}
// sem o `el` (o balão na tela) de cada mensagem
const saveConv = () => M.id ? plugin.data.set('conv:' + M.id, { ...M.conv, msgs: M.conv.msgs.slice(-MAX_MSGS).filter(m => m.role !== 'ai' || m.text.trim()).map(({ el, ...m }) => m) }) : null;
function push(m) { m.at = Date.now(); M.conv.msgs.push(m); paint(m); return m; }

async function pick(id) {
  if (M.run) return toast('Espere a IA terminar ou clique em Parar');
  // um original do BlueScreen que já tem a versão sua: a conversa e as mudanças são nela
  if (id && M.forks[id]) id = M.forks[id];
  M.id = id || null; plugin.data.set('sel', M.id); M.fixes = 0; M.place = null;
  await loadConv(M.id);
  render();
}

// ----- desenho -----
function md(text) {
  const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  return String(text || '').split(/```[^\n]*\n?/).map((s, i) => i % 2 ? `<pre class="iam-pre">${esc(s.replace(/\n$/, ''))}</pre>` : inline(s)).join('');
}
function msgHtml(m) {
  if (m.role === 'user') return `<div class="iam-m iam-user"><div class="iam-b">${md(m.text)}</div></div>`;
  if (m.role === 'ai') return `<div class="iam-m iam-ai"><div class="iam-b">${md(m.text)}</div></div>`;
  if (m.role === 'tool') return `<div class="iam-m iam-tool">${ICO.tool}<span>${esc(m.text)}</span></div>`;
  if (m.role === 'ok') return `<div class="iam-m iam-ok">${ICO.ok}<span>${esc(m.text)}</span></div>`;
  if (m.role === 'err') return `<div class="iam-m iam-err">${ICO.warn}<div><div>${md(m.text)}</div>${m.act ? `<div class="iam-acts">${m.act.map((a, i) => `<button type="button" class="chip" data-act="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div></div>`;
  return `<div class="iam-m iam-sys">${esc(m.text)}</div>`;
}
function bindMsg(el, m) {
  if (m.act) el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => ACTS[m.act[+b.dataset.act].do]?.(m));
}
function paint(m) {
  if (log.querySelector('.iam-wel')) return render();
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.insertAdjacentHTML('beforeend', msgHtml(m));
  bindMsg(log.lastElementChild, m); m.el = log.lastElementChild;
  if (near) log.scrollTop = log.scrollHeight;
}
// texto da IA chegando em pedaços (Gemini): atualiza o último balão
function repaint(m) { if (!m.el || !m.el.isConnected) return paint(m); m.el.querySelector('.iam-b').innerHTML = md(m.text); log.scrollTop = log.scrollHeight; }

function render() {
  const list = editable(), ai = AIS[M.ai] ? M.ai : 'claude';
  const opt = (p) => `<option value="${esc(p.id)}" ${p.id === M.id ? 'selected' : ''}>${esc(p.name)}</option>`;
  const mine = list.filter(p => !p.app), app = list.filter(p => p.app);
  $('#iam-plug').innerHTML = `<option value="">＋ Novo plugin…</option>` + (mine.length ? `<optgroup label="Seus plugins">${mine.map(opt).join('')}</optgroup>` : '')
    + (app.length ? `<optgroup label="Do BlueScreen (cria uma versão sua; o original não muda)">${app.map(opt).join('')}</optgroup>` : '');
  $('#iam-effort').innerHTML = Object.entries(EFFORTS).map(([k, v]) => `<option value="${k}" ${k === M.effort ? 'selected' : ''}>${esc(v)}</option>`).join('');
  $('#iam-ai').innerHTML = Object.entries(AIS).map(([k, v]) => `<option value="${k}" ${k === ai ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
  ['#iam-code', '#iam-dir', '#iam-clear'].forEach(s => $(s).disabled = !M.id);
  busy(!!M.run);
  if (!M.id || !M.conv.msgs.length) { welcome(); return; }
  log.innerHTML = M.conv.msgs.map(msgHtml).join('');
  [...log.children].forEach((el, i) => { const m = M.conv.msgs[i]; m.el = el; bindMsg(el, m); });
  log.scrollTop = log.scrollHeight;
}
function welcome() {
  const p = M.id && entry(M.id);
  log.innerHTML = `<div class="iam-wel">
    <div class="iam-wel-hd">${ICO.spark}<div><b>${M.id ? esc(p ? p.name : M.id) : 'Crie um plugin conversando'}</b>
      <p>${M.id ? 'Diga o que mudar neste plugin. A IA altera os arquivos e o resultado aparece na hora.' : `Descreva o que você quer. O ${esc(AIS[M.ai].name)} escreve o plugin na sua pasta de plugins e ele aparece funcionando na IDE, sem compilar nem recarregar nada.`}</p></div></div>
    ${M.id ? '' : `<label class="iam-name"><span>Nome do plugin <i>(opcional)</i></span><input id="iam-name" spellcheck="false" autocomplete="off" placeholder="Em branco, a IA escolhe um nome curto"></label>`}
    <div class="iam-ex">${EXAMPLES.map(e => `<button type="button" class="iam-chip">${esc(e)}</button>`).join('')}</div>
  </div>`;
  log.querySelectorAll('.iam-chip').forEach(b => b.onclick = () => { q.value = b.textContent; q.focus(); });
}
function busy(on) {
  $('#iam-send').hidden = on; $('#iam-stop').hidden = !on;
  $('#iam-plug').disabled = on; $('#iam-ai').disabled = on; $('#iam-effort').disabled = on;
  con.classList.toggle('iam-busy', on);
  if (!on) $('#iam-state').textContent = '';
}
setInterval(() => {
  reghost(); fitAura();
  if (G.aura && M.run) { const s = Math.round((Date.now() - M.run.at) / 1000); G.aura.querySelector('.iam-aura-t').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  if (!M.run) return;
  const s = Math.round((Date.now() - M.run.at) / 1000);
  const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('#iam-state').innerHTML = `<span class="iam-dot"></span><span class="iam-state-tx">${esc(AIS[M.run.ai].name)} trabalhando · </span><span>${t}</span>`;
  $('#iam-state').title = `${AIS[M.run.ai].name} trabalhando há ${t}`;
}, 1000);

// ----- o lugar: um marcador discreto enquanto a IA trabalha, um destaque rápido quando o plugin carrega -----
const G = { els: [], place: null };
function ghost(place) {
  unghost(); G.place = place;
  const add = (el) => { G.els.push(el); return el; };
  const mk = (tag, cls, html) => { const e = document.createElement(tag); e.className = cls; e.innerHTML = html; return add(e); };
  if (place === 'status' && $('#stDirty')) $('#stDirty').before(mk('span', 's iam-ghost iam-ghost-st', `${ICO.spark}<span>criando…</span>`));
  const grow = document.querySelector('#strip .grow');
  if ((place === 'esquerda' || place === 'baixo') && grow) {
    const g = mk('div', 'iam-ghost iam-ghost-tool', ICO.spark); g.title = 'O IAMaker está criando este painel';
    if (place === 'esquerda') grow.before(g); else grow.after(g);
  }
  // no balão: um item "criando…" na lista de janelas
  if (place === 'balao') add(bs.bubble.placeholder('Janela nova'));
  // a IDE inteira (ou o editor): só um aviso pequeno embaixo, com o passo atual e o tempo
  if (place === 'outro' || place === 'editor') G.aura = add(mk('div', 'iam-aura', `${ICO.spark}<span class="iam-aura-tx">Montando ${esc(IN[place] || 'na IDE')}</span><span class="iam-aura-step"></span><span class="iam-aura-t"></span>`));
  if (G.aura) { G.aura.setAttribute('aria-hidden', 'true'); document.body.appendChild(G.aura); fitAura(); }
  const card = document.querySelector('[data-card]');
  if (place === 'resumo' && card) card.parentElement.appendChild(mk('div', 'iam-ghost iam-ghost-card', '<i></i><i></i><i></i>'));
  // na conversa, sempre: "Montando na barra de status…"
  log.insertAdjacentElement('beforeend', mk('div', 'iam-m iam-build', `${ICO.spark}<span>Montando ${esc(IN[place] || 'na IDE')}…</span>`)); log.scrollTop = log.scrollHeight;
}
function unghost() { G.els.forEach(e => e.remove()); G.els = []; G.place = null; G.aura = null; }
// o aviso fica embaixo do editor (lugar "editor") ou da janela
function fitAura() {
  const el = G.aura; if (!el) return;
  const r = (G.place === 'editor' && $('#editor') ? $('#editor') : document.documentElement).getBoundingClientRect();
  Object.assign(el.style, { left: (r.left + r.width / 2) + 'px', top: (r.bottom - 44) + 'px' });
}
// um passo da IA: o texto do aviso muda
function auraStep(text) {
  const step = G.aura && G.aura.querySelector('.iam-aura-step');
  if (step && text) step.textContent = text;
}
// a barra da esquerda e a conversa são redesenhadas às vezes: o marcador volta para o lugar
const reghost = () => { if (M.run && G.place && G.els.some(e => !e.isConnected)) ghost(G.place); };

// um contorno de destaque que some sozinho em volta de um elemento que acabou de aparecer
function magic(el) {
  if (!el || !el.isConnected) return;
  el.classList.remove('iam-magic'); void el.offsetWidth; el.classList.add('iam-magic');
  setTimeout(() => el.classList.remove('iam-magic'), 1300);
}

// depois de carregar: o núcleo sabe o que o plugin registrou (bs.plugins.owned): itens de status, painéis, ferramentas
// da barra, do balão e cards. Abre o painel novo, se for o lugar dele, e destaca cada um
async function reveal(id, place) {
  const o = (bs.plugins.owned || {})[id] || {};
  const tools = o.tools || [], bubbles = o.bubbles || [];
  if (place === 'esquerda' || place === 'baixo') tools.forEach(t => { try { bs.openTool(t); } catch {} });
  // janela nova no balão: abre e fica na frente
  if (bubbles.length && (place === 'balao' || !tools.length)) bubbles.forEach(b => bs.bubble.open(b));
  await new Promise(r => setTimeout(r, 200));
  const els = [...(o.els || [])];
  tools.forEach(t => { const b = document.querySelector(`#strip [data-tool="${CSS.escape(t)}"]`); if (b) els.push(b); });
  bubbles.forEach(b => { const w = bs.bubble.windowOf(b); if (w && bs.bubble.isOpen(b)) els.push(w); });
  (o.cards || []).forEach(c => { const e = document.querySelector(`[data-card="${CSS.escape(c.id)}"]`); if (e) els.push(e); });
  // ferramenta nova no balão fechado: quem é destacado é o próprio balão
  if (bubbles.length && !bubbles.some(b => bs.bubble.isOpen(b))) els.push(bs.bubble.button);
  const seen = [...new Set(els)].filter(e => e && e.isConnected && !e.hidden && e.getClientRects().length);
  seen.forEach(magic);
  return seen.length;
}

// ----- leitura da saída de cada IA (uma linha JSON por evento) -----
const base = (f) => String(f || '').split(/[\\/]/).pop();
function toolLabel(name, inp) {
  inp = inp || {};
  const target = inp.file_path || inp.path || inp.absolute_path || inp.pattern || inp.command || inp.query || '';
  const NAMES = { Write: 'Escreveu', Edit: 'Editou', MultiEdit: 'Editou', Read: 'Leu', Glob: 'Procurou', Grep: 'Procurou', write_file: 'Escreveu', replace: 'Editou', read_file: 'Leu', list_directory: 'Listou', glob: 'Procurou', search_file_content: 'Procurou', run_shell_command: 'Rodou' };
  return `${NAMES[name] || name} ${/[\\/]/.test(target) ? base(target) : target}`.trim();
}
function parser(ai) {
  let buf = '', delta = null;
  const P = { session: null, said: false, errors: [], place: null, onPlace: null };
  // tira a linha IAMAKER-LUGAR do texto e avisa o lugar (uma vez por pedido)
  const place = (m) => {
    const r = m.text.match(PLACE_RE); if (!r) return;
    m.text = m.text.replace(PLACE_RE, '').replace(/^\s+/, '');
    const k = r[1].toLowerCase();
    if (!P.place && PLACES[k]) { P.place = k; try { P.onPlace && P.onPlace(k); } catch (e) { console.error('IAMaker', e); } }
  };
  const text = (t, isDelta) => {
    if (!t) return;
    P.said = true;
    if (isDelta && delta) { delta.text += t; place(delta); repaint(delta); return; }
    const m = { role: 'ai', text: t }; place(m);
    if (!m.text.trim() && !isDelta) return;
    push(m); delta = isDelta ? m : null;
  };
  const tool = (t) => { delta = null; push({ role: 'tool', text: t }); auraStep(t); };
  const error = (t) => { if (t) P.errors.push(String(t)); };
  function claude(o) {
    if (o.session_id) P.session = o.session_id;
    if (o.type === 'assistant') for (const c of (o.message && o.message.content) || []) {
      if (c.type === 'text') text(c.text); else if (c.type === 'tool_use') tool(toolLabel(c.name, c.input));
    }
    if (o.type === 'result' && o.is_error) error(o.result || o.subtype);
  }
  function codex(o) {
    const it = o.item;
    if (o.type === 'thread.started') P.session = o.thread_id;
    else if (it && o.type === 'item.completed' && it.type === 'agent_message') text(it.text);
    else if (it && o.type === 'item.started' && it.type === 'command_execution') tool('Rodou ' + it.command);
    else if (it && o.type === 'item.completed' && it.type === 'file_change') tool('Alterou ' + (it.changes || []).map(c => base(c.path)).join(', '));
    else if (o.type === 'error' || o.type === 'turn.failed') error(o.message || (o.error && o.error.message));
    // formato antigo do codex exec --json: { msg: { type, ... } }
    const m = o.msg;
    if (m && m.type === 'agent_message') text(m.message);
    else if (m && m.type === 'exec_command_begin') tool('Rodou ' + [].concat(m.command || []).join(' '));
    else if (m && m.type === 'patch_apply_begin') tool('Alterou ' + Object.keys(m.changes || {}).map(base).join(', '));
    else if (m && m.type === 'error') error(m.message);
  }
  function gemini(o) {
    if (o.session_id) P.session = o.session_id;
    if (o.type === 'message' && o.role === 'assistant') text(o.content, !!o.delta);
    else if (o.type === 'tool_use') tool(toolLabel(o.tool_name, o.parameters));
    else if (o.type === 'error') error(o.message);
    else if (o.type === 'result' && o.status === 'error') error(o.error && (o.error.message || o.error));
  }
  const H = { claude, codex, gemini }[ai];
  function line(l) {
    l = l.trim(); if (!l) return;
    let o = null;
    if (l[0] === '{') { try { o = JSON.parse(l); } catch {} }
    if (o) { try { H(o); } catch (e) { console.error('IAMaker', e); } return; }
    // saída em texto puro (Gemini sem --output-format): vira a resposta
    if (ai === 'gemini') text(l + '\n', true);
  }
  P.feed = (chunk) => { buf += chunk; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(line); };
  P.end = () => { if (buf) line(buf); buf = ''; };
  return P;
}

// ----- pedido -----
async function guide() {
  if (M.guide) return M.guide;
  try { M.guide = (await api('file', { project: plugin.path, file: 'GUIA.md' })).content; } catch { M.guide = ''; }
  return M.guide;
}
function argList(text) { return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
async function stamp(dir) {
  const out = {};
  await Promise.all(WATCH.map(async f => { try { const r = await api('file', { project: dir, file: f }); out[f] = r.mtime + ':' + r.size; } catch { out[f] = null; } }));
  return out;
}
const changed = (a, b) => WATCH.some(f => (a || {})[f] !== (b || {})[f]);

// o núcleo recusa {{secret:..}} e {{vault:..}} na entrada de um processo (segredos só vão no env): no pedido, viram ⟪..⟫
const unmark = (s) => String(s).replace(/\{\{(\s*(?:secret|vault):[^}]*)\}\}/g, '⟪$1⟫').replace(/\{\{(\s*(?:secret|vault):)/g, '⟪$1');
async function prompt(text, ai, resumed, files) {
  return unmark(await rawPrompt(text, ai, resumed, files));
}
// os arquivos do plugin como estão agora (até 60 KB juntos), para a IA não precisar ler
const SOURCES = ['plugin.json', 'ui.js', 'style.css', 'server.js', 'server.py'];
async function sources(dir, files) {
  let left = 60000; const out = [];
  for (const f of SOURCES) {
    if (!files[f]) continue;
    let c; try { c = (await api('file', { project: dir, file: f })).content; } catch { continue; }
    if (c == null || c.length > left) { out.push(`## ${f}\n(grande demais para vir aqui: leia o arquivo)`); continue; }
    left -= c.length;
    out.push(`## ${f}\n\`\`\`${f.endsWith('.json') ? 'json' : f.endsWith('.css') ? 'css' : f.endsWith('.py') ? 'python' : 'js'}\n${c}\n\`\`\``);
  }
  return out.length ? `\n# Arquivos do plugin agora (já estão aqui: não precisa ler de novo)\n${out.join('\n\n')}\n` : '';
}
async function rawPrompt(text, ai, resumed, files) {
  const id = M.id, dir = pdir(id), p = entry(id);
  const src = await sources(dir, files);
  const ctx = [
    `- Pasta do plugin (diretório atual): ${dir}`,
    `- id do plugin: ${id} (não mude)`,
    M.conv.unnamed ? `- Este plugin ainda não tem nome. Escolha um nome curto (1 a 3 palavras, em português) que diga o que ele faz e grave em "name" no plugin.json. Use esse nome para o prefixo de ids e classes CSS. Não mude o "id" nem a pasta: o IAMaker renomeia a pasta para o nome que você escolher.` : '',
    `- Arquivos que já existem: ${Object.keys(files).filter(f => files[f]).join(', ') || 'nenhum'}`,
    p && p.error ? `- O plugin está com erro na IDE agora: ${p.error}` : '',
    M.conv.derived ? `- Este plugin é a versão do usuário de "${M.conv.derived.name}" (id ${M.conv.derived.id}), que vem com o BlueScreen e nunca é alterado. Você está numa cópia à parte, com id próprio; o original fica desligado enquanto ela existir. Mude só o que o usuário pediu e mantenha o resto funcionando como antes.` : '',
    M.conv.adopted ? '- Este plugin veio com o BlueScreen e foi copiado para a pasta do usuário com o mesmo id (versão antiga do IAMaker). Mude só o que o usuário pediu e mantenha o resto funcionando como antes.' : '',
    p && p.server ? '- Este plugin tem um servidor próprio (server.exe ou script). Não dá para mudar a parte compilada: mexa no ui.js, no style.css e no plugin.json, e use as rotas que o servidor já atende.' : '',
  ].filter(Boolean).join('\n');
  if (resumed) return `# Contexto\n${ctx}\n${src}\n# Pedido do usuário\n${text}\n\n(Siga as instruções do IAMaker do início desta conversa, inclusive as de rapidez. Só a pasta atual.)\n`;
  const hist = M.conv.msgs.filter(m => m.role === 'user' || m.role === 'ai').slice(-13, -1)
    .map(m => `${m.role === 'user' ? 'Usuário' : 'IA'}: ${m.text.length > 700 ? m.text.slice(0, 700) + '…' : m.text}`).join('\n\n');
  return `${await guide()}\n\n---\n\n# Contexto\n${ctx}\n${src}${hist ? `\n# Conversa até aqui\n${hist}\n` : ''}\n# Pedido do usuário\n${text}\n`;
}

async function send(text, opt = {}) {
  text = String(text || '').trim();
  if (!text || M.run || M.applying) return;
  if (!userDir()) return toast('IAMaker: não achei a pasta dos seus plugins');
  if (!M.id) {
    const name = ($('#iam-name') || {}).value?.trim();
    try { M.id = await createPlugin(name); } catch (e) { return toast('IAMaker: ' + e.message); }
    plugin.data.set('sel', M.id); await loadConv(M.id);
    if (!name) M.conv.unnamed = true;
    render();
  }
  if (!opt.auto) M.fixes = 0;
  if (!opt.retry) { push({ role: opt.auto ? 'sys' : 'user', text: opt.auto ? 'Pedindo a correção para a IA…' : text }); await saveConv(); }
  // plugin que não é seu: a conversa continua na versão sua dele, e é nela que a IA mexe
  try {
    const orig = entry(M.id), mine = await derive(M.id);
    if (mine) {
      const conv = { ...M.conv, derived: { id: orig.id, name: orig.name || orig.id }, msgs: M.conv.msgs.slice(-MAX_MSGS).map(({ el, ...x }) => x) };
      await plugin.data.remove('conv:' + M.id);
      M.id = mine; plugin.data.set('sel', mine);
      await plugin.data.set('conv:' + mine, conv); await loadConv(mine);
      render();
    }
  } catch (e) { push({ role: 'err', text: e.message }); return saveConv(); }
  const ai = M.ai, A = AIS[ai], cfg = M.cfg || {}, dir = pdir(M.id);
  const sid = A.resume && M.conv.sessions && M.conv.sessions[ai];
  const before = await stamp(dir);
  const args = argList(cfg[A.args]);
  if (cfg[A.model]) args.push(ai === 'codex' ? '-m' : '--model', cfg[A.model]);
  if (A.effort) args.push(...A.effort(EFFORTS[M.effort] ? M.effort : 'low', cfg));
  if (sid) args.push('--resume', sid);
  if (A.stdinDash) args.push('-');
  const P = parser(ai);
  const run = M.run = { ai, at: Date.now(), P, err: '', before, text, sid, id: M.id };
  P.onPlace = (k) => placed(k);
  busy(true); bs.bubble.badge('iamaker', 'busy');
  let h;
  try {
    h = await plugin.spawn(A.prog, args, {
      cwd: dir, label: 'IAMaker · ' + A.name,
      onData: (t, s) => { if (s === 'err') run.err = (run.err + t).slice(-4000); else P.feed(t); },
      onExit: (code) => finish(run, code),
    });
  } catch (e) {
    M.run = null; busy(false); bs.bubble.badge('iamaker', null);
    const missing = /não encontrado|not found/i.test(e.message);
    push({ role: 'err', text: missing ? `O **${A.name}** não está instalado (ou não está no PATH).\n\nInstale com \`${A.install}\` e faça o login rodando \`${A.login}\` uma vez no terminal.` : `${A.name}: ${e.message}`,
      act: missing ? [{ label: 'Instalar no terminal', do: 'install' }] : null, ai });
    return saveConv();
  }
  run.h = h;
  plugin.data.set('run', { pid: h.id, id: M.id, ai, before, text });
  try { await h.write(await prompt(text, ai, !!sid, before)); await h.close(); }
  catch (e) { P.errors.push('não deu para mandar o pedido: ' + e.message); h.kill().catch(() => {}); }
}

function placed(k) {
  M.place = M.conv.place = k;
  push({ role: 'sys', text: `Lugar: ${PLACES[k]}` });
  ghost(k);
}

async function finish(run, code) {
  if (M.run !== run) return;
  run.P.end();
  M.run = null; plugin.data.set('run', null); busy(false); unghost();
  bs.bubble.badge('iamaker', bs.bubble.isOpen('iamaker') ? null : 'dot');
  const A = AIS[run.ai];
  if (run.P.session && A.resume) { M.conv.sessions = { ...(M.conv.sessions || {}), [run.ai]: run.P.session }; }
  // sessão do Claude Code que não existe mais: esquece e manda de novo, com as instruções e o histórico
  if (code && run.sid && /no conversation|session/i.test(run.err)) {
    delete M.conv.sessions[run.ai]; await saveConv();
    return send(run.text, { retry: true });
  }
  if (run.killed) push({ role: 'sys', text: 'Parado.' });
  else if (code || run.P.errors.length) {
    const tail = run.err.trim().split(/\r?\n/).slice(-6).join('\n');
    const why = run.P.errors.join('\n') || tail || `saiu com o código ${code}`;
    push({ role: 'err', text: `${A.name} não terminou: ${why}${/login|auth|api key|credential|unauthori/i.test(why) ? `\n\nFaça o login rodando \`${A.login}\` no terminal.` : ''}`,
      act: /login|auth|api key|credential|unauthori/i.test(why) ? [{ label: 'Fazer login no terminal', do: 'login' }] : null, ai: run.ai });
  } else if (!run.P.said) push({ role: 'sys', text: `${A.name} terminou sem resposta.` });
  await saveConv();
  if (run.killed || run.id !== M.id) return;
  const after = await stamp(pdir(run.id));
  if (!changed(run.before, after)) { if (!code) push({ role: 'sys', text: 'Nenhum arquivo do plugin mudou.' }); return saveConv(); }
  const problems = await verify(run.id);
  if (problems.length) return broken(problems);
  await christen(run.id);
  ready();
}

// plugin criado sem nome: a IA gravou um em "name"; a pasta e o id passam a seguir esse nome (novo-plugin -> pomodoro)
async function christen(id) {
  if (!M.conv.unnamed || M.id !== id) return;
  let m; try { m = JSON.parse((await api('file', { project: pdir(id), file: 'plugin.json' })).content); } catch { return; }
  const name = String(m.name || '').trim();
  if (!name || name === UNNAMED) return;
  M.conv.unnamed = false;
  const to = slug(name, id);
  if (to === id) { await saveConv(); return; }
  try {
    await api('file/move', { project: userDir() }, { method: 'POST', body: JSON.stringify({ from: id, to }) });
    m.id = to;
    await api('file', { project: pdir(to), file: 'plugin.json' }, { method: 'PUT', body: JSON.stringify(m, null, 2) + '\n' });
  } catch (e) { push({ role: 'sys', text: `A IA chamou o plugin de "${name}", mas a pasta continua ${id}: ${e.message}` }); return saveConv(); }
  // a conversa e a lista de criados acompanham o id novo
  await plugin.data.set('conv:' + to, { ...M.conv, msgs: M.conv.msgs.slice(-MAX_MSGS).map(({ el, ...x }) => x) });
  await plugin.data.remove('conv:' + id);
  M.made = [...new Set(M.made.map(x => x === id ? to : x))]; await plugin.data.set('made', M.made);
  M.id = to; plugin.data.set('sel', to);
  push({ role: 'sys', text: `A IA chamou o plugin de "${name}" (pasta ${to}).` });
  await saveConv();
  render();
}

// confere o que a IDE vai carregar, sem rodar: plugin.json válido e com o id certo, ui.js sem erro de sintaxe
async function verify(id) {
  const dir = pdir(id), out = [];
  try {
    const m = JSON.parse((await api('file', { project: dir, file: 'plugin.json' })).content);
    if (m.id && m.id !== id) out.push(`plugin.json: o "id" é "${m.id}", mas tem que ser "${id}" (o nome da pasta)`);
    if (!m.name) out.push('plugin.json: falta o "name"');
  } catch (e) { out.push('plugin.json: ' + (e instanceof SyntaxError ? 'JSON inválido: ' + e.message : e.message)); }
  let ui = null; try { ui = (await api('file', { project: dir, file: 'ui.js' })).content; } catch {}
  if (ui != null) { try { new Function('bs', 'plugin', "'use strict';\n" + ui); } catch (e) { out.push('ui.js: erro de sintaxe: ' + e.message); } }
  // os dados ficam só na pasta de dados do plugin (plugin.data), que vai embora junto quando ele é removido
  if (ui != null && M.made.includes(id) && /\b(localStorage|sessionStorage|indexedDB)\b|\bbs\.store\b/.test(ui)) out.push('ui.js: guarda dados fora do plugin (localStorage ou bs.store); troque por await plugin.data.get/set');
  return out;
}
function broken(problems) {
  const text = 'O plugin tem erro:\n' + problems.map(p => '- ' + p).join('\n');
  if ((M.cfg || {}).autoFix !== false && M.fixes < MAX_FIXES) {
    M.fixes++; push({ role: 'err', text }); saveConv();
    return send(`Corrija este erro do plugin, sem mudar o resto:\n${problems.join('\n')}`, { auto: true });
  }
  push({ role: 'err', text, act: [{ label: 'Pedir a correção', do: 'fix' }], problems });
  saveConv();
}
function ready() {
  if ((M.cfg || {}).autoApply !== false) return apply();
  M.pending = true; $('#iam-apply').hidden = false;
  push({ role: 'ok', text: 'Pronto. Clique em Aplicar para carregar o plugin.' });
  saveConv();
}
// carrega o plugin na página aberta, sem recarregar a IDE (bs.plugins.reload desfaz a versão anterior dele)
async function apply() {
  if (!M.id || M.applying) return;
  M.applying = true; M.pending = false; $('#iam-apply').hidden = true;
  const id = M.id, was = entry(id), fresh = !was || !was.loaded;
  // revisão opcional pelo Conselho de agentes (configurações do IAMaker): só carrega se todos aprovarem
  if ((M.cfg || {}).reviewBeforeApply === true) {
    const held = (text) => { M.applying = false; M.pending = true; $('#iam-apply').hidden = false; push({ role: 'err', text }); return saveConv(); };
    if (!bs.plugins.list.some(p => p.id === 'agents' && p.enabled)) return held('A revisão antes de aplicar está ligada, mas o plugin Conselho de agentes está desligado. Ligue o plugin ou desmarque a revisão nas configurações do IAMaker.');
    const who = (M.cfg || {}).reviewProvider;
    let decision, err = null;
    busy(true); bs.bubble.badge('iamaker', 'busy');
    try {
      const before = await stamp(pdir(id));
      push({ role: 'sys', text: 'Conselho de agentes: revisando o plugin antes de carregar…' });
      decision = await api('agents/reviews', {}, { method: 'POST', body: JSON.stringify({
        proposal: `Avalie se o plugin ${id} está pronto para carregar no BlueScreen. Leia plugin.json, ui.js e os arquivos do plugin nesta pasta. Verifique o pedido, erros, integridade dos dados e efeitos inesperados. Pedido mais recente: ${M.conv.msgs.filter(m => m.role === 'user').at(-1)?.text || ''}`,
        cwd: pdir(id), providers: who === 'codex' ? ['codex'] : who === 'claude' ? ['claude'] : ['codex', 'claude'],
      }) });
      if (id !== M.id || changed(before, await stamp(pdir(id)))) err = 'O plugin mudou durante a revisão. Aplique de novo para revisar a versão atual.';
    } catch (e) { err = e.message; }
    // o estado de "ocupado" termina aqui, antes de devolver as correções ao agente principal (que liga o dele)
    busy(false); bs.bubble.badge('iamaker', null);
    if (err) return held('Carregamento bloqueado pela revisão: ' + err);
    if (!decision.approved) {
      const problems = decision.reviews.map(v => `${v.provider}: ${v.error || v.result.reason}`);
      if (decision.reviews.some(v => v.error)) return held('Um revisor não conseguiu responder. Resolva e aplique de novo.\n' + problems.join('\n'));
      M.applying = false;
      return broken(problems);
    }
    push({ role: 'ok', text: 'Conselho de agentes: aprovado. Carregando o plugin.' });
  }
  // erro que o plugin novo lançar logo depois de carregar (num setTimeout, num evento) também conta
  const late = [];
  const onErr = (e) => { if (e.filename && e.filename.includes('/plugins/' + encodeURIComponent(id) + '.js')) late.push(e.message); };
  addEventListener('error', onErr);
  let p;
  try {
    await saveConv();
    p = await bs.plugins.reload(id);
    // o IAMaker sempre deixa ligado o que construiu (um id que estava na lista de desligados voltaria desligado)
    if (p && !p.enabled) { await api('plugins', {}, { method: 'POST', body: JSON.stringify({ id, enabled: true }) }); p = await bs.plugins.reload(id); M.turnedOn = true; }
  } catch (e) { removeEventListener('error', onErr); M.applying = false; push({ role: 'err', text: 'Não deu para carregar o plugin: ' + e.message }); return saveConv(); }
  M.applying = false;
  if (!p) { removeEventListener('error', onErr); push({ role: 'err', text: 'O plugin não apareceu na lista da IDE. Confira o plugin.json.' }); return saveConv(); }
  if (p.error) { removeEventListener('error', onErr); return broken([`a IDE não carregou o plugin: ${p.error}`]); }
  if (!p.ui) { removeEventListener('error', onErr); push({ role: 'sys', text: 'O plugin ainda não tem interface (ui.js).' }); return saveConv(); }
  const n = await reveal(id, M.place);
  const where = M.place && IN[M.place] ? ' ' + IN[M.place] : '';
  push({ role: 'ok', text: `${p.name} v${p.version} ${fresh ? 'criado' : 'atualizado'}${where}${M.turnedOn ? ' e ligado' : ''}.${n || M.place === 'outro' ? '' : ' Procure o que mudou na IDE.'}` });
  M.turnedOn = false;
  saveConv();
  setTimeout(() => { removeEventListener('error', onErr); if (late.length && M.id === id && !M.run) broken(late.map(m => 'erro depois de carregar: ' + m)); else M.fixes = 0; }, 3000);
}

// botões das mensagens
const ACTS = {
  install: (m) => bs.terminal.run(AIS[m.ai || M.ai].install),
  login: (m) => bs.terminal.run(AIS[m.ai || M.ai].login),
  fix: (m) => { M.fixes = 0; send(`Corrija este erro do plugin, sem mudar o resto:\n${(m.problems || [m.text]).join('\n')}`, { auto: true }); },
};

// ----- eventos -----
$('#iam-form').onsubmit = (e) => { e.preventDefault(); const t = q.value; if (!t.trim()) return; q.value = ''; send(t); };
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#iam-form').requestSubmit(); } });
$('#iam-stop').onclick = () => { if (!M.run) return; M.run.killed = true; M.run.h ? M.run.h.kill().catch(() => {}) : null; };
$('#iam-cfg').onclick = () => plugin.settings.open();
$('#iam-apply').onclick = () => apply();
$('#iam-dir').onclick = () => M.id && bs.reveal(pdir(M.id));
$('#iam-code').onclick = () => M.id && bs.openOutside(pdir(M.id), 'ui.js');
$('#iam-clear').onclick = async () => { if (M.run) return; M.conv = { msgs: [], sessions: {} }; await saveConv(); render(); };
$('#iam-plug').onchange = (e) => pick(e.target.value);
$('#iam-effort').onchange = async (e) => { M.effort = e.target.value; try { M.cfg = await plugin.settings.set({ effort: M.effort }); } catch {} };
$('#iam-ai').onchange = async (e) => { M.ai = e.target.value; render(); try { M.cfg = await plugin.settings.set({ provider: M.ai }); } catch {} };
plugin.settings.onChange((v) => { M.cfg = v; if (v && EFFORTS[v.effort]) M.effort = v.effort; if (v && AIS[v.provider] && !M.run) { M.ai = v.provider; render(); } });

// ----- início: configurações, conversa e processo da IA que ainda roda -----
(async () => {
  try { M.cfg = await plugin.settings.get(); } catch { M.cfg = {}; }
  M.ai = AIS[M.cfg.provider] ? M.cfg.provider : 'claude';
  M.effort = EFFORTS[M.cfg.effort] ? M.cfg.effort : 'low';
  // tudo do IAMaker fica na pasta de dados dele (~/.bluescreen/plugin-data/iamaker); o localStorage de versões antigas migra uma vez
  const old = { sel: store.get('iamPlugin', null), run: store.get('iamRun', null) };
  ['iamPlugin', 'iamRun', 'iamReopen'].forEach(k => { try { localStorage.removeItem('bs.' + k); } catch {} });
  let d = {}; try { d = (await plugin.data.all()) || {}; } catch {}
  M.id = d.sel != null ? d.sel : old.sel;
  const was = d.run != null ? d.run : old.run;
  // plugin removido (aba Plugins ou à mão) some do IAMaker também: da lista, da seleção e a conversa dele
  const here = new Set(bs.plugins.list.map(p => p.id));
  const made = Array.isArray(d.made) ? d.made.filter(Boolean) : [];
  const gone = made.filter(id => !here.has(id));
  M.made = made.filter(id => here.has(id));
  if (gone.length) { plugin.data.set('made', M.made); gone.forEach(id => plugin.data.remove('conv:' + id)); }
  // original do BlueScreen -> a versão sua dele
  M.forks = d.forks && typeof d.forks === 'object' ? d.forks : {};
  await healForks();
  if (M.id && !editable().some(p => p.id === M.id)) { M.id = null; plugin.data.set('sel', null); }
  if (old.sel && d.sel == null) plugin.data.set('sel', M.id);
  await loadConv(M.id);

  // a página recarregou com a IA rodando: continua acompanhando
  if (was && was.id === M.id && AIS[was.ai]) {
    let alive = null; try { alive = (await plugin.procs.list()).find(x => x.id === was.pid && !x.done); } catch {}
    if (alive) {
      const P = parser(was.ai);
      const run = M.run = { ai: was.ai, at: Date.now(), P, err: '', before: was.before, text: was.text, id: was.id };
      P.onPlace = (k) => placed(k); bs.bubble.badge('iamaker', 'busy');
      run.h = plugin.procs.attach(was.pid, { onData: (t, s) => { if (s === 'err') run.err = (run.err + t).slice(-4000); else P.feed(t); }, onExit: (code) => finish(run, code) });
      show(true);
    } else plugin.data.set('run', null);
  }
  render();
})();
