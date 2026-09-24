// delivery 域路由（薄路由壳）：点位/配送追踪/用户取餐/一车多单批次/设备上货/平台回调/监控
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// 归属依据（05 方案）：主数据为 delivery_tasks / delivery_batches / landmarks 的路由全部归本域。
// deps = { runtime, platform, batch, goods, order, orderCancel }（与 timers.js 同源）

const express = require('express')
const { createShared } = require('../_shared')
const q = require('./queries')
const s = require('./service')

module.exports = (store, deps) => {
  const { auth, merchantGuard, audit, ok } = createShared(store)
  const router = express.Router()
  const PICKUP = deps.order // PICKUP_REOPEN_WINDOW_MS / MAX_PICKUP_OPEN / ORDER_STATUS 等常量

  // ---------- 点位 ----------
  // 公开列表裁剪物流平台内部 ID（P1-13）：platform_building_id / platform_map_id / platform_landmark_id
  // 是开放物流平台的场地/点位内部编号，对匿名请求暴露等于泄露平台结构。用户端只需点位展示与选择。
  router.get('/landmarks', (req, res) => {
    const rows = q.landmarksAll(store)
    // 有有效登录态的请求（商家点位同步等内部用途）返回全字段；匿名请求一律裁剪
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    const authed = token ? !!q.userByToken(store, token) : false
    const out = authed ? rows : rows.map((r) => {
      const { platform_building_id, platform_map_id, platform_landmark_id, ...rest } = r
      return rest
    })
    ok(res, out)
  })

  // ---------- 配送追踪 ----------
  router.get('/delivery/track', auth, async (req, res) => {
    // 跨域只读：orders（delivery→orders 例外）
    const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(req.query.order_id), req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const task = order.delivery_task_id ? q.taskById(store, order.delivery_task_id) : null
    const pos = task ? await deps.platform.getDevicePosition(store, task.id) : null
    // P1-12：机器人位置归一化为地图图片百分比坐标（x 从左→右 0-100，y 从下→上 0-100）。
    // 用真实坐标 ÷ 地图 bbox，不再依赖前端魔数/step 换算 —— 原实现读 position.step（后端根本不返回该字段）
    // 算出恒 NaN 的 posX/posY，R3 的配送追踪等于不可用。mock 档位置无 x/y → percent 保持 null，
    // 前端须回退为纯文本展示（见 track.js）。
    let percent = null
    if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
      try {
        const bb = await deps.platform.getMapBbox(store)
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
      const bb = await deps.platform.getMapBbox(store)
      if (bb && bb.maxX > bb.minX && bb.maxY > bb.minY) {
        const toPct = (x, y) => {
          // 8% 内边距，避免点位贴边显示不全
          const PAD = 8
          return {
            x: Math.round(PAD + ((Number(x) - bb.minX) / (bb.maxX - bb.minX)) * (100 - 2 * PAD)),
            y: Math.round(PAD + (1 - (Number(y) - bb.minY) / (bb.maxY - bb.minY)) * (100 - 2 * PAD))
          }
        }
        const pts = q.landmarksWithPos(store)
        const landmarks = pts.map((p) => Object.assign({ id: p.id, name: p.name, type: p.type }, toPct(p.pos_x, p.pos_y)))
        // 路线：批次停靠点坐标（含上货点起点）
        let route = []
        if (order.batch_id) {
          const b = q.batchById(store, order.batch_id)
          if (b && b.route) {
            const stops = JSON.parse(b.route)
            const loading = q.loadingPointFirst(store)
            if (loading && Number.isFinite(Number(loading.pos_x))) {
              route.push(Object.assign({ name: '商铺上货' }, toPct(loading.pos_x, loading.pos_y)))
            }
            for (const st of stops) {
              const lm = q.landmarkPosById(store, st.landmark_id)
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
      const b = q.batchById(store, order.batch_id)
      if (b) {
        const active = store.prepare('SELECT COUNT(*) c, SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) p FROM orders WHERE batch_id=? AND status IN (2,3,4)').get(order.batch_id)
        batchInfo = {
          batch_id: b.id,
          batch_no: b.batch_no,
          status: b.status,
          status_text: b.status_text || deps.batch.statusText(b.status),
          total_orders: Number(active && active.c || 0),
          picked_orders: Number(active && active.p || 0),
          multi_order: Number(active && active.c || 0) > 1,
          device_sn: b.device_sn
        }
      }
    }
    // 无任务但已接单（组单中/待上货）：给出更准确的状态文案
    let taskText = task ? task.status_text : (PICKUP.ORDER_STATUS[order.status] || '')
    if (!task) {
      if (Number(order.status) === 2 && batchInfo) {
        taskText = batchInfo.status === 0 ? '商家已接单，正在组车配送' : '机器人前往上货点'
      } else if (Number(order.status) === 1) {
        taskText = '等待商家接单'
      }
    }
    // 取餐超时两段式提示：已送达(3)未取时按阶段给文案（正在取餐 / 一段超时·先送其他单 / 已返回再等·即将取消）
    if (Number(order.status) === 3 && !order.picked_up_at) {
      if (order.picking_up_at) taskText = '正在取餐（舱门已打开，请取出餐品并关舱）'
      else if (Number(order.pickup_timeout_stage) === 1) taskText = '取餐超时，先送其他单，稍后返回本点位，请留意'
      else if (Number(order.pickup_timeout_stage) === 2) taskText = '已再次到达等待，即将取消订单，请尽快取餐'
    }
    ok(res, {
      order_status: order.status,
      order_status_text: PICKUP.ORDER_STATUS[order.status] || '',
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

  // 确认收货（扫码/按钮）：订单置已完成 + 结算销量
  router.post('/delivery/confirm', auth, (req, res) => {
    const { order_id, scan_code } = req.body || {}
    const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number(order_id), req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (order.status !== 3) return res.status(400).json({ code: 400, msg: '机器人还未送达' })
    if (scan_code && String(scan_code).trim() !== order.pickup_code) {
      return res.status(400).json({ code: 400, msg: '取餐码不匹配，请扫描机器人屏幕上的取餐码' })
    }
    store.prepare("UPDATE orders SET status=4, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
    deps.goods.settleSales(store, order.id)
    ok(res)
  })

  // ---------- 用户取餐（扫码后：开舱/取餐/关舱/40s自动关/重开） ----------
  // 扫码取餐：校验订单归属 + 已送达，返回取餐上下文（供取餐页展示与操作）
  // 允许 {3,4}：关舱后（订单 4）重新进入取餐页重开舱也放行，与 P1-2 的重开限制配套
  router.post('/delivery/pickup-scan', auth, (req, res) => {
    const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (![3, 4].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '机器人还未送达，暂不能取餐' })
    ok(res, s.pickupContext(store, order))
  })

  // 扫码取餐（需求5）：用户扫无人车二维码 → 输入取餐码 → 校验归属（本人订单、待取餐、取餐码匹配、车一致）
  router.post('/delivery/pickup-by-code', auth, (req, res) => {
    const { device_sn = '', pickup_code = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    if (!String(pickup_code).trim()) return res.status(400).json({ code: 400, msg: '请输入取餐码' })
    const order = store.prepare(`
      SELECT o.* FROM orders o
      LEFT JOIN delivery_batches b ON b.id = o.batch_id
      WHERE o.user_id=? AND o.status=3 AND o.pickup_code=?
        AND (EXISTS(SELECT 1 FROM delivery_tasks d WHERE d.order_id=o.id AND d.void_at IS NULL AND d.device_sn=?)
             OR (b.device_sn=? AND b.device_sn<>''))
      ORDER BY o.id DESC LIMIT 1`).get(req.user.id, String(pickup_code).trim(), device_sn, device_sn)
    if (!order) return res.status(400).json({ code: 400, msg: '取餐码不正确或无人车不匹配' })
    ok(res, s.pickupContext(store, order))
  })

  // 扫码自动校验（需求 2026-09-17）：扫无人车二维码后，先按登录账号自动匹配本人在该车上的待取餐订单。
  // 匹配到 → 免输取餐码直接取餐；匹配不到 → 区分「配送中」与「无订单」两种提示（需求 2026-09-24），
  // 前端据此分流：配送中 → 提示等待送达；无订单 → 回退「输入取餐码 / 查看我的订单 / 去商城」。
  router.post('/delivery/pickup-by-scan', auth, (req, res) => {
    const { device_sn = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const order = store.prepare(`
      SELECT o.* FROM orders o
      LEFT JOIN delivery_batches b ON b.id = o.batch_id
      WHERE o.user_id=? AND o.status=3
        AND (EXISTS(SELECT 1 FROM delivery_tasks d WHERE d.order_id=o.id AND d.void_at IS NULL AND d.device_sn=?)
             OR (b.device_sn=? AND b.device_sn<>''))
      ORDER BY o.id DESC LIMIT 1`).get(req.user.id, device_sn, device_sn)
    if (order) {
      ok(res, Object.assign({ auto_matched: true }, s.pickupContext(store, order)))
      return
    }
    // 未匹配到待取餐：查该用户在该车上是否有配送中（status 1/2）订单，用于前端提示「正在配送中」
    const delivering = store.prepare(`
      SELECT o.id AS order_id, o.order_no, o.landmark_name FROM orders o
      LEFT JOIN delivery_batches b ON b.id = o.batch_id
      WHERE o.user_id=? AND o.status IN (1,2)
        AND (EXISTS(SELECT 1 FROM delivery_tasks d WHERE d.order_id=o.id AND d.void_at IS NULL AND d.device_sn=?)
             OR (b.device_sn=? AND b.device_sn<>''))
      ORDER BY o.id DESC LIMIT 1`).get(req.user.id, device_sn, device_sn)
    if (delivering) {
      ok(res, { auto_matched: false, status_hint: 'delivering', order_id: delivering.order_id, order_no: delivering.order_no, landmark_name: delivering.landmark_name })
    } else {
      ok(res, { auto_matched: false, status_hint: 'none' })
    }
  })

  // 打开舱门取餐（unloading/verify 开舱）。
  // P1-2 修复：开舱**不再**把订单标记为已取走 —— 原先开舱即置 4 并结算销量，用户尚未拿到餐
  // 订单就已不可逆结束；且「重新打开舱门」因状态已非 3 永远 400，专门为防未取到餐做的功能一次都用不了。
  // 现在「标记已取走」移到关舱（pickup-close）；开舱允许 status ∈ {3,4}，限次数（默认 3 次）限时（默认 10 分钟）。
  router.post('/delivery/pickup-open', auth, async (req, res) => {
    const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (![3, 4].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '机器人还未送达，暂不能取餐' })
    // 重开限时：从首次开舱起超过窗口则不再允许
    if (order.pickup_opened_at) {
      const first = new Date(String(order.pickup_opened_at).replace(' ', 'T')).getTime()
      if (!isNaN(first) && Date.now() - first > PICKUP.PICKUP_REOPEN_WINDOW_MS) {
        return res.status(400).json({ code: 400, msg: '已超过可重新开舱时间（' + Math.round(PICKUP.PICKUP_REOPEN_WINDOW_MS / 60000) + ' 分钟）' })
      }
    }
    // CAS 抢占 + 次数上限：并发双击只成功一次，超过 MAX_PICKUP_OPEN 次直接拒绝
    // picking_up_at=现在：打开舱门即标记「正在取餐」（取餐超时计时暂停，防止取货中途被误判超时）
    const claim = store.prepare(`
      UPDATE orders SET
        pickup_opened_at=COALESCE(pickup_opened_at, datetime('now','localtime')),
        pickup_open_count=pickup_open_count+1,
        picking_up_at=datetime('now','localtime'),
        updated_at=datetime('now','localtime')
      WHERE id=? AND status IN (3,4) AND pickup_open_count < ?`).run(order.id, PICKUP.MAX_PICKUP_OPEN)
    if (claim.changes !== 1) return res.status(400).json({ code: 400, msg: '重新开舱次数已达上限，请联系商家处理' })
    // 取餐开舱：召唤模式无配送任务，直接 drawerCtrl(1) 开舱；否则走 unloadingVerify（任务态）
    if (deps.runtime.summonDelivery) {
      const b = order.batch_id ? q.batchById(store, order.batch_id) : null
      if (b && b.device_sn) {
        const r = await deps.platform.drawerCtrl(b.device_sn, 1)
        if (!r.ok) return res.status(502).json({ code: 502, msg: '开舱失败：' + r.msg })
        return ok(res, { order_id: order.id, status: Number(order.status), opened_at: order.pickup_opened_at, summon: true })
      }
    }
    const task = order.delivery_task_id ? q.taskById(store, order.delivery_task_id) : null
    const ready = !!(task && task.device_sn && task.platform_task_id)
    if (ready) {
      const r = await deps.platform.unloadingVerify(task.device_sn, task.platform_task_id, { contact: order.contact_phone || '', roomNum: order.pickup_code })
      if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
    }
    ok(res, { order_id: order.id, status: Number(order.status), opened_at: order.pickup_opened_at, test: !ready })
  })

  // 关闭舱门（unloading/confirm 关舱返回；订单标记已取走 → 4 已完成 + 结算销量 + 批次计数）
  // P1-2：真正的「确认取餐」动作放在关舱 —— 用户关舱 = 拿走餐品，此时才置已完成并结算。
  // 平台侧 40s 未调用会自动关舱，任务流转 80 时由 applyStatus/onTaskStatus 走同一路径标记已取走。
  router.post('/delivery/pickup-close', auth, async (req, res) => {
    const order = store.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(Number((req.body || {}).order_id), req.user.id)
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    if (![3, 4].includes(Number(order.status))) return res.status(400).json({ code: 400, msg: '订单状态不允许关舱' })
    // 召唤模式：关舱 = drawerCtrl(0)，取走动作收口到 order.fulfillOrder（写 order+结算，批次推进经钩子）
    if (deps.runtime.summonDelivery) {
      const b = order.batch_id ? q.batchById(store, order.batch_id) : null
      if (b && b.device_sn) {
        // 召唤模式关舱是「尽力而为」：用户已取走餐，物理 drawerCtrl(0) 报错不阻断取餐记录与推进。
        // 否则一旦平台关舱失败就会提前 return，该单停在待取货(3) → 推进器永不触发 → 机器人回充电桩。
        try {
          const c = await deps.platform.drawerCtrl(b.device_sn, 0)
          if (!c.ok) console.warn('[summon] 关舱(尽力而为)未确认 order=' + order.id + ' msg=' + c.msg)
        } catch (e) { console.warn('[summon] 关舱调用异常 order=' + order.id + ' msg=' + (e && e.message)) }
      }
      store.prepare("UPDATE orders SET picking_up_at=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
      const r = deps.order.fulfillOrder(store, deps, order) // 置 4 已完成 + 结算销量 + 批次计数(钩子/看门狗触发推进)
      if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
      return ok(res, { order_id: order.id, status: 4, summon: true })
    }
    const task = order.delivery_task_id ? q.taskById(store, order.delivery_task_id) : null
    const ready = !!(task && task.device_sn && task.platform_task_id)
    if (ready) {
      const r = await deps.platform.unloadingConfirm(task.device_sn, task.platform_task_id, { contact: order.contact_phone || '', roomNum: order.pickup_code })
      if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
    }
    // 关舱 = 真正取走：清「正在取餐」标记，随后 markOrderPicked（4 已完成 + 结算销量 + 批次计数）
    store.prepare("UPDATE orders SET picking_up_at=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
    deps.batch.markOrderPicked(store, order)
    ok(res, { order_id: order.id, status: 4, test: !ready })
  })

  // 【同点多单一起取】关闭舱门 = 一次确认「该用户本批次本取货点所有订单」都取走：
  // 用户在点位把舱内全部自己的餐一起拿走，关舱即把该用户在本批次该点位全部待取(3)订单置已完成(4)。
  // 订单状态写走 order 域 fulfillOrder（含结算+批次计数→推进下一站/完成）；召唤模式顺带 drawerCtrl(0) 关舱。
  router.post('/delivery/pickup-close-all', auth, async (req, res) => {
    const batchId = Number((req.body || {}).batch_id)
    const landmarkId = String((req.body || {}).landmark_id || '')
    if (!batchId) return res.status(400).json({ code: 400, msg: '缺少批次号' })
    const b = q.batchById(store, batchId)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    // 在该用户能找到的订单里，本批次该点位的待取(3)订单
    const rows = landmarkId
      ? store.prepare('SELECT * FROM orders WHERE batch_id=? AND user_id=? AND status=3 AND landmark_id=?').all(batchId, req.user.id, landmarkId)
      : store.prepare('SELECT * FROM orders WHERE batch_id=? AND user_id=? AND status=3').all(batchId, req.user.id)
    if (!rows.length) return ok(res, { batch_id: batchId, landmark_id: landmarkId, count: 0, msg: '该点位没有待取订单' })
    let cnt = 0
    for (const o of rows) {
      try { if (deps.order.fulfillOrder(store, deps, o).ok) cnt++ } catch (e) { console.warn('[pickup] close-all 单条失败 order=' + o.id + ' ' + e.message) }
    }
    // 召唤模式：关舱 drawerCtrl(0)（尽力而为）+ 清「正在取餐」
    if (deps.runtime.summonDelivery && b.device_sn) {
      try { const c = await deps.platform.drawerCtrl(b.device_sn, 0); if (!c.ok) console.warn('[summon] 关舱(close-all)未确认 batch=' + b.id + ' msg=' + c.msg) } catch (e) { console.warn('[summon] 关舱(close-all)异常 batch=' + b.id + ' msg=' + (e && e.message)) }
    }
    store.prepare("UPDATE orders SET picking_up_at=NULL, updated_at=datetime('now','localtime') WHERE batch_id=? AND user_id=? AND status=4").run(batchId, req.user.id)
    return ok(res, { batch_id: batchId, landmark_id: landmarkId, count: cnt })
  })

  // ---------- 一车多单：配送批次 ----------
  // 商家批次列表：组单中 / 待上货 / 配送中（近 20 个），每批次带订单摘要
  router.get('/merchant/delivery/batch/list', merchantGuard, (req, res) => {
    const rows = q.recentBatches(store, 20)
    const out = rows.map((b) => deps.batch.getBatchDetail(store, b.id))
    ok(res, out)
  })

  // 批次详情（订单 + 路线）
  router.get('/merchant/delivery/batch/detail', merchantGuard, (req, res) => {
    const b = deps.batch.getBatchDetail(store, Number(req.query.batch_id || 0))
    b ? ok(res, b) : res.status(404).json({ code: 404, msg: '批次不存在' })
  })

  // 批次派车（一车多单）：规划路线 + 创建全部平台任务，可指定机器人（P1-7 并发抢占见 service.doDispatchBatch）
  router.post('/merchant/delivery/batch/dispatch', merchantGuard, async (req, res) => {
    const { batch_id, device_sn } = req.body || {}
    try {
      const detail = await s.doDispatchBatch(store, deps, batch_id, device_sn || '')
      audit(req, 'batch/dispatch', 'batch#' + batch_id, 'device_sn=' + (device_sn || detail.device_sn || '') + ' orders=' + (detail.orders ? detail.orders.length : 0))
      ok(res, detail)
    } catch (e) {
      res.status(400).json({ code: 400, msg: e.message })
    }
  })

  // 批次上货（Route B 直接下发）：开舱 = 获取设备控制权 + 预创建任务（设备开舱等待放货）。
  // 控制权按批次暂存内存（batchCtrl），「开始配送」时释放；服务重启后控制权按平台超时自动失效，
  // 无 ctrlId 时开始配送直接放行（机器人等控制权超时自动执行）。
  router.post('/merchant/device/batch/open-bin', merchantGuard, async (req, res) => {
    const { batch_id } = req.body || {}
    const b = q.batchById(store, batch_id)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    // 召唤多单配送：无配送任务，开舱=先召唤到上货点 + 到达门禁(lightTask status=30) + drawerCtrl(1)
    if (deps.runtime.summonDelivery) {
      if (!b.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先派车定型' })
      // 问题4门禁兜底：若该车正在做召唤配送（别的批次/本批已在投递），不打断它回上货点，直接提示暂无空闲机器人。
      if (!deps.runtime.deviceMock) {
        const busyGuard = await deps.platform.isRobotBusy(store, b.device_sn)
        if (busyGuard.busy) return res.status(400).json({ code: 400, msg: '暂无空闲机器人：' + (busyGuard.msg || '无人车正在配送中，请等其配送完成后再上货') })
      }
      // 到达门禁按「机器人真实到达信号」判断（召唤任务 status=30 arrivedPoint），不再用位置测距估判。
      // 车未到 → 返回 200 {waiting:true}，前端给友好等待提示，稍后重试（已存在的召唤不重复创建，避免进度重置）。
      if (!deps.runtime.deviceMock) {
        const gate = await s.ensureLoadingArrival(store, deps, b)
        if (!gate.waiting && !gate.arrived && gate.error) {
          return res.status(502).json({ code: 502, msg: gate.msg, reason: 'summon_failed' })
        }
        if (!gate.arrived) {
          return ok(res, { batch_id: b.id, opened: 0, summoned: true, waiting: true, msg: '机器人正在前往上货点，请稍候再次点击打开舱门', lighttask_status: gate.status })
        }
      }
      const opened = await deps.platform.drawerCtrl(b.device_sn, 1)
      if (!opened.ok) return res.status(502).json({ code: 502, msg: '开舱失败：' + opened.msg })
      q.setBatchLoading(store, b.id)
      audit(req, 'device/batch-open', 'batch#' + b.id, '召唤开舱 device_sn=' + b.device_sn)
      return ok(res, { batch_id: b.id, opened: b.total_orders, summoned: true })
    }
    // 需求3门禁：无人车必须已到达上货点才能开舱上货（真实档校验；演示档恒通过）
    const gate = await deps.platform.robotAtLoadingPoint(store, b.device_sn)
    if (!gate.ok) {
      // 未到上货点是「等待状态」而非「报错」：带 reason 让前端展示友好提示（不弹红字报错）
      return res.status(400).json({ code: 400, msg: gate.msg, reason: 'not_at_loading_point' })
    }
    let opened = 0
    if (deps.runtime.deviceMock) {
      const results = await deps.platform.verifyBatchLoading(store, b.id)
      const failed = results.filter((r) => !r.ok)
      if (failed.length) {
        return res.status(502).json({ code: 502, msg: '开舱失败：' + failed[0].msg })
      }
      opened = results.length
    } else {
      // Route B（syncLoading=0）：任务已在定型时创建（车自行导航到上货点），开舱=获取控制权 + loadingVerify 开舱
      const g = await deps.platform.grantControl(b.device_sn, 600)
      if (!g.ok) return res.status(502).json({ code: 502, msg: '开舱失败：' + g.msg })
      const ctrlId = (g.data && (g.data.ctrlId || g.data.sessionId || g.data.id)) || ''
      // 控制权 ID 持久化到批次行（重启不丢），内存 Map 仅作快速访问
      s.batchCtrl.set(b.id, { ctrlId, deviceSn: b.device_sn })
      q.setBatchCtrlId(store, b.id, ctrlId)
      const results = await deps.platform.verifyBatchLoading(store, b.id)
      const failed = results.filter((r) => !r.ok)
      if (failed.length) {
        return res.status(502).json({ code: 502, msg: '开舱失败：' + failed[0].msg })
      }
      opened = results.length
    }
    q.setBatchLoading(store, b.id)
    audit(req, 'device/batch-open', 'batch#' + b.id, 'opened=' + opened)
    ok(res, { batch_id: b.id, opened })
  })

  // 批次关舱：Route B（syncLoading=0）任务已在定型时创建，此处仅关舱；演示档同样 drawerCtrl 关舱
  router.post('/merchant/device/batch/close-bin', merchantGuard, async (req, res) => {
    const { batch_id } = req.body || {}
    const b = q.batchById(store, batch_id)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    if (!b.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
    const r = await deps.platform.drawerCtrl(b.device_sn, 0)
    if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
    // 关舱 = 货已装好，但可能先不回「立即配送」页（稍后/退出）。落 loaded_at 持久化「已上货待配送」，
    // 供商家重进 batchDetail 时 inferPhase 恢复「立即配送」，以及批次列表标注「已上货待配送」。
    q.setBatchLoadedAt(store, b.id)
    audit(req, 'device/batch-close', 'batch#' + b.id, 'device_sn=' + b.device_sn)
    ok(res)
  })

  // 批次开始配送（逐任务 loading/confirm；批次置配送中）
  router.post('/merchant/device/batch/dispatch', merchantGuard, async (req, res) => {
    const { batch_id } = req.body || {}
    const b = q.batchById(store, batch_id)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    // 召唤多单配送：立即配送 = 按单数加权路线规划 + 召唤到首站 + 该站订单置待取货（不创建越凡配送任务）
    if (deps.runtime.summonDelivery) {
      try {
        const detail = await s.startSummonDelivery(store, deps, b.id)
        audit(req, 'device/batch-dispatch', 'batch#' + b.id, '召唤配送 device_sn=' + b.device_sn)
        return ok(res, { batch_id: b.id, summoned: true, detail })
      } catch (e) {
        return res.status(400).json({ code: 400, msg: e.message })
      }
    }
    // 开始配送前（商家已上货并关舱）规划路线：按收餐点位分组 + 最近邻，写入 batch.route 供逐点配送/地图展示。
    // 路线规划失败不阻断配送（每个任务自带收餐点位，仍会逐点送达）。
    try {
      const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (1,2)').all(b.id)
      const route = deps.batch.planRoute(store, orders)
      q.setBatchRoute(store, b.id, JSON.stringify(route))
    } catch (e) { console.warn('[batch] 路线规划失败（继续配送）', e.message) }
    let dispatched = 0
    if (deps.runtime.deviceMock) {
      const results = await deps.platform.confirmBatchLoading(store, b.id)
      const failed = results.filter((r) => !r.ok)
      if (failed.length) {
        return res.status(502).json({ code: 502, msg: '开始配送失败：' + failed[0].msg })
      }
      dispatched = results.length
    } else {
      // Route B（syncLoading=0）：确认上货（loadingConfirm → 任务流转 50 已上货，关舱并开始配送）
      const results = await deps.platform.confirmBatchLoading(store, b.id)
      const failed = results.filter((r) => !r.ok)
      if (failed.length) {
        return res.status(502).json({ code: 502, msg: '开始配送失败：' + failed[0].msg })
      }
      // 释放控制权 → 机器人开始执行配送任务。
      // ctrlId 优先取批次行（持久化，重启不丢）。释放失败不阻断配送：
      // 控制权可能已超时（机器人会自行开始执行任务），记日志后照常进入配送中，绝不卡商家。
      const ctrl = s.batchCtrl.get(b.id) || { ctrlId: b.ctrl_id || '', deviceSn: b.device_sn }
      if (ctrl && ctrl.ctrlId) {
        const rel = await deps.platform.releaseControl(ctrl.deviceSn, ctrl.ctrlId)
        if (!rel.ok) console.warn('[batch] 释放控制权失败（继续配送）batch=' + b.id + ' msg=' + rel.msg)
      }
      s.batchCtrl.delete(b.id)
      q.setBatchCtrlId(store, b.id, '')
      dispatched = results.length
    }
    q.setBatchDelivering(store, b.id)
    audit(req, 'device/batch-dispatch', 'batch#' + b.id, 'device_sn=' + b.device_sn + ' dispatched=' + dispatched)
    ok(res, { batch_id: b.id, dispatched })
  })

  // 测试辅助：模拟完成上货并开始配送（无真机器人时用）
  // 纯本地推进批次状态：批次 → 配送中(2)、批次内任务 → 已上货(50)，不调用开放物流平台。
  // 测试阶段配送时间模拟为 MOCK_ARRIVE_MS（默认 10 秒）：到点后自动把批次内全部订单标记为已送达(3)/任务 70，
  // 直接进入「待取货」，用户即可取餐；商家无需手动点「测试完成配送」。
  // 正式接入真机器人后由「立即配送」（/merchant/device/batch/dispatch）真实下发，本接口仅测试阶段使用。
  router.post('/merchant/device/batch/mock-dispatch', merchantGuard, (req, res) => {
    // 非模拟档禁止：否则任何持商家 token 的人都能让整批真实订单在约 10 秒后被标成「已送达」并结算销量，
    // 而机器人仍在真实配送 —— 订单/任务/批次三方状态分叉。与 test-complete 保持同一道守卫。
    if (!deps.runtime.deviceMock) return res.status(404).json({ code: 404, msg: '当前运行模式不允许模拟配送' })
    const { batch_id } = req.body || {}
    const b = q.batchById(store, batch_id)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    if (Number(b.status) !== 1) return res.status(400).json({ code: 400, msg: '批次未派车，请先派车' })
    q.setBatchMockArrive(store, b.id, Math.round(s.MOCK_ARRIVE_MS / 1000))
    q.setTaskStatusByBatchBelow(store, b.id, 50, '已上货（模拟）')
    q.setBatchDelivering(store, b.id)
    console.log('[batch] 模拟上货完成并开始配送（测试）batch=' + b.batch_no + ' user=' + req.user.id + ' 约' + Math.round(s.MOCK_ARRIVE_MS / 1000) + '秒后送达')
    audit(req, 'test/mock-dispatch', 'batch#' + b.id, 'mock_arrive_after=' + Math.round(s.MOCK_ARRIVE_MS / 1000) + 's')
    // P1-4：模拟到达不再依赖内存 setTimeout（纯内存、重启即丢 → 配送中的订单会永久卡死）。
    // mock_arrive_at 已落库，由后台定时任务（自动派车同一 interval）到点统一处理，重启可自愈。
    ok(res, { batch_id: b.id, status: 2, msg: '已开始配送（测试阶段配送时间模拟为' + Math.round(s.MOCK_ARRIVE_MS / 1000) + '秒）' })
  })

  // ---------- 机器人设备列表（真实模式：调平台 runtimeStatusList） ----------
  // 平台未配置/调用失败时返回明确错误，前端展示错误卡
  router.get('/merchant/robots', merchantGuard, async (req, res) => {
    const r = await deps.platform.getDeviceList()
    if (!r.ok) {
      return res.status(502).json({ code: 502, msg: r.msg || '获取机器人失败' })
    }
    ok(res, r.robots)
  })

  // 无人车取餐小程序码（需求：微信扫一扫直达用户端取餐页）：
  // scene 只放纯设备号（≤32 可见字符），page 固定用户端 pages/delivery/scanPickup；
  // 商家在小程序内 wx.scanCode 扫同一个码，得到的就是设备号（parseDeviceSn 对纯编号原样返回），
  // 配单上货流程零改动 —— 一个码两端用。
  // 生成后落盘 uploads/robot-qr/<sn>.png（同 sn 复用文件），返回可展示/保存的图片 URL。
  router.post('/merchant/device/wxacode', merchantGuard, async (req, res) => {
    const { device_sn = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const sn = String(device_sn).trim()
    const fs = require('fs')
    const path = require('path')
    const QR_DIR = path.join(__dirname, '..', '..', 'uploads', 'robot-qr')
    const file = path.join(QR_DIR, sn + '.png')
    if (!fs.existsSync(file)) {
      const r = await deps.wxmp.getWxacodeUnlimit({ scene: sn, page: 'pages/delivery/scanPickup' })
      if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg || '生成二维码失败' })
      try {
        fs.mkdirSync(QR_DIR, { recursive: true })
        fs.writeFileSync(file, r.buffer)
      } catch (e) {
        return res.status(500).json({ code: 500, msg: '保存二维码图片失败' })
      }
    }
    ok(res, { image_url: '/uploads/robot-qr/' + encodeURIComponent(sn) + '.png' })
  })

  // ---------- 配送监控 ----------
  router.get('/merchant/delivery/monitor', merchantGuard, async (req, res) => {
    const tasks = q.monitorTasks(store)
    const out = []
    for (const t of tasks) {
      const pos = await deps.platform.getDevicePosition(store, t.id)
      out.push({ ...t, position: pos })
    }
    ok(res, out)
  })

  // ---------- 配送监控地图（真实校园地图 + 点位 + 路网 + 机器人位置 + 路线） ----------
  router.get('/merchant/map', merchantGuard, async (req, res) => {
    const r = await deps.platform.getMapOverview(store)
    r.ok ? ok(res, r) : res.status(502).json({ code: 502, msg: r.msg || '获取地图失败' })
  })

  // ---------- 开放物流平台回调（真实业务逻辑） ----------
  router.post('/platform/callback/delivery', (req, res) => s.handleDeliveryCallback(store, deps, req, res))
  // 备用形态：令牌走路径段（平台侧若对 query 做规范化时可用）
  router.post('/platform/cb/:token/delivery', (req, res) => s.handleDeliveryCallback(store, deps, req, res))

  router.get('/platform/check-order', (req, res) => s.handleCheckOrder(store, deps, req, res))
  router.post('/platform/check-order', (req, res) => s.handleCheckOrder(store, deps, req, res))
  router.get('/platform/cb/:token/check-order', (req, res) => s.handleCheckOrder(store, deps, req, res))
  router.post('/platform/cb/:token/check-order', (req, res) => s.handleCheckOrder(store, deps, req, res))

  // 设备异常上报回调（T 任务类 / R 机器类 / I IOT 类 / N 导航类）
  router.post('/platform/callback/exception', (req, res) => s.handleExceptionCallback(deps, req, res))
  router.post('/platform/cb/:token/exception', (req, res) => s.handleExceptionCallback(deps, req, res))

  // ---------- 平台点位同步（商家端入口） ----------
  router.post('/merchant/landmarks/sync', merchantGuard, async (req, res) => {
    const r = await deps.platform.syncLandmarks(store)
    r.ok ? ok(res, r) : res.status(500).json({ code: 500, msg: r.msg || '同步失败' })
  })

  // ---------- 商家面对面扫码上货（设备控制） ----------
  // 流程：扫码识别机器人(scan) → 打开舱门(open-bin) → 放货 → 关闭舱门(close-bin，等待) → 立即配送(dispatch)

  // 测试辅助：真实模式无真机器人时，把卡在「配送中」的订单/批次标记为已送达(3)或已完成(4)，便于走通流程
  // 支持：order_id（单订单）/ batch_id（整批全部订单）
  router.post('/merchant/delivery/test-complete', merchantGuard, (req, res) => {
    // 非模拟档禁止测试完成接口（防止把真实配送中的订单直接标为完成）
    if (!deps.runtime.deviceMock) return res.status(404).json({ code: 404, msg: '当前运行模式不允许测试完成' })
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
        q.setTaskStatus(store, order.delivery_task_id, 80, '任务完成（测试）')
      }
      store.prepare("UPDATE orders SET status=?, delivered_at=COALESCE(delivered_at, datetime('now','localtime')), updated_at=datetime('now','localtime') WHERE id=?")
        .run(to, id)
      if (to === 4) deps.batch.markOrderPicked(store, order)
      if (order.batch_id) touched.add(order.batch_id)
    }
    // 批次状态联动：全部完成 → 已完成；否则待上货批次推进为配送中（避免「待上货批次里躺着已送达订单」）
    for (const bid of touched) s.reconcileBatchState(store, bid)
    audit(req, 'test/complete', (batch_id ? 'batch#' + batch_id : 'order#' + (order_id || '')), 'count=' + ids.length + ' status=' + to)
    ok(res, { count: ids.length, status: to })
  })

  // 待上货批次列表：组单中(可派车) / 待上货(已派车，任务排队中/去上货点/上货中) / 配送中
  router.get('/merchant/device/pending', merchantGuard, async (req, res) => {
    const openBatches = q.batchesByStatus(store, 0, 5)
    const readyBatches = q.batchesByStatus(store, 1, 10)
    const activeBatches = q.batchesByStatus(store, 2, 10)
    const wrap = (list) => list.map((b) => deps.batch.getBatchDetail(store, b.id)).filter(Boolean)
    const open = wrap(openBatches)
    const ready = wrap(readyBatches)
    // 问题4门禁：给每个「待上货」批次标注其设备是否被占用（正在配送/使用中）。
    // 商家按「上货」前据此提示「暂无空闲机器人」，否则不中断正在配送的车、不去强召上货点。
    for (const b of ready) {
      let avail = true, busymsg = ''
      if (b.device_sn) {
        try {
          const bb = await deps.platform.isRobotBusy(store, b.device_sn)
          if (bb && bb.busy) { avail = false; busymsg = bb.msg || '机器人正在配送中，暂不能上货' }
        } catch (e) { /* 查询失败按可用处理，不误拦 */ }
      }
      b.robot_available = avail
      b.robot_busy = !avail
      b.robot_busy_msg = busymsg
    }
    // 待配单订单数（配单上货红点）：组单中 + 待上货批次内的订单总数（按订单计，非批次数）
    const pendingOrders = open.reduce((s, b) => s + (b.orders || []).length, 0)
      + ready.reduce((s, b) => s + (b.orders || []).length, 0)
    ok(res, { open_batches: open, ready_batches: ready, active_batches: wrap(activeBatches), pending_orders: pendingOrders })
  })

  // 扫码识别机器人 → 定位待上货批次（一车多单）：返回批次与全部订单
  router.post('/merchant/device/scan', merchantGuard, async (req, res) => {
    const { deviceSn = '' } = req.body || {}
    if (!deviceSn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    let batchRow = null
    if (process.env.PLATFORM_MOCK === 'true') {
      // 模拟：取最早一个待上货批次（或已派车批次）
      batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status IN (1,2) ORDER BY id DESC LIMIT 1').get()
      if (!batchRow) batchRow = store.prepare('SELECT * FROM delivery_batches WHERE status=0 ORDER BY id DESC LIMIT 1').get()
    } else {
      // 真实（P1-10）：按扫码设备号精确匹配，绝不把货错装到别的车。
      // ① 该车已派好车的「待上货」批次 → 直接复用。
      batchRow = q.batchByStatusDeviceSn(store, 1, deviceSn)
      // ② 还没派车（组单中 status=0）：商家站在车前扫码 = 明确指定了这台车，就把批次派给它。
      //    修复：此前只认 status=1，而新订单产生的是 status=0 且 device_sn 为空，
      //    导致「有单但没先点派车」时扫码必然报「没有批次」——而走到车前扫码本是商家最自然的动作。
      if (!batchRow) {
        const open = q.batchesByStatusIn(store, [0], 'ASC', 3)
        for (const cand of open) {
          try {
            await s.doDispatchBatch(store, deps, cand.id, deviceSn)
            batchRow = q.batchByStatusDeviceSn(store, 1, deviceSn)
            break
          } catch (e) {
            // 被并发扫码抢走 → 试下一批；车忙/离线等真实故障 → 把可操作提示原样交给商家
            if (String((e && e.message) || '').indexOf('已派车') === -1) {
              return res.status(400).json({ code: 400, msg: e.message })
            }
          }
        }
      }
    }
    if (!batchRow) {
      const otherReady = q.batchesByStatusIn(store, [1], 'ASC', 1)
      return res.status(404).json({
        code: 404,
        msg: otherReady.length
          ? '本车暂无待上货批次：待上货批次已派给其他无人车，请扫对应车辆'
          : '当前没有待配单的订单，新订单接单后会自动组单，请稍后再试'
      })
    }
    // 记录设备编号到批次与批次内任务
    q.setBatchDeviceSn(store, batchRow.id, deviceSn)
    q.setBatchTasksDeviceSn(store, batchRow.id, deviceSn)
    batchRow.device_sn = deviceSn
    const detail = deps.batch.getBatchDetail(store, batchRow.id)
    const g = await deps.platform.grantControl(deviceSn)
    // 需求3：附带无人车是否已在上货点，供上货页展示「已就位 ✓ / 距上货点 N 米」
    const lp = await deps.platform.robotAtLoadingPoint(store, deviceSn)
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
  router.post('/merchant/device/open-bin', merchantGuard, async (req, res) => {
    const task = s.getLoadingTask(store, req.body)
    if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
    if (!task.platform_task_id) return res.status(400).json({ code: 400, msg: '任务未下发到平台' })
    // 需求3门禁：无人车必须已到达上货点才能开舱上货（真实档校验；演示档恒通过）
    const gate = await deps.platform.robotAtLoadingPoint(store, task.device_sn)
    if (!gate.ok) return res.status(400).json({ code: 400, msg: '开舱失败：' + gate.msg })
    const r = await deps.platform.loadingVerify(task.device_sn, task.platform_task_id, { anyCode: task.pickup_code })
    if (r.ok) {
      audit(req, 'device/open-bin', 'task#' + task.id, 'order#' + task.order_id + ' device_sn=' + task.device_sn)
      ok(res)
    } else {
      res.status(502).json({ code: 502, msg: r.msg })
    }
  })

  // 关闭舱门（关舱等待，不派发；机器人原地等待，滑块/按钮触发 dispatch 才派发）
  router.post('/merchant/device/close-bin', merchantGuard, async (req, res) => {
    const task = s.getLoadingTask(store, req.body)
    if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
    if (!task.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
    const r = await deps.platform.drawerCtrl(task.device_sn, 0)
    if (r.ok) {
      audit(req, 'device/close-bin', 'task#' + task.id, 'order#' + task.order_id + ' device_sn=' + task.device_sn)
      ok(res)
    } else {
      res.status(502).json({ code: 502, msg: r.msg })
    }
  })

  // 开始配送（确认上货）
  router.post('/merchant/device/dispatch', merchantGuard, async (req, res) => {
    const task = s.getLoadingTask(store, req.body)
    if (!task) return res.status(404).json({ code: 404, msg: '任务不存在' })
    if (!task.platform_task_id) return res.status(400).json({ code: 400, msg: '任务未下发到平台' })
    if (!task.device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号，请先扫码' })
    const r = await deps.platform.loadingConfirm(task.device_sn, task.platform_task_id, { anyCode: task.pickup_code })
    if (r.ok) {
      audit(req, 'device/dispatch', 'task#' + task.id, 'order#' + task.order_id + ' device_sn=' + task.device_sn)
      ok(res)
    } else {
      res.status(502).json({ code: 502, msg: r.msg })
    }
  })

  return router
}
