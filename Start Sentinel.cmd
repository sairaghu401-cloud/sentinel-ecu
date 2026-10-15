@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and try again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8787 in your browser after the ready message.
node src/server.js
pause
