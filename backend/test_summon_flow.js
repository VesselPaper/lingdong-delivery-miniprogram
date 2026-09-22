// 召唤多单配送端到端冒烟测试 + 单数加权路线规划单测（SUMMON_DELIVERY=true + Mock + 临时库）
// 用法：node test_summon_flow.js
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT = 3102
const TMP_DB = path.join(os.tmpdir(), 'lingdong_summon_test_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms))

let child = null
function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true',
        LINGDONG_DB: TMP_DB, PAY_MOCK: 'true', BATCH_WAIT_MS: '100000',
        MERCHANT_INVITE_CODE: 'test-invite', WX_APPID: '', WX_SECRET: '',
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
  return res.json().catch(() => ({}))
}
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg)
  console.log('  ✔ ' + msg)
}

// ---------- 单测 1：单数加权最近邻 ----------
function routeUnitTest() {
  console.log('[0] 单数加权路线单测')
  const { DatabaseSync } = require('node:sqlite')
  const mk = () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE landmarks (id INTEGER PRIMARY KEY, name TEXT, type TEXT, sort INTEGER, pos_x REAL, pos_y REAL)`)
    db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, landmark_id TEXT, landmark_name TEXT)`)
    db.exec(`INSERT INTO landmarks VALUES (0,'上货点','loadingPoint',1,0,0)`)
    db.exec(`INSERT INTO landmarks VALUES (1,'楼栋1','deliverPoint',1,10,0)`) // 5 单，稍远
    db.exec(`INSERT INTO landmarks VALUES (2,'楼栋2','deliverPoint',2,9.5,0)`) // 1 单，近一点
    for (let i = 1; i <= 5; i++) db.exec(`INSERT INTO orders VALUES (${i},'1','楼栋1')`)
    db.exec(`INSERT INTO orders VALUES (6,'2','楼栋2')`)
    return db
  }
  // α=0.5：有效距离 楼栋1=100/√5≈44.7 < 楼栋2=90.25 → 先送楼栋1（单数拽路线）
  process.env.ROUTE_COUNT_WEIGHT = '0.5'
  let batch = require('./services/batch')
  const dbA = mk()
  let r = batch.planRoute(dbA, dbA.prepare('SELECT * FROM orders').all())
  assert(String(r[0].landmark_id) === '1', 'α=0.5：5 单楼栋1 先送（有效距离更小）→ 首站楼栋1, 实际=' + r[0].landmark_name)
  dbA.close()

  // α=0：退化为纯最近邻 → 近一点的楼栋2 先送
  delete require.cache[require.resolve('./services/batch')]
  process.env.ROUTE_COUNT_WEIGHT = '0'
  batch = require('./services/batch')
  const dbB = mk()
  r = batch.planRoute(dbB, dbB.prepare('SELECT * FROM orders').all())
  assert(String(r[0].landmark_id) === '2', 'α=0：退化为纯最近邻 → 首站楼栋2, 实际=' + r[0].landmark_name)
  dbB.close()
  delete require.cache[require.resolve('./services/batch')]
  process.env.ROUTE_COUNT_WEIGHT = '0.5'
}

