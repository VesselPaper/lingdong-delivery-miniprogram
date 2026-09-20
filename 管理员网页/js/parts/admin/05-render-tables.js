  // ---------- 配送任务页 ----------
  function renderTasksPage() {
    if (!state) return
    var q = searchQ.tasks
    var flt = statusFilter.tasks
    renderExec(q, flt)
    renderBatchPanel('tasksPanelBatches', false, q, flt, 'tasks')
    renderOrderPanel('tasksPanelOrders', true, q, flt, 'tasks')
  }

  // 正在执行：配送中（批次待上货1/配送中2 + 订单配送中2）/ 待取货（订单3）/ 配送异常（订单6 + 任务90/100/120）
  function renderExec(q, flt) {
    var box = $('tasksPanelExec')
    if (!box) return
    var batches = state.batches || []
    var orders = state.orders || []
    var tasks = state.tasks || []
    var parts = []
    var total = 0

    function match(o, no) {
      if (q && String(no || '').toLowerCase().indexOf(q) < 0) return false
      return true
    }

    // —— 配送中：批次待上货1/配送中2 + 订单配送中2 ——
    var deliveringBatches = batches.filter(function (b) {
      var s = Number(b.status)
      if (s !== 1 && s !== 2) return false
      if (q && String(b.batch_no || '').toLowerCase().indexOf(q) < 0) return false
      if (flt !== '' && String(s) !== flt) return false
      return true
    })
    var deliveringOrders = orders.filter(function (o) {
      if (Number(o.status) !== 2) return false
      if (q && String(o.order_no || '').toLowerCase().indexOf(q) < 0) return false
      if (flt !== '' && flt !== '2') return false
      return true
    })
    if (deliveringBatches.length || deliveringOrders.length) {
      total += deliveringBatches.length + deliveringOrders.length
      var dRows = deliveringBatches.map(function (b) {
        return rowItem('batch', b.id, '<span class="k">批次 #' + b.id + '</span><span class="v">' + esc(b.batch_no) + ' · ' + b.total_orders + ' 单</span>'
          + '<span class="v">' + batchTag(b) + '</span>'
          + (b.device_sn ? '<span class="v num">' + esc(b.device_sn) + '</span>' : '')
          + '<span class="ops"><button class="btn danger ghost sm" onclick="window.actCancelBatch(' + b.id + ')">清理批次</button></span>')
      }).join('')
      dRows += deliveringOrders.map(function (o) {
        return rowItem('order', o.id, '<span class="k">订单 #' + o.id + '</span><span class="v">' + esc(o.order_no) + '</span>'
          + '<span class="v">' + orderTag(o) + '</span>'
          + '<span class="v">' + esc(o.landmark_name || '—') + '</span>'
          + (o.batch_id ? '<span class="v mini">批次 ' + o.batch_id + '</span>' : '')
          + '<span class="ops"><button class="btn danger ghost sm" onclick="window.actCancelOrder(' + o.id + ')">删除订单</button></span>')
      }).join('')
      parts.push(catBlock('配送中', 'green', dRows))
    }
    // —— 待取货：订单 status=3 ——
    var waitPick = orders.filter(function (o) { return Number(o.status) === 3 && match(o, o.order_no) && (flt === '' || flt === '3') })
    if (waitPick.length) {
      total += waitPick.length
      parts.push(catBlock('待取货', 'violet', waitPick.map(function (o) {
        return rowItem('order', o.id, '<span class="k">订单 #' + o.id + '</span><span class="v">' + esc(o.order_no) + '</span>'
          + '<span class="v">' + orderTag(o) + '</span>'
          + '<span class="v">' + esc(o.landmark_name || '—') + '</span>'
          + (o.batch_id ? '<span class="v mini">批次 ' + o.batch_id + '</span>' : '')
          + '<span class="ops"><button class="btn danger ghost sm" onclick="window.actCancelOrder(' + o.id + ')">删除订单</button></span>')
      })))
    }
    // —— 配送异常：订单6 + 任务90/100/120 ——
    var errOrders = orders.filter(function (o) { return Number(o.status) === 6 && match(o, o.order_no) && (flt === '' || flt === '6' || flt === 'err') })
    var errTasks = tasks.filter(function (t) {
      if ([90, 100, 120].indexOf(Number(t.task_status)) < 0 || t.void_at) return false
      if (flt !== '' && flt !== 'err') return false
      if (q) {
        if (String(t.id).indexOf(q) >= 0) return true
        return orders.some(function (o) { return o.id === t.order_id && String(o.order_no || '').toLowerCase().indexOf(q) >= 0 })
      }
      return true
    })
    if (errOrders.length || errTasks.length) {
      total += errOrders.length + errTasks.length
      var rows = errOrders.map(function (o) {
        return rowItem('order', o.id, '<span class="k">订单 #' + o.id + '</span><span class="v">' + esc(o.order_no) + '</span>'
          + '<span class="v">' + orderTag(o) + '</span>'
          + '<span class="v">' + esc(o.landmark_name || '—') + '</span>'
          + '<span class="ops"><button class="btn danger ghost sm" onclick="window.actCancelOrder(' + o.id + ')">删除订单</button></span>')
      }).join('')
      rows += errTasks.map(function (t) {
        return rowItem('task', t.id, '<span class="k">任务 #' + t.id + '</span><span class="v">' + (t.order_id ? '订单 ' + t.order_id : '') + '</span>'
          + '<span class="v">' + taskTag(t) + '</span>'
          + (t.device_sn ? '<span class="v num">' + esc(t.device_sn) + '</span>' : '')
          + '<span class="ops"><button class="btn danger ghost sm" onclick="window.actCloseVoid(' + t.id + ')">关闭并作废</button></span>')
      }).join('')
      parts.push(catBlock('配送异常', 'red', rows))
    }

    if (!parts.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-truck"/></svg>当前没有正在执行的任务</div>'
    } else {
      box.innerHTML = parts.join('')
    }
    // 同步勾选状态
    updateSelUI('tasks')
  }

  function rowItem(type, id, innerHtml) {
    return '<div class="rowitem ctx-hit" oncontextmenu="window.ctx' + cap(type) + '(' + id + ',event)">'
      + '<input type="checkbox" class="ck" data-type="' + type + '" data-id="' + id + '" onchange="window.toggleSel(\'' + type + '\',' + id + ',this.checked)">'
      + innerHtml + '</div>'
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

  function catBlock(title, color, rows) {
    var dotColor = color === 'red' ? 'var(--red)' : color === 'violet' ? 'var(--violet)' : color === 'blue' ? 'var(--blue)' : 'var(--ok)'
    var cnt = rows ? rows.split('class="rowitem').length - 1 : 0
    return '<div class="cat"><div class="cat-head"><span class="dot" style="background:' + dotColor + '"></span><h3>' + title + '</h3><span class="cnt">' + cnt + '</span></div>' + (rows || '') + '</div>'
  }

  // ---------- 批次表（可展开，两页共用） ----------
  // 批次路由解析 / 路线文本 / 当前停靠文本（供批次行展示配送进度）
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
  // 点批次行「地图」：跳到总览地图并高亮该批配送站位
  window.goBatchMap = function (bid) {
    navTo('overview')
    setTabActive('overviewTabs', 'robot')
    showPanel('overviewPanel', 'robot', ['robot', 'dict', 'log'])
    if (window.highlightBatchDetail) window.highlightBatchDetail(bid)
  }

  function renderBatchPanel(panelId, isHistory, q, flt, page) {
    var box = $(panelId)
    if (!box) return
    var rows = (state.batches || []).filter(function (b) {
      var s = Number(b.status)
      var hist = [3, 4].indexOf(s) >= 0
      if (isHistory !== hist) return false
      if (flt !== '' && String(s) !== flt) return false
      if (q) {
        if (String(b.batch_no || '').toLowerCase().indexOf(q) >= 0) return true
        return (state.orders || []).some(function (o) { return o.batch_id === b.id && String(o.order_no || '').toLowerCase().indexOf(q) >= 0 })
      }
      return true
    })
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-box"/></svg>' + (q || flt ? '没有符合条件的批次' : (isHistory ? '暂无历史批次' : '暂无批次')) + '</div>'
      return
    }
    var head = '<div class="tblwrap"><table><thead><tr>'
      + '<th style="width:34px"><input type="checkbox" class="ck" onchange="window.toggleSelAll(\'batch\',this.checked,\'' + page + '\')"></th>'
      + '<th>ID</th><th>批次号</th><th>状态</th><th>设备</th><th>单数</th><th>进度</th><th>当前停靠</th><th>路线</th><th>创建时间</th><th>操作</th>'
      + '<th style="width:34px"></th>'
      + '</tr></thead><tbody>'
    var body = rows.map(function (b) {
      var active = [0, 1, 2].indexOf(Number(b.status)) >= 0
      var exp = expandedSet.has(b.id)
      var hasRoute = parseRoute(b).length > 0
      var mapBtn = (Number(b.status) === 2 && hasRoute) ? '<button class="btn ghost sm mapgo" title="在地图上查看该批次配送站位" onclick="window.goBatchMap(' + b.id + ')"><svg><use href="#i-map"/></svg>地图</button>' : ''
      var progress = Number(b.status) === 2 ? (Number(b.picked_orders || 0) + ' / ' + b.total_orders) : '—'
      return '<tr class="ctx-hit" oncontextmenu="window.ctxBatch(' + b.id + ',event)">'
        + '<td><input type="checkbox" class="ck" data-type="batch" data-id="' + b.id + '" onchange="window.toggleSel(\'batch\',' + b.id + ',this.checked)"></td>'
        + '<td><b>' + b.id + '</b></td><td>' + esc(b.batch_no) + '</td><td>' + batchTag(b) + '</td>'
        + '<td>' + esc(b.device_sn || '—') + '</td><td>' + b.total_orders + '</td>'
        + '<td>' + progress + '</td><td>' + esc(currentStopText(b)) + '</td>'
        + '<td class="route-cell">' + (hasRoute ? esc(batchRouteText(b)) : '—') + '</td>'
        + '<td>' + esc(b.created_at || '—') + '</td>'
        + '<td class="row-ops">' + mapBtn + ' ' + (active ? '<button class="btn danger ghost sm" onclick="window.actCancelBatch(' + b.id + ')">清理批次</button>' : '<span class="mini">终态</span>') + '</td>'
        + '<td><button class="expander' + (exp ? ' open' : '') + '" onclick="window.toggleExpand(' + b.id + ')" title="展开批次内订单"><svg><use href="#i-chev"/></svg></button></td></tr>'
        + expandRow(b)
    }).join('')
    box.innerHTML = head + body + '</tbody></table></div>'
    updateSelUI(page)
  }

  // ---------- 订单表 ----------
  function renderOrderPanel(panelId, allMode, q, flt, page) {
    var box = $(panelId)
    if (!box) return
    var hist = [4, 5, 7]
    var rows = (state.orders || []).filter(function (o) {
      var s = Number(o.status)
      if (!allMode && hist.indexOf(s) < 0) return false
      if (flt !== '' && String(s) !== flt) return false
      if (q) {
        if (String(o.order_no || '').toLowerCase().indexOf(q) >= 0) return true
        var b = (state.batches || []).find(function (x) { return x.id === o.batch_id })
        return b && String(b.batch_no || '').toLowerCase().indexOf(q) >= 0
      }
      return true
    })
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-box"/></svg>' + (q || flt ? '没有符合条件的订单' : '暂无订单') + '</div>'
      return
    }
    var head = '<div class="tblwrap"><table><thead><tr>'
      + '<th style="width:34px"><input type="checkbox" class="ck" onchange="window.toggleSelAll(\'order\',this.checked,\'' + page + '\')"></th>'
      + '<th>ID</th><th>订单号</th><th>状态</th><th>批次</th><th>点位</th><th>金额</th><th>创建时间</th><th>操作</th>'
      + '</tr></thead><tbody>'
    var body = rows.map(function (o) {
      var active = [0, 1, 2, 3, 6].indexOf(Number(o.status)) >= 0
      return '<tr class="ctx-hit" oncontextmenu="window.ctxOrder(' + o.id + ',event)">'
        + '<td><input type="checkbox" class="ck" data-type="order" data-id="' + o.id + '" onchange="window.toggleSel(\'order\',' + o.id + ',this.checked)"></td>'
        + '<td><b>' + o.id + '</b></td><td>' + esc(o.order_no) + '</td><td>' + orderTag(o) + '</td>'
        + '<td>' + (o.batch_id || '—') + '</td><td>' + esc(o.landmark_name || '—') + '</td><td>' + (o.total_amount || 0) + '</td>'
        + '<td>' + esc(o.created_at || '—') + '</td>'
        + '<td class="row-ops">' + (active ? '<button class="btn danger ghost sm" onclick="window.actCancelOrder(' + o.id + ')">删除订单</button>' : '<span class="mini">终态</span>') + '</td></tr>'
    }).join('')
    box.innerHTML = head + body + '</tbody></table></div>'
    updateSelUI(page)
  }

  // ---------- 本地配送任务表 ----------
  function renderLocalTaskPanel(panelId, allMode, q, flt, page) {
    var box = $(panelId)
    if (!box) return
    var rows = (state.tasks || []).filter(function (t) {
      var s = Number(t.task_status)
      var hist = t.void_at || [80, 110, 150].indexOf(s) >= 0
      if (!allMode && !hist) return false
      if (flt !== '' && String(s) !== flt) return false
      if (q) {
        if (String(t.id).indexOf(q) >= 0) return true
        if (String(t.platform_task_id || '').toLowerCase().indexOf(q) >= 0) return true
        var o = (state.orders || []).find(function (x) { return x.id === t.order_id })
        if (o && String(o.order_no || '').toLowerCase().indexOf(q) >= 0) return true
        var b = (state.batches || []).find(function (x) { return x.id === t.batch_id })
        return b && String(b.batch_no || '').toLowerCase().indexOf(q) >= 0
      }
      return true
    })
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-truck"/></svg>' + (q || flt ? '没有符合条件的任务' : '暂无配送任务') + '</div>'
      return
    }
    var head = '<div class="tblwrap"><table><thead><tr>'
      + '<th style="width:34px"><input type="checkbox" class="ck" onchange="window.toggleSelAll(\'task\',this.checked,\'' + page + '\')"></th>'
      + '<th>ID</th><th>订单</th><th>批次</th><th>平台任务 ID</th><th>状态</th><th>停留</th><th>设备</th><th>操作</th>'
      + '</tr></thead><tbody>'
    var body = rows.map(function (t) {
      var active = [80, 110, 150].indexOf(Number(t.task_status)) < 0 && !t.void_at
      var ops = active
        ? '<button class="btn danger ghost sm" onclick="window.actCloseVoid(' + t.id + ')">关闭并作废</button> <button class="btn ghost sm" onclick="window.actVoid(' + t.id + ')">仅作废</button>'
        : '<span class="mini">终态</span>'
      return '<tr class="ctx-hit" oncontextmenu="window.ctxTask(' + t.id + ',event)">'
        + '<td><input type="checkbox" class="ck" data-type="task" data-id="' + t.id + '" onchange="window.toggleSel(\'task\',' + t.id + ',this.checked)"></td>'
        + '<td><b>' + t.id + '</b></td><td>' + (t.order_id || '—') + '</td><td>' + (t.batch_id || '—') + '</td>'
        + '<td class="num">' + esc(t.platform_task_id || '—') + '</td><td>' + taskTag(t) + '</td><td>' + ageCell(t.updated_at) + '</td>'
        + '<td>' + esc(t.device_sn || '—') + '</td><td class="row-ops">' + ops + '</td></tr>'
    }).join('')
    box.innerHTML = head + body + '</tbody></table></div>'
    updateSelUI(page)
  }

  // ---------- 平台任务表 ----------
  function renderPlatformPanel(q, flt) {
    var box = $('tasksPanelPlatform')
    if (!box) return
    var tasks = state.platform_tasks || []
    var rows = tasks.filter(function (t) {
      var st = Number(t.taskStatus)
      if (flt !== '' && String(st) !== flt) return false
      if (q) {
        if (String(t.id).toLowerCase().indexOf(q) >= 0) return true
        return (t.outOrderNo || []).some(function (on) { return String(on).toLowerCase().indexOf(q) >= 0 })
      }
      return true
    })
    if (!tasks.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-truck"/></svg>' + (state.platform_tasks_error ? esc(state.platform_tasks_error) : '暂无平台任务') + '</div>'
      return
    }
    if (!rows.length) {
      box.innerHTML = '<div class="empty">没有符合条件的平台任务</div>'
      return
    }
    var head = '<div class="tblwrap"><table><thead><tr>'
      + '<th style="width:34px"><input type="checkbox" class="ck" onchange="window.toggleSelAll(\'plat\',this.checked,\'tasks\')"></th>'
      + '<th>任务 ID</th><th>状态</th><th>状态停留</th><th>设备</th><th>订单</th><th>创建时间</th><th>操作</th>'
      + '</tr></thead><tbody>'
    var body = rows.map(function (t) {
      var st = Number(t.taskStatus)
      var age = ageCell(t.statusUpdateTime)
      var ops
      if (st === 1 || st === 80 || st === 110 || st === 150) ops = '<span class="mini">终态</span>'
      else if (st < 10) ops = '<button class="btn ghost sm" onclick="window.actCancel(\'' + t.id + '\')">取消</button>'
      else ops = '<button class="btn danger ghost sm" onclick="window.actClose(\'' + esc(t.deviceSn || '') + '\',\'' + t.id + '\')">关闭</button>'
      return '<tr class="ctx-hit" oncontextmenu="window.ctxPlat(' + t.id + ',event)">'
        + '<td><input type="checkbox" class="ck" data-type="plat" data-id="' + t.id + '" onchange="window.toggleSel(\'plat\',this.dataset.id,this.checked)"></td>'
        + '<td><b class="num">' + esc(t.id) + '</b></td><td>' + taskTag(t) + '</td><td>' + age + '</td>'
        + '<td>' + esc(t.deviceSn || '—') + '</td><td>' + esc((t.outOrderNo || []).join('、') || '—') + '</td>'
        + '<td>' + esc(t.createTime || '—') + '</td><td class="row-ops">' + ops + '</td></tr>'
    }).join('')
    box.innerHTML = head + body + '</tbody></table></div>'
    updateSelUI('tasks')
  }

  // ---------- 历史记录页 ----------
  function renderHistoryPage() {
    if (!state) return
    var q = searchQ.history
    var flt = statusFilter.history
    if (historyTab === 'batches') {
      renderBatchPanel('historyPanelBatches', true, q, flt, 'history')
    } else if (historyTab === 'orders') {
      renderOrderPanel('historyPanelOrders', false, q, flt, 'history')
    } else {
      renderLocalTaskPanel('historyPanelTasks', false, q, flt, 'history')
    }
    // 非当前标签面板也保持内容一致（懒渲染：仅当前）
    var hc = $('histCount')
    if (hc) {
      var n = (state.batches || []).filter(function (b) { return [3, 4].indexOf(Number(b.status)) >= 0 }).length
        + (state.orders || []).filter(function (o) { return [4, 5, 7].indexOf(Number(o.status)) >= 0 }).length
        + (state.tasks || []).filter(function (t) { return t.void_at || [80, 110, 150].indexOf(Number(t.task_status)) >= 0 }).length
      hc.textContent = n
    }
  }