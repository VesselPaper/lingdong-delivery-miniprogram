@echo off
chcp 936 >nul
rem ============================================================
rem  零栋送餐 · 启动大屏（kiosk 全屏模式，供看门狗自动拉起）
rem  用 Edge / Chrome 以独立配置目录 + 全屏 kiosk 打开大屏。
rem  命令行里带 "LingdongDashboard" 标识：看门狗靠它识别
rem  这是大屏浏览器进程（避免误判用户日常浏览器）。
rem  后端在远程服务器时：在本文件同目录放 服务器地址.txt，
rem  第一行写 服务器IP:端口（如 192.168.1.10:3000）即可自动改连。
rem ============================================================
setlocal
cd /d "%~dp0"

set "ADDR=127.0.0.1:3000"
if exist "服务器地址.txt" set /p ADDR=<"服务器地址.txt"
if "%ADDR%"=="" set "ADDR=127.0.0.1:3000"
echo %ADDR% | findstr /I "^http" >nul
if errorlevel 1 (
  set "BASE=http://%ADDR%"
) else (
  set "BASE=%ADDR%"
)

set "PROFILE=%TEMP%\LingdongDashboard-kiosk"
set "TARGET=%BASE%/dashboard/"

rem 优先 Edge，其次 Chrome（常见安装路径逐一看，找到就启动）
set "BROWSER="
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if "%BROWSER%"=="" if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if "%BROWSER%"=="" if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if "%BROWSER%"=="" if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if "%BROWSER%"=="" (
  echo [错误] 未找到 Edge 或 Chrome，请安装任一浏览器后重试。
  echo   参考: https://www.microsoft.com/edge
  pause
  exit /b 1
)

echo 正在以 kiosk 全屏模式打开大屏: %TARGET%
start "" "%BROWSER%" --kiosk --no-first-run --disable-session-crashed-bubble --disable-infobars --user-data-dir="%PROFILE%" "%TARGET%"
exit /b 0