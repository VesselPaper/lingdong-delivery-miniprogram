// 「取消机器人全部任务」冒烟测试（Mock 模式 + 临时库 + 独立端口）
// 用法：node test_cancel_tasks.js
//
// 覆盖（对应方案 §5.3 / §8.1，2026-10-12 起语义为「未送达单取消并自动退款」）：
//   ① 枚举该设备任务（平台查询失败时回退本地活跃任务）
//   ② 关联本地订单走统一落账：未送达订单置**已退款(7)** + 写自动售后记录 + 回补库存 + 摘批次
//   ③ 该设备涉及的活跃批次置 4
//   ④ 逐项容错：返回 failed 数组
//   ⑤ 缺设备编号 → 400，且审计留下失败记录（ok=0）
//   ⑥ 成功调用在审计里留痕（action=admin/robot-cancel-tasks）
//   ⑦ 已送达(3) 的订单**不参与自动退款**（订单与任务原样保留，交取餐超时流程）
//   ⑧ dry_run 预演只回计划（单数/金额/已送达单数），不改任何数据
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3103
const TMP_DB = path.join(os.tmpdir(), 'lingdong_canceltasks_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const ADMIN_USER = 'testadmin'
const ADMIN_PASS = 'testpass12345'

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

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    const adminAuth = require('../services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    adminAuth.createAdmin(boot, { username: ADMIN_USER, password: ADMIN_PASS, nickname: '测试管理员' })
    // 商家账号（2026-09-24 起：账号密码登录 + 店主角色）
    boot.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'测试商家')")
      .run('testmerchant', adminAuth.hashPassword('test123456'))
    boot.close()
    db = new DatabaseSync(TMP_DB)

    const mer = await api('POST', '/auth/login', { username: 'testmerchant', password: 'test123456', client: 'merchant', nickname: '测试商家' })
    const mToken = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'student-x-' + Date.now(), role: 'student', nickname: '测试学生' })
    const sToken = stu.data.token
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mToken)
    const lg = await api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })
    const aToken = lg.data.token
    assert(lg.code === 0 && aToken, '管理员登录')

    // ---------- ⑤ 缺设备编号 → 400 且审计记失败 ----------
    const nBefore = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
    const noSn = await adminApi('POST', '/admin/robot/cancel-tasks', {}, aToken)
    assert(noSn.code === 400, '缺设备编号返回 400')
    const failRow = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1').get()
    assert(db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c === nBefore + 1, '失败调用也留痕')
    assert(failRow.ok === 0 && failRow.detail === '缺少设备编号', '失败审计 ok=0 detail=「' + failRow.detail + '」')

    // ---------- 造 3 单 + 派车（第 3 单随后置为「已送达」，用来验证不自动退款） ----------
    const g0 = (await api('GET', '/merchant/goods', null, mToken)).data.find((x) => x.id === 1)
    const stock0 = Number(g0.stock)
    const created = []
    for (const lm of [2, 3, 4]) {
      const c = await api('POST', '/order/create', {
        landmark_id: lm, landmark_name: '点位' + lm, contact_name: '测试学生', contact_phone: '13800138000',
        items: [{ goods_id: 1, quantity: 1 }]
      }, sToken)
      assert(c.code === 0, '下单 order=' + c.data.order_no)
      created.push(c.data.order_id)
      await api('POST', '/order/pay', { id: c.data.order_id }, sToken)
    }
    const stockAfterCreate = Number((await api('GET', '/merchant/goods', null, mToken)).data.find((x) => x.id === 1).stock)
    assert(stockAfterCreate === stock0 - 3, '下单扣库存：' + stock0 + '→' + stockAfterCreate)

    const batchId = db.prepare('SELECT batch_id FROM orders WHERE id=?').get(created[0]).batch_id
    // 演示档（PLATFORM_MOCK=true）不做设备选择（pickAvailableRobot 在 mock 下返回 null），
    // 因此显式传 device_sn 给派车接口 —— 这也正是本用例要覆盖的「按设备取消全部任务」前提。
    const SN = 'MOCK-SN-CANCEL-1'
    const disp = await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: batchId, device_sn: SN }, mToken)
    assert(disp.code === 0 && disp.data.status === 1, '批次派车成功 → 待上货')
    const brow = db.prepare('SELECT device_sn, status FROM delivery_batches WHERE id=?').get(batchId)
    assert(brow.device_sn === SN, '批次已指派设备 device_sn=' + brow.device_sn)
    const sn = brow.device_sn

    // 第 3 单置为「已送达」：验证「已送达的单不参与自动退款」（餐已在舱内/用户手上，退了就是白送）
    const deliveredId = created[2]
    db.prepare("UPDATE orders SET status=3, delivered_at=datetime('now','localtime') WHERE id=?").run(deliveredId)
    assert(Number(db.prepare('SELECT status FROM orders WHERE id=?').get(deliveredId).status) === 3, '第 3 单已置为已送达(3)')

    // ---------- ⑧ dry_run 预演：只回计划，不改任何数据 ----------
    const expectAmount = Number(db.prepare('SELECT ROUND(SUM(total_amount),2) s FROM orders WHERE id IN (?,?)').get(created[0], created[1]).s)
    const refundsBefore = db.prepare('SELECT COUNT(*) c FROM refunds').get().c
    const dry = await adminApi('POST', '/admin/robot/cancel-tasks', { device_sn: sn, dry_run: true }, aToken)
    assert(dry.code === 0 && dry.data.dry_run === true, 'dry_run 返回预演结果')
    assert(dry.data.refundable === 2, '预演：可取消并退款 2 单（实际 ' + dry.data.refundable + '）')
    assert(dry.data.delivered === 1, '预演：已送达 1 单不退款（实际 ' + dry.data.delivered + '）')
    assert(Math.abs(Number(dry.data.refund_amount) - expectAmount) < 0.01,
      '预演退款合计 ¥' + dry.data.refund_amount + '（期望 ¥' + expectAmount + '）')
    assert(db.prepare('SELECT COUNT(*) c FROM refunds').get().c === refundsBefore, '预演不写售后记录')
    assert(Number(db.prepare('SELECT status FROM orders WHERE id=?').get(created[0]).status) !== 7, '预演不改变订单状态')

    // ---------- ①②③④⑦ 取消该设备全部任务（未送达单 → 取消并自动退款） ----------
    const out = await adminApi('POST', '/admin/robot/cancel-tasks', { device_sn: sn }, aToken)
    assert(out.code === 0, '取消机器人全部任务返回成功')
    assert(Array.isArray(out.data.failed), '返回 failed 数组（逐项容错）')
    assert(out.data.cancelled === 2, '未送达订单 2 单取消并退款（实际 ' + out.data.cancelled + '）')
    assert(out.data.skipped_delivered === 1, '已送达 1 单被跳过（实际 ' + out.data.skipped_delivered + '）')
    assert(Math.abs(Number(out.data.refund_amount) - expectAmount) < 0.01, '退款合计 ¥' + out.data.refund_amount)
    assert(out.data.batch_cleaned >= 1, '涉及批次被清理（' + out.data.batch_cleaned + ' 个）')
    assert(!!out.data.source, '返回任务枚举来源 source=' + out.data.source)

    const oStatus = created.map((id) => Number(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status))
    assert(oStatus[0] === 7 && oStatus[1] === 7, '未送达订单置已退款(7)：' + oStatus.join(','))
    assert(oStatus[2] === 3, '已送达订单保持已送达(3)、未被退款：' + oStatus[2])

    // 自动售后记录：用户端「退款」列表就靠它看到「为什么被取消」
    const rf = db.prepare('SELECT * FROM refunds WHERE order_id IN (?,?) ORDER BY id').all(created[0], created[1])
    assert(rf.length === 2, '写了 2 条自动售后记录（实际 ' + rf.length + '）')
    assert(rf.every((r) => Number(r.status) === 3 && r.type === 'refund'), '售后记录均为「已退款」状态')
    assert(rf.every((r) => String(r.reason).indexOf('小车') >= 0), '售后原因含「小车」：' + rf.map((r) => r.reason).join(' / '))
    assert(db.prepare('SELECT COUNT(*) c FROM refunds WHERE order_id=?').get(deliveredId).c === 0, '已送达订单没有售后记录')

    // 已送达单的任务不被作废（留给取餐超时流程收尾）
    const dtask = db.prepare('SELECT void_at FROM delivery_tasks WHERE order_id=?').get(deliveredId)
    assert(!dtask || !dtask.void_at, '已送达订单的任务未被作废')

    const bStatus = Number(db.prepare('SELECT status FROM delivery_batches WHERE id=?').get(batchId).status)
    assert(bStatus === 4, '批次置已取消(4)：' + bStatus)

    const stockAfter = Number((await api('GET', '/merchant/goods', null, mToken)).data.find((x) => x.id === 1).stock)
    assert(stockAfter === stock0 - 1,
      '退款单回补库存、已送达单不回补：' + stockAfterCreate + '→' + stockAfter + '（基线 ' + stock0 + '，差额=未取餐的 1 单）')

    // 摘批次：orders.batch_id 保留为历史引用，改由 batch_removed_at 标记已摘除，并扣回批次计数
    const removed = db.prepare('SELECT COUNT(*) c FROM orders WHERE batch_id=? AND batch_removed_at IS NOT NULL').get(batchId).c
    assert(removed === 2, '未送达 2 单已摘批次（batch_removed_at 已写 ' + removed + '/2）')
    const cnt = db.prepare('SELECT total_orders, total_items FROM delivery_batches WHERE id=?').get(batchId)
    assert(Number(cnt.total_orders) === 1 && Number(cnt.total_items) === 1,
      '批次计数只扣回未送达 2 单，已送达 1 单仍挂在批次上（orders=' + cnt.total_orders + ' items=' + cnt.total_items + '）')

    // ---------- ⑥ 成功调用留痕 ----------
    const okRow = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1').get()
    assert(okRow.action === 'admin/robot-cancel-tasks', '成功审计 action=' + okRow.action)
    assert(okRow.ok === 1 && okRow.target === 'device#' + sn, '成功审计 ok=1 target=' + okRow.target)

    // 幂等：再调一次不应报错（此时已无活跃订单）
    const again = await adminApi('POST', '/admin/robot/cancel-tasks', { device_sn: sn }, aToken)
    assert(again.code === 0 && again.data.cancelled === 0, '重复调用安全（无活跃订单时 cancelled=0）')

    console.log(bad ? '\n=== 取消全部任务测试失败 ' + bad + ' 项 ===' : '\n✅ 取消全部任务测试全部通过')
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
