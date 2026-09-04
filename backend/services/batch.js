// 配送批次服务：一车多单（单车最多 BATCH_MAX_ORDERS 单）
// 现实模型：无人车单仓，可放多份商品 → 一次出车配送一个「批次」（最多 12 单）。
// 关键点：
//  1. 每单独立取餐码（防拿错；平台 unloading/verify 按任务匹配取餐码开舱）。
//  2. 一个仓多个人拿：orders.picked_up_at 记录每单是否已被取走，全部取完 → 批次完成。
//  3. 多地点配送顺序：按点位分组后，从上货点做贪心最近邻排序（近似最小化顾客总等待），
//     停靠顺序写入 batch.route，平台任务按停靠顺序创建并以 priority 递减提示排程。
// 本模块只做数据库编排，不直接调用平台（平台调用在 services/platform.js，由 server.js 编排），
// 避免循环依赖。

const BATCH_STATUS = {
  0: '组单中',
  1: '待上货',
  2: '配送中',
  3: '已完成',
  4: '异常'
}

// 一车最多多少单（现实仓容上限，可用环境变量覆盖）
const BATCH_MAX_ORDERS = Number(process.env.BATCH_MAX_ORDERS || 12)
// 自动派车等待时间：自动接单模式下，批次成立后等待该时长自动派车（单位 ms）
const BATCH_WAIT_MS = Number(process.env.BATCH_WAIT_MS || 90 * 1000)

function statusText(st) {
  return BATCH_STATUS[Number(st)] || ('状态 ' + st)
}

function getBatch(store, batchId) {
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batchId)) || null
}

// 取当前可用的组单中批次（未满员）；没有则新建
function getOrCreateOpenBatch(store) {
  const b = store.prepare('SELECT * FROM delivery_batches WHERE status=0 AND total_orders < ? ORDER BY id DESC LIMIT 1').get(BATCH_MAX_ORDERS)
  if (b) return b
  const batchNo = 'BD' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6).toUpperCase()
  // 当日序号：每天从 1 重置（商家端卡面展示「批次 N」，长编号只在批次详情显示）
  const seqRow = store.prepare("SELECT COUNT(*) c FROM delivery_batches WHERE date(created_at)=date('now','localtime')").get()
  const info = store.prepare('INSERT INTO delivery_batches (batch_no, status, status_text, total_orders, daily_seq) VALUES (?,0,?,0,?)')
    .run(batchNo, BATCH_STATUS[0], Number(seqRow && seqRow.c || 0) + 1)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(info.lastInsertRowid))
}

// 接单并入批次：订单 1 待接单 → 2 配送中，挂到当前批次
function addOrderToBatch(store, order) {
  const batch = getOrCreateOpenBatch(store)
  store.prepare("UPDATE orders SET batch_id=?, status=2, updated_at=datetime('now','localtime') WHERE id=?")
    .run(batch.id, order.id)
  store.prepare("UPDATE delivery_batches SET total_orders=total_orders+1, updated_at=datetime('now','localtime') WHERE id=?")
    .run(batch.id)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batch.id)
}

// 订单取消/退款时从批次移除（仅计数，订单保留 batch_id 供审计）
function removeOrderFromBatch(store, order) {
  if (!order || !order.batch_id) return
  store.prepare("UPDATE delivery_batches SET total_orders=MAX(0,total_orders-1), updated_at=datetime('now','localtime') WHERE id=?")
    .run(order.batch_id)
  // 组单中的批次如果空了，标记异常以便回收（下一单会新建）
  const b = getBatch(store, order.batch_id)
  if (b && Number(b.status) === 0 && Number(b.total_orders) <= 0) {
    store.prepare("UPDATE delivery_batches SET status=4, status_text='批次已取消', updated_at=datetime('now','localtime') WHERE id=?")
      .run(b.id)
  }
}

// 用户已取走本单（仓内拿走一份）：标记取餐时间，批次计数 +1，满了即完成
function markOrderPicked(store, order) {
  if (!order) return
  const row = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
  if (!row) return
  if (row.picked_up_at) return
  store.prepare("UPDATE orders SET picked_up_at=datetime('now','localtime'), status=4, updated_at=datetime('now','localtime') WHERE id=?")
    .run(row.id)
  // 收货完成：结算本单商品已售（幂等）
  try { require('./goodsStats').settleSales(store, row.id) } catch (e) { /* 忽略 */ }
  if (row.batch_id) {
    store.prepare("UPDATE delivery_batches SET picked_orders=picked_orders+1, updated_at=datetime('now','localtime') WHERE id=?")
      .run(row.batch_id)
    maybeCompleteBatch(store, row.batch_id)
  }
}

