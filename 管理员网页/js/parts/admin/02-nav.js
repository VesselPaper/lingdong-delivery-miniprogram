
  // ---------- 导航（三项：总览 / 配送数据 / 设置） ----------
  var PAGE_META = {
    overview: { title: '总览', sub: '机器人状态、异常与死锁监控' },
    data: { title: '配送数据', sub: '批次 / 订单 / 任务的搜索、状态与详情' },
    settings: { title: '设置', sub: '账号、控制权、点位与危险操作' }
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
    // 切页时把该页内容滚动区滚回顶部（导航与报头/页面头固定不动）
    var pgEl = document.getElementById('page-' + page)
    var sc = pgEl ? pgEl.querySelector('.page-body') : null
    if (sc) sc.scrollTop = 0
    if (state && page === 'data') renderDataPage()
    if (page === 'overview') {
      if (window.invalidateAdminMap) window.invalidateAdminMap()
      if (overviewTab === 'log') loadAudit()
    }
  }
  window.navTo = navTo

  // ---------- 标签页（页面头内的子导航） ----------
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
  // 面板切换：prefix + 首字母大写的 key → 匹配 id（如 dataPanel+batch = dataPanelBatch）
  function showPanel(prefix, key, allKeys) {
    allKeys.forEach(function (k) {
      var p = $(prefix + k.charAt(0).toUpperCase() + k.slice(1))
      if (p) p.hidden = k !== key
    })
  }

  // ---------- 筛选下拉：按实体类型填充状态选项 ----------
  function fillStatusOptions(kind) {
    var s = $('dataStatus')
    if (!s) return
    var dict = kind === 'order' ? ORDER_STATUS : kind === 'task' ? TASK_STATUS : BATCH_STATUS
    var html = '<option value="">全部状态</option>'
    Object.keys(dict).forEach(function (k) { html += '<option value="' + k + '">' + esc(dict[k]) + '</option>' })
    s.innerHTML = html
  }

  // ---------- 总览页标签（机器人 / 操作日志） ----------
  var overviewTab = 'robot'
  wireTabs('overviewTabs', function (tab) {
    overviewTab = tab
    showPanel('overviewPanel', tab, ['robot', 'log'])
    if (tab === 'robot' && window.invalidateAdminMap) window.invalidateAdminMap()
    if (tab === 'log') loadAudit()
  })

  // ---------- 配送数据页标签（批次 / 订单 / 任务） ----------
  wireTabs('dataTabs', function (tab) {
    dataTab = tab
    statusFilter = ''
    var sel = $('dataStatus'); if (sel) sel.value = ''
    fillStatusOptions(tab)
    showPanel('dataPanel', tab, ['batch', 'order', 'task'])
    renderDataPage()
  })

  // ---------- 配送数据页分段（活跃 / 历史 / 全部） ----------
  var scopeRoot = $('dataScope')
  if (scopeRoot) {
    scopeRoot.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn')
      if (!btn || btn.classList.contains('active')) return
      scopeRoot.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b === btn) })
      dataScope = btn.dataset.scope || 'active'
      renderDataPage()
    })
  }

  // ---------- 状态筛选 ----------
  var statusSel = $('dataStatus')
  if (statusSel) {
    statusSel.addEventListener('change', function () {
      statusFilter = this.value
      renderDataPage()
    })
  }

  // ---------- 设置页标签（账号 / 机器人控制 / 危险操作） ----------
  wireTabs('settingsTabs', function (tab) {
    showPanel('settingsPanel', tab, ['account', 'robot', 'danger'])
  })

  // ---------- 搜索框（防抖；跨批次号/订单号/任务号/点位/商品名） ----------
  function wireSearch(inputId) {
    var inp = $(inputId)
    if (!inp) return
    inp.addEventListener('input', function () {
      clearTimeout(inp._t)
      inp._t = setTimeout(function () {
        searchQ = inp.value.trim().toLowerCase()
        renderDataPage()
      }, 160)
    })
  }
