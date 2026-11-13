# Migrar um plugin com `server.exe` para a arquitetura sem compilação

Este guia é para quem vai decidir, e depois fazer, a migração de um plugin com servidor compilado (Rust, `server.exe`) para a arquitetura que não precisa compilar: `ui.js` sozinho, ou `ui.js` com um `server.js` / `server.py`. Foi escrito para ser seguido por uma IA, passo a passo, mas vale igual para pessoas.

**A migração não é obrigatória.** Primeiro vem a análise (etapas 1 a 3). Só se ela disser "migrar" é que se mexe no código (etapas 4 a 6). Se a análise disser "manter", o plugin continua com `server.exe` e segue as regras de [PLUGINS-NATIVOS.md](PLUGINS-NATIVOS.md). As duas arquiteturas continuam valendo no BlueScreen; nenhuma delas vai ser removida do núcleo.

Referência da API: [PLUGINS.md](PLUGINS.md).

## As arquiteturas

| | Sem compilação (padrão) | Nativa (exceção) |
|---|---|---|
| Arquivos | `plugin.json` + `ui.js` (+ `style.css`), e opcionalmente `server.js` / `server.py` | `plugin.json` + `ui.js` + `Cargo.toml` + `src/`, que o `build.ps1` transforma em `server.exe` |
| Mudar o plugin | salvar o arquivo e recarregar | `build.ps1 -Plugin <id>` a cada mudança |
| Quem pode criar | qualquer pessoa, ou o IAMaker, em tempo real | quem tem o Rust instalado |
| Precisa na máquina do usuário | nada (`ui.js`), ou Node.js / Python (servidor em script) | nada |
| Desempenho | sobra para interface, HTTP, chamar programas, ler e gravar arquivos | melhor em CPU pesada, paralelismo e volume grande de dados |

Exemplos no repositório: `sheets` e `runtimes` são só `ui.js` (o `sheets` lê e grava `.xlsx` em JavaScript; o `runtimes` foi migrado do Rust, veja a seção Arquitetura do README dele). O `unilint` tem servidor em Rust.

## Etapa 1: inventário

Antes de opinar, levante o que o plugin faz de verdade. Leia `plugin.json`, `ui.js`, `Cargo.toml` e todo o `src/`, e preencha:

| Item | Onde olhar |
|---|---|
| Rotas que o servidor anuncia | `p.route("…")` em `src/bin/server.rs` |
| Quem chama cada rota | `api('<rota>'` no `ui.js` do próprio plugin, nos outros plugins (`app/plugins/*/ui.js`, `~/.bluescreen/plugins/*/ui.js`) e no núcleo (`app/wwwroot/*.js`, `app/src`) |
| Ganchos do núcleo | `"hooks"` no `plugin.json` (`lint`, `build.info`, `build.run`) |
| Dependências do `Cargo.toml` | cada crate além de `bluescreen-sdk`, `tokio`, `serde` e `serde_json` |
| O que o código faz com o sistema | `std::process::Command`, `std::fs`, varrer pastas, rede, APIs do Windows, `unsafe`, FFI |
| Paralelismo | `rayon`, `spawn_blocking`, threads |
| Uso do cofre | `vault_reveal`, `core().secret`, campos `vault` no `plugin.json` |
| Lib publicada para outros plugins | outro `Cargo.toml` que depende deste crate (como `bluescreen-ic`) |
| Quanto trabalho por chamada | quantos arquivos, quantos bytes, quantas vezes por minuto (a cada tecla? ao salvar? ao abrir o projeto?) |

## Etapa 2: critérios

### 2.1 Motivos para manter o `server.exe`

Basta **um** destes, confirmado no inventário e, quando for de desempenho, na medição da etapa 3:

