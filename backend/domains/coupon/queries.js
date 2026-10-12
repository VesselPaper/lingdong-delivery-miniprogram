// coupon 域专属表：coupons（券模板）/ user_coupons（用户领券记录）
// 跨域只读：结算可用券需要商品的价格与分类（JOIN goods，只读；写权限仍只在 goods 域）

module.exports = {
  // ---------- 券模板（商家端管理） ----------
  listAll: (store) => store.prepare('SELECT * FROM coupons ORDER BY status DESC, id DESC').all(),
  listActive: (store) => store.prepare('SELECT * FROM coupons WHERE status=1 ORDER BY id DESC').all(),
  findById: (store, id) => store.prepare('SELECT * FROM coupons WHERE id=?').get(Number(id)),
  insert: (store, f) => {
    const info = store.prepare(`INSERT INTO coupons
      (title, type, threshold, reduce, discount, max_reduce, image, valid_type, start_at, end_at, relative_days,
       scope, scope_ids, total_qty, issued, per_user_limit, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      f.title, f.type, Number(f.threshold) || 0, Number(f.reduce) || 0, Number(f.discount) || 0,
      Number(f.max_reduce) || 0, f.image || '', f.valid_type, f.start_at || null, f.end_at || null,
      Number(f.relative_days) || 0, f.scope, String(f.scope_ids || '[]'), Number(f.total_qty) || 0,
      // 注意：不能写 `|| 1`——0 是「不限领」的合法取值，被吞掉就变成限领 1 张
      (f.per_user_limit === undefined || f.per_user_limit === null ? 1 : Number(f.per_user_limit) || 0),
      Number(f.status) === 0 ? 0 : 1
    )
    return Number(info.lastInsertRowid)
  },
  update: (store, id, f) => store.prepare(`UPDATE coupons SET
      title=?, type=?, threshold=?, reduce=?, discount=?, max_reduce=?, image=?, valid_type=?,
      start_at=?, end_at=?, relative_days=?, scope=?, scope_ids=?, total_qty=?, per_user_limit=?
      WHERE id=?`).run(
    f.title, f.type, Number(f.threshold) || 0, Number(f.reduce) || 0, Number(f.discount) || 0,
    Number(f.max_reduce) || 0, f.image || '', f.valid_type, f.start_at || null, f.end_at || null,
    Number(f.relative_days) || 0, f.scope, String(f.scope_ids || '[]'), Number(f.total_qty) || 0,
    Number(f.per_user_limit) || 1, Number(id)
  ),
  updateStatus: (store, id, status) => store.prepare('UPDATE coupons SET status=? WHERE id=?').run(Number(status) === 1 ? 1 : 0, Number(id)),
  remove: (store, id) => store.prepare('DELETE FROM coupons WHERE id=?').run(Number(id)),
  incIssued: (store, id) => store.prepare('UPDATE coupons SET issued=issued+1 WHERE id=?').run(Number(id)),

  // ---------- 用户券 ----------
  // 关联模板字段，让「我的券」一次取全（列表要展示面额/门槛/折扣）
  mine: (store, userId) => store.prepare(`
    SELECT uc.id, uc.coupon_id, uc.status, uc.received_at, uc.expire_at, uc.used_at, uc.order_id,
           c.title, c.type, c.threshold, c.reduce, c.discount, c.max_reduce, c.image,
           c.scope, c.scope_ids, c.status AS coupon_status
    FROM user_coupons uc LEFT JOIN coupons c ON uc.coupon_id = c.id
    WHERE uc.user_id=? ORDER BY uc.status ASC, uc.id DESC`).all(userId),
  findMine: (store, id, userId) => store.prepare('SELECT * FROM user_coupons WHERE id=? AND user_id=?').get(Number(id), userId),
  countMine: (store, userId, couponId) => store.prepare('SELECT COUNT(*) AS n FROM user_coupons WHERE user_id=? AND coupon_id=?').get(userId, Number(couponId)).n,
  receive: (store, userId, couponId, expireAt) => {
    const info = store.prepare('INSERT INTO user_coupons (user_id, coupon_id, status, expire_at) VALUES (?,?,0,?)')
      .run(userId, Number(couponId), expireAt || null)
    return Number(info.lastInsertRowid)
  },
  markUsed: (store, id, orderId) => store.prepare("UPDATE user_coupons SET status=1, used_at=datetime('now','localtime'), order_id=? WHERE id=? AND status=0").run(Number(orderId), Number(id)),
  // 把已过期的未使用券标记为已过期（读取时顺手同步，避免依赖定时任务）
  expireOutdated: (store, userId) => store.prepare(`
    UPDATE user_coupons SET status=2
    WHERE user_id=? AND status=0 AND expire_at IS NOT NULL AND expire_at < datetime('now','localtime')`).run(userId).changes,
  // 把券退回未使用（订单取消/退款时）
  release: (store, orderId) => store.prepare("UPDATE user_coupons SET status=0, used_at=NULL, order_id=NULL WHERE order_id=? AND status=1").run(Number(orderId)).changes,

  // 结算可用券：拿商品的价格与分类（跨域只读）
  findGoods: (store, id) => store.prepare('SELECT id, name, price, category, status FROM goods WHERE id=?').get(Number(id)),

  // 统计：某券已发多少（用于「剩余数量」展示）
  issuedOf: (store, couponId) => store.prepare('SELECT COUNT(*) AS n FROM user_coupons WHERE coupon_id=?').get(Number(couponId)).n
}
