# 把高德校园图按校准参数"烙"进平台坐标系，输出 map-nav.png
# 这样前端仍按原来的 bbox→百分比 映射画点位/车辆，坐标对齐由构造保证，无需改前端。
#   platform bbox (前 4 个参数来自 /api/dashboard/overview)
#   S / Rot / Tx / Ty = 平台建图 → 高德图的相似变换（由 calib.ps1 标定）

param(
  [double]$S = 0.09,
  [double]$Rot = 0,
  [double]$Tx = 2333,
  [double]$Ty = 2429,
  [int]$OutW = 2200,
  [double]$Fade = 0.0,        # 可选的白色淡化（0=原样）
  [string]$OutFile = 'D:\01_Code\Personal\Software\送餐无人车\送餐无人车微信小程序\可视化大屏\map-nav.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'D:\01_Code\Personal\Software\送餐无人车\_maps'

# 平台 bbox 与平台底图像素尺寸（与 dashboard 接口一致）
$bbMinX = -36.849; $bbMaxX = 231.945; $bbMinY = -107.831; $bbMaxY = 139.007
$platW = 5776; $platH = 5537

$aspect = ($bbMaxY - $bbMinY) / ($bbMaxX - $bbMinX)     # 高/宽
$OutH = [int][Math]::Round($OutW * $aspect)
Write-Host "输出画布 ${OutW}x${OutH}（= 平台 bbox 的宽高比）"

$nav = [System.Drawing.Bitmap]::FromFile((Join-Path $dir 'amap_z18.png'))
$out = New-Object System.Drawing.Bitmap($OutW, $OutH)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::White)

# 变换链（nav 像素 → 输出像素），注意 GDI+ 是"先调用的最后作用于点"：
#   点 → (-Tx,-Ty) → 旋转(-Rot) → 缩放(1/S) → (+平台中心) → 缩放(输出/平台)
$g.ScaleTransform([float]($OutW / $platW), [float]($OutH / $platH))
$g.TranslateTransform([float]($platW / 2.0), [float]($platH / 2.0))
$g.ScaleTransform([float](1.0 / $S), [float](1.0 / $S))
$g.RotateTransform([float](-$Rot))
$g.TranslateTransform([float](-$Tx), [float](-$Ty))
$g.DrawImage($nav, 0, 0)
$g.ResetTransform()

# 可选：整体淡化，让后期叠加的蓝/橙色更跳
if ($Fade -gt 0) {
  $veil = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * $Fade), 255, 255, 255))
  $g.FillRectangle($veil, 0, 0, $OutW, $OutH)
  $g.Dispose(); $veil.Dispose()
  Write-Host ("已叠加白色淡化 " + $Fade)
}
$out.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $out.Dispose(); $nav.Dispose()
Write-Host ("已输出 " + $OutFile + "（" + [Math]::Round((Get-Item $OutFile).Length / 1KB) + " KB）")
