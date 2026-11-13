# Servidor de plugins (`bluescreen-plugin-server`)

Hospeda plugins do BlueScreen com versões. As IDEs que apontam para ele instalam os plugins e são avisadas sempre que sai uma versão nova.

```
app\build.ps1 -PluginServer
dist\PluginServer\bluescreen-plugin-server.exe --port 4900 --dir D:\plugins --name "Plugins da equipe"
```

As mesmas opções valem por variável de ambiente: `PLUGIN_SERVER_PORT`, `PLUGIN_SERVER_DIR` e `PLUGIN_SERVER_NAME`. O servidor escuta em todas as interfaces, então outras máquinas da rede podem apontar para ele.

O servidor é só de leitura: pela rede, as IDEs listam e baixam plugins, e nada é enviado nem apagado por ela. Para publicar, copie a pasta do plugin (com `plugin.json`) para dentro de `<dir>/`; em segundos ela vira `<dir>/<id>/<versão>/`. Para tirar uma versão, apague a pasta `<dir>/<id>/<versão>/` na máquina do servidor.

Para que as IDEs recebam o aviso de atualização, aumente o `version` do `plugin.json`. Pasta com uma versão que já está no servidor vai para `<dir>/_recusados/`.

Do lado da IDE, o servidor entra em `~/.bluescreen/plugins.json` (`{ "servers": [{ "url": "http://servidor:4900" }] }`) e os plugins dele aparecem na Loja de plugins: [docs/PLUGINS.md](../../docs/PLUGINS.md#servidor-de-plugins-da-equipe).
