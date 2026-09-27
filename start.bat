@echo off
setlocal
cd /d "%~dp0"

set PORT=8000

where python >nul 2>nul
if %errorlevel%==0 (
    set PYCMD=python
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set PYCMD=py -3
    ) else (
        echo Python was not found. Install it from https://python.org and try again.
        pause
        exit /b 1
    )
)

echo Starting NinDeals on port %PORT%...
start "NinDeals Server" /min cmd /c "%PYCMD% -m http.server %PORT% --bind 0.0.0.0"

timeout /t 2 /nobreak >nul

start "" http://localhost:%PORT%/

echo.
echo NinDeals is running.
echo   On this PC:       http://localhost:%PORT%/
echo   On your network:  http://YOUR-IP:%PORT%/   (see IPv4 address below)
echo.
ipconfig | findstr /i "IPv4"
echo.
echo Other devices on the same Wi-Fi/network can use the network address above.
echo If they can't connect, allow Python through the Windows Firewall when prompted.
echo.
echo Close the "NinDeals Server" window to stop the server.
pause
