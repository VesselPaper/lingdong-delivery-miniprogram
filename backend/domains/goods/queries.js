// goods 域专属表：goods / shops / activities
// 全部写操作只碰本域三张表。goodsStats（settleSales/restoreStock）归本域，但下单/结算入口在
// order/delivery 域逻辑里，由 goods.service 对外暴露（步骤 2/3 迁移时接入）。
//
// 多店铺（2026-10-23）：goods / activities 都带 shop_id。
//   · 用户端（公开）查询：按传入店铺过滤；不传就是 1 号店（老接口行为不变）
//   · 商家端（管理）查询：一律按 req.shopId 过滤，绝不返回全表 —— 否则就是「B 店能改 A 店商品」
//   · 活动/券的 shop_id=0 表示「平台级」，对全部店铺可见（一期不用，先留语义，避免以后再加一列）

const shopSvc = require('../../services/shops')

const sid = (v) => shopSvc.normalizeShopId(v)

module.exports = {
  // ---------- goods（公开） ----------
  categories: (store, shopId) => store.prepare('SELECT DISTINCT category FROM goods WHERE status=1 AND shop_id=? ORDER BY id')
    .all(sid(shopId)).map((r) => r.category),
  list: (store, query, shopId) => {
    const { category = '', keyword = '' } = query || {}
    let sql = 'SELECT * FROM goods WHERE status=1 AND shop_id=?'
    const args = [sid(shopId)]
    if (category) { sql += ' AND category=?'; args.push(category) }
    if (keyword) { sql += ' AND name LIKE ?'; args.push('%' + keyword + '%') }
    sql += ' ORDER BY sales DESC'
    return store.prepare(sql).all(...args)
  },
  // shopId 传了就只在该店范围内找（商家端编辑/删除必须先过这一关），不传按 id 全局找（历史调用方/跨域）
  findById: (store, id, shopId) => {
    if (shopId === undefined || shopId === null || shopId === '') {
      return store.prepare('SELECT * FROM goods WHERE id=?').get(Number(id))
    }
    return store.prepare('SELECT * FROM goods WHERE id=? AND shop_id=?').get(Number(id), sid(shopId))
  },
  // 按条码精确查（扫码录入用）。空条码不参与查询：否则所有「没填条码的商品」会互相匹配上。
  // 多店铺后条码唯一性是「一店一条码」，所以查询也必须带店铺，否则会扫到别家店的商品。
  findByBarcode: (store, code, shopId) => {
    const c = String(code === undefined || code === null ? '' : code).trim()
    if (!c) return undefined
    return store.prepare('SELECT * FROM goods WHERE barcode=? AND shop_id=?').get(c, sid(shopId))
  },

  // ---------- goods（商家管理） ----------
  merchantList: (store, shopId) => store.prepare('SELECT * FROM goods WHERE shop_id=? ORDER BY id DESC').all(sid(shopId)),
  merchantCategories: (store, shopId) => store.prepare("SELECT category FROM goods WHERE shop_id=? AND category != '' GROUP BY category ORDER BY MIN(id)")
    .all(sid(shopId)).map((r) => r.category),
  updateStock: (store, id, stock, shopId) => store.prepare('UPDATE goods SET stock=? WHERE id=? AND shop_id=?')
    .run(Number(stock), Number(id), sid(shopId)).changes,
  insert: (store, f) => {
    const info = store.prepare('INSERT INTO goods (shop_id, name, price, original_price, image, category, stock, description, barcode, unit) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(sid(f.shop_id), f.name, Number(f.price), Number(f.original_price || 0), f.image || '', f.category || '其他', f.stock, f.description || '', String(f.barcode || '').trim(), String(f.unit || '').trim())
    return Number(info.lastInsertRowid)
  },
  update: (store, id, f, shopId) => store.prepare('UPDATE goods SET name=?, price=?, original_price=?, image=?, category=?, stock=?, description=?, status=?, barcode=?, unit=? WHERE id=? AND shop_id=?')
    .run(f.name, Number(f.price), Number(f.original_price || 0), f.image || '', f.category || '其他', f.stock, f.description || '', f.status, String(f.barcode !== undefined ? f.barcode : '').trim(), String(f.unit !== undefined ? f.unit : '').trim(), Number(id), sid(shopId)).changes,
  updateStatus: (store, id, status, shopId) => store.prepare('UPDATE goods SET status=? WHERE id=? AND shop_id=?')
    .run(Number(status), Number(id), sid(shopId)).changes,

  // 真删一行商品（商家端「删除商品」/运维清理用）。
  // 只删 goods：order_items 存的是下单时的快照（goods_name/goods_image/price 都在行内），历史订单
  // 照样显示明细；cart 的残留行不动 —— 用户端购物车按 g.status=1 过滤（LEFT JOIN 后为 NULL），
  // 残留行不会显示成空白条目，也进不了结算（下单前会再查商品是否存在）。
  deleteById: (store, id, shopId) => store.prepare('DELETE FROM goods WHERE id=? AND shop_id=?')
    .run(Number(id), sid(shopId)).changes,

  // ---------- shops ----------
  getShop: (store, shopId) => store.prepare('SELECT * FROM shops WHERE id=?').get(sid(shopId)) || {},
  // 店铺设置整行更新：未传的可选字段由调用方从当前行带入（见 routes 里的 PUT /merchant/shop）
  updateShop: (store, shopId, business_status, auto_accept, delivery_fee, f) => {
    const x = f || {}
    return store.prepare(`UPDATE shops SET business_status=?, auto_accept=?, delivery_fee=?,
        code=?, logo=?, category=?, address=?, pickup_landmark_id=?, min_order=?, pack_fee=?,
        updated_at=datetime('now','localtime') WHERE id=?`).run(
      business_status, auto_accept, delivery_fee,
      String(x.code || ''),
      String(x.logo || ''),
      String(x.category || ''),
      String(x.address || ''),
      String(x.pickup_landmark_id || ''),
      Number(x.min_order || 0),
      Number(x.pack_fee || 0),
      sid(shopId)
    ).changes
  },

  // ---------- activities ----------
  // 公开：本店活动 + 平台级活动（shop_id=0）
  listActivities: (store, shopId) => store.prepare('SELECT * FROM activities WHERE status=1 AND shop_id IN (0,?) ORDER BY sort, id DESC')
    .all(sid(shopId)),
  merchantActivities: (store, shopId) => store.prepare('SELECT * FROM activities WHERE shop_id IN (0,?) ORDER BY sort, id DESC')
    .all(sid(shopId)),
  findActivityById: (store, id) => store.prepare('SELECT * FROM activities WHERE id=?').get(Number(id)),
  // status 由调用方决定：0=草稿（保存但不上架）/ 1=已发布。此前这里硬编码 1，
  // 导致「保存」等于「上架」，商家无法先存草稿再发布。
  insertActivity: (store, f) => {
    const info = store.prepare('INSERT INTO activities (shop_id, title, subtitle, image, link, status, sort, type, config, start_at, end_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(sid(f.shop_id), f.title, f.subtitle, f.image, f.link, Number(f.status) === 1 ? 1 : 0, Number(f.sort || 0), String(f.type || 'custom'), String(f.config || '{}'), f.start_at || null, f.end_at || null)
    return Number(info.lastInsertRowid)
  },
  updateActivity: (store, id, f) => store.prepare('UPDATE activities SET title=?, subtitle=?, image=?, link=?, sort=?, type=?, config=?, start_at=?, end_at=? WHERE id=?')
    .run(
      f.title !== undefined ? f.title : f.cur.title,
      f.subtitle !== undefined ? f.subtitle : f.cur.subtitle,
      f.image !== undefined ? f.image : f.cur.image,
      f.link !== undefined ? f.link : f.cur.link,
      f.sort !== undefined ? Number(f.sort) : f.cur.sort,
      f.type !== undefined ? String(f.type) : String(f.cur.type || 'custom'),
      f.config !== undefined ? (typeof f.config === 'string' ? f.config : JSON.stringify(f.config || {})) : String(f.cur.config || '{}'),
      f.start_at !== undefined ? (f.start_at || null) : (f.cur.start_at || null),
      f.end_at !== undefined ? (f.end_at || null) : (f.cur.end_at || null),
      Number(id)
    ),
  updateActivityStatus: (store, id, status) => store.prepare('UPDATE activities SET status=? WHERE id=?').run(Number(status), Number(id)),
  deleteActivity: (store, id) => store.prepare('DELETE FROM activities WHERE id=?').run(Number(id))
}

// ── 活动状态的唯一权威规则（保存/发布/下线都走这里，避免各处各判一套）──
// activities.status 三态：
//   0 = 草稿   只存在商家端，用户端活动页看不到，也不参与折扣/满减计价
//   1 = 已发布 用户端可见 + 参与计价（listActivities / promotion.loadActive 都按 status=1 取）
//   2 = 已下线 发布过又下线，同样对用户端不可见
// 注意：0 专指「从未发布过」，与 2「发布过又下线」在列表上要显示成不同标签。
//
// action 语义（关键：防止越权发布与误下线）：
//   draft   保存草稿：草稿仍为草稿；已发布/已下线的活动保持原状态不变
//           —— 否则商家改一下文案点「保存」就把线上活动悄悄下线了。
//   publish 发布：置 1，用于草稿发布、以及已下线活动重新上架
//   offline 下线：置 2，对用户端隐藏；此后重新发布时仍能正确显示「已下线」
function resolveActivityStatus(action, curStatus) {
  const cur = Number(curStatus)
  if (action === 'publish') return { status: 1 }
  if (action === 'offline') return { status: 2 }
  if (action === 'draft') return { status: cur === 1 || cur === 2 ? cur : 0 }
  return { error: { status: 400, msg: '未知的活动状态操作：' + action } }
}

module.exports.resolveActivityStatus = resolveActivityStatus
