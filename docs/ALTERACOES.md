# Alterações: o que mudou, quando e por quem

O painel **Alterações** (`Alt+2`) junta o que antes eram dois painéis (Alterações e Histórico). Funciona com Git e com SVN. Ele tem duas partes:

- **na esquerda**, a lista: o que você ainda não commitou, os commits e a comparação de duas versões;
- **na área grande**, uma aba fixa com a linha do tempo de todos os repositórios da pasta e o **Investigar incidente**.

A aba fixa aparece quando o painel é escolhido e sai quando você escolhe outro painel. Abrir um arquivo não troca o painel: a lista continua na esquerda.

## O painel (esquerda)

| Modo | O que mostra |
|---|---|
| **Local** | O que ainda não foi commitado. O diff é editável, e o commit sai dali (veja [Commit e branches](#commit-e-branches)). |
| **Histórico** (`Alt+3`) | Os commits por dia. O commit escolhido abre ali mesmo os arquivos dele. |
| **Comparar** | Duas versões quaisquer (commit, branch, tag, revisão) ou uma versão com o disco. |

No **Histórico**:

- A busca filtra por mensagem, autor ou hash. **Arquivo** mostra só os commits que mexeram no arquivo aberto.
- Clique num commit para abrir os arquivos dele; clique de novo para recolher. `Alt+PageUp` e `Alt+PageDown` andam de commit em commit.
- Dentro do commit: `Alt+←` e `Alt+→` passam de arquivo em arquivo, o ✓ marca o arquivo como visto e a barra mostra quantos faltam. Em commits grandes aparece o filtro de arquivos, e as pastas recolhem.
- Passe o mouse num commit: **⇄ local** compara com o que está no disco e **◎ base** marca o commit para comparar com outro. O botão direito tem as mesmas ações, mais copiar hash e mensagem.

A lista de arquivos de um commit vem do cache quando ele já foi aberto, e o commit sob o mouse é carregado antes do clique.

## Commit e branches

No modo **Local**, embaixo da lista:

- **Escolher os arquivos.** Cada arquivo tem uma caixa; só os marcados entram no commit. A caixa do título marca ou desmarca todos. Arquivos novos entram sozinhos (`git add` / `svn add`) e os apagados saem do repositório.
- **Mensagem e Commit.** Escreva a mensagem e clique em **Commit** (`Ctrl+Enter`). O que está aberto e ainda não foi salvo é gravado antes. A mensagem fica guardada enquanto você olha os diffs.
- **Git: enviar junto.** A seta ao lado do botão tem **Commit e enviar (push)** (`Ctrl+Shift+Enter`). **Emendar o último** junta os arquivos ao commit anterior (com a mensagem dele, se você não escrever outra); não use em commit que já foi enviado.
- **Git: a branch.** O botão com o nome da branch abre a lista: clique numa para trocar, digite um nome que não existe para criar a partir da atual, e as do remoto aparecem embaixo (escolher uma cria a local que acompanha). As alterações locais vão junto na troca; se a troca apagaria alguma, o Git recusa e a IDE avisa. **Atualizar do remoto** busca as branches que os outros criaram.
- **Git: trazer e enviar.** As setas ↓ e ↑ fazem pull e push. Ao lado da branch aparece quanto falta trazer (↓2) e enviar (↑1); "só aqui" é uma branch que ainda não existe no remoto (o primeiro envio cria ela lá). O pull só avança (`--ff-only`): se você e o remoto mudaram a mesma branch, a IDE avisa em vez de criar um merge sozinha.
- **SVN.** O commit já envia para o servidor. Não há branches nem push: troca de branch no SVN continua pelo `svn switch`.

Se o remoto pedir login, faça um `git push` pelo terminal uma vez: a credencial fica guardada pelo Git e os próximos saem pela IDE. Pela rede local (outro PC ou celular), o painel mostra as alterações, mas não commita.

## Pasta com vários repositórios

Abra como projeto a pasta que guarda os repositórios (a pasta em si não precisa ser um). A IDE procura checkouts Git e SVN até três níveis abaixo.

- **Local** lista cada repositório com o branch e o número de alterações. Os que têm alteração já vêm abertos.
- Clique num arquivo para ver o diff (aba só de leitura). **Abrir no editor**, no botão direito, abre o arquivo para editar.
- Botão direito num repositório: **Abrir como projeto**, **Ver na linha do tempo**, **Terminal aqui**, **Mostrar no Explorer**, **Copiar caminho** e **Copiar branch**.
- Botão direito num arquivo: **Ver diferenças**, **Abrir no editor**, **Mostrar no Explorer**, **Copiar caminho** e **Abrir o repositório como projeto**.

O número no ícone do painel é a soma das alterações locais de todos.

## A tela grande

- **Período:** 24 h, 3 dias, 7 dias ou 30 dias.
- **Linha do tempo:** uma faixa por repositório (num repositório só, uma faixa por pessoa). Cada ponto é um commit; quanto maior a mudança, maior o ponto. Losango é commit com tag, que costuma ser uma versão implantada. Clique no ponto para ir ao commit.
- **Commits:** por dia, de todos os repositórios juntos. A busca aceita mensagem, autor, nome de arquivo ou hash. O commit abre os arquivos; o arquivo abre o diff.
- **Ao lado:** os repositórios (clique filtra, botão direito tem as ações), os arquivos **mais mexidos** e **quem mexeu**. Clicar num arquivo ou numa pessoa filtra a lista.

## Investigar incidente

Para quem pegou um incidente e precisa saber o que mudou antes de o problema começar.

1. Clique em **Investigar incidente** (ou busque "Investigar incidente" no Buscar em tudo).
2. Em **Começou**, ponha a hora em que o problema apareceu. Os atalhos preenchem "agora", "há 1 h", "há 3 h" e "hoje cedo".
3. Se tiver, cole o erro, o stack trace ou palavras do chamado. É opcional.
4. Clique em **Investigar** (`Ctrl+Enter` no campo do erro).

A tela passa a mostrar os commits do período **antes** do início, do mais para o menos suspeito, com uma nota de 0 a 100 e o motivo em frases curtas:

| Motivo | Quando aparece |
|---|---|
| "2 h antes do início" | O commit entrou perto da hora do problema. Quanto mais perto, maior a nota. |
| "mudança grande" | Muitos arquivos ou muitas linhas. |
| "mexe em configuração ou dependências", "banco de dados", "implantação" | `application.yml`, `pom.xml`, `package.json`, `.sql`, migrations, `Dockerfile`, pipelines. |
| "mensagem de correção às pressas" | `hotfix`, `revert`, `rollback`, `workaround`, "urgente", "temporário". |
| "mudou linhas com «nome»" | Uma linha somada ou removida pelo commit contém um nome citado no erro. As linhas aparecem embaixo do arquivo; clique para abrir o diff nela. |
| "mexe em «nome», citado no erro" | O commit alterou um arquivo com esse nome. |

Como a IDE lê o erro colado:

- Ela tira os nomes de classes, métodos, arquivos e tabelas dos quadros da pilha (Java, C#, Python, JavaScript), de `FROM`/`INTO`/`UPDATE` e de nomes compostos (`PedidoService`, `valor_total`).
- Quadros de bibliotecas (`java.`, `org.springframework`, `node_modules`...) e exceções genéricas (`NullPointerException`) ficam de fora: não dizem onde o seu código mudou.
- Poucas palavras numa linha só são usadas como estão, separadas por vírgula ou espaço.
- Os termos aparecem como etiquetas. O × tira um termo e refaz a busca. São no máximo 12.

Outras ações:

- **Descartar** (no commit aberto ou no botão direito) tira um commit da lista de suspeitos. Ele vai para **Descartados**.
- **Depois do início** guarda os commits que entraram depois da hora informada, fora da ordem de suspeita.
- A linha vermelha na linha do tempo marca o início. Os pontos ficam vermelhos, âmbar ou azuis conforme a nota.
- **Copiar relatório** copia os suspeitos em Markdown (motivos, arquivos e linhas), pronto para o chamado.
- **Encerrar** volta para a visão normal. O incidente fica lembrado por projeto até você encerrar.

A nota é uma ajuda para decidir por onde começar a olhar. Ela não prova que o commit causou o problema.

No SVN, a linha do tempo não traz as linhas somadas e removidas de cada arquivo, e a busca dos termos lê no máximo as 100 revisões mais recentes do período.

## Quem mudou esta linha

`Alt+Shift+B` (ou o botão direito no editor) diz qual commit deixou a linha como está e abre o diff dela naquele commit. No Git, o fim da linha do cursor mostra o autor e a data.

## Para plugins

| | |
|---|---|
| `bs.vcs.showHistory()` | Abre o painel no modo Histórico. |
| `bs.vcs.fileHistory(caminho)` | Histórico de um arquivo. |
| `bs.vcs.openAtCommit(commit, caminho, linha)` | Abre um commit (e um arquivo dele). |
| `bs.vcs.compare(base, alvo, caminho)` | Compara duas versões. |
| `bs.vcs.repos()` | Os repositórios da pasta aberta: `[{ path, rel, name, vcs, branch, dirty, last }]`. |
| `bs.vcs.repoDiff(repo, caminho, { mode, rev, base }, linha)` | Diff de um arquivo de outro repositório, numa aba só de leitura. |
| `bs.hooks.filter('menu:repo', (itens, repo) => ...)` | Itens no botão direito de um repositório. |
| `bs.hooks.filter('menu:commit', (itens, commit) => ...)` | Itens no botão direito de um commit do painel. |

Rotas do núcleo: `repos?project=&depth=`, `timeline?project=&since=&until=&n=` (tempos em segundos unix) e `scan?project=&since=` (POST `{ terms: [...] }`). Para gravar (só do próprio PC): `POST vcs/commit { files: [{ path, code }], message, amend, all }`, `GET vcs/branches`, `POST vcs/checkout { name, create }` e `POST vcs/sync { action: push | pull | fetch }`.
