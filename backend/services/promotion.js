// 优惠计算服务：把「活动」从纯展示升级为参与订单价格计算。
// 说明：价格权威在后端。/api/order/create 会调用本模块，按命中活动对每个子订单
// 重算 total_amount 并记录 original_amount / discount_amount / activity_id。
// 前端（购物车/结算/商品）只做"估算展示"，最终以本模块返回为准，杜绝自报价。
//
// 活动类型（activities.type）：
//   custom     自由活动：纯展示，不参与计价
//   discount   商品打折：全场或指定商品按折扣价出售（config.discount：如 0.85 = 85 折）
//   full_reduce 满减：满 X 元减 Y 元，支持多档阶梯，订单合并最优惠一档
//
// 选券规则：同一订单只享受"一个"活动（满减或折扣，取优惠金额最大的那个），
// 不叠加。消费者取得最大优惠，商家侧也没有叠加溢出的边界麻烦。

const MONEY_SCALE = 100

// 金额换算成"分"以避免 JS 浮点误差（8.55 等无法精确表示）
function fen(v) {
  return Math.round((Number(v) || 0) * MONEY_SCALE)
}

// 是否属于某活动的适用商品（scope='all' 表示所有商品命中）
function goodsInScope(activity, goodsId) {
  const cfg = activity._cfg || {}
  if (cfg.scope !== 'goods') return true // 'all' 或缺省
  return (cfg.goods_ids || []).map(Number).includes(Number(goodsId))
}

// 解析 config JSON，非法时视为空配置
function parseConfig(activity) {
  if (activity._cfg) return activity._cfg
  let cfg = {}
  try { cfg = JSON.parse(activity.config || '{}') || {} } catch (e) { cfg = {} }
  activity._cfg = cfg
  return cfg
}

// 活动是否在生效时间窗内（start_at / end_at 为空表示不设限）
function inTimeWindow(activity, now = Date.now()) {
  const at = (t) => (t ? new Date(t.replace(' ', 'T')).getTime() : NaN)
  const s = at(activity.start_at)
  const e = at(activity.end_at)
  if (!isNaN(s) && now < s) return false
  if (!isNaN(e) && now > e) return false
  return true
}

// 从数据库加载"当前生效且已发布"的活动，并预解析 type/config
function loadActive(db) {
  const rows = db.prepare("SELECT * FROM activities WHERE status=1").all()
  const out = []
  for (const a of rows) {
    parseConfig(a)
    if (a.type === 'custom') continue            // 自由活动不参与计价
    if (!inTimeWindow(a)) continue               // 未开始/已结束不参与
    out.push(a)
  }
  return out
}

// 计算单个 "满减" 活动对某个子订单(行列表)能产生的优惠金额。
// rows: [{goods, quantity}]。hybrid 为 true 时按"可参与满减的商品小计"匹配阶梯，
// false 则只按所有商品小计匹配（多半不会用到，保留备查）。
function fullReduceDiscount(activity, rows) {
  const cfg = parseConfig(activity)
  const tiers = Array.isArray(cfg.tiers) ? cfg.tiers.filter((t) => Number(t.threshold) > 0) : []
  if (!tiers.length) return 0
  // 参与满减的小计：满减默认按"全场金额"（scope=goods 时只算指定商品）
  let subtotal = 0
  for (const it of rows) {
    if (!goodsInScope(activity, it.goods.id)) continue
    subtotal += Number(it.goods.price) * Number(it.quantity || 0)
  }
  // 匹配"原价小计达到门槛"的最优惠一档（同门槛取满减最大），超过最高档后封顶在最优惠档
  const fenSubtotal = fen(subtotal)
  let bestReduce = 0
  for (const t of tiers) {
    if (fenSubtotal >= fen(t.threshold)) {
      bestReduce = Math.max(bestReduce, Number(t.reduce) || 0)
    }
  }
  // 优惠不能超过参与金额，也不能为负
  return Math.min(bestReduce, subtotal)
}

