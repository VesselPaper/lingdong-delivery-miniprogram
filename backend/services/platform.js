// 开放物流平台对接层（真实业务逻辑）
// 默认调用 robox 开放物流平台（按 项目进度\03_技术记录.md 的 36 接口清单接入）：
//   - 排队任务创建 queue/create
//   - 任务状态同步 deliveryTask/basicList（轮询兜底）+ feedbackDeliveryTaskUrl 回调（见 server.js）
//   - 机器人实时位置 eviz / iotGatewayProxy
//   - 平台点位同步 buildingList / landmarkInfo
// 字段已按 Apifox「开放物流平台」open-logis_1.0 导出文档（接口\默认模块.openapi.json）核对校正。
// 本地无平台凭据、需要纯本地演示时：显式设置 PLATFORM_MOCK=true 使用本地模拟状态机。
const http = require('http')
const https = require('https')

const MOCK = process.env.PLATFORM_MOCK === 'true'
const APPID = process.env.PLATFORM_APPID || ''
const SECRET = process.env.PLATFORM_SECRET || ''
const PRINCIPAL_ID = process.env.PLATFORM_PRINCIPALID || ''
const BASE = process.env.PLATFORM_BASE || 'https://test-robox.eventec.cn/service-open-logis'
// 回调公网地址（如 cloudflared 内网穿透域名）；未配置时创建任务不带回调，用 basicList 轮询兜底
const CALLBACK_BASE = (process.env.PLATFORM_CALLBACK_BASE || '').replace(/\/$/, '')

// 任务状态码 -> 文案（与开放物流平台标准对照表一致，见 doc/06 常量字典）
const STATUS_TEXT = {
  0: '排队中', 10: '任务已接收', 20: '去往上货点', 30: '到达上货点',
  40: '上货中', 50: '已上货', 60: '去往取货点', 70: '到达取货点', 80: '任务完成',
  90: '上货失败', 91: '去位置点失败', 92: '等待上货超时', 93: '等待上货关舱', 94: '去上货途中设备故障', 95: '去位置点超时',
  100: '取货失败', 101: '去位置点失败', 102: '等待取货超时', 103: '机器返回失败', 104: '去送货途中设备故障', 105: '去位置点超时', 106: '召唤打断配送任务',
  110: '任务取消', 120: '上货流程挂起', 130: '下货流程挂起', 131: '送货挂起，返回上货点', 132: '送货挂起，返回待命',
  140: '待完善', 150: '任务被关闭'
}

// ---------------- Mock 状态机（仅 PLATFORM_MOCK=true 时启用） ----------------
const MOCK_STEPS = [
  { code: 0, text: '排队中' },
  { code: 10, text: '任务已接收' },
  { code: 20, text: '去往上货点' },
  { code: 30, text: '到达上货点' },
  { code: 50, text: '已上货' },
  { code: 60, text: '去往取货点' },
  { code: 70, text: '到达取货点' },
  { code: 80, text: '任务完成' }
]
const mockTasks = new Map() // taskId -> { step, timer }

function mockAdvance(store, taskId) {
  const t = mockTasks.get(taskId)
  if (!t) return
  const idx = t.step + 1
  if (idx >= MOCK_STEPS.length) {
    applyStatus(store, taskId, 80, '任务完成')
    return
  }
  t.step = idx
  applyStatus(store, taskId, MOCK_STEPS[idx].code, MOCK_STEPS[idx].text)
  t.timer = setTimeout(() => mockAdvance(store, taskId), 4000)
}

function mockPosition(taskStatus) {
  const pts = [
    { x: 30.55, y: 104.08 },
    { x: 30.56, y: 104.09 },
    { x: 30.57, y: 104.10 },
    { x: 30.58, y: 104.11 }
  ]
  const stepMap = { 0: 0, 10: 0, 20: 1, 30: 1, 50: 2, 60: 2, 70: 3, 80: 3 }
  const i = Math.min(stepMap[taskStatus] || 0, pts.length - 1)
  return { lat: pts[i].x, lng: pts[i].y, text: STATUS_TEXT[taskStatus] || '' }
}

