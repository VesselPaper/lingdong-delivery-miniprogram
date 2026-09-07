// 零栋无人送餐后端
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

// 轻量 .env 加载（零依赖）：backend/.env 存在时读取，格式 KEY=VALUE（# 注释行）
// 注意：必须最先执行——services/platform 与 services/wxpay 在模块加载时就读取 env，
// 若晚于 require 执行，APPID/SECRET 等将被捕获为空。
;(function loadEnvFile() {
  try {
    const p = path.join(__dirname, '.env')
    if (!fs.existsSync(p)) return
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      const k = t.slice(0, i).trim()
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
      if (k && process.env[k] === undefined) process.env[k] = v
    }
  } catch (e) { /* 忽略 .env 读取异常 */ }
})()

const express = require('express')
const cors = require('cors')
const { init } = require('./db')
// 运行模式守卫必须在 require('./services/platform') 之前执行：platform.js 在模块加载期
// 就把 PLATFORM_MOCK 等 env 捕获成常量，晚于它校验就无法再阻止非法组合启动。
const runtime = require('./services/runtime')
runtime.assertBootable()
const platform = require('./services/platform')
const wxpay = require('./services/wxpay')
const batch = require('./services/batch')
const goodsStats = require('./services/goodsStats')
const orderCancel = require('./services/orderCancel')

// 派车告警以注入方式挂到平台适配层，避免 platform.js 反向依赖 runtime.js 形成环
platform.setDispatchHook(runtime.warnIfUnsafeDispatch)

const store = init()
const app = express()
const PORT = process.env.PORT || 3000
const UPLOAD_DIR = path.join(__dirname, 'uploads')

const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

app.use(cors())
// 仅对支付回调路径保存原始报文（供 P0-6 平台证书验签）；其它路径（如 8mb 图片上传）不缓存，避免内存翻倍
app.use(express.json({ limit: '8mb', verify: (req, res, buf) => { if (req.originalUrl === '/api/pay/notify') req.rawBody = buf } }))
app.use('/uploads', express.static(UPLOAD_DIR))

// 简易鉴权：token = openid 的哈希，正式环境可换 JWT
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ code: 401, msg: '未登录' })
  const row = store.prepare('SELECT * FROM users WHERE openid=?').get(token)
  if (!row) return res.status(401).json({ code: 401, msg: '登录失效' })
  req.user = row
  next()
}

function ok(res, data = null, msg = 'success') {
  res.json({ code: 0, msg, data })
}

// 手机号脱敏（P1-13）：商家端接口对外默认 138****0000，明文只在服务端内部逻辑使用
function maskPhone(p) {
  const s = String(p || '')
  if (!s) return ''
  return s.length <= 7 ? (s.slice(0, 1) + '****' + s.slice(-2)) : (s.slice(0, 3) + '****' + s.slice(-4))
}

// 商家敏感操作审计（P1-13）：改价/上下架/退款/取消/派车/设备控制/活动全部落 audit_logs，
// 配合手机号脱敏形成「展示最小化、操作可追溯」的隐私与责任闭环。
function audit(req, action, target, detail) {
  try {
    store.prepare('INSERT INTO audit_logs (user_id, user_role, action, target, detail) VALUES (?,?,?,?,?)')
      .run(req.user ? req.user.id : 0, req.user ? (req.user.role || '') : '', action, String(target || ''), String(detail || '').slice(0, 500))
  } catch (e) { /* 审计失败不阻断业务 */ }
}

// 库存值归一化：未传/空 → 默认 999；显式 0 必须保留为 0（修复「设库存 0 保存后变回 999」）
function toStock(v, fallback = 999) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return isNaN(n) || n < 0 ? 0 : n
}

// ---------- 登录 ----------
// 角色不再由客户端自报：此前 body 里传 role:'merchant' 就能成为商家，任何人都能自助拿到
// 改价、上下架、退款、派车（真实调度机器人）等权限。改为校验 .env 的 MERCHANT_INVITE_CODE。
app.post('/api/auth/login', async (req, res) => {
  const { code, nickname = '', merchant_code = '', client = 'user' } = req.body || {}
  if (!code) return res.status(400).json({ code: 400, msg: '缺少登录凭证' })
  const clientKey = client === 'merchant' ? 'merchant' : 'user'

  // 填了邀请码就必须正确；未配置邀请码时 verifyMerchantCode 恒为 false（安全侧：一律拒绝）
  const wantsMerchant = String(merchant_code).trim() !== ''
  if (wantsMerchant && !runtime.verifyMerchantCode(String(merchant_code).trim())) {
    return res.status(403).json({ code: 403, msg: '商家邀请码不正确' })
  }

  let openid = ''
  const creds = runtime.loginCreds(clientKey)
  if (creds) {
    // 真实微信登录：零栋GO（用户端）与零栋商家（商家端）是不同小程序，用各自的 appid/secret
    try {
      const u = 'https://api.weixin.qq.com/sns/jscode2session'
        + '?appid=' + encodeURIComponent(creds.appid)
        + '&secret=' + encodeURIComponent(creds.secret)
        + '&js_code=' + encodeURIComponent(code)
        + '&grant_type=authorization_code'
      const resp = await fetch(u)
      const data = await resp.json()
      if (!data.openid) return res.status(401).json({ code: 401, msg: '微信登录失败：' + (data.errmsg || '未知错误') })
      openid = data.openid
    } catch (e) {
      return res.status(500).json({ code: 500, msg: '登录服务异常' })
    }
  } else {
    // ==================== 演示模式 ====================
    // 以 code 的稳定哈希作为 openid，同一设备账号稳定，便于预览页面。
    // token 即 openid：可预测、不可吊销，因此 RUN_MODE=production 下启动守卫会拒绝这种配置。
    openid = 'demo_' + crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 24)
  }

  let user = store.prepare('SELECT * FROM users WHERE openid=?').get(openid)
  if (!user) {
    // 新注册：只有持正确邀请码才成为商家
    const info = store.prepare('INSERT INTO users (openid, nickname, role) VALUES (?,?,?)')
      .run(openid, nickname || '微信用户', wantsMerchant ? 'merchant' : 'student')
    user = store.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid))
  } else {
    if (nickname) store.prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname, user.id)
    // 已是商家的老用户不必每次输码；持正确邀请码则可把学生升级为商家
    if (wantsMerchant && user.role !== 'merchant') {
      store.prepare("UPDATE users SET role='merchant' WHERE id=?").run(user.id)
      console.log(`[auth] 用户 ${user.id} 凭邀请码升级为商家`)
    }
    user = store.prepare('SELECT * FROM users WHERE id=?').get(user.id)
  }
  // runtime 标志随登录下发：商家端据此决定设备控制走真实还是模拟分支（不再前端硬编码）
  ok(res, {
    token: user.openid,
    user,
    runtime: { mode: runtime.mode, device_mock: runtime.deviceMock, pay_mock: !runtime.realPay, login: runtime.loginMode(clientKey) }
  })
})

app.get('/api/user/profile', auth, (req, res) => ok(res, req.user))

app.put('/api/user/profile', auth, (req, res) => {
  const { nickname, phone } = req.body || {}
  if (nickname !== undefined && nickname !== null) {
    store.prepare('UPDATE users SET nickname=? WHERE id=?').run(String(nickname), req.user.id)
  }
  if (phone !== undefined && phone !== null) {
    store.prepare('UPDATE users SET phone=? WHERE id=?').run(String(phone), req.user.id)
  }
  const user = store.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
  ok(res, user)
})

// ---------- 商品 ----------
app.get('/api/goods/categories', (req, res) => {
  const rows = store.prepare('SELECT DISTINCT category FROM goods WHERE status=1 ORDER BY id').all()
  ok(res, rows.map((r) => r.category))
})

app.get('/api/goods/list', (req, res) => {
  const { category = '', keyword = '' } = req.query
  let sql = 'SELECT * FROM goods WHERE status=1'
  const args = []
  if (category) { sql += ' AND category=?'; args.push(category) }
  if (keyword) { sql += ' AND name LIKE ?'; args.push('%' + keyword + '%') }
  sql += ' ORDER BY sales DESC'
  ok(res, store.prepare(sql).all(...args))
})

app.get('/api/goods/detail', (req, res) => {
  const row = store.prepare('SELECT * FROM goods WHERE id=?').get(Number(req.query.id || 0))
  row ? ok(res, row) : res.status(404).json({ code: 404, msg: '商品不存在' })
})

// ---------- 点位 ----------
// 公开列表裁剪物流平台内部 ID（P1-13）：platform_building_id / platform_map_id / platform_landmark_id
// 是开放物流平台的场地/点位内部编号，对匿名请求暴露等于泄露平台结构。用户端只需点位展示与选择。
app.get('/api/landmarks', (req, res) => {
  const rows = store.prepare('SELECT * FROM landmarks ORDER BY sort').all()
  // 有有效登录态的请求（商家点位同步等内部用途）返回全字段；匿名请求一律裁剪
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  const authed = token ? !!store.prepare('SELECT id FROM users WHERE openid=?').get(token) : false
  const out = authed ? rows : rows.map((r) => {
    const { platform_building_id, platform_map_id, platform_landmark_id, ...rest } = r
    return rest
  })
  ok(res, out)
})

// ---------- 购物车 ----------
app.get('/api/cart/list', auth, (req, res) => {
  const rows = store.prepare(`
    SELECT c.id, c.goods_id, c.quantity, c.selected, g.name, g.price, g.image, g.status AS goods_status, g.stock AS goods_stock
    FROM cart c LEFT JOIN goods g ON c.goods_id = g.id
    WHERE c.user_id=? ORDER BY c.id DESC`).all(req.user.id)
  ok(res, rows)
})

app.post('/api/cart/add', auth, (req, res) => {
  const { goods_id, quantity = 1 } = req.body || {}
  const exist = store.prepare('SELECT * FROM cart WHERE user_id=? AND goods_id=?')
    .get(req.user.id, Number(goods_id))
  if (exist) {
    store.prepare('UPDATE cart SET quantity=quantity+? WHERE id=?').run(Number(quantity), exist.id)
  } else {
    store.prepare('INSERT INTO cart (user_id, goods_id, quantity) VALUES (?,?,?)')
      .run(req.user.id, Number(goods_id), Number(quantity))
  }
  ok(res)
})

app.put('/api/cart/update', auth, (req, res) => {
  const { id, quantity, selected } = req.body || {}
  if (quantity !== undefined) store.prepare('UPDATE cart SET quantity=? WHERE id=? AND user_id=?').run(Number(quantity), Number(id), req.user.id)
  if (selected !== undefined) store.prepare('UPDATE cart SET selected=? WHERE id=? AND user_id=?').run(selected ? 1 : 0, Number(id), req.user.id)
  ok(res)
})

app.delete('/api/cart/remove', auth, (req, res) => {
  store.prepare('DELETE FROM cart WHERE id=? AND user_id=?').run(Number(req.body.id), req.user.id)
  ok(res)
})

