// 优惠券服务：券定义（coupons）/ 用户券（user_coupons）/ 结算时的「最优券推荐 + 优惠分摊」。
// 价格权威在后端：结算页只做展示估算，真实抵扣以 order/create 调本模块算出的结果为准。
//
// 券类型：
//   full_reduce  满减   ：可参与商品小计 ≥ threshold 时减 reduce
//   discount     折扣   ：可参与商品小计 × (1-discount)，封顶 max_reduce
//   no_threshold 无门槛 ：直接减 reduce
//
// 与活动（promotion.js）的关系：两者**可同时享受**。
// 活动先作用于商品单价（价格权威在 promotion），券再对「活动后金额」抵扣 —— 与美团一致（先折扣、后用券），
// 也避免了「券把活动价再打折」这种会导致商家亏两遍的算法。

const MONEY_SCALE = 100
const fen = (v) => Math.round((Number(v) || 0) * MONEY_SCALE)
const toYuan = (f) => Math.round(Number(f) || 0) / MONEY_SCALE

function pad2(n) { return String(n).padStart(2, '0') }
function fmt(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
function nowStr() { return fmt(new Date()) }

// ---------- 适用范围 ----------
function parseScope(coupon) {
  let ids = []
  try {
    const v = JSON.parse((coupon && coupon.scope_ids) || '[]')
    if (Array.isArray(v)) ids = v.map(String)
  } catch (e) { ids = [] }
  return { scope: (coupon && coupon.scope) || 'all', ids }
}

// 某商品是否在券的适用范围内
function goodsInScope(coupon, goods) {
  const { scope, ids } = parseScope(coupon)
  if (scope === 'all') return true
  if (!goods) return false
  if (scope === 'goods') return ids.includes(String(goods.id))
  if (scope === 'category') return ids.includes(String(goods.category || ''))
  return true
}

// ---------- 有效期 ----------
// userCoupon.expire_at 优先（相对有效期按领取时间推算，因人而异）；
// 没有相对有效期时看模板的绝对时间窗；两者都没有 = 长期有效。
function inValidWindow(coupon, userCoupon, now) {
  const t = now || nowStr()
  if (coupon.start_at && t < coupon.start_at) return false
  const expire = userCoupon && userCoupon.expire_at
  if (expire) return t <= expire
  if (coupon.end_at) return t <= coupon.end_at
  return true
}

// 领取后到期时间（相对有效期）。无相对有效期返回 ''（表示跟随模板的绝对时间或长期）
function calcExpireAt(coupon, receivedAt) {
  const days = Number(coupon.relative_days) || 0
  if (coupon.valid_type !== 'relative' || days <= 0) return ''
  const base = receivedAt ? new Date(String(receivedAt).replace(' ', 'T')) : new Date()
  if (isNaN(base.getTime())) return ''
  base.setDate(base.getDate() + days)
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())} 23:59:59`
}

// ---------- 抵扣计算 ----------
// rows: [{ goods, quantity, amount }]；amount = 该行的**活动后**金额（分）
// 返回 { reduce(分), base(分, 参与商品小计), scopeMatched(是否有商品参与) }
function computeReduce(coupon, rows) {
  const inScope = (rows || []).filter((r) => goodsInScope(coupon, r.goods))
  if (!inScope.length) return { reduce: 0, base: 0, scopeMatched: false }
  const base = inScope.reduce((s, r) => s + Number(r.amount || 0), 0)
  const type = (coupon && coupon.type) || 'full_reduce'

  if (type === 'no_threshold') {
    return { reduce: Math.max(0, Math.min(fen(coupon.reduce), base)), base, scopeMatched: true }
  }
  if (type === 'full_reduce') {
    if (base < fen(coupon.threshold)) return { reduce: 0, base, scopeMatched: true }
    return { reduce: Math.max(0, Math.min(fen(coupon.reduce), base)), base, scopeMatched: true }
  }
  if (type === 'discount') {
    const d = Number(coupon.discount)
    // discount 语义：0.85 = 85 折（应付比例）。不在 (0,1) 内视为无折扣
    if (!(d > 0) || !(d < 1)) return { reduce: 0, base, scopeMatched: true }
    let reduce = Math.round(base * (1 - d))
    const cap = fen(coupon.max_reduce)
    if (cap > 0) reduce = Math.min(reduce, cap)
    return { reduce: Math.max(0, Math.min(reduce, base)), base, scopeMatched: true }
  }
  return { reduce: 0, base, scopeMatched: true }
}

// 评估一张用户券对当前订单的可用性。
// 返回 { usable, reason(机器码), reasonText(给用户看的原因), reduce(分), base(分) }
// 不可用原因是产品要求：必须明确告诉用户「为什么不能用」
function evaluate(coupon, userCoupon, rows, now) {
  const empty = { reduce: 0, base: 0 }
  if (!coupon || Number(coupon.status) !== 1) {
    return Object.assign({ usable: false, reason: 'disabled', reasonText: '该券已停用' }, empty)
  }
  if (userCoupon && Number(userCoupon.status) === 1) {
    return Object.assign({ usable: false, reason: 'used', reasonText: '已使用' }, empty)
  }
  if (userCoupon && Number(userCoupon.status) === 2) {
    return Object.assign({ usable: false, reason: 'expired', reasonText: '已过期' }, empty)
  }
  if (!inValidWindow(coupon, userCoupon, now)) {
    return Object.assign({ usable: false, reason: 'expired', reasonText: '已过期' }, empty)
  }

  const { reduce, base, scopeMatched } = computeReduce(coupon, rows)
  if (!scopeMatched) {
    return Object.assign({ usable: false, reason: 'scope', reasonText: '商品不适用' }, { reduce: 0, base: 0 })
  }
  if (coupon.type === 'full_reduce' && base < fen(coupon.threshold)) {
    const diff = toYuan(fen(coupon.threshold) - base)
    return { usable: false, reason: 'threshold', reasonText: `还差 ¥${diff.toFixed(2)} 可用`, reduce: 0, base }
  }
  if (reduce <= 0) {
    return { usable: false, reason: 'no_benefit', reasonText: '本单无抵扣', reduce: 0, base }
  }
  return { usable: true, reason: '', reasonText: '', reduce, base }
}

// ---------- 最优券推荐 ----------
// candidates: [{ coupon, userCoupon }]
// 返回 { best, all }：best 为抵扣最多的可用券（同额优先门槛更高的），all 含不可用券及其原因
function rankFor(rows, candidates, now) {
  const all = (candidates || []).map((c) => {
    const r = evaluate(c.coupon, c.userCoupon, rows, now)
    return Object.assign({ coupon: c.coupon, userCoupon: c.userCoupon }, r)
  })
  const usable = all.filter((x) => x.usable)
  usable.sort((a, b) => (b.reduce - a.reduce) || (fen(b.coupon.threshold) - fen(a.coupon.threshold)))
  return { best: usable[0] || null, all }
}

// ---------- 优惠分摊 ----------
// 按「参与商品的活动后金额」比例，把券优惠分摊到每一行商品：
//   ① 各分摊之和**恰好**等于总优惠（余数归最后一行，避免逐行四舍五入对不上账）
//   ② 单行分摊不超过该行金额（实付不会变负数）
//   ③ 只分摊给券适用范围内的商品
// rows: [{ goods, quantity, amount }]（amount 为分）；返回 Map<行下标, 分摊金额(分)>
function allocate(rows, totalReduce, coupon) {
  const out = new Map()
  const list = rows || []
  const idx = []
  list.forEach((r, i) => { if (!coupon || goodsInScope(coupon, r.goods)) idx.push(i) })
  const total = Math.max(0, Math.round(Number(totalReduce) || 0))
  if (!idx.length || total <= 0) return out

  const baseSum = idx.reduce((s, i) => s + Math.max(0, Number(list[i].amount || 0)), 0)
  if (baseSum <= 0) return out

  let assigned = 0
  idx.forEach((i, k) => {
    if (k === idx.length - 1) {
      out.set(i, total - assigned)      // 最后一行吃余数，保证总额精确
    } else {
      const lineAmt = Math.max(0, Number(list[i].amount || 0))
      let share = Math.round(total * lineAmt / baseSum)
      share = Math.min(share, lineAmt)  // 不允许超过该行金额
      out.set(i, share)
      assigned += share
    }
  })
  return out
}

// 券给用户看的一行文案（列表/结算页共用），如「满30减5」「8.5折」「无门槛减3」
function describe(coupon) {
  const c = coupon || {}
  const t = c.type || 'full_reduce'
  const num = (v) => toYuan(fen(v)).toFixed(2).replace(/\.00$/, '')
  if (t === 'discount') {
    const zhe = (Number(c.discount) * 10).toFixed(1).replace(/\.0$/, '')
    const cap = Number(c.max_reduce) > 0 ? `（最高减¥${num(c.max_reduce)}）` : ''
    return `${zhe}折${cap}`
  }
  if (t === 'no_threshold') return `无门槛减¥${num(c.reduce)}`
  return `满¥${num(c.threshold)}减¥${num(c.reduce)}`
}

module.exports = {
  fen, toYuan, nowStr, parseScope, goodsInScope,
  inValidWindow, calcExpireAt, computeReduce, evaluate, rankFor, allocate, describe
}
