// order 域业务逻辑：状态字典/常量、订单状态机辅助、下单拆单、支付、取消/退款落账、商家统计
// 依赖注入：函数显式接收 (store, deps)。deps = { runtime, wxpay, batch, platform, orderCancel, goods, user }
// 跨域读（delivery_tasks/delivery_batches/landmarks/shops/goods）以只读 SQL 形式出现并注释；
// 跨域写一律走 deps.goods / deps.user（deductStock / removeCartItems / restoreStock / settleSales）。

const q = require('./queries')
// 促销计算（promotion.js）为共享服务（纯函数 + store 注入）：下单时权威计算折后应付/优惠金额
const promotion = require('../../services/promotion')

// ---------- 状态字典与常量（05 方案：ORDER_STATUS/REFUND_STATUS/CANCEL_REQ_STATUS/FREE_CANCEL_WINDOW_MS/PICKUP_*/DELIVERY_* 归 order 域） ----------
const ORDER_STATUS = {
  0: '待支付', 1: '待接单', 2: '配送中', 3: '已送达', 4: '已完成', 5: '已取消', 6: '配送异常', 7: '已退款'
}
// 售后状态：0 待处理 / 2 已拒绝 / 3 已退款 / 4 已处理(投诉)
const REFUND_STATUS = { 0: '待处理', 2: '已拒绝', 3: '已退款', 4: '已处理' }
// 取消申请状态：0 待处理 / 2 已拒绝 / 3 已同意取消
const CANCEL_REQ_STATUS = { 0: '待处理', 2: '已拒绝', 3: '已同意取消' }

// 免费取消时间窗：下单后该时长内可直接取消（不论商家是否接单），超过须提交取消申请由商家判断。
const FREE_CANCEL_WINDOW_MS = Number(process.env.FREE_CANCEL_WINDOW_MS || 10 * 60 * 1000)

// 重新开舱限制（P1-2）：取餐开舱后允许在窗口内重新打开，但必须限次数限时。默认送达后 10 分钟内、最多 3 次。
const PICKUP_REOPEN_WINDOW_MS = Number(process.env.PICKUP_REOPEN_WINDOW_MS || 10 * 60 * 1000)
const MAX_PICKUP_OPEN = Number(process.env.MAX_PICKUP_OPEN || 3)

// 取餐超时（两段式）与取餐守卫（详见 server.js 原注释，逻辑原样迁入）
const PICKUP_TIMEOUT_MS = Number(process.env.PICKUP_TIMEOUT_MS || 15 * 60 * 1000)
const PICKUP_RETRY_TIMEOUT_MS = Number(process.env.PICKUP_RETRY_TIMEOUT_MS || 15 * 60 * 1000)
const PICKUP_PICKING_GUARD_MS = Number(process.env.PICKUP_PICKING_GUARD_MS || 5 * 60 * 1000)
const PICKUP_SCAN_MS = Number(process.env.PICKUP_SCAN_MS || 30 * 1000)

// 配送卡死阈值（P1-4）与超时扫描间隔
const DELIVERY_TIMEOUT_MS = Number(process.env.DELIVERY_TIMEOUT_MS || 15 * 60 * 1000)
const DELIVERY_SCAN_MS = Number(process.env.DELIVERY_SCAN_MS || 60 * 1000)

// ---------- 订单状态机辅助 ----------
// 订单是否「真正开始配送」：已接单(2)且机器人已上货出发（任务状态 >= 50 已上货）
function orderTrulyDelivering(store, order) {
  if (Number(order.status) !== 2) return false
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  return !!task && Number(task.task_status) >= 50
}

// 订单是否「卡死配送中」（P1-4）：任务停留在非终态且长期无进展（超过 DELIVERY_TIMEOUT_MS）
function orderStuckDelivering(store, order) {
  if (Number(order.status) !== 2) return false
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  if (!task || task.void_at) return false
  if ([70, 80, 110, 150].includes(Number(task.task_status))) return false
  const t = new Date(String(task.updated_at || '').replace(' ', 'T')).getTime()
  return !isNaN(t) && Date.now() - t > DELIVERY_TIMEOUT_MS
}

