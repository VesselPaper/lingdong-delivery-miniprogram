/* ============================================================
 * map3d.js — 2.5D 斜轴测地图渲染器（window.Map3DFlat）
 * ------------------------------------------------------------
 * 这是 WebGL 不可用时的**回退实现**（Canvas 2D 伪 3D）。
 * 正常情况下大屏用 map3d-gl.js 的真三维渲染；入口在 map3d-entry.js。
 * 几何与场景构建复用 map3d-core.js（与 mapfit/preview3d.js 同一套代码）。
 *
 * 数据：
 *   静态   assets/map-calibration.js（OSM 真实楼栋轮廓 + 道路 + 雷达走廊骨架）
 *          assets/radar-ground.png    （重绘后的雷达底图：蓝色走廊 + 柔光）
 *   动态   /api/dashboard/overview 的 map.landmarks / map.robots / map.routes
 *   演示   无实时数据时自动让 2~3 台车沿骨架路线跑
 * ============================================================ */
window.Map3DFlat = (function () {
  'use strict'
  var core = window.Map3DCore
  var ASSET = 'assets/'

  var cvs = null, ctx = null, box = null
  var W = 0, H = 0, DPR = 1
  var started = false, ready = false
  var calib = null, groundImg = null, groundReady = false
  var view = null
  var opts = { tilt: 54, zScale: 1.65, labels: true, paths: true, roads: true }
  var viewT = { zoom: 1, panX: 0, panY: 0 }
  var staticCvs = null, staticCtx = null, staticDirty = true
  var live = { bbox: null, robots: [], routes: [], landmarks: [] }
  var robotAnim = {}
  var demo = null
  var errEl = null, tipEl = null

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

  /* ---------------- 初始化 ---------------- */
  function ensure() {
    if (started) return
    started = true
    box = document.getElementById('mapBox')
    if (!box) return
    cvs = document.createElement('canvas')
    cvs.style.position = 'absolute'
    cvs.style.inset = '0'
    cvs.style.width = '100%'
    cvs.style.height = '100%'
    cvs.style.zIndex = '2'
    cvs.style.pointerEvents = 'auto'
    box.appendChild(cvs)
    ctx = cvs.getContext('2d')
    errEl = document.getElementById('mapMask')
    tipEl = document.getElementById('mapTip')
    bindInteractions()
    bindControls()
    resize()
    window.addEventListener('resize', resize)
    loadAssets()
    requestAnimationFrame(frame)
  }

  function loadAssets() {
    // 标定数据优先用 <script> 引入的 window.MAP_CALIBRATION：
    // 大屏允许用 file:// 双击打开，那种情况下 XMLHttpRequest 读本地 JSON 会被浏览器直接拦掉
    // （页面其它脚本都正常、唯独地图报"标定文件加载失败"，就是这个原因）。
    if (window.MAP_CALIBRATION) {
      applyCalib(window.MAP_CALIBRATION, 'script')
    } else {
      var url = ASSET + 'map-calibration.json'
      var xhr = new XMLHttpRequest()
      xhr.open('GET', url, true)
      xhr.onload = function () {
        if (xhr.status !== 200 && xhr.status !== 0) return fail('HTTP ' + xhr.status + ' · ' + url)
        try { applyCalib(JSON.parse(xhr.responseText), 'xhr') }
        catch (e) { fail('解析失败：' + e.message + ' · ' + url) }
      }
      xhr.onerror = function () { fail('请求失败 · ' + url) }
      try { xhr.send() } catch (e) { fail('请求异常：' + e.message + ' · ' + url) }
    }

    var im = new Image()
    im.onload = function () { groundImg = im; groundReady = true; staticDirty = true }
    im.onerror = function () { groundReady = false }
    im.src = ASSET + 'radar-ground.png'
  }

  function applyCalib(c, from) {
    if (!c || !c.buildings || !c.buildings.length) return fail('标定数据为空（来源 ' + from + '）')
    calib = c
    ready = true
    staticDirty = true
    if (errEl) errEl.hidden = true
    info(tipEl, calib.buildings.length + ' 栋楼 · ' + (calib.paths || []).length + ' 段雷达路线 · ' + (calib.roads || []).length + ' 条道路')
  }

  function fail(why) {
    if (!errEl) return
    errEl.hidden = false
    errEl.textContent = '地图标定文件加载失败：' + why + '（协议 ' + location.protocol + '）' +
      ' —— 请确认 assets/map-calibration.js 存在；若是 file:// 打开，需用 script 方式引入标定数据'
  }

  function info(el, t) { if (el) { el.textContent = t; el.hidden = false } }

  /* ---------------- 尺寸/视图 ---------------- */
  function resize() {
    if (!box) return
    DPR = Math.min(2, window.devicePixelRatio || 1)
    W = box.clientWidth || 0
    H = box.clientHeight || 0
    if (!W || !H) return
    cvs.width = Math.round(W * DPR)
    cvs.height = Math.round(H * DPR)
    makeView()
    staticDirty = true
  }

  function makeView() {
    if (!W || !H) return
    var w = null
    if (calib) {
      var maxH = 0
      for (var i = 0; i < calib.buildings.length; i++) maxH = Math.max(maxH, num(calib.buildings[i].height_m) * calib.scale_px_per_m)
      var RF = calib.radar_full_size || [5786, 5406]
      w = { minX: 0, minY: 0, maxX: RF[0], maxY: RF[1], maxZ: maxH * opts.zScale }
    }
    view = core.makeView(W, H, calib || {}, {
      tilt: opts.tilt, zScale: opts.zScale,
      zoom: viewT.zoom, panX: viewT.panX, panY: viewT.panY
    }, w || { minX: 0, minY: 0, maxX: 1000, maxY: 1000, maxZ: 0 })
    staticDirty = true
  }

  /* ---------------- 交互 ---------------- */
  function bindInteractions() {
    cvs.style.cursor = 'grab'
    cvs.addEventListener('wheel', function (e) {
      e.preventDefault()
      var f = e.deltaY < 0 ? 1.15 : 1 / 1.15
      var nz = Math.min(6, Math.max(0.6, viewT.zoom * f))
      var k = nz / viewT.zoom
      viewT.panX = e.offsetX - (e.offsetX - viewT.panX) * k
      viewT.panY = e.offsetY - (e.offsetY - viewT.panY) * k
      viewT.zoom = nz
      makeView()
    }, { passive: false })
    var drag = null
    cvs.addEventListener('mousedown', function (e) {
      drag = { x: e.clientX, y: e.clientY, px: viewT.panX, py: viewT.panY }
      cvs.style.cursor = 'grabbing'
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      viewT.panX = drag.px + (e.clientX - drag.x)
      viewT.panY = drag.py + (e.clientY - drag.y)
      makeView()
    })
    window.addEventListener('mouseup', function () { if (drag) { drag = null; cvs.style.cursor = 'grab' } })
    cvs.addEventListener('dblclick', resetView)
  }
  function resetView() {
    viewT.zoom = 1; viewT.panX = 0; viewT.panY = 0
    makeView()
  }

  /* ---------------- 静态图层（缓存到离屏画布） ---------------- */
  function buildStatic() {
    if (!ready || !view) return
    if (!staticCvs) {
      staticCvs = document.createElement('canvas')
      staticCtx = staticCvs.getContext('2d')
    }
    if (staticCvs.width !== cvs.width || staticCvs.height !== cvs.height) {
      staticCvs.width = cvs.width
      staticCvs.height = cvs.height
    }
    var g = staticCtx
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, staticCvs.width, staticCvs.height)
    g.setTransform(DPR, 0, 0, DPR, 0, 0)
    g.fillStyle = core.THEME.pageBg
    g.fillRect(0, 0, W, H)

    var usePaths = opts.paths ? calib.paths : []
    var scene = core.buildScene(view, {
      radar_full_size: calib.radar_full_size,
      scale_px_per_m: calib.scale_px_per_m,
      rotation_deg: calib.rotation_deg,
      buildings: calib.buildings,
      roads: opts.roads ? calib.roads : [],
      paths: usePaths
    }, null, { labels: opts.labels })

    // 地面：把雷达底图按地平面仿射贴上去
    if (groundReady && scene.ground) {
      var A = scene.ground.affine
      g.save()
      g.setTransform(A.a * DPR, A.b * DPR, A.c * DPR, A.d * DPR, A.e * DPR, A.f * DPR)
      g.imageSmoothingEnabled = true
      g.drawImage(groundImg, 0, 0, scene.ground.imgW, scene.ground.imgH)
      g.restore()
      // 底图边界
      g.strokeStyle = core.THEME.mapEdge
      g.lineWidth = 1.2
      g.beginPath()
      var clip = scene.ground.clip
      g.moveTo(clip[0][0], clip[0][1])
      for (var ci = 1; ci < clip.length; ci++) g.lineTo(clip[ci][0], clip[ci][1])
      g.closePath()
      g.stroke()
    }

    // 按深度绘制几何
    for (var i = 0; i < scene.items.length; i++) drawItem(g, scene.items[i], view)

    // 标签（白描边 + 深色字，任何底色上都可读）
    if (opts.labels) {
      g.textBaseline = 'middle'
      for (var li = 0; li < scene.labels.length; li++) {
        var lb = scene.labels[li]
        var big = lb.kind === 'name'
        g.font = (big ? 'bold 12px ' : '11px ') + '"Microsoft YaHei",sans-serif'
        g.lineWidth = 3
        g.strokeStyle = core.THEME.labelHalo
        g.strokeText(lb.text, lb.x, lb.y)
        g.fillStyle = big ? '#0d2a4a' : '#4a6280'
        g.fillText(lb.text, lb.x, lb.y)
      }
    }
    staticDirty = false
  }

  function drawItem(g, it, v) {
    if (it.kind === 'poly') {
      g.beginPath()
      g.moveTo(it.pts[0][0], it.pts[0][1])
      for (var i = 1; i < it.pts.length; i++) g.lineTo(it.pts[i][0], it.pts[i][1])
      g.closePath()
      g.fillStyle = it.fill
      g.fill()
      if (it.stroke) {
        g.strokeStyle = it.stroke
        g.lineWidth = it.lw || 1
        g.stroke()
      }
    } else if (it.kind === 'line') {
      var wpx = it.world ? it.wpx * v.S * v.zoom : (it.wpx || it.lw || 2)
      if (wpx < 0.6) wpx = 0.6
      g.lineCap = 'round'
      g.lineJoin = 'round'
      if (it.glow) {
        g.strokeStyle = it.glow
        g.lineWidth = wpx * 2.6
        strokePts(g, it.pts)
      }
      if (it.dash) g.setLineDash(it.dash)
      g.strokeStyle = it.stroke
      g.lineWidth = wpx
      strokePts(g, it.pts)
      g.setLineDash([])
    } else if (it.kind === 'dot') {
      if (it.glow) {
        g.beginPath()
        g.arc(it.pt[0], it.pt[1], (it.r || 4) * 2.6, 0, 6.2832)
        g.fillStyle = it.glow
        g.globalAlpha = 0.55
        g.fill()
        g.globalAlpha = 1
      }
      g.beginPath()
      g.arc(it.pt[0], it.pt[1], it.r || 4, 0, 6.2832)
      g.fillStyle = it.fill
      g.fill()
      if (it.stroke) { g.strokeStyle = it.stroke; g.lineWidth = it.lw || 2; g.stroke() }
    }
  }
  function strokePts(g, pts) {
    g.beginPath()
    g.moveTo(pts[0][0], pts[0][1])
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
    g.stroke()
  }

  /* ---------------- 动态层（车辆 / 实时路线 / 呼吸点） ---------------- */
  // 把一批"平台坐标的机器人"并进 robotAnim（每帧插值 → 连续移动）
  function ingestRobots(list) {
    var seen = {}
    for (var i = 0; i < (list || []).length; i++) {
      var r = list[i]
      if (!r || !r.device_sn) continue
      if (r.x == null || r.y == null || !isFinite(num(r.x)) || !isFinite(num(r.y))) continue
      var sn = r.device_sn
      seen[sn] = 1
      var a = robotAnim[sn]
      if (a) {
        a.tx = num(r.x); a.ty = num(r.y); a.tt = num(r.theta); a.on = true
        if (r.text) a.text = r.text
      } else {
        robotAnim[sn] = { x: num(r.x), y: num(r.y), th: num(r.theta), tx: num(r.x), ty: num(r.y), tt: num(r.theta), on: true, text: r.text || '' }
      }
    }
    for (var k in robotAnim) if (!seen[k]) robotAnim[k].on = false
  }
  // 高频轮询入口：只更新车辆位置
  function setRobots(list) {
    live.robots = list || []
    ingestRobots(live.robots)
    return live.robots.length
  }

  function update(map) {
    ensure()
    if (!started) return
    if (map) {
      live.bbox = map.bbox || null
      live.robots = map.robots || []
      live.routes = map.routes || []
      live.landmarks = map.landmarks || []
      ingestRobots(live.robots)
    } else if (!live.robots.length) {
      live.bbox = null; live.routes = []; live.landmarks = []
    }
  }

  /* 演示车：沿雷达骨架路线跑（无实时数据时让大屏不空） */
  function initDemo() {
    if (!calib || !calib.paths || !calib.paths.length) return null
    var ps = calib.paths.slice().sort(function (a, b) { return (b.len_px || 0) - (a.len_px || 0) }).slice(0, 3)
    var cars = []
    for (var i = 0; i < ps.length; i++) {
      var pts = ps[i].pts
      if (!pts || pts.length < 2) continue
      var segs = [], total = 0
      for (var j = 0; j < pts.length - 1; j++) {
        var L = Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1])
        segs.push({ a: pts[j], b: pts[j + 1], L: L, acc: total })
        total += L
      }
      if (total > 1) cars.push({ segs: segs, total: total, off: total * (0.15 + 0.3 * i), sp: total * 0.02, sn: 'DEMO-' + (i + 1) })
    }
    return cars.length ? cars : null
  }
  function demoCarsPos(t) {
    if (!demo) return []
    var out = []
    for (var i = 0; i < demo.length; i++) {
      var c = demo[i]
      var p = (t * c.sp + c.off) % c.total
      for (var j = 0; j < c.segs.length; j++) {
        var s = c.segs[j]
        if (p <= s.acc + s.L) {
          var k = s.L ? (p - s.acc) / s.L : 0
          out.push({
            sn: c.sn, x: s.a[0] + (s.b[0] - s.a[0]) * k, y: s.a[1] + (s.b[1] - s.a[1]) * k,
            theta: Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]), demo: true
          })
          break
        }
      }
    }
    return out
  }

  var lastT = 0
  function frame(ts) {
    requestAnimationFrame(frame)
    var t = (ts || 0) / 1000
    if (!cvs || !W || !H) return
    if (staticDirty) buildStatic()
    if (!staticCvs) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cvs.width, cvs.height)
    ctx.drawImage(staticCvs, 0, 0)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    if (!ready || !view) return

    // 动态：实时路线（流动虚线）
    if (live.bbox && live.routes.length) {
      var p2r = core.makePlatformToRadar(live.bbox, calib.radar_full_size[0], calib.radar_full_size[1])
      if (p2r) {
        ctx.lineCap = 'round'
        for (var ri = 0; ri < live.routes.length; ri++) {
          var stops = (live.routes[ri] && live.routes[ri].stops) || []
          if (stops.length < 2) continue
          ctx.beginPath()
          for (var si = 0; si < stops.length; si++) {
            var rp = p2r(stops[si].x, stops[si].y)
            var sp = core.project(view, rp[0], rp[1], 9)
            if (!si) ctx.moveTo(sp[0], sp[1]); else ctx.lineTo(sp[0], sp[1])
          }
          ctx.setLineDash([9, 7])
          ctx.lineDashOffset = -t * 26
          ctx.strokeStyle = core.THEME.route
          ctx.lineWidth = 2.6
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    }

    // 动态：车辆
    var cars = []
    var anyLive = false
    for (var k in robotAnim) {
      var a = robotAnim[k]
      if (!a.on) continue
      anyLive = true
      a.x += (a.tx - a.x) * 0.15
      a.y += (a.ty - a.y) * 0.15
      var da = a.tt - a.th
      while (da > Math.PI) da -= 6.2832
      while (da < -Math.PI) da += 6.2832
      a.th += da * 0.18
      cars.push({ x: a.x, y: a.y, theta: a.th, live: true })
    }
    if (!anyLive) {
      if (!demo) demo = initDemo()
      cars = demoCarsPos(t)
    }
    // 平台坐标 -> 雷达像素
    var conv = (live.bbox && anyLive) ? core.makePlatformToRadar(live.bbox, calib.radar_full_size[0], calib.radar_full_size[1]) : null
    for (var ci = 0; ci < cars.length; ci++) {
      var c = cars[ci]
      var wx = c.x, wy = c.y
      if (c.live) {
        if (!conv) continue          // 缺少平台 bbox 时无法换算，宁可不画也不画错位置
        var q = conv(c.x, c.y); wx = q[0]; wy = q[1]
      }
      drawCar(ctx, view, wx, wy, c.theta, c.live)
    }

    // 配送点呼吸（静态层之上的轻动效）
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.2)
    ctx.globalAlpha = 0.10 + 0.16 * pulse
    ctx.strokeStyle = core.THEME.pin
    ctx.lineWidth = 2
    for (var bi = 0; bi < calib.buildings.length; bi++) {
      var b = calib.buildings[bi]
      if (!/栋/.test(b.name || '')) continue
      var hpx = num(b.height_m) * calib.scale_px_per_m
      var tip = core.project(view, b.center[0], b.center[1], hpx + 3.5 * calib.scale_px_per_m)
      ctx.beginPath()
      ctx.arc(tip[0], tip[1], 5 + 7 * pulse, 0, 6.2832)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    lastT = t
  }

  function drawCar(g, v, x, y, theta, live) {
    var geo = core.carGeometry(v, x, y, theta)
    var base = geo.base, top = geo.top
    var cx = (top[0][0] + top[2][0]) / 2, cy = (top[0][1] + top[2][1]) / 2
    // 地面阴影
    g.beginPath()
    g.ellipse ? g.ellipse(cx, cy, 13, 6, 0, 0, 6.2832) : g.arc(cx, cy, 9, 0, 6.2832)
    g.fillStyle = 'rgba(20,52,92,0.28)'
    g.fill()
    // 侧面
    for (var i = 0; i < 4; i++) {
      g.beginPath()
      g.moveTo(base[i][0], base[i][1])
      g.lineTo(base[(i + 1) % 4][0], base[(i + 1) % 4][1])
      g.lineTo(top[(i + 1) % 4][0], top[(i + 1) % 4][1])
      g.lineTo(top[i][0], top[i][1])
      g.closePath()
      g.fillStyle = live ? '#2a4a70' : '#3c5f86'
      g.fill()
    }
    // 顶面
    g.beginPath()
    g.moveTo(top[0][0], top[0][1])
    for (var j = 1; j < 4; j++) g.lineTo(top[j][0], top[j][1])
    g.closePath()
    g.fillStyle = '#ffffff'
    g.fill()
    // 舱体
    var mx = 0, my = 0
    for (var m = 0; m < 4; m++) { mx += top[m][0] / 4; my += top[m][1] / 4 }
    g.beginPath()
    for (var n = 0; n < 4; n++) {
      var px = mx + (top[n][0] - mx) * 0.55, py = my + (top[n][1] - my) * 0.55
      if (!n) g.moveTo(px, py); else g.lineTo(px, py)
    }
    g.closePath()
    g.fillStyle = core.THEME.carTop
    g.fill()
    // 指示灯
    g.beginPath()
    g.arc(top[0][0] * 0.2 + top[2][0] * 0.8, top[0][1] * 0.2 + top[2][1] * 0.8, 3.2, 0, 6.2832)
    g.fillStyle = '#3ce6ff'
    g.fill()
  }

  /* ---------------- 页面控件 ---------------- */
  function bindControls() {
    // 控件与真 3D 版共用；这里把语义换算到 2.5D 的参数上：
    //   俯仰滑块（3~88，越大越接近垂直俯视）→ 2.5D 的 tilt = 90 - 俯仰
    //   高度滑块（20~200）→ zScale = 值/100 × 2.6
    var tilt = document.getElementById('m3Tilt')
    if (tilt) {
      opts.tilt = 90 - Number(tilt.value)
      tilt.addEventListener('input', function () { opts.tilt = 90 - Number(tilt.value); makeView() })
    }
    var hgt = document.getElementById('m3Height')
    if (hgt) {
      opts.zScale = Number(hgt.value) / 100 * 2.6
      hgt.addEventListener('input', function () { opts.zScale = Number(hgt.value) / 100 * 2.6; makeView() })
    }
    var lb = document.getElementById('m3Label')
    if (lb) lb.addEventListener('click', function () {
      opts.labels = !opts.labels
      lb.classList.toggle('on', opts.labels)
      staticDirty = true
    })
    var pth = document.getElementById('m3Path')
    if (pth) pth.addEventListener('click', function () {
      opts.paths = !opts.paths
      pth.classList.toggle('on', opts.paths)
      staticDirty = true
    })
    var rd = document.getElementById('m3Road')
    if (rd) rd.addEventListener('click', function () {
      opts.roads = !opts.roads
      rd.classList.toggle('on', opts.roads)
      staticDirty = true
    })
    var rst = document.getElementById('mapReset')
    if (rst) { rst.hidden = false; rst.onclick = resetView }
  }

  /* ---------------- 视角控制（供页面按钮调用） ---------------- */
  function setOpts(o) {
    for (var k in o) if (o.hasOwnProperty(k)) opts[k] = o[k]
    makeView()
  }
  function getOpts() { return opts }

  return { ensure: ensure, update: update, resetView: resetView, setOpts: setOpts, getOpts: getOpts, setRobots: setRobots }
})()
