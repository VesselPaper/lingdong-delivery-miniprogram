// admin 域路由（薄路由壳）：数据可视化大屏（只读聚合，免登录）+ 管理员工具（修复机器人状态）
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// deps = { runtime, platform, goods, order, orderCancel }

const express = require('express')
const { createShared } = require('../_shared')
const q = require('./queries')
const s = require('./service')
// 管理员账号服务（方案A）：scrypt 密码 + 随机 session token
const adminAuth = require('../../services/adminAuth')

// 登录限流（内存）：同一「账号+IP」连续失败 ADMIN_LOGIN_MAX 次后锁定窗口
// f = { count: 失败次数, until: 锁定截止时间戳（0 = 未锁定） }
const loginFails = new Map()
const LOGIN_MAX = Number(process.env.ADMIN_LOGIN_MAX || 5)
const LOGIN_WINDOW_MS = Number(process.env.ADMIN_LOGIN_WINDOW_MS || 10 * 60 * 1000)
function loginLocked(key) {
  const f = loginFails.get(key)
  if (!f) return false
  if (f.until && Date.now() < f.until) return true     // 锁定窗口内
  if (f.until && Date.now() >= f.until) loginFails.delete(key)  // 窗口已过，清掉计数
  return false
}
function recordLoginFail(key) {
  const f = loginFails.get(key) || { count: 0, until: 0 }
  f.count += 1
  if (f.count >= LOGIN_MAX && !f.until) f.until = Date.now() + LOGIN_WINDOW_MS
  loginFails.set(key, f)
  if (loginFails.size > 10000) {  // 防泄漏：清掉已过期的，仍超则删最早一条
    const now = Date.now()
    for (const [k, v] of loginFails) if (v.until && now > v.until) loginFails.delete(k)
    if (loginFails.size > 10000) loginFails.delete(loginFails.keys().next().value)
  }
}

