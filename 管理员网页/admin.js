/* ============================================================
   零栋送餐 · 调度台 —— 管理员前端逻辑 v4
   ------------------------------------------------------------
   本文件是 IIFE 的第一片（01-core）：头部注释、常量、基础工具。
   收尾（启动 + `})()`）在最后一片 09-ops.js。

   页面结构（2026-09 重构；2026-10-12 起导航三项）：
   · 总览：机器人（卡片 + 校园实时地图 + 异常告警）/ 操作日志（服务端审计 + 状态字典 + 会话回显）
   · 商家管理：创建账号 / 已创建列表（编辑弹窗：改用户名 / 改权限 / 重置密码 / 删除账号）
   · 设置：账号 / 危险操作（机器人控制页 2026-09-26 移除：控制权与点位同步均由业务自动管理）

   交互约定（铁律）：
   · **2026-10-12：订单相关操作一律在商家端小程序**。「配送数据」页（批次 / 订单 / 任务三类卡片的
     搜索、状态筛选、右键操作）已整页删除；随页面一起下线的还有它仅剩的任务级「关闭并作废 / 仅作废」
     （同属订单相关操作）。后端接口保留（回归测试与「一键初始化」复用），管理页不再提供入口。
   · 管理员侧只保留机器人本体相关的监控与配置：总览 / 商家管理 / 设置。
   · 机器人卡的破坏性动作（停止并取消任务）仍走后端统一落账：未送达订单取消并自动退款
     （用户端以「配送小车异常」售后记录可见），双端一致，杜绝死锁。
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
  // WS live 推送的机器人位置。当前**只赋值、无人读取**（渲染改走 window.mapOnLive 直推地图，
  // 读它的唯一消费者 07-drawer 已随「配送数据」页一并移除）——留作兜底，别当成在用。
  var liveRobots = []
  var toastTimer = null
  var busy = false                // 状态拉取防重入
  var currentAdmin = null         // 当前登录的管理员（方案A：账号密码登录）
  var onUnauthorized = null       // 会话失效回调（由 06 片设置 → 弹登录页）

  // ---------- 基础工具 ----------
  // 安全转义（安全审计 2026-09-26 H1）：必须覆盖 & < > " ' 五类字符，否则属性上下文（如
  // <img src="...">）可被引号逃逸注入。顺序：& 最先（避免二次转义），引号对属性注入至关重要。
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

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
        // 单点登录（2026-10-11）：被"别处登录"顶下线的旧会话，后端回 code=SESSION_KICKED。
        // 标在 error 上，让会话失效回调能给出明确提示（而不是笼统的"登录已过期"）。
        err.kicked = (j.code === 'SESSION_KICKED')
        // 登录接口自身的 401（密码错误）不触发全局会话失效回调，否则会清空用户刚输入的账号密码
        if (r.status === 401 && path !== '/login') { if (onUnauthorized) onUnauthorized(err); throw err }
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

  // 时间线节点圆点配色
  function statusDotClass(type, status) {
    var s = Number(status)
    if (type === 'order') return s === 4 ? 'ok' : s === 2 ? 'busy' : s === 3 ? 'wait' : (s === 5 || s === 7 || s === 6) ? 'bad' : 'warn'
    if (type === 'batch') return s === 3 ? 'ok' : s === 2 ? 'busy' : s === 4 ? 'bad' : 'warn'
    return s === 80 ? 'ok' : [90, 100, 120].indexOf(s) >= 0 ? 'bad' : [1, 110, 150].indexOf(s) >= 0 ? 'bad' : (s >= 50 && s < 80 ? 'wait' : 'busy')
  }


  // ---------- 导航（总览 / 商家管理 / 设置） ----------
  // 2026-10-12：「配送数据」整页删除（订单相关操作全在商家端小程序），导航从 4 项回到 3 项
  var PAGE_META = {
    overview: { title: '总览', sub: '机器人状态、异常与死锁监控' },
    merchants: { title: '商家管理', sub: '商家账号的创建、角色与状态维护' },
    settings: { title: '设置', sub: '账号与控制权' }
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
    showPanel('settingsPanel', tab, ['account'])
  })

  // ---------- 商家管理页标签（创建 / 已创建） ----------
  wireTabs('merchantsTabs', function (tab) {
    showPanel('merchantsPanel', tab, ['create', 'list'])
    if (tab === 'list') loadMerchants()
  })


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

  // 2026-10-12：配送数据页已从管理员网页移除（订单/任务管理只在商家端进行），
  // 订单/批次/任务的右键菜单 ctxOrder/ctxBatch/ctxTask 一并删除。

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
      $('rStatusTime').textContent = r.status_update_time || '—'
      $('rFloor').textContent = (r.floor || '—') + ' · ' + esc(r.building || '—')
    } else {
      $('rMachine').textContent = '—'
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
    // 安全审计 L7：token 只走 WS 子协议（bearer-<token>），不放 URL query（避免进访问日志/浏览器历史）
    return proto + '//' + location.host + '/ws'
  }
  function connectWS() {
    if (!token()) return
    if (ws) { try { ws.close() } catch (e) {} ws = null }
    var sock = new WebSocket(wsURL(), ['bearer-' + token()])
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
        // 被"别处登录"踢下线时，onUnauthorized 已经写了明确提示，这里不要用笼统文案覆盖它
        if (!e.kicked) setAuthBanner('登录已过期：请重新登录', true)
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
    // 2026-10-14 修：这里原先调 closeDrawer()，但抽屉（07 片）已在 2026-10-12 随「配送数据」页被删除，
    // 函数不存在 → 退出登录时会抛 ReferenceError，把后面的 showLogin()/日志一起中断（表现为点了退出没反应）。
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
  // 单点登录（2026-10-11）：同一管理员只允许一个会话，被新登录顶掉时后端回 code=SESSION_KICKED；
  // 必须告诉用户"账号在别处登录了"，否则他只会看到登录页莫名弹出、以为系统坏了。
  onUnauthorized = function (e) {
    currentAdmin = null
    showLogin()
    if (e && e.kicked) {
      setAuthBanner('该账号已在别处登录，你已被踢下线：请重新登录', true)
      log('会话被踢下线：该管理员账号在其他地方登录了', 'bad')
    }
  }

  // 登录页 / 账号页事件
  $('loginBtn').onclick = adminLogin
  $('loginPass').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') adminLogin() })
  $('loginUser').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { var p = $('loginPass'); if (p) p.focus() } })
  $('logoutBtn').onclick = logout
  $('savePass').onclick = changePassword


  // ---------- 操作日志（服务端持久化审计：成功与失败都在） ----------
  // 读 GET /admin/audit（后端由 auditMw 中间件统一写入，不依赖前端上报）。
  // 前端内存日志（#log）只作「本次会话回显」，与审计无关。
  // 人话显示（2026-09-26）：action 机器码 → 中文动作，target（order#12 等）→ 中文对象；
  // 动作筛选从自由输入改为下拉（值即后端 action 前缀，匹配逻辑不变）。
  var auditState = { offset: 0, limit: 50, total: 0, rows: [], loading: false }

  // action 机器码 → 中文动作（与后端 domains/**/routes.js 的 audit() 标注一一对应）
  var AUDIT_TEXT = {
    'admin/login': '登录',
    'admin/logout': '退出登录',
    'admin/password': '修改密码',
    'admin/task-cancel': '取消排队任务',
    'admin/task-close': '关闭平台任务',
    'admin/precreate-del': '删除预创建任务',
    'admin/drawer': '开关舱门',
    'admin/robot-summon': '召唤机器人',
    'admin/robot-stop': '驻停机器人',
    'admin/robot-recover': '恢复机器人任务',
    'admin/robot-stop-cancel': '停止并取消任务',
    'admin/robot-cancel-tasks': '取消机器人全部任务',
    'admin/control-grant': '获取设备控制权',
    'admin/control-release': '释放设备控制权',
    'admin/landmarks-sync': '同步平台点位',
    'admin/order-cancel': '取消订单',
    'admin/task-close-void': '关闭并作废任务',
    'admin/batch-cancel': '清理批次',
    'admin/orders-bulk-cancel': '批量取消订单',
    'admin/batches-bulk-cancel': '批量取消批次',
    'admin/tasks-bulk-close-void': '批量关闭作废任务',
    'admin/reset': '一键初始化',
    'admin/task-void': '作废任务',
    'admin/merchant-create': '创建商家账号',
    'admin/merchant-role': '修改商家权限',
    'admin/merchant-password': '重置商家密码',
    'admin/merchant-disable': '停用商家账号',
    'admin/merchant-enable': '启用商家账号',
    'admin/merchant-username': '修改商家用户名',
    'admin/merchant-delete': '删除商家账号',
    'batch/dispatch': '批次派车',
    'device/batch-open': '批次开舱',
    'device/batch-close': '批次关舱',
    'device/batch-dispatch': '批次开始配送',
    'test/mock-dispatch': '模拟派车',
    'test/complete': '测试完成任务',
    'device/scan': '商家扫码设备',
    'device/open-bin': '打开舱门',
    'device/close-bin': '关闭舱门',
    'device/dispatch': '配送任务下发',
    'shop/update': '修改店铺设置',
    'goods/stock': '修改商品库存',
    'goods/create': '上架商品',
    'goods/update': '修改商品',
    'goods/status': '商品上架停售',
    'activity/create': '创建活动',
    'activity/update': '修改活动',
    'activity/status': '活动启停',
    'activity/delete': '删除活动',
    'cancel-request/approve': '同意取消申请',
    'cancel-request/reject': '拒绝取消申请',
    'refund/approve': '同意退款',
    'refund/reject': '拒绝退款',
    'complaint/reply': '回复投诉',
    'order/confirm': '确认接单',
    'order/exception-retry': '订单异常重试',
    'order/exception-refund': '订单异常退款'
  }
  // 自动推导动作（后端 auditAction 兜底，形如「admin/order/cancel [POST]」）的路径段中文
  var AUDIT_SEG = {
    admin: '管理端', user: '用户端', merchant: '商家端', auth: '登录',
    order: '订单', goods: '商品', batch: '批次', task: '任务', device: '设备',
    shop: '店铺', activity: '活动', cart: '购物车', refund: '退款',
    'cancel-request': '取消申请', complaint: '投诉', platform: '平台',
    delivery: '配送', landmark: '点位', test: '测试'
  }
  var AUDIT_METHOD = { POST: '提交', PUT: '修改', DELETE: '删除', PATCH: '修改' }

  // 动作码 → 人话；显式字典优先，兜底解析「路径 [方法]」形式
  function auditText(a) {
    var s = String(a || '')
    if (AUDIT_TEXT[s]) return AUDIT_TEXT[s]
    var m = s.match(/^(.*?)\s*\[\s*([A-Z]+)\s*\]$/)
    if (m) {
      var segs = String(m[1]).split('/').filter(Boolean)
      var parts = segs.map(function (x) { return AUDIT_SEG[x] || x })
      var verb = AUDIT_METHOD[m[2]] || m[2]
      return parts.concat(verb).join(' · ')
    }
    return s || '未知操作'
  }

  // 对象码（order#12 等）→ 人话
  function auditTarget(t) {
    var s = String(t || '')
    var m = s.match(/^([a-zA-Z_]+)#(.+)$/)
    if (!m) return s
    var kind = { order: '订单', batch: '批次', task: '任务', 'platform_task': '平台任务', 'merchant-user': '商家账号', device: '设备', goods: '商品', activity: '活动', refund: '退款单', 'cancel_request': '取消申请', 'one-shot': '全局' }[m[1]]
    return kind ? kind + ' ' + m[2] : s
  }

  function auditQuery() {
    var role = ($('auditRole') && $('auditRole').value) || 'admin'
    var okv = ($('auditResult') && $('auditResult').value) || ''
    var act = ($('auditAction') && $('auditAction').value) || ''
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
    if (r.user_role === 'admin') return '管理员' + (r.user_id ? ' #' + r.user_id : '')
    if (r.user_role === 'merchant') return '商家' + (r.user_id ? ' #' + r.user_id : '')
    if (r.user_role === 'student') return '用户' + (r.user_id ? ' #' + r.user_id : '')
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
        var act = auditText(r.action)
        var tgt = r.target ? auditTarget(r.target) : ''
        return '<div class="audit-row' + (ok ? '' : ' fail') + '">'
          + '<span class="audit-time">' + esc(r.created_at || '') + '</span>'
          + '<span class="audit-badge ' + (ok ? 'ok' : 'err') + '">' + (ok ? '成功' : '失败') + '</span>'
          + '<span class="audit-who">' + esc(auditWho(r)) + '</span>'
          + '<span class="audit-act" title="' + esc(r.action || '') + '">' + esc(act) + '</span>'
          + (tgt ? '<span class="audit-tgt">' + esc(tgt) + '</span>' : '')
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
    // 动作筛选下拉：选项 = 常用动作（值即后端 action 前缀，显示中文）
    var actSel = $('auditAction')
    if (actSel) {
      var common = [
        ['', '全部动作'],
        ['admin/merchant-create', '创建商家账号'],
        ['admin/merchant-username', '修改商家用户名'],
        ['admin/merchant-role', '修改商家权限'],
        ['admin/merchant-password', '重置商家密码'],
        ['admin/merchant-disable', '停用商家账号'],
        ['admin/merchant-enable', '启用商家账号'],
        ['admin/merchant-delete', '删除商家账号'],
        ['admin/order-cancel', '取消订单'],
        ['admin/orders-bulk-cancel', '批量取消订单'],
        ['admin/batch-cancel', '清理批次'],
        ['admin/batches-bulk-cancel', '批量取消批次'],
        ['admin/task-close-void', '关闭并作废任务'],
        ['admin/task-void', '作废任务'],
        ['admin/task-close', '关闭平台任务'],
        ['admin/drawer', '开关舱门'],
        ['admin/robot-summon', '召唤机器人'],
        ['admin/robot-stop', '驻停机器人'],
        ['admin/robot-stop-cancel', '停止并取消任务'],
        ['admin/reset', '一键初始化'],
        ['batch/dispatch', '批次派车'],
        ['device/dispatch', '配送任务下发'],
        ['device/open-bin', '打开舱门'],
        ['device/close-bin', '关闭舱门'],
        ['goods/create', '上架商品'],
        ['goods/status', '商品上架停售'],
        ['refund/approve', '同意退款'],
        ['cancel-request/approve', '同意取消申请'],
        ['admin/login', '登录']
      ]
      actSel.innerHTML = common.map(function (o) {
        return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'
      }).join('')
    }
    var role = $('auditRole'); if (role) role.addEventListener('change', function () { loadAudit(true) })
    var res = $('auditResult'); if (res) res.addEventListener('change', function () { loadAudit(true) })
    if (actSel) actSel.addEventListener('change', function () { loadAudit(true) })
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


  // ---------- 商家管理（商家账号：创建 / 列表 / 编辑 / 停用启用，2026-09-24 起替代邀请码） ----------
  // 后端：/api/admin/merchants*（admin 域）。商家端登录 = 用户名+密码（scrypt），角色 owner=店主 / staff=店员。
  // 说明：密码只在创建/重置时输入；列表永不返回密码与 token。
  // 结构（2026-09-26 调整）：列表每行只留「编辑」与「启用/停用」两个按钮（启用绿、停用红便于区分）；
  // 修改权限 / 重置密码 / 删除账号 / 修改用户名 全部收敛进「编辑」弹窗。
  var merchantsCache = null

  function loadMerchants() {
    api('/merchants').then(function (d) {
      merchantsCache = d
      renderMerchants()
    }).catch(function (e) {
      if (!isUnauthorized(e)) {
        var box = $('merchantList'); if (box) box.innerHTML = '<span class="mini bad">加载失败：' + esc(e.message) + '</span>'
      }
    })
  }
  window.loadMerchants = loadMerchants

  function merchantById(id) {
    return (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
  }

  function renderMerchants() {
    var list = $('merchantList')
    if (!list) return
    var d = merchantsCache
    if (!d) { list.innerHTML = '<span class="mini">加载中…</span>'; return }
    var ms = d.merchants || []
    var cnt = $('merchantCount'); if (cnt) cnt.textContent = '共 ' + ms.length + ' 个账号'
    if (!ms.length) { list.innerHTML = '<span class="mini">暂无账号</span>'; return }
    var html = ''
    ms.forEach(function (m) {
      var roleTxt = m.merchant_role === 'owner' ? '店主' : '店员'
      var roleCls = m.merchant_role === 'owner' ? 'blue' : 'violet'
      var stateTxt = m.active ? '启用' : '停用'
      var stateCls = m.active ? 'green' : 'gray'
      html += '<div class="merchant-row">'
        + '<div class="merchant-main">'
        + '<div class="merchant-name">' + esc(m.username || '') + ' <span class="tag ' + roleCls + '">' + roleTxt + '</span> <span class="tag ' + stateCls + '">' + stateTxt + '</span></div>'
        + '<div class="mini">创建于 ' + esc(m.created_at || '') + '</div>'
        + '</div>'
        + '<div class="merchant-ops">'
        + '<button class="btn ghost sm" onclick="merchantEdit(' + m.id + ')">编辑</button>'
        + (m.active
            ? '<button class="btn danger sm" onclick="merchantDisable(' + m.id + ')">停用</button>'
            : '<button class="btn ok sm" onclick="merchantEnable(' + m.id + ')">启用</button>')
        + '</div>'
        + '</div>'
    })
    list.innerHTML = html
  }

  // 创建：用户名+密码+权限（店名不再收集：单店铺模式，账号即登录身份）
  function merchantCreate() {
    var username = $('merchantUsername').value.trim()
    var password = $('merchantPassword').value
    var role = document.querySelector('input[name="merchantRole"]:checked')
    var msg = $('merchantCreateMsg')
    if (!username) { msg.className = 'token-msg err'; msg.innerHTML = '请填写用户名'; return }
    if (password.length < 8) { msg.className = 'token-msg err'; msg.innerHTML = '密码至少 8 位'; return }
    $('merchantCreate').disabled = true
    msg.className = 'token-msg'; msg.innerHTML = '创建中…'
    api('/merchants/create', 'POST', {
      username: username,
      password: password,
      merchant_role: role && role.value === 'owner' ? 'owner' : 'staff'
    }).then(function () {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg ok'
      msg.innerHTML = '已创建：' + esc(username)
      $('merchantUsername').value = ''; $('merchantPassword').value = ''
      loadMerchants()
    }).catch(function (e) {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg err'
      msg.innerHTML = esc((e && e.message) || '创建失败')
    })
  }
  window.merchantCreate = merchantCreate

  // ---------- 编辑弹窗：用户名 / 权限 / 重置密码 / 删除账号，右下角统一保存 ----------
  var merchantEditId = null

  function merchantEdit(id) {
    var m = merchantById(id)
    if (!m) return
    merchantEditId = id
    var html = ''
      + '<div class="token-box">'
      + '<span class="token-label">用户名</span>'
      + '<div class="token-input-wrap"><input id="merEditUsername" value="' + esc(m.username || '') + '" placeholder="2~32 位字母/数字/下划线" autocomplete="off" spellcheck="false"></div>'
      + '</div>'
      + '<div class="token-box">'
      + '<span class="token-label">权限</span>'
      + '<div class="row-radio">'
      + '<label class="radio"><input type="radio" name="merEditRole" value="owner" ' + (m.merchant_role === 'owner' ? 'checked' : '') + '><span>店主</span></label>'
      + '<label class="radio"><input type="radio" name="merEditRole" value="staff" ' + (m.merchant_role !== 'owner' ? 'checked' : '') + '><span>店员</span></label>'
      + '</div>'
      + '</div>'
      + '<div class="token-box">'
      + '<span class="token-label">重置密码</span>'
      + '<button class="btn ghost sm" type="button" onclick="merchantEditTogglePass()"><svg><use href="#i-key"/></svg><span>重置密码</span></button>'
      + '<div class="token-input-wrap" id="merEditPassWrap" hidden>'
      + '<input id="merEditPass" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" spellcheck="false">'
      + '</div>'
      + '</div>'
      + '<div class="token-msg" id="merchantEditMsg"></div>'
    $('merchantEditTitle').textContent = '编辑商家账号'
    $('merchantEditBody').innerHTML = html
    $('merchantEditModal').hidden = false
    var first = $('merEditUsername'); if (first) { try { first.focus() } catch (e) {} }
  }
  window.merchantEdit = merchantEdit
  window.closeMerchantEdit = function () { $('merchantEditModal').hidden = true; merchantEditId = null }
  $('merchantEditModal').addEventListener('click', function (e) {
    if (e.target === $('merchantEditModal')) closeMerchantEdit()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('merchantEditModal').hidden) closeMerchantEdit()
  })

  // 重置密码按钮：点击展开新密码输入框（再次点击收起）
  function merchantEditTogglePass() {
    var wrap = $('merEditPassWrap')
    if (wrap) wrap.hidden = !wrap.hidden
    if (!wrap.hidden) { var p = $('merEditPass'); if (p) { try { p.focus() } catch (e) {} } }
  }
  window.merchantEditTogglePass = merchantEditTogglePass

  // 统一保存：用户名 / 权限 / 密码 只提交有变更的字段，逐个落库；全部成功才关弹窗
  function merchantEditSave() {
    var m = merchantById(merchantEditId)
    if (!m) return
    var msg = $('merchantEditMsg')
    var tasks = []
    var nu = $('merEditUsername') ? $('merEditUsername').value.trim() : ''
    if (nu !== m.username) {
      if (!/^[A-Za-z0-9_]{2,32}$/.test(nu)) { if (msg) { msg.className = 'token-msg err'; msg.innerHTML = '用户名限 2~32 位字母/数字/下划线' } ; return }
      tasks.push({ label: '用户名', fn: function () { return api('/merchants/username', 'PUT', { id: merchantEditId, username: nu }) } })
    }
    var sel = document.querySelector('input[name="merEditRole"]:checked')
    var nr = sel && sel.value === 'owner' ? 'owner' : 'staff'
    if (nr !== m.merchant_role) {
      tasks.push({ label: '权限', fn: function () { return api('/merchants/role', 'PUT', { id: merchantEditId, merchant_role: nr }) } })
    }
    var np = $('merEditPass') ? $('merEditPass').value : ''
    if (np) {
      if (String(np).length < 8) { if (msg) { msg.className = 'token-msg err'; msg.innerHTML = '新密码至少 8 位' } ; return }
      tasks.push({ label: '密码', fn: function () { return api('/merchants/password', 'POST', { id: merchantEditId, password: np }) } })
    }
    if (!tasks.length) { if (msg) { msg.className = 'token-msg warn'; msg.innerHTML = '没有需要保存的修改' } ; return }
    if (msg) { msg.className = 'token-msg'; msg.innerHTML = '保存中…' }
    var i = 0
    function next() {
      if (i >= tasks.length) {
        if (msg) { msg.className = 'token-msg ok'; msg.innerHTML = '已保存' }
        toast('商家账号已保存', 'ok')
        loadMerchants()
        setTimeout(closeMerchantEdit, 400)
        return
      }
      tasks[i].fn().then(function () { i++; next() }).catch(function (e) {
        if (msg) { msg.className = 'token-msg err'; msg.innerHTML = esc((e && e.message) || '保存失败') }
        opFail(e, '保存商家账号')
      })
    }
    next()
  }
  window.merchantEditSave = merchantEditSave

  // 删除该账号（右下角）：二次确认后物理删除，历史订单不受影响
  function merchantDelete() {
    var m = merchantById(merchantEditId)
    if (!m) return
    openConfirmModal('删除商家账号', '删除后 <b>' + esc(m.username || '') + '</b> 将无法登录，不可恢复。确定删除？', function () {
      api('/merchants/delete', 'POST', { id: merchantEditId }).then(function () {
        toast('账号已删除', 'ok')
        closeMerchantEdit()
        loadMerchants()
      }).catch(function (e) { opFail(e, '删除账号') })
    })
  }
  window.merchantDelete = merchantDelete

  function merchantDisable(id) {
    var m = merchantById(id)
    var name = m ? (m.username || '') : ''
    openConfirmModal('停用账号', '停用后 <b>' + esc(name || '该账号') + '</b> 将无法登录（已登录也会失效）。确定停用？', function () {
      api('/merchants/disable', 'POST', { id: id }).then(function () {
        toast('已停用', 'ok')
        loadMerchants()
      }).catch(function (e) { opFail(e, '停用') })
    })
  }
  window.merchantDisable = merchantDisable

  function merchantEnable(id) {
    api('/merchants/enable', 'POST', { id: id }).then(function () {
      toast('已启用', 'ok')
      loadMerchants()
    }).catch(function (e) { opFail(e, '启用') })
  }
  window.merchantEnable = merchantEnable

  // 页面事件绑定
  var cBtn = $('merchantCreate')
  if (cBtn) cBtn.onclick = merchantCreate
  var rBtn = $('merchantReload')
  if (rBtn) rBtn.onclick = loadMerchants


  // ---------- 单项操作（走后端统一落账） ----------
  function opFail(e, label) {
    if (isUnauthorized(e)) {
      // 被"别处登录"踢下线时保留 onUnauthorized 写的明确提示，不要覆盖成笼统文案
      if (!e.kicked) setAuthBanner('登录已失效：无法认证，不能查看和管理', true)
      log('认证失败：' + e.message, 'bad')
    } else {
      toast(label + ' 失败：' + e.message, 'err')
      log(label + ' 失败：' + e.message, 'bad')
    }
  }

  // ---------- 确认对话框（替代浏览器原生 confirm；危险操作二次确认） ----------
  var confirmCtx = null
  window.openConfirmModal = function (title, bodyHtml, onOk) {
    confirmCtx = { onOk: onOk || null }
    $('confirmTitle').textContent = title
    $('confirmBody').innerHTML = bodyHtml
    $('confirmOk').disabled = false
    $('confirmModal').hidden = false
    // 危险操作默认焦点放「取消」，避免误回车直接执行
    var cancel = $('confirmCancel')
    if (cancel) cancel.focus()
  }
  window.closeConfirmModal = function () {
    $('confirmModal').hidden = true
    confirmCtx = null
  }
  window.confirmOkClick = function () {
    if (!confirmCtx || !confirmCtx.onOk) { closeConfirmModal(); return }
    var onOk = confirmCtx.onOk
    closeConfirmModal()
    onOk()
  }
  $('confirmOk').addEventListener('click', confirmOkClick)
  // Esc 关闭；点遮罩关闭（与 ctxMenu 的 Esc 监听互不冲突，只在确认框打开时生效）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('confirmModal').hidden) closeConfirmModal()
  })
  $('confirmModal').addEventListener('click', function (e) {
    if (e.target === $('confirmModal')) closeConfirmModal()
  })

  function run(label, p, body, successMsg) {
    log(label + ' …')
    api(p, 'POST', body).then(function () {
      log(successMsg || label + ' 成功', 'green')
      toast(successMsg || label + ' 成功', 'ok')
      refresh()
      if (overviewTab === 'log') loadAudit(true)   // 操作日志页正开着就顺带刷新
    }).catch(function (e) { opFail(e, label) })
  }
  function confirmRun(label, p, body, confirmText, successMsg) {
    window.openConfirmModal('确认操作',
      '<p class="confirm-body warn">' + esc(confirmText) + '</p>',
      function () { run(label, p, body, successMsg) })
  }

  // 2026-10-07：「删除订单」「清理批次」已迁到商家端小程序；
  // 2026-10-12：管理员「配送数据」整页删除，任务级的「关闭并作废 / 仅作废」随页面一起下线
  // （同属订单相关操作）。对应后端接口（/admin/task/close-void、/admin/task/void）全部保留，
  // 供回归测试复用，只是管理页不再提供入口 —— 订单相关操作一律在商家端小程序。

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
      if (!targets.length) { toast('暂无可召唤点位', 'err'); return }
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
  // 停止并取消任务：关闭该设备全部活跃平台任务 + 未送达订单取消并**自动退款**（写售后记录，
  // 用户端「退款」列表可见「配送小车异常…」）+ 已送达订单跳过（交取餐超时流程）+ 批次置 4。
  // 先 dry_run 预演拿影响范围，再让管理员看着「N 单 / ¥X / 已送达 M 单」按确认 —— 一车多单时
  // 不能只写一句「取消关联订单」，否则管理员不知道会退掉多少钱。
  window.actStopCancel = function () {
    var sn = state && state.robot ? state.robot.device_sn : ''
    if (!sn) { toast('当前无机器人信息', 'err'); return }
    api('/robot/cancel-tasks', 'POST', { device_sn: sn, dry_run: true }).then(function (d) {
      var n = Number((d && d.refundable) || 0)
      var amt = Number((d && d.refund_amount) || 0)
      var m = Number((d && d.delivered) || 0)
      var html = '<p class="confirm-body warn">确定取消机器人 ' + esc(sn) + ' 当前的全部任务？</p>'
        + '<p class="confirm-body">将取消并<strong>自动退款</strong> <b>' + n + '</b> 单，合计 <b>¥' + amt.toFixed(2) + '</b>；'
        + '退款记录同步到用户端，说明为「配送小车异常」。</p>'
      if (m) {
        html += '<p class="confirm-body">另有 <b>' + m + '</b> 单已送达（餐已在舱内或用户手上），不自动退款，按取餐超时流程处理。</p>'
      }
      html += '<p class="confirm-body warn">不可撤销。</p>'
      window.openConfirmModal('确认操作', html, function () {
        run('取消机器人 ' + sn + ' 的全部任务', '/robot/cancel-tasks', { device_sn: sn },
          '已取消该机器人的全部任务：未送达订单已自动退款')
      })
    }).catch(function (e) { opFail(e, '查询待取消订单') })
  }

  // ---------- 设置页：控制权 / 点位 ----------
  // 2026-09-26 移除：设备控制权与点位同步均由业务路径自动管理（扫码开舱自动获取、派车缺映射自动同步），
  // 管理员手动入口无使用场景，随「机器人控制」页一并删除（后端接口保留）。
  // 2026-10-12 移除「一键初始化」（设置→危险操作）：管理员网页细分后只管机器人事务，
  // 订单/任务管理只在商家端进行，清理订单统一走商家端「订单异常管理」入口（后端 /admin/reset 保留供测试）。

  // ---------- 其他控件绑定 ----------
  $('refresh').onclick = refresh
  var moreBtn = $('robotMoreBtn')
  if (moreBtn) moreBtn.addEventListener('click', function (ev) { ev.stopPropagation(); window.showRobotMenu(ev) })

  // ---------- 启动 ----------
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
