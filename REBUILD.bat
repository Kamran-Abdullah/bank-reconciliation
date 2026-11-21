@echo off
title Bank Reconciliation System - Rebuild
color 0A

echo.
echo   =============================================
echo     Bank Reconciliation System - Rebuild
echo   =============================================
echo.

cd /d "%~dp0"

echo   Looking for Node.js...
where node >nul 2>nul
if not errorlevel 1 goto :node_found

if exist "C:\Program Files\nodejs\node.exe" goto :found_prog
if exist "C:\Program Files (x86)\nodejs\node.exe" goto :found_prog86
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" goto :found_local

echo   ERROR: Node.js not found!
echo   Install from https://nodejs.org/
echo.
pause
exit /b 1

:found_prog
set "PATH=C:\Program Files\nodejs;%PATH%"
goto :node_found

:found_prog86
set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
goto :node_found

:found_local
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
goto :node_found

:node_found
echo   [OK] Node.js found
node --version
echo.

echo   Stopping any previous instance of this app (port 3001)...
set "KILLED_PREV="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
    set "KILLED_PREV=1"
)
if defined KILLED_PREV (
    timeout /t 2 /nobreak >nul
)
echo.

echo   Rebuilding application...
echo   This may take 3-5 minutes. Please wait...
echo.

echo   [Step 1] Installing dependencies...
call npm install
if errorlevel 1 goto :install_error

echo.
echo   [Step 2] Building application...
call npm run build
if errorlevel 1 goto :build_error

echo.
echo   [OK] Rebuild completed! You can now use RUN.bat to start the app.
echo.
pause
exit /b 0

:install_error
echo.
echo   ERROR: npm install failed!
echo   Check your internet connection.
echo.
pause
exit /b 1

:build_error
echo.
echo   ERROR: Build failed!
echo.
pause
exit /b 1
