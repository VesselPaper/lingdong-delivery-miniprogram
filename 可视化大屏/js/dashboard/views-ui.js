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
  }

  /* ---------------- 渲染：指标 + 任务状态流水线 ---------------- */

  // 任务状态某一格：写数字 + 按 0/非 0 调色（0 不抢注意力；"在途"环节有量时点亮暖色）
  function flowStep(id, value, hot) {
    var el = $(id)
    if (!el) return
    var v = num(value)
    var b = el.querySelector('b')
    if (b) { txt(b, v); if (v === 0) b.classList.add('is-zero'); else b.classList.remove('is-zero') }
    el.classList.toggle('is-zero', v === 0)
    el.classList.toggle('hot', !!hot && v > 0)
  }

  function renderStats(stats) {
    stats = stats || {}
    txt($('mToday'), num(stats.today_orders))
    txt($('mAmount'), '¥' + num(stats.today_amount).toFixed(0))
    txt($('mFinished'), num(stats.finished))
    // 任务状态：配送任务流水线（待接单 → 待上货 → 配送中 → 待取货）
    flowStep('fsPending', stats.pending, false)
    flowStep('fsLoad', stats.ready_load, false)
    flowStep('fsDelivering', stats.delivering, true)
    flowStep('fsPickup', stats.pickup, true)
    txt($('mException'), num(stats.exception))
    txt($('mAftersale'), num(stats.aftersale))
    txt($('mCancelReq'), num(stats.cancel_requests))
  }

  /* ---------------- 渲染：车辆卡面（名称 / 状态 / 电量，点击选中） ---------------- */

  function statusClass(machine) {
    var m = String(machine || '')
    if (m === 'exception') return 's-bad'
    if (m === 'charging' || m === 'returnChargingPile') return 's-charging'
    if (m === 'Delivery' || m === 'delivery' || m === 'lightTask' || m === 'patrol' || m === 'Patrol') return 's-busy'
    return 's-idle'
  }

  // 每台车一张卡面（不再是表格行）：鼠标点卡面 = 选中该车（地图同步高亮、展开数据牌），
  // 再点一次取消选中。选中态由 state.selectedSn 统一驱动，地图点车也会回到这里重渲染。
  function renderRobots(robots, error) {
    var list = $('robotList')
    robots = robots || []
    // 车队快照留在 state：选中变化时无需等下一轮轮询即可立即重渲染卡面
    state.fleet = robots
    state.fleetError = error || ''
    txt($('robotCount'), robots.length + ' 台')

    if (error && !robots.length) {
      list.innerHTML = ''
      var e0 = document.createElement('li')
      e0.className = 'empty'
      e0.textContent = error
      list.appendChild(e0)
      $('robotEmpty').hidden = true
      return
    }

    var show = robots.slice(0, C.MAX_ROBOTS)
    // 固定行数复用：先补齐节点，再改文本（不做 clear + append）
    while (list.children.length < show.length) {
      var li = document.createElement('li')
      li.className = 'vcard'
      li.innerHTML = '<div class="vcTop"><span class="vcName"></span><span class="vcSn"></span></div>'
        + '<div class="vcBot"><span class="robotStatus"></span>'
        + '<span class="battery"><span class="batteryBar"><i></i></span><span class="batteryNum"></span></span></div>'
      list.appendChild(li)
    }
    while (list.children.length > show.length) list.removeChild(list.lastChild)

    show.forEach(function (r, i) {
      var li = list.children[i]
      var sn = String(r.device_sn || '')
      var online = !!r.online
      var offMap = !!r.not_on_map
      var on = !!state.selectedSn && sn === state.selectedSn
      setClass(li, 'vcard' + (on ? ' on' : '') + (online ? '' : ' offline') + (offMap ? ' offmap' : ''))
      li.setAttribute('data-sn', sn)
      li.title = offMap
        ? '这台车不在当前地图上（可能被挂到了扩建中的另一张图），因此不显示在地图中'
        : (on ? '已选中（再点取消；地图上同步高亮）' : '点击选中这台车（地图同步高亮）')
      li.onclick = function () {
        if (Dash.main && Dash.main.selectCar) Dash.main.selectCar(on ? null : sn)
      }

      txt(li.querySelector('.vcName'), r.name || sn || '机器人')
      txt(li.querySelector('.vcSn'), sn)

      var st = li.querySelector('.robotStatus')
      if (offMap) {
        // 不在此地图：电网状态无意义（画不上去），直接把原因写在状态位，避免误判成"离线/故障"
        setClass(st, 'robotStatus s-warn')
        txt(st, '不在此地图')
      } else {
        setClass(st, 'robotStatus ' + (online ? statusClass(r.machine_status) : 's-bad'))
        txt(st, online ? (r.machine_text || '在线') : '离线')
      }

      var bat = r.battery === null || r.battery === undefined ? null : num(r.battery)
      var bar = li.querySelector('.batteryBar')
      setClass(bar, 'batteryBar' + (bat === null ? '' : bat < 20 ? ' low' : bat < 50 ? ' mid' : ''))
      bar.firstChild.style.width = (bat === null ? 0 : Math.max(0, Math.min(100, bat))) + '%'
      txt(li.querySelector('.batteryNum'), bat === null ? '—' : bat + '%')
    })

    $('robotEmpty').hidden = show.length > 0
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

  /* ---------------- 渲染：实时动态（读后端 status_events，刷新不丢） ----------------
   * 2026-10-19 改口径：以前这里是**在浏览器内存里现算差异** —— 前端对比上一轮轮询快照，
   * 拼出「发现车辆 X 在线」「批次进入某某」这类文案存进 state.events。问题：
   *   · 只活在当前标签页，刷新/关页即清空，等于没有日志；
   *   · 多块屏各算各的，同一时刻内容不一致；
   *   · 事后无法追溯（谁在什么时候改了什么，全丢了）。
   * 现在改为后端在 overview 里下发 log_events（读 status_events 表），前端只负责摆位置。
   * 后端返回的已经是拼好的人读文案 { id, t, s }，前端不再维护状态字典。
   * ------------------------------------------------------------- */

  function renderEvents() {
    var list = $('eventList')
    if (!list) return
    var evs = state.events || []
    while (list.children.length < evs.length) list.appendChild(document.createElement('li'))
    while (list.children.length > evs.length) list.removeChild(list.lastChild)
    evs.forEach(function (e, i) {
      var li = list.children[i]
      // old = 非当天。时间已由后端格式化成「MM-DD HH:MM」，这里只负责压暗，不再做日期计算。
      li.className = e.old ? 'old' : ''
      li.innerHTML = '<span class="eTime">' + (e.t || '') + '</span><span class="eText">' + (e.s || '') + '</span>'
    })
  }

  // 解析后端下发的日志。失败时保留上一轮内容（网络抖动不该把墙上日志清空）。
  function applyEvents(d) {
    var evs = d && d.log_events
    if (Array.isArray(evs)) state.events = evs
    renderEvents()
  }

  return {
    tickClock: tickClock, setConn: setConn,
    renderRunState: renderRunState, renderStats: renderStats,
    renderRobots: renderRobots, renderBatches: renderBatches,
    renderAlerts: renderAlerts, applyEvents: applyEvents, renderEvents: renderEvents
  }
})(window.Dash)