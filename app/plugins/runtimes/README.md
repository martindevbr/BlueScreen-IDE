# Runtimes e execução

Plugin oficial do BlueScreen. Faz duas coisas.

## O que cada linguagem precisa instalado

Ao abrir um arquivo, o plugin confere se o runtime ou o compilador da linguagem está no PC e se atende à versão que o projeto pede. Se faltar, aparece um aviso no canto do editor com estas opções:

- **Baixar** pela própria IDE, na versão pedida: JDK, Node.js, Python, Go, .NET, Rust, Kotlin, Maven, Gradle e Zig. O Zig também compila C e C++. Não precisa de instalador nem de administrador.
- **Outras versões…**: abre a janela SDKs (fornecedor e versão).
- **Já tenho instalado…**: você aponta a pasta de uma instalação. Para JDK, Node, Python, Go, .NET, Kotlin, Maven e Gradle, ela vira o padrão da IDE (o JDK vira o `JAVA_HOME` e o JDK do build). Os outros runtimes entram no PATH do terminal, do build e dos servidores de linguagem.
- **winget** / **scoop**: o comando de instalação roda no terminal da IDE. Depois, clique em **Verificar de novo**.
- **Página oficial**.

A versão pedida vem dos arquivos que as próprias ferramentas usam. O arquivo mais perto do arquivo aberto vale.

| Runtime | Onde lê |
|---|---|
| Java | `pom.xml` (`maven.compiler.release`/`source`, `java.version`, `<release>`), `build.gradle(.kts)` (toolchain, `jvmToolchain`, `sourceCompatibility`), `.java-version`, `.sdkmanrc`, `.tool-versions` |
| Node.js | `.nvmrc`, `.node-version`, `engines.node` do `package.json` |
| Python | `.python-version`, `requires-python` do `pyproject.toml`, `runtime.txt`, `Pipfile` |
| Go | `go.mod` (`go`, `toolchain`) |
| Rust | `rust-toolchain(.toml)`, `rust-version` do `Cargo.toml` |
| .NET | `global.json`, `<TargetFramework>` do `.csproj` |
| Ruby, PHP, Dart | `.ruby-version`/`Gemfile`, `require.php` do `composer.json`, `environment.sdk` do `pubspec.yaml` |

Linguagens cobertas: Java, Kotlin, Scala, Groovy, Clojure, Python, JavaScript, TypeScript, Go, Rust, C#, F#, VB, C, C++, Zig, Ruby, PHP, Perl, Lua, R, Julia, Dart, Swift, Elixir, Erlang, Haskell, Nim, OCaml, D, Shell e LaTeX. Arquivo de projeto Maven ou Gradle também pede o Maven ou o Gradle; o `mvnw` ou o `gradlew` do projeto já resolve.

O python.exe da Microsoft Store (o atalho em `WindowsApps` que só abre a loja) não conta como Python.

A janela **Runtimes do projeto** (clique na status bar, `Shift` `Shift` › "Runtimes do projeto…" ou o resumo do projeto) mostra cada linguagem do projeto, o que ela precisa e onde está. Nela também se troca o JDK padrão.

## Executar os mains, como no IntelliJ

