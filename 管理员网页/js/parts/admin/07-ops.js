
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