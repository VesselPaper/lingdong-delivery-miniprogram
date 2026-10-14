// 【需求6】开舱/关舱/动作互斥闸 端到端测试（SUMMON_DELIVERY=true + Mock + 临时库）
// 覆盖：
//   · 开舱成功 → bin_opened_at 置位
//   · 舱门开着时点「立即配送」→ 被互斥闸拦下（400 + reason=bin_open）—— 这是"开仓的时候车就走了"的直接修复
//   · 关舱 → bin_opened_at 清空 → 再点「立即配送」成功
//   · 开舱幂等：重复开舱返回 already_open（不会重复下发平台指令/不会把车叫走）
//   · robotMoving 出口形状（MOCK 档恒 not moving，真实档在真机验证）
// 用法：node test_door_mutex.js
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const PORT = 3105
const TMP_DB = path.join(os.tmpdir(), 'lingdong_door_mutex_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms))

let child = null
let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) } else { fail++; console.log('  ✘ ' + msg) }
}
function section(title) { console.log('\n=== ' + title + ' ===') }

function startServer() {
  return new Promise((resolve, reject) => {
    try {
      const { DatabaseSync } = require('node:sqlite')
      const adminAuth = require('../services/adminAuth')
      const db0 = new DatabaseSync(TMP_DB)
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
    } catch (e) { /* 预置失败不阻断 */ }
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true',
        LINGDONG_DB: TMP_DB, PAY_MOCK: 'true', BATCH_WAIT_MS: '100000',
        WX_APPID: '', WX_SECRET: '',
        MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: '',
        SUMMON_DELIVERY: 'true', SUMMON_STOP_ADVANCE_MS: '1200'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    const t0 = Date.now()
    const timer = setInterval(async () => {
      try { const r = await fetch(BASE + '/shop/status'); if (r.ok) { clearInterval(timer); resolve() } } catch (e) { /* not up */ }
      if (Date.now() - t0 > 15000) { clearInterval(timer); reject(new Error('server start timeout\n' + log)) }
    }, 300)
  })
}

async function api(method, pathname, body, token) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  let j = null
  try { j = await res.json() } catch (e) { j = {} }
  return { status: res.status, ...j }
}

async function main() {
  await startServer()
  console.log('[1] server up (mock + SUMMON_DELIVERY=true, port ' + PORT + ')')

  // robotMoving 出口形状（MOCK 档）
  section('0. robotMoving 互斥闸判据（MOCK 档）')
  try {
    const plat = require('../services/platform')
    const mv = await plat.robotMoving(require('node:sqlite').DatabaseSync ? { prepare: () => ({ get: () => null }) } : null, 'SN-1')
    ok(mv && typeof mv.moving === 'boolean', `robotMoving 返回 { ok, moving } 形状（moving=${mv && mv.moving}）`)
    ok(!mv.moving, 'MOCK 档恒 not moving（真实档在真机验证「车在动→拒绝开舱」）')
  } catch (e) {
    ok(false, 'robotMoving 可调用：' + e.message)
  }

  const mer = await api('POST', '/auth/login', { username: 'testmerchant', password: 'test123456', client: 'merchant', nickname: '测试商家' })
  ok(mer.code === 0, '商家登录')
  const mT = mer.data.token
  const stu = await api('POST', '/auth/login', { code: 'door-' + Date.now(), role: 'student', nickname: '测试学生' })
  ok(stu.code === 0, '学生登录')
  const sT = stu.data.token
  await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mT)

  section('1. 造批 + 定型 + 扫码')
  let created = []
  for (const lm of [2, 3]) {
    const c = await api('POST', '/order/create', { landmark_id: lm, landmark_name: '点位' + lm, contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sT)
    ok(c.code === 0, '下单 order=' + (c.data && c.data.order_no))
    created.push(c.data.order_id)
    const p = await api('POST', '/order/pay', { id: c.data.order_id }, sT)
    ok(p.code === 0, '支付 order=' + c.data.order_id)
  }
  const pend = await api('GET', '/merchant/device/pending', null, mT)
  const batchId = (pend.data.open_batches || [])[0].id
  ok(batchId, '有组单中批次 id=' + batchId)
  const disp = await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: batchId }, mT)
  ok(disp.code === 0 && disp.data.status === 1, '批次定型 → 待上货')
  const scan = await api('POST', '/merchant/device/scan', { deviceSn: 'DOORBOT001' }, mT)
  ok(scan.code === 0 && scan.data.batch_id === batchId, '扫码定位机器人')

  section('2. 开舱成功 → 舱门标记置位')
  const openBin = await api('POST', '/merchant/device/batch/open-bin', { batch_id: batchId }, mT)
  ok(openBin.code === 0 && openBin.data.opened === 2, '开舱成功 opened=2（召唤开舱）')
  let detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
  ok(detail.data.bin_opened === true, 'batch.bin_opened_at 已置位（舱门开着）')

  section('3. ★ 舱门开着 → 「立即配送」必须被互斥闸拦下（开仓时就走了的 bug）')
  const goOpen = await api('POST', '/merchant/device/batch/dispatch', { batch_id: batchId }, mT)
  ok(goOpen.status === 400 && goOpen.reason === 'bin_open',
    `舱门未关时立即配送被拦：HTTP ${goOpen.status} reason=${goOpen.reason} msg=${goOpen.msg}`)
  ok(!goOpen.data || goOpen.data.summoned !== true, '车没有被召唤走（批次未进入配送）')
  detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
  ok(detail.data.status === 1, '批次仍停在待上货(1)，未进入配送中')

  section('4. 开舱幂等：重复开舱返回 already_open（不重复下发、不把车叫走）')
  const openAgain = await api('POST', '/merchant/device/batch/open-bin', { batch_id: batchId }, mT)
  ok(openAgain.code === 0 && openAgain.data.already_open === true, '重复开舱 → already_open（幂等）')

  section('5. 关舱 → 清标记 → 立即配送放行')
  const closeBin = await api('POST', '/merchant/device/batch/close-bin', { batch_id: batchId }, mT)
  ok(closeBin.code === 0, '关舱成功')
  detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
  ok(detail.data.bin_opened === false, '关舱后 bin_opened_at 已清空')
  const goClosed = await api('POST', '/merchant/device/batch/dispatch', { batch_id: batchId }, mT)
  ok(goClosed.code === 0 && goClosed.data.summoned === true, '关舱后立即配送放行（summoned=true）')
  detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
  ok(detail.data.status === 2, '批次进入配送中(2)')

  child.kill()
  console.log('')
  console.log(fail === 0 ? `🎉 互斥闸测试全部通过（${pass} 项）` : `⚠️ 失败 ${fail} 项 / 通过 ${pass} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试异常：', e); child && child.kill(); process.exit(1) })
