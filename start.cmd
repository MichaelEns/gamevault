@echo off
REM Double-click launcher. Starts GameVault and opens the browser.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org/ then run setup.ps1
  pause
  exit /b 1
)

if not exist ".env" (
  echo First run detected -- running setup...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
)

start "" http://localhost:8787
node server.mjs
pause
