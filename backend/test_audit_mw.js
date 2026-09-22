// 审计中间件冒烟测试（Mock 模式 + 临时库 + 独立端口，不影响真实环境）
// 用法：node test_audit_mw.js
//
// 覆盖（对应方案 §5.2 / §8.1）：
//   ① 写接口自动进审计（handler 没有显式调用 audit() 也要留痕）
//   ② 失败请求同样留痕，且 ok=0、detail 取响应 msg
//   ③ 只读请求（GET）不留痕
//   ④ AUDIT_EXCLUDE_PREFIXES 里的高频写路径不留痕
//   ⑤ handler 的 audit() 标注（action/target/detail）生效
//   ⑥ 身份与来源字段：user_role / user_id / status / ip / ms
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3101
const TMP_DB = path.join(os.tmpdir(), 'lingdong_audit_' + Date.now() + '.db')
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

let bad = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✘ ' + msg); bad++ } else { console.log('  ✔ ' + msg) }
}

const auditAll = () => db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
const auditCount = () => db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
const lastAudit = () => db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1').get()

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    // 建管理员账号（独立连接直连临时库，避免测试进程再跑一遍 init/seed）
    const adminAuth = require('./services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    adminAuth.createAdmin(boot, { username: ADMIN_USER, password: ADMIN_PASS, nickname: '测试管理员' })
    boot.close()
    db = new DatabaseSync(TMP_DB)

    // 登录
    const mer = await api('POST', '/auth/login', { code: 'merchant-a-' + Date.now(), merchant_code: 'test-invite', nickname: '测试商家' })
    assert(mer.code === 0, '商家登录')
    const mToken = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'student-a-' + Date.now(), role: 'student', nickname: '测试学生' })
    assert(stu.code === 0, '学生登录')
    const sToken = stu.data.token
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mToken)

    const lg = await api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })
    assert(lg.code === 0 && lg.data.token, '管理员登录')
    const aToken = lg.data.token

    // ---------- ③ 只读不留痕 ----------
    const n0 = auditCount()
    await adminApi('GET', '/admin/state', null, aToken)
    await adminApi('GET', '/admin/audit?limit=5', null, aToken)
    assert(auditCount() === n0, '只读请求（GET）不留痕（仍 ' + n0 + ' 条）')

    // ---------- ④ 排除前缀不留痕 ----------
    await api('POST', '/cart/add', { goods_id: 1, quantity: 1 }, sToken)
    assert(auditCount() === n0, '排除前缀 /api/cart 的写请求不留痕')

    // ---------- ① 自动覆盖：/order/create 没有显式 audit() ----------
    const c = await api('POST', '/order/create', {
      landmark_id: 2, landmark_name: '东苑1栋', contact_name: '测试学生', contact_phone: '13800138000',
      items: [{ goods_id: 1, quantity: 1 }]
    }, sToken)
    assert(c.code === 0, '下单成功 order=' + (c.data && c.data.order_no))
    const orderId = c.data.order_id
    const auto = lastAudit()
    assert(auditCount() > n0, '写接口自动留痕（无需 handler 显式调用 audit()）')
    assert(String(auto.action).indexOf('order/create') >= 0, '自动推导 action：' + auto.action)
    assert(auto.user_role === 'student', '自动识别身份 user_role=student（实际 ' + auto.user_role + '）')
    assert(auto.ok === 1 && auto.status === 200, '成功记录 ok=1 status=200')
    assert(String(auto.ip || '').length > 0, '记录来源 ip=' + auto.ip)
    assert(Number(auto.ms) >= 0, '记录耗时 ms=' + auto.ms)

    // ---------- ② 失败也留痕 ----------
    const n1 = auditCount()
    const badCancel = await adminApi('POST', '/admin/order/cancel', { order_id: 999999 }, aToken)
    assert(badCancel.code === 404, '不存在的订单返回 404')
    assert(auditCount() === n1 + 1, '失败请求也留痕')
    const failRow = lastAudit()
    assert(failRow.ok === 0 && failRow.status === 404, '失败记录 ok=0 status=404')
    assert(failRow.detail === '订单不存在', '失败 detail 取响应 msg（实际「' + failRow.detail + '」）')
    assert(failRow.user_role === 'admin', '失败记录身份为 admin')

    // ---------- ⑤ audit() 标注生效（真实订单由管理员取消） ----------
    await api('POST', '/order/pay', { id: orderId }, sToken)
    const okCancel = await adminApi('POST', '/admin/order/cancel', { order_id: orderId }, aToken)
    assert(okCancel.code === 0, '管理员取消订单成功')
    const ann = lastAudit()
    assert(ann.action === 'admin/order-cancel', '标注 action 生效：' + ann.action)
    assert(ann.target === 'order#' + orderId, '标注 target 生效：' + ann.target)
    assert(String(ann.detail).indexOf('取消') >= 0, '标注 detail 生效：' + ann.detail)
    assert(ann.ok === 1 && ann.status === 200, '成功记录 ok=1 status=200')

    // ---------- ⑥ 分页/筛选接口可用 ----------
    const list = await adminApi('GET', '/admin/audit?role=admin&limit=5', null, aToken)
    assert(list.code === 0 && Array.isArray(list.data.rows), '审计查询接口返回 rows')
    assert(list.data.total >= 3, '默认只统计管理员审计（total=' + list.data.total + '）')
    const onlyFail = await adminApi('GET', '/admin/audit?role=admin&ok=0', null, aToken)
    assert(onlyFail.data.rows.every((r) => Number(r.ok) === 0), '按结果筛选（只看失败）生效')
    const allRole = await adminApi('GET', '/admin/audit?role=all&limit=100', null, aToken)
    assert(allRole.data.total > list.data.total, 'role=all 能看到学生端写操作（' + allRole.data.total + ' > ' + list.data.total + '）')

    console.log(bad ? '\n=== 审计中间件测试失败 ' + bad + ' 项 ===' : '\n✅ 审计中间件测试全部通过')
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
