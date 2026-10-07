'use strict'
const { computeRoute, estimateTripMin } = require('./route')

// ============================================================================
// 仿真引擎（离散时间步）
//
// 每个 tick 顺序：① 释放/到达 ② 策略决策 ③ 派车
// 车队是唯一稀缺资源：批次定型后要等到有车才能出发（对齐真实系统里
// pickAvailableRobot / isRobotBusy 的门禁语义）。
// ============================================================================

function simulate(cfg, arrivals, strategy) {
  const L = new Map(cfg.landmarks.map((l) => [l.id, l]))
  const tick = cfg.tickSec / 60
  const arrivalEnd = cfg.hours * 60
  const simEnd = arrivalEnd + cfg.tailMin

  const state = {
    cfg,
    L,
    now: 0,
    orders: [],
    batches: [],
    deliveredCount: 0,
    missedCount: 0,
    stats: {},
    cars: Array.from({ length: cfg.cars }, (_, i) => ({
      sn: 'CAR' + (i + 1), busyUntil: 0, busyTotal: 0, trips: 0, batchId: null
    })),
    seq: { batch: 0 }
  }

  // ---------- 引擎给策略用的 API ----------
  state.createBatch = () => {
    const b = {
      id: ++state.seq.batch, createdAt: state.now, orders: [], items: 0,
      landmarks: new Set(), status: 'open', lockedAt: null, lockReason: '',
      car: null, dispatchedAt: null, finishedAt: null, stops: null
    }
    state.batches.push(b)
    return b
  }
  // 装得下 = 件数不超 + （如果限了停靠数）楼栋数不超 + （如果限了单趟时长）预计行程不超
  state.fits = (b, o) => {
    if (b.items + o.items > cfg.capacity) return false
    if (cfg.maxStopsPerBatch > 0 && !b.landmarks.has(o.lm) && b.landmarks.size >= cfg.maxStopsPerBatch) return false
    if (cfg.maxTripMin > 0 && estimateTripMin(cfg, b.orders.concat([o]), L) > cfg.maxTripMin) return false
    return true
  }
  state.place = (o, b) => {
    if (b.status !== 'open') throw new Error('不能往非组单中批次里放单：batch#' + b.id)
    if (b.items + o.items > cfg.capacity) {
      throw new Error('容量溢出：batch#' + b.id + ' 已有 ' + b.items + ' 件，再放 ' + o.items + ' 件 > ' + cfg.capacity)
    }
    b.orders.push(o)
    b.items += o.items
    b.landmarks.add(o.lm)
    o.batchId = b.id
    return b
  }
  state.lock = (b, why) => {
    if (b.status !== 'open') return false
    if (cfg.lockNeedsCar && state.idleCars().length === 0) {
      bump(state.stats, '定型:被无车挡住')
      return false
    }
    b.status = 'locked'
    b.lockedAt = state.now
    b.lockReason = why || ''
    bump(state.stats, '定型:' + (why || '未标注'))
    return true
  }
  state.openBatches = () => state.batches.filter((b) => b.status === 'open')
  state.lockedBatches = () => state.batches.filter((b) => b.status === 'locked')
  state.pendingBatches = () => state.batches.filter((b) => b.status === 'open' || b.status === 'locked')
  state.idleCars = () => state.cars.filter((c) => c.busyUntil <= state.now + 1e-9)
  state.estimateTripMin = (orders) => estimateTripMin(cfg, orders, L)

  // ---------- 主循环 ----------
  let ai = 0
  state.now = 0
  for (; state.now <= simEnd + 1e-9; state.now += tick) {
    // ① 到达
    while (ai < arrivals.length && arrivals[ai].t <= state.now + 1e-9) {
      const a = arrivals[ai++]
      const o = {
        id: a.id, t: a.t, lm: a.lm, items: a.items, respSec: a.respSec || 0,
        batchId: null, deliveredAt: null, arriveAt: null, pickupAt: null, noWaitArriveAt: null,
        etaDispatch: null, stopIndex: null, missed: false, missedAt: null
      }
      state.orders.push(o)
      strategy.onOrderArrive(state, o)
    }
    // ② 策略决策（新建批次 / 放置 / 定型）
    strategy.tick(state)
    // ③ 给已定型批次派车
    dispatchLocked(state)
    // ④ 收单结束 + 所有批次都真的跑完（车已回位）→ 提前收工。
    //    注意必须用「车跑完的时刻」而不是「已派发」，否则车辆利用率会被高估。
    if (state.now >= arrivalEnd && ai >= arrivals.length) {
      const allDone = state.batches.every((b) => b.finishedAt != null && state.now >= b.finishedAt - 1e-9)
      if (allDone) break
    }
  }

  const finalNow = state.now
  const leftOpen = state.batches.filter((b) => b.status === 'open').length
  const leftLocked = state.batches.filter((b) => b.status === 'locked').length
  return { cfg, state, finalNow, arrivals, leftOpen, leftLocked }
}

