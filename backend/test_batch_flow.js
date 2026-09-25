// 一车多单批次流程端到端冒烟测试（Mock 模式 + 临时库，不影响真实环境）
// 用法：node test_batch_flow.js   （自动起临时 server、跑流程、清理）
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT = 3100
const TMP_DB = path.join(os.tmpdir(), 'lingdong_test_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'

let child = null
function startServer() {
  return new Promise((resolve, reject) => {
    // 商家账号体系（2026-09-24 起：账号密码登录）：回归用的 testmerchant 账号以「用户名+scrypt密码」预置进临时库
    try {
      const { DatabaseSync } = require('node:sqlite')
      const adminAuth = require('./services/adminAuth')
      const db0 = new DatabaseSync(TMP_DB)
      db0.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT UNIQUE, nickname TEXT, avatar TEXT, phone TEXT,
        role TEXT DEFAULT 'student', landmark_id TEXT DEFAULT '', landmark_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        username TEXT UNIQUE, password_hash TEXT, merchant_role TEXT DEFAULT '', token TEXT, status INTEGER DEFAULT 1)`)
      // 预置 meta 标记，避免 db.js 的 merchant_role_reset_at 一次性修正把预置账号降回 student
      db0.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
      db0.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('merchant_role_reset_at', datetime('now','localtime'))").run()
      db0.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'测试商家')")
        .run('testmerchant', adminAuth.hashPassword('test123456'))
      db0.close()
    } catch (e) { /* 预置失败不阻断 */ }
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true', LINGDONG_DB: TMP_DB, PAY_MOCK: 'true', BATCH_WAIT_MS: '100000', WX_APPID: '', WX_SECRET: '', MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: '', SUMMON_DELIVERY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    const t0 = Date.now()
    const timer = setInterval(async () => {
      try {
        const r = await fetch(BASE + '/shop/status')
        if (r.ok) { clearInterval(timer); resolve(); }
      } catch (e) { /* not up yet */ }
      if (Date.now() - t0 > 15000) { clearInterval(timer); reject(new Error('server start timeout\n' + log)); }
    }, 300)
  })
}

async function api(method, pathname, body, token) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const j = await res.json().catch(() => ({}))
  return j
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg)
  console.log('  ✔ ' + msg)
}

(async () => {
  let fail = false
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    // 登录：商家 + 学生
    const mer = await api('POST', '/auth/login', { username: 'testmerchant', password: 'test123456', client: 'merchant', nickname: '测试商家' })
    assert(mer.code === 0, '商家登录（账号密码）')
    const mToken = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'student-test-' + Date.now(), role: 'student', nickname: '测试学生' })
    assert(stu.code === 0, '学生登录')
    const sToken = stu.data.token
    assert(stu.data.runtime && stu.data.runtime.pay_mock === true && stu.data.runtime.login === 'demo', '登录响应含运行时标志（pay_mock/login=demo，无真实凭据时）')

    // 确保营业 + 自动接单开
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mToken)

    // 建 3 单（不同点位），支付 → 自动接单并入批次
    const lm2 = 2, lm3 = 3, lm4 = 4 // 东苑1/2/3栋
    const created = []
    // 库存/销量基线：真实商品导入后按当前值自适应（不再写死 100/326）
    const g0 = (await api('GET', '/merchant/goods', null, mToken)).data.find((x) => x.id === 1)
    const stock0 = Number(g0.stock)
    const sales0 = Number(g0.sales)
    for (const lm of [lm2, lm3, lm4, lm2]) {
      const c = await api('POST', '/order/create', { landmark_id: lm, landmark_name: '点位' + lm, contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sToken)
      assert(c.code === 0, '下单 order=' + c.data.order_no)
      created.push(c.data.order_id)
      const p = await api('POST', '/order/pay', { id: c.data.order_id }, sToken)
      assert(p.code === 0, '支付 order=' + c.data.order_id + ' auto=' + (p.data.auto_accept ? 'yes' : 'no'))
    }

    // 商品库存/销量（收货完成才结算销量，下单仅扣库存；基线按当前真实商品自适应）
    const goodsBefore = await api('GET', '/merchant/goods', null, mToken)
    const g1 = goodsBefore.data.find((x) => x.id === 1)
    assert(Number(g1.stock) === stock0 - 4, '下单扣库存：商品1 ' + stock0 + '→' + (stock0 - 4) + '（4单各1）')
    assert(Number(g1.sales) === sales0, '下单不结算销量：商品1 sales 仍为 ' + sales0)

    // 商品分类接口
    const cats = await api('GET', '/merchant/goods/categories', null, mToken)
    assert(cats.code === 0 && cats.data.length > 0 && cats.data.indexOf('即食卤味') > -1, '商品分类列表可用（真实商品分类）')

    // 库存接口：标记售空=0 必须保留 0（修复「设0变999」），再恢复
    const s0 = await api('PUT', '/merchant/goods/stock', { id: 5, stock: 0 }, mToken)
    assert(s0.code === 0 && Number(s0.data.stock) === 0, '标记售空：商品5 库存=0（不回落 999）')
    await api('PUT', '/merchant/goods/stock', { id: 5, stock: 200 }, mToken)

    // 批次列表：应有一个组单中批次，4 单
    const pend = await api('GET', '/merchant/device/pending', null, mToken)
    assert(pend.code === 0, '获取待上货批次')
    const open = pend.data.open_batches || []
    assert(open.length === 1, '有 1 个组单中批次')
    const batchId = open[0].id
    assert(Number(open[0].total_orders) === 4, '批次内 4 单')

    // 商家订单确认接口也应可用（手动接单路径，已并入批次）
    // 派车
    const disp = await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: batchId }, mToken)
    assert(disp.code === 0, '批次派车成功')
    assert(disp.data.status === 1, '批次状态→待上货')
    assert(disp.data.orders.length === 4, '批次含 4 单')

    // 每单应有独立取餐码且互不相同
    const codes = disp.data.orders.map((o) => o.pickup_code)
    assert(new Set(codes).size === codes.length, '每单独立取餐码且互不相同: ' + codes.join(','))
    const taskIds = disp.data.orders.map((o) => o.task && o.task.id)
    assert(taskIds.every(Boolean), '每单已创建配送任务')
    assert('items' in disp.data.orders[0] && Array.isArray(disp.data.orders[0].items) && disp.data.orders[0].items.length >= 1, '批次订单含 items 商品明细（上货页逐商品展示）')
    assert(Number(disp.data.daily_seq) >= 1, '批次当日序号（批次 ' + disp.data.daily_seq + '）')

    // 任务页 stage 过滤：待上货（批次未派车/待上货的订单）
    const stageLoad = await api('GET', '/merchant/orders?stage=load', null, mToken)
    const inLoad = stageLoad.data.find((o) => created.indexOf(o.id) > -1)
    assert(!!inLoad, '任务页「待上货」分类可过滤出本批订单')
    assert(Array.isArray(inLoad.items) && inLoad.items.length >= 1 && inLoad.batch && inLoad.batch.batch_no, '商家订单列表含 items 与所属批次')

    // 模拟扫码识别机器人
    const scan = await api('POST', '/merchant/device/scan', { deviceSn: 'TESTROBOT001' }, mToken)
    console.log('    RAW scan resp: ' + JSON.stringify(scan).slice(0, 400))
    assert(scan.code === 0, '扫码识别机器人')
    assert(scan.data.batch_id === batchId, '扫码定位到正确批次')

    // 批次开舱/关舱/派发
    const openBin = await api('POST', '/merchant/device/batch/open-bin', { batch_id: batchId }, mToken)
    assert(openBin.code === 0, '批次开舱（' + openBin.data.opened + ' 任务验证）')
    const closeBin = await api('POST', '/merchant/device/batch/close-bin', { batch_id: batchId }, mToken)
    assert(closeBin.code === 0, '批次关舱')
    const batchDisp = await api('POST', '/merchant/device/batch/dispatch', { batch_id: batchId }, mToken)
    assert(batchDisp.code === 0, '批次开始配送（' + batchDisp.data.dispatched + ' 任务）')

    // 批次状态应到配送中
    const detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mToken)
    assert(detail.code === 0 && detail.data.status === 2, '批次状态→配送中')
    // 路线在「开始配送（关舱后）」才规划：此时应已有完整停靠顺序
    assert(detail.data.route.length >= 2, '路线含多个停靠点（' + detail.data.route.map((r) => r.landmark_name).join(',') + '）')
    console.log('    路线: ' + detail.data.route.map((r) => r.stop + ':' + r.landmark_name + '(' + r.order_ids.length + '单)').join(' → '))

    // 任务页 stage=deliver（配送中）应过滤出本批订单，且 stage_text=配送中
    const stageDeliver = await api('GET', '/merchant/orders?stage=deliver', null, mToken)
    const inDeliver = stageDeliver.data.filter((o) => created.indexOf(o.id) > -1)
    assert(inDeliver.length === 4, '任务页「配送中」分类=本批 4 单')
    assert(inDeliver.every((o) => o.stage_text === '配送中'), '配送中订单 stage_text=配送中')
    // 路线文本不包含脏占位符（?? 等）
    assert(!/[\?？]/.test(detail.data.route_text || ''), '路线文本已清洗无脏字符: ' + detail.data.route_text)

    // 模拟配送完成整批
    const tc = await api('POST', '/merchant/delivery/test-complete', { batch_id: batchId, status: 3 }, mToken)
    assert(tc.code === 0 && tc.data.count === 4, '测试完成配送整批 4 单')

    // 任务页 stage 过滤：待取货（已送达未取）
    const stagePickup = await api('GET', '/merchant/orders?stage=pickup', null, mToken)
    assert(stagePickup.data.filter((o) => created.indexOf(o.id) > -1).length === 4, '任务页「待取货」分类=已送达 4 单')

    // 用户取餐（其中一单）
    const firstOrder = created[0]
    const tr = await api('GET', '/delivery/track?order_id=' + firstOrder, null, sToken)
    assert(tr.code === 0, '配送追踪')
    assert(tr.data.batch && tr.data.batch.multi_order === true, '追踪返回批次信息（一车多单）')

    // ---- 扫码取餐（需求5）：pickup-by-code 按「无人车 + 取餐码」定位本人待取餐订单 ----
    const firstOrderObj = disp.data.orders.find((o) => Number(o.id) === Number(firstOrder))
    assert(!!firstOrderObj && !!firstOrderObj.pickup_code, '待取餐订单已生成取餐码')
    const pbc = await api('POST', '/delivery/pickup-by-code', { device_sn: 'TESTROBOT001', pickup_code: firstOrderObj.pickup_code }, sToken)
    assert(pbc.code === 0 && Number(pbc.data.order_id) === firstOrder, '扫码输取餐码 → 定位到本人订单')
    const pbcBad = await api('POST', '/delivery/pickup-by-code', { device_sn: 'TESTROBOT001', pickup_code: '000000' }, sToken)
    assert(pbcBad.code === 400, '错误取餐码被拒绝')
    const pbcWrongCar = await api('POST', '/delivery/pickup-by-code', { device_sn: 'OTHERBOT', pickup_code: firstOrderObj.pickup_code }, sToken)
    assert(pbcWrongCar.code === 400, '扫错车（设备不匹配）被拒绝')

    const ps = await api('POST', '/delivery/pickup-scan', { order_id: firstOrder }, sToken)
    assert(ps.code === 0, '取餐扫码')
    const po = await api('POST', '/delivery/pickup-open', { order_id: firstOrder }, sToken)
    assert(po.code === 0, '取餐开舱')
    const pc = await api('POST', '/delivery/pickup-close', { order_id: firstOrder }, sToken)
    assert(pc.code === 0, '取餐关舱（关舱才标记已取走，P1-2）')

    const d1 = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mToken)
    const picked = d1.data.orders.filter((o) => o.picked_up).length
    assert(picked >= 1, '批次至少已取 1 单（picked=' + picked + '，含 mock 自动完成）')

    // 剩余 3 单全部取走 → 批次完成
    for (let i = 1; i < created.length; i++) {
      await api('POST', '/delivery/pickup-open', { order_id: created[i] }, sToken)
      await api('POST', '/delivery/pickup-close', { order_id: created[i] }, sToken)
    }
    const d2 = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mToken)
    assert(d2.data.status === 3, '全部取完 → 批次完成 status=' + d2.data.status_text)

    // 收货完成：已售结算（4 单全部取走 → sales 326+4=330）
    const goodsAfter = await api('GET', '/merchant/goods', null, mToken)
    const g1b = goodsAfter.data.find((x) => x.id === 1)
    assert(Number(g1b.sales) === sales0 + 4, '收货完成结算销量：商品1 sales ' + sales0 + '→' + (sales0 + 4) + '（4 单全取走）')

    // 我的页红点
    const badge = await api('GET', '/user/order/badge', null, sToken)
    assert(badge.code === 0, '订单红点接口可用 unread=' + badge.data.unread)
    const mr = await api('POST', '/user/order/mark-read', {}, sToken)
    assert(mr.code === 0, '订单已读接口可用')

    // ---- 边界：任务直接完成路径（无用户取餐，平台任务 80 直接完成）→ 批次应完成 ----
    const c2 = await api('POST', '/order/create', { landmark_id: lm3, landmark_name: '点位3', contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 2, quantity: 1 }] }, sToken)
    await api('POST', '/order/pay', { id: c2.data.order_id }, sToken)
    const pend2 = await api('GET', '/merchant/device/pending', null, mToken)
    const open2 = (pend2.data.open_batches || []).find((b) => b.id !== batchId)
    assert(!!open2, '第二批次已建立')
    await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: open2.id }, mToken)
    // status=4 直接完成整批（等价任务 80 → 已取走）
    const tc4 = await api('POST', '/merchant/delivery/test-complete', { batch_id: open2.id, status: 4 }, mToken)
    assert(tc4.code === 0, '批次2 直接完成（status=4）')
    const d3 = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + open2.id, null, mToken)
    assert(d3.data.status === 3, '批次2 状态→已完成（任务直接完成路径）')

    // ---- Round3：配送异常订单处理（重新配送 / 取消并退款）+ 模拟派车 ----
    const { DatabaseSync } = require('node:sqlite')
    const tdb = new DatabaseSync(TMP_DB)

    // 新订单 → 置为配送异常(6) → 重新配送
    const ce = await api('POST', '/order/create', { landmark_id: lm3, landmark_name: '点位3', contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sToken)
    assert(ce.code === 0, '异常用例下单')
    await api('POST', '/order/pay', { id: ce.data.order_id }, sToken)
    tdb.prepare('UPDATE orders SET status=6 WHERE id=?').run(ce.data.order_id)
    const rt = await api('POST', '/merchant/order/exception/retry', { order_id: ce.data.order_id }, mToken)
    assert(rt.code === 0 && rt.data.status === 2 && rt.data.batch_id, '异常订单重新配送 → 已并入新批次(' + rt.data.batch_no + ')')

    // 新批次派车 + mock-dispatch 模拟开始配送
    const md = await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: rt.data.batch_id }, mToken)
    assert(md.code === 0 && md.data.status === 1, '重配批次派车成功')
    const mockD = await api('POST', '/merchant/device/batch/mock-dispatch', { batch_id: rt.data.batch_id }, mToken)
    assert(mockD.code === 0 && mockD.data.status === 2, '模拟开始配送 → 批次配送中(测试)')

    // 另一新订单 → 置为配送异常(6) → 取消并退款
    const cf = await api('POST', '/order/create', { landmark_id: lm4, landmark_name: '点位4', contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sToken)
    await api('POST', '/order/pay', { id: cf.data.order_id }, sToken)
    tdb.prepare('UPDATE orders SET status=6 WHERE id=?').run(cf.data.order_id)
    const rf = await api('POST', '/merchant/order/exception/refund', { order_id: cf.data.order_id }, mToken)
    assert(rf.code === 0 && rf.data.status === 7, '异常订单取消并退款 → 已退款')
    const od = await api('GET', '/merchant/order/detail?id=' + cf.data.order_id, null, mToken)
    assert(od.code === 0 && od.data.status === 7, '退款订单详情状态=7')
    // 库存回补：cf 单未售出退款回补，ce 单仍待上货占用 → 商品1 stock=95
    const goodsR = await api('GET', '/merchant/goods', null, mToken)
    const g1r = goodsR.data.find((x) => x.id === 1)
    assert(Number(g1r.stock) === stock0 - 5, '异常退款回补库存：商品1 stock=' + (stock0 - 5) + '（' + stock0 + ' -4主单 -1ce -1cf +1退款回补）')
    tdb.close()

    // ---- 取餐超时（已送达无人取餐）两段式：正在取餐暂停计时 / 一段超时 / 返程再等 / 二段驳回 ----
    // 独立起一个临时 server（端口 3101 + 独立临时库 + 极小超时窗口），用 test-complete 即时送达，不依赖 mock 到达计时。
    const PORT2 = 3101
    const TMP_DB2 = path.join(os.tmpdir(), 'lingdong_pickup_test_' + Date.now() + '.db')
    try { // 商家账号以「用户名+密码」预置进第二临时库（与主流程一致）
      const { DatabaseSync } = require('node:sqlite')
      const adminAuth = require('./services/adminAuth')
      const db0 = new DatabaseSync(TMP_DB2)
      db0.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT UNIQUE, nickname TEXT, avatar TEXT, phone TEXT,
        role TEXT DEFAULT 'student', landmark_id TEXT DEFAULT '', landmark_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        username TEXT UNIQUE, password_hash TEXT, merchant_role TEXT DEFAULT '', token TEXT, status INTEGER DEFAULT 1)`)
      // 预置 meta 标记，避免 merchant_role_reset_at 一次性修正把预置账号降回 student
      db0.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
      db0.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('merchant_role_reset_at', datetime('now','localtime'))").run()
      db0.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'测试商家')")
        .run('testmerchant', adminAuth.hashPassword('test123456'))
      db0.close()
    } catch (e) { /* 忽略 */ }
    const child2 = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, RUN_MODE: 'demo', PORT: String(PORT2), PLATFORM_MOCK: 'true', LINGDONG_DB: TMP_DB2, PAY_MOCK: 'true',
        BATCH_WAIT_MS: '100000', WX_APPID: '', WX_SECRET: '', MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: '',
        PICKUP_TIMEOUT_MS: '1500', PICKUP_RETRY_TIMEOUT_MS: '1500', PICKUP_PICKING_GUARD_MS: '60000', PICKUP_SCAN_MS: '300', BATCH_SCAN_MS: '300', MOCK_ARRIVE_MS: '300', SUMMON_DELIVERY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const BASE2 = 'http://127.0.0.1:' + PORT2 + '/api'
    const api2 = async (method, pathname, body, token) => {
      const res = await fetch(BASE2 + pathname, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return res.json().catch(() => ({}))
    }
    await new Promise((resolve, reject) => {
      let log = ''
      child2.stdout.on('data', (d) => { log += d }); child2.stderr.on('data', (d) => { log += d })
      const t0 = Date.now()
      const timer = setInterval(async () => {
        try { const r = await fetch(BASE2 + '/shop/status'); if (r.ok) { clearInterval(timer); resolve() } } catch (e) {}
        if (Date.now() - t0 > 15000) { clearInterval(timer); reject(new Error('server2 start timeout\n' + log)) }
      }, 300)
    })
    try {
      const m2 = await api2('POST', '/auth/login', { username: 'testmerchant', password: 'test123456', client: 'merchant', nickname: '测试商家' })
      const mTok2 = m2.data.token
      const s2 = await api2('POST', '/auth/login', { code: 'student-pk-' + Date.now(), role: 'student', nickname: '测试学生' })
      const sTok2 = s2.data.token
      await api2('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mTok2)
      const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))
      const orderDetail2 = async (id) => (await api2('GET', '/order/detail?id=' + id, null, sTok2)).data

      // 建单 → 派车 → 开/关舱 → mock 开始配送 → test-complete 即时送达（已送达 3 + delivered_at）
      const mkDelivered = async (lm) => {
        const c = await api2('POST', '/order/create', { landmark_id: lm, landmark_name: '点位' + lm, contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sTok2)
        await api2('POST', '/order/pay', { id: c.data.order_id }, sTok2)
        const pend = await api2('GET', '/merchant/device/pending', null, mTok2)
        const open = (pend.data.open_batches || []).find((b) => Number(b.status) === 0)
        await api2('POST', '/merchant/delivery/batch/dispatch', { batch_id: open.id }, mTok2)
        await api2('POST', '/merchant/device/batch/open-bin', { batch_id: open.id }, mTok2)
        await api2('POST', '/merchant/device/batch/close-bin', { batch_id: open.id }, mTok2)
        await api2('POST', '/merchant/device/batch/dispatch', { batch_id: open.id }, mTok2)
        await api2('POST', '/merchant/delivery/test-complete', { batch_id: open.id, status: 3 }, mTok2)
        return { order_id: c.data.order_id, batch_id: open.id }
      }

      // Case 1：打开舱门=「正在取餐」→ 计时暂停，超时窗口内不误判；关舱 → 已完成
      const o1 = await mkDelivered(2)
      let d1 = await orderDetail2(o1.order_id)
      assert(d1.status === 3 && !!d1.delivered_at, '取餐超时用例：订单已送达且 delivered_at 已写')
      const po = await api2('POST', '/delivery/pickup-open', { order_id: o1.order_id }, sTok2)
      assert(po.code === 0, '取餐超时用例：打开舱门（正在取餐，计时暂停）')
      await waitMs(4200) // 超过 PICKUP_TIMEOUT_MS(1500)+秒级精度余量 仍在取餐
      d1 = await orderDetail2(o1.order_id)
      assert(!!d1.picking_up_at && d1.pickup_timeout_stage === 0 && d1.status === 3, '取餐中计时暂停：超时窗口内未误判（stage=0）')
      const pc = await api2('POST', '/delivery/pickup-close', { order_id: o1.order_id }, sTok2)
      assert(pc.code === 0 && pc.data.status === 4, '取餐中关舱 → 已完成(4)')

      // Case 2：一直不取 → 一段超时(stage=1) → 无其他单 → 返程再等(stage=2) → 二段超时 → 驳回退款(status=7, stage=3)
      const o2 = await mkDelivered(3)
      let d2 = await orderDetail2(o2.order_id)
      assert(d2.status === 3, '取餐超时用例：订单B 已送达未取')
      await waitMs(4200) // 一段(1500)+秒级精度余量 → stage=1 → 无其他单 → 立即返程再等 stage=2
      d2 = await orderDetail2(o2.order_id)
      assert(d2.pickup_timeout_stage >= 2, '一段超时→返程再等：stage≥2（实际 ' + d2.pickup_timeout_stage + '）')
      await waitMs(4200) // 二段(1500)+余量 → 驳回退款
      d2 = await orderDetail2(o2.order_id)
      assert(d2.status === 7 && d2.pickup_timeout_stage === 3, '二段超时→驳回退款：status=7 stage=3')

      // Case 3：同批次两单都不取 → 都一段超时（路线重排不破坏）→ 各自返程再等 → 都驳回（不互相卡死）
      const c3a = await api2('POST', '/order/create', { landmark_id: 2, landmark_name: '点位2', contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sTok2)
      await api2('POST', '/order/pay', { id: c3a.data.order_id }, sTok2)
      const c3b = await api2('POST', '/order/create', { landmark_id: 3, landmark_name: '点位3', contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sTok2)
      await api2('POST', '/order/pay', { id: c3b.data.order_id }, sTok2)
      const pend3 = await api2('GET', '/merchant/device/pending', null, mTok2)
      const open3 = (pend3.data.open_batches || []).find((b) => Number(b.status) === 0)
      assert(open3 && open3.total_orders === 2, '取餐超时用例：同批次并入 2 单')
      await api2('POST', '/merchant/delivery/batch/dispatch', { batch_id: open3.id }, mTok2)
      await api2('POST', '/merchant/device/batch/open-bin', { batch_id: open3.id }, mTok2)
      await api2('POST', '/merchant/device/batch/close-bin', { batch_id: open3.id }, mTok2)
      await api2('POST', '/merchant/device/batch/dispatch', { batch_id: open3.id }, mTok2)
      await api2('POST', '/merchant/delivery/test-complete', { batch_id: open3.id, status: 3 }, mTok2)
      await waitMs(4200)
      const da3 = await orderDetail2(c3a.data.order_id)
      const db3 = await orderDetail2(c3b.data.order_id)
      assert(da3.pickup_timeout_stage >= 1 && db3.pickup_timeout_stage >= 1, '同批次两单未取：均一段超时 stage≥1')
      const det3 = await api2('GET', '/merchant/delivery/batch/detail?batch_id=' + open3.id, null, mTok2)
      assert(Array.isArray(det3.data.route) && det3.data.route.length === 2, '同批次两单：路线重排后仍含 2 站')
      await waitMs(4200)
      const da3b = await orderDetail2(c3a.data.order_id)
      const db3b = await orderDetail2(c3b.data.order_id)
      assert(da3b.status === 7 && db3b.status === 7, '同批次两单未取：最终均驳回退款 status=7（互不卡死）')

      child2.kill()
      try { fs.unlinkSync(TMP_DB2); fs.unlinkSync(TMP_DB2 + '-wal'); fs.unlinkSync(TMP_DB2 + '-shm'); } catch (e) {}
      console.log('  ✔ 取餐超时两段式用例全部通过（正在取餐暂停计时 / 一段超时 / 返程再等 / 二段驳回）')
    } finally {
      if (child2 && child2.exitCode === null) child2.kill()
      try { fs.unlinkSync(TMP_DB2); fs.unlinkSync(TMP_DB2 + '-wal'); fs.unlinkSync(TMP_DB2 + '-shm'); } catch (e) {}
    }

    console.log('\n✅ 全部冒烟测试通过（一车多单完整闭环 + Round3 异常处理/模拟派车 + 取餐超时两段式）')
  } catch (e) {
    fail = true
    console.error('\n❌ ' + e.message)
  } finally {
    if (child) { child.kill(); }
    try { fs.unlinkSync(TMP_DB); fs.unlinkSync(TMP_DB + '-wal'); fs.unlinkSync(TMP_DB + '-shm'); } catch (e) {}
    process.exit(fail ? 1 : 0)
  }
})()
