/* BlueScreen: análise semântica e refatoração para qualquer linguagem, pelo Language Server Protocol.
   Para cada linguagem o BlueScreen usa o servidor oficial instalado no PC (rust-analyzer, gopls, pyright, clangd,
   jdtls, typescript-language-server...), aberto pelo núcleo e ligado por WebSocket (/api/rpc/ws). O servidor sobe
   na primeira vez que um arquivo daquela linguagem é aberto, um por projeto.
   No editor, com os atalhos do IntelliJ:
     Shift+F6 renomear (em todos os arquivos)     Alt+Enter ações rápidas e refatorações     Ctrl+B / Ctrl+clique definição
     Alt+F7 usos                                  Ctrl+Alt+B implementações                   Ctrl+Shift+B tipo
     Ctrl+F12 estrutura do arquivo                Ctrl+Q documentação                         Ctrl+Alt+O organizar imports
     Shift+Alt+F formatar
   Também: erros e avisos do servidor no código, completar, assinatura dos parâmetros e destaque dos usos.
   O item "LSP" da status bar mostra o servidor do arquivo aberto; sem servidor, ele oferece instalar pelo terminal.
   Expõe bs.lsp: tools(), clientFor(tab), restart(). */
(function (bs) {

const LS = { tools: null, clients: new Map(), docs: new Map(), registered: new Set(), progress: new Map(), seq: 0, failed: new Map(), ev: {}, semReg: new Set(), asked: new Set() };
const LSP_ID = { shell: 'shellscript' }; // ids do Monaco que o LSP chama diferente
const ext = (lang) => LSP_ID[lang] || lang;

// ----- caminhos e URIs -----
// o Monaco usa bs:/<aba> para os modelos das abas; o servidor fala em file:///C:/...; aqui se converte entre os dois
function pathToUri(abs) { const p = abs.replace(/\\/g, '/'); return 'file:///' + p.split('/').map((s, i) => i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)).join('/'); }
function uriToPath(u) { let p = decodeURIComponent(String(u).replace(/^file:\/\/\/?/, '')); if (/^[A-Za-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1); return p.replace(/\//g, '\\'); }
const keyOf = (abs) => abs.replace(/\//g, '\\').toLowerCase();
const absOf = (tab) => tab.project.replace(/[\\/]+$/, '') + '\\' + tab.path.replace(/\//g, '\\');
function relOf(abs, root) { const r = root.replace(/[\\/]+$/, '') + '\\'; return keyOf(abs).startsWith(keyOf(r)) ? abs.slice(r.length).replace(/\\/g, '/') : null; }
const editorTabFor = (abs) => S.tabs.find(t => t.mode === 'editor' && keyOf(absOf(t)) === keyOf(abs));

// ----- ferramentas instaladas -----
async function lsTools(fresh) {
  if (LS.tools && !fresh) return LS.tools;
  if (fresh) LS.failed.clear();
  try { LS.tools = (await api('rpc/tools', { fresh: fresh ? '1' : null })).tools || []; } catch { LS.tools = []; }
  for (const t of LS.tools) if (t.kind === 'lsp' && t.installed) t.langs.forEach(registerProviders);
  return LS.tools;
}
const serverFor = (lang) => (LS.tools || []).find(t => t.kind === 'lsp' && t.installed && t.langs.includes(lang));
const knownFor = (lang) => (LS.tools || []).filter(t => t.kind === 'lsp' && t.langs.includes(lang));

// ----- cliente JSON-RPC (o mesmo transporte serve ao depurador) -----
class RpcClient {
  constructor(tool, root) { this.tool = tool; this.root = root; this.id = 0; this.pending = new Map(); this.handlers = {}; this.alive = false; }
  connect() {
    return new Promise((ok, fail) => {
      const u = new URL('/api/rpc/ws', location.origin); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.searchParams.set('tool', this.tool.id); u.searchParams.set('root', this.root);
      for (const [k, v] of Object.entries(this.params || {})) u.searchParams.set(k, v); // ex.: port do java-debug
      const ws = this.ws = new WebSocket(u); let opened = false;
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.bs) { if (m.bs === 'ready') { opened = true; this.alive = true; ok(m); } else if (m.bs === 'error') { fail(new Error(m.message)); } else if (m.bs === 'exit') { this.alive = false; this.onexit && this.onexit(m.code); } return; }
        this.receive(m);
      };
      ws.onclose = () => { this.alive = false; for (const p of this.pending.values()) p.fail(new Error('conexão fechada')); this.pending.clear(); if (!opened) fail(new Error('não foi possível iniciar ' + this.tool.name)); this.onclose && this.onclose(); };
    });
  }
  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  close() { try { this.ws.close(); } catch {} }
}
class LspClient extends RpcClient {
  // token: cancelamento do Monaco (você continuou digitando, o pedido ficou velho): avisa o servidor ($/cancelRequest)
  // para ele largar o trabalho em vez de calcular uma resposta que ninguém vai usar
  request(method, params, ms = 30000, token) {
    if (token && token.isCancellationRequested) return Promise.reject(new Error('Canceled'));
    const id = ++this.id; this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((ok, fail) => {
      let sub = null;
      const end = () => { clearTimeout(t); sub && sub.dispose(); };
      const t = setTimeout(() => { this.pending.delete(id); end(); fail(new Error(method + ': sem resposta')); }, ms);
      this.pending.set(id, { ok: (v) => { end(); ok(v); }, fail: (e) => { end(); fail(e); } });
      if (token) sub = token.onCancellationRequested(() => { if (!this.pending.delete(id)) return; this.notify('$/cancelRequest', { id }); end(); fail(new Error('Canceled')); });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  receive(m) {
    if (m.id != null && !m.method) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.fail(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.ok(m.result); return; }
    if (m.id != null && m.method) { Promise.resolve().then(() => this.serverRequest(m.method, m.params)).then((result) => this.send({ jsonrpc: '2.0', id: m.id, result: result ?? null }), (e) => this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } })); return; }
    this.serverNotify(m.method, m.params);
  }
  async serverRequest(method, p) {
    switch (method) {
      case 'workspace/configuration': return (p.items || []).map(it => cfgSection(this.tool.id, it.section));
      case 'workspace/workspaceFolders': return [{ uri: pathToUri(this.root), name: this.root.split(/[\\/]/).pop() }];
      case 'workspace/applyEdit': { const n = await applyWorkspaceEdit(p.edit, this); return { applied: n >= 0 }; }
      case 'window/showMessageRequest': toast(p.message); return null;
      case 'window/showDocument': if (p.uri) goTo(p.uri, p.selection, this); return { success: true };
      case 'client/registerCapability': case 'client/unregisterCapability': case 'window/workDoneProgress/create': return null;
      // o servidor terminou de analisar o projeto (ou mudou algo): pede para o editor pedir de novo
      case 'workspace/inlayHint/refresh': LS.ev.hints && LS.ev.hints.fire(); return null;
      case 'workspace/semanticTokens/refresh': LS.ev.tokens && LS.ev.tokens.fire(); return null;
      case 'workspace/codeLens/refresh': case 'workspace/diagnostic/refresh': case 'workspace/foldingRange/refresh': return null;
      default: throw new Error('não suportado: ' + method);
    }
  }
  serverNotify(method, p) {
    if (method === 'textDocument/publishDiagnostics') return diagnostics(this, p);
    if (method === 'window/showMessage' && p.type <= 2) return toast(this.tool.name + ': ' + p.message, p.type === 1 ? 'err' : undefined);
    if (method === '$/progress' && p.value) {
      if (p.value.kind === 'end') {
        LS.progress.delete(this.tool.id + p.token);
        // terminou uma etapa (carregar o projeto, indexar): dicas e cores pedidas antes podem ter vindo vazias
        if (![...LS.progress.keys()].some(k => k.startsWith(this.tool.id))) { LS.ev.hints && LS.ev.hints.fire(); LS.ev.tokens && LS.ev.tokens.fire(); }
      } else LS.progress.set(this.tool.id + p.token, p.value.title || p.value.message || '');
      lsStatus();
    }
  }
}

// configurações mandadas a cada servidor (initializationOptions, workspace/configuration e didChangeConfiguration).
// Busca de símbolos (Shift Shift) incluindo as dependências do projeto: o rust-analyzer só olha o workspace por padrão;
// o gopls e o tsserver já incluem, mas fica explícito (versões antigas/configurações do usuário mudam o padrão)
const CFG = {
  'rust-analyzer': { 'rust-analyzer': { workspace: { symbol: { search: { scope: 'workspace_and_dependencies' } } } } },
  gopls: { gopls: { symbolScope: 'all' } },
  tsserver: { typescript: { preferences: { excludeLibrarySymbolsInNavTo: false } }, javascript: { preferences: { excludeLibrarySymbolsInNavTo: false } } },
};
function cfgSection(id, section) {
  let v = CFG[id] || {};
  for (const k of (section || '').split('.').filter(Boolean)) { v = v && typeof v === 'object' ? v[k] : undefined; }
  return v === undefined ? {} : v;
}
const INIT_OPTS = { 'rust-analyzer': () => CFG['rust-analyzer']['rust-analyzer'], gopls: () => CFG.gopls.gopls, tsserver: () => ({ preferences: { excludeLibrarySymbolsInNavTo: false } }) };

// tipos e modificadores de token semântico do protocolo (o servidor manda os dele na legenda)
const SEM_TYPES = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator'];
const SEM_MODS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'];

// um servidor por (ferramenta, projeto); sobe no primeiro arquivo
async function clientFor(tool, root) {
  const key = tool.id + '|' + keyOf(root);
  // já falhou ao iniciar neste projeto: não tenta de novo a cada aba (só ao reiniciar ou procurar de novo)
  if (LS.failed.has(key)) throw LS.failed.get(key);
  let c = LS.clients.get(key);
  if (c) return c.ready;
  c = new LspClient(tool, root); LS.clients.set(key, c);
  c.ready = (async () => {
    lsStatus();
    await c.connect();
    // jdtls: carrega o plugin de depuração (java-debug), se baixado; sem ele o Java não depura (ver debug.js)
    const jd = tool.id === 'jdtls' ? (await lsTools()).find(t => t.id === 'java-debug' && t.installed) : null;
    c.bundles = jd ? [jd.command] : [];
    // classFileContentsSupport: sem ele o jdtls não aponta para classes do JDK e de jars (Ctrl+clique em System não
    // levaria a lugar nenhum); com ele vêm endereços jdt:// cujo texto (fonte ou descompilado) se pede em java/classFileContents
    const init = await c.request('initialize', {
      ...(tool.id === 'jdtls' ? { initializationOptions: { bundles: c.bundles, extendedClientCapabilities: { classFileContentsSupport: true } } } : INIT_OPTS[tool.id] ? { initializationOptions: INIT_OPTS[tool.id]() } : {}),
      processId: null, clientInfo: { name: 'BlueScreen', version: BS.version || '' }, locale: 'pt-br',
      rootUri: pathToUri(root), rootPath: root, workspaceFolders: [{ uri: pathToUri(root), name: root.split(/[\\/]/).pop() }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true, showMessage: {}, showDocument: { support: true } },
        workspace: { applyEdit: true, configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] }, didChangeWatchedFiles: { dynamicRegistration: false }, didChangeConfiguration: { dynamicRegistration: false }, executeCommand: {}, symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } }, inlayHint: { refreshSupport: true }, semanticTokens: { refreshSupport: true } },
        textDocument: {
          // didChange incremental: ao digitar vai só o trecho que mudou, não o arquivo inteiro
          synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
          inlayHint: { resolveSupport: { properties: [] } },
          semanticTokens: { requests: { full: { delta: true }, range: false }, formats: ['relative'], tokenTypes: SEM_TYPES, tokenModifiers: SEM_MODS, multilineTokenSupport: false, overlappingTokenSupport: false, augmentsSyntaxTokens: true },
          foldingRange: { lineFoldingOnly: true, foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] } }, selectionRange: {}, documentLink: { tooltipSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { contextSupport: true, completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true, resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }, labelDetailsSupport: true } },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
          definition: { linkSupport: true }, declaration: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true },
          references: {}, documentHighlight: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: { isPreferredSupport: true, dataSupport: true, resolveSupport: { properties: ['edit'] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } } },
          formatting: {}, rangeFormatting: {}, rename: { prepareSupport: true },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
        },
      },
    }, 120000);
    c.caps = init.capabilities || {};
    lateProviders(c);
    c.notify('initialized', {});
    // vários servidores (pyright, por exemplo) só terminam de iniciar depois de receber a configuração
    c.notify('workspace/didChangeConfiguration', { settings: CFG[tool.id] || {} });
    builtinOff(tool);
    lsStatus();
    return c;
  })();
  c.onclose = () => { LS.clients.delete(key); for (const [id, d] of LS.docs) if (d.client === c) LS.docs.delete(id); lsStatus(); };
  c.ready.catch((e) => {
    LS.clients.delete(key); LS.failed.set(key, e);
    toast(`${tool.name} não iniciou (${e.message}). Clique no item dele na barra de status para reiniciar ou instalar.`, 'err');
    lsStatus();
  });
  return c.ready;
}

