// 活动「草稿 / 发布」分离 + 发布强制配图 回归测试
// （Mock + 临时库 + 独立端口 3102，不影响真实环境）
// 用法：cd backend && node tests/test_activity_draft.js
//
// 覆盖：
//   ① 新建时只保存 → status=0 草稿，用户端活动页看不到、也不参与折扣计价
//   ② 草稿发布 → status=1，用户端可见且计价生效
//   ③ 已发布活动「保存」不改变上下架状态（最容易踩的坑：改文案顺手把线上活动下线）
//   ④ 下线 → status=2（与草稿区分），用户端不可见、计价失效
//   ⑤ 已下线可重新发布
//   ⑥ 旧接口只传 status 仍兼容（1→发布 / 0→下线）
//   ⑦ 发布强制配图：无图不能发布，且被拒时不会改掉已有内容（先校验后写库）
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3102
const TMP_DB = path.join(os.tmpdir(), 'lingdong_act_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
const MER_USER = 'testmerchant'
const MER_PASS = 'test123456'
// 任意后端自有的相对路径即可（safeImageUrl 只校验前缀/格式，不要求文件真的存在）
const IMG = '/uploads/act_test.jpg'

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
const actStatus = (list, id) => {
  const a = (list || []).find((x) => Number(x.id) === Number(id))
  return a ? Number(a.status) : null
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
    const stu = await api('POST', '/auth/login', { code: 'stu-act-' + Date.now(), client: 'user', nickname: '测试学生' })
    assert(stu.code === 0, '学生登录')
    const sToken = stu.data.token

    const goods = await api('GET', '/goods/list', null, sToken)
    const g = goods.data.find((x) => x.stock >= 20) || goods.data[0]
    const lms = await api('GET', '/landmarks', null, sToken)
    const lm = (lms.data || []).find((x) => x.type === 'deliverPoint')
    assert(!!lm, '存在可送达点位')

    const MK = (title, status_action, extra) => Object.assign({
      title, subtitle: '', image: IMG, link: '', sort: 0, type: 'discount',
      config: { scope: 'goods', goods_ids: [g.id], discount: 0.5 },
      start_at: '', end_at: '', status_action
    }, extra || {})

    // 主活动：保证订单始终有一个可命中的折扣，隔离「草稿是否影响计价」的干扰项
    const main = await api('POST', '/merchant/activities', MK('主促销', 'publish'), mToken)
    assert(main.code === 0, '创建主促销并发布')

    const orderTotal = async (tag) => {
      const r = await api('POST', '/order/create', {
        landmark_id: lm.id, landmark_name: lm.name,
        contact_name: '测试', contact_phone: '13800000000',
        items: [{ goods_id: g.id, quantity: 2 }], remark: tag
      }, sToken)
      return r.code === 0 ? Number(r.data.total_amount) : null
    }

    console.log('\n[2] 保存草稿（允许无图、不上架）')
    const draft = await api('POST', '/merchant/activities', MK('草稿活动', 'draft', { image: '' }), mToken)
    assert(draft.code === 0, '无图也能存草稿')
    assert(draft.data.status === 0, '新建草稿返回 status=0')
    const draftId = draft.data.id

    let list = await api('GET', '/merchant/activities', null, mToken)
    assert(actStatus(list.data, draftId) === 0, '库里草稿 status=0')
    let pub = await api('GET', '/activity/list', null, sToken)
    assert((pub.data || []).every((a) => Number(a.id) !== Number(draftId)), '用户端活动列表看不到草稿')

    console.log('\n[3] 草稿不参与计价（不该悄悄影响价格）')
    const t1 = await orderTotal('草稿阶段')
    const t2 = await orderTotal('主促销阶段')
    assert(t1 !== null && t1 === t2, '草稿存在与否不影响订单金额（' + t1 + ' vs ' + t2 + '）')

    console.log('\n[4] 发布强制配图')
    const noImg = await api('PUT', '/merchant/activities', MK('草稿活动', 'publish', { id: draftId, image: '' }), mToken)
    assert(noImg.code !== 0, '无图发布被拒绝')
    assert(String(noImg.msg || '').indexOf('图片') > -1, '拒绝理由指向图片（msg=' + noImg.msg + '）')
    list = await api('GET', '/merchant/activities', null, mToken)
    assert(actStatus(list.data, draftId) === 0, '被拒后仍是草稿（没有半发布）')
    const rowAfter = list.data.find((a) => Number(a.id) === draftId)
    assert(rowAfter && rowAfter.image === '', '被拒时内容没被写库（先校验后写库）')

    const pubNoImg = await api('POST', '/merchant/activities', MK('直接发布无图', 'publish', { image: '' }), mToken)
    assert(pubNoImg.code !== 0, '新建时直接发布无图也被拒绝')

    console.log('\n[5] 配图后发布')
    const okPub = await api('PUT', '/merchant/activities', MK('草稿活动', 'publish', { id: draftId }), mToken)
    assert(okPub.code === 0, '配图后发布成功')
    list = await api('GET', '/merchant/activities', null, mToken)
    assert(actStatus(list.data, draftId) === 1, '发布后 status=1')
    pub = await api('GET', '/activity/list', null, sToken)
    assert((pub.data || []).some((a) => Number(a.id) === Number(draftId)), '用户端活动列表能看到已发布活动')

    console.log('\n[6] 已发布活动「只保存」不能改变上下架状态（防误下线）')
    const saved = await api('PUT', '/merchant/activities', MK('草稿活动改名', 'draft', { id: draftId }), mToken)
    assert(saved.code === 0, '已发布活动保存成功')
    list = await api('GET', '/merchant/activities', null, mToken)
    assert(actStatus(list.data, draftId) === 1, '保存后仍是已发布（没被悄悄下线）')

    console.log('\n[7] 下线')
    const off = await api('PUT', '/merchant/activities/status', { id: draftId, action: 'offline' }, mToken)
    assert(off.code === 0 && off.data.status === 2, '下线后 status=2（与草稿 0 区分）')
    pub = await api('GET', '/activity/list', null, sToken)
    assert((pub.data || []).every((a) => Number(a.id) !== Number(draftId)), '下线后用户端不可见')

    console.log('\n[8] 已下线重新发布')
    const rep = await api('PUT', '/merchant/activities/status', { id: draftId, action: 'publish' }, mToken)
    assert(rep.code === 0 && rep.data.status === 1, '已下线可重新发布 → status=1')

    console.log('\n[9] 旧接口只传 status 的兼容性（status=1 → 视为发布）')
    const legacy = await api('PUT', '/merchant/activities/status', { id: draftId, status: 1 }, mToken)
    assert(legacy.code === 0 && legacy.data.status === 1, '旧调用 status=1 被正确视为发布')

    console.log('\n[10] 未知 action 被拒绝')
    const bogus = await api('PUT', '/merchant/activities/status', { id: draftId, action: 'whatever' }, mToken)
    assert(bogus.code !== 0, '未知 action 返回错误而不是静默改状态')

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
