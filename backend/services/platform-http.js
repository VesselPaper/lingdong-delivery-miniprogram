// services/platform-http.js —— 开放物流平台对接·HTTP/查询/控制基础层（结构评审 P0-2 拆分件之一）
// ------------------------------------------------------------------
// 职责：平台通信原语（签名请求/超时）、点位与地图数据、机器人位置/标定、设备列表与控制、
// 到达门禁判定。**不含**业务编排状态机（任务创建流程）、不含回调落账处理 —— 那些在
// platform.js（编排入口）与 platform-callbacks.js（回调/轮询状态同步）。
// 依赖方向：本文件只 require Node 内置模块与 services/batch（延迟），被 mock/callbacks/入口 require。
// 数据项归属不变（按数据项分层）：订单状态迁移一律经注入的 orderStateSink（见入口 platform.js）。
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

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

// 平台回调防伪令牌：与 runtime.js 导出的 callbackToken 一致（显式配置优先，否则由 PLATFORM_SECRET 派生）。
// 依赖方向：runtime 只依赖 wxpay（叶子模块），本文件 require runtime 单向安全（server.js 也先加载 runtime）。
const runtime = require('./runtime')

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

// 本地演示模式的模拟坐标（MOCK 档 getDevicePosition 使用）
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

// 平台日期时间字符串格式（Apifox 规格）：yyyy-MM-dd HH:mm:ss，本地时区
function formatLocalDt(ts) {
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
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

// ---------------- 机器人自身点位（landmarkInfo，实时刷新） ----------------
// 数据来源：/open-api/v1/building/landmarkInfo（type=deliverPoint / patrolPoint）
// 返回机器人自己配置的场地点位（取货点/巡逻点/上货点），坐标空间与 mapInfo bbox / eviz robotpose 一致。
// 30s 缓存：随 /admin/map 4s 轮询自动刷新，避免每轮都对平台发起全量请求。
let landmarkCache = { ts: 0, data: null }
async function getPlatformLandmarks(store) {
  if (landmarkCache.data && Date.now() - landmarkCache.ts < 30000) return landmarkCache.data
  const out = []
  try {
    if (!platformReady()) return landmarkCache.data || out
    const lm0 = store.prepare("SELECT platform_building_id FROM landmarks WHERE platform_building_id != '' LIMIT 1").get()
    const buildingId = lm0 && lm0.platform_building_id
    if (!buildingId) return landmarkCache.data || out
    for (const type of ['deliverPoint', 'patrolPoint']) {
      const r = await requestPlatform('GET', '/open-api/v1/building/landmarkInfo?buildingId=' + encodeURIComponent(buildingId) + '&type=' + type)
      const pts = (r && r.data) || []
      if (!Array.isArray(pts)) continue
      for (const p of pts) {
        if (!p || !p.landmarkName) continue
        const pose = Array.isArray(p.pose) ? p.pose : []
        if (pose.length < 2) continue
        out.push({
          id: p.landmarkId || '',
          name: p.landmarkName,
          type: /上货|商铺|店铺|铺子/.test(p.landmarkName) ? 'loadingPoint' : type,
          x: Number(pose[0]),
          y: Number(pose[1])
        })
      }
    }
    if (out.length) landmarkCache = { ts: Date.now(), data: out }
    return out.length ? out : (landmarkCache.data || out)
  } catch (e) {
    return landmarkCache.data || out
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
  const pts = detail.landmarks || {}
  // 点位：机器人自身点位（landmarkInfo 接口，实时刷新）；接口失败时回退 mapDetailInfo 内嵌点位
  let landmarks = await getPlatformLandmarks(store)
  if (!landmarks.length) {
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
  }
  // 充电点（充电桩）：只存在于地图 mapDetailInfo.landmarks（type=chargePoint，pose 数组），
  // 不在本地 landmarks / landmarkInfo 接口里。追加进点位集，让地图（车当前位置旁）能显示充电点位置。
  // 地图里同一充电点可能以多个 key 重复收录（name+坐标相同），去重只留一份。
  const chargeSeen = new Set()
  for (const k of Object.keys(pts)) {
    const p = pts[k]
    if (!p || p.type !== 'chargePoint' || !Array.isArray(p.pose) || p.pose.length < 2) continue
    const name = p.name || '充电点'
    const cx = Number(p.pose[0]), cy = Number(p.pose[1])
    const uniq = name + '|' + cx + '|' + cy
    if (chargeSeen.has(uniq)) continue
    chargeSeen.add(uniq)
    landmarks.push({ id: p.id || k, name, type: 'chargePoint', x: cx, y: cy })
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
  // 雷达图像素映射元数据（ROS map 惯例：origin=图片左下角世界坐标，resolution=米/像素，width/height=像素数）
  const md = detail.metadata || {}
  const meta = (md.width && md.height && md.resolution) ? {
    width: Number(md.width),
    height: Number(md.height),
    resolution: Number(md.resolution),
    origin: Array.isArray(md.origin) && md.origin.length >= 2 ? [Number(md.origin[0]), Number(md.origin[1])] : [0, 0]
  } : null
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
    // 机器人实时位置（按设备列表直取，兼容召唤多单配送：无配送任务也能显示车的位置）
    const robots = []
    try {
      const devList = await getDeviceList()
      if (devList.ok && Array.isArray(devList.robots)) {
        for (const dev of devList.robots) {
          if (!dev.online || !dev.device_sn) continue
          const pos = await getDevicePositionBySn(store, dev.device_sn, dev.machine_text || '')
          const ax = pos && !isNaN(pos.ax) ? Number(pos.ax) : (pos && !isNaN(pos.x) ? Number(pos.x) : NaN)
          const ay = pos && !isNaN(pos.ay) ? Number(pos.ay) : (pos && !isNaN(pos.y) ? Number(pos.y) : NaN)
          if (!isNaN(ax) && !isNaN(ay)) {
            robots.push({ device_sn: dev.device_sn, x: ax, y: ay, theta: Number(pos.theta || 0), text: pos.text || '', raw: pos.raw })
          }
        }
      }
    } catch (e) { /* 机器人位置采集失败不影响地图其余部分 */ }
    return { ok: true, map_url: mapUrl, barrier_url: barrierUrl, bbox, meta, landmarks, graph, robots, routes, admin_calib: adminCalibStatus() }
}

// ---------------- 地图底图字节（由后端代理下载） ----------------
// 存在理由：building/mapInfo 返回的 map 是 OSS 签名直链，签名有效期极短 —— 实测取到手时已过期
// 14 秒、直接下载 403。把这条 URL 交给浏览器（大屏）或小程序前端去下载，必然间歇性白图。
// 因此改为后端下载字节并缓存，前端只访问后端自己的稳定地址（见 server.js /api/dashboard/map-image）。
function httpGetBuffer(url, redirectLeft) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch (e) { return resolve({ ok: false, msg: '图片地址非法' }) }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'lingdong-backend/1.0' }
    }, (res) => {
      // OSS 可能 302 跳到真实节点
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectLeft <= 0) return resolve({ ok: false, msg: '重定向过多' })
        const loc = res.headers.location
        const next = loc.indexOf('http') === 0 ? loc : (u.protocol + '//' + u.host + loc)
        return resolve(httpGetBuffer(next, redirectLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return resolve({ ok: false, msg: '底图下载失败 HTTP ' + res.statusCode, status: res.statusCode })
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        ok: true,
        buf: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || 'image/png'
      }))
    })
    req.setTimeout(10000, () => { req.destroy(new Error('底图下载超时(10s)')) })
    req.on('error', (e) => resolve({ ok: false, msg: e.message || '底图下载异常' }))
  })
}