// o Monaco já tem TypeScript, HTML, CSS e JSON por conta própria: com o servidor de verdade ligado, os dele saem
function builtinOff(tool) {
  const off = { completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false, documentFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false, colors: false, foldingRanges: true, selectionRanges: true, links: false, tokens: true };
  try {
    const L = monaco.languages;
    if (tool.id === 'tsserver') { L.typescript.typescriptDefaults.setModeConfiguration(off); L.typescript.javascriptDefaults.setModeConfiguration(off); }
    if (tool.id === 'html') L.html.htmlDefaults.setModeConfiguration(off);
    if (tool.id === 'css') { L.css.cssDefaults.setModeConfiguration(off); L.css.scssDefaults.setModeConfiguration(off); L.css.lessDefaults.setModeConfiguration(off); }
    if (tool.id === 'json') L.json.jsonDefaults.setModeConfiguration(off);
  } catch {}
}

// ----- documentos abertos -----
async function openDoc(tab) {
  if (!tab || tab.mode !== 'editor' || tab.virtual || !tab.model || LS.docs.has(tab.model.id)) return;
  await lsTools();
  const tool = serverFor(tab.lang); if (!tool) { lsStatus(); return; }
  let c; try { c = await clientFor(tool, tab.project); } catch { return; }
  if (tab.model.isDisposed() || LS.docs.has(tab.model.id)) return;
  const uri = pathToUri(absOf(tab));
  // como o servidor quer as mudanças: 0 nenhuma, 1 o texto inteiro, 2 só os trechos (incremental)
  const sync = c.caps.textDocumentSync, kind = typeof sync === 'number' ? sync : sync && sync.change != null ? sync.change : 1;
  const d = { client: c, uri, version: 1, tab, timer: null, kind, changes: [], full: false };
  LS.docs.set(tab.model.id, d);
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: ext(tab.lang), version: 1, text: tab.model.getValue() } });
  d.sub = tab.model.onDidChangeContent((e) => {
    // as mudanças de um evento vêm de baixo para cima no arquivo: aplicadas em ordem, uma não desloca a outra
    if (d.kind === 2 && !e.isFlush) for (const ch of e.changes) d.changes.push({ range: RL(ch.range), rangeLength: ch.rangeLength, text: ch.text });
    else d.full = true;
    clearTimeout(d.timer); d.timer = setTimeout(() => flush(d), 150);
  });
  lsStatus();
}
function flush(d) {
  if (!d.timer) return; clearTimeout(d.timer); d.timer = null;
  if (d.tab.model.isDisposed() || d.kind === 0) return;
  const contentChanges = d.kind === 2 && !d.full ? d.changes : [{ text: d.tab.model.getValue() }];
  d.changes = []; d.full = false;
  if (contentChanges.length) d.client.notify('textDocument/didChange', { textDocument: { uri: d.uri, version: ++d.version }, contentChanges });
}
function closeDoc(tab) {
  const d = tab.model && LS.docs.get(tab.model.id); if (!d) return;
  flush(d); d.sub && d.sub.dispose(); LS.docs.delete(tab.model.id);
  if (d.client.alive) d.client.notify('textDocument/didClose', { textDocument: { uri: d.uri } });
}
// documento do modelo, com as últimas edições já enviadas (antes de qualquer pergunta ao servidor)
function docOf(model) { const d = LS.docs.get(model.id); if (d) { flush(d); return d; } return null; }