Um ▶ verde aparece na margem de cada ponto de entrada. Clique nele para executar, executar com argumentos (ficam guardados), depurar (Python, Go, Rust, C, C++ e C#) ou copiar o comando. `Ctrl+Shift+F10` executa o main mais perto do cursor.

O ▶ aparece também onde não há um `main`:

| Onde | Em que linha |
|---|---|
| Python e Ruby sem `if __name__ == "__main__"` | na primeira instrução solta (um módulo só com `def` e `class` não ganha ▶) |
| JavaScript e TypeScript | no `#!/usr/bin/env node`, ou na chamada solta de `main()` |
| Shell, PowerShell, `.bat`/`.cmd`, Lua, Perl (`.pl`), R, OCaml, Julia | na primeira linha que não é comentário: o arquivo roda inteiro |
| PHP | na linha do `<?php` |
| `package.json` | em cada script de `"scripts"`: roda com pnpm, yarn ou bun quando o projeto tem o lockfile deles, senão com npm |

| Linguagem | Ponto de entrada | Como roda |
|---|---|---|
| Java | `public static void main`, classe aninhada (`Externa$Interna`), `void main()` do Java 21+/25 | projeto Maven: `exec:java` (teste com o escopo test); Gradle: tarefa `bsRun` por um init script, sem mexer no build; solto: `javac -sourcepath` na raiz dos pacotes + `java -cp`, com os jars de `lib/`/`libs/` |
| Kotlin | `fun main` (`ArquivoKt`, `@file:JvmName`), `@JvmStatic` em `object`/`companion` | Maven/Gradle como no Java; solto: `kotlinc` + `java` |
| Scala, Groovy, Clojure | `@main`, `object X extends App`, `def main`; `static void main`/script; `-main` | `sbt runMain`, `scala-cli`; `groovy`; `clojure -M -m` / `lein run -m` |
| Python | `if __name__ == "__main__":` | o `.venv` do projeto (ou `uv run`/`poetry run`); dentro de pacotes, `python -m pacote.modulo` |
| C#, F#, VB | `static void/int/Task Main`, `[<EntryPoint>]`, `Sub Main` | `dotnet run --project` (com `StartupObject` quando há vários mains); `.cs` solto: `dotnet run arquivo.cs` |
| Go | `func main` em `package main` | `go run .` no pacote (`//go:build ignore`: só o arquivo) |
| Rust | `fn main` | `cargo run` com `--bin`/`--example` certos; fora de um crate, `rustc` |
| C, C++ | `int main` | gcc, clang ou `zig cc`, com os `.c`/`.cpp` vizinhos que não têm main |
| JS, TS, Ruby, Dart, Zig, Nim, Julia, Haskell, Swift, Elixir, D | `require.main === module`, `import.meta.main`, `if __FILE__ == $0`, `main()`... | `node`, tsx/deno/bun, `bundle exec ruby`, `dart run`, `zig build run`/`zig run`... |

A saída vai para o console do Build: erros clicáveis, parar, repetir (`Ctrl+F9`) e uma linha para digitar a entrada do programa (`Scanner`, `input()`). Antes de executar, o plugin confere os requisitos; se faltar algo, a janela de instalação abre e depois executa.

## Motor

Tudo roda na página, no `ui.js`, sem servidor próprio. O motor fica no fim do arquivo, entre `// >>> motor` e `// <<< motor`, sem DOM: ele pergunta ao núcleo pelas rotas `file/stat`, `file`, `tree` e `index` (arquivos do projeto), `sdk/which`, `sdk/jdks` e `sdk/mavens` (programas do PC), `sdk/default`, `sdk/path` e `sdk/forget`, e roda programas por `plugin.exec` (a versão de cada um, com 6 s de limite). As respostas têm o mesmo formato das antigas rotas `runtimes/*`:

| Função | Devolve |
|---|---|
| `R.check(project, file)` | `{ lang, name, needs, pm }`: requisitos da linguagem do arquivo e o estado de cada um |
| `R.project(project)` | `{ langs: [{ lang, name, files, needs }], pm }`: linguagens do projeto, contadas pelo índice de arquivos |
| `R.entries(file, text)` | `{ lang, entries: [{ line, label, target, instance }] }`: pontos de entrada do texto |
| `R.plan(project, file, line, args)` | `{ plan: { title, how, steps, jdk }, entry }`, `{ missing, lang, name, pm }` ou `{ fallback: true }` |
| `R.select(tool, path)` | `{ ok, path, version, status }`: aponta uma instalação existente |
| `R.forget()` | esquece o que já foi procurado (depois de instalar por fora) |

As classes compiladas, os executáveis de C, C++ e Rust e o init script do Gradle ficam em `~/.bluescreen/plugin-data/runtimes/files/run` (**Apagar dados do plugin** limpa).

Testes, sem a IDE: `node app/plugins/runtimes/tests/motor.test.js`.

## Arquitetura

**Decisão:** migrar para ui.js
**Analisado em:** 2026-10-22, versão 0.1.0 (Rust) → 0.2.0

| Critério | Resultado | Evidência |
|---|---|---|
| N1 CPU num caminho quente | não | `entries` (450 ms depois de cada tecla): 15 ms em JS no pior caso medido (app.js, 2.600 linhas, varrido como Java), 3 ms em Rust sem contar o HTTP; limite 50 ms. `check` e `plan` são leitura de arquivos pequenos e chamadas ao núcleo |
| N2 Paralelismo real | não | o Rust era sequencial (`spawn_blocking`) |
| N3 Biblioteca nativa | não | só `regex` e `serde` |
| N4 API do sistema | não | os programas rodam por `plugin.exec`; a pasta escolhida em "Já tenho instalado…", fora do projeto, é examinada pelo `where.exe` (~12 ms) ou, nas subpastas, pelo PowerShell (~1,1 s, num clique) |
| N5 Volume de dados | não | arquivos de projeto pequenos; textos acima de 4 MB são ignorados, como antes |
| N6 Outros dependem do crate | não | as rotas `runtimes/*` só eram chamadas pelo próprio `ui.js` |
| N7 Sem Node/Python | não se aplica | destino só `ui.js` |

Mesma resposta: as mesmas entradas na biblioteca Rust e no motor JS (212 arquivos de código, 57 versões pedidas e textos de versão, 105 planos de execução com conjuntos diferentes de programas e JDKs) deram JSON iguais.

Diferenças que ficaram: a pasta de trabalho saiu de `%TEMP%luescreen-run` para a pasta de dados do plugin; a versão de cada programa fica guardada até o **Verificar de novo** (antes, também era refeita se o arquivo do programa mudasse); a `lib/` ao lado da raiz dos pacotes Java só entra no classpath se estiver dentro do projeto; a contagem de linguagens do projeto usa o índice de arquivos do núcleo.

**Reavaliar quando:** a varredura dos mains passar de 50 ms em arquivos reais, ou o plugin precisar responder a outros plugins ou a um gancho do núcleo (aí o destino é `server.js`).
