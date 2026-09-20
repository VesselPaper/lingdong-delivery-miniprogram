// domains/admin/live.js —— 管理员实时推送泵（事件驱动，替代前端轮询）
// ------------------------------------------------------------------
// 目标：管理员页不再用 setInterval 轮询拉数据，而是订阅 WebSocket 主题 'admin/live'，
// 由后端主动推送：
//   · {type:'live', robots, robot}        —— 机器人实时位置 + 首位机器状态 → 前端原地更新地图小车/机器人卡片
//   · {type:'state_changed'}              —— 检测到订单/批次/任务状态有变 → 前端拉一次 /api/admin/state
// 高可用/节俭：
//   · 只要没有订阅者，泵直接跳过（不抓取位置、不打平台、不做变更检测），零开销。
//   · 位置抓取走 platform.getDevicePositionBySn（内部 3s 缓存），不会每 tick 都打平台。
// 纯读取，不触碰任何业务写逻辑，可与 delivery/order 域并发安全运行。
const push = require('../../services/push')

const LIVE_MS = Number(process.env.ADMIN_LIVE_MS || 2500)
let lastDigest = ''

function start(store, deps) {
  setInterval(() => { run(store, deps).catch(() => {}) }, LIVE_MS)
  setTimeout(() => { run(store, deps).catch(() => {}) }, 300) // 首帧尽早推送
}

async function run(store, deps) {
  const subCount = push.topicCount('admin/live')
  if (subCount <= 0) return // 无管理员实时订阅者，省事直接跳过

  // 抓机器人实时状态与位置，失败不阻断（位置/设备查询可能慢或平台临时不可用）
  let robot = null
  const robots = []
  try {
    const devList = await deps.platform.getDeviceList()
    if (devList && devList.ok && Array.isArray(devList.robots)) {
      if (devList.robots.length) robot = devList.robots[0]
      for (const dev of devList.robots) {
        if (!dev.online || !dev.device_sn) continue
        const pos = await deps.platform.getDevicePositionBySn(store, dev.device_sn, dev.machine_text || '')
        const ax = pos && !isNaN(pos.ax) ? Number(pos.ax) : (pos && !isNaN(pos.x) ? Number(pos.x) : NaN)
        const ay = pos && !isNaN(pos.ay) ? Number(pos.ay) : (pos && !isNaN(pos.y) ? Number(pos.y) : NaN)
        if (!isNaN(ax) && !isNaN(ay)) {
          robots.push({ device_sn: dev.device_sn, x: ax, y: ay, theta: Number(pos.theta || 0), text: pos.text || '' })
        }
      }
    }
  } catch (e) { console.warn('[admin-live] 抓取机器人状态失败：' + e.message) }

  // 变更检测：活跃订单/批次/任务的计数 + 最大更新时间 + 主机器人状态组成的指纹。
  // 指纹变化才推 state_changed（前端拉一次 state 全量），避免频繁刷新页面数据。
  const digest = digestOf(store, robot)
  const changed = digest !== lastDigest
  lastDigest = digest

  push.broadcastTopic('admin/live', { type: 'live', ts: Date.now(), robots, robot })
  if (changed) push.broadcastTopic('admin/live', { type: 'state_changed', ts: Date.now() })
}

function digestOf(store, robot) {
  const b = store.prepare("SELECT COUNT(*) c, IFNULL(MAX(updated_at),'') u FROM delivery_batches WHERE status IN (0,1,2)").get()
  const o = store.prepare("SELECT COUNT(*) c, IFNULL(MAX(updated_at),'') u FROM orders WHERE status IN (2,3,6)").get()
  const t = store.prepare("SELECT COUNT(*) c, IFNULL(MAX(updated_at),'') u FROM delivery_tasks WHERE (task_status < 80 OR (task_status >= 90 AND task_status < 110)) AND void_at IS NULL").get()
  const r = robot ? [robot.device_sn, Number(robot.online), robot.machine_status || '', robot.curr_map_id || ''].join('|') : 'none'
  return [b.c, b.u, o.c, o.u, t.c, t.u, r].join('|')
}

module.exports = { start }