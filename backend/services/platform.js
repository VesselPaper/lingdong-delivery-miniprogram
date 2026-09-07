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
// 依赖方向说明（避免成环）：
//  - runtime.js 只 require wxpay.js，本文件 require 它是单向安全的（server.js 也已先加载完它）。
//  - orderCancel.js 只在函数体内延迟 require 本文件，加载期不成环，运行时拿到的是完整 exports。
const runtime = require('./runtime')
const goodsStats = require('./goodsStats')
const batch = require('./batch')
const orderCancel = require('./orderCancel')

const MOCK = process.env.PLATFORM_MOCK === 'true'
const APPID = process.env.PLATFORM_APPID || ''
const SECRET = process.env.PLATFORM_SECRET || ''
const PRINCIPAL_ID = process.env.PLATFORM_PRINCIPALID || ''
const BASE = process.env.PLATFORM_BASE || 'https://test-robox.eventec.cn/service-open-logis'
// 回调公网地址（如 cloudflared 内网穿透域名）；未配置时创建任务不带回调，用 basicList 轮询兜底
const CALLBACK_BASE = (process.env.PLATFORM_CALLBACK_BASE || '').replace(/\/$/, '')

const CALLBACK_PATHS = {
  delivery: '/api/platform/callback/delivery',
  'check-order': '/api/platform/check-order',
  exception: '/api/platform/callback/exception'
}

// 生成注册到平台的回调 URL，防伪令牌以 ?token= 查询参数携带。
// 为什么用 query 而不是路径段：平台侧示例回调 URL 自带 "&version+3d24d260000" 后缀
// （见 接口\默认模块.openapi.json），说明注册进去的 URL 后面还会被拼接内容。
// 拼在 ?token=X 之后仍能正常解析；拼在路径段后会变成 /cb/<token>/delivery&version+…，直接 404。
// 服务端同时接受 query、路径段与 body 三种位置（见 server.js callbackAuthorized）。
function callbackUrl(leaf) {
  if (!CALLBACK_BASE) return ''
  const p = CALLBACK_BASE + CALLBACK_PATHS[leaf]
  const t = runtime.callbackToken
  return t ? p + '?token=' + encodeURIComponent(t) : p
}

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

