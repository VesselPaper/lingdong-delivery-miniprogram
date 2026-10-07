// delivery 域定时器统一装配：server.js 只调用一次 start(store, deps)。
// 4 个定时器（05 方案 §2.3）：
//   ① 真实模式任务状态轮询兜底（POLL_MS 默认 8s，仅 realPlatform）
//   ② 超时未接单检测（DELIVERY_SCAN_MS 默认 60s，仅 realPlatform）
//   ③ 取餐超时两段式扫描（PICKUP_SCAN_MS 默认 30s，恒开）
//   ④ 批次自动定型 + 模拟配送到达（BATCH_SCAN_MS 默认 15s，恒开）
// deps = { runtime, platform, goods, order, orderCancel, batch }（与 delivery/routes.js 同源）

const s = require('./service')

const BATCH_SCAN_MS = Number(process.env.BATCH_SCAN_MS || 15 * 1000)
const POLL_MS = Number(process.env.PLATFORM_POLL_MS || 8000)
const SUMMON_WATCHDOG_MS = Number(process.env.SUMMON_WATCHDOG_MS || 5 * 1000)
const healAt = new Map()
// 自动定型失败节流(batch_id->ts)：车离线/忙时至少 60s 再试，避免每 15s 刷平台查询与日志
const autoRetryAt = new Map()
// 上货点「有单就守着」：车最后一次成功召唤上货点的时间(device_sn->ts)，到点前续一次，车物理不离开。
const keepAt = new Map()
// 召唤节流(device_sn->ts)：机器人离线/召唤失败时至少 30s 再试，避免刷爆平台。
const keepTryAt = new Map()


// 空闲可派的车有几台（v2 时机层用）。
//   可用车 = 总车数 − 占用车的【并集】
//   占用 = 离线的  ∪  平台报忙的  ∪  被未完成批次占用（待上货/配送中）的
//   取并集是为了避免同一台车被扣两次（比如一台车既在配送中、平台又报 Delivery）。
//   总车数取平台设备列表的条数，不写死；演示档/平台不可用时退回 BATCH_TOTAL_CARS（默认 2）。
// 不变量自检的日志节流（有问题时最多 60s 打一次，避免刷屏）
let lastInvariantLog = 0