// ---------- 地址 ----------
app.get('/api/address/list', auth, (req, res) => {
  ok(res, store.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC').all(req.user.id))
})

app.post('/api/address/save', auth, (req, res) => {
  const { id, contact_name, contact_phone, landmark_id, landmark_name, detail, is_default } = req.body || {}
  // landmark_id 显式转字符串存储（node:sqlite 把整数绑定到 TEXT 列会存成 "2.0"，导致与点位 id 无法字符串匹配）
  const lmId = landmark_id === undefined || landmark_id === null ? '' : String(landmark_id)
  if (is_default) store.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.user.id)
  if (id) {
    store.prepare('UPDATE addresses SET contact_name=?, contact_phone=?, landmark_id=?, landmark_name=?, detail=?, is_default=? WHERE id=? AND user_id=?')
      .run(contact_name, contact_phone, lmId, landmark_name, detail || '', is_default ? 1 : 0, Number(id), req.user.id)
  } else {
    store.prepare('INSERT INTO addresses (user_id, contact_name, contact_phone, landmark_id, landmark_name, detail, is_default) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.id, contact_name, contact_phone, lmId, landmark_name, detail || '', is_default ? 1 : 0)
  }
  ok(res)
})

app.delete('/api/address/delete', auth, (req, res) => {
  store.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(Number(req.body.id), req.user.id)
  ok(res)
})

// ---------- 订单 ----------
const ORDER_STATUS = {
  0: '待支付', 1: '待接单', 2: '配送中', 3: '已送达', 4: '已完成', 5: '已取消', 6: '配送异常', 7: '已退款'
}

// 售后状态：0 待处理 / 2 已拒绝 / 3 已退款 / 4 已处理(投诉)
const REFUND_STATUS = { 0: '待处理', 2: '已拒绝', 3: '已退款', 4: '已处理' }

// 取消申请状态：0 待处理 / 2 已拒绝 / 3 已同意取消
const CANCEL_REQ_STATUS = { 0: '待处理', 2: '已拒绝', 3: '已同意取消' }

// 免费取消时间窗：下单后该时长内可直接取消（不论商家是否接单），超过须提交取消申请由商家判断。
// 可用环境变量 FREE_CANCEL_WINDOW_MS 覆盖（单位 ms），默认 10 分钟。
const FREE_CANCEL_WINDOW_MS = Number(process.env.FREE_CANCEL_WINDOW_MS || 10 * 60 * 1000)

// 重新开舱限制（P1-2）：取餐开舱后允许在窗口内重新打开（防「未取到餐」），但必须限次数限时，
// 否则单舱机型下每次开舱都把同仓其他用户的餐暴露一次。默认送达后 10 分钟内、最多开舱 3 次。
const PICKUP_REOPEN_WINDOW_MS = Number(process.env.PICKUP_REOPEN_WINDOW_MS || 10 * 60 * 1000)
const MAX_PICKUP_OPEN = Number(process.env.MAX_PICKUP_OPEN || 3)

// 配送卡死阈值（P1-4）：订单停留「配送中」超过该时长且任务非终态 → 视为卡死，向用户开放退款出口。
// 同时也是超时扫描（未接单/挂起状态）的阈值与扫描间隔。必须定义在模块顶层：
// orderStuckDelivering 在演示/真实两种档位都会被调用，原先定义在 if (runtime.realPlatform)
// 块内导致 demo 档（PLATFORM_MOCK=true）下引用未定义变量直接 ReferenceError。
const DELIVERY_TIMEOUT_MS = Number(process.env.DELIVERY_TIMEOUT_MS || 15 * 60 * 1000)
const DELIVERY_SCAN_MS = Number(process.env.DELIVERY_SCAN_MS || 60 * 1000)

// 订单是否「真正开始配送」：已接单(2)且机器人已上货出发（任务状态 >= 50 已上货）
function orderTrulyDelivering(order) {
  if (Number(order.status) !== 2) return false
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  return !!task && Number(task.task_status) >= 50
}

// 订单是否「卡死配送中」（P1-4）：已接单(2)但任务停留在非终态且长期无进展（超过 DELIVERY_TIMEOUT_MS）。
// 机器人在半路故障/挂起（120/130/131/132/140）时订单会永远停在配送中，用户三个自助入口全被后端拒绝，
// 这里为这类订单开放「申请退款」出口。
function orderStuckDelivering(order) {
  if (Number(order.status) !== 2) return false
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  if (!task || task.void_at) return false
  if ([70, 80, 110, 150].includes(Number(task.task_status))) return false
  const t = new Date(String(task.updated_at || '').replace(' ', 'T')).getTime()
  return !isNaN(t) && Date.now() - t > DELIVERY_TIMEOUT_MS
}

// 自动接单：营业中且 auto_accept=1 时，已支付订单自动接单并并入当前配送批次。
// 返回 true 表示已自动接单；否则保持待接单（等待商家手动确认）。
function maybeAutoAccept(store, order) {
  const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
  if (shop.business_status !== 'open' || Number(shop.auto_accept) !== 1) return false
  if (Number(order.status) !== 1) return false
  const cur = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
  if (!cur) return false
  try {
    batch.addOrderToBatch(store, cur)
    console.log('[order] 自动接单 order=' + cur.id + ' ' + cur.order_no + ' → 批次并入')
    // 派车由批次自动派车扫描统一处理（有订单即派，机器人自动前往上货点），保证一车多单组单窗口
    return true
  } catch (e) {
    console.warn('[order] 自动接单并入批次失败', e.message)
    return false
  }
}

// 是否仍在免费取消窗口内（按下单时间计）
function withinFreeCancelWindow(order) {
  const t = new Date(String(order.created_at || '').replace(' ', 'T')).getTime()
  if (isNaN(t)) return false
  return Date.now() - t <= FREE_CANCEL_WINDOW_MS
}

// 订单取消落库 + 真实召回（P0-4）：委托 services/orderCancel —— 平台推送 110/150 也走同一处，
// 取消的全部本地副作用（作废任务 + 回补库存 + 摘除批次 + 停模拟推进）只有一份实现。
// 本地落账是同步的（cancelLocal 内部不得 await），随后才 await 平台召回：
//   排队中(未拉取 task_status<10) → queue/cancel；已上货/途中 → deviceCtrl/close（舱内有货自动开舱）。
// 平台召回失败只记 recall_status=2 待人工，本地是唯一真相源，不回滚。
// 返回 { claimed, finalStatus, tasks }：claimed=false 表示订单已在终态，本次是重复取消。
async function applyOrderCancelled(order, opts) {
  const o = Object.assign({ reason: '订单取消' }, opts || {})
  const c = orderCancel.cancelLocal(store, order, o)
  if (!c.claimed || !c.tasks || !c.tasks.length) return c
  for (const t of c.tasks) {
    try {
      const st = Number(t.task_status)
      let r = null
      if (st < 10 && t.platform_task_id) {
        r = await platform.cancelQueueTask(t.platform_task_id)
      } else if (t.device_sn && t.platform_task_id) {
        r = await platform.closeTask(t.device_sn, t.platform_task_id, o.reason || '订单取消')
      }
      if (r) {
        store.prepare("UPDATE delivery_tasks SET recall_status=?, recall_error=?, updated_at=datetime('now','localtime') WHERE id=?")
          .run(r.ok ? 1 : 2, r.ok ? '' : String(r.msg || '').slice(0, 200), t.id)
      }
    } catch (e) {
      store.prepare("UPDATE delivery_tasks SET recall_status=2, recall_error=?, updated_at=datetime('now','localtime') WHERE id=?")
        .run(String(e.message || e).slice(0, 200), t.id)
    }
  }
  return c
}

// 真实退款（P0-5）：仅真实微信支付渠道且凭据就绪时真正退钱；模拟支付/未配凭据 → 本地标记 + 告警。
// 真实退款失败返回 { ok:false, msg }，调用方须保持售后待处理并返回错误，绝不本地假装已退款。
async function realRefundOrLocal(order, refundId, amount) {
  if (!order) return { ok: true, local: true, refundNo: '' }
  const outRefundNo = 'R' + String(Date.now()).slice(-12) + (refundId ? '-' + refundId : '')
  if (String(order.pay_channel) === 'wxpay' && wxpay.enabled()) {
    try {
      const r = await wxpay.refund({
        outTradeNo: order.order_no,
        outRefundNo,
        refundFen: Math.round(Number(amount || order.total_amount) * 100),
        totalFen: Math.round(Number(order.total_amount) * 100),
        reason: '退款'
      })
      return { ok: true, local: false, refundNo: r.out_refund_no || outRefundNo }
    } catch (e) {
      return { ok: false, msg: '真实退款失败：' + (e.message || e) }
    }
  }
  console.warn('[refund] 订单 ' + order.order_no + ' 为模拟支付或未配置支付凭据，仅本地标记已退款（无可退资金）')
  return { ok: true, local: true, refundNo: '' }
}

// 订单拆单：按 maxItems 件上限把购物车行贪心拆成多个子订单行块（每块 ≤ maxItems 件）。
// 例：A×15 → [[A12],[A3]]；A×8+B×7 → [[A8,B4],[B3]]
function splitOrderChunks(lineItems, maxItems) {
  const chunks = []
  let cur = []
  let curQty = 0
  for (const it of lineItems) {
    let q = it.quantity
    while (q > 0) {
      const take = Math.min(q, maxItems - curQty)
      cur.push({ goods: it.goods, quantity: take })
      curQty += take
      q -= take
      if (curQty >= maxItems) {
        chunks.push(cur)
        cur = []
        curQty = 0
      }
    }
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

app.post('/api/order/create', auth, (req, res) => {
  try {
    const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
    if (shop.business_status === 'closed') {
      return res.status(400).json({ code: 400, msg: '店铺歇业中，暂无法下单' })
    }
    const { landmark_id, landmark_name, remark = '', items = [], contact_name = '', contact_phone = '', address_id } = req.body || {}
    if (!items.length) return res.status(400).json({ code: 400, msg: '订单不能为空' })
    // 收餐人落库（P0-3）：姓名 trim 非空 ≤20；手机号必须校验，真机下货验证依赖该字段
    const cname = String(contact_name || '').trim()
    const cphone = String(contact_phone || '').trim()
    if (!cname) return res.status(400).json({ code: 400, msg: '请填写收餐人姓名' })
    if (cname.length > 20) return res.status(400).json({ code: 400, msg: '收餐人姓名过长' })
    if (!/^1\d{10}$/.test(cphone)) return res.status(400).json({ code: 400, msg: '请填写正确的手机号' })
    // 点位存在性校验（P2-8）：必须是可用的送达点，避免订单指向不存在的点位
    const lm = landmark_id ? store.prepare("SELECT * FROM landmarks WHERE id=? AND type='deliverPoint'").get(String(landmark_id)) : null
    if (!lm) return res.status(400).json({ code: 400, msg: '送达点位不存在或不可用' })
    let total = 0
    const lineItems = items.map((it) => {
      const q = Number(it.quantity)
      if (!Number.isInteger(q) || q <= 0 || q > 99) throw new Error('商品数量不合法')
      const g = store.prepare('SELECT * FROM goods WHERE id=?').get(Number(it.goods_id))
      if (!g) throw new Error('商品不存在')
      if (Number(g.stock) < q) throw new Error('「' + g.name + '」库存不足')
      total += g.price * q
      return { goods: g, quantity: q }
    })
    // 单笔订单总件数超过单车容量（BATCH_MAX_ITEMS=12）时自动拆单：不再拒单，
    // 按 12 件上限贪心拆成多个子订单，每个子订单独立组单/派车/配送/取餐。
    const totalItems = lineItems.reduce((s, it) => s + it.quantity, 0)
    // 拆单前整体预校验库存（拆单后同一商品会被分多次扣减，先确认总量够，避免中途失败）
    for (const it of lineItems) {
      const g = store.prepare('SELECT stock FROM goods WHERE id=?').get(it.goods.id)
      if (!g || Number(g.stock) < it.quantity) throw new Error('「' + it.goods.name + '」库存不足')
    }
    const chunks = totalItems > batch.BATCH_MAX_ITEMS ? splitOrderChunks(lineItems, batch.BATCH_MAX_ITEMS) : [lineItems]
    const created = []
    const seqRowBase = store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=date('now','localtime')").get()
    let seq = Number(seqRowBase && seqRowBase.c || 0)
    const orderNoNew = () => 'LD' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6).toUpperCase()
    const pickupCodeNew = () => String(Math.floor(1000 + Math.random() * 9000))
    const insOrder = store.prepare(`INSERT INTO orders
      (order_no, user_id, landmark_id, landmark_name, contact_name, contact_phone, total_amount, status, remark, pickup_code, daily_seq)
      VALUES (?,?,?,?,?,?,?,0,?,?,?)`)
    const insItem = store.prepare('INSERT INTO order_items (order_id, goods_id, goods_name, goods_image, price, quantity) VALUES (?,?,?,?,?,?)')
    const decStock = store.prepare('UPDATE goods SET stock=stock-? WHERE id=? AND stock>=?')
    for (const chunk of chunks) {
      const chunkTotal = chunk.reduce((s, it) => s + it.goods.price * it.quantity, 0)
      const orderNo = orderNoNew()
      const pickupCode = pickupCodeNew()
      seq += 1
      const info = insOrder.run(orderNo, req.user.id, String(landmark_id), lm.name, cname, cphone, chunkTotal.toFixed(2), remark, pickupCode, seq)
      const orderId = Number(info.lastInsertRowid)
      for (const { goods, quantity } of chunk) {
        insItem.run(orderId, goods.id, goods.name, goods.image, goods.price, quantity)
        // 条件更新扣库存（P1-5）：校验与扣减原子，扣不到即超卖
        const r = decStock.run(quantity, goods.id, quantity)
        if (r.changes === 0) throw new Error('「' + goods.name + '」库存不足')
      }
      created.push({ order_id: orderId, order_no: orderNo, total_amount: chunkTotal, pickup_code: pickupCode, items: chunk.length })
    }
    // 购物车只删本次订单实际包含的商品（P1-6）：不再无条件清空整张购物车
    const cartGids = [...new Set(lineItems.map((it) => it.goods.id))]
    cartGids.forEach((gid) => store.prepare('DELETE FROM cart WHERE user_id=? AND goods_id=?').run(req.user.id, gid))
    if (created.length === 1) {
      const o = created[0]
      ok(res, { order_id: o.order_id, order_no: o.order_no, total_amount: o.total_amount, pickup_code: o.pickup_code })
    } else {
      ok(res, { orders: created, split: true, split_count: created.length, total_amount: total })
    }
  } catch (e) {
    // 业务错误统一 400 JSON（P2-7）：不再让裸 throw 变成 HTML 500
    res.status(400).json({ code: 400, msg: e.message || '下单失败' })
  }
})

app.post('/api/order/pay', auth, async (req, res) => {
  const row = store.prepare('SELECT o.*, u.openid FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id=? AND o.user_id=?')
    .get(Number(req.body.id), req.user.id)
  if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (row.status !== 0) return res.status(400).json({ code: 400, msg: '订单状态不允许支付' })
  // 试点临时开关：非真实支付档（RUN_MODE=demo/pilot 且 PAY_MOCK=true）时跳过真实微信支付，
  // 直接标记已支付进入待接单，用于先跑通真实配送链路。
  // 真实支付代码（下方 wxpay.jsapiPay）保持不动，商户号/登录就绪后把 RUN_MODE 提到 production 即切真实收款。
  if (!runtime.realPay) {
    store.prepare("UPDATE orders SET status=1, pay_channel='mock', updated_at=datetime('now','localtime') WHERE id=?").run(row.id)
    const order = store.prepare('SELECT * FROM orders WHERE id=?').get(row.id)
    if (maybeAutoAccept(store, order)) {
      return ok(res, { order_id: row.id, mock: true, auto_accept: true, msg: '试点模式：模拟支付成功，已自动接单并入配送批次' })
    }
    return ok(res, { order_id: row.id, mock: true, msg: '试点模式：模拟支付成功' })
  }
  if (!WX_APPID) return res.status(501).json({ code: 501, msg: '支付通道未开通：请先配置 WX_APPID 与微信支付商户参数' })
  if (!wxpay.enabled()) {
    return res.status(501).json({ code: 501, msg: '支付通道未开通：请配置 WXPAY_MCHID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY / WXPAY_APIV3_KEY / WXPAY_NOTIFY_URL' })
  }
  try {
    const payParams = await wxpay.jsapiPay({
      appid: WX_APPID,
      openid: row.openid,
      outTradeNo: row.order_no,
      description: '零栋GO-订单' + row.order_no,
      amountFen: Math.round(Number(row.total_amount) * 100)
    })
    store.prepare("UPDATE orders SET pay_channel='wxpay', updated_at=datetime('now','localtime') WHERE id=?").run(row.id)
    ok(res, { order_id: row.id, payParams })
  } catch (e) {
    res.status(502).json({ code: 502, msg: '微信支付下单失败：' + e.message })
  }
})

// 微信支付结果回调（由微信服务器调用；订单状态以回调为准）
app.post('/api/pay/notify', async (req, res) => {
  try {
    // P0-6 支付回调校验：平台证书验签 → 商户号/appid → 事件幂等 → 金额比对 → CAS 置已支付。
    // 凭据未就绪（wxpay.enabled()=false）时直接 501，不影响 PAY_MOCK 模拟流程。
    if (!wxpay.enabled()) return res.status(501).json({ code: 501, msg: '支付回调未启用：请先配置微信支付四要素' })
    const body = req.body || {}
    if (!body.resource) return res.status(400).json({ code: 'FAIL', message: '缺少回调资源' })
    // 平台证书验签（用原始报文 rawBody）
    const raw = req.rawBody ? req.rawBody.toString('utf8') : ''
    const v = await wxpay.verifyNotifySignature(req.headers, raw)
    if (!v.ok) return res.status(401).json({ code: 'FAIL', message: '回调验签失败：' + v.msg })
    const info = wxpay.decryptNotify(body.resource)
    if (info.mchid && info.mchid !== process.env.WXPAY_MCHID) return res.status(401).json({ code: 'FAIL', message: '商户号不匹配' })
    if (info.appid && info.appid !== WX_APPID) return res.status(401).json({ code: 'FAIL', message: 'appid 不匹配' })
    if (info.trade_state !== 'SUCCESS') { res.json({ code: 'SUCCESS', message: '成功' }); return }
    // 幂等：同一支付事件只处理一次
    const dup = store.prepare('SELECT id FROM pay_notifications WHERE event_id=?').get(String(body.id || ''))
    if (dup) { res.json({ code: 'SUCCESS', message: '成功' }); return }
    const order = store.prepare('SELECT * FROM orders WHERE order_no=?').get(info.out_trade_no)
    if (!order) { res.json({ code: 'SUCCESS', message: '成功' }); return }
    // 金额比对（分为单位，防止篡改回调金额）
    if (info.amount && Math.round(Number(order.total_amount) * 100) !== Number(info.amount.total)) {
      return res.status(400).json({ code: 'FAIL', message: '支付金额与订单不一致' })
    }
    // CAS 置已支付：仅待支付(0)可迁移，并记录交易号
    const up = store.prepare("UPDATE orders SET status=1, transaction_id=?, updated_at=datetime('now','localtime') WHERE id=? AND status=0")
      .run(info.transaction_id || '', order.id)
    store.prepare("INSERT OR IGNORE INTO pay_notifications (event_id, out_trade_no, trade_state, amount_total, created_at) VALUES (?,?,?,?,datetime('now','localtime'))")
      .run(String(body.id || ''), info.out_trade_no, info.trade_state, Number(info.amount ? info.amount.total : 0))
    if (up.changes === 1) {
      const o2 = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
      if (o2) maybeAutoAccept(store, o2)
    }
    res.json({ code: 'SUCCESS', message: '成功' })
  } catch (e) {
    res.status(500).json({ code: 'FAIL', message: '回调处理失败' })
  }
})

app.get('/api/order/list', auth, (req, res) => {
  const { status = '' } = req.query
  let sql = 'SELECT * FROM orders WHERE user_id=?'
  const args = [req.user.id]
  if (status !== '' && status !== undefined) { sql += ' AND status=?'; args.push(Number(status)) }
  sql += ' ORDER BY id DESC'
  const rows = store.prepare(sql).all(...args).map((o) => ({ ...o, status_text: ORDER_STATUS[o.status] || '' }))
  ok(res, rows)
})

// ---------- 我的页订单红点（只要有进行中的任务就常驻显示，点开不消失） ----------
// 红点 = 进行中的订单数（待接单/配送中/已送达待取餐），不随已读清除；
// 全部处理完（完成/取消/退款）后才消失。
app.get('/api/user/order/badge', auth, (req, res) => {
  const row = store.prepare(`
    SELECT COUNT(*) c FROM orders
    WHERE user_id=? AND status IN (1,2,3)`).get(req.user.id)
  const c0 = store.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=0').get(req.user.id)
  const c2 = store.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=2').get(req.user.id)
  const c3 = store.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=3').get(req.user.id)
  const c4 = store.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=? AND status=4').get(req.user.id)
  const count = Number(row && row.c || 0)
  ok(res, {
    unread: count > 0, count, has_active: count > 0,
    paying: Number(c0 && c0.c || 0), delivering: Number(c2 && c2.c || 0), arrived: Number(c3 && c3.c || 0), finished: Number(c4 && c4.c || 0)
  })
})

// 已读订单动态（保留兼容；红点已改为常驻进行中计数，本接口不再清除红点）
app.post('/api/user/order/mark-read', auth, (req, res) => {
  ok(res)
})

app.get('/api/order/detail', auth, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.query.id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const items = store.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  // 取消相关：最新取消申请 + 可取消标记（供前端区分「取消订单 / 提交取消申请」）
  const cancelReq = store.prepare('SELECT * FROM cancel_requests WHERE order_id=? ORDER BY id DESC LIMIT 1').get(order.id)
  const created = new Date(String(order.created_at || '').replace(' ', 'T')).getTime()
  const freeLeft = isNaN(created) ? 0 : Math.max(0, FREE_CANCEL_WINDOW_MS - (Date.now() - created))
  const st = Number(order.status)
  const trulyDelivering = orderTrulyDelivering(order)
  // 一车多单批次信息（订单详情展示「本车共几单/已取几单」）
  let batchInfo = null
  if (order.batch_id) {
    const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(order.batch_id)
    if (b) {
      const active = store.prepare('SELECT COUNT(*) c, SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) p FROM orders WHERE batch_id=? AND status IN (2,3,4)').get(order.batch_id)
      batchInfo = {
        batch_id: b.id, batch_no: b.batch_no, status: b.status,
        status_text: b.status_text || batch.statusText(b.status),
        total_orders: Number(active && active.c || 0),
        picked_orders: Number(active && active.p || 0),
        multi_order: Number(active && active.c || 0) > 1,
        device_sn: b.device_sn
      }
    }
  }
  ok(res, {
    ...order,
    status_text: ORDER_STATUS[order.status] || '',
    items,
    task,
    batch: batchInfo,
    cancel_request: cancelReq ? {
      status: cancelReq.status,
      status_text: CANCEL_REQ_STATUS[cancelReq.status] || '',
      reason: cancelReq.reason,
      merchant_reply: cancelReq.merchant_reply,
      created_at: cancelReq.created_at
    } : null,
    free_cancel_left_ms: freeLeft,
    // 待支付随时可取消；待接单/未真正配送在免费窗口内可直接取消
    direct_cancelable: st === 0 || (st === 1 && freeLeft > 0) || (st === 2 && !trulyDelivering && freeLeft > 0),
    // 超过免费窗口的待接单订单：只能提交取消申请
    request_cancelable: st === 1 && freeLeft <= 0
  })
})

// 取消订单：免费窗口内可直接取消（不论商家是否接单、只要未真正开始配送）；
// 超过窗口未配送须提交取消申请（/api/order/cancel-request）；配送中不支持取消。
app.post('/api/order/cancel', auth, async (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.body.id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const st = Number(order.status)
  if ([3, 4, 6].includes(st)) {
    return res.status(400).json({ code: 400, msg: '该订单已送达/完成，请通过「退款/投诉」申请处理' })
  }
  if (st === 2 && orderTrulyDelivering(order)) {
    return res.status(400).json({ code: 400, msg: '配送中不支持取消，送达后可申请退款' })
  }
  if (![0, 1, 2].includes(st)) return res.status(400).json({ code: 400, msg: '当前状态不可取消' })
  // 待支付(0)随时可取消；待接单/未真正配送(1/2)须在免费窗口内
  if (st !== 0 && !withinFreeCancelWindow(order)) {
    return res.status(400).json({ code: 400, msg: '已超过可自由取消时间，请提交取消申请' })
  }
  const r = await applyOrderCancelled(order)
  if (!r.claimed) {
    return res.status(409).json({ code: 409, msg: '订单已取消或状态已变更，请刷新后重试' })
  }
  ok(res, { order_id: order.id, status: 5 })
})

// ---------- 取消申请（超过免费窗口、尚未配送） ----------
// 用户提交取消申请
app.post('/api/order/cancel-request', auth, (req, res) => {
  const { order_id, reason = '' } = req.body || {}
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const st = Number(order.status)
  if (![0, 1].includes(st)) return res.status(400).json({ code: 400, msg: '当前状态不可提交取消申请' })
  if (st !== 0 && withinFreeCancelWindow(order)) {
    return res.status(400).json({ code: 400, msg: '仍可直接取消，无需提交申请' })
  }
  const dup = store.prepare('SELECT * FROM cancel_requests WHERE order_id=? AND status=0').get(order.id)
  if (dup) return res.status(400).json({ code: 400, msg: '已有待处理的取消申请' })
  const info = store.prepare('INSERT INTO cancel_requests (order_id, user_id, reason) VALUES (?,?,?)')
    .run(order.id, req.user.id, reason || '')
  ok(res, { id: Number(info.lastInsertRowid), status: 0 })
})

// 我的取消申请记录
app.get('/api/order/cancel-request/list', auth, (req, res) => {
  const rows = store.prepare(`
    SELECT c.*, o.order_no FROM cancel_requests c JOIN orders o ON o.id=c.order_id
    WHERE c.user_id=? ORDER BY c.id DESC`).all(req.user.id)
  ok(res, rows.map((r) => ({ ...r, status_text: CANCEL_REQ_STATUS[r.status] || '' })))
})

// 商家取消申请列表（待处理优先）
app.get('/api/merchant/cancel-requests', merchantGuard, (req, res) => {
  const { status = '' } = req.query
  let sql = `SELECT c.*, o.order_no, o.landmark_name FROM cancel_requests c JOIN orders o ON o.id=c.order_id`
  const args = []
  if (status !== '' && status !== undefined) { sql += ' WHERE c.status=?'; args.push(Number(status)) }
  sql += ' ORDER BY (c.status=0) DESC, c.id DESC'
  ok(res, store.prepare(sql).all(...args).map((r) => ({ ...r, status_text: CANCEL_REQ_STATUS[r.status] || '' })))
})

// 商家取消申请详情
app.get('/api/merchant/cancel-request/detail', merchantGuard, (req, res) => {
  const row = store.prepare('SELECT c.*, o.order_no, o.landmark_name, o.total_amount, o.status AS order_status FROM cancel_requests c JOIN orders o ON o.id=c.order_id WHERE c.id=?').get(Number(req.query.id))
  if (!row) return res.status(404).json({ code: 404, msg: '取消申请不存在' })
  ok(res, { ...row, status_text: CANCEL_REQ_STATUS[row.status] || '', order_status_text: ORDER_STATUS[row.order_status] || '' })
})

// 商家处理取消申请：approve 同意取消（订单→5 已取消）/ reject 拒绝（需理由）
app.post('/api/merchant/cancel-request/handle', merchantGuard, async (req, res) => {
  const { id, action = '', reply = '' } = req.body || {}
  const c = store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(Number(id))
  if (!c) return res.status(404).json({ code: 404, msg: '取消申请不存在' })
  if (Number(c.status) !== 0) return res.status(400).json({ code: 400, msg: '该申请已处理' })
  if (action === 'approve') {
    // 先取消订单（applyOrderCancelled 内部 CAS 抢占，重复处理/并发双击只有一个成功），
    // 取消成功后才把申请置为已处理 —— 原先先置申请、后取消订单，落库失败会出现
    // 「申请已同意但订单纹丝不动」的半截状态。
    const order = store.prepare('SELECT * FROM orders WHERE id=?').get(c.order_id)
    if (order && [0, 1, 2].includes(Number(order.status))) {
      const r = await applyOrderCancelled(order)
      if (!r.claimed) return res.status(409).json({ code: 409, msg: '订单状态已变更，请刷新后重试' })
    }
    const up = store.prepare("UPDATE cancel_requests SET status=3, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=? AND status=0")
      .run(reply || '同意取消', c.id)
    if (up.changes !== 1) return res.status(400).json({ code: 400, msg: '该申请已处理' })
    audit(req, 'cancel-request/approve', 'cancel_request#' + c.id, 'order#' + c.order_id + ' reply=' + (reply || '同意取消'))
    return ok(res, store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(c.id))
  }
  if (action === 'reject') {
    if (!reply) return res.status(400).json({ code: 400, msg: '请填写拒绝理由' })
    const up = store.prepare("UPDATE cancel_requests SET status=2, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=? AND status=0")
      .run(reply, c.id)
    if (up.changes !== 1) return res.status(400).json({ code: 400, msg: '该申请已处理' })
    audit(req, 'cancel-request/reject', 'cancel_request#' + c.id, 'order#' + c.order_id + ' reason=' + reply)
    return ok(res, store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(c.id))
  }
  res.status(400).json({ code: 400, msg: '无效操作' })
})

// ---------- 退款/投诉（售后） ----------
// 用户申请退款/投诉（已送达/已完成/配送异常可申请；退款默认全额）
// 额外放行「卡死配送中」（P1-4）：机器人挂起/故障时订单长期停在配送中，取消/取消申请/退款三个入口
// 原先全被后端拒绝，用户钱付了餐拿不到还没有任何出口 —— 卡死超过阈值即可申请退款。
app.post('/api/refund/apply', auth, (req, res) => {
  const { order_id, type = 'refund', reason = '' } = req.body || {}
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const st = Number(order.status)
  if (![3, 4, 6].includes(st) && !(st === 2 && orderStuckDelivering(order))) {
    return res.status(400).json({ code: 400, msg: '当前状态不可申请退款/投诉' })
  }
  // 一单只允许一条待处理售后（P2-9 前置）：同一订单可被多次申请退款，商家一旦都批了会二次回补库存
  const dup = store.prepare('SELECT id FROM refunds WHERE order_id=? AND status=0').get(order.id)
  if (dup) return res.status(400).json({ code: 400, msg: '已有待处理的售后申请，请等待商家处理' })
  const t = type === 'complaint' ? 'complaint' : 'refund'
  const info = store.prepare('INSERT INTO refunds (order_id, user_id, type, reason, amount) VALUES (?,?,?,?,?)')
    .run(order.id, req.user.id, t, reason || '', t === 'refund' ? order.total_amount : 0)
  ok(res, { id: Number(info.lastInsertRowid), type: t, status: 0 })
})

// 我的售后记录
app.get('/api/refund/list', auth, (req, res) => {
  const rows = store.prepare(`
    SELECT r.*, o.order_no FROM refunds r JOIN orders o ON o.id = r.order_id
    WHERE r.user_id=? ORDER BY r.id DESC`).all(req.user.id)
  ok(res, rows.map((r) => ({ ...r, status_text: REFUND_STATUS[r.status] || '' })))
})

// 商家售后列表（待处理优先）
app.get('/api/merchant/refunds', merchantGuard, (req, res) => {
  const { status = '' } = req.query
  let sql = `SELECT r.*, o.order_no, o.landmark_name FROM refunds r JOIN orders o ON o.id=r.order_id`
  const args = []
  if (status !== '' && status !== undefined) { sql += ' WHERE r.status=?'; args.push(Number(status)) }
  sql += ' ORDER BY (r.status=0) DESC, r.id DESC'
  ok(res, store.prepare(sql).all(...args).map((r) => ({ ...r, status_text: REFUND_STATUS[r.status] || '' })))
})

app.get('/api/merchant/refund/detail', merchantGuard, (req, res) => {
  const row = store.prepare('SELECT r.*, o.order_no, o.landmark_name, o.total_amount FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.id=?').get(Number(req.query.id))
  row ? ok(res, row) : res.status(404).json({ code: 404, msg: '售后单不存在' })
})

// 商家处理售后：退款 approve(默认全额可改)/reject(填理由)；投诉 reply
app.post('/api/merchant/refund/handle', merchantGuard, async (req, res) => {
  const { id, action = '', amount, reply = '' } = req.body || {}
  const r = store.prepare('SELECT * FROM refunds WHERE id=?').get(Number(id))
  if (!r) return res.status(404).json({ code: 404, msg: '售后单不存在' })
  if (Number(r.status) !== 0) return res.status(400).json({ code: 400, msg: '该售后已处理' })
  if (r.type === 'refund') {
    if (action === 'approve') {
      const refundOrder = store.prepare('SELECT * FROM orders WHERE id=?').get(r.order_id)
      // 订单状态白名单（P2-9）：已退款(7)的订单不得再次被「同意退款」——此前无任何前置校验，
      // 同一订单的先后两条售后单可以被连续批准，库存被二次回补、资金被二次退款。
      if (!refundOrder || ![3, 4, 6].includes(Number(refundOrder.status))) {
        return res.status(400).json({ code: 400, msg: '订单当前状态不可退款，请刷新后重试' })
      }
      // 退款金额上限 = 订单实付金额（防止商家填任意大金额造成资损）
      const maxAmt = Number(refundOrder.total_amount || r.amount)
      const rawAmt = (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) ? r.amount : Number(amount)
      const amt = Math.min(rawAmt, maxAmt)
      // 真实退款（P0-5）：真实微信支付且凭据就绪 → 退款成功后才置 7；失败保持待处理并返回错误
      const ref = await realRefundOrLocal(refundOrder, r.id, amt)
      if (!ref.ok) return res.status(502).json({ code: 502, msg: ref.msg })
      // 订单置 7 已退款，并走与取消完全相同的落账：作废任务 + 回补库存 + 摘除批次 + 停模拟推进。
      // 落账成功才标记售后为已退款 —— 先标售后、后落账时若订单已终态，会出现「售后已退款但订单纹丝不动」。
      const c = await applyOrderCancelled(refundOrder, { finalStatus: 7, reason: '商家同意退款' })
      if (!c.claimed) {
        return res.status(409).json({ code: 409, msg: '订单状态已变更，请刷新后重试' })
      }
      store.prepare("UPDATE refunds SET status=3, amount=?, merchant_reply=?, handled_at=datetime('now','localtime'), wx_refund_no=? WHERE id=?")
        .run(amt, reply || '同意退款', ref.refundNo || '', r.id)
      audit(req, 'refund/approve', 'refund#' + r.id, 'order#' + r.order_id + ' amount=' + amt + (ref.local ? ' (本地标记，无真实资金)' : ''))
    } else if (action === 'reject') {
      if (!reply) return res.status(400).json({ code: 400, msg: '请填写拒绝理由' })
      store.prepare("UPDATE refunds SET status=2, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?").run(reply, r.id)
      audit(req, 'refund/reject', 'refund#' + r.id, 'order#' + r.order_id + ' reason=' + reply)
    } else {
      return res.status(400).json({ code: 400, msg: '无效操作' })
    }
  } else {
    // 投诉：商家回复处理
    store.prepare("UPDATE refunds SET status=4, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?").run(reply || '已处理', r.id)
    audit(req, 'complaint/reply', 'refund#' + r.id, 'order#' + r.order_id + ' reply=' + reply)
  }
  ok(res, store.prepare('SELECT * FROM refunds WHERE id=?').get(r.id))
})

// ---------- 配送追踪 ----------
app.get('/api/delivery/track', auth, async (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.query.order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  const pos = task ? await platform.getDevicePosition(store, task.id) : null
  // P1-12：机器人位置归一化为地图图片百分比坐标（x 从左→右 0-100，y 从下→上 0-100）。
  // 用真实坐标 ÷ 地图 bbox，不再依赖前端魔数/step 换算 —— 原实现读 position.step（后端根本不返回该字段）
  // 算出恒 NaN 的 posX/posY，R3 的配送追踪等于不可用。mock 档位置无 x/y → percent 保持 null，
  // 前端须回退为纯文本展示（见 track.js）。
  let percent = null
  if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
    try {
      const bb = await platform.getMapBbox(store)
      if (bb && bb.maxX > bb.minX && bb.maxY > bb.minY) {
        // 与 map.landmarks/route 同用 8% 内边距归一化，保证机器人位置与点位/路线对齐
        const PAD = 8
        const rx = PAD + ((Number(pos.x) - bb.minX) / (bb.maxX - bb.minX)) * (100 - 2 * PAD)
        const ry = PAD + (1 - (Number(pos.y) - bb.minY) / (bb.maxY - bb.minY)) * (100 - 2 * PAD)
        percent = { x: Math.round(rx), y: Math.round(ry) }
      }
    } catch (e) { /* 地图元数据不可用则不下发 percent，前端走文本展示 */ }
  }
  // 地图数据：bbox + 全部点位（归一化为百分比坐标）+ 批次路线停靠点百分比序列，
  // 供用户端追踪页渲染「可缩放自绘地图」（点位标记 + 路线折线 + 机器人实时位置）。
  let map = null
  try {
    const bb = await platform.getMapBbox(store)
    if (bb && bb.maxX > bb.minX && bb.maxY > bb.minY) {
      const toPct = (x, y) => {
        // 8% 内边距，避免点位贴边显示不全
        const PAD = 8
        return {
          x: Math.round(PAD + ((Number(x) - bb.minX) / (bb.maxX - bb.minX)) * (100 - 2 * PAD)),
          y: Math.round(PAD + (1 - (Number(y) - bb.minY) / (bb.maxY - bb.minY)) * (100 - 2 * PAD))
        }
      }
      const pts = store.prepare("SELECT id,name,type,pos_x,pos_y FROM landmarks WHERE pos_x IS NOT NULL AND pos_y IS NOT NULL").all()
      const landmarks = pts.map((p) => Object.assign({ id: p.id, name: p.name, type: p.type }, toPct(p.pos_x, p.pos_y)))
      // 路线：批次停靠点坐标（含上货点起点）
      let route = []
      if (order.batch_id) {
        const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(order.batch_id)
        if (b && b.route) {
          const stops = JSON.parse(b.route)
          const loading = store.prepare("SELECT pos_x,pos_y FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
          if (loading && Number.isFinite(Number(loading.pos_x))) {
            route.push(Object.assign({ name: '商铺上货' }, toPct(loading.pos_x, loading.pos_y)))
          }
          for (const s of stops) {
            const lm = store.prepare('SELECT name,pos_x,pos_y FROM landmarks WHERE id=?').get(s.landmark_id)
            if (lm && Number.isFinite(Number(lm.pos_x))) {
              route.push(Object.assign({ name: lm.name }, toPct(lm.pos_x, lm.pos_y)))
            }
          }
        }
      }
      map = { bbox: bb, landmarks, route }
    }
  } catch (e) { /* 地图数据不可用则不下发 map，前端走文本展示 */ }
  // 一车多单：同批次信息（一个仓多个人拿 → 告知用户本车共几单、已取几单）
  let batchInfo = null
  if (order.batch_id) {
    const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(order.batch_id)
    if (b) {
      const active = store.prepare('SELECT COUNT(*) c, SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) p FROM orders WHERE batch_id=? AND status IN (2,3,4)').get(order.batch_id)
      batchInfo = {
        batch_id: b.id,
        batch_no: b.batch_no,
        status: b.status,
        status_text: b.status_text || batch.statusText(b.status),        total_orders: Number(active && active.c || 0),
        picked_orders: Number(active && active.p || 0),
        multi_order: Number(active && active.c || 0) > 1,
        device_sn: b.device_sn
      }
    }
  }
  // 无任务但已接单（组单中/待上货）：给出更准确的状态文案
  let taskText = task ? task.status_text : (ORDER_STATUS[order.status] || '')
  if (!task) {
    if (Number(order.status) === 2 && batchInfo) {
      taskText = batchInfo.status === 0 ? '商家已接单，正在组车配送' : '机器人前往上货点'
    } else if (Number(order.status) === 1) {
      taskText = '等待商家接单'
    }
  }
  ok(res, {
    order_status: order.status,
    order_status_text: ORDER_STATUS[order.status] || '',
    pickup_code: order.pickup_code,
    landmark_name: order.landmark_name,
    task: task ? { task_status: task.task_status, status_text: task.status_text } : null,
    task_text: taskText,
    position: pos,
    percent,
    map,
    batch: batchInfo
  })
})

app.post('/api/delivery/confirm', auth, (req, res) => {
  const { order_id, scan_code } = req.body || {}
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (order.status !== 3) return res.status(400).json({ code: 400, msg: '机器人还未送达' })
  if (scan_code && String(scan_code).trim() !== order.pickup_code) {
    return res.status(400).json({ code: 400, msg: '取餐码不匹配，请扫描机器人屏幕上的取餐码' })
  }
  store.prepare("UPDATE orders SET status=4, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
  goodsStats.settleSales(store, order.id)
  ok(res)
})

// ---------- 用户取餐（扫码后：开舱/取餐/关舱/40s自动关/重开） ----------
// 扫码取餐：校验订单归属 + 已送达，返回取餐上下文（供取餐页展示与操作）
// 允许 {3,4}：关舱后（订单 4）重新进入取餐页重开舱也放行，与 P1-2 的重开限制配套
// 取餐上下文（pickup-scan 与 pickup-by-code 共用）：订单 + 同批订单提示 + 任务摘要
function pickupContext(store, order) {
  const task = order.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id) : null
  // 一车多单诚实化（P1-1 缓解）：返回同批订单，供取餐页提示「本车共 N 单，按订单号核对后取走自己的餐」
  let batchOrders = []
  let batchOrderCount = 0
  if (order.batch_id) {
    batchOrders = store.prepare('SELECT id, order_no, daily_seq, landmark_name FROM orders WHERE batch_id=? AND status IN (2,3) ORDER BY id ASC').all(order.batch_id)
    batchOrderCount = batchOrders.length
  }
  return {
    order_id: order.id,
    order_no: order.order_no,
    pickup_code: order.pickup_code,
    landmark_name: order.landmark_name,
    batch_order_count: batchOrderCount,
    batch_orders: batchOrders,
    task: task ? { task_id: task.id, platform_task_id: task.platform_task_id, device_sn: task.device_sn, task_status: task.task_status, status_text: task.status_text } : null
  }
}

app.post('/api/delivery/pickup-scan', auth, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (![3, 4].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '机器人还未送达，暂不能取餐' })
  ok(res, pickupContext(store, order))
})

