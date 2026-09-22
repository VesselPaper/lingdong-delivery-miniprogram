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
  var toastTimer = null
  var busy = false                // 状态轮询防重入
  var currentAdmin = null         // 当前登录的管理员（方案A：账号密码登录）
  var onUnauthorized = null       // 会话失效回调（由登录模块设置 → 弹登录页）

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

  // 管理员会话 token（方案A：登录签发的随机 session token，存 localStorage；不再有「输入令牌」框）
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