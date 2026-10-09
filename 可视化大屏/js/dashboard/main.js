/* ============================================================
 * js/dashboard/main.js — 大屏编排者/控制器
 * ------------------------------------------------------------
 * 从原 dashboard.js 的「取数-主循环」「主循环」「启动」块抽出。
 * 只做编排：启动定时器、拉取数据、把数据分发给 views/map 各渲染、
 * 处理连接中断/内存守护/每日重载。不直接更新具体 DOM 内容。
 *
 * 依赖：window.Dash.api / .views / .map / .state / .ctx / .C
 * 这是 share→api→views→map 之后最后加载的文件。
 * ============================================================ */
window.Dash.main = (function (Dash) {
  'use strict'

  var $ = Dash.ctx.$, txt = Dash.ctx.txt, setClass = Dash.ctx.setClass
  var state = Dash.state, C = Dash.C
  var DEMO = /[?&]demo=1/.test(location.search)
  Dash.DEMO_MODE = DEMO

  // 平台把路网本身作为一个名为「固定路径」的点位一起下发，它不是配送点，入库前剔除
  function usableLandmarks(map) {
    return ((map && map.landmarks) || []).filter(function (m) {
      return !/固定路径/.test(String(m.name || ''))
    })
  }

  function demoPatch(d) {
    var lms = (d.map && d.map.landmarks) || []
    if (lms.length < 2) return d
    var t = Date.now() / 1000
    function lerp(a, b, k) { return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k } }
    function wave(phase) { return 0.5 + 0.5 * Math.sin(t / 12 + phase) }
    var a1 = lms[0], b1 = lms[Math.min(3, lms.length - 1)]
    var a2 = lms[Math.min(5, lms.length - 1)], b2 = lms[lms.length - 1]
    var dir = Math.cos(t / 12) >= 0 ? 1 : -1
    var p1 = lerp(a1, b1, wave(0))
    var p2 = lerp(a2, b2, wave(1.7))
    d.map.robots = [
      { device_sn: 'LD-DEMO-01', x: p1.x, y: p1.y, theta: Math.atan2(b1.y - a1.y, b1.x - a1.x) * dir, text: '配送中' },
      { device_sn: 'LD-DEMO-02', x: p2.x, y: p2.y, theta: Math.atan2(b2.y - a2.y, b2.x - a2.x) * dir, text: '前往取餐点' }
    ]
    if (!d.map.routes || !d.map.routes.length) {
      d.map.routes = [{
        batch_id: -1, batch_no: 'DEMO',
        stops: [
          { stop: 1, x: a1.x, y: a1.y, name: a1.name },
          { stop: 2, x: b1.x, y: b1.y, name: b1.name },
          { stop: 3, x: b2.x, y: b2.y, name: b2.name }
        ]
      }]
    }
    d.stats = Object.assign({}, d.stats, { today_orders: 43, today_amount: 1286.5, pending: 3, ready_load: 2, delivering: 2, pickup: 5, aftersale: 2 })
    d.robots = (d.robots || []).concat([
      { device_sn: 'LD-DEMO-01', name: '演示车 01', online: true, battery: 78, machine_status: 'Delivery', machine_text: '配送中' },
      { device_sn: 'LD-DEMO-02', name: '演示车 02', online: true, battery: 42, machine_status: 'lightTask', machine_text: '召唤' }
    ])
    d.demo = true
    return d
  }

  function apply(d) {
    if (d.map) d.map.landmarks = usableLandmarks(d.map)
    state.lastData = d
    state.lastOkTs = Date.now()
    Dash.views.setConn(true, '数据正常')
    $('demoBadge').hidden = !d.demo
    Dash.views.renderRunState(d)
    Dash.views.renderStats(d.stats)
    Dash.views.renderRobots(d.robots, d.robots_error)
    Dash.views.renderBatches(d.batches)
    Dash.views.renderAlerts(d.pickup_alerts)
    Dash.map.renderMap(d)
    bindMapHooks()          // 首轮 renderMap 之后渲染器已就绪：把地图事件接回大屏（只接一次）
    Dash.views.diffEvents(d)
    txt($('footMid'), '后端 ' + (d.server_time || '') + ' · 运行档位 ' + (d.run_mode || '—'))
  }

  /* ---------------- 选中车辆（左侧车辆卡面 ↔ 地图车辆 双向同步） ----------------
   * 两个入口共用同一份选中态 state.selectedSn：
   *   ① 点左侧卡面 → selectCar(sn)：推给地图（silent，避免地图再回调回来）+ 刷新卡面高亮
   *   ② 点地图上的车 → 渲染器回调 onCarSelect(sn) → 只刷新左侧卡面高亮（地图自己已知）
   * **选中不会自动开启跟随**：跟随只由工具栏「跟随」按钮控制（用户明确要求）。
   * ------------------------------------------------------------------------- */
  function applySelection(sn, pushToMap) {
    var v = sn ? String(sn) : null
    state.selectedSn = v
    if (pushToMap && window.Map3D && Map3D.setSelected) Map3D.setSelected(v, true)
    Dash.views.renderRobots(state.fleet || [], state.fleetError)
    var tip = $('mapTip')
    if (tip && v) txt(tip, '已选中 ' + v + ' · 跟随需另点「跟随」')
  }

  function selectCar(sn) { applySelection(sn, true) }

  // 用 getOpts() 拿渲染器内部 opts 引用直接挂回调：不触发 setOpts 的整场重建。
  function bindMapHooks() {
    if (state.mapHooksBound || !window.Map3D || !Map3D.getOpts) return
    var o = Map3D.getOpts()
    if (!o) return
    o.onCarSelect = function (sn) { applySelection(sn, false) }
    o.onFollowChange = function (on) {
      var tip = $('mapTip')
      if (tip && !on) txt(tip, '已关闭跟随（拖动画面会自动取消跟随）')
    }
    state.mapHooksBound = true
  }

  /* ---------------- 布局：左右看板伸缩 + 地图全屏 ----------------
   * 布局一变，地图容器的尺寸就变了，必须让渲染器重算画布尺寸（否则画布按旧尺寸拉伸、发虚）。
   * 首选 ResizeObserver 盯住地图容器：抽屉动画的每一帧都会触发，尺寸始终跟得上；
   * 没有 ResizeObserver 的老浏览器退化成"立即 + 动画结束后各重算一次"。
   * ------------------------------------------------------------- */
  function mapResizeNow() {
    if (window.Map3D && Map3D.resize) Map3D.resize()
    if (Dash.map && Dash.map.mapResized) Dash.map.mapResized()
  }

  function mapResizeSoon() {
    mapResizeNow()
    if (typeof ResizeObserver === 'undefined') setTimeout(mapResizeNow, 340)
  }

  function observeMapSize() {
    var box = $('mapBox')
    if (!box || state.mapObserver || typeof ResizeObserver === 'undefined') return
    state.mapObserver = new ResizeObserver(function () { mapResizeNow() })
    state.mapObserver.observe(box)
  }

  function syncLayout() {
    var grid = document.querySelector('main.grid')
    var screenEl = $('screen')
    if (grid) {
      grid.classList.toggle('hideLeft', !state.mapFull && state.leftHidden)
      grid.classList.toggle('hideRight', !state.mapFull && state.rightHidden)
    }
    if (screenEl) screenEl.classList.toggle('mapFull', state.mapFull)
    // 贴边把手：只有"该栏已收起且不在全屏态"时才出现
    var el = $('edgeTabLeft'), er = $('edgeTabRight')
    if (el) el.hidden = !(state.leftHidden && !state.mapFull)
    if (er) er.hidden = !(state.rightHidden && !state.mapFull)
    var fb = $('mapFullBtn')
    if (fb) {
      txt(fb, state.mapFull ? '⤡ 退出全屏' : '⛶ 全屏')
      fb.title = state.mapFull ? '退出地图全屏（Esc）' : '地图全屏（只留地图，Esc 退出）'
    }
    mapResizeSoon()
  }

  function setLeftHidden(v) {
    state.leftHidden = !!v
    if (!state.leftHidden && state.mapFull) state.mapFull = false   // 展开某侧即退出全屏
    syncLayout()
  }
  function setRightHidden(v) {
    state.rightHidden = !!v
    if (!state.rightHidden && state.mapFull) state.mapFull = false
    syncLayout()
  }
  function toggleMapFull() { state.mapFull = !state.mapFull; syncLayout() }

  function bindLayoutControls() {
    var bl = $('colLeftToggle'); if (bl) bl.onclick = function () { setLeftHidden(true) }
    var br = $('colRightToggle'); if (br) br.onclick = function () { setRightHidden(true) }
    var el = $('edgeTabLeft'); if (el) el.onclick = function () { setLeftHidden(false) }
    var er = $('edgeTabRight'); if (er) er.onclick = function () { setRightHidden(false) }
    var fb = $('mapFullBtn'); if (fb) fb.onclick = toggleMapFull
    // Esc：先退全屏，再退选中（输入框里按 Esc 不干扰）
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return
      var t = e.target
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || '')) return
      if (state.mapFull) { state.mapFull = false; syncLayout(); return }
      if (state.selectedSn) selectCar(null)
    })
    syncLayout()
  }

  function loop() {
    Dash.api.fetchOverview().then(function (d) {
      apply(DEMO ? demoPatch(d) : d)
    }).catch(function (e) {
      Dash.views.setConn(false, '连接中断' + (e && e.message ? '（' + e.message + '）' : ''))
    })
  }

  function pollRobots() {
    if (!window.Map3D || !Map3D.setRobots) return
    Dash.api.fetchRobotPositions().then(function (d) {
      var list = (d && d.robots) || []
      var withPos = list.filter(function (r) {
        if (!r) return false
        if (r.px != null && r.py != null) return true
        return r.has_pos !== false && r.x != null && r.y != null
      })
      Map3D.setRobots(withPos)
    }).catch(function () { /* 轮询失败静默 */ })
  }

  function memoryGuard() {
    try {
      if (window.performance && performance.memory && performance.memory.usedJSHeapSize > C.MEM_LIMIT) location.reload()
    } catch (e) { /* 非 Chrome 无此 API */ }
  }

  function dailyReload() {
    var now = new Date()
    var day = now.toDateString()
    if (now.getHours() === C.RELOAD_HOUR && state.reloadDay !== day) {
      state.reloadDay = day
      location.reload()
    }
  }

  function fitScreen() {
    var el = $('screen')
    if (!el) return
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
    var dx = (window.innerWidth - 1920 * s) / 2
    var dy = (window.innerHeight - 1080 * s) / 2
    el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + s.toFixed(4) + ')'
  }

  // ---------- 虚拟测试车控制（工具栏「虚拟车」开关 + 「手动」面板） ----------
  function refreshVirtual() {
    Dash.api.getVirtual().then(function (d) {
      if (!d) return
      var toggle = $('simToggle')
      if (toggle) toggle.classList.toggle('on', !!d.enabled)
      var panel = $('simPanel'), snSel = $('simSn')
      if (!panel) return
      var prev = snSel ? snSel.value : ''
      if (snSel && Array.isArray(d.robots)) {
        snSel.innerHTML = ''
        d.robots.forEach(function (r) {
          var o = document.createElement('option')
          o.value = r.sn; o.textContent = r.name + ' (' + r.sn + ')'
          snSel.appendChild(o)
        })
        var prevOk = prev && snSel.querySelector('option[value="' + prev + '"]')
        snSel.value = prevOk ? prev : (snSel.options[0] ? snSel.options[0].value : '')
      }
      var active = {}
      ;(d.robots || []).forEach(function (r) { active[r.sn] = r })
      var cur = active[snSel ? snSel.value : '']
      panel.querySelectorAll('[data-sim-state]').forEach(function (b) {
        var on = cur && !cur.auto && cur.status === b.getAttribute('data-sim-state')
        b.classList.toggle('on', !!on)
      })
      var autoBtn = panel.querySelector('[data-sim-auto]')
      if (autoBtn) autoBtn.classList.toggle('on', !cur || !!cur.auto)
    }).catch(function () { /* 回显失败静默，下一轮轮询重试 */ })
  }

  function bindVirtualControls() {
    var toggle = $('simToggle')
    if (!toggle) return
    toggle.addEventListener('click', function () {
      toggle.classList.toggle('on', !toggle.classList.contains('on'))
      Dash.api.setVirtualEnable(toggle.classList.contains('on')).then(refreshVirtual).catch(function () { refreshVirtual() })
    })
    var statesBtn = $('simStates'), panel = $('simPanel')
    if (statesBtn && panel) {
      statesBtn.addEventListener('click', function () {
        var show = !statesBtn.classList.contains('on')
        statesBtn.classList.toggle('on', show)
        panel.hidden = !show
      })
    }
    if (panel) {
      var snSel = $('simSn')
      if (snSel) snSel.addEventListener('change', function () { refreshVirtual() })
      panel.querySelectorAll('[data-sim-state]').forEach(function (b) {
        b.addEventListener('click', function () {
          var sn = snSel ? snSel.value : ''
          Dash.api.setVirtualState(sn, b.getAttribute('data-sim-state'), false).then(refreshVirtual).catch(function () { refreshVirtual() })
        })
      })
      var autoBtn = panel.querySelector('[data-sim-auto]')
      if (autoBtn) autoBtn.addEventListener('click', function () {
        var sn = snSel ? snSel.value : ''
        Dash.api.setVirtualState(sn, '', true).then(refreshVirtual).catch(function () { refreshVirtual() })
      })
    }
    refreshVirtual()
    setInterval(refreshVirtual, 5000)          // 回显按钮态（含其它端改动）
  }

  function boot() {
    Dash.views.tickClock()
    setInterval(Dash.views.tickClock, 1000)

    fitScreen()
    bindVirtualControls()
    bindLayoutControls()
    observeMapSize()
    window.resetMap = function () { if (Dash.map && Dash.map.resetView) Dash.map.resetView() }
    window.addEventListener('resize', function () { fitScreen(); Dash.map.mapResized() })

    loop()
    setInterval(loop, C.POLL_MS)
    pollRobots()
    setInterval(pollRobots, C.ROBOT_POLL_MS)
    setInterval(memoryGuard, 60000)
    setInterval(dailyReload, 60000)
  }

  return {
    boot: boot, apply: apply, loop: loop, pollRobots: pollRobots, demoPatch: demoPatch,
    usableLandmarks: usableLandmarks,
    // 交互（左侧卡面点选 / 布局伸缩）：供 views-ui 与调试调用
    selectCar: selectCar, applySelection: applySelection,
    setLeftHidden: setLeftHidden, setRightHidden: setRightHidden, toggleMapFull: toggleMapFull
  }
})(window.Dash)

// 启动（保持与原 dashboard.js 相同：DOM 就绪即 boot）
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { window.Dash.main.boot() })
else window.Dash.main.boot()