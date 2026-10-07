'use strict'

// ============================================================================
// 指标统计 + 文本报告（中英文混排按显示宽度对齐）
// ============================================================================

function computeMetrics(res) {
  const { cfg, state, finalNow } = res
  const orders = state.orders
  const batches = state.batches
  const promiseOf = (o) => o.t + cfg.promiseMin
  const delivered = orders.filter((o) => o.deliveredAt != null)
  const missedPre = orders.filter((o) => o.missed).length
  // 未送达 = 既没送到、也不是"送到了没人取" 的那部分（即仿真结束时还压在队列里）
  const undelivered = orders.length - delivered.length - missedPre

  const waits = delivered.map((o) => o.deliveredAt - o.t).sort((a, b) => a - b)
  const totalItems = orders.reduce((s, o) => s + o.items, 0)
  const trips = batches.length
  const stopCounts = batches.map((b) => (b.stops ? b.stops.length : new Set(b.orders.map((o) => o.lm)).size))
  const totalStops = stopCounts.reduce((a, b) => a + b, 0)
  const singleStop = stopCounts.filter((s) => s === 1).length

  const overdueDelivered = delivered.filter((o) => o.deliveredAt > promiseOf(o) + 1e-9).length
  const overdueUndelivered = orders.filter((o) => o.deliveredAt == null && finalNow > promiseOf(o) + 1e-9).length
  const overdue = overdueDelivered + overdueUndelivered

  // 承诺是「下单 + promiseMin」的固定值，所以：
  //   实际−承诺 为负 = 送达比承诺早（承诺偏保守）；标准差 = 到达时间的稳定程度
  const devs = delivered.map((o) => o.deliveredAt - promiseOf(o))
  const waitStd = std(waits, mean(waits))

  const busy = state.cars.reduce((s, c) => s + c.busyTotal, 0)
  const utilization = cfg.cars * finalNow > 0 ? busy / (cfg.cars * finalNow) : 0

  // ---- 用户取餐 / 级联 / ETA 精度（新增）----
  const missed = orders.filter((o) => o.missed).length
  const served = orders.filter((o) => o.deliveredAt != null)
  // 级联延迟：上游用户拖延，让后面的单比"所有人都秒到"晚到多少
  const cascade = served.map((o) => o.arriveAt - o.noWaitArriveAt).sort((a, b) => a - b)
  // ETA 误差：发车时给的预测 vs 实际到站（预测时还不知道用户会拖多久）
  const etaErr = served.filter((o) => o.etaDispatch != null).map((o) => Math.abs(o.arriveAt - o.etaDispatch)).sort((a, b) => a - b)
  // 按"这是本趟第几站"分层，直接回答"第几站的用户该标 ±多少分钟"
  const etaByStop = []
  for (const o of served) {
    if (o.etaDispatch == null || o.stopIndex == null) continue
    const k = o.stopIndex
    if (!etaByStop[k]) etaByStop[k] = []
    etaByStop[k].push(Math.abs(o.arriveAt - o.etaDispatch))
  }
  const etaByStopStat = etaByStop.map((arr, k) => arr ? { stop: k, n: arr.length, meanAbs: mean(arr), p95: pct(arr.slice().sort((a, b) => a - b), 95) } : null).filter(Boolean)
  // 单趟真实耗时（含等用户）
  const tripDur = batches.filter((b) => b.dispatchedAt != null && b.finishedAt != null).map((b) => b.finishedAt - b.dispatchedAt).sort((a, b) => a - b)
  const waitShare = tripDur.length ? batches.reduce((s, b) => s + (b.stops ? b.stops.reduce((x, st) => x + (st.waitSec || 0), 0) / 60 : 0), 0) / tripDur.reduce((s, x) => s + x, 0) : 0
  // 用户自己下楼花的时间（拿到手 vs 车到站）
  const pickupExtra = served.filter((o) => o.pickupAt != null).map((o) => o.pickupAt - o.arriveAt)

  // theirs 的分支占比（用来验证"情况1/情况2 到底哪个在生效"）
  const b1 = state.stats['情况1 tick'] || 0
  const b2 = state.stats['情况2 tick'] || 0
  const branchTotal = b1 + b2

  return {
    orders: orders.length,
    totalItems,
    trips,
    avgItemsPerTrip: trips ? totalItems / trips : 0,
    loadFactor: trips ? totalItems / (trips * cfg.capacity) : 0,
    totalStops,
    avgStopsPerTrip: trips ? totalStops / trips : 0,
    singleStop,
    singleStopRatio: trips ? singleStop / trips : 0,
    delivered: delivered.length,
    undelivered,
    waitMean: mean(waits),
    waitP50: pct(waits, 50),
    waitP95: pct(waits, 95),
    waitMax: waits.length ? waits[waits.length - 1] : 0,
    overdue,
    overdueRate: orders.length ? overdue / orders.length : 0,
    etaMeanSigned: mean(devs),
    waitStd,
    utilization,
    missed,
    missedRate: orders.length ? missed / orders.length : 0,
    cascadeMean: mean(cascade),
    cascadeP95: pct(cascade, 95),
    cascadeMax: cascade.length ? cascade[cascade.length - 1] : 0,
    etaMeanAbs: mean(etaErr),
    etaP95: pct(etaErr, 95),
    etaMax: etaErr.length ? etaErr[etaErr.length - 1] : 0,
    etaByStop: etaByStopStat,
    tripDurMean: mean(tripDur),
    tripDurP95: pct(tripDur, 95),
    tripDurMax: tripDur.length ? tripDur[tripDur.length - 1] : 0,
    waitShare,
    pickupExtraMean: mean(pickupExtra),
    pickupExtraP95: pct(pickupExtra.slice().sort((a, b) => a - b), 95),
    branch1Ratio: branchTotal ? b1 / branchTotal : null,
    branch2Ratio: branchTotal ? b2 / branchTotal : null,
    stats: state.stats,
    batches: batches.map((b) => ({
      id: b.id, items: b.items, stops: stopCounts[b.id - 1], landmarks: [...b.landmarks],
      reason: b.lockReason, createdAt: b.createdAt, dispatchedAt: b.dispatchedAt,
      waitBeforeDispatch: b.dispatchedAt != null ? b.dispatchedAt - b.createdAt : null
    }))
  }
}

