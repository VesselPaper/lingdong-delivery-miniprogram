// 配送批次服务：一车多单，容量以「商品件数」计（一车最多 BATCH_MAX_ITEMS 件，默认 12 件）
// 现实模型：无人车单仓，可放多份商品 → 一次出车配送一个「批次」（最多 12 件商品）。
// 分批算法：best-fit 最优适配 —— 每单按商品件数放入「能容纳且当前最满」的组单中批次；
//  单件数 < 12 → 整单留在同一批；单件数 > 12 → 自动独占新批次。
// 关键点：
//  1. 每单独立取餐码（防拿错；平台 unloading/verify 按任务匹配取餐码开舱）。
//  2. 一个仓多个人拿：orders.picked_up_at 记录每单是否已被取走，全部取完 → 批次完成。
//  3. 多地点配送顺序：按点位分组后，从上货点做贪心最近邻排序（近似最小化顾客总等待），
//     停靠顺序写入 batch.route，平台任务按停靠顺序创建并以 priority 递减提示排程。
// 本模块只做数据库编排，不直接调用平台（平台调用在 services/platform.js，由 server.js 编排），
// 避免循环依赖。

// 编号服务：批次号 = 日期 + 当日序号（原子取号）
const seqSvc = require('./seq')

const BATCH_STATUS = {
  0: '组单中',
  1: '待上货',
  2: '配送中',
  3: '已完成',
  4: '异常'
}

// 一车最多多少件商品（现实仓容上限，以商品件数计，默认 12 件/车）
const BATCH_MAX_ITEMS = Number(process.env.BATCH_MAX_ITEMS || 12)
// 兼容旧引用（原「12 单」现为「12 件商品」口径）
const BATCH_MAX_ORDERS = BATCH_MAX_ITEMS
// 自动派车等待时间：自动接单模式下，批次成立后等待该时长自动派车（单位 ms）
const BATCH_WAIT_MS = Number(process.env.BATCH_WAIT_MS || 90 * 1000)
// 单数加权最近邻权重 α（ROUTE_COUNT_WEIGHT）：给「距离」按该站点订单数打折，
// 有效距离 = 距离平方 ÷ (订单数^α)。α=0 退化纯最近邻，越大越偏好多单楼栋。默认 0.5。
const ROUTE_COUNT_WEIGHT = Number(process.env.ROUTE_COUNT_WEIGHT || 0.5)

// 召唤多单配送的「推进钩子」：当某停靠点第单被取走（批次计数+1）时，通知 delivery 域去判断
// 「当前楼栋是否全取完 → 停 5s → 召唤下一栋」。hook 由 delivery/service.js 注册（registerSummonAdvance），
// 避免 batch.js 与 delivery 域循环依赖（本库不接受 deps）。
let summonAdvanceHook = null
function registerSummonAdvance(fn) { summonAdvanceHook = fn }
function notifySummonAdvance(batchId) {
  if (summonAdvanceHook) { try { summonAdvanceHook(batchId) } catch (e) { console.warn('[batch] summonAdvance hook 异常', e.message) } }
}

function statusText(st) {
  return BATCH_STATUS[Number(st)] || ('状态 ' + st)
}

// 点位/路线名称清洗：历史脏数据可能出现「??1?」「？？」等占位符，统一剔除。
// 返回 null 表示该名称无效（调用方回退到 landmarks 表或「未知点位」）。
function cleanName(name) {
  if (name === undefined || name === null) return null
  const s = String(name).replace(/[?？]/g, '').trim()
  return s || null
}

// 由 landmarks 表解析点位名称（按 id）；解析失败回退到传入名称，再失败为「未知点位」
function landmarkNameOf(store, landmarkId, fallback) {
  if (landmarkId) {
    const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(String(landmarkId))
    if (lm) return cleanName(lm.name) || fallback
  }
  return cleanName(fallback) || '未知点位'
}

function getBatch(store, batchId) {
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batchId)) || null
}

// 订单商品件数（一个订单可能含多件商品；分批以「件」为单位）
function orderItemCount(store, orderId) {
  const row = store.prepare('SELECT IFNULL(SUM(quantity),0) s FROM order_items WHERE order_id=?').get(orderId)
  return Number(row && row.s || 0)
}

