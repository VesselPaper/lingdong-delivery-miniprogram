// ============================================================================
// v2 组单算法 · 收口（不变量自检 + 防死锁）单元测试
// ----------------------------------------------------------------------------
// 覆盖：
//   结构不变量 —— 每个「组单中」批次都该满足：
//     · 件数 ≤ BATCH_MAX_ITEMS(12)                 → OVER_CAPACITY
//     · 多站时预计时长 ≤ V2.maxTripMin(15分钟)      → OVER_TRIP
//     · 单站例外（东苑7栋这种远点单独一批必须放行）
//     · 算不出站点                                  → NO_STOP
//     · 组单中却没有有效订单                        → EMPTY_BATCH
//   活性不变量 —— 每张没送完的订单最终必须发得出去：
//     · 没挂批次                                    → ORDER_NO_BATCH
//     · 挂的批次不存在                              → ORDER_BATCH_MISSING
//     · 批次已完成/已取消但订单还没送完              → ORDER_ORPHAN
//     · 在组单中批次里等超过硬上限还没发出           → ORDER_STUCK
//   防死锁三道网：
//     · 订单时间不可解析 → 当作已到点直接发（不能永远等）
//     · 到点但落在当前窗口【外】的批次照样发（否则会被饿死）
//     · 等待超过 BATCH_HARD_MAX_MS 的无条件发
//
// 用法：node test_batch_v2_invariants.js
// 特点：不起 server、不碰线上库、不依赖任何备份文件；自带 11 个真实坐标点位。
// ============================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const batch = require('./services/batch.js')

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) }
  else { fail++; console.log('  ✘ ' + msg) }
}
function section(title) { console.log('\n=== ' + title + ' ===') }

// ---------- 真实点位（米制坐标，来自平台 landInfo 同步结果）----------
const LANDMARKS = [
  [1, '商铺上货', 'loadingPoint', 17.566, 6.515, 11],
  [2, '东苑1栋', 'deliverPoint', -14.147, 109.278, 1],
  [3, '东苑2栋', 'deliverPoint', -14.969, 11.043, 2],
  [4, '东苑3栋', 'deliverPoint', -14.519, -69.209, 3],
  [5, '东苑4栋', 'deliverPoint', -14.908, -50.382, 4],
  [6, '东苑5栋', 'deliverPoint', -14.979, 37.814, 5],
  [7, '东苑7栋', 'deliverPoint', 231.945, 59.898, 6],
  [8, '东苑11栋', 'deliverPoint', 146.465, -56.382, 7],
  [9, '东苑12栋', 'deliverPoint', 74.747, 24.772, 8],
  [10, '东苑13栋', 'deliverPoint', 23.399, -107.831, 9],
  [11, '零栋库房', 'deliverPoint', 14.05, -3.317, 10]
]

const TMP_DB = path.join(os.tmpdir(), 'lingdong_test_v2inv_' + Date.now() + '.db')
const db = new DatabaseSync(TMP_DB)
db.exec(`CREATE TABLE landmarks (
  id INTEGER PRIMARY KEY, name TEXT, type TEXT DEFAULT 'deliverPoint',
  pos_x REAL, pos_y REAL, sort INTEGER DEFAULT 0)`)
for (const l of LANDMARKS) {
  db.prepare('INSERT INTO landmarks (id, name, type, pos_x, pos_y, sort) VALUES (?,?,?,?,?,?)').run(...l)
}
db.exec(`CREATE TABLE delivery_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_no TEXT, status INTEGER DEFAULT 0,
  status_text TEXT DEFAULT '组单中', device_sn TEXT DEFAULT '', created_at TEXT,
  dispatched_at TEXT, completed_at TEXT)`)
db.exec(`CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, batch_id INTEGER, status INTEGER DEFAULT 2,
  landmark_id TEXT, landmark_name TEXT, created_at TEXT)`)
db.exec(`CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, goods_id INTEGER, goods_name TEXT, price REAL, quantity INTEGER)`)

