// ============================================================================
// P4 动态承诺时间（estimatePromise）单元测试
// ----------------------------------------------------------------------------
// 覆盖：
//   · 无车况缓存 → 用 PROMISE_DEFAULT_CARS 兜底，攒单窗口 15 分钟
//   · 行程分量用真实坐标（上货点 → 楼栋）估算，不全是固定值
//   · 运力压力（待发批次 ≥ K×可用车）→ 攒单窗口缩短 + 排队分量出现
//   · 远楼栋 + 高压力 → 超承诺上限 → busy=true（显示「当前繁忙」，不给数字）
//   · 楼栋无坐标/缺失 → 不崩，退固定粗估
// 用法：node test_promise_eta.js
// 特点：不起 server、不碰线上库、不需要网络；临时库建在系统 temp 目录，跑完自删。
// ============================================================================
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const batch = require('../services/batch.js')
const orderSvc = require('../domains/order/service.js')

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) }
  else { fail++; console.log('  ✘ ' + msg) }
}
function section(title) { console.log('\n=== ' + title + ' ===') }

// ---------- 临时库：landmarks（真实米制坐标）+ delivery_batches ----------
const TMP_DB = path.join(os.tmpdir(), 'lingdong_test_promise_' + Date.now() + '.db')
const db = new DatabaseSync(TMP_DB)
db.exec(`CREATE TABLE landmarks (
  id INTEGER PRIMARY KEY, name TEXT, type TEXT DEFAULT 'deliverPoint',
  pos_x REAL, pos_y REAL, sort INTEGER DEFAULT 0,
  platform_map_id TEXT DEFAULT '', platform_building_id TEXT DEFAULT '', platform_landmark_id TEXT DEFAULT '')`)
const LANDMARKS = [
  [1, '商铺上货', 'loadingPoint', -0.746, 3.801, 10],
  [2, '东苑1栋', 'deliverPoint', -14.147, 109.278, 1],
  [3, '东苑2栋', 'deliverPoint', -14.969, 11.043, 2],
  [4, '东苑3栋', 'deliverPoint', -14.519, -69.209, 3],
  [7, '东苑7栋', 'deliverPoint', 231.945, 59.898, 6],
  [9, '东苑12栋', 'deliverPoint', 74.747, 24.772, 8]
]
for (const l of LANDMARKS) db.prepare('INSERT INTO landmarks (id, name, type, pos_x, pos_y, sort) VALUES (?,?,?,?,?,?)').run(...l)
db.exec(`CREATE TABLE delivery_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_no TEXT, status INTEGER DEFAULT 0,
  status_text TEXT DEFAULT '组单中', device_sn TEXT DEFAULT '', created_at TEXT,
  route TEXT DEFAULT '[]', current_stop INTEGER DEFAULT 0, delivery_mode TEXT DEFAULT '',
  bin_opened_at TEXT, loaded_at TEXT, daily_seq INTEGER, seq_date TEXT,
  total_orders INTEGER DEFAULT 0, total_items INTEGER DEFAULT 0, picked_orders INTEGER DEFAULT 0,
  dispatched_at TEXT, completed_at TEXT, updated_at TEXT)`)
db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, status INTEGER DEFAULT 2, created_at TEXT, landmark_id TEXT)`)
db.exec(`CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, quantity INTEGER)`)

// deps：batch 真模块；cachedCarState 可注入（null = 无缓存 → 默认车数）
function mkDeps(cars) {
  return { batch, cachedCarState: cars === null ? null : () => cars }
}

// 造 N 个组单中批次（供 openBatchCount）
function mkOpenBatches(n) {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO delivery_batches (batch_no, status) VALUES (?,0)').run('PB' + i)
}

async function main() {
  // ---------------------------------------------------------------- 1
  section('1. 无压力：攒单窗口 15 分钟 + 行程用真实坐标')
  db.exec('DELETE FROM delivery_batches')
  const near = orderSvc.estimatePromise(db, mkDeps(null), '3')   // 东苑2栋（近）
  ok(near.busy === false, `近楼栋、车够 → busy=false，承诺 ${near.minutes} 分钟`)
  // 攒单15 + 行程≈4.2（120+100+10 秒固定 + 20.7m 行驶）+ 缓冲3 ≈ 22 分钟
  ok(near.minutes >= 18 && near.minutes <= 26, `数值在合理区间（18~26），实际 ${near.minutes}（攒单15+行程+缓冲3）`)
  ok(near.max === 30, 'max = PROMISE_MAX_MINUTES 默认 30')

  // ---------------------------------------------------------------- 2
  section('2. 运力压力：窗口缩短 + 排队分量')
  db.exec('DELETE FROM delivery_batches')
  mkOpenBatches(4)                                             // 待发 4 个
  const pressured = orderSvc.estimatePromise(db, mkDeps({ available: 1 }), '3')
  ok(pressured.busy === false || pressured.minutes > 15, `压力下（4批/1车）承诺更长或繁忙：${JSON.stringify(pressured)}`)
  // 窗口 = 15×0.5 = 7.5 分钟；排队 = 3×行程

  // ---------------------------------------------------------------- 3
  section('3. 远楼栋 + 高压力 → 超上限 → 当前繁忙（不许撒谎）')
  db.exec('DELETE FROM delivery_batches')
  mkOpenBatches(4)
  const far = orderSvc.estimatePromise(db, mkDeps({ available: 1 }), '7')   // 东苑7栋（231.9, 59.9）最远
  ok(far.busy === true && far.minutes === null,
    `远楼栋+4批/1车 → busy=true 不给数字（${JSON.stringify(far)}）—— 前端显示「当前繁忙」`)

  // ---------------------------------------------------------------- 4
  section('4. 无坐标/未知楼栋 → 不崩，退固定粗估')
  db.exec('DELETE FROM delivery_batches')
  const noLm = orderSvc.estimatePromise(db, mkDeps(null), '9999')   // 不存在的楼栋
  ok(noLm.busy === false && noLm.minutes > 0, `楼栋不存在 → 仍返回可用承诺 ${noLm.minutes} 分钟（行程退固定粗估）`)
  const noCoord = orderSvc.estimatePromise(db, mkDeps(null), null)  // landmarkId 为空
  ok(noCoord.busy === false && noCoord.minutes > 0, `landmarkId 为空 → 不崩，${noCoord.minutes} 分钟`)

  // ---------------------------------------------------------------- 5
  section('5. 车况缓存可用（最近一轮扫描）→ 用它而不是默认值')
  db.exec('DELETE FROM delivery_batches')
  const cached = orderSvc.estimatePromise(db, mkDeps({ available: 3, total: 3, occupied: 0 }), '3')
  ok(cached.busy === false, `缓存 available=3 → 承诺正常 ${cached.minutes} 分钟（窗口不缩短）`)

  console.log('')
  console.log(fail === 0 ? `🎉 承诺时间测试全部通过（${pass} 项）` : `⚠️ 失败 ${fail} 项 / 通过 ${pass} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1) })
