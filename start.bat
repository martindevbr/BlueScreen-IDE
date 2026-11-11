@echo off
setlocal
rem Compila tudo (nucleo em Rust, interface e plugins), monta app\dist\BlueScreen e abre o executavel novo.
rem Argumentos vao para o BlueScreen:  start.bat C:\meus\projetos
cd /d "%~dp0app"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where cargo >nul 2>&1 || (echo Rust/cargo nao encontrado. Instale em https://rustup.rs e rode de novo. & pause & exit /b 1)

rem o BlueScreen aberto trava os arquivos de app\dist: pede para fechar (sem forcar, para nao perder nada)
tasklist /FI "IMAGENAME eq BlueScreen.exe" 2>nul | find /I "BlueScreen.exe" >nul || goto :build
echo Fechando o BlueScreen aberto...
"dist\BlueScreen\BlueScreen.exe" --quit >nul 2>&1
for /l %%i in (1,1,15) do (
  tasklist /FI "IMAGENAME eq BlueScreen.exe" 2>nul | find /I "BlueScreen.exe" >nul || goto :build
  timeout /t 1 /nobreak >nul
)
echo.
echo O BlueScreen continua aberto (talvez com arquivos nao salvos). Feche-o e rode de novo.
pause
exit /b 1

:build
echo Compilando...
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
if errorlevel 1 (echo. & echo A compilacao falhou. Veja os erros acima. & pause & exit /b 1)

start "" "%~dp0app\dist\BlueScreen\BlueScreen.exe" %*
