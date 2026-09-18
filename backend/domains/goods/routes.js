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

module.exports = (store, deps) => {
  const { merchantGuard, audit, ok } = createShared(store)
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

  router.put('/merchant/shop', merchantGuard, (req, res) => {
    const { business_status, auto_accept } = req.body || {}
    const cur = q.getShop(store)
    const st = business_status === 'closed' ? 'closed' : 'open'
    const aa = auto_accept === undefined ? cur.auto_accept : (auto_accept ? 1 : 0)
    q.updateShop(store, st, aa)
    audit(req, 'shop/update', 'shop#1', 'business_status=' + st + ' auto_accept=' + aa)
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

  router.post('/merchant/goods', merchantGuard, (req, res) => {
    const { name, price, original_price, image, category, stock, description, barcode, unit } = req.body || {}
    if (!name) return res.status(400).json({ code: 400, msg: '商品名称不能为空' })
    const st = toStock(stock, 999)
    const id = q.insert(store, { name, price, original_price, image, category, stock: st, description, barcode, unit })
    audit(req, 'goods/create', 'goods#' + id, 'name=' + name + ' price=' + price + ' stock=' + st)
    ok(res, { id })
  })

  router.put('/merchant/goods', merchantGuard, (req, res) => {
    const { id, name, price, original_price, image, category, stock, description, status, barcode, unit } = req.body || {}
    if (!id) return res.status(400).json({ code: 400, msg: '缺少商品 id' })
    const cur = q.findById(store, id)
    if (!cur) return res.status(404).json({ code: 404, msg: '商品不存在' })
    // 编辑商品时未传 stock 字段 → 保留原库存；传了（含 0）→ 用传入值（修复「设 0 变 999」）
    const st = stock === undefined || stock === null || stock === '' ? cur.stock : toStock(stock, 999)
    q.update(store, id, {
      name, price, original_price, image, category, stock: st, description,
      status: status !== undefined ? Number(status) : 1,
      barcode: barcode !== undefined ? barcode : (cur.barcode || ''),
      unit: unit !== undefined ? unit : (cur.unit || '')
    })
    audit(req, 'goods/update', 'goods#' + id, 'name=' + name + ' price=' + price + ' stock=' + st + ' status=' + (status !== undefined ? status : 1))
    ok(res)
  })

  router.put('/merchant/goods/status', merchantGuard, (req, res) => {
    q.updateStatus(store, req.body.id, req.body.status)
    audit(req, 'goods/status', 'goods#' + req.body.id, 'status=' + Number(req.body.status))
    ok(res)
  })

  // ---------- 商家端活动管理（发布/编辑/上下线/删除） ----------
  router.get('/merchant/activities', merchantGuard, (req, res) => ok(res, q.merchantActivities(store)))

  router.post('/merchant/activities', merchantGuard, (req, res) => {
    const { title, subtitle = '', image = '', link = '', sort = 0, type = 'custom', config, start_at = '', end_at = '' } = req.body || {}
    if (!title) return res.status(400).json({ code: 400, msg: '活动标题不能为空' })
    const cfgJson = typeof config === 'string' ? config : JSON.stringify(config || {})
    const id = q.insertActivity(store, { title, subtitle, image, link, sort, type, config: cfgJson, start_at, end_at })
    audit(req, 'activity/create', 'activity#' + id, 'title=' + title + ' type=' + type)
    ok(res, { id })
  })

  router.put('/merchant/activities', merchantGuard, (req, res) => {
    const { id, title, subtitle, image, link, sort, type, config, start_at, end_at } = req.body || {}
    if (!id) return res.status(400).json({ code: 400, msg: '缺少活动ID' })
    const cur = q.findActivityById(store, id)
    if (!cur) return res.status(404).json({ code: 404, msg: '活动不存在' })
    q.updateActivity(store, id, { title, subtitle, image, link, sort, type, config, start_at, end_at, cur })
    audit(req, 'activity/update', 'activity#' + id, 'title=' + (title !== undefined ? title : cur.title) + ' type=' + (type !== undefined ? type : cur.type))
    ok(res)
  })

  // 活动上下线：status 1 发布（用户端可见）/ 0 下线
  router.put('/merchant/activities/status', merchantGuard, (req, res) => {
    q.updateActivityStatus(store, req.body.id, req.body.status)
    audit(req, 'activity/status', 'activity#' + req.body.id, 'status=' + Number(req.body.status))
    ok(res)
  })

  router.delete('/merchant/activities', merchantGuard, (req, res) => {
    q.deleteActivity(store, req.body.id)
    audit(req, 'activity/delete', 'activity#' + req.body.id, '')
    ok(res)
  })

  return router
}
