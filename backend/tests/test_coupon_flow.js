// 优惠券全链路回归测试（Mock + 临时库 + 独立端口 3103，不影响真实环境）
// 用法：cd backend && node tests/test_coupon_flow.js
//
// 覆盖（对应需求）：
//   ① 商家端建券：满减 / 无门槛 / 折扣（含校验拦截）
//   ② 用户领券：总量、每人限领、重复领取拦截
//   ③ 结算可用券：最优券推荐（挑抵扣最多的）
//   ④ 不可用原因：未达门槛（还差多少）/ 商品不适用 / 已过期
//   ⑤ 下单用券：实付 = 活动后金额 − 券抵扣 + 配送费
//   ⑥ 优惠分摊：按商品原价比例分摊到每件，且分摊之和恰好等于券抵扣
//   ⑦ 券用后置「已使用」，不可重复用
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3103
const TMP_DB = path.join(os.tmpdir(), 'lingdong_coupon_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const MER_USER = 'testmerchant'
const MER_PASS = 'test123456'

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

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')

    const adminAuth = require('../services/adminAuth')
    const boot = new DatabaseSync(TMP_DB)
    boot.prepare("INSERT OR IGNORE INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant','owner',1,'测试商家')")
      .run(MER_USER, adminAuth.hashPassword(MER_PASS))
    boot.close()
    db = new DatabaseSync(TMP_DB)

    const mer = await api('POST', '/auth/login', { username: MER_USER, password: MER_PASS, client: 'merchant' })
    assert(mer.code === 0, '商家登录')
    const mToken = mer.data.token
    const stu = await api('POST', '/auth/login', { code: 'stu-coupon-' + Date.now(), client: 'user', nickname: '测试学生' })
    assert(stu.code === 0, '学生登录')
    const sToken = stu.data.token

    const goods = await api('GET', '/goods/list', null, sToken)
    assert(goods.code === 0 && goods.data.length > 0, '商品列表可用')
    // 选两件商品：一个便宜、一个贵（用于触发门槛差异）
    const sorted = goods.data.slice().sort((a, b) => Number(a.price) - Number(b.price))
    const cheap = sorted[0]
    const pricey = sorted[sorted.length - 1]
    const lms = await api('GET', '/landmarks', null, sToken)
    const lm = (lms.data || []).find((x) => x.type === 'deliverPoint')
    assert(!!lm, '存在可送达点位')

    console.log('\n[2] 商家端建券 + 校验')
    const badCoupon = await api('POST', '/merchant/coupons', { title: '', type: 'full_reduce', reduce: 5 }, mToken)
    assert(badCoupon.code !== 0, '空名称被拒')
    const badDiscount = await api('POST', '/merchant/coupons', { title: '坏折扣', type: 'discount', discount: 1.5 }, mToken)
    assert(badDiscount.code !== 0, '折扣率 ≥1 被拒（0.85 才是 85 折）')
    const badScope = await api('POST', '/merchant/coupons', { title: '缺范围', type: 'full_reduce', reduce: 5, scope: 'goods', scope_ids: [] }, mToken)
    assert(badScope.code !== 0, '指定商品券未选商品被拒')
    // 用户端首页/活动页都是图片列表：券必须配图才能启用（否则用户端根本没有它的形态）
    const badNoImg = await api('POST', '/merchant/coupons', { title: '没图', type: 'no_threshold', reduce: 2 }, mToken)
    assert(badNoImg.code !== 0, '启用中的券没配图被拒')
    const offNoImg = await api('POST', '/merchant/coupons', { title: '没图但停用', type: 'no_threshold', reduce: 2, status: 0 }, mToken)
    assert(offNoImg.code === 0, '先存成停用的券可以不配图（后补图再启用）')

    // 三张券：满30减5 / 无门槛减2 / 9折封顶3
    const c1 = await api('POST', '/merchant/coupons', {
      title: '满30减5', type: 'full_reduce', threshold: 30, reduce: 5,
      valid_type: 'relative', relative_days: 7, per_user_limit: 1, total_qty: 100,
      image: '/uploads/coupon-30-5.png'
    }, mToken)
    assert(c1.code === 0, '建满减券（相对有效期7天）')
    const c2 = await api('POST', '/merchant/coupons', {
      title: '无门槛减2', type: 'no_threshold', reduce: 2, valid_type: 'absolute', per_user_limit: 2, total_qty: 0,
      image: '/uploads/coupon-2.png'
    }, mToken)
    assert(c2.code === 0, '建无门槛券（每人限领2）')
    const c3 = await api('POST', '/merchant/coupons', {
      title: '9折最高减3', type: 'discount', discount: 0.9, max_reduce: 3, valid_type: 'absolute', per_user_limit: 1,
      image: '/uploads/coupon-90.png'
    }, mToken)
    assert(c3.code === 0, '建折扣券（9折封顶3）')

    // 券图要能透出到用户端（首页/活动页的图片列表靠它渲染）
    const imgList = await api('GET', '/coupon/list', null, sToken)
    assert(imgList.data.length === 3 && imgList.data.every((x) => !!x.image),
      '可领券列表带出券图（首页/活动页图片列表要用）')

    // 停用券没图 → 补图后可以启用（商家先存后补图的路径）；校验完删掉，免得影响后面的券数量
    assert((await api('PUT', '/merchant/coupons', {
      id: offNoImg.data.id, image: '/uploads/coupon-later.png', status: 1
    }, mToken)).code === 0, '补图后可以启用')
    await api('DELETE', '/merchant/coupons', { id: offNoImg.data.id }, mToken)

    console.log('\n[3] 用户领券')
    const list = await api('GET', '/coupon/list', null, sToken)
    assert(list.code === 0 && list.data.length === 3, '可领券列表 3 张')
    const r1 = await api('POST', '/coupon/receive', { coupon_id: c1.data.id }, sToken)
    assert(r1.code === 0, '领取满减券')
    assert(!!r1.data.expire_at, '相对有效期算出了到期时间：' + r1.data.expire_at)
    const r1again = await api('POST', '/coupon/receive', { coupon_id: c1.data.id }, sToken)
    assert(r1again.code !== 0, '每人限领1 → 重复领取被拒')
    await api('POST', '/coupon/receive', { coupon_id: c2.data.id }, sToken)
    const r2b = await api('POST', '/coupon/receive', { coupon_id: c2.data.id }, sToken)
    assert(r2b.code === 0, '限领2 → 第二张可领')
    const r2c = await api('POST', '/coupon/receive', { coupon_id: c2.data.id }, sToken)
    assert(r2c.code !== 0, '限领2 → 第三张被拒')

    console.log('\n[4] 结算可用券：门槛不足要说明原因')
    // 只买便宜的那件（大概率不足 30）
    const cheapQty = Math.max(1, Math.floor(25 / Number(cheap.price)))
    const smallOrder = [{ goods_id: cheap.id, quantity: cheapQty }]
    const u1 = await api('POST', '/coupon/usable', { items: smallOrder }, sToken)
    assert(u1.code === 0, '查询可用券')
    const fullReduce = u1.data.all
      ? u1.data.all.find((x) => x.coupon_id === c1.data.id)
      : (u1.data.usable.concat(u1.data.unusable)).find((x) => x.coupon_id === c1.data.id)
    assert(!!fullReduce, '满减券出现在列表里')
    if (fullReduce && !fullReduce.usable) {
      assert(/还差|未达/.test(fullReduce.reason_text) || fullReduce.reason === 'threshold',
        '未达门槛给出原因：' + fullReduce.reason_text)
    } else {
      console.log('  （该商品单价已满足门槛，跳过门槛原因断言）')
    }
    assert(!!u1.data.best, '给出了最优券推荐' + (u1.data.best ? '：' + u1.data.best.desc + ' 省' + u1.data.best.reduce : ''))

    console.log('\n[5] 最优券推荐：大额订单应选抵扣最多的')
    const bigItems = [{ goods_id: pricey.id, quantity: 3 }]
    const u2 = await api('POST', '/coupon/usable', { items: bigItems }, sToken)
    assert(u2.code === 0, '查询大额订单可用券')
    assert(!!u2.data.best, '有最优券')
    if (u2.data.best) {
      const bestReduce = Number(u2.data.best.reduce)
      const maxReduce = u2.data.usable.reduce((m, x) => Math.max(m, Number(x.reduce)), 0)
      assert(bestReduce === maxReduce, '推荐的就是抵扣最多的（' + u2.data.best.desc + ' 省 ' + u2.data.best.reduce + '）')
    }
    // 不可用券要给出原因
    if (u2.data.unusable.length) {
      assert(u2.data.unusable.every((x) => !!x.reason_text), '不可用券都带原因文案')
      console.log('     不可用示例：' + u2.data.unusable[0].desc + ' → ' + u2.data.unusable[0].reason_text)
    }

    console.log('\n[6] 下单用券：实付与分摊')
    const useItems = [{ goods_id: pricey.id, quantity: 3 }]
    const beforeTotal = Number((await api('POST', '/order/create', {
      landmark_id: lm.id, landmark_name: lm.name, contact_name: '测试', contact_phone: '13800000000',
      items: useItems, remark: '不用券'
    }, sToken)).data.total_amount)
    const withCoupon = await api('POST', '/order/create', {
      landmark_id: lm.id, landmark_name: lm.name, contact_name: '测试', contact_phone: '13800000000',
      items: useItems, remark: '用券', user_coupon_id: (u2.data.best || {}).user_coupon_id
    }, sToken)
    assert(withCoupon.code === 0, '用券下单成功')
    if (withCoupon.code === 0) {
      const afterTotal = Number(withCoupon.data.total_amount)
      const expect = Math.round((beforeTotal - Number((u2.data.best || {}).reduce || 0)) * 100) / 100
      assert(afterTotal === expect, '实付 = 原实付 − 券抵扣（' + beforeTotal + ' → ' + afterTotal + '，期望 ' + expect + '）')

      // 分摊：order_items.coupon_share 之和 == 券抵扣
      const oid = withCoupon.data.order_id
      const items = db.prepare('SELECT goods_id, price, quantity, coupon_share FROM order_items WHERE order_id=?').all(Number(oid))
      const shareSum = items.reduce((s, r) => s + Number(r.coupon_share || 0), 0)
      const couponAmt = Number(db.prepare('SELECT coupon_amount FROM orders WHERE id=?').get(Number(oid)).coupon_amount || 0)
      assert(items.length > 0, '订单商品明细已写入')
      assert(Math.abs(shareSum - couponAmt) < 0.011, '各商品分摊之和 = 订单券抵扣（' + shareSum.toFixed(2) + ' vs ' + couponAmt.toFixed(2) + '）')
      assert(couponAmt > 0, '订单落库了券抵扣金额 ' + couponAmt)

      // 券已标记使用
      const uc = db.prepare('SELECT status, used_at, order_id FROM user_coupons WHERE id=?').get(Number((u2.data.best || {}).user_coupon_id))
      assert(uc && Number(uc.status) === 1, '券已标记为已使用')
      assert(Number(uc.order_id) === Number(oid), '券记录了使用的订单号')

      // 同一张券不能再用
      const again = await api('POST', '/order/create', {
        landmark_id: lm.id, landmark_name: lm.name, contact_name: '测试', contact_phone: '13800000000',
        items: useItems, remark: '重复用券', user_coupon_id: (u2.data.best || {}).user_coupon_id
      }, sToken)
      assert(again.code !== 0, '已使用的券不能再次使用')
    }

    console.log('\n[7] 券的范围限制：指定商品券对其它商品不可用')
    const scoped = await api('POST', '/merchant/coupons', {
      title: '限商品券', type: 'no_threshold', reduce: 1, valid_type: 'absolute',
      scope: 'goods', scope_ids: [String(pricey.id)], per_user_limit: 1,
      image: '/uploads/coupon-scoped.png'
    }, mToken)
    assert(scoped.code === 0, '建指定商品的无门槛券')
    await api('POST', '/coupon/receive', { coupon_id: scoped.data.id }, sToken)
    const u3 = await api('POST', '/coupon/usable', { items: [{ goods_id: cheap.id, quantity: 5 }] }, sToken)
    const scopedItem = (u3.data.usable || []).concat(u3.data.unusable || []).find((x) => x.coupon_id === scoped.data.id)
    assert(scopedItem && !scopedItem.usable && scopedItem.reason === 'scope',
      '非适用商品时给出「商品不适用」：' + (scopedItem ? scopedItem.reason_text : '未找到'))
    const u4 = await api('POST', '/coupon/usable', { items: [{ goods_id: pricey.id, quantity: 1 }] }, sToken)
    const scopedOk = (u4.data.usable || []).find((x) => x.coupon_id === scoped.data.id)
    assert(!!scopedOk, '换成适用商品后该券可用')

    // 商家端列表页 / 编辑页依赖的接口形态：字段少一个，编辑页打开就会是空白表单
    console.log('\n[8] 商家端券列表 / 编辑（前端页面依赖的字段与接口）')
    const all = await api('GET', '/merchant/coupons', null, mToken)
    assert(all.code === 0 && Array.isArray(all.data), '商家端能拉券模板列表')
    const row = (all.data || []).find((x) => Number(x.id) === Number(c1.data.id))
    assert(!!row, '列表里能找到刚建的满减券')
    if (row) {
      const need = ['title', 'type', 'threshold', 'reduce', 'discount', 'max_reduce', 'valid_type',
        'relative_days', 'scope', 'scope_ids', 'total_qty', 'issued', 'per_user_limit', 'status']
      const missing = need.filter((k) => row[k] === undefined)
      assert(missing.length === 0, '券模板字段齐全（缺：' + (missing.join(',') || '无') + '）')
    }

    // per_user_limit = 0 必须真的是「不限领」：编辑页「不填即不限领」走的就是这条路，
    // 一旦被 `|| 1` 吞掉，商家以为设了不限领、实际每人只能领 1 张
    const unl = await api('POST', '/merchant/coupons', {
      title: '不限领券', type: 'no_threshold', reduce: 1, valid_type: 'absolute', per_user_limit: 0,
      image: '/uploads/coupon-unlimited.png'
    }, mToken)
    assert(unl.code === 0, '建「不限领」券')
    const unlRow = ((await api('GET', '/merchant/coupons', null, mToken)).data || [])
      .find((x) => Number(x.id) === Number(unl.data.id))
    assert(unlRow && Number(unlRow.per_user_limit) === 0, 'per_user_limit=0 落库仍是不限领（没被默认值吞成 1）')
    await api('POST', '/coupon/receive', { coupon_id: unl.data.id }, sToken)
    const unl2 = await api('POST', '/coupon/receive', { coupon_id: unl.data.id }, sToken)
    assert(unl2.code === 0, '不限领 → 同一人可领第二张')

    // 编辑（PUT 用库里原值兜底，前端只传变化字段也不会把其它字段清空）
    const upd = await api('PUT', '/merchant/coupons', { id: unl.data.id, title: '不限领券(改)', reduce: 3 }, mToken)
    assert(upd.code === 0, '编辑券成功')
    const updRow = ((await api('GET', '/merchant/coupons', null, mToken)).data || [])
      .find((x) => Number(x.id) === Number(unl.data.id))
    assert(updRow && updRow.title === '不限领券(改)' && Number(updRow.reduce) === 3, '改动已落库')
    assert(updRow && updRow.type === 'no_threshold', '没传的字段保持原值（没被清空）')

    console.log('\n[9] 停用券：不能再领，已领到的在结算时判为不可用')
    assert((await api('POST', '/coupon/receive', { coupon_id: c3.data.id }, sToken)).code === 0, '先领一张折扣券')
    await api('PUT', '/merchant/coupons/status', { id: c3.data.id, status: 0 }, mToken)
    const c3Row = ((await api('GET', '/merchant/coupons', null, mToken)).data || [])
      .find((x) => Number(x.id) === Number(c3.data.id))
    assert(c3Row && Number(c3Row.status) === 0, '券已停用')
    assert((await api('POST', '/coupon/receive', { coupon_id: c3.data.id }, sToken)).code !== 0, '停用后不能再领')
    const u5 = await api('POST', '/coupon/usable', { items: [{ goods_id: pricey.id, quantity: 3 }] }, sToken)
    const off = (u5.data.usable || []).concat(u5.data.unusable || []).find((x) => x.coupon_id === c3.data.id)
    assert(off && !off.usable && off.reason === 'disabled',
      '停用券在结算页判为不可用：' + (off ? off.reason_text : '未找到'))

    console.log('\n[10] 我的券分组 + 结算页渲染字段')
    const mine = await api('GET', '/coupon/mine', null, sToken)
    assert(mine.code === 0, '拉我的券')
    const md = mine.data || {}
    assert(Array.isArray(md.unused) && Array.isArray(md.used) && Array.isArray(md.expired),
      '分成 未使用 / 已使用 / 已过期 三组')
    assert(Number(md.count) === (md.unused || []).length,
      '未使用张数 = 未使用列表长度（' + md.count + '）')
    assert((md.used || []).some((x) => Number(x.coupon_id) === Number(c1.data.id)), '用掉的满减券落在「已使用」组')
    assert((md.unused || []).every((x) => x.title && x.desc), '未使用券都带名称与规则文案（列表不出现空卡片）')

    // 结算页面额块与有效期要用 type / face_reduce / expire_at，缺了会显示成「-¥0」或没有有效期
    const sample = (u2.data.usable || [])[0]
    if (sample) {
      const need = ['user_coupon_id', 'coupon_id', 'title', 'desc', 'type', 'face_reduce',
        'reduce', 'reason_text', 'expire_at']
      const missing = need.filter((k) => sample[k] === undefined)
      assert(missing.length === 0, '结算可用券字段齐全（缺：' + (missing.join(',') || '无') + '）')
    }

    console.log('')
    if (bad === 0) console.log('全部通过 ✓')
    else console.log('失败 ' + bad + ' 项 ✘')
  } catch (e) {
    console.error('测试异常：' + (e && e.message))
    bad++
  } finally {
    try { if (child) child.kill() } catch (e) { /* 忽略 */ }
    try { if (db) db.close() } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(TMP_DB) } catch (e) { /* 忽略 */ }
    process.exit(bad === 0 ? 0 : 1)
  }
})()