// 计算单个 "折扣" 活动对某个子订单能产生的优惠金额 = 原价 - 折扣价。
// discount 字段语义：0.85 = 85 折（折后价 = 原价 × 0.85）；支持 0<x<1 或含1（等于无折扣）。
function discountActivityDiscount(activity, rows) {
  const cfg = parseConfig(activity)
  const disc = Number(cfg.discount)
  if (!(disc > 0) || !(disc < 1)) return 0   // 非法或 ≥1 视为无折扣
  let discountFen = 0
  for (const it of rows) {
    if (!goodsInScope(activity, it.goods.id)) continue
    const origFen = fen(it.goods.price) * Number(it.quantity || 0)
    const afterFen = fen(Number(it.goods.price) * Number(disc)) * Number(it.quantity || 0)
    discountFen += Math.max(0, origFen - afterFen)
  }
  // 回到"元"，并做两位小数截取，避免浮点噪音
  return Math.round(discountFen / MONEY_SCALE * 100) / 100
}

// 给定一个子订单的行列表，返回最优的单个命中活动（或不命中）。
// 返回值：{ activity:活动对象|null, discount:优惠金额, original:原价合计, payable:应付合计 }
// rows: [{goods, quantity}]
function resolve(rows, activeActivities) {
  // 原价合计
  let original = 0
  for (const it of rows) original += Number(it.goods.price) * Number(it.quantity || 0)

  if (!activeActivities || !activeActivities.length) {
    return { activity: null, discount: 0, original, payable: original }
  }

  let best = null
  let bestDiscount = 0
  for (const a of activeActivities) {
    let d = 0
    if (a.type === 'full_reduce') d = fullReduceDiscount(a, rows)
    else if (a.type === 'discount') d = discountActivityDiscount(a, rows)
    if (d > bestDiscount) { bestDiscount = d; best = a }
  }

  // 优惠金额不能透支原价
  const discount = Math.min(bestDiscount, original)
  return { activity: best, discount, original, payable: Math.max(0, original - discount) }
}

// 给定一个子订单的行列表，对"指定活动"单独计价（不叠加其他活动）。
// 若指定活动不存在 / 不适用 / 无优惠，则回退到全量活动里的最优。
// 供结算页"用户手动选券"使用：同一订单只享受一个活动。
// 返回值同 resolve。
function resolvePicked(rows, activeActivities, pickedActivityId) {
  const original = rows.reduce((s, it) => s + Number(it.goods.price) * Number(it.quantity || 0), 0)
  const picked = (activeActivities || []).find((a) => Number(a.id) === Number(pickedActivityId))
  if (picked) {
    let d = 0
    if (picked.type === 'full_reduce') d = fullReduceDiscount(picked, rows)
    else if (picked.type === 'discount') d = discountActivityDiscount(picked, rows)
    if (d > 0) {
      const discount = Math.min(d, original)
      return { activity: picked, discount, original, payable: Math.max(0, original - discount) }
    }
  }
  // 指定活动不可用 → 用最优活动兜底
  return resolve(rows, activeActivities)
}

// 为前端提供友好的活动命中说明，供结算页/商品页展示
function describe(activity, discount, original) {
  if (!activity) return null
  const cfg = activity._cfg || {}
  const scopeTxt = cfg.scope === 'goods' ? `（指定商品）` : ''
  let text
  if (activity.type === 'discount') {
    const d = Number(cfg.discount)
    const zhe = d ? (d * 10).toFixed(1).replace(/\.0$/, '') : ''
    text = `该商品享受 ${zhe} 折优惠`
  } else if (activity.type === 'full_reduce' && Array.isArray(cfg.tiers)) {
    const top = cfg.tiers.filter((t) => Number(t.threshold) > 0).sort((a, b) => Number(a.threshold) - Number(b.threshold)).map((t) => `满${t.threshold}减${t.reduce}`)
    text = top.length ? `优惠：${top.join(' / ')}` : '满减活动'
  } else {
    text = activity.title || '活动优惠'
  }
  return {
    activity_id: activity.id,
    type: activity.type,
    title: activity.title || '',
    text,
    scope: cfg.scope === 'goods' ? 'goods' : 'all',
    scope_txt: scopeTxt,
    discount,
    payable: Math.max(0, (original || 0) - discount)
  }
}

module.exports = {
  loadActive,
  resolve,
  resolvePicked,
  describe,
  inTimeWindow,
  goodsInScope,
  fullReduceDiscount,
  discountActivityDiscount
}