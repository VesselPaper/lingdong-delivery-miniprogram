// ============================================================================
// 「提前提醒」单元测试（orderAhead）
// ----------------------------------------------------------------------------
// 这个功能决定用户在追踪页上看到什么、什么时候该下楼，算错会直接误导用户，
// 所以这里不只测「有没有返回」，而是把 ETA 公式手算一遍逐项对齐。
//
// 覆盖：
//   · 批次还没定型(组单中/待上货) → waiting，不给站数
//   · 车还没出发（没有任何任务进入 60+）→ 当前站 = 0，还能看到全程 ETA
//   · 车逐站推进 → 当前站 1→2→3，剩余站数 3→2→1→0，ETA 单调递减
//   · 到站（cur ≥ 我这站）→ arriving，文案变为「已到达您楼下」
//   · 中途站的「停靠+等用户+开舱」必须计入 ETA（少算会让用户下楼太晚）
//   · 提前提醒阈值：ahead ≤ ADVANCE_STOPS 才提示准备下楼
//   · 路线数据缺失（老数据 / 演示档被 mock 自动送达）→ 按 landmark_id 回退分组
//   · 批次已完成 / 无批次 / 订单点位不在路线里 → 兜底不报错
//
// 用法：node test_order_ahead.js
// 特点：不起 server、不碰线上库；临时库自带真实坐标，跑完自删。
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
function near(a, b, tol, msg) { ok(Math.abs(Number(a) - Number(b)) <= tol, msg + `（实际 ${a}，期望 ≈${b}）`) }
function section(t) { console.log('\n=== ' + t + ' ===') }

// 真实坐标（与平台 landInfo 同步结果一致）
const LANDMARKS = [
  [1, '商铺上货', 'loadingPoint', 17.566, 6.515, 11],
  [3, '东苑2栋', 'deliverPoint', -14.969, 11.043, 2],
  [6, '东苑5栋', 'deliverPoint', -14.979, 37.814, 5],
  [7, '东苑7栋', 'deliverPoint', 231.945, 59.898, 6]
]

const TMP_DB = path.join(os.tmpdir(), 'lingdong_test_ahead_' + Date.now() + '.db')
const db = new DatabaseSync(TMP_DB)
db.exec(`CREATE TABLE landmarks (id INTEGER PRIMARY KEY, name TEXT, type TEXT DEFAULT 'deliverPoint',
  pos_x REAL, pos_y REAL, sort INTEGER DEFAULT 0)`)
for (const l of LANDMARKS) db.prepare('INSERT INTO landmarks (id,name,type,pos_x,pos_y,sort) VALUES (?,?,?,?,?,?)').run(...l)
db.exec(`CREATE TABLE delivery_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_no TEXT,
  status INTEGER DEFAULT 0, status_text TEXT DEFAULT '组单中', route TEXT DEFAULT '[]',
  device_sn TEXT DEFAULT '', created_at TEXT, dispatched_at TEXT)`)