// 自动接单：营业中且 auto_accept=1 时，已支付订单自动接单并并入当前配送批次。
// 读 shops（goods 域，走 deps.goods.getShop）；并入批次调 deps.batch.addOrderToBatch（delivery 域，未拆前直连 services/batch）。
function maybeAutoAccept(store, deps, order) {
  const shop = deps.goods.getShop(store)
  if (shop.business_status !== 'open' || Number(shop.auto_accept) !== 1) return false
  if (Number(order.status) !== 1) return false
  const cur = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
  if (!cur) return false
  try {
    deps.batch.addOrderToBatch(store, cur)
    console.log('[order] 自动接单 order=' + cur.id + ' ' + cur.order_no + ' → 批次并入')
    return true
  } catch (e) {
    console.warn('[order] 自动接单并入批次失败', e.message)
    return false
  }
}

// 是否仍在免费取消窗口内（按下单时间计）
function withinFreeCancelWindow(order) {
  const t = new Date(String(order.created_at || '').replace(' ', 'T')).getTime()
  if (isNaN(t)) return false
  return Date.now() - t <= FREE_CANCEL_WINDOW_MS
}

// 订单取消落库 + 真实召回（P0-4）：委托 services/orderCancel（本地副作用唯一实现），随后平台召回。
// 返回 { claimed, finalStatus, tasks }：claimed=false 表示订单已在终态，本次是重复取消。
async function applyOrderCancelled(store, deps, order, opts) {
  const o = Object.assign({ reason: '订单取消' }, opts || {})
  const c = deps.orderCancel.cancelLocal(store, order, o)
  if (!c.claimed || !c.tasks || !c.tasks.length) return c
  for (const t of c.tasks) {
    try {
      const st = Number(t.task_status)
      let r = null
      if (st < 10 && t.platform_task_id) {
        r = await deps.platform.cancelQueueTask(t.platform_task_id)
      } else if (t.device_sn && t.platform_task_id) {
        r = await deps.platform.closeTask(t.device_sn, t.platform_task_id, o.reason || '订单取消')
      }
      if (r) {
        store.prepare("UPDATE delivery_tasks SET recall_status=?, recall_error=?, updated_at=datetime('now','localtime') WHERE id=?")
          .run(r.ok ? 1 : 2, r.ok ? '' : String(r.msg || '').slice(0, 200), t.id)
      }
    } catch (e) {
      store.prepare("UPDATE delivery_tasks SET recall_status=2, recall_error=?, updated_at=datetime('now','localtime') WHERE id=?")
        .run(String(e.message || e).slice(0, 200), t.id)
    }
  }
  return c
}

// 真实退款（P0-5）：仅真实微信支付渠道且凭据就绪时真正退钱；否则本地标记 + 告警。
async function realRefundOrLocal(store, deps, order, refundId, amount) {
  if (!order) return { ok: true, local: true, refundNo: '' }
  const outRefundNo = 'R' + String(Date.now()).slice(-12) + (refundId ? '-' + refundId : '')
  if (String(order.pay_channel) === 'wxpay' && deps.wxpay.enabled()) {
    try {
      const r = await deps.wxpay.refund({
        outTradeNo: order.order_no,
        outRefundNo,
        refundFen: Math.round(Number(amount || order.total_amount) * 100),
        totalFen: Math.round(Number(order.total_amount) * 100),
        reason: '退款'
      })
      return { ok: true, local: false, refundNo: r.out_refund_no || outRefundNo }
    } catch (e) {
      return { ok: false, msg: '真实退款失败：' + (e.message || e) }
    }
  }
  console.warn('[refund] 订单 ' + order.order_no + ' 为模拟支付或未配置支付凭据，仅本地标记已退款（无可退资金）')
  return { ok: true, local: true, refundNo: '' }
}

