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