// 扫码取餐（需求5）：用户扫无人车二维码 → 输入取餐码 → 校验归属（本人订单、待取餐、取餐码匹配、车一致）
app.post('/api/delivery/pickup-by-code', auth, (req, res) => {
  const { device_sn = '', pickup_code = '' } = req.body || {}
  if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
  if (!String(pickup_code).trim()) return res.status(400).json({ code: 400, msg: '请输入取餐码' })
  const order = store.prepare(`
    SELECT o.* FROM orders o JOIN delivery_tasks d ON d.order_id = o.id
    WHERE o.user_id=? AND o.status=3 AND o.pickup_code=? AND d.device_sn=? AND d.void_at IS NULL
    ORDER BY o.id DESC LIMIT 1`).get(req.user.id, String(pickup_code).trim(), device_sn)
  if (!order) return res.status(400).json({ code: 400, msg: '取餐码不正确或无人车不匹配' })
  ok(res, pickupContext(store, order))
})

// 打开舱门取餐（unloading/verify 开舱）。
// P1-2 修复：开舱**不再**把订单标记为已取走 —— 原先开舱即置 4 并结算销量，用户尚未拿到餐
// 订单就已不可逆结束；且「重新打开舱门」因状态已非 3 永远 400，专门为防未取到餐做的功能一次都用不了。
// 现在「标记已取走」移到关舱（pickup-close）；开舱允许 status ∈ {3,4}，限次数（默认 3 次）限时（默认 10 分钟）。
app.post('/api/delivery/pickup-open', auth, async (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (![3, 4].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '机器人还未送达，暂不能取餐' })
  // 重开限时：从首次开舱起超过窗口则不再允许
  if (order.pickup_opened_at) {
    const first = new Date(String(order.pickup_opened_at).replace(' ', 'T')).getTime()
    if (!isNaN(first) && Date.now() - first > PICKUP_REOPEN_WINDOW_MS) {
      return res.status(400).json({ code: 400, msg: '已超过可重新开舱时间（' + Math.round(PICKUP_REOPEN_WINDOW_MS / 60000) + ' 分钟）' })
    }
  }
  // CAS 抢占 + 次数上限：并发双击只成功一次，超过 MAX_PICKUP_OPEN 次直接拒绝
  const claim = store.prepare(`
    UPDATE orders SET
      pickup_opened_at=COALESCE(pickup_opened_at, datetime('now','localtime')),
      pickup_open_count=pickup_open_count+1,
      updated_at=datetime('now','localtime')
    WHERE id=? AND status IN (3,4) AND pickup_open_count < ?`).run(order.id, MAX_PICKUP_OPEN)
  if (claim.changes !== 1) return res.status(400).json({ code: 400, msg: '重新开舱次数已达上限，请联系商家处理' })
  const task = order.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id) : null
  const ready = !!(task && task.device_sn && task.platform_task_id)
  if (ready) {
    const r = await platform.unloadingVerify(task.device_sn, task.platform_task_id, { contact: order.contact_phone || '', roomNum: order.pickup_code })
    if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
  }
  ok(res, { order_id: order.id, status: Number(order.status), opened_at: order.pickup_opened_at, test: !ready })
})

