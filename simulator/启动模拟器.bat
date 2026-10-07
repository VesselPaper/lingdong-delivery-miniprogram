@echo off
chcp 65001 >nul
cd /d "%~dp0"
node run.js %*
set EXITCODE=%ERRORLEVEL%
echo.
if "%~1"=="" pause
exit /b %EXITCODE%
