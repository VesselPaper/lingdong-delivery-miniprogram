# 零栋无人送餐 · 大屏看门狗
#
# 作用：无人值守时保证「后端在跑 + 大屏在放」。每 60 秒检查一次：
#   1. 后端接口 /api/shop/status 是否可达 —— 不可达则重新拉起 node server.js；
#   2. 大屏 kiosk 浏览器进程是否存在 —— 不存在则重新启动（调用 启动大屏.bat）；
#   3. 大屏页面有响应但后端刚恢复时，页面下一轮轮询会自己接上（前端保留上一屏，不黑屏）。
#
# 用法（前台观察）：powershell -ExecutionPolicy Bypass -File 看门狗.ps1
# 用法（后台常驻）：见 安装开机自启.ps1

param(
  [int]$IntervalSec = 60,
  [string]$BackendDir = (Join-Path $PSScriptRoot '..\..\backend'),
  [string]$StartScript = (Join-Path $PSScriptRoot '启动大屏.bat')
)

$ErrorActionPreference = 'SilentlyContinue'
$checkUrl = 'http://127.0.0.1:3000/api/shop/status'
$backupUrl = 'http://127.0.0.1:3000/dashboard/index.html'

function Write-Log([string]$msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

function Test-Backend {
  try {
    $r = Invoke-WebRequest -Uri $checkUrl -TimeoutSec 5 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-Backend {
  if (-not (Test-Path (Join-Path $BackendDir 'server.js'))) {
    Write-Log "后端目录不存在，跳过拉起：$BackendDir"
    return
  }
  Write-Log '后端无响应，正在拉起 node server.js …'
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $BackendDir -WindowStyle Hidden
  Start-Sleep -Seconds 6
}

function Test-DashboardBrowser {
  # kiosk 浏览器带独立配置目录，用命令行参数识别，避免误判用户日常浏览器
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'"
  foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine -match 'LingdongDashboard') { return $true }
  }
  return $false
}

function Start-Dashboard {
  if (-not (Test-Path $StartScript)) { Write-Log "找不到启动脚本：$StartScript"; return }
  Write-Log '大屏浏览器未运行，正在启动 …'
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"{0}"' -f $StartScript)) -WindowStyle Hidden
}

Write-Log "看门狗启动，检查间隔 ${IntervalSec}s"
Write-Log "后端目录：$BackendDir"

while ($true) {
  if (-not (Test-Backend)) {
    Start-Backend
    if (-not (Test-Backend)) { Write-Log "后端仍未恢复（$checkUrl）" }
    else { Write-Log '后端已恢复' }
  }

  if (-not (Test-DashboardBrowser)) { Start-Dashboard }

  Start-Sleep -Seconds $IntervalSec
}