// 手机号脱敏（P1-13）：商家端列表/详情默认只显示 138****0000，
// 明文手机号只在开舱验证等内部逻辑使用（服务端直接读库），对外一律脱敏。
function maskPhone(p) {
  const s = String(p || '')
  if (!s) return ''
  return s.length <= 7 ? (s.slice(0, 1) + '****' + s.slice(-2)) : (s.slice(0, 3) + '****' + s.slice(-4))
}

// 最优分批：以商品件数计容量（默认 12 件/车）。取「能容纳本单件数且当前最满」的组单中批次（best-fit）；
// 无合适批次则新建。超容量订单（>12 件）因任何批次都装不下，自动独占新建批次。
// 批次容量一律实时计算（P1-9）：delivery_batches.total_items 是缓存列，历史上有过
// 「UI 实时口径 8 件、调度器读缓存列 3 件」的分叉，best-fit 与自动派车判断都以实时值为准。
function getOrCreateOpenBatch(store, itemCount) {
  const n = Number(itemCount || 0)
  const b = store.prepare(`
    SELECT b.id, IFNULL(SUM(oi.quantity), 0) AS items
    FROM delivery_batches b
    LEFT JOIN orders o ON o.batch_id = b.id AND o.status IN (1,2)
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE b.status = 0
    GROUP BY b.id
    HAVING items + ? <= ?
    ORDER BY items DESC, b.id DESC LIMIT 1`).get(n, BATCH_MAX_ITEMS)
  if (b) return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(b.id))
  // 编号：日期 + 当日序号（原子取号，见 services/seq.js）；商家端卡面展示短号「B-MMDD-NN」
  const { day: seqDay, seq } = seqSvc.nextSeq(store, 'batch')
  const batchNo = seqSvc.batchNo(seqDay, seq)
  const info = store.prepare('INSERT INTO delivery_batches (batch_no, status, status_text, total_orders, total_items, daily_seq, seq_date) VALUES (?,0,?,0,0,?,?)')
    .run(batchNo, BATCH_STATUS[0], seq, seqDay)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(info.lastInsertRowid))
}