| # | Motivo | Exemplo |
|---|---|---|
| N1 | **CPU pesada num caminho quente:** trabalho que o usuário espera ver na hora (a cada tecla, ao salvar, ao abrir um arquivo) e que, em JavaScript, passa do limite da etapa 3 | lint de 16 linguagens por árvore sintática a cada salvamento (`unilint`) |
| N2 | **Paralelismo real:** o ganho vem de usar vários núcleos ao mesmo tempo (`rayon`, threads), e o trabalho não se divide bem em processos separados | lint de uma pasta inteira em paralelo |
| N3 | **Biblioteca nativa sem equivalente maduro** em JavaScript ou Python | gramáticas Tree-sitter compiladas, codecs, bibliotecas em C |
| N4 | **API do sistema que o núcleo não expõe** e que nenhum programa de linha de comando entrega | Win32, DPAPI direto, memória compartilhada, drivers |
| N5 | **Volume de dados que não cabe na página:** centenas de MB em memória, ou arquivos de vários GB lidos em streaming | índices grandes, logs gigantes |
| N6 | **Outros plugins dependem do crate** (link em Rust, não só HTTP) | um crate de cliente compartilhado |
| N7 | **O destino seria um servidor em script** e o plugin precisa funcionar em máquinas sem Node.js e sem Python | plugin para uma equipe que não tem Node instalado |

N7 só vale quando o plugin precisa mesmo de servidor (veja 2.3). Se ele couber só no `ui.js`, N7 não se aplica, porque o `ui.js` não depende de nada instalado.

### 2.2 Sinais de que a migração compensa

| # | Sinal |
|---|---|
| M1 | O servidor só repassa coisas: chama `core()`, roda um programa, faz HTTP e devolve JSON |
| M2 | O trabalho pesado já é feito por um programa externo (`git`, `mvn`, `java -version`, `node --version`) e o Rust só chama e interpreta a saída |
| M3 | As regex e o processamento de texto rodam em arquivos pequenos (um arquivo aberto, um `pom.xml`, um `package.json`) |
| M4 | O plugin muda com frequência, e a recompilação atrasa ou impede quem vai mexer nele (inclusive o IAMaker) |
| M5 | Pouca gente da equipe sabe Rust, e o plugin fica sem manutenção por causa disso |
| M6 | O `Cargo.toml` só depende de `bluescreen-sdk`, `tokio`, `serde`, `serde_json` e `regex` |
| M7 | O tempo de resposta que importa é o de rede ou de um processo externo, não o do código do plugin |

### 2.3 Para onde migrar

Escolha o primeiro que servir:

1. **Só `ui.js`**, quando nada do plugin precisa ficar fora da página. A página já tem `plugin.exec`, `plugin.spawn`, `plugin.fetch`, `plugin.data`, `plugin.files`, `plugin.settings`, os modelos `{{vault:…}}` e as rotas do núcleo por `bs.api` (`file`, `tree`, `search`, `sdk/which`, `sdk/jdks`, `sdk/mavens`, `sdk/default`, `sdk/path`, `build/input`…).
2. **`ui.js` + `server.js`** (ou `server.py`), quando o plugin precisa de alguma destas:
   - atender um **gancho do núcleo** (`hooks`), porque o gancho chama uma rota;
   - oferecer **rotas que outros plugins chamam**;
   - **ler o valor cru de um segredo** (`vault.reveal`), que só vale para servidores;
   - **continuar trabalhando sem a página**, com a página recarregando ou fechada;
   - **ler o disco direto**, além do que `file`, `tree` e `search` do núcleo oferecem.
3. **Híbrido:** `ui.js` e um servidor em script para quase tudo, e um `.exe` pequeno, chamado por `plugin.exec`, só para a parte que cai em N1 a N5. Use quando um único trecho justifica o nativo e o resto não.

## Etapa 3: medir

Para N1, N2 e N5, a decisão sai de números, não de impressão.

1. Escolha de 3 a 5 entradas reais e do tamanho que o usuário usa de verdade: o maior arquivo comum do projeto, a pasta inteira, o caso típico.
2. Meça a rota atual. No DevTools da página: `console.time('x'); await bs.api('<rota>', {...}); console.timeEnd('x')`. Repita 5 vezes e anote a mediana.
3. Reescreva **só o trecho quente** em JavaScript (ou Python, se o destino for `server.py`), sem interface, e meça com as mesmas entradas.
4. Compare com os limites:

| Quando o trabalho acontece | Limite aceitável para a versão nova |
|---|---|
| A cada tecla, ao mover o cursor | 50 ms |
| Ao abrir ou salvar um arquivo | 200 ms |
| Ao abrir o projeto, ou com um clique do usuário | 1 s, ou 2× o tempo atual (vale o maior) |
| Em segundo plano, sem ninguém esperando | sem limite de tempo; olhe só a memória (até 300 MB) |

Se a versão nova ficar dentro do limite, o motivo de desempenho cai. Se passar, o motivo vale e o plugin fica nativo, ou vira híbrido (2.3, item 3).