// ----- conversões -----
const P = (pos) => ({ line: pos.lineNumber - 1, character: pos.column - 1 });
const R = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const RL = (r) => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
const md = (c) => {
  if (!c) return [];
  if (Array.isArray(c)) return c.flatMap(md);
  if (typeof c === 'string') return [{ value: c }];
  if (c.kind) return [{ value: c.kind === 'markdown' ? c.value : '```\n' + c.value + '\n```' }];
  if (c.language) return [{ value: '```' + c.language + '\n' + c.value + '\n```' }];
  return [];
};
const docText = (d) => d == null ? undefined : typeof d === 'string' ? d : { value: d.value, isTrusted: false };
// modelo do Monaco para uma URI do servidor: a aba aberta, um modelo só para a espiada (referências, definição) ou,
// fora do projeto, o código da biblioteca (client: o servidor que apontou para ela)
async function modelFor(uri, client) {
  if (!/^file:/i.test(uri)) return libModel(uri, client);
  const abs = uriToPath(uri); const tab = editorTabFor(abs);
  if (tab) return tab.model;
  const rel = S.project ? relOf(abs, S.project.path) : null;
  if (rel == null) return libModel(uri, client, abs);
  const mu = monaco.Uri.parse(pathToUri(abs));
  let m = monaco.editor.getModel(mu);
  if (!m) try { const f = await api('file', { project: S.project.path, file: rel }); if (!f.binary && !f.tooBig) m = monaco.editor.createModel(f.content, langOf(abs), mu); } catch {}
  return m;
}
async function locations(res, client) {
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  const out = [];
  for (const l of list.slice(0, 200)) {
    const uri = l.targetUri || l.uri; const range = l.targetSelectionRange || l.range; if (!uri || !range) continue;
    const m = await modelFor(uri, client); if (m) out.push({ uri: m.uri, range: R(range) });
  }
  return out;
}

