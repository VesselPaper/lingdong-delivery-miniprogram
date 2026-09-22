// 状态流水（status_events）与时间线冒烟测试（Mock 模式 + 临时库 + 独立端口）
// 用法：node test_status_events.js
//
// 覆盖（对应方案 §5.1 / §5.4 / §8.1）：
//   ① 采集器捕获真实业务链路产生的状态迁移（下单→支付→自动接单→配送中）
//   ② 时间线接口按时间正序返回真实事件（from/to/文案齐全）
//   ③ 操作者归属：管理员操作引发的迁移署名为 admin（来自 audit() 的操作者线索）
//   ④ 批次时间线合并批内订单事件，并标注事件归属哪个订单
//   ⑤ 老数据无事件时返回「推断节点」，有真实事件时不混入推断节点
//   ⑥ 参数校验（非法 type / 不存在的实体）
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3102
const TMP_DB = path.join(os.tmpdir(), 'lingdong_events_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const ADMIN_USER = 'testadmin'
const ADMIN_PASS = 'testpass12345'

let child = null
let db = null

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true', LINGDONG_DB: TMP_DB,
        PAY_MOCK: 'true', BATCH_WAIT_MS: '100000', MERCHANT_INVITE_CODE: 'test-invite',
        WX_APPID: '', WX_SECRET: '', MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: '',
        SUMMON_DELIVERY: 'false', STATUS_EVENTS_MS: '300'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    const t0 = Date.now()
    const timer = setInterval(async () => {
      try {
        const r = await fetch(BASE + '/shop/status')
        if (r.ok) { clearInterval(timer); resolve() }
      } catch (e) { /* not up yet */ }
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
  return res.json().catch(() => ({}))
}
async function adminApi(method, pathname, body, adminToken) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(adminToken ? { 'x-admin-token': adminToken } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return res.json().catch(() => ({}))
}
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))

