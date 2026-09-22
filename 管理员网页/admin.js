/* ============================================================
   零栋送餐 · 调度台 —— 管理员前端逻辑 v4
   ------------------------------------------------------------
   本文件是 IIFE 的第一片（01-core）：头部注释、常量、基础工具。
   收尾（启动 + `})()`）在最后一片 09-ops.js。

   页面结构（2026-09 重构）：
   · 总览：机器人（卡片 + 校园实时地图 + 异常告警）/ 操作日志（服务端审计 + 状态字典 + 会话回显）
   · 配送数据：批次 / 订单 / 任务 三标签 × 活跃 / 历史 / 全部 三分段，卡片式展示
   · 设置：账号 / 机器人控制 / 危险操作

   交互约定（铁律）：
   · 破坏性操作（删除订单 / 清理批次 / 关闭并作废 / 仅作废）只从右键菜单进入，无行内按钮；
     卡片整卡点击 = 打开详情抽屉。
   · 所有删除 / 清理 / 关闭操作均走后端统一落账（作废任务 + 回补库存 + 摘批次 + 平台召回），
     保证机器人状态、用户端、商家端同步，杜绝死锁。
   · 操作日志读服务端 audit_logs（成功与失败都在），前端内存日志只作会话回显。
   ============================================================ */