// ---------------- 平台 HTTP 调用（Header 携带 appid/secret，可附加自定义 header） ----------------
function requestPlatform(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = BASE + path
    const isHttps = url.indexOf('https://') === 0
    const mod = isHttps ? https : http
    let u
    try { u = new URL(url) } catch (e) { return reject(e) }
    const options = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign(
        { 'Content-Type': 'application/json;charset=UTF-8', appid: APPID, secret: SECRET },
        extraHeaders || {}
      )
    }
    const req = mod.request(options, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('平台返回非 JSON：' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function platformReady() {
  return !!(APPID && SECRET && PRINCIPAL_ID)
}

// ---------------- 点位同步：buildingList + landmarkInfo -> landmarks 表 ----------------
// 将平台真实点位（含 platform_building_id / platform_map_id / platform_landmark_id）写入本地 landmarks 表。
// 按平台 landmarkId 幂等 upsert：已存在则更新名称/映射，不存在则新增；并清理无平台映射的历史演示点位。
async function syncLandmarks(store) {
  if (!platformReady()) return { ok: false, msg: '未配置平台凭据' }
  try {
    const b = await requestPlatform('GET', '/open-api/v1/building/buildingList?principalId=' + encodeURIComponent(PRINCIPAL_ID))
    const list = b && b.data && b.data.buildingList
    if (b.code !== 'COMM_200' || !list || !list.length) {
      return { ok: false, msg: (b && b.msg) || '未获取到场地数据' }
    }
    const building = list[0]
    const buildingId = building.buildingId
    const lm = await requestPlatform('GET', '/open-api/v1/building/landmarkInfo?buildingId=' + encodeURIComponent(buildingId) + '&type=deliverPoint')
    const points = (lm && lm.data) || []
    if (!Array.isArray(points)) return { ok: false, msg: '点位数据格式异常' }

    let inserted = 0
    let updated = 0
    let sort = 1
    const isLoading = (p) => /上货|商铺|店铺|铺子/.test(p.landmarkName || '')
    for (const p of points) {
      if (!p || !p.landmarkName) continue
      const lmId = p.landmarkId || ''
      const type = isLoading(p) ? 'loadingPoint' : 'deliverPoint'
      const pose = Array.isArray(p.pose) ? p.pose : []
      const posX = pose.length > 0 ? Number(pose[0]) : 0
      const posY = pose.length > 1 ? Number(pose[1]) : 0
      const exist = lmId ? store.prepare('SELECT id FROM landmarks WHERE platform_landmark_id=?').get(lmId) : null
      if (exist) {
        const r = store.prepare('UPDATE landmarks SET name=?, building=?, floor=?, type=?, sort=?, platform_building_id=?, platform_map_id=?, pos_x=?, pos_y=? WHERE id=?')
          .run(p.landmarkName, building.buildingName || '', p.floor || '', type, sort, buildingId, p.mapId || '', posX, posY, exist.id)
        if (r.changes) updated++
      } else {
        store.prepare('INSERT INTO landmarks (name, building, floor, type, sort, platform_building_id, platform_map_id, platform_landmark_id, pos_x, pos_y) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(p.landmarkName, building.buildingName || '', p.floor || '', type, sort, buildingId, p.mapId || '', lmId, posX, posY)
        inserted++
      }
      sort++
    }
    // 清理无平台映射的历史演示点位（仅当本次成功拉到有效点位时执行）
    let removed = 0
    if (points.length > 0) {
      removed = store.prepare("DELETE FROM landmarks WHERE platform_landmark_id='' OR platform_landmark_id IS NULL").run().changes
    }
    return { ok: true, buildingId, buildingName: building.buildingName, count: points.length, inserted, updated, removed }
  } catch (e) {
    return { ok: false, msg: e.message }
  }
}

// ---------------- 配送监控地图（真实校园地图 + 点位 + 路网 + 机器人位置 + 路线） ----------------
// 数据来源：
//  1. building/mapInfo/{mapId}：真实地图图片（map.png/barrier.png 签名 OSS 直链）+ mapDetailInfo.landmarks（点位坐标）
//     + mapDetailInfo.固定路径 graph（可通行路网 nodes/edges）
//  2. 活跃批次 route（本地 landmarks 坐标）→ 路线折线
//  3. eviz 代理接口按设备获取机器人实时坐标（robotpose）
// 返回 map_url/barrier_url、bbox（坐标→图片像素映射）、landmarks、graph、robots、routes。
async function getMapOverview(store) {
  if (!platformReady()) return { ok: false, msg: '未配置开放物流平台凭据' }
  const lm = store.prepare("SELECT * FROM landmarks WHERE platform_building_id != '' ORDER BY sort LIMIT 1").get()
  if (!lm || !lm.platform_map_id) return { ok: false, msg: '未同步点位（请先执行点位同步）' }
  try {
    const m = await requestPlatform('GET', '/open-api/v1/building/mapInfo/' + encodeURIComponent(lm.platform_map_id))
    if (m.code !== 'COMM_200' || !m.data || !m.data.map) return { ok: false, msg: (m && m.msg) || '获取地图失败' }
    const mapUrl = m.data.map
    const barrierUrl = m.data.barrier || ''
    const detail = m.data.mapDetailInfo || {}
    // 点位（含商铺上货 loading）
    const landmarks = []
    const pts = detail.landmarks || {}
    for (const k of Object.keys(pts)) {
      const p = pts[k]
      if (!p || !Array.isArray(p.pose) || p.pose.length < 2) continue
      landmarks.push({
        id: p.id || k,
        name: p.name || '',
        type: /上货|商铺|店铺|铺子/.test(p.name || '') ? 'loadingPoint' : 'deliverPoint',
        x: Number(p.pose[0]), y: Number(p.pose[1])
      })
    }
    // 路网（固定路径 graph）
    const graph = { nodes: [], edges: [] }
    const line = pts['固定路径'] || Object.values(pts).find((p) => p && p.graph)
    if (line && line.graph) {
      const nodes = line.graph.nodes || {}
      for (const nk of Object.keys(nodes)) {
        const pos = nodes[nk].pos || []
        if (pos.length >= 2) graph.nodes.push({ id: nk, x: Number(pos[0]), y: Number(pos[1]) })
      }
      ;(line.graph.edges || []).forEach((e) => {
        if (e && Array.isArray(e.edge) && e.edge.length === 2) graph.edges.push([e.edge[0], e.edge[1]])
      })
    }
    // bbox：点位 + 路网节点 的外包框（前端按此把坐标映射到图片像素）
    const xs = []
    const ys = []
    landmarks.forEach((p) => { xs.push(p.x); ys.push(p.y) })
    graph.nodes.forEach((n) => { xs.push(n.x); ys.push(n.y) })
    if (!xs.length) return { ok: false, msg: '地图无点位数据' }
    const bbox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    // 活跃批次路线（批次状态=配送中，route 停靠点坐标来自本地 landmarks）
    const routes = []
    const activeBatches = store.prepare('SELECT id FROM delivery_batches WHERE status=2 ORDER BY id DESC LIMIT 10').all()
    for (const rb of activeBatches) {
      const detailB = require('./batch').getBatchDetail(store, rb.id)
      if (!detailB || !Array.isArray(detailB.route)) continue
      const stops = detailB.route.map((s) => {
        const loc = store.prepare('SELECT * FROM landmarks WHERE id=?').get(String(s.landmark_id))
        return { stop: Number(s.stop), landmark_id: s.landmark_id, name: s.landmark_name, x: Number(loc ? loc.pos_x : 0), y: Number(loc ? loc.pos_y : 0), order_count: (s.order_ids || []).length }
      }).filter((s) => !isNaN(s.x) || !isNaN(s.y))
      if (stops.length) routes.push({ batch_id: rb.id, batch_no: detailB.batch_no, daily_seq: detailB.daily_seq, stops })
    }
    // 机器人实时位置（配送中任务设备，去重）
    const robots = []
    const seen = new Set()
    const taskRows = store.prepare(`
      SELECT d.id, d.device_sn FROM delivery_tasks d JOIN orders o ON o.id=d.order_id
      WHERE d.device_sn != '' AND d.task_status BETWEEN 50 AND 79 GROUP BY d.device_sn`).all()
    for (const t of taskRows) {
      if (seen.has(t.device_sn)) continue
      seen.add(t.device_sn)
      const pos = await getDevicePosition(store, t.id)
      if (pos && !isNaN(pos.x) && !isNaN(pos.y)) {
        robots.push({ device_sn: t.device_sn, x: Number(pos.x), y: Number(pos.y), theta: Number(pos.theta || 0), text: pos.text || '' })
      }
    }
    return { ok: true, map_url: mapUrl, barrier_url: barrierUrl, bbox, landmarks, graph, robots, routes }
  } catch (e) {
    return { ok: false, msg: '获取地图数据失败：' + e.message }
  }
}

// ---------------- 创建配送任务 ----------------
function createQueueTask(store, order) {
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
  const unloading = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
  const info = store.prepare(
    'INSERT INTO delivery_tasks (order_id, platform_task_id, device_sn, task_status, status_text) VALUES (?,?,?,?,?)'
  ).run(order.id, '', '', 0, '排队中')
  const taskId = Number(info.lastInsertRowid)
  store.prepare("UPDATE orders SET delivery_task_id=?, status=2, updated_at=datetime('now','localtime') WHERE id=?")
    .run(taskId, order.id)

  if (MOCK) {
    const t = { step: 0, taskId }
    mockTasks.set(taskId, t)
    t.timer = setTimeout(() => mockAdvance(store, taskId), 4000)
  } else {
    realDispatch(store, taskId, order, loading, unloading)
  }
  return taskId
}

// 自动挑选一台可用机器人（在线且空闲/待机/充电中），供批次派车时指派
async function pickAvailableRobot() {
  if (MOCK || !platformReady()) return null
  try {
    const r = await getDeviceList()
    if (!r.ok || !r.robots || !r.robots.length) return null
    const free = r.robots.find((x) => x.online && ['idle', 'standby', 'charging', 'returnChargingPile', 'returnStandby'].includes(x.machine_status))
    return free || r.robots.find((x) => x.online) || null
  } catch (e) {
    return null
  }
}

// ---------------- 批次派车：为一车多单批量创建平台任务 ----------------
// 每单一个平台任务（outOrderNo 独立、取餐码独立），同一批次所有任务共用同一设备/货仓；
// 停靠顺序来自批次 route，按 stop 顺序创建并以 priority 递减提示平台按序配送。
async function createTasksForBatch(store, batch, orders, route) {
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get() || null
  const stopOfOrder = new Map() // orderId -> { stop, priority }
  route.forEach((stop) => {
    const priority = Math.max(1, 10 - (Number(stop.stop) - 1)) // 第一站最高
    stop.order_ids.forEach((oid) => stopOfOrder.set(oid, { stop: Number(stop.stop), priority }))
  })
  const results = []
  for (const order of orders) {
    const unloading = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    const info = store.prepare(
      'INSERT INTO delivery_tasks (order_id, batch_id, platform_task_id, device_sn, task_status, status_text) VALUES (?,?,?,?,?,?)'
    ).run(order.id, batch.id, '', batch.device_sn || '', 0, '排队中')
    const taskId = Number(info.lastInsertRowid)
    store.prepare("UPDATE orders SET delivery_task_id=?, status=2, updated_at=datetime('now','localtime') WHERE id=?")
      .run(taskId, order.id)
    const stopInfo = stopOfOrder.get(order.id) || { stop: 1, priority: 10 }
    if (MOCK) {
      const t = { step: 0, taskId }
      mockTasks.set(taskId, t)
      t.timer = setTimeout(() => mockAdvance(store, taskId), 6000)
    } else {
      await realDispatchBatch(store, taskId, order, loading, unloading, batch, stopInfo)
    }
    results.push({ task_id: taskId, order_id: order.id, stop: stopInfo.stop })
  }
  return results
}

// 批次真实派车：与单任务 realDispatch 相同，但指定设备 + 按停靠顺序排 priority
async function realDispatchBatch(store, taskId, order, loading, unloading, batch, stopInfo) {
  if (!platformReady()) {
    updateTask(store, taskId, '未配置平台凭据，任务未下发')
    console.warn('[platform] 未配置 PLATFORM_APPID/PLATFORM_SECRET，真实配送未启用')
    return
  }
  let l = loading
  let u = unloading
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    const r = await syncLandmarks(store)
    if (r && r.ok) {
      l = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
      u = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    }
  }
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    updateTask(store, taskId, '待配置平台点位，任务未下发')
    console.warn('[platform] 缺少平台点位映射（platform_landmark_id），无法创建真实任务')
    return
  }
  const body = {
    principalId: PRINCIPAL_ID,
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
    feedbackDeliveryTaskUrl: CALLBACK_BASE ? CALLBACK_BASE + '/api/platform/callback/delivery' : '',
    checkBizOrderStatusUrl: CALLBACK_BASE ? CALLBACK_BASE + '/api/platform/check-order' : '',
    extInfo: { businessType: 'takeaway', batchNo: batch.batch_no, stop: stopInfo.stop },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deliveryTask/queue/create', body)
    const ok = r && (r.code === 'COMM_200' || r.success === true)
    if (ok) {
      const pid = (r.data && (r.data.id || r.data.taskId || r.data.deliveryTaskId)) || ''
      if (pid) {
        store.prepare("UPDATE delivery_tasks SET platform_task_id=?, task_status=0, status_text='排队中', updated_at=datetime('now','localtime') WHERE id=?")
          .run(String(pid), taskId)
      }
      console.log('[platform] 批次任务创建成功 taskId=' + taskId + ' platformTaskId=' + pid + ' batch=' + batch.batch_no + ' stop=' + stopInfo.stop)
    } else {
      updateTask(store, taskId, '创建任务失败：' + ((r && r.msg) || '未知错误'))
      console.warn('[platform] queue/create 失败', r)
    }
  } catch (e) {
    updateTask(store, taskId, '创建任务异常：' + e.message)
    console.warn('[platform] 创建排队任务异常', e.message)
  }
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
    if (!t.platform_task_id) { out.push({ task_id: t.id, ok: false, msg: '任务未下发到平台' }); continue }
    const r = await loadingVerify(t.device_sn, t.platform_task_id, { anyCode: t.pickup_code })
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
    if (!t.platform_task_id) { out.push({ task_id: t.id, ok: false, msg: '任务未下发到平台' }); continue }
    if (!t.device_sn) { out.push({ task_id: t.id, ok: false, msg: '缺少设备编号' }); continue }
    const r = await loadingConfirm(t.device_sn, t.platform_task_id, { anyCode: t.pickup_code })
    out.push({ task_id: t.id, ok: r.ok, msg: r.ok ? '' : r.msg })
  }
  return out
}

