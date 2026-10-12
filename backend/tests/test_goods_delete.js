// 商品删除（店主专属，真删行）回归测试
// （Mock + 临时库 + 独立端口 3105，不影响真实环境）
// 用法：cd backend && node tests/test_goods_delete.js
//
// 覆盖：
//   ① 店主删除演示种子商品：DELETE /merchant/goods → 用户端与商家端列表都不再有它
//   ② 权限：店员（merchant_role=staff）删除返回 403；非店主同样不能删
//   ③ 参数/边界：缺 id → 400；不存在 → 404
//   ④ 批量删除：POST /merchant/goods/batch-delete 逐条独立，库里没有的 id 只计入 missing
//   ⑤ 历史订单不受影响：订单里存的是下单快照（goods_name），删掉商品后订单明细照常显示
//   ⑥ 购物车残留行不显示：删商品后 cart 行仍在，但 goods_status 为 null（用户端按 =1 过滤）
//   ⑦ 审计留痕：删除动作落 audit_logs
//   ⑧ 顺带统计「删完之后还有多少商品没有图片」（门店商品里没配图的数量）
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3105
const TMP_DB = path.join(os.tmpdir(), 'lingdong_goodsdel_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const OWNER_USER = 'testowner'
const STAFF_USER = 'teststaff'
const PASS = 'test123456'

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

let bad = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✘ ' + msg); bad++ } else { console.log('  ✔ ' + msg) }
}
const noImage = (g) => !String(g.image || '').trim()

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    // 店主 + 店员账号（直接写临时库，绕过管理员网页建号流程）
    const adminAuth = require('../services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    const ins = boot.prepare("INSERT INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant',?,1,?)")
    ins.run(OWNER_USER, adminAuth.hashPassword(PASS), 'owner', '测试店主')
    ins.run(STAFF_USER, adminAuth.hashPassword(PASS), 'staff', '测试店员')
    boot.close()
    db = new DatabaseSync(TMP_DB)

    const owner = await api('POST', '/auth/login', { username: OWNER_USER, password: PASS, client: 'merchant' })
    assert(owner.code === 0, '店主登录')
    const oToken = owner.data.token
    const staff = await api('POST', '/auth/login', { username: STAFF_USER, password: PASS, client: 'merchant' })
    assert(staff.code === 0, '店员登录')
    const sToken = staff.data.token
    const stu = await api('POST', '/auth/login', { code: 'stu-gd-' + Date.now(), client: 'user', nickname: '测试学生' })
    assert(stu.code === 0, '学生登录')
    const uToken = stu.data.token

    // ---------- 前置：库里 = 演示种子 10 条 + 门店导入 216 条 ----------
    console.log('\n[2] 前置：演示种子商品确实在库里（这就是要清掉的「旧测试商品」）')
    const seedNames = require('../db').DEMO_GOODS.map((r) => String(r[0]))
    const before = await api('GET', '/merchant/goods', null, oToken)
    const all = before.data || []
    const seeds = all.filter((g) => seedNames.indexOf(String(g.name)) > -1)
    assert(seeds.length === 10, '演示种子商品 10 条（库里共 ' + all.length + ' 条）')
    const noImgBefore = all.filter(noImage).length
    console.log('      （删除前：' + all.length + ' 条商品，其中无图 ' + noImgBefore + ' 条）')

    // ---------- ③ 参数与权限 ----------
    console.log('\n[3] 权限与参数')
    const noId = await api('DELETE', '/merchant/goods', {}, oToken)
    assert(noId.code === 400, '缺 id → 400')
    const notFound = await api('DELETE', '/merchant/goods', { id: 999999 }, oToken)
    assert(notFound.code === 404, '商品不存在 → 404')
    const byStaff = await api('DELETE', '/merchant/goods', { id: seeds[0].id }, sToken)
    assert(byStaff.code === 403, '店员删除 → 403（需要店主权限）')
    const seedStill = await api('GET', '/merchant/goods', null, oToken)
    assert((seedStill.data || []).some((g) => Number(g.id) === Number(seeds[0].id)), '被拒后商品仍在（没有误删）')

    // ---------- ⑤ 历史订单快照：先下单，再删这个商品 ----------
    console.log('\n[4] 删商品后历史订单明细照常显示')
    const lms = await api('GET', '/landmarks', null, uToken)
    const lm = (lms.data || []).find((x) => x.type === 'deliverPoint')
    assert(!!lm, '存在可送达点位')
    const ordered = all.find((g) => Number(g.status) === 1 && Number(g.stock) >= 5 && !seedNames.includes(String(g.name)))
    const ord = await api('POST', '/order/create', {
      landmark_id: lm.id, landmark_name: lm.name,
      contact_name: '测试', contact_phone: '13800000000',
      items: [{ goods_id: ordered.id, quantity: 1 }], remark: '删除商品回归'
    }, uToken)
    assert(ord.code === 0, '下单成功（订单里含商品 ' + ordered.name + '）')
    const orderId = ord.data.order_id || ord.data.id
    const orderNo = ord.data.order_no || ''
    const del1 = await api('DELETE', '/merchant/goods', { id: ordered.id }, oToken)
    assert(del1.code === 0 && del1.data.deleted === 1, '店主删除该商品成功')
    const detail = await api('GET', '/merchant/order/detail?id=' + (orderId || orderNo), null, oToken)
    const items = (detail.data && (detail.data.items || (detail.data.order && detail.data.order.items))) || []
    assert(items.some((it) => String(it.goods_name) === String(ordered.name)), '订单明细仍显示已删商品名（下单快照）')

    // ---------- ⑥ 购物车残留行不被用户端显示 ----------
    console.log('\n[5] 删商品后购物车残留行不进界面')
    const cartGoods = all.find((g) => Number(g.status) === 1 && Number(g.stock) >= 5 && !seedNames.includes(String(g.name)) && Number(g.id) !== Number(ordered.id))
    await api('POST', '/cart/add', { goods_id: cartGoods.id, quantity: 1 }, uToken)
    const cart1 = await api('GET', '/cart/list', null, uToken)
    assert((cart1.data || []).some((it) => Number(it.goods_id) === Number(cartGoods.id)), '商品已加入购物车')
    await api('DELETE', '/merchant/goods', { id: cartGoods.id }, oToken)
    const cart2 = await api('GET', '/cart/list', null, uToken)
    const left = (cart2.data || []).find((it) => Number(it.goods_id) === Number(cartGoods.id))
    assert(!!left && left.goods_status === null, '残留行仍在库里，但 goods_status 为 null（用户端按 =1 过滤，不会显示空白条目）')

    // ---------- ① 删掉全部演示种子商品 ----------
    console.log('\n[6] 删除演示种子商品（单条 + 批量）')
    // 前面的权限用例被拒（没删成 seeds[0]），所以这里 10 条种子都还在；
    // 刻意把「第 4 步已删掉的那个门店商品 id」也塞进 ids，验证「已删过的 id 只算 missing」。
    const rest = seeds.map((g) => g.id)
    const batch = await api('POST', '/merchant/goods/batch-delete', { ids: rest.concat([ordered.id]) }, oToken)
    assert(batch.code === 0 && batch.data.deleted === 10, '批量删除 10 条演示种子商品')
    assert(batch.data.missing.indexOf(Number(ordered.id)) > -1, '已删过的 id 只计入 missing，不算失败')

    const after = await api('GET', '/merchant/goods', null, oToken)
    const allAfter = after.data || []
    assert(allAfter.every((g) => seedNames.indexOf(String(g.name)) < 0), '商家端列表里已无任何演示种子商品')
    const pub = await api('GET', '/goods/list', null, uToken)
    assert((pub.data || []).every((g) => !g.image || true) && (pub.data || []).every((g) => allAfter.some((x) => Number(x.id) === Number(g.id))), '用户端在售商品全部来自门店清单')

    // ---------- ⑦ 审计 ----------
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'goods%delete%'").get()
    assert(Number(audit.c) >= 2, '删除动作已落审计（audit_logs 命中 ' + audit.c + ' 条）')

    // ---------- ⑧ 统计：删完之后还有多少商品没有图片 ----------
    console.log('\n[7] 删除结果与「没有图片」的商品')
    const noImgAfter = allAfter.filter(noImage)
    // 一共少了 12 条：10 条演示种子 + 第 4 步（订单快照用例）删的 1 条门店商品 + 第 5 步（购物车用例）删的 1 条
    assert(all.length - allAfter.length === 12, '商品总数 ' + all.length + ' → ' + allAfter.length + '（少 12 条 = 10 种子 + 2 条用例删除）')
    console.log('      删除后商品总数：' + allAfter.length)
    console.log('      其中没有图片的商品：' + noImgAfter.length + ' 个')
    for (const g of noImgAfter) console.log('        - id=' + g.id + '  ' + g.name + '（' + g.category + '）')

    console.log('\n' + (bad ? '✘ 失败 ' + bad + ' 项' : '✔ 全部通过'))
  } catch (e) {
    console.error('测试异常：', e && e.stack)
    bad++
  } finally {
    try { if (db) db.close() } catch (e) { /* 忽略 */ }
    try { if (child) child.kill() } catch (e) { /* 忽略 */ }
    try { require('fs').rmSync(TMP_DB, { force: true }) } catch (e) { /* 忽略 */ }
  }
  process.exit(bad ? 1 : 0)
})()