// 绕过 60s mapInfo 缓存强制取一份新签名（仅在缓存里的签名已过期时使用）
async function fetchMapRawFresh(store) {
  const lm = store.prepare("SELECT * FROM landmarks WHERE platform_building_id != '' ORDER BY sort LIMIT 1").get()
  if (!lm || !lm.platform_map_id) return null
  try {
    const m = await requestPlatform('GET', '/open-api/v1/building/mapInfo/' + encodeURIComponent(lm.platform_map_id))
    if (m.code === 'COMM_200' && m.data && m.data.map) {
      mapInfoCache = { ts: Date.now(), data: m.data }
      return m.data
    }
    return null
  } catch (e) { return null }
}

async function getMapImageBytes(store) {
  if (MOCK) return { ok: false, msg: '本地演示模式无平台底图' }
  if (!platformReady()) return { ok: false, msg: '未配置平台凭据' }

  // 平台签名的地图直链约 14 秒即过期（见 README）。共享的 60s mapInfo 缓存对「点位 pose」够用、
  // 但缓存里的签名 URL 转手就失效，因此**下载底图一律取一份新鲜签名**再下载，
  // 失败则重新签名重试，避免偶发 502。
  let url = ''
  const fresh = await fetchMapRawFresh(store)               // 新鲜签名（不一定每次都能拿到）
  if (fresh && fresh.map) url = fresh.map
  if (!url) {                                               // 新鲜失败时退回缓存里的 URL 兜底
    const cached = await getMapRaw(store)
    if (cached && cached.map) url = cached.map
  }
  if (!url) return { ok: false, msg: '未获取到地图图片地址' }

  for (let i = 0; i < 3; i++) {
    const r = await httpGetBuffer(url, 3)
    if (r.ok && r.buf && r.buf.length) return r
    if (i >= 2) return { ok: false, msg: (r && r.msg) || '底图下载多次失败' }
    // 重试前强制重新签名：上一条 URL 很可能刚过期
    const again = await fetchMapRawFresh(store)
    if (again && again.map) url = again.map
  }
  return { ok: false, msg: '底图下载多次失败' }
}

