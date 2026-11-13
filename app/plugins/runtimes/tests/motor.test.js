// Testes do motor do plugin (o trecho entre "// >>> motor" e "// <<< motor" do ui.js), sem a IDE:
//   node app/plugins/runtimes/tests/motor.test.js
// O `io` daqui lê o disco de verdade, como as rotas file/stat, file, tree e index do núcleo. Os casos são os mesmos dos
// testes da versão em Rust (langs.rs, require.rs, entries.rs e plan.rs).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
const a = src.indexOf('// >>> motor'), b = src.indexOf('// <<< motor');
assert(a >= 0 && b > a, 'marcas do motor no ui.js');
const runtimesCore = new Function(src.slice(a, b) + '\nreturn runtimesCore;')();

// as pastas que o núcleo esconde na árvore (IGNORED_DIRS do bluescreen-sdk)
const IGNORED = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'target', '.idea', '.vscode', '__pycache__', '.next', 'coverage']);
const WIN = process.platform === 'win32';
function nodeIo(over = {}) {
  const work = over.work || path.join(os.tmpdir(), `bs-rt-work-${process.pid}`);
  return {
    win: WIN,
    async stat(root, rels) { const o = {}; for (const r of rels) { try { o[r] = fs.statSync(path.join(root, r)).isFile() ? { size: 0 } : null; } catch { o[r] = null; } } return o; },
    async read(root, r) { const p = path.join(root, r); return fs.statSync(p).size > 2 * 1024 * 1024 ? '' : fs.readFileSync(p, 'utf8'); },
    async list(root, r) { return fs.readdirSync(path.join(root, r), { withFileTypes: true }).filter(e => !IGNORED.has(e.name)).map(e => ({ name: e.name, dir: e.isDirectory() })); },
    async index(root) {
      const out = [];
      (function walk(rel) { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { if (IGNORED.has(e.name)) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(r); else out.push(r); } })('');
      return out;
    },
    async workDir() { return work; },
    async writeWork(rel, content) { const p = path.join(work, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
    async which(progs) { return Object.fromEntries(progs.map(p => [p, null])); },
    async jdks() { return []; },
    async mavens() { return []; },
    async exec() { throw new Error('sem exec nos testes'); },
    async core() { return {}; },
    ...over,
  };
}
const core = runtimesCore(nodeIo());
const _ = core._;
function tmp(n) { const d = path.join(os.tmpdir(), `bs-rt-${n}-${process.pid}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; }
function write(d, rel, text) { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
const jdk = (major) => ({ home: `C:/jdk-${major}`, major, name: `jdk-${major}` });
const e = (target) => ({ line: 1, label: 'Main.main()', target });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('catálogo', () => {
  for (const l of core.langs) for (const alts of l.needs) for (const x of alts) assert(_.tool(x), `${l.id} pede ${x}`);
  assert.strictEqual(_.langOf('a/B.java').id, 'java');
  assert.strictEqual(_.langOf('x.TSX').id, 'typescript');
  assert.strictEqual(_.needsFor(core.langs.find(l => l.id === 'kotlin'), true).length, 1);
});

test('versões', () => {
  assert(_.satisfies('21.0.2', '21'));
  assert(_.satisfies('23', '21'));
  assert(!_.satisfies('17.0.9', '21'));
  assert(_.satisfies('3.12.1', '3.11'));
  assert(!_.satisfies('3.9.6', '3.10'));
  assert(_.satisfies('1.22.1', '1.22'));
  assert.strictEqual(_.normJava('1.8'), '8');
  assert.strictEqual(_.normJava('17'), '17');
  assert.strictEqual(_.parseVersion('go version go1.22.1 windows/amd64'), '1.22.1');
  assert.strictEqual(_.parseVersion('Python 3.12.1'), '3.12.1');
  assert.strictEqual(_.parseVersion('v20.11.0'), '20.11.0');
  assert.strictEqual(_.parseVersion('ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [x64-mingw-ucrt]'), '3.3.0');
  assert.strictEqual(_.parseVersion('cargo 1.79.0 (ffa9cf99a 2024-06-03)'), '1.79.0');
});

test('versão pedida pelos arquivos do projeto', async () => {
  const d = tmp('req');
  write(d, 'pom.xml', '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>');
  write(d, 'mod/build.gradle.kts', 'java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }');
  write(d, 'mod/src/.keep', '');
  write(d, '.nvmrc', 'v20.11.0\n');
  write(d, 'pyproject.toml', '[project]\nrequires-python = ">=3.10,<4"\n');
  write(d, 'go.mod', 'module x\n\ngo 1.22\n');
  write(d, 'App.csproj', '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  const fsx = _.projectFs(d);
  assert.deepStrictEqual(await _.need(fsx, 'jdk', 'mod/src'), { version: '17', source: 'mod/build.gradle.kts' });
  assert.strictEqual((await _.need(fsx, 'jdk', '')).version, '21');
  assert.strictEqual((await _.need(fsx, 'node', 'mod')).version, '20.11.0');
  assert.strictEqual((await _.need(fsx, 'python', '')).version, '3.10');
  assert.strictEqual((await _.need(fsx, 'go', '')).version, '1.22');
  assert.strictEqual((await _.need(fsx, 'dotnet', '')).version, '8');
  fs.rmSync(d, { recursive: true, force: true });
});

test('mains do Java', () => {
  const s = 'package com.acme.app;\n\n/** public static void main(String[] a) no comentário */\npublic class Main {\n  static String s = "void main(String[] x)";\n  public static void main(String[] args) {\n    System.out.println("{");\n    char c = \'{\';\n  }\n  static class Inner {\n    public static void main(String... args) {}\n  }\n}\nclass Other { static public void main(final String args[]) {} }\n';
  let r = _.find('java', 'src/com/acme/app/Main.java', s);
  assert.deepStrictEqual(r.map(x => [x.line, x.target]), [[6, 'com.acme.app.Main'], [11, 'com.acme.app.Main$Inner'], [14, 'com.acme.app.Other']]);
  assert.strictEqual(r[1].label, 'Main.Inner.main()');
  // chave na linha de baixo
  assert.strictEqual(_.find('java', 'B.java', 'public class B\n{\n    public static void main(String[] args)\n    {\n    }\n}\n')[0].target, 'B');
  // Java 25: classe implícita e main de instância
  assert.deepStrictEqual(_.find('java', 'Hello.java', 'void main() {\n  IO.println("oi");\n}\n'), [{ line: 1, label: 'Hello.main()', target: 'Hello', instance: true }]);
  // static, mas fora de classe: também é a classe implícita (não compila no Java 8)
  assert.deepStrictEqual(_.find('java', 'Main.java', 'public static void main(String[] args) {\n    System.out.println("Teste");\n}\n'), [{ line: 1, label: 'Main.main()', target: 'Main', instance: true }]);
  // método main que não é ponto de entrada
  assert.deepStrictEqual(_.find('java', 'A.java', 'class A { private void main() {} int main(int x) { return x; } }'), []);
});

test('mains do Kotlin', () => {
  assert.strictEqual(_.find('kotlin', 'src/main/kotlin/app/server.kt', 'package app\n\ndata class P(val x: Int)\nfun main(args: Array<String>) {\n}\n')[0].target, 'app.ServerKt');
  assert.strictEqual(_.find('kotlin', 'Tool.kt', '@file:JvmName("Cli")\nfun main() {}\n')[0].target, 'Cli');
  const s = 'package p\nclass App {\n  companion object {\n    @JvmStatic\n    fun main(args: Array<String>) {}\n  }\n}\nobject Runner {\n  @JvmStatic fun main(args: Array<String>) {}\n}\nobject NoStatic {\n  fun main(args: Array<String>) {}\n}\n';
  assert.deepStrictEqual(_.find('kotlin', 'App.kt', s).map(x => x.target), ['p.App', 'p.Runner']);
});

test('mains das outras linguagens', () => {
  assert.strictEqual(_.find('python', 'a.py', "def f():\n    pass\n\nif __name__ == '__main__':\n    f()\n")[0].line, 4);
  assert.strictEqual(_.find('go', 'm.go', 'package main\n\nfunc main() {\n}\n')[0].line, 3);
  assert.deepStrictEqual(_.find('go', 'm.go', 'package util\n\nfunc main() {}\n'), []);
  assert.strictEqual(_.find('rust', 'm.rs', '// fn main() {}\nfn helper() { fn main() {} }\n#[tokio::main]\nasync fn main() {}\n')[0].line, 4);
  assert.strictEqual(_.find('rust', 'lt.rs', "fn f<'a>(x: &'a str) -> &'a str { x }\nfn main() {}\n")[0].line, 2);
  assert.strictEqual(_.find('c', 'a.c', '#include <stdio.h>\nint main(void) {\n  return 0;\n}\n')[0].line, 2);
  assert.strictEqual(_.find('csharp', 'P.cs', 'namespace Demo.App;\npublic class Program\n{\n    public static async Task<int> Main(string[] args) { return 0; }\n}\n')[0].target, 'Demo.App.Program');
  assert.strictEqual(_.find('scala', 'M.scala', 'package x\nobject Main extends App {\n}\n')[0].target, 'x.Main');
  assert.strictEqual(_.find('scala', 'M.scala', '@main def hello(): Unit = ()\n')[0].target, 'hello');
  assert.strictEqual(_.find('ruby', 'a.rb', 'if __FILE__ == $0\n  run\nend\n')[0].line, 1);
  assert.strictEqual(_.find('javascript', 'a.js', 'if (require.main === module) main();\n')[0].line, 1);
  assert.strictEqual(_.find('clojure', 'core.clj', '(ns my.app.core)\n(defn -main [& args] (println 1))\n')[0].target, 'my.app.core');
  assert.strictEqual(_.find('dart', 'a.dart', 'Future<void> main() async {\n}\n')[0].line, 1);
  assert.strictEqual(_.find('vb', 'M.vb', 'Module Program\n    Sub Main(args As String())\n    End Sub\nEnd Module\n')[0].target, 'Program');
});

test('argumentos', () => {
  assert.deepStrictEqual(_.splitArgs('a "b c" \'d e\' f'), ['a', 'b c', 'd e', 'f']);
  assert.deepStrictEqual(_.splitArgs('  '), []);
});

const env = (d, has, jdks) => ({ has, jdks, work: path.join(d, 'work'), mkdir: async (r) => fs.mkdirSync(path.join(d, 'work', r), { recursive: true }) });
const run = (d, ev, rel, lang, en, args = '') => _.plan(ev, _.projectFs(d), rel, lang, en, args);

test('executar Java solto, Maven e Gradle', async () => {
  const d = tmp('java');
  const ev = env(d, () => true, [jdk(17), jdk(21)]);
  // solto, com pacote: -sourcepath na raiz dos pacotes
  write(d, 'app/com/x/Main.java', 'package com.x;\npublic class Main { public static void main(String[] a) {} }\n');
  let p = await run(d, ev, 'app/com/x/Main.java', 'java', e('com.x.Main'), 'um "dois três"');
  assert.strictEqual(p.steps.length, 2);
  const sp = p.steps[0].args.indexOf('-sourcepath');
  assert.strictEqual(path.resolve(p.steps[0].args[sp + 1]), path.join(d, 'app'));
  assert.deepStrictEqual(p.steps[1].args.slice(-3), ['com.x.Main', 'um', 'dois três']);
  assert.strictEqual(p.jdk, 'C:/jdk-17');
  // pom.xml pede 21: escolhe o JDK 21; arquivo em src/test vira escopo test
  write(d, 'svc/pom.xml', '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>');
  write(d, 'svc/src/test/java/a/T.java', 'package a; class T { public static void main(String[] a) {} }');
  p = await run(d, ev, 'svc/src/test/java/a/T.java', 'java', e('a.T'));
  assert.strictEqual(p.steps[0].kind, 'maven');
  assert(p.steps[0].args.includes('-Dexec.classpathScope=test') && p.steps[0].args.includes('test-compile'));
  assert.strictEqual(p.jdk, 'C:/jdk-21');
  // Gradle multi-projeto: tarefa :lib:bsRun na raiz, com o wrapper
  write(d, 'g/settings.gradle.kts', 'include("lib")');
  write(d, WIN ? 'g/gradlew.bat' : 'g/gradlew', '');
  write(d, 'g/lib/build.gradle.kts', 'plugins { kotlin("jvm") }');
  write(d, 'g/lib/src/main/kotlin/k/App.kt', 'package k\nfun main() {}\n');
  p = await run(d, ev, 'g/lib/src/main/kotlin/k/App.kt', 'kotlin', e('k.AppKt'));
  assert(p.steps[0].program.endsWith(WIN ? 'gradlew.bat' : 'gradlew'));
  assert(p.steps[0].args.includes(':lib:bsRun') && p.steps[0].args.includes('-Dbs.main=k.AppKt'));
  assert.strictEqual(path.resolve(p.steps[0].cwd), path.join(d, 'g'));
  // sem JDK que atenda
  const old = env(d, () => true, [jdk(11)]);
  await assert.rejects(run(d, old, 'svc/src/test/java/a/T.java', 'java', e('a.T')), /21/);
  await assert.rejects(run(d, old, 'app/com/x/Main.java', 'java', { ...e('Main'), instance: true }));
  fs.rmSync(d, { recursive: true, force: true });
});

test('executar Python, Rust e C', async () => {
  const d = tmp('misc');
  const ev = env(d, (p) => p === 'python' || p === 'gcc', []);
  for (const f of ['pkg/__init__.py', 'pkg/sub/__init__.py']) write(d, f, '');
  write(d, 'pkg/sub/tool.py', "if __name__ == '__main__':\n    pass\n");
  let p = await run(d, ev, 'pkg/sub/tool.py', 'python', { line: 1, label: 'tool.py' });
  assert.deepStrictEqual(p.steps[0].args.slice(-2), ['-m', 'pkg.sub.tool']);
  assert.strictEqual(path.resolve(p.steps[0].cwd), path.resolve(d));
  // cargo: src/bin/x.rs
  write(d, 'cr/Cargo.toml', '[package]\nname = "cr"\n');
  write(d, 'cr/src/bin/cli.rs', 'fn main() {}');
  p = await run(d, ev, 'cr/src/bin/cli.rs', 'rust', e(''), '-v');
  assert.deepStrictEqual(p.steps[0].args, ['run', '--bin', 'cli', '--', '-v']);
  // C: vizinhos sem main entram junto
  write(d, 'c/main.c', 'int main(void) { return f(); }');
  write(d, 'c/util.c', 'int f(void) { return 0; }');
  write(d, 'c/other.c', 'int main() { return 1; }');
  p = await run(d, ev, 'c/main.c', 'c', e(''));
  assert.strictEqual(p.steps[0].program, 'gcc');
  assert(p.steps[0].args.some(x => x.endsWith('util.c')) && !p.steps[0].args.some(x => x.endsWith('other.c')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('requisitos de um arquivo (runtimes/check)', async () => {
  const d = tmp('check');
  write(d, 'pom.xml', '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>');
  write(d, 'src/main/java/a/A.java', 'package a; public class A { public static void main(String[] x) {} }');
  write(d, 'web/app.ts', 'console.log(1)');
  write(d, 'web/.nvmrc', '22');
  const c = runtimesCore(nodeIo({
    async which(progs) { return Object.fromEntries(progs.map(p => [p, p === 'node' ? 'C:\\node\\node.exe' : null])); },
    async jdks() { return [jdk(17)]; },
    async exec(prog, args) { assert.strictEqual(prog, 'C:\\node\\node.exe'); return { ok: true, out: 'v20.11.0\n', err: '' }; },
  }));
  let r = await c.check(d, 'src/main/java/a/A.java');
  assert.strictEqual(r.lang, 'java');
  assert.deepStrictEqual(r.needs.map(n => [n.id, n.status, n.version]), [['jdk', 'old', '17'], ['maven', 'missing', undefined]]);
  assert.deepStrictEqual(r.needs[0].need, { version: '21', source: 'pom.xml' });
  r = await c.check(d, path.join(d, 'web', 'app.ts'));
  assert.deepStrictEqual(r.needs.map(n => [n.id, n.status, n.version, n.need && n.need.version]), [['node', 'old', '20.11.0', '22']]);
  assert.deepStrictEqual(r.needs[0].alts, ['Deno', 'Bun']);
  const pr = await c.project(d);
  assert.deepStrictEqual(pr.langs.map(l => [l.lang, l.files]), [['java', 1], ['typescript', 1]]);
  assert.deepStrictEqual(await c.check(d, 'README'), { lang: null });
  fs.rmSync(d, { recursive: true, force: true });
});

test('scripts sem main e scripts do package.json', async () => {
  const L = (lang, file, src) => _.find(lang, file, src).map(e => e.line);
  // Python: o "if __name__" ganha; sem ele, a primeira instrução solta; módulo só com definições não tem ▶
  assert.deepStrictEqual(L('python', 'a.py', 'import os\n\ndef f():\n    pass\n\nprint(f())\n'), [6]);
  assert.deepStrictEqual(L('python', 'a.py', 'def f():\n    pass\n\nif __name__ == "__main__":\n    f()\n'), [4]);
  assert.deepStrictEqual(L('python', 'lib.py', 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import x\n\nclass A:\n    pass\n'), []);
  assert.deepStrictEqual(L('python', '__init__.py', 'print(1)\n'), []);
  // JavaScript: #! do node, ou a chamada solta de main()
  assert.deepStrictEqual(L('javascript', 'cli.js', '#!/usr/bin/env node\nconsole.log(1)\n'), [1]);
  assert.deepStrictEqual(L('javascript', 'a.mjs', 'async function main() {}\n\nmain().catch(console.error);\n'), [3]);
  assert.deepStrictEqual(L('typescript', 'util.ts', 'export const soma = (a: number, b: number) => a + b;\n'), []);
  // o arquivo é o programa: primeira linha que não é comentário
  assert.deepStrictEqual(L('shell', 'x.sh', '#!/bin/bash\n# comentário\necho oi\n'), [1]);
  assert.deepStrictEqual(L('shell', 'x.sh', '# comentário\n\necho oi\n'), [3]);
  assert.deepStrictEqual(L('powershell', 'x.ps1', '# nota\nWrite-Host "oi"\n'), [2]);
  assert.deepStrictEqual(L('batch', 'x.bat', 'REM nota\n@echo off\n'), [2]);
  assert.deepStrictEqual(L('lua', 'x.lua', '-- nota\nprint("oi")\n'), [2]);
  assert.deepStrictEqual(L('php', 'x.php', '<html>\n<?php echo 1; ?>\n'), [2]);
  assert.deepStrictEqual(L('perl', 'Lib.pm', 'package Lib;\n1;\n'), []);
  assert.deepStrictEqual(L('ruby', 'x.rb', 'require "json"\n\nputs JSON.generate({})\n'), [3]);
  assert.strictEqual(_.langOf('x.ps1').id, 'powershell');
  assert.strictEqual(_.langOf('web/package.json').id, 'npm');
  assert.strictEqual(_.langOf('outro.json'), null);
  // package.json: um ponto de execução por script
  const pkg = '{\n  "name": "x",\n  "scripts": {\n    "dev": "vite",\n    "build:prod": "vite build"\n  },\n  "dependencies": {\n    "a": "1"\n  }\n}\n';
  assert.deepStrictEqual(_.find('npm', 'package.json', pkg), [{ line: 4, label: 'dev', target: 'dev' }, { line: 5, label: 'build:prod', target: 'build:prod' }]);
  assert.deepStrictEqual(_.find('npm', 'package.json', '{ "name": "x" }'), []);
  // o gerenciador sai do lockfile, quando o programa dele existe; senão, npm
  const d = tmp('npm');
  fs.writeFileSync(path.join(d, 'package.json'), pkg); fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
  const plan = async (has, args) => (await _.plan({ has: (x) => has.includes(x), jdks: [], work: d, mkdir() {} }, _.projectFs(d), 'package.json', 'npm', { line: 4, label: 'dev', target: 'dev' }, args || '')).steps[0];
  let st = await plan(['pnpm', 'npm']);
  assert.deepStrictEqual([st.program, st.args], ['pnpm', ['run', 'dev']]);
  st = await plan(['npm'], '--host 0.0.0.0');
  assert.deepStrictEqual([st.program, st.args], ['npm', ['run', 'dev', '--', '--host', '0.0.0.0']]);
  fs.rmSync(d, { recursive: true, force: true });
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok    ' + name); }
    catch (err) { fail++; console.log('FALHA ' + name + '\n' + (err && err.stack || err)); }
  }
  console.log(`\n${tests.length - fail} de ${tests.length} passaram`);
  process.exit(fail ? 1 : 0);
})();
