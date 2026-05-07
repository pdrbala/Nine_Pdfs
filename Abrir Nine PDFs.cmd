@echo off
setlocal

set "APP_DIR=%~dp0"
set "NODE_DIR=C:\Program Files\nodejs"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "PORT=4173"
set "URL=http://127.0.0.1:%PORT%"

if not exist "%NODE_EXE%" (
  echo Node nao foi encontrado em "%NODE_EXE%".
  pause
  exit /b 1
)

if not exist "%NPM_CMD%" (
  echo npm nao foi encontrado em "%NPM_CMD%".
  pause
  exit /b 1
)

cd /d "%APP_DIR%"

if not exist "node_modules" (
  echo Instalando dependencias...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)

echo Verificando build...
call "%NPM_CMD%" run build
if errorlevel 1 (
  echo Falha no build do projeto.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 goto open_browser

echo Iniciando servidor local em %URL% ...
start "Nine PDFs Server" /D "%APP_DIR%" /min "%NODE_EXE%" "%APP_DIR%node_modules\vite\bin\vite.js" preview --host 127.0.0.1 --port %PORT%

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(20); do { try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 700 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo O servidor nao respondeu a tempo.
  pause
  exit /b 1
)

:open_browser
if exist "%CHROME_EXE%" (
  start "" "%CHROME_EXE%" --new-window "%URL%"
) else (
  start "" "%URL%"
)

echo Nine PDFs abriu em %URL%
exit /b 0
