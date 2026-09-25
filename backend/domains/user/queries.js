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
  // 持正确邀请码的学生升级为商家（邀请码机制已退役，2026-09-24 起不再调用，保留防误删）
  upgradeToMerchant: (store, id) => store.prepare("UPDATE users SET role='merchant' WHERE id=?").run(id),

  // ---------- 商家账号体系（2026-09-24 起：账号密码登录 + 店主/店员分级） ----------
  // users 表仍是单一用户表：openid 用户（微信登录）与 username 商家账号共存；
  // 商家账号 = username 非空 + role='merchant'，token 为登录签发的随机串（可吊销）。
  findByUsername: (store, username) => store.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim()),
  setToken: (store, id, token) => store.prepare('UPDATE users SET token=? WHERE id=?').run(String(token), Number(id)),
  clearToken: (store, id) => store.prepare('UPDATE users SET token=NULL WHERE id=?').run(Number(id)),
  // 商家账号列表（管理员网页「商家管理」）：只出管理字段，绝不返回密码/token
  // 排序：店主在前、店员在后；同角色内启用在前、新创建在前
  merchantList: (store) => store.prepare(
    `SELECT id, username, nickname, merchant_role, status, created_at
     FROM users WHERE role='merchant' AND username IS NOT NULL AND username!=''
     ORDER BY (merchant_role='owner') DESC, status DESC, id DESC`).all(),
  createMerchantAccount: (store, { username, passwordHash, nickname = '', merchantRole = 'staff' }) => {
    const info = store.prepare(
      `INSERT INTO users (username, password_hash, role, merchant_role, nickname)
       VALUES (?,?,'merchant',?,?)`)
      .run(String(username), String(passwordHash), merchantRole === 'owner' ? 'owner' : 'staff', String(nickname || '').slice(0, 50))
    return Number(info.lastInsertRowid)
  },
  updateMerchantRole: (store, id, role) => store.prepare(
    "UPDATE users SET merchant_role=? WHERE id=? AND role='merchant' AND username IS NOT NULL AND username!=''")
    .run(role === 'owner' ? 'owner' : 'staff', Number(id)),
  // 重置密码：同时吊销当前 token，强制用新密码重新登录
  updateMerchantPassword: (store, id, hash) => store.prepare(
    'UPDATE users SET password_hash=?, token=NULL WHERE id=?').run(String(hash), Number(id)),
  // 禁用/启用：禁用同时吊销 token
  setMerchantStatus: (store, id, status) => store.prepare(
    'UPDATE users SET status=?, token=NULL WHERE id=?').run(status ? 1 : 0, Number(id)),
  // 修改商家用户名（管理员「编辑」）：只改登录名，不碰密码/权限/状态
  updateMerchantUsername: (store, id, username) => store.prepare(
    "UPDATE users SET username=? WHERE id=? AND role='merchant' AND username IS NOT NULL AND username!=''")
    .run(String(username), Number(id)),
  // 删除商家账号：物理删除（历史订单不受影响，商家账号只是登录身份），同时吊销 token
  deleteMerchant: (store, id) => store.prepare(
    "DELETE FROM users WHERE id=? AND role='merchant' AND username IS NOT NULL AND username!=''").run(Number(id)),

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
