/* ============================================================
   零栋送餐 · 调度台 —— 管理员前端逻辑 v3
   ------------------------------------------------------------
   · 配送任务页：只展示「正在执行」的任务（配送中[含批次待上货/订单配送中] / 待取货 / 配送异常），
     支持右键菜单 + 多选批量操作（删除订单 / 清理批次 / 关闭任务）；
     本地批次 / 订单 / 配送任务 / 平台任务 分标签页单表展示。
   · 历史记录页：批次 / 订单 / 任务 三标签切换单表；批次可点击下箭头展开查看内部订单。
   · 两页均支持按订单号或批次号搜索 + 按状态筛选。
   · 设置页：令牌（输入框 + 正确打勾 + 不显示位数 + 更改令牌）/ 控制权与点位 / 危险操作 分标签。
   · 总览页新增校园实时地图（拖动 / 缩放 / 雷达底图叠加），见 admin-map.js。
   一致性铁律：所有删除 / 清理 / 关闭操作均走后端统一落账（作废任务 + 回补库存 +
   摘批次 + 平台召回关任务），保证机器人状态、用户端、商家端同步，杜绝死锁。
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

  var $ = function (id) { return document.getElementById(id) }
  var state = null
  var sel = { order: {}, batch: {}, task: {}, plat: {} }
  var expandedSet = new Set()      // 已展开的批次 id
  var batchOrdersCache = {}        // 批次 id -> 订单数组 | 'loading'
  var statusFilter = { tasks: '', history: '' }
  var searchQ = { tasks: '', history: '' }
  var tokenVerified = false
  var toastTimer = null
  var busy = false                // 状态轮询防重入

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

  function token() { return $('token').value.trim() || localStorage.getItem(TOKEN_KEY) || '' }

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
        if (r.status === 401) throw err
        if (j.code !== 0 && j.code !== undefined) throw err
        return j.data
      })
    })
  }

  function isUnauthorized(e) { return !!(e && e.status === 401) }

  function setAuthBanner(text, isError) {
    var box = $('authBanner')
    if (!text) { box.hidden = true; box.innerHTML = ''; return }
    box.hidden = false
    box.innerHTML = '<svg><use href="#i-warn"/></svg><span>' + esc(text) + '</span>'
      + (isError ? '<span class="hint">请在上方输入正确的管理员令牌后保存</span>' : '')
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
      inner = '<div class="tblwrap"><table class="mini-tbl"><thead><tr><th>ID</th><th>订单号</th><th>状态</th><th>点位</th><th>金额</th><th>取餐码</th><th>创建时间</th></tr></thead><tbody>'
        + cache.map(function (o) {
          return '<tr><td>' + o.id + '</td><td>' + esc(o.order_no) + '</td><td>' + orderTag(o) + '</td><td>' + esc(o.landmark_name || '—') + '</td><td>' + (o.total_amount || 0) + '</td><td class="num">' + esc(o.pickup_code || '—') + '</td><td>' + esc(o.created_at || '—') + '</td></tr>'
        }).join('')
        + '</tbody></table></div>'
    }
    return '<tr class="row-child"><td colspan="10">' + inner + '</td></tr>'
  }

  // ---------- 主渲染 ----------
  function render() {
    if (!state) return
    renderOverview()
    renderTasksPage()
    renderHistoryPage()
    renderNavCount()
  }

  function renderOverview() {
    // 告警
    var alerts = state.alerts || []
    $('alertCount').textContent = alerts.length
    $('alertCount').className = 'tag ' + (alerts.some(function (a) { return a.level === 'bad' }) ? 'red' : (alerts.length ? 'orange' : 'green'))
    $('alertsBox').innerHTML = alerts.length
      ? alerts.map(function (a) { return '<div class="alert ' + a.level + '">' + esc(a.text) + '</div>' }).join('')
      : '<div class="alert ok">未检测到异常或死锁</div>'

    // 机器人（单独抽出：WS live 事件会原地刷新该卡片，不整页重渲染）
    renderRobotCard()

    // 状态字典
    $('dictBox').innerHTML = Object.keys(TASK_STATUS).map(function (k) { return '<span>' + k + ' <b>' + TASK_STATUS[k] + '</b></span>' }).join('')
      + '<span class="divider">机器状态</span>'
      + Object.keys(MACHINE_TEXT).map(function (k) { return '<span>' + k + ' <b>' + MACHINE_TEXT[k] + '</b></span>' }).join('')
  }

  // 机器人卡片渲染（独立函数：WS live 事件每 ~2.5s 推机器状态，原地刷新卡片不整页重绘）
  function renderRobotCard() {
    var r = state && state.robot
    var tag = $('robotTag')
    if (tag) {
      tag.textContent = r ? (r.online ? '在线' : '离线') : '无设备'
      tag.className = 'tag ' + (r && r.online ? 'green' : 'red')
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
  //   {type:'live', robots, robot}        → 原地更新地图小车 + 机器人卡片
  //   {type:'state_changed'}              → 数据有变，拉一次 /api/admin/state
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
        if (m.robot && state) { state.robot = m.robot; renderRobotCard() }
        if (Array.isArray(m.robots) && window.mapOnLive) window.mapOnLive(m.robots)
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

  // ---------- 刷新与认证 ----------
  function refresh() {
    var tk = token()
    if (!tk) {
      setAuthBanner('未认证：请输入管理员令牌并保存后才能查看和管理', false)
      $('conn').textContent = '未认证'
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
        setAuthBanner('令牌无效：无法认证，不能查看和管理', true)
        log('认证失败：' + e.message, 'bad')
      } else {
        setAuthBanner('')
        log('刷新失败：' + e.message, 'bad')
      }
    }).then(function () { busy = false })
  }

  // ---------- 令牌（设置页） ----------
  function verifyToken(t) {
    return fetch('/api/admin/verify', { headers: { 'x-admin-token': t } })
      .then(function (r) { return r.status === 200 })
      .catch(function () { return false })
  }

  function renderTokenUI() {
    var inp = $('token'), st = $('tokenState'), msg = $('tokenMsg'), chg = $('tokenChange'), btn = $('saveToken')
    if (tokenVerified) {
      inp.value = ''
      inp.placeholder = '••••••'
      inp.disabled = true
      inp.classList.add('ok'); inp.classList.remove('err')
      st.innerHTML = '<svg class="ok-ico"><use href="#i-check"/></svg><span class="ok-txt">正确</span>'
      st.hidden = false
      msg.innerHTML = ''
      msg.className = 'token-msg ok'
      chg.hidden = false
      btn.hidden = true
    } else {
      inp.disabled = false
      inp.classList.remove('ok', 'err')
      if (!inp.value) inp.placeholder = '请输入令牌'
      st.hidden = true
      msg.className = 'token-msg'
      chg.hidden = true
      btn.hidden = false
    }
  }

  $('saveToken').onclick = function () {
    var t = $('token').value.trim()
    var inp = $('token'), msg = $('tokenMsg'), st = $('tokenState')
    if (!t) {
      msg.className = 'token-msg err'
      msg.innerHTML = '请输入令牌'
      inp.classList.add('err'); inp.classList.remove('ok')
      return
    }
    verifyToken(t).then(function (ok) {
      if (ok) {
        localStorage.setItem(TOKEN_KEY, t)
        tokenVerified = true
        renderTokenUI()
        log('令牌验证通过', 'green')
        toast('令牌验证通过', 'ok')
        refresh()
        connectWS() // 用新令牌重建实时推送连接
      } else {
        tokenVerified = false
        inp.classList.add('err'); inp.classList.remove('ok')
        st.innerHTML = '<svg class="err-ico"><use href="#i-close"/></svg>'
        st.hidden = false
        msg.className = 'token-msg err'
        msg.innerHTML = '令牌不正确'
        log('令牌验证失败：不匹配', 'bad')
      }
    })
  }

  $('changeToken').onclick = function () {
    localStorage.removeItem(TOKEN_KEY)
    tokenVerified = false
    $('token').value = ''
    $('tokenMsg').innerHTML = ''
    renderTokenUI()
    $('token').focus()
    state = null
    refresh()
    connectWS() // 旧令牌连接立即断开；输入新令牌并保存后由 connectWS 重建
    log('已清除令牌，等待重新输入', 'warn')
  }

  // ---------- 单项操作（保留原语义，走后端统一落账） ----------
  function run(label, p, body, successMsg) {
    log(label + ' …')
    api(p, 'POST', body).then(function () {
      log(successMsg || label + ' 成功', 'green')
      toast(successMsg || label + ' 成功', 'ok')
      refresh()
    }).catch(function (e) { opFail(e, label) })
  }
  function confirmRun(label, p, body, confirmText, successMsg) {
    if (!window.confirm(confirmText)) return
    run(label, p, body, successMsg)
  }

  window.actCancel = function (pid) { run('取消排队任务 ' + pid, '/task/cancel', { platform_task_id: pid }) }
  window.actClose = function (sn, pid) {
    if (!sn && state && state.robot && state.robot.device_sn) sn = state.robot.device_sn
    if (!sn) {
      var m = '关闭任务 ' + pid + ' 失败：缺少设备编号（该任务未记录设备，且当前无机器人在线）'
      log(m, 'bad'); toast(m, 'err'); return
    }
    run('关闭任务 ' + pid, '/task/close', { device_sn: sn, platform_task_id: pid })
  }
  window.actCancelOrder = function (oid) {
    confirmRun('删除订单 ' + oid, '/order/cancel', { order_id: oid }, '删除订单 ' + oid + '？将关闭其平台任务并同步取消本地订单，防止机器人卡死。', '订单 ' + oid + ' 已删除')
  }
  window.actCloseVoid = function (tid) {
    confirmRun('关闭并作废任务 ' + tid, '/task/close-void', { task_id: tid }, '关闭平台任务并作废本地任务 ' + tid + '？', '任务 ' + tid + ' 已删除')
  }
  window.actVoid = function (tid) { run('本地作废任务 ' + tid, '/task/void', { task_id: tid }) }
  window.actCancelBatch = function (bid) {
    confirmRun('清理批次 ' + bid, '/batch/cancel', { batch_id: bid }, '清理批次 ' + bid + '？将删除批次内全部订单（含平台任务）并释放控制权。', '批次 ' + bid + ' 已清理')
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
      targets.forEach(function (t) { (groups[t.type] || (groups.deliverPoint = groups.deliverPoint)).push(t) })
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

  // 停止 / 继续工作 / 停止并取消任务
  window.actStop = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    confirmRun('驻停机器人 ' + sn, '/robot/stop', { device_sn: sn, stop_time: 30 }, '确定停止机器人 ' + sn + '？将原地驻停 30 秒。', '已发送驻停指令')
  }
  window.actRecover = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    confirmRun('恢复机器人 ' + sn, '/robot/recover', { device_sn: sn }, '确定让机器人 ' + sn + ' 继续工作？将恢复其任务执行。', '已发送恢复指令')
  }
  window.actStopCancel = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    confirmRun('停止并取消任务 ' + sn, '/robot/stop-cancel', { device_sn: sn },
      '确定停止机器人 ' + sn + ' 并取消正在执行的任务？\n将关闭其当前平台任务（舱内有货会自动开舱）并驻停，不可撤销。', '已停止并取消任务')
  }
  window.actDelPre = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    run('删除预创建 ' + sn, '/precreate/del', { device_sn: sn }, '已删除预创建任务（舱门关闭）')
  }
  window.actGrant = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    run('获取控制权 ' + sn, '/control/grant', { device_sn: sn }, '控制权已获取')
  }
  window.actRelease = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    var id = $('ctrlId').value.trim()
    run('释放控制权 ' + id, '/control/release', { device_sn: sn, ctrl_id: id }, '控制权已释放')
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
    }).catch(function (e) { opFail(e, '一键初始化') })
  }

  // ---------- 批量按钮绑定 ----------
  $('tasksBulkOrder').onclick = function () { runBulkOrder('tasks') }
  $('tasksBulkBatch').onclick = function () { runBulkBatch('tasks') }
  $('tasksBulkClear').onclick = function () { clearSel(); renderTasksPage() }
  $('historyBulkOrder').onclick = function () { runBulkOrder('history') }
  $('historyBulkBatch').onclick = function () { runBulkBatch('history') }
  $('historyBulkTask').onclick = function () { runBulkTask('history') }
  $('historyBulkClear').onclick = function () { clearSel(); renderHistoryPage() }

  // 筛选下拉
  $('tasksStatus').addEventListener('change', function () {
    statusFilter.tasks = this.value
    renderTasksPage()
  })
  $('historyStatus').addEventListener('change', function () {
    statusFilter.history = this.value
    renderHistoryPage()
  })

  $('refresh').onclick = refresh

  // ---------- 启动 ----------
  fillStatusOptions('tasksStatus', tasksKind(tasksTab))
  fillStatusOptions('historyStatus', historyKind(historyTab))
  wireSearch('tasksSearch', 'tasks')
  wireSearch('historySearch', 'history')

  var saved = localStorage.getItem(TOKEN_KEY)
  renderTokenUI()
  if (saved) {
    verifyToken(saved).then(function (ok) {
      if (ok) {
        tokenVerified = true
        renderTokenUI()
        refresh()
      } else {
        localStorage.removeItem(TOKEN_KEY)
        tokenVerified = false
        renderTokenUI()
        refresh()
      }
    })
  } else {
    refresh()
  }
  // 事件驱动（WS 推送）更新数据，无轮询：本定时器只做「WS 断开则重连」的健康探查，不拉取任何数据。
  connectWS()
  setInterval(function () { if (token() && (!ws || ws.readyState !== 1)) connectWS() }, 20000)
})()