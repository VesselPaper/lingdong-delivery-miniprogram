/* ============================================================
 * map3d-core.js — 立体地图的几何/场景核心（浏览器与 Node 预览共用）
 * ------------------------------------------------------------
 * 为什么单独一个文件：本机无法截图浏览器页面，所以用 Node 渲染一张
 * 预览 PNG 来校验几何 —— 两边必须用**同一套**投影与场景构建代码。
 *
 * 投影：斜轴测（oblique / cabinet）
 *   1) 场景绕原点旋转 rot（把 SLAM 建图坐标系摆正：雷达图相对正北 +20.42°）
 *   2) 地平面按 cos(tilt) 竖向压扁（俯视角）
 *   3) 高度 z 沿屏幕右上方偏移（kx, kz）—— 于是整体仍是**仿射**，
 *      底图可以直接用 canvas setTransform 贴图，零误差。
 *
 * 世界坐标 = 雷达底图像素（x 右, y 下），z = 高度（像素，向上为正）。
 * ============================================================ */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Map3DCore = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var D2R = Math.PI / 180

  var THEME = {
    pageBg: '#e6ecf5',
    mapEdge: 'rgba(150,182,214,0.80)',
    roadMain: '#d6dfec',
    roadRoad: '#e2e9f3',
    roadWalk: '#ecf0f7',
    // 楼栋来自 OSM，是"环境参照"；雷达扫描的走廊/路线才是主体。
    // 侧面半透明（能透出底下的走廊），顶面做实 —— 读起来像"玻璃体块"，体量清晰。
    bWall: 'rgba(170,192,218,0.55)', bTop: 'rgba(238,244,251,1)', bEdge: 'rgba(96,130,170,0.42)',
    dWall: 'rgba(116,164,218,0.78)', dTop: 'rgba(204,225,248,1)', dEdge: 'rgba(24,72,140,0.62)',
    shadow: 'rgba(30,62,102,0.11)',
    route: '#16c7ff', routeGlow: 'rgba(22,199,255,0.50)',
    path: '#0b9fe4', pathGlow: 'rgba(11,159,228,0.55)', pathCase: 'rgba(255,255,255,0.85)',
    routeDone: '#8fa6bd',
    pin: '#e0402a', pinGlow: 'rgba(224,64,42,0.35)',
    carBody: '#ffffff', carTop: '#16283c', carGlow: 'rgba(56,168,255,0.85)',
    label: '#0d2a4a', labelHalo: 'rgba(255,255,255,0.92)'
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

  /* ---------------- 视图 ---------------- */
  // opts: { rot(deg), tilt(deg), kx, kz, zScale, zoom, panX, panY }
  // calib 提供 px_per_m；bounds 为需要装进画面的世界范围（可选）
  function makeView(w, h, calib, opts, world) {
    opts = opts || {}
    var v = {
      w: w, h: h,
      rot: (opts.rot != null ? opts.rot : -(num(calib.rotation_deg))) * D2R,
      tilt: (opts.tilt != null ? opts.tilt : 56) * D2R,
      kx: opts.kx != null ? opts.kx : 0.34,
      kz: opts.kz != null ? opts.kz : 0.78,
      zScale: opts.zScale != null ? opts.zScale : 1.7,
      zoom: opts.zoom != null ? opts.zoom : 1,
      panX: opts.panX || 0,
      panY: opts.panY || 0,
      pxPerM: num(calib.scale_px_per_m) || 19.45
    }
    var R = v.rot, T = v.tilt
    v.cosR = Math.cos(R); v.sinR = Math.sin(R)
    v.cosT = Math.cos(T)
    v.S = 1; v.OX = 0; v.OY = 0
    fit(v, world, opts.pad != null ? opts.pad : 0.085)
    return v
  }

  // 以 S=1 计算投影包围盒，再求缩放与平移（投影对 S 是线性的，故可解析求解）
  function fit(v, world, padFrac) {
    var bb = world || { minX: 0, minY: 0, maxX: 1000, maxY: 1000, maxZ: 20 * v.pxPerM * v.zScale }
    var zMax = num(bb.maxZ) || 0
    var corners = [
      [bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.minX, bb.maxY], [bb.maxX, bb.maxY]
    ]
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (var zi = 0; zi <= 1; zi++) {
      var z = zi ? zMax : 0
      for (var i = 0; i < corners.length; i++) {
        var p = raw(v, corners[i][0], corners[i][1], z)
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]
      }
    }
    var pad = Math.min(v.w, v.h) * padFrac
    var bw = Math.max(1e-6, maxX - minX), bh = Math.max(1e-6, maxY - minY)
    var s = Math.min((v.w - pad * 2) / bw, (v.h - pad * 2) / bh)
    v.S = s
    v.OX = (v.w - bw * s) / 2 - minX * s
    v.OY = (v.h - bh * s) / 2 - minY * s
  }

  // 未含缩放/平移的投影（S=1 基准）
  function raw(v, x, y, z) {
    var u = x * v.cosR - y * v.sinR
    var w2 = x * v.sinR + y * v.cosR
    var zz = num(z) * v.zScale
    return [u + zz * v.kx, w2 * v.cosT - zz * v.kz]
  }

  function project(v, x, y, z) {
    var p = raw(v, x, y, z)
    return [p[0] * v.S * v.zoom + v.OX + v.panX, p[1] * v.S * v.zoom + v.OY + v.panY]
  }
  function unproject(v, sx, sy) {   // 屏幕 -> 世界（z=0 平面反解，用于拖拽/命中）
    var a = (sx - v.OX - v.panX) / (v.S * v.zoom), b = (sy - v.OY - v.panY) / (v.S * v.zoom)
    var w2 = b / v.cosT
    return [a * v.cosR + w2 * v.sinR, -a * v.sinR + w2 * v.cosR]
  }

  // 地平面(z=0)的仿射：canvas setTransform(a,b,c,d,e,f)
  function groundAffine(v) {
    var s = v.S * v.zoom
    return {
      a: s * v.cosR, b: s * v.cosT * v.sinR,
      c: -s * v.sinR, d: s * v.cosT * v.cosR,
      e: v.OX + v.panX, f: v.OY + v.panY
    }
  }

  /* ---------------- 平台坐标 -> 雷达像素 ---------------- */
  // 平台 bbox 是其底图的自身约定（与 dashboard 原逻辑一致）；y 翻转
  function makePlatformToRadar(bbox, radarW, radarH) {
    if (!bbox) return null
    var minX = num(bbox.minX), maxX = num(bbox.maxX), minY = num(bbox.minY), maxY = num(bbox.maxY)
    if (maxX - minX < 1e-9 || maxY - minY < 1e-9) return null
    return function (x, y) {
      return [(num(x) - minX) / (maxX - minX) * radarW, (maxY - num(y)) / (maxY - minY) * radarH]
    }
  }

  /* ---------------- 场景 ---------------- */
  // 返回 { ground, items, labels, world }
  // items 按 depth 升序（远 -> 近）绘制；depth 用世界 v（旋转后的 y）表示
  function buildScene(v, calib, live, opts) {
    opts = opts || {}
    var showLabels = opts.labels !== false
    var radarW = num(calib.radar_full_size && calib.radar_full_size[0]) || 5786
    var radarH = num(calib.radar_full_size && calib.radar_full_size[1]) || 5406
    var items = [], labels = []
    var _seq = 0
    function seq() { return _seq++ }

    function depthOf(x, y) { return x * v.sinR + y * v.cosR }

    // --- 建筑（挤出体块）---
    var blds = (calib.buildings || []).slice()
    var prisms = []
    for (var i = 0; i < blds.length; i++) {
      var b = blds[i]
      if (!b.ring || b.ring.length < 3) continue
      var hpx = Math.max(3, num(b.height_m) * v.pxPerM)
      // 体块深度：取底面最大 v（离视点最近的那条边）
      var dmax = -Infinity, dmin = Infinity, cx = 0, cy = 0
      for (var k = 0; k < b.ring.length; k++) {
        var dd = depthOf(b.ring[k][0], b.ring[k][1])
        if (dd > dmax) dmax = dd
        if (dd < dmin) dmin = dd
        cx += b.ring[k][0]; cy += b.ring[k][1]
      }
      cx /= b.ring.length; cy /= b.ring.length
      prisms.push({ b: b, hpx: hpx, depth: dmax, dmax: dmax, dmin: dmin, cx: cx, cy: cy, deliver: /栋/.test(b.name || '') })
    }
    prisms.sort(function (p, q) { return p.depth - q.depth })

    for (var pi = 0; pi < prisms.length; pi++) {
      var pr = prisms[pi], ring = pr.b.ring
      var deliver = pr.deliver
      var wallCol = deliver ? THEME.dWall : THEME.bWall
      // 落地阴影：底面外扩一点的柔影（让体块"落"在地面上）
      var shadow = []
      for (var sq = 0; sq < ring.length; sq++) {
        var dx0 = ring[sq][0] - pr.cx, dy0 = ring[sq][1] - pr.cy
        var L0 = Math.hypot(dx0, dy0) || 1
        shadow.push(project(v, ring[sq][0] + dx0 / L0 * 7 + 4, ring[sq][1] + dy0 / L0 * 7 + 5, 0))
      }
      items.push({ kind: 'poly', pts: shadow, fill: THEME.shadow, depth: pr.dmin - 0.5, seq: seq() })
      // 侧面：统一颜色 —— 逐边四边形并集就是正确的挤出轮廓，
      // 若按朝向分色，凹凸轮廓的内壁会在轮廓外露出"三角"伪影。
      for (var e = 0; e < ring.length; e++) {
        var p0 = ring[e], p1 = ring[(e + 1) % ring.length]
        var q = [
          project(v, p0[0], p0[1], 0), project(v, p1[0], p1[1], 0),
          project(v, p1[0], p1[1], pr.hpx), project(v, p0[0], p0[1], pr.hpx)
        ]
        items.push({ kind: 'poly', pts: q, fill: wallCol, depth: pr.dmax, seq: seq() })
      }
      // 顶面（最后画，压住内壁）
      var top = []
      for (var t2 = 0; t2 < ring.length; t2++) top.push(project(v, ring[t2][0], ring[t2][1], pr.hpx))
      items.push({
        kind: 'poly', pts: top, fill: deliver ? THEME.dTop : THEME.bTop,
        stroke: deliver ? THEME.dEdge : THEME.bEdge, lw: 1.1, depth: pr.dmax, seq: seq()
      })
      // 配送点：楼顶之上的飘标；其他有名字的楼栋只出名字
      if (pr.b.name && showLabels) {
        if (deliver) {
          var tipW = project(v, pr.cx, pr.cy, pr.hpx)
          var tipT = project(v, pr.cx, pr.cy, pr.hpx + 3.5 * v.pxPerM)
          items.push({ kind: 'line', pts: [tipW, tipT], stroke: THEME.pin, lw: 1.6, depth: pr.dmax, seq: seq() })
          items.push({ kind: 'dot', pt: tipT, r: 4.5, fill: THEME.pin, glow: THEME.pinGlow, depth: pr.dmax, seq: seq() })
          labels.push({ text: pr.b.name, x: tipT[0] + 8, y: tipT[1] - 4, kind: 'name', depth: pr.dmax })
        } else {
          var tp = project(v, pr.cx, pr.cy, pr.hpx)
          labels.push({ text: pr.b.name, x: tp[0] + 7, y: tp[1] + 4, kind: 'other', depth: pr.dmax })
        }
      }
    }

    // --- 道路（贴地，宽度按"米"定义，随视图比例自动换算）---
    var roads = calib.roads || []
    for (var ri = 0; ri < roads.length; ri++) {
      var rd = roads[ri]
      if (!rd.pts || rd.pts.length < 2) continue
      var color = rd.cls === 'main' ? THEME.roadMain : (rd.cls === 'walk' ? THEME.roadWalk : THEME.roadRoad)
      // 与 3D 渲染器 (scene3d.js buildStatic) 保持一致的路宽，避免降级后路网看起来不一样
      var wM = rd.cls === 'main' ? 4.8 : (rd.cls === 'walk' ? 1.6 : 3.6)
      for (var rj = 0; rj < rd.pts.length - 1; rj++) {
        var A = rd.pts[rj], B = rd.pts[rj + 1]
        items.push({
          kind: 'line', pts: [project(v, A[0], A[1], 0), project(v, B[0], B[1], 0)],
          stroke: color, wpx: wM * v.pxPerM, world: true, cap: 'round',
          depth: depthOf((A[0] + B[0]) / 2, (A[1] + B[1]) / 2) - 0.2, seq: seq()
        })
      }
    }

    // --- 机器人实际行驶路径（雷达可通行区骨架）：立体视图里的发光路线 ---
    var paths = calib.paths || []
    for (var hi = 0; hi < paths.length; hi++) {
      var hp = paths[hi]
      if (!hp.pts || hp.pts.length < 2) continue
      for (var hj = 0; hj < hp.pts.length - 1; hj++) {
        var H1 = hp.pts[hj], H2 = hp.pts[hj + 1]
        var pA = project(v, H1[0], H1[1], 3), pB = project(v, H2[0], H2[1], 3)
        var hdep = depthOf((H1[0] + H2[0]) / 2, (H1[1] + H2[1]) / 2) - 0.1
        // 由外向内三层：蓝色柔光 → 白色外壳 → 蓝色芯线（顺序即绘制顺序）
        items.push({ kind: 'line', pts: [pA, pB], stroke: THEME.pathGlow, wpx: 5.6 * v.pxPerM, world: true, cap: 'round', depth: hdep, seq: seq() })
        items.push({ kind: 'line', pts: [pA, pB], stroke: THEME.pathCase, wpx: 4.4 * v.pxPerM, world: true, cap: 'round', depth: hdep, seq: seq() })
        items.push({ kind: 'line', pts: [pA, pB], stroke: THEME.path, wpx: 2.6 * v.pxPerM, world: true, cap: 'round', depth: hdep, seq: seq() })
      }
    }

    // --- 实时数据（平台坐标 -> 雷达像素）---
    var p2r = makePlatformToRadar(live && live.bbox, radarW, radarH)
    if (p2r) {
      // 配送路线：逐段出线（按世界深度排序，能被楼栋正确遮挡）
      var routes = (live && live.routes) || []
      for (var qi = 0; qi < routes.length; qi++) {
        var stops = (routes[qi] && routes[qi].stops) || []
        var poly = []
        for (var sk = 0; sk < stops.length; sk++) {
          var rr = p2r(stops[sk].x, stops[sk].y)
          poly.push([rr[0], rr[1]])
        }
        for (var sg = 0; sg < poly.length - 1; sg++) {
          var a2 = poly[sg], b2 = poly[sg + 1]
          var dep = depthOf((a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2)
          items.push({
            kind: 'line', pts: [project(v, a2[0], a2[1], 8), project(v, b2[0], b2[1], 8)],
            stroke: THEME.route, wpx: 2.4 * v.pxPerM, world: true, glow: THEME.routeGlow, dash: [12, 8],
            flow: true, depth: dep + 0.1, seq: seq()
          })
        }
        for (var sn = 0; sn < poly.length; sn++) {
          items.push({
            kind: 'dot', pt: project(v, poly[sn][0], poly[sn][1], 9), r: 3.6,
            fill: '#ffffff', stroke: THEME.route, lw: 2, depth: depthOf(poly[sn][0], poly[sn][1]) + 0.11, seq: seq()
          })
        }
      }
      // 点位（非配送楼栋的平台点位）
      var lms = (live && live.landmarks) || []
      for (var li = 0; li < lms.length; li++) {
        var nm = String(lms[li].name || '')
        if (/固定路径|充电|排队/.test(nm)) continue
        var lp = p2r(lms[li].x, lms[li].y)
        items.push({
          kind: 'dot', pt: project(v, lp[0], lp[1], 10), r: 3.8,
          fill: '#2fd45c', glow: 'rgba(47,212,92,0.8)', depth: depthOf(lp[0], lp[1]) + 0.01, seq: seq()
        })
      }
      // 车辆
      var robots = (live && live.robots) || []
      for (var ci = 0; ci < robots.length; ci++) {
        var rp = p2r(robots[ci].x, robots[ci].y)
        items.push({ kind: 'car', x: rp[0], y: rp[1], theta: num(robots[ci].theta), sn: robots[ci].device_sn, depth: depthOf(rp[0], rp[1]) + 0.5, seq: seq() })
      }
    }

    items.sort(function (p, q) { return (p.depth - q.depth) || (p.seq - q.seq) })
    deconflict(labels)
    return {
      ground: {
        affine: groundAffine(v),
        imgW: radarW, imgH: radarH,
        clip: [project(v, 0, 0, 0), project(v, radarW, 0, 0), project(v, radarW, radarH, 0), project(v, 0, radarH, 0)]
      },
      items: items,
      labels: labels,
      world: { radarW: radarW, radarH: radarH }
    }
  }

  // 标签避让：按估算的外框做贪心下移，避免楼名互相压住
  function deconflict(labels) {
    var placed = []
    labels.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x) })
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i]
      var w = String(L.text).length * 12.5 + 6
      var h = 15
      for (var attempt = 0; attempt < 5; attempt++) {
        var box = { x0: L.x - 1, y0: L.y - h / 2, x1: L.x + w, y1: L.y + h / 2 }
        var hit = false
        for (var j = 0; j < placed.length; j++) {
          var P = placed[j]
          if (box.x0 < P.x1 && box.x1 > P.x0 && box.y0 < P.y1 && box.y1 > P.y0) { hit = true; break }
        }
        if (!hit) break
        L.y += 15
      }
      placed.push({ x0: L.x - 1, y0: L.y - h / 2, x1: L.x + w, y1: L.y + h / 2 })
    }
    return labels
  }

  // 车辆在屏幕空间的绘制点（浏览器与 Node 预览共用几何）
  function carGeometry(v, x, y, theta, screen) {
    // 车体：底部长 1.15m、宽 0.72m 的长方体（世界像素）
    var L = 1.15 * v.pxPerM, Wd = 0.72 * v.pxPerM, Hh = 0.62 * v.pxPerM * v.zScale
    var c = Math.cos(num(theta)), sn = Math.sin(num(theta))
    var out = { base: [], top: [] }
    var corners = [[-L / 2, -Wd / 2], [L / 2, -Wd / 2], [L / 2, Wd / 2], [-L / 2, Wd / 2]]
    for (var i = 0; i < 4; i++) {
      var wx = x + corners[i][0] * c - corners[i][1] * sn
      var wy = y + corners[i][0] * sn + corners[i][1] * c
      out.base.push(project(v, wx, wy, 0))
      out.top.push(project(v, wx, wy, Hh / v.zScale))
    }
    return out
  }

  return {
    THEME: THEME,
    D2R: D2R,
    makeView: makeView,
    project: project,
    unproject: unproject,
    groundAffine: groundAffine,
    makePlatformToRadar: makePlatformToRadar,
    buildScene: buildScene,
    carGeometry: carGeometry
  }
})
