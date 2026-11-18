/* ============================================================
 * scene3d.js — 真三维场景：网格构建 + 透视相机 + 矩阵（浏览器/Node 共用）
 * ------------------------------------------------------------
 * 为什么共用：本机无法截图浏览器页面，所以 Node 端用同一份网格与相机数学
 * 走软件光栅器出图校验；两边只要共用本文件，预览就等于所见。
 *
 * 坐标系（右手系）：
 *   X = 雷达底图 x（向右）      Y = 高度（向上）      Z = 雷达底图 y（向下 = 南）
 *   单位一律是"雷达底图像素"，高度由 米 × scale_px_per_m 换算。
 *
 * 风格：数字孪生全息风（深蓝底 + 发光网格 + 玻璃楼体 + 青色描边）。
 * 网格分两组：opaque（屋顶/路线/钉标，不透明）、glass（墙面，半透明，按楼排序绘制）。
 *
 * 依赖：数学/三角化/相机已抽到 scene3d/{math,triangulate,camera}.js 分件
 *        （浏览器先加载三个分件再加载本文件；Node 自动 require）。
 * ============================================================ */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Scene3D = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // ---- 从 scene3d/ 分件注入（math / triangulate / camera）----
  var P = (typeof window !== 'undefined' && window.Scene3DParts) ||
    (typeof module !== 'undefined' && module.exports
      ? { math: require('./scene3d/math'), triangulate: require('./scene3d/triangulate'), camera: require('./scene3d/camera') }
      : {})
  if (!P || !P.math) throw new Error('scene3d: 未先加载 scene3d/math.js 等分件')
  var D2R = P.math.D2R, num = P.math.num, mat4 = P.math.mat4, THEME = P.math.THEME, LIGHT = P.math.LIGHT, AMBIENT = P.math.AMBIENT, DIFFUSE = P.math.DIFFUSE
  var sub = P.math.sub, dot = P.math.dot, cross = P.math.cross, norm = P.math.norm, shade = P.math.shade, carMatrix = P.math.carMatrix
  var ringArea = P.triangulate.ringArea, pointInTri = P.triangulate.pointInTri, triangulate = P.triangulate.triangulate
  var newMesh = P.triangulate.newMesh, pushTri = P.triangulate.pushTri, pushQuad = P.triangulate.pushQuad, finalize = P.triangulate.finalize, linePts = P.triangulate.linePts
  var principalAzimuth = P.camera.principalAzimuth, makePlatformToRadar = P.camera.makePlatformToRadar, fitCamera = P.camera.fitCamera, projectPoint = P.camera.projectPoint, makeCamera = P.camera.makeCamera, fitDistance = P.camera.fitDistance, boundsCorners = P.camera.boundsCorners

  /* ---------------- 3D 图元 ---------------- */
  function squareCap(m, p, w, y, col, aux) {
    var h = w / 2
    pushQuad(m, [p[0] - h, y, p[1] - h], [p[0] + h, y, p[1] - h], [p[0] + h, y, p[1] + h], [p[0] - h, y, p[1] + h],
      col, [0, 1, 0], aux == null ? null : [aux, aux, aux, aux])
  }
  // 扁带（贴地）：cum 为该折线各点的累计弧长（供流光使用），传了才会写 aux
  function ribbon(m, pts2, width, y, col, cum) {
    var w2 = width / 2
    for (var i = 0; i < pts2.length; i++) squareCap(m, pts2[i], width, y, col, cum ? cum[i] : 0)
    for (var s = 0; s + 1 < pts2.length; s++) {
      var p = pts2[s], q = pts2[s + 1]
      var dx = q[0] - p[0], dz = q[1] - p[1]
      var L = Math.hypot(dx, dz)
      if (L < 1e-6) continue
      var nx = -dz / L * w2, nz = dx / L * w2
      pushQuad(m,
        [p[0] + nx, y, p[1] + nz], [q[0] + nx, y, q[1] + nz],
        [q[0] - nx, y, q[1] - nz], [p[0] - nx, y, p[1] - nz], col, [0, 1, 0],
        cum ? [cum[s], cum[s + 1], cum[s + 1], cum[s]] : null)
    }
  }
  function cumulative(pts) {
    var out = [0]
    for (var i = 0; i + 1 < pts.length; i++) {
      out.push(out[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]))
    }
    return out
  }
  function column(m, x, z, y0, y1, w, col) {
    var h = w / 2
    var c4 = [[-h, -h], [h, -h], [h, h], [-h, h]]
    for (var i = 0; i < 4; i++) {
      var p = c4[i], q = c4[(i + 1) % 4]
      var nn = norm([p[0] + q[0], 0, p[1] + q[1]])
      pushQuad(m, [x + p[0], y0, z + p[1]], [x + q[0], y0, z + q[1]], [x + q[0], y1, z + q[1]], [x + p[0], y1, z + p[1]], col, nn)
    }
  }
  function octa(m, x, y, z, r, col) {
    var t = [x, y + r, z], b = [x, y - r, z]
    var e = [[x + r, y, z], [x, y, z + r], [x - r, y, z], [x, y, z - r]]
    for (var i = 0; i < 4; i++) {
      var p = e[i], q = e[(i + 1) % 4]
      pushTri(m, t, p, q, col)
      pushTri(m, b, q, p, col)
    }
  }

  /* ---------------- 建筑：屋顶/描边(不透明) + 墙面(半透明) ----------------
   * 描边用"细四边形"而不是 GL_LINES：WebGL 里 gl.lineWidth 在多数实现被限制为 1px，
   * 想要霓虹发光线框只能自己出几何。 */
  function edgeRibbon(m, a, b, w, col, y) {
    var dx = b[0] - a[0], dz = b[1] - a[1]
    var L = Math.hypot(dx, dz)
    if (L < 1e-6) return
    var nx = -dz / L * w / 2, nz = dx / L * w / 2
    pushQuad(m,
      [a[0] + nx, y, a[1] + nz], [b[0] + nx, y, b[1] + nz],
      [b[0] - nx, y, b[1] - nz], [a[0] - nx, y, a[1] - nz], col, [0, 1, 0])
  }
  function edgePost(m, p, h, w, col) {
    // 竖棱：两片正交薄片，任何视角都能看到
    var hw = w / 2
    pushQuad(m, [p[0] - hw, 0, p[1]], [p[0] + hw, 0, p[1]], [p[0] + hw, h, p[1]], [p[0] - hw, h, p[1]], col, null)
    pushQuad(m, [p[0], 0, p[1] - hw], [p[0], 0, p[1] + hw], [p[0], h, p[1] + hw], [p[0], h, p[1] - hw], col, null)
  }
  function addBuilding(mOpaque, mWall, ring, hpx, roofCol, wallCol, edgeCol, pxPerM) {
    var n = ring.length
    if (n < 3) return
    var idx = triangulate(ring)
    for (var i = 0; i + 2 < idx.length + 1; i += 3) {
      if (i + 2 >= idx.length) break
      var a = ring[idx[i]], b = ring[idx[i + 1]], c = ring[idx[i + 2]]
      pushTri(mOpaque, [a[0], hpx, a[1]], [c[0], hpx, c[1]], [b[0], hpx, b[1]], roofCol, [0, 1, 0])
    }
    var cx = 0, cz = 0
    for (var k = 0; k < n; k++) { cx += ring[k][0]; cz += ring[k][1] }
    cx /= n; cz /= n
    var ew = 0.30 * pxPerM        // 描边宽度（米 → 像素）
    var yb = 0.9, yt = Math.max(1.4, hpx - 0.6)
    for (var e = 0; e < n; e++) {
      var p = ring[e], q = ring[(e + 1) % n]
      var ex = q[0] - p[0], ez = q[1] - p[1]
      var L = Math.hypot(ex, ez)
      if (L < 1e-6) continue
      var nx = -ez / L, nz = ex / L
      var mx = (p[0] + q[0]) / 2 - cx, mz = (p[1] + q[1]) / 2 - cz
      if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz }
      var nn = [nx, 0, nz]
      pushQuad(mWall, [p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], hpx, q[1]], [p[0], hpx, p[1]], wallCol, nn)
      edgeRibbon(mOpaque, p, q, ew, edgeCol, yb)
      edgeRibbon(mOpaque, p, q, ew, edgeCol, yt)
      edgePost(mOpaque, p, hpx, ew, edgeCol)
    }
  }

  /* ---------------- 自动"让路"：只把**真正压住路线**的楼往外推一点 ----------------
   * 用户要求：第三食堂挡住了两侧道路，需要视觉平移。
   * 做法：量出楼轮廓到路线的最近距离；小于 clearance 才沿"远离路线"的方向推开，
   *       推开量 = clearance - minDist（上限 maxM）。这样只有真的压路的楼会动，
   *       其余楼栋保持原坐标（定位精度不受影响），并且会在图上用虚线标出真实位置。 */
  function ringToPolyMinDist(ring, pts) {
    var best = Infinity, bx = 0, bz = 0
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i]
      for (var j = 0; j + 1 < pts.length; j++) {
        var a = pts[j], b = pts[j + 1]
        var vx = b[0] - a[0], vz = b[1] - a[1]
        var L2 = vx * vx + vz * vz
        var t = L2 > 1e-9 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / L2 : 0
        t = Math.max(0, Math.min(1, t))
        var qx = a[0] + vx * t, qz = a[1] + vz * t
        var d = Math.hypot(p[0] - qx, p[1] - qz)
        if (d < best) { best = d; bx = qx; bz = qz }
      }
    }
    return { dist: best, qx: bx, qz: bz }
  }

  /* ---------------- 静态场景 ---------------- */
  // opts: { roads, paths, labels, heightScale, clearRoad, clearM, autoOffsetMaxM }
  function buildStatic(calib, opts) {
    opts = opts || {}
    var radarW = num(calib.radar_full_size && calib.radar_full_size[0]) || 5786
    var radarH = num(calib.radar_full_size && calib.radar_full_size[1]) || 5406
    var pxPerM = num(calib.scale_px_per_m) || 19.45
    var hs = opts.heightScale != null ? opts.heightScale : 1
    var clearM = opts.clearM != null ? opts.clearM : 4.5        // 推开后楼到路线的最小净空（米）
    var overlapM = opts.overlapM != null ? opts.overlapM : 0.4   // 仅当"路线真的压到楼"（<该值）才推
    var maxOffM = opts.autoOffsetMaxM != null ? opts.autoOffsetMaxM : 9.0
    var doClear = opts.clearRoad !== false

    var opaque = newMesh()      // 底板 + 描边 + 路线 + 钉标（不透明，写深度）
    var roofs = newMesh()       // 屋顶：单独一层，俯视时整体淡出，露出底下道路
    var glass = newMesh()       // 墙面：半透明，按楼排序
    var labels = []
    var ranges = []
    var moved = []
    var blds = calib.buildings || []

    // 用于"让路"的参考线：演示/主路线 + 雷达骨架（楼不该压在这些上面）
    var refPaths = []
    if (calib.demo_route && calib.demo_route.pts) refPaths.push(calib.demo_route.pts)
    for (var rp = 0; rp < (calib.paths || []).length; rp++) {
      if (calib.paths[rp].pts) refPaths.push(calib.paths[rp].pts)
    }

    // ---- 先按"地面 + 楼栋"求取景范围（底板不参与，否则会把模型挤小）----
    var minX = 0, maxX = radarW, minZ = 0, maxZ = radarH, maxY = 0
    for (var bi = 0; bi < blds.length; bi++) {
      var rb = blds[bi].ring
      if (!rb) continue
      for (var rk = 0; rk < rb.length; rk++) {
        if (rb[rk][0] < minX) minX = rb[rk][0]; if (rb[rk][0] > maxX) maxX = rb[rk][0]
        if (rb[rk][1] < minZ) minZ = rb[rk][1]; if (rb[rk][1] > maxZ) maxZ = rb[rk][1]
      }
      var hb = num(blds[bi].height_m) * pxPerM * hs + 6 * pxPerM
      if (hb > maxY) maxY = hb
    }
    var bounds = {
      minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, maxY: maxY,
      center: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
      radius: Math.hypot(maxX - minX, maxY, maxZ - minZ) / 2
    }

    // 建筑（含自动让路 + 屋顶单独入层）
    for (var i = 0; i < blds.length; i++) {
      var b = blds[i]
      if (!b.ring || b.ring.length < 3) continue
      var deliver = /栋/.test(b.name || '')
      var cx0 = num(b.center && b.center[0]), cz0 = num(b.center && b.center[1])
      // 偏移优先级：① 标定文件里手工指定的 visual_offset_m（只影响显示）
      //             ② 自动让路（路线真的压进楼里时才推）
      var ox = 0, oz = 0, manual = false
      var vo = b.visual_offset_m
      if (vo && (num(vo[0]) || num(vo[1]))) {
        ox = num(vo[0]) * pxPerM
        oz = num(vo[1]) * pxPerM
        manual = true
      }
      if (!manual && doClear && b.name) {
        var near = null
        for (var rq = 0; rq < refPaths.length; rq++) {
          var m1 = ringToPolyMinDist(b.ring, refPaths[rq])
          if (!near || m1.dist < near.dist) near = m1
        }
        var clearPx = clearM * pxPerM
        // 只有"路线真的压进楼里"才推：道路贴着宿舍楼是正常的，不该动
        if (near && isFinite(near.dist) && near.dist > 1e-6 && near.dist < overlapM * pxPerM) {
          var push = Math.min((clearPx - near.dist) + 1.5 * pxPerM, maxOffM * pxPerM)
          var ux = cx0 - near.qx, uz = cz0 - near.qz
          var ul = Math.hypot(ux, uz)
          if (ul > 1e-6) { ox = ux / ul * push; oz = uz / ul * push }
        }
      }
      var ring = b.ring
      if (ox || oz) {
        ring = b.ring.map(function (p) { return [p[0] + ox, p[1] + oz] })
        moved.push({
          name: b.name, ox: ox, oz: oz, shift_m: +(Math.hypot(ox, oz) / pxPerM).toFixed(1),
          true_center: [cx0, cz0], shown_center: [cx0 + ox, cz0 + oz]
        })
      }
      var hpx = Math.max(2, num(b.height_m) * pxPerM * hs)
      var gStart = glass.pos.length / 3
      addBuilding(roofs, glass, ring, hpx,
        deliver ? THEME.dRoof : THEME.roof, deliver ? THEME.dWall : THEME.wall,
        deliver ? THEME.edgeDeliver : THEME.edge, pxPerM)
      ranges.push({ start: gStart, count: glass.pos.length / 3 - gStart, cx: cx0 + ox, cz: cz0 + oz })
      if (b.name && opts.labels !== false && b.no_label !== true) {
        var cx = cx0 + ox, cz = cz0 + oz
        if (deliver) {
          // 楼名只出文字：不再在楼顶画橙色立体图标（柱子 + 八面体）。
          // 标签直接标在楼顶稍上方即可。
          labels.push({
            text: b.name + (ox || oz ? '（视图偏移）' : ''),
            x: cx, y: hpx + 0.8 * pxPerM, z: cz, kind: 'name'
          })
        } else {
          labels.push({
            text: b.name + (ox || oz ? '（视图偏移）' : ''),
            x: cx, y: hpx + 0.4 * pxPerM, z: cz, kind: 'other'
          })
        }
      }
    }

    /* ---------------- 运动场地（操场 / 跑道 / 球场） ----------------
     * 为什么不再是一块纯色：上一版把整个操场刷成一片绿、跑道刷成一片红，
     * 远景看就是两个色块，既不像操场也不好看（2026-11-18 负责人反馈）。
     * 现在按场地类型做"轻建模"：
     *   跑道 → 8 条分道带 + 白色分道线（内场留空，下面的操场草皮透出来）
     *   矩形操场 → 剪草条纹 + 白边线 + 中线 + 中圈
     *   球场 → 底色 + 白边线 + 中线
     *   草地 → 单色（不加线，避免抢戏）
     * 全部用极薄的高度差错开，避免 z-fighting；道路(0.4)始终压在场地(≤0.34)之上。 */
    var fields = calib.fields || []
    var pxM = pxPerM
    function fillPoly(ring2, y, col) {
      var tri = triangulate(ring2)
      for (var t2 = 0; t2 + 2 < tri.length; t2 += 3) {
        var a2 = ring2[tri[t2]], b2 = ring2[tri[t2 + 1]], c3 = ring2[tri[t2 + 2]]
        pushTri(opaque, [a2[0], y, a2[1]], [c3[0], y, c3[1]], [b2[0], y, b2[1]], col, [0, 1, 0])
      }
    }
    function strokeRing(ring2, y, wPx, col) {
      for (var i2 = 0; i2 < ring2.length; i2++) {
        var p2 = ring2[i2], q2 = ring2[(i2 + 1) % ring2.length]
        edgeRibbon(opaque, p2, q2, wPx, col, y)
      }
    }
    // 矩形操场的两条长边（用于剪草条纹插值）
    function rectLongEdges(ring2) {
      var n2 = ring2.length
      if (n2 > 5) return null
      var e0 = Math.hypot(ring2[1][0] - ring2[0][0], ring2[1][1] - ring2[0][1])
      var e1 = Math.hypot(ring2[2][0] - ring2[1][0], ring2[2][1] - ring2[1][1])
      if (e0 >= e1) return { a1: ring2[0], a2: ring2[1], b1: ring2[3], b2: ring2[2] }
      return { a1: ring2[1], a2: ring2[2], b1: ring2[0], b2: ring2[3] }
    }
    /* ---------------- 运动场地（田径场 / 球场 / 草地） ----------------
     * 关键事实（2026-11-18 查证）：OSM 里那三块「大操场」的多边形其实是**足球场**本身
     * （7261 m² ≈ 110×66 m，6957/7654 也都在标准 11 人制尺寸上），跑道在它**外圈**，
     * 不属于这个多边形。所以跑道绝不能往里缩：
     *   · 往里缩会把球场吃掉 → 画面变成"红框套绿块"；
     *   · 而且矩形内缩出来的是矩形环 → 第二运动场/一号运动场就成了"矩形跑道"。
     * 现在按真实田径场几何重建：
     *   ① 由球场矩形反解出**刚好包住它**的椭圆跑道内沿（stadium 形：两段直线 + 两端半圆）；
     *   ② 内沿往外铺 8 条分道（深浅交替）+ 白色分道线 + 内外白边；
     *   ③ 球场画成矩形草坪 + 剪草条纹 + 标准白线（边线 / 中线 / 中圈 / 禁区 / 球门区）。
     * stadium 形 = 「线段 ⊕ 圆盘」：向外偏移 d 只改半径、不改直段长度，
     * 因此分道带严格等宽、彼此不重叠，端点也是真圆弧而不是直角。 */
    // 生成一条 stadium 形闭合折线：中心 (cx,cy)、长轴角 ang、直段半长 a、端部半径 r。
    function stadiumRing(cx, cy, ang, a, r, seg) {
      var out = []
      var ca = Math.cos(ang), sa = Math.sin(ang)
      function put(u, v) { out.push([cx + u * ca - v * sa, cy + u * sa + v * ca]) }
      var i, th
      for (i = 0; i <= seg; i++) {                       // 右端半圆：-90° → +90°
        th = -Math.PI / 2 + Math.PI * i / seg
        put(a + r * Math.cos(th), r * Math.sin(th))
      }
      for (i = 0; i <= seg; i++) {                       // 左端半圆：+90° → +270°
        th = Math.PI / 2 + Math.PI * i / seg
        put(-a + r * Math.cos(th), r * Math.sin(th))
      }
      return out
    }
    // 两条同参数 stadium 轮廓之间的环带
    function stadiumBand(cx, cy, ang, a, rIn, rOut, y, col, seg) {
      var o = stadiumRing(cx, cy, ang, a, rOut, seg)
      var n = stadiumRing(cx, cy, ang, a, rIn, seg)
      for (var i = 0; i < o.length; i++) {
        var j = (i + 1) % o.length
        pushQuad(opaque,
          [n[i][0], y, n[i][1]], [n[j][0], y, n[j][1]],
          [o[j][0], y, o[j][1]], [o[i][0], y, o[i][1]], col, [0, 1, 0])
      }
    }
    // 一条白色分道线（细环带）
    function stadiumLine(cx, cy, ang, a, r, w, y, col, seg) {
      stadiumBand(cx, cy, ang, a, Math.max(0.5, r - w / 2), r + w / 2, y, col, seg)
    }
    // 本地坐标 (u 沿长轴, v 沿短轴) → 世界
    function l2w(cx, cy, ang, u, v) {
      var ca = Math.cos(ang), sa = Math.sin(ang)
      return [cx + u * ca - v * sa, cy + u * sa + v * ca]
    }
    // 矩形白线框（在本地坐标里给四个角）
    function localRect(cx, cy, ang, u0, u1, v0, v1, w, y, col) {
      var p1 = l2w(cx, cy, ang, u0, v0), p2 = l2w(cx, cy, ang, u1, v0)
      var p3 = l2w(cx, cy, ang, u1, v1), p4 = l2w(cx, cy, ang, u0, v1)
      edgeRibbon(opaque, p1, p2, w, col, y)
      edgeRibbon(opaque, p2, p3, w, col, y)
      edgeRibbon(opaque, p3, p4, w, col, y)
      edgeRibbon(opaque, p4, p1, w, col, y)
    }
    // 本地坐标里的圆弧（圆心 (u0,v0)、半径 r、角度 a0→a1）
    function localArc(cx, cy, ang, u0, v0, r, a0, a1, w, y, col, seg) {
      var n = seg || 20
      for (var i = 0; i < n; i++) {
        var t0 = a0 + (a1 - a0) * i / n
        var t1 = a0 + (a1 - a0) * (i + 1) / n
        edgeRibbon(opaque,
          l2w(cx, cy, ang, u0 + Math.cos(t0) * r, v0 + Math.sin(t0) * r),
          l2w(cx, cy, ang, u0 + Math.cos(t1) * r, v0 + Math.sin(t1) * r),
          w, y, col)
      }
    }
    // 单块球场的标准划线。cu/cv = 该场地中心（本地坐标），cl/cw = 长/宽（世界像素）
    function drawCourtMarks(sport, cx, cy, ang, cu, cv, cl, cw, mP, w, y) {
      var C = THEME.courtLine
      var lu = cl / 2, lv = cw / 2
      // 边线
      localRect(cx, cy, ang, cu - lu, cu + lu, cv - lv, cv + lv, w, y, C)
      if (sport === 'basketball') {
        // 中线 + 中圈（半径 1.8m）
        edgeRibbon(opaque, l2w(cx, cy, ang, cu, cv - lv), l2w(cx, cy, ang, cu, cv + lv), w, y, C)
        localArc(cx, cy, ang, cu, cv, 1.8 * mP, 0, Math.PI * 2, w, y, C, 24)
        // 两端：禁区（5.8m × 4.9m）+ 罚球圈 + 三分弧（6.75m）+ 篮圈
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          var baseU = cu + s2 * lu
          var keyEnd = baseU - s2 * 5.8 * mP
          localRect(cx, cy, ang, Math.min(baseU, keyEnd), Math.max(baseU, keyEnd), cv - 2.45 * mP, cv + 2.45 * mP, w, y, C)
          localArc(cx, cy, ang, keyEnd, cv, 1.8 * mP, -Math.PI / 2, Math.PI / 2, w, y, C, 16)
          // 三分弧：以篮圈为心，朝场内张 ±68°
          var hoopU = baseU - s2 * 1.575 * mP
          var a0 = s2 > 0 ? Math.PI - 1.19 : -1.19
          localArc(cx, cy, ang, hoopU, cv, 6.75 * mP, a0, a0 + 2.38, w, y, C, 22)
          // 篮圈
          localArc(cx, cy, ang, hoopU, cv, 0.3 * mP, 0, Math.PI * 2, Math.max(1, w * 1.1), y, C, 10)
        }
      } else if (sport === 'tennis') {
        // 单打边线（半宽 4.115m）、发球线（±6.4m）、中央发球线、球网
        localRect(cx, cy, ang, cu - lu, cu + lu, cv - 4.115 * mP, cv + 4.115 * mP, w, y, C)
        edgeRibbon(opaque, l2w(cx, cy, ang, cu - 6.4 * mP, cv - lv), l2w(cx, cy, ang, cu - 6.4 * mP, cv + lv), w, y, C)
        edgeRibbon(opaque, l2w(cx, cy, ang, cu + 6.4 * mP, cv - lv), l2w(cx, cy, ang, cu + 6.4 * mP, cv + lv), w, y, C)
        edgeRibbon(opaque, l2w(cx, cy, ang, cu - 6.4 * mP, cv), l2w(cx, cy, ang, cu + 6.4 * mP, cv), w, y, C)
        // 球网：画得比普通线粗，读起来像"中间立着网"
        edgeRibbon(opaque, l2w(cx, cy, ang, cu, cv - lv), l2w(cx, cy, ang, cu, cv + lv), Math.max(1.6, w * 2), y + 0.004, C)
      } else if (sport === 'badminton') {
        edgeRibbon(opaque, l2w(cx, cy, ang, cu, cv - lv), l2w(cx, cy, ang, cu, cv + lv), Math.max(1.4, w * 1.6), y + 0.004, C)
        for (var t2 = -1; t2 <= 1; t2 += 2) {
          edgeRibbon(opaque, l2w(cx, cy, ang, cu + t2 * 1.98 * mP, cv - lv), l2w(cx, cy, ang, cu + t2 * 1.98 * mP, cv + lv), w, y, C)
          edgeRibbon(opaque, l2w(cx, cy, ang, cu + t2 * 5.94 * mP, cv - lv), l2w(cx, cy, ang, cu + t2 * 5.94 * mP, cv + lv), w, y, C)
        }
        edgeRibbon(opaque, l2w(cx, cy, ang, cu - 5.94 * mP, cv), l2w(cx, cy, ang, cu + 5.94 * mP, cv), w, y, C)
      } else if (sport === 'volleyball') {
        edgeRibbon(opaque, l2w(cx, cy, ang, cu, cv - lv), l2w(cx, cy, ang, cu, cv + lv), Math.max(1.4, w * 1.6), y + 0.004, C)
        for (var v2 = -1; v2 <= 1; v2 += 2) {
          edgeRibbon(opaque, l2w(cx, cy, ang, cu + v2 * 3 * mP, cv - lv), l2w(cx, cy, ang, cu + v2 * 3 * mP, cv + lv), w, y, C)
        }
      }
    }

    // 球场标准尺寸（米）：与 emit_assets.mjs 里的 COURT_SPEC 保持一致
    var COURT_SPEC_JS = {
      basketball: { len: 28, wid: 15, gap: 2 },
      tennis: { len: 23.77, wid: 10.97, gap: 3.5 },
      badminton: { len: 13.4, wid: 6.1, gap: 2 },
      volleyball: { len: 18, wid: 9, gap: 2 }
    }
    for (var fi = 0; fi < fields.length; fi++) {
      var fd = fields[fi]
      var fr = fd && fd.ring
      if (!fr || fr.length < 3) continue
      var kind = fd.kind

      // ---------- 田径场：跑道在外圈，球场在中间 ----------
      if (fd.stadium) {
        var st = fd.stadium
        var LANES = 8
        var laneW = st.trackW / LANES
        var SEG = 22                                  // 半圆分段数：够圆滑又不太吃顶点
        // 跑道底色（整条跑道铺一层，深砖红）
        stadiumBand(st.cx, st.cy, st.ang, st.a, st.r, st.r + st.trackW, 0.27, THEME.fieldTrackOuter, SEG)
        // 8 条分道，深浅交替
        for (var li = 0; li < LANES; li++) {
          var rIn = st.r + laneW * li
          var rOut = rIn + laneW
          stadiumBand(st.cx, st.cy, st.ang, st.a, rIn, rOut, 0.272,
            li % 2 ? THEME.fieldTrack : THEME.fieldTrackOuter, SEG)
        }
        // 分道线：内沿、每条分道交界、外沿
        var lw = Math.max(1, 0.09 * pxM)
        for (var ln = 0; ln <= LANES; ln++) {
          stadiumLine(st.cx, st.cy, st.ang, st.a, st.r + laneW * ln, lw, 0.296, THEME.fieldTrackLine, SEG)
        }
        // 跑道外沿加一道稍粗的白线，边界更清楚
        stadiumLine(st.cx, st.cy, st.ang, st.a, st.r + st.trackW, Math.max(1.4, 0.16 * pxM), 0.298, THEME.fieldTrackLine, SEG)
      }

      if (kind === 'grass') {
        fillPoly(fr, 0.26, THEME.fieldGrass)
        continue
      }
      if (kind === 'court') {
        /* 篮球场 / 网球场 / 羽毛球场：单独建模（2026-11-18 负责人要求）。
         * 这些多边形是「一片场地」而不是一块球场（篮球场 92×37m、网球场 83×74m），
         * 所以做法是：整片铺基层 → 按标准尺寸**平铺**出若干块球场 → 每块画自己的白线。
         * 这样远看是一片球场群，近看每块场地都有正确的划线，而不是一整块色板。 */
        fillPoly(fr, 0.28, THEME.courtBase)
        var cf = fd.frame
        var spec = cf && COURT_SPEC_JS[fd.courtSport]
        if (!cf) { strokeRing(fr, 0.295, Math.max(1.2, 0.12 * pxM), THEME.courtLine); continue }
        var cAng = cf.ang, cCx = cf.cx, cCy = cf.cy
        var mP = 1 / pxPerM
        if (!spec) {
          // generic（如「风雨球场」）：只画外框 + 中线，不臆造场地线
          localRect(cCx, cCy, cAng, -cf.A, cf.A, -cf.B, cf.B, Math.max(1.4, 0.12 * pxM), 0.295, THEME.courtLine)
          edgeRibbon(opaque, l2w(cCx, cCy, cAng, -cf.A, 0), l2w(cCx, cCy, cAng, cf.A, 0),
            Math.max(1.2, 0.10 * pxM), 0.295, THEME.courtLine)
          continue
        }
        var cl = spec.len * mP, cw = spec.wid * mP, cg = spec.gap * mP
        var nU = fd.courtFit ? fd.courtFit.nU : 1
        var nV = fd.courtFit ? fd.courtFit.nV : 1
        var bw = nU * cl + (nU - 1) * cg, bh = nV * cw + (nV - 1) * cg
        var lineW = Math.max(1, 0.09 * pxM)
        var Y_LINE = 0.296
        var surf = fd.courtSport === 'basketball' ? THEME.courtBasket
          : (fd.courtSport === 'tennis' ? THEME.courtTennis : THEME.courtBadminton)
        for (var ci = 0; ci < nU; ci++) {
          for (var cj = 0; cj < nV; cj++) {
            var cu = -bw / 2 + cl / 2 + ci * (cl + cg)
            var cv = -bh / 2 + cw / 2 + cj * (cw + cg)
            // 场地表面（整块矩形填充）
            var p1 = l2w(cCx, cCy, cAng, cu - cl / 2, cv - cw / 2)
            var p2 = l2w(cCx, cCy, cAng, cu + cl / 2, cv - cw / 2)
            var p3 = l2w(cCx, cCy, cAng, cu + cl / 2, cv + cw / 2)
            var p4 = l2w(cCx, cCy, cAng, cu - cl / 2, cv + cw / 2)
            pushQuad(opaque, [p1[0], 0.286, p1[1]], [p4[0], 0.286, p4[1]],
              [p3[0], 0.286, p3[1]], [p2[0], 0.286, p2[1]], surf, [0, 1, 0])
            drawCourtMarks(fd.courtSport, cCx, cCy, cAng, cu, cv, cl, cw, mP, lineW, Y_LINE)
          }
        }
        continue
      }
      if (kind === 'track') continue        // 独立跑道面不再单独画（由对应球场的 stadium 接管）

      // ---------- 足球场草坪（矩形）：底色 + 剪草条纹 + 标准白线 ----------
      fillPoly(fr, 0.285, THEME.fieldPitch)
      var e2 = rectLongEdges(fr)
      if (!e2) { strokeRing(fr, 0.30, Math.max(1.2, 0.16 * pxM), THEME.fieldEdge); continue }
      // 剪草条纹：沿长轴分 12 条，深浅交替
      var STRIPES = 12
      for (var si = 1; si < STRIPES; si += 2) {
        var t0 = si / STRIPES, t1 = (si + 1) / STRIPES
        var pa = [e2.a1[0] + (e2.a2[0] - e2.a1[0]) * t0, e2.a1[1] + (e2.a2[1] - e2.a1[1]) * t0]
        var pb = [e2.a1[0] + (e2.a2[0] - e2.a1[0]) * t1, e2.a1[1] + (e2.a2[1] - e2.a1[1]) * t1]
        var qa = [e2.b1[0] + (e2.b2[0] - e2.b1[0]) * t0, e2.b1[1] + (e2.b2[1] - e2.b1[1]) * t0]
        var qb = [e2.b1[0] + (e2.b2[0] - e2.b1[0]) * t1, e2.b1[1] + (e2.b2[1] - e2.b1[1]) * t1]
        pushQuad(opaque, [pa[0], 0.288, pa[1]], [qa[0], 0.288, qa[1]],
          [qb[0], 0.288, qb[1]], [pb[0], 0.288, pb[1]], THEME.fieldPitchAlt, [0, 1, 0])
      }
      // 标准白线：用本地坐标（长轴 u ∈ [-A, A]，短轴 v ∈ [-B, B]）
      if (fd.stadium) {
        var cxs = fd.stadium.cx, cys = fd.stadium.cy, angs = fd.stadium.ang
        var A2 = fd.stadium.A, B2 = fd.stadium.B
        var mPx = 1 / pxPerM                          // 1 米 = 多少世界像素
        var wLine = Math.max(1.1, 0.12 * pxM)
        var yLine = 0.30
        // 边线
        localRect(cxs, cys, angs, -A2, A2, -B2, B2, wLine, yLine, THEME.fieldEdge)
        // 中线（横跨短轴）
        edgeRibbon(opaque, l2w(cxs, cys, angs, 0, -B2), l2w(cxs, cys, angs, 0, B2), wLine, yLine, THEME.fieldEdge)
        // 中圈（半径 9.15 m）
        var ccR = 9.15 * mPx
        var ccSeg = 40
        for (var ci2 = 0; ci2 < ccSeg; ci2++) {
          var ca0 = ci2 / ccSeg * Math.PI * 2, ca1 = (ci2 + 1) / ccSeg * Math.PI * 2
          edgeRibbon(opaque,
            l2w(cxs, cys, angs, Math.cos(ca0) * ccR, Math.sin(ca0) * ccR),
            l2w(cxs, cys, angs, Math.cos(ca1) * ccR, Math.sin(ca1) * ccR),
            wLine, yLine, THEME.fieldEdge)
        }
        // 中圈圆心点
        edgeRibbon(opaque, l2w(cxs, cys, angs, -1.5, 0), l2w(cxs, cys, angs, 1.5, 0), Math.max(1.6, 0.2 * pxM), yLine, THEME.fieldEdge)
        // 两端：禁区（16.5 m × 40.32 m）+ 球门区（5.5 m × 18.32 m）
        var penD = 16.5 * mPx, penW = 20.16 * mPx
        var goalD = 5.5 * mPx, goalW = 9.16 * mPx
        for (var side = -1; side <= 1; side += 2) {
          localRect(cxs, cys, angs, side * (A2 - penD), side * A2, -penW, penW, wLine, yLine, THEME.fieldEdge)
          localRect(cxs, cys, angs, side * (A2 - goalD), side * A2, -goalW, goalW, wLine, yLine, THEME.fieldEdge)
          // 点球点（11 m）
          var spU = side * (A2 - 11 * mPx)
          edgeRibbon(opaque, l2w(cxs, cys, angs, spU - 1.5, 0), l2w(cxs, cys, angs, spU + 1.5, 0),
            Math.max(1.6, 0.2 * pxM), yLine, THEME.fieldEdge)
        }
      } else {
        strokeRing(fr, 0.30, Math.max(1.5, 0.2 * pxM), THEME.fieldEdge)
      }
    }

    // 水体（湖 / 塘）：湖面半透明青蓝 + 亮色岸线。
    // 画在道路之前、高度略高于道路（0.55 vs 0.4），这样从上方俯视时水面会压住穿过它的路面，
    // 湖面上的桥/路自然被"沉"到水下（校园里没有跨湖道路，实际不会出现这种遮挡）。
    var waters = calib.water || []
    for (var wi = 0; wi < waters.length; wi++) {
      var wtr = waters[wi]
      var wring = wtr && wtr.ring
      if (!wring || wring.length < 3) continue
      var wTri = triangulate(wring)
      for (var wt = 0; wt + 2 < wTri.length; wt += 3) {
        var wa = wring[wTri[wt]], wb = wring[wTri[wt + 1]], wc = wring[wTri[wt + 2]]
        pushTri(opaque, [wa[0], 0.55, wa[1]], [wc[0], 0.55, wc[1]], [wb[0], 0.55, wb[1]], THEME.water, [0, 1, 0])
      }
      // 岸线：沿轮廓一圈细带，略高于水面
      for (var we = 0; we < wring.length; we++) {
        var wp = wring[we], wq = wring[(we + 1) % wring.length]
        edgeRibbon(opaque, wp, wq, Math.max(0.35 * pxPerM, 3), THEME.waterRim, 0.62)
      }
    }

    // 校园道路（OSM 参照，压暗）
    if (opts.roads !== false) {
      var roads = calib.roads || []
      for (var r = 0; r < roads.length; r++) {
        var rd = roads[r]
        if (!rd.pts || rd.pts.length < 2) continue
        var col = rd.cls === 'main' ? THEME.roadMain : THEME.roadRoad
        // 宽度按高德参考图里的实际路面宽度：主路 ~4.8 m，支路 ~3.6 m
        var wM = rd.cls === 'main' ? 4.8 : 3.6
        // 没被雷达扫到的路要**弱化**（不是删掉）：那些路要么没扫到、要么车走不了。
        // cov 来自 road_coverage.py；规则见下，既要能看出"这里有条路"，又不能喧宾夺主。
        var aMul = 1
        if (rd.cov != null) {
          if (rd.cov >= 0.5) aMul = 1
          else if (rd.cov >= 0.2) aMul = 0.72
          else aMul = 0.42
        }
        var rc2 = [col[0], col[1], col[2], (col[3] == null ? 1 : col[3]) * aMul]
        ribbon(opaque, rd.pts, wM * pxPerM, 0.4, rc2)
      }
    }

    // 机器人实际行驶路径（雷达骨架）：外发光 + 亮芯线
    if (opts.paths !== false) {
      var paths = calib.paths || []
      for (var h = 0; h < paths.length; h++) {
        var hp = paths[h]
        if (!hp.pts || hp.pts.length < 2) continue
        ribbon(opaque, hp.pts, 5.5 * pxPerM, 1.0, THEME.pathHalo)
        ribbon(opaque, hp.pts, 2.2 * pxPerM, 1.6, THEME.pathCore)
      }
    }

    // 底板（深色"桌面"）：尺寸由取景范围外扩，但不参与取景计算
    var pad = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.30
    pushQuad(opaque,
      [bounds.minX - pad, -22, bounds.minZ - pad], [bounds.maxX + pad, -22, bounds.minZ - pad],
      [bounds.maxX + pad, -22, bounds.maxZ + pad], [bounds.minX - pad, -22, bounds.maxZ + pad],
      THEME.baseBoard, [0, 1, 0])
    // 注：底板网格（淡青网格线）已按负责人要求移除 —— 地面不再有蓝色网格。

    var solid = finalize(opaque)
    var roofsF = finalize(roofs)
    var glassF = finalize(glass)
    return {
      radarW: radarW, radarH: radarH, pxPerM: pxPerM,
      ground: {
        pos: [0, 0, 0, radarW, 0, 0, radarW, 0, radarH, 0, 0, radarH],
        uv: [0, 0, 1, 0, 1, 1, 0, 1]
      },
      opaque: solid,
      roofs: roofsF,
      glass: glassF,
      glassRanges: ranges,
      moved: moved,
      labels: labels,
      bounds: bounds
    }
  }

  /* ---------------- 车辆网格（朝 +X，立体送餐机器人） ----------------
   * 造型对齐真机（assets/robot.png）：深蓝方舱 + 顶部斜切舱盖 + 青色灯带 + 深色前屏 + 六轮。
   * scale：**显示放大倍数**。真车长仅 1.3m，在校园尺度（整图约 4px/m）下只有几个像素、
   * 会退化成一个小点；与楼高夸张（heightScale）同理，这里默认放大，让"这是台车"一眼可辨。 */
  function buildCar(pxPerM, scale) {
    var S = num(scale) > 0 ? num(scale) : 1
    var M = pxPerM * S
    var hL = 0.65 * M, hW = 0.41 * M              // 半长 / 半宽（车 1.3m × 0.82m）
    var yAxle = 0.115 * M                         // 轮心高（=轮半径）
    var yCh0 = 0.045 * M, yCh1 = 0.20 * M         // 底盘
    var yBody1 = 0.72 * M                         // 主舱顶
    var yLid1 = 0.90 * M                          // 舱盖顶
    var inset = 0.16                              // 舱盖四周内收比例
    // 亮色车身（近白金属银）+ 青色灯带：深色底板/楼体上对比极强，一眼可辨
    var BODY = [0.88, 0.92, 0.96, 1], LID = [0.72, 0.83, 0.90, 1]
    var CH = [0.42, 0.48, 0.55, 1], TIRE = [0.08, 0.10, 0.13, 1]
    var HUB = [0.62, 0.68, 0.74, 1]
    var GLOW = [0.45, 1.0, 1.0, 1], SCREEN = [0.02, 0.05, 0.11, 1]
    var m = newMesh()

    // 长方体（显式法线，保证受光方向正确）
    function box(x0, x1, y0, y1, z0, z1, col, topCol) {
      pushQuad(m, [x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], col, [0, -1, 0])
      pushQuad(m, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, [0, 0, 1])
      pushQuad(m, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col, [0, 0, -1])
      pushQuad(m, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col, [1, 0, 0])
      pushQuad(m, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col, [-1, 0, 0])
      pushQuad(m, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], topCol || col, [0, 1, 0])
    }
    // 轮子：轴向 Z 的圆柱（侧壁 + 两端盖），共 6 个（左右各 3）
    function wheel(cx, cz, r, hw) {
      var seg = 12
      for (var i = 0; i < seg; i++) {
        var a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2
        var x0 = cx + Math.cos(a0) * r, y0 = yAxle + Math.sin(a0) * r
        var x1 = cx + Math.cos(a1) * r, y1 = yAxle + Math.sin(a1) * r
        var am = (a0 + a1) / 2
        pushQuad(m, [x0, y0, cz - hw], [x1, y1, cz - hw], [x1, y1, cz + hw], [x0, y0, cz + hw], TIRE, [Math.cos(am), Math.sin(am), 0])
        pushTri(m, [cx, yAxle, cz + hw], [x0, y0, cz + hw], [x1, y1, cz + hw], HUB, [0, 0, 1])
        pushTri(m, [cx, yAxle, cz - hw], [x1, y1, cz - hw], [x0, y0, cz - hw], HUB, [0, 0, -1])
      }
    }

    // 底盘 + 主舱 + 舱盖
    box(-hL * 0.90, hL * 0.90, yCh0, yCh1, -hW * 0.88, hW * 0.88, CH, CH)
    box(-hL, hL, yCh1, yBody1, -hW, hW, BODY, BODY)
    box(-hL * (1 - inset), hL * (1 - inset), yBody1, yLid1, -hW * (1 - inset), hW * (1 - inset), LID, LID)
    // 顶部旋钮/天线
    var kr = 0.045 * M, kx = -hL * 0.42
    box(kx - kr, kx + kr, yLid1, yLid1 + 0.07 * M, -kr, kr, [0.12, 0.16, 0.22, 1], [0.20, 0.28, 0.36, 1])

    // 青色灯带：主舱顶部一圈（细带，法线朝外 → 不被光照明暗吃掉，始终发亮）
    var e = 0.008 * M
    var by0 = yBody1 - 0.055 * M, by1 = yBody1 - 0.012 * M
    pushQuad(m, [-hL - e, by0, -hW - e], [hL + e, by0, -hW - e], [hL + e, by1, -hW - e], [-hL - e, by1, -hW - e], GLOW, [0, 0, -1])
    pushQuad(m, [-hL - e, by0, hW + e], [hL + e, by0, hW + e], [hL + e, by1, hW + e], [-hL - e, by1, hW + e], GLOW, [0, 0, 1])
    pushQuad(m, [hL + e, by0, -hW - e], [hL + e, by0, hW + e], [hL + e, by1, hW + e], [hL + e, by1, -hW - e], GLOW, [1, 0, 0])
    pushQuad(m, [-hL - e, by0, -hW - e], [-hL - e, by0, hW + e], [-hL - e, by1, hW + e], [-hL - e, by1, -hW - e], GLOW, [-1, 0, 0])

    // 前脸：深色屏幕 + 上方灯条 + 侧面小灯；车尾一盏红色尾灯
    var fx = hL + 0.012 * M
    pushQuad(m, [fx, 0.40 * M, -hW * 0.62], [fx, 0.40 * M, hW * 0.62], [fx, 0.64 * M, hW * 0.62], [fx, 0.64 * M, -hW * 0.62], SCREEN, [1, 0, 0])
    pushQuad(m, [fx, 0.65 * M, -hW * 0.62], [fx, 0.65 * M, hW * 0.62], [fx, 0.69 * M, hW * 0.62], [fx, 0.69 * M, -hW * 0.62], GLOW, [1, 0, 0])
    pushQuad(m, [fx, 0.30 * M, -hW * 0.34], [fx, 0.30 * M, -hW * 0.16], [fx, 0.34 * M, -hW * 0.16], [fx, 0.34 * M, -hW * 0.34], GLOW, [1, 0, 0])
    pushQuad(m, [fx, 0.30 * M, hW * 0.16], [fx, 0.30 * M, hW * 0.34], [fx, 0.34 * M, hW * 0.34], [fx, 0.34 * M, hW * 0.16], GLOW, [1, 0, 0])
    pushQuad(m, [-fx, 0.52 * M, -hW * 0.55], [-fx, 0.52 * M, hW * 0.55], [-fx, 0.58 * M, hW * 0.55], [-fx, 0.58 * M, -hW * 0.55], [1.0, 0.36, 0.18, 1], [-1, 0, 0])

    // 六轮：左右各 3（前后 + 中）
    var hw = 0.055 * M
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      var wz = s2 * (hW - 0.005 * M)
      wheel(-hL * 0.62, wz, yAxle, hw)
      wheel(0, wz, yAxle, hw)
      wheel(hL * 0.62, wz, yAxle, hw)
    }

    var f = finalize(m)
    f.height = yLid1
    return f
  }

  /* ---------------- 车底定位光环 / 车顶光柱（跟随车辆模型矩阵绘制） ---------------- */
  function buildRing(pxPerM, radiusM) {
    var m = newMesh()
    var R = num(radiusM) > 0 ? radiusM : 2.7
    var rOut = R * pxPerM, rIn = R * 0.86 * pxPerM, seg = 56, y = 0.7
    for (var i = 0; i < seg; i++) {
      var a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI
      pushQuad(m,
        [Math.cos(a0) * rIn, y, Math.sin(a0) * rIn], [Math.cos(a0) * rOut, y, Math.sin(a0) * rOut],
        [Math.cos(a1) * rOut, y, Math.sin(a1) * rOut], [Math.cos(a1) * rIn, y, Math.sin(a1) * rIn],
        THEME.ring, [0, 1, 0])
    }
    // 内圈细环
    var seg2 = 40
    for (var k = 0; k < seg2; k++) {
      var b0 = k / seg2 * 2 * Math.PI, b1 = (k + 1) / seg2 * 2 * Math.PI
      var ri = R * 0.45 * pxPerM, ro = R * 0.51 * pxPerM
      pushQuad(m,
        [Math.cos(b0) * ri, y, Math.sin(b0) * ri], [Math.cos(b0) * ro, y, Math.sin(b0) * ro],
        [Math.cos(b1) * ro, y, Math.sin(b1) * ro], [Math.cos(b1) * ri, y, Math.sin(b1) * ri],
        THEME.ring, [0, 1, 0])
    }
    return finalize(m)
  }
  function buildBeam(pxPerM, heightM, widthM) {
    var m = newMesh()
    var H = (num(heightM) > 0 ? heightM : 7.5) * pxPerM
    var w = (num(widthM) > 0 ? widthM : 0.24) * pxPerM
    var y0 = 0.62 * pxPerM
    pushQuad(m, [-w, y0, 0], [w, y0, 0], [w, y0 + H, 0], [-w, y0 + H, 0], THEME.beam, null)
    pushQuad(m, [0, y0, -w], [0, y0, w], [0, y0 + H, w], [0, y0 + H, -w], THEME.beam, null)
    return finalize(m)
  }

  /* ---------------- 路线（橙色规划/演示路径，贴地扁带 + 弧长属性给流光） ---------------- */
  function buildRouteMesh(paths, pxPerM, col) {
    var m = newMesh()
    var c = col || THEME.route
    for (var i = 0; i < (paths || []).length; i++) {
      var pts = paths[i].pts || paths[i]
      if (!pts || pts.length < 2) continue
      var cum = cumulative(pts)
      ribbon(m, pts, 3.4 * pxPerM, 3.0, [c[0] * 0.35, c[1] * 0.35, c[2] * 0.35, 0.55], cum)
      ribbon(m, pts, 1.9 * pxPerM, 3.6, c, cum)
    }
    return finalize(m)
  }

  /* ---------------- 演示路线：按"商铺 → 各栋"贪心最近邻串联 ----------------
   * 真实路线由平台下发；演示时没有数据，用楼栋顺序生成一条橙色路径，
   * 既像参考图的"规划路线"，又能让演示车跑在上面。 */
  function demoRoutePaths(calib) {
    // 优先用 route-waypoints.json 生成的多条"贴校园道路"折线（主线 + 支线）
    if (calib && calib.demo_routes && calib.demo_routes.length) {
      var rs = []
      for (var q = 0; q < calib.demo_routes.length; q++) {
        var rr = calib.demo_routes[q]
        if (rr && rr.pts && rr.pts.length > 1) rs.push({ pts: rr.pts, name: rr.name || ('DEMO' + q) })
      }
      if (rs.length) return rs
    }
    // 回退：雷达骨架上的"最长连通路径"（真实位于走廊上，不会穿楼）
    if (calib && calib.demo_route && calib.demo_route.pts && calib.demo_route.pts.length > 1) {
      return [{ pts: calib.demo_route.pts, name: 'DEMO' }]
    }
    var blds = (calib && calib.buildings) || []
    var dorms = [], shop = null
    for (var i = 0; i < blds.length; i++) {
      var c = blds[i].center
      if (!c || !isFinite(c[0])) continue
      if (/栋/.test(blds[i].name || '')) dorms.push([c[0], c[1], blds[i].name])
      else if (/超市|商铺/.test(blds[i].name || '')) shop = [c[0], c[1], blds[i].name]
    }
    if (dorms.length < 2) return []
    var cur = shop || dorms[0]
    var rest = dorms.slice()
    if (!shop) rest.shift()
    var tour = [[cur[0], cur[1]]]
    while (rest.length) {
      var bi = 0, bd = Infinity
      for (var k = 0; k < rest.length; k++) {
        var d = Math.hypot(rest[k][0] - cur[0], rest[k][1] - cur[1])
        if (d < bd) { bd = d; bi = k }
      }
      cur = rest[bi]
      tour.push([cur[0], cur[1]])
      rest.splice(bi, 1)
    }
    return [{ pts: tour, name: 'DEMO' }]
  }

  /* ============================================================
   * 校园道路拓扑网（方案A：让规划路线"天生"落在灰色校园道路上）
   * ------------------------------------------------------------
   * ① buildRoadGraph(roads)  把 roads[] 的折线按交点打断成"节点 + 线段"，建无向图
   * ② routeOnRoads(graph, wps)  依次对相邻 waypoint 做 Dijkstra，串成一条贴路折线
   * ③ simplifyPath(pts, tol)  道格拉斯-普克抽稀 —— 直线段只留两端，拐弯处保留拐点
   *    （用户明确要求：不要样条/贝塞尔平滑，转弯处直线相接）
   * ============================================================ */
  function buildRoadGraph(roads) {
    var segs = []
    for (var ri = 0; ri < (roads || []).length; ri++) {
      var pts = roads[ri].pts || []
      for (var i = 0; i + 1 < pts.length; i++) {
        var a = pts[i], b = pts[i + 1]
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue
        segs.push({ ri: ri, a: [a[0], a[1]], b: [b[0], b[1]], cuts: [0, 1] })
      }
    }
    // 线段两两求交（含同一条路相邻段的共端点），把交点作为打断参数
    // ⚠ 用"夹紧后的两个交点必须靠得很近(<=3px)"来判定，而不是纯参数容差：
    //    坐标是 1e3 量级像素，R4(龙溪路) 与 R15(新增东西向路) 的丁字路口实测差 0.15 px，
    //    纯 1e-6/1e-3 的参数容差会判不出来 → 图断 → 最短路绕一大圈（踩过）。
    var TOLT = 0.02
    function cutParams(p, q) {
      var rx = p.b[0] - p.a[0], ry = p.b[1] - p.a[1]
      var sx = q.b[0] - q.a[0], sy = q.b[1] - q.a[1]
      var den = rx * sy - ry * sx
      if (Math.abs(den) < 1e-9) return null
      var t = ((q.a[0] - p.a[0]) * sy - (q.a[1] - p.a[1]) * sx) / den
      var u = ((q.a[0] - p.a[0]) * ry - (q.a[1] - p.a[1]) * rx) / den
      if (t < -TOLT || t > 1 + TOLT || u < -TOLT || u > 1 + TOLT) return null
      var tc = Math.max(0, Math.min(1, t)), uc = Math.max(0, Math.min(1, u))
      var pu = [p.a[0] + rx * tc, p.a[1] + ry * tc]
      var qu = [q.a[0] + sx * uc, q.a[1] + sy * uc]
      if (Math.hypot(pu[0] - qu[0], pu[1] - qu[1]) > 3) return null
      return [tc, uc]
    }
    for (var s1 = 0; s1 < segs.length; s1++) {
      for (var s2 = s1 + 1; s2 < segs.length; s2++) {
        var c = cutParams(segs[s1], segs[s2])
        if (!c) continue
        segs[s1].cuts.push(c[0]); segs[s2].cuts.push(c[1])
      }
    }
    // 节点合并：按 4px 网格哈希找邻近节点，距离 <=2px 视为同一个点
    // （打断出来的两个交点可能差零点几 px，纯坐标取整哈希会分家）
    var nodeOf = {}, nodes = []
    function nodeId(p) {
      var gx = Math.floor(p[0] / 4), gy = Math.floor(p[1] / 4)
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var bucket = nodeOf[(gx + dx) + ',' + (gy + dy)]
        if (!bucket) continue
        for (var i = 0; i < bucket.length; i++) {
          var n = nodes[bucket[i]]
          if (Math.hypot(n[0] - p[0], n[1] - p[1]) <= 2) return bucket[i]
        }
      }
      var id = nodes.length
      nodes.push([+p[0].toFixed(2), +p[1].toFixed(2)])
      var k = gx + ',' + gy
      if (!nodeOf[k]) nodeOf[k] = []
      nodeOf[k].push(id)
      return id
    }
    var adj = []   // adj[i] = [{to, w, ri}]
    for (var s = 0; s < segs.length; s++) {
      var g = segs[s]
      var cs = g.cuts.slice().sort(function (x, y) { return x - y })
      for (var k2 = 0; k2 + 1 < cs.length; k2++) {
        if (cs[k2 + 1] - cs[k2] < 1e-6) continue
        var p0 = [g.a[0] + (g.b[0] - g.a[0]) * cs[k2], g.a[1] + (g.b[1] - g.a[1]) * cs[k2]]
        var p1 = [g.a[0] + (g.b[0] - g.a[0]) * cs[k2 + 1], g.a[1] + (g.b[1] - g.a[1]) * cs[k2 + 1]]
        var n0 = nodeId(p0), n1 = nodeId(p1)
        if (n0 === n1) continue
        var w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        while (adj.length <= Math.max(n0, n1)) adj.push([])
        adj[n0].push({ to: n1, w: w, ri: g.ri })
        adj[n1].push({ to: n0, w: w, ri: g.ri })
      }
    }
    return { nodes: nodes, adj: adj }
  }
  // 把任意点吸附到最近的图节点
  function nearestNode(graph, p) {
    var best = -1, bd = Infinity
    for (var i = 0; i < graph.nodes.length; i++) {
      var d = (graph.nodes[i][0] - p[0]) * (graph.nodes[i][0] - p[0]) +
        (graph.nodes[i][1] - p[1]) * (graph.nodes[i][1] - p[1])
      if (d < bd) { bd = d; best = i }
    }
    return { id: best, dist: Math.sqrt(bd) }
  }
  // Dijkstra：返回节点下标序列
  function shortestNodes(graph, from, to) {
    var n = graph.nodes.length
    var dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n)
    dist[from] = 0
    for (var it = 0; it < n; it++) {
      var u = -1, bd = Infinity
      for (var i = 0; i < n; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i }
      if (u < 0) break
      done[u] = 1
      if (u === to) break
      var es = graph.adj[u] || []
      for (var k = 0; k < es.length; k++) {
        var v = es[k].to, nd = dist[u] + es[k].w
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u }
      }
    }
    if (!isFinite(dist[to])) return null
    var out = [], cur = to
    while (cur >= 0) { out.push(cur); cur = prev[cur] }
    return out.reverse()
  }
  // 依次穿过所有 waypoint，返回贴路的 radar 折线
  function routeOnRoads(graph, waypoints) {
    if (!graph || !graph.nodes.length || !waypoints || waypoints.length < 2) return null
    var out = []
    for (var i = 0; i + 1 < waypoints.length; i++) {
      var a = nearestNode(graph, waypoints[i]), b = nearestNode(graph, waypoints[i + 1])
      var chain = shortestNodes(graph, a.id, b.id)
      if (!chain) return null                     // 图不连通 → 交给调用方回退
      for (var k = 0; k < chain.length; k++) {
        var p = graph.nodes[chain[k]]
        if (out.length && Math.hypot(out[out.length - 1][0] - p[0], out[out.length - 1][1] - p[1]) < 1e-6) continue
        out.push([p[0], p[1]])
      }
    }
    return out.length >= 2 ? out : null
  }
  // 道格拉斯-普克抽稀（直线段只留两端，拐点保留）
  function simplifyPath(pts, tol) {
    if (!pts || pts.length < 3) return (pts || []).slice()
    var t2 = Math.max(1e-9, tol || 0)
    var keep = new Uint8Array(pts.length)
    keep[0] = 1; keep[pts.length - 1] = 1
    var stack = [[0, pts.length - 1]]
    while (stack.length) {
      var seg = stack.pop(), i0 = seg[0], i1 = seg[1]
      if (i1 <= i0 + 1) continue
      var a = pts[i0], b = pts[i1]
      var vx = b[0] - a[0], vy = b[1] - a[1]
      var L2 = vx * vx + vy * vy
      var worst = -1, wi = -1
      for (var i = i0 + 1; i < i1; i++) {
        var p = pts[i], d
        if (L2 < 1e-12) d = Math.hypot(p[0] - a[0], p[1] - a[1])
        else {
          var t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2
          t = Math.max(0, Math.min(1, t))
          d = Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t))
        }
        if (d > worst) { worst = d; wi = i }
      }
      if (worst > t2) { keep[wi] = 1; stack.push([i0, wi], [wi, i1]) }
    }
    var res = []
    for (var j = 0; j < pts.length; j++) if (keep[j]) res.push([pts[j][0], pts[j][1]])
    return res
  }


  /* ---------------- 光照 ---------------- */
  var LIGHT = norm([-0.42, 0.80, -0.43])
  var AMBIENT = 0.62, DIFFUSE = 0.48
  function shade(col, n) {
    var d = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]
    if (d < 0) d = 0
    var k = AMBIENT + DIFFUSE * d
    var al = col.length > 3 ? col[3] : 1
    return [Math.min(1, col[0] * k), Math.min(1, col[1] * k), Math.min(1, col[2] * k), al]
  }

  function carMatrix(x, z, theta, y) {
    return mat4.mul(mat4.translation(x, y || 0, z), mat4.rotY(-theta))
  }

  return {
    D2R: D2R, THEME: THEME, LIGHT: LIGHT, AMBIENT: AMBIENT, DIFFUSE: DIFFUSE,
    mat4: mat4, sub: sub, dot: dot, cross: cross, norm: norm,
    triangulate: triangulate, ringArea: ringArea,
    newMesh: newMesh, pushTri: pushTri, pushQuad: pushQuad, finalize: finalize, linePts: linePts,
    ribbon: ribbon, column: column, octa: octa, addBuilding: addBuilding,
    buildStatic: buildStatic, buildCar: buildCar, buildRing: buildRing, buildBeam: buildBeam,
    buildRouteMesh: buildRouteMesh, demoRoutePaths: demoRoutePaths,
    buildRoadGraph: buildRoadGraph, routeOnRoads: routeOnRoads, simplifyPath: simplifyPath,
    nearestNode: nearestNode,
    principalAzimuth: principalAzimuth, makePlatformToRadar: makePlatformToRadar,
    makeCamera: makeCamera, fitDistance: fitDistance, fitCamera: fitCamera, projectPoint: projectPoint,
    shade: shade, carMatrix: carMatrix
  }
})
