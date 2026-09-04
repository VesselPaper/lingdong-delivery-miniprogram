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
const platform = require('./services/platform')
const wxpay = require('./services/wxpay')
const batch = require('./services/batch')

const store = init()
const app = express()
const PORT = process.env.PORT || 3000
const UPLOAD_DIR = path.join(__dirname, 'uploads')

const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

app.use(cors())
app.use(express.json({ limit: '8mb' }))
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

// ---------- 登录 ----------
app.post('/api/auth/login', async (req, res) => {
  const { code, role = 'student', nickname = '' } = req.body || {}
  if (!code) return res.status(400).json({ code: 400, msg: '缺少登录凭证' })
  let openid = ''

  // ==================== 演示模式（测试阶段启用） ====================
  // 未接真实微信登录时，点击「微信登录」直接成功，便于预览页面。
  // 以 code 的稳定哈希作为 openid：登录后 token 存本地，同一设备账号稳定。
  openid = 'demo_' + crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 24)

  // ==================== 真实微信登录（正式环境启用，测试阶段已注释） ====================
  // 启用方法：取消下方注释，并在 backend/.env 配置 WX_APPID / WX_SECRET
  // if (WX_APPID && WX_SECRET) {
  //   try {
  //     const resp = await fetch(`https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(WX_APPID)}&secret=${encodeURIComponent(WX_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`)
  //     const data = await resp.json()
  //     if (!data.openid) return res.status(401).json({ code: 401, msg: '微信登录失败：' + (data.errmsg || '未知错误') })
  //     openid = data.openid
  //   } catch (e) {
  //     return res.status(500).json({ code: 500, msg: '登录服务异常' })
  //   }
  // }
  // =====================================================================================

  let user = store.prepare('SELECT * FROM users WHERE openid=?').get(openid)
  if (!user) {
    const roleVal = role === 'merchant' ? 'merchant' : 'student'
    const info = store.prepare('INSERT INTO users (openid, nickname, role) VALUES (?,?,?)')
      .run(openid, nickname || '微信用户', roleVal)
    user = store.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid))
  } else if (nickname) {
    store.prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname, user.id)
    user = store.prepare('SELECT * FROM users WHERE id=?').get(user.id)
  }
  ok(res, { token: user.openid, user })
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
app.get('/api/landmarks', (req, res) => {
  ok(res, store.prepare('SELECT * FROM landmarks ORDER BY sort').all())
})

