/* ============================================================
 * 雷达地图渲染器（radarMap.js）
 * ------------------------------------------------------------
 * 只替换大屏左中「地图面板」的渲染：用【平台雷达底图】做底（它的路网就是正确路线），
 * 在其上用 canvas 叠加发光矢量图层：青色道路 / 橙绿点位 / 白黑小车 / 流动配送光轨。
 * 所有覆盖层都用「平台 bbox 百分比」直接映射到底图上，与点位/小车同一坐标系 → 零误差。
 * 不依赖在线瓦片、不依赖天地图 tk、不参与四周信息模块。
 * 对外 API：
 *   RadarMap.ensure()          在 #mapBox 里建 canvas + 拉底图
 *   RadarMap.update(map)       喂给 /api/dashboard/overview 的 map 数据（dashboard 已有，不需重复轮询）
 * ============================================================ */
window.RadarMap = (function () {
  var MAP_IMG = (location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '') + '/api/dashboard/map-image'

  var cvs = null, ctx = null, box = null
  var W = 0, H = 0, DPR = 1
  var started = false

  var baseImg = null            // 雷达底图 Image
  var boundLines = null         // 底图深色边界矢量化 + 平滑后的「连续曲线」列表
  var mod = { pts: [], roads: [], routes: [], robots: [] }
  var world = null              // {minX,maxX,minY,maxY}
  var lay = null                // {s, ox, oy, iw, ih}  底图对应到 canvas 的缩放/平移
  var robotsAnim = {}
  var flowParticles = []
  var hasMap = false

  // -------- 亮色配色（用户要求比暗色更亮） --------
  var PAL = {
    clear: '#d6e2f0',
    roadCore: '#ffffff', roadMain: '#0e8bf0', roadSub: '#3fa8f2',
    roadGlow: 'rgba(14,139,240,0.9)',
    flow: '#16c7ff', flowGlow: 'rgba(22,199,255,0.95)',
    station: '#ffab11', stationGlow: 'rgba(255,171,17,1)',
    way: '#2fd45c', wayGlow: 'rgba(47,212,92,0.95)',
    robotBody: '#ffffff', robotDk: '#14202e', robotGlow: 'rgba(56,168,255,0.95)'
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

  // 把路网(边图)分解成连续的路径线（trail）→ 用 Catmull-Rom 平滑成真实地图感的道路。
  // 所有坐标仍是平台坐标，仅变换中心线的表达方式，不改变比例与位置。
  function buildTrails(g) {
    var nd = {}
    ;(g.nodes || []).forEach(function (n) { nd[n.id] = { x: num(n.x), y: num(n.y) } })
    var adj = {}, deg = {}
    ;(g.edges || []).forEach(function (e) {
      var a = e[0], b = e[1]
      if (!nd[a] || !nd[b]) return
      ;(adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a)
      deg[a] = (deg[a] || 0) + 1; deg[b] = (deg[b] || 0) + 1
    })
    var ve = {}
    function mark(a, b) { ve[a + '|' + b] = true; ve[b + '|' + a] = true }
    function seen(a, b) { return ve[a + '|' + b] === true }
    var trails = []
    Object.keys(adj).forEach(function (a0) {
      adj[a0].forEach(function (b0) {
        if (seen(a0, b0)) return
        mark(a0, b0)
        // 沿 b0 往前
        var fwd = [], f = a0, c = b0
        while (c != null) {
          fwd.push(c)
          var nb = adj[c].filter(function (x) { return x !== f && !seen(c, x) })
          if (nb.length !== 1 || adj[c].filter(function (x) { return x !== f }).length > 1) break // 达分支/端点则停
          mark(c, nb[0]); f = c; c = nb[0]
        }
        // 沿 a0 往后
        var bwd = [], f2 = b0, c2 = a0
        while (c2 != null) {
          bwd.unshift(c2)
          var nb2 = adj[c2].filter(function (x) { return x !== f2 && !seen(c2, x) })
          if (nb2.length !== 1 || adj[c2].filter(function (x) { return x !== f2 }).length > 1) break
          mark(c2, nb2[0]); f2 = c2; c2 = nb2[0]
        }
        var seq = bwd.concat([a0]).concat(fwd)
        if (seq.length >= 2) {
          var mains = seq.some(function (id) { return (deg[id] || 0) >= 3 })
          trails.push({ main: mains, pts: seq.map(function (id) { return { x: nd[id].x, y: nd[id].y } }) })
        }
      })
    })
    return trails
  }

  // -------- 视图：滚轮缩放 / 拖拽平移（所有层同一变换，保证对齐） --------
  var view = { zoom: 1, px: 0, py: 0 }
  var MINZ = 0.5, MAXZ = 8
  function zoomAt(mx, my, z2) {
    var nz = Math.min(MAXZ, Math.max(MINZ, z2))
    var f = nz / view.zoom
    view.px = mx - (mx - view.px) * f
    view.py = my - (my - view.py) * f
    view.zoom = nz
  }
  function bindInteractions() {
    cvs.style.cursor = 'grab'
    cvs.addEventListener('wheel', function (e) {
      e.preventDefault()
      var factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
      zoomAt(e.offsetX, e.offsetY, view.zoom * factor)
    }, { passive: false })
    var drag = null
    cvs.addEventListener('mousedown', function (e) {
      drag = { x: e.clientX, y: e.clientY, px: view.px, py: view.py }
      cvs.style.cursor = 'grabbing'
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      view.px = drag.px + (e.clientX - drag.x)
      view.py = drag.py + (e.clientY - drag.y)
    })
    window.addEventListener('mouseup', function () { if (drag) { drag = null; cvs.style.cursor = 'grab' } })
    cvs.addEventListener('dblclick', function () { view.zoom = 1; view.px = 0; view.py = 0 }) // 双击复位
  }

  // -------- 布局：底图等比缩放，居中放进面板 --------
  function layout() {
    if (!baseImg || !W || !H) return
    var pad = Math.min(W, H) * 0.05
    var s = Math.min((W - pad) / baseImg.naturalWidth, (H - pad) / baseImg.naturalHeight)
    lay = {
      s: Math.max(1e-3, s),
      ox: (W - baseImg.naturalWidth * s) / 2,
      oy: (H - baseImg.naturalHeight * s) / 2,
      iw: baseImg.naturalWidth, ih: baseImg.naturalHeight
    }
  }

  function resizeF() {
    if (!box) return
    DPR = Math.min(2, window.devicePixelRatio || 1)
    W = box.clientWidth || 0
    H = box.clientHeight || 0
    if (!W || !H) return
    cvs.width = Math.round(W * DPR)
    cvs.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    layout()
  }

  // 平台 (x,y) → canvas 坐标（用 bbox 百分比，y 朝北翻转）
  function P(x, y) {
    if (!world || !lay) return null
    var fx = (x - world.minX) / ((world.maxX - world.minX) || 1)
    var fy = (world.maxY - y) / ((world.maxY - world.minY) || 1)
    return [lay.ox + fx * lay.iw * lay.s, lay.oy + fy * lay.ih * lay.s]
  }

  // -------- 数据 --------
  function update(map) {
    if (!map) return
    var bbox = map.bbox
    var lms = (map.landmarks || []).filter(function (p) {
      return p && !/固定路径|充电|排队/.test(p.name || '')
    })
    if (!bbox || !lms.length) return

    world = {
      minX: num(bbox.minX), maxX: num(bbox.maxX),
      minY: num(bbox.minY), maxY: num(bbox.maxY)
    }

    var pts = lms.map(function (p) { return { x: num(p.x), y: num(p.y), type: p.type, name: p.name } })
    var g = map.graph || { nodes: [], edges: [] }
    var trails = buildTrails(g)

    var routes = []
    ;(map.routes || []).forEach(function (rt) {
      var poly = []
      ;(rt.stops || []).forEach(function (s) { if (isFinite(num(s.x)) || isFinite(num(s.y))) poly.push([num(s.x), num(s.y)]) })
      if (poly.length >= 2) routes.push(poly)
    })

    var robots = []
    ;(map.robots || []).forEach(function (r) { robots.push({ sn: r.device_sn, x: num(r.x), y: num(r.y), theta: num(r.theta) }) })

    mod.pts = pts; mod.trails = trails; mod.routes = routes; mod.robots = robots
    hasMap = true

    var seen = {}
    robots.forEach(function (r) {
      seen[r.sn] = true
      var a = robotsAnim[r.sn]
      if (a) { a.tx = r.x; a.ty = r.y; a.tt = r.theta; a.on = true } else robotsAnim[r.sn] = { x: r.x, y: r.y, th: r.theta, tx: r.x, ty: r.y, tt: r.theta, on: true }
    })
    for (var k in robotsAnim) if (!seen[k]) robotsAnim[k].on = false

    // 流动光轨粒子
    flowParticles = []
    routes.forEach(function (poly) {
      var segs = [], total = 0
      for (var i = 0; i < poly.length - 1; i++) {
        var L2 = Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1])
        segs.push({ x1: poly[i][0], y1: poly[i][1], x2: poly[i + 1][0], y2: poly[i + 1][1], l: L2, a: total })
        total += L2
      }
      if (!total) return
      var n = Math.max(5, Math.min(24, Math.floor(total / 5)))
      for (var j = 0; j < n; j++) flowParticles.push({ segs: segs, total: total, off: total * j / n, sp: total * 0.10 })
    })
  }

  // -------- 绘制 --------
  function rr(x, y, w, h, r) {
    var rr0 = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr0, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr0)
    ctx.arcTo(x + w, y + h, x, y + h, rr0)
    ctx.arcTo(x, y + h, x, y, rr0)
    ctx.arcTo(x, y, x + w, y, rr0)
    ctx.closePath()
  }
  function li(x1, y1, x2, y2, w, color, glow, alpha) {
    ctx.strokeStyle = color
    ctx.lineWidth = w
    ctx.globalAlpha = alpha
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 14 }
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
  }

  // Catmull-Rom → 三次贝塞尔，平滑路径（pts=[{x,y}...] 屏幕坐标）
  function smoothPath(pts) {
    var n = pts.length
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (var i = 0; i < n - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)]
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y)
    }
  }

  // 沿中心线左右各偏移 halfW，得到两条边界线（左/右），并闭合为路面多边形
  function band(pts, hw) {
    if (pts.length < 2) return null
    var L = [], R = []
    for (var i = 0; i < pts.length; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[Math.min(pts.length - 1, i + 1)]
      var dx = p2.x - p0.x, dy = p2.y - p0.y
      var len = Math.hypot(dx, dy) || 1
      var nx = -dy / len, ny = dx / len   // 垂直方向
      L.push({ x: p1.x + nx * hw, y: p1.y + ny * hw })
      R.push({ x: p1.x - nx * hw, y: p1.y - ny * hw })
    }
    return { L: L, R: R }
  }

  function fillBand(b) {
    var i
    ctx.beginPath()
    ctx.moveTo(b.L[0].x, b.L[0].y)
    for (i = 1; i < b.L.length; i++) ctx.lineTo(b.L[i].x, b.L[i].y)
    for (i = b.R.length - 1; i >= 0; i--) ctx.lineTo(b.R[i].x, b.R[i].y)
    ctx.closePath()
    ctx.fill()
  }

  function draw(t) {
    ctx.fillStyle = PAL.clear
    ctx.fillRect(0, 0, W, H)
    // 地图视图变换：滚轮缩放 / 拖拽平移（底图与覆盖层同一变换，保证对齐）
    ctx.save()
    ctx.translate(view.px, view.py)
    ctx.scale(view.zoom, view.zoom)
    // 雷达底图作背景（轻微压暗，让上方平滑车道更清晰；比例/位置不变）
    if (baseImg && lay) {
      ctx.drawImage(baseImg, lay.ox, lay.oy, lay.iw * lay.s, lay.ih * lay.s)
    }
    if (!hasMap || !world) { ctx.restore(); return }

    // 道路边界：已由底图深色像素矢量化+平滑后的 boundLines 曲线绘制（见 buildBoundaryOverlay）
    // （平台 graph 只有 6 节点/4 边，覆盖面太小，不再用它画道路叠加线，避免干扰底图真实道路）

    // 配送路线 + 流动粒子
    flowParticles.forEach(function (f) {
      var p = (t * f.sp + f.off) % f.total
      var px = 0, py = 0
      for (var i = 0; i < f.segs.length; i++) {
        var sg = f.segs[i]
        if (p <= sg.a + sg.l) { var k = sg.l ? (p - sg.a) / sg.l : 0; px = sg.x1 + (sg.x2 - sg.x1) * k; py = sg.y1 + (sg.y2 - sg.y1) * k; break }
      }
      var c = P(px, py)
      if (!c) return
      ctx.beginPath(); ctx.arc(c[0], c[1], 1.8, 0, 6.2832)
      ctx.fillStyle = PAL.flow; ctx.shadowColor = PAL.flowGlow; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0
    })
    mod.routes.forEach(function (poly) {
      ctx.strokeStyle = PAL.flow; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.5; ctx.shadowColor = PAL.flowGlow; ctx.shadowBlur = 6
      ctx.beginPath()
      poly.forEach(function (pt, i) { var c = P(pt[0], pt[1]); if (!c) return; if (!i) ctx.moveTo(c[0], c[1]); else ctx.lineTo(c[0], c[1]) })
      ctx.stroke(); ctx.shadowBlur = 0; ctx.globalAlpha = 1
    })

    // 点位：橙=站点 / 荧光绿=途经点
    var now = Date.now() / 1000
    mod.pts.forEach(function (p) {
      var c = P(p.x, p.y)
      if (!c) return
      var st = p.type === 'loadingPoint'
      var col = st ? PAL.station : PAL.way
      var glow = st ? PAL.stationGlow : PAL.wayGlow
      var r = st ? 6 : 4.6
      var pls = 1 + Math.sin(now * 2.2 + p.x) * 0.12
      ctx.save()
      ctx.beginPath(); ctx.arc(c[0], c[1], r * 3.1 * pls, 0, 6.2832)
      ctx.fillStyle = glow; ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1
      ctx.shadowColor = glow; ctx.shadowBlur = 12
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c[0], c[1], r * pls, 0, 6.2832); ctx.fill()
      ctx.shadowBlur = 0
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4
      ctx.beginPath(); ctx.arc(c[0], c[1], r * pls, 0, 6.2832); ctx.stroke()
      ctx.restore()
    })

    // 小车：白/黑亮色 + 冷蓝发光
    Object.keys(robotsAnim).forEach(function (sn) {
      var a = robotsAnim[sn]
      if (!a.on) return
      a.x += (a.tx - a.x) * 0.18
      a.y += (a.ty - a.y) * 0.18
      var da = a.tt - a.th
      while (da > Math.PI) da -= 6.2832; while (da < -Math.PI) da += 6.2832
      a.th += da * 0.2
      var c = P(a.x, a.y)
      if (c) drawRobot(c[0], c[1], a.th)
    })
    ctx.restore()   // 结束地图视图变换
  }

  function drawRobot(x, y, th) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(th)
    var L = 15, sc = Math.max(0.8, Math.min(1.2, lay.s * 0.5))
    ctx.scale(sc, sc)
    ctx.shadowColor = PAL.robotGlow; ctx.shadowBlur = 12
    // 白底盘（低多边形）
    ctx.fillStyle = PAL.robotBody
    ctx.beginPath()
    ctx.moveTo(0, -L); ctx.lineTo(L * 0.62, -L * 0.18); ctx.lineTo(L * 0.48, L * 0.34)
    ctx.lineTo(0, L * 0.5); ctx.lineTo(-L * 0.48, L * 0.34); ctx.lineTo(-L * 0.62, -L * 0.18)
    ctx.closePath(); ctx.fill()
    ctx.shadowBlur = 0
    // 侧面暗面（体积感）
    ctx.fillStyle = 'rgba(20,40,70,0.28)'
    ctx.beginPath()
    ctx.moveTo(L * 0.62, -L * 0.18); ctx.lineTo(L * 0.48, L * 0.34); ctx.lineTo(0, L * 0.5 + 1.6); ctx.lineTo(0, L * 0.5); ctx.lineTo(L * 0.48, L * 0.34)
    ctx.closePath(); ctx.fill()
    // 两侧轮（黑）
    ctx.fillStyle = PAL.robotDk
    rr(-L * 0.18, -L * 0.55, 3.2, L * 0.62, 1.2); ctx.fill()
    rr(L * 0.18 - 3.2, -L * 0.55, 3.2, L * 0.62, 1.2); ctx.fill()
    // 顶舱（黑面板）
    ctx.fillStyle = 'rgba(20,32,46,0.9)'
    ctx.beginPath()
    ctx.moveTo(0, -L * 0.42); ctx.lineTo(L * 0.34, -L * 0.12); ctx.lineTo(L * 0.26, L * 0.2)
    ctx.lineTo(0, L * 0.3); ctx.lineTo(-L * 0.26, L * 0.2); ctx.lineTo(-L * 0.34, -L * 0.12)
    ctx.closePath(); ctx.fill()
    // 指示灯
    ctx.fillStyle = '#3ce6ff'; ctx.shadowColor = '#3ce6ff'; ctx.shadowBlur = 7
    ctx.beginPath(); ctx.arc(0, -L * 0.2, 1.4, 0, 6.2832); ctx.fill()
    ctx.shadowBlur = 0
    ctx.restore()
  }

  // ---- 把底图深色边界像素矢量化 → 平滑连续曲线（而非实心方块） ----
  var LUM_BOUND = 180      // 亮度低于此视为边界深色（越大越敏感/线越多；可调）
  var MIN_PTS = 5          // 短于该像素数的折线视为噪声丢弃（约合多少像素；可调）
  var GAP_MAX = 9          // 零散片段端点就近拼接的最大间距（桥接断口；可调）
  var SG_C = [-2, 3, 6, 7, 6, 3, -2], SG_D = 21   // Savitzky–Golay 二次(m=3)

  // 折线 → 最小方差平滑：局部二次最小二乘拟合（对 x、y 各自平滑，重噪声点被平均掉）
  function smoothLine(pts) {
    var L = pts.length, out = []
    for (var i = 0; i < L; i++) {
      var ax = 0, ay = 0
      for (var j = -3; j <= 3; j++) {
        var kk = i + j
        if (kk < 0 || kk >= L) continue
        var w = SG_C[j + 3]
        ax += pts[kk].x * w; ay += pts[kk].y * w
      }
      out.push({ x: ax / SG_D, y: ay / SG_D })
    }
    return out
  }

  // 把二值掩膜上的深色像素追踪成一组折线（8-连通，带方向惯性，转弯顺滑）
  function traceLines(mask, bw, bh) {
    var seen = new Uint8ClampedArray(bw * bh)
    var lines = []
    function nbrs(x, y, px, py) {
      var best = null, bestC = -1.1
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        var nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue
        if (!mask[ny * bw + nx] || seen[ny * bw + nx]) continue
        var c = 0
        if (px !== -1) {
          var vdx = nx - x, vdy = ny - y, pdx = x - px, pdy = y - py
          var ml = Math.hypot(vdx, vdy) * Math.hypot(pdx, pdy)
          c = ml ? (vdx * pdx + vdy * pdy) / ml : -1
        }
        if (c > bestC) { bestC = c; best = { x: nx, y: ny } }
      }
      return best
    }
    for (var y = 0; y < bh; y++) for (var x = 0; x < bw; x++) {
      var pi = y * bw + x
      if (!mask[pi] || seen[pi]) continue
      var cx = x, cy = y, px = -1, py = -1, pts = []
      for (;;) {
        if (seen[cy * bw + cx]) break
        seen[cy * bw + cx] = 1
        pts.push({ x: cx, y: cy })
        var nxt = nbrs(cx, cy, px, py)
        if (!nxt) break
        px = cx; py = cy
        cx = nxt.x; cy = nxt.y
      }
      if (pts.length >= MIN_PTS) lines.push(pts)
    }
    return lines
  }

  // 零散片段：按最近端点就地拼接 → 断口连成连续曲线
  function linkFragments(lines) {
    var changed = true
    while (changed) {
      changed = false
      var bi = -1, bj = -1, bd = GAP_MAX
      for (var i = 0; i < lines.length; i++) {
        var A = lines[i], a0 = A[0], aN = A[A.length - 1]
        for (var j = i + 1; j < lines.length; j++) {
          var B = lines[j], bh0 = B[0], bhN = B[B.length - 1]
          var d1 = Math.hypot(aN.x - bh0.x, aN.y - bh0.y)   // A末→B首
          var d2 = Math.hypot(bhN.x - a0.x, bhN.y - a0.y)   // B末→A首
          if (d1 < bd && d1 <= d2) { bd = d1; bi = i; bj = j }
          else if (d2 < bd) { bd = d2; bi = j; bj = i }
        }
      }
      if (bi >= 0 && bj >= 0) {
        var merged = lines[bi].concat(lines[bj])
        if (bi < bj) { lines[bi] = merged; lines.splice(bj, 1) }
        else { lines[bj] = merged; lines.splice(bi, 1) }
        changed = true
      }
    }
    return lines
  }

  function buildBoundaryOverlay() {
    if (!baseImg) { boundLines = null; return }
    var TW = 1300                                   // 处理宽度上限（提速；曲线仍按原始分辨率储存）
    var k = Math.max(1, baseImg.naturalWidth / TW)
    var bw = Math.round(baseImg.naturalWidth / k)
    var bh = Math.round(baseImg.naturalHeight / k)
    var oc = document.createElement('canvas')
    oc.width = bw; oc.height = bh
    var octx = oc.getContext('2d')
    if (!octx) return
    octx.drawImage(baseImg, 0, 0, bw, bh)
    var id = octx.getImageData(0, 0, bw, bh)
    var d = id.data, n = bw * bh
    var mask = new Uint8ClampedArray(n)
    for (var i = 0; i < n; i++) {
      var lum = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
      if (lum < LUM_BOUND) mask[i] = 1
    }
    var lines = traceLines(mask, bw, bh)
    lines = linkFragments(lines)
    // 平滑 + 还原到原始图像分辨率
    boundLines = lines.map(function (ln) {
      return smoothLine(ln).map(function (p) { return [p.x * k, p.y * k] })
    })
  }

  function frame() {
    if (!W || !H) resizeF()
    draw(Date.now() / 1000)
    requestAnimationFrame(frame)
  }

  // -------- API --------
  function ensure() {
    if (started) return
    started = true
    box = document.getElementById('mapBox')
    if (!box) return
    cvs = document.createElement('canvas')
    if (!cvs.getContext) return
    cvs.style.position = 'absolute'
    cvs.style.inset = '0'
    cvs.style.width = '100%'
    cvs.style.height = '100%'
    cvs.style.zIndex = '2'
    cvs.style.pointerEvents = 'auto'
    box.appendChild(cvs)
    ctx = cvs.getContext('2d')
    if (!ctx) return
    bindInteractions()
    resizeF()
    window.addEventListener('resize', resizeF)
    // 拉雷达底图
    var im = new Image()
    im.onload = function () { baseImg = im; layout() }
    im.onerror = function () { baseImg = null }
    im.src = MAP_IMG + '?t=' + Date.now()
    requestAnimationFrame(frame)
  }

  return { ensure: ensure, update: update }
})()