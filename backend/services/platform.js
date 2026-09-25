// services/platform.js —— 开放物流平台对接·编排入口（结构评审 P0-2 拆分后主文件）
// ------------------------------------------------------------------
// 按职责拆为三件（均保持 services 层平铺，调用方 require 本入口即可，导出清单不变）：
//   platform-http.js        平台通信/查询/控制基础层（HTTP 原语、点位地图、设备位置/标定、控制、门禁）
//   platform-callbacks.js   回调/轮询状态同步层（applyStatus 唯一咽喉 + 注入的订单状态迁移钩子）
//   platform-mock.js        本地模拟状态机（PLATFORM_MOCK=true 时的任务推进）
// 本文件 = 任务创建/派车/召唤等**业务编排** + 上述三件的聚合导出。
// 字段已按 Apifox「开放物流平台」open-logis_1.0 导出文档（接口\默认模块.openapi.json）核对校正。
// 本地无平台凭据、需要纯本地演示时：显式设置 PLATFORM_MOCK=true 使用本地模拟状态机。
'use strict'

const httpApi = require('./platform-http')
const mock = require('./platform-mock')
const callbacks = require('./platform-callbacks')

const MOCK = httpApi.MOCK

// ---------------- 创建配送任务 ----------------
function createQueueTask(store, order) {
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
  const unloading = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
  const info = store.prepare(
    'INSERT INTO delivery_tasks (order_id, platform_task_id, device_sn, task_status, status_text) VALUES (?,?,?,?,?)'
  ).run(order.id, '', '', 0, '排队中')
  const taskId = Number(info.lastInsertRowid)
  // 订单状态迁移走注入的 orderStateSink（结构评审 P0-1）
  callbacks.emitOrderState(store, { orderId: order.id, taskId, to: 2 })

  if (MOCK) {
    const t = { step: 0, taskId }
    mock.mockTasks.set(taskId, t)
    t.timer = setTimeout(() => mock.mockAdvance(store, taskId), 4000)
  } else {
    realDispatch(store, taskId, order, loading, unloading)
  }
  return taskId
}

// 自动挑选一台可用机器人（在线且空闲/待机/充电中），供批次派车时指派
async function pickAvailableRobot() {
  if (MOCK || !httpApi.platformReady()) return null
  try {
    const r = await httpApi.getDeviceList()
    if (!r.ok || !r.robots || !r.robots.length) return null
    const free = r.robots.find((x) => x.online && ['idle', 'standby', 'charging', 'returnChargingPile', 'returnStandby', 'lightTask'].includes(x.machine_status))
    return free || r.robots.find((x) => x.online) || null
  } catch (e) {
    return null
  }
}

// ---------------- 批次派车：为一车多单批量创建平台任务 ----------------
// 每单一个平台任务（outOrderNo 独立、取餐码独立），同一批次所有任务共用同一设备/货仓；
// 路线在「开始配送（关舱后）」才规划（见 server.js doDispatchBatch 注释），因此本函数 route 可为空：
// 传入 route 时按停靠顺序递减 priority 提示平台按序配送；为空时全部用固定 priority=10（仅提示，不影响目的地）。
async function createTasksForBatch(store, batch, orders, route = []) {
  // 防御：用最新批次行（派车流程会在中途写入 device_sn，调用方传入的对象可能仍是旧值）
  batch = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batch.id) || batch
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get() || null
  const stopOfOrder = new Map() // orderId -> { stop, priority }
  if (route && route.length) {
    route.forEach((stop) => {
      const priority = Math.max(1, 10 - (Number(stop.stop) - 1)) // 第一站最高
      stop.order_ids.forEach((oid) => stopOfOrder.set(oid, { stop: Number(stop.stop), priority }))
    })
  }
  const results = []
  for (const order of orders) {
    const unloading = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    const info = store.prepare(
      'INSERT INTO delivery_tasks (order_id, batch_id, platform_task_id, device_sn, task_status, status_text) VALUES (?,?,?,?,?,?)'
    ).run(order.id, batch.id, '', batch.device_sn || '', 0, '待开舱上货')
    const taskId = Number(info.lastInsertRowid)
    // 订单状态迁移走注入的 orderStateSink（结构评审 P0-1）
    callbacks.emitOrderState(store, { orderId: order.id, taskId, to: 2 })
    const stopInfo = stopOfOrder.get(order.id) || { stop: 1, priority: 10 }
    if (MOCK) {
      const t = { step: 0, taskId }
      mock.mockTasks.set(taskId, t)
      t.timer = setTimeout(() => mock.mockAdvance(store, taskId), 6000)
    } else {
      // 直接下发（Route B，syncLoading=0，2026-09-17）：定型即创建直接任务，
      // 车自行导航到上货点（任务状态 20→30=到达上货点）。开舱门禁以状态 30 为准（平台权威信号），
      // 到达后 loadingVerify 开舱。不再用召唤/预创建（避免 lightTask 挡配送、错误位置开舱）。
      await createDirectTask(store, taskId, order, loading, unloading, batch, stopInfo)
    }
    results.push({ task_id: taskId, order_id: order.id, stop: stopInfo.stop })
  }
  return results
}

