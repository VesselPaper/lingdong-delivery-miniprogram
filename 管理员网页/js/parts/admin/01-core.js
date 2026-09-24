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

  // 「最近变更」摘要：来自 status_events 的最新一条
  function lastEventText(e) {
    if (!e) return '—'
    return esc(e.created_at || '') + ' · ' + esc(e.status_text || '')
  }
