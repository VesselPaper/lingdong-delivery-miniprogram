/* ============================================================
 * js/dashboard/views-ui.js — 大屏 UI 渲染（纯函数）
 * ------------------------------------------------------------
 * 从原 dashboard.js 的「顶栏/渲染」各块抽出。每个函数只根据传入数据
 * 更新 DOM（复用节点 + 改文本，不无限 append），不持有渲染状态，
 * 不碰地图。通过 window.Dash.views.xxx 调用。
 *
 * 依赖：window.Dash = { C, ctx, state }
 * ============================================================ */
window.Dash.views = (function (Dash) {
  'use strict'

  var $ = Dash.ctx.$, txt = Dash.ctx.txt, setClass = Dash.ctx.setClass
  var num = Dash.ctx.num, hhmmss = Dash.ctx.hhmmss
  var state = Dash.state
  var C = Dash.C

  /* ---------------- 顶栏时钟 / 连接状态 ---------------- */

  function tickClock() { txt($('clock'), hhmmss(new Date())) }

  function setConn(ok, text) {
    var box = $('conn')
    setClass(box, 'conn' + (ok ? ' ok' : ' bad'))
    txt($('connText'), text)
  }

  /* ---------------- 渲染：运行状态 ---------------- */

  function renderRunState(d) {
    var shop = d.shop || {}
    txt($('kvShop'), shop.name || '零栋铺子')

    var biz = $('kvBusiness')
    txt(biz, shop.business_status === 'open' ? '营业中' : '休息中')
    setClass(biz, shop.business_status === 'open' ? 'on' : 'off')

    var auto = $('kvAuto')
    txt(auto, Number(shop.auto_accept) === 1 ? '已开启' : '已关闭')
    setClass(auto, Number(shop.auto_accept) === 1 ? 'on' : 'off')

    txt($('kvMode'), ({ demo: '演示', pilot: '试点', production: '正式' })[d.run_mode] || d.run_mode || '—')
    txt($('kvPlatform'), d.real_platform ? '真实平台' : '本地模拟')

    txt($('subTitle'), (shop.name || '零栋铺子') + ' · 四川师范大学成龙校区')
  }

  /* ---------------- 渲染：指标 ---------------- */

  // 带强调色的指标在 0 时退为弱色：0 不应该抢注意力（"待接单 0"标成橙色是噪音）
  function paintMetric(el, value) {
    var v = num(value)
    txt(el, v)
    if (el) {
      if (v === 0) el.classList.add('is-zero'); else el.classList.remove('is-zero')
    }
  }

  function renderStats(stats) {
    stats = stats || {}
    txt($('mToday'), num(stats.today_orders))
    txt($('mAmount'), '¥' + num(stats.today_amount).toFixed(0))
    paintMetric($('mPending'), stats.pending)
    txt($('mLoad'), num(stats.ready_load))
    paintMetric($('mDelivering'), stats.delivering)
    paintMetric($('mPickup'), stats.pickup)
    txt($('mException'), num(stats.exception))
    txt($('mAftersale'), num(stats.aftersale))
    txt($('mCancelReq'), num(stats.cancel_requests))
  }

  /* ---------------- 渲染：无人车列表 ---------------- */

  function statusClass(machine) {
    var m = String(machine || '')
    if (m === 'exception') return 's-bad'
    if (m === 'charging' || m === 'returnChargingPile') return 's-charging'
    if (m === 'Delivery' || m === 'delivery' || m === 'lightTask' || m === 'patrol' || m === 'Patrol') return 's-busy'
    return 's-idle'
  }

  function renderRobots(robots, error) {
    var list = $('robotList')
    robots = robots || []
    txt($('robotCount'), robots.length + ' 台')

    if (error && !robots.length) {
      renderSimpleList(list, [error], 'robotItem')
      $('robotEmpty').hidden = true
      return
    }

    var show = robots.slice(0, C.MAX_ROBOTS)
    // 固定行数复用：先补齐节点，再改文本（不做 clear + append）
    while (list.children.length < show.length) {
      var li = document.createElement('li')
      li.className = 'robotItem'
      li.innerHTML = '<span class="robotName"></span>'
        + '<span class="battery"><span class="batteryBar"><i></i></span><span class="batteryNum"></span></span>'
        + '<span class="robotStatus"></span>'
      list.appendChild(li)
    }
    while (list.children.length > show.length) list.removeChild(list.lastChild)

    show.forEach(function (r, i) {
      var li = list.children[i]
      var online = !!r.online
      setClass(li, 'robotItem' + (online ? '' : ' offline'))
      txt(li.querySelector('.robotName'), r.name || r.device_sn || '机器人')

      var bat = r.battery === null || r.battery === undefined ? null : num(r.battery)
      var bar = li.querySelector('.batteryBar')
      setClass(bar, 'batteryBar' + (bat === null ? '' : bat < 20 ? ' low' : bat < 50 ? ' mid' : ''))
      bar.firstChild.style.width = (bat === null ? 0 : Math.max(0, Math.min(100, bat))) + '%'
      txt(li.querySelector('.batteryNum'), bat === null ? '—' : bat + '%')

      var st = li.querySelector('.robotStatus')
      setClass(st, 'robotStatus ' + (online ? statusClass(r.machine_status) : 's-bad'))
      txt(st, online ? (r.machine_text || '在线') : '离线')
    })

    $('robotEmpty').hidden = show.length > 0
  }

  function renderSimpleList(list, messages, cls) {
    while (list.children.length < messages.length) {
      var li = document.createElement('li')
      li.className = cls
      list.appendChild(li)
    }
    while (list.children.length > messages.length) list.removeChild(list.lastChild)
    messages.forEach(function (m, i) { txt(list.children[i], m) })
  }

  /* ---------------- 渲染：进行中批次 ---------------- */

  function renderBatches(batches) {
    var list = $('batchList')
    batches = batches || []
    txt($('batchCount'), batches.length + ' 批')
    var show = batches.slice(0, C.MAX_BATCHES)

    while (list.children.length < show.length) {
      var li = document.createElement('li')
      li.className = 'batchItem'
      li.innerHTML = '<div class="batchTop"><span class="batchNo"></span><span class="batchStage"></span></div>'
        + '<div class="batchSub"><span>在途 <b class="bActive">0</b> 单</span>'
        + '<span>待取 <b class="bWait">0</b> 单</span>'
        + '<span class="bDevice"></span></div>'
      list.appendChild(li)
    }
    while (list.children.length > show.length) list.removeChild(list.lastChild)

    show.forEach(function (b, i) {
      var li = list.children[i]
      txt(li.querySelector('.batchNo'), '批次 ' + (b.batch_no || b.id) + (b.daily_seq ? ' · 当日第' + b.daily_seq + '批' : ''))
      var st = li.querySelector('.batchStage')
      setClass(st, 'batchStage s' + num(b.status))
      txt(st, b.status_text || ({ 0: '组单中', 1: '待上货', 2: '配送中' })[num(b.status)] || '—')
      txt(li.querySelector('.bActive'), num(b.active_orders))
      txt(li.querySelector('.bWait'), num(b.waiting_pickup))
      txt(li.querySelector('.bDevice'), b.device_sn ? String(b.device_sn).slice(-6) : '未指派')
    })

    $('batchEmpty').hidden = show.length > 0
  }

  /* ---------------- 渲染：取餐超时提醒 ---------------- */

  function renderAlerts(alerts) {
    alerts = (alerts || []).slice(0, C.MAX_ALERTS)
    $('alertPanel').hidden = alerts.length === 0
    var list = $('alertList')

    while (list.children.length < alerts.length) {
      var li = document.createElement('li')
      li.innerHTML = '<span class="who"></span><span class="stage"></span>'
      list.appendChild(li)
    }
    while (list.children.length > alerts.length) list.removeChild(list.lastChild)

    alerts.forEach(function (a, i) {
      var li = list.children[i]
      var who = (a.landmark_name || '取餐点') + ' · ' + (a.order_no || ('#' + a.id))
      txt(li.querySelector('.who'), who + (a.picking_up_at ? '（正在取餐）' : ''))
      txt(li.querySelector('.stage'), num(a.pickup_timeout_stage) >= 2 ? '二段超时·即将取消' : '一段超时·稍后返程')
    })
  }

  /* ---------------- 渲染：实时动态（对比上一轮快照，固定 MAX_EVENTS 条） ---------------- */

  function pushEvent(time, text) {
    state.events.unshift({ t: time, s: text })
    if (state.events.length > C.MAX_EVENTS) state.events.length = C.MAX_EVENTS
  }

  function diffEvents(d) {
    var p = state.prev
    var now = hhmmss(new Date())
    if (p) {
      // 车辆状态变化
      var prevRobots = {}
      ;(p.robots || []).forEach(function (r) { prevRobots[r.device_sn] = r })
      ;(d.robots || []).forEach(function (r) {
        var old = prevRobots[r.device_sn]
        if (!old) pushEvent(now, '发现车辆 ' + (r.name || r.device_sn) + ' 在线')
        else if (old.machine_text !== r.machine_text) {
          pushEvent(now, (r.name || r.device_sn) + ' 状态 ' + (old.machine_text || '未知') + ' → ' + (r.machine_text || '未知'))
        }
      })
      // 新批次
      var prevBatch = {}
      ;(p.batches || []).forEach(function (b) { prevBatch[b.id] = b })
      ;(d.batches || []).forEach(function (b) {
        if (!prevBatch[b.id]) pushEvent(now, '新建配送批次 ' + (b.batch_no || b.id) + '，共 ' + num(b.active_orders) + ' 单')
        else if (prevBatch[b.id].status !== b.status) {
          pushEvent(now, '批次 ' + (b.batch_no || b.id) + ' 进入「' + (b.status_text || b.status) + '」')
        }
      })
      // 新取餐超时
      var prevAlert = {}
      ;(p.pickup_alerts || []).forEach(function (a) { prevAlert[a.id] = a })
      ;(d.pickup_alerts || []).forEach(function (a) {
        var old = prevAlert[a.id]
        if (!old) pushEvent(now, '取餐超时告警：' + (a.landmark_name || '') + ' ' + (a.order_no || ''))
        else if (num(old.pickup_timeout_stage) !== num(a.pickup_timeout_stage)) {
          pushEvent(now, (a.order_no || '') + ' 取餐超时进入第 ' + num(a.pickup_timeout_stage) + ' 段')
        }
      })
    }
    renderEvents()
  }

  function renderEvents() {
    var list = $('eventList')
    while (list.children.length < state.events.length) list.appendChild(document.createElement('li'))
    while (list.children.length > state.events.length) list.removeChild(list.lastChild)
    state.events.forEach(function (e, i) {
      list.children[i].innerHTML = '<span class="eTime">' + e.t + '</span><span class="eText">' + e.s + '</span>'
    })
  }

  return {
    tickClock: tickClock, setConn: setConn,
    renderRunState: renderRunState, renderStats: renderStats,
    renderRobots: renderRobots, renderBatches: renderBatches,
    renderAlerts: renderAlerts, diffEvents: diffEvents, renderEvents: renderEvents
  }
})(window.Dash)