# BlueScreen no celular

A IDE continua rodando no PC: o celular abre a interface dela pela rede local (`http://<ip-do-pc>:4748`, com PIN). O que muda é como ela chega ao celular:

| Aparelho | Como instala | O que é |
|---|---|---|
| iPhone e iPad | Safari › Compartilhar › **Adicionar à Tela de Início** | a própria interface, instalada como app (PWA): ícone, tela cheia, sem a barra do Safari |
| Android | **APK** baixado do próprio PC (ou do Release) | um app leve (155 KB) que acha o PC na rede, guarda o endereço e abre a IDE em tela cheia |
| Qualquer um | só abrir o endereço no navegador | o mesmo de sempre |

## Instalar

1. No PC: **Configurações** (engrenagem) › **Rede local** › ligue **Permitir acesso pela rede**.
2. Aponte a câmera do celular para o **QR code** que aparece ali. Ele abre `http://<ip-do-pc>:4748/instalar`, uma página que reconhece o aparelho:
   - **iPhone:** mostra os passos do "Adicionar à Tela de Início" (e avisa quando o link foi aberto dentro do Instagram, Gmail etc., que não instalam apps: aí é copiar e abrir no Safari).
   - **Android:** botão **Baixar o app**, servido pelo próprio PC, sem internet. Depois de instalado, **Já tenho o app: abrir este PC** abre direto nele (`bluescreen://abrir?url=...`).
3. Abra pelo ícone e digite o PIN.

### App Android

- **Escolher o PC:** os PCs já usados ficam no topo. **Na rede** lista quem está com a Rede local ligada: o anúncio UDP do BlueScreen (porta 4749) traz o nome do PC e o projeto aberto, e uma varredura da porta 4748 na sub-rede do Wi-Fi cobre as redes que bloqueiam broadcast. Dá também para digitar o IP (com `:porta`, se o PC usa `BLUESCREEN_LAN_PORT`).
- **Ao abrir pelo ícone**, ele volta direto para o último PC. Se o PC não responder, a tela de escolha aparece com o motivo.
- **Voltar:** o primeiro toque fecha o que estiver aberto na IDE (como `Esc`); o segundo, em até 2 s, volta à escolha do PC.
- **Arquivos:** enviar (seletor do Android) e baixar (vão para Downloads) funcionam, inclusive os relatórios gerados na hora pela página.
- Só aceita IP (o servidor recusa nomes como `meupc.local`) e só HTTP da rede local; links para fora abrem no navegador do celular.

### iPhone

- O iOS guarda a sessão do app separada da do Safari: no primeiro uso pelo ícone, o PIN é pedido de novo.
- O ícone fica preso ao endereço do PC (IP e porta). Se o IP do PC mudar, instale de novo pelo QR code. Uma reserva de IP no roteador (DHCP fixo) evita isso.
- Notch, ilha e barra de gestos viram margem (CSS `env(safe-area-inset-*)` em `app.css`), e a barra de status fica na cor da IDE.

## Esteira

O `.github/workflows/release.yml` publica tudo junto a cada push na `main` que mexe em `app/`, `assets/` ou `mobile/`:

```
versão ─┬─ Windows (testes + compilação) ─┐
        ├─ Android (testes + lint + APK) ─┼─ pacote e Release
        └─ iOS (app instalável conferido) ┘
```

- **Windows:** `cargo test` e `build.ps1`, como antes.
- **Android:** testes da JVM, lint e `assembleRelease` com a versão do Release (`-PbsVersion`); a assinatura é conferida com o `apksigner`.
- **iOS:** não há o que compilar; `node mobile/ios/verificar-pwa.mjs` confere manifesto, ícones (o da Tela de Início sem transparência), as tags do Safari nas páginas, a rota `/instalar` e o QR code.
- **Pacote e Release:** o APK entra em `wwwroot/mobile/BlueScreen.apk` (é dali que a página `/instalar` entrega), depois saem o instalador, o zip e o `BlueScreen-X.Y.Z-android.apk`, cada um com `.sha256`.

O `.github/workflows/ci.yml` roda as mesmas conferências em PRs e branches, sem publicar, e deixa o APK de teste como artefato da execução.

### Assinatura do APK

O Android só atualiza um app por cima se a assinatura for a mesma. Crie a chave **uma vez** e guarde em lugar seguro (perder a chave obriga quem usa a desinstalar e instalar de novo):

```
keytool -genkeypair -v -keystore bluescreen.jks -alias bluescreen -keyalg RSA -keysize 4096 -validity 10000
```

No GitHub, em **Settings › Secrets and variables › Actions**, crie:

| Secret | Valor |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | o `.jks` em base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('bluescreen.jks'))`) |
| `ANDROID_KEYSTORE_PASSWORD` | senha do keystore |
| `ANDROID_KEY_ALIAS` | `bluescreen` |
| `ANDROID_KEY_PASSWORD` | senha da chave (se for a mesma do keystore, repita) |

Sem esses secrets, a esteira avisa e assina com uma chave de debug descartável: o APK instala, mas a versão seguinte não atualiza por cima.

## Compilar na máquina

Android (JDK 17+ e o SDK do Android; `ANDROID_HOME` apontando para ele):

```
cd mobile\android
gradlew testReleaseUnitTest lintRelease assembleRelease
```

Sem `BS_ANDROID_KEYSTORE` (e as senhas em `BS_ANDROID_KEYSTORE_PASSWORD`, `BS_ANDROID_KEY_ALIAS`, `BS_ANDROID_KEY_PASSWORD`), o APK sai com a chave de debug da máquina. A versão vem do `app/Cargo.toml`.

Para pôr o APK na IDE compilada (a página `/instalar` passa a entregar ele):

```
cd app
powershell -File build.ps1 -Apk ..\mobile\android\app\build\outputs\apk\release\app-release.apk
```

Testar no emulador: o PC aparece para ele como `10.0.2.2`. Com a Rede local ligada na porta 4748, **Procurar de novo** já acha o PC; em outra porta, digite `10.0.2.2:<porta>`.

| Arquivo | O que faz |
|---|---|
| `app/wwwroot/manifest.webmanifest`, `app/wwwroot/icons/` | app instalável (nome, cores, ícones) |
| `app/wwwroot/instalar.html` | página `/instalar` que o QR code abre |
| `app/wwwroot/qr.js` | gerador de QR code (sem biblioteca de fora) |
| `mobile/android/` | app Android (Java puro, sem AndroidX) |
| `mobile/ios/verificar-pwa.mjs` | conferência do app do iPhone na esteira |
