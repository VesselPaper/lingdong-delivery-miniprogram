/* ============================================================
 * js/dashboard/api.js — 数据源网关
 * ------------------------------------------------------------
 * 从原 dashboard.js 的「取数」块抽出。只负责向后端取数、规范化，
 * 不碰 DOM，不持有渲染状态。所有调用方用 window.Dash.api.xxx。
 *
 *   fetchOverview():          主数据快照（订单/批次/告警/地图…），POLL_MS 低频
 *   fetchRobotPositions():    无人车实时位置，ROBOT_POLL_MS 高频，只喂 3D 地图
 * ============================================================ */
window.Dash.api = (function (Dash) {
  'use strict'

  function make(ctrl, timer, url) {
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        clearTimeout(timer)
        if (!j || j.code !== 0 || !j.data) throw new Error((j && j.msg) || '返回格式异常')
        return j.data
      })
      .catch(function (e) { clearTimeout(timer); throw e })
  }

  function fetchOverview() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, Dash.C.FETCH_TIMEOUT)
    return make(ctrl, timer, Dash.C.API)
  }

  function fetchRobotPositions() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, Dash.C.FETCH_TIMEOUT)
    return make(ctrl, timer, Dash.C.API_ROBOTS)
  }

  // ---------- 虚拟测试车（后端运行时控制） ----------
  function request(method, url, body) {
    var opt = { method: method, headers: {}, cache: 'no-store' }
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json'
      opt.body = JSON.stringify(body)
    }
    return fetch(url, opt).then(function (r) { return r.json() }).then(function (j) {
      if (!j || j.code !== 0 || !j.data) throw new Error((j && j.msg) || '返回格式异常')
      return j.data
    }).catch(function (e) { throw e })
  }
  function getVirtual() { return request('GET', Dash.C.API_VIRTUAL) }
  function setVirtualEnable(enable) { return request('POST', Dash.C.API_VIRTUAL, { enable: !!enable }) }
  function setVirtualState(sn, state, auto) {
    return request('POST', Dash.C.API_VIRTUAL + '/state', { sn: sn, state: state || '', auto: !!auto })
  }

  // ---------- 大屏「3D 图层重构」数据（服务器端持久化） ----------
  // getRecon(): 读服务器上保存的一份；saveRecon(data): 整体保存到服务器（全局共享）。
  // 服务器上没有时返回 { recon: null }，前端回退本地/localStorage/内置默认。
  function getRecon() { return request('GET', Dash.C.API_RECON) }
  function saveRecon(data) { return request('POST', Dash.C.API_RECON, { recon: data || null }) }

  return {
    fetchOverview: fetchOverview,
    fetchRobotPositions: fetchRobotPositions,
    getVirtual: getVirtual,
    setVirtualEnable: setVirtualEnable,
    setVirtualState: setVirtualState,
    getRecon: getRecon,
    saveRecon: saveRecon
  }
})(window.Dash)