// order 域专属表：orders / order_items / refunds / cancel_requests / pay_notifications
// 本文件只写本域五张表；跨域读（delivery_tasks/delivery_batches/landmarks/shops/goods/users）
// 一律放在 service.js 里以只读方式出现（delivery 域未拆前先直接读，步骤 3 可改为调 delivery.service）。

module.exports = {
  // ---------- orders ----------
  findById: (store, id) => store.prepare('SELECT * FROM orders WHERE id=?').get(Number(id)),
  findByIdForUser: (store, id, userId) => store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(id), userId),
  listByUser: (store, userId, status) => {
    let sql = 'SELECT * FROM orders WHERE user_id=?'
    const args = [userId]
    if (status !== '' && status !== undefined) { sql += ' AND status=?'; args.push(Number(status)) }
    sql += ' ORDER BY id DESC'
    return store.prepare(sql).all(...args)
  },
  dailySeqCount: (store) => {
    const r = store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=date('now','localtime')").get()
    return Number(r && r.c || 0)
  },
  insert: (store, f) => {
    const info = store.prepare(`INSERT INTO orders
      (order_no, user_id, landmark_id, landmark_name, contact_name, contact_phone, total_amount, original_amount, discount_amount, activity_id, delivery_fee, status, remark, pickup_code, daily_seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`)
      .run(f.orderNo, f.userId, f.landmarkId, f.landmarkName, f.contactName, f.contactPhone, f.totalAmount, f.originalAmount, f.discountAmount, f.activityId, f.deliveryFee, f.remark, f.pickupCode, f.seq)
    return Number(info.lastInsertRowid)
  },
  // 模拟支付：直接置待接单(1)
  markPaidMock: (store, id) => store.prepare("UPDATE orders SET status=1, pay_channel='mock', updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),
  // 真实支付：先记渠道，回调到达后 CAS 0→1
  markPayChannel: (store, id, channel) => store.prepare("UPDATE orders SET pay_channel=?, updated_at=datetime('now','localtime') WHERE id=?").run(channel, Number(id)),
  markPaidNotify: (store, id, transactionId) => store.prepare("UPDATE orders SET status=1, transaction_id=?, updated_at=datetime('now','localtime') WHERE id=? AND status=0").run(transactionId || '', Number(id)),
  badgeCounts: (store, userId) => {
    const c = (sql) => { const r = store.prepare(sql).get(userId); return Number(r && r.c || 0) }
    return {
      active: c('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status IN (1,2,3)'),
      paying: c('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=0'),
      delivering: c('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=2'),
      arrived: c('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=3'),
      finished: c('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=4')
    }
  },
  setExceptionHandled: (store, id, text) => store.prepare("UPDATE orders SET exception_handled=? || datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?").run(text + ' ', id),
  countToday: (store) => { const r = store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=date('now','localtime')").get(); return Number(r.c || 0) },

  // ---------- order_items ----------
  insertItem: (store, f) => store.prepare('INSERT INTO order_items (order_id, goods_id, goods_name, goods_image, price, quantity) VALUES (?,?,?,?,?,?)')
    .run(f.orderId, f.goodsId, f.goodsName, f.goodsImage, f.price, f.quantity),
  itemsByOrder: (store, orderId) => store.prepare('SELECT * FROM order_items WHERE order_id=?').all(Number(orderId)),
  itemsBriefByOrder: (store, orderId) => store.prepare('SELECT id, goods_id, goods_name, goods_image, price, quantity FROM order_items WHERE order_id=?').all(Number(orderId)),

  // ---------- refunds ----------
  insertRefund: (store, f) => {
    const info = store.prepare('INSERT INTO refunds (order_id, user_id, type, reason, amount) VALUES (?,?,?,?,?)')
      .run(f.orderId, f.userId, f.type, f.reason, f.amount)
    return Number(info.lastInsertRowid)
  },
  insertAutoRefund: (store, f) => store.prepare("INSERT INTO refunds (order_id, user_id, type, reason, amount, status, merchant_reply, handled_at, wx_refund_no) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'),?)")
    .run(f.orderId, f.userId, 'refund', f.reason, f.amount, 3, f.reply, f.refundNo || ''),
  findRefundById: (store, id) => store.prepare('SELECT * FROM refunds WHERE id=?').get(Number(id)),
  pendingRefundByOrder: (store, orderId) => store.prepare('SELECT id FROM refunds WHERE order_id=? AND status=0').get(Number(orderId)),
  listRefundsByUser: (store, userId) => store.prepare('SELECT r.*, o.order_no FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.user_id=? ORDER BY r.id DESC').all(userId),
  listRefundsMerchant: (store, status) => {
    let sql = 'SELECT r.*, o.order_no, o.landmark_name FROM refunds r JOIN orders o ON o.id=r.order_id'
    const args = []
    if (status !== '' && status !== undefined) { sql += ' WHERE r.status=?'; args.push(Number(status)) }
    sql += ' ORDER BY (r.status=0) DESC, r.id DESC'
    return store.prepare(sql).all(...args)
  },
  refundMerchantDetail: (store, id) => store.prepare('SELECT r.*, o.order_no, o.landmark_name, o.total_amount FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.id=?').get(Number(id)),
  markRefunded: (store, id, amt, reply, refundNo) => store.prepare("UPDATE refunds SET status=3, amount=?, merchant_reply=?, handled_at=datetime('now','localtime'), wx_refund_no=? WHERE id=?")
    .run(amt, reply || '同意退款', refundNo || '', Number(id)),
  markRefundRejected: (store, id, reply) => store.prepare("UPDATE refunds SET status=2, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?").run(reply, Number(id)),
  markComplaintHandled: (store, id, reply) => store.prepare("UPDATE refunds SET status=4, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?").run(reply || '已处理', Number(id)),

  // ---------- cancel_requests ----------
  insertCancelRequest: (store, f) => {
    const info = store.prepare('INSERT INTO cancel_requests (order_id, user_id, reason) VALUES (?,?,?)').run(f.orderId, f.userId, f.reason || '')
    return Number(info.lastInsertRowid)
  },
  findCancelRequestById: (store, id) => store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(Number(id)),
  pendingCancelRequestByOrder: (store, orderId) => store.prepare('SELECT * FROM cancel_requests WHERE order_id=? AND status=0').get(Number(orderId)),
  listCancelRequestsByUser: (store, userId) => store.prepare('SELECT c.*, o.order_no FROM cancel_requests c JOIN orders o ON o.id=c.order_id WHERE c.user_id=? ORDER BY c.id DESC').all(userId),
  listCancelRequestsMerchant: (store, status) => {
    let sql = 'SELECT c.*, o.order_no, o.landmark_name FROM cancel_requests c JOIN orders o ON o.id=c.order_id'
    const args = []
    if (status !== '' && status !== undefined) { sql += ' WHERE c.status=?'; args.push(Number(status)) }
    sql += ' ORDER BY (c.status=0) DESC, c.id DESC'
    return store.prepare(sql).all(...args)
  },
  cancelRequestMerchantDetail: (store, id) => store.prepare('SELECT c.*, o.order_no, o.landmark_name, o.total_amount, o.status AS order_status FROM cancel_requests c JOIN orders o ON o.id=c.order_id WHERE c.id=?').get(Number(id)),
  approveCancelRequest: (store, id, reply) => store.prepare("UPDATE cancel_requests SET status=3, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=? AND status=0").run(reply || '同意取消', Number(id)),
  rejectCancelRequest: (store, id, reply) => store.prepare("UPDATE cancel_requests SET status=2, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=? AND status=0").run(reply, Number(id)),
  latestCancelRequestByOrder: (store, orderId) => store.prepare('SELECT * FROM cancel_requests WHERE order_id=? ORDER BY id DESC LIMIT 1').get(Number(orderId)),

  // ---------- pay_notifications ----------
  payNotifyExists: (store, eventId) => store.prepare('SELECT id FROM pay_notifications WHERE event_id=?').get(String(eventId || '')),
  payNotifyInsert: (store, f) => store.prepare("INSERT OR IGNORE INTO pay_notifications (event_id, out_trade_no, trade_state, amount_total, created_at) VALUES (?,?,?,?,datetime('now','localtime'))")
    .run(String(f.eventId || ''), f.outTradeNo, f.tradeState, Number(f.amountTotal || 0))
}
