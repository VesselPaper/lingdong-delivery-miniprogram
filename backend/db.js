// 数据库层：node:sqlite 初始化、建表、种子数据
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const fs = require('fs')

const DATA_DIR = path.join(__dirname, 'data')
// 数据库路径：默认 backend/data/lingdong.db；可用 LINGDONG_DB 覆盖（多实例/测试隔离用）
const DB_PATH = process.env.LINGDONG_DB ? path.resolve(process.env.LINGDONG_DB) : path.join(DATA_DIR, 'lingdong.db')

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT UNIQUE,
      nickname TEXT,
      avatar TEXT,
      phone TEXT,
      role TEXT DEFAULT 'student',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      contact_name TEXT,
      contact_phone TEXT,
      landmark_id TEXT,
      landmark_name TEXT,
      detail TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS landmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      building TEXT,
      floor TEXT,
      type TEXT DEFAULT 'deliverPoint',
      sort INTEGER DEFAULT 0,
      platform_building_id TEXT DEFAULT '',
      platform_map_id TEXT DEFAULT '',
      platform_landmark_id TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      price REAL,
      original_price REAL,
      image TEXT,
      category TEXT,
      stock INTEGER DEFAULT 999,
      status INTEGER DEFAULT 1,
      description TEXT,
      sales INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      goods_id INTEGER,
      quantity INTEGER DEFAULT 1,
      selected INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE,
      user_id INTEGER,
      landmark_id TEXT,
      landmark_name TEXT,
      contact_name TEXT,
      contact_phone TEXT,
      total_amount REAL,
      status INTEGER DEFAULT 0,
      remark TEXT,
      pickup_code TEXT,
      delivery_task_id INTEGER,
      batch_id INTEGER DEFAULT NULL,
      picked_up_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      goods_id INTEGER,
      goods_name TEXT,
      goods_image TEXT,
      price REAL,
      quantity INTEGER
    );
    CREATE TABLE IF NOT EXISTS delivery_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT UNIQUE,
      status INTEGER DEFAULT 0,
      status_text TEXT DEFAULT '组单中',
      device_sn TEXT DEFAULT '',
      loading_landmark_id TEXT DEFAULT '',
      route TEXT DEFAULT '[]',
      total_orders INTEGER DEFAULT 0,
      picked_orders INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      dispatched_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS delivery_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      batch_id INTEGER DEFAULT NULL,
      platform_task_id TEXT,
      device_sn TEXT,
      task_status INTEGER DEFAULT 0,
      status_text TEXT DEFAULT '排队中',
      position TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      business_status TEXT DEFAULT 'open',
      auto_accept INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      subtitle TEXT,
      image TEXT,
      link TEXT,
      status INTEGER DEFAULT 1,
      sort INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      user_id INTEGER,
      type TEXT DEFAULT 'refund',       -- refund 退款 / complaint 投诉
      reason TEXT,
      amount REAL DEFAULT 0,            -- 退款金额（商家同意时写入，默认订单全额）
      status INTEGER DEFAULT 0,         -- 0 待处理 / 2 已拒绝 / 3 已退款 / 4 已处理(投诉)
      merchant_reply TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      handled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cancel_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      user_id INTEGER,
      reason TEXT,
      status INTEGER DEFAULT 0,         -- 0 待处理 / 2 已拒绝 / 3 已同意取消
      merchant_reply TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      handled_at TEXT
    );
  `)
  migrate(db)
  seed(db)
  return db
}

// 轻量迁移：为已存在的旧表补充新增列
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(landmarks)').all().map((c) => c.name)
  const add = [
    ['platform_building_id', 'TEXT DEFAULT \'\''],
    ['platform_map_id', 'TEXT DEFAULT \'\''],
    ['platform_landmark_id', 'TEXT DEFAULT \'\''],
    ['pos_x', 'REAL DEFAULT 0'],
    ['pos_y', 'REAL DEFAULT 0']
  ]
  add.forEach(([name, def]) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE landmarks ADD COLUMN ${name} ${def}`)
    }
  })
  // orders：批次/取餐标记（一车多单）
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name)
  if (!orderCols.includes('batch_id')) db.exec("ALTER TABLE orders ADD COLUMN batch_id INTEGER DEFAULT NULL")
  if (!orderCols.includes('picked_up_at')) db.exec("ALTER TABLE orders ADD COLUMN picked_up_at TEXT")
  // orders：商品已售是否已结算（收货完成时已售+1/库存保留；取消退款时按此判断是否回补库存）
  if (!orderCols.includes('goods_settled')) db.exec("ALTER TABLE orders ADD COLUMN goods_settled INTEGER DEFAULT 0")
  // orders：当日序号（每天从 1 重置，商家端卡面展示「订单 N」，长编号只进详情页）
  if (!orderCols.includes('daily_seq')) db.exec("ALTER TABLE orders ADD COLUMN daily_seq INTEGER")
  // orders：配送异常处理标记（'' 未处理 / 'retry 时间' 已重新配送 / 'refund 时间' 已退款）
  if (!orderCols.includes('exception_handled')) db.exec("ALTER TABLE orders ADD COLUMN exception_handled TEXT DEFAULT ''")
  // delivery_batches：当日序号（商家端卡面展示「批次 N」）
  const batchCols = db.prepare('PRAGMA table_info(delivery_batches)').all().map((c) => c.name)
  if (!batchCols.includes('daily_seq')) db.exec("ALTER TABLE delivery_batches ADD COLUMN daily_seq INTEGER")
  // delivery_batches：已装商品件数（分批以「件」为容量单位，默认 12 件/车）
  if (!batchCols.includes('total_items')) db.exec("ALTER TABLE delivery_batches ADD COLUMN total_items INTEGER DEFAULT 0")
  // 历史数据回填：按创建日期逐日累计编号（id 即当日创建顺序）
  db.exec(`UPDATE delivery_batches SET daily_seq=(
    SELECT COUNT(*) FROM delivery_batches b2
    WHERE date(b2.created_at)=date(delivery_batches.created_at) AND b2.id <= delivery_batches.id)
    WHERE daily_seq IS NULL`)
  db.exec(`UPDATE orders SET daily_seq=(
    SELECT COUNT(*) FROM orders o2
    WHERE date(o2.created_at)=date(orders.created_at) AND o2.id <= orders.id)
    WHERE daily_seq IS NULL`)
  // delivery_tasks：批次归属
  const taskCols = db.prepare('PRAGMA table_info(delivery_tasks)').all().map((c) => c.name)
  if (!taskCols.includes('batch_id')) db.exec("ALTER TABLE delivery_tasks ADD COLUMN batch_id INTEGER DEFAULT NULL")
  // users：订单消息已读时间（我的页红点）
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  if (!userCols.includes('order_read_at')) db.exec("ALTER TABLE users ADD COLUMN order_read_at TEXT")
  // 历史数据修正：地址 landmark_id 若存成 "2.0" 这类数值文本，规范化为 "2"
  const addrRows = db.prepare('SELECT id, landmark_id FROM addresses').all()
  addrRows.forEach((r) => {
    const v = String(r.landmark_id || '')
    if (v.indexOf('.') > -1 && /^\d+(\.\d+)?$/.test(v)) {
      db.prepare('UPDATE addresses SET landmark_id=? WHERE id=?').run(String(Number(v)), r.id)
    }
  })

  // ---------- 取消 / 退款 / 召回 的显式标记列 ----------
  // 为什么要显式时间戳而不是比状态码大小：任务状态 110(取消) < 120(上货挂起)，数值比较判不出终态。
  // 缺这些标记时，取消订单后模拟器仍每 4s 推进（mockAdvance 无 clearTimeout），一条迟到的 70
  // 就能把已取消订单改回「已送达」并结算销量，goods_settled=1 会让库存回补永久锁死，
  // 用户随后能在取餐页真的开舱取走这单已退款的餐。
  if (!taskCols.includes('void_at')) db.exec("ALTER TABLE delivery_tasks ADD COLUMN void_at TEXT")
  // 召回结果：0 无需召回 / 1 已召回 / 2 召回失败待人工
  if (!taskCols.includes('recall_status')) db.exec("ALTER TABLE delivery_tasks ADD COLUMN recall_status INTEGER DEFAULT 0")
  if (!taskCols.includes('recall_error')) db.exec("ALTER TABLE delivery_tasks ADD COLUMN recall_error TEXT DEFAULT ''")
  if (!orderCols.includes('cancelled_at')) db.exec("ALTER TABLE orders ADD COLUMN cancelled_at TEXT")
  // 批次摘除与库存回补各自的幂等标记：同一订单会被「用户取消 / 平台推送 110 / 商家异常退款」
  // 多条路径处理，此前每条都会扣一次批次计数、补一次库存。
  if (!orderCols.includes('batch_removed_at')) db.exec("ALTER TABLE orders ADD COLUMN batch_removed_at TEXT")
  if (!orderCols.includes('stock_restored_at')) db.exec("ALTER TABLE orders ADD COLUMN stock_restored_at TEXT")
  // 支付渠道与微信流水号：退款时据此判断是否有真实资金流可退
  if (!orderCols.includes('pay_channel')) db.exec("ALTER TABLE orders ADD COLUMN pay_channel TEXT DEFAULT ''")
  if (!orderCols.includes('transaction_id')) db.exec("ALTER TABLE orders ADD COLUMN transaction_id TEXT DEFAULT ''")
  // 开舱留痕：单舱机型一车多单无物理隔离，取餐开舱必须可追溯
  if (!orderCols.includes('pickup_opened_at')) db.exec("ALTER TABLE orders ADD COLUMN pickup_opened_at TEXT")
  const refundCols = db.prepare('PRAGMA table_info(refunds)').all().map((c) => c.name)
  if (!refundCols.includes('wx_refund_no')) db.exec("ALTER TABLE refunds ADD COLUMN wx_refund_no TEXT DEFAULT ''")

  // 支付回调幂等表：微信对同一事件会重推，event_id 唯一约束即幂等键
  db.exec(`
    CREATE TABLE IF NOT EXISTS pay_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE,
      out_trade_no TEXT,
      trade_state TEXT,
      amount_total INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `)
  // 一次性迁移标记（避免每次启动重复执行不可逆的数据修正）
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `)

  // 一次性安全修正：存量 merchant 角色全部降回 student。
  // 这些角色是旧登录接口按客户端自报的 body.role 写入的，任何人都能自助成为商家，
  // 因此没有一个是可信的。修复后角色只能由 MERCHANT_INVITE_CODE 授予，
  // 真实商家在商家端登录页输入邀请码即可恢复。
  const resetDone = db.prepare("SELECT value FROM meta WHERE key='merchant_role_reset_at'").get()
  if (!resetDone) {
    const n = db.prepare("UPDATE users SET role='student' WHERE role='merchant'").run()
    db.prepare("INSERT INTO meta (key, value) VALUES ('merchant_role_reset_at', datetime('now','localtime'))").run()
    if (n.changes > 0) {
      console.log(`[db] 安全修正：${n.changes} 个自报的商家账号已降为学生，请用 MERCHANT_INVITE_CODE 重新登录商家端`)
    }
  }
}

function seed(db) {
  // 店铺状态（营业/自动接单）—— 单门店场景，id=1 为唯一门店
  // 放在 landmarks 提前返回之前，保证首次启动即创建
  const shopCount = db.prepare('SELECT COUNT(*) AS c FROM shops').get().c
  if (shopCount === 0) {
    db.prepare('INSERT INTO shops (name, business_status, auto_accept) VALUES (?,?,?)').run('零栋铺子', 'open', 0)
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM landmarks').get().c
  if (count > 0) return

  // 真实点位（四川师范大学成龙校区 · 正式环境，2026-08 与平台核对）：
  // 名称以平台 landmarkName 为准；platform_* 字段直接写入，保证新环境无需再手动同步。
  const BID = '1257237128126592_zcsdb3dd6396c824'
  const MID = '1257237128126592_zcsdb3dd6396c824_1d-1'
  const insLandmark = db.prepare('INSERT INTO landmarks (name, building, floor, type, sort, platform_building_id, platform_map_id, platform_landmark_id) VALUES (?,?,?,?,?,?,?,?)')
  ;[
    ['商铺上货', '四川师范大学成龙校区', '1', 'loadingPoint', 1, BID, MID, '71bb894d0f6548e98fa8580429307a10'],
    ['东苑1栋', '四川师范大学成龙校区', '1', 'deliverPoint', 2, BID, MID, '05f66b224f1148c78a5a1cb63b284702'],
    ['东苑2栋', '四川师范大学成龙校区', '1', 'deliverPoint', 3, BID, MID, '87987c7a7d7145b8ba43738b046f6668'],
    ['东苑3栋', '四川师范大学成龙校区', '1', 'deliverPoint', 4, BID, MID, 'eb064f9c5a8b4e3c906ca0008bf66395'],
    ['东苑4栋', '四川师范大学成龙校区', '1', 'deliverPoint', 5, BID, MID, 'b0de449f2ccd4f20a6ccb0e9397e73cb'],
    ['东苑5栋', '四川师范大学成龙校区', '1', 'deliverPoint', 6, BID, MID, '2da7414ef2ee405d9b613a620d08d5e0'],
    ['东苑7栋', '四川师范大学成龙校区', '1', 'deliverPoint', 7, BID, MID, 'fe0ad571bb124217ba16243cc38030a2'],
    ['东苑11栋', '四川师范大学成龙校区', '1', 'deliverPoint', 8, BID, MID, '183cd72d16a14903aba7601dda4b9224'],
    ['东苑12栋', '四川师范大学成龙校区', '1', 'deliverPoint', 9, BID, MID, '1dbf6004fab6426c8485a552169a2325'],
    ['东苑13栋', '四川师范大学成龙校区', '1', 'deliverPoint', 10, BID, MID, 'e82ce545658e415d92bfe45d96588e2e']
  ].forEach(r => insLandmark.run(...r))

  const insGoods = db.prepare('INSERT INTO goods (name, price, original_price, image, category, stock, description, sales) VALUES (?,?,?,?,?,?,?,?)')
  ;[
    ['零小栋热卤盲盒套餐（含卤串）', 10.9, 12.9, '', '热卤', 100, '卤味盲盒，含素菜、卤串、主食，随机搭配，惊喜开盒', 326],
    ['零小栋热卤精选套餐', 12.9, 15.9, '', '热卤', 100, '含素菜、荤菜、卤串、主食，可选米饭或粥', 412],
    ['招牌鸭脖（个）', 3.0, 4.0, '', '卤味', 200, '麻辣鲜香，追剧必点，单只装', 568],
    ['鸭爪（个）', 3.0, 4.0, '', '卤味', 200, '筋道入味，越啃越香', 487],
    ['鸭翅（个）', 3.0, 4.0, '', '卤味', 200, '香辣过瘾，卤制入味', 355],
    ['现卤素拼（份）', 5.0, 6.0, '', '热卤', 150, '莲藕、土豆、海带、豆皮四拼', 278],
    ['热奶茶（中杯）', 8.0, 10.0, '', '饮品', 300, '茶香浓郁，可做冷热', 621],
    ['柠檬茶（中杯）', 7.0, 9.0, '', '饮品', 300, '手打柠檬，清爽解腻', 534],
    ['冰美式（中杯）', 9.0, 12.0, '', '饮品', 200, '零栋 4A 咖啡，现磨出品', 198],
    ['君姐烤鱼单人餐', 18.8, 22.0, '', '套餐', 80, '黑豆花烤鱼单人份，配米饭', 145]
  ].forEach(r => insGoods.run(...r))

  // 不再写入演示账号：登录必须走真实微信 code2session（WX_APPID / WX_SECRET）
}

module.exports = { init, DB_PATH }
