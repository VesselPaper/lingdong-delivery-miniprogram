'use strict'

// ============================================================================
// 三种分批策略
//
//   current  —— 现有实现（基线）：backend/services/batch.js getOrCreateOpenBatch
//                best-fit 按件数挑「装得下且最满」的批次，无楼栋维度；
//                timers.js ④ 满 12 件或成立超 90 秒即定型。
//
//   theirs   —— 你给的规则：15 分钟窗口 + 情况1/2 分支 + 同楼栋最大化
//                + 按时序填空位 + 多楼栋混批时优先距离近的组合。
//
//   deadline —— 我建议的统一规则（对照用）：把「15 分钟固定窗口」换成
//                「每批的最晚发车时刻」，规则更少、无分支抖动。
//
// 规则里没写、由我补上的假设都标了 ★，并做成可用参数开关，方便你逐条验证。
// ============================================================================

// ---------- 放置逻辑（theirs / deadline 共用）----------
// 你规则的三条优先级：1 同楼栋 → 3 楼栋距离近（★有坐标时） → 2 按时序填空位
function placeByRules(state, o) {
  const cfg = state.cfg
  const fitting = state.openBatches().filter((b) => state.fits(b, o))

  // 全放不下 → 新建批次（★你的规则没写这条，但不写就会把订单丢掉）
  if (fitting.length === 0) {
    bump(state.stats, '新建批次')
    return state.place(o, state.createBatch())
  }

  // 规则 1：优先相同楼栋合并（多个候选时选已装最多的，最大化同楼栋装载）
  const same = fitting.filter((b) => b.landmarks.has(o.lm))
  if (same.length) {
    let best = same[0]
    for (const b of same) if (b.items > best.items) best = b
    bump(state.stats, '放置:同楼栋')
    return state.place(o, best)
  }

  // 规则 3：混批时优先与批次已有楼栋距离更近的组合（★仅在坐标可用时）
  if (cfg.useCoords && cfg.rule3) {
    const lm = state.L.get(o.lm)
    if (lm && (lm.x !== 0 || lm.y !== 0)) {
      let best = null
      let bestD = Infinity
      for (const b of fitting) {
        for (const lid of b.landmarks) {
          const ol = state.L.get(lid)
          if (!ol) continue
          const d = Math.hypot(lm.x - ol.x, lm.y - ol.y)
          if (d < bestD) { bestD = d; best = b }
        }
      }
      if (best) {
        bump(state.stats, '放置:就近楼栋')
        return state.place(o, best)
      }
    }
  }

  // 规则 2：按点单时间顺序，填补最早建立的、装得下的批次
  let target = fitting[0]
  for (const b of fitting) if (b.createdAt < target.createdAt) target = b
  bump(state.stats, '放置:按时序')
  return state.place(o, target)
}

function earliestOpenOrderTime(state) {
  let m = null
  for (const b of state.openBatches()) {
    for (const o of b.orders) if (m === null || o.t < m) m = o.t
  }
  return m
}

// ============================================================================
// ① 现有实现（基线）
// ============================================================================
function makeCurrent() {
  return {
    name: 'current',
    label: '现有 best-fit（90 秒 / 满 12 件，无楼栋维度）',
    onOrderArrive(state, o) {
      const fitting = state.openBatches().filter((b) => state.fits(b, o))
      // best-fit：装得下且当前最满；并列取 id 更大（更新的那个）——与 getOrCreateOpenBatch 的 ORDER BY 一致
      let target = null
      for (const b of fitting) {
        if (!target || b.items > target.items || (b.items === target.items && b.id > target.id)) target = b
      }
      if (!target) target = state.createBatch()
      state.place(o, target)
    },
    tick(state) {
      const cfg = state.cfg
      for (const b of state.openBatches()) {
        if (b.items >= cfg.capacity) state.lock(b, '满容')
        else if (state.now - b.createdAt >= cfg.minWaitMin) state.lock(b, '超时 90s')
      }
    }
  }
}

