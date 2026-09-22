
  // ---------- 右键上下文菜单 ----------
  // 破坏性操作（删除订单 / 清理批次 / 关闭并作废 / 仅作废）只在这里出现，卡片上没有行内按钮，
  // 避免同一操作存在多处入口；非破坏性项（复制编号 / 在地图查看）也一并放这里。
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

  // 按 id 从 state 里取实体（内联处理器只能传 id，不能传对象）
  function findOrder(id) { return (state && state.orders || []).find(function (o) { return o.id === Number(id) }) }
  function findBatch(id) { return (state && state.batches || []).find(function (b) { return b.id === Number(id) }) }
  function findTask(id) { return (state && state.tasks || []).find(function (t) { return t.id === Number(id) }) }

  function ctxOrder(id, ev) {
    ev.preventDefault()
    ev.stopPropagation()
    var o = findOrder(id)
    if (!o) return false
    var items = [
      { icon: 'i-copy', label: '复制订单号', run: function () { copyText(o.order_no, '订单号已复制') } },
      { icon: 'i-timeline', label: '查看详情与时间线', run: function () { openDrawer('order', o.id) } }
    ]
    if ([0, 1, 2, 3, 6].indexOf(Number(o.status)) >= 0) {
      items.push({ icon: 'i-trash', label: '删除订单', danger: true, run: function () { actCancelOrder(o.id) } })
    }
    showCtx(ev.clientX, ev.clientY, '订单 ' + (o.code_short || o.id) + ' · ' + o.order_no, items)
    return false
  }
  window.ctxOrder = ctxOrder

  function ctxBatch(id, ev) {
    ev.preventDefault()
    ev.stopPropagation()
    var b = findBatch(id)
    if (!b) return false
    var items = [
      { icon: 'i-copy', label: '复制批次号', run: function () { copyText(b.batch_no, '批次号已复制') } },
      { icon: 'i-timeline', label: '查看详情与时间线', run: function () { openDrawer('batch', b.id) } }
    ]
    if (Number(b.status) === 2 && parseRoute(b).length > 0) {
      items.push({ icon: 'i-map', label: '在地图查看配送站位', run: function () { goBatchMap(b.id) } })
    }
    if ([0, 1, 2].indexOf(Number(b.status)) >= 0) {
      items.push({ icon: 'i-trash', label: '清理批次', danger: true, run: function () { actCancelBatch(b.id) } })
    }
    showCtx(ev.clientX, ev.clientY, '批次 ' + (b.code_short || b.id) + ' · ' + b.batch_no, items)
    return false
  }
  window.ctxBatch = ctxBatch

  function ctxTask(id, ev) {
    ev.preventDefault()
    ev.stopPropagation()
    var t = findTask(id)
    if (!t) return false
    var active = [80, 110, 150].indexOf(Number(t.task_status)) < 0 && !t.void_at
    var items = [
      { icon: 'i-copy', label: '复制任务号', run: function () { copyText(String(t.id), '任务号已复制') } },
      { icon: 'i-timeline', label: '查看详情与时间线', run: function () { openDrawer('task', t.id) } }
    ]
    if (active) {
      items.push(
        { icon: 'i-close', label: '关闭并作废', danger: true, run: function () { actCloseVoid(t.id) } },
        { icon: 'i-x', label: '仅作废（不关平台任务）', danger: true, run: function () { actVoid(t.id) } }
      )
    }
    showCtx(ev.clientX, ev.clientY, '任务 #' + t.id, items)
    return false
  }
  window.ctxTask = ctxTask

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