function dispatchLocked(state) {
  const cfg = state.cfg
  const waiting = state.batches.filter((b) => b.status === 'locked').sort((a, b) => a.lockedAt - b.lockedAt)
  for (const b of waiting) {
    const car = state.cars.find((c) => c.busyUntil <= state.now + 1e-9)
    if (!car) break // 没车了，剩下的下一轮再说
    const plan = computeRoute(cfg, b, state.L)
    const useUser = cfg.userRespMedianSec > 0
    const fixedMin = cfg.stopServiceSec / 60
    const openMin = cfg.openPerOrderSec / 60
    const cap = cfg.maxWaitAtStopSec
    const priorWaitMin = cfg.etaPriorWaitSec / 60
    const startAt = state.now + cfg.loadingSec / 60

    // ① 发车时的一次性 ETA 预测：所有站都只能用「先验等待」，用户实际什么时候下来还不知道
    const predArrive = []
    let pt = startAt
    for (const stop of plan.stops) {
      pt += stop.travelMin                       // 到站
      predArrive.push(pt)
      pt += fixedMin + priorWaitMin + stop.orders.length * openMin // 本站耗时（先验）
    }

    // ② 实际执行：用户响应是随机的、有上限的；上游的拖延会传导到下游
    let t = startAt
    let tNoWait = startAt // 假想"所有人都秒到"的进度，用来量化级联延迟
    for (let i = 0; i < plan.stops.length; i++) {
      const stop = plan.stops[i]
      const n = stop.orders.length
      t += stop.travelMin
      tNoWait += stop.travelMin
      const arriveAt = t
      const noWaitArriveAt = tNoWait
      const waitSec = useUser ? Math.min(Math.max(...stop.orders.map((o) => o.respSec)), cap) : 0

      for (const o of stop.orders) {
        o.stopIndex = stop.stop
        o.arriveAt = arriveAt
        o.noWaitArriveAt = noWaitArriveAt
        o.etaDispatch = predArrive[i]
        if (!useUser || o.respSec <= cap) {
          // 送达（承诺）以"机器人到站"为准；用户自己拿到手的时间还取决于他多久下来
          o.deliveredAt = arriveAt
          o.pickupAt = useUser ? arriveAt + o.respSec / 60 : arriveAt
          state.deliveredCount += 1
        } else {
          // 等超时了，人还没来 → 没取到，要二次配送（本模拟不建模二次配送的成本）
          o.missed = true
          o.missedAt = arriveAt
          state.missedCount += 1
        }
      }
      stop.arriveAt = arriveAt
      stop.waitSec = waitSec
      t = arriveAt + fixedMin + waitSec / 60 + n * openMin
      tNoWait = noWaitArriveAt + fixedMin + n * openMin
      stop.departAt = t
    }
    b.status = 'running'
    b.car = car.sn
    b.dispatchedAt = state.now
    b.finishedAt = t
    b.stops = plan.stops
    car.batchId = b.id
    car.busyUntil = t
    car.busyTotal += t - state.now
    car.trips += 1
  }
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1
}

module.exports = { simulate }