module.exports = (store, deps) => {
  const { adminGuard, audit, ok } = createShared(store)
  const router = express.Router()
  // 订单取消/退款统一走 order 域落账入口（orderCancel + platform 是它需要的跨域依赖）
  const orderDeps = { orderCancel: deps.orderCancel, platform: deps.platform }

  // ---------- 数据可视化大屏（只读聚合，免登录） ----------
  // 地图底图（同源代理）：平台签名直链几十秒就过期，交给浏览器必然间歇性 403 白图，
  // 故由后端取字节 + 缓存，前端只认这个稳定地址（大屏 index.html 的 map_url 就是它）。
  let mapImgCache = { ts: 0, buf: null, type: 'image/png' }
  const MAP_IMG_CACHE_MS = Number(process.env.DASHBOARD_MAP_CACHE_MS || 10 * 60 * 1000)

  router.get('/dashboard/map-image', async (req, res) => {
    if (mapImgCache.buf && Date.now() - mapImgCache.ts < MAP_IMG_CACHE_MS) {
      res.set('Content-Type', mapImgCache.type)
      res.set('Cache-Control', 'public, max-age=300')
      return res.send(mapImgCache.buf)
    }
    try {
      const r = await deps.platform.getMapImageBytes(store)
      if (!r.ok || !r.buf || !r.buf.length) {
        return res.status(502).json({ code: 502, msg: r.msg || '底图获取失败' })
      }
      mapImgCache = { ts: Date.now(), buf: r.buf, type: r.contentType || 'image/png' }
      res.set('Content-Type', mapImgCache.type)
      res.set('Cache-Control', 'public, max-age=300')
      res.send(mapImgCache.buf)
    } catch (e) {
      res.status(502).json({ code: 502, msg: e.message || '底图获取异常' })
    }
  })

  // 平台调用结果缓存 5 秒（可用 DASHBOARD_CACHE_MS 调整）：防止大屏高频轮询把 runtimeStatusList
  // 变成串行同步请求拖死事件循环 —— 与地图 60s 缓存、位置 3s 缓存同一套思路。
  let dashCache = { ts: 0, data: null }
  const DASH_CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS || 5000)

  router.get('/dashboard/overview', async (req, res) => {
    if (dashCache.data && Date.now() - dashCache.ts < DASH_CACHE_MS) return ok(res, dashCache.data)
    const data = await s.buildDashboard(store, deps)
    dashCache = { ts: Date.now(), data }
    ok(res, data)
  })

  // 前端底图用配置（天地图浏览器端 tk，存于 .env，随页面注入，不进仓库）
  router.get('/config/tianditu', (req, res) => {
    ok(res, { tk: process.env.TIANDITU_TK || '', ts: new Date().toISOString() })
  })

  // ---------- 管理员登录（方案A：用户名+密码 → 随机 session token） ----------
  router.post('/admin/login', (req, res) => {
    const { username = '', password = '' } = req.body || {}
    const key = String(username || '').trim().toLowerCase() + ':' + (req.ip || req.socket.remoteAddress || '')
    if (loginLocked(key)) {
      return res.status(429).json({ code: 429, msg: '尝试次数过多，请 10 分钟后再试' })
    }
    const admin = adminAuth.findByUsername(store, username)
    if (!admin || Number(admin.status) !== 1 || !adminAuth.verifyPassword(password, admin.password_hash)) {
      recordLoginFail(key)
      return res.status(401).json({ code: 401, msg: '用户名或密码错误' })
    }
    loginFails.delete(key)
    store.prepare("UPDATE admin_users SET last_login_at=datetime('now','localtime') WHERE id=?").run(admin.id)
    req.admin = { id: admin.id, username: admin.username, nickname: admin.nickname || '', role: admin.role || 'admin' }
    const sess = adminAuth.issueSession(store, admin.id)
    audit(req, 'admin/login', 'admin#' + admin.id, 'username=' + admin.username)
    ok(res, { token: sess.token, admin: req.admin })
  })

  // 当前登录管理员（前端启动/刷新时校验会话）
  router.get('/admin/me', adminGuard, (req, res) => ok(res, { admin: req.admin }))

  // 退出登录：吊销当前 session
  router.post('/admin/logout', adminGuard, (req, res) => {
    adminAuth.revokeSession(store, req.headers['x-admin-token'])
    audit(req, 'admin/logout', 'admin#' + req.admin.id, req.admin.username)
    ok(res)
  })

  // 修改自己的密码：改后吊销该账号全部 session，强制重新登录
  router.post('/admin/password', adminGuard, (req, res) => {
    const { old_password = '', new_password = '' } = req.body || {}
    const admin = store.prepare('SELECT * FROM admin_users WHERE id=?').get(req.admin.id)
    if (!adminAuth.verifyPassword(old_password, admin.password_hash)) {
      return res.status(400).json({ code: 400, msg: '原密码不正确' })
    }
    if (!new_password || String(new_password).length < 8) {
      return res.status(400).json({ code: 400, msg: '新密码至少 8 位' })
    }
    store.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(adminAuth.hashPassword(new_password), admin.id)
    adminAuth.revokeAllSessions(store, admin.id)
    audit(req, 'admin/password', 'admin#' + admin.id, '修改密码')
    ok(res, { msg: '密码已修改，请重新登录' })
  })

  // ---------- 管理员工具（查看/修复机器人状态） ----------
  // 状态总览：设备 + 平台活跃任务 + 本地批次/订单/任务 + 死锁/异常检测
  router.get('/admin/state', adminGuard, async (req, res) => {
    ok(res, await s.buildAdminState(store, deps))
  })

  // 令牌校验：前端「令牌」输入框提交后验证（对=200，错=401），用于即时反馈正确/错误
  router.get('/admin/verify', adminGuard, (req, res) => {
    ok(res, { valid: true, admin: true })
  })

  // 管理端地图（管理员页总览复用大屏同一份 getMapOverview，adminGuard 鉴权 + 3s 缓存）
  let adminMapCache = { ts: 0, data: null }
  router.get('/admin/map', adminGuard, async (req, res) => {
    if (adminMapCache.data && Date.now() - adminMapCache.ts < 3000) return ok(res, adminMapCache.data)
    const m = await deps.platform.getMapOverview(store)
    if (!m.ok) return res.status(502).json({ code: 502, msg: m.msg || '地图获取失败' })
    adminMapCache = { ts: Date.now(), data: m }
    ok(res, m)
  })

  // 批次内订单全量（批次表展开箭头懒加载；不受 history 条数上限影响）
  router.get('/admin/batch/orders', adminGuard, async (req, res) => {
    const batchId = Number((req.query || {}).batch_id || 0)
    const b = q.batchById(store, batchId)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    ok(res, { batch: b, orders: q.orderCards(store, q.batchOrdersAll(store, batchId)) })
  })

  // 机器人实时雷达数据（eviz 激光点云 + 代价地图 + 位姿），页面轮询绘制雷达图
  router.get('/admin/radar', adminGuard, async (req, res) => {
    const sn = String((req.query && req.query.device_sn) || '')
    const r = await deps.platform.getRobotRadar(store, sn)
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 召唤机器人到上货点
  router.post('/admin/summon', adminGuard, async (req, res) => {
    const r = await deps.platform.summonToLoadingPoint(store, String((req.body || {}).device_sn || ''))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 取消排队任务（status<10 未被拉取）
  router.post('/admin/task/cancel', adminGuard, async (req, res) => {
    const { platform_task_id = '' } = req.body || {}
    if (!platform_task_id) return res.status(400).json({ code: 400, msg: '缺少平台任务ID' })
    const r = await deps.platform.cancelQueueTask(platform_task_id)
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 关闭任务（舱内有货会自动开舱）
  router.post('/admin/task/close', adminGuard, async (req, res) => {
    const { device_sn = '', platform_task_id = '' } = req.body || {}
    if (!device_sn || !platform_task_id) return res.status(400).json({ code: 400, msg: '缺少设备编号或任务ID' })
    const r = await deps.platform.closeTask(device_sn, platform_task_id, '管理员手动关闭')
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 删除预创建任务（预创建后不再继续，立即关舱）
  router.post('/admin/precreate/del', adminGuard, async (req, res) => {
    const r = await deps.platform.deletePreCreateTask(String((req.body || {}).device_sn || ''))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 开/关舱门（drawerCtrl 独立控制，不影响任务状态）
  router.post('/admin/drawer', adminGuard, async (req, res) => {
    const { device_sn = '', cmd = 1 } = req.body || {}
    const r = await deps.platform.drawerCtrl(String(device_sn), Number(cmd))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 召唤可选目标点（上货点/充电点/取货点）
  router.get('/admin/robot/summon-targets', adminGuard, async (req, res) => {
    const r = await deps.platform.getSummonTargets(store)
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 召唤机器人到指定点位（含充电点；召唤会中断正在执行的配送任务）
  router.post('/admin/robot/summon', adminGuard, async (req, res) => {
    const { device_sn = '', landmark_id = '' } = req.body || {}
    if (!landmark_id) return res.status(400).json({ code: 400, msg: '缺少目标点位' })
    const r = await deps.platform.summonToPoint(store, String(device_sn), String(landmark_id))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 机器人驻停（stopTime 秒后自动恢复）
  router.post('/admin/robot/stop', adminGuard, async (req, res) => {
    const { device_sn = '', stop_time = 30 } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const r = await deps.platform.stopRobot(String(device_sn), Number(stop_time))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 机器人继续工作（恢复任务）
  router.post('/admin/robot/recover', adminGuard, async (req, res) => {
    const { device_sn = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const r = await deps.platform.recoverRobot(store, String(device_sn))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 停止并取消正在做的任务（先关闭活跃任务，再驻停）
  router.post('/admin/robot/stop-cancel', adminGuard, async (req, res) => {
    const { device_sn = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const r = await deps.platform.stopAndCancelTask(store, String(device_sn))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 获取设备控制权
  router.post('/admin/control/grant', adminGuard, async (req, res) => {
    const r = await deps.platform.grantControl(String((req.body || {}).device_sn || ''), 600)
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 释放设备控制权（ctrl-id 放 header；body 为 deviceSn+principalId）
  router.post('/admin/control/release', adminGuard, async (req, res) => {
    const { device_sn = '', ctrl_id = '' } = req.body || {}
    const r = await deps.platform.releaseControl(String(device_sn), String(ctrl_id))
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg })
  })

  // 同步点位（从平台 landmarks 拉到本地库）
  router.post('/admin/landmarks/sync', adminGuard, async (req, res) => {
    const r = await deps.platform.syncLandmarks(store)
    r.ok ? ok(res, r) : res.status(400).json({ code: 400, msg: r.msg || '同步失败' })
  })

  // 本地取消订单（cancelLocal：作废任务+回补库存+摘批次；随后平台召回关任务）
  router.post('/admin/order/cancel', adminGuard, async (req, res) => {
    const order = q.orderById(store, Number((req.body || {}).order_id || 0))
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const r = await deps.order.applyOrderCancelled(store, orderDeps, order, { reason: '管理员清理' })
    ok(res, { claimed: r.claimed, final_status: r.finalStatus, tasks: r.tasks.length })
  })

  // 关闭平台任务 + 本地作废（一键）：删除「订单任务」的完整动作
  router.post('/admin/task/close-void', adminGuard, async (req, res) => {
    const taskId = Number((req.body || {}).task_id || 0)
    const t = q.taskById(store, taskId)
    if (!t) return res.status(404).json({ code: 404, msg: '任务不存在' })
    const out = { task_id: taskId, closed: false, voided: false }
    if (t.device_sn && t.platform_task_id && Number(t.task_status) < 80 && !t.void_at) {
      const r = await deps.platform.closeTask(t.device_sn, t.platform_task_id, '管理员关闭+作废')
      if (!r.ok) return res.status(502).json({ code: 502, msg: r.msg })
      out.closed = true
    }
    q.voidTask(store, taskId, '管理员作废')
    out.voided = true
    ok(res, out)
  })

  // 清理批次：删除批次内全部活跃订单（平台召回+本地取消）+ 释放控制权 + 批次置4
  router.post('/admin/batch/cancel', adminGuard, async (req, res) => {
    const batchId = Number((req.body || {}).batch_id || 0)
    const b = q.batchById(store, batchId)
    if (!b) return res.status(404).json({ code: 404, msg: '批次不存在' })
    const out = { batch_id: batchId, cancelled: 0, failed: [] }
    if (b.ctrl_id) {
      try {
        const rel = await deps.platform.releaseControl(b.device_sn, b.ctrl_id)
        if (rel.ok) q.clearBatchCtrl(store, batchId)
        else out.failed.push('释放控制权：' + rel.msg)
      } catch (e) { out.failed.push('释放控制权：' + e.message) }
    }
    const orders = q.batchOrders(store, batchId)
    for (const o of orders) {
      try {
        const r = await deps.order.applyOrderCancelled(store, orderDeps, o, { reason: '管理员清理批次' })
        if (r.claimed) out.cancelled++
      } catch (e) { out.failed.push('order#' + o.id + ': ' + e.message) }
    }
    q.cleanBatch(store, batchId)
    audit(req, 'admin/batch-cancel', 'batch#' + batchId, 'cancelled=' + out.cancelled)
    ok(res, out)
  })

  // 批量删除订单（多选 / 右键菜单）：逐单走 order 域统一落账（作废任务+回补库存+摘批次+平台召回关任务），
  // 保证机器人状态、用户端与商家端同步，避免「订单删了、车还卡在送货」死锁。逐单容错，失败项单独列出。
  router.post('/admin/orders/bulk-cancel', adminGuard, async (req, res) => {
    const ids = Array.isArray((req.body || {}).order_ids)
      ? [...new Set((req.body.order_ids || []).map(Number).filter((n) => n > 0))]
      : []
    if (!ids.length) return res.status(400).json({ code: 400, msg: '请选择要删除的订单' })
    const out = { cancelled: 0, failed: [] }
    for (const id of ids) {
      const o = q.orderById(store, id)
      if (!o) { out.failed.push('订单#' + id + ' 不存在'); continue }
      try {
        const r = await deps.order.applyOrderCancelled(store, orderDeps, o, { reason: '管理员批量删除' })
        if (r.claimed) out.cancelled++
        else out.failed.push('订单#' + id + ' 已是终态，无需处理')
      } catch (e) { out.failed.push('订单#' + id + ': ' + e.message) }
    }
    audit(req, 'admin/orders-bulk-cancel', ids.join(','), 'cancelled=' + out.cancelled)
    ok(res, out)
  })

  // 批量清理批次（多选 / 右键菜单）：逐批释放控制权 + 取消批内活跃订单 + 批次置4
  router.post('/admin/batches/bulk-cancel', adminGuard, async (req, res) => {
    const ids = Array.isArray((req.body || {}).batch_ids)
      ? [...new Set((req.body.batch_ids || []).map(Number).filter((n) => n > 0))]
      : []
    if (!ids.length) return res.status(400).json({ code: 400, msg: '请选择要清理的批次' })
    const out = { cleaned: 0, cancelled: 0, failed: [] }
    for (const batchId of ids) {
      const b = q.batchById(store, batchId)
      if (!b) { out.failed.push('批次#' + batchId + ' 不存在'); continue }
      try {
        if (b.ctrl_id) {
          const rel = await deps.platform.releaseControl(b.device_sn, b.ctrl_id)
          if (rel.ok) q.clearBatchCtrl(store, batchId)
          else out.failed.push('批次#' + batchId + ' 释放控制权：' + rel.msg)
        }
        const orders = q.batchOrders(store, batchId)
        for (const o of orders) {
          try {
            const r = await deps.order.applyOrderCancelled(store, orderDeps, o, { reason: '管理员批量清理批次' })
            if (r.claimed) out.cancelled++
          } catch (e) { out.failed.push('批次#' + batchId + ' 订单#' + o.id + ': ' + e.message) }
        }
        q.cleanBatch(store, batchId)
        out.cleaned++
      } catch (e) { out.failed.push('批次#' + batchId + ': ' + e.message) }
    }
    audit(req, 'admin/batches-bulk-cancel', ids.join(','), 'cleaned=' + out.cleaned + ',cancelled=' + out.cancelled)
    ok(res, out)
  })

  // 批量关闭+作废任务（多选 / 右键菜单）：平台关任务 + 本地作废，逐项容错
  router.post('/admin/tasks/bulk-close-void', adminGuard, async (req, res) => {
    const ids = Array.isArray((req.body || {}).task_ids)
      ? [...new Set((req.body.task_ids || []).map(Number).filter((n) => n > 0))]
      : []
    if (!ids.length) return res.status(400).json({ code: 400, msg: '请选择要关闭的任务' })
    const out = { closed: 0, voided: 0, failed: [] }
    for (const taskId of ids) {
      const t = q.taskById(store, taskId)
      if (!t) { out.failed.push('任务#' + taskId + ' 不存在'); continue }
      try {
        if (t.device_sn && t.platform_task_id && Number(t.task_status) < 80 && !t.void_at) {
          const r = await deps.platform.closeTask(t.device_sn, t.platform_task_id, '管理员批量关闭+作废')
          if (!r.ok) { out.failed.push('任务#' + taskId + ': ' + r.msg); continue }
          out.closed++
        }
        q.voidTask(store, taskId, '管理员批量作废')
        out.voided++
      } catch (e) { out.failed.push('任务#' + taskId + ': ' + e.message) }
    }
    audit(req, 'admin/tasks-bulk-close-void', ids.join(','), 'closed=' + out.closed + ',voided=' + out.voided)
    ok(res, out)
  })

  // 一键初始化：关全部平台活跃任务 + 释放全部控制权 + 取消全部活跃订单 + 批次置4
  // 危险操作（前端需二次确认）：把机器人/平台/本地全部打回干净初始态，防止旧任务死锁。
  router.post('/admin/reset', adminGuard, async (req, res) => {
    const out = { closed: 0, released: 0, cancelled: 0, batch_cleaned: 0, failed: [] }
    // 1) 关闭平台活跃任务（本地库有平台任务ID且未终态的，全部 deviceCtrl/close）
    const activeTasks = q.platformActiveTasks(store)
    for (const t of activeTasks) {
      try {
        const r = await deps.platform.closeTask(t.device_sn, t.platform_task_id, '管理员一键初始化')
        if (r.ok) out.closed++
        else out.failed.push('close task#' + t.id + ': ' + r.msg)
      } catch (e) { out.failed.push('close task#' + t.id + ': ' + e.message) }
    }
    // 2) 释放全部控制权（批次行持久化的 ctrl_id）
    const ctrlBatches = q.ctrlBatches(store)
    for (const b of ctrlBatches) {
      try {
        const r = await deps.platform.releaseControl(b.device_sn, b.ctrl_id)
        if (r.ok) { out.released++; q.clearBatchCtrl(store, b.id) }
        else out.failed.push('release batch#' + b.id + ': ' + r.msg)
      } catch (e) { out.failed.push('release batch#' + b.id + ': ' + e.message) }
    }
    // 3) 取消全部活跃订单（本地取消 + 平台召回）
    const activeOrders = q.allActiveOrders(store)
    for (const o of activeOrders) {
      try {
        const r = await deps.order.applyOrderCancelled(store, orderDeps, o, { reason: '管理员一键初始化' })
        if (r.claimed) out.cancelled++
      } catch (e) { out.failed.push('order#' + o.id + ': ' + e.message) }
    }
    // 4) 批次全部置4（含空批次与组单中批次）
    const activeBatches = q.allActiveBatches(store)
    for (const b of activeBatches) {
      q.cleanBatch(store, b.id)
      out.batch_cleaned++
    }
    audit(req, 'admin/reset', 'one-shot', JSON.stringify({ closed: out.closed, released: out.released, cancelled: out.cancelled, batch_cleaned: out.batch_cleaned }))
    ok(res, out)
  })

  // 本地作废任务（置 110 + void_at）
  router.post('/admin/task/void', adminGuard, async (req, res) => {
    const taskId = Number((req.body || {}).task_id || 0)
    const t = q.taskById(store, taskId)
    if (!t) return res.status(404).json({ code: 404, msg: '任务不存在' })
    q.voidTask(store, taskId, '管理员作废')
    ok(res, { task_id: taskId })
  })

  return router
}