// 批次完成判断：批次内所有「有效订单」（配送中/已送达/已完成，排除取消/退款/异常）都已取走或平台任务已完成
function maybeCompleteBatch(store, batchId) {
  const b = getBatch(store, batchId)
  if (!b || ![1, 2].includes(Number(b.status))) return
  const stats = store.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN o.picked_up_at IS NOT NULL OR d.task_status >= 80 THEN 1 ELSE 0 END) AS done
    FROM orders o
    LEFT JOIN delivery_tasks d ON d.order_id = o.id
    WHERE o.batch_id=? AND o.status IN (2,3,4)`).get(batchId)
  const total = Number(stats && stats.total || 0)
  const done = Number(stats && stats.done || 0)
  if (total > 0 && done >= total) {
    store.prepare("UPDATE delivery_batches SET status=3, status_text='已完成', picked_orders=?, completed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
      .run(done, batchId)
  }
}

// 平台任务状态变化联动批次（由 platform.applyStatus 调用）
function onTaskStatus(store, task, status) {
  if (!task || !task.batch_id) return
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(task.order_id)
  if (!order) return
  if (Number(status) === 80) {
    // 平台任务完成 → 视同已取走（含设备端扫码/模拟完成场景）
    markOrderPicked(store, order)
  } else if (Number(status) === 110 || Number(status) === 150) {
    // 任务取消/关闭：订单已由 applyStatus 置为已取消；批次计数校正
    if (Number(order.status) === 5) removeOrderFromBatch(store, order)
  }
}

// ---------- 路径规划（多地点配送顺序，最小化顾客总等待） ----------
// 贪心最近邻：从上货点出发，每次去「当前最近的未访问点位」。
// 同点位多单合并为一站。该启发式在配送场景近似最小化所有顾客等待时间之和。
// 无坐标时退化为点位 sort 顺序。
function planRoute(store, orders) {
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get() || null
  const groups = new Map()
  for (const o of orders) {
    const lid = String(o.landmark_id || '')
    if (!lid) continue
    if (!groups.has(lid)) {
      const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(lid) || null
      groups.set(lid, { landmark: lm, name: o.landmark_name || (lm && lm.name) || '未知点位', orders: [] })
    }
    groups.get(lid).orders.push(o)
  }
  const arr = [...groups.values()]
  if (!arr.length) return []
  const lx = loading ? Number(loading.pos_x || 0) : 0
  const ly = loading ? Number(loading.pos_y || 0) : 0
  const hasCoord = arr.some((g) => g.landmark && (Number(g.landmark.pos_x) || Number(g.landmark.pos_y)))
  if (hasCoord) {
    // 最近邻贪心
    const remaining = arr.slice()
    const route = []
    let cx = lx
    let cy = ly
    while (remaining.length) {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const g = remaining[i]
        const dx = cx - Number(g.landmark.pos_x || 0)
        const dy = cy - Number(g.landmark.pos_y || 0)
        const d = dx * dx + dy * dy
        if (d < bestD) { bestD = d; best = i }
      }
      const g = remaining.splice(best, 1)[0]
      route.push({ stop: route.length + 1, landmark_id: g.landmark.id, landmark_name: g.name, order_ids: g.orders.map((o) => o.id) })
      cx = Number(g.landmark.pos_x || 0)
      cy = Number(g.landmark.pos_y || 0)
    }
    return route
  }
  // 无坐标：按点位 sort 顺序（与种子/平台同步顺序一致）
  arr.sort((a, b) => (a.landmark ? Number(a.landmark.sort || 99) : 99) - (b.landmark ? Number(b.landmark.sort || 99) : 99))
  return arr.map((g, i) => ({ stop: i + 1, landmark_id: g.landmark ? g.landmark.id : g.orders[0].landmark_id, landmark_name: g.name, order_ids: g.orders.map((o) => o.id) }))
}

// 批次详情（含订单、商品明细与路线），供商家/用户端展示
function getBatchDetail(store, batchId) {
  const b = getBatch(store, batchId)
  if (!b) return null
  const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? ORDER BY id ASC').all(batchId).map((o) => {
    const t = o.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(o.delivery_task_id) : null
    // 订单商品明细：上货操作页需逐单逐商品展示（一行一个商品）
    const items = store.prepare('SELECT id, goods_id, goods_name, goods_image, price, quantity FROM order_items WHERE order_id=?').all(o.id)
    return {
      id: o.id, order_no: o.order_no, status: o.status, status_text: statusText(o.status),
      daily_seq: Number(o.daily_seq || o.id),
      landmark_id: o.landmark_id, landmark_name: o.landmark_name,
      contact_name: o.contact_name, contact_phone: o.contact_phone,
      pickup_code: o.pickup_code, total_amount: o.total_amount,
      created_at: o.created_at,
      picked_up: !!o.picked_up_at,
      items,
      task: t ? { id: t.id, platform_task_id: t.platform_task_id, device_sn: t.device_sn, task_status: t.task_status, status_text: t.status_text } : null
    }
  })
  let route = []
  try { route = JSON.parse(b.route || '[]') } catch (e) { route = [] }
  // 已取餐数以实际订单 picked_up_at 动态统计（与展示自洽，避免计数器漂移）
  const picked = orders.filter((o) => o.picked_up).length
  const distinctLandmarks = [...new Set(orders.map((o) => o.landmark_name).filter(Boolean))]
  const routeText = route.length ? route.map((r) => r.landmark_name).join(' → ') : (distinctLandmarks.join('、') || '')
  return {
    id: b.id, batch_no: b.batch_no, status: b.status, status_text: b.status_text || statusText(b.status),
    daily_seq: Number(b.daily_seq || b.id),
    device_sn: b.device_sn, total_orders: orders.length, picked_orders: picked,
    created_at: b.created_at, dispatched_at: b.dispatched_at, completed_at: b.completed_at,
    route, route_text: routeText, route_stops_text: distinctLandmarks.join('、'),
    orders
  }
}

module.exports = {
  BATCH_STATUS, BATCH_MAX_ORDERS, BATCH_WAIT_MS, statusText,
  getBatch, getOrCreateOpenBatch, addOrderToBatch, removeOrderFromBatch,
  markOrderPicked, maybeCompleteBatch, onTaskStatus, planRoute, getBatchDetail
}
