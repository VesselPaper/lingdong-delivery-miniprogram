/* ============================================================
   零栋送餐 · 调度台 —— 总览页校园实时地图（机器人页右侧）
   ------------------------------------------------------------
   · 底图：平台雷达地图 PNG（map.png），按平台 map 元数据做像素级对齐：
     metadata.origin = 图片左下角世界坐标(米)，resolution = 米/像素，
     width/height = 像素数。世界坐标(米) → 图像像素 线性映射，点位/路网/
     无人车/配送路线与雷达图严格对齐（不再用 bbox 外包框或经纬度近似）。
   · 点位：平台 landmarkInfo 接口的机器人自身点位（取货点/巡逻点/上货点），实时刷新
   · 交互：Leaflet CRS.Simple 像素坐标，原生拖动 + 滚轮缩放 + 「回到校园」复位
   · 数据源：初始完整底图/点位/配送站位 = /api/admin/map（adminGuard，3s 服务端缓存）一次性拉取；
    实时机器人位置 = WebSocket 推送（admin.js 收到 live 事件 → window.mapOnLive），不再轮询。
   ============================================================ */
(function () {
  'use strict'
  var TOKEN_KEY = 'lingdong_admin_token'
  var HEADING_OFFSET = 90
  var $ = function (id) { return document.getElementById(id) }
  var mapObj = null
  var layers = { lms: {}, cars: {}, stops: {}, radar: null }
  var META = null // { width, height, resolution, origin:[x,y] } 平台 map 元数据（像素映射依据）
  var lastData = null
  var mapFootBase = '' // 底栏静态部分（点位/站位/无人车数），实时心跳在其后追加
  var fittedOnce = false
  // 批次聚焦：选中某批次时高亮其配送站位并定位到该批；再次调用同一批次可取消聚焦
  var focusBatch = null
  var lastFitBatch = null
  var followCar = false      // 「跟随小车」开关：开启时自动放大并居中到小车，1米级位移也可见
  var FOLLOW_M = 6           // 跟随视野半宽（米）：约 12m×12m，1~2 米级位移也能看到明显移动
  var trailBuff = {}         // sn -> [[x,y], ...] 最近若干位置（米）
  var trails = {}            // sn -> L.polyline 小车移动轨迹

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0 }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;') }

  // 平台世界坐标(米) → 图像像素坐标 [row, col]（Leaflet CRS.Simple 的 [y, x]，y 向下）
  // CRS.Simple 中第一坐标向北为正，图片 bounds 东北角对应 PNG 第 0 行，故用 H - py 翻转
  function toPixel(x, y) {
    if (!META) return [0, 0]
    var px = (x - META.origin[0]) / META.resolution
    var py = (META.origin[1] + META.height * META.resolution - y) / META.resolution
    return [META.height - py, px]
  }
  function ll(m) { return toPixel(num(m.x), num(m.y)) }

  // 地图用矢量图标（SVG 内联，非圆点）：
  // 无人车 = 顶部俯视铲形车身（货箱 + 车头 + 天线 + 四轮），车头朝上，随航向旋转。
  var CAR_SVG = '<svg viewBox="0 0 48 48" width="34" height="34">'
    + '<path d="M24 5 L30.5 12.5 L17.5 12.5 Z" fill="#e4002b" stroke="#fff" stroke-width="1"/>'
    + '<rect x="10" y="12" width="28" height="26" rx="5" fill="#111114"/>'
    + '<rect x="10" y="12" width="28" height="26" rx="5" fill="none" stroke="#ffffff" stroke-width="1.6"/>'
    + '<path d="M10 25 H38" stroke="#ffffff" stroke-width="1.3" opacity=".45"/>'
    + '</svg>'
  // 配送站位 = 编号矢量钉（蓝色 pin + 站序），一枚放数字
  var stopSvg = function (n) {
    return '<span class="stopIco"><svg viewBox="0 0 22 28" width="22" height="28">'
      + '<path d="M11 1.5C5.8 1.5 2.2 5 2.2 9.7c0 6.3 8.8 16.8 8.8 16.8s8.8-10.5 8.8-16.8C19.8 5 16.2 1.5 11 1.5z" fill="#2e7cf6"/>'
      + '<path d="M11 1.5C5.8 1.5 2.2 5 2.2 9.7c0 6.3 8.8 16.8 8.8 16.8s8.8-10.5 8.8-16.8C19.8 5 16.2 1.5 11 1.5z" fill="none" stroke="#ffffff" stroke-width="1.6"/>'
      + '<text x="11" y="11.6" text-anchor="middle" font-family="Tahoma,\'Segoe UI\',sans-serif" font-size="9.5" font-weight="700" fill="#fff">' + n + '</text>'
      + '</svg></span>'
  }

  // ---- 初始化地图（CRS.Simple 像素坐标，雷达图为唯一底图） ----
  function initMap() {
    if (mapObj || !window.L) return
    var el = $('adminMap')
    if (!el) return
    mapObj = L.map(el, {
      crs: L.CRS.Simple,
      zoomControl: true,
      scrollWheelZoom: true,
      dragging: true,
      minZoom: -6,
      maxZoom: 19,
      attributionControl: false
    })
    var imgUrl = location.protocol === 'file:' ? 'http://127.0.0.1:3000/api/dashboard/map-image' : '/api/dashboard/map-image'
    layers.radar = L.imageOverlay(imgUrl, [[0, 0], [0, 0]], { opacity: 1, interactive: false })
    layers.radar.addTo(mapObj)
    applyRadar()
    var mask = $('mapMask')
    if (mask) mask.hidden = true
  }

  // 雷达图按元数据像素范围铺满（首次 fitBounds 展示全图，并把最小缩放锁定为全图大小）
  function applyRadar() {
    if (!mapObj || !layers.radar) return
    if (META && META.width > 0 && META.height > 0) {
      var b = [[0, 0], [META.height, META.width]]
      layers.radar.setBounds(b)
      layers.radar.setOpacity(1)
      if (!fittedOnce) {
        fittedOnce = true
        mapObj.fitBounds(b, { padding: [8, 8] })
        // 最小只能缩小到雷达图完整显示的大小
        mapObj.setMinZoom(mapObj.getZoom())
      }
    } else {
      layers.radar.setOpacity(0)
    }
  }