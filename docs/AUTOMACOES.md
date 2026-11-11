# Automator, Agenda, Conselho de agentes e Biblioteca

Quatro plugins que vêm com o BlueScreen.

- O **Automator** é uma tela inteira: tem um ícone na barra da esquerda e abre numa aba do editor, ao lado dos arquivos. Enquanto essa aba está na frente, a lista de fluxos fica no painel da esquerda, no lugar do painel de arquivos; ao voltar para um arquivo, o painel anterior volta.
- **Agenda**, **Agentes** e **Biblioteca** abrem cada um numa janela do balão flutuante (o botão de menu no canto da tela), que dá para mover, maximizar ou arrastar pelo topo até uma região da IDE.

Todos também abrem pelo **Buscar em tudo** (`Shift` `Shift`): "Automator", "Agenda", "Agentes", "Biblioteca".

## Automator

Automações montadas com nós ligados por fios, no modelo dos Fluxos do HexLab.

### Monte um fluxo

1. Clique no ícone do **Automator** na barra da esquerda. No painel da esquerda, clique em **Novo fluxo**, ou em **Modelos** para partir de um pronto.
2. **Adicionar nó** (ou duplo clique no quadro) abre o seletor de nós. Digite para buscar.
3. Para ligar dois nós, arraste da bolinha de um até a bolinha do outro. Soltar o fio no vazio abre o seletor e já liga o nó escolhido. O **+** ao lado de uma saída livre faz o mesmo.
4. Clique num nó para preencher os campos dele no painel da direita.
5. **Executar** salva e roda. Cada nó mostra o andamento: girando, concluído com o tempo, ou o erro.

No quadro:

| Para | Faça |
|---|---|
| mover a vista | arraste o fundo |
| aproximar e afastar | roda do mouse (no ponto do cursor) ou os botões no canto |
| enquadrar tudo | `F` |
| selecionar vários | `Shift` + clique, ou `Shift` + arrastar no fundo |
| remover uma ligação | clique no fio e `Delete`, ou duplo clique no fio |
| duplicar | `Ctrl+D` (ou `Ctrl+C` e `Ctrl+V`) |
| desfazer e refazer | `Ctrl+Z` e `Ctrl+Shift+Z` |
| salvar | `Ctrl+S` |
| arrumar em colunas | botão **Organizar** na barra |

O botão direito num nó desliga, duplica ou exclui. Um nó desligado é pulado na execução.

Sem nenhum nó selecionado, o painel da direita mostra as execuções do fluxo. Abra uma para ver o que cada nó entregou.

A aba do Automator funciona como a de um arquivo: o ponto nela avisa que o fluxo tem alterações, `Ctrl+S` e **Salvar tudo** gravam, e fechar a aba (ou sair do BlueScreen) com alterações pergunta antes. O salvamento automático da IDE não grava fluxos: um fluxo só muda quando você salva.

### Nós

| Nó | O que faz |
|---|---|
| **Gatilhos** | |
| Iniciar manualmente | Começa quando você clica em **Executar**. Entrega o texto de exemplo. |
| Agenda | Começa sozinho: a cada intervalo (em minutos) ou num horário, nos dias da semana marcados. |
| Ao abrir o BlueScreen | Começa sozinho quando o BlueScreen é aberto. |
| Quando um arquivo mudar | Começa quando o arquivo, ou algo no primeiro nível da pasta, é criado ou alterado. Entrega `path`, `name` e `files`. A conferência é a cada cinco segundos. |
| **Dados** | |
| Texto | Monta um texto com o que chegou. |
| Montar objeto | Monta um objeto com os campos que você definir. |
| Data e hora | Entrega a data e a hora de agora no formato pedido (`%d/%m/%Y %H:%M`), com dias a somar. |
| Substituir texto | Troca um trecho por outro, por texto exato ou expressão regular. |
| Extrair do texto | Pega o trecho que casa com uma expressão regular: o primeiro, ou todos numa lista. |
| Dividir em lista | Divide um texto por linha, vírgula, ponto e vírgula ou outro separador. |
| Resultado | Mostra o que chegou como resultado da execução. |
| **Lógica** | |
| Condição | Compara um valor e segue por **sim** ou por **não**: igual, diferente, contém, maior, menor, vazio, verdadeiro. `"5"` e `5` contam como iguais. |
| Esperar | Pausa de 0 a 3.600 segundos. |
| Parar com erro | Encerra o fluxo como falha, com a mensagem que você escrever. |
| **Arquivos** | |
| Ler arquivo | Entrega o texto de um arquivo. |
| Gravar arquivo | Grava um texto num arquivo: substitui, ou acrescenta no fim. Cria a pasta se faltar. |
| Listar arquivos | Entrega a lista dos arquivos de uma pasta, com filtro (`*.pdf`). |
| Arquivo existe? | Segue por **sim** ou por **não**. |
| Copiar, mover ou excluir | Copia ou move um arquivo, ou manda para a Lixeira. |
| **Windows** | |
| Executar programa | Roda um programa com os argumentos (um por linha) e entrega o que ele escreveu. Código de saída diferente de zero falha o fluxo. |
| Script PowerShell | Roda um script de várias linhas e entrega o que ele escreveu. O que chegou no nó fica em `$env:BS_INPUT`. |
| Abrir | Abre um arquivo, uma pasta ou um site no programa padrão. |
| Área de transferência | Lê o texto copiado, ou copia um texto. |
| Notificação | Mostra um aviso do Windows. |
| **Rede** | |
| Requisição HTTP | Chama um endereço e entrega a resposta. Resposta em JSON chega como objeto. Status fora de 2xx falha o fluxo. |
| Baixar arquivo | Baixa um endereço e grava num arquivo. |
| Ferramenta MCP | Chama uma ferramenta de um servidor MCP por HTTP. |
| **IA** | |
| Perguntar à IA | Envia um pedido ao Codex ou ao Claude Code, só com leitura, e entrega a resposta. |
| OpenRouter | Envia um pedido a um modelo do OpenRouter, com o token do Cofre. |
| Revisar decisão | Só continua se os agentes escolhidos aprovarem. Precisa do plugin **Conselho de agentes** ligado. |

