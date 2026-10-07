'use strict'
// 站点路线：与 backend/services/batch.js 的 planRoute 保持同一套语义
//   · 有坐标：从取货点出发的最近邻，单数加权（有效距离 = 距离² / 单数^α）
//   · 无坐标：单数多的先送，同单数按 landmarks.sort —— 即真实库现状会走的分支
// 同一楼栋多单合并为一站。

function computeRoute(cfg, batch, L) {
  const groups = new Map()
  for (const o of batch.orders) {
    if (!groups.has(o.lm)) groups.set(o.lm, [])
    groups.get(o.lm).push(o)
  }
  let stops = [...groups.entries()].map(([lmId, orders]) => ({ lmId, lm: L.get(lmId) || null, orders }))
  const withCoord = cfg.useCoords && stops.length > 0 && stops.every((s) => s.lm && (s.lm.x !== 0 || s.lm.y !== 0))

  if (withCoord) {
    const load = cfg.landmarks.find((l) => l.type === 'loadingPoint') || { x: 0, y: 0 }
    const remain = stops.slice()
    const out = []
    let cx = load.x
    let cy = load.y
    while (remain.length) {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < remain.length; i++) {
        const s = remain[i]
        const dx = cx - s.lm.x
        const dy = cy - s.lm.y
        const n = s.orders.length || 1
        const d2 = (dx * dx + dy * dy) / Math.pow(n, cfg.alpha)
        if (d2 < bestD) { bestD = d2; best = i }
      }
      const s = remain.splice(best, 1)[0]
      out.push(s)
      cx = s.lm.x
      cy = s.lm.y
    }
    stops = out
    for (let i = 0; i < stops.length; i++) {
      const from = i === 0 ? load : stops[i - 1].lm
      const d = Math.hypot(stops[i].lm.x - from.x, stops[i].lm.y - from.y)
      stops[i].distM = Math.round(d)
      stops[i].travelMin = d / cfg.speedMpm
    }
  } else {
    stops.sort((a, b) => (b.orders.length - a.orders.length) || ((a.lm ? a.lm.sort : 99) - (b.lm ? b.lm.sort : 99)))
    for (const s of stops) { s.distM = null; s.travelMin = cfg.perStopTravelSec / 60 }
  }
  stops.forEach((s, i) => { s.stop = i + 1 })
  return { stops }
}

// 行程耗时粗估（deadline 策略倒推最晚发车时刻、maxTripMin 放置判据都用它）。
// 必须把「等用户取餐」和「逐单开箱」算进去 —— 它们是单趟耗时的大头（实测占 21~31%），
// 漏算会让 deadline 把最晚发车时刻算得过晚、maxTripMin 的分钟数也对不上真实耗时。
// 行驶时间直接复用 computeRoute：有坐标时按真实米数÷车速，无坐标时才退回「每站固定耗时」。
// （早期版本有坐标时按「每站 220 米」硬估，真实地图上东西跨度 247 米、西线楼栋间距仅 18.8 米，
//   这种均匀假设会把"3 个西线楼栋"和"1 个东苑7栋"当成一样贵 —— 正是要避免的错误。）
function estimateTripMin(cfg, orders, L) {
  const { stops } = computeRoute(cfg, { orders }, L)
  const travel = stops.reduce((s, x) => s + (x.travelMin || 0), 0)
  // 每站等待用「先验」估（系统发车时并不知道用户几点下来）：取预测等待与等待上限的较小值
  const waitPerStop = cfg.userRespMedianSec > 0
    ? Math.min(cfg.etaPriorWaitSec, cfg.maxWaitAtStopSec) / 60
    : 0
  const items = orders.reduce((s, o) => s + Number(o.items || 0), 0)
  return cfg.loadingSec / 60
    + travel
    + stops.length * (cfg.stopServiceSec / 60 + waitPerStop)
    + items * (cfg.openPerOrderSec / 60)
}

module.exports = { computeRoute, estimateTripMin }
