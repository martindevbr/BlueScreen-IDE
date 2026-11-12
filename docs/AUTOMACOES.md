# Automator, Agenda e Biblioteca

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
| redimensionar um nó | arraste o canto de baixo, à direita (duplo clique nele volta ao tamanho padrão) |
| arrumar em colunas | botão **Organizar** na barra |

O botão direito num nó desliga, duplica ou exclui. Um nó desligado é pulado na execução.

O botão direito num fluxo da lista executa, liga ou desliga, renomeia, duplica, exporta e exclui, sem precisar abrir o fluxo antes.

Sem nenhum nó selecionado, o painel da direita mostra as execuções do fluxo. Abra uma para ver o que cada nó entregou.

A aba do Automator funciona como a de um arquivo: o ponto nela avisa que o fluxo tem alterações, `Ctrl+S` e **Salvar tudo** gravam, e fechar a aba (ou sair do BlueScreen) com alterações pergunta antes. O salvamento automático da IDE não grava fluxos: um fluxo só muda quando você salva.

### Organize a lista em pastas

A lista de fluxos aceita pastas, e a ordem é a que você arrumar.

- **Criar:** o botão de pasta ao lado da busca, ou **Mover para uma pasta… › Nova pasta** no menu do fluxo.
- **Subpastas:** no menu da pasta, **Nova subpasta…** cria uma dentro dela, e **Mover para dentro de…** leva a pasta inteira (com as subpastas e os fluxos) para dentro de outra, ou para fora de todas. Arrastando: soltar uma pasta no meio de outra põe dentro; soltar na borda de cima ou de baixo deixa ao lado, antes ou depois. Vai até seis níveis. A cor de uma pasta vale para as subpastas que não têm cor própria, e o número ao lado do nome conta os fluxos dela e das subpastas.
- **Mover:** arraste o fluxo para cima da pasta. Soltar sobre outro fluxo põe antes ou depois dele (a linha azul mostra onde); soltar em **Sem pasta** tira da pasta. O menu do fluxo tem **Mover para cima**, **Mover para baixo** e **Mover para uma pasta…**. Fluxo trancado também muda de pasta.
- **Pastas:** clique para abrir e fechar. Arraste uma pasta sobre outra para trocar de lugar. Ao passar o mouse aparecem **+** (novo fluxo dentro dela) e **⋯**: mover, cor, renomear, exportar e excluir. Excluir a pasta não apaga fluxo nenhum: eles sobem para a pasta de cima (ou para **Sem pasta**); as subpastas dela saem junto.
- **Cor:** cada pasta pode ter uma de oito cores, que pinta o ícone e a guia dos fluxos dentro dela.
- **Organizar** (o botão de linhas ao lado da busca): recolher ou expandir todas, ordenar os fluxos ou as pastas de A a Z, exportar tudo e importar.
- A bolinha de cada fluxo diz o estado: verde, ligado e rodando sozinho; azul piscando, executando; vazia, manual.

### Exporte e importe vários fluxos

**Exportar todos os fluxos** (em Organizar, ou no menu ⋯ do fluxo) e **Exportar a pasta** (no menu da pasta) abrem a janela **Salvar como** do Windows, para você escolher onde gravar, e gravam um arquivo só, com os fluxos, as pastas (e subpastas), as cores e a ordem. **Exportar** no menu de um fluxo faz o mesmo para ele sozinho. **Importar** aceita esse arquivo ou o de um fluxo só. Os fluxos importados entram desligados, nas pastas em que estavam, e os que você já tem não mudam. Um nó **Chamar fluxo** que apontava para outro fluxo do mesmo arquivo passa a apontar para a cópia importada. As senhas não vão no arquivo: ele leva só os nomes das credenciais (`{{cred:nome}}`), que você guarda de novo no outro PC.

### Salve sozinho

No menu **⋯** da barra do fluxo, **Salvar sozinho a cada alteração** grava o fluxo cerca de um segundo depois de você parar de mexer. O botão passa a mostrar **Salvando…** e **Salvo**. Se o núcleo recusar (um horário de agenda inválido, por exemplo), um aviso aparece uma vez e a gravação volta a ser tentada quando você mexer de novo. Fluxo trancado não é gravado.

### Chame um fluxo dentro de outro

O nó **Chamar fluxo** (categoria Lógica) roda outro fluxo salvo, do começo ao fim, e continua com o resultado dele. Serve para ter um fluxo "Entrar no portal" ou "Avisar o time" pronto e usá-lo em vários outros.

- **Fluxo:** escolha na lista, agrupada pelas pastas. **abrir** leva ao fluxo chamado.
- **O que entregar a ele:** chega no primeiro nó do fluxo chamado, no lugar do que o gatilho dele entregaria. Lá dentro é o `{{input}}` depois do gatilho. Em branco, o gatilho dele decide.
- **O que volta:** o que chegou no nó **Resultado** do fluxo chamado ou, se ele não tem esse nó, a saída do último nó que rodou.
- A execução do fluxo chamado ganha uma entrada própria no histórico dele. Se ele falhar, o fluxo de fora para naquele nó com o motivo. Parar o fluxo de fora para também o de dentro.
- Um fluxo que acabaria chamando a si mesmo é barrado, e a profundidade vai até oito níveis.

### Execuções: ocultas até você pedir

