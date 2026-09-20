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

  // ---- 点位（机器人自身点位，来自平台 landmarkInfo） ----
  function usableLandmarks(map) {
    return (map.landmarks || []).filter(function (m) { return !/固定路径/.test(String(m.name || '')) })
  }
  function updateLandmarks(map) {
    var lms = usableLandmarks(map)
    var seen = {}
    lms.forEach(function (m) {
      var key = m.id != null ? m.id : m.name
      seen[key] = true
      var g = ll(m)
      var mk = layers.lms[key]
      if (!mk) {
        var isPatrol = m.type === 'patrolPoint'
        if (isPatrol) {
          // 巡逻点：保留悬停泡泡
          mk = L.circleMarker(g, { radius: 5, weight: 2, color: '#ffffff', fillColor: '#6d4bc4', fillOpacity: 1 })
          mk.bindTooltip(m.name || '', { direction: 'top', offset: [0, -8], className: 'lmTip' })
        } else {
          // 取货点/上货点/充电点：色点 + 名字文字整体渲染在标记上，名字必然常驻可见
          var color = m.type === 'loadingPoint' ? '#e8890c' : m.type === 'chargePoint' ? '#2f9e44' : '#1d5bd6'
          var html = '<i class="lmDot" style="background:' + color + '"></i><b class="lmName">' + esc(m.name || '') + '</b>'
          mk = L.marker(g, { icon: L.divIcon({ className: 'lmWrap x' + m.type, html: html, iconAnchor: [6, 8] }) })
        }
        mk.addTo(mapObj)
        layers.lms[key] = mk
      } else {
        mk.setLatLng(g)
        if (mk.getTooltip && mk.getTooltip() && m.name) mk.setTooltipContent(m.name)
      }
    })
    Object.keys(layers.lms).forEach(function (k) {
      if (!seen[k]) { mapObj.removeLayer(layers.lms[k]); delete layers.lms[k] }
    })
  }

  // ---- 配送站位（车将前往的配送点，按停靠顺序编号；不再画配送连线/路网连线） ----
  function updateRoutes(routes) {
    var r = (routes || []).filter(function (x) { return x && x.stops && x.stops.length > 0 })[0]
    var seenN = {}
    ;((r && r.stops) || []).forEach(function (s) {
      var key = (r ? r.batch_id : 'x') + '_' + num(s.stop)
      seenN[key] = true
      var g = ll(s)
      var mk = layers.stops[key]
      if (!mk) {
        mk = L.marker(g, {
          icon: L.divIcon({ className: 'stopWrap', html: stopSvg(num(s.stop)), iconSize: [22, 28], iconAnchor: [11, 28] })
        })
        mk.addTo(mapObj)
        layers.stops[key] = mk
      } else mk.setLatLng(g)
    })
    Object.keys(layers.stops).forEach(function (k) {
      if (!seenN[k]) { mapObj.removeLayer(layers.stops[k]); delete layers.stops[k] }
    })
  }

  // ---- 无人车（实时位置 + 朝向箭头） ----
  function updateCars(robots) {
    var seen = {}
    ;(robots || []).forEach(function (r) {
      var g = ll(r)
      seen[r.device_sn] = true
      var mk = layers.cars[r.device_sn]
      if (!mk) {
        mk = L.marker(g, {
          icon: L.divIcon({
            className: 'carWrap',
            html: '<span class="carSvg">' + CAR_SVG + '</span><span class="carName">' + String(r.device_sn || '').slice(-6) + '</span>',
            iconSize: [34, 40], iconAnchor: [17, 17]
          })
        })
        mk.addTo(mapObj)
        layers.cars[r.device_sn] = mk
      } else mk.setLatLng(g)
      // 世界系 θ（弧度，逆时针为正，y 向上）→ 屏幕像素系（y 向下）后旋转方向同步翻转，
      // 与北向翻转互相抵消，仍用 deg = 90 - θ
      var deg = HEADING_OFFSET - num(r.theta) * 180 / Math.PI
      var el = mk.getElement()
      var cs = el && el.querySelector('.carSvg')
      if (cs) cs.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)'
      if (r.text && mk.getTooltip && !mk.getTooltip()) {
        mk.bindTooltip(r.text, { direction: 'top', className: 'lmTip' })
      } else if (r.text && mk.getTooltip && mk.getTooltip()) {
        mk.setTooltipContent(r.text)
      }
    })
    Object.keys(layers.cars).forEach(function (sn) {
      if (!seen[sn]) { mapObj.removeLayer(layers.cars[sn]); delete layers.cars[sn] }
    })
  }

  // ---- 批次聚焦：高亮指定批次配送站位（其余降透明度），并定位到该批 ----
  function applyRouteFocus() {
    if (!mapObj) return
    var has = false
    var pts = []
    Object.keys(layers.stops).forEach(function (key) {
      var bid = String(key).split('_')[0]
      var on = focusBatch && String(bid) === String(focusBatch)
      if (on) has = true
      var mk = layers.stops[key]
      var el = mk && mk.getElement ? mk.getElement() : null
      if (el) { el.style.opacity = on ? '1' : '0.22'; el.classList.toggle('focusStop', !!on) }
      if (on) pts.push(mk.getLatLng())
    })
    if (focusBatch && has && lastFitBatch !== focusBatch) {
      lastFitBatch = focusBatch
      mapObj.fitBounds(pts, { padding: [55, 55] })
    } else if (!focusBatch) {
      lastFitBatch = null
    }
  }
  window.highlightBatchDetail = function (batchId) {
    focusBatch = batchId === undefined || batchId === null ? null : String(batchId)
    applyRouteFocus()
  }
  window.clearBatchFocus = function () { highlightBatchDetail(null) }

  // ---- 渲染一轮 ----
  function renderMap(d) {
    initMap()
    var mask = $('mapMask')
    if (!mapObj) {
      if (mask) { mask.innerHTML = '<span class="spinner"></span><span>地图组件加载失败</span>'; mask.hidden = false }
      return
    }
    if (!d) return
    if (d.meta) META = d.meta
    lastData = d
    applyRadar()
    updateLandmarks(d)
    updateRoutes(d.routes)
    updateCars(d.robots)
    var foot = $('mapFoot')
    if (foot) {
      var res = META ? ' · 雷达图 ' + META.width + '×' + META.height : ''
      var stopsN = (d.routes || []).reduce(function (s, x) { return s + (((x && x.stops) || []).length) }, 0)
      mapFootBase = '点位 ' + usableLandmarks(d).length + ' 个 · 配送站位 ' + stopsN + ' 个 · 无人车 ' + (d.robots || []).length + ' 台' + res
      foot.textContent = mapFootBase + ' · 更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    setTimeout(function () { if (mapObj) mapObj.invalidateSize() }, 60)
    applyRouteFocus()
  }

  function setMask(text, show) {
    var mask = $('mapMask')
    if (!mask) return
    if (show) { mask.innerHTML = '<span class="spinner"></span><span>' + text + '</span>'; mask.hidden = false }
    else mask.hidden = true
  }

  // ---- 轮询 ----
  function poll() {
    var tk = localStorage.getItem(TOKEN_KEY)
    if (!tk) { setMask('等待令牌…', true); return }
    if (!mapObj) initMap()
    fetch('/api/admin/map', { headers: { 'x-admin-token': tk }, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '地图获取失败')
        setMask('', false)
        renderMap(j.data)
      })
      .catch(function (e) {
        if (String(e && e.message).indexOf('令牌') >= 0 || (e && e.message === '管理员令牌无效')) { setMask('令牌无效', true); return }
        setMask('地图数据获取失败', true)
        var foot = $('mapFoot')
        if (foot) foot.textContent = '地图获取失败：' + (e && e.message ? e.message : '网络错误')
      })
  }

  // ---- 控件绑定 ----
  function wire() {
    var rt = $('mapResetBtn')
    if (rt) rt.addEventListener('click', function () {
      if (!mapObj) return
      if (META && META.width > 0) mapObj.fitBounds([[0, 0], [META.height, META.width]], { padding: [8, 8] })
      else mapObj.setView([0, 0], 1)
    })
    window.addEventListener('resize', function () { if (mapObj) setTimeout(function () { mapObj.invalidateSize() }, 80) })
  }

  // 供总览页标签切回机器人页时刷新地图尺寸
  window.invalidateAdminMap = function () {
    if (mapObj) setTimeout(function () { mapObj.invalidateSize() }, 60)
  }

  // 事件驱动：实时位置由后端推送（admin.js 收到 live 事件后调用本函数），原地只更新小车，不整体重拉。
  window.mapOnLive = function (robots) {
    if (!mapObj || !META) return // 底图/元数据未就绪，先等完整地图（初次加载 + WS 重连时 reloadAdminMap）
    var arr = Array.isArray(robots) ? robots : []
    if (arr.length) mapFollowTarget = arr[0]
    updateCars(arr)
    trackCar(arr)
    if (followCar && mapFollowTarget) {
      var c = ll(mapFollowTarget)
      // 首次进入：按 FOLLOW_M 放大并居中到小车（之后不再强制定位中心）
      if (mapObj.getZoom() < mapFollowZoom) {
        mapObj.fitBounds([[c[0] - padPx, c[1] - padPx], [c[0] + padPx, c[1] + padPx]], { animate: false })
      } else {
        // 「边沿跟随」：小车在中部约 33% 安全区时保持不动，让它先在视野里真实跑动；
        // 只有驶出安全区（接近边缘）才平滑平移追过去，避免「永远钉在屏幕中心→看着像没动」。
        var pt = mapObj.latLngToContainerPoint(L.latLng(c))
        var ctr = mapObj.getSize().divideBy(2)
        var limX = mapObj.getSize().x * 0.33
        var limY = mapObj.getSize().y * 0.33
        if (Math.abs(pt.x - ctr.x) > limX || Math.abs(pt.y - ctr.y) > limY) {
          mapObj.panTo(c, { animate: true })
        }
      }
    }
    // 实时心跳：每次 live 事件刷新「时间戳 + 各车坐标」，直观确认位置在刷
    var foot = $('mapFoot')
    if (foot) {
      var t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      var live = arr.map(function (r) { return '#' + String(r.device_sn || '').slice(-4) + '=' + num(r.x).toFixed(1) + ',' + num(r.y).toFixed(1) }).join('; ')
      foot.innerHTML = '<span class="live-dot"></span>' + esc((mapFootBase || '') + ' · 实时位置 ' + t + (live ? ' [' + live + ']' : ''))
    }
  }

  // ---- 跟随小车：读取第一次放大倍数后只居中不平移视野；DELETE 掉旧 target 确保跟随正确 ----
  var mapFollowTarget = null
  var mapFollowZoom = 0
  var padPx = 0
  function ensureFollowBtn() {
    if (document.getElementById('followCarBtn') || !mapObj) return
    var b = document.createElement('button')
    b.id = 'followCarBtn'; b.type = 'button'; b.className = 'followBtn'
    b.textContent = '跟随小车'
    b.addEventListener('click', function () {
      followCar = !followCar
      b.classList.toggle('on', followCar)
      b.textContent = followCar ? '跟随中·取消' : '跟随小车'
      if (followCar && mapFollowTarget && META) {
        padPx = Math.round((FOLLOW_M / META.resolution) / 2) // FOLLOW_M(米) 一半对应多少像素
        mapFollowZoom = (mapObj.getZoom() || 0) + 1
        var c = ll(mapFollowTarget)
        mapObj.fitBounds([[c[0] - padPx, c[1] - padPx], [c[0] + padPx, c[1] + padPx]], { animate: false })
      }
    })
    mapObj.getContainer().appendChild(b)
  }

  // 记录每台车最近位置，画轨迹（即使小位移也能看出在实时推进）
  function trackCar(arr) {
    arr.forEach(function (r) {
      var sn = r.device_sn
      if (!sn) return
      var b = trailBuff[sn] = (trailBuff[sn] || [])
      b.push([num(r.x), num(r.y)])
      if (b.length > 80) b.shift()
      if (b.length >= 2) {
        var pts = b.map(function (p) { return ll({ x: p[0], y: p[1] }) })
        if (!trails[sn]) trails[sn] = L.polyline(pts, { color: '#2f9e44', weight: 2, opacity: .55, dashArray: '4 6' }).addTo(mapObj)
        else trails[sn].setLatLngs(pts)
      }
    })
  }

  // WS 重连/初次加载时拉一次完整地图（点位/路网/配送站位/元数据）；之后实时位置走 mapOnLive。
  window.reloadAdminMap = function () { poll() }

  // 排障钩子：读取当前缩放状态
  window.adminMapDebug = function () {
    if (!mapObj) return null
    return { zoom: mapObj.getZoom(), minZoom: mapObj.getMinZoom(), center: mapObj.getCenter(), size: mapObj.getSize() }
  }

  function boot() {
    wire()
    initMap()
    ensureFollowBtn()
    // 初次加载拉一次完整地图（底图/点位/配送站位）；实时位置之后由 WS 推送（admin.mapOnLive），不再 4s 轮询。
    poll()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()