// ----- código de fora do projeto (Ctrl+clique em System, String, Vec, fmt.Println, printf, Console...) -----
// O servidor aponta para um arquivo de biblioteca no disco (std do Rust, GOROOT, typeshed do pyright, headers do
// clangd, lib.d.ts, fontes descompiladas pelo Kotlin LS) ou para um endereço só dele, cujo texto ele mesmo entrega:
// jdt:// (jdtls: a fonte anexada ou a classe descompilada pelo Fernflower) e csharp:/metadata (csharp-ls: o assembly
// descompilado pelo ILSpy). Abre numa aba só de leitura ligada ao mesmo servidor: lá dentro o Ctrl+clique continua.
const LIB_TEXT = {
  jdt: (c, uri) => c.request('java/classFileContents', { uri }, 30000),
  csharp: async (c, uri) => { const r = await c.request('csharp/metadata', { textDocument: { uri } }, 30000); return r && r.source; },
  kls: (c, uri) => c.request('kotlin/jarClassContents', { textDocument: { uri } }, 30000),
};
async function libModel(uri, client, abs) {
  const mu = monaco.Uri.parse('bs-lib:/' + encodeURIComponent(uri));
  let m = monaco.editor.getModel(mu); if (m) return m;
  let text = null;
  try {
    if (abs) { const dir = abs.replace(/[\\/][^\\/]*$/, ''); const f = await api('file', { project: dir, file: abs.slice(dir.length + 1) }); if (!f.binary && !f.tooBig) text = f.content; }
    else { const get = LIB_TEXT[uri.split(':')[0].toLowerCase()]; if (get && client && client.alive) text = await get(client, uri); }
  } catch {}
  if (typeof text !== 'string' || !text) return null;
  // headers sem extensão (<vector>, <iostream>) e endereços do servidor: a linguagem é a do servidor
  const byName = abs ? langOf(abs) : 'plaintext';
  const lang = byName !== 'plaintext' || !client ? byName : client.tool.langs[0];
  m = monaco.editor.getModel(mu) || monaco.editor.createModel(text, lang, mu);
  m._lib = { uri, client, abs };
  return m;
}
// nome na aba e dica: "System.class" · "JDK java.base · java.lang.System"
function libLabel(L) {
  const u = decodeURIComponent(L.uri);
  let m = u.match(/^jdt:\/\/contents\/([^/]+)\/([^/]+)\/([^?]+)/);
  if (m) return { name: m[3], title: `${/^java\./.test(m[1]) || m[1] === 'rt.jar' ? 'JDK ' : ''}${m[1]} · ${m[2]}.${m[3].replace(/\.class$/, '')}` };
  m = u.match(/^csharp:\/?\/?metadata\/.*?assemblies\/([^/]+)\/symbols\/([^?]+)/);
  if (m) return { name: m[2].split('.').slice(-2).join('.'), title: `${m[1]} · ${m[2].replace(/\.cs$/, '')}` };
  const p = L.abs || u.replace(/^[a-z]+:/i, '').replace(/[?#].*$/, '');
  return { name: p.split(/[\\/!]/).filter(Boolean).pop() || p, title: p };
}
function openLibrary(m, line, col) {
  const L = m._lib; const key = 'lib:' + L.uri;
  let tab = S.tabs.find(t => t.key === key);
  if (!tab) {
    const lb = libLabel(L);
    tab = { key, path: lb.name, title: lb.title + (L.abs ? '' : ' (descompilado/fonte do servidor)'), mode: 'editor', virtual: true, lib: true, editable: false, project: S.project ? S.project.path : '', lang: m.getLanguageId(), model: m, saved: m.getValue() };
    m._tab = tab; S.tabs.push(tab);
    // o servidor passa a conhecer o documento: hover, Ctrl+clique e usos funcionam dentro da biblioteca também
    const c = L.client;
    if (c && c.alive && !LS.docs.has(m.id)) {
      LS.docs.set(m.id, { client: c, uri: L.uri, version: 1, tab, timer: null, kind: 0, changes: [], full: false });
      c.notify('textDocument/didOpen', { textDocument: { uri: L.uri, languageId: ext(tab.lang), version: 1, text: m.getValue() } });
    }
  }
  activate(tab);
  if (line) revealAt(editor, line, col || 1);
  return tab;
}

// ----- provedores do Monaco (um registro por linguagem, valem para todo servidor daquela linguagem) -----
const CIK = () => { const K = monaco.languages.CompletionItemKind; return [K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter]; };
const SK = () => { const K = monaco.languages.SymbolKind; return [K.File, K.File, K.Module, K.Namespace, K.Package, K.Class, K.Method, K.Property, K.Field, K.Constructor, K.Enum, K.Interface, K.Function, K.Variable, K.Constant, K.String, K.Number, K.Boolean, K.Array, K.Object, K.Key, K.Null, K.EnumMember, K.Struct, K.Event, K.Operator, K.TypeParameter]; };
function registerProviders(lang) {
  if (LS.registered.has(lang) || !window.monaco) return; LS.registered.add(lang);
  const L = monaco.languages;
  // -32801 (o conteúdo mudou) e -32802 (o servidor cancelou, ocupado analisando): o protocolo pede para tentar de novo
  const ask = async (model, method, params, cap, token) => {
    for (let n = 0; ; n++) {
      const d = docOf(model); if (!d || (cap && !d.client.caps[cap])) return undefined;
      try { return await d.client.request(method, { textDocument: { uri: d.uri }, ...params }, 30000, token); }
      catch (e) { if (n >= 4 || (e.code !== -32801 && e.code !== -32802) || (token && token.isCancellationRequested)) return undefined; await new Promise(r => setTimeout(r, 300 * (n + 1))); }
    }
  };
  L.registerHoverProvider(lang, { provideHover: async (model, pos, token) => { const r = await ask(model, 'textDocument/hover', { position: P(pos) }, 'hoverProvider', token); return r && r.contents ? { contents: md(r.contents), range: r.range ? R(r.range) : undefined } : null; } });
  for (const [prov, method, cap] of [['registerDefinitionProvider', 'textDocument/definition', 'definitionProvider'], ['registerDeclarationProvider', 'textDocument/declaration', 'declarationProvider'], ['registerTypeDefinitionProvider', 'textDocument/typeDefinition', 'typeDefinitionProvider'], ['registerImplementationProvider', 'textDocument/implementation', 'implementationProvider']]) {
    L[prov](lang, { [prov.replace('register', 'provide').replace('Provider', '')]: async (model, pos, token) => locations(await ask(model, method, { position: P(pos) }, cap, token), docOf(model)?.client) });
  }
  L.registerReferenceProvider(lang, { provideReferences: async (model, pos, ctx) => locations(await ask(model, 'textDocument/references', { position: P(pos), context: { includeDeclaration: ctx.includeDeclaration } }, 'referencesProvider'), docOf(model)?.client) });
  L.registerDocumentHighlightProvider(lang, { provideDocumentHighlights: async (model, pos, token) => ((await ask(model, 'textDocument/documentHighlight', { position: P(pos) }, 'documentHighlightProvider', token)) || []).map(h => ({ range: R(h.range), kind: (h.kind || 1) - 1 })) });
  L.registerDocumentSymbolProvider(lang, { provideDocumentSymbols: async (model) => {
    const r = await ask(model, 'textDocument/documentSymbol', {}, 'documentSymbolProvider'); if (!r) return [];
    const sk = SK(); const conv = (s) => s.location ? { name: s.name, detail: '', kind: sk[s.kind] ?? sk[13], tags: [], range: R(s.location.range), selectionRange: R(s.location.range) } : { name: s.name, detail: s.detail || '', kind: sk[s.kind] ?? sk[13], tags: [], range: R(s.range), selectionRange: R(s.selectionRange), children: (s.children || []).map(conv) };
    return r.map(conv);
  } });
  L.registerCompletionItemProvider(lang, {
    triggerCharacters: ['.', ':', '<', '"', "'", '/', '@', '>', '#', '$', '-'],
    provideCompletionItems: async (model, pos, ctx, token) => {
      const r = await ask(model, 'textDocument/completion', { position: P(pos), context: ctx.triggerCharacter ? { triggerKind: 2, triggerCharacter: ctx.triggerCharacter } : { triggerKind: 1 } }, 'completionProvider', token);
      if (!r) return { suggestions: [] };
      const items = Array.isArray(r) ? r : r.items || []; const w = model.getWordUntilPosition(pos);
      const def = new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn); const k = CIK();
      return { incomplete: !!r.isIncomplete, suggestions: items.slice(0, 1000).map(it => {
        const te = it.textEdit; const range = te ? (te.range ? R(te.range) : { insert: R(te.insert), replace: R(te.replace) }) : def;
        return { label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label, kind: k[it.kind] ?? k[1], detail: it.detail, documentation: docText(it.documentation), sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
          insertText: te ? te.newText : (it.insertText || it.label), insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, range,
          additionalTextEdits: (it.additionalTextEdits || []).map(e => ({ range: R(e.range), text: e.newText })), tags: it.deprecated ? [1] : undefined, _lsp: it };
      }) };
    },
    resolveCompletionItem: async (item) => {
      const d = [...LS.docs.values()].find(x => x.client.caps.completionProvider && x.client.caps.completionProvider.resolveProvider); if (!d || !item._lsp) return item;
      try { const r = await d.client.request('completionItem/resolve', item._lsp, 4000); if (r) { item.documentation = docText(r.documentation) || item.documentation; item.detail = r.detail || item.detail; if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(e => ({ range: R(e.range), text: e.newText })); } } catch {}
      return item;
    },
  });
  L.registerSignatureHelpProvider(lang, {
    signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [')'],
    provideSignatureHelp: async (model, pos, token) => {
      const r = await ask(model, 'textDocument/signatureHelp', { position: P(pos) }, 'signatureHelpProvider', token); if (!r || !r.signatures || !r.signatures.length) return null;
      return { value: { activeSignature: r.activeSignature || 0, activeParameter: r.activeParameter || 0, signatures: r.signatures.map(s => ({ label: s.label, documentation: docText(s.documentation), parameters: (s.parameters || []).map(p => ({ label: p.label, documentation: docText(p.documentation) })), activeParameter: s.activeParameter })) }, dispose() {} };
    },
  });
  // dicas no meio do código (tipos inferidos, nomes dos parâmetros, encadeamentos): o forte do rust-analyzer
  LS.ev.hints = LS.ev.hints || new monaco.Emitter();
  L.registerInlayHintsProvider(lang, {
    onDidChangeInlayHints: LS.ev.hints.event,
    provideInlayHints: async (model, range, token) => {
      const r = await ask(model, 'textDocument/inlayHint', { range: RL(range) }, 'inlayHintProvider', token);
      const tip = (t) => t == null ? undefined : typeof t === 'string' ? t : { value: t.value };
      return { hints: (r || []).map(h => ({ position: { lineNumber: h.position.line + 1, column: h.position.character + 1 }, label: typeof h.label === 'string' ? h.label : h.label.map(x => ({ label: x.value, tooltip: tip(x.tooltip) })), kind: h.kind, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight, tooltip: tip(h.tooltip) })), dispose() {} };
    },
  });
  // dobras do servidor (regiões, imports, comentários) e expandir/encolher seleção pela estrutura do código (Shift+Alt+→/←)
  // sem resposta = null (lista vazia desligaria as dobras por indentação do próprio Monaco)
  L.registerFoldingRangeProvider(lang, { provideFoldingRanges: async (model, ctx, token) => { const r = await ask(model, 'textDocument/foldingRange', {}, 'foldingRangeProvider', token); return r ? r.filter(f => f.endLine > f.startLine).map(f => ({ start: f.startLine + 1, end: f.endLine + 1, kind: f.kind ? new L.FoldingRangeKind(f.kind) : undefined })) : null; } });
  L.registerSelectionRangeProvider(lang, { provideSelectionRanges: async (model, positions, token) => {
    const r = await ask(model, 'textDocument/selectionRange', { positions: positions.map(P) }, 'selectionRangeProvider', token);
    return r ? r.map(s => { const out = []; for (let x = s; x; x = x.parent) out.push({ range: R(x.range) }); return out; }) : undefined;
  } });
  L.registerLinkProvider(lang, { provideLinks: async (model, token) => ({ links: ((await ask(model, 'textDocument/documentLink', {}, 'documentLinkProvider', token)) || []).filter(l => l.target).map(l => ({ range: R(l.range), url: l.target, tooltip: l.tooltip })) }) });
  L.registerDocumentFormattingEditProvider(lang, { provideDocumentFormattingEdits: async (model, opt) => ((await ask(model, 'textDocument/formatting', { options: { tabSize: opt.tabSize, insertSpaces: opt.insertSpaces } }, 'documentFormattingProvider')) || []).map(e => ({ range: R(e.range), text: e.newText })) });
  L.registerDocumentRangeFormattingEditProvider(lang, { provideDocumentRangeFormattingEdits: async (model, range, opt) => ((await ask(model, 'textDocument/rangeFormatting', { range: RL(range), options: { tabSize: opt.tabSize, insertSpaces: opt.insertSpaces } }, 'documentRangeFormattingProvider')) || []).map(e => ({ range: R(e.range), text: e.newText })) });
  L.registerRenameProvider(lang, {
    resolveRenameLocation: async (model, pos) => {
      const d = docOf(model); if (!d) return { range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1), text: '', rejectReason: 'Sem servidor de linguagem para renomear aqui' };
      const pr = d.client.caps.renameProvider;
      if (pr && pr.prepareProvider) {
        try { const r = await d.client.request('textDocument/prepareRename', { textDocument: { uri: d.uri }, position: P(pos) }); if (!r) return { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: '', rejectReason: 'Isto não pode ser renomeado' }; if (r.range) return { range: R(r.range), text: r.placeholder || model.getValueInRange(R(r.range)) }; if (r.start) return { range: R(r), text: model.getValueInRange(R(r)) }; } catch (e) { return { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: '', rejectReason: e.message }; }
      }
      const w = model.getWordAtPosition(pos); if (!w) return { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: '', rejectReason: 'Nada para renomear aqui' };
      return { range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn), text: w.word };
    },
    // o Monaco só sabe editar o arquivo aberto; os outros arquivos o BlueScreen altera e salva sozinho
    provideRenameEdits: async (model, pos, newName) => {
      const d = docOf(model); if (!d) return { edits: [], rejectReason: 'Sem servidor de linguagem' };
      let we; try { we = await d.client.request('textDocument/rename', { textDocument: { uri: d.uri }, position: P(pos), newName }); } catch (e) { return { edits: [], rejectReason: e.message }; }
      if (!we) return { edits: [], rejectReason: 'O servidor não encontrou o que renomear' };
      const n = await applyWorkspaceEdit(we, d.client, model);
      const own = editsFor(we).find(x => keyOf(uriToPath(x.uri)) === keyOf(absOf(d.tab)));
      if (n > 0) toast(`Renomeado para ${newName} em ${n + (own ? 1 : 0)} arquivos`, 'ok');
      return { edits: (own ? own.edits : []).map(e => ({ resource: model.uri, versionId: undefined, textEdit: { range: R(e.range), text: e.newText } })) };
    },
  });
  L.registerCodeActionProvider(lang, {
    provideCodeActions: async (model, range, ctx) => {
      const d = docOf(model); if (!d || !d.client.caps.codeActionProvider) return { actions: [], dispose() {} };
      const diags = (d.diags || []).filter(x => ctx.markers.some(m => m.startLineNumber === x.range.start.line + 1 && m.message === x.message));
      let r; try { r = await d.client.request('textDocument/codeAction', { textDocument: { uri: d.uri }, range: RL(range), context: { diagnostics: diags, only: ctx.only ? [ctx.only] : undefined, triggerKind: ctx.trigger === 1 ? 1 : 2 } }); } catch { r = null; }
      const actions = (r || []).map(a => ({ title: a.title, kind: a.kind || (a.command && !a.edit ? 'quickfix' : 'refactor'), isPreferred: a.isPreferred, diagnostics: a.diagnostics ? ctx.markers.filter(m => a.diagnostics.some(x => x.message === m.message)) : undefined, disabled: a.disabled && a.disabled.reason, command: { id: 'bs.lsp.codeAction', title: a.title, arguments: [d, a] } }));
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] });
}
// provedores que dependem do que o servidor declarou ao iniciar
function lateProviders(c) {
  const st = c.caps.semanticTokensProvider;
  if (!st || !st.legend || !(st.full || st.range)) return;
  LS.ev.tokens = LS.ev.tokens || new monaco.Emitter();
  // cores pelo significado (função, tipo, macro, parâmetro, variável mutável...). A legenda vai com prefixo "s-" para
  // as regras do tema não se confundirem com os tokens da coloração por sintaxe; o que o tema não colore fica como estava
  const legend = { tokenTypes: st.legend.tokenTypes.map(x => 's-' + x), tokenModifiers: st.legend.tokenModifiers };
  const delta = !!(st.full && st.full.delta);
  for (const lang of c.tool.langs) {
    if (LS.semReg.has(lang)) continue; LS.semReg.add(lang);
    monaco.languages.registerDocumentSemanticTokensProvider(lang, {
      getLegend: () => legend, onDidChange: LS.ev.tokens.event,
      provideDocumentSemanticTokens: async (model, lastId, token) => {
        const d = docOf(model); if (!d || d.client !== c) return null;
        try {
          // com delta, só vêm as diferenças desde a última resposta
          const r = delta && lastId ? await c.request('textDocument/semanticTokens/full/delta', { textDocument: { uri: d.uri }, previousResultId: lastId }, 30000, token)
            : await c.request('textDocument/semanticTokens/full', { textDocument: { uri: d.uri } }, 30000, token);
          if (!r) return null;
          if (r.edits) return { resultId: r.resultId, edits: r.edits.map(e => ({ start: e.start, deleteCount: e.deleteCount, data: e.data ? new Uint32Array(e.data) : undefined })) };
          return { resultId: r.resultId, data: new Uint32Array(r.data || []) };
        } catch { return null; }
      },
      releaseDocumentSemanticTokens() {},
    });
  }
}

