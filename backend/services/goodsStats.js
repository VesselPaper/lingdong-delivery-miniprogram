// 商品库存/销量结算服务
// 现实模型：
//  - 下单（order/create）：库存即时扣减（防止超卖，剩余库存实时可见），销量暂不计。
//  - 收货完成（订单 3 已送达 / 4 已完成）：已售 + 数量（本单真正售出）。
//  - 取消/退款（订单 5/7）：若该单尚未结算（未真正售出）→ 回补库存（下单时扣减的部分退回）。
// 用 orders.goods_settled 标记是否已结算，保证「平台任务完成 + 用户取餐」双通道触发时幂等。
const store = null // 不持有实例，全部方法显式接收 store

// 本单已售结算：把订单内每个商品 sales 累加数量（幂等，已结算则跳过）
function settleSales(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(orderId))
  if (!order) return
  if (Number(order.goods_settled) === 1) return
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)
  if (!items.length) return
  const upd = db.prepare('UPDATE goods SET sales=sales+? WHERE id=?')
  for (const it of items) upd.run(Number(it.quantity || 0), Number(it.goods_id))
  db.prepare("UPDATE orders SET goods_settled=1, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
}

// 本单库存回补：取消/退款且尚未结算时，把下单时扣减的库存退回（幂等，已结算不退回）
function restoreStock(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(orderId))
  if (!order) return
  if (Number(order.goods_settled) === 1) return
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)
  if (!items.length) return
  const upd = db.prepare('UPDATE goods SET stock=stock+? WHERE id=?')
  for (const it of items) upd.run(Number(it.quantity || 0), Number(it.goods_id))
  // 库存回补不影响已售标记（本单从未结算过销量）
}

module.exports = { settleSales, restoreStock }