// 关闭舱门（unloading/confirm 关舱返回；订单标记已取走 → 4 已完成 + 结算销量 + 批次计数）
// P1-2：真正的「确认取餐」动作放在关舱 —— 用户关舱 = 拿走餐品，此时才置已完成并结算。
// 平台侧 40s 未调用会自动关舱，任务流转 80 时由 applyStatus/onTaskStatus 走同一路径标记已取走。
app.post('/api/delivery/pickup-close', auth, async (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (![3, 4].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '订单状态不允许关舱' })
  const task = order.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id) : null
  const ready = !!(task && task.device_sn && task.platform_task_id)
  if (ready) {
    const r = await platform.unloadingConfirm(task.device_sn, task.platform_task_id, { contact: order.contact_phone || '', roomNum: order.pickup_code })
    if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
  }
  batch.markOrderPicked(store, order)
  ok(res, { order_id: order.id, status: 4, test: !ready })
})

// ---------- 活动 ----------
app.get('/api/activity/list', (req, res) => {
  ok(res, store.prepare('SELECT * FROM activities WHERE status=1 ORDER BY sort, id DESC').all())
})

// ---------- 商家端 ----------
function merchantGuard(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'merchant') return res.status(403).json({ code: 403, msg: '无权限' })
    next()
  })
}

