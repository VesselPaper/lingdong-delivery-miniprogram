// 数据库层：node:sqlite 初始化、建表、种子数据
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const fs = require('fs')

const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'lingdong.db')

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
    CREATE TABLE IF NOT EXISTS delivery_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
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
    ['platform_landmark_id', 'TEXT DEFAULT \'\'']
  ]
  add.forEach(([name, def]) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE landmarks ADD COLUMN ${name} ${def}`)
    }
  })
  // 历史数据修正：地址 landmark_id 若存成 "2.0" 这类数值文本，规范化为 "2"
  const addrRows = db.prepare('SELECT id, landmark_id FROM addresses').all()
  addrRows.forEach((r) => {
    const v = String(r.landmark_id || '')
    if (v.indexOf('.') > -1 && /^\d+(\.\d+)?$/.test(v)) {
      db.prepare('UPDATE addresses SET landmark_id=? WHERE id=?').run(String(Number(v)), r.id)
    }
  })
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

  const insLandmark = db.prepare('INSERT INTO landmarks (name, building, floor, type, sort) VALUES (?,?,?,?,?)')
  ;[
    ['零栋铺子（取餐点）', '零栋', '1F', 'loadingPoint', 1],
    ['东苑 3 栋', '东苑', '1F', 'deliverPoint', 2],
    ['东苑 7 栋', '东苑', '1F', 'deliverPoint', 3],
    ['西苑 5 栋', '西苑', '1F', 'deliverPoint', 4],
    ['西苑 9 栋', '西苑', '1F', 'deliverPoint', 5],
    ['第一教学楼', '教学区', '1F', 'deliverPoint', 6],
    ['图书馆门口', '教学区', '1F', 'deliverPoint', 7]
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
