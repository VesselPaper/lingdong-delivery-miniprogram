// coupon 域业务逻辑：商家端券管理 / 用户端领券与我的券 / 结算可用券（最优推荐 + 不可用原因）
// 券「怎么算」都在 services/coupon.js；这里只负责取数、校验、落库。
const q = require('./queries')
const couponSvc = require('../../services/coupon')
const promotion = require('../../services/promotion')

const TYPES = ['full_reduce', 'discount', 'no_threshold']
const SCOPES = ['all', 'category', 'goods']

// 商家端新建/编辑共用的字段归一化 + 校验（两处各写一套迟早口径不一致）
function normalizeCoupon(body) {
  const b = body || {}
  const title = String(b.title || '').trim()
  if (!title) return { error: '请填写券名称' }
  if (title.length > 40) return { error: '券名称过长' }

  const type = TYPES.includes(b.type) ? b.type : 'full_reduce'
  const threshold = Math.max(0, Number(b.threshold) || 0)
  const reduce = Math.max(0, Number(b.reduce) || 0)
  const discount = Number(b.discount) || 0
  const maxReduce = Math.max(0, Number(b.max_reduce) || 0)

  if (type === 'full_reduce' && !(reduce > 0)) return { error: '满减券需要填写抵扣金额' }
  if (type === 'no_threshold' && !(reduce > 0)) return { error: '无门槛券需要填写抵扣金额' }
  if (type === 'discount' && !(discount > 0 && discount < 1)) return { error: '折扣率需在 0~1 之间（0.85 表示 85 折）' }

  const validType = b.valid_type === 'relative' ? 'relative' : 'absolute'
  const relativeDays = Math.max(0, Math.floor(Number(b.relative_days) || 0))
  if (validType === 'relative' && relativeDays <= 0) return { error: '相对有效期需要填写天数' }

  const scope = SCOPES.includes(b.scope) ? b.scope : 'all'
  let scopeIds = []
  if (scope !== 'all') {
    const raw = Array.isArray(b.scope_ids) ? b.scope_ids : []
    scopeIds = raw.map((x) => String(x)).filter(Boolean)
    if (!scopeIds.length) return { error: scope === 'category' ? '请选择适用分类' : '请选择适用商品' }
  }

  // 用户端首页与活动页都是图片列表，券和折扣/满减活动一样靠图片呈现 ——
  // 没图就等于用户看不到这张券，所以「启用」必须有图（停用可以没图，便于先存后补图）
  const image = String(b.image || '').trim()
  const status = Number(b.status) === 0 ? 0 : 1
  if (status === 1 && !image) return { error: '请上传优惠券图片（用户端以图片形式展示优惠券）' }

  return {
    value: {
      title, type, threshold, reduce,
      discount: type === 'discount' ? discount : 0,
      max_reduce: type === 'discount' ? maxReduce : 0,
      image,
      valid_type: validType,
      start_at: validType === 'absolute' ? String(b.start_at || '') : '',
      end_at: validType === 'absolute' ? String(b.end_at || '') : '',
      relative_days: validType === 'relative' ? relativeDays : 0,
      scope,
      scope_ids: JSON.stringify(scopeIds),
      total_qty: Math.max(0, Math.floor(Number(b.total_qty) || 0)),
      // 0 = 不限领；字段缺失才回落默认「每人限领 1 张」（不限领是危险默认，不能拿来兜底）
      per_user_limit: (b.per_user_limit === undefined || b.per_user_limit === null || b.per_user_limit === '')
        ? 1
        : Math.max(0, Math.floor(Number(b.per_user_limit) || 0)),
      status
    }
  }
}

// 能否领取（状态 / 绝对有效期 / 总量 / 每人限领）
function checkReceivable(store, userId, coupon) {
  if (!coupon) return { error: '优惠券不存在' }
  if (Number(coupon.status) !== 1) return { error: '该券已停用' }
  const now = couponSvc.nowStr()
  if (coupon.valid_type === 'absolute' && coupon.end_at && now > coupon.end_at) return { error: '该券已过期' }
  const total = Number(coupon.total_qty) || 0
  if (total > 0) {
    const issued = Number(q.issuedOf(store, coupon.id)) || 0
    if (issued >= total) return { error: '该券已被领完' }
  }
  const limit = Number(coupon.per_user_limit) || 0
  if (limit > 0) {
    const mine = Number(q.countMine(store, userId, coupon.id)) || 0
    if (mine >= limit) return { error: limit === 1 ? '你已领取过该券' : '每人限领 ' + limit + ' 张' }
  }
  return { ok: true }
}

// 可领券列表：附描述、我已领张数、剩余、能否领（前端据此置灰按钮）
function listForUser(store, userId) {
  const list = q.listActive(store) || []
  const now = couponSvc.nowStr()
  return list.map((c) => {
    const total = Number(c.total_qty) || 0
    const issued = Number(q.issuedOf(store, c.id)) || 0
    const mine = userId ? Number(q.countMine(store, userId, c.id)) || 0 : 0
    const limit = Number(c.per_user_limit) || 0
    let state = 'ok'
    if (c.valid_type === 'absolute' && c.end_at && now > c.end_at) state = 'expired'
    else if (total > 0 && issued >= total) state = 'soldout'
    else if (limit > 0 && mine >= limit) state = 'received'
    return Object.assign({}, c, {
      desc: couponSvc.describe(c),
      mine_count: mine,
      left: total > 0 ? Math.max(0, total - issued) : -1,   // -1 = 不限量
      state
    })
  })
}

