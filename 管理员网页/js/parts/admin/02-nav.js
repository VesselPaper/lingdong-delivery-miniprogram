
  // ---------- 导航 ----------
  var PAGE_META = {
    overview: { title: '总览', sub: '机器人状态、异常与死锁监控' },
    tasks: { title: '配送任务', sub: '正在执行的任务与本地数据管理' },
    history: { title: '历史记录', sub: '已完成与已取消的批次、订单、任务' },
    settings: { title: '设置', sub: '令牌、控制权、点位与危险操作' }
  }
  function navTo(page) {
    if (!PAGE_META[page]) return
    document.querySelectorAll('.nav-item').forEach(function (el) { el.classList.remove('active') })
    var el = document.querySelector('.nav-item[data-page="' + page + '"]')
    if (el) el.classList.add('active')
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active') })
    var pg = document.getElementById('page-' + page)
    if (pg) pg.classList.add('active')
    $('pageTitle').textContent = PAGE_META[page].title
    $('pageSub').textContent = PAGE_META[page].sub
    // 切页时把内容滚动区滚回顶部（第一层导航、第二层报头固定不动）
    var sc = document.querySelector('.page-scroll')
    if (sc) sc.scrollTop = 0
    if (state && page === 'tasks') renderTasksPage()
    if (state && page === 'history') renderHistoryPage()
  }
  window.navTo = navTo

  // ---------- 标签页（子页面导航） ----------
  function wireTabs(id, onSwitch) {
    var root = $(id)
    if (!root) return
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab')
      if (!btn || btn.classList.contains('active')) return
      root.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === btn) })
      onSwitch(btn.dataset.tab)
    })
  }
  function setTabActive(containerId, key) {
    var root = $(containerId)
    if (!root) return
    root.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === key) })
  }
  // 面板切换：prefix + 首字母大写的 key → 匹配 id（如 settingsPanel+Token = settingsPanelToken）
  function showPanel(prefix, key, allKeys) {
    allKeys.forEach(function (k) {
      var p = $(prefix + k.charAt(0).toUpperCase() + k.slice(1))
      if (p) p.hidden = k !== key
    })
  }

  // 筛选下拉：按实体类型填充状态选项
  function fillStatusOptions(selectId, kind) {
    var s = $(selectId)
    if (!s) return
    var dict = kind === 'order' ? ORDER_STATUS : kind === 'batch' ? BATCH_STATUS : kind === 'exec' ? { 1: '待上货', 2: '配送中', 3: '待取货', err: '配送异常' } : TASK_STATUS
    var html = '<option value="">全部状态</option>'
    Object.keys(dict).forEach(function (k) { html += '<option value="' + k + '">' + esc(dict[k]) + '</option>' })
    s.innerHTML = html
  }

  function tasksKind(tab) {
    return tab === 'exec' ? 'exec' : tab === 'batches' ? 'batch' : 'order'
  }
  function historyKind(tab) {
    return tab === 'orders' ? 'order' : tab === 'tasks' ? 'task' : 'batch'
  }

  // ---------- 任务页 ----------
  var tasksTab = 'exec'
  wireTabs('tasksTabs', function (tab) {
    tasksTab = tab
    statusFilter.tasks = ''
    $('tasksStatus').value = ''
    fillStatusOptions('tasksStatus', tasksKind(tab))
    clearSel()
    showPanel('tasksPanel', tab, ['exec', 'batches', 'orders'])
    renderTasksPage()
  })

  var historyTab = 'batches'
  wireTabs('historyTabs', function (tab) {
    historyTab = tab
    statusFilter.history = ''
    $('historyStatus').value = ''
    fillStatusOptions('historyStatus', historyKind(tab))
    clearSel()
    showPanel('historyPanel', tab, ['batches', 'orders', 'tasks'])
    renderHistoryPage()
  })

  // 设置页标签
  wireTabs('settingsTabs', function (tab) {
    showPanel('settingsPanel', tab, ['token', 'control', 'danger'])
  })

  // 总览页标签
  var overviewTab = 'robot'
  wireTabs('overviewTabs', function (tab) {
    overviewTab = tab
    showPanel('overviewPanel', tab, ['robot', 'dict', 'log'])
    if (tab === 'robot' && window.invalidateAdminMap) window.invalidateAdminMap()
  })

  // 搜索框（防抖）
  function wireSearch(inputId, key, render) {
    var inp = $(inputId)
    if (!inp) return
    inp.addEventListener('input', function () {
      clearTimeout(inp._t)
      inp._t = setTimeout(function () {
        searchQ[key] = inp.value.trim().toLowerCase()
        if (key === 'tasks') { maybeAutoExpandByOrderNo('tasks'); renderTasksPage() }
        else { maybeAutoExpandByOrderNo('history'); renderHistoryPage() }
      }, 160)
    })
  }

  // 按订单号搜到批次时自动展开对应批次
  function maybeAutoExpandByOrderNo(page) {
    if (!state) return
    var q = searchQ[page]
    if (!q || !/^[a-z0-9]+$/.test(q)) return
    ;(state.batches || []).forEach(function (b) {
      var hit = (state.orders || []).some(function (o) {
        return o.batch_id === b.id && String(o.order_no || '').toLowerCase() === q
      })
      if (hit && !expandedSet.has(b.id)) {
        expandedSet.add(b.id)
        if (!batchOrdersCache[b.id]) {
          api('/batch/orders?batch_id=' + b.id).then(function (d) {
            batchOrdersCache[b.id] = (d && d.orders) || []
            if (page === 'tasks') renderTasksPage(); else renderHistoryPage()
          }).catch(function () { batchOrdersCache[b.id] = [] })
        }
      }
    })
  }