// 真实模式：调用排队任务创建接口（queue/create）
async function realDispatch(store, taskId, order, loading, unloading) {
  if (!platformReady()) {
    updateTask(store, taskId, '未配置平台凭据，任务未下发')
    console.warn('[platform] 未配置 PLATFORM_APPID/PLATFORM_SECRET，真实配送未启用')
    return
  }
  let l = loading
  let u = unloading
  // 点位缺少平台映射时，先尝试从平台同步
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    const r = await syncLandmarks(store)
    if (r && r.ok) {
      l = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
      u = store.prepare('SELECT * FROM landmarks WHERE id=?').get(order.landmark_id)
    }
  }
  if (!l || !u || !l.platform_landmark_id || !u.platform_landmark_id) {
    updateTask(store, taskId, '待配置平台点位，任务未下发')
    console.warn('[platform] 缺少平台点位映射（platform_landmark_id），无法创建真实任务')
    return
  }

  const body = {
    principalId: PRINCIPAL_ID,
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
    feedbackDeliveryTaskUrl: CALLBACK_BASE ? CALLBACK_BASE + '/api/platform/callback/delivery' : '',
    checkBizOrderStatusUrl: CALLBACK_BASE ? CALLBACK_BASE + '/api/platform/check-order' : '',
    extInfo: { businessType: 'takeaway' },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deliveryTask/queue/create', body)
    const ok = r && (r.code === 'COMM_200' || r.success === true)
    if (ok) {
      const pid = (r.data && (r.data.id || r.data.taskId || r.data.deliveryTaskId)) || ''
      if (pid) {
        store.prepare("UPDATE delivery_tasks SET platform_task_id=?, task_status=0, status_text='排队中', updated_at=datetime('now','localtime') WHERE id=?")
          .run(String(pid), taskId)
      }
      console.log('[platform] 排队任务创建成功 taskId=' + taskId + ' platformTaskId=' + pid)
    } else {
      updateTask(store, taskId, '创建任务失败：' + ((r && r.msg) || '未知错误'))
      console.warn('[platform] queue/create 失败', r)
    }
  } catch (e) {
    updateTask(store, taskId, '创建任务异常：' + e.message)
    console.warn('[platform] 创建排队任务异常', e.message)
  }
}

