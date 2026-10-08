/* ============================================================
 * js/dashboard/map.js — Leaflet 实时可拖拽地图 + 标定模式
 * ------------------------------------------------------------
 * 从原 dashboard.js 的「地图」「标定」两块抽出。这两块强耦合
 * （renderMap 内部调用 initMap/renderCalib；标定复用 initMap/
 * platformToLngLat 与共享 mapObj/mapLayers），故合并为一个自洽模块，
 * 共享状态 mapObj/mapLayers/CALIB_T 锁在此闭包内、不分摊到外部。
 *
 * 依赖 window.Dash = { C, ctx, state }；需在 map3d.js / entry.js 之后加载。
 * ============================================================ */
window.Dash.map = (function (Dash) {
  'use strict'

  var $ = Dash.ctx.$, txt = Dash.ctx.txt, num = Dash.ctx.num
  // 模式常量（也供 main 判断）：
  var CALIB = /[?&]calib=1/.test(location.search)
  Dash.CALIB_MODE = CALIB

  // 标定常量（用户 ?calib=1 拖拽标定得出，2026-09-22）：
  // 平台局部坐标(米) -> WebMercator米（相似变换）-> WGS84 经纬度（匹配 OSM 底图）。
  var CALIB_T = { a: 1.184949, b: 0.339779, tx: 11599629.22, ty: 3576279.423 }

  var mapObj = null
  var mapLayers = { lms: {}, cars: {}, stops: {}, route: null, graph: null }

  /* ---------------- 坐标换算 ---------------- */

  // 平台坐标（米，自有原点）→ WGS84 经纬度 [lat, lng]
  function platformToLngLat(x, y) {
    var R = 6378137
    var qx = CALIB_T.a * x - CALIB_T.b * y + CALIB_T.tx
    var qy = CALIB_T.b * x + CALIB_T.a * y + CALIB_T.ty
    var lng = qx / R * 180 / Math.PI
    var lat = Math.atan(Math.sinh(qy / R)) * 180 / Math.PI
    return [lat, lng]
  }

  // 天地图浏览器端 tk：由后端 /api/config/tianditu 注入
  var TIANDITU_TK = null
  var TIANDITU_FETCHING = false
  function getTiandituTk() {
    if (TIANDITU_TK !== null) return Promise.resolve(TIANDITU_TK)
    if (TIANDITU_FETCHING) {
      return new Promise(function (resolve) {
        var iv = setInterval(function () {
          if (TIANDITU_TK !== null) { clearInterval(iv); resolve(TIANDITU_TK) }
        }, 100)
      })
    }
    TIANDITU_FETCHING = true
    return fetch((location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '') + '/api/config/tianditu').then(function (r) { return r.json() }).then(function (j) {
      TIANDITU_TK = (j && j.data && j.data.tk) || ''
      return TIANDITU_TK
    }).catch(function () { TIANDITU_TK = ''; return '' })
  }
  function tiandituUrl(layer, tk) {
    return 'https://t{s}.tianditu.gov.cn/' + layer + '_w/wmts?tk=' + tk +
      '&TILEMATRIXSET=w&Service=WMTS&Request=GetTile&Version=1.0.0&FORMAT=tiles' +
      '&Layer=' + layer + '&Style=default&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}'
  }

  function initMap() {
    if (mapObj || !window.L) return
    var el = $('mapBox')
    if (!el) return
    // 底图源（矢量道路图，非卫星影像）。方便切换：改动 TILE_PROVIDER 一项即可。
    var TILE_PROVIDER = 'tianditu'
    var TILE = {
      tianditu:   { name: '天地图', max: 18 },
      carto:      { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', subs: ['a', 'b', 'c', 'd'], attr: '&copy; OpenStreetMap &copy; CARTO', max: 20 },
      osm:        { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subs: ['a', 'b', 'c'], attr: '&copy; OpenStreetMap', max: 20 },
      'osm-de':   { url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', subs: [''], attr: '&copy; OpenStreetMap', max: 19 },
      'amap-vector': { url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', subs: ['1', '2', '3', '4'], attr: '&copy; 高德地图', max: 20 },
      'amap-sat': { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', subs: ['1', '2', '3', '4'], attr: '&copy; 高德地图', max: 20 }
    }
    var t = TILE[TILE_PROVIDER] || TILE.carto
    mapObj = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: true,
      maxZoom: 20,
      attributionControl: false
    })
    if (TILE_PROVIDER === 'tianditu') {
      getTiandituTk().then(function (tk) {
        if (!tk || !mapObj) { txt($('mapTip'), '天地图密钥未配置（backend/.env 的 TIANDITU_TK），自动使用备用底图'); startFallbackTiles(); return }
        L.tileLayer(tiandituUrl('vec', tk), { subdomains: '01234567', maxNativeZoom: 18, maxZoom: 20 }).addTo(mapObj)
        L.tileLayer(tiandituUrl('cva', tk), { subdomains: '01234567', maxNativeZoom: 18, maxZoom: 20 }).addTo(mapObj)
      })
      return
    }
    var FALLBACK_CHAIN = ['osm-de', 'amap-vector']
    var fallbackIdx = 0
    var tileEverOk = false
    var tileErrCount = 0
    var tileLayer = L.tileLayer(t.url, { subdomains: t.subs, maxZoom: t.max, attribution: t.attr })
    function onTileLoad() { tileEverOk = true }
    function onTileError() {
      if (tileEverOk) return
      tileErrCount++
      if (tileErrCount < 3) return
      if (fallbackIdx >= FALLBACK_CHAIN.length) return
      var fb = TILE[FALLBACK_CHAIN[fallbackIdx]]
      fallbackIdx++
      if (!fb) return
      try { mapObj.removeLayer(tileLayer) } catch (e) {}
      tileLayer = L.tileLayer(fb.url, { subdomains: fb.subs, maxZoom: fb.max, attribution: fb.attr })
      tileEverOk = false
      tileErrCount = 0
      tileLayer.on('tileload', onTileLoad)
      tileLayer.on('tileerror', onTileError)
      tileLayer.addTo(mapObj)
      console.warn('[map] 底图源连续加载失败，已自动切换为 ' + FALLBACK_CHAIN[fallbackIdx - 1])
    }
    tileLayer.on('tileload', onTileLoad)
    tileLayer.on('tileerror', onTileError)
    tileLayer.addTo(mapObj)

    function startFallbackTiles() {
      var tl = L.tileLayer(TILE['osm-de'].url, { subdomains: TILE['osm-de'].subs, maxZoom: TILE['osm-de'].max, attribution: TILE['osm-de'].attr })
      var ever = false, errs = 0
      tl.on('tileload', function () { ever = true })
      tl.on('tileerror', function () {
        if (ever) return
        if (++errs < 3) return
        try { mapObj.removeLayer(tl) } catch (e) {}
        var fb2 = TILE['amap-vector']
        L.tileLayer(fb2.url, { subdomains: fb2.subs, maxZoom: fb2.max, attribution: fb2.attr }).addTo(mapObj)
        console.warn('[map] 天地图密钥缺失且 osm-de 连续失败，已降级为高德矢量')
      })
      tl.addTo(mapObj)
    }
    mapObj.setView(platformToLngLat(0, 15), Math.min(18, t.max))
    if (!CALIB) el.classList.add('map-digital')
    var mask = $('mapMask')
    if (mask) mask.hidden = true
    var reset = $('mapReset')
    if (reset) reset.hidden = false
  }

  function mapResized() { if (mapObj) setTimeout(function () { mapObj.invalidateSize() }, 60) }

  function resetView() { if (mapObj) mapObj.setView(platformToLngLat(0, 15), 18) }

  function llList(pts) {
    var out = []
    ;(pts || []).forEach(function (p) { if (isFinite(num(p.x)) && isFinite(num(p.y))) out.push(platformToLngLat(num(p.x), num(p.y))) })
    return out
  }

  function usableLandmarks(map) {
    return ((map && map.landmarks) || []).filter(function (m) {
      return !/固定路径/.test(String(m.name || ''))
    })
  }

  function updateLandmarks(map) {
    var lms = usableLandmarks(map)
    var seen = {}
    lms.forEach(function (m) {
      var key = m.id || m.name
      seen[key] = true
      var ll = platformToLngLat(num(m.x), num(m.y))
      var mk = mapLayers.lms[key]
      if (!mk) {
        var isLoad = m.type === 'loadingPoint'
        mk = L.circleMarker(ll, { radius: isLoad ? 8 : 5, weight: 2, color: '#ffffff', fillColor: isLoad ? '#ffb020' : '#5aff86', fillOpacity: 1 })
        mk.bindTooltip(m.name || '', { direction: 'top', offset: [0, -8], className: 'lmTip' })
        mk.addTo(mapObj)
        mapLayers.lms[key] = mk
      } else mk.setLatLng(ll)
    })
    Object.keys(mapLayers.lms).forEach(function (k) { if (!seen[k]) { mapObj.removeLayer(mapLayers.lms[k]); delete mapLayers.lms[k] } })
  }

  function updateGraph(graph) {
    var pts = llList(graph && graph.nodes)
    if (mapLayers.graph) { mapLayers.graph.setLatLngs(pts); return }
    if (!pts.length) return
    mapLayers.graph = L.polyline(pts, { color: '#45d0ff', weight: 2.5, opacity: .85 }).addTo(mapObj)
  }

  function updateRoutes(routes) {
    var r = (routes || []).filter(function (x) { return x && x.stops && x.stops.length > 1 })[0]
    var pts = r ? llList(r.stops) : []
    if (mapLayers.route) mapLayers.route.setLatLngs(pts)
    else if (pts.length) mapLayers.route = L.polyline(pts, { color: '#66f0ff', weight: 3, dashArray: '8 6' }).addTo(mapObj)
    var seenN = {}
    ;((r && r.stops) || []).forEach(function (s) {
      var key = 's' + r.batch_id + '_' + num(s.stop)
      seenN[key] = true
      var ll = platformToLngLat(num(s.x), num(s.y))
      var mk = mapLayers.stops[key]
      if (!mk) {
        mk = L.marker(ll, { icon: L.divIcon({ className: 'stopWrap', html: '<span class="stopNum">' + num(s.stop) + '</span>', iconSize: [18, 18], iconAnchor: [9, 9] }) })
        mk.addTo(mapObj)
        mapLayers.stops[key] = mk
      } else mk.setLatLng(ll)
    })
    Object.keys(mapLayers.stops).forEach(function (k) { if (!seenN[k]) { mapObj.removeLayer(mapLayers.stops[k]); delete mapLayers.stops[k] } })
  }

  function updateCars(robots) {
    var seen = {}
    ;(robots || []).forEach(function (r) {
      var ll = platformToLngLat(num(r.x), num(r.y))
      seen[r.device_sn] = true
      var mk = mapLayers.cars[r.device_sn]
      if (!mk) {
        mk = L.marker(ll, { icon: L.divIcon({ className: 'carWrap', html: '<span class="carArrow"></span><span class="carName">' + String(r.device_sn || '').slice(-6) + '</span>', iconSize: [22, 26], iconAnchor: [11, 13] }) })
        mk.addTo(mapObj)
        mapLayers.cars[r.device_sn] = mk
      } else mk.setLatLng(ll)
      var deg = Dash.C.HEADING_OFFSET - num(r.theta) * 180 / Math.PI
      var el = mk.getElement()
      var ar = el && el.querySelector('.carArrow')
      if (ar) ar.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)'
    })
    Object.keys(mapLayers.cars).forEach(function (sn) { if (!seen[sn]) { mapObj.removeLayer(mapLayers.cars[sn]); delete mapLayers.cars[sn] } })
  }

  function renderMap(d) {
    var map = d.map
    if (CALIB) { if (!map) return; initMap(); renderCalib(map); return }
    if (window.Map3D) {
      Map3D.ensure()
      Map3D.update(map || null, d)
      var DEMO = Dash.DEMO_MODE
      if (DEMO && !Dash.state.demoCarsOn) { Dash.state.demoCarsOn = true; Map3D.setOpts({ demoCars: true }) }
      if (map) txt($('mapTip'), '立体地图 · ' + (map.landmarks || []).length + ' 个点位 · ' + (map.robots || []).length + ' 台车')
      return
    }
    if (!map) return
    if (window.RadarMap) {
      RadarMap.ensure()
      RadarMap.update(map)
      var mask2 = $('mapMask'); if (mask2) mask2.hidden = true
      txt($('mapTip'), '雷达地图 · ' + (map.landmarks || []).length + ' 个点位 · ' + (map.graph && map.graph.nodes ? map.graph.nodes.length : 0) + ' 个路网节点')
      return
    }
    initMap()
    var mask = $('mapMask')
    if (!mapObj) { if (mask) { txt(mask, '地图组件加载失败（vendor/leaflet.js 缺失）'); mask.hidden = false } return }
    updateLandmarks(map)
    updateGraph(map.graph)
    updateRoutes(map.routes)
    updateCars(map.robots)
    txt($('mapTip'), (map.landmarks || []).length + ' 个点位 · ' + (map.graph && map.graph.nodes ? map.graph.nodes.length : 0) + ' 个路网节点')
    mapResized()
  }

  /* ---------------- 标定（?calib=1） ---------------- */

  var R_EARTH = 6378137
  var calibPairs = []
  var calibMarks = {}
  var calibT = null

  function merc(lat, lng) {
    return { x: R_EARTH * lng * Math.PI / 180, y: R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) }
  }
  function mercToLngLat(m) {
    return [Math.atan(Math.sinh(m.y / R_EARTH)) * 180 / Math.PI, m.x / R_EARTH * 180 / Math.PI]
  }
  function solveLinear(M, v) {
    var n = 4, a = [], i, k, j
    M.forEach(function (row) { a.push(row.slice()) })
    var b = v.slice()
    for (i = 0; i < n; i++) {
      var p = i
      for (k = i + 1; k < n; k++) if (Math.abs(a[k][i]) > Math.abs(a[p][i])) p = k
      if (Math.abs(a[p][i]) < 1e-12) return [0, 0, 0, 0]
      if (p !== i) { var t = a[p]; a[p] = a[i]; a[i] = t; t = b[p]; b[p] = b[i]; b[i] = t }
      var piv = a[i][i]
      for (k = i; k < n; k++) a[i][k] /= piv
      b[i] /= piv
      for (k = 0; k < n; k++) if (k !== i && a[k][i] !== 0) {
        var f = a[k][i]
        for (j = i; j < n; j++) a[k][j] -= f * a[i][j]
        b[k] -= f * b[i]
      }
    }
    return b
  }
  function solveSimilarity(pts) {
    var M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], v = [0, 0, 0, 0]
    pts.forEach(function (p) {
      var r1 = [p.px, -p.py, 1, 0], r2 = [p.py, p.px, 0, 1]
      var rhs = [p.mx, p.my]
      for (var idx = 0; idx < 2; idx++) {
        var row = r1, r = rhs[0]; if (idx === 1) { row = r2; r = rhs[1] }
        for (var i = 0; i < 4; i++) { for (var j = 0; j < 4; j++) M[i][j] += row[i] * row[j]; v[i] += row[i] * r }
      }
    })
    var x = solveLinear(M, v)
    return { a: x[0], b: x[1], tx: x[2], ty: x[3] }
  }

  function calibPanel() {
    var st = document.createElement('style')
    st.textContent = '.cbmark{border-radius:50%;background:#e02020;color:#fff;text-align:center;line-height:22px;font-size:12px;width:24px;height:24px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)}.cbmark.done{background:#20a04a}'
    document.head.appendChild(st)
    var p = document.createElement('div')
    p.id = 'calibPanel'
    p.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1200;background:#fff;border:1px solid #99b3dd;padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.18);font-size:13px;color:#222;width:680px;max-width:94%;'
    p.innerHTML = '<b>标定模式</b>：把红色圆点(<b>点位</b>)一个一个拖到它在地图上的<b>真实位置</b>（该栋/铺子的实际门口）。' +
      '<br>至少拖 <b>3</b> 个、建议 <b>4~6</b> 个分散点，然后点「计算新变换」，下方会输出参数（把它发给我写进代码）。' +
      '<br><span style="color:#888">拖动后圆点会变绿并编上号。刷新页面可重新开始。</span>' +
      '<div style="margin-top:4px"><button id="calibCalc" style="margin-right:8px;padding:4px 12px">计算新变换</button>' +
      '<button id="calibReset" style="padding:4px 12px">重置本页拖动</button></div>' +
      '<pre id="calibOut" style="margin:6px 0 0;white-space:pre-wrap;font-size:12px;max-height:170px;overflow:auto;background:#f7f9fc;padding:6px;border-radius:6px">（先把圆点拖到真实位置，再点计算）</pre>'
    var box = $('mapBox')
    if (box) box.insertAdjacentElement('afterend', p)
    p.querySelector('#calibCalc').onclick = function () {
      var o = p.querySelector('#calibOut')
      if (calibPairs.length < 3) { o.textContent = '需要至少 3 个点，当前已拖 ' + calibPairs.length + ' 个。'; return }
      calibT = solveSimilarity(calibPairs)
      o.textContent =
        '已用 ' + calibPairs.length + ' 个点。变换：qx=a*px-b*py+tx ; qy=b*px+a*py+ty （px,py=平台局部坐标米，q=WebMercator米）\n' +
        'a=' + calibT.a.toFixed(6) + '  b=' + calibT.b.toFixed(6) + '  tx=' + calibT.tx.toFixed(3) + '  ty=' + calibT.ty.toFixed(3)
      calibPairs.forEach(function (pr) {
        var ll = mercToLngLat({ x: calibT.a * pr.px - calibT.b * pr.py + calibT.tx, y: calibT.b * pr.px + calibT.a * pr.py + calibT.ty })
        var mk = calibMarks[pr.src]
        if (mk) mk.setLatLng(L.latLng(ll[0], ll[1]))
      })
    }
    p.querySelector('#calibReset').onclick = function () {
      calibPairs = []
      var i = 0
      Object.keys(calibMarks).forEach(function (k) {
        var mk = calibMarks[k]
        mk.setIcon(L.divIcon({ className: 'cbmark', html: '<b>' + (++i) + '</b>', iconSize: [24, 24], iconAnchor: [12, 12] }))
      })
      p.querySelector('#calibOut').textContent = '已重置'
    }
  }

  function renderCalib(map) {
    initMap()
    if (!mapObj) return
    var lms = (map.landmarks || []).filter(function (m) {
      return isFinite(num(m.x)) && isFinite(num(m.y)) && !/固定路径|商铺上货|充电点|排队点/.test(String(m.name || ''))
    })
    if (!calibPanel.x) { calibPanel(); calibPanel.x = true }
    lms.forEach(function (m) {
      var key = String(m.id != null ? m.id : m.name)
      if (calibMarks[key]) return
      var g = platformToLngLat(num(m.x), num(m.y))
      var mk = L.marker([g[0], g[1]], {
        draggable: true,
        icon: L.divIcon({ className: 'cbmark', html: '<b>' + (Object.keys(calibMarks).length + 1) + '</b>', iconSize: [24, 24], iconAnchor: [12, 12] })
      })
      mk.bindTooltip(String(m.name), { direction: 'top' })
      mk.on('dragend', function () {
        var g2 = mk.getLatLng(), q = merc(g2.lat, g2.lng)
        calibPairs.push({ src: key, px: num(m.x), py: num(m.y), mx: q.x, my: q.y })
        var n = calibPairs.length
        mk.setIcon(L.divIcon({ className: 'cbmark done', html: '<b>' + n + '</b>', iconSize: [24, 24], iconAnchor: [12, 12] }))
        mk.bindTooltip(String(m.name) + ' ✓', { direction: 'top' })
        var o = document.getElementById('calibOut')
        if (o) o.textContent = '已拖 ' + n + ' 个点（建议 4~6 个再计算）'
      })
      mk.addTo(mapObj)
      calibMarks[key] = mk
    })
    var pts = lms.map(function (m) { return platformToLngLat(num(m.x), num(m.y)) })
    if (pts.length) mapObj.fitBounds(L.latLngBounds(pts.map(function (g) { return [g[0], g[1]] })))
  }

  return {
    initMap: initMap, mapResized: mapResized, renderMap: renderMap, resetView: resetView,
    get calibMode() { return CALIB }, isReady: function () { return !!mapObj }
  }
})(window.Dash)