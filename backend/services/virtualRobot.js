/* ============================================================
 * virtualRobot.js —— 虚拟机器人（联调/演示用）：在**平台接口层**模拟多台真实在线机器人
 * ------------------------------------------------------------
 * 为什么放在这一层：
 *   真实机器人数据来自 platform-http.js 的
 *     · getDeviceList()                 —— 设备清单（在线/电量/机器状态）
 *     · getDevicePositionBySn(store,sn) —— eviz robotpose（= 地图像素坐标）
 *   把模拟数据**注入这两个函数**，则大屏 / 管理页 / 商家监控页 / 实时推送泵
 *   走的都是同一条真实链路，**前端一行都不用改**，也不存在"前端另写一套动画"。
 *
 * 多车 + 状态机：
 *   · 默认 N 台（VIRTUAL_ROBOT_COUNT=2）：虚拟测试车1=LD-SIM-01 / 虚拟测试车2=LD-SIM-02
 *   · 每台独立随时间在状态机里自动循环：
 *       充电 → 等待(待机) → 配送 → 上货 → 待取货 → 返回(回桩) → 充电(闭环)
 *   · 时间驱动、无定时器、无状态累积 → 不漂移、重启即一致
 *   · 多车共用同一固定路径图，用 phaseOffset 错峰起步（各自线路后续可扩展）
 *   · 手动模式：setState(sn, state, auto=false) 把某台钉在指定状态；
 *              setState(sn, null, true) 恢复自动循环。
 *   · 运行时总开关：setEnabled(bool)，无需重启即可开/关整批虚拟车。
 *
 * 位置模型：仍由**时钟**推导。静止态（充电/等待/上货/待取货）停在代表点位；
 * 移动态（配送/返回）沿路线匀速前进/折返。theta 取当前行进方向。
 *
 * 配置（.env）：VIRTUAL_ROBOT=1、VIRTUAL_ROBOT_COUNT、VIRTUAL_ROBOT_SPEED、
 *   VIRTUAL_ROBOT_SN_BASE（LD-SIM-）、VIRTUAL_ROBOT_NAME_BASE（虚拟测试车）、VIRTUAL_ROBOT_STATUS
 *
 * 安全：本模块只产出**只读数据**；派车逻辑按 device.virtual 跳过它，
 *       绝不会向真实平台下发针对假设备的指令。
 * ============================================================ */
'use strict'

const COUNT = Math.max(1, parseInt(process.env.VIRTUAL_ROBOT_COUNT, 10) || 4)
const SN_BASE = String(process.env.VIRTUAL_ROBOT_SN_BASE || 'LD-SIM-')
const NAME_BASE = String(process.env.VIRTUAL_ROBOT_NAME_BASE || '虚拟测试车')
const SPEED_MPS = Number(process.env.VIRTUAL_ROBOT_SPEED || 1.2)
const MACHINE_STATUS = String(process.env.VIRTUAL_ROBOT_STATUS || 'Delivering')

// 名称保持历史兼容：第 1 台 SN 沿用旧默认 LD-SIM-01；旧 NAME 默认『模拟车 01』改为『虚拟测试车1』
const ROBOTS = Array.from({ length: COUNT }, (_, i) => ({
  sn: SN_BASE + String(i + 1).padStart(2, '0'),
  name: NAME_BASE + (i + 1),
  k: i,                       // 台序号：决定错峰（按周期等分，多台在地图上明显分散）
  auto: true,                 // true=自动循环；false=钉在 handStatus
  handStatus: ''              // 手动钉定的状态（仅 auto=false 时生效）
}))

// 六态文本（device/position 的 machine_text）
const STATUS_TEXT = {
  charging: '正在充电', standby: '待机中', delivering: '配送中',
  loading: '上货中', waitPickup: '待取货', returning: '返回充电桩'
}
// 与平台标准码尽量对齐（派车/后端其它逻辑可识别的码）
const STATUS_CODE = {
  charging: 'charging', standby: 'standby', delivering: 'delivery',
  loading: 'lightTask', waitPickup: 'Delivery', returning: 'returnChargingPile'
}

// ---------------- 运行时总开关 ----------------
// 默认取 .env（VIRTUAL_ROBOT=1）；setEnabled 在运行时改内存态，无需重启。
let runtimeEnabled = null
function envWantsOn() {
  const v = String(process.env.VIRTUAL_ROBOT || '').toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}
function enabled() { return runtimeEnabled === null ? envWantsOn() : runtimeEnabled }
function setEnabled(on) { runtimeEnabled = !!on; return { enabled: enabled() } }

// ---------------- 路线（地图像素折线） ----------------
let route = { pts: [], cum: [], total: 0, resolution: 0.05, setAt: 0 }
let WORLD = { ox: 0, oy: 0, h: 0 }      // 反向换算回世界米所需的 ROS 元数据

function setWorld(meta) {
  if (!meta) return
  WORLD = {
    ox: Number(meta.origin && meta.origin[0]) || 0,
    oy: Number(meta.origin && meta.origin[1]) || 0,
    h: Number(meta.height) || 0
  }
}