// ---------------- 任务状态同步 ----------------
// 回调通道：由 server.js /api/platform/callback/delivery 调用
function applyStatus(store, taskId, status, text) {
  updateTask(store, taskId, text, status)
  const order = store.prepare('SELECT o.* FROM delivery_tasks d JOIN orders o ON o.id=d.order_id WHERE d.id=?').get(taskId)
  if (!order) return
  let orderStatus = null
  if (status === 70) orderStatus = 3        // 到达取餐点 -> 已送达（待取餐）
  else if (status === 80) orderStatus = 4   // 完成
  else if (status === 110 || status === 150) orderStatus = 5 // 取消/关闭
  else if (status >= 90 && status < 100) orderStatus = 6     // 上货失败 -> 配送异常
  else if (status >= 100 && status < 110) orderStatus = 6    // 送货失败 -> 配送异常
  if (orderStatus !== null && Number(order.status) !== orderStatus) {
    store.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(orderStatus, order.id)
    // 到达取餐点(3)/任务完成(4) → 本单已售结算（幂等）
    if (orderStatus === 3 || orderStatus === 4) {
      try { require('./goodsStats').settleSales(store, order.id) } catch (e) { /* 忽略 */ }
    }
    // 平台侧取消(5) → 未售出则回补库存
    if (orderStatus === 5) {
      try { require('./goodsStats').restoreStock(store, order.id) } catch (e) { /* 忽略 */ }
    }
  }
  // 一车多单联动：任务完成/取消时更新批次（取餐计数/完成判断）
  const task = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
  if (task) {
    try {
      require('./batch').onTaskStatus(store, task, Number(status))
    } catch (e) { /* 批次联动异常静默 */ }
  }
}

