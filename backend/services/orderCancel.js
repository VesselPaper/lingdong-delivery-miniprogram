// 订单取消 / 退款的本地落账 —— 全项目唯一入口。
//
// 存在理由：此前 server.js applyOrderCancelled 与 platform.js applyStatus 各写一半取消逻辑，
// 一边摘批次、另一边收到平台 110 又摘一次；一边回补库存、另一边又补一次。任何一条重试路径
// 都会造成批次计数双扣、库存双补。这里把所有本地副作用收敛到一处，并用显式标记列保证
// 每条副作用只发生一次。
//
// 两条硬性约束：
//  1. cancelLocal 内部**不得 await**。一旦让出事件循环，平台轮询(8s)、自动派车(15s)、
//     超时扫描(60s) 三个定时器会插进来读到「订单已取消但批次未摘除」的中间态。
//     需要调用平台（召回机器人 / 微信退款）的，一律在 cancelLocal 返回之后再做。
//  2. 本地库是唯一真相源。平台召回失败只记 recall_status=2 待人工，绝不回滚本地取消。

const goodsStats = require('./goodsStats')
const batch = require('./batch')

// CAS 抢占「取消权」：只有从可取消状态出发且从未取消过才成功。
// 返回 true 代表本次调用拿到取消权、负责执行全部副作用；false 代表别的调用已处理过。
// 这同时是并发锁（用户与商家同时点取消）与幂等锁（平台回调重推）。
// 可取消状态：0待支付 1待接单 2配送中 3已送达 6配送异常（4已完成走售后退款，7已退款是终态）
function claimCancelled(store, orderId) {
  const r = store.prepare(`
    UPDATE orders SET status=5,
      cancelled_at=COALESCE(cancelled_at, datetime('now','localtime')),
      updated_at=datetime('now','localtime')
    WHERE id=? AND cancelled_at IS NULL AND status IN (0,1,2,3,6)`).run(Number(orderId))
  return r.changes === 1
}

// CAS 抢占「退款权」：可从 5已取消 升级为 7已退款，也可从各可退款状态直接进入。
// 7 已是终态，不可重复退款。
function claimRefunded(store, orderId) {
  const r = store.prepare(`
    UPDATE orders SET status=7,
      cancelled_at=COALESCE(cancelled_at, datetime('now','localtime')),
      updated_at=datetime('now','localtime')
    WHERE id=? AND status IN (0,1,2,3,4,5,6)`).run(Number(orderId))
  return r.changes === 1
}

// 作废本单的配送任务：置 110 并写显式 void_at，此后一切迟到的平台/模拟状态都会被丢弃。
// 已完成(80)与已终态(110/150)的任务不改写，避免把「真的送到了」抹掉。
// 返回被作废的任务快照，供调用方决定召回策略（排队中走 queue/cancel，已上货走 deviceCtrl/close）。
function voidTasks(store, orderId, reason) {
  const tasks = store.prepare('SELECT * FROM delivery_tasks WHERE order_id=?').all(Number(orderId))
  const voided = []
  for (const t of tasks) {
    const st = Number(t.task_status)
    if (t.void_at || st === 80 || st === 110 || st === 150) continue
    store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text=?,
      void_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(reason || '订单取消', t.id)
    voided.push(t)
  }
  return voided
}

// 执行取消/退款的全部本地副作用。opts.finalStatus=7 表示退款，否则为取消(5)。
// 返回值 { claimed, finalStatus, tasks }；claimed=false 说明本次是重复调用，未做任何写入。
function cancelLocal(store, order, opts) {
  if (!order) return { claimed: false, finalStatus: 5, tasks: [] }
  const o = opts || {}
  const finalStatus = Number(o.finalStatus) === 7 ? 7 : 5
  const claimed = finalStatus === 7 ? claimRefunded(store, order.id) : claimCancelled(store, order.id)
  if (!claimed) return { claimed: false, finalStatus, tasks: [] }

  const voided = voidTasks(store, order.id, o.reason)
  // 未售出则回补库存（内部以 stock_restored_at 幂等；已结算的单自动跳过）
  goodsStats.restoreStock(store, order.id)
  // 从批次摘除（内部以 batch_removed_at 幂等）
  batch.removeOrderFromBatch(store, order)
  // 停掉本地模拟推进：mockAdvance 每 4s 自动推进，不清定时器就会把状态一路推回来
  stopMock(voided)

  return { claimed: true, finalStatus, tasks: voided }
}

function stopMock(tasks) {
  if (!tasks || !tasks.length) return
  // 延迟 require：platform.js 在文件末尾才 module.exports，加载期成环会拿到空对象。
  // 运行到此处时 platform 早已加载完毕，缓存里是完整 exports。
  let platform = null
  try { platform = require('./platform') } catch (e) { return }
  for (const t of tasks) {
    try { platform.cancelMockTask(t.id) } catch (e) { /* 模拟任务不存在，忽略 */ }
  }
}

module.exports = { claimCancelled, claimRefunded, voidTasks, cancelLocal }