// ---------------- 机器人实时位置 ----------------
const posCache = new Map() // taskId -> { ts, pos }

// eviz robotpose（激光 SLAM 网格坐标）→ 平台局部米 的相似变换标定。
// 2026-09-16 真机实测两组对应点求解并自洽验证：
//   商铺上货 (18.262, 6.537) ↔ robotpose (733, 2583)
//   充电点1  (19.931, 8.125) ↔ robotpose (1145, 2497)
// robotpose = s*R*landmark + t；逆变换：landmark = R⁻¹*(robotpose - t)/s
// 解：s=182.67, R=-55.37°(cos=0.5681, sin=-0.8229), t=(-2144.6, 4649.8)
// ⚠️ 平台若重新标定地图（点位 pose 变化），需用同样的「两对应点」方法重新标定。
const POS_CAL = { s: 182.67, cos: 0.5681, sin: -0.8229, tx: -2144.6, ty: 4649.8 }
function robotposeToMeters(rx, ry) {
  const px = rx - POS_CAL.tx
  const py = ry - POS_CAL.ty
  return {
    x: (POS_CAL.cos * px + POS_CAL.sin * py) / POS_CAL.s,
    y: (-POS_CAL.sin * px + POS_CAL.cos * py) / POS_CAL.s
  }
}

// ================= 管理页自动标定（robotpose 网格 → 地图米制），免手动跑车 =================
// 背景：robotpose 是 SLAM 网格帧（大数，如 1025,2725）；地图点位/landmark 是米制帧（小值，如
// 商铺上货 17.566,6.515），陆地底图用 ROS metadata.pgm（origin[-37,-137] res0.05, 5786x5406）。
// 二者差一个相似变换，旧 POS_CAL 已对当前地图失效。
// 方案：不专门跑车标定——机器人**正常配送/召唤**每到已知点位（robotAtPoint 判定到达）时，
// 自动把「robotpose 原始网格, landmark 米」记一对；攒到 ≥2 个相距够远的锚点就解相似变换并持久化，
// 管理页显示用它把 robotpose 换成地图帧。**全局 POS_CAL / 配送到达判定完全不碰**（只读观测）。
// 开关：ADMIN_AUTO_CALIB=false 关闭；ADMIN_CALIB_RANGE_M 为两锚点间最小米距（默认 8m，保证 scale 可靠）。
const ADMIN_CALIB_ENABLED = process.env.ADMIN_AUTO_CALIB !== 'false'
const ADMIN_CALIB_RANGE_M = Number(process.env.ADMIN_CALIB_RANGE_M || 8.0)
const CALIB_FILE = path.join(__dirname, '..', 'data', 'admin-calib.json')
let autoCalibState = null
function loadAutoCalib() {
  if (autoCalibState) return autoCalibState
  autoCalibState = { enabled: ADMIN_CALIB_ENABLED, pairs: [], calib: null, message: '' }
  try {
    const j = JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8'))
    autoCalibState.pairs = Array.isArray(j && j.pairs) ? j.pairs : []
    autoCalibState.calib = (j && j.calib) || null
    autoCalibState.message = (j && j.message) || ''
  } catch (e) { /* 首次运行尚无文件 */ }
  return autoCalibState
}
function saveAutoCalib() {
  const s = autoCalibState
  try { fs.writeFileSync(CALIB_FILE, JSON.stringify({ pairs: s.pairs, calib: s.calib, message: s.message })) } catch (e) { /* 写失败可忽略 */ }
}
// 到达判定通过后由调用方传入（robotpose 原始网格, landmark 米）。只追加观测，线性去重，不影响业务。
function recordCalibPosePair(deviceSn, rx, ry, lmx, lmy) {
  const s = loadAutoCalib()
  if (!s.enabled) return
  if (![rx, ry, lmx, lmy].every(Number.isFinite)) return
  // 与已存锚点在米制帧相距 < 4m 则略过（保证锚点尽量分散）
  const near = s.pairs.some((p) => Math.hypot(p.lmx - lmx, p.lmy - lmy) < 4)
  if (near) return
  s.pairs.push({ sn: deviceSn, rx: Math.round(rx), ry: Math.round(ry), lmx, lmy, ts: Date.now() })
  if (s.pairs.length > 64) s.pairs = s.pairs.slice(-64)
  const cal = solveCalibSimilarity(s.pairs)
  if (cal) { s.calib = cal; s.message = 'ok ' + new Date().toISOString() }
  saveAutoCalib()
}
// 从锚点对解相似变换 grid = s*R*lm + t（R=[cos,-sin;sin,cos]），返回 {s,cos,sin,tx,ty}。
function solveCalibSimilarity(pairs) {
  if (pairs.length < 2) return null
  const A = pairs[0]
  let B = pairs[1], best = -1
  for (const p of pairs) {
    const d = Math.hypot(p.lmx - A.lmx, p.lmy - A.lmy)
    if (d > best) { best = d; B = p }
  }
  if (best < ADMIN_CALIB_RANGE_M) return null // 两锚点太近(<8m)不足以定 scale
  const vgx = B.rx - A.rx, vgy = B.ry - A.ry
  const vmx = B.lmx - A.lmx, vmy = B.lmy - A.lmy
  const s = Math.hypot(vgx, vgy) / Math.hypot(vmx, vmy)
  if (!Number.isFinite(s) || s <= 0) return null
  const th = Math.atan2(vgy, vgx) - Math.atan2(vmy, vmx)
  const cos = Math.cos(th), sin = Math.sin(th)
  const tx = A.rx - s * (cos * A.lmx - sin * A.lmy)
  const ty = A.ry - s * (sin * A.lmx + cos * A.lmy)
  return { s: Math.round(s * 1000) / 1000, cos: Math.round(cos * 1e5) / 1e5, sin: Math.round(sin * 1e5) / 1e5, tx: Math.round(tx), ty: Math.round(ty) }
}
// 管理页显示：用自动标定把 robotpose → 地图米制；未锁定前回退全局 POS_CAL（保持现状，不突变）。
function robotposeToMetersForAdmin(rx, ry) {
  const cal = loadAutoCalib().calib
  if (cal) {
    const px = rx - cal.tx, py = ry - cal.ty
    return { x: (cal.cos * px + cal.sin * py) / cal.s, y: (-cal.sin * px + cal.cos * py) / cal.s }
  }
  return robotposeToMeters(rx, ry)
}
// 暴露给接口/日志查看自动标定状态（观测用）
function adminCalibStatus() {
  const s = loadAutoCalib()
  return { enabled: s.enabled, pairs: s.pairs.length, locked: !!s.calib, message: s.message }
}

