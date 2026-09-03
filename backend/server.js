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
  0: '待支付', 1: '待接单', 2: '配送中', 3: '已送达', 4: '已完成', 5: '已取消', 6: '配送异常'
}

app.post('/api/order/create', auth, (req, res) => {
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

app.get('/api/order/detail', auth, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.query.id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const items = store.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  ok(res, { ...order, status_text: ORDER_STATUS[order.status] || '', items, task })
})

app.post('/api/order/cancel', auth, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.body.id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (![0, 1].includes(order.status)) return res.status(400).json({ code: 400, msg: '配送中的订单无法取消' })
  store.prepare("UPDATE orders SET status=5, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
  ok(res)
})

// ---------- 配送追踪 ----------
app.get('/api/delivery/track', auth, async (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.query.order_id), req.user.id)
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const task = order.delivery_task_id
    ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
    : null
  const pos = task ? await platform.getDevicePosition(store, task.id) : null
  ok(res, {
    order_status: order.status,
    order_status_text: ORDER_STATUS[order.status] || '',
    pickup_code: order.pickup_code,
    landmark_name: order.landmark_name,
    task: task ? { task_status: task.task_status, status_text: task.status_text } : null,
    position: pos
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

app.get('/api/merchant/stats', merchantGuard, (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const stats = {
    today_orders: store.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=?").get(today).c,
    today_amount: store.prepare("SELECT IFNULL(SUM(total_amount),0) s FROM orders WHERE date(created_at)=? AND status NOT IN (0,5)").get(today).s,
    pending: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=1').get().c,
    delivering: store.prepare('SELECT COUNT(*) c FROM orders WHERE status IN (2,3)').get().c,
    finished: store.prepare('SELECT COUNT(*) c FROM orders WHERE status=4').get().c
  }
  ok(res, stats)
})

app.get('/api/merchant/orders', merchantGuard, (req, res) => {
  const { status = '' } = req.query
  let sql = 'SELECT * FROM orders'
  const args = []
  if (status !== '' && status !== undefined) { sql += ' WHERE status=?'; args.push(Number(status)) }
  sql += ' ORDER BY id DESC'
  const rows = store.prepare(sql).all(...args).map((o) => ({ ...o, status_text: ORDER_STATUS[o.status] || '' }))
  ok(res, rows)
})

app.get('/api/merchant/order/detail', merchantGuard, (req, res) => {
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.query.id))
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  const items = store.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)
  ok(res, { ...order, status_text: ORDER_STATUS[order.status] || '', items })
})

// 商家接单（真实业务：店铺歇业时后端拒绝接单）
app.post('/api/merchant/order/confirm', merchantGuard, (req, res) => {
  const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
  if (shop.business_status === 'closed') {
    return res.status(400).json({ code: 400, msg: '店铺歇业中，无法接单' })
  }
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.body.id))
  if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
  if (order.status !== 1) return res.status(400).json({ code: 400, msg: '订单状态不允许接单' })
  platform.createQueueTask(store, order)
  ok(res, { order_id: order.id, status: 2 })
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

// 扫码识别机器人：按 deviceSn 定位待上货订单 + 获取控制权
app.post('/api/merchant/device/scan', merchantGuard, async (req, res) => {
  const { deviceSn = '' } = req.body || {}
  if (!deviceSn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
  const row = process.env.PLATFORM_MOCK === 'true'
    ? store.prepare(`SELECT d.*, o.order_no, o.pickup_code, o.landmark_name, o.contact_name, o.contact_phone
        FROM delivery_tasks d JOIN orders o ON o.id=d.order_id
        WHERE d.task_status < 50 ORDER BY d.id DESC LIMIT 1`).get()
    : store.prepare(`SELECT d.*, o.order_no, o.pickup_code, o.landmark_name, o.contact_name, o.contact_phone
        FROM delivery_tasks d JOIN orders o ON o.id=d.order_id
        WHERE d.device_sn=? AND d.task_status < 50 ORDER BY d.id DESC LIMIT 1`).get(deviceSn)
  if (!row) return res.status(404).json({ code: 404, msg: '该机器人暂无待上货订单' })
  // 记录机器人编号（后续 open/close/dispatch 使用）
  if (!row.device_sn) {
    store.prepare('UPDATE delivery_tasks SET device_sn=? WHERE id=?').run(deviceSn, row.id)
    row.device_sn = deviceSn
  }
  const g = await platform.grantControl(deviceSn)
  ok(res, {
    task_id: row.id,
    platform_task_id: row.platform_task_id,
    device_sn: row.device_sn,
    order_no: row.order_no,
    pickup_code: row.pickup_code,
    delivery_landmark: row.landmark_name,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    task_status: row.task_status,
    status_text: row.status_text,
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
}

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
