'use strict'
// 确定性随机数（mulberry32）：同一个 seed 必得同一串订单流，
// 这样「换策略」时的差异只来自算法，而不是随机波动，问题也能复现。

function makeRng(seed) {
  let a = (Number(seed) || 1) >>> 0
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 按权重返回下标（权重不必归一化）
function weightedIndex(rng, weights) {
  let sum = 0
  for (const w of weights) sum += w
  if (sum <= 0) return 0
  let r = rng() * sum
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r <= 0) return i
  }
  return weights.length - 1
}

module.exports = { makeRng, weightedIndex }
