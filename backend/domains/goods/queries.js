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

  // ---------- goods（商家管理） ----------
  merchantList: (store) => store.prepare('SELECT * FROM goods ORDER BY id DESC').all(),
  merchantCategories: (store) => store.prepare("SELECT category FROM goods WHERE category != '' GROUP BY category ORDER BY MIN(id)").all().map((r) => r.category),
  updateStock: (store, id, stock) => store.prepare('UPDATE goods SET stock=? WHERE id=?').run(stock, Number(id)),
  insert: (store, f) => {
    const info = store.prepare('INSERT INTO goods (name, price, original_price, image, category, stock, description) VALUES (?,?,?,?,?,?,?)')
      .run(f.name, Number(f.price), Number(f.original_price || 0), f.image || '', f.category || '其他', f.stock, f.description || '')
    return Number(info.lastInsertRowid)
  },
  update: (store, id, f) => store.prepare('UPDATE goods SET name=?, price=?, original_price=?, image=?, category=?, stock=?, description=?, status=? WHERE id=?')
    .run(f.name, Number(f.price), Number(f.original_price || 0), f.image || '', f.category || '其他', f.stock, f.description || '', f.status, Number(id)),
  updateStatus: (store, id, status) => store.prepare('UPDATE goods SET status=? WHERE id=?').run(Number(status), Number(id)),

  // ---------- shops ----------
  getShop: (store) => store.prepare('SELECT * FROM shops WHERE id=1').get() || {},
  updateShop: (store, business_status, auto_accept) => store.prepare(
    "UPDATE shops SET business_status=?, auto_accept=?, updated_at=datetime('now','localtime') WHERE id=1").run(business_status, auto_accept),

  // ---------- activities ----------
  listActivities: (store) => store.prepare('SELECT * FROM activities WHERE status=1 ORDER BY sort, id DESC').all(),
  merchantActivities: (store) => store.prepare('SELECT * FROM activities ORDER BY sort, id DESC').all(),
  findActivityById: (store, id) => store.prepare('SELECT * FROM activities WHERE id=?').get(Number(id)),
  insertActivity: (store, f) => {
    const info = store.prepare('INSERT INTO activities (title, subtitle, image, link, status, sort, type, config, start_at, end_at) VALUES (?,?,?,?,1,?,?,?,?,?)')
      .run(f.title, f.subtitle, f.image, f.link, Number(f.sort || 0), String(f.type || 'custom'), String(f.config || '{}'), f.start_at || null, f.end_at || null)
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
