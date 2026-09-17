/* ============================================================
 * 零栋无人送餐 · 数字孪生配送地图（digital.html）
 * ------------------------------------------------------------
 * 用平台局部坐标直接在 canvas 上平面渲染（无地理误差）：
 *  - 路网 → 发光的矢量道路（主/次干道分层）
 *  - 点位 → 发光圆点（橙=站点，绿=途经点）
 *  - 配送批次路线 → 流动光轨（点与点之间的配送路径）
 *  - 机器人 → 低多边形 DAK 小车（白黑配色，随 theta 朝向）
 * 数据源：GET /api/dashboard/overview（只读，5 秒轮询）
 * ============================================================ */
(function () {
  var API = location.protocol === 'file:'
    ? 'http://127.0.0.1:3000/api/dashboard/overview'
    : '/api/dashboard/overview'
  var POLL_MS = 5000
  var FETCH_TIMEOUT = 12000

  var cvs = document.getElementById('c')
  var errEl = document.getElementById('err')
  var ctx = cvs.getContext('2d')
  var W = 0, H = 0, DPR = 1

  // ---------- 颜色 ----------
  var C = {
    bgTop: '#040a16', bgBot: '#0a1426',
    grid: 'rgba(64,150,240,0.05)',
    roadMain: '#46d6ff', roadMainGlow: 'rgba(70,214,255,0.55)',
    roadSub: '#2aa3e8',  roadSubGlow: 'rgba(42,163,232,0.35)',
    flow: '#63f0ff', flowGlow: 'rgba(99,240,255,0.7)',
    station: '#ffb020', stationGlow: 'rgba(255,160,20,0.85)',
    way: '#5aff86',      wayGlow: 'rgba(90,255,134,0.75)',
    robotBody: '#f2f7ff', robotDark: '#0b0e16', robotGlow: 'rgba(120,210,255,0.8)'
  }

  // ---------- 数据模型 ----------
  var world = null          // {minX,maxX,minY,maxY,s,ox,oy}
  var mod = { points: [], edgeLines: [], edgeMain: [], nodeDeg: {}, routes: [], robots: [] }
  var robotsAnim = {}       // device_sn -> {x,y,theta,tx,ty,ttheta,on}
  var flowParticles = []    // 流动光轨粒子
  var hasData = false

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1)
    W = cvs.clientWidth || window.innerWidth
    H = cvs.clientHeight || window.innerHeight
    cvs.width = Math.round(W * DPR)
    cvs.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    layout()
  }
  window.addEventListener('resize', resize)

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

  // 世界 → 屏幕（平台 y 朝北，翻转）
  function sx(x) { return world.ox + (x - world.minX) * world.s }
  function sy(y) { return world.oy + (world.maxY - y) * world.s }

  function layout() {
    if (!world) return
    var pad = Math.min(W, H) * 0.09
    var bw = (world.maxX - world.minX) || 1
    var bh = (world.maxY - world.minY) || 1
    world.s = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)
    world.ox = (W - bw * world.s) / 2 - world.minX * world.s
    world.oy = (H - bh * world.s) / 2 + world.maxY * world.s
  }

  // ---------- 数据摄取 ----------
  function ingest(d) {
    var map = d && d.map
    if (!map) return false
    var bbox = map.bbox
    var lms = map.landmarks || []
    var g = map.graph || { nodes: [], edges: [] }
    if (!lms.length || !bbox) return false

    // 世界范围（bbox 兜底）
    var minX = num(bbox.minX), maxX = num(bbox.maxX), minY = num(bbox.minY), maxY = num(bbox.maxY)
    if (maxX - minX < 1e-6 && maxY - minY < 1e-6) return false

    // 点位（剔除 固定路径 这个路网噪音 + 充电/排队等非配送点）
    var points = []
    lms.forEach(function (p) {
      if (/固定路径/.test(p.name || '')) return
      if (/充电|排队/.test(p.name || '')) return
      points.push({ id: p.id, name: p.name, type: p.type, x: num(p.x), y: num(p.y) })
    })
    if (!points.length) return false

    // 路网边
    var nodes = {}
    ;(g.nodes || []).forEach(function (n) { nodes[n.id] = { x: num(n.x), y: num(n.y) } })
    var nodeDeg = {}
    ;(g.edges || []).forEach(function (e) {
      var a = e[0], b = e[1]
      nodeDeg[a] = (nodeDeg[a] || 0) + 1
      nodeDeg[b] = (nodeDeg[b] || 0) + 1
    })
    var edgeLines = [], edgeMain = []
    ;(g.edges || []).forEach(function (e) {
      var a = nodes[e[0]], b = nodes[e[1]]
      if (!a || !b || (a.x === b.x && a.y === b.y)) return
      var main = (nodeDeg[e[0]] || 0) >= 3 && (nodeDeg[e[1]] || 0) >= 3
      var edge = { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
      if (main) edgeMain.push(edge); else edgeLines.push(edge)
    })

    // 路线（配送批次，按停靠点顺序）
    var routes = []
    ;(map.routes || []).forEach(function (rt) {
      var pts = []
      ;(rt.stops || []).forEach(function (s) { if (isFinite(num(s.x)) || isFinite(num(s.y))) pts.push([num(s.x), num(s.y)]) })
      if (pts.length >= 2) routes.push({ poly: pts })
    })

    // 机器人目标位置
    var robots = []
    ;(map.robots || []).forEach(function (r) {
      robots.push({ sn: r.device_sn, x: num(r.x), y: num(r.y), theta: num(r.theta) })
    })

    world = world && Math.abs(world.minX - minX) < 1e-6 && Math.abs(world.maxY - maxY) < 1e-6
      ? { minX: minX, maxX: maxX, minY: minY, maxY: maxY, s: world.s, ox: world.ox, oy: world.oy }
      : { minX: minX, maxX: maxX, minY: minY, maxY: maxY, s: 0, ox: 0, oy: 0 }
    if (!world.s) layout()

    mod.points = points
    mod.edgeLines = edgeLines
    mod.edgeMain = edgeMain
    mod.nodeDeg = nodeDeg
    mod.routes = routes
    mod.robots = robots

    // 机器人插值目标
    var seen = {}
    robots.forEach(function (r) {
      seen[r.sn] = true
      var a = robotsAnim[r.sn]
      if (a) { a.tx = r.x; a.ty = r.y; a.ttheta = r.theta; a.on = true }
      else robotsAnim[r.sn] = { x: r.x, y: r.y, theta: r.theta, tx: r.x, ty: r.y, ttheta: r.theta, on: true }
    })
    for (var k in robotsAnim) if (!seen[k]) robotsAnim[k].on = false

    // 路线生成流动光轨粒子
    flowParticles = []
    routes.forEach(function (rt) {
      var segs = [], total = 0
      for (var i = 0; i < rt.poly.length - 1; i++) {
        var len = Math.hypot(rt.poly[i + 1][0] - rt.poly[i][0], rt.poly[i + 1][1] - rt.poly[i][1])
        segs.push({ x1: rt.poly[i][0], y1: rt.poly[i][1], x2: rt.poly[i + 1][0], y2: rt.poly[i + 1][1], len: len, acc: total })
        total += len
      }
      if (!total) return
      var n = Math.max(6, Math.min(28, Math.floor(total / 4)))
      for (var j = 0; j < n; j++) flowParticles.push({ segs: segs, total: total, off: total * j / n, speed: total * 0.12 })
    })

    hasData = true
    if (errEl) errEl.style.display = 'none'
    return true
  }

  // ---------- 轮询 ----------
  var fetching = false
  function poll() {
    if (fetching) return
    fetching = true
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, FETCH_TIMEOUT)
    fetch(API, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!ingest(j && j.data)) showErr('数据未就绪（等待平台点位…）')
      })
      .catch(function () { showErr('连接中断，等待重连…') })
      .then(function () { clearTimeout(timer); fetching = false })
  }
  function showErr(t) {
    if (errEl) { errEl.style.display = 'flex'; errEl.textContent = t }
  }

  // ---------- 渲染 ----------
  function draw() {
    ctx.clearRect(0, 0, W, H)
    drawBg()
    if (!hasData || !world) { requestAnimationFrame(draw); return }
    drawGrid()
    drawRoads()
    drawRoutes()
    drawPoints()
    drawRobots()
    requestAnimationFrame(draw)
  }

  function roundRect(x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr)
    ctx.arcTo(x + w, y + h, x, y + h, rr)
    ctx.arcTo(x, y + h, x, y, rr)
    ctx.arcTo(x, y, x + w, y, rr)
    ctx.closePath()
  }

  function drawBg() {
    var gr = ctx.createLinearGradient(0, 0, 0, H)
    gr.addColorStop(0, C.bgTop)
    gr.addColorStop(1, C.bgBot)
    ctx.fillStyle = gr
    ctx.fillRect(0, 0, W, H)
    // 边缘暗角
    var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.42)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, W, H)
  }

  function drawGrid() {
    ctx.strokeStyle = C.grid
    ctx.lineWidth = 1
    var step = 62
    ctx.beginPath()
    for (var x = (0 % step); x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H) }
    for (var y = (0 % step); y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y) }
    ctx.stroke()
  }

  function lineEdge(e, w, core, glow, alpha) {
    var x1 = sx(e.x1), y1 = sy(e.y1), x2 = sx(e.x2), y2 = sy(e.y2)
    if (glow) { ctx.save(); ctx.shadowColor = glow; ctx.shadowBlur = 22 }
    ctx.strokeStyle = core
    ctx.lineWidth = w
    ctx.globalAlpha = alpha
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    ctx.globalAlpha = 1
    if (glow) ctx.restore()
  }

  function drawRoads() {
    // 次干道（后画，暗一些）
    mod.edgeLines.forEach(function (e) {
      lineEdge(e, 1.6, C.roadSub, null, 0.5)
      lineEdge(e, 5, C.roadSubGlow, C.roadSubGlow, 0.16)
    })
    // 主干道（叠加亮核心）
    mod.edgeMain.forEach(function (e) {
      lineEdge(e, 2.4, C.roadMain, C.roadMainGlow, 0.85)
      lineEdge(e, 8, C.roadMainGlow, C.roadMainGlow, 0.14)
    })
  }

  function drawRoutes() {
    if (!flowParticles.length) return
    var t = now() / 1000
    ctx.save()
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    // 光轨底
    mod.routes.forEach(function (rt) {
      ctx.strokeStyle = C.flow
      ctx.globalAlpha = 0.22
      ctx.lineWidth = 1.4
      ctx.shadowColor = C.flowGlow; ctx.shadowBlur = 6
      ctx.beginPath()
      rt.poly.forEach(function (tx, i) {
        var sxp = sx(tx[0]), syp = sy(tx[1]); if (!i) ctx.moveTo(sxp, syp); else ctx.lineTo(sxp, syp)
      })
      ctx.stroke()
    })
    // 流动粒子
    flowParticles.forEach(function (f) {
      var p = (t * f.speed + f.off) % f.total
      var px = 0, py = 0
      for (var i = 0; i < f.segs.length; i++) {
        var sg = f.segs[i]
        if (p <= sg.acc + sg.len) {
          var d = p - sg.acc, k = sg.len ? d / sg.len : 0
          px = sg.x1 + (sg.x2 - sg.x1) * k
          py = sg.y1 + (sg.y2 - sg.y1) * k
          break
        }
      }
      ctx.beginPath()
      ctx.arc(sx(px), sy(py), 1.6, 0, 6.283)
      ctx.fillStyle = C.flow
      ctx.shadowColor = C.flowGlow; ctx.shadowBlur = 8
      ctx.fill()
    })
    ctx.restore()
  }

  function drawPoints() {
    var t = now() / 1000
    mod.points.forEach(function (p) {
      var x = sx(p.x), y = sy(p.y)
      var station = p.type === 'loadingPoint'
      var col = station ? C.station : C.way
      var glow = station ? C.stationGlow : C.wayGlow
      var r = station ? 5.5 : 4.2
      var pulse = 1 + Math.sin(t * 2 + p.x) * 0.14
      ctx.save()
      // 外光晕
      ctx.beginPath(); ctx.arc(x, y, r * 3.2 * pulse, 0, 6.283)
      ctx.fillStyle = glow; ctx.globalAlpha = 0.16; ctx.fill()
      ctx.globalAlpha = 1
      ctx.shadowColor = glow; ctx.shadowBlur = 12
      ctx.beginPath(); ctx.arc(x, y, r * pulse, 0, 6.283)
      ctx.fillStyle = col; ctx.fill()
      ctx.shadowBlur = 0
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath(); ctx.arc(x, y, r * pulse, 0, 6.283); ctx.stroke()
      ctx.restore()
    })
  }

  function drawRobots() {
    var t = now() / 1000
    Object.keys(robotsAnim).forEach(function (sn) {
      var a = robotsAnim[sn]
      if (!a.on) return
      // 缓动逼近目标
      a.x += (a.tx - a.x) * 0.18
      a.y += (a.ty - a.y) * 0.18
      // 角度取最短角差
      var da = a.ttheta - a.theta
      while (da > Math.PI) da -= 6.283; while (da < -Math.PI) da += 6.283
      a.theta += da * 0.2
      drawRobot(sx(a.x), sy(a.y), a.theta, t + sn.length)
    })
  }

  function drawRobot(x, y, theta, ph) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(theta)
    var L = 17, Hw = 6, scale = Math.max(0.75, Math.min(1.15, world.s * 0.35))
    ctx.scale(scale, scale)
    ctx.shadowColor = C.robotGlow; ctx.shadowBlur = 14
    // 底盘（低多边形）
    ctx.fillStyle = C.robotBody
    ctx.beginPath()
    ctx.moveTo(0, -L)
    ctx.lineTo(L * 0.62, -L * 0.18)
    ctx.lineTo(L * 0.48, L * 0.34)
    ctx.lineTo(0, L * 0.5)
    ctx.lineTo(-L * 0.48, L * 0.34)
    ctx.lineTo(-L * 0.62, -L * 0.18)
    ctx.closePath()
    ctx.fill()
    ctx.shadowBlur = 0
    // 体积侧面（右下面暗面）
    ctx.fillStyle = 'rgba(20,40,70,0.5)'
    ctx.beginPath()
    ctx.moveTo(L * 0.62, -L * 0.18); ctx.lineTo(L * 0.48, L * 0.34)
    ctx.lineTo(0, L * 0.5 + 1.6); ctx.lineTo(0, L * 0.5); ctx.lineTo(L * 0.48, L * 0.34)
    ctx.closePath(); ctx.fill()
    // 两侧轮（黑）
    ctx.fillStyle = C.robotDark
    roundRect(-L * 0.18, -L * 0.55, 3.2, L * 0.62, 1.2); ctx.fill()
    roundRect(L * 0.18 - 3.2, -L * 0.55, 3.2, L * 0.62, 1.2); ctx.fill()
    // 顶舱深色（黑面板）
    ctx.fillStyle = 'rgba(10,14,22,0.92)'
    ctx.beginPath()
    ctx.moveTo(0, -L * 0.42)
    ctx.lineTo(L * 0.34, -L * 0.12)
    ctx.lineTo(L * 0.26, L * 0.2)
    ctx.lineTo(0, L * 0.3)
    ctx.lineTo(-L * 0.26, L * 0.2)
    ctx.lineTo(-L * 0.34, -L * 0.12)
    ctx.closePath(); ctx.fill()
    // 指示灯（呼吸感）
    ctx.fillStyle = '#7ff0ff'; ctx.shadowColor = '#7ff0ff'; ctx.shadowBlur = 8
    ctx.beginPath(); ctx.arc(0, -L * 0.2, 1.5, 0, 6.283); ctx.fill()
    ctx.shadowBlur = 0
    ctx.restore()
  }

  function now() { return Date.now() }

  // ---------- 启动 ----------
  resize()
  poll()
  draw()
  setInterval(poll, POLL_MS)
})()