(function () {
  'use strict'
  var TOKEN_KEY = 'lingdong_admin_token'

  var TASK_STATUS = {
    0: '排队中', 1: '已取消', 10: '已接收', 20: '去往上货点', 30: '到达上货点',
    40: '上货中', 50: '已上货', 60: '去往取货点', 70: '到达取货点', 71: '等待取餐',
    80: '完成', 90: '上货失败', 100: '取货失败', 110: '已取消', 120: '挂起', 150: '已关闭'
  }
  var MACHINE_TEXT = {
    idle: '空状态', init: '初始化', setting: '设置', charging: '正在充电', returnChargingPile: '返回充电桩',
    standby: '待机中', returnStandby: '前往待机', exception: '异常', lightTask: '召唤', update: '升级',
    interaction: '交互', patrol: '巡逻中', Delivery: '配送中', delivery: '配送中', remoteDevOps: '远程运维'
  }
  var ORDER_STATUS = { 0: '待支付', 1: '待接单', 2: '配送中', 3: '已送达', 4: '已完成', 5: '已取消', 6: '配送异常', 7: '已退款' }
  var BATCH_STATUS = { 0: '组单中', 1: '待上货', 2: '配送中', 3: '已完成', 4: '已取消' }

  // 各实体的「活跃」判定（与后端 admin 域 history 口径一致）
  var ACTIVE_STATUS = { batch: [0, 1, 2], order: [2, 3, 6], task: null }

  var $ = function (id) { return document.getElementById(id) }
  var state = null                // GET /api/admin/state 的聚合结果
  var dataTab = 'batch'           // batch | order | task
  var dataScope = 'active'        // active | history | all
  var searchQ = ''
  var statusFilter = ''
  var liveRobots = []             // 最近一次 WS live 推送的机器人位置（供抽屉显示实时位置）
  var toastTimer = null
  var busy = false                // 状态拉取防重入
  var currentAdmin = null         // 当前登录的管理员（方案A：账号密码登录）
  var onUnauthorized = null       // 会话失效回调（由 06 片设置 → 弹登录页）

  // ---------- 基础工具 ----------
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;') }

  function log(msg, cls) {
    var box = $('log')
    if (!box) return
    var line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg
    box.innerHTML = (cls ? '<span class="' + cls + '">' : '') + line.replace(/</g, '&lt;') + (cls ? '</span>' : '') + '\n' + box.innerHTML
  }

  function toast(msg, cls) {
    var t = $('toast')
    if (!t) return
    var ico = cls === 'ok' ? '<svg><use href="#i-check"/></svg>' : cls === 'err' ? '<svg><use href="#i-close"/></svg>' : '<svg><use href="#i-warn"/></svg>'
    t.className = 'toast ' + (cls || '')
    t.innerHTML = ico + esc(msg)
    t.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { t.hidden = true }, 3400)
  }

  // 管理员会话 token（方案A：登录签发的随机 session token，存 localStorage）
  function token() { return localStorage.getItem(TOKEN_KEY) || '' }

  function api(path, method, body) {
    return fetch('/api/admin' + path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token() },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (j) {
        var err = new Error(j.msg || ('HTTP ' + r.status))
        err.status = r.status
        err.code = j.code
        // 登录接口自身的 401（密码错误）不触发全局会话失效回调，否则会清空用户刚输入的账号密码
        if (r.status === 401 && path !== '/login') { if (onUnauthorized) onUnauthorized(); throw err }
        if (r.status === 401) throw err
        if (j.code !== 0 && j.code !== undefined) throw err
        return j.data
      })
    })
  }

  function isUnauthorized(e) { return !!(e && e.status === 401) }

  function setAuthBanner(text, isError) {
    var box = $('authBanner')
    if (!box) return
    if (!text) { box.hidden = true; box.innerHTML = ''; return }
    box.hidden = false
    box.innerHTML = '<svg><use href="#i-warn"/></svg><span>' + esc(text) + '</span>'
      + (isError ? '<span class="hint">请重新登录后再操作</span>' : '')
  }

  // ---------- 状态色（不同状态不同颜色） ----------
  function tag(text, cls) { return '<span class="tag ' + (cls || '') + '">' + esc(text) + '</span>' }

  function orderTag(o) {
    var s = Number(o.status)
    var cls = s === 2 ? 'blue' : s === 3 ? 'violet' : s === 4 ? 'green' : s === 6 ? 'red' : (s === 1 ? 'orange' : 'gray')
    return tag(ORDER_STATUS[s] || ('状态 ' + s), cls)
  }
  function batchTag(b) {
    var s = Number(b.status)
    var cls = s === 0 || s === 1 ? 'orange' : s === 2 ? 'blue' : s === 3 ? 'green' : 'gray'
    return tag(b.status_text && [3, 4].indexOf(s) >= 0 ? b.status_text : (BATCH_STATUS[s] || ('状态 ' + s)), cls)
  }
  function taskTag(t) {
    var s = Number(t.task_status !== undefined ? t.task_status : t.taskStatus)
    var txt = t.status_text || TASK_STATUS[s] || ('状态 ' + s)
    var cls = s === 80 ? 'green' : ([90, 100, 120].indexOf(s) >= 0 ? 'red' : ([1, 110, 150].indexOf(s) >= 0 ? 'gray' : (s >= 50 && s < 80 ? 'blue' : 'orange')))
    return tag(txt, cls)
  }

  // 批次卡整行头部的底色（按状态取色；与 .bcard-head 的 --bh 变量配合）
  function batchHeadColor(b) {
    var s = Number(b.status)
    return s === 2 ? 'var(--blue)' : s === 3 ? 'var(--ok)' : (s === 0 || s === 1) ? 'var(--amber)' : 'var(--ink-3)'
  }
  // 时间线节点圆点配色
  function statusDotClass(type, status) {
    var s = Number(status)
    if (type === 'order') return s === 4 ? 'ok' : s === 2 ? 'busy' : s === 3 ? 'wait' : (s === 5 || s === 7 || s === 6) ? 'bad' : 'warn'
    if (type === 'batch') return s === 3 ? 'ok' : s === 2 ? 'busy' : s === 4 ? 'bad' : 'warn'
    return s === 80 ? 'ok' : [90, 100, 120].indexOf(s) >= 0 ? 'bad' : [1, 110, 150].indexOf(s) >= 0 ? 'bad' : (s >= 50 && s < 80 ? 'wait' : 'busy')
  }

  function ageLabel(dtStr) {
    if (!dtStr) return { text: '—', cls: '' }
    var t = new Date(String(dtStr).replace(' ', 'T')).getTime()
    if (isNaN(t)) return { text: esc(dtStr), cls: '' }
    var mins = Math.floor((Date.now() - t) / 60000)
    if (mins < 1) return { text: '刚刚', cls: '' }
    if (mins < 60) return { text: mins + ' 分钟', cls: mins > 20 ? 'stale-soft' : '' }
    var hrs = Math.floor(mins / 60)
    if (hrs < 24) return { text: hrs + ' 小时 ' + (mins % 60) + ' 分', cls: 'stale' }
    var days = Math.floor(hrs / 24)
    return { text: days + ' 天 ' + (hrs % 24) + ' 小时', cls: 'stale' }
  }

  function ageCell(dtStr) {
    var a = ageLabel(dtStr)
    return a.cls ? '<span class="' + a.cls + '">' + a.text + '</span>' : esc(a.text)
  }

  // 「最近变更」摘要：来自 status_events 的最新一条
  function lastEventText(e) {
    if (!e) return '—'
    return esc(e.created_at || '') + ' · ' + esc(e.status_text || '')
  }


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


  // ---------- 主渲染 ----------
  function render() {
    if (!state) return
    renderOverview()
    renderDataPage()
    renderNavCount()
  }

  function renderOverview() {
    // 异常与死锁告警（运维信息，与机器人同屏）
    var alerts = state.alerts || []
    var ac = $('alertCount')
    if (ac) {
      ac.textContent = alerts.length
      ac.className = 'tag ' + (alerts.some(function (a) { return a.level === 'bad' }) ? 'red' : (alerts.length ? 'orange' : 'green'))
    }
    var ab = $('alertsBox')
    if (ab) {
      ab.innerHTML = alerts.length
        ? alerts.map(function (a) { return '<div class="alert ' + a.level + '">' + esc(a.text) + '</div>' }).join('')
        : '<div class="alert ok">未检测到异常或死锁</div>'
    }
    renderRobotCard()
    // 状态字典（折叠卡内，低频参考）
    var dict = $('dictBox')
    if (dict) {
      dict.innerHTML = Object.keys(TASK_STATUS).map(function (k) { return '<span>' + k + ' <b>' + TASK_STATUS[k] + '</b></span>' }).join('')
        + '<span class="divider">机器状态</span>'
        + Object.keys(MACHINE_TEXT).map(function (k) { return '<span>' + k + ' <b>' + MACHINE_TEXT[k] + '</b></span>' }).join('')
    }
  }

  // 机器人卡片渲染（独立函数：WS live 事件每 ~2.5s 推机器状态，原地刷新卡片不整页重绘）
  function renderRobotCard() {
    var r = state && state.robot
    var tagEl = $('robotTag')
    if (tagEl) {
      tagEl.textContent = r ? (r.online ? '在线' : '离线') : '无设备'
      tagEl.className = 'tag ' + (r && r.online ? 'green' : 'red')
    }
    var snEl = $('rSn')
    if (snEl) snEl.textContent = r ? r.device_sn : ((state && state.robot_error) || '—')
    if (r) {
      var mt = r.machine_text || MACHINE_TEXT[r.machine_status] || r.machine_status || '未知'
      var mCls = r.machine_status === 'exception' ? 'stale' : (r.machine_status === 'charging' ? 'stale-soft' : '')
      $('rMachine').innerHTML = '<span class="' + mCls + '">' + esc(r.machine_status + '（' + mt + '）') + '</span>'
      var age = ageLabel(r.status_update_time)
      $('rMachineAge').innerHTML = age.cls ? '<span class="' + age.cls + '">' + age.text + '</span>' : esc(age.text)
      $('rStatusTime').textContent = r.status_update_time || '—'
      $('rFloor').textContent = (r.floor || '—') + ' · ' + esc(r.building || '—')
    } else {
      $('rMachine').textContent = '—'
      $('rMachineAge').textContent = '—'
      $('rStatusTime').textContent = '—'
      $('rFloor').textContent = '—'
    }
    $('rBattery').textContent = r ? (r.battery === null || r.battery === undefined ? '—' : r.battery + '%') : '—'
    $('rOnline').textContent = r ? (r.online ? '在线' : '离线') : '—'
    var bs = r && r.busy_stocks
    $('rStocks').textContent = (Array.isArray(bs) ? bs.join('、') : bs) || '—'
    $('rMap').textContent = (r && r.curr_map_id) ? r.curr_map_id : '—'
  }

  // ---------- 实时推送（WebSocket 事件驱动，替代轮询） ----------
  // 前端不轮询：连 /ws 订阅 admin/live，后端推送：
  //   {type:'live', robots, robot}  → 原地更新地图小车 + 机器人卡片 + 抽屉实时位置
  //   {type:'state_changed'}        → 数据有变，拉一次 /api/admin/state
  var ws = null
  var wsReconnectTimer = null

  function wsURL() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return proto + '//' + location.host + '/ws?token=' + encodeURIComponent(token()) + '&src=admin'
  }
  function connectWS() {
    if (!token()) return
    if (ws) { try { ws.close() } catch (e) {} ws = null }
    var sock = new WebSocket(wsURL())
    ws = sock
    sock.onopen = function () {
      try { sock.send(JSON.stringify({ type: 'sub', topics: ['admin/live'] })) } catch (e) {}
      log('实时推送已连接（事件驱动，无需轮询）', 'green')
      if (!busy) refresh()             // 连上先拉一次最新全量（含断线重连场景）
      if (window.reloadAdminMap) window.reloadAdminMap() // 底图/点位/配送站位拉最新
      if (window.invalidateAdminMap) window.invalidateAdminMap()
    }
    sock.onmessage = function (ev) {
      var m
      try { m = JSON.parse(ev.data) } catch (e) { return }
      if (!m || !m.type) return
      if (m.type === 'live') {
        if (Array.isArray(m.robots)) {
          liveRobots = m.robots
          if (window.mapOnLive) window.mapOnLive(m.robots)
          // 抽屉若正开着，原地刷新它的实时位置段（不整页重绘）
          if (drawerCtx && typeof renderDrawerLive === 'function') renderDrawerLive()
        }
        if (m.robot && state) { state.robot = m.robot; renderRobotCard() }
      } else if (m.type === 'state_changed') {
        if (!busy && state) refresh()
      }
    }
    sock.onclose = function () { if (ws === sock) { ws = null; scheduleReconnect() } }
    sock.onerror = function () { try { sock.close() } catch (e) {} }
  }
  function scheduleReconnect() {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = setTimeout(connectWS, 4000)
  }

  // 侧栏「配送数据」徽标：活跃批次 + 活跃订单 + 未完成任务的合计
  function renderNavCount() {
    var activeTotal = (state.batches || []).filter(function (b) { return [0, 1, 2].indexOf(Number(b.status)) >= 0 }).length
      + (state.orders || []).filter(function (o) { return [2, 3, 6].indexOf(Number(o.status)) >= 0 }).length
      + (state.tasks || []).filter(function (t) { return Number(t.task_status) < 80 && !t.void_at }).length
    var navCnt = $('navTaskCount')
    if (navCnt) {
      navCnt.textContent = activeTotal
      navCnt.className = 'nav-count' + (activeTotal ? ' red' : '')
    }
  }


  // ---------- 配送数据页：卡片渲染（批次卡包裹订单子卡 / 订单卡 / 任务卡） ----------
  // 取代原先的表格 + 多选批量体系：
  //   · 整卡点击 → 打开详情抽屉（时间线 + 实时位置 + 商品明细）
  //   · 右键 → 复制编号 / 在地图查看 / 破坏性操作（唯一入口）
  //   · 活跃 / 历史 / 全部 分段 + 状态筛选 + 搜索 在渲染前统一过滤

  function renderDataPage() {
    if (!state) return
    var count = 0
    if (dataTab === 'order') count = renderOrderCards()
    else if (dataTab === 'task') count = renderTaskCards()
    else count = renderBatchCards()
    var box = $('dataCount')
    if (box) box.textContent = count ? ('共 ' + count + ' 张卡') : ''
  }

  // ---------- 过滤 ----------
  // 分段口径：活跃 / 历史 / 全部（与后端 admin 域 active/history 的判定一致）
  function inScope(kind, row) {
    if (dataScope === 'all') return true
    if (kind === 'batch') {
      var isActive = [0, 1, 2].indexOf(Number(row.status)) >= 0
      return dataScope === 'active' ? isActive : !isActive
    }
    if (kind === 'order') {
      var oActive = [2, 3, 6].indexOf(Number(row.status)) >= 0
      return dataScope === 'active' ? oActive : !oActive
    }
    var tActive = !row.void_at && Number(row.task_status) < 80
    return dataScope === 'active' ? tActive : !tActive
  }
  function inStatus(status) {
    if (statusFilter === '') return true
    return String(status) === statusFilter
  }
  function hit(q, vals) {
    if (!q) return true
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] !== undefined && vals[i] !== null && String(vals[i]).toLowerCase().indexOf(q) >= 0) return true
    }
    return false
  }
  function goodsNames(o) {
    return (o.items || []).map(function (it) { return it.goods_name }).filter(Boolean)
  }

  // ---------- 订单：商品明细行（最多 6 行，其余折叠成一行） ----------
  function orderGoodsRows(o, limit) {
    var items = o.items || []
    if (!items.length) return '<div class="o-row"><span class="o-name mini">（无商品明细）</span></div>'
    var max = limit || 6
    var rows = items.slice(0, max).map(function (it) {
      var img = it.goods_image
        ? '<img class="o-thumb" src="' + esc(it.goods_image) + '" alt="" onerror="this.style.display=\'none\'">'
        : '<span class="o-thumb ph"></span>'
      return '<div class="o-row">' + img
        + '<span class="o-name">' + esc(it.goods_name) + '</span>'
        + '<span class="o-qty">× ' + Number(it.quantity || 0) + '</span>'
        + '<span class="o-price">¥' + Number(it.price || 0).toFixed(2) + '</span></div>'
    }).join('')
    if (items.length > max) rows += '<div class="o-row"><span class="o-name mini">等 ' + items.length + ' 项商品</span></div>'
    return rows
  }

  // ---------- 批次卡（内含订单子卡） ----------
  function batchCardHtml(b, ordersOfBatch) {
    var lines = []
    if (b.device_sn) lines.push('<div class="bcard-line"><span class="k">机器人</span><span class="v mono">' + esc(b.device_sn) + '</span></div>')
    if (Number(b.total_items)) lines.push('<div class="bcard-line"><span class="k">件数</span><span class="v">' + Number(b.total_items) + ' 件</span></div>')
    var rt = batchRouteText(b)
    if (rt) lines.push('<div class="bcard-line"><span class="k">路线</span><span class="v">' + esc(rt) + '</span></div>')
    if (Number(b.status) === 2) {
      lines.push('<div class="bcard-line"><span class="k">当前停靠</span><span class="v">' + esc(currentStopText(b)) + '</span></div>')
      lines.push('<div class="bcard-line"><span class="k">进度</span><span class="v">已取 ' + Number(b.picked_orders || 0) + ' / ' + Number(b.total_orders || 0) + ' 单</span></div>')
    }
    lines.push('<div class="bcard-line"><span class="k">创建</span><span class="v weak">' + esc(b.created_at || '—') + '</span></div>')
    lines.push('<div class="bcard-line"><span class="k">最近变更</span><span class="v weak">' + lastEventText(b.last_event) + '</span></div>')

    var subs = ordersOfBatch.map(function (o) { return orderSubCardHtml(o) }).join('')
    var subWrap = ordersOfBatch.length
      ? '<div class="bcard-orders">' + subs + '</div>'
      : '<div class="bcard-more">该批次暂无可展示的订单明细</div>'

    return '<div class="bcard" data-kind="batch" data-id="' + b.id + '" tabindex="0"'
      + ' oncontextmenu="window.ctxBatch(' + b.id + ',event)" onclick="openDrawer(\'batch\',' + b.id + ')"'
      + ' onkeydown="if(event.key===\'Enter\')openDrawer(\'batch\',' + b.id + ')">'
      + '<div class="bcard-head" style="--bh:' + batchHeadColor(b) + '">'
      + '<div class="bcard-title"><b>批次 ' + esc(b.code_short || b.daily_seq || b.id) + '</b>'
      + '<span class="full">' + esc(b.batch_no || '') + '</span></div>'
      + '<div class="bcard-tags">'
      + '<span class="tag solid">' + esc(b.status_text || BATCH_STATUS[Number(b.status)] || '') + '</span>'
      + '<span class="tag">' + Number(b.total_orders || 0) + ' 单</span>'
      + '</div></div>'
      + '<div class="bcard-body">' + lines.join('') + subWrap
      + '<div class="bcard-more">点击卡片查看详情与状态时间线 · 右键打开操作菜单</div>'
      + '</div></div>'
  }

  function orderSubCardHtml(o) {
    return '<div class="bcard-order" data-kind="order" data-id="' + o.id + '"'
      + ' oncontextmenu="window.ctxOrder(' + o.id + ',event)"'
      + ' onclick="event.stopPropagation();openDrawer(\'order\',' + o.id + ')">'
      + '<div class="bcard-order-head"><b>订单 ' + esc(o.code_short || o.daily_seq || o.id) + '</b>'
      + '<span class="lm">' + esc(o.landmark_name || '未选点位') + '</span>'
      + '<span class="st">' + orderTag(o) + '</span></div>'
      + '<div class="bcard-order-body">' + orderGoodsRows(o, 4) + '</div>'
      + '<div class="bcard-order-foot">'
      + '<span>取餐码 <b>' + esc(o.pickup_code || '—') + '</b></span>'
      + '<span>金额 <b>¥' + Number(o.total_amount || 0).toFixed(2) + '</b></span>'
      + '</div></div>'
  }

  function renderBatchCards() {
    var box = $('dataPanelBatch')
    if (!box) return 0
    var q = searchQ
    var all = state.batches || []
    var orders = state.orders || []
    var byBatch = {}
    orders.forEach(function (o) { if (o.batch_id) (byBatch[o.batch_id] = byBatch[o.batch_id] || []).push(o) })

    var rows = all.filter(function (b) {
      if (!inScope('batch', b)) return false
      if (!inStatus(b.status)) return false
      var mine = byBatch[b.id] || []
      var vals = [b.batch_no, b.code_short, b.daily_seq, b.device_sn, batchRouteText(b)]
      mine.forEach(function (o) { vals.push(o.order_no, o.code_short, o.landmark_name); vals = vals.concat(goodsNames(o)) })
      return hit(q, vals)
    })

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-box"/></svg>'
        + (q || statusFilter ? '没有符合条件的批次' : (dataScope === 'history' ? '暂无历史批次' : dataScope === 'all' ? '暂无批次' : '暂无活跃批次'))
        + '</div>'
      return 0
    }
    box.innerHTML = '<div class="cards">' + rows.map(function (b) { return batchCardHtml(b, byBatch[b.id] || []) }).join('') + '</div>'
    return rows.length
  }

  // ---------- 订单卡（扁平列表） ----------
  function renderOrderCards() {
    var box = $('dataPanelOrder')
    if (!box) return 0
    var q = searchQ
    var batchNo = {}
    ;(state.batches || []).forEach(function (b) { batchNo[b.id] = b.batch_no })

    var rows = (state.orders || []).filter(function (o) {
      if (!inScope('order', o)) return false
      if (!inStatus(o.status)) return false
      var vals = [o.order_no, o.code_short, o.daily_seq, o.landmark_name, o.pickup_code, o.device_sn, batchNo[o.batch_id]]
      vals = vals.concat(goodsNames(o))
      return hit(q, vals)
    })

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-box"/></svg>'
        + (q || statusFilter ? '没有符合条件的订单' : (dataScope === 'history' ? '暂无历史订单' : dataScope === 'all' ? '暂无订单' : '暂无活跃订单'))
        + '</div>'
      return 0
    }
    box.innerHTML = '<div class="cards">' + rows.map(function (o) {
      return '<div class="bcard" data-kind="order" data-id="' + o.id + '" tabindex="0"'
        + ' oncontextmenu="window.ctxOrder(' + o.id + ',event)" onclick="openDrawer(\'order\',' + o.id + ')"'
        + ' onkeydown="if(event.key===\'Enter\')openDrawer(\'order\',' + o.id + ')">'
        + '<div class="bcard-head" style="--bh:var(--ink-3)">'
        + '<div class="bcard-title"><b>订单 ' + esc(o.code_short || o.daily_seq || o.id) + '</b>'
        + '<span class="full">' + esc(o.order_no || '') + '</span></div>'
        + '<div class="bcard-tags"><span class="tag solid">' + esc(ORDER_STATUS[Number(o.status)] || ('状态 ' + o.status)) + '</span></div>'
        + '</div>'
        + '<div class="bcard-body">'
        + '<div class="bcard-line"><span class="k">送达点位</span><span class="v">' + esc(o.landmark_name || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">批次</span><span class="v mono">' + esc(batchNo[o.batch_id] || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">机器人</span><span class="v mono">' + esc(o.device_sn || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">取餐码</span><span class="v">' + esc(o.pickup_code || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">金额</span><span class="v">¥' + Number(o.total_amount || 0).toFixed(2) + '</span></div>'
        + '<div class="bcard-line"><span class="k">创建</span><span class="v weak">' + esc(o.created_at || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">最近变更</span><span class="v weak">' + lastEventText(o.last_event) + '</span></div>'
        + '<div class="bcard-orders"><div class="bcard-order" style="cursor:default">'
        + '<div class="bcard-order-head"><b>商品明细</b><span class="st mini">' + (o.item_count || 0) + ' 件</span></div>'
        + '<div class="bcard-order-body">' + orderGoodsRows(o, 8) + '</div>'
        + '</div></div>'
        + '<div class="bcard-more">点击卡片查看详情与状态时间线 · 右键打开操作菜单</div>'
        + '</div></div>'
    }).join('') + '</div>'
    return rows.length
  }

  // ---------- 任务卡（扁平列表） ----------
  function renderTaskCards() {
    var box = $('dataPanelTask')
    if (!box) return 0
    var q = searchQ
    var orderNo = {}
    ;(state.orders || []).forEach(function (o) { orderNo[o.id] = o.order_no })
    var batchNo = {}
    ;(state.batches || []).forEach(function (b) { batchNo[b.id] = b.batch_no })

    var rows = (state.tasks || []).filter(function (t) {
      if (!inScope('task', t)) return false
      if (!inStatus(t.task_status)) return false
      return hit(q, [t.id, t.platform_task_id, t.device_sn, orderNo[t.order_id], batchNo[t.batch_id]])
    })

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-truck"/></svg>'
        + (q || statusFilter ? '没有符合条件的任务' : (dataScope === 'history' ? '暂无历史任务' : dataScope === 'all' ? '暂无配送任务' : '暂无活跃任务'))
        + '</div>'
      return 0
    }
    box.innerHTML = '<div class="cards">' + rows.map(function (t) {
      var voided = !!t.void_at
      return '<div class="tcard" data-kind="task" data-id="' + t.id + '" tabindex="0"'
        + ' oncontextmenu="window.ctxTask(' + t.id + ',event)" onclick="openDrawer(\'task\',' + t.id + ')"'
        + ' onkeydown="if(event.key===\'Enter\')openDrawer(\'task\',' + t.id + ')">'
        + '<div class="tcard-head"><b>任务 #' + t.id + '</b>'
        + '<span class="st">' + taskTag(t) + '</span></div>'
        + '<div class="tcard-line"><span class="k">订单</span><span class="v mono">' + esc(orderNo[t.order_id] || (t.order_id ? '#' + t.order_id : '—')) + '</span></div>'
        + '<div class="tcard-line"><span class="k">批次</span><span class="v mono">' + esc(batchNo[t.batch_id] || (t.batch_id ? '#' + t.batch_id : '—')) + '</span></div>'
        + '<div class="tcard-line"><span class="k">平台任务</span><span class="v mono">' + esc(t.platform_task_id || '—') + '</span></div>'
        + '<div class="tcard-line"><span class="k">设备</span><span class="v mono">' + esc(t.device_sn || '—') + '</span></div>'
        + '<div class="tcard-line"><span class="k">停留</span><span class="v">' + ageCell(t.updated_at) + '</span></div>'
        + '<div class="tcard-line"><span class="k">最近变更</span><span class="v weak">' + lastEventText(t.last_event) + '</span></div>'
        + (voided ? '<div class="tcard-line"><span class="k">作废于</span><span class="v weak">' + esc(t.void_at) + '</span></div>' : '')
        + '</div>'
    }).join('') + '</div>'
    return rows.length
  }


  // ---------- 刷新与认证（方案A：账号密码 → 随机 session token） ----------
  function refresh() {
    var tk = token()
    if (!tk) {
      setAuthBanner('未登录：请使用管理员账号登录', false)
      $('conn').textContent = '未登录'
      return
    }
    if (busy) return
    busy = true
    $('conn').textContent = '加载中…'
    setAuthBanner('')
    api('/state').then(function (d) {
      state = d
      render()
      $('conn').textContent = '更新于 ' + d.server_time
      log('状态已刷新（机器人 ' + (d.robot ? d.robot.machine_status : '无') + '，平台任务 ' + (d.platform_tasks || []).length + '，告警 ' + (d.alerts || []).length + '）')
    }).catch(function (e) {
      $('conn').textContent = ''
      if (isUnauthorized(e)) {
        state = null
        setAuthBanner('登录已过期：请重新登录', true)
        log('认证失败：' + e.message, 'bad')
      } else {
        setAuthBanner('')
        log('刷新失败：' + e.message, 'bad')
      }
    }).then(function () { busy = false })
  }

  // ---------- 登录 / 会话（方案A） ----------
  function showLogin() {
    var m = $('loginMask')
    if (m) m.hidden = false
    var u = $('loginUser')
    if (u) { u.value = ''; try { u.focus() } catch (e) {} }
    var p = $('loginPass'); if (p) p.value = ''
    var e = $('loginErr'); if (e) { e.hidden = true; e.textContent = '' }
    setAuthBanner('')
    var c = $('conn'); if (c) c.textContent = '未登录'
  }
  function hideLogin() { var m = $('loginMask'); if (m) m.hidden = true }

  function adminLogin() {
    var username = $('loginUser').value.trim()
    var password = $('loginPass').value
    var err = $('loginErr')
    if (!username || !password) { err.textContent = '请输入账号和密码'; err.hidden = false; return }
    $('loginBtn').disabled = true
    err.textContent = ''
    api('/login', 'POST', { username: username, password: password }).then(function (d) {
      localStorage.setItem(TOKEN_KEY, d.token)
      currentAdmin = d.admin
      hideLogin()
      renderAccountUI()
      log('管理员 ' + d.admin.username + ' 登录成功', 'green')
      refresh()
      connectWS()
    }).catch(function (e) {
      $('loginBtn').disabled = false
      err.textContent = (e && e.message) || '登录失败'
      err.hidden = false
      log('登录失败：' + ((e && e.message) || ''), 'bad')
    })
  }

  function logout() {
    var tk = token()
    if (tk) api('/logout', 'POST', {}).catch(function () {})
    localStorage.removeItem(TOKEN_KEY)
    currentAdmin = null
    state = null
    if (ws) { try { ws.close() } catch (e) {} ws = null }
    closeDrawer()
    showLogin()
    log('已退出登录', 'warn')
  }

  function changePassword() {
    var oldP = $('oldPass').value, np1 = $('np1').value, np2 = $('np2').value
    var msg = $('tokenMsg')
    if (!oldP || !np1) { msg.className = 'token-msg err'; msg.innerHTML = '请填写原密码与新密码'; return }
    if (np1 !== np2) { msg.className = 'token-msg err'; msg.innerHTML = '两次输入的新密码不一致'; return }
    if (np1.length < 8) { msg.className = 'token-msg err'; msg.innerHTML = '新密码至少 8 位'; return }
    api('/password', 'POST', { old_password: oldP, new_password: np1 }).then(function () {
      msg.className = 'token-msg ok'
      msg.innerHTML = '密码已修改，请重新登录'
      setTimeout(logout, 800)
    }).catch(function (e) {
      msg.className = 'token-msg err'
      msg.innerHTML = (e && e.message) || '修改失败'
    })
  }

  function renderAccountUI() {
    var a = $('accountName'), r = $('accountRole')
    if (a) a.textContent = currentAdmin ? currentAdmin.username : '—'
    if (r) r.textContent = currentAdmin
      ? (currentAdmin.nickname ? currentAdmin.nickname + ' · ' : '') + (currentAdmin.role || 'admin')
      : ''
    var msg = $('tokenMsg'); if (msg) { msg.className = 'token-msg'; msg.innerHTML = '' }
    ;[$('oldPass'), $('np1'), $('np2')].forEach(function (x) { if (x) x.value = '' })
  }

  // 会话失效（任意接口 401）统一回调 → 弹登录页
  onUnauthorized = function () {
    currentAdmin = null
    showLogin()
  }

  // 登录页 / 账号页事件
  $('loginBtn').onclick = adminLogin
  $('loginPass').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') adminLogin() })
  $('loginUser').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { var p = $('loginPass'); if (p) p.focus() } })
  $('logoutBtn').onclick = logout
  $('savePass').onclick = changePassword


  // ---------- 详情抽屉（状态时间线 + 实时位置 + 商品明细 + 操作） ----------
  // 点卡片整卡进入；列表留在左侧不丢上下文。时间线来自 GET /admin/timeline，
  // 老数据没有事件时展示「推断节点」（由后端用现有时间列拼出，前端明确标注）。
  var drawerCtx = null

  function openDrawer(type, id) {
    var eid = Number(id)
    if (!eid || ['order', 'batch', 'task'].indexOf(type) < 0) return
    drawerCtx = { type: type, id: eid, data: null }
    var d = $('detailDrawer')
    if (d) d.hidden = false
    var label = type === 'batch' ? '批次' : type === 'order' ? '订单' : '任务'
    $('drawerTitle').textContent = label + ' #' + eid
    $('drawerBody').innerHTML = '<div class="skel">时间线加载中…</div>'
    api('/timeline?type=' + type + '&id=' + eid).then(function (data) {
      // 期间用户可能已切到别的卡片，丢弃过期响应
      if (!drawerCtx || drawerCtx.id !== eid || drawerCtx.type !== type) return
      drawerCtx.data = data
      renderDrawer()
    }).catch(function (err) {
      if (!drawerCtx || drawerCtx.id !== eid) return
      $('drawerBody').innerHTML = '<div class="empty">时间线加载失败：' + esc(err.message) + '</div>'
    })
  }
  window.openDrawer = openDrawer

  function closeDrawer() {
    var d = $('detailDrawer')
    if (d) d.hidden = true
    drawerCtx = null
  }
  window.closeDrawer = closeDrawer

  window.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && drawerCtx) closeDrawer() })

  function kvLine(k, v) {
    return '<div class="bcard-line"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'
  }

  // 实时位置段：机器人坐标来自 WS live 推送（liveRobots），不额外打接口
  function drawerLiveHtml() {
    var t = drawerCtx && drawerCtx.data
    var sn = ''
    if (t && t.current) sn = t.current.device_sn || ''
    if (!sn && t && t.type === 'order') {
      // 订单本身没有设备，取所属批次的设备
      var o = (state && state.orders || []).find(function (x) { return x.id === drawerCtx.id })
      if (o) sn = o.device_sn || ''
    }
    if (!sn) return '<div class="mini">该对象当前没有关联的机器人（未派车或已释放）。</div>'
    var r = (liveRobots || []).find(function (x) { return x.device_sn === sn })
    var rows = kvLine('设备', '<span class="num">' + esc(sn) + '</span>')
    if (r) {
      rows += kvLine('实时坐标', '<span class="num">x=' + Number(r.x).toFixed(1) + '，y=' + Number(r.y).toFixed(1) + '</span>')
      rows += kvLine('航向', '<span class="num">' + Number(r.theta || 0).toFixed(0) + '°</span>')
      rows += kvLine('位置更新', '<span class="mini">' + esc(new Date().toLocaleTimeString('zh-CN', { hour12: false })) + '（实时推送）</span>')
    } else {
      rows += kvLine('实时坐标', '<span class="mini">位置暂不可用（机器人离线或未上报）</span>')
    }
    var canMap = t && t.type === 'batch' && Number(t.current.status) === 2
    rows += '<div class="drawer-ops" style="margin-top:10px">'
      + (canMap ? '<button class="btn ghost sm" onclick="window.goBatchMap(' + drawerCtx.id + ')"><svg><use href="#i-map"/></svg><span>在总览地图查看</span></button>' : '')
      + '</div>'
    return rows
  }
  function renderDrawerLive() {
    var box = $('drawerLiveBox')
    if (box) box.innerHTML = drawerLiveHtml()
  }

  // 时间线段
  function drawerTimelineHtml(t) {
    var evs = (t.events || [])
    var legacy = (t.legacy || [])
    if (!evs.length && !legacy.length) return '<div class="mini">暂无状态变更记录。</div>'
    var html = '<div class="timeline">'
    if (evs.length) {
      evs.forEach(function (e) {
        var from = e.from_status === null || e.from_status === undefined ? '' : (statusTextOf(t.type, e.from_status) + ' → ')
        var who = e.actor_type === 'admin' ? '管理员' + (e.actor_name ? '·' + e.actor_name : '')
          : e.actor_type === 'merchant' ? '商家' : e.actor_type === 'user' ? '用户'
            : e.actor_type === 'platform' ? '平台' : '系统'
        html += '<div class="tl-item ' + statusDotClass(t.type, e.to_status) + '">'
          + '<div class="tl-head"><span class="tl-time">' + esc(e.created_at || '') + '</span>'
          + '<span class="tl-text">' + esc(from + (e.status_text || statusTextOf(t.type, e.to_status))) + '</span>'
          + '<span class="tl-actor">' + esc(who) + '</span>'
          + (e.order_short ? '<span class="tl-actor">订单 ' + esc(e.order_short) + '</span>' : '')
          + '</div>'
          + (e.note ? '<div class="tl-note">' + esc(e.note) + '</div>' : '')
          + '</div>'
      })
    } else {
      legacy.forEach(function (n) {
        html += '<div class="tl-item inferred">'
          + '<div class="tl-head"><span class="tl-time">' + esc(n.at || '') + '</span>'
          + '<span class="tl-text">' + esc(n.label || '') + '</span>'
          + '<span class="tl-inferred-tag">推断</span></div>'
          + '</div>'
      })
    }
    html += '</div>'
    if (!evs.length && legacy.length) {
      html += '<div class="mini" style="margin-top:8px">该对象产生于状态流水上线之前，以上节点由既有时间字段推断，可能不完整。</div>'
    }
    return html
  }

  function statusTextOf(type, status) {
    var s = Number(status)
    if (type === 'order') return ORDER_STATUS[s] || ('状态 ' + s)
    if (type === 'batch') return BATCH_STATUS[s] || ('状态 ' + s)
    return TASK_STATUS[s] || ('状态 ' + s)
  }

  function renderDrawer() {
    var t = drawerCtx && drawerCtx.data
    if (!t) return
    var cur = t.current || {}
    var out = []

    // 概要
    out.push('<div class="drawer-sec"><h4><svg><use href="#i-flag"/></svg>概要</h4>')
    if (t.type === 'batch') {
      out.push(kvLine('批次号', '<span class="num">' + esc(cur.batch_no || '—') + '</span>'))
      out.push(kvLine('状态', esc(cur.status_text || statusTextOf('batch', cur.status))))
      out.push(kvLine('机器人', '<span class="num">' + esc(cur.device_sn || '—') + '</span>'))
      var b = (state && state.batches || []).find(function (x) { return x.id === t.id })
      if (b) {
        out.push(kvLine('单数 / 件数', Number(b.total_orders || 0) + ' 单 · ' + Number(b.total_items || 0) + ' 件'))
        out.push(kvLine('已取', Number(b.picked_orders || 0) + ' / ' + Number(b.total_orders || 0) + ' 单'))
        if (batchRouteText(b)) out.push(kvLine('路线', esc(batchRouteText(b))))
        if (Number(b.status) === 2) out.push(kvLine('当前停靠', esc(currentStopText(b))))
        out.push(kvLine('创建时间', '<span class="mini">' + esc(b.created_at || '—') + '</span>'))
      }
    } else if (t.type === 'order') {
      var o = (state && state.orders || []).find(function (x) { return x.id === t.id })
      out.push(kvLine('订单号', '<span class="num">' + esc(cur.order_no || (o && o.order_no) || '—') + '</span>'))
      out.push(kvLine('状态', esc(cur.status_text || statusTextOf('order', cur.status))))
      out.push(kvLine('送达点位', esc((o && o.landmark_name) || cur.landmark_name || '—')))
      out.push(kvLine('批次', '<span class="num">' + esc((o && o.batch_id) ? ('#' + o.batch_id) : '—') + '</span>'))
      out.push(kvLine('取餐码', esc((o && o.pickup_code) || (t.context && t.context.pickup_code) || '—')))
      out.push(kvLine('金额', '¥' + Number((o && o.total_amount) || 0).toFixed(2)))
      out.push(kvLine('创建时间', '<span class="mini">' + esc((o && o.created_at) || '—') + '</span>'))
    } else {
      out.push(kvLine('任务号', '<span class="num">#' + t.id + '</span>'))
      out.push(kvLine('状态', esc(cur.status_text || statusTextOf('task', cur.status))))
      out.push(kvLine('平台任务', '<span class="num">' + esc(cur.platform_task_id || '—') + '</span>'))
      out.push(kvLine('设备', '<span class="num">' + esc(cur.device_sn || '—') + '</span>'))
    }
    out.push('</div>')

    // 商品明细（订单）
    if (t.type === 'order') {
      var oo = (state && state.orders || []).find(function (x) { return x.id === t.id })
      if (oo) {
        out.push('<div class="drawer-sec"><h4><svg><use href="#i-box"/></svg>商品明细</h4>'
          + orderGoodsRows(oo, 20) + '</div>')
      }
    }

    // 状态时间线
    out.push('<div class="drawer-sec"><h4><svg><use href="#i-timeline"/></svg>状态时间线</h4>'
      + drawerTimelineHtml(t) + '</div>')

    // 实时位置
    out.push('<div class="drawer-sec"><h4><svg><use href="#i-pin"/></svg>实时位置</h4>'
      + '<div id="drawerLiveBox">' + drawerLiveHtml() + '</div></div>')

    // 操作（破坏性操作仍在右键菜单，这里给非破坏性快捷入口）
    out.push('<div class="drawer-sec"><h4><svg><use href="#i-more"/></svg>操作</h4><div class="drawer-ops">'
      + '<button class="btn ghost sm" onclick="window.drawerCopy()"><svg><use href="#i-copy"/></svg><span>复制编号</span></button>'
      + '<button class="btn ghost sm" onclick="window.drawerRefresh()"><svg><use href="#i-refresh"/></svg><span>刷新时间线</span></button>'
      + '</div><div class="mini" style="margin-top:8px">删除 / 清理 / 作废等破坏性操作请右键卡片打开操作菜单。</div></div>')

    $('drawerBody').innerHTML = out.join('')
  }

  window.drawerCopy = function () {
    var t = drawerCtx && drawerCtx.data
    if (!t) return
    if (t.type === 'order') copyText((t.context && t.context.order_no) || '', '订单号已复制')
    else if (t.type === 'batch') copyText((t.context && t.context.batch_no) || '', '批次号已复制')
    else copyText(String(t.id), '任务号已复制')
  }
  window.drawerRefresh = function () {
    if (drawerCtx) openDrawer(drawerCtx.type, drawerCtx.id)
  }


  // ---------- 操作日志（服务端持久化审计：成功与失败都在） ----------
  // 读 GET /admin/audit（后端由 auditMw 中间件统一写入，不依赖前端上报）。
  // 前端内存日志（#log）只作「本次会话回显」，与审计无关。
  var auditState = { offset: 0, limit: 50, total: 0, rows: [], loading: false }

  function auditQuery() {
    var role = ($('auditRole') && $('auditRole').value) || 'admin'
    var okv = ($('auditResult') && $('auditResult').value) || ''
    var act = ($('auditAction') && $('auditAction').value.trim()) || ''
    var qs = '?limit=' + auditState.limit + '&offset=' + auditState.offset + '&role=' + encodeURIComponent(role)
    if (okv !== '') qs += '&ok=' + encodeURIComponent(okv)
    if (act) qs += '&action=' + encodeURIComponent(act)
    return qs
  }

  function loadAudit(reset) {
    if (reset) auditState.offset = 0
    if (auditState.loading) return
    auditState.loading = true
    var box = $('auditBox')
    if (box && !auditState.rows.length) box.innerHTML = '<span class="mini">加载中…</span>'
    api('/audit' + auditQuery()).then(function (d) {
      auditState.total = Number(d.total || 0)
      auditState.rows = d.rows || []
      renderAudit()
    }).catch(function (e) {
      if (box) box.innerHTML = '<div class="empty">操作日志加载失败：' + esc(e.message) + '</div>'
    }).then(function () { auditState.loading = false })
  }

  function auditWho(r) {
    if (r.user_role === 'admin') return '管理员' + (r.user_id ? '#' + r.user_id : '')
    if (r.user_role === 'merchant') return '商家' + (r.user_id ? '#' + r.user_id : '')
    if (r.user_role === 'student') return '用户' + (r.user_id ? '#' + r.user_id : '')
    return r.user_role || '匿名'
  }

  function renderAudit() {
    var box = $('auditBox')
    if (!box) return
    if (!auditState.rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-shield"/></svg>暂无符合条件的操作记录</div>'
    } else {
      box.innerHTML = auditState.rows.map(function (r) {
        var ok = Number(r.ok) === 1
        return '<div class="audit-row' + (ok ? '' : ' fail') + '">'
          + '<span class="audit-time">' + esc(r.created_at || '') + '</span>'
          + '<span class="audit-badge ' + (ok ? 'ok' : 'err') + '">' + (ok ? '成功' : '失败') + '</span>'
          + '<span class="audit-who">' + esc(auditWho(r)) + '</span>'
          + '<span class="audit-act">' + esc(r.action || '') + '</span>'
          + (r.target ? '<span class="audit-tgt">' + esc(r.target) + '</span>' : '')
          + '<span class="audit-detail">' + esc(r.detail || '') + '</span>'
          + '<span class="audit-ip">' + esc(r.ip || '') + (Number(r.ms) ? ' · ' + Number(r.ms) + 'ms' : '') + '</span>'
          + '</div>'
      }).join('')
    }
    var from = auditState.total ? auditState.offset + 1 : 0
    var to = Math.min(auditState.offset + auditState.limit, auditState.total)
    var info = $('auditInfo')
    if (info) info.textContent = '共 ' + auditState.total + ' 条，显示 ' + from + '–' + to
    var prev = $('auditPrev'), next = $('auditNext')
    if (prev) prev.disabled = auditState.offset <= 0
    if (next) next.disabled = auditState.offset + auditState.limit >= auditState.total
  }

  // ---------- 操作日志控件绑定 ----------
  ;(function wireAudit() {
    var role = $('auditRole'); if (role) role.addEventListener('change', function () { loadAudit(true) })
    var res = $('auditResult'); if (res) res.addEventListener('change', function () { loadAudit(true) })
    var act = $('auditAction')
    if (act) {
      act.addEventListener('input', function () {
        clearTimeout(act._t)
        act._t = setTimeout(function () { loadAudit(true) }, 220)
      })
    }
    var reload = $('auditReload'); if (reload) reload.addEventListener('click', function () { loadAudit(false) })
    var prev = $('auditPrev')
    if (prev) prev.addEventListener('click', function () {
      auditState.offset = Math.max(0, auditState.offset - auditState.limit)
      loadAudit(false)
    })
    var next = $('auditNext')
    if (next) next.addEventListener('click', function () {
      if (auditState.offset + auditState.limit < auditState.total) {
        auditState.offset += auditState.limit
        loadAudit(false)
      }
    })
  })()


  // ---------- 单项操作（走后端统一落账） ----------
  function opFail(e, label) {
    if (isUnauthorized(e)) {
      setAuthBanner('登录已失效：无法认证，不能查看和管理', true)
      log('认证失败：' + e.message, 'bad')
    } else {
      toast(label + ' 失败：' + e.message, 'err')
      log(label + ' 失败：' + e.message, 'bad')
    }
  }

  function run(label, p, body, successMsg) {
    log(label + ' …')
    api(p, 'POST', body).then(function () {
      log(successMsg || label + ' 成功', 'green')
      toast(successMsg || label + ' 成功', 'ok')
      refresh()
      if (overviewTab === 'log') loadAudit(true)   // 操作日志页正开着就顺带刷新
      if (drawerCtx) window.drawerRefresh()
    }).catch(function (e) { opFail(e, label) })
  }
  function confirmRun(label, p, body, confirmText, successMsg) {
    if (!window.confirm(confirmText)) return
    run(label, p, body, successMsg)
  }

  // 删除订单：作废任务 + 回补库存 + 摘批次 + 平台召回（order 域统一落账）
  window.actCancelOrder = function (oid) {
    confirmRun('删除订单 ' + oid, '/order/cancel', { order_id: oid },
      '删除订单 ' + oid + '？将关闭其平台任务并同步取消本地订单，防止机器人卡死。', '订单 ' + oid + ' 已删除')
  }
  // 关闭平台任务 + 本地作废（一键）
  window.actCloseVoid = function (tid) {
    confirmRun('关闭并作废任务 ' + tid, '/task/close-void', { task_id: tid },
      '关闭平台任务并作废本地任务 ' + tid + '？', '任务 ' + tid + ' 已删除')
  }
  // 仅本地作废（不动平台任务）
  window.actVoid = function (tid) { run('本地作废任务 ' + tid, '/task/void', { task_id: tid }) }
  // 清理批次：删批内活跃订单（平台召回+本地取消）+ 释放控制权 + 批次置 4
  window.actCancelBatch = function (bid) {
    confirmRun('清理批次 ' + bid, '/batch/cancel', { batch_id: bid },
      '清理批次 ' + bid + '？将删除批次内全部订单（含平台任务）并释放控制权。', '批次 ' + bid + ' 已清理')
  }

  // ---------- 选择弹窗（召唤目标点 / 开关舱） ----------
  var pickCtx = null
  function readPick(el) {
    var cmd = el.getAttribute('data-cmd')
    if (cmd !== null && cmd !== undefined && cmd !== '') return Number(cmd)
    return { id: el.getAttribute('data-id'), name: el.querySelector('b') ? el.querySelector('b').textContent : '' }
  }
  window.openPickModal = function (title, html, onOk) {
    pickCtx = { selected: null, onOk: onOk || null }
    $('pickTitle').textContent = title
    $('pickBody').innerHTML = html
    $('pickOk').disabled = false
    $('pickModal').hidden = false
    var first = $('pickBody').querySelector('.pick-item')
    if (first) { first.classList.add('sel'); pickCtx.selected = readPick(first) }
  }
  window.closePickModal = function () { $('pickModal').hidden = true; pickCtx = null }
  window.pickConfirm = function () {
    if (!pickCtx || !pickCtx.onOk) { closePickModal(); return }
    if (pickCtx.selected === null || pickCtx.selected === undefined) { toast('请先选择一项', 'err'); return }
    var onOk = pickCtx.onOk
    var sel = pickCtx.selected
    closePickModal()
    onOk(sel)
  }
  $('pickBody').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.pick-item')
    if (!btn || !pickCtx) return
    var items = $('pickBody').querySelectorAll('.pick-item')
    items.forEach(function (x) { x.classList.remove('sel') })
    btn.classList.add('sel')
    pickCtx.selected = readPick(btn)
  })

  // 召唤：弹窗选择目标点（上货点/充电点/取货点）后执行；召唤会中断正在执行的配送任务
  window.actSummon = function () {
    api('/robot/summon-targets', 'GET').then(function (d) {
      var targets = (d && d.targets) || []
      if (!targets.length) { toast('无可召唤点位（请先在设置页同步点位）', 'err'); return }
      var groups = { loadingPoint: [], chargePoint: [], deliverPoint: [] }
      targets.forEach(function (t) { (groups[t.type] || (groups[t.type] = [])).push(t) })
      var order = [['loadingPoint', '上货点'], ['chargePoint', '充电点'], ['deliverPoint', '取货点']]
      var html = ''
      order.forEach(function (g) {
        var list = groups[g[0]] || []
        if (!list.length) return
        html += '<div class="pick-group">' + g[1] + ' · ' + list.length + ' 处</div>'
        html += list.map(function (t) {
          return '<button type="button" class="pick-item" data-id="' + esc(t.id) + '"><b>' + esc(t.name) + '</b><span>' + g[1] + '</span></button>'
        }).join('')
      })
      html += '<p class="pick-hint warn">召唤会中断机器人正在执行的配送任务</p>'
      openPickModal('召唤机器人到', html, function (sel) {
        var sn = state && state.robot ? state.robot.device_sn : ''
        run('召唤 ' + (sn || '空闲车') + ' 到 ' + sel.name, '/robot/summon', { device_sn: sn, landmark_id: sel.id }, '召唤成功：' + sel.name)
      })
    }).catch(function (e) { opFail(e, '获取召唤点位') })
  }

  // 开关舱：弹窗选择开舱/关舱后执行（drawerCtrl 不影响任务状态）
  window.actDrawerPick = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    var html = '<button type="button" class="pick-item big" data-cmd="1"><b>开舱</b><span>打开货舱门</span></button>'
      + '<button type="button" class="pick-item big" data-cmd="0"><b>关舱</b><span>关闭货舱门</span></button>'
    openPickModal('开关舱', html, function (cmd) {
      run((cmd ? '开' : '关') + '舱门 ' + sn, '/drawer', { device_sn: sn, cmd: cmd })
    })
  }

  // ---------- 机器人卡「更多操作」里的三个设备级动作 ----------
  // 停止：平台驻停 30 秒后自动恢复，任务/订单/批次均不变
  window.actStop = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    confirmRun('驻停机器人 ' + sn, '/robot/stop', { device_sn: sn, stop_time: 30 },
      '确定停止机器人 ' + sn + '？将原地驻停 30 秒后自动恢复。', '已发送驻停指令')
  }
  // 继续工作：恢复该设备当前（挂起）任务
  window.actRecover = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    confirmRun('恢复机器人 ' + sn, '/robot/recover', { device_sn: sn },
      '确定让机器人 ' + sn + ' 继续工作？将恢复其当前任务执行。', '已发送恢复指令')
  }
  // 停止并取消任务：关闭该设备全部活跃平台任务 + 关联本地订单统一落账 + 批次置 4
  window.actStopCancel = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    confirmRun('取消机器人 ' + sn + ' 的全部任务', '/robot/cancel-tasks', { device_sn: sn },
      '确定取消机器人 ' + sn + ' 当前的全部任务？\n将关闭其全部平台任务、取消关联订单（回补库存、摘批次），不可撤销。',
      '已取消该机器人的全部任务')
  }

  // ---------- 设置页：控制权 / 点位 ----------
  window.actGrant = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    run('获取控制权 ' + sn, '/control/grant', { device_sn: sn }, '控制权已获取（系统已记住控制权 ID）')
  }
  window.actRelease = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    run('释放控制权 ' + sn, '/control/release', { device_sn: sn }, '控制权已释放')
  }
  window.actSyncLm = function () { run('同步点位', '/landmarks/sync', {}, '点位已同步') }

  // 一键初始化（危险）：关闭全部平台任务 + 释放全部控制权 + 删除全部活跃订单 + 批次置4
  $('reset').onclick = function () {
    var confirmText = '一键初始化将执行：\n'
      + '1) 关闭全部平台活跃任务\n'
      + '2) 释放全部设备控制权\n'
      + '3) 删除全部活跃订单（作废任务 + 回补库存 + 平台召回）\n'
      + '4) 全部批次置已取消\n\n'
      + '此操作会作用于真实机器人，不可撤销。确认继续？'
    if (!window.confirm(confirmText)) return
    log('一键初始化 …（可能耗时，请等待）')
    api('/reset', 'POST', {}).then(function (d) {
      var failed = d.failed && d.failed.length ? d.failed : []
      var msg = '一键初始化完成：关闭任务 ' + d.closed + '，释放控制权 ' + d.released + '，删除订单 ' + d.cancelled + '，清理批次 ' + d.batch_cleaned
        + (failed.length ? '，失败 ' + failed.length + ' 项（' + failed.slice(0, 5).join('；') + '）' : '')
      log(msg, failed.length ? 'warn' : 'green')
      toast(msg, failed.length ? 'warn' : 'ok')
      refresh()
      if (overviewTab === 'log') loadAudit(true)
    }).catch(function (e) { opFail(e, '一键初始化') })
  }

  // ---------- 其他控件绑定 ----------
  $('refresh').onclick = refresh
  var moreBtn = $('robotMoreBtn')
  if (moreBtn) moreBtn.addEventListener('click', function (ev) { ev.stopPropagation(); window.showRobotMenu(ev) })

  // ---------- 启动 ----------
  fillStatusOptions('batch')
  wireSearch('dataSearch')
  showPanel('dataPanel', 'batch', ['batch', 'order', 'task'])

  var saved = localStorage.getItem(TOKEN_KEY)
  if (saved) {
    // 方案A：有会话 token → 调 /admin/me 校验；失效/过期由 onUnauthorized 弹登录页
    api('/me').then(function (d) {
      currentAdmin = d.admin
      renderAccountUI()
      hideLogin()   // 有效会话：loginMask 默认可见，必须显式隐藏，否则每次刷新都被登录遮罩挡住
      refresh()
    }).catch(function () { /* onUnauthorized 已弹登录页 */ })
  } else {
    showLogin()
  }
  // 事件驱动（WS 推送）更新数据，无轮询：本定时器只做「WS 断开则重连」的健康探查，不拉取任何数据。
  connectWS()
  setInterval(function () { if (token() && (!ws || ws.readyState !== 1)) connectWS() }, 20000)
})()