// 批次真实派车：与单任务 realDispatch 相同，但指定设备 + 按停靠顺序排 priority
async function realDispatchBatch(store, taskId, order, loading, unloading, batch, stopInfo) {
  if (!httpApi.platformReady()) {
    callbacks.updateTask(store, taskId, '未配置平台凭据，任务未下发')
    console.warn('[platform] 未配置 PLATFORM_APPID/PLATFORM_SECRET，真实配送未启用')
    return
  }
  httpApi.notifyDispatch({ batch_id: batch.id, batch_no: batch.batch_no })
  let l = loading
  let u = unloading
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    const r = await httpApi.syncLandmarks(store)
    if (r && r.ok) {
      l = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
      u = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    }
  }
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    callbacks.updateTask(store, taskId, '待配置平台点位，任务未下发')
    console.warn('[platform] 缺少平台点位映射（platform_landmark_id），无法创建真实任务')
    return
  }
  const body = {
    principalId: httpApi.PRINCIPAL_ID,
    buildingId: u.platform_building_id || l.platform_building_id || '',
    stockType: 1, // 舱位类型：0 大舱 1 中舱 2 小舱（对接文档：单舱机型默认中舱）
    deviceSn: batch.device_sn || '', // 指定设备排队，保证一车多单同机
    loadingMapId: l.platform_map_id,
    loadingLandmarkId: l.platform_landmark_id,
    unloadingMapId: u.platform_map_id,
    unloadingLandmarkId: u.platform_landmark_id,
    unloadingLandmarkName: u.name,
    appointUnloadingPoint: 1,
    priority: stopInfo.priority,
    outOrderNo: [order.order_no],
    loadingStrategy: { match: 10, strategies: { anyCode: order.pickup_code } },
    unloadingStrategy: { match: 10, strategies: { contact: order.contact_phone || '', roomNum: order.pickup_code } },
    feedbackDeliveryTaskUrl: httpApi.callbackUrl('delivery'),
    checkBizOrderStatusUrl: httpApi.callbackUrl('check-order'),
    extInfo: { businessType: 'takeaway', batchNo: batch.batch_no, stop: stopInfo.stop },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    // 排队任务（queue/create）：完整上货流程。注：机器人充电中不拉取排队任务（见 逻辑树/树 图四），
    // 待与越凡确认待机策略后再切换为可用派车方式。
    const r = await httpApi.requestPlatform('POST', '/open-api/v1/deliveryTask/queue/create', body)
    const ok = r && (r.code === 'COMM_200' || r.success === true)
    if (ok) {
      const pid = (r.data && (r.data.id || r.data.taskId || r.data.deliveryTaskId)) || ''
      if (pid) {
        store.prepare("UPDATE delivery_tasks SET platform_task_id=?, task_status=0, status_text='排队中', updated_at=datetime('now','localtime') WHERE id=?")
          .run(String(pid), taskId)
      }
      console.log('[platform] 批次任务创建成功 taskId=' + taskId + ' platformTaskId=' + pid + ' batch=' + batch.batch_no + ' stop=' + stopInfo.stop)
    } else {
      callbacks.updateTask(store, taskId, '创建任务失败：' + ((r && r.msg) || '未知错误'))
      console.warn('[platform] queue/create 失败', r)
    }
  } catch (e) {
    callbacks.updateTask(store, taskId, '创建任务异常：' + e.message)
    console.warn('[platform] 创建排队任务异常', e.message)
  }
}

// 直接下发（Route B）：预创建任务 —— 需先持有设备控制权；成功则设备开舱等待放货。
// 路径/字段按 Apifox open-logis_1.0 核对（POST /deviceCtrl/create/pre）。
async function preCreateTask(deviceSn, extInfo) {
  if (MOCK) return { ok: true, data: {} }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  try {
    const r = await httpApi.requestPlatform('POST', '/open-api/v1/deviceCtrl/create/pre', {
      deviceSn,
      principalId: httpApi.PRINCIPAL_ID,
      stockPos: 'pos_1',
      taskExpireTime: 600, // 预创建任务过期（秒），超时未创建自动关舱
      extInfo: extInfo || {}
    })
    return r && r.code === 'COMM_200'
      ? { ok: true, data: r.data || {} }
      : { ok: false, msg: (r && r.msg) || '预创建任务失败' }
  } catch (e) {
    return { ok: false, msg: '预创建任务异常：' + e.message }
  }
}

