// goods 域路由（薄路由壳）：商品（公开+商家管理）/ 店铺 / 活动 / 图片上传
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// 归属依据（05 方案）：只读写 goods / shops / activities 三张表（upload 是文件系统，归本域随商家商品管理）。

const express = require('express')
const path = require('path')
const fs = require('fs')
const { createShared, toStock } = require('../_shared')
const q = require('./queries')
const service = require('./service')
// 外部条码库查询适配器（可替换）：扫到本地没有的条码时用它去外部查商品信息。
// 现在还没拿到商铺接口，它是占位实现；接口到位后只改那一个文件。
const goodsLookup = require('../../services/goodsLookup')

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

// 批量录入单次上限：够一次录完一天的进货量，又不至于让一个请求长时间占住数据库。
const BATCH_MAX = 200

// 新增商品的字段归一化 + 校验。单个新增（POST /merchant/goods）与批量录入
// （POST /merchant/goods/batch）共用这一套规则 —— 两处各写一份，迟早改一处漏一处，
// 而校验口径不一致会直接变成「单条能加、批量加不进去」这类很难查的问题。
// 返回 { ok: true, value } 或 { ok: false, reason }；reason 原样回给前端展示给商家。
function normalizeNewGoods(body) {
  const b = body || {}
  const name = String(b.name === undefined || b.name === null ? '' : b.name).trim()
  if (!name) return { ok: false, reason: '商品名称不能为空' }
  if (name.length > 100) return { ok: false, reason: '商品名称过长' }
  const price = checkPrice(b.price)
  if (price === null) return { ok: false, reason: '价格不合法（0~9999）' }
  const image = safeImageUrl(b.image)
  if (image === null) return { ok: false, reason: '图片地址不合法' }
  return {
    ok: true,
    value: {
      name,
      price,
      original_price: Math.max(0, Number(b.original_price) || 0),
      image,
      category: cleanText(b.category || '', 50) || '其他',
      stock: toStock(b.stock, 99),        // 与商家端表单提示「不填默认 99」一致
      description: cleanText(b.description || '', 500),
      barcode: cleanText(b.barcode || '', 64),
      unit: cleanText(b.unit || '', 10)
    }
  }
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

  // 新建商品：店主专属（含定价）。字段校验复用 normalizeNewGoods，与批量录入同一套规则。
  router.post('/merchant/goods', ownerGuard, (req, res) => {
    const nv = normalizeNewGoods(req.body)
    if (!nv.ok) return res.status(400).json({ code: 400, msg: nv.reason })
    const v = nv.value
    // 条码唯一：先查再插，好告诉商家「和哪个商品撞了」。不先查的话会撞唯一索引抛 500，
    // 商家只看到一句「服务器错误」，完全不知道怎么办。
    if (v.barcode) {
      const dup = q.findByBarcode(store, v.barcode)
      if (dup) return res.status(400).json({ code: 400, msg: '条码已存在（商品：' + dup.name + '）' })
    }
    const id = q.insert(store, v)
    audit(req, 'goods/create', 'goods#' + id, 'name=' + v.name + ' price=' + v.price + ' stock=' + v.stock)
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
    // 条码唯一：改条码时才需要查（自己不算撞）。不查的话唯一索引会抛 500，
    // 商家只看到「服务器错误」，不知道是条码重复。
    const bcNew = String(barcode !== undefined ? barcode : (cur.barcode || '')).trim()
    if (bcNew && bcNew !== String(cur.barcode || '').trim()) {
      const dup = q.findByBarcode(store, bcNew)
      if (dup && Number(dup.id) !== Number(id)) {
        return res.status(400).json({ code: 400, msg: '条码已存在（商品：' + dup.name + '）' })
      }
    }
    q.update(store, id, {
      name: n, price: p,
      original_price: original_price === undefined ? Number(cur.original_price || 0) : Math.max(0, Number(original_price) || 0),
      image: img,
      category: category === undefined ? cur.category : cleanText(category || '', 50),
      stock: st,
      description: description === undefined ? cur.description : cleanText(description || '', 500),
      status: status !== undefined ? Number(status) : 1,
      barcode: bcNew,
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

  // ---------- 批量录入：Excel 粘贴 / 连续扫码 ----------
  // 语义：逐条独立处理，一条不合法不影响其余（部分成功）；每条的结果都回给前端，
  // 前端只把失败那几行标红让商家改，不必整批重来。
  // if_exists：条码在库里已存在时怎么办 —— 'skip'（默认，跳过并说明是哪个商品）
  // 还是 'update'（按新值覆盖名称/售价/库存等，图片和描述保留原值）。
  router.post('/merchant/goods/batch', ownerGuard, (req, res) => {
    const body = req.body || {}
    const items = Array.isArray(body.items) ? body.items : null
    if (!items) return res.status(400).json({ code: 400, msg: '缺少 items 数组' })
    if (!items.length) return res.status(400).json({ code: 400, msg: '没有要录入的商品' })
    if (items.length > BATCH_MAX) return res.status(400).json({ code: 400, msg: '一次最多录入 ' + BATCH_MAX + ' 个商品' })
    const ifExists = body.if_exists === 'update' ? 'update' : 'skip'

    const results = []
    const writes = []                 // 已过校验、待落库的条目
    const seenBarcode = new Map()     // 条码 → 行号，用于批内查重
    let skipped = 0, failed = 0

    items.forEach((raw, i) => {
      const line = i + 1
      const nv = normalizeNewGoods(raw)
      if (!nv.ok) {
        failed++
        results.push({ index: i, line, name: String((raw && raw.name) || '').trim(), barcode: String((raw && raw.barcode) || '').trim(), result: 'failed', reason: nv.reason })
        return
      }
      const v = nv.value
      if (v.barcode) {
        // 批内查重：同一批里条码写重了只认第一条，后面的判失败并指出和哪一行撞了 ——
        // 否则前一条会入库、后一条撞唯一索引，错误信息还看不出是哪两行。
        const at = seenBarcode.get(v.barcode)
        if (at) {
          failed++
          results.push({ index: i, line, name: v.name, barcode: v.barcode, result: 'failed', reason: '条码与第 ' + at + ' 行重复' })
          return
        }
        seenBarcode.set(v.barcode, line)
        const cur = q.findByBarcode(store, v.barcode)
        if (cur) {
          if (ifExists === 'skip') {
            skipped++
            results.push({ index: i, line, name: v.name, barcode: v.barcode, result: 'skipped', id: cur.id, reason: '条码已存在，已跳过（现有商品：' + cur.name + '）' })
            return
          }
          writes.push({ kind: 'update', id: cur.id, v, i, line })
          return
        }
      }
      writes.push({ kind: 'insert', v, i, line })
    })

    // 落库放在一个事务里：中途异常就整批回滚，绝不留半截数据。
    // 注意「某条不合法」在上面已经判完、不会走到这里抛异常，所以不影响"部分成功"的语义。
    let created = 0, updated = 0
    if (writes.length) {
      store.exec('BEGIN')
      try {
        for (const w of writes) {
          if (w.kind === 'insert') {
            const id = q.insert(store, w.v)
            created++
            results.push({ index: w.i, line: w.line, name: w.v.name, barcode: w.v.barcode, result: 'created', id })
          } else {
            const cur = q.findById(store, w.id)
            // q.update 是全字段覆盖：这里没提供的图片/描述/原价/状态沿用原值，
            // 免得「只想改个价」把商家上传的图和描述一起清空。
            q.update(store, w.id, {
              name: w.v.name, price: w.v.price,
              original_price: cur.original_price, image: cur.image || '',
              category: w.v.category, stock: w.v.stock,
              description: cur.description, status: cur.status,
              barcode: w.v.barcode, unit: w.v.unit
            })
            updated++
            results.push({ index: w.i, line: w.line, name: w.v.name, barcode: w.v.barcode, result: 'updated', id: w.id })
          }
        }
        store.exec('COMMIT')
      } catch (e) {
        store.exec('ROLLBACK')
        console.error('[goods/batch] ERROR', e && e.stack)
        return res.status(500).json({ code: 500, msg: '批量写入失败，已全部回滚：' + e.message })
      }
    }

    results.sort((a, b) => a.line - b.line)
    audit(req, 'goods/batch', 'goods+' + created + '/' + updated, '新增=' + created + ' 更新=' + updated + ' 跳过=' + skipped + ' 失败=' + failed + ' if_exists=' + ifExists)
    ok(res, { total: items.length, created, updated, skipped, failed, if_exists: ifExists, results })
  })

  // 按条码查商品（扫码录入用）。
  // 「没查到」是扫码的正常结果、不是错误，所以照样返回 code 0，用 found 区分真假，
  // 免得前端把 404 当异常抛出来弹一堆红字。
  router.get('/merchant/goods/by-barcode', merchantGuard, async (req, res) => {
    const code = String(req.query.code || '').trim()
    if (!code) return res.status(400).json({ code: 400, msg: '缺少条码' })
    const hit = q.findByBarcode(store, code)
    if (hit) {
      return ok(res, {
        found: true, source: 'local',
        goods: {
          id: hit.id, name: hit.name, price: hit.price, category: hit.category,
          unit: hit.unit, stock: hit.stock, status: hit.status, barcode: hit.barcode, image: hit.image
        }
      })
    }
    // 本地没有 → 交给「外部条码库」适配器。现阶段还没接入，它会返回未找到，
    // 前端就退化成「条码已带上、请手动填写名称和价格」。接口到位后只改 goodsLookup 那一个文件。
    const ext = await goodsLookup.lookupByBarcode(code)
    if (ext && ext.ok && ext.goods) {
      return ok(res, { found: true, source: ext.source || 'external', goods: ext.goods })
    }
    ok(res, { found: false, source: 'none', goods: null, msg: (ext && ext.msg) || '本地与外部条码库都没有这个条码' })
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
