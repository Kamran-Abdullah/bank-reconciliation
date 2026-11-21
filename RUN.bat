@echo off
title Bank Reconciliation System
color 0A

echo.
echo   =============================================
echo     Bank Reconciliation System
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

if not exist "package.json" goto :files_missing
if not exist "build.js" goto :files_missing
goto :check_build

:files_missing
echo   ERROR: Project files not found!
echo   Make sure you extracted ALL files from the ZIP.
echo.
pause
exit /b 1

:check_build
echo   Stopping any previous instance of this app (port 3001)...
set "KILLED_PREV="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
    set "KILLED_PREV=1"
)
if defined KILLED_PREV (
    REM Give Windows a moment to release file handles before the build deletes/rewrites them
    timeout /t 2 /nobreak >nul
)
echo.

REM Only (re)install/rebuild if there's no existing build yet. Once it's built,
REM RUN.bat just starts the server instantly. Use REBUILD.bat to force a fresh
REM build after the app's code has been changed.
if exist ".next\standalone\server.js" goto :build_skip

echo   No existing build found - building application...
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
echo   [OK] Build completed!
echo.
goto :start_server

:build_skip
echo   [OK] Using existing build (fast start).
echo   If you changed the app's code, run REBUILD.bat first.
echo.

:start_server
echo   =============================================
echo     Starting server...
echo   =============================================
echo.
echo   Browser will open in 5 seconds.
echo   If not, go to: http://localhost:3001
echo.
echo   To STOP: Press Ctrl+C
echo   =============================================
echo.

start "" cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:3001"
set PORT=3001

if exist "crashproof-server.js" goto :run_crashproof
if exist ".next\standalone\server.js" goto :run_standalone
if exist "server.js" goto :run_fallback

echo   ERROR: No server file found!
echo.
pause
exit /b 1

:run_crashproof
echo   Using crash-proof server...
echo   If the server crashes, it will restart automatically.
echo   Errors are logged to: server_errors.log
echo.
node crashproof-server.js
goto :done

:run_standalone
echo   Using standalone server...
node .next\standalone\server.js
goto :done

:run_fallback
echo   Using fallback server...
node server.js
goto :done

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

:done
echo.
echo   Server stopped.
pause
