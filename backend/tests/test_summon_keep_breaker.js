// tests/test_summon_keep_breaker.js —— 上货点守候「连续失败」处理口径单测（不连平台、不连真车）
// 背景（2026-10-12 实测）：平台把我们的召唤轻任务反复判成 50（失败），车一失败就回充电桩。
// 口径（负责人 2026-10-12 定）：**失败不等于放弃** —— 平台判失败不归我们管，但我们要持续重试，
// 把车一直保持在"去上货点/在上货点"的循环里，不允许它就此回充电桩；失败次数只用来亮告警。
// 本测试锁定行为：
//   ① 默认（SUMMON_LOADING_KEEP_MAX_FAILS=0）**不停手**：每轮失败都续，连续失败到阈值只落告警；
//   ② 车真到达过（status=30）算健康周期：不重发、清计数与告警；
//   ③ 任务还活着（0/10/20）时不重发（不刷平台）；
//   ④ 显式设 SUMMON_LOADING_KEEP_MAX_FAILS=1 = 只发一次（排查用的隔离档）；
//   ⑤ 批次不再等上货（配送中/完成）后，计数与告警一起清掉。
// 用法：cd backend && node tests\test_summon_keep_breaker.js
const { DatabaseSync } = require('node:sqlite')
const timers = require('../domains/delivery/timers')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) } else { fail++; console.log('  ❌ ' + msg) }
}

