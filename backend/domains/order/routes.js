// order 域路由（薄路由壳）：下单/支付/回调/列表/详情/取消/取消申请/退款/售后/商家订单
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// 归属依据（05 方案）：主数据为 orders/order_items/refunds/cancel_requests/pay_notifications 的路由全部归本域，
// 即使它被商家端/管理员页面使用（端只是入口，数据项才是边界）。
// deps = { runtime, wxpay, batch, platform, orderCancel, goods, user }

const express = require('express')
const { createShared } = require('../_shared')
const q = require('./queries')
const s = require('./service')

module.exports = (store, deps) => {
  const { auth, merchantGuard, audit, ok, maskPhone } = createShared(store)
  const router = express.Router()

  // ---------- 下单 ----------
  router.post('/order/create', auth, (req, res) => {
    try {
      const r = s.createOrder(store, deps, req.body, req.user.id)
      if (r.error) return res.status(r.error.status).json({ code: r.error.status, msg: r.error.msg })
      ok(res, r.data)
    } catch (e) {
      // 业务错误统一 400 JSON（P2-7）：不再让裸 throw 变成 HTML 500
      res.status(400).json({ code: 400, msg: e.message || '下单失败' })
    }
  })

  // ---------- 支付 ----------
  router.post('/order/pay', auth, async (req, res) => {
    const row = store.prepare('SELECT o.*, u.openid FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id=? AND o.user_id=?')
      .get(Number(req.body.id), req.user.id)
    if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const r = await s.payOrder(store, deps, row, { openid: row.openid })
    if (r.error) return res.status(r.error.status).json({ code: r.error.status, msg: r.error.msg })
    ok(res, r.data)
  })

  // 微信支付结果回调（由微信服务器调用；订单状态以回调为准）
  router.post('/pay/notify', async (req, res) => {
    try {
      // P0-6 支付回调校验：平台证书验签 → 商户号/appid → 事件幂等 → 金额比对 → CAS 置已支付。
      if (!deps.wxpay.enabled()) return res.status(501).json({ code: 501, msg: '支付回调未启用：请先配置微信支付四要素' })
      const body = req.body || {}
      if (!body.resource) return res.status(400).json({ code: 'FAIL', message: '缺少回调资源' })
      const raw = req.rawBody ? req.rawBody.toString('utf8') : ''
      const v = await deps.wxpay.verifyNotifySignature(req.headers, raw)
      if (!v.ok) return res.status(401).json({ code: 'FAIL', message: '回调验签失败：' + v.msg })
      const info = deps.wxpay.decryptNotify(body.resource)
      if (info.mchid && info.mchid !== process.env.WXPAY_MCHID) return res.status(401).json({ code: 'FAIL', message: '商户号不匹配' })
      if (info.appid && info.appid !== (process.env.WX_APPID || '')) return res.status(401).json({ code: 'FAIL', message: 'appid 不匹配' })
      if (info.trade_state !== 'SUCCESS') { res.json({ code: 'SUCCESS', message: '成功' }); return }
      // 幂等：同一支付事件只处理一次
      if (q.payNotifyExists(store, body.id)) { res.json({ code: 'SUCCESS', message: '成功' }); return }
      const order = store.prepare('SELECT * FROM orders WHERE order_no=?').get(info.out_trade_no)
      if (!order) { res.json({ code: 'SUCCESS', message: '成功' }); return }
      // 金额比对（分为单位，防止篡改回调金额）
      if (info.amount && Math.round(Number(order.total_amount) * 100) !== Number(info.amount.total)) {
        return res.status(400).json({ code: 'FAIL', message: '支付金额与订单不一致' })
      }
      // CAS 置已支付：仅待支付(0)可迁移，并记录交易号
      const up = q.markPaidNotify(store, order.id, info.transaction_id)
      q.payNotifyInsert(store, { eventId: body.id, outTradeNo: info.out_trade_no, tradeState: info.trade_state, amountTotal: info.amount ? info.amount.total : 0 })
      if (up.changes === 1) {
        const o2 = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
        if (o2) s.maybeAutoAccept(store, deps, o2)
      }
      res.json({ code: 'SUCCESS', message: '成功' })
    } catch (e) {
      res.status(500).json({ code: 'FAIL', message: '回调处理失败' })
    }
  })

  // ---------- 订单列表 / 红点 / 详情 ----------
  router.get('/order/list', auth, (req, res) => {
    const { status = '' } = req.query
    const rows = q.listByUser(store, req.user.id, status).map((o) => ({ ...o, status_text: s.ORDER_STATUS[o.status] || '' }))
    ok(res, rows)
  })

  // 我的页订单红点（只要有进行中的任务就常驻显示，点开不消失）
  router.get('/user/order/badge', auth, (req, res) => {
    const b = q.badgeCounts(store, req.user.id)
    ok(res, {
      unread: b.active > 0, count: b.active, has_active: b.active > 0,
      paying: b.paying, delivering: b.delivering, arrived: b.arrived, finished: b.finished
    })
  })

  // 已读订单动态（保留兼容；红点已改为常驻进行中计数，本接口不再清除红点）
  router.post('/user/order/mark-read', auth, (req, res) => {
    ok(res)
  })

  router.get('/order/detail', auth, (req, res) => {
    const order = q.findByIdForUser(store, req.query.id, req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const items = q.itemsByOrder(store, order.id)
    // 跨域只读：delivery_tasks/delivery_batches（delivery 域未拆前直接读，步骤 3 可改走 delivery.service）
    const task = order.delivery_task_id
      ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(order.delivery_task_id)
      : null
    const cancelReq = q.latestCancelRequestByOrder(store, order.id)
    const created = new Date(String(order.created_at || '').replace(' ', 'T')).getTime()
    const freeLeft = isNaN(created) ? 0 : Math.max(0, s.FREE_CANCEL_WINDOW_MS - (Date.now() - created))
    const st = Number(order.status)
    const trulyDelivering = s.orderTrulyDelivering(store, order)
    // 一车多单批次信息
    let batchInfo = null
    if (order.batch_id) {
      const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(order.batch_id)
      if (b) {
        const active = store.prepare('SELECT COUNT(*) c, SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) p FROM orders WHERE batch_id=? AND status IN (2,3,4)').get(order.batch_id)
        batchInfo = {
          batch_id: b.id, batch_no: b.batch_no, status: b.status,
          status_text: b.status_text || deps.batch.statusText(b.status),
          total_orders: Number(active && active.c || 0),
          picked_orders: Number(active && active.p || 0),
          multi_order: Number(active && active.c || 0) > 1,
          device_sn: b.device_sn
        }
      }
    }
    ok(res, {
      ...order,
      status_text: s.ORDER_STATUS[order.status] || '',
      items,
      task,
      batch: batchInfo,
      cancel_request: cancelReq ? {
        status: cancelReq.status,
        status_text: s.CANCEL_REQ_STATUS[cancelReq.status] || '',
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

  // ---------- 取消订单 ----------
  router.post('/order/cancel', auth, async (req, res) => {
    const order = q.findByIdForUser(store, req.body.id, req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const st = Number(order.status)
    if ([3, 4, 6].includes(st)) {
      return res.status(400).json({ code: 400, msg: '该订单已送达/完成，请通过「退款/投诉」申请处理' })
    }
    if (st === 2 && s.orderTrulyDelivering(store, order)) {
      return res.status(400).json({ code: 400, msg: '配送中不支持取消，送达后可申请退款' })
    }
    if (![0, 1, 2].includes(st)) return res.status(400).json({ code: 400, msg: '当前状态不可取消' })
    if (st !== 0 && !s.withinFreeCancelWindow(order)) {
      return res.status(400).json({ code: 400, msg: '已超过可自由取消时间，请提交取消申请' })
    }
    const r = await s.applyOrderCancelled(store, deps, order)
    if (!r.claimed) {
      return res.status(409).json({ code: 409, msg: '订单已取消或状态已变更，请刷新后重试' })
    }
    ok(res, { order_id: order.id, status: 5 })
  })

  // ---------- 取消申请 ----------
  router.post('/order/cancel-request', auth, (req, res) => {
    const { order_id, reason = '' } = req.body || {}
    const order = q.findByIdForUser(store, order_id, req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const st = Number(order.status)
    if (![0, 1].includes(st)) return res.status(400).json({ code: 400, msg: '当前状态不可提交取消申请' })
    if (st !== 0 && s.withinFreeCancelWindow(order)) {
      return res.status(400).json({ code: 400, msg: '仍可直接取消，无需提交申请' })
    }
    if (q.pendingCancelRequestByOrder(store, order.id)) return res.status(400).json({ code: 400, msg: '已有待处理的取消申请' })
    const id = q.insertCancelRequest(store, { orderId: order.id, userId: req.user.id, reason })
    ok(res, { id, status: 0 })
  })

  router.get('/order/cancel-request/list', auth, (req, res) => {
    const rows = q.listCancelRequestsByUser(store, req.user.id).map((r) => ({ ...r, status_text: s.CANCEL_REQ_STATUS[r.status] || '' }))
    ok(res, rows)
  })

  router.get('/merchant/cancel-requests', merchantGuard, (req, res) => {
    const { status = '' } = req.query
    ok(res, q.listCancelRequestsMerchant(store, status).map((r) => ({ ...r, status_text: s.CANCEL_REQ_STATUS[r.status] || '' })))
  })

  router.get('/merchant/cancel-request/detail', merchantGuard, (req, res) => {
    const row = q.cancelRequestMerchantDetail(store, req.query.id)
    if (!row) return res.status(404).json({ code: 404, msg: '取消申请不存在' })
    ok(res, { ...row, status_text: s.CANCEL_REQ_STATUS[row.status] || '', order_status_text: s.ORDER_STATUS[row.order_status] || '' })
  })

  // 商家处理取消申请：approve 同意取消（订单→5）/ reject 拒绝（需理由）
  router.post('/merchant/cancel-request/handle', merchantGuard, async (req, res) => {
    const { id, action = '', reply = '' } = req.body || {}
    const c = q.findCancelRequestById(store, id)
    if (!c) return res.status(404).json({ code: 404, msg: '取消申请不存在' })
    if (Number(c.status) !== 0) return res.status(400).json({ code: 400, msg: '该申请已处理' })
    if (action === 'approve') {
      // 先取消订单（内部 CAS 抢占），取消成功后才把申请置为已处理
      const order = q.findById(store, c.order_id)
      if (order && [0, 1, 2].includes(Number(order.status))) {
        const r = await s.applyOrderCancelled(store, deps, order)
        if (!r.claimed) return res.status(409).json({ code: 409, msg: '订单状态已变更，请刷新后重试' })
      }
      const up = q.approveCancelRequest(store, c.id, reply)
      if (up.changes !== 1) return res.status(400).json({ code: 400, msg: '该申请已处理' })
      audit(req, 'cancel-request/approve', 'cancel_request#' + c.id, 'order#' + c.order_id + ' reply=' + (reply || '同意取消'))
      return ok(res, q.findCancelRequestById(store, c.id))
    }
    if (action === 'reject') {
      if (!reply) return res.status(400).json({ code: 400, msg: '请填写拒绝理由' })
      const up = q.rejectCancelRequest(store, c.id, reply)
      if (up.changes !== 1) return res.status(400).json({ code: 400, msg: '该申请已处理' })
      audit(req, 'cancel-request/reject', 'cancel_request#' + c.id, 'order#' + c.order_id + ' reason=' + reply)
      return ok(res, q.findCancelRequestById(store, c.id))
    }
    res.status(400).json({ code: 400, msg: '无效操作' })
  })

  // ---------- 退款/投诉（售后） ----------
  router.post('/refund/apply', auth, (req, res) => {
    const { order_id, type = 'refund', reason = '' } = req.body || {}
    const order = q.findByIdForUser(store, order_id, req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const st = Number(order.status)
    if (![3, 4, 6].includes(st) && !(st === 2 && s.orderStuckDelivering(store, order))) {
      return res.status(400).json({ code: 400, msg: '当前状态不可申请退款/投诉' })
    }
    // 一单只允许一条待处理售后（P2-9 前置）
    if (q.pendingRefundByOrder(store, order.id)) return res.status(400).json({ code: 400, msg: '已有待处理的售后申请，请等待商家处理' })
    const t = type === 'complaint' ? 'complaint' : 'refund'
    const id = q.insertRefund(store, { orderId: order.id, userId: req.user.id, type: t, reason, amount: t === 'refund' ? order.total_amount : 0 })
    ok(res, { id, type: t, status: 0 })
  })

  router.get('/refund/list', auth, (req, res) => {
    const rows = q.listRefundsByUser(store, req.user.id).map((r) => ({ ...r, status_text: s.REFUND_STATUS[r.status] || '' }))
    ok(res, rows)
  })

  router.get('/merchant/refunds', merchantGuard, (req, res) => {
    const { status = '' } = req.query
    ok(res, q.listRefundsMerchant(store, status).map((r) => ({ ...r, status_text: s.REFUND_STATUS[r.status] || '' })))
  })

  router.get('/merchant/refund/detail', merchantGuard, (req, res) => {
    const row = q.refundMerchantDetail(store, req.query.id)
    row ? ok(res, row) : res.status(404).json({ code: 404, msg: '售后单不存在' })
  })

  // 商家处理售后：退款 approve(默认全额可改)/reject(填理由)；投诉 reply
  router.post('/merchant/refund/handle', merchantGuard, async (req, res) => {
    const { id, action = '', amount, reply = '' } = req.body || {}
    const r = q.findRefundById(store, id)
    if (!r) return res.status(404).json({ code: 404, msg: '售后单不存在' })
    if (Number(r.status) !== 0) return res.status(400).json({ code: 400, msg: '该售后已处理' })
    if (r.type === 'refund') {
      if (action === 'approve') {
        const refundOrder = q.findById(store, r.order_id)
        // 订单状态白名单（P2-9）：已退款(7)的订单不得再次被「同意退款」
        if (!refundOrder || ![3, 4, 6].includes(Number(refundOrder.status))) {
          return res.status(400).json({ code: 400, msg: '订单当前状态不可退款，请刷新后重试' })
        }
        // 退款金额上限 = 订单实付金额
        const maxAmt = Number(refundOrder.total_amount || r.amount)
        const rawAmt = (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) ? r.amount : Number(amount)
        const amt = Math.min(rawAmt, maxAmt)
        // 真实退款（P0-5）：成功后才置 7；失败保持待处理并返回错误
        const ref = await s.realRefundOrLocal(store, deps, refundOrder, r.id, amt)
        if (!ref.ok) return res.status(502).json({ code: 502, msg: ref.msg })
        const c = await s.applyOrderCancelled(store, deps, refundOrder, { finalStatus: 7, reason: '商家同意退款' })
        if (!c.claimed) {
          return res.status(409).json({ code: 409, msg: '订单状态已变更，请刷新后重试' })
        }
        q.markRefunded(store, r.id, amt, reply, ref.refundNo)
        audit(req, 'refund/approve', 'refund#' + r.id, 'order#' + r.order_id + ' amount=' + amt + (ref.local ? ' (本地标记，无真实资金)' : ''))
      } else if (action === 'reject') {
        if (!reply) return res.status(400).json({ code: 400, msg: '请填写拒绝理由' })
        q.markRefundRejected(store, r.id, reply)
        audit(req, 'refund/reject', 'refund#' + r.id, 'order#' + r.order_id + ' reason=' + reply)
      } else {
        return res.status(400).json({ code: 400, msg: '无效操作' })
      }
    } else {
      // 投诉：商家回复处理
      q.markComplaintHandled(store, r.id, reply)
      audit(req, 'complaint/reply', 'refund#' + r.id, 'order#' + r.order_id + ' reply=' + reply)
    }
    ok(res, q.findRefundById(store, r.id))
  })

  // ---------- 商家端订单 ----------
  router.get('/merchant/stats', merchantGuard, (req, res) => {
    ok(res, s.computeStats(store))
  })

  // 商家订单列表：status / scope(active|history) / stage(accept|load|deliver|pickup) 三种过滤
  router.get('/merchant/orders', merchantGuard, (req, res) => {
    const { status = '', scope = '', stage = '' } = req.query
    let sql = 'SELECT * FROM orders'
    const args = []
    // 跨域只读：delivery_batches 状态过滤（与任务页 load/deliver 口径一致）
    if (stage === 'accept') sql += ' WHERE status=1'
    else if (stage === 'load') sql += " WHERE status=2 AND (batch_id IS NULL OR batch_id IN (SELECT id FROM delivery_batches WHERE status IN (0,1)))"
    else if (stage === 'deliver') sql += " WHERE status=2 AND batch_id IN (SELECT id FROM delivery_batches WHERE status=2)"
    else if (stage === 'pickup') sql += ' WHERE status=3'
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
          let rt = ''
          try { rt = (JSON.parse(b.route || '[]') || []).map((r) => r.landmark_name).filter(Boolean).join(' → ') } catch (e) { rt = '' }
          batchInfo = { batch_no: b.batch_no, daily_seq: Number(b.daily_seq || b.id), status: b.status, total_items: Number(b.total_items || 0), route_text: rt }
        }
      }
      return {
        ...o,
        status_text: s.ORDER_STATUS[o.status] || '',
        stage_text: stageText,
        // P1-13 手机号脱敏：商家端一律展示 138****0000
        contact_phone: maskPhone(o.contact_phone),
        // 点位名清洗：脏数据（??1?）以 landmarks 表回退（deps.batch = delivery 域，未拆前直连 services/batch）
        landmark_name: deps.batch.landmarkNameOf(store, o.landmark_id, o.landmark_name),
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

  router.get('/merchant/order/detail', merchantGuard, (req, res) => {
    const order = q.findById(store, req.query.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const items = q.itemsByOrder(store, order.id)
    let batchInfo = null
    if (order.batch_id) {
      const detail = deps.batch.getBatchDetail(store, order.batch_id)
      batchInfo = detail ? { id: detail.id, batch_no: detail.batch_no, daily_seq: detail.daily_seq, status: detail.status, status_text: detail.status_text, total_orders: detail.total_orders, picked_orders: detail.picked_orders } : null
    }
    ok(res, { ...order, contact_phone: maskPhone(order.contact_phone), status_text: s.ORDER_STATUS[order.status] || '', items, batch: batchInfo })
  })

  // 商家接单（真实业务：店铺歇业时后端拒绝接单；接单即并入当前配送批次，待批次派车）
  router.post('/merchant/order/confirm', merchantGuard, (req, res) => {
    const shop = deps.goods.getShop(store)
    if (shop.business_status === 'closed') {
      return res.status(400).json({ code: 400, msg: '店铺歇业中，无法接单' })
    }
    const order = q.findById(store, req.body.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (order.status !== 1) return res.status(400).json({ code: 400, msg: '订单状态不允许接单' })
    const b = deps.batch.addOrderToBatch(store, order)
    audit(req, 'order/confirm', 'order#' + order.id, '→ batch#' + b.id + ' ' + b.batch_no)
    ok(res, { order_id: order.id, status: 2, batch_id: b.id, batch_no: b.batch_no, msg: '已接单，订单并入配送批次 ' + b.batch_no })
  })

  // ---------- 配送异常订单处理（商家端） ----------
  // 1) 重新配送：作废旧任务、从旧批次摘除、并入新的组单中批次
  router.post('/merchant/order/exception/retry', merchantGuard, (req, res) => {
    const { order_id } = req.body || {}
    const order = q.findById(store, order_id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (Number(order.status) !== 6) return res.status(400).json({ code: 400, msg: '仅配送异常订单可重新配送' })
    // 作废旧任务并从旧批次摘除。必须按 order_id 精确作废（原注释：写 batch_id 会误伤同批次其他订单）
    store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text='异常重配，任务作废',
      void_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
      WHERE order_id=? AND task_status < 80 AND void_at IS NULL`).run(order.id)
    deps.batch.removeOrderFromBatch(store, order)
    // 并入新的组单中批次（派车由批次自动派车扫描统一处理）
    const b = deps.batch.addOrderToBatch(store, q.findById(store, order.id))
    q.setExceptionHandled(store, order.id, 'retry')
    console.log('[exception] 配送异常订单重新配送 order=' + order.id + ' → batch=' + b.batch_no + ' user=' + req.user.id)
    audit(req, 'order/exception-retry', 'order#' + order.id, '→ batch#' + b.id)
    ok(res, { order_id: order.id, status: 2, batch_id: b.id, batch_no: b.batch_no, msg: '已重新并入批次 ' + b.batch_no + '，请派车上货配送' })
  })

  // 2) 取消并退款：作废任务、订单置 7、写售后记录、回补未售库存、从批次摘除
  router.post('/merchant/order/exception/refund', merchantGuard, async (req, res) => {
    const { order_id } = req.body || {}
    const order = q.findById(store, order_id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (Number(order.status) !== 6) return res.status(400).json({ code: 400, msg: '仅配送异常订单可取消退款' })
    const ref = await s.realRefundOrLocal(store, deps, order, null, Number(order.total_amount))
    if (!ref.ok) return res.status(502).json({ code: 502, msg: ref.msg })
    // 落库统一走 orderCancel（作废任务 + 回补库存 + 摘除批次 + 停模拟推进）
    const c = await s.applyOrderCancelled(store, deps, order, { finalStatus: 7, reason: '异常退款，任务作废' })
    if (!c.claimed) return res.status(409).json({ code: 409, msg: '订单状态已变更，请刷新后重试' })
    q.setExceptionHandled(store, order.id, 'refund')
    q.insertAutoRefund(store, { orderId: order.id, userId: order.user_id, reason: '配送异常，商家取消并退款', amount: order.total_amount, reply: '配送异常自动退款', refundNo: ref.refundNo })
    console.log('[exception] 配送异常订单取消退款 order=' + order.id + ' amount=' + order.total_amount + ' user=' + req.user.id)
    audit(req, 'order/exception-refund', 'order#' + order.id, 'amount=' + order.total_amount)
    ok(res, { order_id: order.id, status: 7, msg: '已取消并退款 ¥' + order.total_amount })
  })

  // 配送异常订单列表：tab=all 全部异常相关 / pending 待处理 / done 已处理
  router.get('/merchant/orders/exception', merchantGuard, (req, res) => {
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
          let rt = ''
          try { rt = (JSON.parse(b.route || '[]') || []).map((r) => r.landmark_name).filter(Boolean).join(' → ') } catch (e) { rt = '' }
          batchInfo = { batch_no: b.batch_no, daily_seq: Number(b.daily_seq || b.id), status: b.status, total_items: Number(b.total_items || 0), route_text: rt }
        }
      }
      return {
        ...o,
        status_text: s.ORDER_STATUS[o.status] || '',
        contact_phone: maskPhone(o.contact_phone),
        daily_seq: Number(o.daily_seq || o.id),
        landmark_name: deps.batch.landmarkNameOf(store, o.landmark_id, o.landmark_name),
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

  return router
}