function updateTask(store, taskId, text, status) {
  if (status === undefined) {
    store.prepare("UPDATE delivery_tasks SET status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(text, taskId)
  } else {
    store.prepare("UPDATE delivery_tasks SET task_status=?, status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, text, taskId)
  }
}

// 轮询兜底：basicList 按配送任务ID批量查询并同步状态
// （真实接口字段已按 Apifox open-logis_1.0 核对：查询参数为 idList，返回 data 数组即任务本体，无 task 包装）
async function syncTaskStatus(store, taskId) {
  if (MOCK || !platformReady()) return
  const t = store.prepare('SELECT d.*, o.order_no FROM delivery_tasks d LEFT JOIN orders o ON o.id=d.order_id WHERE d.id=?').get(taskId)
  if (!t || t.task_status >= 80 || (t.task_status >= 90 && t.task_status !== 120)) return
  if (!t.platform_task_id) return
  try {
    const q = '/open-api/v1/deliveryTask/basicList?idList=' + encodeURIComponent(t.platform_task_id)
    const r = await requestPlatform('GET', q)
    if (r && r.code === 'COMM_200') {
      const data = r.data
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : [])
      const item = list.find((x) => x && String(x.id) === String(t.platform_task_id))
        || list.find((x) => x && x.outOrderNo && t.order_no && String(x.outOrderNo).indexOf(t.order_no) > -1)
      if (item && item.taskStatus !== undefined) {
        const st = item.taskStatus
        applyStatus(store, taskId, st, STATUS_TEXT[st] || ('状态 ' + st))
        // 记录设备 SN 供位置接口使用
        if (item.deviceSn && !t.device_sn) {
          store.prepare('UPDATE delivery_tasks SET device_sn=? WHERE id=?').run(item.deviceSn, taskId)
        }
      }
    }
  } catch (e) { /* 轮询失败静默，等下一轮 */ }
}

// ---------------- 机器人实时位置 ----------------
const posCache = new Map() // taskId -> { ts, pos }

async function getDevicePosition(store, taskId) {
  const t = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
  if (!t) return null
  if (MOCK) return mockPosition(t.task_status)
  const hit = posCache.get(taskId)
  if (hit && Date.now() - hit.ts < 3000) return hit.pos
  if (!t.device_sn) return hit ? hit.pos : null
  try {
    const r = await requestPlatform('GET', '/open-api/v1/iotGatewayProxy/' + encodeURIComponent(t.device_sn) + '/buildingManager/om-api/EvizServer')
    const d = r && r.data
    if (d && Array.isArray(d.robotpose) && d.robotpose.length >= 2) {
      const pos = {
        x: d.robotpose[0],
        y: d.robotpose[1],
        theta: d.robotpose[2],
        timestamp: d.timestamp,
        locQuality: d.locQuality,
        text: STATUS_TEXT[t.task_status] || ''
      }
      posCache.set(taskId, { ts: Date.now(), pos })
      return pos
    }
  } catch (e) { /* 位置获取失败，回退缓存 */ }
  return hit ? hit.pos : null
}

// 机器状态码 -> 中文（与开放物流平台标准对照表一致，见 doc/06 常量字典）
const MACHINE_TEXT = {
  idle: '空状态', init: '初始化', setting: '设置', charging: '正在充电', returnChargingPile: '返回充电桩',
  standby: '待机中', returnStandby: '前往待机', exception: '异常',
  lightTask: '召唤', update: '升级', interaction: '交互',
  patrol: '巡逻中', Patrol: '巡逻中', Delivery: '配送中', delivery: '配送中',
  remoteDevOps: '远程运维', Acceptance: '验收'
}

// ---------------- 机器人设备列表 ----------------
// 调平台 runtimeStatusList，返回真实设备状态；未配置凭据/调用失败时返回 { ok:false, msg }
async function getDeviceList() {
  if (MOCK) return { ok: false, msg: '本地演示模式，未接入真实开放物流平台' }
  if (!platformReady()) return { ok: false, msg: '未配置开放物流平台凭据（PLATFORM_APPID/PLATFORM_SECRET/PLATFORM_PRINCIPALID）' }
  try {
    const r = await requestPlatform('GET', '/open-api/v1/deviceRuntime/runtimeStatusList?principalId=' + encodeURIComponent(PRINCIPAL_ID) + '&curPage=1&size=50')
    if (r.code !== 'COMM_200' || !r.data) {
      return { ok: false, msg: (r && r.msg) || '获取设备列表失败' }
    }
    const data = r.data
    const list = Array.isArray(data) ? data : (data.data || [])
    const onlineText = { 1: '在线', 2: '离线', 3: '故障' }
    return {
      ok: true,
      robots: list.map((d) => ({
        device_sn: d.deviceSn || '',
        name: d.name || d.deviceSn || '机器人',
        type: d.type || '',
        online: Number(d.onlineStatus) === 1,
        online_text: onlineText[d.onlineStatus] || '未知',
        battery: d.batteryLevel !== undefined && d.batteryLevel !== null ? d.batteryLevel : null,
        machine_status: d.machineStatus || '',
        machine_text: MACHINE_TEXT[d.machineStatus] || d.machineStatus || '未知',
        floor: d.currFloor || '',
        building: d.currBuildingName || '',
        version: d.softwareVersion || ''
      }))
    }
  } catch (e) {
    return { ok: false, msg: '获取机器人失败：' + e.message }
  }
}

// 查询任务状态（单条，供接口返回）
function getTaskStatus(store, taskId) {
  return store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
}

// ---------------- 商家面对面扫码上货（设备控制，真实模式） ----------------
// 流程：扫码识别机器人(authority/grant 获取控制权) → loading/verify 开舱(40) →
//       放货 → drawerCtrl 关舱(原地等待，任务仍 40) → loading/confirm 开始配送(50)
// Mock 模式：返回模拟成功，用于本地演示页面流程。

// 获取设备控制权（header duration 为超时秒数）
async function grantControl(deviceSn, durationSec = 180) {
  if (MOCK) return { ok: true, data: { ctrlId: 'mock-ctrl', sessionId: 'mock-session', expireTime: 0 } }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/authority/grant', { deviceSn, principalId: PRINCIPAL_ID }, { duration: String(durationSec) })
    return r && r.code === 'COMM_200'
      ? { ok: true, data: r.data || {} }
      : { ok: false, msg: (r && r.msg) || '获取设备控制权失败' }
  } catch (e) {
    return { ok: false, msg: '获取设备控制权异常：' + e.message }
  }
}

