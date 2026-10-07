// ============================================================================
// v2 组单算法 · 第 3 层（时机层）+ 可用车判定 单元测试
// ----------------------------------------------------------------------------
// 覆盖：
//   · BATCH_ALGO / BATCH_V2_READY 开关联动（默认必须是 legacy，线上零变化）
//   · 未定型批次数口径（只数组单中 status=0，待上货不算）
//   · 情况1（车够）：各自到点各自锁
//   · 情况2（车不够）：按 15 分钟窗口成批锁 + 窗口外的等下一轮
//   · 满容（12 件）无条件立即锁
//   · 可用车 = 0 → 强制退回情况1（继续攒单，不让每单自成一批）
//   · 派车优先级：第一张订单最早的先走
//   · 迟滞：连续稳定才切换，单次抖动不切（两个方向都验）
//   · carState：总车数从平台设备列表取、离线/报忙/被批次占用取并集去重、演示档兜底
//
// 用法：node test_batch_v2_timing.js
// 特点：不起 server、不碰线上库、不需要网络；临时库建在系统 temp 目录，跑完自删。
// ============================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const batch = require('../services/batch.js')
const timers = require('../domains/delivery/timers.js')

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) }
  else { fail++; console.log('  ✘ ' + msg) }
}
function section(title) { console.log('\n=== ' + title + ' ===') }

// ---------- 临时库（只建 batch.js 需要的 3 张表）----------
const TMP_DB = path.join(os.tmpdir(), 'lingdong_test_v2timing_' + Date.now() + '.db')
const db = new DatabaseSync(TMP_DB)
db.exec(`CREATE TABLE delivery_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_no TEXT, status INTEGER DEFAULT 0,
  device_sn TEXT DEFAULT '', created_at TEXT)`)
db.exec(`CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, status INTEGER DEFAULT 2, created_at TEXT)`)
db.exec(`CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, quantity INTEGER)`)

