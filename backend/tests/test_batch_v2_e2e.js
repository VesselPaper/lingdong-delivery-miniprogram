// ============================================================================
// v2 组单算法 · 端到端对比测试（demo 档 + 临时库，不碰线上）
// ----------------------------------------------------------------------------
// 做什么：起一个 demo 档后端，灌一批真实订单（24 单，散布 9 个楼栋），
//         等所有批次定型后，把每一批的「件数 / 站点数 / 预计行程时长」算出来，
//         分别跑 v2 和 legacy，并排对比。
//
// 为什么这么比：legacy 组批【只看件数、不看楼栋】，所以一趟能塞 7~8 个楼栋；
//   v2 有「每趟 ≤ 15 分钟」硬约束，会把这种批次拆开。这个测试就是钉住这个差别。
//
// 断言：
//   · v2 的每一个多站批次，预计行程都必须 ≤ 15 分钟        ← 核心设计目标
//   · 两种算法都不能有订单没进批次（否则订单永远发不出去）
//   · v2 档必须真的跑在 v2 上（日志里不能出现"回落 legacy"的警告）
//
// 用法：
//   node tests/test_batch_v2_e2e.js           跑两档并对比（约 6~7 分钟）
//   node tests/test_batch_v2_e2e.js v2        只跑 v2（约 3 分钟）
//   node tests/test_batch_v2_e2e.js legacy    只跑 legacy
//
// 参数说明：为了跑得快，攒单上限被压成 60 秒（真实是 15 分钟）。
//   窗口/批次的【结构】验证有效，绝对分钟数不能直接换算到生产。
// ============================================================================
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const batchMod = require('../services/batch.js')

const PORT = 3211
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const BE = path.join(__dirname, '..')

// ★ 真实点位坐标（米制，来自平台 landInfo 同步结果）。
// 为什么必须自带：全新数据库的 landmarks 表坐标全是 (0,0) —— 坐标是后端跟平台同步时
// 才写进去的，演示/Mock 档不会同步。没有坐标时 v2EstimateTripMin 的行驶时间项恒为 0，
// 算出来的"预计行程"只剩停靠开销，对比就失去意义了。所以每次起完服务都要把这组坐标灌回去。
const REAL_COORDS = {
  商铺上货: [17.566, 6.515],
  东苑1栋: [-14.147, 109.278],
  东苑2栋: [-14.969, 11.043],
  东苑3栋: [-14.519, -69.209],
  东苑4栋: [-14.908, -50.382],
  东苑5栋: [-14.979, 37.814],
  东苑7栋: [231.945, 59.898],
  东苑11栋: [146.465, -56.382],
  东苑12栋: [74.747, 24.772],
  东苑13栋: [23.399, -107.831],
  零栋库房: [14.05, -3.317]
}
// 把真实坐标灌进临时库；返回实际写入的点位数
function injectCoords(dbPath) {
  const d = new DatabaseSync(dbPath)
  const upd = d.prepare('UPDATE landmarks SET pos_x=?, pos_y=? WHERE name=?')
  let n = 0
  for (const [name, [x, y]] of Object.entries(REAL_COORDS)) {
    const r = upd.run(x, y, name)
    if (r.changes > 0) n++
  }
  const noCoord = d.prepare('SELECT COUNT(*) c FROM landmarks WHERE pos_x=0 AND pos_y=0').get().c
  d.close()
  return { n, noCoord }
}

// 订单流：24 单，故意散布在 9 个楼栋（楼栋越散，legacy "不看楼栋"的毛病越明显）
const SEQ = [
  ['东苑1栋', 1], ['东苑2栋', 2], ['东苑7栋', 1], ['东苑3栋', 1], ['东苑5栋', 3], ['东苑11栋', 1],
  ['东苑1栋', 2], ['东苑13栋', 1], ['东苑2栋', 1], ['东苑4栋', 2], ['东苑12栋', 1], ['东苑7栋', 2],
  ['东苑3栋', 1], ['东苑5栋', 1], ['东苑1栋', 1], ['东苑11栋', 2], ['东苑2栋', 1], ['东苑4栋', 1],
  ['东苑13栋', 2], ['东苑12栋', 1], ['东苑7栋', 1], ['东苑5栋', 2], ['东苑3栋', 1], ['东苑1栋', 1]
]
const GAP_MS = 4000      // 每 4 秒一单 → 约 93 秒放完
const TAIL_MS = 95000    // 尾部等待，让最后那批也到点定型
const HOLD_MS = 60000    // 攒单上限压成 1 分钟
const TOTAL_CARS = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return res.json().catch(() => ({}))
}

