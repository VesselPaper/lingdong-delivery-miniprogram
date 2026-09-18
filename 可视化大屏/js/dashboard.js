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
  // 无人车实时位置：轻量接口，比 overview 高频得多（车要看得见在动）
  var API_ROBOTS = location.protocol === 'file:'
    ? 'http://127.0.0.1:3000/api/dashboard/robot-positions'
    : '/api/dashboard/robot-positions'
  var ROBOT_POLL_MS = 1000          // 车辆位置轮询间隔

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

  // 无人车实时位置：单独高频轮询，只喂给 3D 地图（不动其它面板）
  function fetchRobotPositions() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, FETCH_TIMEOUT)
    return fetch(API_ROBOTS, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        clearTimeout(timer)
        if (!j || j.code !== 0 || !j.data) throw new Error((j && j.msg) || '返回格式异常')
        return j.data
      })
      .catch(function (e) { clearTimeout(timer); throw e })
  }

  function pollRobots() {
    if (!window.Map3D || !Map3D.setRobots) return
    fetchRobotPositions().then(function (d) {
      var list = (d && d.robots) || []
      // 只有拿到有效坐标的才交给地图（没定位的保持上一次/等下一轮）
      var withPos = list.filter(function (r) { return r && r.has_pos !== false && r.x != null && r.y != null })
      Map3D.setRobots(withPos)
      var tip = $('mapTip')
      if (tip && d && d.msg) tip.textContent = '车辆位置接口：' + d.msg
    }).catch(function () { /* 轮询失败静默，等下一轮 */ })
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
    if (el) {
      if (v === 0) el.classList.add('is-zero'); else el.classList.remove('is-zero')
    }
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

  // 标定常量（用户 ?calib=1 拖拽标定得出，2026-09-22）：
  // 平台局部坐标(米) -> WebMercator米（相似变换）-> WGS84 经纬度（匹配 OSM 底图）。
  // qx = a*px - b*py + tx ; qy = b*px + a*py + ty
  var CALIB_T = { a: 1.184949, b: 0.339779, tx: 11599629.22, ty: 3576279.423 }

  // 平台坐标（米，自有原点）→ WGS84 经纬度 [lat, lng]
  function platformToLngLat(x, y) {
    var R = 6378137
    var qx = CALIB_T.a * x - CALIB_T.b * y + CALIB_T.tx
    var qy = CALIB_T.b * x + CALIB_T.a * y + CALIB_T.ty
    var lng = qx / R * 180 / Math.PI
    var lat = Math.atan(Math.sinh(qy / R)) * 180 / Math.PI
    return [lat, lng]
  }

  var mapObj = null
  var mapLayers = { lms: {}, cars: {}, stops: {}, route: null, graph: null }

  // 天地图浏览器端 tk：由后端 /api/config/tianditu 注入（存于 .env，不进仓库）
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
    //   'tianditu'    = 天地图（矢量底图+中文注记，国内稳定、无水印、数据较新，默认）
    //   'carto'       = CARTO Voyager（干净现代矢量路网）
    //   'osm'         = OpenStreetMap 标准（部分环境会 403）
    //   'osm-de'      = OSM 德国镜像（标准 OSM 画风，国内可达；备用降级源）
    //   'amap-vector' = 高德矢量（自带中文楼名，但带回源水印；最终兜底）
    //   'amap-sat'    = 高德卫星影像（真实影像，无道路标注；用水印，需留意版权）
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
      scrollWheelZoom: true,        // 允许鼠标滚轮缩放（网页端需求）
      maxZoom: 20,                  // 最高 20 级（天地图原生到 18，19~20 由 maxNativeZoom 放大）
      attributionControl: false     // 隐藏底图版权水印（内部演示大屏；正式发布建议按版权保留）
    })
    // 天地图为主底图（团队方案）：tk 由后端注入；未配置或加载失败时降级到备用源
    if (TILE_PROVIDER === 'tianditu') {
      getTiandituTk().then(function (tk) {
        if (!tk || !mapObj) { txt($('mapTip'), '天地图密钥未配置（backend/.env 的 TIANDITU_TK），自动使用备用底图'); startFallbackTiles(); return }
        // 天地图原生最高 18 级；maxNativeZoom=18 让 19~20 级自动放大原图，避免空白
        L.tileLayer(tiandituUrl('vec', tk), { subdomains: '01234567', maxNativeZoom: 18, maxZoom: 20 }).addTo(mapObj)  // 矢量底图
        L.tileLayer(tiandituUrl('cva', tk), { subdomains: '01234567', maxNativeZoom: 18, maxZoom: 20 }).addTo(mapObj)  // 中文注记
      })
      return
    }
    // 非天地图源：OSM 降级链 + 防抖（本地保留）
    // 国内网络常无法访问 OSM/CARTO 官方瓦片服务器（实测超时），底图会整片空白/灰底。
    // 降级链：OSM 德国镜像(同为 OSM 画风，国内可达) → 高德矢量（最终兜底）。
    // 防抖规则：当前底图只要有瓦片成功加载过（tileload）就锁定、不再降级，个别瓦片失败只是抖动；
    // 只有「从未成功 + 连续失败 >= 3」才判定该源不可用并切换到下一个。
    var FALLBACK_CHAIN = ['osm-de', 'amap-vector']
    var fallbackIdx = 0
    var tileEverOk = false
    var tileErrCount = 0
    var tileLayer = L.tileLayer(t.url, {
      subdomains: t.subs,
      maxZoom: t.max,
      attribution: t.attr
    })
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

    // 备用底图（天地图无 tk 时）：osm-de → amap-vector 防抖降级
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
    mapObj.setView(platformToLngLat(0, 15), Math.min(18, t.max))   // 东苑宿舍区
    // 普通模式套「数字孪生暗色地图」皮肤（仅地图面板）；标定模式保持原样便于拖拽
    if (!CALIB) el.classList.add('map-digital')
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
          fillColor: isLoad ? '#ffb020' : '#5aff86', fillOpacity: 1   // 站点=橙 / 途经点=荧光绿
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
    mapLayers.graph = L.polyline(pts, { color: '#45d0ff', weight: 2.5, opacity: .85 }).addTo(mapObj)   // 发光路网（青色，光晕由 CSS drop-shadow 提供）
  }

  // 路线（虚线）+ 停靠序号
  function updateRoutes(routes) {
    var r = (routes || []).filter(function (x) { return x && x.stops && x.stops.length > 1 })[0]
    var pts = r ? llList(r.stops) : []
    if (mapLayers.route) mapLayers.route.setLatLngs(pts)
    else if (pts.length) mapLayers.route = L.polyline(pts, { color: '#66f0ff', weight: 3, dashArray: '8 6' }).addTo(mapObj)   // 配送路线（青色流动感）
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
    var map = d.map
    if (CALIB) { if (!map) return; initMap(); renderCalib(map); return }
    // 立体地图（Map3D）：静态几何来自 assets/map-calibration.json + radar-ground.png，
    // 因此平台地图接口不可用时（演示档）也能出图，只是没有实时车辆/路线。
    if (window.Map3D) {
      Map3D.ensure()
      Map3D.update(map || null, d)
      // mapMask 的显隐由 Map3D 自己管（标定文件加载成功才隐藏，失败时保留错误提示）
      if (map) txt($('mapTip'), '立体地图 · ' + (map.landmarks || []).length + ' 个点位 · ' + (map.robots || []).length + ' 台车')
      return
    }
    if (!map) return
    // 回退：雷达底图 + 发光图层（RadarMap）
    if (window.RadarMap) {
      RadarMap.ensure()
      RadarMap.update(map)
      var mask2 = $('mapMask'); if (mask2) mask2.hidden = true
      txt($('mapTip'), '雷达地图 · ' + (map.landmarks || []).length + ' 个点位 · ' + (map.graph && map.graph.nodes ? map.graph.nodes.length : 0) + ' 个路网节点')
      return
    }
    initMap()
    var mask = $('mapMask')
    if (!mapObj) {
      if (mask) { txt(mask, '地图组件加载失败（vendor/leaflet.js 缺失）'); mask.hidden = false }
      return
    }
    updateLandmarks(map)
    updateGraph(map.graph)
    updateRoutes(map.routes)
    updateCars(map.robots)
    txt($('mapTip'), (map.landmarks || []).length + ' 个点位 · ' + (map.graph && map.graph.nodes ? map.graph.nodes.length : 0) + ' 个路网节点')
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
    // 无人车位置单独高频轮询 —— 让车在地图上连续移动（overview 5s 一次太慢）
    pollRobots()
    setInterval(pollRobots, ROBOT_POLL_MS)
    setInterval(memoryGuard, 60000)
    setInterval(dailyReload, 60000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