No painel do fluxo, **Execuções** começa oculta, para a tela ficar leve: com ela oculta o Automator busca só a execução mais recente, que é a que pinta os nós no quadro. **mostrar** traz a lista. Aberta, ela tem **Guardar no máximo N execuções** (de 5 a 1000, somando todos os fluxos; o padrão é 100), que já corta o histórico ao mudar, e **limpar**, que apaga as execuções terminadas do fluxo aberto.

### Tranque um fluxo ou um nó

O cadeado na barra do fluxo tranca o fluxo inteiro: ele fica só para visualização. Não dá para mover, ligar, editar, adicionar nem excluir nós, nem renomear ou excluir o fluxo; dá para executar, ligar e desligar o interruptor **Ligado** e ver o histórico. A lista mostra um cadeado ao lado do nome. O próprio núcleo recusa gravar mudanças num fluxo trancado, então a trava vale também para quem chama a API. Clique no cadeado de novo (ou em **Destrancar**, no painel) para voltar a editar. O botão direito na lista também tranca e destranca.

Para proteger só uma parte, tranque nós: botão direito no nó › **Trancar o nó**, ou o cadeado no topo do painel dele. Um nó trancado não se move, não aceita edição nos campos, não é desligado nem excluído, e fica no lugar quando você organiza o fluxo. A execução não muda.

### Nós

A paleta (**Adicionar nó**) agrupa os nós por categoria. Nos campos de caminho, o botão da pasta abre o seletor do Windows para escolher o arquivo, a pasta ou o programa, sem digitar.

Cada nó diz o que recebe e o que devolve. Na paleta aparece uma linha como `Texto → JSON`; no quadro, a etiqueta fica ao lado de cada bolinha (a da esquerda é o que entra, a da direita é o que sai) e a bolinha ganha a cor do formato. No painel do nó, **Recebe** e **Devolve** explicam em uma frase, e **Exemplo da saída** mostra o JSON que vem quando o formato é conhecido.

| Etiqueta | O que é |
|---|---|
| Texto | Um texto simples. |
| JSON | Dados com campos, como `{ "nome": "Ana" }`. |
| Lista | Vários itens em sequência. |
| Número | Um número. |
| Imagem, Áudio, Vídeo | O caminho de um arquivo desse tipo. |
| Arquivo | O caminho de um arquivo qualquer. |
| Qualquer | Aceita qualquer formato. |
| O mesmo | Passa adiante exatamente o que recebeu. |
| Começa, Fim | O nó não recebe nada (gatilho) ou não devolve nada. |

**Gatilhos**