// 店铺状态（营业/自动接单）：真实后端状态，不再存于小程序本地
// 附加运行模式标记：设备控制（开舱/关舱/派发）是否走本地模拟由后端决定，
// 商家端不再硬编码 DEVICE_MOCK —— 那会造成「后端已真实调度机器人、前端却假装已上货已送达」。
// 强制点在后端（mock-dispatch/test-complete 按 deviceMock 返回 404），此处下发仅供前端选择分支。
function shopWithRuntime(shop) {
  return Object.assign(
    { id: 1, name: '零栋铺子', business_status: 'open', auto_accept: 0 },
    shop || {},
    {
      run_mode: runtime.mode,
      device_mock: runtime.deviceMock,
      pay_mock: !runtime.realPay,
      login_user: runtime.loginMode('user'),
      login_merchant: runtime.loginMode('merchant')
    }
  )
}

app.get('/api/merchant/shop', merchantGuard, (req, res) => {
  ok(res, shopWithRuntime(store.prepare('SELECT * FROM shops WHERE id=1').get()))
})

app.put('/api/merchant/shop', merchantGuard, (req, res) => {
  const { business_status, auto_accept } = req.body || {}
  const cur = store.prepare('SELECT * FROM shops WHERE id=1').get() || { business_status: 'open', auto_accept: 0 }
  const st = business_status === 'closed' ? 'closed' : 'open'
  const aa = auto_accept === undefined ? cur.auto_accept : (auto_accept ? 1 : 0)
  store.prepare("UPDATE shops SET business_status=?, auto_accept=?, updated_at=datetime('now','localtime') WHERE id=1")
    .run(st, aa)
  audit(req, 'shop/update', 'shop#1', 'business_status=' + st + ' auto_accept=' + aa)
  ok(res, store.prepare('SELECT * FROM shops WHERE id=1').get())
})

// 店铺状态（公开，用户端判断是否可下单 / 展示歇业标签）
app.get('/api/shop/status', (req, res) => {
  ok(res, shopWithRuntime(store.prepare('SELECT * FROM shops WHERE id=1').get()))
})

app.get('/api/merchant/stats', merchantGuard, (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const stats = {
    today_orders: store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=?").get(today).c,
    today_amount: store.prepare("SELECT IFNULL(SUM(total_amount),0) s FROM orders WHERE date(created_at)=? AND status NOT IN (0,5)").get(today).s,
    // 主面板四态：待接单 / 待上货 / 配送中 / 待取货
    pending: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=1').get().c,              // 待接单：订单
    ready_load: store.prepare("SELECT COUNT(*) c FROM orders WHERE status=2 AND batch_id IN (SELECT id FROM delivery_batches WHERE status IN (0,1))").get().c,  // 待上货：订单（与任务页 load 口径一致）
    delivering: store.prepare("SELECT COUNT(*) c FROM orders WHERE status=2 AND batch_id IN (SELECT id FROM delivery_batches WHERE status=2)").get().c,  // 配送中：订单（与任务页 deliver 口径一致）
    pickup: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=3').get().c,                // 待取货：已送达未取
    // 异常 / 售后（次面板）
    exception: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=6').get().c,
    aftersale: store.prepare('SELECT COUNT(*) c FROM refunds WHERE status=0').get().c,
    cancel_requests: store.prepare('SELECT COUNT(*) c FROM cancel_requests WHERE status=0').get().c,
    // 兼容旧字段
    finished: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=4').get().c
  }
  ok(res, stats)
})

// 商家订单列表：status / scope(active|history) / stage(accept|load|deliver|pickup) 三种过滤
// 附带 items 商品明细、首商品摘要与所属批次（batch_no + 当日序号），任务页/历史订单页直接展示
// stage 过滤时附带 stage_text：待接单/待上货/配送中/待取货（任务页按分类着色，避免「待上货里全是配送中字样」）
app.get('/api/merchant/orders', merchantGuard, (req, res) => {
  const { status = '', scope = '', stage = '' } = req.query
  let sql = 'SELECT * FROM orders'
  const args = []
  if (stage === 'accept') sql += ' WHERE status=1'
  else if (stage === 'load') sql += " WHERE status=2 AND (batch_id IS NULL OR batch_id IN (SELECT id FROM delivery_batches WHERE status IN (0,1)))"
  else if (stage === 'deliver') sql += " WHERE status=2 AND batch_id IN (SELECT id FROM delivery_batches WHERE status=2)"
  else if (stage === 'pickup') sql += ' WHERE status=3'
  // 当前任务：仅执行中的订单（待接单/配送中/等待取餐）；历史订单：已完成/已取消/配送异常/已退款
  else if (scope === 'active') sql += ' WHERE status IN (1,2,3)'
  else if (scope === 'history') sql += ' WHERE status IN (4,5,6,7)'
  else if (status !== '' && status !== undefined) { sql += ' WHERE status=?'; args.push(Number(status)) }
  sql += ' ORDER BY id DESC'
  const getItems = store.prepare('SELECT id, goods_id, goods_name, goods_image, price, quantity FROM order_items WHERE order_id=?')
  const getBatch = store.prepare('SELECT batch_no, daily_seq, status, total_items, route FROM delivery_batches WHERE id=?')
  const stageText = { accept: '待接单', load: '待上货', deliver: '配送中', pickup: '待取货' }[stage] || ''
  const rows = store.prepare(sql).all(...args).map((o) => {
    const items = getItems.all(o.id)
    let batchInfo = null
    if (o.batch_id) {
      const b = getBatch.get(o.batch_id)
      if (b) {
        // 路线文本：先送在左、后送在右，以 → 分隔（供批次卡面下方展示）
        let rt = ''
        try { rt = (JSON.parse(b.route || '[]') || []).map((r) => r.landmark_name).filter(Boolean).join(' → ') } catch (e) { rt = '' }
        batchInfo = { batch_no: b.batch_no, daily_seq: Number(b.daily_seq || b.id), status: b.status, total_items: Number(b.total_items || 0), route_text: rt }
      }
    }
    return {
      ...o,
      status_text: ORDER_STATUS[o.status] || '',
      stage_text: stageText,
      // P1-13 手机号脱敏：商家端一律展示 138****0000，明文仅在服务端内部逻辑使用
      contact_phone: maskPhone(o.contact_phone),
      // 点位名清洗：脏数据（??1?）以 landmarks 表回退
      landmark_name: batch.landmarkNameOf(store, o.landmark_id, o.landmark_name),
      daily_seq: Number(o.daily_seq || o.id),
      items,
      first_name: items.length ? items[0].goods_name : '',
      first_image: items.length ? (items[0].goods_image || '') : '',
      first_qty: items.length ? Number(items[0].quantity || 0) : 0,
      item_count: items.reduce((s, it) => s + Number(it.quantity || 0), 0),
      batch: batchInfo
    }
  })
  ok(res, rows)
})

app.get('/api/merchant/order/detail', merchantGuard, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.query.id))
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const items = store.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)
  let batchInfo = null
  if (order.batch_id) {
    const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(order.batch_id)
    if (b) {
      const detail = batch.getBatchDetail(store, b.id)
      batchInfo = detail ? { id: detail.id, batch_no: detail.batch_no, daily_seq: detail.daily_seq, status: detail.status, status_text: detail.status_text, total_orders: detail.total_orders, picked_orders: detail.picked_orders } : null
    }
  }
  ok(res, { ...order, contact_phone: maskPhone(order.contact_phone), status_text: ORDER_STATUS[order.status] || '', items, batch: batchInfo })
})

// 商家接单（真实业务：店铺歇业时后端拒绝接单；接单即并入当前配送批次，待批次派车）
app.post('/api/merchant/order/confirm', merchantGuard, (req, res) => {
  const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
  if (shop.business_status === 'closed') {
    return res.status(400).json({ code: 400, msg: '店铺歇业中，无法接单' })
  }
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.body.id))
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (order.status !== 1) return res.status(400).json({ code: 400, msg: '订单状态不允许接单' })
  const b = batch.addOrderToBatch(store, order)
  audit(req, 'order/confirm', 'order#' + order.id, '→ batch#' + b.id + ' ' + b.batch_no)
  ok(res, { order_id: order.id, status: 2, batch_id: b.id, batch_no: b.batch_no, msg: '已接单，订单并入配送批次 ' + b.batch_no })
})

