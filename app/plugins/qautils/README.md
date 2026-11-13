# QAutils

Cenários de QA no BlueScreen, em Gherkin (Cucumber). É um plugin nativo e só tem interface: usa o índice e a busca do núcleo, a pasta de dados do plugin e o console de Build. Não sobe nenhum servidor.

O painel **QAutils** (`Alt+9`, se nenhum outro plugin usar a tecla) mostra os cenários do projeto. Com ele escolhido, a área do editor ganha a aba fixa **QAutils**, na primeira posição: o quadro de execução.

## Quadro de execução (aba fixa)

- **Indicadores:** cenários, % executado, passou, falhou, bloqueado e não executado do que está filtrado.
- **Quadro:** uma coluna por status (Não executado, Passou, Falhou, Bloqueado), com um cartão por cenário: CT, chamado, título, feature, tags, anotação, evidências e a data da execução.
  - **Arrastar o cartão** para outra coluna muda o status. É o mesmo status do painel e do editor: os três andam juntos.
  - **Clique** (ou `Enter`) abre a feature na linha do cenário. Clique no chamado abre o link ou copia; clique na tag filtra por ela.
  - **Botão direito:** status, anotação, relatório de bug, evidências, copiar o cenário, chamado e, em projeto automatizado, executar.
  - Cada coluna desenha 60 cartões de cada vez (**Mais…** traz os seguintes).
- **Filtros:** busca (cenário, passo, `@tag`, arquivo ou chamado), chamado, tag e pasta. Um filtro com uma opção só não aparece.
- **Cobertura:** uma linha por chamado, tag ou pasta, com a barra passou/falhou/bloqueado/não executado e os números. As piores vêm primeiro (mais falhas, mais bloqueios, menos executado). Clique na linha para ver só ela no quadro.
- **Relatório** e **CSV:** o relatório de evidências e os casos de teste só dos cenários filtrados, na pasta comum das features deles.
- Em área estreita as colunas se empilham e a tela rola inteira.

## Bug a partir de um cenário

No status de um cenário (acima dele, no editor) há **Abrir relatório de bug deste cenário…**, com a pré-condição, os passos, o esperado, o chamado e as evidências já preenchidos. Copia como texto (para o chamado) ou Markdown (Jira, Azure, GitHub), ou salva em `qa/bugs/`.

---

# Cenários (Gherkin / Cucumber)

## Painel (aba Cenários)

- **Features:** as features por pasta (equipe, mês), com o **chamado** do nome do arquivo em destaque (`INC1753202`, `PRB0068833`, `SDIGBSID00-2429`), o número de cenários e uma barra com o andamento da execução. "Recentes" ordena pelo que foi mexido por último. A seta abre os cenários de cada feature.
- **Busca:** texto (nome do arquivo, da funcionalidade, dos cenários e dos passos), `@tag` ou o número do chamado.
- **Tags:** as tags com contagem. Clique para filtrar. Em projeto automatizado, ▶ roda a tag.
- **Execução:** o percentual executado, ✓ passou, ✗ falhou, ⊘ bloqueado e ○ não executado, com as features com falha primeiro. Daqui saem o relatório de evidências e o CSV do que a busca encontrou.
- Botão **+**: nova feature. Clique no chamado: abre o link (veja as configurações) ou copia o número.

## Nova feature de chamado

No **+** do painel, no botão direito numa pasta (**Nova feature aqui…**) ou no Buscar em tudo (**QA: Nova feature**):

- **Nome do arquivo:** `CHAMADO - Título.feature`.
- **Pasta do mês:** se a pasta escolhida já tem subpastas por mês (`OUTUBRO`, `OUTUBRO-2026`, `outubro_2026`), a feature vai para a do mês atual, no mesmo estilo.
- **Conteúdo:**
  - `# language: pt` (ou o idioma do projeto);
  - a tag do chamado (`@INC1753202`);
  - a história de usuário (Como / Eu quero / Para que);
  - os cenários já numerados (`CT001`, `CT002`…).

## No editor (`.feature`)

- **Acima de cada cenário:** o status (**○ Não executado → ✓ Passou / ✗ Falhou / ⊘ Bloqueado**, com anotação), as **📷 Evidências** e **Copiar**, que copia o cenário em texto pronto para colar no chamado, com o resultado. Cenário executado ganha uma **faixa colorida na margem esquerda**, do título ao último passo: verde (passou), vermelha (falhou) ou amarela (bloqueado).
- **Acima da funcionalidade:** o resumo da execução, o **Relatório de evidências** e o **Exportar CSV**.
- **Autocompletar:**
  - palavras-chave no idioma do arquivo; num arquivo novo, no idioma da configuração ou das features do projeto (sem features: **português**);
  - em português: `Funcionalidade`, `Contexto`, `Cenário`, `Esquema do Cenário`, `Exemplos`, `Regra`, `Dado`/`Dada`/`Dados`/`Dadas`, `Quando`, `Então`, `E`, `Mas`. Dá para digitar sem acento (`cenario`, `entao`) ou o termo em inglês (`feat`, `scen`, `then`): a sugestão já vem em português;
  - a primeira palavra-chave em português põe o `# language: pt` na primeira linha (sem ele o Cucumber lê o arquivo como inglês). Arquivo sem esse cabeçalho ganha um aviso, e **Alt+Enter** o adiciona;
  - cenário novo já com o próximo número (`CT006`);
  - os passos já escritos no projeto (os mais usados e os do mesmo tipo Dado/Quando/Então primeiro);
  - as step definitions, com os parâmetros para preencher;
  - `@tags` (inclusive a do chamado do arquivo);
  - as `<colunas>` dos Exemplos.
