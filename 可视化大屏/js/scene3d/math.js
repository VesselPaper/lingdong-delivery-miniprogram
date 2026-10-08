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
    baseBoard: [0.031, 0.078, 0.133],
    gridMinor: [0.18, 0.55, 0.78],
    groundTex: 'assets/radar-ground-dark.png',
    wall: [0.42, 0.68, 0.82, 0.26],
    roof: [0.13, 0.29, 0.41, 0.92],
    dWall: [0.36, 0.78, 0.90, 0.30],
    dRoof: [0.16, 0.42, 0.55, 0.94],
    edge: [0.35, 0.88, 1.0],
    edgeDeliver: [0.45, 0.98, 1.0],
    roadMain: [0.74, 0.81, 0.88, 0.92],
    roadRoad: [0.62, 0.69, 0.77, 0.86],
    roadWalk: [0.44, 0.50, 0.58, 0.66],
    pathHalo: [0.06, 0.45, 0.48, 0.45],
    pathCore: [0.38, 0.95, 0.86, 0.95],
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