// ---------- 配送异常订单处理（商家端） ----------
// 配送异常(6)：机器人超时未接单/上货失败/送货失败时进入，由商家二选一处理。
//  1) 重新配送：作废旧任务、从旧批次摘除、并入新的组单中批次，商家派车后重新上货配送。
//  2) 取消并退款：作废任务、订单置 7 已退款、写售后记录、回补未售库存、从批次摘除。
app.post('/api/merchant/order/exception/retry', merchantGuard, (req, res) => {
  const { order_id } = req.body || {}
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(order_id))
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (Number(order.status) !== 6) return res.status(400).json({ code: 400, msg: '仅配送异常订单可重新配送' })
  // 作废旧任务并从旧批次摘除。必须按 order_id 精确作废：原先写的是 batch_id，
  // 重试一单会把同批次其他订单（最多 11 单）的任务一起作废，接上真实召回后等于强关别人的机器人。
  store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text='异常重配，任务作废',
    void_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
    WHERE order_id=? AND task_status < 80 AND void_at IS NULL`).run(order.id)
  batch.removeOrderFromBatch(store, order)
  // 并入新的组单中批次（派车由批次自动派车扫描统一处理）
  const b = batch.addOrderToBatch(store, store.prepare('SELECT * FROM orders WHERE id=?').get(order.id))
  store.prepare("UPDATE orders SET exception_handled='retry ' || datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
  console.log('[exception] 配送异常订单重新配送 order=' + order.id + ' → batch=' + b.batch_no + ' user=' + req.user.id)
  audit(req, 'order/exception-retry', 'order#' + order.id, '→ batch#' + b.id)
  ok(res, { order_id: order.id, status: 2, batch_id: b.id, batch_no: b.batch_no, msg: '已重新并入批次 ' + b.batch_no + '，请派车上货配送' })
})

app.post('/api/merchant/order/exception/refund', merchantGuard, async (req, res) => {
  const { order_id } = req.body || {}
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(order_id))
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (Number(order.status) !== 6) return res.status(400).json({ code: 400, msg: '仅配送异常订单可取消退款' })
  // 真实退款（P0-5）：真实支付渠道且凭据就绪 → 微信退款成功后才置 7
  const ref = await realRefundOrLocal(order, null, Number(order.total_amount))
  if (!ref.ok) return res.status(502).json({ code: 502, msg: ref.msg })
  // 落库：订单 7 已退款 + 作废任务(写 void_at) + 回补未售库存 + 从批次摘除，统一走 orderCancel。
  // 原先自己写了一遍半套逻辑：只作废 orders.delivery_task_id 指向的那一条、不写 void_at，
  // 于是一条迟到的平台回调仍能把已退款订单改回「已送达」。
  const c = await applyOrderCancelled(order, { finalStatus: 7, reason: '异常退款，任务作废' })
  if (!c.claimed) return res.status(409).json({ code: 409, msg: '订单状态已变更，请刷新后重试' })
  store.prepare("UPDATE orders SET exception_handled='refund ' || datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
  store.prepare("INSERT INTO refunds (order_id, user_id, type, reason, amount, status, merchant_reply, handled_at, wx_refund_no) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'),?)")
    .run(order.id, order.user_id, 'refund', '配送异常，商家取消并退款', order.total_amount, 3, '配送异常自动退款', ref.refundNo || '')
  console.log('[exception] 配送异常订单取消退款 order=' + order.id + ' amount=' + order.total_amount + ' user=' + req.user.id)
  audit(req, 'order/exception-refund', 'order#' + order.id, 'amount=' + order.total_amount)
  ok(res, { order_id: order.id, status: 7, msg: '已取消并退款 ¥' + order.total_amount })
})

// 配送异常订单列表（独立异常页）：tab=all 全部异常相关 / pending 待处理(状态6未处理) / done 已处理
app.get('/api/merchant/orders/exception', merchantGuard, (req, res) => {
  const { tab = 'pending' } = req.query
  const getItems = store.prepare('SELECT id, goods_id, goods_name, goods_image, price, quantity FROM order_items WHERE order_id=?')
  const getBatch = store.prepare('SELECT batch_no, daily_seq, status, total_items, route FROM delivery_batches WHERE id=?')
  const rows = store.prepare("SELECT * FROM orders WHERE status=6 OR exception_handled != '' ORDER BY id DESC").all()
  const out = rows.filter((o) => {
    if (tab === 'pending') return Number(o.status) === 6 && !o.exception_handled
    if (tab === 'done') return !!o.exception_handled
    return true
  }).map((o) => {
    const items = getItems.all(o.id)
    let batchInfo = null
    if (o.batch_id) {
      const b = getBatch.get(o.batch_id)
      if (b) {
        // 路线文本：先送在左、后送在右，以 → 分隔（供批次卡面下方展示）
        let rt = ''
        try { rt = (JSON.parse(b.route || '[]') || []).map((r) => r.landmark_name).filter(Boolean).join(' → ') } catch (e) { rt = '' }
        batchInfo = { batch_no: b.batch_no, daily_seq: Number(b.daily_seq || b.id), status: b.status, total_items: Number(b.total_items || 0), route_text: rt }
      }
    }
    return {
      ...o,
      status_text: ORDER_STATUS[o.status] || '',
      // P1-13 手机号脱敏
      contact_phone: maskPhone(o.contact_phone),
      daily_seq: Number(o.daily_seq || o.id),
      landmark_name: batch.landmarkNameOf(store, o.landmark_id, o.landmark_name),
      items,
      first_name: items.length ? items[0].goods_name : '',
      first_image: items.length ? (items[0].goods_image || '') : '',
      first_qty: items.length ? Number(items[0].quantity || 0) : 0,
      item_count: items.reduce((s, it) => s + Number(it.quantity || 0), 0),
      handled: !!o.exception_handled,
      handled_text: o.exception_handled ? (o.exception_handled.indexOf('retry') === 0 ? '已重新配送' : '已退款') : '',
      batch: batchInfo
    }
  })
  ok(res, out)
})

// ---------- 一车多单：配送批次 ----------
// 商家批次列表：组单中 / 待上货 / 配送中（近 20 个），每批次带订单摘要
app.get('/api/merchant/delivery/batch/list', merchantGuard, (req, res) => {
  const rows = store.prepare('SELECT * FROM delivery_batches ORDER BY id DESC LIMIT 20').all()
  const out = rows.map((b) => {
    const detail = batch.getBatchDetail(store, b.id)
    return detail
  })
  ok(res, out)
})

// 批次详情（订单 + 路线）
app.get('/api/merchant/delivery/batch/detail', merchantGuard, (req, res) => {
  const b = batch.getBatchDetail(store, Number(req.query.batch_id || 0))
  b ? ok(res, b) : res.status(404).json({ code: 404, msg: '批次不存在' })
})

// 批次派车：规划路线 + 创建全部平台任务（一车多单），可指定机器人
// P1-7 并发抢占：先读后写存在竞争 —— 两个并发派车（自动派车扫描 + 商家手点）都会读到 status=0
// 并各自创建一套平台任务 → 同一批货被下发两次、真机被调度两次。现在任何 await 之前先用
// 条件更新抢占（status 0→1），只有抢到的一方才继续；失败方直接报「已派车」，绝不重复创建。
// 抢占后任一步失败则回滚：已建任务作废(void_at) + 批次回到组单中，不留半派车状态。
async function doDispatchBatch(store, batchId, deviceSn) {
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batchId))
  if (!b) throw new Error('批次不存在')
  // 需求3门禁（真实档）：先确认有可用且空闲的无人车，再占批次 —— 避免占位后再回滚。
  // 演示档（PLATFORM_MOCK=true）跳过：本地模拟不涉及真车。
  let sn = deviceSn || b.device_sn || ''
  if (runtime.realPlatform) {
    if (!sn) {
      const r = await platform.pickAvailableRobot()
      if (r && r.device_sn) sn = r.device_sn
    }
    if (!sn) throw new Error('暂无可用无人车，请确认无人车在线后再派车')
    const busy = await platform.isRobotBusy(store, sn)
    if (busy.busy) throw new Error(busy.msg)
  }
  const claim = store.prepare(`
    UPDATE delivery_batches SET status=1, status_text='待上货',
      dispatched_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
    WHERE id=? AND status=0`).run(batchId)
  if (claim.changes !== 1) throw new Error('该批次已派车，不能重复派车')
  try {
    const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (1,2)').all(batchId)
    if (!orders.length) {
      store.prepare("UPDATE delivery_batches SET status=0, status_text='组单中', dispatched_at=NULL, updated_at=datetime('now','localtime') WHERE id=?")
        .run(batchId)
      throw new Error('批次内没有待配送订单')
    }
    // 1. 规划配送路线（多地点，最小化顾客总等待）
    const route = batch.planRoute(store, orders)
    store.prepare("UPDATE delivery_batches SET device_sn=?, route=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(sn, JSON.stringify(route), batchId)
    // 同步内存中的批次对象，供 createTasksForBatch 取 device_sn（它创建平台任务必须指定设备）
    b.device_sn = sn
    // 3. 为批次内每单创建平台任务（真实创建排队任务 / 本地 Mock）
    await platform.createTasksForBatch(store, b, orders, route)
    // 4. 兜底置为配送中（已由并入批次时置 2）
    store.prepare("UPDATE orders SET status=2, updated_at=datetime('now','localtime') WHERE batch_id=? AND status=1").run(batchId)
    console.log('[batch] 批次派车 ' + b.batch_no + ' 共' + orders.length + '单 路线' + route.map((s) => s.landmark_name).join('→'))
    return batch.getBatchDetail(store, batchId)
  } catch (e) {
    // 回滚：作废本轮已创建的任务 + 批次退回组单中（device_sn/route 一并清掉，避免下次派车沿用旧路线）
    try {
      store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text='派车失败，任务作废',
        void_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
        WHERE batch_id=? AND void_at IS NULL`).run(batchId)
      store.prepare("UPDATE delivery_batches SET status=0, status_text='组单中', device_sn='', route='', dispatched_at=NULL, updated_at=datetime('now','localtime') WHERE id=?")
        .run(batchId)
    } catch (e2) { /* 回滚失败静默，下次派车时批次状态会再次校验 */ }
    throw e
  }
}

app.post('/api/merchant/delivery/batch/dispatch', merchantGuard, async (req, res) => {
  const { batch_id, device_sn } = req.body || {}
  try {
    const detail = await doDispatchBatch(store, batch_id, device_sn || '')
    audit(req, 'batch/dispatch', 'batch#' + batch_id, 'device_sn=' + (device_sn || detail.device_sn || '') + ' orders=' + (detail.orders ? detail.orders.length : 0))
    ok(res, detail)
  } catch (e) {
    res.status(400).json({ code: 400, msg: e.message })
  }
})

// 批次上货（多单一次性）：开舱（逐任务 loading/verify）
app.post('/api/merchant/device/batch/open-bin', merchantGuard, async (req, res) => {
  const { batch_id } = req.body || {}
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batch_id))
  if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
  // 需求3门禁：无人车必须已到达上货点才能开舱上货（真实档校验；演示档恒通过）
  const gate = await platform.robotAtLoadingPoint(store, b.device_sn)
  if (!gate.ok) return res.status(400).json({ code: 400, msg: '开舱失败：' + gate.msg })
  const results = await platform.verifyBatchLoading(store, b.id)
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    return res.status(502).json({ code: 502, msg: '开舱失败：' + failed[0].msg })
  }
  store.prepare("UPDATE delivery_batches SET status=1, status_text='待上货', updated_at=datetime('now','localtime') WHERE id=?").run(b.id)
  audit(req, 'device/batch-open', 'batch#' + b.id, 'opened=' + results.length)
  ok(res, { batch_id: b.id, opened: results.length })
})

// 批次关舱（原地等待，不派发）
app.post('/api/merchant/device/batch/close-bin', merchantGuard, async (req, res) => {
  const { batch_id } = req.body || {}
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batch_id))
  if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
  if (!b.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
  const r = await platform.drawerCtrl(b.device_sn, 0)
  if (r.ok) {
    audit(req, 'device/batch-close', 'batch#' + b.id, 'device_sn=' + b.device_sn)
    ok(res)
  } else {
    res.status(502).json({ code: 502, msg: r.msg })
  }
})

// 批次开始配送（逐任务 loading/confirm；批次置配送中）
app.post('/api/merchant/device/batch/dispatch', merchantGuard, async (req, res) => {
  const { batch_id } = req.body || {}
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batch_id))
  if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
  const results = await platform.confirmBatchLoading(store, b.id)
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    return res.status(502).json({ code: 502, msg: '开始配送失败：' + failed[0].msg })
  }
  store.prepare("UPDATE delivery_batches SET status=2, status_text='配送中', updated_at=datetime('now','localtime') WHERE id=?")
    .run(b.id)
  audit(req, 'device/batch-dispatch', 'batch#' + b.id, 'device_sn=' + b.device_sn + ' dispatched=' + results.length)
  ok(res, { batch_id: b.id, dispatched: results.length })
})

// 测试辅助：模拟完成上货并开始配送（无真机器人时用）
// 纯本地推进批次状态：批次 → 配送中(2)、批次内任务 → 已上货(50)，不调用开放物流平台。
// 测试阶段配送时间模拟为 MOCK_ARRIVE_MS（默认 10 秒）：到点后自动把批次内全部订单标记为已送达(3)/任务 70，
// 直接进入「待取货」，用户即可取餐；商家无需手动点「测试完成配送」。
// 正式接入真机器人后由「立即配送」（/merchant/device/batch/dispatch）真实下发，本接口仅测试阶段使用。
const MOCK_ARRIVE_MS = Number(process.env.MOCK_ARRIVE_MS || 10 * 1000)
app.post('/api/merchant/device/batch/mock-dispatch', merchantGuard, (req, res) => {
  // 设备控制未处于模拟模式（pilot/production 档）时禁止模拟派发，防止真机被真实调度而前端假装已上货
  if (!runtime.deviceMock) return res.status(404).json({ code: 404, msg: '当前运行模式不允许模拟派发' })
  const { batch_id } = req.body || {}
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batch_id))
  if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
  if (![0, 1].includes(Number(b.status))) return res.status(400).json({ code: 400, msg: '仅组单中/待上货批次可模拟派发' })
  store.prepare("UPDATE delivery_batches SET status=2, status_text='配送中', mock_arrive_at=datetime('now','localtime', ?), updated_at=datetime('now','localtime') WHERE id=?")
    .run('+' + Math.round(MOCK_ARRIVE_MS / 1000) + ' seconds', b.id)
  store.prepare("UPDATE delivery_tasks SET task_status=50, status_text='已上货（模拟）', updated_at=datetime('now','localtime') WHERE batch_id=? AND task_status < 50")
    .run(b.id)
  console.log('[batch] 模拟上货完成并开始配送（测试）batch=' + b.batch_no + ' user=' + req.user.id + ' 约' + Math.round(MOCK_ARRIVE_MS / 1000) + '秒后送达')
  audit(req, 'test/mock-dispatch', 'batch#' + b.id, 'mock_arrive_after=' + Math.round(MOCK_ARRIVE_MS / 1000) + 's')
  // P1-4：模拟到达不再依赖内存 setTimeout（纯内存、重启即丢 → 配送中的订单会永久卡死）。
  // mock_arrive_at 已落库，由后台定时任务（自动派车同一 interval）到点统一处理，重启可自愈。
  ok(res, { batch_id: b.id, status: 2, msg: '已开始配送（测试阶段配送时间模拟为' + Math.round(MOCK_ARRIVE_MS / 1000) + '秒）' })
})

// 商家商品图片上传（base64，避免引入 multipart 依赖）
app.post('/api/merchant/upload', merchantGuard, (req, res) => {
  const { name = 'img.jpg', data = '' } = req.body || {}
  if (!data) return res.status(400).json({ code: 400, msg: '文件为空' })
  const ext = (String(name).match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase()
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
    return res.status(400).json({ code: 400, msg: '不支持的图片格式' })
  }
  const fname = Date.now() + '_' + Math.random().toString(36).slice(2, 6) + ext
  const buf = Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ''), 'base64')
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf)
  ok(res, { url: '/uploads/' + fname })
})

// 商家商品管理
app.get('/api/merchant/goods', merchantGuard, (req, res) => {
  ok(res, store.prepare('SELECT * FROM goods ORDER BY id DESC').all())
})

// 商品分类列表（供新增/编辑商品时选择或新增）
app.get('/api/merchant/goods/categories', merchantGuard, (req, res) => {
  const rows = store.prepare("SELECT category FROM goods WHERE category != '' GROUP BY category ORDER BY MIN(id)").all()
  ok(res, rows.map((r) => r.category))
})

// 单独调整库存（标记售空=置0 / 恢复库存），不触碰其它字段
app.put('/api/merchant/goods/stock', merchantGuard, (req, res) => {
  const { id, stock } = req.body || {}
  if (!id) return res.status(400).json({ code: 400, msg: '缺少商品 id' })
  if (stock === undefined || stock === null || stock === '') return res.status(400).json({ code: 400, msg: '缺少库存值' })
  try {
    const g = store.prepare('SELECT * FROM goods WHERE id=?').get(Number(id))
    if (!g) return res.status(404).json({ code: 404, msg: '商品不存在' })
    const newStock = toStock(stock, 0)
    store.prepare('UPDATE goods SET stock=? WHERE id=?').run(newStock, Number(id))
    audit(req, 'goods/stock', 'goods#' + id, 'stock ' + g.stock + '→' + newStock)
    ok(res, store.prepare('SELECT * FROM goods WHERE id=?').get(Number(id)))
  } catch (e) {
    console.error('[goods/stock] ERROR', e && e.stack)
    res.status(500).json({ code: 500, msg: e.message })
  }
})

app.post('/api/merchant/goods', merchantGuard, (req, res) => {
  const { name, price, original_price, image, category, stock, description } = req.body || {}
  if (!name) return res.status(400).json({ code: 400, msg: '商品名称不能为空' })
  const info = store.prepare('INSERT INTO goods (name, price, original_price, image, category, stock, description) VALUES (?,?,?,?,?,?,?)')
    .run(name, Number(price), Number(original_price || 0), image || '', category || '其他', toStock(stock, 999), description || '')
  audit(req, 'goods/create', 'goods#' + info.lastInsertRowid, 'name=' + name + ' price=' + price + ' stock=' + toStock(stock, 999))
  ok(res, { id: Number(info.lastInsertRowid) })
})