// ação escolhida: resolve (se o servidor pedir), aplica a edição e roda o comando
async function runCodeAction(d, a) {
  try {
    if (a.command && typeof a.command === 'string') return void await d.client.request('workspace/executeCommand', { command: a.command, arguments: a.arguments });
    if (!a.edit && !a.command && d.client.caps.codeActionProvider && d.client.caps.codeActionProvider.resolveProvider) a = await d.client.request('codeAction/resolve', a);
    if (a.edit) await applyWorkspaceEdit(a.edit, d.client);
    if (a.command) await d.client.request('workspace/executeCommand', { command: a.command.command, arguments: a.command.arguments });
  } catch (e) { toast(a.title + ': ' + e.message, 'err'); }
}

// ----- edições em vários arquivos (renomear, refatorar, organizar imports) -----
function editsFor(we) {
  const out = [];
  if (we.documentChanges) for (const c of we.documentChanges) { if (c.textDocument) out.push({ uri: c.textDocument.uri, edits: c.edits }); else if (c.kind) out.push({ op: c }); }
  else if (we.changes) for (const [uri, edits] of Object.entries(we.changes)) out.push({ uri, edits });
  return out;
}
// aplica a edição: abas abertas mudam no editor (ficam por salvar); os outros arquivos são alterados e salvos.
// skipModel: o arquivo que o próprio Monaco vai editar (renomear). Devolve quantos arquivos fora dele mudaram.
async function applyWorkspaceEdit(we, client, skipModel) {
  let n = 0; const disk = [];
  for (const x of editsFor(we)) {
    if (x.op) { toast('Operação de arquivo do servidor ignorada: ' + x.op.kind); continue; }
    const abs = uriToPath(x.uri); const tab = editorTabFor(abs);
    const edits = x.edits.map(e => ({ range: R(e.range), text: e.newText, forceMoveMarkers: true }));
    if (tab) { if (skipModel && tab.model === skipModel) continue; tab.model.pushEditOperations([], edits, () => null); n++; continue; }
    const rel = S.project && relOf(abs, S.project.path); if (rel == null) continue;
    try {
      const f = await api('file', { project: S.project.path, file: rel }); if (f.binary || f.tooBig) continue;
      const tmp = monaco.editor.createModel(f.content); tmp.applyEdits(edits); const text = tmp.getValue(); tmp.dispose();
      await api('file', { project: S.project.path, file: rel, encoding: f.encoding !== 'utf-8' ? f.encoding : null, bom: f.bom ? 1 : null }, { method: 'PUT', body: text });
      const peek = monaco.editor.getModel(monaco.Uri.parse(pathToUri(abs))); if (peek) peek.setValue(text);
      disk.push({ uri: x.uri, type: 2 }); n++;
    } catch (e) { toast('Não foi possível alterar ' + rel + ': ' + e.message, 'err'); }
  }
  if (disk.length) { client && client.notify('workspace/didChangeWatchedFiles', { changes: disk }); refreshProject(); }
  return n;
}

// ----- erros e avisos do servidor -----
function diagnostics(c, p) {
  const abs = uriToPath(p.uri); const tab = editorTabFor(abs);
  const d = tab && LS.docs.get(tab.model.id); if (d) d.diags = p.diagnostics;
  const model = tab ? tab.model : monaco.editor.getModel(monaco.Uri.parse(pathToUri(abs))); if (!model) return;
  const sev = monaco.MarkerSeverity; const SV = [sev.Error, sev.Error, sev.Warning, sev.Info, sev.Hint];
  monaco.editor.setModelMarkers(model, 'lsp:' + c.tool.id, p.diagnostics.map(x => ({ ...R(x.range), message: x.message, severity: SV[x.severity || 1], source: x.source || c.tool.name, code: x.code != null ? String(typeof x.code === 'object' ? x.code.value : x.code) : undefined, tags: x.tags })));
  lsStatus();
}

// ----- ir para um arquivo (definição em outro arquivo, "abrir" das espiadas) -----
// fora do projeto (biblioteca, JDK): aba só de leitura, sem trocar de projeto
async function goTo(uri, range, client) {
  const line = range ? (range.startLineNumber || (range.start && range.start.line + 1) || 1) : 1;
  const col = range ? (range.startColumn || (range.start && range.start.character + 1) || 1) : 1;
  const rel = /^file:/i.test(uri) && S.project ? relOf(uriToPath(uri), S.project.path) : null;
  if (rel != null) return openFile(rel, 'editor', line);
  const m = await modelFor(uri, client);
  if (m && m._lib) openLibrary(m, line, col); else toast('Não foi possível abrir ' + decodeURIComponent(uri));
}