// 接单并入批次：订单 1 待接单 → 2 配送中，挂到最优适配批次（以商品件数计容量）
function addOrderToBatch(store, order) {
  const itemCount = orderItemCount(store, order.id)
  const batch = getOrCreateOpenBatch(store, itemCount)
  // batch_removed_at 必须一并清空：「配送异常重新配送」会先摘除本单再并入新批次，
  // 留着旧标记会让本单在新批次里再也摘不掉（计数永久虚高）。
  store.prepare("UPDATE orders SET batch_id=?, status=2, batch_removed_at=NULL, updated_at=datetime('now','localtime') WHERE id=?")
    .run(batch.id, order.id)
  store.prepare("UPDATE delivery_batches SET total_orders=total_orders+1, total_items=total_items+?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(itemCount, batch.id)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batch.id)
}

// 订单取消/退款时从批次移除（仅计数，订单保留 batch_id 供审计）
// 幂等：同一订单会被「用户取消 / 平台推送 110 / 商家异常退款」多条路径摘除，
// 此前每条都再扣一次 total_orders 与 total_items，MAX(0,…) 只是把负数掩盖成 0。
function removeOrderFromBatch(store, order) {
  if (!order || !order.batch_id) return
  // 传入的 order 可能是取消前读的旧快照，标记一律以库中现值为准
  const cur = store.prepare('SELECT batch_removed_at FROM orders WHERE id=?').get(order.id)
  if (cur && cur.batch_removed_at) return
  const itemCount = orderItemCount(store, order.id)
  store.prepare("UPDATE delivery_batches SET total_orders=MAX(0,total_orders-1), total_items=MAX(0,total_items-?), updated_at=datetime('now','localtime') WHERE id=?")
    .run(itemCount, order.batch_id)
  store.prepare("UPDATE orders SET batch_removed_at=datetime('now','localtime') WHERE id=?").run(order.id)
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
  // 已取消/已退款的订单不得被标记为已取走：那会把状态改回 4 并结算销量
  if ([5, 7].includes(Number(row.status)) || row.cancelled_at) return
  store.prepare("UPDATE orders SET picked_up_at=datetime('now','localtime'), status=4, updated_at=datetime('now','localtime') WHERE id=?")
    .run(row.id)
  // 收货完成：结算本单商品已售（幂等）
  try { require('./goodsStats').settleSales(store, row.id) } catch (e) { /* 忽略 */ }
  countPicked(store, row)
}

// 批次已取走计数（幂等护栏在 markOrderPicked/fulfillOrder 已做，本函数只对仍生效的单+批计数）。
// 也被 order.service.fulfillOrder 跨域调用，作为 delivery 域对订单「已完成」的批次侧落账。
function countPicked(store, order) {
  if (!order) return
  const row = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
  if (!row) return
  if ([5, 7].includes(Number(row.status)) || row.cancelled_at) return
  if (row.batch_id) {
    store.prepare("UPDATE delivery_batches SET picked_orders=picked_orders+1, updated_at=datetime('now','localtime') WHERE id=?")
      .run(row.batch_id)
    const b = getBatch(store, row.batch_id)
    maybeCompleteBatch(store, row.batch_id)
    // 召唤模式：取完扇动推进钩子（delivery 域判断是否该推下一栋 / 召回）。
    // 注意不限制 status=2 —— 最后一单取走时 maybeCompleteBatch 可能已把批次置 3，
    // 若guard成 [2] 会挡住「召回上货点 + current_stop 归零」的收尾路径。
    if (b && b.delivery_mode === 'summon') {
      notifySummonAdvance(row.batch_id)
    }
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
    // 任务完成(80) ≠ 用户已取走：只有用户真正「关舱取走」（pickup-close 置了 picked_up_at）才算已取、
    // 计入批次完成。平台 40s 自动关舱流转的 80 不在此列 —— 未取餐订单保持已送达(3)，由取餐超时扫描处理。
    if (order.picked_up_at) markOrderPicked(store, order)
  } else if (Number(status) === 110 || Number(status) === 150) {
    // 任务取消/关闭：订单已由 applyStatus 置为已取消；批次计数校正
    if (Number(order.status) === 5) removeOrderFromBatch(store, order)
  }
}

// ---------- 路径规划（多地点配送顺序，最小化顾客总等待） ----------
// 单数加权最近邻：从上货点出发，每次去「有效距离最小」的未访问点位。
//  有效距离 = 距离平方 ÷ (该站点订单数^ROUTE_COUNT_WEIGHT)。
// 与纯最近邻的区别：同距离下、甚至稍远一点点，单数多的楼栋会被优先安排 ——
// 否则 1 单近楼栋会抢在 5 单楼栋前，让多单楼栋的人平均等待被拖长。
// 同一楼栋多单合并为一站。无坐标时退化为【单数从多到少，同单数按点位 sort】。（仍单数优先）
function planRoute(store, orders) {
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get() || null
  const groups = new Map()
  for (const o of orders) {
    const lid = String(o.landmark_id || '')
    if (!lid) continue
    if (!groups.has(lid)) {
      const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(lid) || null
      // 名称清洗：脏点位名（含 ? 占位符）优先以 landmarks 表为准，再回退订单名/未知
      groups.set(lid, { landmark: lm, name: landmarkNameOf(store, lid, o.landmark_name), orders: [] })
    }
    groups.get(lid).orders.push(o)
  }
  const arr = [...groups.values()]
  if (!arr.length) return []
  const lx = loading ? Number(loading.pos_x || 0) : 0
  const ly = loading ? Number(loading.pos_y || 0) : 0
  const hasCoord = arr.some((g) => g.landmark && (Number(g.landmark.pos_x) || Number(g.landmark.pos_y)))
  if (hasCoord) {
    const alpha = Math.max(0, Number(ROUTE_COUNT_WEIGHT)) // α≥0，防负值把「多单」反向变远
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
        const n = g.orders.length || 1
        // 单数加权：距离平方除以「订单数的 α 次方」，多单楼栋的有效距离被缩小 → 更早被选
        const d2 = (dx * dx + dy * dy) / Math.pow(n, alpha)
        if (d2 < bestD) { bestD = d2; best = i }
      }
      const g = remaining.splice(best, 1)[0]
      route.push({ stop: route.length + 1, landmark_id: g.landmark.id, landmark_name: g.name, order_ids: g.orders.map((o) => o.id) })
      cx = Number(g.landmark.pos_x || 0)
      cy = Number(g.landmark.pos_y || 0)
    }
    return route
  }
  // 无坐标：单数优先（多单楼栋先送，符合"人多的先送"目标），同单数按点位 sort 顺序兜底
  const byCountThenSort = (a, b) => (b.orders.length - a.orders.length)
    || ((a.landmark ? Number(a.landmark.sort || 99) : 99) - (b.landmark ? Number(b.landmark.sort || 99) : 99))
  arr.sort(byCountThenSort)
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
    // 点位名清洗：脏数据（??1?）以 landmarks 表为准回退
    const lmName = landmarkNameOf(store, o.landmark_id, o.landmark_name)
    return {
      id: o.id, order_no: o.order_no, status: o.status, status_text: statusText(o.status),
      daily_seq: Number(o.daily_seq || o.id),
      code_short: seqSvc.orderShortOf(o.seq_date, o.created_at, o.daily_seq || o.id),
      landmark_id: o.landmark_id, landmark_name: lmName,
      contact_name: o.contact_name, contact_phone: maskPhone(o.contact_phone),
      pickup_code: o.pickup_code, total_amount: o.total_amount,
      created_at: o.created_at,
      picked_up: !!o.picked_up_at,
      items,
      task: t ? { id: t.id, platform_task_id: t.platform_task_id, device_sn: t.device_sn, task_status: t.task_status, status_text: t.status_text, recall_status: Number(t.recall_status || 0), recall_error: t.recall_error || '' } : null
    }
  })
  let route = []
  try { route = JSON.parse(b.route || '[]') } catch (e) { route = [] }
  // 已取餐数以实际订单 picked_up_at 动态统计（与展示自洽，避免计数器漂移）
  const picked = orders.filter((o) => o.picked_up).length
  const distinctLandmarks = [...new Set(orders.map((o) => o.landmark_name).filter(Boolean))]
  // 路线文本：剔除脏点位名，缺失时回退到订单点位/未知
  const cleanStops = route
    .map((r) => ({ ...r, landmark_name: cleanName(r.landmark_name) || landmarkNameOf(store, r.landmark_id, orders.find((o) => String(o.landmark_id) === String(r.landmark_id)) && orders.find((o) => String(o.landmark_id) === String(r.landmark_id)).landmark_name) || '未知点位' }))
    .filter((r) => r.landmark_name && r.landmark_name !== '未知点位')
  const routeText = cleanStops.length ? cleanStops.map((r) => r.landmark_name).join(' → ') : (distinctLandmarks.join('、') || '')
  const totalItems = orders.reduce((s, o) => s + (o.items || []).reduce((x, it) => x + Number(it.quantity || 0), 0), 0)
  return {
    id: b.id, batch_no: b.batch_no, status: b.status, status_text: b.status_text || statusText(b.status),
    daily_seq: Number(b.daily_seq || b.id),
    code_short: seqSvc.batchShortOf(b.seq_date, b.created_at, b.daily_seq || b.id),
    device_sn: b.device_sn, total_orders: orders.length, total_items: totalItems, picked_orders: picked,
    delivery_mode: b.delivery_mode || '', current_stop: Number(b.current_stop || 0),
    loaded_at: b.loaded_at || '', ready_dispatch: !!(Number(b.status) === 1 && b.loaded_at),
    created_at: b.created_at, dispatched_at: b.dispatched_at, completed_at: b.completed_at,
    route: cleanStops, route_text: routeText, route_stops_text: distinctLandmarks.join('、'),
    orders
  }
}

module.exports = {
  BATCH_STATUS, BATCH_MAX_ORDERS, BATCH_MAX_ITEMS, BATCH_WAIT_MS, statusText, cleanName, landmarkNameOf,
  orderItemCount, getBatch, getOrCreateOpenBatch, addOrderToBatch, removeOrderFromBatch,
  markOrderPicked, countPicked, maybeCompleteBatch, onTaskStatus, planRoute, getBatchDetail,
  registerSummonAdvance
}
