@echo off
chcp 936 >nul
rem ============================================================
rem  零栋送餐 · 一键打开管理员网页（不启动后端）
rem  默认连接本机后端 http://127.0.0.1:3000
rem  后端在远程服务器时：在本文件同目录放 服务器地址.txt，
rem  第一行写 服务器IP:端口（如 192.168.1.10:3000）即可自动改连。
rem ============================================================
setlocal
cd /d "%~dp0"

set "ADDR=127.0.0.1:3000"
if exist "服务器地址.txt" set /p ADDR=<"服务器地址.txt"
if "%ADDR%"=="" set "ADDR=127.0.0.1:3000"

rem 兼容 txt 里写了 http:// 前缀的情况
echo %ADDR% | findstr /I "^http" >nul
if errorlevel 1 (
  set "BASE=http://%ADDR%"
) else (
  set "BASE=%ADDR%"
)

echo ================================================
echo   零栋送餐 · 打开管理员网页
echo   目标地址: %BASE%/admin/
echo ================================================
echo.

rem 连通性探测（Win10 自带 curl；老系统没有 curl 则跳过探测直接打开）
where curl >nul 2>nul
if errorlevel 1 goto :open

curl -s -o nul -m 3 -w "%%{http_code}" "%BASE%/admin/" >"%TEMP%\ld_ping.txt" 2>nul
if not exist "%TEMP%\ld_ping.txt" goto :open
set /p CODE=<"%TEMP%\ld_ping.txt"
del "%TEMP%\ld_ping.txt" >nul 2>nul

if "%CODE%"=="200" goto :open
if "%CODE%"=="301" goto :open
if "%CODE%"=="302" goto :open

echo [提示] 无法连通 %BASE%/admin/ (HTTP 状态: %CODE%)
echo   请检查：
echo     1. 后端已启动 (backend 目录 node server.js, 或根目录 启动服务器.bat)
echo     2. 服务器防火墙 / 云安全组已放行 3000 端口
echo     3. 后端在远程服务器时, 在本文件同目录放 服务器地址.txt,
echo        第一行写 服务器IP:端口, 如 192.168.1.10:3000
echo.
pause
exit /b 1

:open
start "" "%BASE%/admin/"
echo 已在默认浏览器打开管理员网页 (如未弹出请检查默认浏览器)。
echo 首次打开需输入管理员令牌, 默认 123456。
echo.
pause
