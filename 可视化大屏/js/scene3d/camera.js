/* ============================================================
 * scene3d/camera.js — 透视相机 + 坐标换算（独立工具层）
 * ------------------------------------------------------------
 * 从 scene3d.js 抽出。只依赖 math（mat4/num/D2R），不涉及造楼/车/路线。
 *    makeCamera / fitCamera / fitDistance / boundsCorners / projectPoint
 *    makePlatformToRadar（平台世界坐标 → 雷达像素）
 *    principalAzimuth（楼群长轴方位）
 *
 * UMD：浏览器挂 window.Scene3DParts.camera；Node 端 module.exports。
 * ============================================================ */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else {
    if (!root.Scene3DParts) root.Scene3DParts = {}
    root.Scene3DParts.camera = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // 浏览器：window.Scene3DParts.math；Node：同为已加载的 math 模块
  var M = (typeof window !== 'undefined' && window.Scene3DParts && window.Scene3DParts.math) ||
    (typeof module !== 'undefined' && require('./math'))
  var mat4 = M.mat4, num = M.num, D2R = M.D2R

  /* ---------------- 相机 ---------------- */
  function makeCamera(w, h, bounds, state) {
    var fov = (state.fov || 34) * D2R
    var aspect = (w || 1) / (h || 1)
    var near = Math.max(1, bounds.radius * 0.004)
    var far = bounds.radius * 14 + 6000
    var az = (state.az || 0) * D2R
    var el = Math.max(2, Math.min(89, state.el == null ? 34 : state.el)) * D2R
    var dist = state.dist || fitDistance(bounds, fov)
    var t = state.target || bounds.center
    var eye = [
      t[0] + Math.sin(az) * Math.cos(el) * dist,
      t[1] + Math.sin(el) * dist,
      t[2] + Math.cos(az) * Math.cos(el) * dist
    ]
    var view = mat4.lookAt(eye, t, [0, 1, 0])
    var proj = mat4.perspective(fov, aspect, near, far)
    return {
      eye: eye, target: t, view: view, proj: proj, viewProj: mat4.mul(proj, view),
      near: near, far: far, dist: dist, az: az, el: el, fov: fov
    }
  }
  function fitDistance(bounds, fovRad) {
    var r = Math.max(1, bounds.radius)
    return r / Math.tan(fovRad / 2) * 1.12
  }
  function boundsCorners(b) {
    var out = []
    for (var xi = 0; xi < 2; xi++) for (var zi = 0; zi < 2; zi++) for (var yi = 0; yi < 2; yi++) {
      out.push([xi ? b.maxX : b.minX, yi ? Math.max(0, b.maxY) : 0, zi ? b.maxZ : b.minZ])
    }
    return out
  }
  function fitCamera(w, h, bounds, state) {
    state = state || {}
    var fov = state.fov || 34
    var target = state.target || bounds.center
    var margin = state.margin != null ? state.margin : 0.90
    var d = state.dist || (bounds.radius * 2.2)
    var corners = boundsCorners(bounds)
    var cam = null
    for (var iter = 0; iter < 10; iter++) {
      cam = makeCamera(w, h, bounds, { az: state.az, el: state.el, dist: d, fov: fov, target: target })
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, behind = 0
      for (var i = 0; i < corners.length; i++) {
        var sp = projectPoint(cam, w, h, corners[i])
        if (!sp) { behind++; continue }
        if (sp[0] < minX) minX = sp[0]; if (sp[0] > maxX) maxX = sp[0]
        if (sp[1] < minY) minY = sp[1]; if (sp[1] > maxY) maxY = sp[1]
      }
      if (behind > 0 || !(maxX > minX) || !(maxY > minY)) { d *= 1.25; continue }
      var k = Math.min(w * margin / (maxX - minX), h * margin / (maxY - minY))
      if (!isFinite(k) || k <= 0) break
      var nd = d / k
      if (Math.abs(nd - d) / d < 0.004) { d = nd; break }
      d = nd
    }
    cam = makeCamera(w, h, bounds, { az: state.az, el: state.el, dist: d, fov: fov, target: target })
    cam.fitDist = d
    return cam
  }
  function projectPoint(cam, w, h, p) {
    var c = mat4.xform4(cam.viewProj, p)
    if (c[3] <= 1e-6) return null
    return [(c[0] / c[3] * 0.5 + 0.5) * w, (0.5 - c[1] / c[3] * 0.5) * h, c[3]]
  }

  /* ---------------- 平台坐标 -> 雷达像素 -
   * 优先用权威 ROS 映射（meta），bbox 拉伸仅作兜底。 */
  function makePlatformToRadar(bbox, radarW, radarH, meta) {
    var res = meta && num(meta.resolution)
    if (res > 0 && meta.origin && meta.origin.length >= 2) {
      var ox = num(meta.origin[0]), oy = num(meta.origin[1])
      var mw = num(meta.width) || radarW, mh = num(meta.height) || radarH
      var kw = mw / (radarW || mw)
      var kh = mh / (radarH || mh)
      return function (x, y) {
        return [(num(x) - ox) / res / kw, (mh - (num(y) - oy) / res) / kh]
      }
    }
    if (!bbox) return null
    var minX = num(bbox.minX), maxX = num(bbox.maxX), minY = num(bbox.minY), maxY = num(bbox.maxY)
    if (maxX - minX < 1e-9 || maxY - minY < 1e-9) return null
    return function (x, y) {
      return [(num(x) - minX) / (maxX - minX) * radarW, (maxY - num(y)) / (maxY - minY) * radarH]
    }
  }

  /* ---------------- 初始方位：楼群长轴横过来（宽屏最饱满） ---------------- */
  function principalAzimuth(buildings) {
    var pts = []
    for (var i = 0; i < (buildings || []).length; i++) {
      var c = buildings[i].center
      if (c && isFinite(c[0]) && isFinite(c[1])) pts.push([c[0], c[1]])
    }
    if (pts.length < 3) return 0
    var mx = 0, mz = 0
    for (var k = 0; k < pts.length; k++) { mx += pts[k][0]; mz += pts[k][1] }
    mx /= pts.length; mz /= pts.length
    var sxx = 0, sxz = 0, szz = 0
    for (var j = 0; j < pts.length; j++) {
      var dx = pts[j][0] - mx, dz = pts[j][1] - mz
      sxx += dx * dx; sxz += dx * dz; szz += dz * dz
    }
    var theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
    return -theta * 180 / Math.PI
  }

  return {
    makeCamera: makeCamera, fitDistance: fitDistance, fitCamera: fitCamera,
    boundsCorners: boundsCorners, projectPoint: projectPoint,
    makePlatformToRadar: makePlatformToRadar, principalAzimuth: principalAzimuth
  }
})