// 临时库是空的，不预置账号就没法登录商家端（与 test_batch_flow.js 同一套做法）
function seedMerchant(dbPath) {
  const adminAuth = require('../services/adminAuth')
  const db0 = new DatabaseSync(dbPath)
  db0.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT UNIQUE, nickname TEXT, avatar TEXT, phone TEXT,
    role TEXT DEFAULT 'student', landmark_id TEXT DEFAULT '', landmark_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    username TEXT UNIQUE, password_hash TEXT, merchant_role TEXT DEFAULT '', token TEXT, status INTEGER DEFAULT 1)`)
  db0.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
  db0.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('merchant_role_reset_at', datetime('now','localtime'))").run()
  db0.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'测试商家')")
    .run('testmerchant', adminAuth.hashPassword('test123456'))
  db0.close()
}

function startServer(algo) {
  const dbPath = path.join(os.tmpdir(), `lingdong_test_v2e2e_${algo}_${Date.now()}.db`)
  seedMerchant(dbPath)
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BE,
    env: {
      ...process.env,
      RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true', PAY_MOCK: 'true',
      LINGDONG_DB: dbPath,
      BATCH_ALGO: algo,
      BATCH_V2_READY: algo === 'v2' ? 'true' : 'false',   // v2 必须显式打开才生效
      BATCH_HOLD_MS: String(HOLD_MS),                     // v2 的攒单上限
      BATCH_WAIT_MS: String(HOLD_MS),                     // legacy 对齐到同样的时长，才比得公平
      BATCH_HYSTERESIS_MS: '6000', BATCH_SCAN_MS: '2000', BATCH_TOTAL_CARS: String(TOTAL_CARS),
      WX_APPID: '', WX_SECRET: '', MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: '', SUMMON_DELIVERY: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, dbPath, getLog: () => log }
}

async function waitUp(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(BASE + '/shop/status'); if (r.ok) return true } catch (e) { /* 还没起来 */ }
    await sleep(300)
  }
  return false
}

function cleanupDb(dbPath) {
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { fs.unlinkSync(f) } catch (e) { /* 不存在就算了 */ }
  }
}

async function runOne(algo) {
  console.log('')
  console.log('█'.repeat(78))
  console.log(`█  ${algo.toUpperCase()}：${SEQ.length} 单 / 每 ${GAP_MS / 1000} 秒一单 / 攒单上限压成 ${HOLD_MS / 1000} 秒 / ${TOTAL_CARS} 台车`)
  console.log('█'.repeat(78))
  const srv = startServer(algo)
  const t0 = Date.now()
  let v2WarnedFallback = false
  try {
    if (!await waitUp(20000)) throw new Error('后端起不来（20s 超时）\n' + srv.getLog())

    // ★ 必须在下单之前灌坐标，否则后面算出来的"预计行程"不含行驶时间
    const coord = injectCoords(srv.dbPath)
    if (coord.n === 0 || coord.noCoord > 0) {
      throw new Error(`点位坐标注入失败：写入 ${coord.n} 个，仍有 ${coord.noCoord} 个点位无坐标 —— 对比结果不可信`)
    }
    console.log(`  点位坐标：已灌入 ${coord.n} 个真实坐标`)

    const mer = await api('POST', '/auth/login', { username: 'testmerchant', password: 'test123456', client: 'merchant', nickname: '测试商家' })
    if (mer.code !== 0) throw new Error('商家登录失败：' + JSON.stringify(mer))
    const mToken = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'v2e2e-' + Date.now(), role: 'student', nickname: '测试学生' })
    if (stu.code !== 0) throw new Error('学生登录失败：' + JSON.stringify(stu))
    const sToken = stu.data.token
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mToken)

    // 临时库商品库存是按门店 xlsx 导入的，不够 24 单；先把要用的那个商品库存拉满
    const goods = (await api('GET', '/merchant/goods', null, mToken)).data || []
    const gUse = goods.find((g) => Number(g.stock) > 0) || goods[0]
    if (gUse) await api('PUT', '/merchant/goods/stock', { id: gUse.id, stock: 9999 }, mToken)

    // 从库里取真实点位 id（不硬编码，避免点位表变动后测试失效）
    const db0 = new DatabaseSync(srv.dbPath, { readOnly: true })
    const lms = db0.prepare("SELECT id, name FROM landmarks WHERE type != 'loadingPoint'").all()
    db0.close()
    const lmId = new Map(lms.map((x) => [x.name, x.id]))

    // 放订单流，同时记录「组单中 / 待上货 / 配送中」批次数随时间的变化
    const series = []
    let lastPoll = 0
    async function poll() {
      if (Date.now() - lastPoll < 9000) return
      lastPoll = Date.now()
      try {
        const p = await api('GET', '/merchant/device/pending', null, mToken)
        const d = (p && p.data) || {}
        series.push({
          t: Math.round((Date.now() - t0) / 1000),
          open: (d.open_batches || []).length,
          ready: (d.ready_batches || []).length,
          act: (d.active_batches || []).length
        })
      } catch (e) { /* 轮询失败忽略 */ }
    }
    await poll()

    let okCount = 0
    const failed = []
    for (let i = 0; i < SEQ.length; i++) {
      const [name, qty] = SEQ[i]
      const id = lmId.get(name)
      if (!id) { failed.push(name + '（点位表里没这个名字）'); continue }
      const c = await api('POST', '/order/create', {
        landmark_id: id, landmark_name: name, contact_name: '测试学生', contact_phone: '13800138000',
        items: [{ goods_id: gUse.id, quantity: qty }]
      }, sToken)
      if (c.code !== 0) { failed.push(name + ' 下单失败:' + JSON.stringify(c).slice(0, 80)); continue }
      const pay = await api('POST', '/order/pay', { id: c.data.order_id }, sToken)
      if (pay.code !== 0) failed.push(name + ' 支付失败:' + JSON.stringify(pay).slice(0, 80))
      else okCount++
      await poll()
      if (i < SEQ.length - 1) await sleep(GAP_MS)
    }
    console.log(`  下单：成功 ${okCount} 单，失败 ${failed.length} 单`)
    for (const f of failed.slice(0, 5)) console.log('    ⚠️ ' + f)

    const tailEnd = Date.now() + TAIL_MS
    console.log(`  放单用时 ${((Date.now() - t0) / 1000).toFixed(0)}s，尾部等待 ${TAIL_MS / 1000}s…`)
    while (Date.now() < tailEnd) {
      await sleep(10000)
      await poll()
    }
    await poll()
    console.log('')
    console.log('  批次数随时间变化（秒: 组单中/待上货/配送中）')
    console.log('    ' + series.map((s) => `${s.t}s:${s.open}/${s.ready}/${s.act}`).join('  '))
  } finally {
    v2WarnedFallback = /BATCH_V2_READY 不是 true/.test(srv.getLog())
    try { srv.child.kill() } catch (e) { /* 忽略 */ }
    await sleep(1500)
  }

  // ---------- 收数（服务停了再读，避免 WAL 并发）----------
  const db = new DatabaseSync(srv.dbPath, { readOnly: true })
  const loading = db.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get() || null
  const loadingPt = batchMod.lmPoint(loading)

  const rows = db.prepare(`
    SELECT b.id, b.batch_no, b.status, b.created_at, b.dispatched_at,
      (SELECT COUNT(DISTINCT o.id) FROM orders o WHERE o.batch_id=b.id) c,
      (SELECT IFNULL(SUM(oi.quantity),0) FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.batch_id=b.id) items,
      (SELECT MIN(o.created_at) FROM orders o WHERE o.batch_id=b.id) first_at
    FROM delivery_batches b ORDER BY b.id`).all()

  const detail = []
  for (const b of rows) {
    const orders = db.prepare('SELECT id, landmark_id FROM orders WHERE batch_id=?').all(b.id)
    const byLm = new Map()
    for (const o of orders) byLm.set(o.landmark_id, (byLm.get(o.landmark_id) || 0) + 1)
    const stops = [...byLm].map(([lm, n]) => ({ landmark_id: lm, pt: batchMod.landmarkPointOf(db, lm), n }))
    const tripMin = stops.length ? batchMod.v2EstimateTripMin(loadingPt, stops, Number(b.items) || 0) : 0
    const firstT = batchMod.parseTime(b.first_at)
    const dispT = batchMod.parseTime(b.dispatched_at)
    detail.push({
      no: b.batch_no, status: Number(b.status), c: Number(b.c), items: Number(b.items),
      stops: stops.length, tripMin,
      collectMin: (firstT !== null && dispT !== null) ? (dispT - firstT) / 60000 : null
    })
  }
  const inv = batchMod.checkInvariants(db)
  const totalOrders = Number(db.prepare('SELECT COUNT(*) c FROM orders').get().c || 0)
  const noBatch = Number(db.prepare('SELECT COUNT(*) c FROM orders WHERE batch_id IS NULL').get().c || 0)
  db.close()
  cleanupDb(srv.dbPath)

  // ---------- 打印 ----------
  console.log('')
  console.log('  批次明细：')
  console.log('    批次          状态  单数  件数  站点  预计行程   攒单用时')
  for (const d of detail) {
    const flag = d.stops > 1 && d.tripMin > 15 ? '  ← 超15分' : ''
    console.log(`    ${String(d.no).padEnd(13)} ${String(d.status).padEnd(4)} ${String(d.c).padStart(4)}  ${String(d.items).padStart(4)}  ${String(d.stops).padStart(4)}  ${d.tripMin.toFixed(1).padStart(6)}分  ${d.collectMin === null ? '  —  ' : d.collectMin.toFixed(1).padStart(5) + '分'}${flag}`)
  }
  const multi = detail.filter((d) => d.stops > 1)
  const over = detail.filter((d) => d.stops > 1 && d.tripMin > 15)
  const avg = (a, k) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0
  console.log('')
  console.log(`  【${algo} 汇总】`)
  console.log(`    订单 ${totalOrders} 单，没进批次的 ${noBatch} 单`)
  console.log(`    批次数 ${detail.length}；平均 件数 ${avg(detail, 'items').toFixed(1)} / 站点 ${avg(detail, 'stops').toFixed(1)} / 行程 ${avg(detail, 'tripMin').toFixed(1)}分 / 攒单 ${avg(detail.filter((d) => d.collectMin !== null), 'collectMin').toFixed(1)}分`)
  console.log(`    最大 件数 ${Math.max(0, ...detail.map((d) => d.items))} / 站点 ${Math.max(0, ...detail.map((d) => d.stops))} / 行程 ${Math.max(0, ...detail.map((d) => d.tripMin)).toFixed(1)}分`)
  console.log(`    ★ 超过 15 分钟的批次：${over.length} / ${multi.length} 个多站批次`)
  console.log(`    不变量自检：${inv.ok ? '✅ 无违规' : '⚠️ ' + inv.violations.length + ' 处'}`)
  for (const v of inv.violations.slice(0, 8)) console.log(`       · [${v.type}] ${v.detail}`)

  return {
    algo, detail, inv, totalOrders, noBatch,
    over: over.length, multi: multi.length,
    avgItems: avg(detail, 'items'), avgStops: avg(detail, 'stops'),
    avgTrip: avg(detail, 'tripMin'), maxTrip: Math.max(0, ...detail.map((d) => d.tripMin)),
    v2WarnedFallback, elapsed: (Date.now() - t0) / 1000
  }
}

// ============================================================================
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) }
  else { fail++; console.log('  ✘ ' + msg) }
}

;(async () => {
  const arg = String(process.argv[2] || 'both').trim().toLowerCase()
  const arms = arg === 'v2' ? ['v2'] : arg === 'legacy' ? ['legacy'] : ['v2', 'legacy']
  console.log(`将跑：${arms.join(' + ')}（每档约 ${Math.round((SEQ.length * GAP_MS + TAIL_MS) / 1000)}s + 启动开销）`)

  const results = []
  for (const algo of arms) {
    try { results.push(await runOne(algo)) }
    catch (e) { console.log(`  ❌ ${algo} 跑挂了：${e.message}`); fail++ }
  }
  const g = (a, k) => (results.find((r) => r.algo === a) || {})[k]

  if (arms.length > 1) {
    console.log('')
    console.log('='.repeat(78))
    console.log('  对比')
    console.log('='.repeat(78))
    console.log('  指标                      v2      legacy')
    const f = (x, d = 1) => (x === undefined || x === null ? '  —  ' : Number(x).toFixed(d))
    for (const [name, k, d] of [
      ['批次数', 'detail', 0], ['平均件数', 'avgItems', 1], ['平均站点数', 'avgStops', 1],
      ['平均行程(分)', 'avgTrip', 1], ['最大行程(分)', 'maxTrip', 1],
      ['★ 超过15分的批次', 'over', 0], ['没进批次的订单', 'noBatch', 0]
    ]) {
      const a = k === 'detail' ? (g('v2', 'detail') || []).length : g('v2', k)
      const b = k === 'detail' ? (g('legacy', 'detail') || []).length : g('legacy', k)
      console.log(`  ${name.padEnd(24)} ${f(a, d).padStart(6)}  ${f(b, d).padStart(6)}`)
    }
  }

  console.log('')
  console.log('='.repeat(78))
  console.log('  断言')
  console.log('='.repeat(78))

  const v2 = results.find((r) => r.algo === 'v2') || null
  const lg = results.find((r) => r.algo === 'legacy') || null

  if (v2) {
    assert(v2.v2WarnedFallback === false, 'v2 档确实跑在 v2 上（日志里没有"回落 legacy"警告）')
    assert(v2.over === 0, `v2 的批次没有一趟超过 15 分钟（实际超时 ${v2.over} 个，最大 ${v2.maxTrip.toFixed(1)} 分）`)
    assert(v2.noBatch === 0, `v2 没有订单被漏在批次外（${v2.noBatch} 单）`)
    assert(v2.inv.ok, `v2 收尾时不变量自检通过${v2.inv.ok ? '' : '（' + v2.inv.violations.length + ' 处）'}`)
  }
  if (lg) {
    assert(lg.noBatch === 0, `legacy 也没有订单被漏在批次外（${lg.noBatch} 单）`)
    assert(lg.inv.ok, `legacy 收尾时不变量自检通过${lg.inv.ok ? '' : '（' + lg.inv.violations.length + ' 处）'}`)
    console.log(`  ℹ️  legacy 有 ${lg.over} / ${lg.multi} 个多站批次超过 15 分钟（这是它的已知缺陷，不是回归）`)
  }
  if (v2 && lg) {
    assert(lg.over > 0, `对照组有效：legacy 确实产生了超 15 分钟的批次（${lg.over} 个）—— 否则说明这个测试没测出差别`)
    assert(v2.avgTrip < lg.avgTrip, `v2 平均行程 ${v2.avgTrip.toFixed(1)} 分 < legacy ${lg.avgTrip.toFixed(1)} 分`)
  }

  console.log('')
  console.log(fail === 0 ? `🎉 全部通过（${pass} 项）` : `⚠️ 失败 ${fail} 项 / 通过 ${pass} 项`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('总异常：', e); process.exit(1) })
