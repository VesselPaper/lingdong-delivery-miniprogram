// 多店铺隔离回归测试（一期「多店地基」的验收尺子）
// （Mock + 临时库 + 独立端口 3110，不影响真实环境）
// 用法：cd backend && node tests/test_shop_isolation.js
//
// 覆盖：
//   ① 商家账号各自属于自己的店：B 店账号的 /merchant/shop 拿到的是 B 店，不是 1 号店
//   ② 商品列表按店隔离：B 店看不到 A 店商品；A 店看不到 B 店商品
//   ③ 越权写保护：B 店改/删/上下架 A 店商品 → 404（不是「成功」，也不是 403 泄露存在性）
//   ④ 用户端按店取商品：?shop_id=2 只出 B 店商品；不传 shop_id 仍是 1 号店（老版本小程序兼容）
//   ⑤ 活动与优惠券同样按店隔离（列表 + 越权改）
//   ⑥ 店名/营业状态按店返回（/shop/list、/shop/status?shop_id=2）
//   ⑦ 存量口径：默认店仍是 1 号店，没有成员行的老账号落到 1 号店
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3110
const TMP_DB = path.join(os.tmpdir(), 'lingdong_shops_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const PASS = 'test123456'
const A_USER = 'testshop_a'
const B_USER = 'testshop_b'

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
        SUMMON_DELIVERY: 'false', STATUS_EVENTS_MS: '300',
        BOOTSTRAP_ACCOUNTS: '0'
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

let bad = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✘ ' + msg); bad++ } else { console.log('  ✔ ' + msg) }
}

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    // ---------- 造两家店 + 两个店主账号 ----------
    // 直接写临时库：管理员建号接口会顺带写成员行，但这里要精确控制 shop_id
    const adminAuth = require('../services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    const insShop = boot.prepare("INSERT INTO shops (name, business_status, auto_accept, code) VALUES (?,?,?,?)")
    insShop.run('东苑超市', 'open', 0, 'shop-b')
    const B_SHOP = Number(boot.prepare("SELECT id FROM shops WHERE code='shop-b'").get().id)
    const insUser = boot.prepare("INSERT INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant',?,1,?)")
    insUser.run(A_USER, adminAuth.hashPassword(PASS), 'owner', '测试A店')
    const A_UID = Number(boot.prepare('SELECT id FROM users WHERE username=?').get(A_USER).id)
    insUser.run(B_USER, adminAuth.hashPassword(PASS), 'owner', '测试B店')
    const B_UID = Number(boot.prepare('SELECT id FROM users WHERE username=?').get(B_USER).id)
    const insMember = boot.prepare('INSERT INTO shop_members (shop_id, user_id, role) VALUES (?,?,?)')
    insMember.run(1, A_UID, 'owner')
    insMember.run(B_SHOP, B_UID, 'owner')
    boot.close()
    db = new DatabaseSync(TMP_DB)
    assert(B_SHOP > 1, '临时库里有第二家店（id=' + B_SHOP + '）')

    const a = await api('POST', '/auth/login', { username: A_USER, password: PASS, client: 'merchant' })
    const b = await api('POST', '/auth/login', { username: B_USER, password: PASS, client: 'merchant' })
    assert(a.code === 0 && b.code === 0, '两个店主账号都能登录')
    const aT = a.data.token, bT = b.data.token

    // ---------- ① 当前店铺 ----------
    console.log('\n[2] 每个账号拿到的是自己那家店')
    const aShop = await api('GET', '/merchant/shop', null, aT)
    const bShop = await api('GET', '/merchant/shop', null, bT)
    assert(Number(aShop.data.id) === 1, 'A 店账号当前店铺 = 1')
    assert(Number(bShop.data.id) === B_SHOP && bShop.data.name === '东苑超市', 'B 店账号当前店铺 = ' + B_SHOP + '（东苑超市）')

    // ---------- ② 商品隔离 ----------
    console.log('\n[3] 商品按店隔离')
    const aGoods = await api('POST', '/merchant/goods', { name: 'A店专属烤肠', price: 3, stock: 10, category: '零食' }, aT)
    const bGoods = await api('POST', '/merchant/goods', { name: 'B店专属面包', price: 5, stock: 20, category: '面包' }, bT)
    assert(aGoods.code === 0 && bGoods.code === 0, '两家店各建一个商品')

    const aList = (await api('GET', '/merchant/goods', null, aT)).data || []
    const bList = (await api('GET', '/merchant/goods', null, bT)).data || []
    assert(aList.some((g) => g.name === 'A店专属烤肠'), 'A 店列表有自己的商品')
    assert(!aList.some((g) => g.name === 'B店专属面包'), 'A 店列表里没有 B 店商品')
    assert(bList.some((g) => g.name === 'B店专属面包'), 'B 店列表有自己的商品')
    assert(!bList.some((g) => g.name === 'A店专属烤肠'), 'B 店列表里没有 A 店商品')
    assert(bList.length === 1, 'B 店看不到 1 号店的历史商品（实测 ' + bList.length + ' 条）')
    const aRow = db.prepare('SELECT shop_id FROM goods WHERE name=?').get('A店专属烤肠')
    const bRow = db.prepare('SELECT shop_id FROM goods WHERE name=?').get('B店专属面包')
    assert(Number(aRow.shop_id) === 1 && Number(bRow.shop_id) === B_SHOP, '落库的 shop_id 分别是 1 与 ' + B_SHOP)

    // ---------- ③ 越权写保护 ----------
    console.log('\n[4] 越权写一律 404（不泄露「这件商品存在」）')
    const bGoodsId = Number(bGoods.data.id)
    const aGoodsId = Number(aGoods.data.id)
    const cross1 = await api('PUT', '/merchant/goods', { id: bGoodsId, name: '被A店改名', price: 1 }, aT)
    const cross2 = await api('PUT', '/merchant/goods/stock', { id: bGoodsId, stock: 0 }, aT)
    const cross3 = await api('PUT', '/merchant/goods/status', { id: bGoodsId, status: 0 }, aT)
    const cross4 = await api('DELETE', '/merchant/goods?id=' + bGoodsId, null, aT)
    assert(cross1.code === 404, 'A 店改 B 店商品 → 404')
    assert(cross2.code === 404, 'A 店改 B 店库存 → 404')
    assert(cross3.code === 404, 'A 店上下架 B 店商品 → 404')
    assert(cross4.code === 404, 'A 店删 B 店商品 → 404')
    const stillB = db.prepare('SELECT name, stock, status FROM goods WHERE id=?').get(bGoodsId)
    assert(stillB.name === 'B店专属面包' && Number(stillB.stock) === 20 && Number(stillB.status) === 1, 'B 店商品没被改动（名称/库存/状态原样）')
    // 反向：B 店改 A 店同样 404
    const cross5 = await api('PUT', '/merchant/goods', { id: aGoodsId, name: '被B店改名', price: 1 }, bT)
    assert(cross5.code === 404, 'B 店改 A 店商品 → 404')

    // 条码唯一性按店：两家店可以用同一条码
    console.log('\n[5] 条码唯一性是「一店一条码」')
    const bc = '6901234567890'
    const bcA = await api('POST', '/merchant/goods', { name: 'A店条码商品', price: 2, stock: 5, barcode: bc }, aT)
    const bcB = await api('POST', '/merchant/goods', { name: 'B店条码商品', price: 2, stock: 5, barcode: bc }, bT)
    assert(bcA.code === 0, 'A 店录入条码 ' + bc)
    assert(bcB.code === 0, 'B 店可以用同一条码（不会被全库唯一挡住）')
    const bScan = await api('GET', '/merchant/goods/by-barcode?code=' + bc, null, bT)
    assert(bScan.data && bScan.data.found && bScan.data.goods.name === 'B店条码商品', 'B 店扫同一条码扫到的是自己的商品')

    // ---------- ④ 用户端按店取商品 ----------
    console.log('\n[6] 用户端：?shop_id= 决定看哪家店的货')
    const pubAll = (await api('GET', '/goods/list')).data || []
    const pubB = (await api('GET', '/goods/list?shop_id=' + B_SHOP)).data || []
    assert(!pubAll.some((g) => g.name === 'B店专属面包'), '不传 shop_id（老版本小程序）看不到 B 店商品，默认 1 号店不变')
    assert(pubB.some((g) => g.name === 'B店专属面包'), '?shop_id=' + B_SHOP + ' 能取到 B 店商品')
    assert(!pubB.some((g) => g.name === 'A店专属烤肠'), '?shop_id=' + B_SHOP + ' 取不到 A 店商品')
    const detailB = await api('GET', '/goods/detail?id=' + bGoodsId)
    const detailB2 = await api('GET', '/goods/detail?id=' + bGoodsId + '&shop_id=' + B_SHOP)
    assert(detailB.code === 404, '默认店铺口径下访问 B 店商品详情 → 404')
    assert(detailB2.code === 0 && detailB2.data.name === 'B店专属面包', '?shop_id=' + B_SHOP + ' 能看 B 店商品详情')

    // ---------- ⑤ 活动与券 ----------
    console.log('\n[7] 活动与优惠券同样按店隔离')
    const actB = await api('POST', '/merchant/activities', { title: 'B店活动', status_action: 'draft', image: '/store-img/x.jpg' }, bT)
    assert(actB.code === 0, 'B 店新建活动（草稿）')
    const aActs = (await api('GET', '/merchant/activities', null, aT)).data || []
    const bActs = (await api('GET', '/merchant/activities', null, bT)).data || []
    assert(!aActs.some((x) => x.title === 'B店活动'), 'A 店活动列表里没有 B 店活动')
    assert(bActs.some((x) => x.title === 'B店活动'), 'B 店活动列表里有自己的活动')
    const actCross = await api('PUT', '/merchant/activities', { id: actB.data.id, title: '被A改' }, aT)
    assert(actCross.code === 404, 'A 店改 B 店活动 → 404')
    const actCrossDel = await api('DELETE', '/merchant/activities', { id: actB.data.id }, aT)
    assert(actCrossDel.code === 404, 'A 店删 B 店活动 → 404')

    const cB = await api('POST', '/merchant/coupons', {
      title: 'B店券', type: 'no_threshold', threshold: 0, reduce: 2, valid_type: 'relative', relative_days: 7,
      scope: 'all', scope_ids: [], total_qty: 100, per_user_limit: 1, status: 1,
      // 启用的券必须有图（用户端券以图片呈现），这里给个占位图以便通过校验
      image: '/store-img/coupon-b.jpg'
    }, bT)
    assert(cB.code === 0, 'B 店新建优惠券（启用态）')
    const aCoupons = (await api('GET', '/merchant/coupons', null, aT)).data || []
    assert(!aCoupons.some((c) => c.title === 'B店券'), 'A 店券列表里没有 B 店券')
    const couponCross = await api('PUT', '/merchant/coupons/status', { id: cB.data.id, status: 0 }, aT)
    assert(couponCross.code === 404, 'A 店停用 B 店券 → 404')

    // ---------- ⑥ 店铺列表与营业状态 ----------
    console.log('\n[8] 公开的店铺列表 / 按店营业状态')
    const shops = (await api('GET', '/shop/list')).data || []
    assert(shops.length >= 2, '/shop/list 返回 ' + shops.length + ' 家店')
    assert(shops.some((s) => s.name === '东苑超市'), '/shop/list 里有东苑超市')
    const stB = await api('GET', '/shop/status?shop_id=' + B_SHOP)
    assert(stB.code === 0 && stB.data.name === '东苑超市' && Number(stB.data.id) === B_SHOP, '/shop/status?shop_id=' + B_SHOP + ' 返回东苑超市')
    // B 店歇业，不影响 A 店
    await api('PUT', '/merchant/shop', { business_status: 'closed' }, bT)
    const stB2 = await api('GET', '/shop/status?shop_id=' + B_SHOP)
    const stA2 = await api('GET', '/shop/status?shop_id=1')
    assert(stB2.data.business_status === 'closed', 'B 店歇业已生效')
    assert(stA2.data.business_status === 'open', 'A 店仍是营业中（互不串）')

    // ---------- ⑦ 存量口径 ----------
    console.log('\n[9] 没有成员行的老账号仍落到 1 号店（兼容）')
    const oldUser = 'testshop_old'
    const boot2 = new DatabaseSync(TMP_DB)
    boot2.prepare("INSERT INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'老账号')")
      .run(oldUser, adminAuth.hashPassword(PASS))
    boot2.close()
    const old = await api('POST', '/auth/login', { username: oldUser, password: PASS, client: 'merchant' })
    const oldShop = await api('GET', '/merchant/shop', null, old.data.token)
    assert(old.code === 0 && Number(oldShop.data.id) === 1, '老账号（无 shop_members 行）当前店铺 = 1 号店')
    const oldList = (await api('GET', '/merchant/goods', null, old.data.token)).data || []
    assert(oldList.some((g) => g.name === 'A店专属烤肠'), '老账号看到的是 1 号店商品（行为与单店时一致）')

    // ---------- ⑧ 商家工作台 / 售后 / 批次 / 购物车 ----------
    // 这一段是「漏一处就等于把全平台数据展示给某个商家」的地方，逐条钉住。
    console.log('\n[10] 工作台、售后、批次都只看本店')
    const stu = await api('POST', '/auth/login', { code: 'stu-shop-' + Date.now(), client: 'user', nickname: '测试学生' })
    const uT = stu.data.token
    const lms = (await api('GET', '/landmarks', null, uT)).data || []
    const lm = lms.find((x) => x.type === 'deliverPoint')
    assert(!!lm, '存在可送达点位')
    const ord = await api('POST', '/order/create', {
      shop_id: 1, landmark_id: lm.id, landmark_name: lm.name,
      contact_name: '测试', contact_phone: '13800000000',
      items: [{ goods_id: aGoodsId, quantity: 1 }], remark: '多店隔离回归'
    }, uT)
    assert(ord.code === 0, '用户在 1 号店下单成功')
    const orderId = Number(ord.data.order_id || ord.data.id)
    const uid = Number(db.prepare('SELECT user_id FROM orders WHERE id=?').get(orderId).user_id)

    // 工作台统计：整个数字面板都要按店
    const statsA = (await api('GET', '/merchant/stats', null, aT)).data || {}
    const statsB = (await api('GET', '/merchant/stats', null, bT)).data || {}
    assert(Number(statsA.today_orders) >= 1, 'A 店工作台今日单量 >= 1（实测 ' + statsA.today_orders + '）')
    assert(Number(statsB.today_orders) === 0, 'B 店工作台今日单量为 0（看不到 1 号店的单）')
    assert(Number(statsA.shop_id) === 1 && Number(statsB.shop_id) === B_SHOP, '工作台带回本店 shop_id')

    // 用户订单列表带店名（多店之后用户要分得清哪单是哪家店）
    const myOrders = (await api('GET', '/order/list', null, uT)).data || []
    const myOrder = myOrders.find((o) => Number(o.id) === orderId)
    assert(myOrder && Number(myOrder.shop_id) === 1 && !!myOrder.shop_name, '用户订单列表带 shop_id + 店名（' + (myOrder && myOrder.shop_name) + '）')

    // 购物车条目的店铺归属（结算页「一车只能一家店」靠它）
    await api('POST', '/cart/add', { goods_id: bGoodsId, quantity: 1 }, uT)
    const cart = (await api('GET', '/cart/list', null, uT)).data || []
    const cartB = cart.find((c) => Number(c.goods_id) === bGoodsId)
    assert(cartB && Number(cartB.shop_id) === B_SHOP && cartB.shop_name === '东苑超市', '购物车条目带 shop_id + 店名（东苑超市）')

    // 售后 / 取消申请：两张表没有 shop_id，只能沿订单判定归属 —— 直接造数据最稳
    db.prepare('INSERT INTO refunds (order_id, user_id, type, reason, amount) VALUES (?,?,?,?,?)')
      .run(orderId, uid, 'refund', '多店隔离测试', 3)
    db.prepare('INSERT INTO cancel_requests (order_id, user_id, reason) VALUES (?,?,?)')
      .run(orderId, uid, '多店隔离测试')
    const aRefunds = (await api('GET', '/merchant/refunds', null, aT)).data || []
    const bRefunds = (await api('GET', '/merchant/refunds', null, bT)).data || []
    assert(aRefunds.some((r) => Number(r.order_id) === orderId), 'A 店售后列表里有自家单')
    assert(!bRefunds.some((r) => Number(r.order_id) === orderId), 'B 店售后列表里没有 A 店的单')
    const refundId = (aRefunds.find((r) => Number(r.order_id) === orderId) || {}).id
    assert((await api('GET', '/merchant/refund/detail?id=' + refundId, null, bT)).code === 404, 'B 店查 A 店售后详情 → 404')
    assert((await api('POST', '/merchant/refund/handle', { id: refundId, action: 'reject', reply: '别家店' }, bT)).code === 404, 'B 店处理 A 店售后 → 404')

    const aCancels = (await api('GET', '/merchant/cancel-requests', null, aT)).data || []
    const bCancels = (await api('GET', '/merchant/cancel-requests', null, bT)).data || []
    assert(aCancels.some((c) => Number(c.order_id) === orderId), 'A 店取消申请列表里有自家单')
    assert(!bCancels.some((c) => Number(c.order_id) === orderId), 'B 店取消申请列表里没有 A 店的单')
    const cancelId = (aCancels.find((c) => Number(c.order_id) === orderId) || {}).id
    assert((await api('GET', '/merchant/cancel-request/detail?id=' + cancelId, null, bT)).code === 404, 'B 店查 A 店取消申请 → 404')
    assert((await api('POST', '/merchant/cancel-request/handle', { id: cancelId, action: 'reject', reply: '别家店' }, bT)).code === 404, 'B 店处理 A 店取消申请 → 404')

    // 配送批次：批次自带 shop_id，商家端调度页与派车入口都要按店
    db.prepare("INSERT INTO delivery_batches (batch_no, status, status_text, shop_id) VALUES ('BD-TEST-A', 0, '组单中', 1)").run()
    const testBatchId = Number(db.prepare("SELECT id FROM delivery_batches WHERE batch_no='BD-TEST-A'").get().id)
    const aBatchList = (await api('GET', '/merchant/delivery/batch/list', null, aT)).data || []
    const bBatchList = (await api('GET', '/merchant/delivery/batch/list', null, bT)).data || []
    assert(aBatchList.some((x) => Number(x.id) === testBatchId), 'A 店批次列表里有自家批次')
    assert(!bBatchList.some((x) => Number(x.id) === testBatchId), 'B 店批次列表里没有 A 店批次')
    assert((await api('GET', '/merchant/delivery/batch/detail?batch_id=' + testBatchId, null, bT)).code === 404, 'B 店查 A 店批次详情 → 404')
    assert((await api('POST', '/merchant/delivery/batch/dispatch', { batch_id: testBatchId }, bT)).code === 404, 'B 店派 A 店的批次 → 404')
    assert((await api('POST', '/merchant/delivery/batch/delete', { batch_id: testBatchId }, bT)).code === 404, 'B 店删 A 店的批次 → 404')
    assert((await api('POST', '/merchant/device/batch/open-bin', { batch_id: testBatchId }, bT)).code === 404, 'B 店给 A 店批次开舱 → 404')
    const bPending = (await api('GET', '/merchant/device/pending', null, bT)).data || {}
    const bPendingIds = (bPending.open_batches || []).map((x) => Number(x.id))
    assert(bPendingIds.indexOf(testBatchId) === -1, 'B 店「待上货」列表里没有 A 店批次')

    console.log('\n' + (bad ? '✘ 失败 ' + bad + ' 项' : '✔ 全部通过'))
  } catch (e) {
    console.error('测试异常：', e && e.stack)
    bad++
  } finally {
    try { if (db) db.close() } catch (e) { /* 忽略 */ }
    try { if (child) child.kill() } catch (e) { /* 忽略 */ }
    try { require('fs').rmSync(TMP_DB, { force: true }) } catch (e) { /* 忽略 */ }
    try { require('fs').rmSync(TMP_DB + '-wal', { force: true }) } catch (e) { /* 忽略 */ }
    try { require('fs').rmSync(TMP_DB + '-shm', { force: true }) } catch (e) { /* 忽略 */ }
  }
  process.exit(bad ? 1 : 0)
})()