// —— 历史参考：2026-09-16 手工标定的管理页变换（实验性、已不再用作显示）——
const ADMIN_POS_CAL = { s: 90.056, cos: -0.11298, sin: -0.99360, tx: 620.762, ty: 4363.085 }
function robotposeToMetersAdmin(rx, ry) {
  const px = rx - ADMIN_POS_CAL.tx
  const py = ry - ADMIN_POS_CAL.ty
  return {
    x: (ADMIN_POS_CAL.cos * px + ADMIN_POS_CAL.sin * py) / ADMIN_POS_CAL.s,
    y: (-ADMIN_POS_CAL.sin * px + ADMIN_POS_CAL.cos * py) / ADMIN_POS_CAL.s
  }
}

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
    // 平台 EvizServer 返回的 data 是「字符串包着 JSON」（内层序列化），直接当对象取 robotpose 永远为空。
    // 2026-09-16 真机实测确认：必须先 JSON.parse 再取字段，否则 getDevicePosition 恒返回 null，
    // 开舱门禁会一直报「无法获取无人车位置」。
    let inner = d
    if (typeof d === 'string') {
      try { inner = JSON.parse(d) } catch (e) { inner = null }
    }
    if (inner && Array.isArray(inner.robotpose) && inner.robotpose.length >= 2) {
      // eviz robotpose 与点位坐标不是同一坐标系（点位为平台局部米，robotpose 为其激光 SLAM 网格坐标）。
      // 2026-09-16 真机实测两组对应点求解相似变换并自洽验证：
      //   商铺上货 (18.262, 6.537) ↔ robotpose (733, 2583)
      //   充电点1  (19.931, 8.125) ↔ robotpose (1145, 2497)
      // 解：scale=182.67, rot=-55.37°, t=(-2144.6, 4649.8)。
      // ⚠️ 平台若重新标定地图（点位 pose 变化），需按上述方式重新标定这两个常量。
      const m = robotposeToMeters(Number(inner.robotpose[0]), Number(inner.robotpose[1]))
      const pos = {
        x: m.x,
        y: m.y,
        theta: inner.robotpose[2],
        timestamp: inner.timestamp,
        locQuality: inner.locQuality,
        text: STATUS_TEXT[t.task_status] || ''
      }
      posCache.set(taskId, { ts: Date.now(), pos })
      return pos
    }
  } catch (e) { /* 位置获取失败，回退缓存 */ }
  return hit ? hit.pos : null
}

