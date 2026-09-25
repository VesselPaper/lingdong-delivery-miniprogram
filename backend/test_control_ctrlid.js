// 控制权 ctrlId 持久化冒烟测试（Mock 模式 + 临时库 + 独立端口）
// 用法：node test_control_ctrlid.js
//
// 覆盖（对应方案 §5.5）：
//   ① 获取控制权后，平台返回的 ctrlId 被持久化到 meta['ctrl_id:<sn>']
//   ② 释放控制权时 ctrl_id 可省 —— 自动读 meta 中的值（修掉原先必须人工输入 ID 的缺陷）
//   ③ 释放成功后清掉 meta 键；再释放则明确报错而不是静默失败
//   ④ 两次调用都在审计里留痕
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3104
const TMP_DB = path.join(os.tmpdir(), 'lingdong_ctrl_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const ADMIN_USER = 'testadmin'
const ADMIN_PASS = 'testpass12345'
const SN = 'MOCK-SN-CTRL-1'

let child = null
let db = null

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true', LINGDONG_DB: TMP_DB,
        PAY_MOCK: 'true', BATCH_WAIT_MS: '100000',
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
const metaOf = (k) => { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : null }
const lastAudit = () => db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1').get()

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    const adminAuth = require('./services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    adminAuth.createAdmin(boot, { username: ADMIN_USER, password: ADMIN_PASS, nickname: '测试管理员' })
    boot.close()
    db = new DatabaseSync(TMP_DB)

    const lg = await api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })
    const aToken = lg.data.token
    assert(lg.code === 0 && aToken, '管理员登录')

    const key = 'ctrl_id:' + SN
    assert(metaOf(key) === null, '初始状态：meta 中没有该设备的控制权记录')

    // ---------- ① 获取控制权 → 持久化 ctrlId ----------
    const g = await adminApi('POST', '/admin/control/grant', { device_sn: SN }, aToken)
    assert(g.code === 0, '获取控制权成功')
    assert(g.data && g.data.data && !!g.data.data.ctrlId, '平台返回了 ctrlId（mock 档为 mock-ctrl）')
    assert(metaOf(key) === 'mock-ctrl', '① ctrlId 已持久化到 meta[' + key + ']（实际 ' + metaOf(key) + '）')
    assert(lastAudit().action === 'admin/control-grant', '获取控制权已留痕：' + lastAudit().action)
    assert(lastAudit().ok === 1, '获取控制权审计 ok=1')

    // ---------- ② 释放控制权：不传 ctrl_id 也能成功 ----------
    const r1 = await adminApi('POST', '/admin/control/release', { device_sn: SN }, aToken)
    assert(r1.code === 0, '② 不传 ctrl_id 即可释放（自动读 meta）')
    assert(lastAudit().action === 'admin/control-release' && lastAudit().ok === 1, '释放控制权已留痕且成功')

    // ---------- ③ 释放后清键；再释放明确报错 ----------
    assert(metaOf(key) === null, '③ 释放成功后 meta 键已清除')
    const r2 = await adminApi('POST', '/admin/control/release', { device_sn: SN }, aToken)
    assert(r2.code === 400, '再次释放返回 400')
    assert(String(r2.msg).indexOf('缺少控制权ID') >= 0, '错误文案明确：' + r2.msg)
    assert(lastAudit().ok === 0 && lastAudit().detail === r2.msg, '失败也留痕且 detail 取响应 msg')

    // ---------- ④ 显式传 ctrl_id 仍然可用（兼容旧调用） ----------
    await adminApi('POST', '/admin/control/grant', { device_sn: SN }, aToken)
    const r3 = await adminApi('POST', '/admin/control/release', { device_sn: SN, ctrl_id: 'explicit-id' }, aToken)
    assert(r3.code === 0, '显式传 ctrl_id 仍然可用（兼容旧调用）')
    assert(metaOf(key) === null, '显式释放后 meta 键同样被清除')

    console.log(bad ? '\n=== 控制权持久化测试失败 ' + bad + ' 项 ===' : '\n✅ 控制权持久化测试全部通过')
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
