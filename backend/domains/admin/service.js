// admin 域业务逻辑：状态字典 + 管理员状态总览（死锁/异常检测）+ 大屏只读聚合
// 依赖注入：(store, deps)。deps = { runtime, platform, goods, order, orderCancel }
// 跨域读全部为只读聚合（05 方案明确允许）；订单取消等写操作一律走 deps.order.applyOrderCancelled（order 域落账）。

const q = require('./queries')

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
  out.orders = q.activeOrders(store).concat(q.historyOrders(store))
  out.tasks = q.activeTasks(store).concat(q.historyTasks(store))
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

module.exports = { ADMIN_TASK_STATUS, buildAdminState, buildDashboard }
