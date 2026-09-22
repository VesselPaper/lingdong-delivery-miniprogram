// admin 域业务逻辑：状态字典 + 管理员状态总览（死锁/异常检测）+ 大屏只读聚合
// 依赖注入：(store, deps)。deps = { runtime, platform, goods, order, orderCancel }
// 跨域读全部为只读聚合（05 方案明确允许）；订单取消等写操作一律走 deps.order.applyOrderCancelled（order 域落账）。

const q = require('./queries')
// 编号格式化：批次人读短号（B-MMDD-NN）
const seqSvc = require('../../services/seq')
// 状态字典（订单/批次/任务状态码 → 中文），与 status_events 写入时用的同一份
const statusSvc = require('../../services/statusEvents')

// 状态字典（机器状态码/任务状态码 → 中文），供页面展示状态关系
const ADMIN_TASK_STATUS = {
  0: '排队中', 1: '已取消', 10: '任务已接收', 20: '去往上货点', 30: '到达上货点',
  40: '上货中', 50: '已上货', 60: '去往取货点', 70: '到达取货点', 71: '等待取餐',
  80: '任务完成', 90: '上货失败', 100: '取货失败', 110: '任务取消', 120: '上货流程挂起', 150: '任务关闭'
}

// 管理员状态总览：设备 + 平台活跃任务 + 本地批次/订单/任务 + 死锁/异常检测
async function buildAdminState(store, deps) {
  const out = { server_time: new Date().toLocaleString('zh-CN', { hour12: false }) }
  // 设备状态
  const dev = await deps.platform.getDeviceList()
  out.robot = dev.ok && dev.robots && dev.robots.length ? dev.robots[0] : null
  out.robot_error = dev.ok ? '' : dev.msg
  // 平台任务（全部，页面自行过滤展示）
  const pt = await deps.platform.listPlatformTasks(store)
  out.platform_tasks = pt.ok ? pt.tasks : []
  out.platform_tasks_error = pt.ok ? '' : pt.msg
  // 本地批次/订单/任务：活跃全量 + 终态最近 100 条（管理页分类展示：活跃在前、历史在后）
  out.batches = q.activeBatches(store).concat(q.historyBatches(store))
    .map((b) => Object.assign({}, b, { code_short: seqSvc.batchShortOf(b.seq_date, b.created_at, b.daily_seq || b.id) }))
  out.orders = q.orderCards(store, q.activeOrders(store).concat(q.historyOrders(store)))
  out.tasks = q.activeTasks(store).concat(q.historyTasks(store))

  // 卡片上的「最近变更」摘要 + 订单的设备归属（订单表没有 device_sn，经批次关联）。
  // recentEvents 取最近 N 条后在内存里按实体取最新：有界，不随 status_events 增长而变慢。
  const lastMap = new Map()
  for (const e of q.recentEvents(store, 800)) {
    const k = e.entity_type + '#' + e.entity_id
    if (!lastMap.has(k)) lastMap.set(k, e)
  }
  const batchById = new Map()
  for (const b of out.batches) batchById.set(b.id, b)
  out.batches = out.batches.map((b) => Object.assign({}, b, { last_event: lastMap.get('batch#' + b.id) || null }))
  out.orders = out.orders.map((o) => {
    const b = o.batch_id ? batchById.get(o.batch_id) : null
    return Object.assign({}, o, {
      device_sn: b ? (b.device_sn || '') : '',
      last_event: lastMap.get('order#' + o.id) || null
    })
  })
  out.tasks = out.tasks.map((t) => Object.assign({}, t, { last_event: lastMap.get('task#' + t.id) || null }))
  // 死锁/异常检测（管理页观察车是否卡死/异常）
  const nowMs = Date.now()
  const STUCK_MIN = Number(process.env.ADMIN_STUCK_MIN || 10)
  const alerts = []
  const parseDt = (s) => { const t = new Date(String(s || '').replace(' ', 'T')).getTime(); return isNaN(t) ? null : t }
  // 1) 本地活跃任务卡在中间态超时（疑似死锁）
  const stuckTasks = q.stuckTasks(store)
  for (const t of stuckTasks) {
    const up = parseDt(t.updated_at)
    if (up && nowMs - up > STUCK_MIN * 60 * 1000) {
      alerts.push({ level: 'warn', text: '任务#' + t.id + ' 卡在「' + (ADMIN_TASK_STATUS[t.task_status] || t.task_status) + '」已 ' + Math.round((nowMs - up) / 60000) + ' 分钟，疑似死锁' })
    }
  }
  // 2) 本地任务异常态（上货失败/取货失败/挂起）
  const badTasks = q.badTasks(store)
  for (const t of badTasks) {
    alerts.push({ level: 'bad', text: '任务#' + t.id + ' 异常：' + (t.status_text || ADMIN_TASK_STATUS[t.task_status]) })
  }
  // 3) 平台任务异常态
  for (const p of (out.platform_tasks || [])) {
    if ([90, 100, 120].includes(Number(p.taskStatus))) {
      alerts.push({ level: 'bad', text: '平台任务 ' + p.id + ' 异常：' + (ADMIN_TASK_STATUS[p.taskStatus] || p.taskStatus) })
    }
  }
  // 4) 机器人异常/离线
  if (out.robot) {
    if (out.robot.machine_status === 'exception') alerts.push({ level: 'bad', text: '机器人处于异常状态（exception），可能死锁' })
    if (!out.robot.online) alerts.push({ level: 'bad', text: '机器人离线，无法执行任务' })
  }
  out.alerts = alerts
  return out
}

