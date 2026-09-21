// user 域专属表：users / addresses / cart
// 例外：cartList JOIN goods 取商品展示字段（跨 goods 域**只读**，05 方案 §2 user 域清单已列明）；
// 其余写操作只碰本域三张表。跨域写（order 下单后删购物车）通过 user.service.removeCartItems 暴露给 order 域调用。

module.exports = {
  // ---------- users ----------
  findByOpenid: (store, openid) => store.prepare('SELECT * FROM users WHERE openid=?').get(openid),
  findById: (store, id) => store.prepare('SELECT * FROM users WHERE id=?').get(id),
  create: (store, openid, nickname, role) => {
    const info = store.prepare('INSERT INTO users (openid, nickname, role) VALUES (?,?,?)').run(openid, nickname, role)
    return Number(info.lastInsertRowid)
  },
  updateNickname: (store, id, nickname) => store.prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname, id),
  // 持正确邀请码的学生升级为商家
  upgradeToMerchant: (store, id) => store.prepare("UPDATE users SET role='merchant' WHERE id=?").run(id),
  // 逐字段更新：undefined/null 表示「本次不改这个字段」，避免只传昵称时把手机号清空
  updateProfile: (store, id, nickname, phone, avatar) => {
    if (nickname !== undefined && nickname !== null) {
      store.prepare('UPDATE users SET nickname=? WHERE id=?').run(String(nickname), id)
    }
    if (phone !== undefined && phone !== null) {
      store.prepare('UPDATE users SET phone=? WHERE id=?').run(String(phone), id)
    }
    if (avatar !== undefined && avatar !== null) {
      store.prepare('UPDATE users SET avatar=? WHERE id=?').run(String(avatar), id)
    }
  },
  // 当前配送楼栋：首页顶部 / 我的页收货地址 / 结算页楼栋 三处读写同一份，空串=未选择。
  // 不放在地址簿里是因为「没建过地址也要能选楼栋」，而地址簿是可选的联系人信息。
  updatePoint: (store, id, landmarkId, landmarkName) => store.prepare('UPDATE users SET landmark_id=?, landmark_name=? WHERE id=?')
    .run(String(landmarkId || ''), String(landmarkName || ''), id),

  // ---------- cart ----------
  // 列表 JOIN goods 取名称/价格/库存（跨域只读；写权限仍只在 cart 表）
  cartList: (store, userId) => store.prepare(`
    SELECT c.id, c.goods_id, c.quantity, c.selected, g.name, g.price, g.image, g.status AS goods_status, g.stock AS goods_stock
    FROM cart c LEFT JOIN goods g ON c.goods_id = g.id
    WHERE c.user_id=? ORDER BY c.id DESC`).all(userId),
  cartFind: (store, userId, goodsId) => store.prepare('SELECT * FROM cart WHERE user_id=? AND goods_id=?').get(userId, Number(goodsId)),
  cartAddQty: (store, id, qty) => store.prepare('UPDATE cart SET quantity=quantity+? WHERE id=?').run(Number(qty), id),
  cartInsert: (store, userId, goodsId, qty) => store.prepare('INSERT INTO cart (user_id, goods_id, quantity) VALUES (?,?,?)').run(userId, Number(goodsId), Number(qty)),
  cartUpdateQty: (store, id, qty, userId) => store.prepare('UPDATE cart SET quantity=? WHERE id=? AND user_id=?').run(Number(qty), Number(id), userId),
  cartUpdateSelected: (store, id, selected, userId) => store.prepare('UPDATE cart SET selected=? WHERE id=? AND user_id=?').run(selected ? 1 : 0, Number(id), userId),
  cartRemove: (store, id, userId) => store.prepare('DELETE FROM cart WHERE id=? AND user_id=?').run(Number(id), userId),
  // 下单成功后按商品删除购物车（order 域跨域调用 user.service 的入口；只删本次订单包含的商品，P1-6）
  removeCartItems: (store, userId, goodsIds) => {
    for (const gid of goodsIds) store.prepare('DELETE FROM cart WHERE user_id=? AND goods_id=?').run(userId, gid)
  },

  // ---------- addresses ----------
  addressList: (store, userId) => store.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC').all(userId),
  clearDefault: (store, userId) => store.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(userId),
  addressUpdate: (store, id, userId, f) => store.prepare(
    'UPDATE addresses SET contact_name=?, contact_phone=?, landmark_id=?, landmark_name=?, detail=?, is_default=? WHERE id=? AND user_id=?')
    .run(f.contact_name, f.contact_phone, f.lmId, f.landmark_name, f.detail || '', f.is_default ? 1 : 0, Number(id), userId),
  addressInsert: (store, userId, f) => store.prepare(
    'INSERT INTO addresses (user_id, contact_name, contact_phone, landmark_id, landmark_name, detail, is_default) VALUES (?,?,?,?,?,?,?)')
    .run(userId, f.contact_name, f.contact_phone, f.lmId, f.landmark_name, f.detail || '', f.is_default ? 1 : 0),
  addressDelete: (store, id, userId) => store.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(Number(id), userId)
}