// 上货验证（验证通过自动开舱，任务流转 40 上货中）
async function loadingVerify(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/loading/verify', {
      deviceSn, id: String(platformTaskId), strategies: strategies || {}, autoOpen: true
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '上货验证失败' }
  } catch (e) {
    return { ok: false, msg: '上货验证异常：' + e.message }
  }
}

// 舱门控制：stockCmd 1 开 / 0 关（不影响任务状态，用于「关舱等待」）
async function drawerCtrl(deviceSn, stockCmd) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/drawerCtrl', {
      deviceSn, stockPos: 'pos_1', stockCmd: Number(stockCmd)
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '舱门控制失败' }
  } catch (e) {
    return { ok: false, msg: '舱门控制异常：' + e.message }
  }
}

// 确认上货：关舱并开始配送（任务流转 50 已上货）
async function loadingConfirm(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/loading/confirm', {
      deviceSn, id: String(platformTaskId), strategies: strategies || {}
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '确认上货失败' }
  } catch (e) {
    return { ok: false, msg: '确认上货异常：' + e.message }
  }
}

// ---------------- 用户取餐（下货验证开舱 / 确认关舱） ----------------
// 开舱取餐：unloading/verify 验证通过自动开舱（开舱即完成，任务流转 80）
async function unloadingVerify(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/unloading/verify', {
      taskIdList: [String(platformTaskId)], deviceSn, strategies: strategies || {}, autoOpen: true
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '开舱失败' }
  } catch (e) {
    return { ok: false, msg: '开舱异常：' + e.message }
  }
}

// 关闭舱门：unloading/confirm 关舱返回（40s 未调用平台自动关舱；此项不改变任务状态）
async function unloadingConfirm(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/unloading/confirm', {
      deviceSn, strategies: strategies || {}
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '关舱失败' }
  } catch (e) {
    return { ok: false, msg: '关舱异常：' + e.message }
  }
}

module.exports = { createQueueTask, createTasksForBatch, batchPendingTasks, verifyBatchLoading, confirmBatchLoading, pickAvailableRobot, getTaskStatus, getDevicePosition, syncTaskStatus, syncLandmarks, getMapOverview, applyStatus, platformReady, getDeviceList, grantControl, loadingVerify, drawerCtrl, loadingConfirm, unloadingVerify, unloadingConfirm }
