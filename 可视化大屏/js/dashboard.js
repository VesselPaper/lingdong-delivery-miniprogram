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

  // 标定常量：平台坐标系 → 高德导航图（GCJ-02）的相似变换。
  // 推导见 deploy\校准并生成底图.ps1（S=比例、Rot=0、Tx/Ty=平移）；瓦片为高德 z=18 免费瓦片。
  var MAP_CALIB = {
    bbMinX: -36.849, bbMaxX: 231.945, bbMinY: -107.831, bbMaxY: 139.007,
    platW: 5776, platH: 5537,
    S: 0.09, cx: 2888, cy: 2768.5, tx: 2138, ty: 2501,
    z: 18, tx0: 206943, ty0: 107671
  }

  // 平台坐标（米，自有原点）→ GCJ-02 经纬度
  function platformToLngLat(x, y) {
    var C = MAP_CALIB
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

  var mapObj = null
  var mapLayers = { lms: {}, cars: {}, stops: {}, route: null, graph: null }

  function initMap() {
    if (mapObj || !window.L) return
    var el = $('mapBox')
    if (!el) return
    mapObj = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: false,      // 大屏防误触：用拖拽与 +/- 按钮缩放
      attributionControl: true
    })
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 18,
      attribution: '&copy; 高德地图'
    }).addTo(mapObj)
    mapObj.setView(platformToLngLat(0, 15), 18)   // 东苑宿舍区
    var mask = $('mapMask')
    if (mask) mask.hidden = true
    var reset = $('mapReset')
    if (reset) reset.hidden = false
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
    updateLandmarks(map)
    updateGraph(map.graph)
    updateRoutes(map.routes)
    updateCars(map.robots)
    txt($('mapTip'), (map.landmarks || []).length + ' 个点位 · ' + (map.graph && map.graph.nodes ? map.graph.nodes.length : 0) + ' 个路网节点')
    mapResized()
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
    var dx = (window.innerWidth - 1920 * s) / 2
    var dy = (window.innerHeight - 1080 * s) / 2
    el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + s.toFixed(4) + ')'
  }

  function boot() {
    tickClock()
    setInterval(tickClock, 1000)

    fitScreen()
    window.resetMap = function () { if (mapObj) mapObj.setView(platformToLngLat(0, 15), 18) }
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
