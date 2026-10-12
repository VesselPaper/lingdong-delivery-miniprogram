
  // ---------- 导航（总览 / 商家管理 / 设置） ----------
  // 2026-10-12：「配送数据」整页删除（订单相关操作全在商家端小程序），导航从 4 项回到 3 项
  var PAGE_META = {
    overview: { title: '总览', sub: '机器人状态、异常与死锁监控' },
    merchants: { title: '商家管理', sub: '商家账号的创建、角色与状态维护' },
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
    if (page === 'overview') {
      if (window.invalidateAdminMap) window.invalidateAdminMap()
      if (overviewTab === 'log') loadAudit()
    }
    if (page === 'merchants') loadMerchants()
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
  // 面板切换：prefix + 首字母大写的 key → 匹配 id（如 merchantsPanel+list = merchantsPanelList）
  function showPanel(prefix, key, allKeys) {
    allKeys.forEach(function (k) {
      var p = $(prefix + k.charAt(0).toUpperCase() + k.slice(1))
      if (p) p.hidden = k !== key
    })
  }

  // ---------- 总览页标签（机器人 / 操作日志） ----------
  var overviewTab = 'robot'
  wireTabs('overviewTabs', function (tab) {
    overviewTab = tab
    showPanel('overviewPanel', tab, ['robot', 'log'])
    if (tab === 'robot' && window.invalidateAdminMap) window.invalidateAdminMap()
    if (tab === 'log') loadAudit()
  })

  // ---------- 设置页标签（账号 / 危险操作；机器人控制页已移除：控制权与点位同步均由业务自动管理） ----------
  wireTabs('settingsTabs', function (tab) {
    showPanel('settingsPanel', tab, ['account', 'danger'])
  })

  // ---------- 商家管理页标签（创建 / 已创建） ----------
  wireTabs('merchantsTabs', function (tab) {
    showPanel('merchantsPanel', tab, ['create', 'list'])
    if (tab === 'list') loadMerchants()
  })