// ============================================================================
// ② 你的规则
// ============================================================================
function makeTheirs() {
  return {
    name: 'theirs',
    label: '你的规则（15 分钟窗口 + 情况1/2 分支）',
    onOrderArrive(state, o) {
      placeByRules(state, o)
    },
    tick(state) {
      const cfg = state.cfg

      // ★ 单楼栋早发：批次里只有一个楼栋、件数已凑够 N 件 → 不必等窗口，直接发车。
      //   这是「同楼栋优先于时间」的可调实现，N 由 --samebldg 控制（0 = 关闭）。
      if (cfg.sameBuildingMinItems > 0) {
        for (const b of state.openBatches()) {
          if (b.landmarks.size === 1 && b.items >= cfg.sameBuildingMinItems) state.lock(b, '同楼栋凑够')
        }
      }

      // ★ 你的规则没写「什么时候发车」，这里按最自然读法补：装满必发
      for (const b of state.openBatches()) {
        if (b.items >= cfg.capacity) state.lock(b, '满容')
      }

      // 分支：未定型批次数 vs 无人车数量
      const openCount = state.openBatches().length
      const pendingCount = cfg.countMode === 'allPending' ? state.pendingBatches().length : openCount
      const carCount = cfg.carMode === 'idle' ? state.idleCars().length : state.cars.length
      const inCase1 = pendingCount <= carCount
      bump(state.stats, inCase1 ? '情况1 tick' : '情况2 tick')

      if (inCase1) {
        // 情况 1：按「每单 15 分钟计时」定型（批内最早那单到点即视为到点）
        for (const b of state.openBatches()) {
          if (state.now - b.createdAt >= cfg.windowMin) state.lock(b, '情况1 计时到点')
        }
      } else {
        if (cfg.timerMode === 'perOrder') {
          // 读法 A：按批计时（等价于"批内最早订单的 15 分钟计时到点"）
          for (const b of state.openBatches()) {
            if (state.now - b.createdAt >= cfg.windowMin) state.lock(b, '情况2 按批计时')
          }
        } else {
          // 读法 B（默认）：以「最早未定型订单的下单时间」为锚，15 分钟一轮，锁定窗口内所有批次
          const anchor = earliestOpenOrderTime(state)
          if (anchor !== null && state.now - anchor >= cfg.windowMin) {
            for (const b of state.openBatches()) {
              const t0 = Math.min(...b.orders.map((o) => o.t))
              if (t0 < anchor + cfg.windowMin) state.lock(b, '情况2 窗口锁定')
            }
          }
        }
      }
    }
  }
}

// ============================================================================
// ③ 自适应窗口（对照用）：放置规则与你的规则完全一致，只把「固定的 15 分钟」
//    换成随积压量滑动的窗口 —— 低负载用短窗（不让人白等），高负载用长窗（攒满一车）。
//    窗口 = adaptLow + (adaptHigh − adaptLow) × 在途件数 / (车数 × 容量)
// ============================================================================
function makeAdaptive() {
  return {
    name: 'adaptive',
    label: '自适应窗口（低负载短窗 / 高负载长窗）+ 同楼栋优先',
    onOrderArrive(state, o) {
      placeByRules(state, o)
    },
    tick(state) {
      const cfg = state.cfg
      for (const b of state.openBatches()) {
        if (b.items >= cfg.capacity) state.lock(b, '满容')
      }
      // 负载信号用「在途未送完的件数」而不是「未装满的空位」：后者在批次一装满
      // 就归零，会把高负载误判成低负载（实测窗口均值只剩 4 分钟）。
      let outstanding = 0
      for (const b of state.batches) {
        if (b.finishedAt == null || state.now < b.finishedAt) outstanding += b.items
      }
      const load = Math.min(1, outstanding / Math.max(1, cfg.cars * cfg.capacity))
      const win = cfg.adaptLow + (cfg.adaptHigh - cfg.adaptLow) * load
      state.stats['窗口均值累计'] = (state.stats['窗口均值累计'] || 0) + win
      state.stats['窗口采样数'] = (state.stats['窗口采样数'] || 0) + 1
      for (const b of state.openBatches()) {
        if (state.now - b.createdAt >= win) state.lock(b, '自适应窗口到点')
      }
    }
  }
}

// ============================================================================
// ④ 建议的统一规则（对照用）
//    发车条件三选一：装满 / 到最晚发车时刻 / 车驱动
//    最晚发车时刻 = min(批内订单承诺送达) − 预计行程 − 缓冲
// ============================================================================
function makeDeadline() {
  return {
    name: 'deadline',
    label: '建议的统一规则（最晚发车时刻驱动，无分支）',
    onOrderArrive(state, o) {
      placeByRules(state, o)
    },
    tick(state) {
      const cfg = state.cfg
      for (const b of state.openBatches()) {
        if (b.items >= cfg.capacity) { state.lock(b, '满容'); continue }
        const promise = Math.min(...b.orders.map((o) => o.t + cfg.promiseMin))
        const trip = state.estimateTripMin(b.orders)
        const latest = promise - trip - cfg.bufferMin
        if (state.now >= latest) { state.lock(b, '最晚发车时刻'); continue }
        // 车驱动：有空闲车且本批已等够最小等待 → 让它去跑，别让车空转
        if (state.idleCars().length > 0 && state.now - b.createdAt >= cfg.minWaitMin) {
          state.lock(b, '车驱动')
        }
      }
    }
  }
}

const FACTORIES = { current: makeCurrent, theirs: makeTheirs, adaptive: makeAdaptive, deadline: makeDeadline }

function makeStrategy(name) {
  const f = FACTORIES[name]
  if (!f) throw new Error('未知策略：' + name + '（可选：' + Object.keys(FACTORIES).join(' / ') + '）')
  return f()
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1
}

module.exports = { makeStrategy, FACTORIES }
