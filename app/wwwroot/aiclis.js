'use strict';
// ===== Agentes de IA (programas de linha de comando) =====
// O Automator e o Conselho de agentes chamam o Codex, o Claude Code e os programas que o usuário cadastrar aqui (um
// OpenClaude, por exemplo). Cada agente tem programa, modelo, esforço e opções a mais; a lista fica no núcleo
// (rota agents/clis, automation.rs). bs.aiClis.open(id) abre esta janela; ao gravar, roda o gancho 'aiclis:change'.
(function () {
  const KIND = [['claude', 'Claude Code, ou programa com as mesmas opções'], ['codex', 'Codex, ou programa com as mesmas opções'], ['custom', 'Outro programa']];
  const EFFORT = [['', 'O padrão do programa'], ['minimal', 'Mínimo (Codex)'], ['low', 'Baixo'], ['medium', 'Médio'], ['high', 'Alto'], ['xhigh', 'Extra alto'], ['max', 'Máximo (Claude)']];
  const HELP = {
    claude: 'Opções a mais, uma por linha. A IDE já passa o pedido, o modelo, o esforço e o modo só de leitura (plan, com Read, Glob e Grep).',
    codex: 'Opções a mais, uma por linha. A IDE já passa o pedido, o modelo, o esforço e a sandbox só de leitura.',
    custom: 'Um argumento por linha. {prompt} vira o pedido, {model} o modelo e {effort} o esforço. Sem {prompt}, o pedido vai pela entrada padrão. A IDE não consegue limitar um programa desses a só leitura.',
  };
  const factory = (id) => id === 'codex' || id === 'claude';
  const post = (b) => api('agents/clis', {}, { method: 'POST', body: JSON.stringify(b) });
  const blank = () => ({ id: '', name: '', kind: 'claude', program: '', model: '', effort: '', args: [] });
  let list = [], cur = null;

  async function open(id) {
    try { list = await api('agents/clis'); } catch (e) { return toast(e.message, 'err'); }
    cur = list.find(c => c.id === id) || list[0] || blank();
    draw();
  }
  function draw(note) {
    const c = cur, fixed = factory(c.id);
    dialog('aiClis', `<div class="dlg-hd"><div><h3>Agentes de IA</h3><p>Os programas que o Automator e o Conselho de agentes chamam, cada um com o seu modelo e o seu esforço.</p></div></div>
      <div class="aic-tabs" role="tablist">${list.map(x => `<button class="chip${x.id === c.id ? ' on' : ''}" data-id="${esc(x.id)}" role="tab">${esc(x.name)}</button>`).join('')}<button class="chip${c.id ? '' : ' on'}" data-new role="tab">+ Novo</button></div>
      <label class="fld">Nome<input id="aicName" maxlength="60" autocomplete="off" placeholder="OpenClaude"></label>
      <label class="fld"${fixed ? ' hidden' : ''}>Fala como<select id="aicKind">${KIND.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="fld">Programa<input id="aicProg" spellcheck="false" autocomplete="off"></label>
      <div class="aic-two"><label class="fld">Modelo<input id="aicModel" spellcheck="false" autocomplete="off" placeholder="vazio: o padrão do programa"></label>
        <label class="fld">Esforço<select id="aicEffort">${EFFORT.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label></div>
      <label class="fld"><span id="aicArgsLbl"></span><textarea id="aicArgs" rows="3" spellcheck="false"></textarea></label>
      <p class="aic-help" id="aicHelp"></p>
      <p class="err" id="aicErr"></p><pre class="aic-out" id="aicOut" hidden></pre>
      <div class="actions">${c.id ? `<button class="chip danger" id="aicDel">${fixed ? 'Voltar ao padrão' : 'Excluir'}</button>` : ''}<span class="spacer"></span><button class="chip" id="aicTest" title="Grava e faz uma pergunta curta ao agente">Testar</button><button class="chip primary" id="aicSave">Salvar</button></div>`, (box) => {
      const $ = (s) => box.querySelector(s), err = $('#aicErr'), out = $('#aicOut');
      $('#aicName').value = c.name; $('#aicKind').value = c.kind || 'claude'; $('#aicProg').value = c.program; $('#aicModel').value = c.model; $('#aicEffort').value = c.effort; $('#aicArgs').value = (c.args || []).join('\n');
      if (note) { out.hidden = false; out.textContent = note; }
      const kind = () => fixed ? c.id : $('#aicKind').value;
      const sync = () => {
        const k = kind();
        $('#aicProg').placeholder = k === 'custom' ? 'o comando do programa' : fixed ? `vazio: ${k}` : k === 'claude' ? 'openclaude' : 'o comando do programa';
        $('#aicArgsLbl').textContent = k === 'custom' ? 'Argumentos' : 'Opções a mais';
        $('#aicArgs').placeholder = k === 'custom' ? '--model\n{model}\n-p\n{prompt}' : '';
        $('#aicHelp').textContent = HELP[k];
      };
      $('#aicKind').onchange = sync; sync();
      box.querySelectorAll('.aic-tabs [data-id]').forEach(b => b.onclick = () => { cur = list.find(x => x.id === b.dataset.id); draw(); });
      box.querySelector('.aic-tabs [data-new]').onclick = () => { cur = blank(); draw(); };
      const read = () => ({ id: c.id, name: $('#aicName').value.trim(), kind: kind(), program: $('#aicProg').value.trim(), model: $('#aicModel').value.trim(), effort: $('#aicEffort').value, args: $('#aicArgs').value.split('\n').map(s => s.trim()).filter(Boolean) });
      const save = async () => {
        err.textContent = '';
        const saved = await post({ cli: read() });
        list = await api('agents/clis'); cur = list.find(x => x.id === saved.id) || saved;
        BS.hooks.run('aiclis:change', list);
        return saved;
      };
      const busy = (on) => { $('#aicSave').disabled = $('#aicTest').disabled = on; };
      $('#aicSave').onclick = async () => { busy(true); try { await save(); toast('Agente salvo', 'ok'); draw(); } catch (e) { err.textContent = e.message; busy(false); } };
      $('#aicTest').onclick = async () => {
        busy(true); out.hidden = false; out.className = 'aic-out'; out.textContent = 'Perguntando ao agente… pode levar até 3 minutos.';
        try {
          const saved = await save();
          const r = await post({ action: 'test', id: saved.id });
          const secs = (r.ms / 1000).toFixed(1).replace('.', ',');
          draw(r.ok ? `Respondeu em ${secs} s:\n${r.out || '(sem texto)'}` : `Não funcionou${r.timedOut ? ' (passou de 3 minutos)' : ''}:\n${r.err || r.out || 'o programa saiu sem dizer o motivo'}`);
          document.getElementById('aicOut').classList.toggle('bad', !r.ok);
        } catch (e) { out.hidden = true; err.textContent = e.message; busy(false); }
      };
      const del = $('#aicDel');
      if (del) del.onclick = async () => {
        try { await post({ action: 'delete', id: c.id }); list = await api('agents/clis'); cur = list.find(x => x.id === c.id) || list[0]; BS.hooks.run('aiclis:change', list); toast(fixed ? 'Voltou ao padrão' : 'Agente excluído', 'ok'); draw(); }
        catch (e) { err.textContent = e.message; }
      };
      if (!c.id) $('#aicName').focus();
    });
  }
  BS.aiClis = { open, list: () => api('agents/clis') };
  BS.actions.add([{ label: 'Agentes de IA: modelo, esforço e programas (Claude Code, Codex, outros)', run: () => open() }]);
})();
