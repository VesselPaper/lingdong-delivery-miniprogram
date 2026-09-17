@echo off
cd /d "%~dp0backend"

echo ================================================
echo   零栋无人送餐后端
echo   ^(小程序 API 与大屏共用这一个服务, 端口 3000^)
echo   启动后请用浏览器打开大屏:
echo     http://127.0.0.1:3000/dashboard/
echo ================================================
echo.

rem 端口已被占用说明后端已在运行, 别重复启动
netstat -ano | findstr /C:":3000" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo [提示] 端口 3000 已被占用, 后端可能已经在本机运行中。
  echo        这时不用再启动, 直接打开大屏即可:
  echo        http://127.0.0.1:3000/dashboard/
  echo        如需强制重启, 先结束占用的 node 进程再运行本脚本。
  echo.
  pause
  exit /b 0
)

echo [启动] node server.js ...
node server.js
echo.
echo [提示] 后端进程已退出(手动关闭或启动报错), 请看上方输出。
echo        若上方出现 EADDRINUSE, 说明端口被占, 请先关掉旧进程。
echo.
pause