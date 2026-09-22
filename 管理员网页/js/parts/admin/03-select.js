  // ---------- 选择与批量操作 ----------
  function selCount() {
    return Object.keys(sel.order).length + Object.keys(sel.batch).length + Object.keys(sel.task).length + Object.keys(sel.plat).length
  }
  function updateSelUI(page) {
    var prefix = page === 'tasks' ? 'tasks' : 'history'
    // 行高亮
    document.querySelectorAll('tr.row-selected').forEach(function (tr) { tr.classList.remove('row-selected') })
    document.querySelectorAll('.rowitem.row-selected').forEach(function (r) { r.classList.remove('row-selected') })
    ;['order', 'batch', 'task', 'plat'].forEach(function (type) {
      document.querySelectorAll('.ck[data-type="' + type + '"][data-id]').forEach(function (cb) {
        var on = !!sel[type][cb.dataset.id]
        cb.checked = on
        if (on) {
          var tr = cb.closest('tr, .rowitem')
          if (tr) tr.classList.add('row-selected')
        }
      })
    })
    var n = selCount()
    var info = $(prefix + 'SelInfo')
    if (info) info.textContent = n ? '已选 ' + n + ' 项' : ''
    var bulk = $(prefix + 'Bulk')
    if (bulk) bulk.hidden = n === 0
    // 按选中类型显示对应操作按钮
    var hasO = Object.keys(sel.order).length > 0
    var hasB = Object.keys(sel.batch).length > 0
    var hasT = Object.keys(sel.task).length > 0
    var hasP = Object.keys(sel.plat).length > 0
    var bOrder = $(prefix + 'BulkOrder')
    var bBatch = $(prefix + 'BulkBatch')
    var bTask = $(prefix + 'BulkTask')
    if (bOrder) bOrder.hidden = !hasO
    if (bBatch) bBatch.hidden = !hasB
    if (bTask) bTask.hidden = !hasT
  }
  function clearSel() {
    sel = { order: {}, batch: {}, task: {}, plat: {} }
    updateSelUI('tasks')
    updateSelUI('history')
  }
  window.clearSel = clearSel
  window.toggleSel = function (type, id, checked) {
    if (checked) sel[type][String(id)] = true
    else delete sel[type][String(id)]
    var page = (document.getElementById('page-tasks').classList.contains('active')) ? 'tasks' : 'history'
    updateSelUI(page)
  }
  window.toggleSelAll = function (type, checked, page) {
    var p = page || 'tasks'
    document.querySelectorAll('.ck[data-type="' + type + '"]').forEach(function (cb) {
      cb.checked = checked
      if (checked) sel[type][cb.dataset.id] = true
      else delete sel[type][cb.dataset.id]
    })
    updateSelUI(p)
  }

  // 批量删除订单（后端统一落账 + 平台召回，同步机器人/用户端/商家端）
  function runBulkOrder(page) {
    var ids = Object.keys(sel.order).map(Number)
    if (!ids.length) return
    if (!window.confirm('删除所选 ' + ids.length + ' 个订单？将关闭其平台任务并同步取消，防止机器人卡死。')) return
    api('/orders/bulk-cancel', 'POST', { order_ids: ids }).then(function (d) {
      var failed = d.failed && d.failed.length ? d.failed : []
      toast('已删除 ' + d.cancelled + ' 个订单' + (failed.length ? '，失败 ' + failed.length + ' 项' : ''), failed.length ? 'warn' : 'ok')
      log('批量删除订单：成功 ' + d.cancelled + (failed.length ? '，失败 ' + failed.join('；') : ''), failed.length ? 'warn' : 'green')
      clearSel(); refresh()
    }).catch(function (e) { opFail(e, '批量删除订单') })
  }
  function runBulkBatch(page) {
    var ids = Object.keys(sel.batch).map(Number)
    if (!ids.length) return
    if (!window.confirm('清理所选 ' + ids.length + ' 个批次？将删除批次内全部订单（含平台任务）并释放控制权。')) return
    api('/batches/bulk-cancel', 'POST', { batch_ids: ids }).then(function (d) {
      var failed = d.failed && d.failed.length ? d.failed : []
      toast('已清理 ' + d.cleaned + ' 个批次，删除订单 ' + d.cancelled + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 项' : ''), failed.length ? 'warn' : 'ok')
      log('批量清理批次：成功 ' + d.cleaned + '，删单 ' + d.cancelled + (failed.length ? '，失败 ' + failed.join('；') : ''), failed.length ? 'warn' : 'green')
      clearSel(); refresh()
    }).catch(function (e) { opFail(e, '批量清理批次') })
  }
  function runBulkTask(page) {
    var ids = Object.keys(sel.task).map(Number)
    if (!ids.length) return
    if (!window.confirm('关闭并作废所选 ' + ids.length + ' 个配送任务？')) return
    api('/tasks/bulk-close-void', 'POST', { task_ids: ids }).then(function (d) {
      var failed = d.failed && d.failed.length ? d.failed : []
      toast('已关闭 ' + d.closed + ' 个任务，作废 ' + d.voided + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 项' : ''), failed.length ? 'warn' : 'ok')
      log('批量关闭任务：关闭 ' + d.closed + '，作废 ' + d.voided + (failed.length ? '，失败 ' + failed.join('；') : ''), failed.length ? 'warn' : 'green')
      clearSel(); refresh()
    }).catch(function (e) { opFail(e, '批量关闭任务') })
  }
  // 平台任务批量（客户端循环既有接口）
  function runBulkPlat(mode) {
    var ids = Object.keys(sel.plat)
    if (!ids.length) return
    var items = ids.map(function (id) {
      return (state.platform_tasks || []).find(function (t) { return String(t.id) === id })
    }).filter(Boolean)
    var targets = items.filter(function (t) {
      var st = Number(t.taskStatus)
      return mode === 'cancel' ? st < 10 : ([1, 80, 110, 150].indexOf(st) < 0 && st >= 10)
    })
    if (!targets.length) { toast(mode === 'cancel' ? '所选任务中没有可取消的排队任务' : '所选任务中没有可关闭的活跃任务', 'warn'); return }
    if (!window.confirm(mode === 'cancel' ? '取消所选 ' + targets.length + ' 个排队任务？' : '关闭所选 ' + targets.length + ' 个活跃任务？')) return
    var okN = 0, fail = []
    ;(async function () {
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i]
        try {
          if (mode === 'cancel') {
            await api('/task/cancel', 'POST', { platform_task_id: t.id })
          } else {
            var sn = t.deviceSn || (state.robot && state.robot.device_sn)
            if (!sn) { fail.push('任务 ' + t.id + ' 缺少设备编号'); continue }
            await api('/task/close', 'POST', { device_sn: sn, platform_task_id: t.id })
          }
          okN++
        } catch (e) { fail.push('任务 ' + t.id + ': ' + e.message) }
      }
      toast((mode === 'cancel' ? '已取消 ' : '已关闭 ') + okN + ' 个任务' + (fail.length ? '，失败 ' + fail.length + ' 项' : ''), fail.length ? 'warn' : 'ok')
      clearSel(); refresh()
    })()
  }

  function opFail(e, label) {
    if (isUnauthorized(e)) {
      setAuthBanner('令牌无效：无法认证，不能查看和管理', true)
      log('认证失败：' + e.message, 'bad')
    } else {
      toast(label + ' 失败：' + e.message, 'err')
      log(label + ' 失败：' + e.message, 'bad')
    }
  }

  // ---------- 右键上下文菜单 ----------
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
    m.style.left = Math.min(x, vw - rw - 8) + 'px'
    m.style.top = Math.min(y, vh - rh - 8) + 'px'
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

  function ctxOrder(o, ev) {
    ev.preventDefault()
    var items = [{ icon: 'i-copy', label: '复制订单号', run: function () { copyText(o.order_no, '订单号已复制') } }]
    if ([0, 1, 2, 3, 6].indexOf(Number(o.status)) >= 0) {
      items.unshift({ icon: 'i-trash', label: '删除订单', danger: true, run: function () { actCancelOrder(o.id) } })
    }
    showCtx(ev.clientX, ev.clientY, '订单 ' + o.id + ' · ' + o.order_no, items)
    return false
  }
  window.ctxOrder = ctxOrder

  function ctxBatch(b, ev) {
    ev.preventDefault()
    var items = [
      { icon: 'i-copy', label: '复制批次号', run: function () { copyText(b.batch_no, '批次号已复制') } },
      { icon: 'i-chev', label: expandedSet.has(b.id) ? '收起订单' : '展开订单', run: function () { window.toggleExpand(b.id) } }
    ]
    if ([0, 1, 2].indexOf(Number(b.status)) >= 0) {
      items.unshift({ icon: 'i-trash', label: '清理批次', danger: true, run: function () { actCancelBatch(b.id) } })
    }
    showCtx(ev.clientX, ev.clientY, '批次 ' + b.id + ' · ' + b.batch_no, items)
    return false
  }
  window.ctxBatch = ctxBatch

  function ctxTask(t, ev) {
    ev.preventDefault()
    var active = [80, 110, 150].indexOf(Number(t.task_status)) < 0 && !t.void_at
    var items = [{ icon: 'i-copy', label: '复制任务号', run: function () { copyText(String(t.id), '任务号已复制') } }]
    if (active) {
      items.unshift(
        { icon: 'i-close', label: '关闭并作废', danger: true, run: function () { actCloseVoid(t.id) } },
        { icon: 'i-x', label: '仅作废', run: function () { actVoid(t.id) } }
      )
    }
    showCtx(ev.clientX, ev.clientY, '任务 ' + t.id, items)
    return false
  }
  window.ctxTask = ctxTask

  function ctxPlat(t, ev) {
    ev.preventDefault()
    var st = Number(t.taskStatus)
    var items = [{ icon: 'i-copy', label: '复制任务 ID', run: function () { copyText(t.id, '任务 ID 已复制') } }]
    if (st < 10) {
      items.unshift({ icon: 'i-x', label: '取消排队任务', danger: true, run: function () { actCancel(t.id) } })
    } else if ([1, 80, 110, 150].indexOf(st) < 0) {
      items.unshift({ icon: 'i-close', label: '关闭任务', danger: true, run: function () { actClose(t.deviceSn || '', t.id) } })
    }
    showCtx(ev.clientX, ev.clientY, '平台任务 ' + t.id, items)
    return false
  }
  window.ctxPlat = ctxPlat

  function copyText(txt, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(okMsg, 'ok') }, function () { fallbackCopy(txt, okMsg) })
    } else fallbackCopy(txt, okMsg)
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

  // ---------- 批次展开 ----------
  window.toggleExpand = function (bid) {
    if (expandedSet.has(bid)) {
      expandedSet.delete(bid)
    } else {
      expandedSet.add(bid)
      if (!batchOrdersCache[bid]) {
        batchOrdersCache[bid] = 'loading'
        api('/batch/orders?batch_id=' + bid).then(function (d) {
          batchOrdersCache[bid] = (d && d.orders) || []
          renderPanels()
        }).catch(function (e) {
          batchOrdersCache[bid] = []
          log('批次 ' + bid + ' 订单加载失败：' + e.message, 'bad')
          renderPanels()
        })
      }
    }
    renderPanels()
  }
  function renderPanels() {
    if (state) { renderTasksPage(); renderHistoryPage() }
  }
  function expandRow(b) {
    var cache = batchOrdersCache[b.id]
    if (!expandedSet.has(b.id)) return ''
    var inner
    if (cache === 'loading') inner = '<div class="skel">批次订单加载中…</div>'
    else if (!cache || !cache.length) inner = '<div class="empty">该批次暂无订单</div>'
    else {
      inner = '<div class="tblwrap"><table class="mini-tbl"><thead><tr><th>短号</th><th>订单号</th><th>状态</th><th>商品</th><th>点位</th><th>金额</th><th>取餐码</th><th>创建时间</th></tr></thead><tbody>'
        + cache.map(function (o) {
          return '<tr><td><b>' + esc(o.code_short || o.id) + '</b></td><td>' + esc(o.order_no) + '</td><td>' + orderTag(o) + '</td><td>' + orderGoods(o) + '</td><td>' + esc(o.landmark_name || '—') + '</td><td>' + (o.total_amount || 0) + '</td><td class="num">' + esc(o.pickup_code || '—') + '</td><td>' + esc(o.created_at || '—') + '</td></tr>'
        }).join('')
        + '</tbody></table></div>'
    }
    return '<tr class="row-child"><td colspan="10">' + inner + '</td></tr>'
  }