// ----- status bar: servidor do arquivo aberto -----
let stEl = null;
// linguagens com análise embutida (lint ao vivo do núcleo + html.js): sem servidor não é "sem análise" nem pede instalar
const BUILTIN = { html: 'HTML/JSP embutido' };
function lsStatus() {
  if (!stEl) return;
  const t = S.active; const lang = t && t.mode === 'editor' ? t.lang : null;
  const known = lang ? knownFor(lang) : [];
  if (!lang || !known.length) { stEl.hidden = true; return; }
  stEl.hidden = false;
  const tool = serverFor(lang);
  if (!tool && BUILTIN[lang]) { stEl.innerHTML = `<span class="lsp-dot ok"></span>${esc(BUILTIN[lang])}`; stEl.title = `${BUILTIN[lang]}: erros, autocompletar e navegação embutidos, sem instalar nada.\nClique para opções`; return; }
  if (!tool) {
    // instalado, mas sem o que ele precisa para rodar (o jdtls pede um JDK mais novo que os do PC): diz o quê
    const blocked = known.find(x => x.sdk && x.needs);
    if (blocked) {
      stEl.innerHTML = `<span class="lsp-dot err"></span>sem análise · falta ${esc(bs.sdk ? bs.sdk.name(blocked.sdk) : blocked.sdk)}${blocked.sdk_min ? ' ' + blocked.sdk_min + '+' : ''}`;
      stEl.title = `${blocked.name}: ${blocked.needs}.\nSem ele não há autocompletar, erros nem navegação de ${lang}.\nClique para baixar pela IDE (não muda o JDK do projeto).`;
      return;
    }
    stEl.innerHTML = '<span class="lsp-dot off"></span>sem análise'; stEl.title = `Nenhum servidor de linguagem para ${lang}. Clique para instalar.`; return;
  }
  const c = LS.clients.get(tool.id + '|' + keyOf(t.project));
  const busy = [...LS.progress.keys()].some(k => k.startsWith(tool.id));
  const errs = t.model ? monaco.editor.getModelMarkers({ resource: t.model.uri }).filter(m => m.owner.startsWith('lsp:') && m.severity === monaco.MarkerSeverity.Error).length : 0;
  const failed = LS.failed.get(tool.id + '|' + keyOf(t.project));
  const state = failed ? 'não iniciou' : !c ? 'parado' : !c.alive ? 'iniciando' : busy ? 'analisando' : 'pronto';
  stEl.innerHTML = `<span class="lsp-dot ${failed ? 'off' : state === 'pronto' ? (errs ? 'err' : 'ok') : 'busy'}"></span>${esc(tool.name.replace(/ \(.*\)$/, ''))}`;
  stEl.title = `${tool.name}: ${state}${failed ? ' (' + failed.message + ')' : ''}${busy ? ' (' + [...LS.progress.values()].filter(Boolean).join(', ') + ')' : ''}${errs ? `\n${errs} erro(s) neste arquivo` : ''}\nClique para opções`;
}
function lsMenu(e) {
  const t = S.active; if (!t) return; const lang = t.lang; const tool = serverFor(lang);
  // sem servidor: vai direto para o aviso de instalação, em vez de um menu no canto
  const absent = knownFor(lang).filter(x => !x.installed);
  if (!tool && absent.length && !BUILTIN[lang]) return lsNotify(absent.map(x => ({ tool: x, langs: [lang] })), { title: 'Análise de ' + (LS_MAIN[lang] || lang) + ' não instalada' });
  const items = [];
  if (tool) {
    items.push({ label: 'Reiniciar ' + tool.name, icon: I.refresh, action: () => restart(tool, t.project) });
    items.push({ label: 'Renomear símbolo', k: 'Shift+F6', icon: I.edit, action: () => editor.trigger('bs', 'editor.action.rename') });
    items.push({ label: 'Ações rápidas e refatorações', k: 'Alt+Enter', icon: I.edit, action: () => editor.trigger('bs', 'editor.action.quickFix') });
    items.push({ label: 'Formatar arquivo', k: 'Shift+Alt+F', icon: I.edit, action: () => editor.trigger('bs', 'editor.action.formatDocument') });
  }
  const missing = knownFor(lang).filter(x => !x.installed);
  if (missing.length) { if (items.length) items.push('-'); missing.forEach(x => items.push({ label: 'Instalar ' + x.name + (BUILTIN[lang] ? ' (opcional, análise mais completa)' : ''), icon: I.pkg || I.edit, action: () => install(x) })); }
  items.push('-', { label: 'Procurar servidores de novo', icon: I.refresh, action: async () => { await lsTools(true); const n = LS.tools.filter(x => x.installed).length; toast(`${n} ferramentas encontradas`); S.tabs.filter(x => x.mode === 'editor').forEach(openDoc); lsStatus(); } });
  showMenu(e, items, 'Análise de ' + lang);
}
// instalar pela barra de status: mesmo cartão de instalação do aviso do projeto
function install(tool) { lsNotify([{ tool, langs: tool.langs }], { title: 'Instalar ' + tool.name, start: true }); }