// 删除预创建任务（设备预创建后若不再继续创建，调用后立即关舱释放）
async function deletePreCreateTask(deviceSn) {
  if (MOCK) return { ok: true }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  try {
    const r = await httpApi.requestPlatform('DELETE', '/open-api/v1/deviceCtrl/del/pre', { deviceSn, principalId: httpApi.PRINCIPAL_ID })
    return r && r.code === 'COMM_200'
      ? { ok: true }
      : { ok: false, msg: (r && r.msg) || '删除预创建任务失败' }
  } catch (e) {
    return { ok: false, msg: '删除预创建任务异常：' + e.message }
  }
}

// 直接下发（Route B）：创建配送任务（POST /deviceCtrl/create/direct）。
// 语义：需先【预创建】(create/pre) + 持有设备控制权；创建成功设备自动关舱；
// 等待控制权超时或主动释放后开始执行配送。货已在舱（syncLoading=1）。
async function createDirectTask(store, taskId, order, loading, unloading, batch, stopInfo) {
  if (!httpApi.platformReady()) {
    callbacks.updateTask(store, taskId, '未配置平台凭据，任务未下发')
    console.warn('[platform] 未配置 PLATFORM_APPID/PLATFORM_SECRET，真实配送未启用')
    return
  }
  httpApi.notifyDispatch({ batch_id: batch.id, batch_no: batch.batch_no })
  let l = loading
  let u = unloading
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    const r = await httpApi.syncLandmarks(store)
    if (r && r.ok) {
      l = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
      u = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    }
  }
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    callbacks.updateTask(store, taskId, '待配置平台点位，任务未下发')
    console.warn('[platform] 缺少平台点位映射（platform_landmark_id），无法创建真实任务')
    return
  }
  const body = {
    principalId: httpApi.PRINCIPAL_ID,
    buildingId: u.platform_building_id || l.platform_building_id || '',
    deviceSn: batch.device_sn || '',
    stockPos: 'pos_1',   // 货舱位置（Apifox 示例用小写 pos_1）
    syncLoading: 0,      // 异步上货（2026-09-17 改）：车先自己导航到上货点（任务状态 30=到达上货点），
                         // 到达后 loadingVerify 开舱。不用 preCreate（避免在错误位置开舱），
                         // 开舱门禁以任务状态 30 为准（平台权威「到达」信号），不再用带标定误差的距离判断。
    loadingMapId: l.platform_map_id,
    loadingLandmarkId: l.platform_landmark_id,
    unloadingMapId: u.platform_map_id,
    unloadingLandmarkId: u.platform_landmark_id,
    unloadingLandmarkName: u.name,
    appointUnloadingPoint: 1,
    priority: (stopInfo && stopInfo.priority) || 10,
    outOrderNo: [order.order_no],
    loadingStrategy: { match: 10, strategies: { anyCode: order.pickup_code } },
    unloadingStrategy: { match: 10, strategies: { contact: order.contact_phone || '', roomNum: order.pickup_code } },
    feedbackDeliveryTaskUrl: httpApi.callbackUrl('delivery'),
    checkBizOrderStatusUrl: httpApi.callbackUrl('check-order'),
    extInfo: { businessType: 'takeaway', batchNo: batch.batch_no, stop: (stopInfo && stopInfo.stop) || 1 },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    const r = await httpApi.requestPlatform('POST', '/open-api/v1/deviceCtrl/create/direct', body)
    const ok = r && (r.code === 'COMM_200' || r.success === true)
    if (ok) {
      const pid = (r.data && (r.data.id || r.data.taskId || r.data.deliveryTaskId)) || ''
      if (pid) {
        // syncLoading=0：货未装，任务状态由平台驱动（10/20→30 到达上货点）；开舱门禁等 30
        store.prepare("UPDATE delivery_tasks SET platform_task_id=?, task_status=0, status_text='待到达上货点', updated_at=datetime('now','localtime') WHERE id=?")
          .run(String(pid), taskId)
      }
      console.log('[platform] 直接下发任务创建成功 taskId=' + taskId + ' platformTaskId=' + pid + ' batch=' + batch.batch_no)
    } else {
      callbacks.updateTask(store, taskId, '创建任务失败：' + ((r && r.msg) || '未知错误'))
      console.warn('[platform] create/direct 失败', r)
    }
  } catch (e) {
    callbacks.updateTask(store, taskId, '创建任务异常：' + e.message)
    console.warn('[platform] 创建直接任务异常', e.message)
  }
}

