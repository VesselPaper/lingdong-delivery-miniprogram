/* ============================================================
 * map3d-entry.js — 地图渲染入口（自动选择真 3D / 2.5D 回退）
 * ------------------------------------------------------------
 * 大屏 dashboard.js 只调用 window.Map3D.{ensure,update,resetView,setOpts}，
 * 具体由哪个渲染器实现由这里决定：
 *   1) 支持 WebGL → Map3DGL（真三维：自由旋转/俯仰/缩放）
 *   2) 不支持 WebGL 或着色器失败 → Map3DFlat（原 2.5D 斜轴测，保证不黑屏）
 * 顶部的 mapTip 会写明当前用的是哪一种。
 * ============================================================ */
window.Map3D = (function () {
  'use strict'
  var mode = null      // 'gl' | 'flat'

  function pick() {
    if (mode) return mode
    if (window.Map3DGL && window.Map3DGL.probe && window.Map3DGL.probe()) mode = 'gl'
    else mode = (window.Map3DFlat ? 'flat' : null)
    return mode
  }
  function impl() {
    pick()
    return mode === 'gl' ? window.Map3DGL : (mode === 'flat' ? window.Map3DFlat : null)
  }
  // WebGL 初始化失败（着色器编译/上下文丢失等）→ 现场降级到 2.5D，不黑屏
  function degradeIfNeeded() {
    if (mode !== 'gl') return
    if (!window.Map3DGL.hasFailed || !window.Map3DGL.hasFailed()) return
    if (!window.Map3DFlat) return
    mode = 'flat'
    window.Map3DFlat.ensure()
    var el = document.getElementById('mapTip')
    if (el) el.textContent = '（WebGL 不可用，已回退为 2.5D 视图）'
  }

  return {
    ensure: function () { var i = impl(); if (i) i.ensure(); degradeIfNeeded() },
    update: function (map, d) {
      degradeIfNeeded()
      var i = impl(); if (i) i.update(map, d)
    },
    resetView: function () { var i = impl(); if (i && i.resetView) i.resetView() },
    setOpts: function (o) { var i = impl(); if (i && i.setOpts) i.setOpts(o) },
    getOpts: function () { var i = impl(); return i && i.getOpts ? i.getOpts() : null },
    // 高频轮询入口：只更新无人车位置（大屏每 ~1s 调一次，车就能实时移动）
    setRobots: function (list) { var i = impl(); return (i && i.setRobots) ? i.setRobots(list) : 0 },
    mode: function () { return pick() }
  }
})()
