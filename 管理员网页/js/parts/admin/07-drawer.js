
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