app.put('/api/merchant/goods', merchantGuard, (req, res) => {
  const { id, name, price, original_price, image, category, stock, description, status } = req.body || {}
  if (!id) return res.status(400).json({ code: 400, msg: '缺少商品 id' })
  const cur = store.prepare('SELECT * FROM goods WHERE id=?').get(Number(id))
  if (!cur) return res.status(404).json({ code: 404, msg: '商品不存在' })
  // 编辑商品时未传 stock 字段 → 保留原库存；传了（含 0）→ 用传入值（修复「设 0 变 999」）
  const st = stock === undefined || stock === null || stock === '' ? cur.stock : toStock(stock, 999)
  store.prepare('UPDATE goods SET name=?, price=?, original_price=?, image=?, category=?, stock=?, description=?, status=? WHERE id=?')
    .run(name, Number(price), Number(original_price || 0), image || '', category || '其他', st, description || '', status !== undefined ? Number(status) : 1, Number(id))
  audit(req, 'goods/update', 'goods#' + id, 'name=' + name + ' price=' + price + ' stock=' + st + ' status=' + (status !== undefined ? status : 1))
  ok(res)
})

app.put('/api/merchant/goods/status', merchantGuard, (req, res) => {
  store.prepare('UPDATE goods SET status=? WHERE id=?').run(Number(req.body.status), Number(req.body.id))
  audit(req, 'goods/status', 'goods#' + req.body.id, 'status=' + Number(req.body.status))
  ok(res)
})

// ---------- 商家端活动管理（发布/编辑/上下线/删除） ----------
app.get('/api/merchant/activities', merchantGuard, (req, res) => {
  ok(res, store.prepare('SELECT * FROM activities ORDER BY sort, id DESC').all())
})

app.post('/api/merchant/activities', merchantGuard, (req, res) => {
  const { title, subtitle = '', image = '', link = '', sort = 0 } = req.body || {}
  if (!title) return res.status(400).json({ code: 400, msg: '活动标题不能为空' })
  const info = store.prepare('INSERT INTO activities (title, subtitle, image, link, status, sort) VALUES (?,?,?,?,1,?)')
    .run(title, subtitle, image, link, Number(sort || 0))
  audit(req, 'activity/create', 'activity#' + info.lastInsertRowid, 'title=' + title)
  ok(res, { id: Number(info.lastInsertRowid) })
})

app.put('/api/merchant/activities', merchantGuard, (req, res) => {
  const { id, title, subtitle, image, link, sort } = req.body || {}
  if (!id) return res.status(400).json({ code: 400, msg: '缺少活动ID' })
  const cur = store.prepare('SELECT * FROM activities WHERE id=?').get(Number(id))
  if (!cur) return res.status(404).json({ code: 404, msg: '活动不存在' })
  store.prepare('UPDATE activities SET title=?, subtitle=?, image=?, link=?, sort=? WHERE id=?')
    .run(
      title !== undefined ? title : cur.title,
      subtitle !== undefined ? subtitle : cur.subtitle,
      image !== undefined ? image : cur.image,
      link !== undefined ? link : cur.link,
      sort !== undefined ? Number(sort) : cur.sort,
      Number(id)
    )
  audit(req, 'activity/update', 'activity#' + id, 'title=' + (title !== undefined ? title : cur.title))
  ok(res)
})

// 活动上下线：status 1 发布（用户端可见）/ 0 下线
app.put('/api/merchant/activities/status', merchantGuard, (req, res) => {
  store.prepare('UPDATE activities SET status=? WHERE id=?').run(Number(req.body.status), Number(req.body.id))
  audit(req, 'activity/status', 'activity#' + req.body.id, 'status=' + Number(req.body.status))
  ok(res)
})

app.delete('/api/merchant/activities', merchantGuard, (req, res) => {
  store.prepare('DELETE FROM activities WHERE id=?').run(Number(req.body.id))
  audit(req, 'activity/delete', 'activity#' + req.body.id, '')
  ok(res)
})

// ---------- 机器人设备列表（真实模式：调平台 runtimeStatusList） ----------
// 平台未配置/调用失败时返回明确错误，前端展示错误卡
app.get('/api/merchant/robots', merchantGuard, async (req, res) => {
  const r = await platform.getDeviceList()
  if (!r.ok) {
    return res.status(502).json({ code: 502, msg: r.msg || '获取机器人失败' })
  }
  ok(res, r.robots)
})

// ---------- 配送监控 ----------
app.get('/api/merchant/delivery/monitor', merchantGuard, async (req, res) => {
  const tasks = store.prepare(`
    SELECT d.*, o.order_no, o.landmark_name, o.status AS order_status, o.daily_seq AS order_daily_seq
    FROM delivery_tasks d JOIN orders o ON d.order_id = o.id
    WHERE d.task_status < 80 OR (d.task_status >= 90 AND d.task_status < 110)
    ORDER BY d.id DESC`).all()
  const out = []
  for (const t of tasks) {
    const pos = await platform.getDevicePosition(store, t.id)
    out.push({ ...t, position: pos })
  }
  ok(res, out)
})

// ---------- 配送监控地图（真实校园地图 + 点位 + 路网 + 机器人位置 + 路线） ----------
app.get('/api/merchant/map', merchantGuard, async (req, res) => {
  const r = await platform.getMapOverview(store)
  r.ok ? ok(res, r) : res.status(502).json({ code: 502, msg: r.msg || '获取地图失败' })
})