| Nó | O que faz |
|---|---|
| Iniciar manualmente | Começa quando você clica em **Executar**. Entrega o texto de exemplo. |
| Agenda | Começa sozinho: a cada intervalo (em minutos) ou num horário, nos dias da semana marcados. |
| Ao abrir o BlueScreen | Começa sozinho quando o BlueScreen é aberto. |
| Quando um arquivo mudar | Começa quando o arquivo, ou algo no primeiro nível da pasta, é criado ou alterado. Entrega `path`, `name` e `files`. A conferência é a cada cinco segundos. |
| Endpoint HTTP | Começa quando alguém chama o endereço do fluxo, e o fluxo responde. Veja [Crie um endpoint](#crie-um-endpoint). |

**Lógica**

| Nó | O que faz |
|---|---|
| Condição | Compara um valor e segue por **sim** ou por **não**: igual, diferente, contém, maior, menor, vazio, verdadeiro. `"5"` e `5` contam como iguais. |
| Garantir que | Faz a mesma comparação, mas falha o fluxo, com a sua mensagem, se ela não valer. Serve de teste. |
| Esperar | Pausa de 0 a 3.600 segundos. |
| Parar com erro | Encerra o fluxo como falha, com a mensagem que você escrever. |

**Texto**

| Nó | O que faz |
|---|---|
| Texto | Monta um texto com o que chegou. |
| Substituir texto | Troca um trecho por outro, por texto exato ou expressão regular. |
| Extrair do texto | Pega o trecho que casa com uma expressão regular: o primeiro, ou todos numa lista. |
| Dividir em lista | Divide um texto por linha, vírgula, ponto e vírgula ou outro separador. |
| Juntar lista | Junta os itens de uma lista num texto só. |
| Ajustar texto | Maiúsculas, minúsculas, primeira letra maiúscula, sem espaços nas pontas ou sem linhas vazias. |
| Contar texto | Entrega `chars`, `words` e `lines`. |

**Dados**

| Nó | O que faz |
|---|---|
| Resultado | Mostra o que chegou como resultado da execução. |
| Montar objeto | Monta um objeto com os campos que você definir. |
| Data e hora | Entrega a data e a hora de agora no formato pedido (`%d/%m/%Y %H:%M`), com dias a somar. |
| Ler CSV | Transforma um texto CSV numa lista, usando a primeira linha como nomes dos campos. |
| Filtrar lista | Fica com os itens que passam numa comparação. |
| Resumir números | Entrega `count`, `sum`, `avg`, `min` e `max` de uma lista. |
| Montar tabela | Transforma uma lista numa tabela em Markdown, CSV ou HTML, para um relatório. |

**JSON**

Para tratar o que sai de uma requisição, de um script ou de outro nó. O caminho de um campo são os nomes separados por ponto, e número é a posição na lista, a partir de 0: `disks.0.free_gb`. Texto em JSON é aceito como JSON.

| Nó | O que faz |
|---|---|
| Pegar campo | Tira um valor de dentro do JSON pelo caminho. Se o campo não existir, para com erro, segue com vazio ou usa um valor padrão. |
| Escolher campos | Monta um objeto só com os campos que interessam, um por linha (`caminho` ou `novo_nome = caminho`). Numa lista, vale para cada item. |
| Remover campos | Devolve o mesmo JSON sem os campos indicados. |
| Definir campo | Cria ou troca o valor de um campo; cria os objetos do caminho que faltarem. Reconhece número, `true`/`false` e JSON, ou guarda sempre como texto. |
| Juntar objetos | Junta dois objetos num só; em campo repetido vale o segundo. |
| Ler JSON | Transforma um texto em JSON. Acha o JSON no meio do texto (respostas de IA, saídas de programas) ou exige que o texto inteiro seja JSON. |
| JSON para texto | Escreve o JSON como texto, indentado ou numa linha. |
| Listar campos | Transforma um objeto numa lista de `key` e `value`. |
| Extrair de cada item | Fica só com um campo de cada item da lista. |
| Ordenar lista | Ordena pelo campo, crescente ou decrescente, e fica com os primeiros se você der um limite. |
| Agrupar lista | Agrupa pelo valor de um campo: entrega `key`, `count` e `items` de cada grupo, do maior para o menor. |
| Contar itens | Conta os itens da lista, os campos do objeto ou as letras do texto. |

Quando a saída de um nó é JSON, o painel dele mostra atalhos em **Última execução**: **Pegar campo** abre a lista dos campos que vieram e já cria o nó ligado e preenchido; para uma lista aparecem Filtrar, Ordenar, Extrair, Agrupar, Resumir e Montar tabela. Nos campos de caminho, **campos** lista os caminhos do dado que chega; em **+ dado**, os campos do JSON que chega aparecem prontos como `{{input.campo}}`. Antes da primeira execução, a lista vem do exemplo do nó anterior.

**Arquivos**

| Nó | O que faz |
|---|---|
| Ler arquivo | Entrega o texto de um arquivo. |
| Gravar arquivo | Grava um texto num arquivo: substitui, ou acrescenta no fim. Cria a pasta se faltar. |
| Listar arquivos | Entrega a lista dos arquivos de uma pasta, com filtro (`*.pdf`). |
| Arquivo existe? | Segue por **sim** ou por **não**. |
| Copiar, mover ou excluir | Copia ou move um arquivo, ou manda para a Lixeira. |

**Windows**

| Nó | O que faz |
|---|---|
| Executar programa | Roda um programa com os argumentos (um por linha) e entrega o que ele escreveu. Escolha o programa pelo botão da pasta, ou digite o nome de um que esteja instalado (`git`, `node`). Código de saída diferente de zero falha o fluxo. |
| Script PowerShell | Roda um script de várias linhas e entrega o que ele escreveu. O que chegou no nó fica em `$env:BS_INPUT`. |
| Abrir | Abre um arquivo, uma pasta ou um site no programa padrão. |
| Área de transferência | Lê o texto copiado, ou copia um texto. |
| Notificação | Mostra um aviso do Windows. |
| Alarme | Abre um alerta no canto da tela, por cima de tudo e sem tirar o foco de onde você está, com um som da biblioteca do Windows (o botão ao lado toca o escolhido) ou um `.wav` seu. Dá para escolher o tipo e a cor, tocar uma vez ou sem parar, fechar sozinho depois de um tempo, um ou dois botões, o canto da tela, a largura, o fundo, a opacidade e a borda piscando. Com **Espera o alarme fechar**, o nó entrega `closed`: o botão clicado, ou `timeout`. Alarmes abertos ao mesmo tempo no mesmo canto se empilham em vez de se cobrir: o novo entra por cima, a pilha desliza quando um fecha e abre outra coluna se não couber na altura da tela. |
| Saúde do PC | Entrega o uso de CPU e de memória, o espaço nos discos e há quantas horas o PC está ligado. |
| Programa está rodando? | Segue por **sim** ou por **não**. |

**Rede**

| Nó | O que faz |
|---|---|
| Requisição HTTP | Chama um endereço e entrega a resposta. Resposta em JSON chega como objeto. Status fora de 2xx falha o fluxo. |
| Baixar arquivo | Baixa um endereço e grava num arquivo. |
| Ferramenta MCP | Chama uma ferramenta de um servidor MCP por HTTP. |
| Responder ao endpoint | Define o código, o formato e o corpo que o **Endpoint HTTP** devolve. |

**Segurança** (para o Endpoint HTTP)

| Nó | O que faz |
|---|---|
| Exigir token | Só continua se a chamada trouxer o token certo. Senão responde 401. |
| Limitar chamadas | Recusa com 429 quem passa do limite (tantas chamadas a cada tantos segundos), por token ou no total. |
| Conferir assinatura | Confere a assinatura HMAC-SHA256 do corpo, como a do GitHub. Senão responde 401. |
| Exigir campos | Só continua se os campos vierem preenchidos. Senão responde 400, dizendo qual faltou. |

**Auditoria**

| Nó | O que faz |
|---|---|
| Site no ar? | Chama o endereço e segue por **sim** ou por **não**. Entrega `status`, `ms`, `size` e `reason`. Dá para exigir um texto na página e um tempo máximo. |
| Certificado HTTPS | Entrega `expires`, `days` (quantos dias faltam), `issuer` e `protocol`. |
| Cabeçalhos de segurança | Confere HTTPS, HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy e Permissions-Policy. Entrega `score`, `present` e `missing`, com o motivo de cada um. |
| Porta aberta? | Tenta conectar no servidor e segue por **sim** ou por **não**. |
| Links quebrados | Abre a página, testa os links dela e entrega `checked` e `broken`. |

**Integrações**

| Nó | O que faz |
|---|---|
| Mensagem no Slack, Teams ou Discord | Envia um texto para um canal pelo webhook de entrada dele. |
| Dynatrace: problemas | Lista os problemas abertos (ou fechados, ou todos) com título, severidade, impacto e entidades. |
| Dynatrace: métrica | Consulta um `metricSelector` e entrega o último valor, a média e o máximo de cada série. |
| Dynatrace: registrar evento | Marca um deploy, uma anotação, uma informação ou um alerta. |

**IA**

| Nó | O que faz |
|---|---|
| Agente de IA | Roda o Codex, o Claude Code ou outro agente numa pasta. Veja [Agentes de IA](#agentes-de-ia). |
| OpenRouter | Envia um pedido a um modelo do OpenRouter, com o token do Cofre. |

**Imagem** (png, jpg, bmp e gif)

| Nó | O que faz |
|---|---|
| Redimensionar imagem | Muda o tamanho. Zero na largura ou na altura mantém a proporção. |
| Converter imagem | Grava em JPG (com a qualidade), PNG, BMP ou GIF. |
| Cortar imagem | Recorta um retângulo. |
| Girar imagem | Gira 90° ou 180°, ou espelha. |
| Dados da imagem | Entrega `width` e `height`. |

**Áudio** e **Vídeo** (precisam do FFmpeg: `winget install Gyan.FFmpeg`)

| Nó | O que faz |
|---|---|
| Converter áudio | MP3, WAV, M4A, OGG ou FLAC, com a qualidade. |
| Cortar áudio | Fica com um trecho: começo e duração, em segundos ou `00:01:30`. |
| Ajustar volume | Nivela para o volume padrão, ou muda por porcentagem. |
| Converter vídeo | MP4, WebM, MKV ou GIF animado, com tamanho (1080p a 360p), qualidade e com ou sem som. |
| Cortar vídeo | Fica com um trecho, com corte exato ou rápido. |
| Extrair áudio do vídeo | Grava só o som. |
| Capturar quadro | Grava uma imagem de um instante do vídeo. |
| Dados do áudio ou vídeo | Entrega duração, tamanho, formato, resolução e codecs. |

Os nós de imagem, áudio e vídeo gravam um arquivo novo ao lado do original (ou onde você indicar em **Gravar em**) e entregam o caminho dele, então dá para encadear: capturar um quadro, redimensionar e converter.

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

Use um gatilho automático (**Agenda**, **Ao abrir o BlueScreen**, **Quando um arquivo mudar** ou **Endpoint HTTP**) e acenda o interruptor **Ligado** na barra do fluxo. Com a Agenda, a lista mostra a próxima execução. Um fluxo pode ter um gatilho manual e um automático: o botão **Executar** segue pelo manual e o disparo automático segue pelo gatilho que disparou.

Os gatilhos valem enquanto o BlueScreen estiver aberto, inclusive na bandeja. Eles não iniciam o BlueScreen com o Windows nem acordam o computador.

### Crie um endpoint

O gatilho **Endpoint HTTP** dá um endereço ao fluxo. Quem chama esse endereço dispara o fluxo e recebe a resposta dele.

1. Ponha o nó **Endpoint HTTP** e dê um nome a ele (`pedidos`, por exemplo). O painel mostra o endereço, com um botão para copiar: `http://127.0.0.1:4747/api/automator/hook?e=pedidos`.
2. Logo depois, ponha os nós de **Segurança** que fizerem sentido: **Exigir token**, **Limitar chamadas**, **Exigir campos**, **Conferir assinatura**.
3. Faça o trabalho (gravar num arquivo, chamar outro serviço, perguntar a um agente) e termine com **Responder ao endpoint**.
4. Acenda o interruptor **Ligado**. O modelo **Endpoint com token** já vem montado assim.

O gatilho entrega `method`, `query`, `headers` (nomes em minúsculas), `body` (já como objeto, se veio JSON), `raw` (o corpo como chegou) e `token`. O token é tirado do `Authorization: Bearer`, do `X-API-Key` ou de `?token=`.

```
curl -X POST "http://127.0.0.1:4747/api/automator/hook?e=pedidos" -H "Authorization: Bearer MEU-TOKEN" -H "Content-Type: application/json" -d "{\"nome\": \"Ana\"}"
```

O que o endpoint devolve:

| Situação | Resposta |
|---|---|
| o fluxo chegou num **Responder ao endpoint** | o código, o formato e o corpo desse nó |
| o fluxo terminou sem esse nó | `200` com `{ "ok": true }` |
| um nó de Segurança recusou | `400`, `401` ou `429`, com o motivo |
| outro nó falhou | `500`, sem detalhes (eles ficam no histórico do fluxo) |
| o fluxo passou do tempo de espera do gatilho | `202`, e ele continua rodando |
| o fluxo já está atendendo outra chamada | `503`: tente de novo |
| nome errado, ou fluxo desligado | `404` |

Sobre a segurança:

- **Quem pode chamar** começa em **Só este PC**. Com **A rede local também**, o endpoint atende outros aparelhos, mas só com o acesso pela rede local do BlueScreen ligado. Ele não fica exposto na internet.
- No **Exigir token** e no **Conferir assinatura**, escreva `{{cred:nome}}` (Credenciais do Automator) ou `{{vault:nome}}` (um segredo do Cofre liberado para o Automator). Um token digitado direto no nó fica gravado no fluxo, em texto.
- O histórico de uma chamada não guarda o token, o `Authorization`, os cookies nem a assinatura.
- Um fluxo atende uma chamada por vez, e o BlueScreen roda quatro fluxos ao mesmo tempo. É um endpoint para automações suas e da equipe, não para tráfego de produção.

### Audite um site

Os nós de **Auditoria** dão as respostas que um SRE ou QA olha todo dia: o site responde, o certificado vai vencer, os cabeçalhos de proteção estão lá, a porta do banco está aberta, a página tem link quebrado. O modelo **Auditoria de um site** roda nos dias úteis, avisa se o site cair e se o certificado vencer em menos de 21 dias, e mostra os cabeçalhos.

Para ir além do que se vê de fora, use os nós do **Dynatrace**:

1. No Dynatrace, crie um API token com as permissões do que vai usar: `problems.read`, `metrics.read`, `events.ingest`.
2. Guarde no Cofre (`Alt+8`) com o nome `dynatrace` e libere para o Automator e para o endereço do seu ambiente.
3. Nos nós, informe o ambiente (`https://abc12345.live.dynatrace.com`).

O modelo **Relatório de problemas do Dynatrace** lista os problemas abertos, monta uma tabela e manda para um canal do Slack, do Teams ou do Discord.

### Agentes de IA

O nó **Agente de IA** roda um agente de linha de comando numa pasta:

| Campo | |
|---|---|
| Agente | Codex, Claude Code ou um que você cadastrou. |
| Pedido | O que ele deve fazer. |
| Pasta de trabalho | Onde ele lê e, se puder, altera arquivos. |
| O que ele pode fazer | **Só ler e responder** (o padrão), **Ler e alterar arquivos da pasta**, ou **Tudo, sem perguntar** (arquivos e comandos). |
| Modelo e Esforço | Vazios, valem os do agente. |
| Tempo limite | De 1 a 60 minutos. |

**Tudo, sem perguntar** deixa o agente rodar qualquer comando no seu PC, sem confirmação. Use só com pedidos seus (não com texto vindo de um endpoint ou de um site) e numa pasta que possa ser refeita.

A janela **Agentes de IA** guarda o programa, o modelo e o esforço de cada agente. Ela abre pelo **configurar** ao lado do campo Agente, pelo menu **⋯** do fluxo ou pelo **Buscar em tudo** ("Agentes de IA").

- **Codex** e **Claude Code** sempre existem. Dá para trocar o modelo, o esforço, o programa e acrescentar opções.
- **+ Novo** cadastra outro programa. Se ele aceita as mesmas opções do Claude Code (o OpenClaude, por exemplo) ou do Codex, escolha isso em **Fala como** e informe só o comando: a IDE passa o pedido, o modelo, o esforço e o modo de leitura do jeito que esse tipo espera.
- Em **Outro programa**, você escreve os argumentos, um por linha: `{prompt}` vira o pedido, `{model}` o modelo, `{effort}` o esforço e `{access}` o acesso (`read`, `edit` ou `full`). Sem `{prompt}`, o pedido vai pela entrada padrão. A IDE não consegue limitar um programa desses a só leitura.
- **Testar** grava e faz uma pergunta curta ao agente, para você ver se ele responde.

Os agentes cadastrados aparecem no nó **Agente de IA** e nas janelas **Criar com IA**, **Ajustar com IA** e **Script com IA**. O esforço vai de mínimo a máximo; cada programa aceita os níveis dele e recusa os outros com a própria mensagem.

### Teste e automatize um site

O plugin **Navegador** traz dois nós que abrem o Edge (ou o Chrome) num perfil próprio e seguem um roteiro: **Testar site** (categoria QA) e **Automatizar site**. Precisam do Node.js 22 ou mais novo.

**Grave em vez de escrever.** No painel do nó, **Gravar no navegador** abre o site de verdade. Use ele normalmente: cada clique, texto digitado e opção escolhida vira um passo no roteiro, na hora. Uma barra no topo da página mostra que está gravando e tem:

- **Ler campo:** o próximo clique escolhe um texto da tela para o teste devolver. Você dá um nome (`saldo`) e ele sai em `values.saldo`.
- **Conferir:** o próximo clique vira uma conferência de que aquele texto continua lá.
- **Pausar:** usar o site sem gravar. **⇅** leva a barra para o outro lado, se ela estiver em cima do que você quer clicar.
- **Concluir:** fecha o navegador e deixa os passos no nó.

O gravador escolhe o jeito mais firme de achar cada elemento (id, atributos de teste como `data-testid`, nome do campo, texto do botão) e nunca grava senha: no lugar dela fica `{{cred:senha}}`, e o painel do nó oferece **Guardar agora** para você digitar o valor em Credenciais. Sem endereço no nó, o primeiro site que você abrir vira o endereço. Os passos também podem ser escritos ou ajustados à mão; a cor da borda diz o tipo (azul: ação, verde: conferência, amarelo: leitura, cinza: espera).

| Passo | O que faz |
|---|---|
| Clicar, Digitar, Escolher opção, Apertar tecla, Passar o mouse, Ir para endereço | As ações. **Onde** é um seletor CSS (`#senha`) ou `texto=Entrar`. |
| Conferir texto | O elemento tem que conter o texto. A falha diz o que estava lá. |
| Conferir que aparece / que sumiu | O elemento tem que estar, ou deixar de estar, na tela. |
| Conferir endereço / título | O endereço ou o título da página tem que conter o trecho. |
| Conferir quantidade | Quantos elementos casam com o seletor (linhas de uma tabela, itens de uma lista). |
| Comparar com a referência (visual) | Compara a tela com uma imagem guardada. A primeira execução grava a referência; as seguintes falham se mudar mais que a **Diferença visual aceita**, e gravam uma imagem com as diferenças em vermelho. |
| Checar acessibilidade (básico) | Idioma e título da página, imagens sem texto alternativo, botões e links sem nome, campos sem rótulo, falta de título principal. |
| Ler campo (devolver) | Guarda o texto do elemento em `values`, com o nome que você der. |
| Capturar tela, Esperar aparecer, Esperar (segundos) | Imagem num arquivo e esperas. |

**Testar site** sai por **sim** (passou) ou **não** (falhou) e entrega cada passo com o tempo e o erro, os campos lidos, os erros de JavaScript e os pedidos que falharam na página, e o caminho de um relatório em HTML com a tela da hora da falha. No painel, o resultado aparece como placar, com **Ver a tela na hora da falha** e **Abrir o relatório**; no quadro, o nó mostra quantos passaram. Dá para escolher a tela (computador, tablet, celular), seguir depois de uma falha para anotar todas, e reprovar por erro de JavaScript. Quando falha com a janela à vista, ela fica aberta onde parou.

**Automatizar site** é o mesmo motor sem o placar: para na primeira falha e entrega `{ url, title, values }`. Serve para rotinas, como trocar a senha de um usuário.

### Mais ferramentas de QA

| Nó | O que faz |
|---|---|
| Testar API | Chama um endereço e confere status, tempo, texto da resposta, campos do JSON (`itens.0.nome`) e cabeçalhos. Sai por sim ou não, com cada conferência e o que veio no lugar do esperado. |
| Dados de teste | Gera pessoas de mentira para preencher formulários: nome, e-mail, CPF e CNPJ com dígitos válidos, celular, nascimento, CEP, endereço, empresa, senha forte, UUID e frase. Um objeto, ou uma lista. |
| Teste de carga leve | Até 500 chamadas GET, até 20 ao mesmo tempo. Entrega média, mediana, 95%, máximo, chamadas por segundo e os status. Reprova pelo tempo ou pela taxa de erro. Use só em sistemas seus ou com autorização. |
| Relatório de testes | Junta resultados de Testar site e Testar API numa página HTML, num JUnit XML (Jenkins, GitLab, Azure) ou em Markdown. |

Um roteiro comum: **Dados de teste** → **Testar site** (os passos usam `{{input.nome}}`, `{{input.cpf}}`) → na saída **não**, **Relatório de testes** e **Mensagem no Slack, Teams ou Discord**.

### Crie nós com um plugin

Qualquer plugin do BlueScreen acrescenta nós ao Automator com um arquivo `automator.json` na pasta dele. Cada nó declara os campos que o painel desenha e o programa que roda:

```json
{
  "nodes": [{
    "type": "maiusculas", "name": "Maiúsculas", "category": "Texto", "desc": "Passa o texto para maiúsculas.",
    "params": { "text": "{{input}}" },
    "fields": [{ "name": "text", "label": "Texto", "kind": "area" }],
    "takes": "text", "gives": "text",
    "expects": "Um texto.", "returns": "O texto em maiúsculas.",
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

`takes` e `gives` são o formato do que o nó recebe e devolve (`text`, `object`, `list`, `number`, `image`, `audio`, `video`, `file`, `any`, `same`, `none`); `expects` e `returns` são a frase que o painel mostra; `sample`, opcional, é um exemplo da saída em JSON, usado para sugerir os campos antes da primeira execução.

- O nó aparece na paleta como `plugin.<id do plugin>.<type>`, enquanto o plugin estiver ligado. `category` pode ser uma das que existem ou um nome novo.
- **Campos** (`kind`): `text`, `area`, `number` (`min`, `max`), `select` (`options`), `checks`, `time`, `json`, `lines` (um item por linha) e `rows` (uma lista de linhas, com `columns`). Num campo `text`, `"pick": "file"`, `"folder"`, `"save"`, `"program"` ou `"any"` põe o botão que abre o seletor do Windows. `show: { "campo": ["valor"] }` mostra o campo só quando outro tem um desses valores.
- **Entrada do programa:** `{ node, params, input, data, secrets }`. As expressões já chegam resolvidas em `params`; `data` é a pasta de dados do plugin.
- **Saída:** o que o programa escreve na saída padrão, lido como JSON (ou como texto). Código de saída diferente de zero falha o nó com o que ele escreveu na saída de erro. Com mais de uma saída em `outputs`, responda `{ "port": "nome", "value": ... }`.
- **Segredos:** `{{vault:nome}}` e `{{cred:nome}}` num parâmetro não vão no JSON. O valor chega numa variável de ambiente, e `secrets` diz qual (`{ "{{vault:nome}}": "BS_SECRET_0" }`). O Cofre só entrega se o segredo estiver liberado para o plugin e para o programa.
- **Gravador:** `"record": { "args": ["arquivo.js", "--record"] }` no nó e `"recorder": true` num campo `rows` põem o botão **Gravar** no painel. O programa recebe `{ params, data }` na primeira linha da entrada e escreve um passo por linha (`{ "do", "on", "value" }`); quando a entrada fecha, ele encerra. Numa opção de `select`, `"tone": "act" | "check" | "read" | "wait"` dá a cor do passo.
- O programa roda na pasta do plugin, com o Node.js, o Python ou o que estiver no PC. O plugin **Navegador** (`app/plugins/navegador`) é um exemplo completo.

Dá para pedir um nó desses ao **IAMaker** sem sair do Automator: no fim da paleta, **Criar um nó novo com IA** (ou **Criar o nó "…" com IA**, quando a busca não acha nada) abre o IAMaker num plugin novo com o pedido já começado. O guia do IAMaker ensina a IA a escrever o `automator.json`, o programa e a parte de Recebe/Devolve. Quando o plugin fica pronto, o nó aparece na paleta na próxima vez que ela abrir.

O núcleo roda até quatro coisas ao mesmo tempo (fluxos e pedidos à IA). Um disparo automático sem vaga espera na fila; **Parar** tira da fila ou interrompe a execução.

### Crie e ajuste com IA

**Criar com IA**, na lista de fluxos, monta um fluxo novo a partir de uma descrição. A janela traz ideias prontas para começar.

**Ajustar com IA**, na barra do fluxo aberto (e no menu de três pontos), é outra janela: você diz o que mudar ("avise também no Slack", "troque o horário para 8h") e a IA devolve o fluxo alterado. Os nós que já existiam ficam onde estavam, nó trancado não muda e `Ctrl+Z` desfaz o ajuste inteiro.

Nas duas, e no script com IA, você escolhe o **agente**, o **modelo** e o **esforço**. Em branco, valem os do agente (os de **Agentes…**). A escolha fica lembrada por agente. Enquanto a IA trabalha, a janela mostra a etapa em que o pedido está (a IA escreve, o BlueScreen confere, a IA corrige, credenciais e resultado), o tempo corrido e **Cancelar**, que encerra o agente. Fechar a janela também cancela. O agente tem dez minutos para responder.

A IA recebe um guia dos nós escrito para ela (o que cada um faz, o formato que recebe e devolve, as portas, os parâmetros com os valores aceitos e os campos da saída), um exemplo de fluxo bem montado e os nomes das credenciais que já existem. Antes de mostrar o resultado, o BlueScreen confere o fluxo:

- parâmetro que o nó não tem e valor fora da lista;
- `{{nodes.x}}` apontando para nó que não existe ou que não vem antes, e campo que a saída do nó anterior não tem;
- expressão inventada, como `{{now}}`;
- nó sem ninguém ligado nele e fluxo sem gatilho;
- senha em argumento de programa e token escrito num nó.

O que aparecer volta para a IA corrigir, até duas vezes. No fim, uma janela mostra o que ainda merece atenção: as credenciais guardadas, o que a IA deixou para você preencher e o que a conferência ainda achou. Nada roda nem é salvo sem você conferir.

**Senhas no pedido.** Pode escrever a senha ou o token na frase ("entre no portal com a senha X"). O BlueScreen tira o valor do texto antes de ele ir para a IA, guarda em **Credenciais** e manda só o nome (`{{cred:senha-portal}}`). Ele reconhece tokens de formato conhecido (GitHub, GitLab, OpenAI, Slack, AWS, JWT) e o que vem depois de "senha", "token" ou "chave" quando parece um valor: entre aspas, depois de `:` ou `=`, ou com número ou símbolo no meio. Uma senha só de letras, sem aspas, passa por esse filtro; aí a IA é instruída a não copiá-la para o fluxo e a apontá-la, e a janela do resultado avisa que a IA viu o valor. Para ter certeza, escreva a senha entre aspas ou guarde-a antes em Credenciais.

### Edite scripts com IA

No nó **Script PowerShell**, o botão **Escrever com IA** (ou **Editar com IA**, quando já há script) abre uma janela: você diz o que o script deve fazer ou o que mudar, e a IA devolve o script inteiro com um resumo. A janela mostra as linhas que entram e as que saem; **Aplicar no nó** troca o script (um `Ctrl+Z` desfaz) e **Pedir outra mudança** continua a partir da proposta. A IA recebe o script atual, um exemplo do que chega no nó e, se a última execução falhou, o erro, para corrigir. Senhas escritas no pedido têm o mesmo tratamento do fluxo.

Um nó de plugin ganha o mesmo botão com `"code": "linguagem"` num campo `area` do `automator.json`.

### Credenciais

**Credenciais**, no pé da lista de fluxos, é o cofre do Automator: senhas e tokens que os fluxos usam sem mostrar. É separado do Cofre da IDE e fica em `automator-credentials.json`, ao lado do arquivo dos fluxos, com cada valor cifrado pelo Windows (DPAPI): só o seu usuário, neste PC, decifra.

- **Guardar:** dê um nome (`senha-portal`) e clique em **Guardar…**. O usuário e a senha são digitados numa janela do BlueScreen, fora da página. Senhas escritas num pedido à IA vêm parar aqui sozinhas.
- **Usar:** `{{cred:nome}}` em qualquer campo de um nó; `{{cred:nome.user}}` é o usuário. O menu **+ dado** dos campos lista as credenciais.
- **O valor não aparece:** nenhuma tela ou rota o devolve. Na execução ele entra no nó e é trocado por `••••••` no que o nó devolve, na saída e no erro, antes de seguir para os próximos nós e para o histórico.
- **Em scripts:** no Script PowerShell, escreva `{{cred:nome}}` fora de aspas simples; o valor chega por variável de ambiente e não fica escrito no arquivo do script. Em **Executar programa**, credencial em argumento é recusada, porque outros programas do PC leem os argumentos.
- **Em nós de plugin** (Testar site, Automatizar site): o valor chega ao programa do nó por variável de ambiente, como os segredos do Cofre.
- Um campo que cita uma credencial que não existe mostra o aviso com **Guardar agora**.
- **A tela** segue a do Cofre da IDE: um cartão por credencial, com quando foi trocada, quem usou por último (fluxo e nó) e os fluxos que a usam; o menu do cartão troca o valor, edita a descrição, copia a referência ou apaga. **Registro de uso** lista os usos e as recusas desde que o BlueScreen abriu.

Diferença para o Cofre da IDE: uma credencial do Automator não tem lista de sites nem de programas. Qualquer fluxo pode usá-la, para onde o fluxo mandar. Para um token que só pode ir a um site, use o Cofre (`{{vault:nome}}`), que continua valendo nos nós.

### OpenRouter e tokens

1. No nó OpenRouter, clique em **Guardar o token no Cofre** (ou abra o Cofre com `Alt+8`).
2. Guarde o token na janela do Cofre e libere o segredo `openrouter` para o Automator.
3. Informe o modelo no nó, no formato `provedor/modelo`.

O fluxo guarda só o nome do segredo. O núcleo põe o token no cabeçalho da chamada e o tira da resposta. Em Requisição HTTP e Ferramenta MCP, use `{{vault:nome}}` nos cabeçalhos (ou `{{cred:nome}}`, das Credenciais do Automator):

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

## Estúdio: os plugins sem a IDE

Na tela inicial, o cartão **Estúdio** abre uma janela só dos plugins, sem projeto, busca, Git, Build nem terminal. A janela da IDE sai da frente e continua na bandeja. Fechar o Estúdio não para a agenda nem os fluxos.

- **Início:** a saudação, um cartão por plugin e os projetos recentes. Clicar num projeto abre ele na janela da IDE; **Abrir uma pasta…** e **Ver todos os projetos** também levam para lá.
- **Dentro de um plugin:** a barra de cima mostra **‹ Estúdio › Automator**. Clicar em **Estúdio**, no ícone de casa da barra da esquerda ou Alt+Home volta para o início sem fechar nada; o cartão do plugin retorna de onde você parou.
- **Barra da esquerda:** um ícone por plugin, para trocar com um clique.
- **Rodapé:** a Agenda fica na barra de baixo, com o próximo compromisso de hoje ou quantos estão atrasados; um clique abre ela. O mesmo resumo aparece na barra de baixo da IDE.
- **Direto num plugin:** na tela inicial da IDE, clicar num dos ícones do cartão Estúdio abre a janela já naquele plugin. `BlueScreen.exe --studio automator` faz o mesmo quando o BlueScreen já está aberto; sem ele, abre a IDE normal. No navegador (`--web`), o Estúdio abre em outra aba, em `/?studio=1`.

## Bandeja do Windows

Fechar a janela principal esconde o BlueScreen na área de notificação, para a agenda e os fluxos continuarem. Na primeira vez, um aviso mostra onde ele ficou.

- Clique no ícone para voltar.
- Botão direito no ícone, **Sair do BlueScreen**, encerra. Se houver arquivos (ou um fluxo) com alterações não salvas, a IDE pergunta antes.
- Pelo terminal: `BlueScreen.exe --quit`. O `start.bat` usa isso antes de recompilar.

Janelas abertas com `--doc` continuam fechando normalmente. Nos modos `--web` e `--no-open` não há ícone nem aviso do Windows: os eventos ficam só no log.

## Biblioteca de plugins

A Biblioteca mostra em cartões o catálogo dos servidores de plugins, os mesmos da aba **Plugins** (`Alt+7`), com busca e os filtros **Todos**, **Favoritos** e **Instalados**.

- A estrela marca um favorito.
- **⋯ › Exportar coleção** gera um arquivo com os favoritos e os servidores deles.
- **⋯ › Importar coleção** põe os plugins do arquivo nos seus favoritos. Se a coleção aponta servidores que você ainda não tem, a IDE mostra os endereços antes de aceitar. Nada é instalado na importação: a faixa **favoritos ainda não instalados** instala todos de uma vez.

Download, conferência de versão e de hash são os do núcleo. Para hospedar o catálogo da equipe, veja [Servidor de plugins](../app/plugin-server/README.md).

## Dados e testes

Fluxos, fila, compromissos e execuções ficam em `~/.bluescreen/automation.json`. O histórico guarda as últimas execuções até o limite que você escolher (cem, de fábrica); saídas muito grandes entram cortadas. Depois de uma queda do processo, o que estava rodando aparece como `interrompido`. Os tokens ficam no Cofre; as credenciais do Automator, em `automator-credentials.json`, na mesma pasta. Essas rotas só respondem pelo PC local.

`BLUESCREEN_AUTOMATION_FILE` aponta outro arquivo de dados (os testes usam uma pasta temporária).

Na pasta `app`:

```powershell
cargo test -p bluescreen --offline
cargo build -p bluescreen --offline
python tests/automation_api.py
```

A suíte usa programas e servidor MCP simulados: não chama modelos nem gasta tokens.