// 按设备编号直接取实时位置（不依赖 delivery_tasks —— 召唤多单配送无配送任务，
// 地图/到达门禁需要用 deviceSn 而非 taskId 取位）。mock 档无真实坐标，返回 null。
const posCacheBySn = new Map() // deviceSn -> { ts, pos }
async function getDevicePositionBySn(store, deviceSn, hintText) {
  if (!deviceSn) return null
  if (MOCK) return null
  const hit = posCacheBySn.get(deviceSn)
  if (hit && Date.now() - hit.ts < 3000) return hit.pos
  try {
    const r = await requestPlatform('GET', '/open-api/v1/iotGatewayProxy/' + encodeURIComponent(deviceSn) + '/buildingManager/om-api/EvizServer')
    const d = r && r.data
    let inner = d
    if (typeof d === 'string') {
      try { inner = JSON.parse(d) } catch (e) { inner = null }
    }
    if (inner && Array.isArray(inner.robotpose) && inner.robotpose.length >= 2) {
      const m = robotposeToMeters(Number(inner.robotpose[0]), Number(inner.robotpose[1]))
      const ma = robotposeToMetersForAdmin(Number(inner.robotpose[0]), Number(inner.robotpose[1]))
      const pos = {
        x: m.x,       // 全局坐标系（配送到达仍用它，不动）
        y: m.y,
        ax: ma.x,     // 管理页坐标系（自动标定；未锁定前回退全局 → 等同 x/y）
        ay: ma.y,
        raw: Array.isArray(inner.robotpose) ? inner.robotpose.slice(0, 2).map(Number) : null,
        theta: inner.robotpose[2],
        timestamp: inner.timestamp,
        locQuality: inner.locQuality,
        text: hintText || ''
      }
      posCacheBySn.set(deviceSn, { ts: Date.now(), pos })
      return pos
    }
  } catch (e) { /* 位置获取失败，回退缓存 */ }
  return hit ? hit.pos : null
}

// ---------------- 机器人实时雷达数据（eviz 激光点云 + 代价地图） ----------------
// 同一 EvizServer 代理接口除 robotpose 外还返回 laserscan（激光点云）与 costmap（代价地图 base64）。
// 数据 3s 缓存（与 getDevicePosition 同节奏）；机器人离线/网关无响应时返回 { ok:false, msg }。
const radarCache = new Map() // device_sn -> { ts, data }
async function getRobotRadar(store, deviceSn) {
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  if (MOCK) return { ok: false, msg: '本地演示模式，无雷达数据' }
  if (!platformReady()) return { ok: false, msg: '未配置开放物流平台凭据' }
  const hit = radarCache.get(deviceSn)
  if (hit && Date.now() - hit.ts < 3000) return hit.data
  try {
    const r = await requestPlatform('GET', '/open-api/v1/iotGatewayProxy/' + encodeURIComponent(deviceSn) + '/buildingManager/om-api/EvizServer')
    let inner = r && r.data
    if (typeof inner === 'string') { try { inner = JSON.parse(inner) } catch (e) { inner = null } }
    if (!inner || (r && r.code && r.code !== 'COMM_200')) {
      const out = { ok: false, msg: (r && r.msg) || '无雷达数据（机器人离线？）' }
      radarCache.set(deviceSn, { ts: Date.now(), data: out })
      return out
    }
    const out = {
      ok: true,
      timestamp: inner.timestamp || null,
      locQuality: inner.locQuality || null,
      robotPose: Array.isArray(inner.robotpose) ? inner.robotpose.map(Number) : null,
      // laserscan 可能为「极坐标 ranges 数组」或「直角坐标点数组」，原样透传由前端自适应解析
      laserscan: inner.laserscan !== undefined && inner.laserscan !== null ? inner.laserscan : null,
      costmap: inner.costmap !== undefined && inner.costmap !== null ? inner.costmap : null
    }
    radarCache.set(deviceSn, { ts: Date.now(), data: out })
    return out
  } catch (e) {
    const out = { ok: false, msg: '雷达数据获取失败：' + e.message }
    radarCache.set(deviceSn, { ts: Date.now(), data: out })
    return out
  }
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
        version: d.softwareVersion || '',
        busy_stocks: d.busyStocks || '',
        curr_map_id: d.currMapId || '',
        status_update_time: d.statusUpdateTime || ''
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

// 上货验证（验证通过自动开舱，任务流转 40 上货中）。
// ⚠️ 2026-09-17 实测两步缺一不可：
//   1) 先调 /deviceCtrl/verify/match —— 进入验证阶段 + 校验（只调 loading/verify 会报 DLV_CTRL_0011「机器人当前不在取货阶段」）
//   2) 再调 /deviceCtrl/loading/verify —— 真正开舱动作（只调 verify/match 会「显示成功但舱门不开」，autoOpen 在 loading/verify 上生效）
async function loadingVerify(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const m = await requestPlatform('POST', '/open-api/v1/deviceCtrl/verify/match', {
      deviceSn, strategies: strategies || {}, autoOpen: false
    })
    if (!m || m.code !== 'COMM_200') {
      return { ok: false, msg: (m && m.msg) || '上货验证失败，请稍后重试' }
    }
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/loading/verify', {
      deviceSn, id: Number(platformTaskId), strategies: strategies || {}, autoOpen: true
    })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '上货验证失败，请稍后重试' }
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
// 判据（2026-09-17 改）：以**平台权威的「到达上货点」信号**为准——该设备最近配送任务状态 ∈ {30,40}
// （30=到达上货点 / 40=上货中），这是平台自己判定的到达，不做带标定误差的距离判断。
// 辅以机器状态预检（充电/返程/回待机 → 明确提示等车到位）。
// MOCK 档恒 ok（demo 冒烟不受影响）；拿不到任务状态 → 保守拒绝，宁可挡住不可假装。
const LOADING_RADIUS_M = Number(process.env.LOADING_POINT_RADIUS_M || 1.5)
// 召唤模式点位到达门禁半径（米）与定位标定系数：robotAtPoint 用 getDevicePosition 测距判定到点。
// 真机标定 ARRIVE_RADIUS_M（距目标点 ≤ 该值判为已到）与 POS_M_PER_UNIT（SLAM 网格坐标→局部米）。
const ARRIVE_RADIUS_M = Number(process.env.ARRIVE_RADIUS_M || 2.0)
const POS_M_PER_UNIT = Number(process.env.POS_M_PER_UNIT || 1.0)

