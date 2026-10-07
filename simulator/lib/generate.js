'use strict'
const { makeRng, weightedIndex } = require('./rng')

// 用户响应时长（下单到下楼走到车边的秒数）：对数正态，尾巴长——大多数人很快，少数人很慢。
// 关键：这个值「预先分配给每个订单」，所有策略共用同一批用户行为，对比才公平。
function userResp(rng, median, sigma) {
  const u1 = Math.max(1e-9, rng())
  const u2 = rng()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(5, median * Math.exp(sigma * z))
}

// 生成订单流。所有策略共用同一串订单（同 seed 必得同一结果），
// 这样策略之间的差异只来自分批算法本身。
function generateArrivals(cfg) {
  const rng = makeRng(cfg.seed)
  const deliver = cfg.landmarks.filter((l) => l.type === 'deliverPoint').sort((a, b) => a.sort - b.sort)
  const weights = cfg.landmarkWeights
  if (weights.length !== deliver.length) {
    throw new Error('landmarkWeights 长度(' + weights.length + ') 与送达点数(' + deliver.length + ') 不一致')
  }
  const itemPairs = cfg.itemsDist
  const itemWeights = itemPairs.map((p) => p[1])
  const horizon = cfg.hours * 60
  const tick = cfg.tickSec / 60
  const med = cfg.userRespMedianSec || 0
  const sigma = cfg.userRespSigma

  const out = []
  let id = 0
  const push = (t, lm, items) => {
    out.push({ id: ++id, t: round6(t), lm, items, respSec: med > 0 ? Math.round(userResp(rng, med, sigma) * 10) / 10 : 0 })
  }
  for (let t = 0; t < horizon - 1e-9; t += tick) {
    const rate = rateAt(cfg, t)
    const p = (rate / 60) * tick // 本步内至少来一单的概率（离散化泊松过程）
    if (rng() >= p) continue
    const li = weightedIndex(rng, weights)
    let items = itemPairs[weightedIndex(rng, itemWeights)][0]
    // 单笔超过容量 → 下单时拆单（与 backend/domains/order/service.js splitOrderChunks 语义一致）
    while (items > cfg.capacity) {
      push(t, deliver[li].id, cfg.capacity)
      items -= cfg.capacity
    }
    if (items > 0) push(t, deliver[li].id, items)
  }
  return out
}

function rateAt(cfg, t) {
  let r = cfg.ratePerHour
  for (const pk of cfg.peaks || []) {
    if (t >= pk.startMin && t < pk.endMin) r *= pk.multiplier
  }
  return r
}

function round6(x) { return Math.round(x * 1e6) / 1e6 }

module.exports = { generateArrivals, rateAt }
