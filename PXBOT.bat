@echo off
title PXBOT NQ Console
echo.
echo  ================================================
echo   PXBOT NQ Console — Starting...
echo  ================================================
echo.

:: Check Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js is not installed or not on PATH.
  echo  Install it from https://nodejs.org (LTS version), then double-click this file again.
  echo.
  pause
  exit /b 1
)

:: Check Node.js version — the historical-data store needs node:sqlite (Node 22.5+)
node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj>22||(maj===22&&min>=5))?0:1)"
if errorlevel 1 (
  echo  Your Node.js version is too old for PXBOT's data store ^(needs 22.5 or newer^).
  echo  Install a current LTS from https://nodejs.org, then double-click this file again.
  echo.
  pause
  exit /b 1
)

:: Kill any old instance on port 8899
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8899 "') do (
  taskkill /PID %%a /F >nul 2>&1
)

:: Install dependencies on first run (needed for the /mcp connector endpoint)
if not exist "%~dp0node_modules" (
  echo  Installing dependencies (first run only)...
  call npm install --prefix "%~dp0"
)

:: Start the server
start "PXBOT Server" /min node "%~dp0server.js"

:: Wait for it to come up
echo  Waiting for server...
timeout /t 3 /nobreak >nul

:: Open browser
start "" "http://localhost:8899"

echo  Server running at http://localhost:8899
echo  Close this window to STOP the server.
echo.
echo  To let Claude read this chart live in chat, see MCP_CONNECTOR_SETUP.md
echo.
pause
taskkill /FI "WINDOWTITLE eq PXBOT Server" /F >nul 2>&1