// 管理员工具：分页拉取主体全部任务（basicPageList），供 /admin 查看/排查
async function listPlatformTasks(store) {
  const lm = store.prepare("SELECT platform_building_id FROM landmarks WHERE platform_building_id != '' LIMIT 1").get()
  const buildingId = lm && lm.platform_building_id
  if (!buildingId) return { ok: false, msg: '无场地' }
  const out = []
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await httpApi.requestPlatform('GET', '/open-api/v1/deliveryTask/basicPageList?curPage=' + page + '&size=100&buildingId=' + encodeURIComponent(buildingId) + '&principalId=' + encodeURIComponent(httpApi.PRINCIPAL_ID))
      if (!r || r.code !== 'COMM_200') break
      const pd = r.data && r.data.data
      const list = Array.isArray(pd) ? pd : ((pd && pd.list) || [])
      if (!list.length) break
      out.push(...list)
      if (page >= (r.data && r.data.pages)) break
    }
    return { ok: true, tasks: out }
  } catch (e) {
    return { ok: false, msg: e.message }
  }
}

// 召唤空闲机器人到上货点待命（轻任务 lightTask，不创建配送任务、不锁定批次）：
// 组单中批次有订单时调用，让机器人提前就位等待商家上货；上货定型时才创建配送任务。
// 注意：召唤会中断正在执行的配送任务（平台语义），调用前须确认无活跃配送。
// preferredSn：待上货(1)批次已定型指派的车，优先召唤该车（扫描对 status IN (0,1) 批次都召唤时传入）。
// optExpireMin：召唤任务有效期分钟。默认 5（组队待组装车）;「释放返程」时传 3(见 settleRobotAtLoading)。
// 到达/等待窗口同样取 optExpireMin：任务到点自动返程 =「等 optExpireMin 分钟无单则释放」的自然实现。
async function summonToLoadingPoint(store, preferredSn, optExpireMin) {
  // Mock：模拟创建轻任务并返回合成 id——真到站链路（queryLightTask→status 30）依赖 light_task_id 才能把订单置待取货
  if (MOCK) return { ok: true, msg: '模拟召唤成功', light_task_id: 'mock-light-' + Date.now() }
  if (!httpApi.platformReady()) return { ok: false, msg: '未配置平台凭据' }
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
  if (!loading || !loading.platform_landmark_id || !loading.platform_map_id || !loading.platform_building_id) {
    return { ok: false, msg: '上货点未配置平台映射' }
  }
  const expireMin = Number(optExpireMin) > 0 ? Number(optExpireMin) : 5
  const r = await httpApi.getDeviceList()
  if (!r.ok || !r.robots || !r.robots.length) return { ok: false, msg: '无机器人可召唤' }
  // 优先指定设备（已定型批次指派的车），其次空闲/充电/待机/返程/召唤中的车，最后任意在线车
  let robot = null
  if (preferredSn) robot = r.robots.find((x) => x.online && x.device_sn === preferredSn)
  if (!robot) robot = r.robots.find((x) => x.online && ['idle', 'standby', 'charging', 'returnChargingPile', 'returnStandby', 'lightTask'].includes(x.machine_status))
  robot = robot || r.robots.find((x) => x.online) || null
  if (!robot) return { ok: false, msg: '无在线机器人可召唤' }
  try {
    const body = {
      principalId: httpApi.PRINCIPAL_ID,
      deviceSn: robot.device_sn,
      landmarkId: loading.platform_landmark_id,
      mapId: loading.platform_map_id,
      buildingId: loading.platform_building_id,
      // expireTime 必须是 "yyyy-MM-dd HH:mm:ss" 日期时间字符串（Apifox 规格；传毫秒时间戳字符串会被平台拒绝
      // 「expireTime字段类型错误」——2026-09-16 真机实测确认，此前召唤一直因此失败）。
      // 窗口默认 5 分钟：召唤的 lightTask 没有取消接口，创建后只能等它到期；
      // 若窗口太长（10 分钟），「开始配送」后车会被 lightTask 挡住最多 10 分钟才启动配送任务（2026-09-17 实测）。
      // optExpireMin>0 时按传入值（如释放场景传 3：车在上货点等 3 分钟无单则自动返程释放）。
      expireTime: httpApi.formatLocalDt(Date.now() + expireMin * 60 * 1000),
      remark: '组单中批次待上货，召唤至商铺上货点',
      // action 必须带 type:"wait"（Apifox 示例）；缺 type 平台报「请求发生异常」
      action: { type: 'wait', waitTime: expireMin * 60 },
      // extInfo 必须显式给出（空对象即可）：缺它同样报「请求发生异常」——2026-09-16 受控对比实测确认
      extInfo: {}
    }
    const resp = await httpApi.requestPlatform('POST', '/open-api/v1/lightTask', body)
    if (resp && (resp.code === 'COMM_200' || resp.success === true)) {
      // 召唤成功不打印（扫描每 15s 一轮，避免刷屏；机器人是否就位由上货页实时展示）
      // data.id = 创建轻任务返回的任务 id，用于后续按 id 查它的到达状态（status=30 arrivedPoint）。
      const lightTaskId = (resp.data && (resp.data.id || resp.data.taskId)) ? String(resp.data.id || resp.data.taskId) : ''
      return { ok: true, device_sn: robot.device_sn, light_task_id: lightTaskId }
    }
    return { ok: false, msg: (resp && resp.msg) || '召唤失败' }
  } catch (e) {
    return { ok: false, msg: '召唤异常：' + e.message }
  }
}

