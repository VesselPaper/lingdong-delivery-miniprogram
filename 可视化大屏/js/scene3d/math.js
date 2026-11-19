/* ============================================================
 * scene3d/math.js — 数学 + 主题 + 光照（最独立工具层）
 * ------------------------------------------------------------
 * 从 scene3d.js 抽出、最独立且 agent 几乎不改的部分：
 *   矩阵/向量、主题色板、光照与车模朝向矩阵。
 * 零依赖（自给 D2R/num），不涉及任何"造楼/车/路线"逻辑。
 *
 * UMD：浏览器挂 window.Scene3DParts.math；Node 端 module.exports。
 * ============================================================ */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else {
    if (!root.Scene3DParts) root.Scene3DParts = {}
    root.Scene3DParts.math = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var D2R = Math.PI / 180
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

  /* ---------------- mat4（列主序） ---------------- */
  var mat4 = {
    identity: function () { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    mul: function (a, b) {
      var o = new Array(16)
      for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
        }
      }
      return o
    },
    perspective: function (fovyRad, aspect, near, far) {
      var f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far)
      return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]
    },
    lookAt: function (eye, center, up) {
      var z = norm(sub(eye, center))
      var x = norm(cross(up, z))
      var y = cross(z, x)
      return [
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
      ]
    },
    xform4: function (m, p) {
      return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
      ]
    },
    translation: function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] },
    rotY: function (a) { var c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1] },
    rotZ: function (a) { var c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    scale: function (x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1] }
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
  function norm(v) { var L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L] }

  /* ---------------- 主题（数字孪生全息风） ---------------- */
  var THEME = {
    bg: [0.039, 0.098, 0.161],
    bgLight: [0.058, 0.132, 0.212],
    // 地台（校区边界多边形内的地面）：只比背景深一点点，靠极小的明暗差表达范围，
    // 边缘不加任何描边（加过，截图里像激光围栏）
    baseBoard: [0.046, 0.108, 0.176],
    // 底板径向渐变（中心略亮 → 外圈压暗），配合贴地光晕形成"聚光"感
    boardCenter: [0.070, 0.150, 0.235, 0.96],
    boardMid: [0.043, 0.098, 0.163, 0.93],
    boardEdge: [0.020, 0.050, 0.088, 0.90],
    // 校区边界：一道很淡的青色贴地发光带
    boundaryGlow: [0.18, 0.52, 0.66, 0.26],
    // 楼底投影圈
    bldShadow: [0.010, 0.030, 0.060, 0.40],
    // 楼层腰线 / 屋顶女儿墙：原来 alpha 0.15/0.50 在深底上几乎看不见，
    // 一轮截图确认"楼还是素的"，现在提上来，让楼有"层"和"顶"的读数。
    floorLine: [0.62, 0.90, 1.0, 0.34],
    parapet: [0.66, 0.95, 1.0, 0.78],
    // 按功能分色的楼体（墙/顶）：宿舍、教学、食堂、场馆
    // 2026-11-18 截图确认：原色太暗太透，整片楼群糊成一团深蓝。
    // 统一抬亮度、抬不透明度，让屋顶明显比墙亮，楼才"立"得起来。
    // 2026-11-19 第二轮：墙面还是太透（alpha 0.46 时楼像玻璃盒子），提到 0.66；
    // 屋顶再提亮一档，让"顶面 vs 墙面"的明暗差拉开，楼群才会立起来。
    catDormWall: [0.26, 0.48, 0.72, 0.70],
    catDormRoof: [0.32, 0.55, 0.80, 0.98],
    catTeachWall: [0.24, 0.58, 0.64, 0.70],
    catTeachRoof: [0.26, 0.60, 0.66, 0.98],
    catFoodWall: [0.64, 0.48, 0.30, 0.72],
    catFoodRoof: [0.74, 0.53, 0.29, 0.98],
    catSportWall: [0.32, 0.38, 0.68, 0.70],
    catSportRoof: [0.38, 0.43, 0.74, 0.98],
    gridMinor: [0.18, 0.55, 0.78],
    groundTex: 'assets/radar-ground-dark.png',
    wall: [0.34, 0.56, 0.72, 0.42],
    roof: [0.20, 0.36, 0.50, 0.95],
    dWall: [0.36, 0.78, 0.90, 0.30],
    dRoof: [0.16, 0.42, 0.55, 0.94],
    // 描边：2026-11-18 从"亮青实线"收到更细、更淡，避免楼群变成一片白描线
    edge: [0.32, 0.78, 0.94, 0.80],
    edgeDeliver: [0.45, 0.98, 1.0, 0.95],
    // 校园道路：全校图上道路是"骨架"，要比东苑小图那版更亮一点才看得清
    // 校园道路：2026-11-18 从"亮白"降到"浅灰蓝"。
    // 原色 (0.86,0.92,0.98) 在深底上像粉笔划痕，是最显"杂乱"的元凶之一；
    // 现在压到接近真实沥青的浅灰，靠"比地面亮一点"读出来，而不是靠高反差。
    roadMain: [0.62, 0.71, 0.80, 0.95],
    roadRoad: [0.50, 0.59, 0.68, 0.90],
    roadWalk: [0.40, 0.47, 0.56, 0.72],
    pathHalo: [0.06, 0.45, 0.48, 0.45],
    pathCore: [0.38, 0.95, 0.86, 0.95],
    // 水体（湖/塘）：三层深度渐变 + 双层岸线 + 反光条（2026-11-18 美术打磨）
    water: [0.06, 0.36, 0.50, 0.90],
    waterDeep: [0.035, 0.19, 0.30, 0.96],
    waterMid: [0.055, 0.30, 0.43, 0.94],
    waterShallow: [0.10, 0.44, 0.56, 0.90],
    waterRim: [0.45, 0.98, 1.0, 0.95],
    waterRimSoft: [0.22, 0.68, 0.82, 0.32],
    waterGlint: [0.74, 0.96, 1.0, 0.16],
    // 运动场地：跑道=砖红（双层：外圈深、内圈亮），球场=草/蓝，草地=深绿
    fieldTrackOuter: [0.42, 0.16, 0.15, 0.96],
    fieldTrack: [0.62, 0.28, 0.22, 0.96],
    fieldTrackLine: [0.95, 0.93, 0.88, 0.85],
    fieldPitch: [0.14, 0.40, 0.25, 0.95],
    fieldPitchAlt: [0.17, 0.47, 0.29, 0.95],
    fieldCourt: [0.14, 0.31, 0.45, 0.95],
    fieldCourtAlt: [0.17, 0.37, 0.52, 0.95],
    fieldGrass: [0.10, 0.26, 0.19, 0.95],
    fieldEdge: [0.88, 0.94, 0.86, 0.70],
    // 球场（2026-11-18 单独建模）：整片场地的基层 + 三种场地表面 + 白线
    courtBase: [0.13, 0.20, 0.25, 0.95],
    courtBasket: [0.44, 0.25, 0.20, 0.96],
    courtTennis: [0.13, 0.34, 0.33, 0.96],
    courtBadminton: [0.15, 0.32, 0.24, 0.96],
    courtLine: [0.93, 0.96, 0.94, 0.80],
    pin: [1.0, 0.55, 0.16, 1.0],
    carBody: [0.94, 0.97, 1.0, 1.0],
    carTop: [0.07, 0.15, 0.24, 1.0],
    ring: [0.35, 0.92, 1.0, 0.80],
    beam: [0.32, 0.86, 1.0, 0.26],
    route: [1.0, 0.55, 0.13, 1.0]
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
    mat4: mat4, sub: sub, dot: dot, cross: cross, norm: norm, num: num,
    shade: shade, carMatrix: carMatrix
  }
})