// 停止本地模拟推进。mockAdvance 会自己续 setTimeout 且此前无人 clearTimeout，
// 取消订单后它仍会每 4s 把状态往前推，是「已取消订单复活成已送达」最稳定的复现路径。
// 由 orderCancel.cancelLocal 在作废任务时调用。
function cancelMockTask(taskId) {
  const id = Number(taskId)
  const t = mockTasks.get(id)
  if (!t) return false
  if (t.timer) clearTimeout(t.timer)
  mockTasks.delete(id)
  return true
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
    // 平台调用超时（P1-11）：一个挂起的请求会拖死轮询/派车/追踪等 for-await 串行链路
    req.setTimeout(10000, () => { req.destroy(new Error('平台请求超时(10s)：' + method + ' ' + path)) })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function platformReady() {
  return !!(APPID && SECRET && PRINCIPAL_ID)
}

// ---------------- 派车告警钩子（由 server.js 注入 runtime.warnIfUnsafeDispatch） ----------------
// 用注入而非直接 require('./runtime')：runtime.js 若在加载期 require 本文件，会因本文件的
// module.exports 位于文件末尾而拿到空对象，导致启动守卫静默失效。依赖方向必须保持单向。
let dispatchHook = null
function setDispatchHook(fn) {
  dispatchHook = typeof fn === 'function' ? fn : null
}
function notifyDispatch(ctx) {
  if (!dispatchHook) return
  try { dispatchHook(ctx) } catch (e) { /* 告警失败不影响派车 */ }
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
// mapInfo 缓存 60s：追踪页 3s 轮询 / 监控页 5s 轮询 / 地图接口共享同一份地图元数据，
// 避免每 3 秒对平台发一次 building/mapInfo 全量请求（P1-11 同类问题：串行同步调用拖死事件循环）。
let mapInfoCache = { ts: 0, data: null }

async function getMapRaw(store) {
  if (mapInfoCache.data && Date.now() - mapInfoCache.ts < 60000) return mapInfoCache.data
  const lm = store.prepare("SELECT * FROM landmarks WHERE platform_building_id != '' ORDER BY sort LIMIT 1").get()
  if (!lm || !lm.platform_map_id) return null
  try {
    const m = await requestPlatform('GET', '/open-api/v1/building/mapInfo/' + encodeURIComponent(lm.platform_map_id))
    if (m.code !== 'COMM_200' || !m.data || !m.data.map) return mapInfoCache.data
    mapInfoCache = { ts: Date.now(), data: m.data }
    return m.data
  } catch (e) {
    return mapInfoCache.data
  }
}

// 由 mapInfo 的 landmarks + 固定路径 graph 节点计算坐标 bbox（坐标空间与 eviz robotpose 一致）
function computeMapBbox(data) {
  const detail = (data && data.mapDetailInfo) || {}
  const pts = detail.landmarks || {}
  const xs = []
  const ys = []
  for (const k of Object.keys(pts)) {
    const p = pts[k]
    if (p && Array.isArray(p.pose) && p.pose.length >= 2) { xs.push(Number(p.pose[0])); ys.push(Number(p.pose[1])) }
  }
  const line = pts['固定路径'] || Object.values(pts).find((p) => p && p.graph)
  if (line && line.graph) {
    const nodes = line.graph.nodes || {}
    for (const nk of Object.keys(nodes)) {
      const pos = nodes[nk].pos || []
      if (pos.length >= 2) { xs.push(Number(pos[0])); ys.push(Number(pos[1])) }
    }
  }
  if (!xs.length) return null
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// 地图坐标 bbox（供用户端追踪页把机器人坐标归一化为百分比；缓存 60s）
async function getMapBbox(store) {
  const data = await getMapRaw(store)
  return data ? computeMapBbox(data) : null
}

async function getMapOverview(store) {
  const data = await getMapRaw(store)
  if (!data) return { ok: false, msg: '未同步点位或获取地图失败' }
  const mapUrl = data.map
  const barrierUrl = data.barrier || ''
  const detail = data.mapDetailInfo || {}
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
  const bbox = computeMapBbox(data)
  if (!bbox) return { ok: false, msg: '地图无点位数据' }
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
  // 防御：用最新批次行（派车流程会在中途写入 device_sn，调用方传入的对象可能仍是旧值）
  batch = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batch.id) || batch
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
  notifyDispatch({ batch_id: batch.id, batch_no: batch.batch_no })
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
    feedbackDeliveryTaskUrl: callbackUrl('delivery'),
    checkBizOrderStatusUrl: callbackUrl('check-order'),
    extInfo: { businessType: 'takeaway', batchNo: batch.batch_no, stop: stopInfo.stop },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    // 排队任务（queue/create）：完整上货流程。注：机器人充电中不拉取排队任务（见 逻辑树/树 图四），
    // 待与越凡确认待机策略后再切换为可用派车方式。
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
  notifyDispatch({ order_id: order.id })
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
    feedbackDeliveryTaskUrl: callbackUrl('delivery'),
    checkBizOrderStatusUrl: callbackUrl('check-order'),
    extInfo: { businessType: 'takeaway' },
    consigneePrincipalName: order.contact_name || '',
    consigneePrincipalPhone: order.contact_phone || ''
  }
  try {
    // 排队任务（queue/create）：完整上货流程。注：机器人充电中不拉取排队任务（见 逻辑树/树 图四），
    // 待与越凡确认待机策略后再切换为可用派车方式。
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
// 订单状态单向推进：0待支付 → 1待接单 → 2配送中 → 3已送达 → 4已完成
const ORDER_RANK = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 }
const ORDER_TERMINAL = [5, 7]     // 已取消 / 已退款
const TASK_TERMINAL = [110, 150]  // 任务取消 / 任务关闭

// 订单状态是否允许这样迁移。禁止从终态迁出，禁止正常链路倒退。
// 6配送异常 是旁路状态：可由 1/2/3 进入，重试后回到 2。
function canMoveOrderStatus(from, to) {
  const f = Number(from)
  const t = Number(to)
  if (f === t) return false
  if (ORDER_TERMINAL.includes(f)) return false
  if (t === 5) return [0, 1, 2, 3, 6].includes(f)
  if (t === 6) return [1, 2, 3].includes(f)
  if (f === 6) return [2, 3, 4].includes(t)
  const rf = ORDER_RANK[f]
  const rt = ORDER_RANK[t]
  if (rf === undefined || rt === undefined) return false
  return rt > rf
}

// 任务状态写入的唯一咽喉：平台回调（server.js /api/platform/callback/delivery）、
// basicList 轮询兜底（syncTaskStatus）、本地模拟（mockAdvance）三条通道全部经过这里，
// 因此终态守卫只需在这一处实现。
function applyStatus(store, taskId, status, text) {
  const st = Number(status)   // 回调报文里的 taskStatus 可能是字符串，先归一化
  const task = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
  if (!task) return
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(task.order_id) || null

  // ---- 终态守卫 ----
  // 本地已作废（void_at / 110 / 150）或订单已取消退款时，丢弃一切迟到的平台状态。
  // 少了这道守卫：取消订单后 mockAdvance 仍在每 4s 推进，推来的 70 会把已取消订单
  // 改回「已送达(3)」并结算销量，goods_settled=1 令库存回补永久锁死，用户随后能在取餐页
  // 真的开舱取走这单已退款的餐。反向同理：已退款(7) 收到 110 会被降级成已取消并二次回补库存。
  // 注意判据必须是显式标记列 —— 状态码 110(取消) < 120(挂起)，比大小判不出终态。
  const taskVoided = !!task.void_at || TASK_TERMINAL.includes(Number(task.task_status))
  const orderVoided = !!order && (!!order.cancelled_at || ORDER_TERMINAL.includes(Number(order.status)))
  if (taskVoided || orderVoided) {
    // 仅接受平台对「任务被关闭(150)」的确认（即我们请求的 forceCloseTask 已生效），
    // 且只更新任务自身，绝不联动订单 / 库存 / 批次 —— 那些副作用在取消时已执行过一次。
    if (st === 150 && Number(task.task_status) !== 150) {
      updateTask(store, taskId, text || STATUS_TEXT[150], 150)
      console.warn(`[platform] 任务${taskId} 已作废，仅记录平台关闭确认(150)，不联动订单`)
    } else {
      console.warn(`[platform] 丢弃迟到状态 ${st}「${text || STATUS_TEXT[st] || ''}」：任务${taskId} 已作废或订单已终态`)
    }
    return
  }

  // 平台侧取消/关闭：与本地取消走完全相同的落账路径（幂等由 orderCancel 保证）。
  // task_status 与 void_at 必须一次写完，否则随后的 voidTasks 会因已是 110 而跳过 void_at。
  if (st === 110 || st === 150) {
    store.prepare(`UPDATE delivery_tasks SET task_status=?, status_text=?,
      void_at=COALESCE(void_at, datetime('now','localtime')), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(st, text || STATUS_TEXT[st] || ('状态 ' + st), taskId)
    try {
      orderCancel.cancelLocal(store, order, { finalStatus: 5, reason: STATUS_TEXT[st] || '任务取消' })
    } catch (e) { console.warn('[platform] 平台取消落账失败', e.message) }
    return
  }

  updateTask(store, taskId, text, st)
  if (!order) return

  let orderStatus = null
  if (st === 70) orderStatus = 3            // 到达取餐点 -> 已送达（待取餐）
  else if (st === 80) orderStatus = 4       // 任务完成
  else if (st >= 90 && st < 110) orderStatus = 6  // 上货失败(9x) / 取货失败(10x) -> 配送异常
  if (orderStatus !== null && canMoveOrderStatus(order.status, orderStatus)) {
    store.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(orderStatus, order.id)
    // 到达取餐点(3)/任务完成(4) → 本单已售结算（幂等）
    if (orderStatus === 3 || orderStatus === 4) {
      try { goodsStats.settleSales(store, order.id) } catch (e) { /* 忽略 */ }
    }
  } else if (orderStatus !== null) {
    console.warn(`[platform] 忽略订单状态迁移 ${order.status}→${orderStatus}（任务${taskId} 状态${st}）`)
  }
  // 一车多单联动：任务完成时更新批次取餐计数与完成判断
  const fresh = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
  if (fresh) {
    try { batch.onTaskStatus(store, fresh, st) } catch (e) { /* 批次联动异常静默 */ }
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
  // 只跳过真正的终态：80 完成、110/150 取消关闭、本地已作废（void_at）。
  // 70 到达取货点必须继续轮询：它只是「机器人已到、等待用户取餐」的停等态 ——
  // 若平台的到达回调丢失而任务停在 70，轮询是唯一能把订单推进到「已送达(3)」的兜底；
  // 把它一并跳过会令订单永久卡在配送中(2)，用户连取餐入口都打不开。
  // 同时 90-109（上货/取货失败）也必须轮询以驱动到「配送异常(6)」（P1-4），
  // 原写法 task_status >= 80 一律跳过，把这些非终态全挡在了轮询外。
  if (!t || [80, 110, 150].includes(Number(t.task_status)) || t.void_at) return
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
      deviceSn, id: Number(platformTaskId), strategies: strategies || {}, autoOpen: true
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
      deviceSn, id: Number(platformTaskId), strategies: strategies || {}
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '确认上货失败' }
  } catch (e) {
    return { ok: false, msg: '确认上货异常：' + e.message }
  }
}

// ---------------- 无人车位置门禁（需求3：配单/上货必须先确认车在上货点） ----------------
// 判据：设备实时位置（eviz robotpose）与 loadingPoint 点位坐标距离 ≤ 阈值；
// 兜底：该设备最近任务状态 ∈ {30,40}（30=到达上货点 / 40=上货中）视为已就位。
// MOCK 档恒 ok（demo 冒烟不受影响）；位置/设备拿不到 → 保守拒绝，宁可挡住不可假装。
const LOADING_RADIUS_M = Number(process.env.LOADING_POINT_RADIUS_M || 5)

async function robotAtLoadingPoint(store, deviceSn) {
  if (MOCK) return { ok: true, at_loading_point: true, distance_m: 0 }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号', at_loading_point: false, distance_m: null }
  const loading = store.prepare("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get()
  if (!loading) return { ok: false, msg: '未配置上货点（loadingPoint）点位', at_loading_point: false, distance_m: null }
  // 任务状态兜底：该设备最近任务已到达上货点/上货中
  const t = store.prepare("SELECT * FROM delivery_tasks WHERE device_sn=? AND void_at IS NULL ORDER BY id DESC LIMIT 1").get(deviceSn)
  if (t && [30, 40].includes(Number(t.task_status))) {
    return { ok: true, at_loading_point: true, distance_m: 0, by_task_status: true }
  }
  // 上货点坐标缺失时无法算距离，只能依赖任务状态（上面已判）
  const lx = Number(loading.pos_x)
  const ly = Number(loading.pos_y)
  if (!Number.isFinite(lx) || !Number.isFinite(ly) || (lx === 0 && ly === 0)) {
    return { ok: false, msg: '上货点未同步平台坐标，无法判断无人车是否就位', at_loading_point: false, distance_m: null }
  }
  const pos = t ? await getDevicePosition(store, t.id) : null
  if (!pos || isNaN(pos.x) || isNaN(pos.y)) {
    return { ok: false, msg: '无法获取无人车位置，请确认无人车在线并到达上货点', at_loading_point: false, distance_m: null }
  }
  const dx = Number(pos.x) - lx
  const dy = Number(pos.y) - ly
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist <= LOADING_RADIUS_M) {
    return { ok: true, at_loading_point: true, distance_m: Math.round(dist * 100) / 100 }
  }
  return {
    ok: false,
    msg: `无人车未在上货点（距上货点约 ${Math.round(dist)} 米），请等待其返回后再上货`,
    at_loading_point: false,
    distance_m: Math.round(dist * 100) / 100
  }
}

// 无人车是否空闲可接单（派车门禁用）：
// 存在 50-79 活跃任务（配送中/待取餐）算忙；设备列表状态为配送/巡逻/异常/离线/运维/升级算忙；
// 设备列表查不到该车 → 保守拒绝。MOCK 档恒空闲。
async function isRobotBusy(store, deviceSn) {
  if (MOCK) return { ok: true, busy: false, msg: '' }
  if (!deviceSn) return { ok: false, busy: true, msg: '缺少设备编号' }
  const active = store.prepare(`
    SELECT COUNT(*) c FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
    WHERE d.device_sn=? AND d.void_at IS NULL AND d.task_status BETWEEN 50 AND 79`).get(deviceSn)
  if (active && Number(active.c) > 0) return { ok: false, busy: true, msg: '无人车正在配送中，请等其返回后再派车' }
  const r = await getDeviceList()
  if (r.ok && r.robots && r.robots.length) {
    const me = r.robots.find((x) => x.device_sn === deviceSn)
    if (me) {
      if (!me.online) return { ok: false, busy: true, msg: '无人车当前离线，无法派车' }
      const busyStatus = ['Delivery', 'delivery', 'patrol', 'Patrol', 'exception', 'remoteDevOps', 'update', 'interaction', 'lightTask']
      if (busyStatus.includes(me.machine_status)) {
        return { ok: false, busy: true, msg: '无人车正在' + (me.machine_text || '忙碌') + '，请等其空闲后再派车' }
      }
      return { ok: true, busy: false, msg: '' }
    }
  }
  return { ok: false, busy: true, msg: '无法确认无人车状态（设备列表查询失败或未找到该车）' }
}

// ---------------- 取消/退款时的真实召回（P0-4 修复） ----------------
// 排队中（未被机器人拉取，task_status<10）→ 取消排队任务；已上货/途中 → 强制关闭任务（舱内有货自动开舱让用户取货）。
// 本地库是唯一真相源：召回失败只记 recall_status=2 待人工，绝不回滚本地取消。

// 取消排队中任务
async function cancelQueueTask(platformTaskId) {
  if (MOCK) return { ok: true }
  if (!platformTaskId) return { ok: false, msg: '缺少平台任务ID' }
  try {
    const r = await requestPlatform('PUT', '/open-api/v1/deliveryTask/queue/cancel', { id: Number(platformTaskId), principalId: PRINCIPAL_ID })
    return r && r.code === 'COMM_200' ? { ok: true, data: r.data || {} } : { ok: false, msg: (r && r.msg) || '取消排队任务失败' }
  } catch (e) {
    return { ok: false, msg: '取消排队任务异常：' + e.message }
  }
}

// 强制关闭任务（已上货未送达阶段）
async function closeTask(deviceSn, platformTaskId, reason) {
  if (MOCK) return { ok: true }
  if (!deviceSn || !platformTaskId) return { ok: false, msg: '缺少设备编号或任务ID' }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/close', {
      deviceSn, principalId: PRINCIPAL_ID, taskId: Number(platformTaskId), stockPos: 'pos_1',
      extInfo: { keyEvent: { eventName: 'forceCloseTask', taskSubStatus: -1, eventDesc: reason || '' } }
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '强制关闭任务失败' }
  } catch (e) {
    return { ok: false, msg: '强制关闭任务异常：' + e.message }
  }
}

// 释放设备控制权（配套 authority/grant；路径/语义需与越凡确认）
async function releaseControl(ctrlId) {
  if (MOCK) return { ok: true }
  if (!ctrlId) return { ok: false, msg: '缺少控制权ID' }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/authority/release', { ctrlId })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '释放控制权失败' }
  } catch (e) {
    return { ok: false, msg: '释放控制权异常：' + e.message }
  }
}

// ---------------- 用户取餐（下货验证开舱 / 确认关舱） ----------------
// 开舱取餐：unloading/verify 验证通过自动开舱（开舱即完成，任务流转 80）
async function unloadingVerify(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/unloading/verify', {
      taskIdList: [Number(platformTaskId)], deviceSn, strategies: strategies || {}, autoOpen: true
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

module.exports = { createQueueTask, createTasksForBatch, batchPendingTasks, verifyBatchLoading, confirmBatchLoading, pickAvailableRobot, getTaskStatus, getDevicePosition, syncTaskStatus, syncLandmarks, getMapOverview, getMapBbox, applyStatus, platformReady, getDeviceList, grantControl, releaseControl, loadingVerify, drawerCtrl, loadingConfirm, unloadingVerify, unloadingConfirm, cancelQueueTask, closeTask, setDispatchHook, cancelMockTask, robotAtLoadingPoint, isRobotBusy }
