# 校园导航地图瓦片抓取 + 拼接
# 说明：
#  · 高德(autonavi)瓦片用的是 GCJ-02 坐标系，必须先把 WGS84 坐标换算成 GCJ-02 再算瓦片号，
#    否则整张图会偏 ~500m。
#  · 瓦片仅用于校内演示大屏的底图，版权归各自地图服务商，正式对外发布前请换成自有/已授权地图。

param(
  [string]$OutDir = 'D:\01_Code\Personal\Software\送餐无人车\_maps',
  [int]$Zoom = 17,
  [int]$Margin = 1,
  [string]$Source = 'amap',        # amap | osm | both
  [int]$TimeoutSec = 15,
  [int]$Retry = 2
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$log = Join-Path $OutDir 'fetch.log'
function Log($m) {
  $line = ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m)
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}
Log "开始：Zoom=$Zoom Source=$Source"

# ---------- 坐标系换算 ----------
function OutOfChina([double]$lat, [double]$lon) { return ($lon -lt 72.004 -or $lon -gt 137.8347 -or $lat -lt 0.8293 -or $lat -gt 55.8271) }
function TransformLat([double]$x, [double]$y) {
  $r = -100.0 + 2.0 * $x + 3.0 * $y + 0.2 * $y * $y + 0.1 * $x * $y + 0.2 * [Math]::Sqrt([Math]::Abs($x))
  $r += (20.0 * [Math]::Sin(6.0 * $x * [Math]::PI) + 20.0 * [Math]::Sin(2.0 * $x * [Math]::PI)) * 2.0 / 3.0
  $r += (20.0 * [Math]::Sin($y * [Math]::PI) + 40.0 * [Math]::Sin($y / 3.0 * [Math]::PI)) * 2.0 / 3.0
  $r += (160.0 * [Math]::Sin($y / 12.0 * [Math]::PI) + 320.0 * [Math]::Sin($y * [Math]::PI / 30.0)) * 2.0 / 3.0
  return $r
}
function TransformLon([double]$x, [double]$y) {
  $r = 300.0 + $x + 2.0 * $y + 0.1 * $x * $x + 0.1 * $x * $y + 0.1 * [Math]::Sqrt([Math]::Abs($x))
  $r += (20.0 * [Math]::Sin(6.0 * $x * [Math]::PI) + 20.0 * [Math]::Sin(2.0 * $x * [Math]::PI)) * 2.0 / 3.0
  $r += (20.0 * [Math]::Sin($x * [Math]::PI) + 40.0 * [Math]::Sin($x / 3.0 * [Math]::PI)) * 2.0 / 3.0
  $r += (150.0 * [Math]::Sin($x / 12.0 * [Math]::PI) + 300.0 * [Math]::Sin($x / 30.0 * [Math]::PI)) * 2.0 / 3.0
  return $r
}
function ToGcj02([double]$lat, [double]$lon) {
  if (OutOfChina $lat $lon) { return @($lat, $lon) }
  $a = 6378245.0
  $ee = 0.00669342162296594323
  $dlat = TransformLat ($lon - 105.0) ($lat - 35.0)
  $dlon = TransformLon ($lon - 105.0) ($lat - 35.0)
  $radlat = $lat / 180.0 * [Math]::PI
  $magic = 1 - $ee * [Math]::Sin($radlat) * [Math]::Sin($radlat)
  $sq = [Math]::Sqrt($magic)
  $dlat = ($dlat * 180.0) / (($a * (1 - $ee)) / ($magic * $sq) * [Math]::PI)
  $dlon = ($dlon * 180.0) / ($a / $sq * [Math]::Cos($radlat) * [Math]::PI)
  return @(($lat + $dlat), ($lon + $dlon))
}
function TileX([double]$lon, [int]$z) { return [int][Math]::Floor((($lon + 180.0) / 360.0) * [Math]::Pow(2, $z)) }
function TileY([double]$lat, [int]$z) {
  $r = $lat / 180.0 * [Math]::PI
  return [int][Math]::Floor((1.0 - [Math]::Log([Math]::Tan($r) + 1.0 / [Math]::Cos($r)) / [Math]::PI) / 2.0 * [Math]::Pow(2, $z))
}

# 校园 bbox（WGS84，来自 Nominatim）
$latS = 30.5619; $latN = 30.5742; $lonW = 104.1925; $lonE = 104.2068

function FetchLayer([string]$name, [double]$laS, [double]$laN, [double]$loW, [double]$loE, [int]$z, [string]$tpl) {
  $x0 = (TileX $loW $z) - $Margin; $x1 = (TileX $loE $z) + $Margin
  $y0 = (TileY $laN $z) - $Margin; $y1 = (TileY $laS $z) + $Margin
  $cols = $x1 - $x0 + 1; $rows = $y1 - $y0 + 1
  $total = $cols * $rows
  Log "$name : z=$z 瓦片 $cols x $rows = $total 张（x $x0..$x1, y $y0..$y1）"
  $bmp = New-Object System.Drawing.Bitmap(($cols * 256), ($rows * 256))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $ok = 0; $fail = 0; $i = 0
  for ($ty = $y0; $ty -le $y1; $ty++) {
    for ($tx = $x0; $tx -le $x1; $tx++) {
      $i++
      $u = $tpl.Replace('{z}', "$z").Replace('{x}', "$tx").Replace('{y}', "$ty")
      $f = Join-Path $env:TEMP ("tile_${name}_${tx}_${ty}.png")
      $got = $false
      for ($try = 1; $try -le $Retry -and -not $got; $try++) {
        try {
          Invoke-WebRequest -Uri $u -OutFile $f -Headers @{ 'User-Agent' = 'Mozilla/5.0' } -TimeoutSec $TimeoutSec
          if ((Get-Item $f).Length -gt 200) { $got = $true }
        } catch { Start-Sleep -Milliseconds 300 }
      }
      if ($got) {
        try {
          $tb = [System.Drawing.Bitmap]::FromFile($f)
          $g.DrawImage($tb, (($tx - $x0) * 256), (($ty - $y0) * 256))
          $tb.Dispose(); $ok++
        } catch { $fail++ }
      } else { $fail++ }
      Remove-Item $f -Force -ErrorAction SilentlyContinue
      if ($i % 20 -eq 0) { Log "  $name 进度 $i/$total（成功 $ok 失败 $fail）" }
    }
  }
  $g.Dispose()
  $path = Join-Path $OutDir ($name + "_z$z.png")
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Log "$name 完成：成功 $ok / 失败 $fail -> $path（${cols}x${rows} 瓦片）"
}

if ($Source -eq 'amap' -or $Source -eq 'both') {
  $c = ToGcj02 (($latS + $latN) / 2.0) (($lonW + $lonE) / 2.0)
  $dLat = $c[0] - (($latS + $latN) / 2.0)
  $dLon = $c[1] - (($lonW + $lonE) / 2.0)
  Log ("GCJ-02 偏移：dLat=" + [Math]::Round($dLat, 6) + " dLon=" + [Math]::Round($dLon, 6))
  $tpl = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
  # 轮询 1..4 子域，降低单域名限流概率
  $tpl = $tpl.Replace('{s}', '1')
  FetchLayer 'amap' ($latS + $dLat) ($latN + $dLat) ($lonW + $dLon) ($lonE + $dLon) $Zoom $tpl
}
if ($Source -eq 'osm' -or $Source -eq 'both') {
  FetchLayer 'osm' $latS $latN $lonW $lonE $Zoom 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
}
Log '全部结束'
