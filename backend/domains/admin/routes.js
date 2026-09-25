// admin 域路由（薄路由壳）：数据可视化大屏（只读聚合，免登录）+ 管理员工具（修复机器人状态）
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// deps = { runtime, platform, goods, order, orderCancel }

const express = require('express')
const { createShared } = require('../_shared')
const q = require('./queries')
const s = require('./service')
// 管理员账号服务（方案A）：scrypt 密码 + 随机 session token
const adminAuth = require('../../services/adminAuth')
// 商家账号（user 域 users 表：账号密码登录 + 店主/店员分级，2026-09-24 起替代邀请码体系）
const uq = require('../user/queries')

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

  // 审计日志（管理页「操作日志」）：读服务端持久化的 audit_logs，成功与失败都在。
  // 默认只看管理员（user_role='admin'）；role=all 看全部（含商家/用户端的写操作）。
  // 写入由 domains/_shared.js → auditMw 中间件统一负责，本接口只读。
  router.get('/admin/audit', adminGuard, (req, res) => {
    const query = req.query || {}
    const role = query.role === undefined ? 'admin' : String(query.role)
    const okRaw = query.ok
    ok(res, q.auditLogs(store, {
      limit: query.limit,
      offset: query.offset,
      action: query.action ? String(query.action) : '',
      role: role === 'all' ? '' : role,
      ok: (okRaw === undefined || okRaw === '') ? undefined : Number(okRaw)
    }))
  })

  // 状态时间线（管理页详情抽屉）：status_events 真实事件优先；老数据无事件时给「推断节点」。
  // type=batch 时合并批内订单事件（一次看清整批流转）。
  router.get('/admin/timeline', adminGuard, (req, res) => {
    const query = req.query || {}
    const type = String(query.type || '')
    const id = Number(query.id || 0)
    if (!id || ['order', 'batch', 'task'].indexOf(type) < 0) {
      return res.status(400).json({ code: 400, msg: '参数不合法：需要 type=order|batch|task 与 id' })
    }
    const r = s.buildTimeline(store, type, id)
    if (!r) return res.status(404).json({ code: 404, msg: '对象不存在' })
    ok(res, r)
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
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/task-cancel', 'platform_task#' + platform_task_id, '取消排队任务')
    ok(res, r)
  })

  // 关闭任务（舱内有货会自动开舱）
  router.post('/admin/task/close', adminGuard, async (req, res) => {
    const { device_sn = '', platform_task_id = '' } = req.body || {}
    if (!device_sn || !platform_task_id) return res.status(400).json({ code: 400, msg: '缺少设备编号或任务ID' })
    const r = await deps.platform.closeTask(device_sn, platform_task_id, '管理员手动关闭')
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/task-close', 'platform_task#' + platform_task_id, '关闭平台任务（设备 ' + device_sn + '，舱内有货自动开舱）')
    ok(res, r)
  })

  // 删除预创建任务（预创建后不再继续，立即关舱）
  router.post('/admin/precreate/del', adminGuard, async (req, res) => {
    const sn = String((req.body || {}).device_sn || '')
    const r = await deps.platform.deletePreCreateTask(sn)
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/precreate-del', 'device#' + sn, '删除预创建任务（立即关舱）')
    ok(res, r)
  })

  // 开/关舱门（drawerCtrl 独立控制，不影响任务状态）
  router.post('/admin/drawer', adminGuard, async (req, res) => {
    const { device_sn = '', cmd = 1 } = req.body || {}
    const r = await deps.platform.drawerCtrl(String(device_sn), Number(cmd))
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/drawer', 'device#' + device_sn, Number(cmd) ? '开舱' : '关舱')
    ok(res, r)
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
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/robot-summon', 'device#' + device_sn, '召唤到点位 ' + landmark_id + '（会中断正在执行的配送任务）')
    ok(res, r)
  })

  // 机器人驻停（stopTime 秒后自动恢复）
  router.post('/admin/robot/stop', adminGuard, async (req, res) => {
    const { device_sn = '', stop_time = 30 } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const r = await deps.platform.stopRobot(String(device_sn), Number(stop_time))
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/robot-stop', 'device#' + device_sn, '驻停 ' + Number(stop_time) + ' 秒后自动恢复')
    ok(res, r)
  })

  // 机器人继续工作（恢复任务）
  router.post('/admin/robot/recover', adminGuard, async (req, res) => {
    const { device_sn = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const r = await deps.platform.recoverRobot(store, String(device_sn))
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/robot-recover', 'device#' + device_sn, '恢复任务执行')
    ok(res, r)
  })

  // 停止并取消正在做的任务（先关闭活跃任务，再驻停）
  router.post('/admin/robot/stop-cancel', adminGuard, async (req, res) => {
    const { device_sn = '' } = req.body || {}
    if (!device_sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const r = await deps.platform.stopAndCancelTask(store, String(device_sn))
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    audit(req, 'admin/robot-stop-cancel', 'device#' + device_sn, '关闭活跃任务 ' + (r.closed || 0) + ' 个并驻停')
    ok(res, r)
  })

  // 取消机器人当前的全部任务（管理页「更多操作 → 停止并取消任务」）
  // 与旧 /robot/stop-cancel 的区别（旧接口保留作兼容，前端不再调用）：
  //   ① 旧接口只关「平台任务」且最多 3 个，不回补库存、不摘批次 → 本地订单会卡在「配送中」；
  //   ② 本接口枚举该设备全部任务并逐个关闭，且对关联本地订单走 order 域统一落账
  //      （作废任务 + 回补库存 + 摘批次 + 平台召回），批次置 4，双端一致、不留脏数据。
  // 顺序：先枚举 → 再本地落账（内含平台召回，记录已处理的任务）→ 关闭剩余孤儿任务 → 批次置 4。
  router.post('/admin/robot/cancel-tasks', adminGuard, async (req, res) => {
    const sn = String((req.body || {}).device_sn || '')
    if (!sn) return res.status(400).json({ code: 400, msg: '缺少设备编号' })
    const out = { device_sn: sn, closed: 0, cancelled: 0, batch_cleaned: 0, failed: [], source: '' }

    // ① 枚举该设备当前任务：优先平台货舱查询（权威），失败回退本地活跃任务
    const ids = []
    const qt = await deps.platform.queryDeviceTasks(sn)
    if (qt.ok && (qt.tasks || []).length) {
      out.source = 'platform'
      for (const t of qt.tasks) if (t.taskId) ids.push(String(t.taskId))
    } else {
      out.source = qt.ok ? 'platform-empty' : 'local-fallback'
      const local = await deps.platform.deviceActiveTasks(store, sn)
      for (const t of (local || [])) if (t.id) ids.push(String(t.id))
    }
    const uniq = [...new Set(ids)]

    // ② 关联本地订单统一落账（内含平台召回）；记录其平台任务，避免下一步重复关闭
    const handled = new Set()
    for (const o of q.activeOrdersByDevice(store, sn)) {
      try {
        const r = await deps.order.applyOrderCancelled(store, orderDeps, o, { reason: '管理员取消机器人全部任务' })
        if (r.claimed) out.cancelled++
        for (const t of (r.tasks || [])) if (t && t.platform_task_id) handled.add(String(t.platform_task_id))
      } catch (e) { out.failed.push('订单#' + o.id + '：' + e.message) }
    }

    // ③ 关闭剩余平台任务（订单落账未覆盖的孤儿任务），逐项容错
    for (const pid of uniq) {
      if (handled.has(pid)) continue
      try {
        const r = await deps.platform.closeTask(sn, pid, '管理员取消机器人全部任务')
        if (r.ok) out.closed++
        else out.failed.push('平台任务 ' + pid + '：' + r.msg)
      } catch (e) { out.failed.push('平台任务 ' + pid + '：' + e.message) }
    }

    // ③b 把「经订单统一落账关闭」的平台任务也计入 closed —— 否则会出现
    //     「取消了 N 单但 closed=0」这种看起来像没关任务的误导（recall_status=1 表示平台召回成功）
    if (handled.size) {
      const hids = [...handled]
      const ph = hids.map(() => '?').join(',')
      try {
        out.closed += store.prepare(
          `SELECT COUNT(*) c FROM delivery_tasks WHERE platform_task_id IN (${ph}) AND recall_status=1`).get(...hids).c
      } catch (e) { /* 统计失败不影响主流程 */ }
    }

    // ④ 该设备涉及的活跃批次置 4
    for (const b of q.activeBatchesByDevice(store, sn)) { q.cleanBatch(store, b.id); out.batch_cleaned++ }

    audit(req, 'admin/robot-cancel-tasks', 'device#' + sn,
      '关闭平台任务 ' + out.closed + '，取消订单 ' + out.cancelled + '，清理批次 ' + out.batch_cleaned
      + '，失败 ' + out.failed.length + '（枚举来源 ' + out.source + '）')
    ok(res, out)
  })

  // 获取设备控制权
  router.post('/admin/control/grant', adminGuard, async (req, res) => {
    const sn = String((req.body || {}).device_sn || '')
    const r = await deps.platform.grantControl(sn, 600)
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    // 控制权 ID 持久化：此前直接丢弃返回值，导致「释放控制权」必须人工输入 ID
    const ctrlId = String((r.data && (r.data.ctrlId || r.data.sessionId || r.data.id)) || '')
    if (sn && ctrlId) q.setMeta(store, 'ctrl_id:' + sn, ctrlId)
    audit(req, 'admin/control-grant', 'device#' + sn, '获取控制权 600 秒' + (ctrlId ? '' : '（平台未返回 ctrlId）'))
    ok(res, r)
  })

  // 释放设备控制权（ctrl-id 放 header；body 为 deviceSn+principalId）
  // ctrl_id 可省：优先用请求体，否则读获取时持久化到 meta 的值（前端不再需要人工输入）
  router.post('/admin/control/release', adminGuard, async (req, res) => {
    const { device_sn = '', ctrl_id = '' } = req.body || {}
    const sn = String(device_sn)
    const id = String(ctrl_id) || String(q.getMeta(store, 'ctrl_id:' + sn) || '')
    if (!id) return res.status(400).json({ code: 400, msg: '缺少控制权ID（未记录该设备的控制权，或已被释放）' })
    const r = await deps.platform.releaseControl(sn, id)
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg })
    q.delMeta(store, 'ctrl_id:' + sn)
    audit(req, 'admin/control-release', 'device#' + sn, '释放控制权')
    ok(res, r)
  })

  // 同步点位（从平台 landmarks 拉到本地库）
  router.post('/admin/landmarks/sync', adminGuard, async (req, res) => {
    const r = await deps.platform.syncLandmarks(store)
    if (!r.ok) return res.status(400).json({ code: 400, msg: r.msg || '同步失败' })
    audit(req, 'admin/landmarks-sync', 'landmarks', '点位同步 ' + (r.count === undefined ? '' : r.count + ' 个'))
    ok(res, r)
  })

  // 本地取消订单（cancelLocal：作废任务+回补库存+摘批次；随后平台召回关任务）
  router.post('/admin/order/cancel', adminGuard, async (req, res) => {
    const order = q.orderById(store, Number((req.body || {}).order_id || 0))
    if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' })
    const r = await deps.order.applyOrderCancelled(store, orderDeps, order, { reason: '管理员清理' })
    audit(req, 'admin/order-cancel', 'order#' + order.id,
      '订单 ' + (order.order_no || order.id) + ' 取消：claimed=' + r.claimed + ' 终态=' + r.finalStatus + ' 平台任务=' + r.tasks.length)
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
    audit(req, 'admin/task-close-void', 'task#' + taskId, '关闭平台任务=' + out.closed + ' 本地作废=' + out.voided)
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
    audit(req, 'admin/task-void', 'task#' + taskId, '仅本地作废（不关平台任务）')
    ok(res, { task_id: taskId })
  })

  // ---------- 商家账号管理（管理员网页「商家管理」页，2026-09-24 起替代邀请码） ----------
  // 商家端登录改为「账号密码」（user 域 users 表：username + scrypt 密码 + 店主/店员分级）。
  // 列表只出管理字段（用户名/昵称/角色/状态/创建时间），绝不返回密码哈希与 token。

  // 商家账号列表
  router.get('/admin/merchants', adminGuard, (req, res) => {
    const rows = uq.merchantList(store)
    ok(res, {
      merchants: rows.map((r) => ({
        id: r.id,
        username: r.username || '',
        name: r.nickname || '',
        merchant_role: r.merchant_role === 'owner' ? 'owner' : 'staff',
        active: Number(r.status) === 1,
        created_at: r.created_at || ''
      }))
    })
  })

  // 创建商家账号：用户名+初始密码必填，角色（店主/店员）默认店员；昵称即店名（选填）
  router.post('/admin/merchants/create', adminGuard, (req, res) => {
    const { username = '', password = '', merchant_role = 'staff', nickname = '' } = req.body || {}
    const u = String(username).trim()
    if (!u) return res.status(400).json({ code: 400, msg: '请填写用户名' })
    if (!/^[A-Za-z0-9_]{2,32}$/.test(u)) return res.status(400).json({ code: 400, msg: '用户名限 2~32 位字母/数字/下划线' })
    if (uq.findByUsername(store, u)) return res.status(400).json({ code: 400, msg: '用户名已存在' })
    if (!password || String(password).length < 6) return res.status(400).json({ code: 400, msg: '密码至少 6 位' })
    const id = uq.createMerchantAccount(store, {
      username: u,
      passwordHash: adminAuth.hashPassword(String(password)),
      nickname: String(nickname || ''),
      merchantRole: merchant_role === 'owner' ? 'owner' : 'staff'
    })
    audit(req, 'admin/merchant-create', 'merchant-user#' + id, '创建商家账号 ' + u + '（角色 ' + (merchant_role === 'owner' ? '店主' : '店员') + '）')
    ok(res, { id, username: u })
  })

  // 修改角色（店主 <-> 店员）
  router.put('/admin/merchants/role', adminGuard, (req, res) => {
    const id = Number((req.body || {}).id || 0)
    const role = (req.body || {}).merchant_role === 'owner' ? 'owner' : 'staff'
    if (!id) return res.status(400).json({ code: 400, msg: '缺少商家账号编号' })
    const row = store.prepare('SELECT username, merchant_role FROM users WHERE id=?').get(id)
    if (!row) return res.status(404).json({ code: 404, msg: '商家账号不存在' })
    uq.updateMerchantRole(store, id, role)
    audit(req, 'admin/merchant-role', 'merchant-user#' + id, row.username + ' 角色 ' + (row.merchant_role === 'owner' ? '店主' : '店员') + '→' + (role === 'owner' ? '店主' : '店员'))
    ok(res, { id })
  })

  // 重置密码：同时吊销当前 token（强制用新密码重新登录）
  router.post('/admin/merchants/password', adminGuard, (req, res) => {
    const id = Number((req.body || {}).id || 0)
    const password = String((req.body || {}).password || '')
    if (!id) return res.status(400).json({ code: 400, msg: '缺少商家账号编号' })
    if (password.length < 6) return res.status(400).json({ code: 400, msg: '新密码至少 6 位' })
    const row = store.prepare('SELECT username FROM users WHERE id=?').get(id)
    if (!row) return res.status(404).json({ code: 404, msg: '商家账号不存在' })
    uq.updateMerchantPassword(store, id, adminAuth.hashPassword(password))
    audit(req, 'admin/merchant-password', 'merchant-user#' + id, '重置密码 ' + row.username)
    ok(res, { id })
  })

  // 禁用 / 启用（禁用同时吊销 token，商家端立即失效）
  const merchantSetStatus = (active) => (req, res) => {
    const id = Number((req.body || {}).id || 0)
    if (!id) return res.status(400).json({ code: 400, msg: '缺少商家账号编号' })
    const row = store.prepare('SELECT username FROM users WHERE id=?').get(id)
    if (!row) return res.status(404).json({ code: 404, msg: '商家账号不存在' })
    uq.setMerchantStatus(store, id, active ? 1 : 0)
    audit(req, active ? 'admin/merchant-enable' : 'admin/merchant-disable', 'merchant-user#' + id, (active ? '启用' : '禁用') + ' ' + row.username)
    ok(res, { id })
  }
  router.post('/admin/merchants/disable', adminGuard, merchantSetStatus(false))
  router.post('/admin/merchants/enable', adminGuard, merchantSetStatus(true))

  return router
}