async function robotAtLoadingPoint(store, deviceSn) {
  if (MOCK) return { ok: true, at_loading_point: true, distance_m: 0 }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号', at_loading_point: false, distance_m: null }
  // 机器状态预检：充电/返程/回待机 = 不在上货点，直接拒绝（避免充电桩旁误判就位）
  const dev = await getDeviceList()
  if (dev.ok && dev.robots && dev.robots.length) {
    const me = dev.robots.find((x) => x.device_sn === deviceSn)
    if (me && ['charging', 'returnChargingPile', 'returnStandby'].includes(me.machine_status)) {
      return { ok: false, msg: '无人车还在' + (me.machine_text || me.machine_status) + '，请等待其到达上货点后再开舱', at_loading_point: false, distance_m: null }
    }
  }
  // 平台权威「到达上货点」：该设备**存在任一**配送任务状态 30/40 即视为已就位。
  // 2026-09-18 修复：此前按 `ORDER BY id DESC LIMIT 1` 取「最新」一条任务判定，同一批次多单同机下，
  // 若其中某单任务创建失败（platform_task_id 为空、status 停在 0），会误把「正在前往上货点」当最新
  // 状态返回，导致车明明到了上货点（task_status=30）却无法开舱。正确判据 = 任一任务已到上货点。
  const ready = store.prepare(
    "SELECT task_status, status_text FROM delivery_tasks WHERE device_sn=? AND void_at IS NULL AND task_status IN (30,40) AND platform_task_id != '' LIMIT 1"
  ).get(deviceSn)
  if (ready) {
    return { ok: true, at_loading_point: true, distance_m: 0, by_task_status: true }
  }
  // 无已就位任务：取最新一条有效任务做等待提示（排除平台未下发的空任务，避免误导）
  const t = store.prepare(
    "SELECT task_status, status_text FROM delivery_tasks WHERE device_sn=? AND void_at IS NULL AND platform_task_id != '' ORDER BY id DESC LIMIT 1"
  ).get(deviceSn)
  if (!t) return { ok: false, msg: '未找到该设备的配送任务，请先「上货定型」', at_loading_point: false, distance_m: null }
  return {
    ok: false,
    msg: '无人车正在前往上货点，请等待其到达后再开舱',
    at_loading_point: false,
    distance_m: null
  }
}