Se não der para medir (o trecho não é isolável, falta o ambiente), registre isso na decisão e trate como "manter" até alguém medir.

## Decisão

| Resultado da análise | Decisão |
|---|---|
| Nenhum motivo de 2.1 confirmado | **Migrar** para o destino de 2.3 |
| Um motivo de 2.1 confirmado, preso a um trecho pequeno | **Híbrido** |
| Um motivo de 2.1 confirmado, atravessando o plugin inteiro | **Manter nativo**, seguindo [PLUGINS-NATIVOS.md](PLUGINS-NATIVOS.md) |
| Dúvida, ou medição impossível | **Manter nativo** e registrar o que falta medir |

Registre a decisão no `README.md` do plugin, numa seção **Arquitetura**, com este modelo:

```markdown
## Arquitetura

**Decisão:** migrar para ui.js | migrar para ui.js + server.js | híbrido | manter nativo
**Analisado em:** AAAA-MM-DD, versão X.Y.Z

| Critério | Resultado | Evidência |
|---|---|---|
| N1 CPU num caminho quente | não | `runtimes/entries`: 3 ms em Rust, 9 ms em JS (arquivo de 2 mil linhas), limite 200 ms |
| ... | | |

**Reavaliar quando:** <o que mudaria a decisão>
```

Ao final da análise, a IA responde com a decisão, a tabela e, se for migrar, o plano da etapa 4. Ela não começa a migrar sem a confirmação de quem pediu.

## Etapa 4: migrar

### 4.1 Mantenha o contrato

O caminho mais seguro é trocar o motor e deixar o contrato intacto:

- **Destino `server.js` / `server.py`:** anuncie **as mesmas rotas, com os mesmos nomes**, recebendo os mesmos parâmetros e devolvendo o mesmo JSON (mesmos campos, tipos e códigos de erro). Assim o `ui.js`, os outros plugins e o núcleo não mudam.
- **Destino só `ui.js`:** troque cada `api('<id>/<rota>', …)` por uma função local do `ui.js` que devolve o mesmo formato. Antes, confirme no inventário que **nenhum outro plugin nem o núcleo chamam essas rotas**. Se algum chamar, o destino é `server.js`.
- **Ganchos** (`hooks`) exigem servidor. O destino mínimo é `server.js`, com a rota do gancho devolvendo o mesmo formato (veja a tabela de ganchos em [PLUGINS.md](PLUGINS.md#ganchos-do-núcleo-hooks-no-pluginjson)).
- **Dados:** a pasta `~/.bluescreen/plugin-data/<id>/` é a mesma nas duas arquiteturas. Leia os arquivos que o Rust gravava no mesmo formato, ou escreva a conversão na primeira execução e guarde uma marca (`plugin.data.set('migrado', 'X.Y.Z')`).

### 4.2 De Rust para a API sem compilação

| Em Rust (`bluescreen-sdk`) | No `ui.js` | No `server.js` |
|---|---|---|
| `p.route("id/x", …)` | função local (se só o próprio plugin chama) | `p.route('id/x', async (req) => …)` |
| `core().get("sdk/which", …)` / `core().post(…)` | `bs.api('sdk/which', …)` | `p.core.get(…)` / `p.core.post(…)` |
| `std::process::Command` (rodar e esperar) | `plugin.exec(prog, args, { cwd, env, timeout })` | `p.exec` pela rota `plugin/exec`, ou `child_process` do Node |
| processo longo, watcher | `plugin.spawn(…)` | `child_process.spawn` |
| `std::fs::read_to_string` de arquivo do projeto | `bs.api('file', { project, file })` | `fs.readFileSync` |
| varrer pastas do projeto | `bs.api('tree', { project, dir })`, `bs.api('search', …)` | `fs.readdirSync` / `fs.promises.opendir` |
| arquivos do próprio plugin | `plugin.files.read/write/list` | `p.files` |
| `core().data_get/data_set` | `plugin.data.get/set` | `p.data` |
| `core().settings` | `plugin.settings.get()` | `p.settings()` |
| HTTP (`reqwest`) | `plugin.fetch(url, …)` (sem CORS) | `p.fetch` ou `fetch` do Node 18+ |
| `vault_reveal` | não existe: use `{{vault:nome}}` no `fetch`/`exec` | `p.vault.reveal('nome')` |
| `regex` | `RegExp` (atenção: sem `(?x)`, `\A`, `\z`; nomes de grupo `(?<n>…)`) | `RegExp` / `re` do Python |
| `serde_json` | `JSON.parse` / `JSON.stringify` | o mesmo |
| `spawn_blocking` | divida o trabalho, ou leve para `server.js` | `worker_threads` se for pesado |
| `creation_flags(0x0800_0000)` (sem janela) | o `plugin.exec` do núcleo já esconde a janela | `windowsHide: true` |

### 4.3 Tire o Rust de vez

O núcleo escolhe o servidor nesta ordem: o campo `server` do `plugin.json`, depois `server.exe`, `server.js`, `server.mjs`, `server.py`, `server.ps1`, e por último o binário `target/release|debug/bluescreen-<id>.exe` (`app/src/plugins/external.rs`, `server_cmd`). Um `server.exe` esquecido **ganha** do `server.js` novo. Por isso:

1. Apague `Cargo.toml` e `src/` da pasta do plugin. Enquanto o `Cargo.toml` existir, o `build.ps1` volta a gerar e copiar o `server.exe`.
2. Apague o `server.exe` de onde ele foi instalado: `app/dist/…/plugins/<id>/` e `~/.bluescreen/plugins/<id>/`.
3. Se quiser deixar explícito, declare `"server": "server.js"` no `plugin.json`.
4. Se o crate aparecia como dependência de outro, resolva isso antes (N6 deveria ter barrado).
5. Aumente o `version` do `plugin.json`, para as IDEs da equipe receberem a versão nova pelo [servidor de plugins](PLUGINS.md#servidor-de-plugins).

Até a versão nova ser aprovada, a versão antiga fica no git. Não apague nada que não esteja commitado.

## Etapa 5: verificar

A migração só termina quando tudo isto passa:

| Verificação | Como |
|---|---|
| **Mesma resposta** | Antes de apagar o Rust, rode as mesmas entradas da etapa 3 na rota antiga e na nova e compare os JSON. Diferenças só de ordem de chaves são aceitáveis; qualquer outra é defeito ou precisa de justificativa |
| **Mesmo tempo** | As medidas da etapa 3 com a versão completa, dentro dos limites |
| **Interface** | Cada painel, atalho, item de menu, ação e card do plugin funciona como antes |
| **Liga e desliga** | Em `Alt+7`, desligar faz o plugin sumir por inteiro; religar volta tudo |
| **Sem processo velho** | Com o plugin ligado, não há `bluescreen-<id>.exe` no Gerenciador de Tarefas; com servidor em script, há um `node`/`python` que some ao desligar |
| **Log limpo** | `~/.bluescreen/bluescreen.log` sem erros do plugin ao ligar, usar e desligar |
| **Dados antigos** | Um `plugin-data/<id>` gravado pela versão Rust abre na versão nova |
| **Sem Node / Python** (se o destino for servidor em script) | Sem o programa, o plugin mostra uma mensagem clara, não uma tela quebrada |

## Etapa 6: relatório

Ao terminar, a IA entrega:

1. A decisão e a tabela de critérios (o que foi para o `README.md`).
2. O que mudou: arquivos criados, alterados e apagados.
3. O resultado de cada verificação da etapa 5, inclusive as que falharam ou não puderam ser feitas.
4. As diferenças de comportamento que ficaram, se houver.

## Situação dos plugins do repositório

| Plugin | Arquitetura | Leitura inicial |
|---|---|---|
| `qautils` | só `ui.js` | já está na arquitetura nova; desde 2026-11 mora na [loja de plugins](https://github.com/martindevbr/BlueScreen-Plugins), como o `iamaker` |
| `sheets` | só `ui.js` | já está na arquitetura nova |
| `unilint` | Rust (`server.exe`) | **Manter nativo** (reconfirmado em 2026-10-22): gancho `lint` num caminho quente (N1), 15 gramáticas Tree-sitter compiladas (N3), `rayon` (N2) e `mimalloc` |
| `runtimes` | só `ui.js` (desde a 0.2.0) | **Migrado** em 2026-10-22: nenhum motivo de 2.1 confirmado; a varredura dos mains leva até 15 ms em JS (limite 50 ms) e as respostas são iguais às do Rust. Detalhes na seção Arquitetura do README |