const ROWS = [
  { key: 'orders', label: '订单数', fmt: (m) => String(m.orders) },
  { key: 'totalItems', label: '总商品件数', fmt: (m) => String(m.totalItems) },
  { key: 'trips', label: '趟数（批次数）', fmt: (m) => String(m.trips) },
  { key: 'avgItemsPerTrip', label: '平均每趟件数', fmt: (m) => m.avgItemsPerTrip.toFixed(1) },
  { key: 'loadFactor', label: '载货率（÷12件）', fmt: (m) => pctText(m.loadFactor) },
  { key: 'totalStops', label: '总停靠次数', fmt: (m) => String(m.totalStops) },
  { key: 'avgStopsPerTrip', label: '平均停靠/趟', fmt: (m) => m.avgStopsPerTrip.toFixed(1) },
  { key: 'tripDurMean', label: '单趟真实耗时', fmt: (m) => minText(m.tripDurMean) },
  { key: 'waitShare', label: '其中「等用户」占比', fmt: (m) => pctText(m.waitShare) },
  { key: 'singleStopRatio', label: '单楼栋批次占比', fmt: (m) => pctText(m.singleStopRatio) },
  { key: 'waitMean', label: '平均等待（已送达）', fmt: (m) => minText(m.waitMean) },
  { key: 'waitP50', label: '等待中位数', fmt: (m) => minText(m.waitP50) },
  { key: 'waitP95', label: '等待 P95', fmt: (m) => minText(m.waitP95) },
  { key: 'waitMax', label: '最长等待', fmt: (m) => minText(m.waitMax) },
  { key: 'overdue', label: '超时单数（>承诺）', fmt: (m) => String(m.overdue) },
  { key: 'overdueRate', label: '超时率', fmt: (m) => pctText(m.overdueRate) },
  { key: 'etaMeanAbs', label: 'ETA 平均误差', fmt: (m) => minText(m.etaMeanAbs) },
  { key: 'etaP95', label: 'ETA P95 误差', fmt: (m) => minText(m.etaP95) },
  { key: 'cascadeP95', label: '级联延迟 P95', fmt: (m) => minText(m.cascadeP95) },
  { key: 'missed', label: '未取走单数（等超时）', fmt: (m) => String(m.missed) },
  { key: 'etaMeanSigned', label: '实际−承诺（负=更早）', fmt: (m) => minText(m.etaMeanSigned) },
  { key: 'waitStd', label: '等待标准差（越小越稳）', fmt: (m) => minText(m.waitStd) },
  { key: 'utilization', label: '车辆利用率', fmt: (m) => pctText(m.utilization) },
  { key: 'undelivered', label: '未送达（仿真结束）', fmt: (m) => String(m.undelivered) }
]

function renderTable(results) {
  const cols = results.map((r) => ({
    name: r.strategy.name,
    m: computeMetrics(r)
  }))
  const labelW = Math.max(...ROWS.map((r) => dispWidth(r.label)))
  const colW = Math.max(9, ...cols.map((c) => dispWidth(c.name)))
  const lines = []
  lines.push('  ' + pad('指标', labelW) + '  ' + cols.map((c) => pad(c.name, colW, 'right')).join('  '))
  lines.push('  ' + '─'.repeat(labelW) + '  ' + cols.map(() => '─'.repeat(colW)).join('  '))
  for (const row of ROWS) {
    lines.push('  ' + pad(row.label, labelW) + '  ' + cols.map((c) => pad(row.fmt(c.m), colW, 'right')).join('  '))
  }
  return { text: lines.join('\n'), cols }
}