// ---------------- 管理员手动召唤（可选目标点，含充电点） ----------------
// 召唤目标点列表：上货点/取货点（本地 landmarks 同步自 landmarkInfo）+ 充电点（地图 landmarks 的 chargePoint）
async function getSummonTargets(store) {
  const out = []
  const rows = store.prepare("SELECT id, name, type, platform_landmark_id, platform_map_id, platform_building_id, pos_x, pos_y FROM landmarks WHERE type IN ('loadingPoint','deliverPoint') ORDER BY sort").all()
  for (const r of rows) {
    if (!r.platform_landmark_id) continue
    out.push({ id: r.platform_landmark_id, name: r.name || '', type: r.type, x: r.pos_x, y: r.pos_y })
  }
  try {
    const data = await httpApi.getMapRaw(store)
    const detail = data && data.mapDetailInfo
    const pts = (detail && detail.landmarks) || {}
    for (const k of Object.keys(pts)) {
      const p = pts[k]
      if (p && p.type === 'chargePoint' && Array.isArray(p.pose) && p.pose.length >= 2) {
        out.push({ id: p.id || k, name: p.name || '充电点', type: 'chargePoint', x: Number(p.pose[0]), y: Number(p.pose[1]) })
      }
    }
  } catch (e) { /* 充电点获取失败不阻断取货点列表 */ }
  return { ok: true, targets: out }
}

// 召唤指定机器人到指定点位（lightTask 轻任务；召唤会中断正在执行的配送任务，调用前须确认）
// optExpireMin：lightTask 失效分钟数（到期自动返程）。默认 5（管理员手动召唤/返程沿用）；
// 配送停靠站（summonDeliveryToStop）传更长窗口，避免「车在取餐点等单，5 分钟一到就跑回充电点」。
async function summonToPoint(store, deviceSn, landmarkId, optExpireMin) {
  // Mock：同上，返回合成轻任务 id，保证召唤推进的「真到站」链路可测
  if (MOCK) return { ok: true, msg: '模拟召唤成功', light_task_id: 'mock-light-' + Date.now() }
  if (!httpApi.platformReady()) return { ok: false, msg: '未配置平台凭据' }
  const base = store.prepare("SELECT platform_building_id, platform_map_id FROM landmarks WHERE platform_building_id != '' LIMIT 1").get()
  if (!base || !base.platform_building_id) return { ok: false, msg: '未配置平台映射' }
  // 解析目标点：本地 landmarks（上货/取货）；找不到则尝试地图 landmarks（充电点等）
  let lm = landmarkId ? store.prepare('SELECT * FROM landmarks WHERE platform_landmark_id=?').get(landmarkId) : null
  let targetName = lm ? lm.name : ''
  if (!lm) {
    const data = await httpApi.getMapRaw(store)
    const detail = data && data.mapDetailInfo
    const pts = (detail && detail.landmarks) || {}
    for (const k of Object.keys(pts)) {
      const p = pts[k]
      if (p && (p.id === landmarkId || k === landmarkId)) {
        // mapId 必须用机器人实际使用的地图（DB platform_map_id，landmarkInfo 同源）；
        // 不能用 mapInfo 的 kmapId（平台内部地图版本，与机器人地图不一致会报「点位不存在」）
        lm = { platform_landmark_id: p.id || k, platform_map_id: base.platform_map_id || '', platform_building_id: base.platform_building_id }
        targetName = p.name || '点位'
        break
      }
    }
  }
  if (!lm || !lm.platform_landmark_id) return { ok: false, msg: '目标点位不存在' }
  // 选择设备：指定设备优先，其次空闲/充电/待机/返程/召唤中的车，最后任意在线车
  const r = await httpApi.getDeviceList()
  if (!r.ok || !r.robots || !r.robots.length) return { ok: false, msg: '无机器人可召唤' }
  let robot = null
  if (deviceSn) robot = r.robots.find((x) => x.online && x.device_sn === deviceSn)
  if (!robot) robot = r.robots.find((x) => x.online && ['idle', 'standby', 'charging', 'returnChargingPile', 'returnStandby', 'lightTask'].includes(x.machine_status))
  robot = robot || r.robots.find((x) => x.online) || null
  if (!robot) return { ok: false, msg: '无在线机器人可召唤' }
  try {
    const body = {
      principalId: httpApi.PRINCIPAL_ID,
      deviceSn: robot.device_sn,
      landmarkId: lm.platform_landmark_id,
      mapId: lm.platform_map_id || '',
      buildingId: lm.platform_building_id || base.platform_building_id,
      expireTime: httpApi.formatLocalDt(Date.now() + (Number(optExpireMin) > 0 ? Number(optExpireMin) : 5) * 60 * 1000),
      remark: '召唤至 ' + (targetName || '点位'),
      // waitTime 必须与 expireTime 匹配：expire 是 20 分钟而 waitTime 固定 300 秒时，
      // 车到达后只等 5 分钟任务就结束返程（issue2：等一会儿就回充电）。统一按 optExpireMin 走。
      action: { type: 'wait', waitTime: (Number(optExpireMin) > 0 ? Number(optExpireMin) : 5) * 60 },
      extInfo: {}
    }
    const resp = await httpApi.requestPlatform('POST', '/open-api/v1/lightTask', body)
    if (resp && (resp.code === 'COMM_200' || resp.success === true)) {
      const lightTaskId = (resp.data && (resp.data.id || resp.data.taskId)) ? String(resp.data.id || resp.data.taskId) : ''
      return { ok: true, device_sn: robot.device_sn, landmark: targetName || '', light_task_id: lightTaskId }
    }
    return { ok: false, msg: (resp && resp.msg) || '召唤失败' }
  } catch (e) {
    return { ok: false, msg: '召唤异常：' + e.message }
  }
}