// ----- aviso: o projeto usa linguagens sem analisador instalado -----
// Ao abrir o projeto, olha as extensões dos arquivos (o índice que a busca já monta) e os arquivos de projeto
// (Cargo.toml, go.mod...). Para cada linguagem principal sem servidor de linguagem, mostra um aviso com o que ele faz
// e um botão que instala ali mesmo (rpc/install no núcleo: download com progresso ou o gerenciador da linguagem,
// sem console). Terminado, a análise liga sozinha nas abas abertas.
const LS_MAIN = { typescript: 'TypeScript', javascript: 'JavaScript', rust: 'Rust', go: 'Go', python: 'Python', c: 'C', cpp: 'C++', java: 'Java', csharp: 'C#', kotlin: 'Kotlin', php: 'PHP', ruby: 'Ruby', lua: 'Lua', dart: 'Dart', zig: 'Zig' };
const LS_MARKERS = { 'tsconfig.json': 'typescript', 'jsconfig.json': 'javascript', 'cargo.toml': 'rust', 'go.mod': 'go', 'pyproject.toml': 'python', 'requirements.txt': 'python', 'setup.py': 'python', 'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'kotlin', 'composer.json': 'php', 'gemfile': 'ruby', 'build.zig': 'zig', 'pubspec.yaml': 'dart', 'cmakelists.txt': 'cpp' };
async function lsCheckProject() {
  const proj = S.project && S.project.path; if (!proj) return;
  if (LS.asked.has(proj) || store.get('lspAsk:' + proj, true) === false) return;
  const [idx] = await Promise.all([typeof seIndex === 'function' ? seIndex() : [], lsTools()]);
  if (!S.project || S.project.path !== proj || !Array.isArray(idx)) return;
  const count = {};
  for (const f of idx) {
    const name = f.p.split('/').pop().toLowerCase();
    if (LS_MARKERS[name] && !f.p.includes('/')) count[LS_MARKERS[name]] = (count[LS_MARKERS[name]] || 0) + 100;
    const l = langOf(f.p); if (LS_MAIN[l]) count[l] = (count[l] || 0) + 1;
  }
  // C e C++ usam o mesmo servidor (clangd)
  if (count.c && count.cpp) { count.cpp += count.c; delete count.c; }
  const missing = [];
  for (const [lang, n] of Object.entries(count)) {
    if (n < 3 || serverFor(lang)) continue; // poucos arquivos (um script solto) não justificam o aviso
    if (bs.lint && (bs.lint.universal || []).includes(lang)) continue; // plugin com lint embutido (Linter Universal): nada a baixar
    const known = knownFor(lang); if (!known.length) continue;
    const tool = known.find(t => t.auto) || known[0];
    const same = missing.find(m => m.tool.id === tool.id);
    if (same) same.langs.push(lang); else missing.push({ tool, langs: [lang] });
  }
  LS.asked.add(proj);
  if (missing.length) lsNotify(missing, { proj });
}
// aviso em modal no meio da tela (fica até você escolher); items: [{ tool, langs }]
// Esc ou clique fora fecham, menos enquanto algo instala (o andamento só aparece aqui)
function lsNotify(items, o = {}) {
  let host = document.getElementById('bsNotifs');
  if (!host) {
    host = document.createElement('div'); host.id = 'bsNotifs'; host.className = 'scrim'; document.body.appendChild(host);
    const busy = () => !!host.querySelector('.nt-row[data-st="running"]');
    const dismiss = () => { if (!busy()) host.querySelectorAll('.bs-notif').forEach(n => n._close && n._close()); };
    host.addEventListener('mousedown', (e) => { if (e.target === host) dismiss(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && host.isConnected && host.children.length) { e.stopPropagation(); dismiss(); } }, true);
  }
  host.classList.remove('out');
  const key = items.map(x => x.tool.id).join(',');
  host.querySelector(`[data-key="${key}"]`)?.remove();
  const names = [...new Set(items.flatMap(x => x.langs.map(l => LS_MAIN[l] || l)))];
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1] : names[0];
  const el = document.createElement('div'); el.className = 'dlg-box bs-notif warn'; el.dataset.key = key;
  el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="nt-hd"><span class="nt-ic">!</span><b>${esc(o.title || 'Análise de código não instalada')}</b><button class="icon-btn nt-x" title="Fechar">×</button></div>`
    + (o.start ? '' : `<p class="nt-tx">Instale para ter erros, autocompletar e navegação em <b>${esc(list)}</b>.</p>`)
    + items.map((x, i) => `<div class="nt-row" data-i="${i}"><div class="nt-nm"><b>${esc(x.tool.name)}</b><small>${esc(lsHow(x.tool))}</small></div>`
      + `${x.tool.auto || lsSdk(x.tool) ? '<button class="chip primary" data-a="go">Instalar</button>' : `<button class="chip" data-a="copy" title="${esc(x.tool.install)}">Copiar comando</button><button class="chip" data-a="recheck" title="Procura de novo (o PATH atual do Windows, sem reiniciar a IDE)">Já instalei</button>`}`
      + `${lsSdk(x.tool) ? `<a class="nt-alt" data-a="sdk" title="Escolher a versão e o fornecedor">outra versão…</a>` : ''}`
      + `<div class="nt-prog" hidden><div class="nt-bar"><i></i></div><span class="nt-step"></span><a data-a="log">log</a></div><pre class="nt-log" hidden></pre></div>`).join('')
    + (o.start ? '' : `<div class="nt-ft">${items.filter(x => x.tool.auto || lsSdk(x.tool)).length > 1 ? '<button class="chip primary" data-a="all">Instalar todos</button>' : ''}<span class="spacer"></span><button class="chip" data-a="later">Agora não</button>${o.proj ? '<button class="chip" data-a="never">Não perguntar neste projeto</button>' : ''}</div>`);
  host.appendChild(el);
  const close = () => {
    const last = host.querySelectorAll('.bs-notif:not(.out)').length <= 1;
    el.classList.add('out'); if (last) host.classList.add('out');
    setTimeout(() => { el.remove(); if (!host.children.length) host.remove(); }, 200);
  };
  el._close = close;
  (el.querySelector('[data-a="go"]') || el.querySelector('.nt-x')).focus();
  el.querySelector('.nt-x').onclick = close;
  el.querySelector('[data-a="later"]')?.addEventListener('click', close);
  el.querySelector('[data-a="never"]')?.addEventListener('click', () => { store.set('lspAsk:' + o.proj, false); close(); toast('Não vou mais perguntar neste projeto. Dá para instalar pelo item de análise na barra de status.'); });
  const rows = [...el.querySelectorAll('.nt-row')];
  const run = (i) => lsInstallRow(items[i].tool, rows[i], () => { if (items.every((x, k) => rows[k].dataset.st === 'done' || !(x.tool.auto || lsSdk(x.tool)))) setTimeout(close, 3500); }, (t) => { items[i].tool = t; });
  rows.forEach((r, i) => {
    r.querySelector('[data-a="go"]')?.addEventListener('click', () => run(i));
    r.querySelector('[data-a="sdk"]')?.addEventListener('click', () => bs.sdk.open(lsSdk(items[i].tool)));
    r.querySelector('[data-a="copy"]')?.addEventListener('click', () => { copyText(items[i].tool.install); toast('Comando copiado'); });
    r.querySelector('[data-a="recheck"]')?.addEventListener('click', async () => {
      await lsTools(true);
      const t = LS.tools.find(t => t.id === items[i].tool.id);
      if (t && t.installed) { r.dataset.st = 'done'; S.tabs.filter(x => x.mode === 'editor').forEach(openDoc); lsStatus(); toast(`${t.name} encontrado: análise ligada`, 'ok'); if (items.every((x, k) => rows[k].dataset.st === 'done')) close(); return; }
      // ainda não: mostra o motivo (ex.: falta o Java 21) e, se agora der, o botão de instalar
      if (t) items[i].tool = t;
      r.querySelector('.nt-nm small').textContent = t ? (t.needs || 'ainda não encontrado no PATH') : 'ainda não encontrado';
      toast('Ainda não encontrei ' + items[i].tool.name);
    });
    r.querySelector('[data-a="log"]').onclick = () => { const l = r.querySelector('.nt-log'); l.hidden = !l.hidden; };
  });
  el.querySelector('[data-a="all"]')?.addEventListener('click', () => rows.forEach((r, i) => { if ((items[i].tool.auto || lsSdk(items[i].tool)) && !r.dataset.st) run(i); }));
  if (o.start && (items[0].tool.auto || lsSdk(items[0].tool))) run(0);
}
// o SDK que a IDE baixa para conseguir instalar a ferramenta (Node.js para o npm, Java 25 para o jdtls...)
const lsSdk = (tool) => (!tool.installed && tool.sdk && bs.sdk ? tool.sdk : null);
function lsHow(tool) {
  if (tool.auto) return 'instala com ' + tool.auto;
  const k = lsSdk(tool);
  if (k) return `baixa ${bs.sdk.name(k)}${tool.sdk_min ? ' ' + tool.sdk_min + '+' : ''} e instala` + (tool.needs ? ` (${tool.needs})` : '');
  return tool.needs || tool.install;
}
// instala uma ferramenta mostrando o andamento na linha do cartão; sem o gerenciador (npm, pip, Java...), baixa
// antes o SDK pela IDE e segue. onTool: a ferramenta como ficou depois do SDK (o cartão guarda para os botões)
async function lsInstallRow(tool, row, after, onTool) {
  if (row.dataset.st === 'running' || row.dataset.st === 'done') return;
  row.dataset.st = 'running';
  const btn = row.querySelector('[data-a="go"]'), prog = row.querySelector('.nt-prog'), bar = row.querySelector('.nt-bar'), fill = bar.querySelector('i'), step = row.querySelector('.nt-step'), log = row.querySelector('.nt-log');
  if (btn) btn.hidden = true; prog.hidden = false; row.classList.remove('err');
  const sdk = lsSdk(tool);
  if (sdk) {
    const show = (j) => { bar.classList.toggle('indet', j.progress == null); fill.style.width = j.progress == null ? '' : Math.round(j.progress * 100) + '%'; if (j.step) step.textContent = j.step; if (j.log) log.textContent = j.log.join('\n'); };
    try { await bs.sdk.quick(sdk, { min: tool.sdk_min, onStep: show }); }
    catch (e) { row.dataset.st = ''; row.classList.add('err'); bar.classList.remove('indet'); step.textContent = e.message; if (e.log) log.textContent = e.log.join('\n'); if (btn) { btn.hidden = false; btn.textContent = 'Tentar de novo'; } after && after(); return; }
    step.textContent = bs.sdk.name(sdk) + ' instalado. Procurando de novo…';
    await lsTools(true);
    const t = LS.tools.find(x => x.id === tool.id) || tool; onTool && onTool(t); tool = t;
    if (t.installed) return lsInstallDone(t, row, bar, fill, step, after);
    if (!t.auto) { row.dataset.st = ''; row.classList.add('err'); step.textContent = t.needs || 'o SDK foi instalado, mas ainda falta algo para esta ferramenta'; after && after(); return; }
    fill.style.width = '0';
  }
  let j;
  try { j = await api('rpc/install', { tool: tool.id }, { method: 'POST' }); } catch (e) { j = { state: 'error', error: e.message, log: [] }; }
  while (j && j.state === 'running') {
    bar.classList.toggle('indet', j.progress == null); fill.style.width = j.progress == null ? '' : Math.round(j.progress * 100) + '%';
    step.textContent = j.step || ''; log.textContent = (j.log || []).join('\n');
    await new Promise(r => setTimeout(r, 400));
    try { j = await api('rpc/install', { tool: tool.id }); } catch (e) { j = { state: 'error', error: e.message, log: [] }; }
  }
  log.textContent = (j && j.log || []).join('\n');
  bar.classList.remove('indet');
  if (j && j.state === 'done') return lsInstallDone(tool, row, bar, fill, step, after);
  row.dataset.st = ''; row.classList.add('err');
  step.textContent = (j && j.error) || 'Falhou'; if (btn) { btn.hidden = false; btn.textContent = 'Tentar de novo'; }
  after && after();
}

async function lsInstallDone(tool, row, bar, fill, step, after) {
  row.dataset.st = 'done'; bar.classList.remove('indet'); fill.style.width = '100%'; step.textContent = 'Instalado. Ligando a análise…';
  await lsRefresh();
  step.textContent = 'Instalado · análise ligada';
  toast(`${tool.name} instalado: análise de ${tool.langs.map(l => LS_MAIN[l] || l).join(', ')} ligada`, 'ok');
  after && after();
}

// ----- símbolos do projeto inteiro (busca geral: Shift Shift / Ctrl+N) -----
// pergunta a todos os servidores ligados neste projeto; uma busca nova cancela a anterior.
// Os de fora do projeto são as dependências dele, do jeito que o servidor de cada linguagem as enxerga (JDK e jars do
// Maven/Gradle no jdtls, crates no rust-analyzer, módulos do go.mod no gopls, headers incluídos no clangd, node_modules e
// lib.d.ts no tsserver, vendor/ no Intelephense...): só os tipos (classe, interface, enum, struct) entram, com ext: true
const EXT_KINDS = new Set([5, 10, 11, 23]);
// onde fica a classe externa: módulo/jar do JDK, assembly, pacote do node_modules, crate, módulo Go, site-packages...
function libWhere(uri) {
  const u = decodeURIComponent(uri);
  let m = u.match(/^jdt:\/\/contents\/([^/]+)\//); if (m) return m[1];
  m = u.match(/assemblies\/([^/]+)\//); if (m) return m[1];
  const p = u.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
  m = p.match(/\/(node_modules\/(?:@[^/]+\/)?[^/]+|site-packages\/[^/]+|dist-packages\/[^/]+|typeshed[^/]*\/stdlib|registry\/src\/[^/]+\/[^/]+|pkg\/mod\/[^@]+@[^/]+|rustlib\/src\/rust\/library\/[^/]+|vendor\/[^/]+\/[^/]+|include)\//i);
  if (m) return m[1].replace(/^registry\/src\/[^/]+\//, '').replace(/^rustlib\/src\/rust\/library\//, 'std/').replace(/^pkg\/mod\//, '');
  return p.split('/').slice(-3, -1).join('/');
}
async function openSymbol(s) {
  let loc = s.loc;
  // LSP 3.17: o servidor pode mandar só a URI e completar o lugar depois (workspaceSymbol/resolve)
  if (!loc.range && s.client.alive && s.client.caps.workspaceSymbolProvider && s.client.caps.workspaceSymbolProvider.resolveProvider) {
    try { const r = await s.client.request('workspaceSymbol/resolve', s.raw, 10000); if (r && r.location) loc = r.location; } catch {}
  }
  return goTo(loc.uri, loc.range, s.client);
}
let symAbort = null;
async function workspaceSymbols(q) {
  if (symAbort) symAbort.cancel();
  const proj = S.project && S.project.path; if (!proj || !q.trim() || !window.monaco) return [];
  const src = new monaco.CancellationTokenSource(); symAbort = src;
  const clients = [...LS.clients.values()].filter(c => c.alive && c.caps && c.caps.workspaceSymbolProvider && keyOf(c.root) === keyOf(proj));
  const res = await Promise.all(clients.map(c => c.request('workspace/symbol', { query: q }, 8000, src.token).catch(() => null)));
  if (src.token.isCancellationRequested) return null;
  const out = [], ext = [], seen = new Set();
  res.forEach((list, i) => { for (const s of list || []) {
    const loc = s.location; if (!loc || !loc.uri) continue;
    const rel = /^file:/i.test(loc.uri) ? relOf(uriToPath(loc.uri), proj) : null;
    if (rel != null) { if (loc.range && out.length < 200) out.push({ name: s.name, kind: s.kind, container: s.containerName || '', p: rel, line: loc.range.start.line + 1, col: loc.range.start.character + 1 }); continue; }
    if (!EXT_KINDS.has(s.kind) || ext.length >= 200) continue;
    const k = s.name + '|' + loc.uri; if (seen.has(k)) continue; seen.add(k);
    ext.push({ ext: true, name: s.name, kind: s.kind, container: s.containerName || '', lib: libWhere(loc.uri), uri: loc.uri, loc, raw: s, client: clients[i] });
  } });
  return out.concat(ext);
}

// arquivos mudados fora do editor (git checkout, Cargo.toml, gerado pelo build): o servidor relê sem reiniciar
function watchedFiles(proj, r) {
  const clients = [...LS.clients.values()].filter(c => c.alive && keyOf(c.root) === keyOf(proj)); if (!clients.length) return;
  const type = { add: 1, change: 2, remove: 3 };
  const changes = (r.files || []).slice(0, 2000).map(f => ({ uri: pathToUri(proj.replace(/[\\/]+$/, '') + '\\' + f.p.replace(/\//g, '\\')), type: type[f.k] || 2 }));
  if (changes.length) clients.forEach(c => c.notify('workspace/didChangeWatchedFiles', { changes }));
}
async function restart(tool, root) {
  const key = tool.id + '|' + keyOf(root); const c = LS.clients.get(key);
  LS.failed.delete(key);
  if (c) { try { await c.request('shutdown', null, 3000); c.notify('exit', null); } catch {} c.close(); LS.clients.delete(key); }
  for (const [id, d] of [...LS.docs]) if (d.client === c) { d.sub && d.sub.dispose(); LS.docs.delete(id); }
  S.tabs.filter(x => x.mode === 'editor' && x.project === root).forEach(openDoc);
}

// ----- ligações com o núcleo -----
bs.hooks.on('editor:ready', (ed) => {
  // atalhos do IntelliJ para navegação e refatoração
  const K = monaco.KeyMod, C = monaco.KeyCode; const run = (id) => () => ed.trigger('bs', id, null);
  ed.addCommand(K.Shift | C.F6, run('editor.action.rename'));
  ed.addCommand(K.Alt | C.Enter, run('editor.action.quickFix'));
  ed.addCommand(K.Alt | C.F7, run('editor.action.goToReferences'));
  ed.addCommand(K.CtrlCmd | C.KeyB, run('editor.action.revealDefinition'));
  ed.addCommand(K.CtrlCmd | K.Alt | C.KeyB, run('editor.action.goToImplementation'));
  ed.addCommand(K.CtrlCmd | K.Shift | C.KeyB, run('editor.action.goToTypeDefinition'));
  ed.addCommand(K.CtrlCmd | C.F12, run('editor.action.quickOutline'));
  ed.addCommand(K.CtrlCmd | C.KeyQ, run('editor.action.showHover'));
  ed.addCommand(K.CtrlCmd | K.Alt | C.KeyO, run('editor.action.organizeImports'));
  ed.addAction({ id: 'bs.lsp.rename', label: 'Renomear…', keybindings: [], contextMenuGroupId: '1_modification', contextMenuOrder: 0, run: run('editor.action.rename') });
  lsTools();
});
bs.hooks.on('tab:open', (t) => openDoc(t));
bs.hooks.on('tab:activate', (t) => { openDoc(t); lsStatus(); });
bs.hooks.on('tab:close', (t) => closeDoc(t));
bs.hooks.on('tab:save', (t) => { const d = t.model && LS.docs.get(t.model.id); if (d) { flush(d); d.client.notify('textDocument/didSave', { textDocument: { uri: d.uri }, text: t.model.getValue() }); } });
bs.hooks.on('project:select', (p) => { lsStatus(); if (p) setTimeout(lsCheckProject, 1500); });
bs.hooks.on('files:changed', watchedFiles);
const boot = setInterval(() => {
  if (!window.monaco) return; clearInterval(boot);
  monaco.editor.registerCommand('bs.lsp.codeAction', (_, d, a) => runCodeAction(d, a));
  // Monaco abrindo outro arquivo (definição, referência, espiada): vira uma aba do BlueScreen
  // código de biblioteca (bs-lib:): abre a aba só de leitura dela
  monaco.editor.registerEditorOpener({ openCodeEditor(src, resource, sel) {
    const m = monaco.editor.getModel(resource); const tab = m && m._tab;
    const line = sel ? sel.startLineNumber || sel.lineNumber || 1 : 0, col = sel ? sel.startColumn || sel.column || 1 : 1;
    if (tab && S.tabs.includes(tab)) { activate(tab); if (line) revealAt(editor, line, col); return true; }
    if (m && m._lib) { openLibrary(m, line, col); return true; }
    if (resource.scheme === 'file') { goTo(resource.toString(), sel); return true; }
    return false;
  } });
  stEl = bs.status.add({ id: 'stLsp', title: 'Análise da linguagem', onclick: (e) => lsMenu(e) });
  lsTools().then(lsStatus);
}, 100);
setInterval(lsStatus, 2000);
bs.actions.add([
  { label: 'Renomear símbolo', k: 'Shift+F6', run: () => editor && editor.trigger('bs', 'editor.action.rename') },
  { label: 'Ações rápidas e refatorações', k: 'Alt+Enter', run: () => editor && editor.trigger('bs', 'editor.action.quickFix') },
  { label: 'Ir para a definição', k: 'Ctrl+B', run: () => editor && editor.trigger('bs', 'editor.action.revealDefinition') },
  { label: 'Encontrar usos', k: 'Alt+F7', run: () => editor && editor.trigger('bs', 'editor.action.goToReferences') },
  { label: 'Estrutura do arquivo', k: 'Ctrl+F12', run: () => editor && editor.trigger('bs', 'editor.action.quickOutline') },
  { label: 'Formatar arquivo', k: 'Shift+Alt+F', run: () => editor && editor.trigger('bs', 'editor.action.formatDocument') },
  { label: 'Organizar imports', k: 'Ctrl+Alt+O', run: () => editor && editor.trigger('bs', 'editor.action.organizeImports') },
  { label: 'Servidores de linguagem: procurar de novo', run: async () => { await lsTools(true); toast(LS.tools.filter(x => x.kind === 'lsp' && x.installed).length + ' servidores de linguagem'); } },
]);
window.addEventListener('beforeunload', () => LS.clients.forEach(c => c.close()));
// procura de novo e liga a análise nas abas abertas (depois de instalar um servidor ou um SDK)
async function lsRefresh() { await lsTools(true); S.tabs.filter(t => t.mode === 'editor').forEach(openDoc); lsStatus(); }
bs.lsp = { tools: lsTools, refresh: lsRefresh, clientFor: (tab) => { const t = serverFor(tab.lang); return t ? clientFor(t, tab.project) : null; }, restart, pathToUri, uriToPath, RpcClient, workspaceSymbols, openSymbol, install, checkProject: lsCheckProject };
})(window.BS);
