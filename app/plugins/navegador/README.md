# Navegador

Acrescenta ao Automator o nó **Automatizar site**: abre o Edge (ou o Chrome) num perfil próprio, entra num endereço e segue os passos que você montar: clicar, digitar, escolher, apertar tecla, esperar, ler texto e capturar a tela.

Senhas vão como `{{vault:site}}` no passo **Digitar**: guarde no Cofre (`Alt+8`) e libere para este plugin e para o programa `node`.

Precisa do Node.js 22 ou mais novo. O plugin é só o `automator.json` (o nó e os campos) e o `site.js` (quem controla o navegador): serve de exemplo para criar outros nós.

Veja [Automatize um site](../../../docs/AUTOMACOES.md#automatize-um-site).
