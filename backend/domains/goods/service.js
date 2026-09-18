// goods 域业务逻辑：店铺状态聚合、库存/销量结算（goodsStats 归本域）
// 依赖注入：函数显式接收 store；runtime 由调用方传入（不持有模块级单例）。

const q = require('./queries')

// 店铺状态（营业/自动接单）：真实后端状态，不再存于小程序本地。
// 附加运行模式标记：设备控制（开舱/关舱/派发）是否走本地模拟由后端决定，
// 商家端不再硬编码 DEVICE_MOCK —— 那会造成「后端已真实调度机器人、前端却假装已上货已送达」。
// 强制点在后端（mock-dispatch/test-complete 按 deviceMock 返回 404），此处下发仅供前端选择分支。
function shopWithRuntime(shop, runtime) {
  return Object.assign(
    { id: 1, name: '零栋铺子', business_status: 'open', auto_accept: 0 },
    shop || {},
    {
      run_mode: runtime.mode,
      device_mock: runtime.deviceMock,
      pay_mock: !runtime.realPay,
      login_user: runtime.loginMode('user'),
      login_merchant: runtime.loginMode('merchant')
    }
  )
}

// goodsStats（settleSales/restoreStock）归 goods 域：对外包装，供 order/delivery 域跨域调用。
// settleSales：收货完成结算已售（goods_settled 幂等）；restoreStock：取消/退款回补库存（stock_restored_at 幂等）。
const goodsStats = require('../../services/goodsStats')
const settleSales = (store, orderId) => goodsStats.settleSales(store, orderId)
const restoreStock = (store, orderId) => goodsStats.restoreStock(store, orderId)

// 促销计算（promotion.js）为共享服务：价格权威在 order 域下单时执行；本域只做"展示用"折后价。
const promotion = require('../../services/promotion')

// 为商品行附加"折后价/是否参与折扣"，供用户端商品页/购物车展示划线价与折后价。
// 仅做展示，不参与交易；真实金额在 order/create 由 promotion.resolve 权威计算。
// rowsOrRow：单行或行数组；行需含 id 与 price（购物车行请先把 goods_id 映射成 id 再传入）。
function withPromoPrices(store, rowsOrRow) {
  const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow]
  const active = promotion.loadActive(store).filter((a) => a.type === 'discount')
  return rows.map((row) => {
    let sale_price = null
    let discount_info = null
    for (const a of active) {
      if (promotion.goodsInScope(a, row.id)) {
        const d = Number((a._cfg || {}).discount)
        if (d > 0 && d < 1) {
          sale_price = Math.round(Number(row.price) * d * 100) / 100
          discount_info = { activity_id: a.id, discount: d, title: a.title || '' }
          break // 同一商品只算第一个命中折扣（商家应避免多折扣并行）
        }
      }
    }
    return Object.assign({}, row, { sale_price, discount_info })
  })
}

// 活动列表（用户端公开）：附 type / config(已解析) / 起止时间 / state(active|pending|ended)，
// 前端据此展示折扣/满减样式与估算（最终金额以后端 order/create 为准）。
function listActivitiesTyped(store) {
  const now = Date.now()
  return q.listActivities(store).map((a) => {
    let cfg = {}
    try { cfg = JSON.parse(a.config || '{}') || {} } catch (e) { cfg = {} }
    let state = 'active'
    const at = (t) => (t ? new Date(t.replace(' ', 'T')).getTime() : NaN)
    const s = at(a.start_at), e = at(a.end_at)
    if (!isNaN(s) && now < s) state = 'pending'
    else if (!isNaN(e) && now > e) state = 'ended'
    return {
      id: a.id, title: a.title, subtitle: a.subtitle, image: a.image, link: a.link,
      type: a.type, sort: a.sort, start_at: a.start_at, end_at: a.end_at, state, config: cfg
    }
  })
}

// 跨域只读入口：order 域下单/自动接单需要店铺与商品信息
const getShop = (store) => q.getShop(store)
const getGoods = (store, id) => q.findById(store, id)

// 跨域写入口：order 域下单条件扣库存（stock>=? 原子防超卖，扣不到返回 false 由调用方抛业务错误）
function deductStock(store, id, qty) {
  const r = store.prepare('UPDATE goods SET stock=stock-? WHERE id=? AND stock>=?').run(Number(qty), Number(id), Number(qty))
  return r.changes === 1
}

module.exports = { shopWithRuntime, settleSales, restoreStock, getShop, getGoods, deductStock, withPromoPrices, listActivitiesTyped }