// 召唤模式点位到达门禁（open-bin 用）：按批次当前召唤任务判断车是否已到上货点。
// taskId 为空/查询失败按未到处理 —— 由 route 决定是否重新召唤，绝不误判为已到。
async function lightTaskArrived(store, batch) {
  const id = batch && batch.light_task_id
  const r = await httpApi.queryLightTask(id)
  return { ok: r.ok && r.arrived, arrived: r.arrived, status: r.status, msg: r.msg, light_task_id: id || '' }
}

// 召唤多单配送：把指定机器人召唤到 route 里的某停靠点（stop.landmark_id → 平台点位）。
// 内部复用 summonToPoint；stop.landmark_id 是本地 landmarks 表主键（DB id，非平台 id），
// summonToPoint 会按 platform_landmark_id 反查平台 landmark，故这里传本地 landmark 的 platform_landmark_id。
async function summonDeliveryToStop(store, batch, stop) {
  if (!store || !batch || !batch.device_sn || !stop) return { ok: false, msg: '参数不完整' }
  const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(String(stop.landmark_id))
  if (!lm || !lm.platform_landmark_id) {
    return { ok: false, msg: '配送点未配置平台映射，无法召唤' }
  }
  const r = await summonToPoint(store, batch.device_sn, lm.platform_landmark_id, Number(process.env.SUMMON_STOP_EXPIRE_MIN || 20))
  if (!r.ok) return { ok: false, msg: '召唤到点位失败：' + r.msg, device_sn: batch.device_sn }
  return { ok: true, device_sn: r.device_sn, stop: Number(stop.stop || 0), landmark_id: stop.landmark_id, landmark_name: stop.landmark_name, light_task_id: r.light_task_id || '' }
}

// ---------------- 管理员手动控制：驻停 / 恢复 / 停止并取消任务 ----------------
// 查设备当前活跃任务（basicPageList 按设备过滤，taskStatus<80 未终态）
async function deviceActiveTasks(store, deviceSn) {
  const r = await listPlatformTasks(store)
  if (!r.ok) return []
  return (r.tasks || []).filter((t) => t.deviceSn === deviceSn && Number(t.taskStatus) < 80)
}

// 恢复任务（继续工作）：恢复设备当前（挂起）任务；平台要求 taskId 必填
async function recoverRobot(store, deviceSn) {
  if (MOCK) return { ok: true, msg: '模拟恢复成功' }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  let taskId = null
  try {
    const acts = await deviceActiveTasks(store, deviceSn)
    if (acts.length) taskId = acts[0].id
  } catch (e) { /* 查任务失败不阻断恢复指令 */ }
  if (!taskId) return { ok: false, msg: '未找到 ' + deviceSn + ' 的当前任务（可能无任务或已终态），无法恢复' }
  try {
    const body = { deviceSn, taskId: Number(taskId), stockPos: 'pos_1' }
    const r = await httpApi.requestPlatform('POST', '/open-api/v1/deviceCtrl/recover', body)
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '恢复任务失败' }
  } catch (e) {
    return { ok: false, msg: '恢复任务异常：' + e.message }
  }
}

// 停止并取消正在做的任务：先关闭设备当前活跃任务（舱内有货自动开舱），再驻停
async function stopAndCancelTask(store, deviceSn) {
  if (MOCK) return { ok: true, msg: '模拟停止并取消成功' }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  const out = { closed: 0, stopped: false }
  try {
    const acts = await deviceActiveTasks(store, deviceSn)
    for (const t of acts.slice(0, 3)) {
      const c = await httpApi.closeTask(t.deviceSn || deviceSn, t.id, '管理员停止并取消任务')
      if (c && c.ok) out.closed++
    }
    const s = await httpApi.stopRobot(deviceSn, 30)
    out.stopped = s.ok
  } catch (e) { /* 部分失败不回滚，由返回结果提示 */ }
  if (!out.closed && !out.stopped) return { ok: false, msg: '未关闭任何任务且驻停失败' }
  return { ok: true, closed: out.closed, stopped: out.stopped }
}