const LM = Object.fromEntries(LANDMARKS.map((l) => [l[1], l[0]]))
const p2 = (n) => String(n).padStart(2, '0')
function ago(min) {
  const d = new Date(Date.now() - min * 60000)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
let seq = 0
function mkOrder(lmName, qty, minAgo, status = 2, batchId = null, forcedCreatedAt = null) {
  const no = 'T' + (++seq)
  const info = db.prepare('INSERT INTO orders (order_no, landmark_id, landmark_name, status, batch_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(no, String(LM[lmName] || ''), lmName, status, batchId, forcedCreatedAt || ago(minAgo))
  const oid = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO order_items (order_id, goods_id, goods_name, price, quantity) VALUES (?,1,?,1,?)')
    .run(oid, '测试商品', qty)
  return oid
}
function mkBatch(minAgo, status = 0, forcedCreatedAt = null) {
  const info = db.prepare('INSERT INTO delivery_batches (batch_no, status, created_at) VALUES (?,?,?)')
    .run('TB' + (++seq), status, forcedCreatedAt || ago(minAgo))
  return Number(info.lastInsertRowid)
}
function clear() {
  db.exec('DELETE FROM delivery_batches')
  db.exec('DELETE FROM orders')
  db.exec('DELETE FROM order_items')
  batch.resetSituation()
  batch.V2.hysteresisMs = 0
}

function main() {
  // ---------------------------------------------------------------- 1
  section('1. 干净数据 → 没有问题')
  clear()
  let b = mkBatch(5); mkOrder('东苑5栋', 2, 5, 2, b)
  b = mkBatch(7); mkOrder('东苑2栋', 2, 7, 2, b)
  let inv = batch.checkInvariants(db)
  ok(inv.ok, `正常数据 → ok=${inv.ok}，问题 ${inv.violations.length} 处`)

  // ---------------------------------------------------------------- 2
  section('2. 结构不变量：件数 ≤ 12')
  clear()
  b = mkBatch(2)
  mkOrder('东苑5栋', 8, 2, 2, b)
  mkOrder('东苑2栋', 6, 1, 2, b)
  inv = batch.checkInvariants(db)
  const overCap = inv.violations.find((x) => x.type === 'OVER_CAPACITY')
  ok(!!overCap, `8 + 6 = 14 件 → ${overCap ? overCap.detail : '没检出'}`)

  // ---------------------------------------------------------------- 3
  section('3. 结构不变量：多站时每趟 ≤ 15 分钟')
  clear()
  b = mkBatch(2)
  mkOrder('东苑3栋', 2, 2, 2, b)
  mkOrder('东苑1栋', 2, 2, 2, b)
  mkOrder('东苑7栋', 2, 1, 2, b)   // 东苑7栋离上货点 220 米，是全场最远的
  inv = batch.checkInvariants(db)
  const overTrip = inv.violations.find((x) => x.type === 'OVER_TRIP')
  ok(!!overTrip, `东苑3栋 + 东苑1栋 + 东苑7栋 → ${overTrip ? overTrip.detail : '没检出'}`)

  // ---------------------------------------------------------------- 4
  section('4. 单站例外：最远的东苑7栋单独一批必须放行')
  clear()
  b = mkBatch(2); mkOrder('东苑7栋', 12, 2, 2, b)
  inv = batch.checkInvariants(db)
  ok(inv.ok, `东苑7栋单独一批（单站例外）→ ok=${inv.ok}${inv.ok ? '' : '，却报错：' + inv.violations.map((x) => x.type).join(',')}`)

  // ---------------------------------------------------------------- 5
  section('5. 结构不变量：组单中却没有有效订单')
  clear()
  mkBatch(5)
  inv = batch.checkInvariants(db)
  ok(inv.violations.some((x) => x.type === 'EMPTY_BATCH'), '组单中没订单的批次 → EMPTY_BATCH')

  // ---------------------------------------------------------------- 6-8
  section('6-8. 活性不变量：订单必须发得出去')
  clear()
  mkOrder('东苑5栋', 2, 3, 2, null)
  inv = batch.checkInvariants(db)
  ok(inv.violations.some((x) => x.type === 'ORDER_NO_BATCH'), '待接单/配送中的订单没挂任何批次 → ORDER_NO_BATCH')

  clear()
  mkOrder('东苑5栋', 2, 3, 2, 99999)
  inv = batch.checkInvariants(db)
  ok(inv.violations.some((x) => x.type === 'ORDER_BATCH_MISSING'), '挂到不存在的批次 → ORDER_BATCH_MISSING')

  clear()
  const doneBatch = mkBatch(30, 3)         // 批次已完成
  mkOrder('东苑5栋', 2, 3, 2, doneBatch)   // 但订单还没送完
  inv = batch.checkInvariants(db)
  const orph = inv.violations.find((x) => x.type === 'ORDER_ORPHAN')
  ok(!!orph, `订单没送完但批次已完成 → ${orph ? orph.detail : '没检出'}`)

  // ---------------------------------------------------------------- 9
  section('9. 活性不变量：等太久还没发出')
  clear()
  b = mkBatch(25); mkOrder('东苑5栋', 2, 25, 2, b)
  inv = batch.checkInvariants(db)
  const stuck = inv.violations.find((x) => x.type === 'ORDER_STUCK')
  ok(!!stuck, `等了 25 分钟（硬上限 ${(batch.V2.hardMaxMs / 60000).toFixed(0)} 分钟）→ ${stuck ? stuck.detail : '没检出'}`)

  // ---------------------------------------------------------------- 10
  section('10. 防死锁：订单时间不可解析 → 当作已到点直接发')
  clear()
  const badBatch = mkBatch(1, 0, '垃圾时间')                 // 批次 created_at 也是垃圾
  mkOrder('东苑5栋', 2, 1, 2, badBatch, '也是垃圾')          // 订单 created_at 也是垃圾
  const row = db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(badBatch)
  ok(batch.firstOrderAt(db, row) === null, 'firstOrderAt 返回 null（订单和批次时间都不可解析）')
  ok(batch.shouldAutoLockV2(db, row, 2) === true, '单批次判定 → true（宁可早发，也不能永远发不出去）')
  const plan10 = batch.planAutoLockV2(db, { cars: { available: 99 } })
  ok(plan10.includes(badBatch), `计划里包含它 → ${JSON.stringify(plan10)}`)

  // ---------------------------------------------------------------- 11
  section('11. ★ 防饿死：到点但落在当前窗口【外】的批次，必须照样发')
  clear()
  const X = mkBatch(40); mkOrder('东苑5栋', 2, 40, 2, X)  // 等了 40 分钟：它是窗口起点
  const Y = mkBatch(20); mkOrder('东苑2栋', 2, 20, 2, Y)  // 等了 20 分钟：自己早到点了，但落在窗口外
  const plan11 = batch.planAutoLockV2(db, { cars: { available: 1 } })
  console.log('     窗口起点 = X 的锚点（40分钟前），窗口 = [T-40, T-25)')
  console.log('     Y 的锚点 = T-20，落在窗口外，但它自己已经等 20 分钟 → 早就到点了')
  ok(plan11.includes(X) && plan11.includes(Y),
    `X 和 Y 都被锁 → ${JSON.stringify(plan11)}（只按窗口选会漏掉 Y，Y 就被饿死）`)

  // ---------------------------------------------------------------- 12
  section('12. 情况2 正常扫窗口：窗口内还没到点的也一起走')
  clear()
  const W20 = mkBatch(20); mkOrder('东苑5栋', 2, 20, 2, W20)
  const W12 = mkBatch(12); mkOrder('东苑2栋', 2, 12, 2, W12)
  const W3 = mkBatch(3); mkOrder('东苑3栋', 2, 3, 2, W3)
  const plan12 = batch.planAutoLockV2(db, { cars: { available: 1 } })
  ok(plan12.includes(W20) && plan12.includes(W12) && !plan12.includes(W3),
    `20分（到点）+ 12分（窗口内未到点）一起走，3分的等下一轮 → ${JSON.stringify(plan12)}`)

  // ---------------------------------------------------------------- 13
  section('13. 一次巡检能报出全部卡住的订单')
  clear()
  b = mkBatch(30); mkOrder('东苑5栋', 2, 30, 2, b)
  b = mkBatch(22); mkOrder('东苑2栋', 2, 22, 2, b)
  inv = batch.checkInvariants(db)
  console.log(`     ok=${inv.ok}，问题 ${inv.violations.length} 处`)
  for (const v of inv.violations) console.log(`       · [${v.type}] ${v.detail}`)
  ok(inv.violations.filter((x) => x.type === 'ORDER_STUCK').length === 2, '两个卡住的订单都被报出来')

  console.log('')
  console.log(fail === 0 ? `🎉 全部通过（${pass} 项）` : `⚠️ 失败 ${fail} 项 / 通过 ${pass} 项`)
}

try { main() } catch (e) { console.error('测试异常：', e); fail++ }
try { db.close() } catch (e) { /* 忽略 */ }
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
  try { fs.unlinkSync(f) } catch (e) { /* 不存在就算了 */ }
}
process.exit(fail === 0 ? 0 : 1)