const p2 = (n) => String(n).padStart(2, '0')
function ago(min) {
  const d = new Date(Date.now() - min * 60000)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
let seq = 0
// 造一个「组单中」批次：内含 1 张订单、件数 items，订单下单时间 = minAgo 分钟前
function mkBatch(minAgo, items, status = 0, sn = '') {
  const bi = db.prepare('INSERT INTO delivery_batches (batch_no, status, device_sn, created_at) VALUES (?,?,?,?)')
    .run('TB' + (++seq), status, sn, ago(minAgo))
  const bid = Number(bi.lastInsertRowid)
  const oi = db.prepare('INSERT INTO orders (batch_id, status, created_at) VALUES (?,2,?)').run(bid, ago(minAgo))
  db.prepare('INSERT INTO order_items (order_id, quantity) VALUES (?,?)').run(Number(oi.lastInsertRowid), items)
  return bid
}
function clear() {
  db.exec('DELETE FROM delivery_batches')
  db.exec('DELETE FROM orders')
  db.exec('DELETE FROM order_items')
  batch.resetSituation()          // 迟滞状态是模块级的，每个用例前必须复位
  batch.V2.hysteresisMs = 0       // 默认关掉迟滞，让情况切换立即生效（第 6 组单独测迟滞）
}

async function main() {
  // ---------------------------------------------------------------- 0
  section('0. 开关与入口')
  ok(batch.BATCH_ALGO === 'legacy', `默认实际生效 BATCH_ALGO=${batch.BATCH_ALGO}（BATCH_V2_READY=${batch.BATCH_V2_READY}）—— 线上行为零变化`)
  ok(batch.BATCH_V2_READY === false, '默认 BATCH_V2_READY=false（必须显式打开才走 v2）')
  ok(batch.planAutoLock(db, { cars: { available: 99 } }) === null, 'legacy 模式下 planAutoLock 返回 null（老路径逐批判定，零改动）')

  // ---------------------------------------------------------------- 1
  section('1. 未定型批次数口径 + 情况1（车够）：各自到点各自走')
  clear()
  const A20 = mkBatch(20, 2), A12 = mkBatch(12, 2), A3 = mkBatch(3, 2)
  mkBatch(1, 2, 1) // 一个「待上货」批次：已锁定，不该被算进未定型
  ok(batch.openBatchCount(db) === 3, `未定型批次数 = ${batch.openBatchCount(db)}（只数组单中，待上货不算）`)
  let plan = batch.planAutoLockV2(db, { cars: { available: 10 } })
  ok(plan.length === 1 && plan[0] === A20,
    `可用车 10 台 → 只锁到点的 ${JSON.stringify(plan)}（12分/3分那两批没到点，不锁）`)

  // ---------------------------------------------------------------- 2
  section('2. 情况2（车不够）：窗口内所有批次一起锁')
  clear()
  const C20 = mkBatch(20, 2), C12 = mkBatch(12, 2), C3 = mkBatch(3, 2)
  plan = batch.planAutoLockV2(db, { cars: { available: 1 } })
  console.log('     窗口起点 = 最早到点批次的第一张订单时间（20分钟前），窗口 = [T-20, T-5)')
  ok(plan.length === 2 && plan[0] === C20 && plan[1] === C12,
    `可用车 1 台、未定型 3 个 → 锁 ${JSON.stringify(plan)}（20分 + 12分）`)
  ok(!plan.includes(C3), '窗口外的 3 分钟批次没被锁（留给下一轮递归）')

  // ---------------------------------------------------------------- 3
  section('3. 满容立即锁（不管哪种情况、到没到点）')
  clear()
  const F1 = mkBatch(20, 2), Ffull = mkBatch(2, 12)
  plan = batch.planAutoLockV2(db, { cars: { available: 1 } })
  ok(plan.includes(Ffull), `满容批次（12件、才 2 分钟）被锁：${JSON.stringify(plan)}`)
  ok(plan.includes(F1), '同时窗口内到点批次也锁')

  // ---------------------------------------------------------------- 4
  section('4. 可用车 = 0 → 强制情况1，继续攒单')
  clear()
  const Z20 = mkBatch(20, 2)
  mkBatch(12, 2)
  plan = batch.planAutoLockV2(db, { cars: { available: 0 } })
  ok(plan.length === 1 && plan[0] === Z20,
    `可用车 0 台 → 只锁到点的 ${JSON.stringify(plan)}（车全忙，锁了也派不出去，不该把 12 分那批也带走）`)
  plan = batch.planAutoLockV2(db, { cars: null })
  ok(plan.length === 1, '拿不到车辆信息（cars=null）时同样按可用车 0 处理，不会误触发情况2')

  // ---------------------------------------------------------------- 5
  section('5. 派车优先级：第一张订单最早的先走')
  clear()
  mkBatch(3, 2)                                  // 故意乱序创建，验的是"按订单时间"不是"按批次 id"
  const P18 = mkBatch(18, 2)
  const P11 = mkBatch(11, 2)
  plan = batch.planAutoLockV2(db, { cars: { available: 1 } })
  ok(plan[0] === P18, `计划首位 = 18 分钟前那批（最早）→ ${JSON.stringify(plan)}`)
  ok(JSON.stringify(plan) === JSON.stringify([P18, P11]),
    `窗口内按时间升序 [${P18}(18分), ${P11}(11分)]`)

  // ---------------------------------------------------------------- 6
  section('6. 迟滞：连续稳定才切换，单次抖动不切')
  clear()
  batch.V2.hysteresisMs = 400
  batch.resetSituation()
  mkBatch(20, 2); mkBatch(12, 2)
  let s = batch.planAutoLockV2(db, { cars: { available: 1 } })
  ok(s.length === 1, `第 1 次（车不够，但迟滞未满）：仍按情况1 → ${JSON.stringify(s)}`)
  let t0 = Date.now(); while (Date.now() - t0 < 500) { /* 等迟滞窗口 */ }
  s = batch.planAutoLockV2(db, { cars: { available: 1 } })
  ok(s.length === 2, `连续 400ms 车不够后 → 切情况2 → ${JSON.stringify(s)}（窗口内两批一起锁）`)
  s = batch.planAutoLockV2(db, { cars: { available: 99 } })
  ok(s.length === 2, `车一恢复（单次抖动）：不立刻切回情况1，仍按情况2 → ${JSON.stringify(s)}`)
  t0 = Date.now(); while (Date.now() - t0 < 500) { /* 等迟滞窗口 */ }
  s = batch.planAutoLockV2(db, { cars: { available: 99 } })
  ok(s.length === 1, `车持续充足 400ms 后 → 才切回情况1 → ${JSON.stringify(s)}`)
  batch.V2.hysteresisMs = 0

  // ---------------------------------------------------------------- 7
  section('7. 可用车计算（carState）')
  clear()
  const fourRobots = {
    platform: {
      getDeviceList: async () => ({
        ok: true,
        robots: [
          { device_sn: 'SN-1', online: true, machine_status: 'idle' },       // 空闲
          { device_sn: 'SN-2', online: true, machine_status: 'Delivery' },   // 平台报忙
          { device_sn: 'SN-3', online: false, machine_status: 'idle' },      // 离线
          { device_sn: 'SN-4', online: true, machine_status: 'lightTask' }   // 召唤待命 = 空闲
        ]
      })
    }
  }
  let cs = await timers.carState(db, fourRobots)
  console.log(`     总车数=${cs.total} 占用=${cs.occupied} 可用=${cs.available} 来源=${cs.source} 离线=${cs.offline} 车报忙=${cs.machine_busy}`)
  ok(cs.total === 4, '总车数 = 平台设备列表条数（4），不写死')
  ok(cs.available === 2, '可用 2 台（SN-1 空闲 + SN-4 召唤待命算空闲；SN-2 忙、SN-3 离线）')
  ok(cs.offline === 1 && cs.machine_busy === 1, '明细正确：离线 1 台、平台报忙 1 台')

  mkBatch(1, 2, 1, 'SN-1') // 待上货批次占用 SN-1
  cs = await timers.carState(db, fourRobots)
  ok(cs.available === 1, `待上货批次占用 SN-1 后 → 可用 ${cs.available} 台（已派车还没出发的也算占用）`)

  mkBatch(1, 2, 1, 'SN-2') // 又一个待上货批次占用 SN-2，而平台同时也报它 Delivery
  cs = await timers.carState(db, fourRobots)
  ok(cs.occupied === 3, `SN-2 既被批次占用、平台又报 Delivery → 占用仍为 ${cs.occupied}（取并集，不重复扣）`)
  ok(cs.available === 1, `可用 ${cs.available} 台（4 − 3）`)

  cs = await timers.carState(db, { platform: { getDeviceList: async () => ({ ok: false, msg: '演示模式' }) } })
  ok(cs.source === 'config' && cs.total === 2, `平台不可用（演示档）→ 退回 BATCH_TOTAL_CARS=${cs.total}，来源=${cs.source}`)
  ok(cs.available === 0, `演示档下"没指派设备号的未完成批次"按数量计入占用 → 可用 ${cs.available} 台（2 − 2）`)

  // ---------------------------------------------------------------- 汇总
  console.log('')
  console.log(fail === 0 ? `🎉 全部通过（${pass} 项）` : `⚠️ 失败 ${fail} 项 / 通过 ${pass} 项`)
}

main()
  .catch((e) => { console.error('测试异常：', e); fail++ })
  .finally(() => {
    try { db.close() } catch (e) { /* 忽略 */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
      try { fs.unlinkSync(f) } catch (e) { /* 不存在就算了 */ }
    }
    process.exit(fail === 0 ? 0 : 1)
  })