(async () => {
  let fail = false
  try {
    routeUnitTest()

    await startServer()
    console.log('[1] server up (mock + SUMMON_DELIVERY=true, port ' + PORT + ')')

    const mer = await api('POST', '/auth/login', { code: 'merchant-summon-' + Date.now(), merchant_code: 'test-invite', nickname: '测试商家' })
    assert(mer.code === 0, '商家登录')
    const mT = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'student-summon-' + Date.now(), role: 'student', nickname: '测试学生' })
    assert(stu.code === 0, '学生登录')
    const sT = stu.data.token
    await api('PUT', '/merchant/shop', { business_status: 'open', auto_accept: 1 }, mT)

    // 建 4 单：楼栋2(2单) + 楼栋3 + 楼栋4 → 自动接单并入一批
    const created = []
    for (const lm of [2, 3, 4, 2]) {
      const c = await api('POST', '/order/create', { landmark_id: lm, landmark_name: '点位' + lm, contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sT)
      assert(c.code === 0, '下单 order=' + c.data.order_no)
      created.push(c.data.order_id)
      const p = await api('POST', '/order/pay', { id: c.data.order_id }, sT)
      assert(p.code === 0, '支付 order=' + c.data.order_id)
    }

    const pend = await api('GET', '/merchant/device/pending', null, mT)
    const open = pend.data.open_batches || []
    assert(open.length === 1 && Number(open[0].total_orders) === 4, '有 1 个组单中批次，4 单')
    const batchId = open[0].id

    // 定型（召唤模式：不创建越凡配送任务）
    const disp = await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: batchId }, mT)
    assert(disp.code === 0 && disp.data.status === 1, '批次定型 → 待上货 status=' + disp.data.status_text)
    assert(disp.data.orders.every((o) => !o.task), '召唤模式不创建配送任务（orders[].task 为空）')

    // 扫码指定机器人（召唤开舱依赖 device_sn）
    const scan = await api('POST', '/merchant/device/scan', { deviceSn: 'SUMMONBOT001' }, mT)
    assert(scan.code === 0 && scan.data.batch_id === batchId, '扫码定位机器人')

    // 开舱（召唤到上货点 + drawerCtrl 开）/ 关舱
    const openBin = await api('POST', '/merchant/device/batch/open-bin', { batch_id: batchId }, mT)
    assert(openBin.code === 0 && openBin.data.summoned === true && openBin.data.opened === 4, '召唤开舱（summoned=true, opened=4单）')
    const closeBin = await api('POST', '/merchant/device/batch/close-bin', { batch_id: batchId }, mT)
    assert(closeBin.code === 0, '召唤关舱')

    // 立即配送（召唤多单配送：规划路线 + 召唤首站 + 该站订单置待取货3）
    const go = await api('POST', '/merchant/device/batch/dispatch', { batch_id: batchId }, mT)
    assert(go.code === 0 && go.data.summoned === true, '立即配送（召唤）启动')

    let detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
    assert(detail.data.status === 2, '批次状态→配送中')
    assert(detail.data.delivery_mode === 'summon', 'batch.delivery_mode=summon')
    assert(detail.data.current_stop === 1, 'current_stop=1（首站已启）')
    assert(detail.data.route.length >= 2, '路线含多点：' + detail.data.route.map((x) => x.landmark_name).join('→'))
    const routeOrder = detail.data.route.map((s) => s.stop + ':' + s.landmark_name + '(' + (s.order_ids || []).length + '单)').join(' → ')
    console.log('    路线: ' + routeOrder)
    // 首站订单置待取货(3)：召唤派车后由「真到站门禁 + 推进看门狗（默认 5s）」置位 —— 轮询等待而非立即断言
    let firstStopOrders = []
    let firstOk = false
    for (let i = 0; i < 24 && !firstOk; i++) {
      detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
      const routeNow = detail.data && detail.data.route
      if (routeNow && routeNow.length) {
        const fsi = routeNow[0].order_ids.map(String)
        firstStopOrders = detail.data.orders.filter((o) => fsi.includes(String(o.id)))
        firstOk = firstStopOrders.length >= 2 && firstStopOrders.every((o) => o.status === 3)
      }
      if (!firstOk) await WAIT(500)
    }
    assert(firstOk, '首站订单已置待取货(3)（真到站门禁 + 看门狗置位）')

    // 逐站取餐：每站全取完 → 停 SUMMON_STOP_ADVANCE_MS → 下一站订单变待取货 → 再取……直至批次完成
    let visited = 0
    let totalWaited = 0
    const maxStops = detail.data.route.length
    while (visited < maxStops) {
      detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
      if (detail.data.status === 3) break
      const pickupable = detail.data.orders.filter((o) => o.status === 3 && !o.picked_up)
      if (pickupable.length) {
        for (const o of pickupable) {
          const po = await api('POST', '/delivery/pickup-open', { order_id: o.id }, sT)
          assert(po.code === 0, '取餐开舱 order=' + o.id)
          const pc = await api('POST', '/delivery/pickup-close', { order_id: o.id }, sT)
          assert(pc.code === 0 && pc.data.summon === true, '取餐关舱(召唤) order=' + o.id + ' → status ' + pc.data.status)
        }
        visited += 1
        continue
      }
      // 本站都取完 → 等服务推进器把下一站置待取货 / 或批次完成
      await WAIT(600)
      totalWaited += 600
      if (totalWaited > 15000) throw new Error('召唤推进超时：current_stop=' + detail.data.current_stop + ' status=' + detail.data.status)
    }

    // 等批次被推进器置为已完成，且收尾把 current_stop 归零、机器人召回上货点
    // （全部取完后还有 SUMMON_STOP_ADVANCE_MS 的"停 5 秒"步进 + 召回，故这里一并等待）
    detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
    for (let i = 0; i < 40 && !(detail.data.status === 3 && Number(detail.data.current_stop) === 0); i++) {
      await WAIT(400); detail = await api('GET', '/merchant/delivery/batch/detail?batch_id=' + batchId, null, mT)
    }
    assert(detail.data.status === 3, '全部取完 → 批次已完成(status=' + detail.data.status_text + ')')
    assert(detail.data.orders.every((o) => o.picked_up), '批次内所有订单已取走')
    assert(Number(detail.data.current_stop) === 0, '完成后 current_stop 归 0（机器人召回上货点）')

    console.log('\n✅ 召唤多单配送全链路通过：加权路线 + 定型无任务 + 召唤开/关舱 + 逐站推进(5s) + 全部取完召回完成')
  } catch (e) {
    fail = true
    console.error('\n❌ ' + e.message)
  } finally {
    if (child) child.kill()
    try { fs.unlinkSync(TMP_DB); fs.unlinkSync(TMP_DB + '-wal'); fs.unlinkSync(TMP_DB + '-shm') } catch (e) {}
    process.exit(fail ? 1 : 0)
  }
})()