// 极简库：只建本函数用到的两张表
function mkStore() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE delivery_batches (
    id INTEGER PRIMARY KEY, batch_no TEXT, status INTEGER, device_sn TEXT, light_task_id TEXT,
    total_orders INTEGER, delivery_mode TEXT, updated_at TEXT)`)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  return db
}
function seedBatch(db, { id, sn, taskId, status = 1, batchNo = 'BD-TEST-' + id }) {
  db.prepare('INSERT INTO delivery_batches (id,batch_no,status,device_sn,light_task_id,total_orders,delivery_mode,updated_at) VALUES (?,?,?,?,?,1,\'\',\'\')')
    .run(id, batchNo, status, sn, taskId)
}
// 假平台：statusOf 可以是「id→状态」的映射，也可以是 (id)=>状态 的函数；每次召唤产出新 id 并记数
function mkDeps(statusOf, calls) {
  const st = typeof statusOf === 'function' ? statusOf : (id) => statusOf[id]
  return {
    platform: {
      queryLightTask: async (id) => {
        const v = st(id)
        if (v === undefined || v === null) return { ok: false, msg: '查询失败' }
        return { ok: true, status: v, arrived: v === 30 }
      },
      summonToLoadingPoint: async (store, sn) => {
        const id = 'LT-' + sn + '-' + (++calls.n)
        return { ok: true, light_task_id: id }
      }
    }
  }
}

;(async () => {
  // 测试里把重发节流关掉，便于连续调用（生产默认 15000ms）；两个阈值都用默认（不停手 / 告警 3 次）
  process.env.SUMMON_LOADING_KEEP_TRY_MS = '0'
  delete process.env.SUMMON_LOADING_KEEP_MAX_FAILS
  delete process.env.SUMMON_LOADING_KEEP_ALERT_FAILS

  console.log('[1] 默认口径：失败也【不停手】，一直重试；连续 3 次只落告警')
  {
    const db = mkStore()
    seedBatch(db, { id: 1, sn: 'SN-A', taskId: 'LT-A1' })
    const calls = { n: 0 }
    const deps = mkDeps(() => 50, calls) // 平台永远把召唤判成失败

    await timers.keepLoadingSummon(db, deps) // 第 1 次失败 → 续
    ok(calls.n === 1, '第 1 次失败后仍续一次召唤（实际 ' + calls.n + ' 次）')
    const b1 = db.prepare('SELECT light_task_id FROM delivery_batches WHERE id=1').get()
    ok(b1.light_task_id === 'LT-SN-A-1', '批次上的 light_task_id 已更新为新任务（' + b1.light_task_id + '）')

    await timers.keepLoadingSummon(db, deps) // 第 2 次失败 → 续
    ok(calls.n === 2, '第 2 次失败后仍续（累计 ' + calls.n + ' 次）')

    await timers.keepLoadingSummon(db, deps) // 第 3 次失败 → 到达告警阈值，但**继续重试**
    ok(calls.n === 3, '到达告警阈值后【继续重试】而不是停手（累计 ' + calls.n + ' 次）')
    const alert = db.prepare("SELECT value FROM meta WHERE key='summon_keep_alert:SN-A'").get()
    ok(!!alert, 'meta 里落了告警')
    const info = alert ? JSON.parse(alert.value) : {}
    ok(info.fails === 3, '告警里失败次数=3')
    ok(info.stopped === false, '告警标明「未停手」（stopped=false）')
    const f = timers.keepFailOf('SN-A')
    ok(f && f.n === 3, '内存里的失败计数=3')

    await timers.keepLoadingSummon(db, deps) // 第 4 次失败 → 依旧继续重试
    ok(calls.n === 4, '第 4 次失败后依然继续重试（累计 ' + calls.n + ' 次 = 从不放弃）')
    db.close()
  }

  console.log('[2] 车真到达过（status=30）→ 健康：不重发、清计数与告警')
  {
    const db = mkStore()
    seedBatch(db, { id: 2, sn: 'SN-B', taskId: 'LT-B1' })
    db.prepare("INSERT INTO meta (key,value) VALUES ('summon_keep_alert:SN-B','{\"fails\":3}')").run()
    const calls = { n: 0 }
    const deps = mkDeps(() => 30, calls)
    await timers.keepLoadingSummon(db, deps)
    ok(calls.n === 0, '到达态不重发召唤（实际 ' + calls.n + ' 次）')
    ok(!db.prepare("SELECT 1 FROM meta WHERE key='summon_keep_alert:SN-B'").get(), '已有的告警被清掉')
    ok(timers.keepFailOf('SN-B') === null, '失败计数归零')
    db.close()
  }

  console.log('[3] 任务还活着（前往中 20）→ 不刷平台')
  {
    const db = mkStore()
    seedBatch(db, { id: 3, sn: 'SN-C', taskId: 'LT-C1' })
    const calls = { n: 0 }
    const deps = mkDeps(() => 20, calls)
    await timers.keepLoadingSummon(db, deps)
    await timers.keepLoadingSummon(db, deps)
    ok(calls.n === 0, '在途任务不重复召唤（实际 ' + calls.n + ' 次）')
    db.close()
  }

  console.log('[4] SUMMON_LOADING_KEEP_MAX_FAILS=1 → 只发一次（排查隔离档，非默认）')
  {
    const db = mkStore()
    seedBatch(db, { id: 4, sn: 'SN-D', taskId: 'LT-D0' })
    const calls = { n: 0 }
    const deps = mkDeps(() => 50, calls)
    process.env.SUMMON_LOADING_KEEP_MAX_FAILS = '1'
    await timers.keepLoadingSummon(db, deps)
    ok(calls.n === 0, '显式设为 1 时，首次发现失败就不再重发（实际 ' + calls.n + ' 次）')
    const alert = db.prepare("SELECT value FROM meta WHERE key='summon_keep_alert:SN-D'").get()
    const info = alert ? JSON.parse(alert.value) : {}
    ok(info.fails === 1 && info.stopped === true, '告警按第 1 次失败落库，且标明已停手（stopped=true）')
    delete process.env.SUMMON_LOADING_KEEP_MAX_FAILS
    db.close()
  }

  console.log('[5] 还没有召唤任务 → 首次召唤')
  {
    const db = mkStore()
    seedBatch(db, { id: 5, sn: 'SN-E', taskId: '' })
    const calls = { n: 0 }
    const deps = mkDeps(() => 50, calls)
    await timers.keepLoadingSummon(db, deps)
    ok(calls.n === 1, '无任务时召唤一次（实际 ' + calls.n + ' 次）')
    const b = db.prepare('SELECT light_task_id FROM delivery_batches WHERE id=5').get()
    ok(b.light_task_id === 'LT-SN-E-1', '任务 id 已回写批次')
    db.close()
  }

  console.log('[6] 批次进入配送中(2) → 熔断状态与告警一起清掉')
  {
    const db = mkStore()
    seedBatch(db, { id: 6, sn: 'SN-F', taskId: 'LT-F1' })
    const calls = { n: 0 }
    const deps = mkDeps(() => 50, calls)
    await timers.keepLoadingSummon(db, deps)
    await timers.keepLoadingSummon(db, deps)
    await timers.keepLoadingSummon(db, deps)
    ok(timers.keepFailOf('SN-F') !== null, '先制造出熔断状态')
    db.prepare("UPDATE delivery_batches SET status=2, delivery_mode='summon' WHERE id=6").run()
    await timers.keepLoadingSummon(db, deps)
    ok(timers.keepFailOf('SN-F') === null, '批次转配送中后熔断状态被清理')
    ok(!db.prepare("SELECT 1 FROM meta WHERE key='summon_keep_alert:SN-F'").get(), '告警也被清掉')
    db.close()
  }

  console.log('\n' + (fail === 0 ? '🎉 全部通过' : '❌ 有失败项') + '（' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : '') + '）')
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('❌ 测试跑挂：' + e.message); process.exit(1) })
