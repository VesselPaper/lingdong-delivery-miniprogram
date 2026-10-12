@echo off
chcp 936 >nul
rem ============================================================
rem  零栋送餐 · 一键打开【云端】可视化大屏（不启动任何服务）
rem  2026-10-12 起后端常驻在云端：http://47.108.151.96:3000
rem  想改指向（换服务器 / 连本机后端）：在本文件同目录的
rem  服务器地址.txt 第一行写 服务器IP:端口，例如 127.0.0.1:3000
rem ============================================================
setlocal
cd /d "%~dp0"

set "ADDR=47.108.151.96:3000"
if exist "服务器地址.txt" set /p ADDR=<"服务器地址.txt"
if "%ADDR%"=="" set "ADDR=47.108.151.96:3000"

rem 兼容 txt 里写了 http:// 前缀的情况
echo %ADDR% | findstr /I "^http" >nul
if errorlevel 1 (
  set "BASE=http://%ADDR%"
) else (
  set "BASE=%ADDR%"
)

echo ================================================
echo   零栋送餐 · 打开可视化大屏（云端）
echo   目标地址: %BASE%/dashboard/
echo ================================================
echo.

rem 连通性探测（Win10 自带 curl；老系统没有 curl 则跳过探测直接打开）
where curl >nul 2>nul
if errorlevel 1 goto :open

curl -s -o nul -m 5 -w "%%{http_code}" "%BASE%/dashboard/" >"%TEMP%\ld_ping.txt" 2>nul
if not exist "%TEMP%\ld_ping.txt" goto :open
set /p CODE=<"%TEMP%\ld_ping.txt"
del "%TEMP%\ld_ping.txt" >nul 2>nul

if "%CODE%"=="200" goto :open
if "%CODE%"=="301" goto :open
if "%CODE%"=="302" goto :open

echo [提示] 无法连通 %BASE%/dashboard/ (HTTP 状态: %CODE%)
echo   请依次检查：
echo     1. 云端服务是否在跑：登录服务器执行 systemctl status lingdong
echo     2. 云安全组是否放行 3000 端口
echo     3. 服务器地址变过：改本文件同目录的 服务器地址.txt 第一行
echo.
pause
exit /b 1

:open
start "" "%BASE%/dashboard/"
echo 已在默认浏览器打开可视化大屏（如未弹出请检查默认浏览器）。
echo 大屏免登录，可直接全屏展示。
echo.
pause
