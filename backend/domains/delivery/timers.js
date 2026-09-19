// delivery 域定时器统一装配：server.js 只调用一次 start(store, deps)。
// 4 个定时器（05 方案 §2.3）：
//   ① 真实模式任务状态轮询兜底（POLL_MS 默认 8s，仅 realPlatform）
//   ② 超时未接单检测（DELIVERY_SCAN_MS 默认 60s，仅 realPlatform）
//   ③ 取餐超时两段式扫描（PICKUP_SCAN_MS 默认 30s，恒开）
//   ④ 批次自动派车 + 模拟配送到达（BATCH_SCAN_MS 默认 15s，恒开）
// deps = { runtime, platform, goods, order, orderCancel, batch }（与 delivery/routes.js 同源）

const s = require('./service')

const BATCH_SCAN_MS = Number(process.env.BATCH_SCAN_MS || 15 * 1000)
const POLL_MS = Number(process.env.PLATFORM_POLL_MS || 8000)
const SUMMON_WATCHDOG_MS = Number(process.env.SUMMON_WATCHDOG_MS || 5 * 1000)

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

  // ---------- ④ 批次自动派车（一车多单）+ 模拟配送到达 ----------
  // 组单中的批次满足任一条件即自动派车：
  //  1) 达到一车容量上限（BATCH_MAX_ORDERS，默认 12 单）
  //  2) 自动接单模式开启且批次成立超过 BATCH_WAIT_MS（默认 90s）
  // 手动「派车」按钮始终可用。
  setInterval(async () => {
    try {
      // P1-4：模拟配送到达处理（不依赖营业状态、不依赖内存 setTimeout，重启后按落库时间补送达）
      s.processMockArrivals(store, deps)
      // 跨域只读：店铺营业状态（goods 域；保持与原先 server.js 相同的直接读法）
      const shop = store.prepare('SELECT * FROM shops WHERE id=1').get() || {}
      if (shop.business_status !== 'open') return
      // status IN (0,1)：组单中(0)持续收单召唤待命；待上货(1)已定型指派设备，仍需确保车在上货点
      // （问题1修复：此前只在 status=0 召唤，商家快速定型后扫描停止召唤，车没到上货点就开舱会失败）
      // 2026-09-17：Route B 改 syncLoading=0 后不再召唤 —— 直接任务在定型时创建，车自行导航到上货点
      // （任务状态 30=到达上货点，开舱门禁以此为准）。召唤的 lightTask 无法取消，会挡住配送任务启动。
      const openBatches = store.prepare('SELECT * FROM delivery_batches WHERE status IN (0,1) ORDER BY id ASC').all()
      for (const b of openBatches) {
        const cnt = store.prepare(`
          SELECT COUNT(DISTINCT o.id) c, IFNULL(SUM(oi.quantity),0) items
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE o.batch_id=? AND o.status IN (1,2)`).get(b.id)
        const n = Number(cnt && cnt.c || 0)
        if (n <= 0) continue
        // 仅扫描留空（不再召唤）；批次在定型时由 doDispatchBatch 创建直接任务驱动车辆
      }
    } catch (e) { console.warn('[batch] 自动派车扫描异常', e.message) }
  }, BATCH_SCAN_MS)

  // ---------- ⑤ 召唤多单配送推进看门狗（SUMMON_DELIVERY=true 时兜底） ----------
  // 不依赖「取餐事件 → 钩子」这条异步链（真实链路里钩子/定时器可能丢），改为定时扫描：
  // 对 delivery_mode=summon 且配送中(2)的批次，若当前站订单已全部取走，
  // 就触发 advanceSummonDelivery（其内部自带 5s 步进 + current_stop 独占 + 防重 Set）。
  // 即使事件钩子没跑、或服务重启，也能保证「送完本栋 → 必然推进下一栋 / 召回完成」。
  if (deps.runtime.summonDelivery) {
    setInterval(async () => {
      try {
        const rows = store.prepare("SELECT id FROM delivery_batches WHERE delivery_mode='summon' AND status=2").all()
        for (const r of rows) {
          await s.advanceSummonDelivery(store, deps, r.id)
        }
      } catch (e) { console.warn('[summon] 推进看门狗异常', e.message) }
    }, SUMMON_WATCHDOG_MS)
  }
}

module.exports = { start, BATCH_SCAN_MS }
