// goods 域路由（薄路由壳）：商品（公开+商家管理）/ 店铺 / 活动 / 图片上传
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// 归属依据（05 方案）：只读写 goods / shops / activities 三张表（upload 是文件系统，归本域随商家商品管理）。

const express = require('express')
const path = require('path')
const fs = require('fs')
const { createShared, toStock } = require('../_shared')
const q = require('./queries')
const service = require('./service')

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads')

// 安全审计 2026-09-26 H1/L4/L5：图片地址白名单 + 价格/文本长度校验。
// image 只允许后端自有相对路径（/uploads、/store-img）或 http(s) 外链，杜绝
// 「x" onerror=…」这类属性注入字符串入库（管理页 <img src> 渲染曾被引号逃逸）。
// 返回 ''（空）、字符串（合法）或 null（非法，调用方 400）。
function safeImageUrl(v) {
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return ''
  if (s.indexOf('/uploads/') === 0 || s.indexOf('/store-img/') === 0) return s.slice(0, 300)
  if (/^https?:\/\/[^\s"'<>\\]{1,500}$/.test(s)) return s
  return null
}
function cleanText(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max)
}
function checkPrice(p) {
  const n = Number(p)
  return Number.isFinite(n) && n >= 0 && n <= 9999 ? n : null
}

module.exports = (store, deps) => {
  const { merchantGuard, ownerGuard, audit, ok } = createShared(store)
  const runtime = deps.runtime
  const router = express.Router()

  // ---------- 商品（公开） ----------
  router.get('/goods/categories', (req, res) => ok(res, q.categories(store)))

  // 商品列表附折后价/命中折扣（sale_price/discount_info，展示用；真实金额以 order/create 权威计算）
  router.get('/goods/list', (req, res) => ok(res, service.withPromoPrices(store, q.list(store, req.query))))

  router.get('/goods/detail', (req, res) => {
    const row = q.findById(store, req.query.id || 0)
    if (!row) return res.status(404).json({ code: 404, msg: '商品不存在' })
    ok(res, service.withPromoPrices(store, row)[0])
  })

  // ---------- 活动（公开） ----------
  // 类型化活动列表：附 type/config(已解析)/起止时间/state（active|pending|ended）
  router.get('/activity/list', (req, res) => ok(res, service.listActivitiesTyped(store)))

  // ---------- 店铺状态 ----------
  router.get('/merchant/shop', merchantGuard, (req, res) => ok(res, service.shopWithRuntime(q.getShop(store), runtime)))

  // 店铺设置（营业状态/自动接单/配送费）：店主专属（店员不开放，避免误操作歇业/改价）
  router.put('/merchant/shop', ownerGuard, (req, res) => {
    const { business_status, auto_accept, delivery_fee } = req.body || {}
    const cur = q.getShop(store)
    // 未传的字段保留原值（此前 business_status 缺省会被强制成 open，导致单改配送费会把歇业店改回营业）
    const st = business_status === undefined ? (cur.business_status || 'open') : (business_status === 'closed' ? 'closed' : 'open')
    const aa = auto_accept === undefined ? cur.auto_accept : (auto_accept ? 1 : 0)
    // 配送费：只接受 0~999 的数值（保留 2 位小数）；非法输入忽略并保留原值，空串按 0 处理
    let df = cur.delivery_fee === undefined || cur.delivery_fee === null ? 1 : Number(cur.delivery_fee)
    if (delivery_fee !== undefined) {
      const n = Number(delivery_fee)
      if (!isNaN(n) && n >= 0 && n <= 999) df = Math.round(n * 100) / 100
    }
    q.updateShop(store, st, aa, df)
    audit(req, 'shop/update', 'shop#1', 'business_status=' + st + ' auto_accept=' + aa + ' delivery_fee=' + df)
    ok(res, q.getShop(store))
  })

  // 店铺状态（公开，用户端判断是否可下单 / 展示歇业标签）
  router.get('/shop/status', (req, res) => ok(res, service.shopWithRuntime(q.getShop(store), runtime)))

  // ---------- 商家商品图片上传（base64，避免引入 multipart 依赖） ----------
  router.post('/merchant/upload', merchantGuard, (req, res) => {
    const { name = 'img.jpg', data = '' } = req.body || {}
    if (!data) return res.status(400).json({ code: 400, msg: '文件为空' })
    const ext = (String(name).match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return res.status(400).json({ code: 400, msg: '不支持的图片格式' })
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const fname = Date.now() + '_' + Math.random().toString(36).slice(2, 6) + ext
    const buf = Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ''), 'base64')
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf)
    ok(res, { url: '/uploads/' + fname })
  })

  // ---------- 商家商品管理 ----------
  router.get('/merchant/goods', merchantGuard, (req, res) => ok(res, q.merchantList(store)))

  // 商品分类列表（供新增/编辑商品时选择或新增）
  router.get('/merchant/goods/categories', merchantGuard, (req, res) => ok(res, q.merchantCategories(store)))

  // 单独调整库存（标记售空=置0 / 恢复库存），不触碰其它字段
  router.put('/merchant/goods/stock', merchantGuard, (req, res) => {
    const { id, stock } = req.body || {}
    if (!id) return res.status(400).json({ code: 400, msg: '缺少商品 id' })
    if (stock === undefined || stock === null || stock === '') return res.status(400).json({ code: 400, msg: '缺少库存值' })
    try {
      const g = q.findById(store, id)
      if (!g) return res.status(404).json({ code: 404, msg: '商品不存在' })
      const newStock = toStock(stock, 0)
      q.updateStock(store, id, newStock)
      audit(req, 'goods/stock', 'goods#' + id, 'stock ' + g.stock + '→' + newStock)
      ok(res, q.findById(store, id))
    } catch (e) {
      console.error('[goods/stock] ERROR', e && e.stack)
      res.status(500).json({ code: 500, msg: e.message })
    }
  })

  // 新建商品：店主专属（含定价）
  router.post('/merchant/goods', ownerGuard, (req, res) => {
    const { name, price, original_price, image, category, stock, description, barcode, unit } = req.body || {}
    const n = String(name || '').trim()
    if (!n) return res.status(400).json({ code: 400, msg: '商品名称不能为空' })
    if (n.length > 100) return res.status(400).json({ code: 400, msg: '商品名称过长' })
    const p = checkPrice(price)
    if (p === null) return res.status(400).json({ code: 400, msg: '价格不合法（0~9999）' })
    const img = safeImageUrl(image)
    if (img === null) return res.status(400).json({ code: 400, msg: '图片地址不合法' })
    // 库存缺省 99：与商家端表单提示「不填默认 99」保持一致
    const st = toStock(stock, 99)
    const id = q.insert(store, {
      name: n, price: p,
      original_price: Math.max(0, Number(original_price) || 0),
      image: img,
      category: cleanText(category || '', 50),
      stock: st,
      description: cleanText(description || '', 500),
      barcode, unit
    })
    audit(req, 'goods/create', 'goods#' + id, 'name=' + n + ' price=' + p + ' stock=' + st)
    ok(res, { id })
  })

  // 编辑商品（含改价）：店主专属；店员补货只走 stock/status 接口
  router.put('/merchant/goods', ownerGuard, (req, res) => {
    const { id, name, price, original_price, image, category, stock, description, status, barcode, unit } = req.body || {}
    if (!id) return res.status(400).json({ code: 400, msg: '缺少商品 id' })
    const cur = q.findById(store, id)
    if (!cur) return res.status(404).json({ code: 404, msg: '商品不存在' })
    // 未传字段保留原值；传了则按新值校验
    const n = name === undefined ? cur.name : String(name || '').trim()
    if (!n) return res.status(400).json({ code: 400, msg: '商品名称不能为空' })
    if (n.length > 100) return res.status(400).json({ code: 400, msg: '商品名称过长' })
    const p = price === undefined ? Number(cur.price) : checkPrice(price)
    if (p === null) return res.status(400).json({ code: 400, msg: '价格不合法（0~9999）' })
    let img = cur.image || ''
    if (image !== undefined) {
      img = safeImageUrl(image)
      if (img === null) return res.status(400).json({ code: 400, msg: '图片地址不合法' })
    }
    // 编辑商品时未传 stock 字段 → 保留原库存；传了（含 0）→ 用传入值（修复「设 0 被重置」）
    const st = stock === undefined || stock === null || stock === '' ? cur.stock : toStock(stock, 99)
    q.update(store, id, {
      name: n, price: p,
      original_price: original_price === undefined ? Number(cur.original_price || 0) : Math.max(0, Number(original_price) || 0),
      image: img,
      category: category === undefined ? cur.category : cleanText(category || '', 50),
      stock: st,
      description: description === undefined ? cur.description : cleanText(description || '', 500),
      status: status !== undefined ? Number(status) : 1,
      barcode: barcode !== undefined ? barcode : (cur.barcode || ''),
      unit: unit !== undefined ? unit : (cur.unit || '')
    })
    audit(req, 'goods/update', 'goods#' + id, 'name=' + n + ' price=' + p + ' stock=' + st + ' status=' + (status !== undefined ? status : 1))
    ok(res)
  })

  router.put('/merchant/goods/status', merchantGuard, (req, res) => {
    q.updateStatus(store, req.body.id, req.body.status)
    audit(req, 'goods/status', 'goods#' + req.body.id, 'status=' + Number(req.body.status))
    ok(res)
  })

  // ---------- 商家端活动管理（发布/编辑/上下线/删除）——店主专属 ----------
  router.get('/merchant/activities', ownerGuard, (req, res) => ok(res, q.merchantActivities(store)))

  router.post('/merchant/activities', ownerGuard, (req, res) => {
    const { title, subtitle = '', image = '', link = '', sort = 0, type = 'custom', config, start_at = '', end_at = '' } = req.body || {}
    const t = String(title || '').trim()
    if (!t) return res.status(400).json({ code: 400, msg: '活动标题不能为空' })
    if (t.length > 60) return res.status(400).json({ code: 400, msg: '活动标题过长' })
    const img = safeImageUrl(image)
    if (img === null) return res.status(400).json({ code: 400, msg: '活动图片地址不合法' })
    const cfgJson = typeof config === 'string' ? config : JSON.stringify(config || {})
    const id = q.insertActivity(store, {
      title: t,
      subtitle: cleanText(subtitle, 120),
      image: img,
      link: cleanText(link, 300),
      sort, type, config: cfgJson, start_at, end_at
    })
    audit(req, 'activity/create', 'activity#' + id, 'title=' + t + ' type=' + type)
    ok(res, { id })
  })

  router.put('/merchant/activities', ownerGuard, (req, res) => {
    const { id, title, subtitle, image, link, sort, type, config, start_at, end_at } = req.body || {}
    if (!id) return res.status(400).json({ code: 400, msg: '缺少活动ID' })
    const cur = q.findActivityById(store, id)
    if (!cur) return res.status(404).json({ code: 404, msg: '活动不存在' })
    const t = title === undefined ? cur.title : String(title || '').trim()
    if (!t) return res.status(400).json({ code: 400, msg: '活动标题不能为空' })
    if (t.length > 60) return res.status(400).json({ code: 400, msg: '活动标题过长' })
    let img = cur.image || ''
    if (image !== undefined) {
      img = safeImageUrl(image)
      if (img === null) return res.status(400).json({ code: 400, msg: '活动图片地址不合法' })
    }
    q.updateActivity(store, id, {
      title: t,
      subtitle: subtitle === undefined ? cur.subtitle : cleanText(subtitle, 120),
      image: img,
      link: link === undefined ? cur.link : cleanText(link, 300),
      sort, type, config, start_at, end_at, cur
    })
    audit(req, 'activity/update', 'activity#' + id, 'title=' + t + ' type=' + (type !== undefined ? type : cur.type))
    ok(res)
  })

  // 活动上下线：status 1 发布（用户端可见）/ 0 下线
  router.put('/merchant/activities/status', ownerGuard, (req, res) => {
    q.updateActivityStatus(store, req.body.id, req.body.status)
    audit(req, 'activity/status', 'activity#' + req.body.id, 'status=' + Number(req.body.status))
    ok(res)
  })

  router.delete('/merchant/activities', ownerGuard, (req, res) => {
    q.deleteActivity(store, req.body.id)
    audit(req, 'activity/delete', 'activity#' + req.body.id, '')
    ok(res)
  })

  return router
}