// ---------- 购物车 ----------
app.get('/api/cart/list', auth, (req, res) => {
  const rows = store.prepare(`
    SELECT c.id, c.goods_id, c.quantity, c.selected, g.name, g.price, g.image, g.status AS goods_status
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

// 订单是否「真正开始配送」：已接单(2)且机器人已上货出发（任务状态 >= 50 已上货）
function orderTrulyDelivering(order) {
  if (Number(order.status) !== 2) return false
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  return !!task && Number(task.task_status) >= 50
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

// 订单取消落库：订单置 5 已取消；若配送任务未完成，同步标记任务取消(110)；从配送批次中移除
function applyOrderCancelled(order) {
  store.prepare("UPDATE orders SET status=5, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
  if (order.delivery_task_id) {
    const t = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    if (t && Number(t.task_status) < 80) {
      store.prepare("UPDATE delivery_tasks SET task_status=110, status_text='订单取消', updated_at=datetime('now','localtime') WHERE id=?")
        .run(order.delivery_task_id)
    }
  }
  batch.removeOrderFromBatch(store, order)
}

app.post('/api/order/create', auth, (req, res) => {
  const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
  if (shop.business_status === 'closed') {
    return res.status(400).json({ code: 400, msg: '店铺歇业中，暂无法下单' })
  }
  const { landmark_id, landmark_name, remark = '', items = [] } = req.body || {}
  if (!items.length) return res.status(400).json({ code: 400, msg: '订单不能为空' })
  let total = 0
  const lineItems = items.map((it) => {
    const g = store.prepare('SELECT * FROM goods WHERE id=?').get(Number(it.goods_id))
    if (!g) throw new Error('商品不存在')
    total += g.price * Number(it.quantity || 1)
    return { goods: g, quantity: Number(it.quantity || 1) }
  })
  const orderNo = 'LD' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6).toUpperCase()
  const pickupCode = String(Math.floor(1000 + Math.random() * 9000))
  const info = store.prepare(`INSERT INTO orders
    (order_no, user_id, landmark_id, landmark_name, contact_name, contact_phone, total_amount, status, remark, pickup_code)
    VALUES (?,?,?,?,?,?,?,0,?,?)`)
    .run(orderNo, req.user.id, landmark_id || '', landmark_name || '', req.user.nickname || '', req.user.phone || '', total.toFixed(2), remark, pickupCode)
  const orderId = Number(info.lastInsertRowid)
  const insItem = store.prepare('INSERT INTO order_items (order_id, goods_id, goods_name, goods_image, price, quantity) VALUES (?,?,?,?,?,?)')
  lineItems.forEach(({ goods, quantity }) => {
    insItem.run(orderId, goods.id, goods.name, goods.image, goods.price, quantity)
    store.prepare('UPDATE goods SET sales=sales+?, stock=MAX(0,stock-?) WHERE id=?').run(quantity, quantity, goods.id)
  })
  // 清空已选购物车
  store.prepare('DELETE FROM cart WHERE user_id=?').run(req.user.id)
  ok(res, { order_id: orderId, order_no: orderNo, total_amount: total, pickup_code: pickupCode })
})

app.post('/api/order/pay', auth, async (req, res) => {
  const row = store.prepare('SELECT o.*, u.openid FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id=? AND o.user_id=?')
    .get(Number(req.body.id), req.user.id)
  if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (row.status !== 0) return res.status(400).json({ code: 400, msg: '订单状态不允许支付' })
  // 试点临时开关：PAY_MOCK=true 时跳过真实微信支付，直接标记已支付进入待接单，用于先跑通真实配送链路。
  // 真实支付代码（下方 wxpay.jsapiPay）保持不动，商户号/登录就绪后删除本开关即切真实收款。
  if (process.env.PAY_MOCK === 'true') {
    store.prepare("UPDATE orders SET status=1, updated_at=datetime('now','localtime') WHERE id=?").run(row.id)
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
      description: '零栋无人送餐-订单' + row.order_no,
      amountFen: Math.round(Number(row.total_amount) * 100)
    })
    ok(res, { order_id: row.id, payParams })
  } catch (e) {
    res.status(502).json({ code: 502, msg: '微信支付下单失败：' + e.message })
  }
})

// 微信支付结果回调（由微信服务器调用；订单状态以回调为准）
app.post('/api/pay/notify', (req, res) => {
  try {
    const body = req.body || {}
    if (!body.resource) return res.status(400).json({ code: 'FAIL', message: '缺少回调资源' })
    const info = wxpay.decryptNotify(body.resource)
    if (info.trade_state === 'SUCCESS' && info.out_trade_no) {
      const order = store.prepare('SELECT * FROM orders WHERE order_no=?').get(info.out_trade_no)
      if (order && order.status === 0) {
        store.prepare("UPDATE orders SET status=1, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
        maybeAutoAccept(store, order)
      }
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

// ---------- 我的页订单红点（订单到达/状态已接单等未读动态） ----------
// 未读 = 存在「执行中状态（待接单/配送中/已送达）」且 updated_at 晚于上次已读时间的订单
app.get('/api/user/order/badge', auth, (req, res) => {
  const u = store.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
  const readAt = (u && u.order_read_at) || '1970-01-01 00:00:00'
  const row = store.prepare(`
    SELECT COUNT(*) c FROM orders
    WHERE user_id=? AND status IN (1,2,3) AND updated_at > ?`).get(req.user.id, readAt)
  const count = Number(row && row.c || 0)
  ok(res, { unread: count > 0, count, has_active: count > 0 })
})

// 已读订单动态：进入订单列表/详情时调用
app.post('/api/user/order/mark-read', auth, (req, res) => {
  store.prepare("UPDATE users SET order_read_at=datetime('now','localtime') WHERE id=?").run(req.user.id)
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
app.post('/api/order/cancel', auth, (req, res) => {
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
  applyOrderCancelled(order)
  ok(res)
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
app.post('/api/merchant/cancel-request/handle', merchantGuard, (req, res) => {
  const { id, action = '', reply = '' } = req.body || {}
  const c = store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(Number(id))
  if (!c) return res.status(404).json({ code: 404, msg: '取消申请不存在' })
  if (Number(c.status) !== 0) return res.status(400).json({ code: 400, msg: '该申请已处理' })
  if (action === 'approve') {
    store.prepare("UPDATE cancel_requests SET status=3, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?")
      .run(reply || '同意取消', c.id)
    const order = store.prepare('SELECT * FROM orders WHERE id=?').get(c.order_id)
    if (order && [0, 1, 2].includes(Number(order.status))) applyOrderCancelled(order)
    return ok(res, store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(c.id))
  }
  if (action === 'reject') {
    if (!reply) return res.status(400).json({ code: 400, msg: '请填写拒绝理由' })
    store.prepare("UPDATE cancel_requests SET status=2, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?")
      .run(reply, c.id)
    return ok(res, store.prepare('SELECT * FROM cancel_requests WHERE id=?').get(c.id))
  }
  res.status(400).json({ code: 400, msg: '无效操作' })
})

// ---------- 退款/投诉（售后） ----------
// 用户申请退款/投诉（已送达/已完成/配送异常可申请；退款默认全额）
app.post('/api/refund/apply', auth, (req, res) => {
  const { order_id, type = 'refund', reason = '' } = req.body || {}
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (![3, 4, 6].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '当前状态不可申请退款/投诉' })
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
app.post('/api/merchant/refund/handle', merchantGuard, (req, res) => {
  const { id, action = '', amount, reply = '' } = req.body || {}
  const r = store.prepare('SELECT * FROM refunds WHERE id=?').get(Number(id))
  if (!r) return res.status(404).json({ code: 404, msg: '售后单不存在' })
  if (Number(r.status) !== 0) return res.status(400).json({ code: 400, msg: '该售后已处理' })
  if (r.type === 'refund') {
    if (action === 'approve') {
      const amt = (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) ? r.amount : Number(amount)
      store.prepare("UPDATE refunds SET status=3, amount=?, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?")
        .run(amt, reply || '同意退款', r.id)
      // 订单标记为已退款
      store.prepare("UPDATE orders SET status=7, updated_at=datetime('now','localtime') WHERE id=?").run(r.order_id)
    } else if (action === 'reject') {
      if (!reply) return res.status(400).json({ code: 400, msg: '请填写拒绝理由' })
      store.prepare("UPDATE refunds SET status=2, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?").run(reply, r.id)
    } else {
      return res.status(400).json({ code: 400, msg: '无效操作' })
    }
  } else {
    // 投诉：商家回复处理
    store.prepare("UPDATE refunds SET status=4, merchant_reply=?, handled_at=datetime('now','localtime') WHERE id=?").run(reply || '已处理', r.id)
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
  ok(res)
})

// ---------- 用户取餐（扫码后：开舱/关舱/40s自动关/重开） ----------
// 扫码取餐：校验订单归属 + 已送达，返回取餐上下文（供取餐页展示与操作）
app.post('/api/delivery/pickup-scan', auth, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (Number(order.status) !== 3) return res.status(400).json({ code: 400, msg: '机器人还未送达，暂不能取餐' })
  const task = order.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id) : null
  ok(res, {
    order_id: order.id,
    order_no: order.order_no,
    pickup_code: order.pickup_code,
    landmark_name: order.landmark_name,
    task: task ? { task_id: task.id, platform_task_id: task.platform_task_id, device_sn: task.device_sn, task_status: task.task_status, status_text: task.status_text } : null
  })
})

// 打开舱门取餐（unloading/verify 开舱即完成，订单置为已完成，并标记「仓内已取走」）
// 测试兜底：无真实机器人任务（deviceSn/平台任务为空）时本地直接完成并标记 test，便于测试取餐页流程
app.post('/api/delivery/pickup-open', auth, async (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (Number(order.status) !== 3) return res.status(400).json({ code: 400, msg: '机器人还未送达，暂不能取餐' })
  const task = order.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id) : null
  const ready = !!(task && task.device_sn && task.platform_task_id)
  if (ready) {
    const r = await platform.unloadingVerify(task.device_sn, task.platform_task_id, { contact: order.contact_phone || '', roomNum: order.pickup_code })
    if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
  }
  // 一车多单：记录本单已取走 → 批次计数 +1，全部取完则批次完成
  batch.markOrderPicked(store, order)
  ok(res, { order_id: order.id, status: 4, test: !ready })
})

// 关闭舱门（unloading/confirm 关舱返回；订单若仍为已送达则置为已完成）
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
  store.prepare("UPDATE orders SET status=4, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
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
app.get('/api/merchant/shop', merchantGuard, (req, res) => {
  const shop = store.prepare('SELECT * FROM shops WHERE id=1').get()
  ok(res, shop || { id: 1, name: '零栋铺子', business_status: 'open', auto_accept: 0 })
})

app.put('/api/merchant/shop', merchantGuard, (req, res) => {
  const { business_status, auto_accept } = req.body || {}
  const cur = store.prepare('SELECT * FROM shops WHERE id=1').get() || { business_status: 'open', auto_accept: 0 }
  const st = business_status === 'closed' ? 'closed' : 'open'
  const aa = auto_accept === undefined ? cur.auto_accept : (auto_accept ? 1 : 0)
  store.prepare("UPDATE shops SET business_status=?, auto_accept=?, updated_at=datetime('now','localtime') WHERE id=1")
    .run(st, aa)
  ok(res, store.prepare('SELECT * FROM shops WHERE id=1').get())
})

// 店铺状态（公开，用户端判断是否可下单 / 展示歇业标签）
app.get('/api/shop/status', (req, res) => {
  const shop = store.prepare('SELECT * FROM shops WHERE id=1').get()
  ok(res, shop || { id: 1, name: '零栋铺子', business_status: 'open', auto_accept: 0 })
})

app.get('/api/merchant/stats', merchantGuard, (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const stats = {
    today_orders: store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=?").get(today).c,
    today_amount: store.prepare("SELECT IFNULL(SUM(total_amount),0) s FROM orders WHERE date(created_at)=? AND status NOT IN (0,5)").get(today).s,
    pending: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=1').get().c,
    delivering: store.prepare('SELECT COUNT(*) c FROM orders WHERE status IN (2,3)').get().c,
    finished: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=4').get().c,
    exception: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=6').get().c,
    aftersale: store.prepare('SELECT COUNT(*) c FROM refunds WHERE status=0').get().c,
    cancel_requests: store.prepare('SELECT COUNT(*) c FROM cancel_requests WHERE status=0').get().c
  }
  ok(res, stats)
})

app.get('/api/merchant/orders', merchantGuard, (req, res) => {
  const { status = '', scope = '' } = req.query
  let sql = 'SELECT * FROM orders'
  const args = []
  // 当前任务：仅执行中的订单（待接单/配送中/等待取餐）；历史订单：已完成/已取消/配送异常/已退款
  if (scope === 'active') sql += ' WHERE status IN (1,2,3)'
  else if (scope === 'history') sql += ' WHERE status IN (4,5,6,7)'
  else if (status !== '' && status !== undefined) { sql += ' WHERE status=?'; args.push(Number(status)) }
  sql += ' ORDER BY id DESC'
  const rows = store.prepare(sql).all(...args).map((o) => ({ ...o, status_text: ORDER_STATUS[o.status] || '' }))
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
      batchInfo = detail ? { id: detail.id, batch_no: detail.batch_no, status: detail.status, status_text: detail.status_text, total_orders: detail.total_orders, picked_orders: detail.picked_orders } : null
    }
  }
  ok(res, { ...order, status_text: ORDER_STATUS[order.status] || '', items, batch: batchInfo })
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
  ok(res, { order_id: order.id, status: 2, batch_id: b.id, batch_no: b.batch_no, msg: '已接单，订单并入配送批次 ' + b.batch_no })
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
async function doDispatchBatch(store, batchId, deviceSn) {
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batchId))
  if (!b) throw new Error('批次不存在')
  if (Number(b.status) !== 0) throw new Error('该批次已派车，不能重复派车')
  const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (1,2)').all(batchId)
  if (!orders.length) throw new Error('批次内没有待配送订单')
  // 1. 规划配送路线（多地点，最小化顾客总等待）
  const route = batch.planRoute(store, orders)
  // 2. 指派机器人（可指定；未指定且真实模式时自动挑空闲机器人）
  let sn = deviceSn || b.device_sn || ''
  if (!sn && process.env.PLATFORM_MOCK !== 'true') {
    const r = await platform.pickAvailableRobot()
    if (r && r.device_sn) sn = r.device_sn
  }
  store.prepare("UPDATE delivery_batches SET device_sn=?, route=?, status=1, status_text='待上货', dispatched_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
    .run(sn, JSON.stringify(route), batchId)
  // 3. 为批次内每单创建平台任务（真实创建排队任务 / 本地 Mock）
  await platform.createTasksForBatch(store, b, orders, route)
  // 4. 兜底置为配送中（已由并入批次时置 2）
  store.prepare("UPDATE orders SET status=2, updated_at=datetime('now','localtime') WHERE batch_id=? AND status=1").run(batchId)
  console.log('[batch] 批次派车 ' + b.batch_no + ' 共' + orders.length + '单 路线' + route.map((s) => s.landmark_name).join('→'))
  return batch.getBatchDetail(store, batchId)
}

app.post('/api/merchant/delivery/batch/dispatch', merchantGuard, async (req, res) => {
  const { batch_id, device_sn } = req.body || {}
  try {
    const detail = await doDispatchBatch(store, batch_id, device_sn || '')
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
  const results = await platform.verifyBatchLoading(store, b.id)
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    return res.status(502).json({ code: 502, msg: '开舱失败：' + failed[0].msg })
  }
  store.prepare("UPDATE delivery_batches SET status=1, status_text='待上货', updated_at=datetime('now','localtime') WHERE id=?").run(b.id)
  ok(res, { batch_id: b.id, opened: results.length })
})

// 批次关舱（原地等待，不派发）
app.post('/api/merchant/device/batch/close-bin', merchantGuard, async (req, res) => {
  const { batch_id } = req.body || {}
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batch_id))
  if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
  if (!b.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
  const r = await platform.drawerCtrl(b.device_sn, 0)
  r.ok ? ok(res) : res.status(502).json({ code: 502, msg: r.msg })
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
  ok(res, { batch_id: b.id, dispatched: results.length })
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

app.post('/api/merchant/goods', merchantGuard, (req, res) => {
  const { name, price, original_price, image, category, stock, description } = req.body || {}
  const info = store.prepare('INSERT INTO goods (name, price, original_price, image, category, stock, description) VALUES (?,?,?,?,?,?,?)')
    .run(name, Number(price), Number(original_price || 0), image || '', category || '其他', Number(stock || 999), description || '')
  ok(res, { id: Number(info.lastInsertRowid) })
})

app.put('/api/merchant/goods', merchantGuard, (req, res) => {
  const { id, name, price, original_price, image, category, stock, description, status } = req.body || {}
  store.prepare('UPDATE goods SET name=?, price=?, original_price=?, image=?, category=?, stock=?, description=?, status=? WHERE id=?')
    .run(name, Number(price), Number(original_price || 0), image || '', category || '其他', Number(stock || 999), description || '', status !== undefined ? Number(status) : 1, Number(id))
  ok(res)
})

app.put('/api/merchant/goods/status', merchantGuard, (req, res) => {
  store.prepare('UPDATE goods SET status=? WHERE id=?').run(Number(req.body.status), Number(req.body.id))
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
  ok(res)
})

// 活动上下线：status 1 发布（用户端可见）/ 0 下线
app.put('/api/merchant/activities/status', merchantGuard, (req, res) => {
  store.prepare('UPDATE activities SET status=? WHERE id=?').run(Number(req.body.status), Number(req.body.id))
  ok(res)
})

app.delete('/api/merchant/activities', merchantGuard, (req, res) => {
  store.prepare('DELETE FROM activities WHERE id=?').run(Number(req.body.id))
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
    SELECT d.*, o.order_no, o.landmark_name, o.status AS order_status
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

// ---------- 开放物流平台回调（真实业务逻辑） ----------
// feedbackDeliveryTaskUrl：平台在任务状态变更时 POST 到这里，同步任务与订单状态
app.post('/api/platform/callback/delivery', (req, res) => {
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
})

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
  const orderNo = req.query.orderNo || req.query.outOrderNo || (req.body && (req.body.orderNo || req.body.outOrderNo))
  if (!orderNo) return res.json({ code: 'FAIL', msg: '缺少订单号' })
  const order = store.prepare('SELECT * FROM orders WHERE order_no=?').get(String(orderNo))
  if (!order) return res.json({ code: 'FAIL', msg: '订单不存在' })
  if (Number(order.status) === 5) {
    // 订单已取消/退款：通知设备端强制关闭任务
    return res.json({
      code: 'COMM_200',
      data: { keyEvent: { eventName: 'forceCloseTask', taskSubStatus: 201, eventDesc: '订单已取消/退款' } },
      msg: 'ok'
    })
  }
  // 订单正常：无强制关闭事件
  res.json({ code: 'COMM_200', data: null, msg: 'ok' })
}
app.get('/api/platform/check-order', handleCheckOrder)
app.post('/api/platform/check-order', handleCheckOrder)

// 设备异常上报回调（T 任务类 / R 机器类 / I IOT 类 / N 导航类）
app.post('/api/platform/callback/exception', (req, res) => {
  const body = req.body || {}
  console.warn('[platform] 设备异常上报', JSON.stringify(body))
  res.json({ code: 'SUCCESS', msg: 'ok' })
})

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
  }
  ok(res, { count: ids.length, status: to })
})

// 待上货批次列表：组单中(可派车) / 待上货(已派车，任务排队中/去上货点/上货中) / 配送中
app.get('/api/merchant/device/pending', merchantGuard, (req, res) => {
  const openBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=0 ORDER BY id DESC LIMIT 5').all()
  const readyBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=1 ORDER BY id DESC LIMIT 10').all()
  const activeBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=2 ORDER BY id DESC LIMIT 10').all()
  const wrap = (list) => list.map((b) => batch.getBatchDetail(store, b.id)).filter(Boolean)
  ok(res, { open_batches: wrap(openBatches), ready_batches: wrap(readyBatches), active_batches: wrap(activeBatches) })
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
    // 真实：优先按设备号匹配待上货批次，否则取最早待上货批次
    batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status=1 AND device_sn=? ORDER BY id DESC LIMIT 1').get(deviceSn)
    if (!batchRow) batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status=1 ORDER BY id DESC LIMIT 1').get()
  }
  if (!batchRow) return res.status(404).json({ code: 404, msg: '该机器人暂无待上货批次，请先在批次列表「派车」' })
  // 记录设备编号到批次与批次内任务
  store.prepare("UPDATE delivery_batches SET device_sn=?, updated_at=datetime('now','localtime') WHERE id=?").run(deviceSn, batchRow.id)
  store.prepare("UPDATE delivery_tasks SET device_sn=? WHERE batch_id=? AND (device_sn='' OR device_sn IS NULL)").run(deviceSn, batchRow.id)
  batchRow.device_sn = deviceSn
  const detail = batch.getBatchDetail(store, batchRow.id)
  const g = await platform.grantControl(deviceSn)
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
    control_msg: g.ok ? '' : g.msg
  })
})

// 打开舱门（上货验证，验证通过自动开舱）
app.post('/api/merchant/device/open-bin', merchantGuard, async (req, res) => {
  const task = getLoadingTask(req.body)
  if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
  if (!task.platform_task_id) return res.status(400).json({ code: 400, msg: '任务未下发到平台' })
  const r = await platform.loadingVerify(task.device_sn, task.platform_task_id, { anyCode: task.pickup_code })
  r.ok ? ok(res) : res.status(502).json({ code: 502, msg: r.msg })
})

// 关闭舱门（关舱等待，不派发；机器人原地等待，滑块/按钮触发 dispatch 才派发）
app.post('/api/merchant/device/close-bin', merchantGuard, async (req, res) => {
  const task = getLoadingTask(req.body)
  if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
  if (!task.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
  const r = await platform.drawerCtrl(task.device_sn, 0)
  r.ok ? ok(res) : res.status(502).json({ code: 502, msg: r.msg })
})

// 开始配送（确认上货）
app.post('/api/merchant/device/dispatch', merchantGuard, async (req, res) => {
  const task = getLoadingTask(req.body)
  if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
  if (!task.platform_task_id) return res.status(400).json({ code: 400, msg: '任务未下发到平台' })
  if (!task.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
  const r = await platform.loadingConfirm(task.device_sn, task.platform_task_id, { anyCode: task.pickup_code })
  r.ok ? ok(res) : res.status(502).json({ code: 502, msg: r.msg })
})

// ---------- 真实模式任务状态轮询兜底 ----------
if (!(process.env.PLATFORM_MOCK === 'true')) {
  const POLL_MS = Number(process.env.PLATFORM_POLL_MS || 8000)
  setInterval(async () => {
    try {
      const rows = store.prepare(`
        SELECT d.id FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
        WHERE d.task_status < 80 AND d.platform_task_id != ''`).all()
      for (const r of rows) {
        await platform.syncTaskStatus(store, r.id)
      }
    } catch (e) { /* 轮询异常静默 */ }
  }, POLL_MS)

  // ---------- 超时未接单检测 ----------
  // 机器人长时间未接单（任务卡在排队/去上货点/上货中）→ 订单标记「配送异常(6)」，由商家处理。
  // 阈值默认 15 分钟，可用环境变量 DELIVERY_TIMEOUT_MS 覆盖；扫描间隔 DELIVERY_SCAN_MS（默认 60s）。
  const DELIVERY_TIMEOUT_MS = Number(process.env.DELIVERY_TIMEOUT_MS || 15 * 60 * 1000)
  const DELIVERY_SCAN_MS = Number(process.env.DELIVERY_SCAN_MS || 60 * 1000)
  const STUCK_TASK_STATES = [0, 10, 20, 30, 40] // 排队中/任务已接收/去上货点/到达上货点/上货中（未真正开始配送）

  function scanStuckDeliveries() {
    try {
      const cutoff = new Date(Date.now() - DELIVERY_TIMEOUT_MS)
      const cs = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0') + '-' + String(cutoff.getDate()).padStart(2, '0') +
        ' ' + String(cutoff.getHours()).padStart(2, '0') + ':' + String(cutoff.getMinutes()).padStart(2, '0') + ':' + String(cutoff.getSeconds()).padStart(2, '0')
      const rows = store.prepare(`
        SELECT d.id, d.order_id, d.task_status FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
        WHERE o.status = 2 AND d.task_status IN (0,10,20,30,40) AND d.updated_at < ?`).all(cs)
      for (const r of rows) {
        store.prepare("UPDATE orders SET status=6, updated_at=datetime('now','localtime') WHERE id=? AND status=2").run(r.order_id)
        store.prepare("UPDATE delivery_tasks SET status_text='机器人长时间未接单（超时' + (?) + '分钟），订单已标记配送异常', updated_at=datetime('now','localtime') WHERE id=?")
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
    const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
    if (shop.business_status !== 'open') return
    const openBatches = store.prepare('SELECT * FROM delivery_batches WHERE status=0 ORDER BY id ASC').all()
    for (const b of openBatches) {
      const n = Number(b.total_orders)
      if (n <= 0) continue
      const full = n >= batch.BATCH_MAX_ORDERS
      let autoGo = false
      if (Number(shop.auto_accept) === 1) {
        const t = new Date(String(b.updated_at || '').replace(' ', 'T')).getTime()
        autoGo = !isNaN(t) && (Date.now() - t) >= batch.BATCH_WAIT_MS
      }
      if (full || autoGo) {
        console.log('[batch] 自动派车 ' + b.batch_no + ' 共' + n + '单' + (full ? '（已达容量上限）' : '（等待期满）'))
        await doDispatchBatch(store, b.id, '')
      }
    }
  } catch (e) { console.warn('[batch] 自动派车扫描异常', e.message) }
}, BATCH_SCAN_MS)

app.listen(PORT, () => {
  console.log(`[lingdong-backend] listening on http://127.0.0.1:${PORT}`)
  if (process.env.PLATFORM_MOCK === 'true') {
    console.log('[lingdong-backend] 配送层：本地 Mock 状态机（PLATFORM_MOCK=true）')
  } else if (platform.platformReady()) {
    console.log('[lingdong-backend] 配送层：开放物流平台真实模式（' + (process.env.PLATFORM_BASE || 'https://test-robox.eventec.cn/service-open-logis') + '）')
  } else {
    console.warn('[lingdong-backend] 配送层：未配置 PLATFORM_APPID/PLATFORM_SECRET，真实配送未启用')
  }
})
