// Linter Universal: o lint das linguagens embutidas vem do plugin (gancho "lint"); aqui só a parte da página.
// Linguagens com lint embutido: o aviso "Análise de código não instalada" não insiste nelas (o servidor de
// linguagem continua disponível pela barra de status, para autocompletar e navegação).
bs.lint = Object.assign(bs.lint || {}, { universal: ['python', 'javascript', 'typescript', 'java', 'rust', 'go', 'c', 'cpp', 'csharp', 'kotlin', 'php', 'ruby', 'lua', 'shell', 'powershell'] });

async function lintProject() {
  if (!bs.S.project) { bs.toast('Abra um projeto'); return; }
  const st = document.getElementById('stLint'); if (st) { st.hidden = false; st.className = 's'; st.textContent = 'lint do projeto…'; }
  try {
    const r = await bs.api('unilint/project', { project: bs.S.project.path });
    document.getElementById('problems').hidden = false;
    document.getElementById('probSub').textContent = `projeto inteiro · ${r.files} arquivos, ${r.lines.toLocaleString('pt-BR')} linhas em ${r.ms} ms`;
    renderProblemList(r.problems, true);
    if (st) { st.hidden = !r.problems.length; st.className = 's warn'; st.textContent = r.problems.length ? `${r.problems.length} problema${r.problems.length === 1 ? '' : 's'} no projeto` : ''; }
    bs.toast(`Linter Universal: ${r.files} arquivos em ${r.ms} ms`, 'ok');
  } catch (e) { if (st) st.hidden = true; bs.toast('Linter Universal: ' + e.message); }
}

bs.actions.add([{ label: 'Linter Universal: analisar o projeto inteiro', icon: bs.I.lint, run: lintProject }]);
bs.hooks.filter('menu:project', (items) => [...items, '-', { label: 'Lint do projeto inteiro (Linter Universal)', icon: bs.I.lint, action: lintProject }]);
