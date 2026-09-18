/* ============================================================
   零栋无人送餐 · 数据可视化大屏 —— 前端逻辑
   ------------------------------------------------------------
   长跑稳定性设计（对应「浏览器久跑会渲染出问题」的规避）：
   1. 固定 DOM：所有列表都用「复用节点 + 改文本」的方式更新，绝不无限 append；
   2. 图表实例只建一次，之后 setOption 换数据；
   3. 静态层（路网/点位）只在底图或数据签名变化时重绘，机器人节点按 device_sn 复用并按
      CSS transition 平滑移动，不做「清空重画」；
   4. 每日 04:00 整页重载一次释放累积渲染状态（数字标牌行业标配）；
   5. 堆内存超阈值主动重载兜底（Chrome 专有 API，取不到则跳过）。
   ============================================================ */
(function () {
  'use strict'

  var POLL_MS = 5000           // 取数间隔
  var FETCH_TIMEOUT = 8000     // 单次请求超时
  var RELOAD_HOUR = 4          // 每日整页重载时刻（小时）
  var MEM_LIMIT = 800 * 1024 * 1024
  var MAP_PAD = 0              // 坐标 → 图片百分比的内边距（与底图对齐，如有偏移可微调）
  var HEADING_OFFSET = 90      // 车头朝向基准角（箭头默认朝上 → 东为 90°）
  var MAX_ROBOTS = 6
  var MAX_BATCHES = 4
  var MAX_ALERTS = 3
  var MAX_EVENTS = 8

  // file:// 直接双击打开时，接口指向本机后端（正常由后端 /dashboard 托管，走同源相对路径）
  var API = location.protocol === 'file:'
    ? 'http://127.0.0.1:3000/api/dashboard/overview'
    : '/api/dashboard/overview'

  var $ = function (id) { return document.getElementById(id) }

  var state = {
    lastData: null,
    lastOkTs: 0,
    mapKey: '',       // 底图对象路径（去掉签名 query），用于判断「是否换图」而非「签名是否变」
    mapBBox: null,
    mapReady: false,
    sigRoads: '',
    sigLm: '',
    sigRoutes: '',
    cars: {},          // device_sn -> element
    stopEls: [],
    events: [],
    prev: null,
    reloadDay: ''
  }

  /* ---------------- 通用工具 ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n }

  function hhmmss(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) }

  function txt(node, value) {
    var s = value === undefined || value === null ? '' : String(value)
    if (node && node.textContent !== s) node.textContent = s
  }

  function setClass(node, cls) {
    if (node && node.className !== cls) node.className = cls
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0 }

  /* ---------------- 顶栏时钟 / 连接状态 ---------------- */

  function tickClock() { txt($('clock'), hhmmss(new Date())) }

  function setConn(ok, text) {
    var box = $('conn')
    setClass(box, 'conn' + (ok ? ' ok' : ' bad'))
    txt($('connText'), text)
  }

  /* ---------------- 取数 ---------------- */

  function fetchOverview() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, FETCH_TIMEOUT)
    return fetch(API, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        clearTimeout(timer)
        if (!j || j.code !== 0 || !j.data) throw new Error((j && j.msg) || '返回格式异常')
        return j.data
      })
      .catch(function (e) { clearTimeout(timer); throw e })
  }

  /* ---------------- 渲染：运行状态 ---------------- */

  function renderRunState(d) {
    var shop = d.shop || {}
    txt($('kvShop'), shop.name || '零栋铺子')

    var biz = $('kvBusiness')
    txt(biz, shop.business_status === 'open' ? '营业中' : '休息中')
    setClass(biz, shop.business_status === 'open' ? 'on' : 'off')

    var auto = $('kvAuto')
    txt(auto, Number(shop.auto_accept) === 1 ? '已开启' : '已关闭')
    setClass(auto, Number(shop.auto_accept) === 1 ? 'on' : 'off')

    txt($('kvMode'), ({ demo: '演示', pilot: '试点', production: '正式' })[d.run_mode] || d.run_mode || '—')
    txt($('kvPlatform'), d.real_platform ? '真实平台' : '本地模拟')

    txt($('subTitle'), (shop.name || '零栋铺子') + ' · 四川师范大学成龙校区')
  }

  /* ---------------- 渲染：指标 ---------------- */

  // 带强调色的指标在 0 时退为弱色：0 不应该抢注意力（"待接单 0"标成橙色是噪音）
  function paintMetric(el, value) {
    var v = num(value)
    txt(el, v)
    setClass(el, v === 0 ? 'is-zero' : '')
  }

  function renderStats(stats) {
    stats = stats || {}
    txt($('mToday'), num(stats.today_orders))
    txt($('mAmount'), '¥' + num(stats.today_amount).toFixed(0))
    paintMetric($('mPending'), stats.pending)
    txt($('mLoad'), num(stats.ready_load))
    paintMetric($('mDelivering'), stats.delivering)
    paintMetric($('mPickup'), stats.pickup)
    txt($('mException'), num(stats.exception))
    txt($('mAftersale'), num(stats.aftersale))
    txt($('mCancelReq'), num(stats.cancel_requests))
  }

  /* ---------------- 渲染：订单状态分布（堆叠条 + 数值清单） ---------------- */
  // 不用环形图/饼图：小数量下不可读，且是"AI 大屏"最常见的套路组件。
  function renderStatusBar(stats) {
    stats = stats || {}
    var parts = [
      ['sbPending', 'lgPending', num(stats.pending)],
      ['sbLoad', 'lgLoad', num(stats.ready_load)],
      ['sbDeliver', 'lgDeliver', num(stats.delivering)],
      ['sbPickup', 'lgPickup', num(stats.pickup)],
      ['sbException', 'lgException', num(stats.exception)]
    ]
    var total = 0
    parts.forEach(function (p) { total += p[2] })
    parts.forEach(function (p) {
      var bar = $(p[0])
      if (bar) bar.style.width = total > 0 ? (p[2] / total * 100).toFixed(1) + '%' : '0%'
      txt($(p[1]), p[2])
    })
  }

  /* ---------------- 渲染：无人车列表 ---------------- */

  function statusClass(machine) {
    var m = String(machine || '')
    if (m === 'exception') return 's-bad'
    if (m === 'charging' || m === 'returnChargingPile') return 's-charging'
    if (m === 'Delivery' || m === 'delivery' || m === 'lightTask' || m === 'patrol' || m === 'Patrol') return 's-busy'
    return 's-idle'
  }

  function renderRobots(robots, error) {
    var list = $('robotList')
    robots = robots || []
    txt($('robotCount'), robots.length + ' 台')

    if (error && !robots.length) {
      renderSimpleList(list, [error], 'robotItem')
      $('robotEmpty').hidden = true
      return
    }

    var show = robots.slice(0, MAX_ROBOTS)
    // 固定行数复用：先补齐节点，再改文本（不做 clear + append）
    while (list.children.length < show.length) {
      var li = document.createElement('li')
      li.className = 'robotItem'
      li.innerHTML = '<span class="robotName"></span>'
        + '<span class="battery"><span class="batteryBar"><i></i></span><span class="batteryNum"></span></span>'
        + '<span class="robotStatus"></span>'
      list.appendChild(li)
    }
    while (list.children.length > show.length) list.removeChild(list.lastChild)

    show.forEach(function (r, i) {
      var li = list.children[i]
      var online = !!r.online
      setClass(li, 'robotItem' + (online ? '' : ' offline'))
      txt(li.querySelector('.robotName'), r.name || r.device_sn || '机器人')

      var bat = r.battery === null || r.battery === undefined ? null : num(r.battery)
      var bar = li.querySelector('.batteryBar')
      setClass(bar, 'batteryBar' + (bat === null ? '' : bat < 20 ? ' low' : bat < 50 ? ' mid' : ''))
      bar.firstChild.style.width = (bat === null ? 0 : Math.max(0, Math.min(100, bat))) + '%'
      txt(li.querySelector('.batteryNum'), bat === null ? '—' : bat + '%')

      var st = li.querySelector('.robotStatus')
      setClass(st, 'robotStatus ' + (online ? statusClass(r.machine_status) : 's-bad'))
      txt(st, online ? (r.machine_text || '在线') : '离线')
    })

    $('robotEmpty').hidden = show.length > 0
  }

  function renderSimpleList(list, messages, cls) {
    while (list.children.length < messages.length) {
      var li = document.createElement('li')
      li.className = cls
      list.appendChild(li)
    }
    while (list.children.length > messages.length) list.removeChild(list.lastChild)
    messages.forEach(function (m, i) { txt(list.children[i], m) })
  }

  /* ---------------- 渲染：进行中批次 ---------------- */

  function renderBatches(batches) {
    var list = $('batchList')
    batches = batches || []
    txt($('batchCount'), batches.length + ' 批')
    var show = batches.slice(0, MAX_BATCHES)

    while (list.children.length < show.length) {
      var li = document.createElement('li')
      li.className = 'batchItem'
      li.innerHTML = '<div class="batchTop"><span class="batchNo"></span><span class="batchStage"></span></div>'
        + '<div class="batchSub"><span>在途 <b class="bActive">0</b> 单</span>'
        + '<span>待取 <b class="bWait">0</b> 单</span>'
        + '<span class="bDevice"></span></div>'
      list.appendChild(li)
    }
    while (list.children.length > show.length) list.removeChild(list.lastChild)

    show.forEach(function (b, i) {
      var li = list.children[i]
      txt(li.querySelector('.batchNo'), '批次 ' + (b.batch_no || b.id) + (b.daily_seq ? ' · 当日第' + b.daily_seq + '批' : ''))
      var st = li.querySelector('.batchStage')
      setClass(st, 'batchStage s' + num(b.status))
      txt(st, b.status_text || ({ 0: '组单中', 1: '待上货', 2: '配送中' })[num(b.status)] || '—')
      txt(li.querySelector('.bActive'), num(b.active_orders))
      txt(li.querySelector('.bWait'), num(b.waiting_pickup))
      txt(li.querySelector('.bDevice'), b.device_sn ? String(b.device_sn).slice(-6) : '未指派')
    })

    $('batchEmpty').hidden = show.length > 0
  }

  /* ---------------- 渲染：取餐超时提醒 ---------------- */

  function renderAlerts(alerts) {
    alerts = (alerts || []).slice(0, MAX_ALERTS)
    $('alertPanel').hidden = alerts.length === 0
    var list = $('alertList')

    while (list.children.length < alerts.length) {
      var li = document.createElement('li')
      li.innerHTML = '<span class="who"></span><span class="stage"></span>'
      list.appendChild(li)
    }
    while (list.children.length > alerts.length) list.removeChild(list.lastChild)

    alerts.forEach(function (a, i) {
      var li = list.children[i]
      var who = (a.landmark_name || '取餐点') + ' · ' + (a.order_no || ('#' + a.id))
      txt(li.querySelector('.who'), who + (a.picking_up_at ? '（正在取餐）' : ''))
      txt(li.querySelector('.stage'), num(a.pickup_timeout_stage) >= 2 ? '二段超时·即将取消' : '一段超时·稍后返程')
    })
  }

  /* ---------------- 渲染：实时动态（对比上一轮快照，固定 8 条） ---------------- */

  function pushEvent(time, text) {
    state.events.unshift({ t: time, s: text })
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
  }

  function diffEvents(d) {
    var p = state.prev
    var now = hhmmss(new Date())
    if (p) {
      // 车辆状态变化
      var prevRobots = {}
      ;(p.robots || []).forEach(function (r) { prevRobots[r.device_sn] = r })
      ;(d.robots || []).forEach(function (r) {
        var old = prevRobots[r.device_sn]
        if (!old) pushEvent(now, '发现车辆 ' + (r.name || r.device_sn) + ' 在线')
        else if (old.machine_text !== r.machine_text) {
          pushEvent(now, (r.name || r.device_sn) + ' 状态 ' + (old.machine_text || '未知') + ' → ' + (r.machine_text || '未知'))
        }
      })
      // 新批次
      var prevBatch = {}
      ;(p.batches || []).forEach(function (b) { prevBatch[b.id] = b })
      ;(d.batches || []).forEach(function (b) {
        if (!prevBatch[b.id]) pushEvent(now, '新建配送批次 ' + (b.batch_no || b.id) + '，共 ' + num(b.active_orders) + ' 单')
        else if (prevBatch[b.id].status !== b.status) {
          pushEvent(now, '批次 ' + (b.batch_no || b.id) + ' 进入「' + (b.status_text || b.status) + '」')
        }
      })
      // 新取餐超时
      var prevAlert = {}
      ;(p.pickup_alerts || []).forEach(function (a) { prevAlert[a.id] = a })
      ;(d.pickup_alerts || []).forEach(function (a) {
        var old = prevAlert[a.id]
        if (!old) pushEvent(now, '取餐超时告警：' + (a.landmark_name || '') + ' ' + (a.order_no || ''))
        else if (num(old.pickup_timeout_stage) !== num(a.pickup_timeout_stage)) {
          pushEvent(now, (a.order_no || '') + ' 取餐超时进入第 ' + num(a.pickup_timeout_stage) + ' 段')
        }
      })
    } else {
      pushEvent(now, '大屏已连接后端，开始接收实时数据')
    }
    state.prev = d

    var list = $('eventList')
    while (list.children.length < state.events.length) {
      var li = document.createElement('li')
      li.innerHTML = '<time></time><span></span>'
      list.appendChild(li)
    }
    while (list.children.length > state.events.length) list.removeChild(list.lastChild)
    state.events.forEach(function (e, i) {
      txt(list.children[i].querySelector('time'), e.t)
      txt(list.children[i].querySelector('span'), e.s)
    })
  }

  /* ---------------- 地图：Leaflet 实时可拖拽地图 ---------------- */

  // 底图提供商（矢量道路图，非卫星影像）。对齐结果按提供商保存，切换后需重新对齐：
  //   'amap-vector' = 高德矢量（默认：国内稳定、中文楼名、时效性好；免费瓦片 maxZoom=18）
  //   'amap-sat'    = 高德卫星影像（真实影像，无道路标注）
  //   'carto'       = CARTO Voyager（干净现代矢量路网；境外 CDN，国内偶发慢）
  //   'osm'         = OpenStreetMap 官方源（国内被墙，会 403/白图，不推荐）
  // 注意：高德瓦片按 GCJ-02 渲染，OSM/CARTO 按 WGS84 —— 两者偏差约几百米，切换后点位会偏移，
  // 需重新用「对齐校准」把雷达底图对到新底图上。
  var TILE_PROVIDER = 'amap-vector'

  // ---- 坐标变换：平台局部坐标(米) → 经纬度 ----
  // 优先用「雷达图手动对齐」结果（本机 localStorage 保存）：
  //   qx = a*x - b*y + tx ; qy = b*x + a*y + ty （平台坐标 → WebMercator米）→ 反投影经纬度
  // 未对齐前按底图类型用内置标定兜底：
  //   · 高德瓦片（GCJ-02）：LEGACY_AMAP（东苑锚点推断，±20~30m）
  //   · OSM/CARTO（WGS84）：CALIB_T（成员 ?calib=1 拖拽标定）
  var LEGACY_AMAP = {
    bbMinX: -36.849, bbMaxX: 231.945, bbMinY: -107.831, bbMaxY: 139.007,
    platW: 5776, platH: 5537,
    S: 0.09, cx: 2888, cy: 2768.5, tx: 2138, ty: 2501,
    z: 18, tx0: 206943, ty0: 107671
  }
  var CALIB_T = { a: 1.184949, b: 0.339779, tx: 11599629.22, ty: 3576279.423 }

  function legacyAmapToLngLat(x, y) {
    var C = LEGACY_AMAP
    var plx = (x - C.bbMinX) / (C.bbMaxX - C.bbMinX) * C.platW
    var ply = (1 - (y - C.bbMinY) / (C.bbMaxY - C.bbMinY)) * C.platH
    var navX = C.S * (plx - C.cx) + C.tx
    var navY = C.S * (ply - C.cy) + C.ty
    var n = Math.pow(2, C.z)
    var lng = ((C.tx0 * 256 + navX) / 256) / n * 360 - 180
    var wy = (C.ty0 * 256 + navY) / 256
    var lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / n))) * 180 / Math.PI
    return [lat, lng]
  }

  function calibWgsToLngLat(x, y) {
    var R = 6378137
    var qx = CALIB_T.a * x - CALIB_T.b * y + CALIB_T.tx
    var qy = CALIB_T.b * x + CALIB_T.a * y + CALIB_T.ty
    return [Math.atan(Math.sinh(qy / R)) * 180 / Math.PI, qx / R * 180 / Math.PI]
  }

  // 对齐状态：saved=已保存的结果；on=正在对齐；preview=拖动中的实时预览变换
  var ALIGN = {
    on: false, preview: null, saved: null,
    el: null, img: null, imgW: 0, imgH: 0,
    L: 0, T: 0, W: 0, H: 0, rot: 0, lock: true,
    bbox: null, drag: null, tile: null, lastRepaint: 0
  }

  function alignActiveTransform() {
    if (ALIGN.on && ALIGN.preview) return ALIGN.preview
    if (ALIGN.saved && ALIGN.saved.provider === TILE_PROVIDER) return ALIGN.saved
    return null
  }

  // 平台坐标（米，自有原点）→ 经纬度 [lat, lng]
  function platformToLngLat(x, y) {
    var t = alignActiveTransform()
    if (t) {
      var R = 6378137
      var qx = t.a * x - t.b * y + t.tx
      var qy = t.b * x + t.a * y + t.ty
      return [Math.atan(Math.sinh(qy / R)) * 180 / Math.PI, qx / R * 180 / Math.PI]
    }
    return (TILE_PROVIDER === 'amap-vector' || TILE_PROVIDER === 'amap-sat')
      ? legacyAmapToLngLat(x, y)
      : calibWgsToLngLat(x, y)
  }

  // 平台坐标 → 雷达图叠加层在 mapBox 里的像素（与 Leaflet containerPoint 同一坐标系）。
  // 映射约定与商家端 monitor.js 一致：x 左→右、y 上→下（平台 y 向北，转成图片向下）。
  function platformToContainerPoint(x, y) {
    var bb = ALIGN.bbox
    var iw = ALIGN.imgW || 5786, ih = ALIGN.imgH || 5406
    var px = (x - bb.minX) / (bb.maxX - bb.minX) * iw
    var py = (bb.maxY - y) / (bb.maxY - bb.minY) * ih
    var dx = px * (ALIGN.W / iw)
    var dy = py * (ALIGN.H / ih)
    var cx = ALIGN.W / 2, cy = ALIGN.H / 2
    var th = ALIGN.rot * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th)
    var rx = (dx - cx) * cos - (dy - cy) * sin + cx
    var ry = (dx - cx) * sin + (dy - cy) * cos + cy
    return [ALIGN.L + rx, ALIGN.T + ry]
  }

  var mapObj = null
  var mapLayers = { lms: {}, cars: {}, stops: {}, route: null, graph: null }

  function initMap() {
    if (mapObj || !window.L) return
    var el = $('mapBox')
    if (!el) return
    var TILE = {
      'amap-vector': { url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', subs: ['1', '2', '3', '4'], attr: '&copy; 高德地图', max: 18 },
      'amap-sat': { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', subs: ['1', '2', '3', '4'], attr: '&copy; 高德地图', max: 18 },
      carto: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', subs: ['a', 'b', 'c', 'd'], attr: '&copy; OpenStreetMap &copy; CARTO', max: 20 },
      osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subs: ['a', 'b', 'c'], attr: '&copy; OpenStreetMap', max: 20 }
    }
    var t = TILE[TILE_PROVIDER] || TILE['amap-vector']
    mapObj = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: true,
      maxZoom: t.max,
      attributionControl: true     // 保留底图版权署名（高德/OSM 授权要求）
    })
    ALIGN.tile = L.tileLayer(t.url, {
      subdomains: t.subs,
      maxZoom: t.max,
      attribution: t.attr,
      opacity: 1
    }).addTo(mapObj)
    mapObj.setView(platformToLngLat(0, 15), Math.min(18, t.max))   // 东苑宿舍区
    var mask = $('mapMask')
    if (mask) mask.hidden = true
    var reset = $('mapReset')
    if (reset) reset.hidden = false
    var ab = $('alignBtn')
    if (ab) ab.hidden = false
    var ac = $('alignClear')
    if (ac) ac.hidden = !ALIGN.saved
  }

  function mapResized() {
    if (mapObj) setTimeout(function () { mapObj.invalidateSize() }, 60)
  }

  function llList(pts) {
    var out = []
    ;(pts || []).forEach(function (p) {
      if (isFinite(num(p.x)) && isFinite(num(p.y))) out.push(platformToLngLat(num(p.x), num(p.y)))
    })
    return out
  }

  // 平台点位（店铺=橙、其余=招牌蓝；不重复画文字，底图自带楼名）
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
        mk = L.circleMarker(ll, {
          radius: isLoad ? 8 : 5, weight: 2, color: '#ffffff',
          fillColor: isLoad ? '#e8890c' : '#2b50a1', fillOpacity: 1
        })
        mk.bindTooltip(m.name || '', { direction: 'top', offset: [0, -8], className: 'lmTip' })
        mk.addTo(mapObj)
        mapLayers.lms[key] = mk
      } else {
        mk.setLatLng(ll)
      }
    })
    Object.keys(mapLayers.lms).forEach(function (k) {
      if (!seen[k]) { mapObj.removeLayer(mapLayers.lms[k]); delete mapLayers.lms[k] }
    })
  }

  // 路网（平台固定路径图，浅蓝细线）
  function updateGraph(graph) {
    var pts = llList(graph && graph.nodes)
    if (mapLayers.graph) { mapLayers.graph.setLatLngs(pts); return }
    if (!pts.length) return
    mapLayers.graph = L.polyline(pts, { color: '#8fb1e6', weight: 2, opacity: .6 }).addTo(mapObj)
  }

  // 路线（虚线）+ 停靠序号
  function updateRoutes(routes) {
    var r = (routes || []).filter(function (x) { return x && x.stops && x.stops.length > 1 })[0]
    var pts = r ? llList(r.stops) : []
    if (mapLayers.route) mapLayers.route.setLatLngs(pts)
    else if (pts.length) mapLayers.route = L.polyline(pts, { color: '#2e7cf6', weight: 3, dashArray: '8 6' }).addTo(mapObj)
    var seenN = {}
    ;((r && r.stops) || []).forEach(function (s) {
      var key = 's' + r.batch_id + '_' + num(s.stop)
      seenN[key] = true
      var ll = platformToLngLat(num(s.x), num(s.y))
      var mk = mapLayers.stops[key]
      if (!mk) {
        mk = L.marker(ll, {
          icon: L.divIcon({ className: 'stopWrap', html: '<span class="stopNum">' + num(s.stop) + '</span>', iconSize: [18, 18], iconAnchor: [9, 9] })
        })
        mk.addTo(mapObj)
        mapLayers.stops[key] = mk
      } else mk.setLatLng(ll)
    })
    Object.keys(mapLayers.stops).forEach(function (k) {
      if (!seenN[k]) { mapObj.removeLayer(mapLayers.stops[k]); delete mapLayers.stops[k] }
    })
  }

  // 无人车（蓝色箭头 + 编号，按 device_sn 复用，位置/朝向每轮更新）
  function updateCars(robots) {
    var seen = {}
    ;(robots || []).forEach(function (r) {
      var ll = platformToLngLat(num(r.x), num(r.y))
      seen[r.device_sn] = true
      var mk = mapLayers.cars[r.device_sn]
      if (!mk) {
        mk = L.marker(ll, {
          icon: L.divIcon({
            className: 'carWrap',
            html: '<span class="carArrow"></span><span class="carName">' + String(r.device_sn || '').slice(-6) + '</span>',
            iconSize: [22, 26], iconAnchor: [11, 13]
          })
        })
        mk.addTo(mapObj)
        mapLayers.cars[r.device_sn] = mk
      } else {
        mk.setLatLng(ll)
      }
      var deg = HEADING_OFFSET - num(r.theta) * 180 / Math.PI
      var el = mk.getElement()
      var ar = el && el.querySelector('.carArrow')
      if (ar) ar.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)'
    })
    Object.keys(mapLayers.cars).forEach(function (sn) {
      if (!seen[sn]) { mapObj.removeLayer(mapLayers.cars[sn]); delete mapLayers.cars[sn] }
    })
  }

  function renderMap(d) {
    initMap()
    var mask = $('mapMask')
    if (!mapObj) {
      if (mask) { txt(mask, '地图组件加载失败（vendor/leaflet.js 缺失）'); mask.hidden = false }
      return
    }
    var map = d.map
    if (!map) return
    if (CALIB) { renderCalib(map); return }
    updateLandmarks(map)
    updateGraph(map.graph)
    updateRoutes(map.routes)
    updateCars(map.robots)
    if (ALIGN.on) {
      txt($('mapTip'), '对齐中：拖动雷达底图，点位实时跟随')
    } else {
      txt($('mapTip'), (map.landmarks || []).length + ' 个点位 · ' + (map.graph && map.graph.nodes ? map.graph.nodes.length : 0) + ' 个路网节点'
        + (ALIGN.saved && ALIGN.saved.provider === TILE_PROVIDER ? ' · 已手动对齐' : ' · 未对齐，点「对齐校准」'))
    }
    mapResized()
  }

  /* ---------------- 地图标定（?calib=1） ---------------- */
  // 一次性把「平台局部坐标」精确对齐到在线地图(OSM/WGS84)。
  // 用法：地址栏 /dashboard/?calib=1 → 把每个圆点拖到真实位置 → 点「计算」→ 输出新变换参数。
  var CALIB = /[?&]calib=1/.test(location.search)
  var R_EARTH = 6378137
  var calibPairs = []      // {src, px, py, mx, my}
  var calibMarks = {}      // key -> Leaflet marker
  var calibT = null        // 本次会话计算出的相似变换

  // 经纬度 -> WebMercator 米（就近投影，校园尺度下可当线性）
  function merc(lat, lng) {
    return { x: R_EARTH * lng * Math.PI / 180, y: R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) }
  }
  function mercToLngLat(m) {
    return [Math.atan(Math.sinh(m.y / R_EARTH)) * 180 / Math.PI, m.x / R_EARTH * 180 / Math.PI]
  }

  // 高斯消元解 4x4
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
  // 相似变换最小二乘： qx = a*px - b*py + tx ; qy = b*px + a*py + ty（旋转+等比缩放+平移）
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
      var g = platformToLngLat(num(m.x), num(m.y))   // [lat, lng] WGS84
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

  /* ---------------- 地图对齐：全局地图 + 局部雷达图 手动对齐 ---------------- */
  // 平台没有 GPS，机器人定位只有激光 SLAM 局部坐标（eviz robotpose）。
  // 做法：把平台下发的雷达底图（/api/dashboard/map-image）半透明叠在全局在线地图上，
  // 手动拖动 / 缩放 / 旋转到两者轮廓重合 → 点「保存对齐」→ 由当前几何反推相似变换
  // （平台坐标 → WebMercator米），之后所有点位/路网/车辆坐标都经该变换显示在全局地图上。
  // 对齐结果只存在本机浏览器 localStorage（键 dash_align_v1），按底图提供商区分。
  var fitScale = 1

  function alignLoadSaved() {
    try {
      var s = JSON.parse(localStorage.getItem('dash_align_v1') || 'null')
      if (s && isFinite(s.a) && isFinite(s.tx)) {
        ALIGN.saved = s
        ALIGN.L = s.L || 0; ALIGN.T = s.T || 0
        ALIGN.W = s.W || 0; ALIGN.H = s.H || 0; ALIGN.rot = s.rot || 0
      }
    } catch (e) { ALIGN.saved = null }
  }

  // 创建雷达图叠加层（懒加载：进入对齐模式时才创建）
  function alignUI() {
    if (ALIGN.el) { ALIGN.el.style.display = 'block'; return ALIGN.el }
    var d = document.createElement('div')
    d.id = 'radarOverlay'
    d.className = 'radarOverlay'
    var tag = document.createElement('span')
    tag.className = 'radarTag'
    tag.textContent = '雷达底图（可拖动）'
    var img = document.createElement('img')
    img.className = 'radarImg'
    img.alt = '平台雷达底图'
    img.src = (location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '') + '/api/dashboard/map-image'
    d.appendChild(tag)
    d.appendChild(img)
    ALIGN.img = img
    var box = $('mapBox')
    if (!box) return null
    box.appendChild(d)
    ALIGN.el = d
    img.onload = function () {
      ALIGN.imgW = img.naturalWidth || 5786
      ALIGN.imgH = img.naturalHeight || 5406
      var st = $('alignStatus')
      if (st) txt(st, '雷达底图 ' + ALIGN.imgW + '×' + ALIGN.imgH + ' 已加载')
    }
    img.onerror = function () {
      var st = $('alignStatus')
      if (st) txt(st, '雷达底图加载失败：本地演示模式（PLATFORM_MOCK）下平台不提供底图，需真实平台环境')
    }
    // 拖动（平移）
    d.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      ALIGN.drag = { sx: e.clientX, sy: e.clientY, l: ALIGN.L, t: ALIGN.T }
      setClass(d, 'radarOverlay dragging')
    })
    // 滚轮缩放（围绕雷达图中心）
    d.addEventListener('wheel', function (e) {
      e.preventDefault()
      e.stopPropagation()
      var f = e.deltaY < 0 ? 1.08 : 0.92
      alignResize(ALIGN.W * f, ALIGN.H * f)
    }, { passive: false })
    return d
  }

  function alignApply() {
    var d = ALIGN.el
    if (!d) return
    d.style.left = ALIGN.L + 'px'
    d.style.top = ALIGN.T + 'px'
    d.style.width = ALIGN.W + 'px'
    d.style.height = ALIGN.H + 'px'
    d.style.transform = ALIGN.rot ? ('rotate(' + ALIGN.rot + 'deg)') : ''
  }

  function alignResize(w, h) {
    w = Math.max(40, Math.min(2200, w))
    h = Math.max(40, Math.min(2200, h))
    var dw = w - ALIGN.W, dh = h - ALIGN.H
    ALIGN.W = w; ALIGN.H = h
    ALIGN.L -= dw / 2; ALIGN.T -= dh / 2
    alignApply()
    alignPreview()
  }

  // 由当前几何算相似变换（平台坐标 → WebMercator米），复用标定模式的最小二乘解算
  function alignComputeTransform() {
    var bb = ALIGN.bbox
    var corners = [
      { x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY },
      { x: bb.maxX, y: bb.maxY }, { x: bb.minX, y: bb.maxY }
    ]
    var pairs = []
    corners.forEach(function (c) {
      var cp = platformToContainerPoint(c.x, c.y)
      var ll = mapObj.containerPointToLatLng([cp[0], cp[1]])
      var m = merc(ll.lat, ll.lng)
      pairs.push({ px: c.x, py: c.y, mx: m.x, my: m.y })
    })
    return solveSimilarity(pairs)
  }

  // 拖动/缩放/旋转时实时刷新点位（限频），让用户直接看到"对齐准不准"
  function alignPreview() {
    var now = Date.now()
    if (now - ALIGN.lastRepaint < 80) return
    ALIGN.lastRepaint = now
    if (!ALIGN.bbox || !mapObj) return
    var t = alignComputeTransform()
    ALIGN.preview = t
    if (state.lastData) renderMap(state.lastData)
  }

  window.enterAlign = function () {
    if (!mapObj) return
    var d = state.lastData && state.lastData.map
    if (!d || !d.bbox) { alert('还没有地图数据（bbox），无法对齐'); return }
    ALIGN.bbox = d.bbox
    var box = $('mapBox')
    if (!box) return
    // 首次进入：雷达图居中，约占地图框 62%
    if (!ALIGN.W || !ALIGN.H) {
      var iw = ALIGN.imgW || 5786, ih = ALIGN.imgH || 5406
      var bw = box.clientWidth, bh = box.clientHeight
      ALIGN.W = Math.round(Math.min(bw * .62, 760))
      ALIGN.H = Math.round(ALIGN.W * ih / iw)
      ALIGN.L = Math.round((bw - ALIGN.W) / 2)
      ALIGN.T = Math.round((bh - ALIGN.H) / 2)
      ALIGN.rot = 0
    }
    ALIGN.on = true
    alignUI()
    mapObj.dragging.disable()
    mapObj.scrollWheelZoom.disable()
    if (ALIGN.tile) ALIGN.tile.setOpacity(.5)
    $('alignPanel').hidden = false
    $('alignBtn').hidden = true
    txt($('alignTip'), '拖动橙色虚线框里的雷达底图，让校园轮廓与下方全局地图重合；' +
      '滚轮缩放、滑块微调大小/角度。蓝色点位会实时跟着变换，对齐准不准一眼可见。')
    txt($('alignStatus'), ALIGN.saved ? '已有对齐结果，重新对齐将覆盖' : '拖动/缩放雷达图开始')
    $('alignRot').value = ALIGN.rot
    $('alignW').value = ALIGN.W
    $('alignH').value = ALIGN.H
    alignApply()
  }

  window.alignSave = function () {
    if (!ALIGN.on) return
    if (!ALIGN.bbox || !ALIGN.imgW) { txt($('alignStatus'), '雷达底图还没加载完成，稍等再试'); return }
    var t = alignComputeTransform()
    ALIGN.preview = null
    ALIGN.saved = {
      a: t.a, b: t.b, tx: t.tx, ty: t.ty,
      provider: TILE_PROVIDER, ts: Date.now(),
      imgW: ALIGN.imgW, imgH: ALIGN.imgH,
      L: ALIGN.L, T: ALIGN.T, W: ALIGN.W, H: ALIGN.H, rot: ALIGN.rot
    }
    try { localStorage.setItem('dash_align_v1', JSON.stringify(ALIGN.saved)) } catch (e) { /* 隐私模式忽略 */ }
    alignExit()
    txt($('mapTip'), '对齐已保存 ✓ a=' + t.a.toFixed(3) + ' b=' + t.b.toFixed(3))
  }

  window.alignCancel = function () {
    if (!ALIGN.on) return
    ALIGN.preview = null
    alignExit()
  }

  window.clearAlign = function () {
    ALIGN.saved = null
    ALIGN.preview = null
    try { localStorage.removeItem('dash_align_v1') } catch (e) { /* 忽略 */ }
    var ac = $('alignClear')
    if (ac) ac.hidden = true
    if (state.lastData) renderMap(state.lastData)
    txt($('mapTip'), '已清除对齐，恢复内置标定（±20~30m，建议尽快重新对齐）')
  }

  function alignExit() {
    ALIGN.on = false
    ALIGN.preview = null
    ALIGN.drag = null
    if (mapObj) { mapObj.dragging.enable(); mapObj.scrollWheelZoom.enable() }
    if (ALIGN.tile) ALIGN.tile.setOpacity(1)
    if (ALIGN.el) ALIGN.el.style.display = 'none'
    var p = $('alignPanel')
    if (p) p.hidden = true
    var ab = $('alignBtn')
    if (ab) ab.hidden = false
    var ac = $('alignClear')
    if (ac) ac.hidden = !ALIGN.saved
    if (state.lastData) renderMap(state.lastData)
  }

  function wireAlignControls() {
    var rot = $('alignRot'), w = $('alignW'), h = $('alignH'), lock = $('alignLock')
    rot.oninput = function () {
      ALIGN.rot = Number(this.value)
      alignApply()
      alignPreview()
    }
    w.oninput = function () {
      var v = Number(this.value)
      var nh = lock.checked ? Math.round(v * (ALIGN.imgH || 5406) / (ALIGN.imgW || 5786)) : ALIGN.H
      alignResize(v, nh)
      h.value = ALIGN.H
    }
    h.oninput = function () {
      var v = Number(this.value)
      var nw = lock.checked ? Math.round(v * (ALIGN.imgW || 5786) / (ALIGN.imgH || 5406)) : ALIGN.W
      alignResize(nw, v)
      w.value = ALIGN.W
    }
    var save = $('alignSave')
    if (save) save.onclick = window.alignSave
    var cancel = $('alignCancel')
    if (cancel) cancel.onclick = window.alignCancel
  }

  /* ---------------- 主循环 ---------------- */

  // 演示模式（地址栏加 ?demo=1）：机器人未开工 / 汇报演示时，用真实地图与点位叠加模拟车辆，
  // 让大屏「动起来」。顶部会亮出「演示数据」标识，避免与真实数据混淆。
  var DEMO = /[?&]demo=1/.test(location.search)

  function demoPatch(d) {
    var lms = (d.map && d.map.landmarks) || []
    if (lms.length < 2) return d
    var t = Date.now() / 1000
    function lerp(a, b, k) { return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k } }
    function wave(phase) { return 0.5 + 0.5 * Math.sin(t / 12 + phase) }
    var a1 = lms[0], b1 = lms[Math.min(3, lms.length - 1)]
    var a2 = lms[Math.min(5, lms.length - 1)], b2 = lms[lms.length - 1]
    var dir = Math.cos(t / 12) >= 0 ? 1 : -1
    var p1 = lerp(a1, b1, wave(0))
    var p2 = lerp(a2, b2, wave(1.7))
    d.map.robots = [
      { device_sn: 'LD-DEMO-01', x: p1.x, y: p1.y, theta: Math.atan2(b1.y - a1.y, b1.x - a1.x) * dir, text: '配送中' },
      { device_sn: 'LD-DEMO-02', x: p2.x, y: p2.y, theta: Math.atan2(b2.y - a2.y, b2.x - a2.x) * dir, text: '前往取餐点' }
    ]
    if (!d.map.routes || !d.map.routes.length) {
      d.map.routes = [{
        batch_id: -1,
        batch_no: 'DEMO',
        stops: [
          { stop: 1, x: a1.x, y: a1.y, name: a1.name },
          { stop: 2, x: b1.x, y: b1.y, name: b1.name },
          { stop: 3, x: b2.x, y: b2.y, name: b2.name }
        ]
      }]
    }
    d.stats = Object.assign({}, d.stats, { today_orders: 43, today_amount: 1286.5, pending: 3, ready_load: 2, delivering: 2, pickup: 5, aftersale: 2 })
    d.robots = (d.robots || []).concat([
      { device_sn: 'LD-DEMO-01', name: '演示车 01', online: true, battery: 78, machine_status: 'Delivery', machine_text: '配送中' },
      { device_sn: 'LD-DEMO-02', name: '演示车 02', online: true, battery: 42, machine_status: 'lightTask', machine_text: '召唤' }
    ])
    d.demo = true
    return d
  }

  // 平台把路网本身作为一个名为「固定路径」的点位一起下发，它不是配送点，
  // 画出来只会在角落露出半截标签 —— 在入库前统一剔除，所有渲染处拿到的都是干净点位表
  function usableLandmarks(map) {
    return ((map && map.landmarks) || []).filter(function (m) {
      return !/固定路径/.test(String(m.name || ''))
    })
  }

  function apply(d) {
    if (d.map) d.map.landmarks = usableLandmarks(d.map)
    state.lastData = d
    state.lastOkTs = Date.now()
    setConn(true, '数据正常')
    $('demoBadge').hidden = !d.demo
    renderRunState(d)
    renderStats(d.stats)
    renderStatusBar(d.stats)
    renderRobots(d.robots, d.robots_error)
    renderBatches(d.batches)
    renderAlerts(d.pickup_alerts)
    renderMap(d)
    diffEvents(d)
    txt($('footMid'), '后端 ' + (d.server_time || '') + ' · 运行档位 ' + (d.run_mode || '—'))
  }

  function loop() {
    fetchOverview().then(function (d) {
      apply(DEMO ? demoPatch(d) : d)
    }).catch(function (e) {
      setConn(false, '连接中断' + (e && e.message ? '（' + e.message + '）' : ''))
      // 拿不到数据时保留上一屏内容，不清空 —— 大屏最忌讳黑屏
    })
  }

  function memoryGuard() {
    try {
      if (window.performance && performance.memory && performance.memory.usedJSHeapSize > MEM_LIMIT) {
        location.reload()
      }
    } catch (e) { /* 非 Chrome 无此 API，忽略 */ }
  }

  function dailyReload() {
    var now = new Date()
    var day = now.toDateString()
    if (now.getHours() === RELOAD_HOUR && state.reloadDay !== day) {
      state.reloadDay = day
      location.reload()
    }
  }

  /* ---------------- 启动 ---------------- */

  // 等比缩放固定画布：大屏主机不论 1080p / 2K / 4K，版式与字号比例都一致
  function fitScreen() {
    var el = $('screen')
    if (!el) return
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
    fitScale = s
    var dx = (window.innerWidth - 1920 * s) / 2
    var dy = (window.innerHeight - 1080 * s) / 2
    el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + s.toFixed(4) + ')'
  }

  function boot() {
    tickClock()
    setInterval(tickClock, 1000)

    fitScreen()
    alignLoadSaved()
    wireAlignControls()
    window.resetMap = function () { if (mapObj) mapObj.setView(platformToLngLat(0, 15), 18) }
    // 雷达图拖动：全局监听鼠标位移（限对齐模式内生效）
    window.addEventListener('mousemove', function (e) {
      if (!ALIGN.drag || !ALIGN.el) return
      var dx = (e.clientX - ALIGN.drag.sx) / fitScale
      var dy = (e.clientY - ALIGN.drag.sy) / fitScale
      ALIGN.L = ALIGN.drag.l + dx
      ALIGN.T = ALIGN.drag.t + dy
      alignApply()
      alignPreview()
    })
    window.addEventListener('mouseup', function () {
      if (ALIGN.drag) {
        ALIGN.drag = null
        if (ALIGN.el) setClass(ALIGN.el, 'radarOverlay')
      }
    })
    // 无第三方图表库：状态分布用纯 CSS 堆叠条渲染 —— 页面更轻、少一个依赖、7×24 更稳
    window.addEventListener('resize', function () { fitScreen(); mapResized() })

    loop()
    setInterval(loop, POLL_MS)
    setInterval(memoryGuard, 60000)
    setInterval(dailyReload, 60000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
