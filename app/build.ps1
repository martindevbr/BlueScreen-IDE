# BlueScreen: monta a versão final em dist\BlueScreen (núcleo + interface + plugins).
#   .\build.ps1            compila em release e monta dist\BlueScreen
#   .\build.ps1 -Plugin <id> monta só dist\plugins\<id> (para copiar em ~\.bluescreen\plugins de outra máquina)
#   .\build.ps1 -Packages bluescreen,bluescreen-unilint   compila só esses pacotes (o atualizador passa o que mudou);
#                         os outros exes vêm do target\release da compilação anterior (sem eles, compila tudo)
#   .\build.ps1 -PluginServer   monta só o servidor de plugins em dist\PluginServer
param([string]$Plugin = '', [string]$Out = "$PSScriptRoot\dist", [string[]]$Packages = @(), [switch]$PluginServer)
$ErrorActionPreference = 'Continue' # o cargo escreve o progresso no stderr; o que vale é o código de saída
Set-Location $PSScriptRoot

function Copy-Plugin([string]$id, [string]$dest) {
  $src = Join-Path $PSScriptRoot "plugins\$id"
  New-Item -ItemType Directory -Force $dest | Out-Null
  foreach ($f in 'plugin.json', 'ui.js', 'style.css', 'icon.svg', 'icon.png', 'GUIA.md') { if (Test-Path "$src\$f") { Copy-Item "$src\$f" $dest } }
  # plugin com servidor próprio: o programa vira server.exe na pasta do plugin
  $exe = Join-Path $PSScriptRoot "target\release\bluescreen-$id.exe"
  if (Test-Path "$src\Cargo.toml") { Copy-Item $exe (Join-Path $dest 'server.exe') }
  Write-Host "plugin  $id  -> $dest"
}