// 订单拆单：按 maxItems 件上限把购物车行贪心拆成多个子订单行块（每块 ≤ maxItems 件）
function splitOrderChunks(lineItems, maxItems) {
  const chunks = []
  let cur = []
  let curQty = 0
  for (const it of lineItems) {
    let q = it.quantity
    while (q > 0) {
      const take = Math.min(q, maxItems - curQty)
      cur.push({ goods: it.goods, quantity: take })
      curQty += take
      q -= take
      if (curQty >= maxItems) {
        chunks.push(cur)
        cur = []
        curQty = 0
      }
    }
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

// 订单统计口径（商家首页与大屏共用同一份）
// 跨域只读：delivery_batches 状态过滤（delivery 域未拆前直接读，步骤 3 可改走 delivery.service）
function computeStats(store) {
  const today = new Date().toISOString().slice(0, 10)
  return {
    today_orders: store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=?").get(today).c,
    today_amount: store.prepare("SELECT IFNULL(SUM(total_amount),0) s FROM orders WHERE date(created_at)=? AND status NOT IN (0,5)").get(today).s,
    // 主面板四态：待接单 / 待上货 / 配送中 / 待取货
    pending: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=1').get().c,
    ready_load: store.prepare("SELECT COUNT(*) c FROM orders WHERE status=2 AND batch_id IN (SELECT id FROM delivery_batches WHERE status IN (0,1))").get().c,
    delivering: store.prepare("SELECT COUNT(*) c FROM orders WHERE status=2 AND batch_id IN (SELECT id FROM delivery_batches WHERE status=2)").get().c,
    pickup: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=3').get().c,
    // 异常 / 售后（次面板）
    exception: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=6').get().c,
    aftersale: store.prepare('SELECT COUNT(*) c FROM refunds WHERE status=0').get().c,
    cancel_requests: store.prepare('SELECT COUNT(*) c FROM cancel_requests WHERE status=0').get().c,
    // 兼容旧字段
    finished: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=4').get().c
  }
}

// ---------- 下单（核心业务，从路由回调迁入） ----------
// 返回 { error: {status, msg} } 或 { data }；HTTP 状态码由 routes 层翻译。
// 跨域读：shops（goods 域）、landmarks（delivery 域只读）、goods（goods 域只读）
// 跨域写：goods.deductStock、user.removeCartItems
function createOrder(store, deps, body, userId) {
  const shop = deps.goods.getShop(store)
  if (shop.business_status === 'closed') {
    return { error: { status: 400, msg: '店铺歇业中，暂无法下单' } }
  }
  const { landmark_id, landmark_name, remark = '', items = [], contact_name = '', contact_phone = '', address_id, activity_id } = body || {}
  if (!items.length) return { error: { status: 400, msg: '订单不能为空' } }
  // 收餐人落库（P0-3）：姓名 trim 非空 ≤20；手机号必须校验
  const cname = String(contact_name || '').trim()
  const cphone = String(contact_phone || '').trim()
  if (!cname) return { error: { status: 400, msg: '请填写收餐人姓名' } }
  if (cname.length > 20) return { error: { status: 400, msg: '收餐人姓名过长' } }
  if (!/^1\d{10}$/.test(cphone)) return { error: { status: 400, msg: '请填写正确的手机号' } }
  // 点位存在性校验（P2-8）：必须是可用的送达点
  const lm = landmark_id ? store.prepare("SELECT * FROM landmarks WHERE id=? AND type='deliverPoint'").get(String(landmark_id)) : null
  if (!lm) return { error: { status: 400, msg: '送达点位不存在或不可用' } }
  let total = 0
  const lineItems = items.map((it) => {
    const q = Number(it.quantity)
    if (!Number.isInteger(q) || q <= 0 || q > 99) throw new Error('商品数量不合法')
    const g = deps.goods.getGoods(store, it.goods_id)
    if (!g) throw new Error('商品不存在')
    if (Number(g.stock) < q) throw new Error('「' + g.name + '」库存不足')
    total += g.price * q
    return { goods: g, quantity: q }
  })
  // 单笔订单总件数超过单车容量（BATCH_MAX_ITEMS=12）时自动拆单
  const totalItems = lineItems.reduce((s, it) => s + it.quantity, 0)
  // 拆单前整体预校验库存（拆单后同一商品会被分多次扣减，先确认总量够）
  for (const it of lineItems) {
    const g = deps.goods.getGoods(store, it.goods.id)
    if (!g || Number(g.stock) < it.quantity) throw new Error('「' + it.goods.name + '」库存不足')
  }
  const chunks = totalItems > deps.batch.BATCH_MAX_ITEMS ? splitOrderChunks(lineItems, deps.batch.BATCH_MAX_ITEMS) : [lineItems]
  const created = []
  let seq = q.dailySeqCount(store)
  const orderNoNew = () => 'LD' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6).toUpperCase()
  const pickupCodeNew = () => String(Math.floor(1000 + Math.random() * 9000))
  // 当前生效且已发布的活动（含时间窗过滤）：同单只享一个，取用户选中的（activity_id），未选/失效取最大优惠
  const ordersActivePromos = promotion.loadActive(store)
  for (const chunk of chunks) {
    const originalTotal = chunk.reduce((s, it) => s + it.goods.price * it.quantity, 0)
    // 权威优惠计算：后端重算应付金额，前端自报价无效
    const promo = activity_id
      ? promotion.resolvePicked(chunk.map((it) => ({ goods: it.goods, quantity: it.quantity })), ordersActivePromos, activity_id)
      : promotion.resolve(chunk.map((it) => ({ goods: it.goods, quantity: it.quantity })), ordersActivePromos)
    const chunkTotal = promo.payable
    const discountAmount = promo.discount
    const orderNo = orderNoNew()
    const pickupCode = pickupCodeNew()
    seq += 1
    const orderId = q.insert(store, {
      orderNo, userId, landmarkId: String(landmark_id), landmarkName: lm.name,
      contactName: cname, contactPhone: cphone, totalAmount: Number(chunkTotal).toFixed(2),
      originalAmount: Number(originalTotal).toFixed(2), discountAmount: Number(discountAmount).toFixed(2),
      activityId: promo.activity ? promo.activity.id : null,
      remark, pickupCode, seq
    })
    for (const { goods, quantity } of chunk) {
      q.insertItem(store, { orderId, goodsId: goods.id, goodsName: goods.name, goodsImage: goods.image, price: goods.price, quantity })
      // 条件更新扣库存（P1-5）：校验与扣减原子，扣不到即超卖
      if (!deps.goods.deductStock(store, goods.id, quantity)) throw new Error('「' + goods.name + '」库存不足')
    }
    created.push({ order_id: orderId, order_no: orderNo, total_amount: chunkTotal, pickup_code: pickupCode, items: chunk.length })
  }
  // 购物车只删本次订单实际包含的商品（P1-6）：不再无条件清空整张购物车
  const cartGids = [...new Set(lineItems.map((it) => it.goods.id))]
  deps.user.removeCartItems(store, userId, cartGids)
  if (created.length === 1) {
    const o = created[0]
    return { data: { order_id: o.order_id, order_no: o.order_no, total_amount: o.total_amount, pickup_code: o.pickup_code } }
  }
  return { data: { orders: created, split: true, split_count: created.length, total_amount: total } }
}

// ---------- 支付（模拟档 / 真实档） ----------
async function payOrder(store, deps, order, user) {
  const { id } = order
  if (Number(order.status) !== 0) return { error: { status: 400, msg: '订单状态不允许支付' } }
  // 试点临时开关：非真实支付档直接标记已支付进入待接单（真实支付代码保持不动）
  if (!deps.runtime.realPay) {
    q.markPaidMock(store, id)
    const o2 = store.prepare('SELECT * FROM orders WHERE id=?').get(id)
    if (maybeAutoAccept(store, deps, o2)) {
      return { data: { order_id: id, mock: true, auto_accept: true, msg: '试点模式：模拟支付成功，已自动接单并入配送批次' } }
    }
    return { data: { order_id: id, mock: true, msg: '试点模式：模拟支付成功' } }
  }
  const WX_APPID = process.env.WX_APPID || ''
  if (!WX_APPID) return { error: { status: 501, msg: '支付通道未开通：请先配置 WX_APPID 与微信支付商户参数' } }
  if (!deps.wxpay.enabled()) {
    return { error: { status: 501, msg: '支付通道未开通：请配置 WXPAY_MCHID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY / WXPAY_APIV3_KEY / WXPAY_NOTIFY_URL' } }
  }
  try {
    const payParams = await deps.wxpay.jsapiPay({
      appid: WX_APPID,
      openid: user.openid,
      outTradeNo: order.order_no,
      description: '零栋GO-订单' + order.order_no,
      amountFen: Math.round(Number(order.total_amount) * 100)
    })
    q.markPayChannel(store, id, 'wxpay')
    return { data: { order_id: id, payParams } }
  } catch (e) {
    return { error: { status: 502, msg: '微信支付下单失败：' + e.message } }
  }
}

module.exports = {
  // 常量（delivery 域/定时器仍在使用，步骤 3 迁移时从此处引入）
  ORDER_STATUS, REFUND_STATUS, CANCEL_REQ_STATUS, FREE_CANCEL_WINDOW_MS,
  PICKUP_REOPEN_WINDOW_MS, MAX_PICKUP_OPEN, PICKUP_TIMEOUT_MS, PICKUP_RETRY_TIMEOUT_MS, PICKUP_PICKING_GUARD_MS, PICKUP_SCAN_MS,
  DELIVERY_TIMEOUT_MS, DELIVERY_SCAN_MS,
  // 状态机辅助
  orderTrulyDelivering, orderStuckDelivering, maybeAutoAccept, withinFreeCancelWindow,
  applyOrderCancelled, realRefundOrLocal, splitOrderChunks,
  // 业务
  createOrder, payOrder, computeStats
}
