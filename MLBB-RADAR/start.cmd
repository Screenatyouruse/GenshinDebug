@echo off
title MLBB Radar Server
cd /d "%~dp0m2"
echo ========================================================
echo    MLBB External Radar Server
echo ========================================================
echo.
echo [*] Starting telemetry daemon on http://127.0.0.1:8080 ...
echo [*] Open radar HUD in browser: http://localhost:8080/map.html
echo [*] Open replay studio in browser: http://localhost:8080/replay.html
echo.
python -u serve.py
pause