// ---------- 开放物流平台回调（真实业务逻辑） ----------
// 回调防伪：令牌在创建排队任务时以 ?token= 拼进 feedbackDeliveryTaskUrl / checkBizOrderStatusUrl。
// 这些回调地址经 cloudflared 公网可达，此前任何人都能 POST 一条伪造的 taskStatus，
// 把任意订单驱动成「已送达」并结算销量，甚至驱动退款流程。
// 无法派生令牌时（PLATFORM_SECRET 为空且未显式配置 PLATFORM_CALLBACK_TOKEN）选择放行：
// 那种情况下本来就没有真实平台对接，一律拦住只会让本地演示全线失败；启动日志已就此告警。
function callbackAuthorized(req) {
  const expected = runtime.callbackToken
  if (!expected) return true
  const given = String(req.query.token || req.params.token || (req.body && req.body.token) || '')
  if (!given) return false
  // 定长摘要比较，避免通过响应时间逐位猜解
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function cbDenied(res) {
  console.warn('[platform] 回调防伪校验失败，已拒绝')
  res.status(403).json({ code: 'FAIL', msg: 'invalid token' })
}

// feedbackDeliveryTaskUrl：平台在任务状态变更时 POST 到这里，同步任务与订单状态
function handleDeliveryCallback(req, res) {
  if (!callbackAuthorized(req)) return cbDenied(res)
  const body = req.body || {}
  // 兼容多种报文形态：直接字段 / task 包装 / data 包装（DeliveryTaskBasicVo 结构）
  const src = (body.data && typeof body.data === 'object') ? body.data : body
  const taskId = src.taskId || src.id || (src.task && src.task.id)
  const status = src.taskStatus !== undefined ? src.taskStatus
    : (src.task && src.task.taskStatus)
  if (!taskId || status === undefined) {
    return res.json({ code: 'FAIL', msg: '缺少任务ID或状态' })
  }
  const row = store.prepare('SELECT * FROM delivery_tasks WHERE platform_task_id=?').get(String(taskId))
  if (!row) {
    return res.json({ code: 'FAIL', msg: '任务不存在' })
  }
  platform.applyStatus(store, row.id, Number(status), src.taskStatusText || platformStatusText(status))
  // 同步设备编号
  const sn = src.deviceSn || (src.task && src.task.deviceSn)
  if (sn && !row.device_sn) {
    store.prepare('UPDATE delivery_tasks SET device_sn=? WHERE id=?').run(sn, row.id)
  }
  res.json({ code: 'SUCCESS', msg: 'ok' })
}
app.post('/api/platform/callback/delivery', handleDeliveryCallback)
// 备用形态：令牌走路径段（平台侧若对 query 做规范化时可用）
app.post('/api/platform/cb/:token/delivery', handleDeliveryCallback)

function platformStatusText(code) {
  const map = {
    0: '排队中', 10: '任务已接收', 20: '去往上货点', 30: '到达上货点',
    40: '上货中', 50: '已上货', 60: '去往取货点', 70: '到达取货点', 80: '任务完成',
    90: '上货失败', 100: '取货失败', 110: '任务取消', 120: '上货流程挂起', 130: '下货流程挂起', 140: '待完善', 150: '任务被关闭'
  }
  return map[Number(code)] || ('状态 ' + code)
}

// checkBizOrderStatusUrl：设备端在关键节点检查业务订单状态（是否已退款/人工送达等）
// 返回值格式以 Apifox open-logis_1.0 文档为准：HttpMethod 必须为 POST、公开访问，
// 需要强制关闭任务时返回 keyEvent（taskSubStatus 201 已退款 / 202 人工送达）。
function handleCheckOrder(req, res) {
  if (!callbackAuthorized(req)) return cbDenied(res)
  const orderNo = req.query.orderNo || req.query.outOrderNo || (req.body && (req.body.orderNo || req.body.outOrderNo))
  if (!orderNo) return res.json({ code: 'FAIL', msg: '缺少订单号' })
  const order = store.prepare('SELECT * FROM orders WHERE order_no=?').get(String(orderNo))
  if (!order) return res.json({ code: 'FAIL', msg: '订单不存在' })
  const st = Number(order.status)
  // 5已取消 与 7已退款 都必须让设备强制关任务。原先只判 5，已退款订单平台侧永远收不到
  // forceCloseTask，机器人照送不误 —— 钱退了、餐也送到了。
  // taskSubStatus 按对接文档只有 201已退款 / 202人工送达 两种，故用 eventDesc 区分具体原因。
  if (st === 5 || st === 7 || order.cancelled_at) {
    return res.json({
      code: 'COMM_200',
      data: {
        keyEvent: {
          eventName: 'forceCloseTask',
          taskSubStatus: 201,
          eventDesc: st === 7 ? '订单已退款' : '订单已取消'
        }
      },
      msg: 'ok'
    })
  }
  // 订单正常：无强制关闭事件
  res.json({ code: 'COMM_200', data: null, msg: 'ok' })
}
app.get('/api/platform/check-order', handleCheckOrder)
app.post('/api/platform/check-order', handleCheckOrder)
app.get('/api/platform/cb/:token/check-order', handleCheckOrder)
app.post('/api/platform/cb/:token/check-order', handleCheckOrder)

// 设备异常上报回调（T 任务类 / R 机器类 / I IOT 类 / N 导航类）
function handleExceptionCallback(req, res) {
  if (!callbackAuthorized(req)) return cbDenied(res)
  const body = req.body || {}
  console.warn('[platform] 设备异常上报', JSON.stringify(body))
  res.json({ code: 'SUCCESS', msg: 'ok' })
}
app.post('/api/platform/callback/exception', handleExceptionCallback)
app.post('/api/platform/cb/:token/exception', handleExceptionCallback)

// ---------- 平台点位同步（商家端入口） ----------
app.post('/api/merchant/landmarks/sync', merchantGuard, async (req, res) => {
  const r = await platform.syncLandmarks(store)
  r.ok ? ok(res, r) : res.status(500).json({ code: 500, msg: r.msg || '同步失败' })
})

// ---------- 商家面对面扫码上货（设备控制） ----------
// 流程：扫码识别机器人(scan) → 打开舱门(open-bin) → 放货 → 关闭舱门(close-bin，等待) → 立即配送(dispatch)
function getLoadingTask(body) {
  const id = Number((body || {}).task_id)
  if (!id) return null
  return store.prepare('SELECT d.*, o.pickup_code FROM delivery_tasks d JOIN orders o ON o.id=d.order_id WHERE d.id=?').get(id)
}

// 扫码识别机器人：按 deviceSn 定位待上货订单 + 获取控制权（已由下方批次版 /api/merchant/device/scan 取代）

// 测试辅助：真实模式无真机器人时，把卡在「配送中」的订单/批次标记为已送达(3)或已完成(4)，便于走通流程
// 支持：order_id（单订单）/ batch_id（整批全部订单）
app.post('/api/merchant/delivery/test-complete', merchantGuard, (req, res) => {
  // 非模拟档禁止测试完成接口（防止把真实配送中的订单直接标为完成）
  if (!runtime.deviceMock) return res.status(404).json({ code: 404, msg: '当前运行模式不允许测试完成' })
  const { order_id, batch_id, status = 3 } = req.body || {}
  console.log('[merchant] test-complete called, order_id=' + order_id + ' batch_id=' + batch_id + ' status=' + status + ' user=' + req.user.id)
  const to = Number(status) === 4 ? 4 : 3
  const ids = []
  if (batch_id) {
    store.prepare('SELECT id FROM orders WHERE batch_id=? AND status IN (2,3)').all(Number(batch_id)).forEach((r) => ids.push(r.id))
  } else if (order_id) {
    ids.push(Number(order_id))
  }
  if (!ids.length) return res.status(404).json({ code: 404, msg: '没有可标记的订单' })
  const touched = new Set()
  for (const id of ids) {
    const order = store.prepare('SELECT * FROM orders WHERE id=?').get(id)
    if (!order) continue
    if (order.delivery_task_id) {
      store.prepare("UPDATE delivery_tasks SET task_status=80, status_text='任务完成（测试）', updated_at=datetime('now','localtime') WHERE id=?")
        .run(order.delivery_task_id)
    }
    store.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(to, id)
    if (to === 4) batch.markOrderPicked(store, order)
    if (order.batch_id) touched.add(order.batch_id)
  }
  // 批次状态联动：全部完成 → 已完成；否则待上货批次推进为配送中（避免「待上货批次里躺着已送达订单」）
  for (const bid of touched) reconcileBatchState(store, bid)
  audit(req, 'test/complete', (batch_id ? 'batch#' + batch_id : 'order#' + (order_id || '')), 'count=' + ids.length + ' status=' + to)
  ok(res, { count: ids.length, status: to })
})

// 测试/异常后批次状态重算：全部有效订单已取走 → 已完成；
// 批次内已有已送达(3)/已完成(4)订单（配送已真正开始）→ 推进为配送中(2)；
// 否则保持待上货（批次尚未派发，订单仍为待上货状态）。
function reconcileBatchState(store, batchId) {
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batchId))
  if (!b) return
  const stats = store.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN o.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN o.status IN (3,4) THEN 1 ELSE 0 END) AS delivered
    FROM orders o WHERE o.batch_id=? AND o.status IN (2,3,4)`).get(batchId)
  const total = Number(stats && stats.total || 0)
  const done = Number(stats && stats.done || 0)
  const delivered = Number(stats && stats.delivered || 0)
  if (total > 0 && done >= total) {
    store.prepare("UPDATE delivery_batches SET status=3, status_text='已完成', picked_orders=?, completed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
      .run(done, batchId)
  } else if (delivered > 0 && Number(b.status) === 1) {
    store.prepare("UPDATE delivery_batches SET status=2, status_text='配送中', updated_at=datetime('now','localtime') WHERE id=?")
      .run(batchId)
  }
}

// 待上货批次列表：组单中(可派车) / 待上货(已派车，任务排队中/去上货点/上货中) / 配送中
app.get('/api/merchant/device/pending', merchantGuard, (req, res) => {
  const openBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=0 ORDER BY id DESC LIMIT 5').all()
  const readyBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=1 ORDER BY id DESC LIMIT 10').all()
  const activeBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=2 ORDER BY id DESC LIMIT 10').all()
  const wrap = (list) => list.map((b) => batch.getBatchDetail(store, b.id)).filter(Boolean)
  const open = wrap(openBatches)
  const ready = wrap(readyBatches)
  // 待配单订单数（配单上货红点）：组单中 + 待上货批次内的订单总数（按订单计，非批次数）
  const pendingOrders = open.reduce((s, b) => s + (b.orders || []).length, 0)
    + ready.reduce((s, b) => s + (b.orders || []).length, 0)
  ok(res, { open_batches: open, ready_batches: ready, active_batches: wrap(activeBatches), pending_orders: pendingOrders })
})

// 扫码识别机器人 → 定位待上货批次（一车多单）：返回批次与全部订单
app.post('/api/merchant/device/scan', merchantGuard, async (req, res) => {
  const { deviceSn = '' } = req.body || {}
  if (!deviceSn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
  let batchRow = null
  if (process.env.PLATFORM_MOCK === 'true') {
    // 模拟：取最早一个待上货批次（或已派车批次）
    batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status IN (1,2) ORDER BY id DESC LIMIT 1').get()
    if (!batchRow) batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status=0 ORDER BY id DESC LIMIT 1').get()
  } else {
    // 真实（P1-10）：只按扫码设备号精确匹配待上货批次。
    // 原先匹配不到会回退「取最早待上货批次」并顺手把 device_sn 覆盖成扫到的车 ——
    // 商家对着 A 车扫码，货却上到 B 车（或 A 车被派了 B 车的货），真机误送必出客诉。
    // 匹配不到直接 404 报错，引导商家先派车并指定本机器人，绝不静默认错车。
    batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status=1 AND device_sn=? ORDER BY id DESC LIMIT 1').get(deviceSn)
  }
  if (!batchRow) return res.status(404).json({ code: 404, msg: '该机器人没有待上货的批次，请先在批次列表「派车」并指定本机器人' })
  // 记录设备编号到批次与批次内任务
  store.prepare("UPDATE delivery_batches SET device_sn=?, updated_at=datetime('now','localtime') WHERE id=?").run(deviceSn, batchRow.id)
  store.prepare("UPDATE delivery_tasks SET device_sn=? WHERE batch_id=? AND (device_sn='' OR device_sn IS NULL)").run(deviceSn, batchRow.id)
  batchRow.device_sn = deviceSn
  const detail = batch.getBatchDetail(store, batchRow.id)
  const g = await platform.grantControl(deviceSn)
  // 需求3：附带无人车是否已在上货点，供上货页展示「已就位 ✓ / 距上货点 N 米」
  const lp = await platform.robotAtLoadingPoint(store, deviceSn)
  audit(req, 'device/scan', 'batch#' + detail.id, 'device_sn=' + deviceSn + ' control=' + (g.ok ? 'granted' : 'fail'))
  ok(res, {
    batch_id: detail.id,
    batch_no: detail.batch_no,
    device_sn: detail.device_sn,
    status: detail.status,
    status_text: detail.status_text,
    total_orders: detail.total_orders,
    orders: detail.orders,
    route: detail.route,
    control_ok: g.ok,
    control_msg: g.ok ? '' : g.msg,
    at_loading_point: lp.at_loading_point,
    distance_m: lp.distance_m,
    loading_msg: lp.ok ? '' : lp.msg
  })
})

// 打开舱门（上货验证，验证通过自动开舱）
app.post('/api/merchant/device/open-bin', merchantGuard, async (req, res) => {
  const task = getLoadingTask(req.body)
  if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
  if (!task.platform_task_id) return res.status(400).json({ code: 400, msg: '任务未下发到平台' })
  // 需求3门禁：无人车必须已到达上货点才能开舱上货（真实档校验；演示档恒通过）
  const gate = await platform.robotAtLoadingPoint(store, task.device_sn)
  if (!gate.ok) return res.status(400).json({ code: 400, msg: '开舱失败：' + gate.msg })
  const r = await platform.loadingVerify(task.device_sn, task.platform_task_id, { anyCode: task.pickup_code })
  if (r.ok) {
    audit(req, 'device/open-bin', 'task#' + task.id, 'order#' + task.order_id + ' device_sn=' + task.device_sn)
    ok(res)
  } else {
    res.status(502).json({ code: 502, msg: r.msg })
  }
})

// 关闭舱门（关舱等待，不派发；机器人原地等待，滑块/按钮触发 dispatch 才派发）
app.post('/api/merchant/device/close-bin', merchantGuard, async (req, res) => {
  const task = getLoadingTask(req.body)
  if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
  if (!task.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
  const r = await platform.drawerCtrl(task.device_sn, 0)
  if (r.ok) {
    audit(req, 'device/close-bin', 'task#' + task.id, 'order#' + task.order_id + ' device_sn=' + task.device_sn)
    ok(res)
  } else {
    res.status(502).json({ code: 502, msg: r.msg })
  }
})

// 开始配送（确认上货）
app.post('/api/merchant/device/dispatch', merchantGuard, async (req, res) => {
  const task = getLoadingTask(req.body)
  if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
  if (!task.platform_task_id) return res.status(400).json({ code: 400, msg: '任务未下发到平台' })
  if (!task.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
  const r = await platform.loadingConfirm(task.device_sn, task.platform_task_id, { anyCode: task.pickup_code })
  if (r.ok) {
    audit(req, 'device/dispatch', 'task#' + task.id, 'order#' + task.order_id + ' device_sn=' + task.device_sn)
    ok(res)
  } else {
    res.status(502).json({ code: 502, msg: r.msg })
  }
})

// ---------- 真实模式任务状态轮询兜底 ----------
if (runtime.realPlatform) {
  const POLL_MS = Number(process.env.PLATFORM_POLL_MS || 8000)
  setInterval(async () => {
    try {
      // P1-4：只跳过终态（80 完成 / 110 取消 / 150 关闭）与已作废任务。
      // 70 到达取货点必须轮询：到达回调若丢失，轮询是订单推进到「已送达(3)」的兜底。
      // 90-109（上货/取货失败）与 120-140（挂起）同样在轮询范围 —— 它们需要同步到
      // 「配送异常(6)」或人工恢复，原先 task_status < 80 把它们全部挡在轮询外，订单卡死。
      const rows = store.prepare(`
        SELECT d.id FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
        WHERE d.task_status NOT IN (80,110,150) AND d.void_at IS NULL AND d.platform_task_id != ''`).all()
      for (const r of rows) {
        await platform.syncTaskStatus(store, r.id)
      }
    } catch (e) { /* 轮询异常静默 */ }
  }, POLL_MS)

  // ---------- 超时未接单检测 ----------
  // 机器人长时间未接单/任务挂起（排队/去上货点/上货中/挂起态）→ 订单标记「配送异常(6)」，由商家处理。
  // 阈值默认 15 分钟，可用环境变量 DELIVERY_TIMEOUT_MS 覆盖；扫描间隔 DELIVERY_SCAN_MS（默认 60s）。
  // （常量定义已上移到模块顶层，demo 档的 orderStuckDelivering 同样依赖。）
  const STUCK_TASK_STATES = [0, 10, 20, 30, 40] // 排队中/任务已接收/去上货点/到达上货点/上货中（未真正开始配送）

  function scanStuckDeliveries() {
    try {
      const cutoff = new Date(Date.now() - DELIVERY_TIMEOUT_MS)
      const cs = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0') + '-' + String(cutoff.getDate()).padStart(2, '0') +
        ' ' + String(cutoff.getHours()).padStart(2, '0') + ':' + String(cutoff.getMinutes()).padStart(2, '0') + ':' + String(cutoff.getSeconds()).padStart(2, '0')
      const rows = store.prepare(`
        SELECT d.id, d.order_id, d.task_status FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
        WHERE o.status = 2 AND d.task_status NOT IN (70,80,110,150) AND d.void_at IS NULL AND d.updated_at < ?`).all(cs)
      for (const r of rows) {
        store.prepare("UPDATE orders SET status=6, updated_at=datetime('now','localtime') WHERE id=? AND status=2").run(r.order_id)
        store.prepare("UPDATE delivery_tasks SET status_text='机器人长时间未接单或任务挂起（超时' + (?) + '分钟），订单已标记配送异常', updated_at=datetime('now','localtime') WHERE id=?")
          .run(Math.round(DELIVERY_TIMEOUT_MS / 60000), r.id)
        console.warn('[delivery] 配送超时未接单 → 配送异常 order=' + r.order_id + ' task=' + r.id + ' task_status=' + r.task_status)
      }
    } catch (e) { /* 扫描异常静默 */ }
  }
  setInterval(scanStuckDeliveries, DELIVERY_SCAN_MS)
  scanStuckDeliveries()
}

// ---------- 批次自动派车（一车多单） ----------
// 组单中的批次满足任一条件即自动派车：
//  1) 达到一车容量上限（BATCH_MAX_ORDERS，默认 12 单）
//  2) 自动接单模式开启且批次成立超过 BATCH_WAIT_MS（默认 90s）
// 手动「派车」按钮始终可用。
const BATCH_SCAN_MS = Number(process.env.BATCH_SCAN_MS || 15 * 1000)
setInterval(async () => {
  try {
    // P1-4：模拟配送到达处理（不依赖营业状态、不依赖内存 setTimeout，重启后按落库时间补送达）
    const arrivals = store.prepare("SELECT * FROM delivery_batches WHERE status=2 AND mock_arrive_at IS NOT NULL AND mock_arrive_at <= datetime('now','localtime')").all()
    for (const b of arrivals) {
      const orderIds = store.prepare('SELECT id FROM orders WHERE batch_id=? AND status=2').all(b.id).map((r) => r.id)
      for (const oid of orderIds) {
        store.prepare("UPDATE delivery_tasks SET task_status=70, status_text='到达取货点（模拟）', updated_at=datetime('now','localtime') WHERE order_id=?").run(oid)
        store.prepare("UPDATE orders SET status=3, updated_at=datetime('now','localtime') WHERE id=?").run(oid)
        try { goodsStats.settleSales(store, oid) } catch (e) { /* 忽略 */ }
      }
      reconcileBatchState(store, b.id)
      store.prepare("UPDATE delivery_batches SET mock_arrive_at=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(b.id)
      console.log('[batch] 模拟配送到达（测试）batch=' + b.batch_no + ' 订单 ' + orderIds.length + ' 单 → 待取货')
    }
    const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
    if (shop.business_status !== 'open') return
    const openBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=0 ORDER BY id ASC').all()
    for (const b of openBatches) {
      // P1-9：容量按实时件数计（批次内 status IN (1,2) 的订单 SUM(quantity)），不再信任
      // 冗余列 total_orders/total_items —— 取消单/退款单残留计数会让批次「看似满」或「永不触发满额派车」。
      const cnt = store.prepare(`
        SELECT COUNT(DISTINCT o.id) c, IFNULL(SUM(oi.quantity),0) items
        FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.batch_id=? AND o.status IN (1,2)`).get(b.id)
      const n = Number(cnt && cnt.c || 0)
      if (n <= 0) continue
      const items = Number(cnt && cnt.items || 0)
      // 有订单就召唤机器人到上货点待命（不创建配送任务、不锁定批次）：
      // 批次保持组单中持续接收新订单（多单合并），商家点「上货」定型时才创建配送任务。
      // 召唤失败（如无在线车）静默，批次仍在组单中，商家上货时若车未到会提示等待。
      console.log('[batch] 检测到待上货订单，召唤机器人 ' + b.batch_no + ' 共' + n + '单' + items + '件')
      await platform.summonToLoadingPoint(store)
    }
  } catch (e) { console.warn('[batch] 自动派车扫描异常', e.message) }
}, BATCH_SCAN_MS)

app.listen(PORT, () => {
  const d = runtime.describe()
  console.log(`[lingdong-backend] listening on http://127.0.0.1:${PORT}`)
  console.log(`[lingdong-backend] 运行模式 RUN_MODE=${d.run_mode}`)
  console.log(`[lingdong-backend]   登录：${d.real_login ? '真实微信 code2session' : '演示（token 可预测，不可用于真实运营）'}`)
  console.log(`[lingdong-backend]   支付：${d.real_pay ? '微信支付 V3' : '模拟（不产生资金流，退款也不会真实退钱）'}`)
  if (d.real_platform) {
    console.log(`[lingdong-backend]   配送：开放物流平台真实模式 ${d.platform_host}${d.prod_platform ? '【生产】' : '【测试】'}${d.unsafe_prod ? ' (ALLOW_UNSAFE_PROD_PLATFORM)' : ''}`)
    if (!platform.platformReady()) {
      console.warn('[lingdong-backend]   ⚠ 未配置 PLATFORM_APPID/PLATFORM_SECRET，任务不会真正下发')
    }
  } else {
    console.log('[lingdong-backend]   配送：本地 Mock 状态机（PLATFORM_MOCK=true）')
  }
  console.log(`[lingdong-backend]   设备控制：${d.device_mock ? '本地模拟（开舱/关舱/派发均为假成功）' : '真实分支（调用平台设备控制接口）'}`)
  console.log(`[lingdong-backend]   商家邀请码：${d.merchant_invite_configured ? '已配置' : '未配置 → 商家端登录将被拒绝'}`)
})
