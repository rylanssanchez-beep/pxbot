@echo off
title PXBOT NQ Console
echo.
echo  ================================================
echo   PXBOT NQ Console — Starting...
echo  ================================================
echo.

:: Kill any old instance on port 8899
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8899 "') do (
  taskkill /PID %%a /F >nul 2>&1
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
pause
taskkill /FI "WINDOWTITLE eq PXBOT Server" /F >nul 2>&1
