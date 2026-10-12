
  // ---------- 右键上下文菜单 ----------
  // 2026-10-12：配送数据页整页删除后，本菜单只剩机器人卡的「更多操作」；
  // 批次 / 订单 / 任务卡的右键菜单已随页面一起删除 ——
  // 订单相关操作一律在商家端小程序，管理员侧不再留入口。
  var ctxOpen = false
  function showCtx(x, y, title, items) {
    var m = $('ctxMenu')
    m.innerHTML = ''
    if (title) m.innerHTML = '<div class="ctx-title">' + esc(title) + '</div>'
    items.forEach(function (it) {
      var b = document.createElement('button')
      b.className = 'ctx-item' + (it.danger ? ' danger' : '')
      b.innerHTML = '<svg><use href="#' + it.icon + '"/></svg>' + esc(it.label)
      b.onclick = function () { hideCtx(); it.run() }
      m.appendChild(b)
    })
    m.hidden = false
    ctxOpen = true
    var rw = m.offsetWidth, rh = m.offsetHeight
    var vw = window.innerWidth, vh = window.innerHeight
    m.style.left = Math.max(8, Math.min(x, vw - rw - 8)) + 'px'
    m.style.top = Math.max(8, Math.min(y, vh - rh - 8)) + 'px'
  }
  function hideCtx() {
    var m = $('ctxMenu')
    if (m) m.hidden = true
    ctxOpen = false
  }
  window.addEventListener('click', function (e) {
    if (ctxOpen && !e.target.closest('#ctxMenu')) hideCtx()
  })
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideCtx() })
  window.addEventListener('blur', hideCtx)

  // ---------- 机器人卡「更多操作」 ----------
  // 只保留三种设备级动作；召唤与开关舱是高频操作，仍在卡片上直接暴露。
  window.showRobotMenu = function (ev) {
    var r = state && state.robot
    var sn = r ? r.device_sn : ''
    var items = [
      { icon: 'i-pause', label: '停止（驻停 30 秒）', run: function () { actStop() } },
      { icon: 'i-play', label: '继续工作（恢复任务）', run: function () { actRecover() } },
      { icon: 'i-close', label: '停止并取消任务', danger: true, run: function () { actStopCancel() } }
    ]
    var x = ev ? ev.clientX : 0
    var y = ev ? ev.clientY : 0
    if (!x && ev && ev.target) { var rc = ev.target.getBoundingClientRect(); x = rc.left; y = rc.bottom + 4 }
    showCtx(x, y, '机器人 ' + (sn || '（无设备）'), items)
  }

  // ---------- 复制编号 ----------
  function copyText(txt, okMsg) {
    var v = String(txt || '')
    if (!v) { toast('没有可复制的内容', 'warn'); return }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(function () { toast(okMsg, 'ok') }, function () { fallbackCopy(v, okMsg) })
    } else fallbackCopy(v, okMsg)
  }
  function fallbackCopy(txt, okMsg) {
    var ta = document.createElement('textarea')
    ta.value = txt
    ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); toast(okMsg, 'ok') } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta)
  }

  // ---------- 批次路由解析（卡片与右键菜单共用） ----------
  function parseRoute(b) { try { return JSON.parse((b && b.route) || '[]') } catch (e) { return [] } }
  function batchRouteText(b) {
    var r = parseRoute(b)
    if (!r.length) return ''
    return r.map(function (s) { return s.landmark_name || ('站' + s.stop) }).join(' → ')
  }
  function currentStopText(b) {
    if (Number(b.status) !== 2) return '—'
    var cs = Number(b.current_stop || 0)
    return cs > 0 ? '第 ' + cs + ' 站 / 共 ' + parseRoute(b).length + ' 站' : '已出发'
  }
  // 点「在地图查看」：跳总览地图并高亮该批配送站位
  window.goBatchMap = function (bid) {
    navTo('overview')
    setTabActive('overviewTabs', 'robot')
    showPanel('overviewPanel', 'robot', ['robot', 'log'])
    if (window.highlightBatchDetail) window.highlightBatchDetail(bid)
  }
