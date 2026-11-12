# Navegador

Nós para o Automator que abrem um site no Edge (ou no Chrome) e seguem um roteiro, sem dependências: o `site.js` fala com o navegador pelo protocolo de depuração (CDP). Precisa do Node.js 22 ou mais novo.

- **Testar site** (categoria QA): roteiro com conferências, placar de passou/falhou, tela da hora da falha, comparação visual, checagem básica de acessibilidade e relatório em HTML.
- **Automatizar site**: o mesmo motor para rotinas; para na primeira falha e entrega `{ url, title, values }`.
- **Gravar no navegador**: `node site.js --record` abre o site com uma barra de gravação; cada ação vira um passo. Senhas nunca são gravadas: fica `{{cred:senha}}`, uma credencial do Automator.

O perfil do navegador, as evidências e os relatórios ficam na pasta de dados do plugin. O guia completo está em `docs/AUTOMACOES.md`, em "Teste e automatize um site".