// 大屏只读聚合（免登录）：店铺状态 + 订单统计 + 地图/路网/机器人 + 车辆列表 + 进行中批次 + 取餐超时告警
async function buildDashboard(store, deps) {
  // 地图（底图 + 路网 + 点位 + 机器人实时位置 + 进行中路线）；平台异常时降级为 null，不影响统计展示
  let map = null
  let mapError = ''
  try {
    const m = await deps.platform.getMapOverview(store)
    if (m && m.ok) {
      map = {
        // 前端用 Leaflet + 高德瓦片实时渲染，不再读取 map_url；
        // 这里仍下发平台位图代理地址，供 API 消费方（如小程序监控页）或未来回退使用。
        map_url: '/api/dashboard/map-image',
        barrier_url: m.barrier_url, bbox: m.bbox,
        landmarks: m.landmarks, graph: m.graph, robots: m.robots, routes: m.routes
      }
    } else mapError = (m && m.msg) || '获取地图失败'
  } catch (e) { mapError = e.message || '获取地图异常' }

  // 车辆列表（在线 / 电量 / 机器状态）；失败时降级为空数组 + 错误文案
  let robots = []
  let robotsError = ''
  try {
    const r = await deps.platform.getDeviceList()
    if (r && r.ok) robots = r.robots || []
    else robotsError = (r && r.msg) || '获取车辆列表失败'
  } catch (e) { robotsError = e.message || '获取车辆列表异常' }

  return {
    server_time: new Date().toLocaleString('zh-CN', { hour12: false }),
    run_mode: deps.runtime.mode,
    real_platform: deps.runtime.realPlatform,
    shop: deps.goods.shopWithRuntime(q.shopRow(store), deps.runtime),
    stats: deps.order.computeStats(store),
    map,
    map_error: mapError,
    robots,
    robots_error: robotsError,
    batches: q.activeBatchesOverview(store),
    pickup_alerts: q.pickupAlerts(store)
  }
}

// ---------- 状态时间线（管理页详情抽屉） ----------
// 优先返回 status_events 里的真实事件；老数据没有事件时退回「推断节点」
// （用现有时间列拼出可得的节点，前端标注为「推断」，不做假数据）。
function legacyNodes(store, type, id) {
  const out = []
  const push = (label, at) => { if (at) out.push({ label, at: String(at) }) }
  if (type === 'order') {
    const o = store.prepare('SELECT created_at, delivered_at, picked_up_at, cancelled_at, updated_at FROM orders WHERE id=?').get(Number(id))
    if (!o) return out
    push('创建订单', o.created_at); push('送达', o.delivered_at); push('已取餐', o.picked_up_at)
    push('取消', o.cancelled_at); push('最后变更', o.updated_at)
  } else if (type === 'batch') {
    const b = store.prepare('SELECT created_at, dispatched_at, loaded_at, completed_at, updated_at FROM delivery_batches WHERE id=?').get(Number(id))
    if (!b) return out
    push('创建批次', b.created_at); push('派车', b.dispatched_at); push('上货完成', b.loaded_at)
    push('完成', b.completed_at); push('最后变更', b.updated_at)
  } else {
    const t = store.prepare('SELECT updated_at, void_at FROM delivery_tasks WHERE id=?').get(Number(id))
    if (!t) return out
    push('最后变更', t.updated_at); push('作废', t.void_at)
  }
  // created_at 等均为 'YYYY-MM-DD HH:MM:SS'，字典序即时间序
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

function buildTimeline(store, type, id) {
  const t = String(type)
  const eid = Number(id)
  if (!eid || ['order', 'batch', 'task'].indexOf(t) < 0) return null
  let events = []
  let current = null
  let context = null

  if (t === 'batch') {
    const b = q.batchById(store, eid)
    if (!b) return null
    current = { status: Number(b.status), status_text: b.status_text, device_sn: b.device_sn || '', batch_no: b.batch_no }
    // 批次时间线合并批内订单事件（一次看清整批流转），并标注事件归属哪个订单
    const orders = q.batchOrdersAll(store, eid)
    const ids = orders.map((o) => o.id)
    const shortOf = new Map()
    for (const o of orders) shortOf.set(o.id, seqSvc.orderShortOf(o.seq_date, o.created_at, o.daily_seq || o.id))
    const batchEvs = q.eventsOf(store, 'batch', eid)
    const orderEvs = q.eventsOfMany(store, 'order', ids)
      .map((e) => Object.assign({}, e, { order_short: shortOf.get(e.entity_id) || ('#' + e.entity_id) }))
    events = batchEvs.concat(orderEvs).sort((a, b2) => a.id - b2.id)
    context = { batch_no: b.batch_no, order_count: ids.length }
  } else if (t === 'order') {
    const o = q.orderById(store, eid)
    if (!o) return null
    current = {
      status: Number(o.status), status_text: (statusSvc.ORDER_STATUS_TEXT[Number(o.status)] || ''),
      batch_id: o.batch_id || null, landmark_name: o.landmark_name || '', order_no: o.order_no
    }
    events = q.eventsOf(store, 'order', eid)
    context = { order_no: o.order_no, pickup_code: o.pickup_code || '' }
  } else {
    const tk = q.taskById(store, eid)
    if (!tk) return null
    current = {
      status: Number(tk.task_status), status_text: tk.status_text || (ADMIN_TASK_STATUS[Number(tk.task_status)] || ''),
      device_sn: tk.device_sn || '', platform_task_id: tk.platform_task_id || ''
    }
    events = q.eventsOf(store, 'task', eid)
  }

  return {
    type: t,
    id: eid,
    current,
    context,
    events,
    // 只在完全没有真实事件时给推断节点，避免新旧混排造成误读
    legacy: events.length ? [] : legacyNodes(store, t, eid)
  }
}

module.exports = { ADMIN_TASK_STATUS, buildAdminState, buildDashboard, buildTimeline, legacyNodes }
