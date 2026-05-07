@echo off
setlocal

set "PORT=4173"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  taskkill /PID %%P /F >nul 2>nul
)

echo Servidor da porta %PORT% encerrado.
exit /b 0
