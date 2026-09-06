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
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true', LINGDONG_DB: TMP_DB, PAY_MOCK: 'true', BATCH_WAIT_MS: '100000', MERCHANT_INVITE_CODE: 'test-invite', WX_APPID: '', WX_SECRET: '', MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: '' },
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
    const mer = await api('POST', '/auth/login', { code: 'merchant-test-' + Date.now(), merchant_code: 'test-invite', nickname: '测试商家' })
    assert(mer.code === 0, '商家登录')
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
    for (const lm of [lm2, lm3, lm4, lm2]) {
      const c = await api('POST', '/order/create', { landmark_id: lm, landmark_name: '点位' + lm, contact_name: '测试学生', contact_phone: '13800138000', items: [{ goods_id: 1, quantity: 1 }] }, sToken)
      assert(c.code === 0, '下单 order=' + c.data.order_no)
      created.push(c.data.order_id)
      const p = await api('POST', '/order/pay', { id: c.data.order_id }, sToken)
      assert(p.code === 0, '支付 order=' + c.data.order_id + ' auto=' + (p.data.auto_accept ? 'yes' : 'no'))
    }

    // 商品库存/销量（收货完成才结算销量，下单仅扣库存）
    const goodsBefore = await api('GET', '/merchant/goods', null, mToken)
    const g1 = goodsBefore.data.find((x) => x.id === 1)
    assert(Number(g1.stock) === 96, '下单扣库存：商品1 100→96（4单各1）')
    assert(Number(g1.sales) === 326, '下单不结算销量：商品1 sales 仍为 326')

    // 商品分类接口
    const cats = await api('GET', '/merchant/goods/categories', null, mToken)
    assert(cats.code === 0 && cats.data.length > 0 && cats.data.indexOf('热卤') > -1, '商品分类列表可用')

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
    assert(disp.data.route.length >= 2, '路线含多个停靠点（' + disp.data.route.map((r) => r.landmark_name).join(',') + '）')
    console.log('    路线: ' + disp.data.route.map((r) => r.stop + ':' + r.landmark_name + '(' + r.order_ids.length + '单)').join(' → '))

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
    assert(Number(g1b.sales) >= 330, '收货完成结算销量：商品1 sales≥330（实际 ' + g1b.sales + '）')

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
    assert(Number(g1r.stock) === 95, '异常退款回补库存：商品1 stock=95（96 -1 ce -1 cf +1 退款回补）')
    tdb.close()

    console.log('\n✅ 全部冒烟测试通过（一车多单完整闭环 + Round3 异常处理/模拟派车）')
  } catch (e) {
    fail = true
    console.error('\n❌ ' + e.message)
  } finally {
    if (child) { child.kill(); }
    try { fs.unlinkSync(TMP_DB); fs.unlinkSync(TMP_DB + '-wal'); fs.unlinkSync(TMP_DB + '-shm'); } catch (e) {}
    process.exit(fail ? 1 : 0)
  }
})()