let bad = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✘ ' + msg); bad++ } else { console.log('  ✔ ' + msg) }
}

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    const adminAuth = require('./services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    adminAuth.createAdmin(boot, { username: ADMIN_USER, password: ADMIN_PASS, nickname: '测试管理员' })
    boot.close()
    db = new DatabaseSync(TMP_DB)

    const mer = await api('POST', '/auth/login', { code: 'merchant-e-' + Date.now(), merchant_code: 'test-invite', nickname: '测试商家' })
    const mToken = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'student-e-' + Date.now(), role: 'student', nickname: '测试学生' })
    const sToken = stu.data.token
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mToken)
    const lg = await api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })
    const aToken = lg.data.token
    assert(lg.code === 0 && aToken, '管理员登录')

    // ---------- ① 采集器捕获真实链路迁移 ----------
    const c = await api('POST', '/order/create', {
      landmark_id: 2, landmark_name: '东苑1栋', contact_name: '测试学生', contact_phone: '13800138000',
      items: [{ goods_id: 1, quantity: 1 }]
    }, sToken)
    assert(c.code === 0, '下单 order=' + (c.data && c.data.order_no))
    const orderId = c.data.order_id
    const p = await api('POST', '/order/pay', { id: orderId }, sToken)
    assert(p.code === 0, '支付（自动接单并入批次）')

    await waitMs(1500)   // 等采集器跑几轮（STATUS_EVENTS_MS=300）

    const tl = await adminApi('GET', '/admin/timeline?type=order&id=' + orderId, null, aToken)
    assert(tl.code === 0 && tl.data, '时间线接口可用')
    // 下单→支付→自动接单在毫秒内完成，采集器首次看到该订单时已是「配送中」，
    // 故这里只会有 1 条起始事件（方案 §5.1 已注明「短时间连跳只记最终值」这一局限）。
    assert(tl.data.events.length >= 1, '采集器捕获到该订单的起始状态（' + tl.data.events.length + ' 条）')
    assert(tl.data.events.some((e) => Number(e.to_status) === 2), '捕获到 → 配送中(2) 的迁移')
    assert(tl.data.events.every((e) => e.status_text), '每条事件都带状态文案')
    const ids = tl.data.events.map((e) => e.id)
    assert(ids.join(',') === ids.slice().sort((a, b) => a - b).join(','), '事件按时间正序返回')
    assert(tl.data.legacy.length === 0, '有真实事件时不返回推断节点')
    assert(tl.data.current && Number(tl.data.current.status) === 2, '时间线含当前状态=配送中')

    const batchId = db.prepare('SELECT batch_id FROM orders WHERE id=?').get(orderId).batch_id
    assert(!!batchId, '订单已并入批次 #' + batchId)

    // ---------- ③ 操作者归属（管理员取消 → admin） ----------
    const cancel = await adminApi('POST', '/admin/order/cancel', { order_id: orderId }, aToken)
    assert(cancel.code === 0, '管理员取消订单')
    await waitMs(1500)
    const tl2 = await adminApi('GET', '/admin/timeline?type=order&id=' + orderId, null, aToken)
    const adminEv = tl2.data.events.filter((e) => e.actor_type === 'admin')
    assert(adminEv.length >= 1, '管理员引发的迁移署名为 admin（' + adminEv.length + ' 条）')
    assert(adminEv.some((e) => Number(e.to_status) === 5), '署名 admin 的事件为 → 已取消(5)')
    assert(Number(adminEv[0].from_status) === 2, '事件带变更前状态 from_status=2（证明采集器观察到了 2→5 的迁移）')
    assert(String(adminEv[0].note || '').indexOf('取消') >= 0, '事件带管理员操作说明：' + adminEv[0].note)

    // ---------- ④ 批次时间线合并批内订单事件 ----------
    const tlb = await adminApi('GET', '/admin/timeline?type=batch&id=' + batchId, null, aToken)
    assert(tlb.code === 0 && tlb.data, '批次时间线接口可用')
    assert(tlb.data.events.length >= 1, '批次时间线含事件（' + tlb.data.events.length + ' 条）')
    assert(tlb.data.events.some((e) => e.order_short), '订单事件带 order_short 归属标记')
    assert(tlb.data.context && Number(tlb.data.context.order_count) >= 1, '批次上下文含订单数')

    // ---------- ⑤ 老数据（无事件）→ 推断节点 ----------
    db.prepare(`INSERT INTO orders (order_no,status,landmark_name,total_amount,created_at,delivered_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run('LD-OLD-0001', 4, '东苑9栋', 8.8, '2026-01-01 09:00:00', '2026-01-01 09:20:00', '2026-01-01 09:30:00')
    const oldId = db.prepare("SELECT id FROM orders WHERE order_no='LD-OLD-0001'").get().id
    const tlo = await adminApi('GET', '/admin/timeline?type=order&id=' + oldId, null, aToken)
    assert(tlo.code === 0 && tlo.data.events.length === 0, '老数据无真实事件')
    assert(tlo.data.legacy.length >= 2, '老数据返回推断节点（' + tlo.data.legacy.length + ' 个）')
    assert(tlo.data.legacy[0].label === '创建订单', '推断节点首个为「创建订单」')
    assert(String(tlo.data.legacy[0].at) <= String(tlo.data.legacy[1].at), '推断节点按时间升序')

    // ---------- ⑥ 参数校验 ----------
    const badType = await adminApi('GET', '/admin/timeline?type=nope&id=1', null, aToken)
    assert(badType.code === 400, '非法 type 返回 400')
    const noId = await adminApi('GET', '/admin/timeline?type=order&id=0', null, aToken)
    assert(noId.code === 400, '缺少 id 返回 400')
    const notFound = await adminApi('GET', '/admin/timeline?type=order&id=999999', null, aToken)
    assert(notFound.code === 404, '不存在的实体返回 404')

    console.log(bad ? '\n=== 状态流水测试失败 ' + bad + ' 项 ===' : '\n✅ 状态流水测试全部通过')
  } catch (e) {
    console.error('\n❌ 测试异常：' + (e && e.stack || e))
    bad++
  } finally {
    try { if (db) db.close() } catch (e) {}
    if (child) { try { child.kill() } catch (e) {} }
    await new Promise((r) => setTimeout(r, 400))
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f) } catch (e) {} }
    process.exit(bad ? 1 : 0)
  }
})()
