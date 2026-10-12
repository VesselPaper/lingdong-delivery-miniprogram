// 商家端「订单异常管理」清理流程测试（Mock 模式 + 临时库 + 独立端口）
// 用法：node test_order_admin_clear.js
//
// 覆盖（2026-10-12 负责人定的口径：清理订单=驳回任务+付款退款+用户端显示「订单异常」）：
//   ① 店员调用清理接口 → 403（ownerGuard）
//   ② 店长清理已付款订单 → 订单置 7 已退款、cancel_note=订单异常、任务作废、库存回补、退款单落账
//   ③ 店长清理未付款订单 → 订单置 5 已取消、cancel_note=订单异常
//   ④ 用户端订单详情显示「订单异常（已退款/已取消）」，不出现"管理员删除"
//   ⑤ 终态订单（已完成）→ 400 拒绝
//   ⑥ 批次清理：批内已付款订单逐单退款 + cancel_note
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3106
const TMP_DB = path.join(os.tmpdir(), 'lingdong_clear_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'

let child = null
let db = null

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
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
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))

let bad = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✘ ' + msg); bad++ } else { console.log('  ✔ ' + msg) }
}

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    const adminAuth = require('../services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    // 店长（owner）+ 店员（staff），都用可登录密码
    boot.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'测试店主')")
      .run('testowner', adminAuth.hashPassword('test123456'))
    boot.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','staff',1,'测试店员')")
      .run('teststaff', adminAuth.hashPassword('test123456'))
    boot.close()
    db = new DatabaseSync(TMP_DB)

    const owner = await api('POST', '/auth/login', { username: 'testowner', password: 'test123456', client: 'merchant', nickname: '测试店主' })
    const staff = await api('POST', '/auth/login', { username: 'teststaff', password: 'test123456', client: 'merchant', nickname: '测试店员' })
    const stu = await api('POST', '/auth/login', { code: 'student-c-' + Date.now(), role: 'student', nickname: '测试学生' })
    const oToken = owner.data.token
    const fToken = staff.data.token
    const sToken = stu.data.token
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, oToken)

    // ---------- ① 店员无权限 ----------
    const c0 = await api('POST', '/order/create', {
      landmark_id: 2, landmark_name: '东苑1栋', contact_name: '测试学生', contact_phone: '13800138000',
      items: [{ goods_id: 1, quantity: 1 }]
    }, sToken)
    const oid0 = c0.data.order_id
    const rStaff = await api('POST', '/merchant/admin/order/clear', { order_id: oid0 }, fToken)
    assert(rStaff.code === 403, '店员调用清理接口 → 403（实际 code=' + rStaff.code + '）')

    // ---------- ② 店长清理已付款订单（退款 + 订单异常） ----------
    const c1 = await api('POST', '/order/create', {
      landmark_id: 2, landmark_name: '东苑1栋', contact_name: '测试学生', contact_phone: '13800138000',
      items: [{ goods_id: 1, quantity: 1 }]
    }, sToken)
    const oid1 = c1.data.order_id
    await api('POST', '/order/pay', { id: oid1 }, sToken)
    const st1 = db.prepare('SELECT status, batch_id FROM orders WHERE id=?').get(oid1)
    assert(Number(st1.status) === 2, '订单支付后为配送中(2)，并入批次 #' + st1.batch_id)
    // 先定型派车（生成配送任务），再清理 → 验证「驳回进行中的任务」
    const disp = await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: st1.batch_id }, oToken)
    assert(disp.code === 0, '批次定型派车成功（生成配送任务）')
    const task1 = db.prepare("SELECT id, task_status FROM delivery_tasks WHERE order_id=? ORDER BY id DESC LIMIT 1").get(oid1)
    assert(!!task1 && Number(task1.task_status) < 80, '订单有进行中的配送任务（task_status=' + (task1 && task1.task_status) + '）')

    const r1 = await api('POST', '/merchant/admin/order/clear', { order_id: oid1 }, oToken)
    assert(r1.code === 0 && r1.data.status === 7, '店长清理已付款订单 → 已退款(7)')
    assert(String(r1.data.msg || '').indexOf('订单异常') >= 0, '返回文案含「订单异常」')
    const row1 = db.prepare('SELECT status, cancel_note, batch_removed_at, stock_restored_at FROM orders WHERE id=?').get(oid1)
    assert(row1.cancel_note === '订单异常', 'cancel_note=订单异常')
    assert(!!row1.batch_removed_at && !!row1.stock_restored_at, '批次摘除 + 库存回补已执行')
    const voided1 = db.prepare("SELECT COUNT(*) c FROM delivery_tasks WHERE order_id=? AND void_at IS NOT NULL AND task_status=110").get(oid1)
    assert(Number(voided1.c) >= 1, '订单任务已作废（驳回进行中的任务）')
    const ref1 = db.prepare('SELECT COUNT(*) c FROM refunds WHERE order_id=?').get(oid1)
    assert(Number(ref1.c) >= 1, '退款单已落账')

    // 用户端订单详情文案
    const ud1 = await api('GET', '/order/detail?id=' + oid1, null, sToken)
    assert(ud1.data.status_text === '订单异常（已退款）', '用户端显示「订单异常（已退款）」，实际=' + ud1.data.status_text)

    // ---------- ③ 清理未付款订单（仅取消） ----------
    const c2 = await api('POST', '/order/create', {
      landmark_id: 2, landmark_name: '东苑1栋', contact_name: '测试学生', contact_phone: '13800138000',
      items: [{ goods_id: 1, quantity: 1 }]
    }, sToken)
    const oid2 = c2.data.order_id
    const r2 = await api('POST', '/merchant/admin/order/clear', { order_id: oid2 }, oToken)
    assert(r2.code === 0 && r2.data.status === 5, '清理未付款订单 → 已取消(5)')
    const row2 = db.prepare('SELECT status, cancel_note FROM orders WHERE id=?').get(oid2)
    assert(Number(row2.status) === 5 && row2.cancel_note === '订单异常', '未付款订单置 5 + cancel_note=订单异常')
    const ud2 = await api('GET', '/order/detail?id=' + oid2, null, sToken)
    assert(ud2.data.status_text === '订单异常（已取消）', '用户端显示「订单异常（已取消）」')

    // ---------- ④ 终态订单拒绝 ----------
    db.prepare('UPDATE orders SET status=4 WHERE id=?').run(oid2)
    const r4 = await api('POST', '/merchant/admin/order/clear', { order_id: oid2 }, oToken)
    assert(r4.code === 400, '终态订单（已完成）→ 400 拒绝')

    // ---------- ⑤ 批次清理：批内已付款订单逐单退款 ----------
    const c5 = await api('POST', '/order/create', {
      landmark_id: 2, landmark_name: '东苑1栋', contact_name: '测试学生', contact_phone: '13800138000',
      items: [{ goods_id: 1, quantity: 1 }, { goods_id: 2, quantity: 1 }]
    }, sToken)
    const oid5 = c5.data.order_id
    await api('POST', '/order/pay', { id: oid5 }, sToken)
    const b5 = db.prepare('SELECT batch_id FROM orders WHERE id=?').get(oid5).batch_id
    assert(!!b5, '订单并入批次 #' + b5)
    const rb = await api('POST', '/merchant/delivery/batch/delete', { batch_id: b5 }, oToken)
    assert(rb.code === 0 && Number(rb.data.cancelled) >= 1, '店长清理批次成功（cancelled=' + rb.data.cancelled + '）')
    const row5 = db.prepare('SELECT status, cancel_note FROM orders WHERE id=?').get(oid5)
    assert(Number(row5.status) === 7 && row5.cancel_note === '订单异常', '批内已付款订单 → 7 已退款 + cancel_note=订单异常')
    const ref5 = db.prepare('SELECT COUNT(*) c FROM refunds WHERE order_id=?').get(oid5)
    assert(Number(ref5.c) >= 1, '批内订单退款单已落账')

    console.log(bad ? '\n=== 订单异常清理测试失败 ' + bad + ' 项 ===' : '\n✅ 订单异常清理测试全部通过')
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
