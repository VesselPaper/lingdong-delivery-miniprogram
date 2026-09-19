/* ============================================================
   零栋送餐 · 调度台 —— 总览页校园实时地图（机器人页右侧）
   ------------------------------------------------------------
   · 底图：平台雷达地图 PNG（map.png），按平台 map 元数据做像素级对齐：
     metadata.origin = 图片左下角世界坐标(米)，resolution = 米/像素，
     width/height = 像素数。世界坐标(米) → 图像像素 线性映射，点位/路网/
     无人车/配送路线与雷达图严格对齐（不再用 bbox 外包框或经纬度近似）。
   · 点位：平台 landmarkInfo 接口的机器人自身点位（取货点/巡逻点/上货点），实时刷新
   · 交互：Leaflet CRS.Simple 像素坐标，原生拖动 + 滚轮缩放 + 「回到校园」复位
   · 数据源：/api/admin/map（adminGuard，3s 服务端缓存），4s 轮询
   ============================================================ */
(function () {
  'use strict'
  var TOKEN_KEY = 'lingdong_admin_token'
  var POLL_MS = 4000
  var HEADING_OFFSET = 90
  var $ = function (id) { return document.getElementById(id) }
  var mapObj = null
  var layers = { lms: {}, cars: {}, stops: {}, route: null, graph: null, radar: null }
  var META = null // { width, height, resolution, origin:[x,y] } 平台 map 元数据（像素映射依据）
  var lastData = null
  var fittedOnce = false

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0 }

  // 平台世界坐标(米) → 图像像素坐标 [row, col]（Leaflet CRS.Simple 的 [y, x]，y 向下）
  // CRS.Simple 中第一坐标向北为正，图片 bounds 东北角对应 PNG 第 0 行，故用 H - py 翻转
  function toPixel(x, y) {
    if (!META) return [0, 0]
    var px = (x - META.origin[0]) / META.resolution
    var py = (META.origin[1] + META.height * META.resolution - y) / META.resolution
    return [META.height - py, px]
  }
  function ll(m) { return toPixel(num(m.x), num(m.y)) }

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
        var isLoad = m.type === 'loadingPoint'
        var isPatrol = m.type === 'patrolPoint'
        mk = L.circleMarker(g, {
          radius: isLoad ? 8 : 5, weight: 2, color: '#ffffff',
          fillColor: isLoad ? '#e8890c' : isPatrol ? '#6d4bc4' : '#1d5bd6', fillOpacity: 1
        })
        mk.bindTooltip(m.name || '', { direction: 'top', offset: [0, -8], className: 'lmTip' })
        mk.addTo(mapObj)
        layers.lms[key] = mk
      } else mk.setLatLng(g)
    })
    Object.keys(layers.lms).forEach(function (k) {
      if (!seen[k]) { mapObj.removeLayer(layers.lms[k]); delete layers.lms[k] }
    })
  }

  // ---- 路网（平台固定路径 graph） ----
  function updateGraph(graph) {
    var pts = (graph && graph.nodes || []).map(ll)
    if (layers.graph) { layers.graph.setLatLngs(pts); return }
    if (!pts.length) return
    layers.graph = L.polyline(pts, { color: '#8fb1e6', weight: 2, opacity: .55 }).addTo(mapObj)
  }

  // ---- 配送路线 ----
  function updateRoutes(routes) {
    var r = (routes || []).filter(function (x) { return x && x.stops && x.stops.length > 1 })[0]
    var pts = r ? r.stops.map(ll) : []
    if (layers.route) layers.route.setLatLngs(pts)
    else if (pts.length) layers.route = L.polyline(pts, { color: '#2e7cf6', weight: 3, dashArray: '8 6' }).addTo(mapObj)
    var seenN = {}
    ;((r && r.stops) || []).forEach(function (s) {
      var key = (r ? r.batch_id : 'x') + '_' + num(s.stop)
      seenN[key] = true
      var g = ll(s)
      var mk = layers.stops[key]
      if (!mk) {
        mk = L.marker(g, {
          icon: L.divIcon({ className: 'stopWrap', html: '<span class="stopNum">' + num(s.stop) + '</span>', iconSize: [18, 18], iconAnchor: [9, 9] })
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
            html: '<span class="carArrow"></span><span class="carName">' + String(r.device_sn || '').slice(-6) + '</span>',
            iconSize: [22, 28], iconAnchor: [11, 14]
          })
        })
        mk.addTo(mapObj)
        layers.cars[r.device_sn] = mk
      } else mk.setLatLng(g)
      // 世界系 θ（弧度，逆时针为正，y 向上）→ 屏幕像素系（y 向下）后旋转方向同步翻转，
      // 与北向翻转互相抵消，仍用 deg = 90 - θ
      var deg = HEADING_OFFSET - num(r.theta) * 180 / Math.PI
      var el = mk.getElement()
      var ar = el && el.querySelector('.carArrow')
      if (ar) ar.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)'
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
    updateGraph(d.graph)
    updateRoutes(d.routes)
    updateCars(d.robots)
    var foot = $('mapFoot')
    if (foot) {
      var res = META ? ' · 雷达图 ' + META.width + '×' + META.height : ''
      foot.textContent = '点位 ' + usableLandmarks(d).length + ' 个 · 路网节点 ' + (d.graph && d.graph.nodes ? d.graph.nodes.length : 0) + ' 个 · 无人车 ' + (d.robots || []).length + ' 台'
        + res + ' · 更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    setTimeout(function () { if (mapObj) mapObj.invalidateSize() }, 60)
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

  // 排障钩子：读取当前缩放状态
  window.adminMapDebug = function () {
    if (!mapObj) return null
    return { zoom: mapObj.getZoom(), minZoom: mapObj.getMinZoom(), center: mapObj.getCenter(), size: mapObj.getSize() }
  }

  function boot() {
    wire()
    initMap()
    poll()
    setInterval(poll, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
