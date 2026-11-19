# Alterações: o que mudou, quando e por quem

O painel **Alterações** (`Alt+2`) junta o que antes eram dois painéis (Alterações e Histórico). Funciona com Git e com SVN. Ele tem duas partes:

- **na esquerda**, a lista: o que você ainda não commitou, os commits e a comparação de duas versões;
- **na área grande**, uma aba fixa com a linha do tempo de todos os repositórios da pasta.

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

- **Local** lista os repositórios agrupados pela pasta de cima, cada um em duas linhas: o nome (cortado no meio quando é comprido, para o fim, que é onde os nomes costumam diferir, ficar à vista) e, embaixo, o branch, quanto falta enviar (↑) e baixar (↓) e o último commit. Os que têm alteração já vêm abertos. O botão da nuvem consulta o remoto de todos (fetch; no SVN, o servidor).
- Clique num arquivo para ver o diff (aba só de leitura). **Abrir no editor**, no botão direito, abre o arquivo para editar.
- Botão direito num repositório: **Abrir como projeto**, **Consultar o remoto (fetch)**, **Ver na linha do tempo**, **Terminal aqui**, **Mostrar no Explorer**, **Copiar caminho** e **Copiar branch**.
- Botão direito num arquivo: **Ver diferenças**, **Abrir no editor**, **Mostrar no Explorer**, **Copiar caminho** e **Abrir o repositório como projeto**.

O número no ícone do painel é a soma das alterações locais de todos.

## A tela grande

- **Período:** 24 h, 3 dias, 7 dias ou 30 dias.
- **Repositórios:** um quadro em cima com cada repositório (agrupado pela pasta de cima), o branch, o **último commit local**, a situação no **origin** (em dia, ↑ para enviar, ↓ para baixar, e o último commit de lá quando é outro) e quantos commits teve no período. Clique na linha para filtrar; clique num commit para abrir ele, mesmo fora do período. **Consultar origin** faz o fetch de todos ao mesmo tempo. Com remota, a lista também traz os commits do origin que você ainda não baixou, com o selo **↓ só no origin**; os seus que ainda não foram enviados levam **↑ não enviado**, e os botões **Não enviados** / **Não baixados** mostram só esses.
- **Linha do tempo:** uma faixa por repositório (num repositório só, uma faixa por pessoa). Cada ponto é um commit; quanto maior a mudança, maior o ponto. Losango é commit com tag, que costuma ser uma versão implantada. Clique no ponto para ir ao commit.
- **Commits:** por dia, de todos os repositórios juntos. A busca aceita mensagem, autor, nome de arquivo ou hash. O commit abre os arquivos; o arquivo abre o diff.
- **Ao lado:** os arquivos **mais mexidos** e **quem mexeu**. Clicar num arquivo ou numa pessoa filtra a lista.

## Quem mudou esta linha

`Alt+Shift+B` (ou o botão direito no editor) diz qual commit deixou a linha como está e abre o diff dela naquele commit. No Git, o fim da linha do cursor mostra o autor e a data.

## Para plugins

| | |
|---|---|
| `bs.vcs.showHistory()` | Abre o painel no modo Histórico. |
| `bs.vcs.fileHistory(caminho)` | Histórico de um arquivo. |
| `bs.vcs.openAtCommit(commit, caminho, linha)` | Abre um commit (e um arquivo dele). |
| `bs.vcs.compare(base, alvo, caminho)` | Compara duas versões. |
| `bs.vcs.repos()` | Os repositórios da pasta aberta: `[{ path, rel, name, vcs, branch, dirty, last, upstream, ahead, behind, remote_last, fetched }]` (à frente e atrás pelo último fetch). `bs.vcs.remoteCheck(repo)` consulta o remoto de um. |
| `bs.vcs.repoDiff(repo, caminho, { mode, rev, base }, linha)` | Diff de um arquivo de outro repositório, numa aba só de leitura. |
| `bs.hooks.filter('menu:repo', (itens, repo) => ...)` | Itens no botão direito de um repositório. |
| `bs.hooks.filter('menu:commit', (itens, commit) => ...)` | Itens no botão direito de um commit do painel. |

Rotas do núcleo: `repos?project=&depth=` e `timeline?project=&since=&until=&n=` (tempos em segundos unix). Para gravar (só do próprio PC): `POST vcs/commit { files: [{ path, code }], message, amend, all }`, `GET vcs/branches`, `POST vcs/checkout { name, create }` e `POST vcs/sync { action: push | pull | fetch }`.