// 召唤模式点位到达门禁：判定指定机器人是否已到达某 landmarks 点位（robotAtPoint）。
// 与 robotAtLoadingPoint 的区别：召唤多单配送下**没有配送任务**可依赖，故不用任务状态，
// 改用机器状态预检 + getDevicePosition 测距到目标 landmark 坐标（≤ ARRIVE_RADIUS_M 判为已到）。
// 软信号辅助：machine_status==='lightTask'（车正被召唤停在该点待命）。
// MOCK 档恒 ok；定位数据拿不到则保守拒绝（宁可挡，不假装）。
async function robotAtPoint(store, deviceSn, landmarkId, landmark) {
  if (MOCK) return { ok: true, at_point: true, distance_m: 0 }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号', at_point: false, distance_m: null }
  // 机器状态预检：充电/返程/回待机 = 不在目标点，直接拒绝
  const dev = await getDeviceList()
  if (dev.ok && dev.robots && dev.robots.length) {
    const me = dev.robots.find((x) => x.device_sn === deviceSn)
    if (me && ['charging', 'returnChargingPile', 'returnStandby'].includes(me.machine_status)) {
      return { ok: false, msg: '无人车还在' + (me.machine_text || me.machine_status) + '，请等待其到达后再开舱', at_point: false, distance_m: null }
    }
  }
  // 解析目标点坐标：优先入参 landmark，其次按 id 查本地 landmarks
  let lm = landmark
  if (!lm && landmarkId) lm = store.prepare('SELECT * FROM landmarks WHERE platform_landmark_id=? OR id=?').get(String(landmarkId), String(landmarkId))
  const tx = lm ? Number(lm.pos_x || 0) : 0
  const ty = lm ? Number(lm.pos_y || 0) : 0
  if (!tx && !ty) return { ok: false, msg: '目标点位无坐标，无法判定到达', at_point: false, distance_m: null }
  try {
    const pos = await getDevicePosition(store, deviceSn)
    const px = pos ? Number(pos.position_x != null ? pos.position_x : pos.x) : null
    const py = pos ? Number(pos.position_y != null ? pos.position_y : pos.y) : null
    if (px === null || py === null || isNaN(px) || isNaN(py)) {
      return { ok: false, msg: '无法获取机器人当前位置', at_point: false, distance_m: null }
    }
    const dx = (px - tx) * POS_M_PER_UNIT
    const dy = (py - ty) * POS_M_PER_UNIT
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist <= ARRIVE_RADIUS_M) {
      // 自动标定观测（只读，只追加采样，绝不影响到达判定结果）：
      // 车此刻已确定到位 → 记 (robotpose 原始网格, landmark 米)。
      try {
        const pr = await getDevicePositionBySn(store, deviceSn, '')
        if (pr && Array.isArray(pr.raw) && pr.raw.length >= 2) {
          recordCalibPosePair(deviceSn, Number(pr.raw[0]), Number(pr.raw[1]), tx, ty)
        }
      } catch (_e) { /* 采样失败不阻断 */ }
      return { ok: true, at_point: true, distance_m: dist }
    }
    return { ok: false, msg: '机器人尚未到达上货点，请稍后再试', at_point: false, distance_m: dist }
  } catch (e) {
    return { ok: false, msg: '到达判断失败，请稍后重试', at_point: false, distance_m: null }
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
  if (active && Number(active.c) > 0) return { ok: false, busy: true, msg: '无人车正在配送，请稍后再试' }
  // 召唤多单配送：车正被逐点推进投递（delivery_mode='summon' 且配送中(2) 且已下发召唤任务）→ 也算忙。
  // 否则车停在取餐点等待时是 lightTask 态，会被下方 machine_status 判定为「空闲」，商家可强行「上货」
  // 打断正在投递的车召回上货点（问题4）。正在投递/待命于上货点(status=1/2)的分界线就是这个 active summon 批次。
  const summonBatch = store.prepare(`
    SELECT id FROM delivery_batches
    WHERE device_sn=? AND delivery_mode='summon' AND status=2 AND light_task_id IS NOT NULL AND light_task_id!=''
    LIMIT 1`).get(deviceSn)
  if (summonBatch) return { ok: false, busy: true, msg: '无人车正在配送，请稍后再上货' }
  const r = await getDeviceList()
  if (r.ok && r.robots && r.robots.length) {
    const me = r.robots.find((x) => x.device_sn === deviceSn)
    if (me) {
      if (!me.online) return { ok: false, busy: true, msg: '无人车已离线，请先开机上线' }
      // lightTask=召唤待命（车正被叫到上货点等待，正是要派它的时候），不算忙碌；
      // 2026-09-16 真机实测：召唤成功后车停在 lightTask 态，若仍按忙处理，「上货」会一直报「无人车正在召唤」
      const busyStatus = ['Delivery', 'delivery', 'patrol', 'Patrol', 'exception', 'remoteDevOps', 'update', 'interaction']
      if (busyStatus.includes(me.machine_status)) {
        return { ok: false, busy: true, msg: '无人车正在' + (me.machine_text || '忙碌') + '，请稍后再试' }
      }
      return { ok: true, busy: false, msg: '' }
    }
  }
  return { ok: false, busy: true, msg: '无法确认无人车状态，请稍后重试' }
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

// 释放设备控制权：ctrl-id 放在 header，body 为 {deviceSn, principalId}
// （Apifox 规格核对：header 参数 ctrl-id；requestBody = AuthorityGainReqVo）
async function releaseControl(deviceSn, ctrlId) {
  if (MOCK) return { ok: true }
  if (!ctrlId) return { ok: false, msg: '缺少控制权ID' }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/authority/release', { deviceSn, principalId: PRINCIPAL_ID }, { 'ctrl-id': ctrlId })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '释放控制权失败' }
  } catch (e) {
    return { ok: false, msg: '释放控制权异常：' + e.message }
  }
}