Com o plugin **Navegador** ligado, a paleta também tem **Automatizar site** (veja [Automatize um site](#automatize-um-site)). Outros plugins podem acrescentar nós: veja [Crie nós com um plugin](#crie-nós-com-um-plugin).

Um fluxo aceita até 200 nós e 1.000 ligações, sem ciclos. Quando um nó falha, os seguintes não rodam. Se várias ligações chegam à mesma entrada, o nó recebe uma lista com os valores.

### Use a saída de outro nó

Nos campos de texto, o link **+ dado** insere a expressão para você. Elas são:

| Expressão | Valor |
|---|---|
| `{{input}}` | O que chegou neste nó. |
| `{{input.campo}}` | Um campo do que chegou. Vale `{{input.itens.0.nome}}` para listas. |
| `{{nodes.ID.out}}` | A saída de outro nó. Na Condição, as saídas são `true` e `false`. |
| `{{nodes.ID.out.campo}}` | Um campo dessa saída. |

Uma expressão sozinha no campo mantém o tipo (objeto, número). No meio de um texto, vira texto. Se o que chegou é um texto em JSON (a saída de um programa, por exemplo), o campo é lido de dentro dele.

Para rodar um comando do PowerShell, use `powershell` como programa e, nos argumentos, uma linha para cada um:

```
-NoProfile
-Command
Get-Date
```

O programa é chamado direto, com os argumentos separados: não há shell no meio.

### Rode sozinho

Use um gatilho automático (**Agenda**, **Ao abrir o BlueScreen** ou **Quando um arquivo mudar**) e acenda o interruptor **Ligado** na barra do fluxo. Com a Agenda, a lista mostra a próxima execução. Um fluxo pode ter um gatilho manual e um automático: o botão **Executar** segue pelo manual e o disparo automático segue pelo gatilho que disparou.

Os gatilhos valem enquanto o BlueScreen estiver aberto, inclusive na bandeja. Eles não iniciam o BlueScreen com o Windows nem acordam o computador.

### Automatize um site

O plugin **Navegador** acrescenta o nó **Automatizar site**: ele abre o Edge (ou o Chrome) num perfil próprio, entra no endereço e segue os passos, de cima para baixo.

| Passo | O que faz |
|---|---|
| Clicar | Clica no elemento. |
| Digitar | Limpa o campo e digita o valor. |
| Escolher opção | Escolhe, numa lista, a opção com esse texto ou valor. |
| Apertar tecla | Enter, Tab, Escape, Espaço, setas. |
| Esperar aparecer | Só continua quando o elemento aparece. |
| Ler texto | Guarda o texto do elemento. O valor do passo é o nome do campo na saída. |
| Ir para endereço | Abre outro endereço na mesma janela. |
| Esperar (segundos) | Pausa. |
| Capturar tela | Grava um PNG da página no arquivo informado. |

Em **Onde**, use um seletor CSS (`#senha`, `.botao`, `input[name=email]`) ou `texto=Entrar`, que acha o botão, o link ou o campo pelo texto visível (ou pelo texto de exemplo do campo). Cada passo espera o elemento aparecer, até o limite do nó.

O nó entrega `url`, `title` e `values`, com o que os passos **Ler texto** guardaram: `{{input.values.saldo}}`.

Para trocar uma senha num site, por exemplo:

1. Guarde a senha no Cofre (`Alt+8`) com o nome `site` e libere para o plugin **Navegador** e o programa `node`.
2. No nó, ponha o endereço da página de login e os passos: **Digitar** em `#usuario`, **Digitar** em `#senha` com `{{vault:site}}`, **Clicar** em `texto=Entrar`, e assim por diante até **Clicar** em `texto=Salvar`.
3. Termine com **Ler texto** na mensagem de confirmação, para o fluxo saber que deu certo.

A senha não fica no fluxo nem aparece no histórico: o núcleo entrega o valor só ao programa do nó e o tira do que volta. O perfil do navegador é só desse nó e guarda os logins entre as execuções. Se um passo falha, a execução diz qual; com a janela à mostra, ela fica aberta para você ver onde parou.

Esse nó precisa do Node.js 22 ou mais novo. Sites com CAPTCHA ou confirmação em dois passos param no passo em que a página pede isso.

### Crie nós com um plugin

Qualquer plugin do BlueScreen acrescenta nós ao Automator com um arquivo `automator.json` na pasta dele. Cada nó declara os campos que o painel desenha e o programa que roda:

```json
{
  "nodes": [{
    "type": "maiusculas", "name": "Maiúsculas", "category": "Texto", "desc": "Passa o texto para maiúsculas.",
    "params": { "text": "{{input}}" },
    "fields": [{ "name": "text", "label": "Texto", "kind": "area" }],
    "run": { "program": "node", "args": ["maiusculas.js"], "timeout": 30000 }
  }]
}
```

```js
// maiusculas.js: recebe um JSON pela entrada padrão e escreve a saída do nó
let s = ''; process.stdin.on('data', d => s += d).on('end', () => {
  const { params } = JSON.parse(s);
  process.stdout.write(JSON.stringify(String(params.text).toUpperCase()));
});
```

- O nó aparece na paleta como `plugin.<id do plugin>.<type>`, enquanto o plugin estiver ligado. `category` pode ser uma das que existem ou um nome novo.
- **Campos** (`kind`): `text`, `area`, `number` (`min`, `max`), `select` (`options`), `checks`, `time`, `json`, `lines` (um item por linha) e `rows` (uma lista de linhas, com `columns`). `show: { "campo": ["valor"] }` mostra o campo só quando outro tem um desses valores.
- **Entrada do programa:** `{ node, params, input, data, secrets }`. As expressões já chegam resolvidas em `params`; `data` é a pasta de dados do plugin.
- **Saída:** o que o programa escreve na saída padrão, lido como JSON (ou como texto). Código de saída diferente de zero falha o nó com o que ele escreveu na saída de erro. Com mais de uma saída em `outputs`, responda `{ "port": "nome", "value": ... }`.
- **Segredos:** `{{vault:nome}}` num parâmetro não vai no JSON. O valor chega numa variável de ambiente, e `secrets` diz qual (`{ "{{vault:nome}}": "BS_SECRET_0" }`). O Cofre só entrega se o segredo estiver liberado para o plugin e para o programa.
- O programa roda na pasta do plugin, com o Node.js, o Python ou o que estiver no PC. O plugin **Navegador** (`app/plugins/navegador`) é um exemplo completo.

Dá para pedir um plugin desses ao **IAMaker**: descreva o nó e diga que ele vai num `automator.json`.

O núcleo roda até quatro coisas ao mesmo tempo (fluxos, revisões e propostas de IA). Um disparo automático sem vaga espera na fila; **Parar** tira da fila ou interrompe a execução.

### Crie com IA

**Criar com IA** pede a descrição da automação e quem monta (Claude Code, Codex ou OpenRouter). A proposta abre no quadro, desligada e sem salvar, para você conferir. O Claude Code e o Codex precisam estar instalados e com login feito.

### OpenRouter e tokens

1. No nó OpenRouter, clique em **Guardar o token no Cofre** (ou abra o Cofre com `Alt+8`).
2. Guarde o token na janela do Cofre e libere o segredo `openrouter` para o Automator.
3. Informe o modelo no nó, no formato `provedor/modelo`.

O fluxo guarda só o nome do segredo. O núcleo põe o token no cabeçalho da chamada e o tira da resposta. Em Requisição HTTP e Ferramenta MCP, use `{{vault:nome}}` nos cabeçalhos:

```json
{ "Authorization": "Bearer {{vault:meu-servico}}" }
```

### Ferramenta MCP

Informe o endereço do servidor, o nome da ferramenta e os argumentos (um objeto JSON). O nó fala Streamable HTTP (versões `2025-03-26`, `2025-06-18` e `2025-11-25`), aceita resposta em JSON ou SSE e encerra a sessão depois da chamada. Ele não inicia servidores por `stdio`, não faz login OAuth e não lista as ferramentas do servidor.

### Importe e exporte

O menu **⋯** da barra importa e exporta o fluxo em JSON, com os mesmos campos do HexLab (`nodes`, `edges`, `position`, `from_port`, `to_port`). Um fluxo importado entra desligado. Só os nós do Automator são aceitos: fluxos do HexLab que usam modelos locais precisam ser adaptados.

## Agenda

1. Abra a **Agenda** e clique no dia.
2. **Novo** (ou duplo clique no dia) abre o compromisso: título, dia, hora, repetição e notas.
3. Com o Automator ligado, **Na hora, rodar também** escolhe um fluxo para executar junto com o aviso.

Na hora marcada chega um aviso do Windows. Em cada compromisso dá para concluir, adiar (10 minutos, 1 hora, amanhã), editar e excluir. Os que repetem aparecem em todos os dias em que caem; neles, no lugar de concluir e adiar, **Parar de repetir** suspende os avisos até você mandar voltar. **Passaram do horário** lista os que já avisaram e ninguém concluiu.

Os horários são conferidos a cada cinco segundos. Se o BlueScreen estava fechado na hora, o aviso chega uma vez ao abrir; um compromisso que repete pula para a próxima ocorrência.

## Bandeja do Windows

Fechar a janela principal esconde o BlueScreen na área de notificação, para a agenda e os fluxos continuarem. Na primeira vez, um aviso mostra onde ele ficou.

- Clique no ícone para voltar.
- Botão direito no ícone, **Sair do BlueScreen**, encerra. Se houver arquivos (ou um fluxo) com alterações não salvas, a IDE pergunta antes.
- Pelo terminal: `BlueScreen.exe --quit`. O `start.bat` usa isso antes de recompilar.

Janelas abertas com `--doc` continuam fechando normalmente. Nos modos `--web` e `--no-open` não há ícone nem aviso do Windows: os eventos ficam só no log.

## Conselho de agentes

1. Abra **Agentes** e escreva a proposta: a decisão, o contexto e a solução.
2. Confira a pasta que os agentes podem ler e escolha Codex, Claude Code ou os dois.
3. **Pedir revisão** (ou `Ctrl+Enter`).

Cada agente analisa sozinho, só com leitura, usando o programa e o login deste PC. A proposta só é aprovada quando todos aprovam. Pedido de ajuste, rejeição, resposta fora do formato, programa ausente e falha de login bloqueiam. Cada agente tem até três minutos. O histórico guarda as cem últimas revisões.

### No IAMaker

A revisão antes de aplicar um plugin é opcional e vem **desligada**. Para ligar, abra as configurações do IAMaker e marque **Revisar com o Conselho de agentes antes de aplicar**; escolha os revisores no campo ao lado. Ligada, cada aplicação espera os revisores e usa a sua conta de cada um. Se eles pedem correções, elas voltam ao agente principal. Se um revisor não responde, o plugin fica sem carregar até você aplicar de novo.

## Biblioteca de plugins

A Biblioteca mostra em cartões o catálogo dos servidores de plugins, os mesmos da aba **Plugins** (`Alt+7`), com busca e os filtros **Todos**, **Favoritos** e **Instalados**.

- A estrela marca um favorito.
- **⋯ › Exportar coleção** gera um arquivo com os favoritos e os servidores deles.
- **⋯ › Importar coleção** põe os plugins do arquivo nos seus favoritos. Se a coleção aponta servidores que você ainda não tem, a IDE mostra os endereços antes de aceitar. Nada é instalado na importação: a faixa **favoritos ainda não instalados** instala todos de uma vez.

Download, conferência de versão e de hash são os do núcleo. Para hospedar o catálogo da equipe, veja [Servidor de plugins](../app/plugin-server/README.md).

## Dados e testes

Fluxos, fila, compromissos, execuções e revisões ficam em `~/.bluescreen/automation.json`. O histórico guarda as cem últimas execuções; saídas muito grandes entram cortadas. Depois de uma queda do processo, o que estava rodando aparece como `interrompido`. Os tokens ficam no Cofre. Essas rotas só respondem pelo PC local.

`BLUESCREEN_AUTOMATION_FILE` aponta outro arquivo de dados (os testes usam uma pasta temporária).

Na pasta `app`:

```powershell
cargo test -p bluescreen --offline
cargo build -p bluescreen --offline
python tests/automation_api.py
node tests/iamaker-review.cjs
```

A suíte usa programas e servidor MCP simulados: não chama modelos nem gasta tokens.
