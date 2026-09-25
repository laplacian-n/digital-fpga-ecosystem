@echo off
REM ============================================================
REM  setup.bat - double-click to auto-configure ISE environment
REM  (asks for Administrator, then runs setup.ps1)
REM ============================================================
cd /d "%~dp0"

REM --- request admin if not elevated ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
    exit /b
)

echo Running environment setup...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