// ---------------- 用户取餐（下货验证开舱 / 确认关舱） ----------------
// 开舱取餐：必须先调 /deviceCtrl/verify/match（进入验证阶段 + 校验 + autoOpen 自动开舱）。
// 2026-09-17 真机实测：直接调 unloading/verify 报「机器人当前不在取货阶段」（DLV_CTRL_0011），
// 因为缺了 verify/match 这一步（Apifox 规格：机器人到达送货点发起验证前必须先调 verify/match）。
async function unloadingVerify(deviceSn, platformTaskId, strategies) {
  if (MOCK) return { ok: true }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/verify/match', {
      deviceSn, strategies: strategies || {}, autoOpen: true
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

// ---------------- 召唤任务查询与设备任务/驻停（真实调用，MOCK 档本地假装） ----------------
// 召唤任务的到达状态枚举（对应 open-api 轻任务状态）：
//   0 unconfirmed(排队未下发) / 10 accepted(已接受) / 20 goingtoPoint(前往中)
//   30 arrivedPoint(到达目标点) / 40 finished(完成) / 50 failed(失败) / 60 closed(被删除)
// 到达判断以「机器人真实到达信号(30)」为准，不再用 getDevicePosition 测距估判。
// 用途：商家的 open-bin 门禁 —— 批次召唤到上货点后，按召唤任务 id 查询是否已到，到才能开舱。
async function queryLightTask(id) {
  if (MOCK) return { ok: true, status: 30, arrived: true, msg: '模拟已到达' }
  if (!platformReady() || !id) return { ok: false, status: -1, arrived: false, msg: '未配置平台凭据或缺少召唤任务id' }
  try {
    const r = await requestPlatform('GET', '/open-api/v1/lightTask/' + encodeURIComponent(id) + '?principalId=' + encodeURIComponent(PRINCIPAL_ID))
    if (r && (r.code === 'COMM_200' || r.success === true) && r.data) {
      const status = Number(r.data.status)
      return { ok: true, status, arrived: status === 30, msg: '' }
    }
    return { ok: false, status: -1, arrived: false, msg: (r && r.msg) || '查询召唤任务失败' }
  } catch (e) {
    return { ok: false, status: -1, arrived: false, msg: '查询召唤任务异常：' + e.message }
  }
}

// 设备驻停（stopTime 秒后自动恢复）
async function stopRobot(deviceSn, stopTime) {
  if (MOCK) return { ok: true, msg: '模拟驻停成功' }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  try {
    const r = await requestPlatform('POST', '/open-api/v1/deviceCtrl/stop', { deviceSn, stopTime: Number(stopTime) || 30 })
    return r && r.code === 'COMM_200' ? { ok: true } : { ok: false, msg: (r && r.msg) || '驻停失败' }
  } catch (e) {
    return { ok: false, msg: '驻停异常：' + e.message }
  }
}

// 查询设备当前货舱状态与对应任务（deviceCtrl/queryDeviceTasks，GET ?deviceSN=）。
// 用途：管理员「取消机器人全部任务」——平台侧货舱占用是任务占用的权威来源，
// 比「拉全量任务再按设备过滤」更准确（basicPageList 有分页上限）。
// 规格未给响应示例，故对 data 结构做容错提取；失败时调用方回退 deviceActiveTasks。
async function queryDeviceTasks(deviceSn) {
  if (MOCK) return { ok: true, tasks: [], mock: true }
  if (!deviceSn) return { ok: false, msg: '缺少设备编号' }
  try {
    const r = await requestPlatform('GET', '/open-api/v1/deviceCtrl/queryDeviceTasks?deviceSN=' + encodeURIComponent(deviceSn))
    if (!r || r.code !== 'COMM_200') return { ok: false, msg: (r && r.msg) || '查询设备任务失败' }
    const d = r.data
    let arr = []
    if (Array.isArray(d)) arr = d
    else if (d && Array.isArray(d.data)) arr = d.data
    else if (d && Array.isArray(d.tasks)) arr = d.tasks
    else if (d && Array.isArray(d.list)) arr = d.list
    else if (d && typeof d === 'object') arr = [d]
    const tasks = arr.map((x) => ({
      taskId: (x && (x.taskId !== undefined ? x.taskId : (x.id !== undefined ? x.id : ''))) + '',
      stockPos: (x && (x.stockPos || x.position)) || '',
      status: Number((x && (x.taskStatus !== undefined ? x.taskStatus : x.status)) || 0)
    })).filter((t) => t.taskId !== '' && t.taskId !== 'undefined')
    return { ok: true, tasks, raw: d }
  } catch (e) {
    return { ok: false, msg: '查询设备任务异常：' + e.message }
  }
}

module.exports = {
  MOCK, APPID, SECRET, PRINCIPAL_ID, BASE, STATUS_TEXT, MACHINE_TEXT,
  callbackUrl, requestPlatform, platformReady, httpGetBuffer, formatLocalDt, mockPosition,
  setDispatchHook, notifyDispatch,
  syncLandmarks, getPlatformLandmarks, getMapRaw, computeMapBbox, getMapBbox,
  getMapOverview, fetchMapRawFresh, getMapImageBytes,
  robotposeToMeters, robotposeToMetersForAdmin, recordCalibPosePair, adminCalibStatus,
  getDevicePosition, getDevicePositionBySn, getRobotRadar, getDeviceList, getTaskStatus,
  grantControl, releaseControl, loadingVerify, drawerCtrl, loadingConfirm,
  unloadingVerify, unloadingConfirm, cancelQueueTask, closeTask,
  queryLightTask, stopRobot, queryDeviceTasks,
  robotAtLoadingPoint, robotAtPoint, isRobotBusy
}
