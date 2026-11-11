# Escrevendo um plugin

Um plugin acrescenta coisas ao BlueScreen sem mexer no núcleo: painéis, atalhos, ações do Buscar em tudo, itens da status bar, cards do resumo do projeto, tarefas de build. Boa parte do que antes pedia um servidor próprio o núcleo já faz pelo plugin: guardar atributos, tokens e arquivos, mostrar uma tela de configurações, rodar programas e fazer HTTP de qualquer site (veja [Sem servidor próprio](#sem-servidor-próprio)). Quando precisar mesmo de lógica fora da página, o servidor pode ser um script em Node.js, Python ou PowerShell, sem compilar nada, ou um programa à parte em qualquer linguagem.

O padrão é o plugin sem compilação (`ui.js`, e `server.js` / `server.py` quando precisar). Servidor compilado (`server.exe`) é para os casos em que o nativo faz diferença: veja [PLUGINS-NATIVOS.md](PLUGINS-NATIVOS.md). Para levar um plugin antigo com `server.exe` para a arquitetura sem compilação, ou decidir que ele fica nativo, veja [MIGRACAO-PLUGINS.md](MIGRACAO-PLUGINS.md).

Plugins ligam e desligam na aba **Plugins** (`Alt+7`), sem recompilar o BlueScreen. Desligado, um plugin some por inteiro: painel, atalhos, status bar, card, marcas na árvore, ações, contribuições ao build, rotas da API e o processo do servidor. A escolha fica em `~/.bluescreen/plugins.json`.

Os plugins da sua pasta também podem ser **removidos**: a lixeira no cartão (ou botão direito › **Remover…**) manda a pasta para a Lixeira do Windows, e dá para restaurar de lá. Se você marcar a opção, a pasta de dados do plugin vai junto. Os plugins que vêm com o BlueScreen só desligam. O IAMaker nunca altera nem sobrepõe um deles: ao editar, cria uma versão sua, um plugin à parte com id próprio (`<id>-meu`), e desliga o original. Remover essa versão faz o IAMaker ligar o original de novo. Uma cópia com o mesmo id do original (de versões antigas do IAMaker) vale no lugar dele, e removê-la devolve a versão original. Pela API: `POST plugins/uninstall { id, data }`.

Para criar ou alterar plugins conversando com uma IA, sem escrever o código, use o plugin [IAMaker](../app/plugins/iamaker/README.md) (`Alt+0`).

## Onde ficam

- `app/plugins/<id>/`: os que vêm com o BlueScreen.
- `~/.bluescreen/plugins/<id>/`: os seus. Com o mesmo id, o seu ganha.

Um lugar para cada coisa, e nenhum outro:

| O quê | Onde |
|---|---|
| código dos seus plugins (inclusive os criados pelo IAMaker) | `~/.bluescreen/plugins/<id>/` |
| dados de cada plugin (`plugin.data`, `plugin.files`, `plugin.secrets`, configurações) | `~/.bluescreen/plugin-data/<id>/` |
| plugins desligados e servidores de plugins | `~/.bluescreen/plugins.json` |

Não guarde dados de plugin em `localStorage`, `bs.store`, IndexedDB nem cookies: ficam presos à janela e sobram depois de remover o plugin. Remover com **Apagar também os dados do plugin** manda a pasta de dados junto para a Lixeira. Se um painel continua na barra depois de remover, ele é de outro plugin: o botão direito no ícone mostra de qual.

Cada pasta tem:

| Arquivo | |
|---|---|
| `plugin.json` | `{ "id", "name", "description", "version", "order", "icon": "icon.svg", "requires": ["outro-plugin"], "hooks": { "build.info": "meu/build-info" }, "settings": [...], "vault": [...], "server": "server.js" }` |
| `icon.svg` ou `icon.png` (opcional) | o ícone na aba Plugins e no servidor de plugins: SVG, PNG, JPG ou WebP, até 64 KB, de preferência quadrado. Sem o campo `icon`, vale o `icon.svg`/`icon.png` da pasta; sem nenhum, a IDE desenha um com as iniciais do nome |
| `ui.js` (opcional) | roda na página dentro de `function (bs, plugin) { ... }` e enxerga tudo do núcleo (`S`, `api`, `$`, `esc`, `toast`, `store`, `I`, `TI`, `monaco`, `editor`, `openFile`, `openTool`...) |
| `style.css` (opcional) | injetado junto com o `ui.js` |
| `server.exe`, `server.js`, `server.py` ou `server.ps1` (opcional) | o servidor do plugin, iniciado quando o plugin liga e encerrado quando desliga ou quando o BlueScreen fecha. Os scripts rodam com o Node.js, o Python ou o PowerShell que a IDE acha (PATH ou janela SDKs). O campo `server` escolhe outro arquivo (`"dist/main.js"`) ou um comando inteiro (`{ "command": "java", "args": ["-jar", "srv.jar"] }`) |
| `README.md` | o que o plugin faz e como configurar |

## Pasta de dados

Cada plugin tem uma pasta só sua em `~/.bluescreen/plugin-data/<id>/`, fora da pasta do plugin: atualizar, reinstalar ou desinstalar o plugin não apaga o que ele guardou. Na aba Plugins, botão direito no plugin › **Pasta de dados** abre a pasta e **Apagar dados do plugin…** zera tudo.

| | |
|---|---|
| `store.json` | atributos: chave → qualquer valor JSON (`plugin.data`) |
| `secrets.json` | tokens e senhas, cifrados com o DPAPI do Windows: só o seu usuário, neste PC, decifra. Um segredo copiado para outro plugin não abre (`plugin.secrets`) |
| `settings.json` | os valores das configurações que o plugin declara (`plugin.settings`) |
| `files/` | arquivos livres do plugin: caches, bancos, downloads (`plugin.files`) |

Os segredos nunca respondem pela rede local: um celular conectado pela rede vê a interface, mas não lê tokens.

## Configurações (`settings` no `plugin.json`)

O plugin declara os campos e a IDE desenha o formulário: aparece uma engrenagem no cartão do plugin, na aba Plugins.

```json
"settings": [
  { "key": "url", "label": "Servidor", "default": "https://api.exemplo.com", "help": "Sem barra no fim" },
  { "key": "token", "label": "Token de acesso", "type": "secret" },
  { "key": "limite", "label": "Itens por página", "type": "number", "default": 50 },
  { "key": "modo", "label": "Modo", "type": "select", "options": ["rápido", { "value": "full", "label": "Completo" }] },
  { "key": "ativo", "label": "Sincronizar sozinho", "type": "bool", "default": true }
]
```

Tipos: `text` (padrão), `secret` (ou `password`: vai cifrado para os segredos e nunca volta para a página), `number`, `bool`, `select` e `textarea`.

```js
const cfg = await plugin.settings.get();          // { url, limite, modo, ativo } (com os padrões)
plugin.settings.onChange((v) => recarregar(v));   // o usuário salvou o formulário
plugin.settings.open();                            // abre o formulário
```

## Sem servidor próprio

O `plugin` que o `ui.js` recebe (e `bs.plugin(id)`, de qualquer lugar) já vem ligado ao id do plugin:

| | |
|---|---|
| `plugin.data.get(chave, padrão)` / `set(chave, valor)` / `merge({...})` / `remove(chave)` / `all()` / `clear()` | atributos |
| `plugin.secrets.get(chave)` / `set(chave, valor)` / `remove(chave)` / `keys()` / `has(chave)` | tokens e senhas (só pelo PC local) |
| `plugin.settings.get(chave?)` / `set({...})` / `open()` / `onChange(fn)` | configurações declaradas |
| `plugin.files.read(caminho, 'text' \| 'json' \| 'blob' \| 'arrayBuffer')` / `write(caminho, conteúdo)` / `list(pasta)` / `remove(caminho)` / `exists(caminho)` / `url(caminho)` | arquivos em `files/` (objetos viram JSON; `url()` serve para `<img src>`) |
| `plugin.exec(programa, args, { cwd, env, stdin, timeout })` | roda e espera: `{ ok, code, out, err, timedOut }`. O programa é achado como no resto da IDE (PATH, SDKs, `npm`/`.cmd`) |
| `plugin.spawn(programa, args, { cwd, env, label, onData(texto, 'out' \| 'err'), onExit(código) })` | processo longo (servidor de dev, watcher): devolve `{ id, write(texto), close(), kill(), done }`. Os processos saem quando o plugin é desligado |
| `plugin.procs.list()` / `procs.attach(id, { onData, onExit })` | os processos do plugin que continuam rodando depois de a página recarregar |
| `plugin.fetch(url, { method, headers, body \| json, as: 'base64', timeout })` | HTTP de qualquer site, sem CORS: `{ status, ok, headers, body, json(), bodyBase64 }` |
| `plugin.info()` / `plugin.wipe()` | onde ficam os dados / apagar tudo |
| `plugin.onUnload(fn)` | roda `fn` antes de o plugin ser recarregado sem recarregar a página (veja [Recarregar sem recarregar a página](#recarregar-sem-recarregar-a-página)): pare `setInterval`, tire `addEventListener` de `window`/`document`, remova o que pôs direto no `document` |

No `fetch`, `{{secret:nome}}` em `url`, `headers` e corpo é trocado pelo segredo **dentro do núcleo**: o token nunca passa pela página.

```js
const r = await plugin.fetch('https://api.github.com/user/repos', {
  headers: { Authorization: 'Bearer {{secret:token}}', Accept: 'application/vnd.github+json' },
});
if (!r.ok) return bs.toast('GitHub: ' + r.status);
const repos = r.json();
await plugin.data.set('ultimaBusca', Date.now());
await plugin.files.write('cache/repos.json', repos);
```

`plugin.vault.status()` / `has(nome)` / `request(nome)` usam o [Cofre](#cofre) da IDE.

`exec`, `spawn`, `fetch` e os segredos só respondem pelo PC local. As mesmas coisas existem como rotas (`plugin/data`, `plugin/secrets`, `plugin/settings`, `plugin/files`, `plugin/exec`, `plugin/proc`, `plugin/fetch`, `plugin/info`, todas com `?plugin=<id>`), para servidores de plugin usarem com o token.

## Cofre

O cofre guarda tokens da IDE (GitHub, OpenAI, Jira, a API da empresa) **uma vez só** e libera cada um para os plugins que você escolher. É diferente de `plugin.secrets`, que é de um plugin só: um segredo do cofre pode servir a vários plugins, e você controla para onde ele vai.

Abre pelo ícone da chave na barra da esquerda (**Alt+8**, se nenhum plugin usar essa tecla; um número no ícone avisa que há plugins pedindo acesso), pela faixa **Cofre de credenciais** no topo da aba Plugins, pelo **Buscar em tudo** ("Cofre") ou pelo botão direito num plugin › **Cofre…**. Fica em `~/.bluescreen/vault.json`.

### Para quem usa

1. No Cofre, preencha nome (`github`), descrição e **sites liberados** (`api.github.com`). Se o segredo vem do pedido de um plugin, isso já vem preenchido, junto com o que ele pede (um token, usuário e senha...). Sem pedido, escolha em **O que guardar**: um token ou usuário e senha.
2. Clique em **Digitar e guardar…**. Abre uma janela do Windows (*BlueScreen · Cofre*) com um campo para cada coisa que o plugin pediu. Ela mostra para onde o segredo pode ir. Digite ou cole (Ctrl+V); senhas e tokens aparecem como `•••` (marque **Mostrar o que eu digito** para conferir). **Guardar** grava, **Cancelar** (ou Esc) desiste. Se o que você colou ainda estiver na área de transferência, ela é limpa.
3. Libere o segredo para os plugins: pelo cartão de pedido do plugin (**Permitir**) ou por **Liberar para um plugin…** no segredo. Cada liberação pede o "Sim" numa caixa do Windows.

Para trocar uma senha ou token vencido: **⋯ › Trocar o valor…** no segredo. Os campos que não são secretos (usuário) vêm preenchidos, e um campo secreto deixado em branco mantém o valor atual.

Em cada segredo você vê quando ele foi usado e por quem. O **Registro de uso** lista os usos e as recusas. Tirar o acesso de um plugin ou apagar um segredo vale na hora, sem confirmação.

| Permissão | O plugin… |
|---|---|
| **usar** | manda o token nos pedidos HTTP para os **sites liberados** (só HTTPS, menos `localhost`) e nas variáveis de ambiente dos **programas liberados**, sem ver o valor |
| **ver valor** | lê o valor. Só vale para **servidores** de plugin, e com ela o plugin pode copiar o token para qualquer lugar: só marque para plugins em que você confia |

### Para quem escreve plugins

Declare no `plugin.json` o que o plugin precisa. Isso aparece como pedido no Cofre, já com os sites sugeridos:

```json
"vault": [
  { "key": "github", "label": "Token do GitHub", "why": "listar seus repositórios e PRs",
    "hosts": ["api.github.com"], "programs": ["gh"], "reveal": false }
]
```

**O que o usuário digita (`kind` ou `fields`).** O plugin só **pede**: nada sai do Cofre até o usuário digitar na janela do Windows e liberar o plugin. Sem `kind` nem `fields`, o Cofre pede um valor só, o token. Para outra coisa, escolha um tipo pronto com `"kind"`:

```json
"vault": [{ "key": "relatorios.aws", "label": "Relatórios: credencial da AWS", "kind": "aws", "hosts": ["*.amazonaws.com"] }]
```

| `kind` | A janela pede (campo: `{{vault:nome/campo}}`) | `{{vault:nome}}` |
|---|---|---|
| `token` (padrão) | Token (`value`) | o token |
| `basic` | Usuário (`user`), Senha (`password`) | a senha |
| `domain` | Usuário (`user`), Senha (`password`), Domínio (`domain`, opcional) | a senha |
| `apiKeySecret` | Chave (`key`), Segredo (`secret`) | o segredo |
| `oauthClient` | Client ID (`client_id`), Client secret (`client_secret`), Tenant/realm (`tenant`, opcional) | o client secret |
| `aws` | Access key ID (`access_key_id`), Secret access key (`secret_access_key`), Session token (`session_token`, opcional), Região (`region`, opcional) | a secret key |
| `database` | Servidor (`host`), Porta (`port`, número, opcional), Banco (`database`, opcional), Usuário (`user`), Senha (`password`) | a senha |
| `connectionString` | String de conexão (`value`) | a string |
| `webhook` | URL do webhook (`value`, confere `https://`) | a URL |
| `sshKey` | Chave privada (`private_key`, várias linhas), Senha da chave (`passphrase`, opcional) | a chave |
| `certificate` | Certificado (`cert`, várias linhas), Chave privada (`key`, várias linhas), Senha da chave (`passphrase`, opcional) | a chave |
| `pin` | PIN (`value`, só números) | o PIN |
| `text` | Texto (`value`, várias linhas) | o texto |

A tela do Cofre recebe a lista atual em `GET vault` → `kinds`, e o usuário escolhe um deles em **O que guardar** quando cria um segredo sem pedido de plugin.

Se nenhum tipo serve, liste os campos com `fields`, que vale mais que `kind`. A janela mostra um campo para cada um, com o rótulo que você escolheu:

```json
"vault": [
  { "key": "drilltrace.svn", "label": "DrillTrace: usuário do SVN", "hosts": ["svn.empresa.com.br"],
    "fields": [
      { "key": "user", "label": "Usuário" },
      { "key": "password", "label": "Senha" },
      { "key": "domain", "label": "Domínio", "optional": true }
    ] }
]
```

| Campo de `fields` | |
|---|---|
| `key` | o nome do campo: letras, números, `_` e `-` (até 8 campos). Também vale só o nome: `"fields": ["user", "password"]` |
| `label` | o rótulo na janela (sem ele, o `key`) |
| `secret` | digitado como `•••`. Por padrão, todo campo é secreto, menos `user`, `username`, `usuario`, `login`, `email`, `url`, `host`, `domain`, `tenant`, `org`, `account` e `client_id` |
| `optional` | pode ficar em branco (o padrão é obrigatório) |
| `type` | o formato: `text` (padrão), `secret` ou `password` (texto secreto), `multiline` (caixa de várias linhas, para chaves e certificados PEM; não fica como `•••`), `url` (começa com `https://` ou `http://`), `email`, `number` (só dígitos). A janela confere url, e-mail e número antes de gravar e diz o que está errado |

Cada campo vira `{{vault:nome/campo}}`. `{{vault:nome}}` sozinho é o primeiro campo secreto (a senha, o token). `{{vault:nome/basic}}` é o `base64("usuário:senha")` pronto para HTTP Basic, feito com o primeiro campo que não é secreto e o primeiro secreto:

```js
const r = await plugin.fetch('https://svn.empresa.com.br/repos/', { headers: { Authorization: 'Basic {{vault:drilltrace.svn/basic}}' } });
await plugin.exec('svn', ['log', '-l', '5', url, '--non-interactive'], { env: { SVN_USER: '{{vault:drilltrace.svn/user}}', SVN_PASS: '{{vault:drilltrace.svn/password}}' } });
```

No servidor, `p.vault.reveal('drilltrace.svn/user')` lê um campo; `reveal('drilltrace.svn')` devolve o principal em `value` e todos em `fields` (`GET vault/reveal` → `{ value, fields: { user, password } }`). Um segredo já guardado com um valor só continua funcionando; se um plugin passar a pedir campos, **Trocar o valor…** pede os campos novos e o valor antigo fica no campo principal.

**Plugin que só funciona com o token** (`"required": true`): enquanto faltar o segredo, a liberação ou o "ver valor", o painel do plugin na barra da esquerda mostra no lugar dele uma tela de configuração. Ela traz os passos (criar o segredo, permitir o plugin, deixar ver o valor, lido pelo plugin), o andamento de cada um e o botão **Abrir no Cofre**. A tela confere sozinha e mostra o painel assim que tudo estiver liberado, sem recarregar. Campos opcionais: `title` (o título da tela, ex.: "Configure o token do Dynatrace") e `revealWhy` (o motivo do passo "Deixar ver o valor").

```json
"vault": [
  { "key": "rastro.dynatrace", "label": "Rastro: platform token do Dynatrace", "title": "Configure o token do Dynatrace",
    "why": "implantações, métricas e spans vêm do Grail com este token, só de leitura",
    "hosts": ["*.apps.dynatrace.com"], "reveal": true, "revealWhy": "O servidor do Rastro consulta o Grail com ele.", "required": true }
]
```

**O mesmo token para vários plugins.** Pedidos sem segredo para os **mesmos sites** aparecem num cartão só ("2 plugins pedem token para `*.apps.dynatrace.com`"; com `fields` diferentes, a janela pede a união dos campos). **Criar um para todos** guarda um segredo (o nome sugerido é o fim comum dos nomes, como `dynatrace`) e libera os plugins numa confirmação só. Cada plugin continua pedindo pelo nome dele (`{{vault:rastro.dynatrace}}`, `{{vault:drilltrace.dynatrace}}`): o Cofre guarda o apelido de cada um, e o nome de um plugin não vale para outro. Se já existe um segredo para o mesmo site, o pedido oferece **Usar “nome”**. Na página, a lista de plugins traz esses pedidos em `plugin.vaultKeys`, porque `plugin.vault` é a API do Cofre.

Use `{{vault:nome}}` onde o token entra. O núcleo troca pelo valor, confere o destino e tira o valor do que volta:

```js
// ui.js
if (!(await plugin.vault.has('github'))) return plugin.vault.request('github'); // abre o Cofre no pedido
const r = await plugin.fetch('https://api.github.com/user/repos', {
  headers: { Authorization: 'Bearer {{vault:github}}' },
});
const repos = r.json();

// programa com o token numa variável de ambiente (o programa precisa estar liberado no segredo)
const prs = await plugin.exec('gh', ['pr', 'list', '--json', 'title'], { cwd: bs.S.project.path, env: { GH_TOKEN: '{{vault:github}}' } });
```

```js
// server.js: o mesmo, e o valor cru se o usuário marcou "ver valor"
const r = await p.fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{vault:github}}' } });
const token = await p.vault.reveal('github'); // erro 403 sem a permissão
```

Em Python, `p.fetch(url, headers={...})`, `p.vault.status()` e `p.vault.reveal("github")`. Em Rust, `core().vault_reveal("github")`.

| | |
|---|---|
| `plugin.vault.status()` | `[{ key, exists, granted, reveal, hosts, programs, fields }]`: os segredos que o plugin pediu ou recebeu (sem valores; `fields` são os nomes dos campos) |
| `plugin.vault.has(nome)` | existe e está liberado para este plugin |
| `plugin.vault.request(nome)` | abre o Cofre no pedido (criar o segredo ou liberar) |
| `{{vault:nome}}`, `{{vault:nome/campo}}`, `{{vault:nome/basic}}` | em `fetch` (url, headers, corpo) e em `exec`/`spawn` (`env` e `stdin` do `exec`). Nos argumentos do programa é recusado, porque aparecem na lista de processos do PC |
| `vault/reveal?plugin=&key=` | o valor, só para o servidor do plugin (pelo `BLUESCREEN_PLUGIN_TOKEN`) e com "ver valor" |

Erros vêm com a explicação: segredo inexistente (404), plugin sem permissão, site ou programa não liberado, HTTP sem TLS (403).

### Como o cofre protege o token

Todo `ui.js` roda na mesma página: um plugin pode chamar a API dizendo ser outro, mudar as funções da página e ler o que se digita nela. Por isso o cofre não confia em nada que venha da página:

- **O valor não passa pela página.** Ele é digitado numa janela nativa do Windows aberta pelo núcleo (nenhum `ui.js` lê o que se digita nela nem clica em **Guardar**) e nunca volta. Nenhuma rota entrega o valor para a página. A rota antiga `paste` (um valor só, da área de transferência) continua existindo.
- **Ampliar acesso pede uma caixa nativa do Windows.** Gravar um valor (a própria janela de digitar), liberar um plugin, marcar "ver valor" e acrescentar sites ou programas só valem depois do **Sim** na caixa *BlueScreen · Cofre*, que fica por cima de tudo. O JavaScript da página não clica nela, então um plugin não consegue se liberar sozinho. Há uma caixa por vez.
- **O token só vai para onde você deixou.** `{{vault:..}}` só funciona para os sites liberados (só HTTPS), sem seguir redirecionamentos, e só nas variáveis de ambiente dos programas liberados. Segredo sem nenhum site liberado não vai para site nenhum, nem a partir de um servidor de plugin. Um plugin que finja ser outro continua preso aos mesmos destinos.
- **O valor sai do que volta.** Se o site ou o programa devolver o token (um eco, um log), a resposta chega à página com `••••••` no lugar.
- **Ler o valor exige identidade de processo.** Cada servidor de plugin recebe um token próprio (`BLUESCREEN_PLUGIN_TOKEN`), que as bibliotecas de apoio mandam sozinhas. Só com ele, e com "ver valor", sai o valor. Plugins não administram o cofre (a rota `vault` recusa quem chega com esse token).
- **Cifrado no disco** com o DPAPI do Windows: outro usuário, ou o arquivo copiado para outro PC, não abre. Nada do cofre responde pela rede local.

O que o cofre **não** faz: plugins com servidor nativo rodam como o seu usuário do Windows. O cofre limita o que eles recebem pela API, mas um programa malicioso pode ler a memória ou clicar na tela como qualquer outro programa seu. Instale plugins de quem você confia. Um programa liberado (`gh`, `git`) recebe o token e pode usá-lo como quiser, então libere só programas que você conhece.

## Interface (`ui.js`)

O objeto `bs` (também em `window.BS`):

| | |
|---|---|
| `bs.tools.register({ id, title, icon, key: 'Alt+5', order, render() })` | painel na barra da esquerda, com atalho e badge `#badge-<id>`. Com `bottom: true` e `toggle(on)`, vira um painel embaixo do editor, como o Terminal. Atalho repetido fica com quem registrou por último (os plugins carregam depois dos painéis embutidos); o outro painel fica sem atalho |
| `bs.keys.add('Ctrl+F9', fn)` | tecla; devolver `false` deixa a tecla seguir |
| `bs.actions.add([{ label, k, run, icon }])` | ações do Buscar em tudo (`Shift` `Shift`) |
| `bs.status.add({ id, title, onclick })` | item na status bar (devolve o `<span>`) |
| `bs.dashboard.card({ id, order, wide, html(), bind(el) })` / `bs.dashboard.action({ label, icon, go })` | card e botão no resumo do projeto |
| `bs.ui.panel(html)` | painel na área do editor, abaixo do código. Como os outros painéis, dá para arrastar a aba dele para cima, para os lados ou para uma janela flutuante (veja [Dividir a tela](#dividir-a-tela-bslayout)). A aba usa o `.head .ttl` do painel como título; `data-dock-title`, `data-dock-icon` (SVG) e `data-dock-tool` (o id do `bs.tools.register` que abre o painel) no elemento mudam isso |
| `bs.bubble.register({ id, title, icon, order, width, height, render(el), show(), hide() })` | **janela no balão flutuante**: o balão (canto da tela, arrastável) lista as janelas; cada uma abre na própria janela, que o usuário move, redimensiona, maximiza, minimiza no balão, fecha ou encaixa numa região da tela. `render(el)` roda uma vez, no registro, e desenha dentro de `el`. `bs.bubble.open(id)` / `minimize(id)` / `close(id)` / `toggle(id)` / `isOpen(id)` / `windowOf(id)`; `bs.bubble.badge(id, 'busy' \| 'dot' \| null)` marca o balão (anel girando, ponto) |
| `bs.build.info()` / `selected()` / `run(task, cmd)` / `showLog(log)` / `current()` / `render()` | painel Build (embaixo do editor): estrutura, escolhas (Maven, JDK, repositório), rodar tarefa, mostrar um log de fora no console |
| `bs.build.runSteps({ title, steps, jdk })` / `runFile()` | roda passos prontos no console (`{ program, args, cwd, env, java }`, ou `kind: "maven"` com os argumentos do mvn), com uma linha para a entrada do programa; `runFile()` é o "Executar arquivo" pela extensão |
| `bs.terminal.open(pasta, shell)` / `run(comando, pasta)` / `shells()` | terminal |
| `bs.lsp.tools()` / `clientFor(aba)` / `restart(ferramenta, raiz)` | servidores de linguagem: lista, cliente da aba (para pedidos LSP próprios) e reinício |
| `bs.debug.start(aba)` / `stop()` / `session()` | depurador |
| `bs.hooks.on(evento, fn)` | `project:select`, `project:refresh`, `tab:open`, `tab:activate`, `tab:close`, `tab:save`, `editor:ready(editor, diffEditor)`, `dashboard:render(el)`, `build:render(body, info)`, `codefont(tamanho)`, `refresh`, `escape` |
| `bs.hooks.filter(nome, fn)` | `tree:marks`, `menu:file`, `menu:tab`, `menu:project`, `menu:commit`, `build:path(rel, caminho)`, `plugin:buttons(itens, p)` (botões `{ label, icon, action }` no cartão e no botão direito de cada plugin da aba Plugins, como o "Editar com o IAMaker") |

Funções do núcleo declaradas com `function` também podem ser trocadas: `window.renderTree = function () { ... }`.

Na margem do editor, a faixa da esquerda (`glyphMargin: { position: monaco.editor.GlyphMarginLane.Left }`) é dos plugins (o ▶ do plugin runtimes); a do meio é dos breakpoints. Um clique numa decoração da faixa da esquerda não marca breakpoint.

Exemplo, um item de menu na árvore:

```js
bs.hooks.filter('menu:file', (items, ctx) => [...items, '-', {
  label: 'Contar linhas', icon: bs.I.lint,
  action: async () => { const f = await bs.api('file', { project: bs.S.project.path, file: ctx.rel }); bs.toast(f.content.split('\n').length + ' linhas'); },
}]);
```

## Dividir a tela (`bs.layout`)

Em volta do editor há quatro regiões: embaixo (a de sempre, com Terminal, Build, Depurar e Problemas), em cima, à esquerda e à direita. Cada uma tem abas, recolhe com um clique na aba da frente e muda de tamanho pela borda. Uma região sem painéis não aparece.

O usuário leva um painel para outro lugar arrastando:
- a **aba** dele;
- o **topo** de uma janela do balão;
- o **cabeçalho** do painel de arquivos (Projeto, Alterações...), que troca entre a esquerda e a direita da janela.

Durante o arraste aparece uma rosa de alvos no meio do editor (cima, esquerda, flutuar, direita, baixo) e uma prévia de onde o painel vai ficar. Chegar perto da borda do editor também vale. Esc cancela. Um painel que vai para "flutuar" vira uma janela do balão; fechar essa janela devolve o painel para a região de onde ele veio. Onde cada painel ficou é lembrado.

Os painéis de `bs.ui.panel` e as janelas de `bs.bubble.register` já participam sozinhos. Para o resto:

| | |
|---|---|
| `bs.layout.move(id, lado)` | leva o painel (`id` do elemento, ou da janela do balão) para `'bottom'`, `'top'`, `'left'`, `'right'` ou `'float'`. `'tool'` é o painel de arquivos (só `'left'` e `'right'`) |
| `bs.layout.sideOf(id)` | onde ele está agora |
| `bs.layout.draggable(alça, { id, title, icon, sides, drop(lado) })` | qualquer elemento vira alça de arrastar com os mesmos alvos; `sides` limita os lados, `drop` decide o que fazer |
| `bs.layout.show(opt)` / `hover(x, y)` / `hide()` | para quem já arrasta por conta própria: mostrar os alvos, acompanhar o ponteiro (devolve o lado sob ele) e soltar (devolve o lado escolhido) |
| `bs.hooks.on('layout:move', (id, de, para) => ...)` | um painel mudou de lugar. A página também recebe um `resize`, para editores e terminais se ajustarem |

Um painel que muda de lugar continua sendo o mesmo elemento: ids, eventos e estado ficam. Use `ResizeObserver` (ou o evento `resize`) se o conteúdo depende do tamanho, e evite CSS preso a `#dockBody`.

## Recarregar sem recarregar a página

`BS.plugins.reload(id)` relê a lista de plugins no núcleo, desfaz o que o plugin registrou nesta página e roda o `ui.js` dele de novo, sem recarregar a IDE. O IAMaker usa isso a cada mudança. O núcleo desfaz sozinho o que passou pela API, desde que o registro tenha sido feito **no topo do `ui.js`**, não depois de um `await`:
- painéis (`bs.tools.register`), janelas do balão e painéis de `bs.ui.panel`;
- itens de status, atalhos (`bs.keys.add`) e ações;
- cards e botões do resumo;
- ganchos (`bs.hooks.on`, `bs.hooks.filter`);
- o `style.css`.

O resto (`setInterval`, `addEventListener` em `window`, elementos postos direto no `document`) vai em `plugin.onUnload(fn)`. `BS.plugins.owned[id]` mostra o que o núcleo anotou de cada plugin.

## Servidor do plugin

Para o que não cabe na página (ganchos do núcleo, rotas que outros plugins chamam, trabalho pesado). O BlueScreen passa ao programa, por variável de ambiente, `BLUESCREEN_URL`, `BLUESCREEN_TOKEN`, `BLUESCREEN_PLUGIN`, `BLUESCREEN_PLUGIN_DIR`, `BLUESCREEN_PLUGIN_DATA` (a pasta de dados), `BLUESCREEN_SDK` (as bibliotecas de apoio em Node e Python) e `BLUESCREEN_PLUGIN_TOKEN` (identifica este processo ao núcleo, no cabeçalho `x-bluescreen-plugin-token`; é o que o cofre exige para entregar valores). O programa abre uma porta local e avisa numa linha da saída padrão:

```
BLUESCREEN-READY {"port":51234,"routes":["meu/ola","meu/build-info"]}
```

A partir daí, `/api/meu/ola` chega ao plugin com o cabeçalho `x-bluescreen-token`, e com `x-bluescreen-remote: 1` quando vem da rede local. O resto da saída vai para `~/.bluescreen/bluescreen.log`.

### Em Node.js ou Python, sem compilar

Um `server.js` ou `server.py` na pasta basta. As bibliotecas de apoio (sem dependências) já cuidam da porta, do token e do aviso de pronto:

```js
// server.js (Node.js 18+)
const { Plugin } = require(process.env.BLUESCREEN_SDK + '/bluescreen.js');
const p = new Plugin();
p.route('meu/ola', async (req) => {
  const { url } = await p.settings();
  const token = await p.secrets.get('token');
  return { projeto: req.query.project, url, temToken: !!token };
});
p.route('meu/falha', async () => { throw Plugin.error('não deu', 409); });
p.run();
```

```python
# server.py (Python 3.8+)
import os, sys; sys.path.insert(0, os.environ["BLUESCREEN_SDK"])
from bluescreen_plugin import Plugin, PluginError

p = Plugin()

@p.route("meu/ola")
def ola(req):
    p.data.set("visitas", (p.data.get("visitas") or 0) + 1)
    return {"projeto": req.query.get("project"), "visitas": p.data.get("visitas")}

p.run()
```

A rota recebe `method`, `query`, `headers`, `body`, `text()`, `json()`, `remote` e `internal`, e devolve um objeto (vira JSON), um `Plugin.reply(status, corpo, cabeçalhos)` / `Reply(...)` ou lança o erro com o status. `p.core.get/post` fala com o núcleo e com outros plugins; `p.data`, `p.secrets`, `p.settings()` e `p.files` usam a pasta de dados. Um `server.ps1` também roda; nele, o aviso de pronto e o servidor HTTP ficam por sua conta.

### Em Rust

O crate `app/sdk` (`bluescreen-sdk`) faz tudo isso:

```rust
let mut p = bluescreen_sdk::plugin::PluginServer::new("meu");
p.route("meu/ola", |r| async move { ok(json!({ "projeto": r.q("project") })) });
p.run().await
```

`core().data_get/data_set/secret/settings` e `bluescreen_sdk::plugin::data_dir()` dão acesso à pasta de dados. Toda pasta em `app/plugins/` com `Cargo.toml` entra sozinha no workspace; `build.ps1 -Plugin <id>` monta só aquele plugin.

Para falar com o núcleo ou com outro plugin, chame o BlueScreen com o token (`bluescreen_sdk::plugin::core().get("outro/rota", ...)`). Rotas do núcleo úteis para plugins: `sdk/which` (POST `{ progs }`: onde está cada programa, pela busca da IDE), `sdk/jdks` e `sdk/mavens` (os achados, o escolhido primeiro), `sdk/default` e `sdk/path` (tornar uma instalação o padrão / pôr uma pasta no PATH de tudo o que a IDE abre) e `build/input` (POST `{ id, text }`: entrada para o programa do console). Um plugin pode publicar uma lib com o cliente das suas rotas para os outros usarem (como `bluescreen-ic`). Rotas internas (`r.internal_only()`) só respondem a chamadas com o token, nunca ao navegador nem à rede local. Uma rota anunciada pelo plugin com o nome de uma rota do núcleo, ou de uma rota que outro plugin já anunciou, é ignorada (e vai para o log).

## Ganchos do núcleo (`hooks` no `plugin.json`)

O núcleo chama a rota indicada (POST, como chamada interna) e usa a resposta. Gancho que aponta para uma rota que o plugin não anuncia é ignorado e vai para o log.

| Gancho | Recebe | Devolve (tudo opcional) |
|---|---|---|
| `build.info` | `{ project, root, rel, vcs, aggregator, poms, mavens, jdks }` | `{ tasks, aggregator, maven, systemNames, repos, data }`: tarefas extras (`main` destaca, `detail` lista os passos), pom agregador, versão de Maven preferida, nome dos grupos de tarefas, repositórios Maven (`{ id, label, default }`) e dados livres que o `ui.js` lê em `bs.build.info().plugins[id]` |
| `build.run` | `{ project, root, repo }` quando o usuário escolheu um repositório do plugin | `{ settings, env, note }`: settings.xml do Maven, variáveis de ambiente do build e o aviso no console |
| `lint` | `{ project, file }` (caminho relativo ao projeto) | `{ handled, tool, problems: [{ line, col, end_line, end_col, sev, msg, rule }], client }`. Com `handled: false` (ou erro), o núcleo segue o lint de sempre. `sev` é `error`, `warning` ou `info`; `client: "ts"` mantém o verificador TypeScript do editor |

## Servidor de plugins

`app/plugin-server` é um programa à parte que hospeda plugins com versões. A IDE aponta para ele na aba **Plugins** › **Servidores de plugins** (só o endereço). O servidor é só de leitura: a IDE lista, instala e atualiza, mas não envia nada para ele. A lista fica em `~/.bluescreen/plugins.json` (`servers`).

**Na IDE:**
- **Instalar.** Os plugins do servidor aparecem em **Disponíveis nos servidores**, com o botão **Instalar**.
- **Aviso de atualização.**
  - A IDE consulta os servidores alguns segundos depois de abrir, de meia em meia hora e quando você volta para a janela.
  - Havendo versão maior de um plugin instalado, aparecem o selo no topo e o número na aba Plugins.
  - O botão **Atualizar para vX** fica na linha do plugin.
  - O aviso some quando você atualiza.
- **Onde instala.** O plugin vai para `~/.bluescreen/plugins/<id>`, que vale mais que o do app.
  - O pacote é conferido pelo sha256 antes.
  - Um plugin com `server.exe` é encerrado e trocado sem fechar a IDE.
  - A pasta ganha um `.origin.json` com o servidor e a versão.
- **Desinstalar.** Botão direito no plugin › **Desinstalar**. Só vale para plugins da pasta do usuário. Se o app tiver o mesmo plugin, a versão do app volta a valer.

**No servidor:**

```
app\build.ps1 -PluginServer
dist\PluginServer\bluescreen-plugin-server.exe --port 4900 --dir D:\plugins --name "Plugins da equipe"
```

- **Pasta de dados:** `<dir>/<id>/<versão>/`. As IDEs sempre recebem a maior versão; as antigas ficam guardadas.
- **Publicar:** na máquina do servidor, solte a pasta do plugin, a que tem o `plugin.json`, direto em `<dir>/`. O servidor lê o id e a versão e arquiva sozinho. Para as IDEs receberem o aviso, aumente o `version` do `plugin.json`; uma versão que já está lá vai para `<dir>/_recusados/`.
- **Tirar uma versão:** apague `<dir>/<id>/<versão>/`.
- **Rotas:**
  - `GET /api/index`
  - `GET /api/plugins/<id>[?version=]`, que devolve o pacote `{ id, version, sha256, files: [{ path, data (base64) }] }`
  - `GET /`, uma página com a lista
- **Só leitura:** não há rota para enviar nem apagar plugins pela rede.

