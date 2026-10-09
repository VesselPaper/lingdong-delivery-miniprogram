/* ============================================================
 * scene3d/triangulate.js — 三角化 + 网格累加器（独立工具层）
 * ------------------------------------------------------------
 * 从 scene3d.js 抽出。只依赖 math（norm/cross/sub/num），不涉及画楼/车。
 *    ringArea / pointInTri / triangulate   （耳切：多边形→三角形索引）
 *    newMesh / pushTri / pushQuad / finalize / linePts
 *
 * UMD：浏览器挂 window.Scene3DParts.triangulate；Node 端 module.exports。
 * ============================================================ */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else {
    if (!root.Scene3DParts) root.Scene3DParts = {}
    root.Scene3DParts.triangulate = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var M = (typeof window !== 'undefined' && window.Scene3DParts && window.Scene3DParts.math) ||
    (typeof module !== 'undefined' && require('./math'))
  var norm = M.norm, cross = M.cross, sub = M.sub, num = M.num

  /* ---------------- 三角化（耳切，支持凹多边形） ---------------- */
  function ringArea(ring) {
    var a = 0
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i], q = ring[(i + 1) % ring.length]
      a += p[0] * q[1] - q[0] * p[1]
    }
    return a / 2
  }
  function pointInTri(p, a, b, c) {
    var d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])
    var d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1])
    var d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])
    var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
    var hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
    return !(hasNeg && hasPos)
  }
  // 「严格」点在三角形内部：落在边上的点**不算**内部。
  // 为什么必须严格：标定楼栋的 ring 普遍带**首尾重合的闭合点**（17/17 栋都有）。用上面的
  // 非严格判定，这个重合点会被判成"在耳内"，于是每个候选耳都被否决 → 耳切提前卡住 →
  // 屋顶只被三角化了一部分，表现为"每栋楼都缺一个三角形角"（实测缺 11%~57% 面积）。
  function pointInTriStrict(p, a, b, c) {
    var d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])
    var d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1])
    var d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])
    return d1 > 0 && d2 > 0 && d3 > 0
  }
  function triangulate(ring) {
    var n = ring.length
    var idx = []
    if (n < 3) return idx
    var list = []
    for (var i = 0; i < n; i++) list.push(i)
    if (ringArea(ring) < 0) list.reverse()
    var guard = 0
    while (list.length > 3 && guard++ < 5000) {
      var earFound = false
      for (var k = 0; k < list.length; k++) {
        var i0 = list[(k - 1 + list.length) % list.length]
        var i1 = list[k]
        var i2 = list[(k + 1) % list.length]
        var a = ring[i0], b = ring[i1], c = ring[i2]
        var crossZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if (crossZ <= 1e-9) continue
        var any = false
        for (var m = 0; m < list.length; m++) {
          var im = list[m]
          if (im === i0 || im === i1 || im === i2) continue
          if (pointInTriStrict(ring[im], a, b, c)) { any = true; break }
        }
        if (any) continue
        idx.push(i0, i1, i2)
        list.splice(k, 1)
        earFound = true
        break
      }
      if (!earFound) break
    }
    // 收尾：耳切可能因退化顶点（共线/首尾重合）提前卡住，剩余多边形一律扇形补齐 ——
    // 宁可有个别三角形重叠，也绝不能让屋顶缺一块（缺角是明显的视觉错误）。
    if (list.length > 3) {
      for (var f2 = 1; f2 + 1 < list.length; f2++) idx.push(list[0], list[f2], list[f2 + 1])
    } else if (list.length === 3) {
      idx.push(list[0], list[1], list[2])
    }
    if (idx.length === 0) { for (var f = 1; f + 1 < n; f++) idx.push(0, f, f + 1) }
    return idx
  }

  /* ---------------- 网格累加器（顶点色带 alpha，可选弧长属性 aux） ---------------- */
  function newMesh() { return { pos: [], nrm: [], col: [], aux: [] } }
  function pushTri(m, a, b, c, col, forcedN, aux3) {
    var n = forcedN
    if (!n) {
      n = norm(cross(sub(b, a), sub(c, a)))
      if (!isFinite(n[0])) n = [0, 1, 0]
    }
    var al = col.length > 3 ? col[3] : 1
    m.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
    for (var i = 0; i < 3; i++) {
      m.nrm.push(n[0], n[1], n[2])
      m.col.push(col[0], col[1], col[2], al)
      if (m.aux) m.aux.push(aux3 ? num(aux3[i]) : 0)
    }
  }
  function pushQuad(m, a, b, c, d, col, n, aux4) {
    pushTri(m, a, b, c, col, n, aux4 ? [aux4[0], aux4[1], aux4[2]] : null)
    pushTri(m, a, c, d, col, n, aux4 ? [aux4[0], aux4[2], aux4[3]] : null)
  }
  function finalize(m) {
    return {
      pos: new Float32Array(m.pos), nrm: new Float32Array(m.nrm), col: new Float32Array(m.col),
      aux: m.aux && m.aux.length ? new Float32Array(m.aux) : null,
      count: m.pos.length / 3
    }
  }
  function linePts(list, a, b) { list.push(a[0], a[1], a[2], b[0], b[1], b[2]) }

  return {
    ringArea: ringArea, pointInTri: pointInTri, triangulate: triangulate,
    newMesh: newMesh, pushTri: pushTri, pushQuad: pushQuad, finalize: finalize, linePts: linePts
  }
})