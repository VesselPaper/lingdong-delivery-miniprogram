// goods 域专属表：goods / shops / activities
// 全部写操作只碰本域三张表。goodsStats（settleSales/restoreStock）归本域，但下单/结算入口在
// order/delivery 域逻辑里，由 goods.service 对外暴露（步骤 2/3 迁移时接入）。

module.exports = {
  // ---------- goods（公开） ----------
  categories: (store) => store.prepare('SELECT DISTINCT category FROM goods WHERE status=1 ORDER BY id').all().map((r) => r.category),
  list: (store, query) => {
    const { category = '', keyword = '' } = query || {}
    let sql = 'SELECT * FROM goods WHERE status=1'
    const args = []
    if (category) { sql += ' AND category=?'; args.push(category) }
    if (keyword) { sql += ' AND name LIKE ?'; args.push('%' + keyword + '%') }
    sql += ' ORDER BY sales DESC'
    return store.prepare(sql).all(...args)
  },
  findById: (store, id) => store.prepare('SELECT * FROM goods WHERE id=?').get(Number(id)),
  // 按条码精确查（扫码录入用）。空条码不参与查询：否则所有「没填条码的商品」会互相匹配上。
  findByBarcode: (store, code) => {
    const c = String(code === undefined || code === null ? '' : code).trim()
    if (!c) return undefined
    return store.prepare('SELECT * FROM goods WHERE barcode=?').get(c)
  },

  // ---------- goods（商家管理） ----------
  merchantList: (store) => store.prepare('SELECT * FROM goods ORDER BY id DESC').all(),
  merchantCategories: (store) => store.prepare("SELECT category FROM goods WHERE category != '' GROUP BY category ORDER BY MIN(id)").all().map((r) => r.category),
  updateStock: (store, id, stock) => store.prepare('UPDATE goods SET stock=? WHERE id=?').run(stock, Number(id)),
  insert: (store, f) => {
    const info = store.prepare('INSERT INTO goods (name, price, original_price, image, category, stock, description, barcode, unit) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(f.name, Number(f.price), Number(f.original_price || 0), f.image || '', f.category || '其他', f.stock, f.description || '', String(f.barcode || '').trim(), String(f.unit || '').trim())
    return Number(info.lastInsertRowid)
  },
  update: (store, id, f) => store.prepare('UPDATE goods SET name=?, price=?, original_price=?, image=?, category=?, stock=?, description=?, status=?, barcode=?, unit=? WHERE id=?')
    .run(f.name, Number(f.price), Number(f.original_price || 0), f.image || '', f.category || '其他', f.stock, f.description || '', f.status, String(f.barcode !== undefined ? f.barcode : '').trim(), String(f.unit !== undefined ? f.unit : '').trim(), Number(id)),
  updateStatus: (store, id, status) => store.prepare('UPDATE goods SET status=? WHERE id=?').run(Number(status), Number(id)),

  // 真删一行商品（商家端「删除商品」/运维清理用）。
  // 只删 goods：order_items 存的是下单时的快照（goods_name/goods_image/price 都在行内），历史订单
  // 照样显示明细；cart 的残留行不动 —— 用户端购物车按 g.status=1 过滤（LEFT JOIN 后为 NULL），
  // 残留行不会显示成空白条目，也进不了结算（下单前会再查商品是否存在）。
  deleteById: (store, id) => store.prepare('DELETE FROM goods WHERE id=?').run(Number(id)),

  // ---------- shops ----------
  getShop: (store) => store.prepare('SELECT * FROM shops WHERE id=1').get() || {},
  updateShop: (store, business_status, auto_accept, delivery_fee) => store.prepare(
    "UPDATE shops SET business_status=?, auto_accept=?, delivery_fee=?, updated_at=datetime('now','localtime') WHERE id=1").run(business_status, auto_accept, delivery_fee),

  // ---------- activities ----------
  listActivities: (store) => store.prepare('SELECT * FROM activities WHERE status=1 ORDER BY sort, id DESC').all(),
  merchantActivities: (store) => store.prepare('SELECT * FROM activities ORDER BY sort, id DESC').all(),
  findActivityById: (store, id) => store.prepare('SELECT * FROM activities WHERE id=?').get(Number(id)),
  // status 由调用方决定：0=草稿（保存但不上架）/ 1=已发布。此前这里硬编码 1，
  // 导致「保存」等于「上架」，商家无法先存草稿再发布。
  insertActivity: (store, f) => {
    const info = store.prepare('INSERT INTO activities (title, subtitle, image, link, status, sort, type, config, start_at, end_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(f.title, f.subtitle, f.image, f.link, Number(f.status) === 1 ? 1 : 0, Number(f.sort || 0), String(f.type || 'custom'), String(f.config || '{}'), f.start_at || null, f.end_at || null)
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