db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, batch_id INTEGER,
  status INTEGER DEFAULT 2, landmark_id TEXT, landmark_name TEXT, created_at TEXT)`)
db.exec(`CREATE TABLE delivery_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER,
  batch_id INTEGER, task_status INTEGER DEFAULT 0, status_text TEXT DEFAULT '', void_at TEXT)`)
db.exec(`CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, quantity INTEGER)`)

// 一个 3 站的批次：东苑2栋(2单) → 东苑5栋(1单) → 东苑7栋(1单)
const ROUTE = [
  { stop: 1, landmark_id: '3', landmark_name: '东苑2栋', order_ids: [1, 2] },
  { stop: 2, landmark_id: '6', landmark_name: '东苑5栋', order_ids: [3] },
  { stop: 3, landmark_id: '7', landmark_name: '东苑7栋', order_ids: [4] }
]
function seed() {
  db.exec('DELETE FROM delivery_batches'); db.exec('DELETE FROM orders')
  db.exec('DELETE FROM delivery_tasks'); db.exec('DELETE FROM order_items')
  db.prepare("INSERT INTO delivery_batches (id,batch_no,status,route) VALUES (1,'TB1',2,?)")
    .run(JSON.stringify(ROUTE))
  const mk = db.prepare("INSERT INTO orders (id,order_no,batch_id,status,landmark_id,landmark_name) VALUES (?,?,1,2,?,?)")
  mk.run(1, 'O1', '3', '东苑2栋'); mk.run(2, 'O2', '3', '东苑2栋')
  mk.run(3, 'O3', '6', '东苑5栋'); mk.run(4, 'O4', '7', '东苑7栋')
  const mt = db.prepare('INSERT INTO delivery_tasks (order_id,batch_id,task_status) VALUES (?,1,?)')
  mt.run(1, 50); mt.run(2, 50); mt.run(3, 50); mt.run(4, 50)
}
// 把某栋楼所有任务置为某状态（模拟车走到哪了）
function setStatus(lmId, st) {
  const rows = db.prepare('SELECT id FROM orders WHERE landmark_id=?').all(String(lmId))
  for (const r of rows) db.prepare('UPDATE delivery_tasks SET task_status=? WHERE order_id=?').run(st, r.id)
}
const order4 = () => db.prepare('SELECT * FROM orders WHERE id=4').get()

function main() {
  console.log('提前提醒阈值 ADVANCE_STOPS = ' + batch.ADVANCE_STOPS)

  // ---------------------------------------------------------------- 1
  section('1. 批次还没定型 → waiting，不给站数')
  seed()
  db.prepare('UPDATE delivery_batches SET status=0 WHERE id=1').run()
  let a = batch.orderAhead(db, order4())
  ok(a.state === 'waiting', `组单中 → state=${a.state}，文案「${a.text}」`)
  ok(a.stops_ahead === null && a.prepare === false, '不给站数、不提示下楼')
  db.prepare('UPDATE delivery_batches SET status=1 WHERE id=1').run()
  a = batch.orderAhead(db, order4())
  ok(a.state === 'waiting' && /上货/.test(a.text), `待上货 → state=${a.state}，文案「${a.text}」`)

  // ---------------------------------------------------------------- 2
  section('2. 车还没出发 → 当前站 0，看到全程 ETA（手算对齐）')
  seed()
  a = batch.orderAhead(db, order4())
  console.log(`     我的站号=${a.my_stop} 当前站=${a.current_stop} 还有=${a.stops_ahead} 站 ETA=${a.eta_min} 分`)
  // 手算：上货→东苑2栋 32.85m →东苑5栋 26.77m →东苑7栋 247.91m = 307.53m
  //       ×1.3 绕行 = 399.79m ÷60 = 6.663 分
  //       中途 2 站：(30+70+2×10) + (30+70+1×10) = 120 + 110 = 230 秒 = 3.833 分
  //       合计 10.497 分
  ok(a.state === 'approaching', `state=${a.state}`)
  ok(a.current_stop === 0, '当前站 = 0（车还没动）')
  ok(a.my_stop === 3 && a.stops_ahead === 3, '我在第 3 站，还有 3 站')
  near(a.eta_min, 10.5, 0.1, 'ETA 含行驶 + 中途两站的停靠等时')
  ok(a.prepare === false, `还有 3 站 > 阈值 ${batch.ADVANCE_STOPS} → 先不打扰用户`)

  // ---------------------------------------------------------------- 3
  section('3. 车推进 → 剩余站数与 ETA 单调递减')
  setStatus(3, 70)   // 东苑2栋 已到达
  a = batch.orderAhead(db, order4())
  console.log(`     当前站=${a.current_stop} 还有=${a.stops_ahead} 站 ETA=${a.eta_min} 分  prepare=${a.prepare}`)
  ok(a.current_stop === 1, '当前站推进到 1')
  ok(a.stops_ahead === 2, '还有 2 站')
  near(a.eta_min, 7.8, 0.1, 'ETA 去掉已走完的一段 + 去掉东苑2栋的停靠')
  ok(a.prepare === true, `还有 2 站 ≤ 阈值 ${batch.ADVANCE_STOPS} → 提示准备下楼`)
  ok(/还有 2 站/.test(a.text), `文案「${a.text}」`)

  setStatus(6, 60)   // 东苑5栋 正在去（在途）
  a = batch.orderAhead(db, order4())
  console.log(`     当前站=${a.current_stop} 还有=${a.stops_ahead} 站 ETA=${a.eta_min} 分`)
  ok(a.current_stop === 2, '当前站推进到 2')
  ok(a.stops_ahead === 1, '还有 1 站')
  near(a.eta_min, 5.4, 0.1, 'ETA 只剩东苑5栋→东苑7栋这一段（中途已无停靠）')
  ok(/还有 1 站/.test(a.text), `文案「${a.text}」`)

  // ---------------------------------------------------------------- 4
  section('4. 车到我这一站 → arriving')
  setStatus(7, 70)
  a = batch.orderAhead(db, order4())
  ok(a.state === 'arriving', `state=${a.state}`)
  ok(a.stops_ahead === 0 && a.prepare === true, '还有 0 站，仍然提示（最紧急）')
  ok(/已到达/.test(a.text), `文案「${a.text}」`)

  // 车已经走过去了（我的站任务已完成 80），也不该报错
  setStatus(7, 80)
  a = batch.orderAhead(db, order4())
  ok(a.state === 'arriving' && a.stops_ahead === 0, '车已过站（任务 80）→ 仍按已到达处理，不出现负数')

  // ---------------------------------------------------------------- 5
  section('5. 取最大站号，而不是最小')
  seed()
  setStatus(3, 80)   // 第 1 站已完成
  setStatus(6, 80)   // 第 2 站已完成
  setStatus(7, 60)   // 第 3 站正在去
  a = batch.orderAhead(db, order4())
  ok(a.current_stop === 3, `当前站 = 3（取最大；若取最小会永远卡在第 1 站）→ ${a.current_stop}`)
  ok(a.state === 'arriving', '车正在去我这一站 → arriving')

  // ---------------------------------------------------------------- 6
  section('6. 路线数据缺失 → 按 landmark_id 回退分组')
  seed()
  db.prepare("UPDATE delivery_batches SET route='[]' WHERE id=1").run()
  a = batch.orderAhead(db, order4())
  ok(a.total_stops === 3, `route 为空 → 回退分组出 ${a.total_stops} 站（不会算不出）`)
  ok(a.my_stop === 3, `回退后我的站号 = ${a.my_stop}（按点位 sort 排序，东苑7栋最后）`)
  db.prepare("UPDATE delivery_batches SET route='不是JSON' WHERE id=1").run()
  a = batch.orderAhead(db, order4())
  ok(a.total_stops === 3, 'route 是坏 JSON → 同样回退，不抛异常')

  // ---------------------------------------------------------------- 7
  section('7. 兜底：不存在的批次 / 没有批次 / 点位不在路线里')
  seed()
  a = batch.orderAhead(db, { id: 4, batch_id: 999, landmark_id: '7' })
  ok(a.state === 'none' && a.prepare === false, '批次不存在 → state=none，不报错')
  a = batch.orderAhead(db, order4())
  a = batch.orderAhead(db, { id: 4, batch_id: null, landmark_id: '7' })
  ok(a.state === 'none', '订单没挂批次 → state=none')
  a = batch.orderAhead(db, { id: 4, batch_id: 1, landmark_id: '999' })
  ok(a.state === 'waiting' && a.prepare === false, '订单点位不在路线里 → 不崩、不误报')

  db.prepare('UPDATE delivery_batches SET status=3 WHERE id=1').run()
  a = batch.orderAhead(db, order4())
  ok(a.state === 'done', '批次已完成 → state=done')

  console.log('')
  console.log(fail === 0 ? `🎉 全部通过（${pass} 项）` : `⚠️ 失败 ${fail} 项 / 通过 ${pass} 项`)
}

try { main() } catch (e) { console.error('测试异常：', e); fail++ }
try { db.close() } catch (e) { /* 忽略 */ }
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
  try { fs.unlinkSync(f) } catch (e) { /* 不存在就算了 */ }
}
process.exit(fail === 0 ? 0 : 1)