// 取餐超时「回来再等」：为未取餐订单重建一个同卸载点位的配送任务，让机器人再跑一趟该点位等待。
// 与 createTasksForBatch 的区别：**不把订单改回 status=2**（保持已送达 3，避免被「卡死配送中」扫描误伤），
// 也不重新 loading（货已在舱）。真实平台对「同一单/同一货舱重建 queue/create 任务」是否可行、
// 是否会先回上货点，待与越凡确认；失败不阻断 —— 二段超时（pickup_revisit_at + PICKUP_RETRY_TIMEOUT_MS）
// 到期仍会驳回。mock 档走本地任务推进便于联调。
async function recreatePickupTask(store, batch, order) {
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get() || null
  const unloading = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
  const info = store.prepare(
    'INSERT INTO delivery_tasks (order_id, batch_id, platform_task_id, device_sn, task_status, status_text) VALUES (?,?,?,?,?,?)'
  ).run(order.id, batch.id, '', batch.device_sn || '', 0, '排队中')
  const taskId = Number(info.lastInsertRowid)
  // 只挂任务不改状态：走注入的 orderStateSink（结构评审 P0-1）
  callbacks.emitOrderState(store, { orderId: order.id, taskId })
  if (MOCK) {
    const t = { step: 0, taskId }
    mock.mockTasks.set(taskId, t)
    t.timer = setTimeout(() => mock.mockAdvance(store, taskId), 6000)
  } else {
    await realDispatchBatch(store, taskId, order, loading, unloading, batch, { stop: 1, priority: 10 })
  }
  return { task_id: taskId }
}

// 批次内待上货任务列表（任务状态 < 50）
function batchPendingTasks(store, batchId) {
  return store.prepare(`
    SELECT d.*, o.order_no, o.pickup_code, o.landmark_name, o.contact_name, o.contact_phone
    FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
    WHERE d.batch_id=? AND d.task_status < 50 ORDER BY d.id ASC`).all(batchId)
}

// 批次上货验证（逐任务 loading/verify，autoOpen 开舱一次）
async function verifyBatchLoading(store, batchId) {
  if (MOCK) {
    const tasks = batchPendingTasks(store, batchId)
    return tasks.map((t) => ({ task_id: t.id, ok: true, msg: '' }))
  }
  const tasks = batchPendingTasks(store, batchId)
  const out = []
  for (const t of tasks) {
    if (!t.platform_task_id) { continue }   // 排队待下发（同批次上一单完成后才下发），本轮不参与开舱，跳过
    const r = await httpApi.loadingVerify(t.device_sn, t.platform_task_id, { anyCode: t.pickup_code })
    out.push({ task_id: t.id, ok: r.ok, msg: r.ok ? '' : r.msg })
  }
  return out
}

// 批次确认上货并开始配送（逐任务 loading/confirm）
async function confirmBatchLoading(store, batchId) {
  if (MOCK) {
    const tasks = batchPendingTasks(store, batchId)
    return tasks.map((t) => ({ task_id: t.id, ok: true, msg: '' }))
  }
  const tasks = batchPendingTasks(store, batchId)
  const out = []
  for (const t of tasks) {
    if (!t.platform_task_id) { continue }   // 排队待下发，本轮不参与关舱/配送，跳过
    if (!t.device_sn) { out.push({ task_id: t.id, ok: false, msg: '缺少设备编号' }); continue }
    const r = await httpApi.loadingConfirm(t.device_sn, t.platform_task_id, { anyCode: t.pickup_code })
    out.push({ task_id: t.id, ok: r.ok, msg: r.ok ? '' : r.msg })
  }
  return out
}