const BUSY_MACHINE = ['Delivery', 'delivery', 'patrol', 'Patrol', 'exception', 'remoteDevOps', 'update', 'interaction']
async function carState(store, deps) {
  // 被未完成批次占用的车（含「已派车但还没出发」的待上货批次）
  const byBatch = new Set(store.prepare(`
    SELECT DISTINCT device_sn FROM delivery_batches WHERE status IN (1,2) AND device_sn IS NOT NULL AND device_sn != ''
  `).all().map((r) => String(r.device_sn)))
  // 没指派设备号的未完成批次：演示档不指认真车，device_sn 一直是空。
  // 一台车对一个批次，按数量计入占用 —— 否则演示档里永远显示"车都空着"。
  // 真实档下批次一定有 device_sn，noSn 恒为 0，不影响真实计算。
  const noSn = Number(store.prepare(
`    SELECT COUNT(*) c FROM delivery_batches WHERE status IN (1,2) AND (device_sn IS NULL OR device_sn = '')
  `).get().c || 0)
  const occupied = new Set(byBatch)
  let total = 0, source = 'config', offline = 0, machineBusy = 0
  let r = null
  try { r = await deps.platform.getDeviceList() } catch (e) { r = null }
  if (r && r.ok && Array.isArray(r.robots) && r.robots.length) {
    total = r.robots.length
    source = 'platform'
    for (const rb of r.robots) {
      const sn = String(rb.device_sn || '')
      if (!sn) continue
      if (!rb.online) { occupied.add(sn); offline++; continue }
      if (BUSY_MACHINE.includes(String(rb.machine_status || ''))) { occupied.add(sn); machineBusy++ }
    }
  } else {
    total = Number(process.env.BATCH_TOTAL_CARS || 2)
  }
  const occupiedCount = occupied.size + noSn
  return {
    total, occupied: occupiedCount,
    available: Math.max(0, total - occupiedCount),
    source, offline, machine_busy: machineBusy, by_batch: byBatch.size, no_sn: noSn
  }
}
function start(store, deps) {
  // ---------- ① 真实模式任务状态轮询兜底 ----------
  if (deps.runtime.realPlatform) {
    setInterval(async () => {
      try {
        // P1-4：只跳过终态（80 完成 / 110 取消 / 150 关闭）与已作废任务。
        // 70 到达取货点必须轮询：到达回调若丢失，轮询是订单推进到「已送达(3)」的兜底。
        // 90-109（上货/取货失败）与 120-140（挂起）同样在轮询范围 —— 它们需要同步到
        // 「配送异常(6)」或人工恢复，原先 task_status < 80 把它们全部挡在轮询外，订单卡死。
        const rows = store.prepare(`
          SELECT d.id FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
          WHERE d.task_status NOT IN (80,110,150) AND d.void_at IS NULL AND d.platform_task_id != ''`).all()
        for (const r of rows) {
          await deps.platform.syncTaskStatus(store, r.id)
        }
      } catch (e) { /* 轮询异常静默 */ }
    }, POLL_MS)
  }

  // ---------- ② 超时未接单检测（真实档） ----------
  if (deps.runtime.realPlatform) {
    const { DELIVERY_SCAN_MS } = deps.order
    setInterval(() => { s.scanStuckDeliveries(store, deps) }, DELIVERY_SCAN_MS)
    s.scanStuckDeliveries(store, deps)
  }

  // ---------- ③ 取餐超时两段式扫描（恒开，demo 档也要走两段式用例） ----------
  const { PICKUP_SCAN_MS } = deps.order
  setInterval(() => { s.scanPickupTimeouts(store, deps).catch(() => {}) }, PICKUP_SCAN_MS)
  s.scanPickupTimeouts(store, deps).catch(() => {})

  // ---------- ④ 批次自动定型（一车多单）+ 模拟配送到达 ----------
  // 组单中的批次满足任一条件即自动定型（status 0→1，指派设备锁定）：
  //  1) 达到一车容量上限（BATCH_MAX_ITEMS，默认 12 件）
  //  2) 批次成立超过 BATCH_WAIT_MS（默认 90s）
  // 定型后广播 batch_dispatched → 商家端刷新列表，卡面从「组单中」变为「待上货」，
  // 不再一直停在组单中。手动「上货」/扫码始终可用；并发由 claimDispatch 保证不重复派车。
  // 召唤模式（syncLoading=0）下 doDispatchBatch 只定型设备（不建越凡任务），车由看门狗⑤召到上货点待命。
  setInterval(async () => {
    try {
      // P1-4：模拟配送到达处理（不依赖营业状态、不依赖内存 setTimeout，重启后按落库时间补送达）
      // 仅模拟档执行：真实档若残留 mock_arrive_at（历史数据或异常调用写入），不加这层会把真实订单也推进成「已送达」。
      if (deps.runtime.deviceMock) s.processMockArrivals(store, deps)
      // 跨域只读：店铺营业状态（goods 域；保持与原先 server.js 相同的直接读法）
      const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
      if (shop.business_status !== 'open') return
      const openBatches = store.prepare('SELECT * FROM delivery_batches WHERE status IN (0,1) ORDER BY id ASC').all()

      // v2：先算出本轮该锁哪些批次（情况1/情况2、窗口、优先级都在 batch 模块里决策）。
      // legacy：planAutoLock 返回 null，仍走逐批 shouldAutoLock 的老路径，且不查平台。
      let planOrder = null
      if (deps.batch.BATCH_ALGO === 'v2' && typeof deps.batch.planAutoLock === 'function') {
        const cars = await carState(store, deps)
        const plan = deps.batch.planAutoLock(store, { cars }) || []
        planOrder = new Map(plan.map((id, i) => [Number(id), i]))
      }

      const todo = []
      for (const b of openBatches) {
        const cnt = store.prepare(`
          SELECT COUNT(DISTINCT o.id) c, IFNULL(SUM(oi.quantity),0) items
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE o.batch_id=? AND o.status IN (1,2)`).get(b.id)
        const n = Number(cnt && cnt.c || 0)
        if (n <= 0) continue
        // 待上货(1)已定型，只需由看门狗⑤保持在位，这里无事可做
        if (Number(b.status) !== 0) continue
        const items = Number(cnt && cnt.items || 0)
        // 定型规则收敛到 batch 模块，本定时器只负责调度。
        if (planOrder) {
          if (!planOrder.has(Number(b.id))) continue
        } else if (!deps.batch.shouldAutoLock(store, b, items)) continue
        todo.push({ b, items })
      }
      // 按计划顺序执行 = 派车优先级（第一张订单最早的先走，车不够时先发得出去）
      if (planOrder) todo.sort((x, y) => planOrder.get(Number(x.b.id)) - planOrder.get(Number(y.b.id)))

      for (const { b, items } of todo) {
        const full = items >= Number(deps.batch.BATCH_MAX_ITEMS || 12) // 仅用于下面日志措辞
        // 失败节流：上次尝试（成功与否）后 60s 内不再重试
        if (Date.now() - (autoRetryAt.get(b.id) || 0) < 60 * 1000) continue
        autoRetryAt.set(b.id, Date.now())
        try {
          await s.doDispatchBatch(store, deps, b.id, '')
          console.log('[batch] 自动定型 ' + b.batch_no + (full ? ' 满容' : ' 超时') + ' items=' + items)
        } catch (e) {
          // 无空闲车 / 车忙等：节流后下轮再试，不中断扫描
          console.warn('[batch] 自动定型失败 batch=' + b.id + ' ' + e.message)
        }
      }

      // 不变量自检（收口）：检查"件数≤12 / 每趟≤15分 / 站点≥1 / 订单最终发得出去"。
      // 只在发现问题时打日志，最多 60s 一次。checkInvariants 不存在时（老版本）自动跳过。
      if (typeof deps.batch.checkInvariants === 'function') {
        const inv = deps.batch.checkInvariants(store)
        if (!inv.ok && Date.now() - lastInvariantLog > 60 * 1000) {
          lastInvariantLog = Date.now()
          console.warn('[batch] 不变量自检发现 ' + inv.violations.length + ' 处问题：')
          for (const x of inv.violations.slice(0, 10)) console.warn('         · [' + x.type + '] ' + x.detail)
          if (inv.violations.length > 10) console.warn('         · …还有 ' + (inv.violations.length - 10) + ' 处')
        }
      }
    } catch (e) { console.warn('[batch] 自动定型扫描异常', e.message) }
  }, BATCH_SCAN_MS)

  // ---------- ⑤ 召唤多单配送推进看门狗（SUMMON_DELIVERY=true 时兜底） ----------
  // 不依赖「取餐事件 → 钩子」这条异步链（真实链路里钩子/定时器可能丢），改为定时扫描：
  // 对 delivery_mode=summon 且配送中(2)的批次，若当前站订单已全部取走，
  // 就触发 advanceSummonDelivery（其内部自带 5s 步进 + current_stop 独占 + 防重 Set）。
  // 即使事件钩子没跑、或服务重启，也能保证「送完本栋 → 必然推进下一栋 / 召回完成」。
  if (deps.runtime.summonDelivery) {
    setInterval(async () => {
      try {
        // ③ 上货点「有单就守着」：有「组单中/待上货」批次且该车不在配送时，保持它的召唤上货点任务
        //    （默认每 4 分钟在 5 分钟窗口到期前续一次），车物理一直停在上货点，不会到期返程。
        //    无待上货批次 → 本轮不续（由「释放事件」settleRobot 走 3 分钟释放返程）。
        //    商家点「立即配送」后批次转配送中(2)，本循环不再续，车由新召唤正常出发送货。
        //    注意：这不是"轮询是否有新单来派车"，而是"守住已指派/该待的上货点"，与「不轮询查单来释放」并存。
        const keepMs = Number(process.env.SUMMON_LOADING_KEEP_MS || 4 * 60 * 1000)
        const loadables = store.prepare(`
          SELECT id, device_sn, light_task_id FROM delivery_batches
          WHERE status IN (0,1) AND total_orders>0 AND device_sn!='' ORDER BY id ASC`).all()
        const byDev = new Map()
        for (const lb of loadables) {
          if (!byDev.has(lb.device_sn)) byDev.set(lb.device_sn, [])
          byDev.get(lb.device_sn).push(lb)
        }
        for (const [sn, batches] of byDev) {
          try {
            const delivering = store.prepare("SELECT id FROM delivery_batches WHERE device_sn=? AND delivery_mode='summon' AND status=2 LIMIT 1").get(sn)
            if (delivering) continue
            let lid = ''
            for (const b of batches) if (b.light_task_id) lid = b.light_task_id
            const lastTs = keepAt.get(sn) || 0
            let need = false
            if (!lid) need = true
            else {
              const qr = await deps.platform.queryLightTask(lid)
              if (!qr.ok) need = true
              else if ([40, 50, 60].includes(qr.status)) need = true
              else if (!lastTs) keepAt.set(sn, Date.now()) // 任务活着且首次见到→采纳为新鲜
              else if (Date.now() - lastTs >= keepMs) need = true // 到点前续一次
            }
            if (need) {
              if (Date.now() - (keepTryAt.get(sn) || 0) < 30 * 1000) continue
              keepTryAt.set(sn, Date.now())
              const r2 = await deps.platform.summonToLoadingPoint(store, sn)
              if (r2.ok) {
                keepAt.set(sn, Date.now())
                const newest = batches[batches.length - 1]
                if (r2.light_task_id && newest) store.prepare("UPDATE delivery_batches SET light_task_id=?, updated_at=datetime('now','localtime') WHERE id=?").run(r2.light_task_id, newest.id)
                console.log('[summon] 车 ' + sn + ' 保持在上货点（有待上货批次#' + (newest && newest.id) + '，续一次）')
              }
            }
          } catch (e) { /* 单台不影响 */ }
        }
        // ① 正常推进：当前站全取走 → 推下一站/召回完成
        const rows = store.prepare("SELECT id FROM delivery_batches WHERE delivery_mode='summon' AND status=2").all()
        for (const r of rows) {
          await s.advanceSummonDelivery(store, deps, r.id)
        }
        // ② 自愈「半启动」批次：status=2 且 current_stop=0（上次召唤首站失败抛错，批次已推进到配送中、
        //    但首站订单没置待取货 → 用户端卡死在配送中）。重跑 startSummonDelivery 补召唤+补标。
        //    节流到每 START_HEAL_MS 至多一次，避免机器人/平台被连续失败的召唤刷爆。
        const healMs = Number(process.env.SUMMON_START_HEAL_MS || 25 * 1000)
        const stuck = store.prepare("SELECT id FROM delivery_batches WHERE delivery_mode='summon' AND status=2 AND (current_stop IS NULL OR current_stop=0)").all()
        for (const r2 of stuck) {
          const prev = healAt.get(r2.id) || 0
          if (Date.now() - prev < healMs) continue
          healAt.set(r2.id, Date.now())
          try { await s.startSummonDelivery(store, deps, r2.id) } catch (e) { /* 该批次暂无法召唤，等下轮 */ }
        }
      } catch (e) { console.warn('[summon] 推进看门狗异常', e.message) }
    }, SUMMON_WATCHDOG_MS)
  }
}

module.exports = { start, BATCH_SCAN_MS, carState }