// 由 platform-http 在拿到平台固定路径图后调用；pts = [[px,py],...]
function setRoute(pts, resolution) {
  const clean = (pts || []).filter((p) => p && isFinite(p[0]) && isFinite(p[1]))
  if (clean.length < 2) return false
  const cum = [0]
  for (let i = 1; i < clean.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]))
  }
  const total = cum[cum.length - 1]
  if (!(total > 1)) return false
  route = { pts: clean, cum, total, resolution: Number(resolution) > 0 ? Number(resolution) : 0.05, setAt: Date.now() }
  return true
}
function routeInfo() {
  return { points: route.pts.length, length_m: +(route.total * route.resolution).toFixed(1), ready: route.pts.length > 1 }
}

const speedPx = () => SPEED_MPS / (route.resolution > 0 ? route.resolution : 0.05)   // 米/秒 → 像素/秒

// 沿路线按行驶距离插值一个点（theta 取行进方向）
function pointAtDist(d) {
  d = Math.max(0, Math.min(route.total, d))
  let i = 1
  while (i < route.cum.length - 1 && route.cum[i] < d) i++
  const a = route.pts[i - 1], b = route.pts[i]
  const seg = (route.cum[i] - route.cum[i - 1]) || 1
  const t = Math.max(0, Math.min(1, (d - route.cum[i - 1]) / seg))
  return {
    px: a[0] + (b[0] - a[0]) * t, py: a[1] + (b[1] - a[1]) * t,
    theta: Math.atan2(b[1] - a[1], b[0] - a[0])
  }
}

// 静止代表点位
function staticPoints() {
  const start = route.pts[0]
  const end = pointAtDist(route.total)
  const loading = pointAtDist(route.total * 0.35)
  return {
    chargingPx: { px: start[0], py: start[1], theta: loading.theta },
    standbyPx: { px: start[0], py: start[1], theta: loading.theta },
    loadingPx: loading,
    waitPickupPx: end
  }
}

/* ---------------- 六态自动循环（时间驱动） ----------------
 * 每台按台序在周期上等分错开（phaseU），用 (nowSec + 台内相位) 对「单周期」取模定位到当前阶段。
 * 静止阶段预算（秒）为常量；移动阶段（配送/返回）预算 = 单程行驶时间，速度恒定。
 * 单周期：充电[0,6) 等待[6,12) 配送[12,12+rt) 上货[..+5) 待取货[..+25) 返回[..+rt) */
const T_CHARGING = 6, T_STANDBY = 6, T_LOADING = 5, T_WAITPICKUP = 25

function cycleSpan() {
  const rt = route.pts.length < 2 ? 1 : Math.max(1, route.total / speedPx())
  const CYCLE = T_CHARGING + T_STANDBY + rt + T_LOADING + T_WAITPICKUP + rt
  return { rt, CYCLE }
}

function batteryAt(u, CYCLE) {
  if (u < T_CHARGING) return Math.round(40 + 60 * (u / T_CHARGING))           // 充电 40→100
  const t = (u - T_CHARGING) / (CYCLE - T_CHARGING)                            // 其余 100→40
  return Math.round(100 - 60 * t)
}

// 台内相位：按台序在周期上等分错开，多台沿同一路径明显分散（而非挤在一起）
function phaseU(robot, nowSec, CYCLE) {
  const off = (robot.k % ROBOTS.length) / ROBOTS.length * CYCLE
  return (((nowSec + off) % CYCLE) + CYCLE) % CYCLE
}

// 自动模式下：返回 { phase, px, py, theta, prog }
function autoAt(robot, nowSec) {
  const { rt, CYCLE } = cycleSpan()
  const u = phaseU(robot, nowSec, CYCLE)
  const b2 = T_CHARGING, b3 = T_CHARGING + T_STANDBY, b4 = b3 + rt,
    b5 = b4 + T_LOADING, b6 = b5 + T_WAITPICKUP, b7 = b6 + rt
  const S = staticPoints()
  if (u < b2) return { phase: 'charging', ...S.chargingPx, prog: 0 }
  if (u < b3) return { phase: 'standby', ...S.standbyPx, prog: 0 }
  if (u < b4) { const p = (u - b3) / rt; const pt = pointAtDist(route.total * p); return { phase: 'delivering', ...pt, prog: p } }
  if (u < b5) return { phase: 'loading', ...S.loadingPx, prog: 0.35 }
  if (u < b6) return { phase: 'waitPickup', ...S.waitPickupPx, prog: 1 }
  const r = (u - b6) / rt; const pt = pointAtDist(route.total * (1 - r))
  return { phase: 'returning', ...pt, prog: 1 - r }
}

// 手动模式（auto=false）：钉在指定状态，静止在代表点位
function manualAt(robot) {
  const s = robot.handStatus
  const S = staticPoints()
  if (!s || !STATUS_TEXT[s]) return { phase: 'standby', ...S.standbyPx, prog: 0 }
  const p = s === 'loading' ? S.loadingPx : s === 'waitPickup' ? S.waitPickupPx : S.standbyPx
  return { phase: s, ...p, prog: s === 'loading' ? 0.35 : s === 'waitPickup' ? 1 : 0 }
}