- **Passo parecido:** quando um passo é quase igual a um padrão do projeto (outra grafia, um acento, uma palavra trocada), o editor avisa e **Alt+Enter** troca pelo padrão.
- **Alt+Enter no cabeçalho da funcionalidade ou de um cenário:**
  - **mover os passos repetidos para o `Contexto`:** os que abrem todos os cenários do mesmo jeito; o primeiro passo que sobra vira "Quando/Então" se começava com "E";
  - **converter as palavras-chave** para português ou inglês (Feature ↔ Funcionalidade, Given ↔ Dado...), sem mexer na descrição, nas tabelas nem nas docstrings (só no cabeçalho da funcionalidade);
  - **renumerar os cenários** (`CT001`, `CT002`… mantendo o prefixo e a largura);
  - **formatar e alinhar as tabelas**.
- **Shift+Alt+F:** formata (recuo padrão, tabelas alinhadas, docstrings preservadas).
- **Estrutura:** **Ctrl+F12** e a trilha mostram a funcionalidade e os cenários.
- **Navegação:** **Shift+F12** mostra onde mais o passo é usado. Passar o mouse mostra quantas vezes ele aparece.
- **Comentário que parece tag** (`#Sistema_E2E_...`): **Alt+Enter** transforma em `@tag` acima da funcionalidade.

## Evidências e relatórios

- **Evidências:** tire o print (**Win+Shift+S**), clique em **📷 Evidência** acima do cenário e cole com **Ctrl+V**, ou arraste imagens. Elas ficam ao lado da feature: `<pasta>/evidencias/<nome da feature>/CT001_1.png`. Vão para o repositório junto da feature, se você quiser.
- **Relatório de evidências (HTML):** funcionalidade, cenários, passos, Exemplos, status, data, QA, observações e as imagens. Abre no navegador, onde dá para imprimir em PDF. O de uma feature fica na pasta das evidências dela; o de uma pasta, em `relatorio-evidencias.html`.
- **CSV:** casos de teste para Excel, Xray, Zephyr ou Azure Test Plans, com as colunas Chamado, Arquivo, Funcionalidade, ID, Cenário, Tags, Pré-condições (Contexto + Dado), Passos (Quando), Resultado esperado (Então), Exemplos, Status, Executado em, QA e Observação. Separado por `;`, abre direto no Excel em português, e o BlueScreen o abre como planilha.

O status de execução é seu (fica na pasta de dados do plugin, em `~/.bluescreen/plugin-data/qautils`). O relatório e o CSV levam o status para quem precisar.

## Automação

Quando o projeto tem step definitions (Java, Kotlin, JS/TS, Ruby, Python/behave ou C#/SpecFlow), o modo automação liga sozinho:

- **Steps:** os sem definição e os ambíguos ficam marcados. **Alt+Enter** gera a definição no idioma da feature (`@Dado`, `@Quando`, `@Entao` com o import de `io.cucumber.java.pt`, ou `Given`/`When`/`Then`) e insere no arquivo de steps que você escolher.
- **F12 / Ctrl+clique** num passo vai para a step definition.
- **▶ Executar** a feature, o cenário ou uma tag:
  - **Maven:** `mvn test -Dcucumber.features=arquivo:linha`, só com a classe do Cucumber;
  - **Gradle:** `cleanTest test`, com `CUCUMBER_FEATURES`;
  - **npm:** `npx cucumber-js`;
  - **Ruby:** `bundle exec cucumber`;
  - **behave**.

  A saída vai para o console de Build.

## Configurações (engrenagem na aba Plugins)

| | |
|---|---|
| Seu nome | vai nos relatórios e nos bugs |
| Ambientes | um por linha, `NOME=endereço`: o relatório de bug oferece a lista |
| Pasta dos relatórios de bug | `qa` (os bugs salvos ficam em `qa/bugs/`) |
| Modo | automático (documentação sem step definitions), documentação ou automação |
| Idioma das features novas | o mesmo do projeto, português ou inglês |
| Prefixo dos cenários | `CT` (CT001, CT002…) |
| Pasta das evidências | `evidencias` |
| Links dos chamados | um por linha, `PREFIXO=endereço com {id}`, ex.: `INC=https://empresa.service-now.com/nav_to.do?uri=incident.do?sysparm_query=number={id}` |
| Passo parecido | liga/desliga o aviso |
