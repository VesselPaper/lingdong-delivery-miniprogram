/* 零栋送餐 · 管理员工具前端逻辑
 * v2：死锁/异常告警 + 机器人状态停留 + 平台任务全量 + 删除订单任务 + 一键初始化
 */
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
  var ctrlId = ''

  function log(msg, cls) {
    var box = $('log')
    var line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg
    box.innerHTML = (cls ? '<span class="' + cls + '">' : '') + line.replace(/</g, '&lt;') + (cls ? '</span>' : '') + '\n' + box.innerHTML
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

  // 认证状态提示条：无令牌/令牌无效时醒目提示（有令牌且通过后隐藏）
  function setAuthBanner(text, isError) {
    var box = $('authBanner')
    if (!text) { box.style.display = 'none'; box.innerHTML = ''; return }
    box.style.display = 'flex'
    box.innerHTML = '<span>' + esc(text) + '</span>'
      + (isError ? '<span class="hint">请在上方输入正确的管理员令牌后点「保存」</span>' : '')
  }

  function isUnauthorized(e) { return !!(e && e.status === 401) }

  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;') }

  // ---------- 导航切换（左侧导航栏） ----------
  var PAGE_META = {
    overview: { title: '总览', sub: '机器人状态、异常与死锁监控' },
    tasks: { title: '配送任务', sub: '进行中任务分类、平台任务与本地管理' },
    history: { title: '历史记录', sub: '已完成 / 已取消的批次、订单与任务（只读）' },
    settings: { title: '设置', sub: '令牌、控制权、点位与危险操作' }
  }
  function navTo(page) {
    if (!PAGE_META[page]) return
    var items = document.querySelectorAll('.nav-item')
    for (var i = 0; i < items.length; i++) items[i].className = items[i].className.replace(/\s*active/g, '')
    var el = document.querySelector('.nav-item[data-page="' + page + '"]')
    if (el) el.className += ' active'
    var pages = document.querySelectorAll('.page')
    for (var j = 0; j < pages.length; j++) pages[j].className = pages[j].className.replace(/\s*active/g, '')
    var pg = document.getElementById('page-' + page)
    if (pg) pg.className += ' active'
    $('pageTitle').textContent = PAGE_META[page].title
    $('pageSub').textContent = PAGE_META[page].sub
  }
  // 导航由 HTML onclick 全局调用，必须挂到 window
  window.navTo = navTo

  // 距现在多久（"x 分钟前 / x 小时前 / x 天前"），传入本地时间字符串
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

  function statusTag(st, text) {
    var s = Number(st)
    var cls = 'tag'
    if (s === 80) cls += ' green'
    else if (s === 90 || s === 100 || s === 120) cls += ' red'   // 异常态
    else if (s === 110 || s === 150 || s === 1) cls += ''        // 终态灰
    else if (s === 30 || s === 40) cls += ' orange'              // 上货阶段
    else cls += ' orange'
    return '<span class="' + cls + '">' + esc(text) + ' (' + s + ')</span>'
  }

  function render() {
    if (!state) return
    // ---------- 告警 ----------
    var alerts = state.alerts || []
    $('alertCount').textContent = alerts.length
    $('alertCount').className = 'tag ' + (alerts.some(function (a) { return a.level === 'bad' }) ? 'red' : (alerts.length ? 'orange' : 'green'))
    $('alertsBox').innerHTML = alerts.length
      ? alerts.map(function (a) { return '<div class="alert ' + a.level + '">' + esc(a.text) + '</div>' }).join('')
      : '<div class="alert ok">未检测到异常/死锁 ✓</div>'

    // ---------- 机器人 ----------
    var r = state.robot
    $('robotTag').textContent = r ? (r.online ? '在线' : '离线') : '无设备'
    $('robotTag').className = 'tag ' + (r && r.online ? 'green' : 'red')
    $('rSn').textContent = r ? r.device_sn : (state.robot_error || '—')
    if (r) {
      var mt = r.machine_text || MACHINE_TEXT[r.machine_status] || r.machine_status || '未知'
      var mCls = r.machine_status === 'exception' ? 'stale' : (r.machine_status === 'charging' ? 'stale-soft' : '')
      $('rMachine').innerHTML = '<span class="' + mCls + '">' + esc(r.machine_status + '（' + mt + '）') + '</span>'
      var age = ageLabel(r.status_update_time)
      $('rMachineAge').innerHTML = age.cls ? '<span class="' + age.cls + '">' + age.text + '</span>' : esc(age.text)
      $('rStatusTime').textContent = r.status_update_time || '—'
      $('rFloor').textContent = (r.floor || '—') + ' / ' + esc(r.building || '—')
    } else {
      $('rMachine').textContent = '—'
      $('rMachineAge').textContent = '—'
      $('rStatusTime').textContent = '—'
      $('rFloor').textContent = '—'
    }
    $('rBattery').textContent = r ? (r.battery === null || r.battery === undefined ? '—' : r.battery + '%') : '—'
    $('rOnline').textContent = r ? (r.online ? '在线' : '离线') : '—'
    $('rStocks').textContent = (r && r.busy_stocks) ? r.busy_stocks : '—'
    $('rMap').textContent = (r && r.curr_map_id) ? r.curr_map_id : '—'

    // ---------- 平台任务（全量） ----------
    var tasks = state.platform_tasks || []
    $('taskCount').textContent = tasks.length
    if (!tasks.length) {
      $('taskBody').innerHTML = '<tr><td colspan="7" class="sub">无平台任务' + (state.platform_tasks_error ? '（' + esc(state.platform_tasks_error) + '）' : '') + '</td></tr>'
    } else {
      $('taskBody').innerHTML = tasks.map(function (t) {
        var st = Number(t.taskStatus)
        var age = ageLabel(t.statusUpdateTime)
        var ageCell = age.cls ? '<span class="' + age.cls + '">' + age.text + '</span>' : esc(age.text)
        // 终态（1已取消/80完成/110取消/150关闭）不提供操作；排队中(<10)可取消；
        // 其余活跃/异常态（含90上货失败/100取货失败/120挂起）可关闭
        var ops
        if (st === 1 || st === 80 || st === 110 || st === 150) {
          ops = '<span class="mini">终态</span>'
        } else if (st < 10) {
          ops = '<button class="ghost" onclick="window.__actCancel(\'' + t.id + '\')">取消</button>'
        } else {
          ops = '<button class="ghost danger" onclick="window.__actClose(\'' + esc(t.deviceSn || '') + '\',\'' + t.id + '\')">关闭</button>'
        }
        return '<tr><td><b>' + esc(t.id) + '</b></td>'
          + '<td>' + statusTag(st, TASK_STATUS[st] || st) + '</td>'
          + '<td>' + ageCell + '</td>'
          + '<td>' + esc(t.deviceSn || '—') + '</td>'
          + '<td>' + esc((t.outOrderNo || []).join('、') || '—') + '</td>'
          + '<td>' + esc(t.createTime || '—') + '</td>'
          + '<td>' + ops + '</td></tr>'
      }).join('')
    }

    // ---------- 本地批次 ----------
    $('batchBody').innerHTML = (state.batches || []).map(function (b) {
      var active = [0, 1, 2].indexOf(Number(b.status)) >= 0
      return '<tr><td>' + b.id + '</td><td>' + esc(b.batch_no) + '</td><td>' + statusTag(b.status, BATCH_STATUS[b.status] || b.status_text) + '</td><td>' + esc(b.device_sn || '—') + '</td><td>' + b.total_orders + '</td><td>' + esc(b.ctrl_id || '—') + '</td>'
        + '<td>' + (active ? '<button class="ghost danger" onclick="window.__actCancelBatch(' + b.id + ')">清理批次</button>' : '') + '</td></tr>'
    }).join('') || '<tr><td colspan="7" class="sub">无</td></tr>'

    // ---------- 本地订单 ----------
    $('orderBody').innerHTML = (state.orders || []).map(function (o) {
      var active = [0, 1, 2, 3, 6].indexOf(Number(o.status)) >= 0
      return '<tr><td>' + o.id + '</td><td>' + esc(o.order_no) + '</td><td>' + statusTag(o.status, ORDER_STATUS[o.status] || o.status) + '</td><td>' + (o.batch_id || '—') + '</td><td>' + esc(o.landmark_name || '—') + '</td><td>' + (o.total_amount || 0) + '</td>'
        + '<td>' + (active ? '<button class="ghost danger" onclick="window.__actCancelOrder(' + o.id + ')">删除订单</button>' : '<span class="mini">终态</span>') + '</td></tr>'
    }).join('') || '<tr><td colspan="7" class="sub">无</td></tr>'

    // ---------- 本地任务 ----------
    $('localTaskBody').innerHTML = (state.tasks || []).map(function (t) {
      var active = Number(t.task_status) < 110 && !t.void_at
      var age = ageLabel(t.updated_at)
      var ageCell = age.cls ? '<span class="' + age.cls + '">' + age.text + '</span>' : esc(age.text)
      var ops = ''
      if (active) {
        ops = '<button class="ghost danger" onclick="window.__actCloseVoid(' + t.id + ')">关闭+作废</button>'
        ops += ' <button class="ghost" onclick="window.__actVoid(' + t.id + ')">仅作废</button>'
      } else {
        ops = '<span class="mini">终态</span>'
      }
      return '<tr><td>' + t.id + '</td><td>' + (t.order_id || '—') + '</td><td>' + (t.batch_id || '—') + '</td><td>' + esc(t.platform_task_id || '—') + '</td>'
        + '<td>' + statusTag(t.task_status, t.status_text || TASK_STATUS[t.task_status] || t.task_status) + '</td><td>' + ageCell + '</td><td>' + esc(t.device_sn || '—') + '</td>'
        + '<td>' + ops + '</td></tr>'
    }).join('') || '<tr><td colspan="8" class="sub">无</td></tr>'

    // ---------- 状态字典 ----------
    $('dictBox').innerHTML = Object.keys(TASK_STATUS).map(function (k) { return '<span>' + k + ' <b>' + TASK_STATUS[k] + '</b></span>' }).join('')
      + '<span style="grid-column:1/-1;margin-top:4px">机器状态：</span>'
      + Object.keys(MACHINE_TEXT).map(function (k) { return '<span>' + k + ' <b>' + MACHINE_TEXT[k] + '</b></span>' }).join('')

    renderCats()
    renderHistory()
    // 侧边栏活跃任务数角标（配送任务页计数）
    var navCnt = $('navTaskCount')
    if (navCnt) {
      var activeTotal = (state.batches || []).filter(function (b) { return [0, 1, 2].indexOf(Number(b.status)) >= 0 }).length
        + (state.orders || []).filter(function (o) { return [2, 3, 6].indexOf(Number(o.status)) >= 0 }).length
        + (state.tasks || []).filter(function (t) { return Number(t.task_status) < 80 && !t.void_at }).length
      navCnt.textContent = activeTotal
      navCnt.className = 'nav-count' + (activeTotal ? ' red' : '')
    }
  }

  // ---------- 配送任务页：分类区块（活跃在前，历史在后） ----------
  // 分类口径与商家端一致：
  //   待接单=批次0(组单中)  待上货=批次1  配送中=订单2/批次2  待取货=订单3  异常=订单6/任务90,100,120
  // 每个分类只列出该分类相关条目；历史(终态)放最后。
  function renderCats() {
    var box = $('catBox')
    if (!box) return
    var batches = state.batches || []
    var orders = state.orders || []
    var tasks = state.tasks || []
    var activeCount = 0
    var parts = []

    // —— 待接单：批次 status=0（组单中，未派车） ——
    var waitAccept = batches.filter(function (b) { return Number(b.status) === 0 })
    if (waitAccept.length) {
      activeCount += waitAccept.length
      parts.push(catBlock('待接单', 'orange', waitAccept.map(function (b) {
        return '<div class="rowitem"><span class="k">批次 #' + b.id + '</span><span class="v">' + esc(b.batch_no) + ' · ' + b.total_orders + ' 单 / ' + b.total_items + ' 件</span>'
          + '<span class="v">' + statusTag(b.status, BATCH_STATUS[b.status] || b.status_text) + '</span>'
          + '<span class="ops"><button class="ghost danger" onclick="window.__actCancelBatch(' + b.id + ')">清理批次</button></span></div>'
      }).join('')))
    }
    // —— 待上货：批次 status=1 ——
    var waitLoad = batches.filter(function (b) { return Number(b.status) === 1 })
    if (waitLoad.length) {
      activeCount += waitLoad.length
      parts.push(catBlock('待上货', 'orange', waitLoad.map(function (b) {
        return '<div class="rowitem"><span class="k">批次 #' + b.id + '</span><span class="v">' + esc(b.batch_no) + ' · ' + b.total_orders + ' 单 / ' + b.total_items + ' 件</span>'
          + '<span class="v">' + statusTag(b.status, BATCH_STATUS[b.status] || b.status_text) + '</span>'
          + (b.device_sn ? '<span class="v mono">' + esc(b.device_sn) + '</span>' : '')
          + '<span class="ops"><button class="ghost danger" onclick="window.__actCancelBatch(' + b.id + ')">清理批次</button></span></div>'
      }).join('')))
    }
    // —— 配送中：批次 status=2 ——
    var delivering = batches.filter(function (b) { return Number(b.status) === 2 })
    if (delivering.length) {
      activeCount += delivering.length
      parts.push(catBlock('配送中', 'green', delivering.map(function (b) {
        return '<div class="rowitem"><span class="k">批次 #' + b.id + '</span><span class="v">' + esc(b.batch_no) + ' · ' + b.total_orders + ' 单</span>'
          + '<span class="v">' + statusTag(b.status, BATCH_STATUS[b.status] || b.status_text) + '</span>'
          + (b.device_sn ? '<span class="v mono">' + esc(b.device_sn) + '</span>' : '')
          + (b.ctrl_id ? '<span class="v mono mini">ctrl:' + esc(b.ctrl_id) + '</span>' : '')
          + '<span class="ops"><button class="ghost danger" onclick="window.__actCancelBatch(' + b.id + ')">清理批次</button></span></div>'
      }).join('')))
    }
    // —— 待取货：订单 status=3（已送达未取） ——
    var waitPick = orders.filter(function (o) { return Number(o.status) === 3 })
    if (waitPick.length) {
      activeCount += waitPick.length
      parts.push(catBlock('待取货', 'green', waitPick.map(function (o) {
        return '<div class="rowitem"><span class="k">订单 #' + o.id + '</span><span class="v">' + esc(o.order_no) + '</span>'
          + '<span class="v">' + statusTag(o.status, ORDER_STATUS[o.status] || o.status) + '</span>'
          + '<span class="v">' + esc(o.landmark_name || '—') + '</span>'
          + (o.batch_id ? '<span class="v mini">批次 ' + o.batch_id + '</span>' : '')
          + '<span class="ops"><button class="ghost danger" onclick="window.__actCancelOrder(' + o.id + ')">删除订单</button></span></div>'
      }).join('')))
    }
    // —— 配送异常：订单6 / 任务90,100,120 ——
    var errOrders = orders.filter(function (o) { return Number(o.status) === 6 })
    var errTasks = tasks.filter(function (t) { return [90, 100, 120].indexOf(Number(t.task_status)) >= 0 && !t.void_at })
    if (errOrders.length || errTasks.length) {
      activeCount += errOrders.length + errTasks.length
      var rows = errOrders.map(function (o) {
        return '<div class="rowitem"><span class="k">订单 #' + o.id + '</span><span class="v">' + esc(o.order_no) + '</span>'
          + '<span class="v">' + statusTag(o.status, ORDER_STATUS[o.status] || o.status) + '</span>'
          + '<span class="v">' + esc(o.landmark_name || '—') + '</span>'
          + '<span class="ops"><button class="ghost danger" onclick="window.__actCancelOrder(' + o.id + ')">删除订单</button></span></div>'
      }).join('')
      rows += errTasks.map(function (t) {
        return '<div class="rowitem"><span class="k">任务 #' + t.id + '</span><span class="v">' + (t.order_id ? '订单 ' + t.order_id : '') + '</span>'
          + '<span class="v">' + statusTag(t.task_status, t.status_text || TASK_STATUS[t.task_status] || t.task_status) + '</span>'
          + (t.device_sn ? '<span class="v mono">' + esc(t.device_sn) + '</span>' : '')
          + '<span class="ops"><button class="ghost danger" onclick="window.__actCloseVoid(' + t.id + ')">关闭+作废</button></span></div>'
      }).join('')
      parts.push(catBlock('配送异常', 'red', rows))
    }
    // —— 历史（终态批次/订单/任务，放最后，收进折叠，表格展示） ——
    var histBatches = batches.filter(function (b) { return [3, 4].indexOf(Number(b.status)) >= 0 })
    var histOrders = orders.filter(function (o) { return [4, 5, 7].indexOf(Number(o.status)) >= 0 })
    var histTasks = tasks.filter(function (t) { return t.void_at || [80, 110, 150].indexOf(Number(t.task_status)) >= 0 })
    var histTotal = histBatches.length + histOrders.length + histTasks.length
    if (histTotal) {
      var histInner = ''
      if (histBatches.length) {
        histInner += '<div class="tblwrap"><table><thead><tr><th>批次 ID</th><th>批次号</th><th>状态</th><th>单数</th></tr></thead><tbody>'
          + histBatches.map(function (b) { return '<tr><td>' + b.id + '</td><td>' + esc(b.batch_no) + '</td><td>' + statusTag(b.status, b.status_text || BATCH_STATUS[b.status]) + '</td><td>' + b.total_orders + '</td></tr>' }).join('')
          + '</tbody></table></div>'
      }
      if (histOrders.length) {
        histInner += '<div class="tblwrap"><table><thead><tr><th>订单 ID</th><th>订单号</th><th>状态</th><th>点位</th></tr></thead><tbody>'
          + histOrders.map(function (o) { return '<tr><td>' + o.id + '</td><td>' + esc(o.order_no) + '</td><td>' + statusTag(o.status, ORDER_STATUS[o.status] || o.status) + '</td><td>' + esc(o.landmark_name || '—') + '</td></tr>' }).join('')
          + '</tbody></table></div>'
      }
      if (histTasks.length) {
        histInner += '<div class="tblwrap"><table><thead><tr><th>任务 ID</th><th>订单</th><th>状态</th><th>设备</th></tr></thead><tbody>'
          + histTasks.map(function (t) { return '<tr><td>' + t.id + '</td><td>' + (t.order_id || '—') + '</td><td>' + statusTag(t.task_status, t.status_text || TASK_STATUS[t.task_status] || t.task_status) + '</td><td>' + esc(t.device_sn || '—') + '</td></tr>' }).join('')
          + '</tbody></table></div>'
      }
      parts.push('<details class="cat"><summary class="cat-head" style="cursor:pointer"><span class="dot" style="background:#8a8a90"></span><h3>历史记录</h3><span class="cnt">' + histTotal + ' 条</span></summary>' + histInner + '</details>')
    }
    // 汇总
    if (!parts.length) {
      box.innerHTML = '<div class="alert ok">当前没有进行中的配送任务 ✓</div>'
    } else {
      box.innerHTML = parts.join('')
    }
    var ac = $('activeCount')
    if (ac) ac.textContent = activeCount
  }

  function catBlock(title, color, rows) {
    var dotColor = color === 'red' ? 'var(--red)' : (color === 'green' ? 'var(--ok)' : 'var(--amber)')
    return '<div class="cat"><div class="cat-head"><span class="dot" style="background:' + dotColor + '"></span><h3>' + title + '</h3><span class="cnt">' + (rows ? rows.split('<div class="rowitem">').length - 1 : 0) + '</span></div>' + (rows || '') + '</div>'
  }

  // ---------- 历史记录页：终态数据表格（只读） ----------
  function renderHistory() {
    var box = $('histBox')
    if (!box) return
    var histBatches = (state.batches || []).filter(function (b) { return [3, 4].indexOf(Number(b.status)) >= 0 })
    var histOrders = (state.orders || []).filter(function (o) { return [4, 5, 7].indexOf(Number(o.status)) >= 0 })
    var histTasks = (state.tasks || []).filter(function (t) { return t.void_at || [80, 110, 150].indexOf(Number(t.task_status)) >= 0 })
    var parts = []
    if (histBatches.length) {
      parts.push('<h3 class="hist-title">历史批次</h3><div class="tblwrap"><table><thead><tr><th>ID</th><th>批次号</th><th>状态</th><th>设备</th><th>单数</th><th>创建时间</th></tr></thead><tbody>'
        + histBatches.map(function (b) {
          return '<tr><td>' + b.id + '</td><td>' + esc(b.batch_no) + '</td><td>' + statusTag(b.status, b.status_text || BATCH_STATUS[b.status]) + '</td><td>' + esc(b.device_sn || '—') + '</td><td>' + b.total_orders + '</td><td>' + esc(b.created_at || '—') + '</td></tr>'
        }).join('') + '</tbody></table></div>')
    }
    if (histOrders.length) {
      parts.push('<h3 class="hist-title">历史订单</h3><div class="tblwrap"><table><thead><tr><th>ID</th><th>订单号</th><th>状态</th><th>批次</th><th>点位</th><th>金额</th><th>创建时间</th></tr></thead><tbody>'
        + histOrders.map(function (o) {
          return '<tr><td>' + o.id + '</td><td>' + esc(o.order_no) + '</td><td>' + statusTag(o.status, ORDER_STATUS[o.status] || o.status) + '</td><td>' + (o.batch_id || '—') + '</td><td>' + esc(o.landmark_name || '—') + '</td><td>' + (o.total_amount || 0) + '</td><td>' + esc(o.created_at || '—') + '</td></tr>'
        }).join('') + '</tbody></table></div>')
    }
    if (histTasks.length) {
      parts.push('<h3 class="hist-title">历史任务</h3><div class="tblwrap"><table><thead><tr><th>ID</th><th>订单</th><th>批次</th><th>平台任务 ID</th><th>状态</th><th>设备</th><th>更新时间</th></tr></thead><tbody>'
        + histTasks.map(function (t) {
          return '<tr><td>' + t.id + '</td><td>' + (t.order_id || '—') + '</td><td>' + (t.batch_id || '—') + '</td><td>' + esc(t.platform_task_id || '—') + '</td><td>' + statusTag(t.task_status, t.status_text || TASK_STATUS[t.task_status] || t.task_status) + '</td><td>' + esc(t.device_sn || '—') + '</td><td>' + esc(t.updated_at || '—') + '</td></tr>'
        }).join('') + '</tbody></table></div>')
    }
    box.innerHTML = parts.length ? parts.join('') : '<div class="alert ok">暂无历史记录</div>'
    var hc = $('histCount')
    if (hc) hc.textContent = histBatches.length + histOrders.length + histTasks.length
  }

  // ---------- 实时雷达（eviz 激光点云）绘制 ----------
  // laserscan 兼容两种结构：
  //  A) ROS 风格：{ angle_min, angle_max, angle_increment, ranges:[...], range_min, range_max }（极坐标）
  //  B) 点数组：[[x,y],...] 或 { points:[[x,y],...] }（直角坐标，单位米）
  function drawRadar(data) {
    var canvas = $('radarCanvas')
    var overlay = $('radarOverlay')
    var tag = $('radarTag')
    var foot = $('radarFoot')
    if (!data || !data.ok) {
      var msg = (data && data.msg) || '无雷达数据'
      tag.textContent = '无数据'
      tag.className = 'tag red'
      overlay.style.display = 'flex'
      overlay.textContent = msg
      var ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    tag.textContent = '在线'
    tag.className = 'tag green'
    overlay.style.display = 'none'
    var t = data.timestamp ? new Date(String(data.timestamp).replace(' ', 'T')) : null
    foot.textContent = '更新于 ' + (t && !isNaN(t.getTime()) ? t.toLocaleTimeString('zh-CN', { hour12: false }) : (data.timestamp || '—'))
      + (data.locQuality ? ' · 定位精度 ' + data.locQuality : '')

    var ctx = canvas.getContext('2d')
    var W = canvas.width, H = canvas.height
    var cx = W / 2, cy = H / 2
    ctx.clearRect(0, 0, W, H)
    // 底
    ctx.fillStyle = '#101418'
    ctx.fillRect(0, 0, W, H)
    // 网格：同心圆 + 十字 + 45° 线
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    var R = Math.min(W, H) / 2 - 10
    for (var i = 1; i <= 4; i++) {
      ctx.beginPath(); ctx.arc(cx, cy, R * i / 4, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - R * 0.707, cy - R * 0.707); ctx.lineTo(cx + R * 0.707, cy + R * 0.707); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + R * 0.707, cy - R * 0.707); ctx.lineTo(cx - R * 0.707, cy + R * 0.707); ctx.stroke()
    // 量程刻度文字
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '10px monospace'
    ctx.fillText('5m', cx + 4, cy - R / 4 + 3)
    ctx.fillText('10m', cx + 4, cy - R / 2 + 3)
    ctx.fillText('15m', cx + 4, cy - R * 0.75 + 3)
    ctx.fillText('20m', cx + 4, cy - R + 10)

    // 解析点云
    var pts = []
    var ls = data.laserscan
    if (ls) {
      if (Array.isArray(ls.ranges) && ls.ranges.length && typeof ls.ranges[0] === 'number') {
        // 结构 A：极坐标 ranges
        var aMin = Number(ls.angle_min || 0)
        var aInc = Number(ls.angle_increment || 0)
        var rMin = Number(ls.range_min || 0.05)
        var rMax = Number(ls.range_max || 20)
        var N = ls.ranges.length
        for (var i2 = 0; i2 < N; i2++) {
          var d0 = Number(ls.ranges[i2])
          if (!isFinite(d0) || d0 <= rMin || d0 >= rMax) continue
          var ang = aMin + aInc * i2
          pts.push([Math.cos(ang) * d0, Math.sin(ang) * d0])
        }
      } else if (Array.isArray(ls) || (ls.points && Array.isArray(ls.points))) {
        // 结构 B：直角坐标点数组
        var arr = Array.isArray(ls) ? ls : ls.points
        for (var i3 = 0; i3 < arr.length; i3++) {
          var p = arr[i3]
          if (!Array.isArray(p) || p.length < 2) continue
          var px = Number(p[0]), py = Number(p[1])
          if (!isFinite(px) || !isFinite(py)) continue
          pts.push([px, py])
        }
      }
    }
    // 绘制点云：点到中心的距离决定缩放（取最大距离=量程）
    var maxR = 20
    for (var i4 = 0; i4 < pts.length; i4++) {
      var dist = Math.sqrt(pts[i4][0] * pts[i4][0] + pts[i4][1] * pts[i4][1])
      if (dist > maxR) maxR = dist
    }
    var scale = R / maxR
    ctx.fillStyle = '#7dd3fc'
    for (var i5 = 0; i5 < pts.length; i5++) {
      var sx = cx + pts[i5][0] * scale
      var sy = cy - pts[i5][1] * scale // 屏幕 y 向下，翻转
      ctx.fillRect(sx - 1, sy - 1, 2, 2)
    }
    // 机器人本体（中心）
    ctx.fillStyle = '#e4002b'
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = '#e4002b'
    ctx.lineWidth = 2
    // 朝向（robotPose[2] 角度）
    var th = data.robotPose && data.robotPose.length >= 3 ? Number(data.robotPose[2]) : 0
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(th) * R * 0.2, cy - Math.sin(th) * R * 0.2); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '10px monospace'
    ctx.fillText(pts.length + ' 点', 8, H - 8)
  }

  // 雷达轮询（3s）：无令牌、机器人离线或无设备时跳过请求（离线时平台网关会卡 10s 超时）
  var radarTimer = null
  function pollRadar() {
    if (!token()) return
    var r = state && state.robot
    if (!r || !r.device_sn || !r.online) {
      var ov = $('radarOverlay')
      if (ov) { ov.style.display = 'flex'; ov.textContent = r && r.device_sn ? '机器人离线，无雷达数据' : '等待机器人上线…' }
      var tag = $('radarTag')
      if (tag) { tag.textContent = r && r.device_sn ? '离线' : '—'; tag.className = 'tag red' }
      return
    }
    api('/radar?device_sn=' + encodeURIComponent(r.device_sn)).then(function (d) {
      drawRadar(d)
    }).catch(function (e) {
      if (!isUnauthorized(e)) {
        var ov2 = $('radarOverlay')
        if (ov2) { ov2.style.display = 'flex'; ov2.textContent = '雷达获取失败：' + e.message }
      }
    })
  }

  function refresh() {
    var tk = token()
    // 无令牌：不发请求，明确提示未认证
    if (!tk) {
      setAuthBanner('未认证：请输入管理员令牌并保存后才能查看和管理', false)
      $('conn').textContent = '未认证'
      return
    }
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
        // 令牌无效：明确提示，页面保持不可管理状态
        state = null
        setAuthBanner('令牌无效：无法认证，不能查看和管理', true)
        log('认证失败：' + e.message, 'bad')
      } else {
        setAuthBanner('')
        log('刷新失败：' + e.message, 'bad')
      }
    })
  }

  // 失败弹窗：所有操作失败都弹窗提示（不静默），便于立即发现问题
  function failAlert(msg) {
    try { window.alert(msg) } catch (e) { /* 弹窗被拦截时退化为日志 */ }
  }

  function run(label, p, body, successMsg) {
    log(label + ' …')
    api(p, 'POST', body).then(function () {
      log(successMsg || label + ' 成功', 'green')
      refresh()
    }).catch(function (e) {
      if (isUnauthorized(e)) {
        setAuthBanner('令牌无效：无法认证，不能查看和管理', true)
        log('认证失败：' + e.message, 'bad')
        failAlert('认证失败：' + e.message)
      } else {
        log(label + ' 失败：' + e.message, 'bad')
        failAlert(label + ' 失败：' + e.message)
      }
    })
  }

  function confirmRun(label, p, body, confirmText, successMsg) {
    if (!window.confirm(confirmText)) return
    run(label, p, body, successMsg)
  }

  window.__actCancel = function (pid) { run('取消排队任务 ' + pid, '/task/cancel', { platform_task_id: pid }) }
  // 关闭任务：设备号为空时自动从当前机器人补（status=1 的历史任务列表不带 deviceSn）
  window.__actClose = function (sn, pid) {
    if (!sn && state && state.robot && state.robot.device_sn) sn = state.robot.device_sn
    if (!sn) {
      var m = '关闭任务 ' + pid + ' 失败：缺少设备编号（该任务未记录设备，且当前无机器人在线）'
      log(m, 'bad'); failAlert(m); return
    }
    run('关闭任务 ' + pid, '/task/close', { device_sn: sn, platform_task_id: pid })
  }
  // 删除订单 = 平台召回关任务 + 本地取消（作废任务/回补库存/摘批次）
  window.__actCancelOrder = function (oid) {
    confirmRun('删除订单 ' + oid, '/order/cancel', { order_id: oid }, '删除订单 ' + oid + '？将关闭其平台任务并取消本地订单。', '订单 ' + oid + ' 已删除')
  }
  // 关闭平台任务 + 本地作废（一键删除任务）
  window.__actCloseVoid = function (tid) {
    confirmRun('关闭+作废任务 ' + tid, '/task/close-void', { task_id: tid }, '关闭平台任务并作废本地任务 ' + tid + '？', '任务 ' + tid + ' 已删除')
  }
  window.__actVoid = function (tid) { run('本地作废任务 ' + tid, '/task/void', { task_id: tid }) }
  window.__actCancelBatch = function (bid) {
    confirmRun('清理批次 ' + bid, '/batch/cancel', { batch_id: bid }, '清理批次 ' + bid + '？将删除批次内全部订单（含平台任务）。', '批次 ' + bid + ' 已清理')
  }

  window.actSummon = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    run('召唤 ' + sn + ' 到上货点', '/summon', { device_sn: sn }, '召唤成功，车应前往上货点')
  }
  window.actDrawer = function (cmd) {
    var sn = state && state.robot ? state.robot.device_sn : ''
    run((cmd ? '开' : '关') + '舱门 ' + sn, '/drawer', { device_sn: sn, cmd: cmd })
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
  window.actSyncLm = function () { run('同步点位', '/landmarks/sync', {}) }

  // 一键初始化（危险）：关闭全部平台活跃任务 + 释放全部控制权 + 删除全部活跃订单 + 批次置4
  $('reset').onclick = function () {
    var confirmText = '一键初始化将执行：\n'
      + '1) 关闭全部平台活跃任务\n'
      + '2) 释放全部设备控制权\n'
      + '3) 删除全部活跃订单（作废任务+回补库存）\n'
      + '4) 全部批次置已取消\n\n'
      + '此操作会作用于真实机器人，不可撤销。确认继续？'
    if (!window.confirm(confirmText)) return
    log('一键初始化 …（可能耗时，请等待）')
    api('/reset', 'POST', {}).then(function (d) {
      log('一键初始化完成：关闭任务 ' + d.closed + '，释放控制权 ' + d.released + '，删除订单 ' + d.cancelled + '，清理批次 ' + d.batch_cleaned
        + (d.failed && d.failed.length ? '，失败 ' + d.failed.length + ' 项（' + d.failed.slice(0, 5).join('；') + '）' : ''), d.failed && d.failed.length ? 'warn' : 'green')
      refresh()
    }).catch(function (e) {
      if (isUnauthorized(e)) { setAuthBanner('令牌无效：无法认证，不能查看和管理', true); log('认证失败：' + e.message, 'bad') }
      else log('一键初始化失败：' + e.message, 'bad')
    })
  }

  $('saveToken').onclick = function () {
    var t = $('token').value.trim()
    if (!t) { setAuthBanner('未认证：请输入管理员令牌并保存后才能查看和管理', false); return log('请输入令牌', 'warn') }
    localStorage.setItem(TOKEN_KEY, t)
    var show = $('setTokenShow')
    if (show) show.textContent = t.replace(/./g, '•')
    log('令牌已保存，正在验证…', 'green')
    refresh()
  }
  $('refresh').onclick = refresh

  // 初始化：有令牌则验证加载；无令牌明确提示未认证（不发请求）
  var saved = localStorage.getItem(TOKEN_KEY)
  if (saved) {
    $('token').value = saved
    var show0 = $('setTokenShow')
    if (show0) show0.textContent = saved.replace(/./g, '•')
  }
  refresh()
  // 实时雷达轮询（3s）：与 state 轮询节奏一致，机器人在线才有数据
  radarTimer = setInterval(pollRadar, 3000)
  setTimeout(pollRadar, 600)
})()