function renderStats(results) {
  const out = []
  for (const r of results) {
    const m = computeMetrics(r)
    if (m.branch1Ratio != null) {
      out.push('  分支占比 [' + r.strategy.name + ']：情况1 ' + pctText(m.branch1Ratio) + ' / 情况2 ' + pctText(m.branch2Ratio))
    }
    const lockKeys = Object.keys(m.stats).filter((k) => k.startsWith('定型:'))
    if (lockKeys.length) {
      out.push('  定型原因 [' + r.strategy.name + ']：' + lockKeys.map((k) => k.replace('定型:', '') + '=' + m.stats[k]).join('，'))
    }
    const placeKeys = Object.keys(m.stats).filter((k) => k.startsWith('放置:'))
    if (placeKeys.length) {
      out.push('  放置方式 [' + r.strategy.name + ']：' + placeKeys.map((k) => k.replace('放置:', '') + '=' + m.stats[k]).join('，'))
    }
    const samples = m.stats['窗口采样数'] || 0
    if (samples > 0) {
      out.push('  自适应窗口均值 [' + r.strategy.name + ']：' + (m.stats['窗口均值累计'] / samples).toFixed(1) + ' 分钟（采样 ' + samples + ' 次）')
    }
  }
  return out.join('\n')
}

// ETA 精度按"本趟第几站"分层 —— 直接回答「第几站的用户该标 ±多少分钟」
function renderEtaByStop(results) {
  const lines = []
  for (const r of results) {
    const m = computeMetrics(r)
    if (!m.etaByStop.length) continue
    lines.push('  [' + r.strategy.name + '] 单趟站序 → ETA 误差（P95 / 平均，分钟）')
    const parts = m.etaByStop.map((x) => '第' + x.stop + '站 ±' + x.p95.toFixed(1) + '(' + x.meanAbs.toFixed(1) + ',n=' + x.n + ')')
    lines.push('    ' + parts.join('  '))
    lines.push('    单趟真实耗时 平均 ' + m.tripDurMean.toFixed(1) + ' / P95 ' + m.tripDurP95.toFixed(1) +
      ' 分，其中等用户占 ' + (m.waitShare * 100).toFixed(0) + '%；用户自己下楼平均花 ' + m.pickupExtraMean.toFixed(1) + ' 分')
    lines.push('    上游拖延级联：平均 +' + m.cascadeMean.toFixed(1) + ' 分，P95 +' + m.cascadeP95.toFixed(1) + ' 分，最坏 +' + m.cascadeMax.toFixed(1) + ' 分')
  }
  return lines.join('\n')
}

// 不变量校验：跑出来的数字必须自洽，否则报告不可信
function verify(res) {
  const { cfg, state } = res
  const problems = []
  for (const b of state.batches) {
    const sum = b.orders.reduce((s, o) => s + o.items, 0)
    if (sum !== b.items) problems.push('batch#' + b.id + ' 件数与订单之和不符')
    if (b.items > cfg.capacity) problems.push('batch#' + b.id + ' 超过容量：' + b.items)
    if (b.status === 'running' && b.stops == null) problems.push('batch#' + b.id + ' 已发车却没有路线')
  }
  for (const o of state.orders) {
    if (o.batchId == null) problems.push('order#' + o.id + ' 没有进入任何批次')
    if (o.deliveredAt != null && o.deliveredAt < o.t) problems.push('order#' + o.id + ' 送达早于下单')
    if (o.deliveredAt == null && !o.missed) problems.push('order#' + o.id + ' 既没送达也不算未取走')
  }
  const batchItems = state.batches.reduce((s, b) => s + b.items, 0)
  const orderItems = state.orders.reduce((s, o) => s + o.items, 0)
  if (batchItems !== orderItems) problems.push('批次件数合计(' + batchItems + ') ≠ 订单件数合计(' + orderItems + ')')
  return problems
}

// ---------- 工具 ----------
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0 }
function std(a, mu) {
  if (a.length < 2) return 0
  const m = mu === undefined ? mean(a) : mu
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1))
}
function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

function dispWidth(s) {
  let n = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
    n += wide ? 2 : 1
  }
  return n
}
function pad(s, width, align) {
  s = String(s)
  const gap = Math.max(0, width - dispWidth(s))
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap)
}
function pctText(x) { return (x * 100).toFixed(1) + '%' }
function minText(x) { return x.toFixed(1) + ' 分' }

module.exports = { computeMetrics, renderTable, renderStats, renderEtaByStop, verify, ROWS, dispWidth, pad }