// 单台当前状态（自动或手动）
function robotStateAt(robot, nowSec) {
  if (route.pts.length < 2) {
    // 还没拿到固定路径图：停在原点并标明"无路线"
    return { phase: 'standby', px: 0, py: 0, theta: 0, prog: 0, ready: false, battery: 78 }
  }
  const { CYCLE } = cycleSpan()
  const u = phaseU(robot, nowSec, CYCLE)
  const st = (robot.auto === false && robot.handStatus) ? manualAt(robot) : autoAt(robot, nowSec)
  // 电量按周期位置单调下降，只在充电段回升
  return Object.assign(st, { ready: true, battery: batteryAt(u, CYCLE) })
}

// ---------------- 位置（eviz robotpose 同构） ----------------
function posObjectFor(robot) {
  const now = Date.now() / 1000
  const st = robotStateAt(robot, now)
  if (!st.ready) {
    return {
      raw: [0, 0], px: 0, py: 0, x: 0, y: 0, ax: 0, ay: 0, theta: 0,
      timestamp: now, locQuality: '100.0',
      text: STATUS_TEXT[st.phase] || st.phase,
      battery: st.battery, virtual: true, route_ready: false
    }
  }
  const wx = st.px * route.resolution + WORLD.ox
  const wy = (WORLD.h - st.py) * route.resolution + WORLD.oy
  return {
    raw: [st.px, st.py],           // eviz robotpose 原始值 = 平台地图像素（x 右、y 下）
    px: st.px, py: st.py,
    x: wx, y: wy, ax: wx, ay: wy,  // ax/ay 必须同为米（否则下游当 x/y 用会飞出场景）
    theta: st.theta,
    timestamp: now, locQuality: '100.0',
    text: STATUS_TEXT[st.phase] || st.phase,
    battery: st.battery, virtual: true, route_ready: true
  }
}
function positionFor(sn) {
  const r = ROBOTS.find((x) => x.sn === sn)
  return r ? posObjectFor(r) : null
}
function position(val) { // 兼容单台取法：返回首台
  return positionFor(ROBOTS[0].sn)
}

// ---------------- 设备项（与平台 getDeviceList 的元素同构） ----------------
function deviceFor(robot) {
  const now = Date.now() / 1000
  const st = robotStateAt(robot, now)
  return {
    device_sn: robot.sn,
    name: robot.name,
    type: 'VirtualRobot',
    online: true,
    online_text: '在线',
    battery: st.battery,
    machine_status: STATUS_CODE[st.phase] || st.phase,
    machine_text: STATUS_TEXT[st.phase] || st.phase,
    floor: '1',
    building: '',
    version: 'virtual-sim',
    busy_stocks: '[]',
    curr_map_id: '',
    status_update_time: new Date().toLocaleString('zh-CN', { hour12: false }),
    virtual: true                    // ← 派车逻辑据此跳过（autoLoad / pickAvailableRobot）
  }
}
function devices() { return ROBOTS.map((r) => deviceFor(r)).filter(Boolean) }
function device(val) {               // 兼容单台取法：返回首台
  const d = deviceFor(ROBOTS[0]); return d || null
}

function isVirtual(sn) {
  return !!sn && ROBOTS.some((r) => r.sn === String(sn))
}

// 手动切态 / 恢复自动
//   setState(sn, state, auto=false) -> 钉在某状态（state∈六态）；
//   setState(sn, null, true)        -> 恢复自动循环
function setState(sn, state, auto) {
  const r = ROBOTS.find((x) => x.sn === String(sn))
  if (!r) return { ok: false, msg: '未找到虚拟车：' + sn }
  const toAuto = auto === true
  let invalid = ''
  if (!toAuto) {
    const s = String(state || '')
    if (!STATUS_TEXT[s]) invalid = '未知状态：' + s + '（可选 ' + Object.keys(STATUS_TEXT).join('/') + '）'
    else r.handStatus = s
  }
  if (invalid) return { ok: false, msg: invalid }
  r.auto = toAuto
  if (toAuto) r.handStatus = ''
  return summary()
}

// ---------------- 汇总（开关态 + 各车摘要） ----------------
function summary() {
  const now = Date.now() / 1000
  return {
    enabled: enabled(),
    count: ROBOTS.length,
    speed_mps: SPEED_MPS,
    mode: ROBOTS.every((r) => r.auto) ? 'auto' : 'manual',
    route: routeInfo(),
    robots: ROBOTS.map((r) => {
      const st = robotStateAt(r, now)
      return {
        sn: r.sn, name: r.name, auto: r.auto,
        status: st.phase,
        machine_text: STATUS_TEXT[st.phase] || st.phase,
        battery: st.battery
      }
    })
  }
}

module.exports = {
  enabled, setEnabled, isVirtual,
  device, position, devices, positionFor, summary, setState,
  setRoute, setWorld, routeInfo,
  SN: ROBOTS.map((r) => r.sn), SN0: ROBOTS[0].sn,
  NAME: ROBOTS.map((r) => r.name),
  SPEED_MPS, MACHINE_STATUS, COUNT
}