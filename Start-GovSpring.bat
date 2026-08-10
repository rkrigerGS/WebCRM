@echo off
REM ============================================================
REM  GovSpring Prospecting - starts the local server.
REM  Double-click this to run the app. Leave the window open
REM  (or minimize it) - closing it stops the app.
REM ============================================================

cd /d "%~dp0"

echo Starting GovSpring Prospecting...
echo.
echo When you see "running", open your browser to:
echo     http://localhost:3000
echo.

node server\server.js

REM If node exits (error or closed), keep the window open so the message is readable.
echo.
echo The server has stopped. Press any key to close this window.
pause >nul