function receive(store, userId, couponId) {
  const c = q.findById(store, couponId)
  const chk = checkReceivable(store, userId, c)
  if (chk.error) return chk
  // 相对有效期按「领取时刻」算，因人而异，所以到期时间写在用户券上
  const expireAt = couponSvc.calcExpireAt(c, couponSvc.nowStr())
  const id = q.receive(store, userId, c.id, expireAt)
  q.incIssued(store, c.id)
  return { data: { id, expire_at: expireAt, desc: couponSvc.describe(c) } }
}

// 我的券：读取时顺手同步过期状态，不依赖定时任务
function myList(store, userId) {
  q.expireOutdated(store, userId)
  const rows = q.mine(store, userId) || []
  const deco = rows.map((r) => Object.assign({}, r, {
    desc: couponSvc.describe(r),
    usable_now: Number(r.status) === 0 && Number(r.coupon_status) === 1
  }))
  return {
    unused: deco.filter((r) => Number(r.status) === 0),
    used: deco.filter((r) => Number(r.status) === 1),
    expired: deco.filter((r) => Number(r.status) === 2),
    count: deco.filter((r) => Number(r.status) === 0).length
  }
}

// 结算行：把 [{goods_id, quantity}] 变成券算法要的 rows（amount = **活动后**金额，单位分）
// 券作用于活动后金额（先折扣、后用券），与美团一致，也避免券把活动价再打一遍折
function buildRows(store, items) {
  const active = promotion.loadActive(store)
  const rows = []
  for (const it of items || []) {
    const g = q.findGoods(store, it.goods_id)
    if (!g || Number(g.status) !== 1) continue
    const qty = Math.max(1, Number(it.quantity) || 1)
    const promo = promotion.resolve([{ goods: g, quantity: qty }], active)
    rows.push({ goods: g, quantity: qty, amount: couponSvc.fen(promo.payable) })
  }
  return rows
}

// 结算页：可用券 / 不可用券（含原因） / 最优推荐
function usableFor(store, userId, items) {
  const rows = buildRows(store, items)
  if (!rows.length) return { usable: [], unusable: [], best: null, goods_total: '0.00' }
  q.expireOutdated(store, userId)
  const mine = (q.mine(store, userId) || []).filter((r) => Number(r.status) !== 1)   // 已用券不再列
  const candidates = mine.map((r) => ({
    coupon: {
      id: r.coupon_id, title: r.title, type: r.type, threshold: r.threshold, reduce: r.reduce,
      discount: r.discount, max_reduce: r.max_reduce, scope: r.scope, scope_ids: r.scope_ids,
      status: r.coupon_status
    },
    userCoupon: r
  }))
  const { best, all } = couponSvc.rankFor(rows, candidates)
  const deco = (x) => ({
    user_coupon_id: x.userCoupon.id,
    coupon_id: x.coupon.id,
    title: x.coupon.title,
    // 前端要用 type 决定面额块文案（满减券/折扣券/无门槛），discount 等用于折扣券展示
    type: x.coupon.type,
    threshold: x.coupon.threshold,
    discount: x.coupon.discount,
    max_reduce: x.coupon.max_reduce,
    scope: x.coupon.scope,
    expire_at: x.userCoupon.expire_at || x.coupon.end_at || '',
    // 券本身的「面额」（与订单无关）：不可用券的 reduce 会被算成 0，
    // 面额块必须用模板上的值，否则券会显示成「减 0 元」
    face_reduce: couponSvc.toYuan(x.coupon.reduce).toFixed(2),
    desc: couponSvc.describe(x.coupon),
    usable: x.usable,
    reason: x.reason,
    reason_text: x.reasonText,
    reduce: couponSvc.toYuan(x.reduce).toFixed(2),
    reduce_fen: x.reduce
  })
  const goodsTotal = rows.reduce((s, r) => s + r.amount, 0)
  return {
    usable: all.filter((x) => x.usable).map(deco),
    unusable: all.filter((x) => !x.usable).map(deco),
    best: best ? deco(best) : null,
    goods_total: couponSvc.toYuan(goodsTotal).toFixed(2)
  }
}

// 下单用券：校验 → 算分摊。返回 { amount(分), user_coupon_id, coupon_id, shares: Map<行下标, 分> }
// 注意：这里只**计算**，标记「已使用」由 order 域在订单落库成功后调用 q.markUsed（避免下单失败却把券烧掉）
function consume(store, userId, userCouponId, rows) {
  const uc = q.findMine(store, userCouponId, userId)
  if (!uc) return { error: '优惠券不存在' }
  if (Number(uc.status) === 1) return { error: '该券已使用' }
  if (Number(uc.status) === 2) return { error: '该券已过期' }
  const c = q.findById(store, uc.coupon_id)
  const ev = couponSvc.evaluate(c, uc, rows)
  if (!ev.usable) return { error: ev.reasonText || '该券不可用' }
  return {
    amount: ev.reduce,
    user_coupon_id: uc.id,
    coupon_id: c.id,
    shares: couponSvc.allocate(rows, ev.reduce, c)
  }
}

// 订单落库成功后标记券已用（由 order 域跨域调用；先算后标，避免下单失败把券烧掉）
function markUsed(store, userCouponId, orderId) {
  return q.markUsed(store, userCouponId, orderId)
}

// 订单取消/退款时把券退回未使用（符合用户习惯：没用上就该还回来）
function release(store, orderId) {
  return q.release(store, orderId)
}

module.exports = {
  normalizeCoupon, checkReceivable, listForUser, receive, myList,
  buildRows, usableFor, consume, markUsed, release
}
