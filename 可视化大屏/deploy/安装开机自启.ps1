# 零栋无人送餐 · 大屏开机自启安装脚本
#
# 作用：注册一个「登录时自动运行」的计划任务，登录后自动跑看门狗（看门狗再负责后端 + 大屏）。
# 说明：需要管理员权限运行（注册计划任务）。卸载见文件末尾注释。

$ErrorActionPreference = 'Stop'

$taskName = 'LingdongDashboardKiosk'
$watchdog = Join-Path $PSScriptRoot '看门狗.ps1'

if (-not (Test-Path $watchdog)) {
  Write-Host "找不到看门狗脚本：$watchdog" -ForegroundColor Red
  exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '零栋无人送餐数据大屏：登录后自动启动看门狗（后端 + kiosk 浏览器）' -Force | Out-Null

Write-Host "已注册计划任务：$taskName" -ForegroundColor Green
Write-Host "立即试运行：Start-ScheduledTask -TaskName $taskName"
Write-Host "查看状态：  Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo"
Write-Host "卸载：      Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
