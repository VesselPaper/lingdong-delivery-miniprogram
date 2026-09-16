@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  零栋无人送餐 · 大屏启动脚本（kiosk 全屏）
rem  作用：用 Chrome/Edge 的 kiosk 模式全屏打开大屏页，并独立一份浏览器配置，
rem        避免与日常浏览器的标签页/弹窗互相干扰。
rem  用法：双击即可；大屏主机可把它放进「启动」文件夹或交给看门狗调用。
rem ============================================================

set "URL=http://127.0.0.1:3000/dashboard"
set "PROFILE=%LocalAppData%\LingdongDashboard"
set "CHROME="

for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do (
  if not defined CHROME if exist %%P set "CHROME=%%~P"
)

if not defined CHROME (
  echo [大屏] 未找到 Chrome 或 Edge，请先安装任一浏览器后重试。
  pause
  exit /b 1
)

echo [大屏] 浏览器：%CHROME%
echo [大屏] 打开：%URL%

start "" "%CHROME%" ^
  --kiosk ^
  --app=%URL% ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --noerrdialogs ^
  --disable-session-crashed-bubble ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  --autoplay-policy=no-user-gesture-required ^
  --disable-features=Translate,MediaRouter

endlocal