# plugins com servidor próprio (plugins\<id>\Cargo.toml) entram no workspace só durante o cargo build: o Cargo.toml
# fica sem "plugins/*" (vazio, o curinga faz o cargo recusar o manifesto). Cargo.toml e Cargo.lock voltam como estavam.
# Os membros são listados um a um: o curinga também pegaria os plugins só de interface (sem Cargo.toml, ex.: sheets),
# e o cargo recusa o workspace inteiro por causa deles.
function Invoke-Cargo([string[]]$CargoArgs) {
  $crates = @(Get-ChildItem 'plugins' -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'Cargo.toml') } | ForEach-Object { "`"plugins/$($_.Name)`"" })
  $hasPlugins = $crates.Count -gt 0
  $toml = Join-Path $PSScriptRoot 'Cargo.toml'; $lock = Join-Path $PSScriptRoot 'Cargo.lock'
  $tomlText = [IO.File]::ReadAllText($toml); $lockText = [IO.File]::ReadAllText($lock)
  if ($hasPlugins) { [IO.File]::WriteAllText($toml, ($tomlText -replace 'members = \[[^\]]*\]', "members = [`".`", `"sdk`", `"plugin-server`", $($crates -join ', ')]")) }
  try { cargo @CargoArgs | Out-Host; return $LASTEXITCODE }
  finally { if ($hasPlugins) { [IO.File]::WriteAllText($toml, $tomlText); [IO.File]::WriteAllText($lock, $lockText) } }
}

# WebView2Loader.dll: com o Rust MSVC o loader entra estático no exe; com o Rust GNU (x86_64-pc-windows-gnu) o exe
# importa a DLL e não abre sem ela ao lado ("WebView2Loader.dll não foi encontrado"). O webview2-com-sys deixa a DLL
# de cada arquitetura em target\release\build\webview2-com-sys-*\out\<arq>; copia a da arquitetura do exe.
function Copy-WebView2Loader([string]$exe, [string]$dest) {
  $bytes = [IO.File]::ReadAllBytes((Resolve-Path $exe))
  if ([Text.Encoding]::ASCII.GetString($bytes) -notmatch '(?i)WebView2Loader\.dll') { return }
  # arquitetura do exe pelo cabeçalho PE (campo Machine)
  $pe = [BitConverter]::ToInt32($bytes, 0x3C); $machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
  $arch = @{ 0x8664 = 'x64'; 0x14C = 'x86'; 0xAA64 = 'arm64' }[[int]$machine]
  if (-not $arch) { Write-Warning "Arquitetura do exe desconhecida (0x$('{0:X}' -f $machine)): copie o WebView2Loader.dll à mão."; return }
  $dll = Get-ChildItem 'target\release\build' -Directory -Filter 'webview2-com-sys-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "out\$arch\WebView2Loader.dll" } | Where-Object { Test-Path $_ } |
    Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1
  if (-not $dll) { Write-Error "O exe precisa do WebView2Loader.dll ($arch), mas ele não está em target\release\build."; exit 1 }
  Copy-Item $dll $dest
  Write-Host "WebView2Loader.dll ($arch) -> $dest (build com o Rust GNU)"
}

# servidor de plugins (programa à parte, fora da IDE): dist\PluginServer\bluescreen-plugin-server.exe
if ($PluginServer) {
  if (Invoke-Cargo @('build', '--release', '-p', 'bluescreen-plugin-server')) { exit 1 }
  $dest = Join-Path $Out 'PluginServer'; New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item 'target\release\bluescreen-plugin-server.exe' $dest
  Write-Host "servidor de plugins -> $dest (rode bluescreen-plugin-server.exe --help)"
  exit 0
}

if ($Plugin) {
  if (Test-Path "plugins\$Plugin\Cargo.toml") { if (Invoke-Cargo @('build', '--release', '-p', "bluescreen-$Plugin")) { exit 1 } }
  Copy-Plugin $Plugin (Join-Path $Out "plugins\$Plugin")
  exit 0
}

# exe que cada pacote gera em target\release (o núcleo e os plugins com servidor)
$exes = @{ 'bluescreen' = 'target\release\bluescreen.exe' }
Get-ChildItem 'plugins' -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Cargo.toml') } | ForEach-Object { $exes["bluescreen-$($_.Name)"] = "target\release\bluescreen-$($_.Name).exe" }
$Packages = @($Packages | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
# só compila parte se os exes que ficam de fora já existem de uma compilação anterior
$partial = $Packages.Count -gt 0 -and -not ($exes.Keys | Where-Object { $Packages -notcontains $_ -and -not (Test-Path $exes[$_]) })
if ($partial) {
  Write-Host "Compilando só: $($Packages -join ', ')"
  $cargoArgs = @('build', '--release'); foreach ($p in $Packages) { $cargoArgs += @('-p', $p) }
  if (Invoke-Cargo $cargoArgs) { exit 1 }
} elseif (Invoke-Cargo @('build', '--release', '--workspace', '--exclude', 'bluescreen-plugin-server')) { exit 1 }
$dist = Join-Path $Out 'BlueScreen'
$ErrorActionPreference = 'Stop'
# Confira o destino e os arquivos em uso antes de remover qualquer parte da distribuição.
$outFull = [IO.Path]::GetFullPath($Out).TrimEnd('\', '/')
$distFull = [IO.Path]::GetFullPath($dist)
if ($distFull -ne (Join-Path $outFull 'BlueScreen')) { throw "Destino de distribuição inválido: $distFull" }
if (Test-Path -LiteralPath $distFull) {
  foreach ($item in Get-ChildItem -LiteralPath $distFull -File -Recurse) {
    try {
      $probe = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $probe.Dispose()
    } catch { throw "Não foi possível preparar a distribuição: '$($item.FullName)' está em uso ou sem permissão. Use Sair do BlueScreen na bandeja e tente novamente, ou escolha outra pasta com -Out." }
  }
}
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item 'target\release\bluescreen.exe' (Join-Path $dist 'BlueScreen.exe')
Copy-WebView2Loader 'target\release\bluescreen.exe' $dist
Copy-Item -Recurse 'wwwroot' (Join-Path $dist 'wwwroot')
Get-ChildItem 'plugins' -Directory | ForEach-Object { Copy-Plugin $_.Name (Join-Path $dist "plugins\$($_.Name)") }
$size = (Get-ChildItem $dist -Recurse | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("`nVersão final em {0} ({1:N1} MB). Rode BlueScreen.exe lá dentro." -f $dist, $size)