// 真实模式：调用排队任务创建接口（queue/create）
async function realDispatch(store, taskId, order, loading, unloading) {
  if (!httpApi.platformReady()) {
    callbacks.updateTask(store, taskId, '未配置平台凭据，任务未下发')
    console.warn('[platform] 未配置 PLATFORM_APPID/PLATFORM_SECRET，真实配送未启用')
    return
  }
  httpApi.notifyDispatch({ order_id: order.id })
  let l = loading
  let u = unloading
  // 点位缺少平台映射时，先尝试从平台同步
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    const r = await httpApi.syncLandmarks(store)
    if (r && r.ok) {
      l = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
      u = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    }
  }
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    callbacks.updateTask(store, taskId, '待配置平台点位，任务未下发')
    console.warn('[platform] 缺少平台点位映射（platform_landmark_id），无法创建真实任务')
    return
  }

  const body = {
    principalId: httpApi.PRINCIPAL_ID,
    buildingId: u.platform_building_id || l.platform_building_id || '',
    stockType: 1, // 舱位类型：0 大舱 1 中舱 2 小舱（对接文档：单舱机型默认中舱）
    loadingMapId: l.platform_map_id,
    loadingLandmarkId: l.platform_landmark_id,
    unloadingMapId: u.platform_map_id,
    unloadingLandmarkId: u.platform_landmark_id,
    unloadingLandmarkName: u.name,
    appointUnloadingPoint: 1,
    priority: 10,
    outOrderNo: [order.order_no],
    loadingStrategy: { match: 10, strategies: { anyCode: order.pickup_code } },
    unloadingStrategy: { match: 10, strategies: { contact: order.contact_phone || '', roomNum: order.pickup_code } },
    feedbackDeliveryTaskUrl: httpApi.callbackUrl('delivery'),
    checkBizOrderStatusUrl: httpApi.callbackUrl('check-order'),
    extInfo: { businessType: 'takeaway' },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    // 排队任务（queue/create）：完整上货流程。注：机器人充电中不拉取排队任务（见 逻辑树/树 图四），
    // 待与越凡确认待机策略后再切换为可用派车方式。
    const r = await httpApi.requestPlatform('POST', '/open-api/v1/deliveryTask/queue/create', body)
    const ok = r && (r.code === 'COMM_200' || r.success === true)
    if (ok) {
      const pid = (r.data && (r.data.id || r.data.taskId || r.data.deliveryTaskId)) || ''
      if (pid) {
        store.prepare("UPDATE delivery_tasks SET platform_task_id=?, task_status=0, status_text='排队中', updated_at=datetime('now','localtime') WHERE id=?")
          .run(String(pid), taskId)
      }
      console.log('[platform] 排队任务创建成功 taskId=' + taskId + ' platformTaskId=' + pid)
    } else {
      callbacks.updateTask(store, taskId, '创建任务失败：' + ((r && r.msg) || '未知错误'))
      console.warn('[platform] queue/create 失败', r)
    }
  } catch (e) {
    callbacks.updateTask(store, taskId, '创建任务异常：' + e.message)
    console.warn('[platform] 创建排队任务异常', e.message)
  }
}

// ---------------- 聚合导出（与原 platform.js 导出清单完全一致，调用方无感） ----------------
module.exports = {
  // 任务创建/派车编排（本文件）
  createQueueTask, createTasksForBatch, createDirectTask, preCreateTask, deletePreCreateTask,
  listPlatformTasks, recreatePickupTask, batchPendingTasks, verifyBatchLoading, confirmBatchLoading,
  pickAvailableRobot, realDispatch, realDispatchBatch,
  // 召唤编排（本文件）
  summonToLoadingPoint, getSummonTargets, summonToPoint, lightTaskArrived, summonDeliveryToStop,
  // 管理员控制编排（本文件）
  deviceActiveTasks, recoverRobot, stopAndCancelTask,
  // 钩子注入（转发至对应拆分件）
  setDispatchHook: httpApi.setDispatchHook,
  setOrderStateSink: callbacks.setOrderStateSink,
  // 基础层/回调层/模拟层（原导出，转发）
  getTaskStatus: httpApi.getTaskStatus,
  getDevicePosition: httpApi.getDevicePosition, getDevicePositionBySn: httpApi.getDevicePositionBySn,
  getRobotRadar: httpApi.getRobotRadar, getDeviceList: httpApi.getDeviceList,
  grantControl: httpApi.grantControl, releaseControl: httpApi.releaseControl,
  loadingVerify: httpApi.loadingVerify, drawerCtrl: httpApi.drawerCtrl,
  loadingConfirm: httpApi.loadingConfirm, unloadingVerify: httpApi.unloadingVerify,
  unloadingConfirm: httpApi.unloadingConfirm,
  cancelQueueTask: httpApi.cancelQueueTask, closeTask: httpApi.closeTask,
  robotAtLoadingPoint: httpApi.robotAtLoadingPoint, robotAtPoint: httpApi.robotAtPoint,
  isRobotBusy: httpApi.isRobotBusy,
  queryLightTask: httpApi.queryLightTask, stopRobot: httpApi.stopRobot,
  queryDeviceTasks: httpApi.queryDeviceTasks, adminCalibStatus: httpApi.adminCalibStatus,
  syncTaskStatus: callbacks.syncTaskStatus, applyStatus: callbacks.applyStatus,
  cancelMockTask: mock.cancelMockTask,
  platformReady: httpApi.platformReady,
  syncLandmarks: httpApi.syncLandmarks,
  getMapOverview: httpApi.getMapOverview, getMapBbox: httpApi.getMapBbox,
  getMapImageBytes: httpApi.getMapImageBytes
}
