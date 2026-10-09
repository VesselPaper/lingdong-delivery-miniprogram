/* ============================================================
 * map3d-gl.js — 真三维全息地图（原生 WebGL，无第三方依赖）
 * ------------------------------------------------------------
 * 风格：数字孪生全息（深蓝底 #0A1929 + 发光网格地面 + 玻璃楼体 + 青色描边 +
 *       青绿发光路网 + 橙色规划路线 + 白色小车带定位光环/光柱 + 全息标签）。
 *
 * 为什么自己写 WebGL 而不引 three.js：大屏约定「无第三方前端依赖」，且要能离线跑。
 * 几何与相机数学全部来自 scene3d.js（与 mapfit/preview3d_gl.js 共用），
 * 所以 Node 出的预览图 == 浏览器所见。
 *
 * 渲染顺序（透明度的关键）：
 *   opaque（底板/屋顶/描边/路网/钉标，写深度）
 *   → ground（贴图 + 程序化网格，写深度）
 *   → glass（墙面，混合、不写深度、按楼从远到近）
 *   → 车辆/光环/光柱（不透明车体 + 混合光环）
 * 因为墙面不写深度，**机器人走到楼后面依然可见**（这正是用户要的）。
 *
 * 操作：左键拖动=环绕 · 滚轮=缩放 · 右键/Shift+拖动=平移 · 双击=复位 · 单指/双指（触摸）
 * ============================================================ */
window.Map3DGL = (function () {
  'use strict'
  var S = window.Scene3D
  var ASSET = 'assets/'

  var box = null, glc = null, gl = null, ovc = null, ov = null
  var W = 0, H = 0, DPR = 1
  var started = false, ready = false, failed = false
  var calib = null, groundTex = null, groundReady = false
  var progs = {}, bufs = {}
  var scene = null, carMesh = null, ringMesh = null, beamMesh = null
  // 默认值：保留**灰色校园道路**与底图、楼体；关掉橙色规划路线与青色荧光测绘线
  // （用户要求"不要取消灰色的线，先不要黄色的" → 再去掉荧光绿的线条）。
  var opts = {
    el: 65, heightScale: 0.58,
    labels: true,          // 楼栋名称
    paths: false,          // 测绘骨架线（青色荧光线条）—— 默认关闭
    roads: true,           // OSM 校园道路（灰色）—— 保留
    route: false,          // 橙色规划/演示路线 —— 默认关闭
    routeFlow: false,      // 路线上的"流光"动态效果 —— 默认关闭（用户要求：不要动态效果）
    demoCars: false,       // 演示车辆 —— 默认关闭：没有真实车辆数据时地图上不显示任何车
    // 雷达底图（激光可通行区）：默认**关闭** —— 大屏只保留校园道路与小车图标；
    // 调试对齐时可用工具栏「雷达图」按钮临时打开（能看到"有宽度的可通行区"对照）。
    ground: false,
    spin: false, follow: false, roofFade: false
  }
  var cam = null, fitDist = 0
  var view = { az: 0, el: 65, zoom: 1, target: null, panX: 0, panY: 0 }
  // 跟随目标车：点地图上的车辆选中跟随；null=未选（此时退回到跟首台）
  var followSn = null
  // 最近一帧车辆场景坐标（供点击选中跟随目标；含被下划线标记的坐标）
  var lastCars = []
  // 车辆拖尾的 3D 地面带网格（每帧重建，复用同一组 buffer）
  var trailBuf = null
  // 是否已经应用过"初始＝回到校园视角"（只做一次，之后由用户操作控制）
  var initialViewApplied = false
  // 缩放范围：zoom>1=拉远(看得更多)，zoom<1=拉近。最小拉到距默认再留约 1/3（view.zoom≈1.3），
  // 放大上限收紧（约 3 倍），避免之前缩得太深。
  var ZOOM_MIN_IN = 0.32, ZOOM_MAX_OUT = 1.30
  var live = { bbox: null, meta: null, robots: [], routes: [], landmarks: [], fleet: {} }

  /* ---------------- 3D 图层重构（灰色 OSM 路网/楼体 → 雷达激光图真实位置） ----------------
   * 小车坐标来自平台 robotpose（激光坐标系，权威、真车所在），是机器人「行驶 / 定位」的基准。
   * 真实的校园地理 = 雷达激光图（真实路宽/可通行区）。灰色 OSM 道路+楼体相对它存在
   * "空间不均匀漂移"（中心 ~8m / 东侧 ~30m），无法用单一数学变换自动校齐。
   * 因此提供**逐栋楼 / 逐条路的手动校补**：选中某个楼或某条路，用方向键/按钮把它平移
   * 到雷达图上正确的位置；另有「全域」档可整层平移/旋转/缩放做粗对齐。
   * 结果存 localStorage「dash3d_recon」，刷新仍生效；只改灰色显示层，不动小车/平台坐标。 */
  var RECON = { global: { tx: 0, ty: 0, rot: 0, sc: 1 }, bld: {}, road: {}, delRoads: {}, addRoads: [] }
  // 额外编辑能力（道路/楼栋）：软删楼栋(delBlds)、新增楼栋(addBlds)、改名(bldNames/roadNames/addNames/newRoadNames 等)。
  // 键约定：原建筑/道路用数组下标字符串 '#i'；新增对象用其在数组中序遍历后的显示名（重名自动加序号）。
  // 这些字段在 loadRecon 里逐项兜底，缺失即用默认，保证老存档兼容。
  var RECON_STEP_M = 1  // 方向键/按钮单次平移的米数
  // 把一份结构化重构数据并入 RECON（逐项兜底，缺失即用默认，保证老存档兼容）。
  function applyReconObject(o) {
    var g = (o && o.global) || {}
    RECON.global = {
      tx: isFinite(num(g.tx)) ? num(g.tx) : 0,
      ty: isFinite(num(g.ty)) ? num(g.ty) : 0,
      rot: isFinite(num(g.rot)) ? num(g.rot) : 0,
      sc: isFinite(num(g.sc)) && num(g.sc) > 0 ? num(g.sc) : 1
    }
    RECON.bld = (o && o.bld && typeof o.bld === 'object') ? o.bld : {}
    RECON.road = (o && o.road && typeof o.road === 'object') ? o.road : {}
    RECON.delRoads = (o && o.delRoads && typeof o.delRoads === 'object') ? o.delRoads : {}
    RECON.addRoads = Array.isArray(o && o.addRoads) ? o.addRoads : []
    RECON.delBlds = (o && o.delBlds && typeof o.delBlds === 'object') ? o.delBlds : {}
    RECON.addBlds = Array.isArray(o && o.addBlds) ? o.addBlds : []
    RECON.bldNames = (o && o.bldNames && typeof o.bldNames === 'object') ? o.bldNames : {}
    RECON.roadNames = (o && o.roadNames && typeof o.roadNames === 'object') ? o.roadNames : {}
    RECON.roadCls = (o && o.roadCls && typeof o.roadCls === 'object') ? o.roadCls : {}
    RECON.bldHeight = (o && o.bldHeight && typeof o.bldHeight === 'object') ? o.bldHeight : {}
  }
  function loadRecon() {
    // 优先级：本地手工存档(localStorage) > 内置默认新地图(MAP_DEFAULT_RECON)。
    // 状态由"本机手工改过的存档"决定；没有手工存档时就显示内置的完善后新地图。
    try {
      var s = window.localStorage && window.localStorage.getItem('dash3d_recon')
      var src = null
      if (s) { try { src = JSON.parse(s) } catch (e) { src = null } }
      if (!(src && typeof src === 'object')) src = window.MAP_DEFAULT_RECON || null
      if (src && typeof src === 'object') applyReconObject(src)
    } catch (e) {}
  }
  function saveRecon() {
    try { window.localStorage.setItem('dash3d_recon', JSON.stringify(RECON)) } catch (e) {}
  }
  // 便于脚本读取/回写重构数据（已持久化在 localStorage「dash3d_recon」）
  if (window) window.__dash3d_recon = {
    get: function () { return JSON.parse(JSON.stringify(RECON)) },
    set: function (o) { if (o && typeof o === 'object') RECON = o; rebuildGrey(); saveRecon() }
  }

  /* ---- 新增道路绘制（画线）状态 ----
   * reconDrawActive=true 时，在地图上左键单击会投放到地面点（scene px）加入 reconDrawPts，
   * 并通过 bufs.drawPrev 实时预览折线；双击 /「完成」收尾写入 RECON.addRoads。 */
  var reconDrawActive = false
  var reconDrawPts = []
  // 当前画的对象：'road'（新增道路折线）｜'bld'（新增楼栋轮廓）；完成时按此落地到不同 RECON 数组
  var reconDrawKind = 'road'
  // 编辑选中态（点击地图高亮）：{kind:'road'|'bld'|'addRoad'|'addBld', key, name, ...}；null=未选中
  var editedSel = null
  // 预览缓冲（在 bindReconControls 里用场景 pxPerM 刷新）
  var drawPrevKey = ''

  // 新增楼栋轮廓的名字（完成时自增）；刷新也不重置，避免楼名重复
  function nextBldName() {
    var n = (RECON.addBlds || []).length + 1
    var used = {}
    ;(RECON.addBlds || []).forEach(function (b) { if (b && b.name) used[b.name] = 1 })
    var base = '新楼'
    while (used[base + n]) n++
    return base + n
  }

  function updateDrawPreview() {
    if (!gl || !scene) { dropMesh(bufs.drawPrev); bufs.drawPrev = null; drawPrevKey = ''; return }
    if (reconDrawPts.length < 2) {
      if (bufs.drawPrev) { dropMesh(bufs.drawPrev); bufs.drawPrev = null }
      drawPrevKey = ''
      return
    }
    var key = reconDrawPts.length + ':' + Math.round(reconDrawPts[reconDrawPts.length - 1][0] * 10)
    if (key === drawPrevKey && bufs.drawPrev) return
    drawPrevKey = key
    if (bufs.drawPrev) dropMesh(bufs.drawPrev)
    bufs.drawPrev = uploadMesh(S.buildRouteMesh([{ pts: reconDrawPts.slice() }], scene.pxPerM, [0.1, 1.0, 0.55]))
  }
  function cancelReconDraw() {
    reconDrawActive = false
    reconDrawPts = []
    if (bufs.drawPrev) { dropMesh(bufs.drawPrev); bufs.drawPrev = null }
    drawPrevKey = ''
    var s = document.getElementById('reconSel'); if (s) s.disabled = false
    var b = document.getElementById('reconDrawBtns'); if (b) b.hidden = true
    var d = document.getElementById('reconDrawHint'); if (d) d.hidden = true
  }
  function finishReconDraw() {
    if (reconDrawKind === 'bld') {
      // 楼栋轮廓：至少 3 个不重复顶点；首尾不同则补闭合点（三角化需要闭合环）
      var ring = []
      for (var i = 0; i < reconDrawPts.length; i++) {
        var p = reconDrawPts[i]
        var dup = ring.length && ring[ring.length - 1][0] === p[0] && ring[ring.length - 1][1] === p[1]
        if (!dup) ring.push([p[0], p[1]])
      }
      if (ring.length >= 3) {
        if (window.Map3DGLRecon && window.Map3DGLRecon.beforeChange) window.Map3DGLRecon.beforeChange()
        var first = ring[0], last = ring[ring.length - 1]
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
        RECON.addBlds = RECON.addBlds || []
        var name = nextBldName()
        RECON.addBlds.push({ name: name, cls: 'bld', ring: ring })
        rebuildGrey()
        cancelReconDraw()
        var nb = document.getElementById('alignNote')
        if (nb) nb.textContent = '已新增楼栋「' + name + '」（保存后写进 dash3d_recon；可选中它再微调位置）'
      } else {
        cancelReconDraw()
        var nb2 = document.getElementById('alignNote')
        if (nb2) nb2.textContent = '楼栋轮廓至少需要 3 个点，已取消'
      }
      return
    }
    if (reconDrawPts.length >= 2) {
      if (window.Map3DGLRecon && window.Map3DGLRecon.beforeChange) window.Map3DGLRecon.beforeChange()
      RECON.addRoads.push({ name: '新路' + (RECON.addRoads.length + 1), cls: 'road', pts: reconDrawPts.slice() })
      rebuildGrey()
    }
    cancelReconDraw()
    var n = document.getElementById('alignNote')
    if (n) n.textContent = '已新增一条道路（保存后写进 dash3d_recon）'
  }
  function beginReconDraw(kind) {
    reconDrawKind = kind === 'bld' ? 'bld' : 'road'
    reconDrawPts = []
    reconDrawActive = true
    var s = document.getElementById('reconSel'); if (s) s.disabled = true
    var b = document.getElementById('reconDrawBtns'); if (b) b.hidden = false
    var d = document.getElementById('reconDrawHint'); if (d) d.hidden = false
    var n = document.getElementById('alignNote')
    if (n) n.textContent = '画' + (reconDrawKind === 'bld' ? '楼栋轮廓' : '道路') + '模式：左键逐点放点，完成后点「完成」或在图上双击收尾（楼栋至少 3 个点）'
  }
  var _gCenter = null
  // 命中检测：屏幕逻辑像素 → 命中的道路/楼栋（在 grayGlobal 变换后的场景坐标里做距离判定）。
  // 返回 {kind, key, name, subtype}：kind='road'|'bld'，key='#'+原下标 或 '#add:'+新增下标。
  // 道路用「点到折线最近距离」判定，楼栋用「点到多边形 ring 最近距离」（含中心兜底）。
  function pickAtXY(sx, sy) {
    if (!scene || !cam) return null
    var g = groundAt(sx, sy, 0)
    if (!g) return null
    var px = g[0], pz = g[2]
    var ppm = scene.pxPerM || 19.45
    var ROAD_TOL = 6.5 * ppm          // 点到路最近距离 <6.5m 算命中
    var BLD_TOL = 6.0 * ppm           // 点到楼轮廓距离 <6m 算命中（点楼内也算）
    // 一条原道路/楼栋在「有效标定」里的显示坐标（含全域+逐元素偏移）
    function shownRoadPts(r, idx) {
      if (RECON.delRoads && (RECON.delRoads['#' + idx] || RECON.delRoads[r.name])) return null
      var off = (RECON.road && (RECON.road['#' + idx] || RECON.road[r.name])) || { dx: 0, dy: 0 }
      return perObjPts((r.pts || []).map(function (p) { return greyGlobalPx(p[0], p[1]) }), off)
    }
    function shownBldRing(b, idx) {
      if (RECON.delBlds && RECON.delBlds['#' + idx]) return null
      var off = (RECON.bld && (RECON.bld['#' + idx] || RECON.bld[b.name])) || { dx: 0, dy: 0 }
      return perObjPts((b.ring || []).map(function (p) { return greyGlobalPx(p[0], p[1]) }), off)
    }
    var best = null, bd = Infinity
    // 原道路
    ;(calib.roads || []).forEach(function (r, idx) {
      var pts = shownRoadPts(r, idx)
      if (!pts || pts.length < 2) return
      for (var s2 = 0; s2 < pts.length - 1; s2++) {
        var d = ptSegDist(px, pz, pts[s2], pts[s2 + 1])
        if (d < bd) { bd = d; best = { kind: 'road', key: '#' + idx, name: r.name || ('道路#' + idx), subtype: 'orig' } }
      }
    })
    // 新增道路（点已在场景 px，套全域+自身旋转缩放）
    ;(RECON.addRoads || []).forEach(function (nr, ai) {
      if (!nr || !Array.isArray(nr.pts) || nr.pts.length < 2) return
      var pts = perObjPts(nr.pts.map(function (p) { return [num(p[0]), num(p[1])] }), nr)
      for (var s3 = 0; s3 < pts.length - 1; s3++) {
        var d3 = ptSegDist(px, pz, pts[s3], pts[s3 + 1])
        if (d3 < bd) { bd = d3; best = { kind: 'road', key: '#add:' + ai, name: nr.name || ('新路' + (ai + 1)), subtype: 'add' } }
      }
    })
    if (best && bd <= ROAD_TOL * 1.5) return best
    // 楼栋（原 + 新增）
    var bb = null, bbd = Infinity
    ;(calib.buildings || []).forEach(function (b, idx) {
      var ring = shownBldRing(b, idx)
      if (!ring || ring.length < 3) return
      var d2 = polySegDist(px, pz, ring)
      if (d2 < bbd) { bbd = d2; bb = { kind: 'bld', key: '#' + idx, name: b.name || ('楼栋#' + idx), subtype: 'orig' } }
    })
    ;(RECON.addBlds || []).forEach(function (nb, ai) {
      if (!nb || !Array.isArray(nb.ring) || nb.ring.length < 3) return
      var ring = perObjPts(nb.ring.map(function (p) { return [num(p[0]), num(p[1])] }), nb)
      var d4 = polySegDist(px, pz, ring)
      if (d4 < bbd) { bbd = d4; bb = { kind: 'bld', key: '#add:' + ai, name: nb.name || ('新楼' + (ai + 1)), subtype: 'add' } }
    })
    if (bb && bbd <= BLD_TOL) return bb
    return null
  }
  function recFromIndex(obj, i, addArr) {
    if (i >= 0 && addArr && addArr.length && i >= addArr.length) return { key: '#' + (i - addArr.length), subtype: 'orig' }
    return { key: '#add:' + i, subtype: 'add' }
  }
  function ptSegDist(px, pz, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1]
    var L2 = vx * vx + vy * vy
    var t = L2 > 1e-9 ? ((px - a[0]) * vx + (pz - a[1]) * vy) / L2 : 0
    t = Math.max(0, Math.min(1, t))
    var qx = a[0] + vx * t, qy = a[1] + vy * t
    return Math.hypot(px - qx, pz - qy)
  }
  // 点到多边形轮廓（各边线段）最近距离；点在多边形内视为 0
  function polySegDist(px, pz, ring) {
    var min = Infinity
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length]
      var d = ptSegDist(px, pz, a, b)
      if (d < min) min = d
    }
    // 点在多边形内（射线法）→ 也算命中（距离 0）
    var inside = false
    for (var j = 0, k = ring.length - 1; j < ring.length; k = j++) {
      var a2 = ring[j], b2 = ring[k]
      if (((a2[1] > pz) !== (b2[1] > pz)) && (px < (b2[0] - a2[0]) * (pz - a2[1]) / (b2[1] - a2[1] + 1e-9) + a2[0])) inside = !inside
    }
    return inside ? 0 : min
  }
  // 灰色层全域基点（绕它旋转/缩放），懒计算为雷达图中心
  function gCenter() {
    if (!_gCenter) _gCenter = scene ? [scene.radarW / 2, scene.radarH / 2] : [calib && calib.radar_full_size ? calib.radar_full_size[0] / 2 : 2893, calib && calib.radar_full_size ? calib.radar_full_size[1] / 2 : 2703]
    return _gCenter
  }
  // 对灰色层一个点应用「全域变换」（global）—— 供 effectiveCalib() 用它变换整条路/整栋楼
  function greyGlobalPx(x, y) {
    var g = RECON.global
    if (g.tx === 0 && g.ty === 0 && g.rot === 0 && g.sc === 1) return [x, y]
    var s = g.sc, r = g.rot * Math.PI / 180
    var c = Math.cos(r) * s, sn = Math.sin(r) * s
    var cg = gCenter(), px = cg[0], py = cg[1]
    var dx = x - px, dy = y - py
    return [c * dx - sn * dy + px + g.tx, sn * dx + c * dy + py + g.ty]
  }
  var _calibEff = null
  // 对一组点套「逐元素」旋/缩/平移（绕旋转中心 pivotPts 的质心，默认绕自身质心）。
  // 返回新数组（不改入参）。rec = {dx,dy,rot,sc}（rot 单位角度，sc 缩放）。全零时直接浅拷贝。
  function perObjPts(pts, rec, pivotPts) {
    var dx = num(rec && rec.dx), dy = num(rec && rec.dy)
    var rot = num(rec && rec.rot)
    var sc = (rec && typeof rec.sc === 'number' && rec.sc > 0) ? rec.sc : 1
    if (rot === 0 && sc === 1 && dx === 0 && dy === 0) return pts.map(function (p) { return [p[0], p[1]] })
    var base = pivotPts || pts
    var n = base.length, cx = 0, cy = 0
    for (var i = 0; i < n; i++) { cx += base[i][0]; cy += base[i][1] }
    cx /= n; cy /= n
    var a = rot * Math.PI / 180, co = Math.cos(a) * sc, si = Math.sin(a) * sc
    return pts.map(function (p) {
      var x = p[0] - cx, y = p[1] - cy
      return [cx + co * x - si * y + dx, cy + si * x + co * y + dy]
    })
  }
  // 生成「有效标定数据」：把灰色层(楼体 ring/center + 道路 pts) 按 全域 + 逐元素 偏移后的副本。
  // 供 buildStatic / buildRoadGraph / demoRoutePaths 使用；青色导航线、小车、吸附网仍用原始权威坐标。
  function effectiveCalib() {
    if (!calib) return calib
    var g = RECON.global
    if (_calibEff) return _calibEff
    var hasGlobal = !(g.tx === 0 && g.ty === 0 && g.rot === 0 && g.sc === 1)
    // 只要有任何一档编辑记录（含新增楼栋/软删楼/改名），就重建有效副本
    var needAny = hasGlobal ||
      (Object.keys(RECON.bld || {}).length > 0) || (Object.keys(RECON.road || {}).length > 0) ||
      (Object.keys(RECON.delRoads || {}).length > 0) || ((RECON.addRoads || []).length > 0) ||
      (Object.keys(RECON.delBlds || {}).length > 0) || ((RECON.addBlds || []).length > 0) ||
      (Object.keys(RECON.bldNames || {}).length > 0) || (Object.keys(RECON.roadNames || {}).length > 0) ||
      (Object.keys(RECON.roadCls || {}).length > 0) || (Object.keys(RECON.bldHeight || {}).length > 0)
    if (!needAny) { _calibEff = calib; return calib }
    var out = { __proto__: calib, buildings: [], paths: calib.paths, demo_route: calib.demo_route }
    // 复制除 buildings/roads 之外的字段，保持引用一致（不动原数据）
    for (var k in calib) { if (k === 'buildings') continue; if (k === 'roads') continue; out[k] = calib[k] }
    // 键解析：#i 按下标；否则按名称（兼容老存档）。新增对象按 {kind}#序号 计算。
    // 楼体：软删 + 全域 + 逐栋 dx/dy/rot/sc + 改名/改高
    out.buildings = []
    ;(calib.buildings || []).forEach(function (b, bi) {
      var key = '#' + bi
      if (RECON.delBlds && RECON.delBlds[key]) return
      var off = (RECON.bld && (RECON.bld[key] || RECON.bld[b.name] || RECON.bld['#' + bi])) || { dx: 0, dy: 0 }
      var rawRing = (b.ring || []).map(function (p) { return greyGlobalPx(p[0], p[1]) })
      var ring = perObjPts(rawRing, off)
      var center = b.center ? perObjPts([greyGlobalPx(b.center[0], b.center[1])], off, rawRing)[0] : b.center
      var nb = { __proto__: b, ring: ring, center: center }
      // 改名 / 改高（显示层覆盖，不动源标定）
      var newName = RECON.bldNames && RECON.bldNames[key]; if (newName) nb.name = newName
      var newH = RECON.bldHeight && RECON.bldHeight[key]; if (newH) nb.height_m = num(newH)
      out.buildings.push(nb)
    })
    // 用户新增楼栋（画轮廓）：points 已是 scene px 场景世界坐标，直接按点渲，不套全局变换
    //（否则用户在已有 global 偏移时会二次错位）。自身逐对象 rot/sc 通过 perObjPts 保留。
    ;(RECON.addBlds || []).forEach(function (nb2) {
      if (!nb2 || !Array.isArray(nb2.ring) || nb2.ring.length < 3) return
      var rawRing = nb2.ring.map(function (p) { return [num(p[0]), num(p[1])] })
      var rring = perObjPts(rawRing, nb2)
      var cx = 0, cz = 0
      for (var ai = 0; ai < rawRing.length; ai++) { cx += rawRing[ai][0]; cz += rawRing[ai][1] }
      out.buildings.push({
        name: nb2.name || ('新楼' + (out.buildings.length + 1)),
        cls: nb2.cls || 'bld', height_m: num(nb2.height_m) || 12,
        center: nb2.center ? perObjPts([num(nb2.center[0]), num(nb2.center[1])], nb2, rawRing)[0] : [cx / rawRing.length, cz / rawRing.length],
        ring: rring
      })
    })
    // 道路：删除被标记的 + 全域/逐路偏移/旋转缩放/改名/改类 + 追加用户新增的
    out.roads = []
    ;(calib.roads || []).forEach(function (r, idx) {
      var key = '#' + idx
      if (RECON.delRoads && (RECON.delRoads[key] || RECON.delRoads[r.name])) return
      var off = (RECON.road && (RECON.road[key] || RECON.road[r.name] || RECON.road['#' + idx])) || { dx: 0, dy: 0 }
      var pts = perObjPts((r.pts || []).map(function (p) { return greyGlobalPx(p[0], p[1]) }), off)
      var nr = { __proto__: r, pts: pts }
      var newName = RECON.roadNames && RECON.roadNames[key]; if (newName) nr.name = newName
      var newCls = RECON.roadCls && RECON.roadCls[key]; if (newCls) nr.cls = newCls
      out.roads.push(nr)
    })
    // 用户新增道路：points 已是 scene px 场景世界坐标，直接按点渲，不套全局变换
    //（否则用户在已有 global 偏移时会二次错位）。自身逐对象 rot/sc 经 perObjPts 保留。
    ;(RECON.addRoads || []).forEach(function (nr2) {
      if (!nr2 || !Array.isArray(nr2.pts) || nr2.pts.length < 2) return
      out.roads.push({
        name: nr2.name || ('新路' + (out.roads.length + 1)), cls: nr2.cls || 'road',
        pts: perObjPts(nr2.pts.map(function (p) { return [num(p[0]), num(p[1])] }), nr2)
      })
    })
    return out
  }
  function invalidateCalibEff() { _calibEff = null }
  // 仅重建灰色静态场景（不碰青色导航线/小车/吸附网）
  function rebuildGrey() {
    invalidateCalibEff()
    rebuildStaticMesh()
  }
  loadRecon()

  // 从服务器拉取「3D 图层重构」数据：服务器上存在时优先覆盖，保证全局一致。
  // 后端无 recon 接口/鉴权关闭/超时则静默忽略，保持当前显示（本地 localStorage 或内置默认）。
  // 需要等场景就绪（gl + calib）后再应用，否则 rebuild 会因 calib 为空而空跑，导致服务器数据没真正显示。
  function loadReconRemote() {
    var url = (window.Dash && window.Dash.C && window.Dash.C.API_RECON) || null
    if (!url) return
    function tryOnce() {
      if (!ready || !calib) return false      // 场景还没就绪，稍后重试
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
      var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, 6000)
      fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          clearTimeout(timer)
          if (!j || j.code !== 0 || !j.data) return
          var rc = j.data.recon
          if (rc && typeof rc === 'object') {
            applyReconObject(rc)
            rebuild()                    // 完整重建（楼体/道路/车模），确保服务器数据真正上屏
            markReconSource('server')
          }
        })
        .catch(function () { clearTimeout(timer) })
      return true
    }
    if (tryOnce()) return
    // 场景未就绪：轮询等待 ready（applyCalib 完成后）
    var tries = 0
    var iv = setInterval(function () {
      tries++
      if (tryOnce() || tries > 80) clearInterval(iv)   // 约 8s 内最多轮询 80 次
    }, 100)
  }
  // 记录本次重构数据的来源（server/local/default），供地图下角提示排查
  function markReconSource(src) {
    window.__dash3d_recon_src = src
  }
  loadReconRemote()

  var robotAnim = {}, demo = null, routeMeshData = null, routeKey = '', roadNet = null
  var errEl = null, tipEl = null, maskEl = null
  var isGL2 = false

  // 车辆显示放大倍数：真车长 1.3m，在整图约 4px/m 的视口里只有几个像素、会退化成小点，
  // 所以默认放大到 3.0 倍（车长约 3.9m）——与"楼高夸张"同理，属可读性取舍。
  // 需要调参可在地址栏加 ?carscale=2 覆盖。
  // 车模显示倍数：默认 9.0（车身上屏约 45px，配合亮色车体一眼可辨；可用 ?carscale=N 或工具栏"车模比例"滑块实时改）。
  var CAR_SCALE = (function () {
    var mt = /[?&]carscale=([0-9.]+)/.exec(location.search)
    var v = mt ? Number(mt[1]) : 0
    return v > 0 ? v : 9.0
  })()
  var CAR_LEN_M = 1.3 * CAR_SCALE
  function setCarScale(v) {
    if (!(v > 0)) v = 6.0
    CAR_SCALE = v
    CAR_LEN_M = 1.3 * v
    rebuild()
  }
  // 车模在场景中的高度（px），用于点击命中/跟随标记的投影
  function carHeightPx() { return (CAR_LEN_M * 0.6 + 1.2) * (scene ? scene.pxPerM : 19.45) }
  // 车尾外沿（后保险杠/尾灯面）到车中心的距离（场景像素）。
  // 与 scene3d.buildCar 的几何一致：盒体半长 0.65·M + 尾灯面外扩 0.012·M = 0.662·M，M = pxPerM × CAR_SCALE。
  function carTailPx() { return 0.662 * (scene ? scene.pxPerM : 19.45) * CAR_SCALE }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }
  // 收集当前有效楼栋名称集合（含改名/新增）——备用工具
  function buildingNameSet() {
    var cef = effectiveCalib(), s = {}
    ;(cef && cef.buildings ? cef.buildings : []).forEach(function (bd) {
      if (bd && bd.name) s[String(bd.name).replace(/\s+/g, '')] = 1
    })
    return s
  }
  // 失败时把已插入的画布摘掉，让回退渲染器（2.5D）能干净地接管地图区
  function fail(why) {
    failed = true
    try {
      if (glc && glc.parentNode) glc.parentNode.removeChild(glc)
      if (ovc && ovc.parentNode) ovc.parentNode.removeChild(ovc)
    } catch (e) { /* ignore */ }
    if (maskEl) { maskEl.hidden = false; maskEl.textContent = why }
    if (window.console && console.warn) console.warn('[Map3D] ' + why)
  }
  function probe() {
    try {
      var c = document.createElement('canvas')
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
    } catch (e) { return false }
  }

  /* ---------------- 着色器 ---------------- */
  var VS_MESH = window.GL3DShaders.VS_MESH
  // 流光：沿路线弧长做流动高光（片元级，随深度正常遮挡）
  var FS_MESH = window.GL3DShaders.FS_MESH
  var VS_GROUND = window.GL3DShaders.VS_GROUND
  // 雷达底图：按亮度抠背景（背景 RGB(10,25,41) 亮度≈41/255，走廊≈86/255），
  // 只保留**有宽度的可通行区**，背景透明 → 不再出现"一块正方形地面"；
  // 同时去掉原先的程序化蓝色网格（地面网格已按负责人要求移除）。
  var FS_GROUND = window.GL3DShaders.FS_GROUND

  function compile(src, type) {
    var s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  function program(vsSrc, fsSrc, names) {
    var p = gl.createProgram()
    gl.attachShader(p, compile(vsSrc, gl.VERTEX_SHADER))
    gl.attachShader(p, compile(fsSrc, gl.FRAGMENT_SHADER))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    var u = {}
    for (var i = 0; i < names.length; i++) u[names[i]] = gl.getUniformLocation(p, names[i])
    return { p: p, u: u }
  }

  /* ---------------- 初始化 ---------------- */
  function ensure() {
    if (started || failed) return
    started = true
    box = document.getElementById('mapBox')
    maskEl = document.getElementById('mapMask')
    tipEl = document.getElementById('mapTip')
    if (!box) return
    glc = document.createElement('canvas')
    glc.style.position = 'absolute'; glc.style.inset = '0'
    glc.style.width = '100%'; glc.style.height = '100%'; glc.style.zIndex = '1'
    box.appendChild(glc)
    ovc = document.createElement('canvas')
    ovc.style.position = 'absolute'; ovc.style.inset = '0'
    ovc.style.width = '100%'; ovc.style.height = '100%'; ovc.style.zIndex = '2'
    ovc.style.pointerEvents = 'none'
    box.appendChild(ovc)
    gl = glc.getContext('webgl2', { antialias: true, alpha: false, depth: true })
    isGL2 = !!gl
    if (!gl) gl = glc.getContext('webgl', { antialias: true, alpha: false, depth: true })
    if (!gl) return fail('当前浏览器不支持 WebGL，无法显示立体地图')
    ov = ovc.getContext('2d')
    try {
      progs.mesh = program(VS_MESH, FS_MESH, ['uViewProj', 'uModel', 'uLight', 'uAmbient', 'uDiffuse', 'uAlphaMul', 'uFlowAmp', 'uFlowScale', 'uTime'])
      progs.ground = program(VS_GROUND, FS_GROUND,
        ['uViewProj', 'uTex', 'uFade', 'uFadeSoft', 'uOpacity'])
    } catch (e) { return fail('WebGL 着色器编译失败：' + e.message) }
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    var bg = S.THEME.bg
    gl.clearColor(bg[0], bg[1], bg[2], 1)

    bindControls()
    bindInput()
    resize()
    window.addEventListener('resize', resize)
    loadAssets()
    requestAnimationFrame(frame)
  }

  function loadAssets() {
    if (window.MAP_CALIBRATION) applyCalib(window.MAP_CALIBRATION)
    else {
      var xhr = new XMLHttpRequest()
      xhr.open('GET', ASSET + 'map-calibration.json', true)
      xhr.onload = function () {
        if (xhr.status !== 200 && xhr.status !== 0) return fail('标定文件 HTTP ' + xhr.status)
        try { applyCalib(JSON.parse(xhr.responseText)) } catch (e) { fail('标定文件解析失败：' + e.message) }
      }
      xhr.onerror = function () { fail('标定文件加载失败（file:// 会拦截 XHR，需用 script 方式引入）') }
      try { xhr.send() } catch (e) { fail('标定文件请求异常：' + e.message) }
    }
    var im = new Image()
    im.onload = function () {
      groundTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, groundTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      groundReady = true
    }
    im.onerror = function () { groundReady = false }
    im.src = ASSET + 'radar-ground-dark.png?v=' + (window.MAP_ASSET_VER || '1')
  }

  function applyCalib(c) {
    if (!c || !c.buildings || !c.buildings.length) return fail('标定数据为空')
    calib = c
    rebuild()
    ready = true
    if (maskEl) maskEl.hidden = true
    if (tipEl) {
      tipEl.hidden = false
      tipEl.textContent = c.buildings.length + ' 栋楼 · ' + (c.paths || []).length + ' 段雷达路线 · ' +
        '拖动旋转 / 滚轮缩放 / 右键平移'
    }
  }

  /* ---------------- 几何上传 ---------------- */
  function uploadMesh(mesh) {
    var b = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), aux: null, count: mesh.count }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col); gl.bufferData(gl.ARRAY_BUFFER, mesh.col, gl.STATIC_DRAW)
    if (mesh.aux) {
      b.aux = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, b.aux); gl.bufferData(gl.ARRAY_BUFFER, mesh.aux, gl.STATIC_DRAW)
    }
    return b
  }
  function dropMesh(b) { if (b) { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.nrm); gl.deleteBuffer(b.col); if (b.aux) gl.deleteBuffer(b.aux) } }
  // 动态网格（每帧都变，如车辆拖尾）：复用同一组 buffer 只重传数据，
  // 避免每帧 createBuffer 造成 GPU buffer 泄漏。
  function uploadMeshInto(b, mesh) {
    if (!b) return uploadMesh(mesh)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col); gl.bufferData(gl.ARRAY_BUFFER, mesh.col, gl.DYNAMIC_DRAW)
    // aux 必须与顶点数严格一致：若残留旧长度的 aux buffer，顶点数变多时 drawArrays 会越界读
    // → WebGL 直接报 INVALID_OPERATION 并**整条不画**。所以这里同步维护。
    if (mesh.aux) {
      if (!b.aux) b.aux = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, b.aux); gl.bufferData(gl.ARRAY_BUFFER, mesh.aux, gl.DYNAMIC_DRAW)
    } else if (b.aux) {
      gl.deleteBuffer(b.aux); b.aux = null
    }
    b.count = mesh.count
    return b
  }

  // 只重建灰色静态层（楼体/道路/底板/车模）—— 不碰青色导航线、小车吸附、路线
  function rebuildStaticMesh() {
    if (!gl || !calib) return
    var ce = effectiveCalib()
    scene = S.buildStatic(ce, {
      roads: opts.roads, paths: opts.paths, labels: opts.labels, heightScale: opts.heightScale
    })
    // 道路拓扑网：规划路线用它做"吸附 + 最短路"，保证黄线一定压在灰色道路上
    roadNet = S.buildRoadGraph(ce.roads || [])
    dropMesh(bufs.opaque); bufs.opaque = uploadMesh(scene.opaque)
    dropMesh(bufs.roofs); bufs.roofs = uploadMesh(scene.roofs)
    dropMesh(bufs.glass); bufs.glass = uploadMesh(scene.glass)
    carMesh = S.buildCar(scene.pxPerM, CAR_SCALE); dropMesh(bufs.car); bufs.car = uploadMesh(carMesh)
    ringMesh = S.buildRing(scene.pxPerM, CAR_LEN_M * 0.92); dropMesh(bufs.ring); bufs.ring = uploadMesh(ringMesh)
    beamMesh = S.buildBeam(scene.pxPerM, CAR_LEN_M * 2.2, 0.24 * CAR_SCALE); dropMesh(bufs.beam); bufs.beam = uploadMesh(beamMesh)
    if (!bufs.ground) {
      bufs.ground = { pos: gl.createBuffer(), uv: gl.createBuffer(), count: 4 }
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ground.uv)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(scene.ground.uv), gl.STATIC_DRAW)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ground.pos)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(scene.ground.pos), gl.STATIC_DRAW)

    if (view.az === 0) view.az = S.principalAzimuth(ce.buildings)
    view.target = scene.bounds.center.slice()
  }

  function rebuild() {
    if (!gl || !calib) return
    invalidateCalibEff()
    rebuildStaticMesh()

    // 演示路线（橙色，沿雷达骨架最长连通路径）；真实模式由平台下发路线，改用叠加层绘制
    // 路线网格：只在打开「路线」时构建（演示档用骨架主路线；真实档用平台途经点）
    dropMesh(bufs.route)
    bufs.route = null
    routeKey = ''
    if (opts.route) {
      routeMeshData = S.buildRouteMesh(S.demoRoutePaths(calib), scene.pxPerM)
      bufs.route = uploadMesh(routeMeshData)
      flowScale = 1 / (9 * scene.pxPerM)     // 流光节距：约每 9 m 一个高光
    }
    demo = null
    updateCamera(true)
    // 首次构建完成后，自动切到「回到校园」视角（用户要求：一打开网页就是这个视角）
    if (!initialViewApplied) { initialViewApplied = true; resetView() }
  }

  /* ---------------- 相机 ---------------- */
  function updateCamera(refit) {
    if (!scene || !W || !H) return          // 面板还没布局出尺寸时不要算相机（会出 NaN）
    if (refit || !fitDist) {
      var c = S.fitCamera(W, H, scene.bounds, { az: view.az, el: view.el, fov: 34, target: view.target, margin: 0.93 })
      fitDist = c.fitDist
    }
    cam = S.makeCamera(W, H, scene.bounds, {
      az: view.az, el: view.el, fov: 34,
      dist: fitDist * view.zoom,
      target: [view.target[0] + view.panX, view.target[1], view.target[2] + view.panY]
    })
    cam.vpF32 = new Float32Array(cam.viewProj)
  }

  function resize() {
    if (!box || !gl) return
    DPR = Math.min(2, window.devicePixelRatio || 1)
    W = box.clientWidth || 0
    H = box.clientHeight || 0
    if (!W || !H) return
    glc.width = Math.round(W * DPR); glc.height = Math.round(H * DPR)
    ovc.width = Math.round(W * DPR); ovc.height = Math.round(H * DPR)
    gl.viewport(0, 0, glc.width, glc.height)
    updateCamera(true)
  }

  // 屏幕像素坐标（canvas 逻辑像素，0..W/0..H）→ 地面 y=hitY 平面上的世界场景像素点。
  // 用于"右键拖动让内容跟手"和"滚轮以光标为中心缩放"。hitY 默认 0（贴地）。
  function groundAt(sx, sy, hitY) {
    if (!cam || !W || !H) return null
    hitY = (hitY == null ? 0 : hitY)
    var eye = cam.eye, t = cam.target
    var fx = t[0] - eye[0], fy = t[1] - eye[1], fz = t[2] - eye[2]
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
    fx /= fl; fy /= fl; fz /= fl                  // forward
    var rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0 // cross(forward, up(0,1,0))
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
    rx /= rl; ry /= rl; rz /= rl                  // right
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx // up = cross(right, forward)
    var hh = Math.tan(cam.fov / 2)
    var hw = hh * (W / H)
    var ndcX = (sx / W) * 2 - 1
    var ndcY = 1 - (sy / H) * 2
    var dx = rx * ndcX * hw + ux * ndcY * hh + fx
    var dy = ry * ndcX * hw + uy * ndcY * hh + fy
    var dz = rz * ndcX * hw + uz * ndcY * hh + fz
    if (Math.abs(dy) < 1e-9) return null
    var lam = (hitY - eye[1]) / dy
    if (lam <= 0) return null
    return [eye[0] + lam * dx, hitY, eye[2] + lam * dz]
  }

  function resetView() {
    view.az = S.principalAzimuth(calib ? calib.buildings : null)
    view.el = 45   //「回到校园」用 45° 俯仰（不压迫：既看得到楼顶高度，又不会太垂直）
    view.zoom = 1
    view.panX = 0; view.panY = 0
    if (scene) view.target = scene.bounds.center.slice()
    updateCamera(true)
    syncTiltSlider()
  }

  /* ---------------- 交互 ---------------- */
  function bindInput() {
    glc.style.cursor = 'grab'
    glc.style.touchAction = 'none'
    var drag = null
    // 让浏览器坐标换算成地图画布的逻辑像素（考虑 .screen 缩放），供 groundAt 使用
    function localXY(e) {
      var r = glc.getBoundingClientRect()
      return [(e.clientX - r.left) * (W / Math.max(1, r.width)), (e.clientY - r.top) * (H / Math.max(1, r.height))]
    }
    glc.addEventListener('contextmenu', function (e) { e.preventDefault() })
    glc.addEventListener('mousedown', function (e) {
      e.preventDefault()
      if (reconDrawActive && e.button === 0) return  // 画线模式：左键交给 click 放点，不做旋转
      var pan = (e.button === 2 || e.shiftKey)
      var xy = localXY(e)
      drag = { x: e.clientX, y: e.clientY, az: view.az, el: view.el, tx: view.panX, tz: view.panY, pan: pan, lastXY: pan ? xy : null }
      glc.style.cursor = drag.pan ? 'move' : 'grabbing'
    })
    // 画线模式：左键拾取地面点并实时预览；否则若重构面板打开且非「全域」，交给 recon 点选
    glc.addEventListener('click', function (e) {
      if (e.button !== 0) return
      var xy = localXY(e)
      if (reconDrawActive) {
        var g = groundAt(xy[0], xy[1], 0)
        if (g) { reconDrawPts.push([Math.round(g[0] * 10) / 10, Math.round(g[2] * 10) / 10]); updateDrawPreview() }
        return
      }
      // 面板点选：非 global 且面板打开
      var panel = document.getElementById('alignPanel')
      var reconApi = window.Map3DGLRecon
      if (panel && !panel.hidden && reconApi && reconApi.mode && reconApi.mode() !== 'global' && reconApi.pickAt) {
        e.preventDefault()
        reconApi.pickAt(xy)
        return
      }
      // 点击选中车辆作为跟随目标：命中任意一台车即选中并开启跟随
      if (cam && lastCars.length) {
        var hitSn = null, hitD = 28 * 28   // 命中半径约 28px
        for (var ci = 0; ci < lastCars.length; ci++) {
          var cc = lastCars[ci]
          var pj = S.projectPoint(cam, W, H, [cc.x, carHeightPx(), cc.z])
          if (!pj) continue
          var dxp = pj[0] - xy[0], dyp = pj[1] - xy[1]
          var dd = dxp * dxp + dyp * dyp
          if (dd < hitD) { hitD = dd; hitSn = cc.sn }
        }
        if (hitSn) {
          followSn = hitSn
          if (!opts.follow) { opts.follow = true; var fob = document.getElementById('m3Follow'); if (fob) fob.classList.add('on') }
          e.preventDefault()
          return
        }
      }
    })
    // 画线模式：双击结束
    glc.addEventListener('dblclick', function (e) {
      if (reconDrawActive) { e.preventDefault(); finishReconDraw(); return }
      resetView()
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      if (drag.pan) {
        // 增量跟手：在更新 pan 前先用「当前未变相机」对上一光标与当前光标各解一次地面点，
        // 二者之差即屏幕位移对应的地面世界位移，累加进 panX/panY。
        // （同一相机内取差 → 相机随 pan 平移的项互相抵消，无反馈回路，拖动手感不生抖）
        var xy = localXY(e)
        var gPrev = drag.lastXY ? groundAt(drag.lastXY[0], drag.lastXY[1], 0) : null
        var gCur = groundAt(xy[0], xy[1], 0)
        if (gPrev && gCur) {
          view.panX += gPrev[0] - gCur[0]
          view.panY += gPrev[2] - gCur[2]
          drag.lastXY = xy
        } else if (gCur) {
          // 首个可命中点：仅记录起点，本次不位移
          drag.lastXY = xy
        }
        // 光标处于 groundAt 打不到地面的区域（如顶部地平线）：保持上一有效位置，不出跳变
      } else {
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y
        view.az = drag.az - dx * 0.28
        view.el = Math.max(3, Math.min(88, drag.el + dy * 0.22))
        syncTiltSlider()
      }
      updateCamera(false)
    })
    window.addEventListener('mouseup', function () { if (drag) { drag = null; glc.style.cursor = 'grab' } })
    glc.addEventListener('wheel', function (e) {
      e.preventDefault()
      var xy = localXY(e)
      var g0 = groundAt(xy[0], xy[1], 0)
      // 缩放灵敏度：按滚轮 delta 比例、**每格变 7%**（12% 太快，5% 又太钝，取中间）。
      // 鼠标一格 deltaY≈100 → 一档；触控板小 delta → 每次更细小、连续滚动依然顺滑；
      // 大 delta（快速滚动）最多按一档算，避免一下跳到边界。
      var steps = Math.max(-1, Math.min(1, e.deltaY / 100))
      var f = Math.pow(1.07, steps)
      var nz = Math.min(ZOOM_MAX_OUT, Math.max(ZOOM_MIN_IN, view.zoom * f))
      if (nz === view.zoom) { updateCamera(false); return }
      view.zoom = nz
      updateCamera(false)
      // 以光标为中心：缩放后把光标下的地面点拉回原光标位置
      var g1 = groundAt(xy[0], xy[1], 0)
      if (g0 && g1) { view.panX += (g0[0] - g1[0]); view.panY += (g0[2] - g1[2]) }
      updateCamera(false)
    }, { passive: false })
    var touch = null
    glc.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        touch = { mode: 'rot', x: e.touches[0].clientX, y: e.touches[0].clientY, az: view.az, el: view.el }
      } else if (e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1]
        touch = { mode: 'pinch', d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: view.zoom }
      }
    }, { passive: true })
    glc.addEventListener('touchmove', function (e) {
      if (!touch) return
      e.preventDefault()
      if (touch.mode === 'rot' && e.touches.length === 1) {
        view.az = touch.az - (e.touches[0].clientX - touch.x) * 0.3
        view.el = Math.max(3, Math.min(88, touch.el + (e.touches[0].clientY - touch.y) * 0.24))
      } else if (touch.mode === 'pinch' && e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1]
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        var mxy = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2]
        var r = glc.getBoundingClientRect()
        mxy = [(mxy[0] - r.left) * (W / Math.max(1, r.width)), (mxy[1] - r.top) * (H / Math.max(1, r.height))]
        var pg0 = groundAt(mxy[0], mxy[1], 0)
        // 双指捏合加阻尼（指数 0.7）：与滚轮的"每格 5%"手感一致，避免轻轻一动就跳很远
        view.zoom = Math.min(ZOOM_MAX_OUT, Math.max(ZOOM_MIN_IN, touch.zoom * Math.pow(touch.d / Math.max(1, d), 0.7)))
        updateCamera(false)
        var pg1 = groundAt(mxy[0], mxy[1], 0)
        if (pg0 && pg1) { view.panX += (pg0[0] - pg1[0]); view.panY += (pg0[2] - pg1[2]) }
      }
      updateCamera(false)
    }, { passive: false })
    glc.addEventListener('touchend', function () { touch = null }, { passive: true })
  }

  function syncTiltSlider() {
    var t = document.getElementById('m3Tilt')
    if (t) t.value = String(Math.round(view.el))
  }
  function bindControls() {
    var tilt = document.getElementById('m3Tilt')
    if (tilt) {
      tilt.min = 3; tilt.max = 88
      tilt.addEventListener('input', function () { opts.el = Number(tilt.value); view.el = opts.el; updateCamera(false) })
    }
    var hgt = document.getElementById('m3Height')
    if (hgt) hgt.addEventListener('input', function () { opts.heightScale = Number(hgt.value) / 100; rebuild() })
    var m3car = document.getElementById('m3Car')
    if (m3car) m3car.addEventListener('input', function () { setCarScale(Number(m3car.value) / 10) })
    var lb = document.getElementById('m3Label')
    if (lb) lb.addEventListener('click', function () { opts.labels = !opts.labels; lb.classList.toggle('on', opts.labels); rebuild() })
    var pth = document.getElementById('m3Path')
    if (pth) pth.addEventListener('click', function () { opts.paths = !opts.paths; pth.classList.toggle('on', opts.paths); rebuild() })
    var rt = document.getElementById('m3Route')
    if (rt) rt.addEventListener('click', function () { opts.route = !opts.route; rt.classList.toggle('on', opts.route); rebuild() })
    var rd = document.getElementById('m3Road')
    if (rd) rd.addEventListener('click', function () { opts.roads = !opts.roads; rd.classList.toggle('on', opts.roads); rebuild() })
    var gr = document.getElementById('m3Ground')
    if (gr) gr.addEventListener('click', function () { opts.ground = !opts.ground; gr.classList.toggle('on', opts.ground) })
    var sp = document.getElementById('m3Spin')
    if (sp) sp.addEventListener('click', function () { opts.spin = !opts.spin; sp.classList.toggle('on', opts.spin) })
    var fo = document.getElementById('m3Follow')
    if (fo) fo.addEventListener('click', function () {
      opts.follow = !opts.follow
      if (!opts.follow) followSn = null
      fo.classList.toggle('on', opts.follow)
    })
    var fd = document.getElementById('m3Fade')
    if (fd) fd.addEventListener('click', function () { opts.roofFade = !opts.roofFade; fd.classList.toggle('on', opts.roofFade) })
    var rst = document.getElementById('mapReset')
    if (rst) { rst.hidden = false; rst.onclick = resetView }
    // 重构面板控制器已拆到独立文件 gl3d/recon.js（经 host/recon 桥，低耦合）
    var rec = window.Map3DGLRecon
    if (rec) rec.bindReconControls(document.getElementById('m3Align'), document.getElementById('alignPanel'))
  }

  /* ---------------- 3D 图层重构面板 → 已抽取到 gl3d/recon.js ---------------- */
  /* ---------------- 绘制 ---------------- */
  function bindAttr(prog, name, buf, size) {
    var loc = gl.getAttribLocation(prog, name)
    if (loc < 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
  }
  var _ident = null, _light = null, _now = 0
  function identF32() { if (!_ident) _ident = new Float32Array(S.mat4.identity()); return _ident }
  function lightF32() { if (!_light) _light = new Float32Array(S.LIGHT); return _light }

  function drawMesh(buf, model, alphaMul, flowAmp) {
    if (!buf) return
    var pr = progs.mesh, p = pr.p
    gl.useProgram(p)
    bindAttr(p, 'aPos', buf.pos, 3)
    bindAttr(p, 'aNrm', buf.nrm, 3)
    bindAttr(p, 'aCol', buf.col, 4)
    var auxLoc = gl.getAttribLocation(p, 'aAux')
    if (auxLoc >= 0) {
      if (buf.aux) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.aux)
        gl.enableVertexAttribArray(auxLoc)
        gl.vertexAttribPointer(auxLoc, 1, gl.FLOAT, false, 0, 0)
      } else {
        gl.disableVertexAttribArray(auxLoc)
        gl.vertexAttrib1f(auxLoc, 0)
      }
    }
    gl.uniformMatrix4fv(pr.u.uViewProj, false, cam.vpF32)
    gl.uniformMatrix4fv(pr.u.uModel, false, model ? new Float32Array(model) : identF32())
    gl.uniform3fv(pr.u.uLight, lightF32())
    gl.uniform1f(pr.u.uAmbient, S.AMBIENT)
    gl.uniform1f(pr.u.uDiffuse, S.DIFFUSE)
    gl.uniform1f(pr.u.uAlphaMul, alphaMul == null ? 1 : alphaMul)
    gl.uniform1f(pr.u.uTime, _now)
    gl.uniform1f(pr.u.uFlowAmp, flowAmp == null ? 0 : flowAmp)
    gl.uniform1f(pr.u.uFlowScale, flowScale)
    gl.drawArrays(gl.TRIANGLES, 0, buf.count)
  }
  var flowScale = 0
  // 雷达底图参数：uFade = 背景亮度阈值（真机底图实测：背景 41/255≈0.161，走廊 86/255≈0.337），
  // 低于阈值 → 透明（露出底板），高于阈值 → 显现为"有宽度的可通行区"。
  var GROUND_FADE = 0.165, GROUND_FADE_SOFT = 0.10, GROUND_OPACITY = 0.95
  function drawGround() {
    if (!groundReady || !bufs.ground) return
    var pr = progs.ground, p = pr.p
    gl.useProgram(p)
    bindAttr(p, 'aPos', bufs.ground.pos, 3)
    bindAttr(p, 'aUV', bufs.ground.uv, 2)
    gl.uniformMatrix4fv(pr.u.uViewProj, false, cam.vpF32)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, groundTex)
    gl.uniform1i(pr.u.uTex, 0)
    gl.uniform1f(pr.u.uFade, GROUND_FADE)
    gl.uniform1f(pr.u.uFadeSoft, GROUND_FADE_SOFT)
    gl.uniform1f(pr.u.uOpacity, GROUND_OPACITY)
    // 注意：地面 quad 的 4 个顶点是**环序**（左上→右上→右下→左下，见 scene3d.js 的 scene.ground.pos），
    // 因此必须用 TRIANGLE_FAN 扇形成两个三角形 {左上,右上,右下}+{左上,右下,左下}，完整铺满 quad。
    // 曾误用 TRIANGLE_STRIP：对环序顶点会切成 {左上,右上,右下}+{右上,右下,左下}，
    // 右半边重叠、左中三角形（面积 1/4）漏空 → 表现为"雷达图左侧缺一块斜 45° 的方形空白"。
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)
  }
  function drawGlass() {
    if (!bufs.glass || !bufs.glass.count) return
    var pr = progs.mesh, p = pr.p
    gl.useProgram(p)
    bindAttr(p, 'aPos', bufs.glass.pos, 3)
    bindAttr(p, 'aNrm', bufs.glass.nrm, 3)
    bindAttr(p, 'aCol', bufs.glass.col, 4)
    gl.uniformMatrix4fv(pr.u.uViewProj, false, cam.vpF32)
    gl.uniformMatrix4fv(pr.u.uModel, false, identF32())
    gl.uniform3fv(pr.u.uLight, lightF32())
    gl.uniform1f(pr.u.uAmbient, S.AMBIENT)
    gl.uniform1f(pr.u.uDiffuse, S.DIFFUSE)
    gl.depthMask(false)
    var c = cam.eye
    var order = scene.glassRanges.map(function (r, i) { return { i: i, d: Math.hypot(r.cx - c[0], r.cz - c[2]) } })
      .sort(function (a, b) { return b.d - a.d })
    for (var k = 0; k < order.length; k++) {
      var r = scene.glassRanges[order[k].i]
      gl.drawArrays(gl.TRIANGLES, r.start, r.count)
    }
    gl.depthMask(true)
  }

  /* ---------------- 数据 ---------------- */
  function update(map, d) {
    if (!started) ensure()
    if (d && d.robots) {
      var f = {}
      for (var i = 0; i < d.robots.length; i++) f[d.robots[i].device_sn] = d.robots[i]
      live.fleet = f
    }
    if (map) {
      live.bbox = map.bbox || null
      live.meta = map.meta || null          // 平台 ROS 元数据：世界坐标→地图像素的权威映射
      live.robots = map.robots || []
      live.routes = map.routes || []
      live.landmarks = map.landmarks || []
      buildSnapNet()
      ingestRobots(live.robots)
    } else {
      live.bbox = null; live.meta = null; live.robots = []; live.routes = []; live.landmarks = []
    }
    syncRouteMesh()
  }

  // 平台世界坐标(米) → 场景像素：① robotpose 原始像素(px/py，权威且无需换算)
  //   ② meta 权威映射 ③ bbox 拉伸兜底
  function robotToRadar(r) {
    // 权威坐标（激光/雷达帧），不做任何灰色层偏移 —— 车永远在真实地图帧上
    if (r.px != null && r.py != null && isFinite(num(r.px)) && isFinite(num(r.py))) return [num(r.px), num(r.py)]
    if (r.x == null || r.y == null) return null
    var conv = S.makePlatformToRadar(live.bbox, scene ? scene.radarW : 0, scene ? scene.radarH : 0, live.meta)
    var p = conv ? conv(num(r.x), num(r.y)) : null
    return p || null
  }

  /* ---------------- 路网吸附（对应"雷达图有路宽 / 3D 图只有中心线"） ----------------
   * 平台的「固定路径」图（graph）= 机器人实际可行驶的路网；用 meta 精确投到场景像素后作为
   * **不可见**的吸附网：把车辆真实位置投影到最近的路段上再显示 —— 等价于导航 App 的"贴路"。
   * 好处：即便标定/定位有 1~3m 残余误差，车也永远落在它真正走的那条路上。
   * 吸附上限 SNAP_MAX_M：偏离路网太远（定位异常）时不硬拉，照原样显示，避免"车飞出路面又被拽回"。 */
  var SNAP_MAX_M = 12
  // 「瞬移落位」阈值（米）：车辆目标点与当前位置差超过它，说明不是真实位移（如后台切回来、
  // 机器人重启、定位跳变），直接落位而不是平滑追赶。正常行驶约 2.3m/秒（ROBOT_POLL_MS=1000），
  // 取 12m 远高于真实位移，不会误判。
  var TELEPORT_M = 12
  // 吸附网内容指纹 + 版本号：版本只在"吸附源真的变了"（重构/标定变更）时递增，
  // 车辆据此把"换映射导致的整体位移"处理成原地重新入场，而不是飘过去。
  var snapNetSig = ''
  var snapRevision = 0
  // 车辆入场动画时长（秒）：原地"生长"，替代从旧位置飘移进场
  var APPEAR_SEC = 0.45
  // 标注分层（view.zoom 越小＝越放大；「回到校园」= zoom 1.00）：
  //   T1 楼栋名（含食堂/餐厅/铺子，**同一层级同样式**）：zoom ∈ (0.50, 1.25)
  //        —— 缩到最小(≥1.25)才消失；放大到 T3(取货点名)出现时隐藏（同一位置由 T3 接手）
  //   T2 充电点/上货点名：zoom ≤ 1.00 —— 「回到校园」大小刚好显示，再缩小就不显示
  //   T3 取货点名：zoom ≤ 0.50 —— 放大到「回到校园」的一半时显示
  var TIER_T3_ZOOM = 0.50, TIER_T2_ZOOM = 1.00, TIER_T1_HIDE_OUT = 1.25
  // 各层字号基准（zoom=1 时的像素）：楼栋 12 / 第二层 10 / 第三层 9
  var LABEL_BASE_PX = { 1: 12, 2: 10, 3: 9 }
  // 站点图标基准半径（zoom=1），第二层 4.4 / 第三层 3.6（比原来 5.4 小）
  var SITE_HEAD_BASE = { 2: 4.4, 3: 3.6 }
  var snapNet = null
  function buildSnapNet() {
    snapNet = null
    var segs = []
    // 首选吸附源 = **3D 建模线道路 effectiveCalib().roads**（灰色 OSM 中心线折线，无宽度）；
    // 用户用标定面板把它校准到"雷达道路中间"后，这里就实时跟随校准结果。
    // 小车真实位置（雷达像素 px/py）投影到这些中心线段上 = "贴到 3D 建模线道路"，同时保留 SNAP_MAX 限距。
    // 不再使用平台「固定路径」作为吸附源（它只是贴路边、碰起点才走的优先级片段，会吸偏造成错位）。
    var ce = effectiveCalib()
    if (ce && Array.isArray(ce.roads)) {
      for (var r = 0; r < ce.roads.length; r++) {
        var rp = (ce.roads[r] && ce.roads[r].pts) || []
        if (rp.length < 2) continue
        for (var i = 0; i < rp.length - 1; i++) {
          var pa = rp[i], pb = rp[i + 1]
          if (pa && pb && isFinite(pa[0]) && isFinite(pb[0])) segs.push([pa, pb])
        }
      }
    }
    // 兜底：静态"测绘白线"（calib.paths，已在校准像素里；仅在没有建模道路时用于贴线）
    if (!segs.length && calib && Array.isArray(calib.paths)) {
      for (var h = 0; h < calib.paths.length; h++) {
        var hp = calib.paths[h]
        if (!hp || !hp.pts || hp.pts.length < 2) continue
        for (var i = 0; i < hp.pts.length - 1; i++) {
          var pa = hp.pts[i], pb = hp.pts[i + 1]
          if (pa && pb && isFinite(pa[0]) && isFinite(pb[0])) segs.push([pa, pb])
        }
      }
    }
    snapNet = segs.length ? segs : null
    // 只有吸附网**内容真的变了**（重构/标定变更）才递增版本号：地图轮询每 5s 也会重建一次，
    // 若每次都递增，会让车每 5s 无谓地"重新落位"一次。
    var sig = netSig(snapNet)
    if (sig !== snapNetSig) { snapNetSig = sig; snapRevision++ }
  }
  // 吸附网指纹：用来判断重建后内容是否真的变了（不比较全部线段，取头尾几段足够）
  function netSig(segs) {
    if (!segs || !segs.length) return 'none'
    var n = segs.length, out = n + '|'
    var k = Math.min(6, n)
    for (var i = 0; i < k; i++) out += Math.round(segs[i][0][0]) + ',' + Math.round(segs[i][0][1]) + ';'
    var last = segs[n - 1]
    out += Math.round(last[1][0]) + ',' + Math.round(last[1][1])
    return out
  }
  // 投影到最近路段；返回 {x,y,off}。off = 偏离路网的米数（0 表示就在路上）
  function snapToNet(px, py) {
    if (!snapNet) return { x: px, y: py, off: 0, snapped: false }
    var best = null, bd = Infinity
    for (var i = 0; i < snapNet.length; i++) {
      var a = snapNet[i][0], b = snapNet[i][1]
      var vx = b[0] - a[0], vy = b[1] - a[1]
      var L2 = vx * vx + vy * vy
      var t = L2 > 1e-9 ? ((px - a[0]) * vx + (py - a[1]) * vy) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      var qx = a[0] + vx * t, qy = a[1] + vy * t
      var d = (px - qx) * (px - qx) + (py - qy) * (py - qy)
      if (d < bd) { bd = d; best = [qx, qy] }
    }
    if (!best) return { x: px, y: py, off: 0, snapped: false }
    var offM = Math.sqrt(bd) * (scene ? 1 / scene.pxPerM : 0.05)
    if (offM > SNAP_MAX_M) return { x: px, y: py, off: offM, snapped: false }
    return { x: best[0], y: best[1], off: offM, snapped: true }
  }

  // 把一批机器人并进 robotAnim（目标点已是**场景像素**，每帧向目标插值 → 看起来是连续移动）
  function ingestRobots(list) {
    var seen = {}
    for (var j = 0; j < (list || []).length; j++) {
      var r = list[j]
      if (!r || !r.device_sn) continue
      var rp = robotToRadar(r)
      if (!rp || !isFinite(rp[0]) || !isFinite(rp[1])) continue
      var sn = r.device_sn
      seen[sn] = 1
      var sp = snapToNet(rp[0], rp[1])      // 吸附到机器人真实路网（该图层不显示，仅用于贴路）
      var a = robotAnim[sn]
      if (a) {
        var pxm = scene ? scene.pxPerM : 19.45
        var jumpPx = Math.hypot(sp.x - a.x, sp.y - a.y)
        // 两种"重新落位"：① 吸附网内容变了（重构/标定刚生效 → 打开网页时最常见）
        //                ② 单次跳变远超正常位移（后台切回、重启等）
        var netChanged = (a.snapRev !== snapRevision)
        if (netChanged || jumpPx > TELEPORT_M * pxm) {
          a.x = sp.x; a.y = sp.y; a.th = num(r.theta)
          a.trail = []                       // 别从旧位置拉出一条横穿地图的直线
          a.lastPush = 0
          // 位置不是"飘"过去，而是**原地重新生长**一次（隐藏这次换位，观感上像重新入场）
          if (jumpPx > 0.5 * pxm) a.bornAt = null
        }
        a.snapRev = snapRevision
        a.tx = sp.x; a.ty = sp.y; a.tt = num(r.theta); a.on = true
        a.raw = rp; a.off = sp.off; a.snapped = sp.snapped
        if (r.text) a.text = r.text
      } else {
        // 首次出现：直接落位（不从别处飘过来），bornAt=null 交给渲染帧开始"原地生长"入场
        robotAnim[sn] = {
          x: sp.x, y: sp.y, th: num(r.theta),
          tx: sp.x, ty: sp.y, tt: num(r.theta), on: true, text: r.text || '',
          raw: rp, off: sp.off, snapped: sp.snapped, snapRev: snapRevision,
          trail: [], lastPush: 0, bornAt: null
        }
      }
    }
    for (var kk in robotAnim) {
      if (!seen[kk]) {
        robotAnim[kk].on = false
        robotAnim[kk].trail = []    // 离线即清空拖尾，避免重新上线时拉出一条直线
      }
    }
  }

  // 高频轮询入口：只更新车辆位置（不动配准/路线/点位）。
  // 大屏用 /api/dashboard/robot-positions 每 ~1s 调一次，车就能"实时走"。
  function setRobots(list) {
    if (!started) ensure()
    live.robots = list || []
    ingestRobots(live.robots)
    // 车只在「楼层/建筑」同一个场地里显示；不在同一 building 的先不画
    return live.robots.length
  }

  // 路线网格：演示档用骨架主路线；真实档用平台下发的途经点（做重采样+平滑后成带）
  function syncRouteMesh() {
    if (!calib || !scene) return
    if (!opts.route) {           // 「路线」关掉时不构建、不显示
      if (routeKey !== '') { routeKey = ''; dropMesh(bufs.route); bufs.route = null }
      return
    }
    var key, paths
    if (live.bbox && live.routes && live.routes.length) {
      var p2r = S.makePlatformToRadar(live.bbox, scene.radarW, scene.radarH, live.meta)
      if (!p2r) return
      var polys = []
      for (var i = 0; i < live.routes.length; i++) {
        var stops = (live.routes[i] && live.routes[i].stops) || []
        if (stops.length < 2) continue
        var pts = []
        for (var s = 0; s < stops.length; s++) {
          var rp = p2r(stops[s].x, stops[s].y)
          pts.push([rp[0], rp[1]])
        }
        if (pts.length >= 2) polys.push({ pts: snapToRoads(pts) })
      }
      if (!polys.length) return
      paths = polys
      key = 'live:' + polys.length + ':' + polys[0].pts.length + ':' + Math.round(polys[0].pts[0][0]) + ',' + Math.round(polys[0].pts[0][1])
    } else {
      paths = S.demoRoutePaths(calib)
      key = 'demo'
    }
    if (key === routeKey) return
    routeKey = key
    dropMesh(bufs.route)
    routeMeshData = S.buildRouteMesh(paths, scene.pxPerM)
    bufs.route = uploadMesh(routeMeshData)
  }

  // 途经点 → 贴路折线（方案A + 方案B 一起用）
  //   ① 先用道路拓扑图在途经点之间走最短路 → 结果天然落在灰色道路中线上
  //   ② 图不连通/吸附失败时退回"投影吸附"：把每个点压到最近的校园道路中线上
  //   ③ 最后道格拉斯-普克抽稀：直线段只留两端、拐弯保留拐点（不做曲线平滑）
  function snapToRoads(pts) {
    var tol = 0.25 * scene.pxPerM
    if (roadNet) {
      var routed = S.routeOnRoads(roadNet, pts)
      if (routed && routed.length >= 2) return S.simplifyPath(routed, tol)
    }
    var out = []
    for (var i = 0; i < pts.length; i++) out.push(projectOnRoads(pts[i]))
    return S.simplifyPath(out, tol)
  }
  // 把一个点投影到最近的道路中线上（用有效灰色道路：跟随重构后的位置）
  function projectOnRoads(p) {
    var roads = effectiveCalib().roads || []
    var best = null, bd = Infinity
    for (var i = 0; i < roads.length; i++) {
      var q = roads[i].pts || []
      for (var k = 0; k + 1 < q.length; k++) {
        var a = q[k], b = q[k + 1]
        var vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy
        var t = L2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2 : 0
        t = Math.max(0, Math.min(1, t))
        var x = a[0] + vx * t, y = a[1] + vy * t
        var d = Math.hypot(p[0] - x, p[1] - y)
        if (d < bd) { bd = d; best = [x, y] }
      }
    }
    return best || [p[0], p[1]]
  }
  // 保留给旧调用（现在改用 snapToRoads）
  function smoothPolyline(pts, step) {
    if (pts.length < 3) return pts
    var out = [pts[0]], acc = 0
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1]
      var L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L < 1e-9) continue
      var t = 0
      while (acc + (L - t) >= step) {
        t += step - acc
        var k = t / L
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k])
        acc = 0
      }
      acc += L - t
    }
    out.push(pts[pts.length - 1])
    for (var p = 0; p < 2; p++) {
      for (var j = 1; j < out.length - 1; j++) {
        out[j] = [(out[j - 1][0] + 2 * out[j][0] + out[j + 1][0]) / 4,
          (out[j - 1][1] + 2 * out[j][1] + out[j + 1][1]) / 4]
      }
    }
    return out
  }

  function initDemo() {
    // 演示车沿"演示路线"跑（该路线取自雷达骨架，真在走廊上）
    var paths = S.demoRoutePaths(calib)
    var pts = (paths[0] && paths[0].pts) || []
    if (pts.length < 2) return null
    var segs = [], total = 0
    for (var j = 0; j < pts.length - 1; j++) {
      var L = Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1])
      segs.push({ a: pts[j], b: pts[j + 1], L: L, acc: total })
      total += L
    }
    if (!(total > 1)) return null
    var cars = []
    for (var i = 0; i < 3; i++) {
      cars.push({ segs: segs, total: total, off: total * (0.08 + 0.3 * i), sp: total * 0.01, sn: '演示车 0' + (i + 1), trail: [], lastPush: 0 })
    }
    return cars
  }
  function demoPos(t) {
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
            x: s.a[0] + (s.b[0] - s.a[0]) * k, z: s.a[1] + (s.b[1] - s.a[1]) * k,
            th: Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]), sn: c.sn, demo: true,
            anim: c        // 让演示车也走同一套拖尾采样
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
    if (!gl || !ready || !scene) return
    if (!W || !H) { resize(); return }       // 首次布局尚未确定尺寸：重试
    var t = (ts || 0) / 1000
    var dt = Math.min(0.1, t - lastT); lastT = t
    _now = t
    if (opts.spin) { view.az += dt * 6; updateCamera(false) }

    // 车辆世界坐标（先算，跟随模式要用）
    // 插值系数按 dt 归一化：原来是"每帧固定 0.12"，在两次定位（1s 一次）之间会先猛追一下、
    // 再停住不动，看起来一卡一卡；改成 1-exp(-dt·2.6)（时间常数 ≈0.38s）后车辆全程匀速滑行。
    var cars = [], anyLive = false
    var kSmooth = 1 - Math.exp(-dt * 2.6)
    for (var k in robotAnim) {
      var a = robotAnim[k]
      if (!a.on) continue
      anyLive = true
      a.x += (a.tx - a.x) * kSmooth; a.y += (a.ty - a.y) * kSmooth
      var da = a.tt - a.th
      while (da > Math.PI) da -= 6.2832
      while (da < -Math.PI) da += 6.2832
      a.th += da * Math.min(1, kSmooth * 1.8)
      // 入场进度：首次出现后 0.45s 内从 0「原地生长」到 1（smoothstep），不产生位移
      if (a.bornAt == null) a.bornAt = t
      var ap = (t - a.bornAt) / APPEAR_SEC
      if (ap > 1) ap = 1
      else if (ap < 0) ap = 0
      ap = ap * ap * (3 - 2 * ap)
      cars.push({ x: a.x, z: a.y, th: a.th, sn: a.sn || k, live: true, text: a.text, anim: a, snapped: a.snapped, appear: ap })
    }
    // 说明：robotAnim 里的坐标在 ingestRobots 阶段就已换算成**场景像素**
    //（robotpose 原始像素优先 / meta 权威映射次之），这里不再做任何坐标变换。
    // 轨迹拖尾采样（真实车与演示车都走这套）：每 ~0.18s 记一个点、位移超过 0.35m 才记（停车不堆点）。
    // 裁剪按**时间窗**（最近 TRAIL_SEC 秒）而不是只按点数：定位是「1s 一跳」的离散更新，
    // 在帧率高/虚拟时间加速时按点数裁剪会把拖尾拉成几十米的长线；按时间裁剪则任何帧率下长度一致。
    var TRAIL_SEC = 6
    // 拖尾采样点取**车尾**（不是车中心）：车中心沿航向后退到后保险杠位置，
    // 这样拖尾是从车屁股甩出来的，而不是从车身中间冒出来。
    var tailPx = carTailPx()
    for (var cj = 0; cj < cars.length; cj++) {
      var cc = cars[cj]
      if (!cc.anim) continue
      var tr = cc.anim.trail || (cc.anim.trail = [])
      var tailX = cc.x - Math.cos(cc.th) * tailPx
      var tailZ = cc.z - Math.sin(cc.th) * tailPx
      if (!cc.anim.lastPush || t - cc.anim.lastPush > 0.18) {
        cc.anim.lastPush = t
        var last = tr.length ? tr[tr.length - 1] : null
        if (!last || Math.hypot(tailX - last[0], tailZ - last[1]) > 0.35 * scene.pxPerM) {
          tr.push([tailX, tailZ, t])
          while (tr.length > 2 && t - tr[0][2] > TRAIL_SEC) tr.shift()
          if (tr.length > 120) tr.shift()
        }
      } else {
        while (tr.length > 2 && t - tr[0][2] > TRAIL_SEC) tr.shift()
      }
    }
    if (!anyLive) {
      // 没有真实车辆：默认一台车都不画（用户要求）；opts.demoCars 打开时才跑演示车
      if (opts.demoCars) { if (!demo) demo = initDemo(); cars = demoPos(t) }
      else cars = []
    }
    lastCars = cars
    // 拖尾 3D 地面带（每帧重建 → 复用 buffer）。车辆拖尾在下方，车体遮挡它。
    var tm = buildTrailMesh(cars)
    if (tm) { tm.aux = null; trailBuf = uploadMeshInto(trailBuf, tm) }   // 拖尾不需要 aux（省一次上传）
    else if (trailBuf) trailBuf.count = 0      // 没有拖尾就画 0 个顶点（保留 buffer 继续复用）

    // 跟随：把视图中心平滑移到跟随目标车（点地图选中；未选中退回首台）
    if (opts.follow && cars.length) {
      var tgtCar = null
      for (var fi = 0; fi < cars.length; fi++) {
        if (followSn && cars[fi].sn === followSn) { tgtCar = cars[fi]; break }
      }
      if (!tgtCar) tgtCar = cars[0]
      if (tgtCar) {
        var cx = scene.bounds.center[0] + view.panX, cz = scene.bounds.center[2] + view.panY
        view.panX += (tgtCar.x - cx) * 0.06
        view.panY += (tgtCar.z - cz) * 0.06
        updateCamera(false)
      }
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    drawMesh(bufs.opaque, null)
    if (opts.ground) drawGround()

    // 屋顶默认**实心可见**（楼必须看得见）；只有打开「楼体透明」时才随俯角淡出，
    // 用于临时看清被楼压住的道路。淡出时关闭 depthMask，让楼后的车也能透出来。
    var roofAlpha = 1
    if (opts.roofFade) {
      var t2 = Math.max(0, Math.min(1, (view.el - 45) / 35))
      roofAlpha = 1 - 0.66 * t2
    }
    gl.depthMask(roofAlpha > 0.985)
    drawMesh(bufs.roofs, null, roofAlpha)
    gl.depthMask(true)

    drawGlass()

    // 路线：**正常参与深度测试**（所以它永远贴在地面道路上，不会压在楼上）。
    // 流光（按弧长在着色器里算）默认关闭 —— opts.routeFlow 打开才有动态效果。
    if (bufs.route) {
      gl.depthMask(true)
      drawMesh(bufs.route, null, 1, opts.routeFlow ? 1 : 0)
    }
    // 新增道路画线预览（绿色，最上层便于看清）
    if (bufs.drawPrev) { gl.depthMask(true); drawMesh(bufs.drawPrev, null, 1, 0) }

    // 车辆拖尾：3D 地面带，**在画车之前**绘制并写深度 → 车体会正确遮挡它（拖尾在车下方）
    if (trailBuf) { gl.depthMask(true); drawMesh(trailBuf, null) }

    for (var m = 0; m < cars.length; m++) {
      var c = cars[m]
      var mtx = S.carMatrix(c.x, c.z, c.th, 0)
      // 入场：原地按比例长大（绕车自身原点），配合叠层淡入，避免"飘移"入场
      if (c.appear != null && c.appear < 1) mtx = S.mat4.mul(mtx, S.mat4.scale(c.appear, c.appear, c.appear))
      gl.depthMask(false)
      drawMesh(bufs.ring, mtx)
      drawMesh(bufs.beam, mtx)
      gl.depthMask(true)
      drawMesh(bufs.car, mtx)
    }
    drawOverlay(t, cars)
  }

  /* ---------------- 2D 叠加层：全息标签 / 橙色路线 / 车辆数据 ---------------- */
  function drawOverlay(t, cars) {
    if (!ov) return
    var g = ov
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ovc.width, ovc.height)
    g.setTransform(DPR, 0, 0, DPR, 0, 0)

    // 路线不再画在叠加层：3D 里那条带子参与深度测试，所以才"贴合地面道路"。
    // 叠加层只负责：车辆定位标记、数据牌、楼栋标签、被偏移楼栋的真实位置提示。

    // ---- 车辆：轨迹拖尾 + 定位光环 + 光柱 + 数据牌（叠加层，保证"永远看得见车在哪"）----
    g.textBaseline = 'middle'
    for (var ci = 0; ci < cars.length; ci++) {
      var c = cars[ci]
      // 入场淡入：与 3D 车体的"原地生长"同步，避免车还没长出来、叠层标记先蹦出来
      var cap = (c.appear == null ? 1 : c.appear)
      g.globalAlpha = cap
      drawCarMarker(g, c)
      if (cap <= 0.999) { g.globalAlpha = 1; continue }   // 未长成前先不画数据牌
      var top = S.projectPoint(cam, W, H, [c.x, carMesh.height + 1.6 * scene.pxPerM, c.z])
      if (!top) { g.globalAlpha = 1; continue }
      var info = live.fleet[c.sn]
      var lines = []
      if (c.demo) lines.push('演示车 · 配送中')
      else if (info) {
        lines.push((info.machine_text || info.machine_status || '在线') + (c.snapped ? ' · 已贴路' : ''))
        if (info.battery != null) lines.push('电量 ' + info.battery + '%')
      } else lines.push('无人车' + (c.snapped ? ' · 已贴路' : ''))
      drawPlate(g, top[0], top[1] - 26, lines, '#7ff0ff')
      g.globalAlpha = 1
    }

    // ---- 被"视图偏移"的楼：用虚线 + 小圆圈标出真实位置 ----
    // 注意：**不再画那串黄字**（"真实位置 · 视图已偏移 Xm"）。用户明确要求
    // 东苑12栋 / 东苑13栋 / 第三学生食堂 不要显示这串文字（这三栋就是全部被偏移的楼），
    // 所以这里直接去掉文本，只留中性的虚线 + 圆圈做"真实位置"点位提示。
    if (scene.moved && scene.moved.length && opts.labels) {
      g.save()
      g.setLineDash([4, 4])
      g.strokeStyle = 'rgba(140,200,220,0.55)'
      g.lineWidth = 1.2
      for (var mi = 0; mi < scene.moved.length; mi++) {
        var mv = scene.moved[mi]
        var a = S.projectPoint(cam, W, H, [mv.true_center[0], 2, mv.true_center[1]])
        var b = S.projectPoint(cam, W, H, [mv.shown_center[0], 2, mv.shown_center[1]])
        if (!a || !b) continue
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke()
        g.beginPath(); g.arc(a[0], a[1], 4, 0, 6.2832); g.stroke()
      }
      g.restore()
    }

    // ---- 编辑选中高亮：重构面板里被点选的道路/楼栋（金色描边）----
    // data: {kind,key,name,subtype}；按 key 在当前有效数据里重新定位并描边，保证跟随偏移。
    if (editedSel && editedSel.kind && scene) {
      var HL = '#ffd53d'                       // 金色，与 2.5D 重构面板亮色一致
      g.save()
      g.lineCap = 'round'; g.lineJoin = 'round'
      if (editedSel.kind === 'road') {
        var hlPts = null
        if (editedSel.subtype === 'add') {
          var ari = Number(String(editedSel.key).split(':')[1])
          var ar = (RECON.addRoads || [])[ari]
          if (ar) hlPts = perObjPts(ar.pts.map(function (p) { return [num(p[0]), num(p[1])] }), ar)
        } else {
          var hri = Number(String(editedSel.key).replace(/^\#/, ''))
          var hr = (calib.roads || [])[hri]
          if (hr) {
            var offR = (RECON.road && (RECON.road[editedSel.key] || RECON.road[hr.name])) || { dx: 0, dy: 0 }
            hlPts = perObjPts(hr.pts.map(function (p) { return greyGlobalPx(p[0], p[1]) }), offR)
          }
        }
        if (hlPts && hlPts.length > 1) {
          for (var hi = 0; hi < hlPts.length - 1; hi++) {
            var hA = S.projectPoint(cam, W, H, [hlPts[hi][0], 1.6, hlPts[hi][1]])
            var hB = S.projectPoint(cam, W, H, [hlPts[hi + 1][0], 1.6, hlPts[hi + 1][1]])
            if (!hA || !hB) continue
            g.strokeStyle = HL; g.lineWidth = 5; g.globalAlpha = 0.35
            g.beginPath(); g.moveTo(hA[0], hA[1]); g.lineTo(hB[0], hB[1]); g.stroke()
            g.strokeStyle = '#ffefb0'; g.lineWidth = 2; g.globalAlpha = 1
            g.beginPath(); g.moveTo(hA[0], hA[1]); g.lineTo(hB[0], hB[1]); g.stroke()
          }
        }
      } else {  // bld：描亮矩形框（沿 ring）
        var hlRing = null
        if (editedSel.subtype === 'add') {
          var abi = Number(String(editedSel.key).split(':')[1])
          var ab = (RECON.addBlds || [])[abi]
          if (ab) hlRing = perObjPts(ab.ring.map(function (p) { return [num(p[0]), num(p[1])] }), ab)
        } else {
          var hbi = Number(String(editedSel.key).replace(/^\#/, ''))
          var hb = (calib.buildings || [])[hbi]
          if (hb) {
            var offB = (RECON.bld && (RECON.bld[editedSel.key] || RECON.bld[hb.name])) || { dx: 0, dy: 0 }
            hlRing = perObjPts(hb.ring.map(function (p) { return greyGlobalPx(p[0], p[1]) }), offB)
          }
        }
        if (hlRing && hlRing.length > 2) {
          for (var hj = 0; hj < hlRing.length; hj++) {
            var a0 = S.projectPoint(cam, W, H, [hlRing[hj][0], 3.0, hlRing[hj][1]])
            var a1 = S.projectPoint(cam, W, H, [hlRing[(hj + 1) % hlRing.length][0], 3.0, hlRing[(hj + 1) % hlRing.length][1]])
            if (!a0 || !a1) continue
            g.strokeStyle = HL; g.lineWidth = 5; g.globalAlpha = 0.35
            g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.stroke()
            g.strokeStyle = '#ffefb0'; g.lineWidth = 2; g.globalAlpha = 1
            g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.stroke()
          }
        }
      }
      g.restore()
    }

    // ---- 点位标记（取货点/上货点/充电点）：来自平台 landmarks，世界坐标→场景雷达像素 ----
    // 与 2.5D 回退版（map3d-core.js）同色系：取货点绿 / 上货点橙 / 充电点黄；
    // 图标是"定位针"；文字统一收集到 siteLabels，最后和楼名一起做避让排布。
    var siteLabels = []
    var seenLm = {}                   // 兜底去重：同名 + 同雷达坐标只画一个 pin / 收集一次文字
    if (live.bbox && live.meta && live.landmarks && live.landmarks.length) {
      var lmP2r = S.makePlatformToRadar(live.bbox, scene.radarW, scene.radarH, live.meta)
      if (lmP2r) {
        for (var L0 = 0; L0 < live.landmarks.length; L0++) {
          var LM = live.landmarks[L0]
          if (!LM || !isFinite(num(LM.x)) || !isFinite(num(LM.y))) continue
          var nm3 = String(LM.name || '').replace(/\s+/g, '')
          if (/固定路径|排队/.test(nm3)) continue          // 路网/排队点不是站点
          var pt3 = lmP2r(LM.x, LM.y)
          if (!pt3 || !isFinite(pt3[0]) || !isFinite(pt3[1])) continue
          var lmKey = nm3 + '|' + Math.round(pt3[0] * 10) + '|' + Math.round(pt3[1] * 10)
          if (seenLm[lmKey]) continue                     // 同一点重复上报：只画一次
          seenLm[lmKey] = 1
          // 分层：充电点/上货点 = 第二层（小图标+小字）；取货点 = 第三层（更小）
          var isCharge = String(LM.type || '') === 'chargePoint' || /充电/.test(nm3)
          var isLoad = String(LM.type || '') === 'loadingPoint' || /上货/.test(nm3)
          var tier = (isCharge || isLoad) ? 2 : 3
          // 颜色：充电点=绿、上货点=黄、取货点=绿（沿用原色）
          var col3 = isCharge ? '#2fd45c' : (isLoad ? '#ffd24a' : '#2fd45c')
          // 图标与文字一起随视角缩放：view.zoom 越小＝越放大 → 图形越大
          var kz = 1 / Math.max(0.01, view.zoom)
          // 站点图标：经典"定位针"（下收敛三角 + 圆头 + 中心小孔），底尖落在真实点位上。
          var scb3 = S.projectPoint(cam, W, H, [pt3[0], 0.4, pt3[1]])
          if (!scb3) continue
          var tipX = scb3[0], tipY = scb3[1]
          var headR = (SITE_HEAD_BASE[tier] || 4) * kz
          var headY = tipY - headR * 2.6
          g.save()
          // 地面落点：淡色描边小圆环（只示意位置，不做实心球）
          g.strokeStyle = col3
          g.globalAlpha = 0.5
          g.lineWidth = Math.max(0.8, 1.4 * kz)
          g.beginPath(); g.arc(tipX, tipY, headR * 0.63, 0, 6.2832); g.stroke()
          g.globalAlpha = 1
          // 针身 + 圆头
          g.fillStyle = col3
          g.shadowColor = col3; g.shadowBlur = 8 * kz
          g.beginPath()
          g.moveTo(tipX, tipY)
          g.lineTo(tipX - headR * 0.72, headY + headR * 0.5)
          g.lineTo(tipX + headR * 0.72, headY + headR * 0.5)
          g.closePath(); g.fill()
          g.beginPath(); g.arc(tipX, headY, headR, 0, 6.2832); g.fill()
          g.shadowBlur = 0
          // 中心小孔（深色），让图标更像"站点"而不是实心球
          g.fillStyle = 'rgba(6,20,34,0.9)'
          g.beginPath(); g.arc(tipX, headY, headR * 0.4, 0, 6.2832); g.fill()
          // 名称标签：按**本层自己的缩放区间**决定是否显示（图标始终画，便于定位）
          var tierShown = (tier === 2) ? (view.zoom <= TIER_T2_ZOOM) : (view.zoom <= TIER_T3_ZOOM)
          if (opts.labels && nm3 && tierShown) {
            siteLabels.push({
              text: nm3, x: tipX + headR + 4, y: headY + 4, kind: 'site', color: col3,
              pr: tier, tier: tier, wx: pt3[0], wy: 0.4, wz: pt3[1]
            })
          }
          g.restore()
        }
      }
    }

    if (!opts.labels) return
    // ---- 第一层：楼栋名（宿舍楼 / 食堂 / 餐厅 / 铺子 **同层级、同样式**）----
    // 缩放区间：(0.50, 1.25) —— 缩到最小(≥1.25)才消失；放大到 T3(取货点名)出现时隐藏。
    var showT1 = (view.zoom > TIER_T3_ZOOM && view.zoom < TIER_T1_HIDE_OUT)
    var blds = calib.buildings || []
    var items = []
    if (showT1) {
      for (var b = 0; b < blds.length; b++) {
        var bd = blds[b]
        if (bd.no_label === true) continue          // 标定里标记为"只渲染体块、不画名字"的楼
        var hpx = num(bd.height_m) * scene.pxPerM * opts.heightScale + 4.5 * scene.pxPerM
        var tip = S.projectPoint(cam, W, H, [bd.center[0], hpx, bd.center[1]])
        if (!tip) continue
        // 楼名只出文字，不画立体图标
        items.push({ text: bd.name, x: tip[0] + 2, y: tip[1] - 4, kind: 'bld', color: '#9ef2ff', pr: 1, wx: bd.center[0], wy: hpx, wz: bd.center[1] })
      }
    }
    // 站点文字并入同一批（第二/三层已在收集时按各自缩放区间过滤过）
    for (var sl = 0; sl < siteLabels.length; sl++) items.push(siteLabels[sl])

    // ---- 统一绘制：**不挪位、不隐藏**（重叠只靠"变淡"，文字不消失）----
    //   · 远的先画、近的后画 → 近处的名字自然压住远处的名字；
    //   · 初始完全不透明(alpha=1)，越远越透明（被遮在后面的越淡），最近 1.00 → 最远 0.45；
    //   · 同深度时按层级：楼栋(1)最后画、压在上层，然后第二层、第三层。
    //   · 字号随视角缩放：font = 基准 / view.zoom（视角放大文字同步放大、缩小同步缩小）。
    var eye = cam.eye
    items.forEach(function (it) { it.d = Math.hypot(eye[0] - it.wx, eye[1] - it.wy, eye[2] - it.wz) })
    items.sort(function (a, b) { return (b.d - a.d) || (b.pr - a.pr) })
    var dMin = Infinity, dMax = -Infinity
    items.forEach(function (it) { if (it.d < dMin) dMin = it.d; if (it.d > dMax) dMax = it.d })
    var dSpan = Math.max(1e-6, dMax - dMin)
    var kzText = 1 / Math.max(0.01, view.zoom)
    for (var k2 = 0; k2 < items.length; k2++) {
      var it = items[k2]
      var tFar = (it.d - dMin) / dSpan                 // 0=最近 1=最远
      var alpha = 1.00 - 0.55 * tFar                   // 1.00（完全不透明）→ 0.45
      var bold = (it.kind === 'bld')
      var base = bold ? LABEL_BASE_PX[1] : (it.pr === 2 ? LABEL_BASE_PX[2] : LABEL_BASE_PX[3])
      g.globalAlpha = alpha
      g.font = (bold ? 'bold ' : '') + (base * kzText).toFixed(1) + 'px "Microsoft YaHei",sans-serif'
      g.lineWidth = Math.max(2, 3 * kzText)
      g.strokeStyle = 'rgba(6,18,32,0.85)'
      g.strokeText(it.text, it.x, it.y)
      g.fillStyle = it.color || '#9ef2ff'
      g.fillText(it.text, it.x, it.y)
      g.globalAlpha = 1
    }
  }
  function strokePath(g, pts) {
    g.beginPath()
    g.moveTo(pts[0][0], pts[0][1])
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
    g.stroke()
  }
  // 叠加层用的路线折线（雷达像素）：真实档取平台路线，演示档取骨架主路线
  var _routeCache = null
  function routePolylines() {
    if (live.bbox && live.routes && live.routes.length) {
      var p2r = S.makePlatformToRadar(live.bbox, scene.radarW, scene.radarH, live.meta)
      if (!p2r) return []
      var out = [], cacheKey = 'live' + live.routes.length
      if (_routeCache && _routeCache.key === cacheKey) return _routeCache.data
      for (var i = 0; i < live.routes.length; i++) {
        var stops = (live.routes[i] && live.routes[i].stops) || []
        if (stops.length < 2) continue
        var poly = []
        for (var s = 0; s < stops.length; s++) {
          var rp = p2r(stops[s].x, stops[s].y)
          poly.push([rp[0], rp[1]])
        }
        if (poly.length >= 2) out.push(poly)
      }
      _routeCache = { key: cacheKey, data: out }
      return out
    }
    var paths = S.demoRoutePaths(calib)
    var demo = []
    for (var k = 0; k < paths.length; k++) if (paths[k].pts && paths[k].pts.length > 1) demo.push(paths[k].pts)
    return demo
  }
  // 行驶轨迹拖尾：**画成 3D 地面带**，而不是 2D 叠层。
  // 为什么必须放到 3D：叠层永远盖在 3D 画布之上，所以 2D 画的拖尾会压在车模上；
  // 放进 3D 后它参与深度测试，车体在它前面 → 会被正确遮挡，视觉上就是"拖尾在车下方"。
  // 由旧到新逐段加深加粗（青蓝渐变），一眼看出车往哪走。
  var TRAIL_Y = 4.4                       // 略高于道路带（3.0/3.6），避免与地面 z-fighting
  function buildTrailMesh(cars) {
    var m = S.newMesh()
    var any = false
    var tpx = carTailPx()
    for (var ci = 0; ci < cars.length; ci++) {
      var c = cars[ci]
      var tr = c.anim && c.anim.trail
      if (!tr || tr.length < 2) continue
      // 末尾补上"当前车尾"点：拖尾从车屁股连住，不留一段空隙
      var cur = [c.x - Math.cos(c.th) * tpx, c.z - Math.sin(c.th) * tpx]
      var pts = []
      for (var q = 0; q < tr.length; q++) pts.push([tr[q][0], tr[q][1]])
      var lp = pts[pts.length - 1]
      if (Math.hypot(cur[0] - lp[0], cur[1] - lp[1]) > 0.02 * scene.pxPerM) pts.push(cur)
      var n = pts.length
      if (n < 2) continue
      for (var s = 0; s + 1 < n; s++) {
        var p = pts[s], q2 = pts[s + 1]
        var dx = q2[0] - p[0], dz = q2[1] - p[1]
        var L = Math.hypot(dx, dz)
        if (L < 1e-6) continue
        var f2 = (s + 1) / (n - 1)                      // 0=最旧 1=最新
        var half = (0.45 + 1.15 * f2) * scene.pxPerM / 2  // 由旧到新变宽
        var ux = dx / L, uz = dz / L
        var nx = -uz * half, nz = ux * half
        // 沿走向各外扩半个宽度，让相邻段在拐弯处互相重叠，避免出现缺口
        var ex = ux * half, ez = uz * half
        var a0 = [p[0] - ex, TRAIL_Y, p[1] - ez]
        var a1 = [q2[0] + ex, TRAIL_Y, q2[1] + ez]
        var al = 0.10 + 0.55 * f2 * f2
        S.pushQuad(m,
          [a0[0] + nx, TRAIL_Y, a0[2] + nz], [a1[0] + nx, TRAIL_Y, a1[2] + nz],
          [a1[0] - nx, TRAIL_Y, a1[2] - nz], [a0[0] - nx, TRAIL_Y, a0[2] - nz],
          [0.47, 0.92, 1.0, al], [0, 1, 0])
        any = true
      }
    }
    return any ? S.finalize(m) : null
  }
  // 车辆定位标记：地面光环（按透视投影成正圆）+ 垂直光柱 + 中心点
  function drawCarMarker(g, c) {
    var ap = (c.appear == null ? 1 : c.appear)
    var r = CAR_LEN_M * 0.92 * scene.pxPerM * ap
    // 当前跟随目标车：额外画一个金色虚线外圈，提示"正在跟这辆车"
    if (followSn && c.sn === followSn) {
      var rr = CAR_LEN_M * 1.35 * scene.pxPerM
      var rng = []
      for (var kk = 0; kk <= 40; kk++) {
        var aa = kk / 40 * 2 * Math.PI
        var spp = S.projectPoint(cam, W, H, [c.x + Math.cos(aa) * rr, 0.8, c.z + Math.sin(aa) * rr])
        if (spp) rng.push(spp)
      }
      if (rng.length > 3) {
        g.save()
        g.setLineDash([6, 5])
        g.strokeStyle = 'rgba(255,213,61,0.95)'
        g.lineWidth = 2
        g.shadowColor = 'rgba(255,200,40,0.8)'; g.shadowBlur = 8
        g.beginPath(); g.moveTo(rng[0][0], rng[0][1])
        for (var kk2 = 1; kk2 < rng.length; kk2++) g.lineTo(rng[kk2][0], rng[kk2][1])
        g.closePath(); g.stroke()
        g.restore()
      }
    }
    var seg = 28
    var ring = []
    for (var i = 0; i <= seg; i++) {
      var a = i / seg * 2 * Math.PI
      var sp = S.projectPoint(cam, W, H, [c.x + Math.cos(a) * r, 0.8, c.z + Math.sin(a) * r])
      if (sp) ring.push(sp)
    }
    if (ring.length > 3) {
      g.save()
      g.shadowColor = 'rgba(80,220,255,0.9)'
      g.shadowBlur = 10
      g.strokeStyle = 'rgba(120,235,255,0.9)'
      g.lineWidth = 1.6
      g.beginPath()
      g.moveTo(ring[0][0], ring[0][1])
      for (var k = 1; k < ring.length; k++) g.lineTo(ring[k][0], ring[k][1])
      g.closePath()
      g.stroke()
      g.restore()
    }
    // 光柱：车顶 -> 地面（高度随车模尺寸缩放，避免小车配大光柱）
    var tipTop = S.projectPoint(cam, W, H, [c.x, CAR_LEN_M * 1.9 * scene.pxPerM, c.z])
    var tipBot = S.projectPoint(cam, W, H, [c.x, 0.2, c.z])
    if (tipTop && tipBot) {
      var grd = g.createLinearGradient(tipTop[0], tipTop[1], tipBot[0], tipBot[1])
      grd.addColorStop(0, 'rgba(120,235,255,0.05)')
      grd.addColorStop(1, 'rgba(120,235,255,0.55)')
      g.save()
      g.strokeStyle = grd
      g.lineWidth = 3
      g.beginPath(); g.moveTo(tipTop[0], tipTop[1]); g.lineTo(tipBot[0], tipBot[1]); g.stroke()
      // 原来这里有个很亮的白点（#eafcff 实心圆）——用户反馈太扎眼、画面乱，去掉。
      g.restore()
    }
  }
  // 全息数据牌：深色底 + 青色描边 + 发光文字
  function drawPlate(g, x, y, lines, color) {
    if (!lines.length) return
    g.font = '11px "Microsoft YaHei",sans-serif'
    var wmax = 0
    for (var i = 0; i < lines.length; i++) wmax = Math.max(wmax, g.measureText(lines[i]).width)
    var w = wmax + 16, h = lines.length * 14 + 8
    var x0 = x - w / 2, y0 = y - h
    g.save()
    g.fillStyle = 'rgba(6,20,34,0.72)'
    g.strokeStyle = 'rgba(80,220,255,0.75)'
    g.lineWidth = 1
    roundRect(g, x0, y0, w, h, 4)
    g.fill(); g.stroke()
    // 引线
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, y0 + h); g.stroke()
    g.shadowColor = color; g.shadowBlur = 8
    g.fillStyle = color
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (var k = 0; k < lines.length; k++) g.fillText(lines[k], x, y0 + 11 + k * 14)
    g.restore()
    g.textAlign = 'start'
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }

  /* ---------------- API ---------------- */
  function setOpts(o) {
    for (var k in o) if (o.hasOwnProperty(k)) opts[k] = o[k]
    if (o.el != null) view.el = o.el
    rebuild()
  }
  function getOpts() { return opts }

  // ---- 与 gl3d/recon.js 的接线桥：把主渲染器闭包能力注入重构面板控制器 ----
  var __reconHost = {
    RECON: function () { return RECON },
    setRECON: function (o) { if (o && typeof o === 'object') RECON = o },
    calib: function () { return calib },
    scene: function () { return scene },
    rebuildGrey: function () { rebuildGrey() },
    setStep: function (v) { RECON_STEP_M = v },
    loadRecon: function () { loadRecon() },
    saveRecon: function () { saveRecon() },
    beginReconDraw: function (kind) { beginReconDraw(kind) },
    finishReconDraw: function () { finishReconDraw() },
    cancelReconDraw: function () { cancelReconDraw() },
    nextBldName: function () { return nextBldName() },
    // 编辑选中态：recon.js 点击地图命中后写入；drawOverlay 据此画高亮
    setEdited: function (v) { editedSel = v },
    getEdited: function () { return editedSel },
    // 屏幕 XY(逻辑像素) → 命中 {kind,key,name,dx?} ；命中失败返回 null
    pickAt: function (sx, sy) { return pickAtXY(sx, sy) },
    reconDrawActive: function () { return reconDrawActive },
    beginReconDraw: function (kind) { beginReconDraw(kind) }
  }
  if (window.Map3DGLRecon && window.Map3DGLRecon.bind) window.Map3DGLRecon.bind(__reconHost)

  return {
    ensure: ensure, update: update, resetView: resetView,
    setOpts: setOpts, getOpts: getOpts, probe: probe,
    setCarScale: setCarScale,
    setRobots: setRobots,
    isReady: function () { return ready }, hasFailed: function () { return failed }
  }
})()
