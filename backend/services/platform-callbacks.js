// services/platform-callbacks.js —— 开放物流平台对接·回调/轮询状态同步层（结构评审 P0-2 拆分件之二）
// ------------------------------------------------------------------
// 职责：任务状态同步的唯一咽喉（applyStatus）—— 平台回调（server.js /api/platform/callback/delivery）、
// basicList 轮询兜底（syncTaskStatus）、本地模拟（platform-mock.mockAdvance）三条通道全部经过这里。
// 订单状态迁移一律经注入的 orderStateSink 转交 order 域收口（结构评审 P0-1），本文件不直写 orders。
// 依赖方向：只 require services 层（http/batch/goodsStats/orderCancel），被入口 platform.js 与 mock 层 require。
'use strict'

const httpApi = require('./platform-http')
const batch = require('./batch')
const goodsStats = require('./goodsStats')
const orderCancel = require('./orderCancel')

const TASK_TERMINAL = [110, 150]  // 任务取消 / 任务关闭

// ---------------- 订单状态迁移注入钩子（由 server.js 经入口 platform.setOrderStateSink 注入） ----------------
let orderStateSink = null
function setOrderStateSink(fn) {
  orderStateSink = typeof fn === 'function' ? fn : null
}
function emitOrderState(store, ev) {
  if (!orderStateSink) return null
  try { return orderStateSink(store, ev) } catch (e) { console.warn('[platform] 订单状态迁移失败', e.message); return null }
}

// 任务状态写入的唯一咽喉：平台回调（server.js /api/platform/callback/delivery）、
// basicList 轮询兜底（syncTaskStatus）、本地模拟（mockAdvance）三条通道全部经过这里，
// 因此终态守卫只需在这一处实现。
function applyStatus(store, taskId, status, text) {
  const st = Number(status)   // 回调报文里的 taskStatus 可能是字符串，先归一化
  const task = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
  if (!task) return
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(task.order_id) || null

  // ---- 终态守卫 ----
  // 本地已作废（void_at / 110 / 150）或订单已取消退款时，丢弃一切迟到的平台状态。
  // 少了这道守卫：取消订单后 mockAdvance 仍在每 4s 推进，推来的 70 会把已取消订单
  // 改回「已送达(3)」并结算销量，goods_settled=1 令库存回补永久锁死，用户随后能在取餐页
  // 真的开舱取走这单已退款的餐。反向同理：已退款(7) 收到 110 会被降级成已取消并二次回补库存。
  // 注意判据必须是显式标记列 —— 状态码 110(取消) < 120(挂起)，比大小判不出终态。
  const taskVoided = !!task.void_at || TASK_TERMINAL.includes(Number(task.task_status))
  // 终态守卫只认取消/退款（5/7）与 cancelled_at 显式标记；已完成(4) 等迁移合法性由 order 域收口守卫兜底
  const orderVoided = !!order && (!!order.cancelled_at || [5, 7].includes(Number(order.status)))
  if (taskVoided || orderVoided) {
    // 仅接受平台对「任务被关闭(150)」的确认（即我们请求的 forceCloseTask 已生效），
    // 且只更新任务自身，绝不联动订单 / 库存 / 批次 —— 那些副作用在取消时已执行过一次。
    if (st === 150 && Number(task.task_status) !== 150) {
      updateTask(store, taskId, text || httpApi.STATUS_TEXT[150], 150)
      // 任务已作废，仅记录平台关闭确认(150)，不联动订单（静默，避免轮询刷屏）
    }
    return
  }

  // 平台侧取消/关闭：与本地取消走完全相同的落账路径（幂等由 orderCancel 保证）。
  // task_status 与 void_at 必须一次写完，否则随后的 voidTasks 会因已是 110 而跳过 void_at。
  if (st === 110 || st === 150) {
    store.prepare(`UPDATE delivery_tasks SET task_status=?, status_text=?,
      void_at=COALESCE(void_at, datetime('now','localtime')), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(st, text || httpApi.STATUS_TEXT[st] || ('状态 ' + st), taskId)
    try {
      orderCancel.cancelLocal(store, order, { finalStatus: 5, reason: httpApi.STATUS_TEXT[st] || '任务取消' })
    } catch (e) { console.warn('[platform] 平台取消落账失败', e.message) }
    return
  }

  updateTask(store, taskId, text, st)
  if (!order) return

  let orderStatus = null
  if (st === 70) orderStatus = 3            // 到达取餐点 -> 已送达（待取餐）
  else if (st === 80) {
    // 任务完成(80) ≠ 用户已取走：平台 40s 自动关舱后任务同样流转 80，此时用户可能根本没来取。
    // 只有用户真正「关舱取走」（pickup-close 置了 picked_up_at）才进已完成；否则保持已送达(3)，
    // 由取餐超时扫描（scanPickupTimeouts）决定「先送其他单/稍后返回/驳回」。已取走则订单已是 4，无需再动。
    if (!order.picked_up_at) orderStatus = 3
  }
  else if (st >= 90 && st < 110) orderStatus = 6  // 上货失败(9x) / 取货失败(10x) -> 配送异常
  if (orderStatus !== null) {
    // 状态迁移走注入的 orderStateSink（结构评审 P0-1：守卫+CAS 在 order 域收口实现）
    const moved = emitOrderState(store, { orderId: order.id, to: orderStatus })
    // 已送达(3) 即本单已售结算（幂等）——货已送达取餐点；未取餐的驳回不在此处回补（见 orderCancel/goodsStats）
    if (orderStatus === 3 && moved && moved.ok && !moved.already) {
      try { goodsStats.settleSales(store, order.id) } catch (e) { /* 忽略 */ }
    }
  }
  // 一车多单联动：任务完成时更新批次取餐计数与完成判断
  const fresh = store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(taskId)
  if (fresh) {
    try { batch.onTaskStatus(store, fresh, st) } catch (e) { /* 批次联动异常静默 */ }
  }
}

function updateTask(store, taskId, text, status) {
  if (status === undefined) {
    store.prepare("UPDATE delivery_tasks SET status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(text, taskId)
  } else {
    store.prepare("UPDATE delivery_tasks SET task_status=?, status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, text, taskId)
  }
}

// 轮询兜底：basicList 按配送任务ID批量查询并同步状态
// （真实接口字段已按 Apifox open-logis_1.0 核对：查询参数为 idList，返回 data 数组即任务本体，无 task 包装）
async function syncTaskStatus(store, taskId) {
  if (httpApi.MOCK || !httpApi.platformReady()) return
  const t = store.prepare('SELECT d.*, o.order_no FROM delivery_tasks d LEFT JOIN orders o ON o.id=d.order_id WHERE d.id=?').get(taskId)
  // 只跳过真正的终态：80 完成、110/150 取消关闭、本地已作废（void_at）。
  // 70 到达取货点必须继续轮询：它只是「机器人已到、等待用户取餐」的停等态 ——
  // 若平台的到达回调丢失而任务停在 70，轮询是唯一能把订单推进到「已送达(3)」的兜底；
  // 把它一并跳过会令订单永久卡在配送中(2)，用户连取餐入口都打不开。
  // 同时 90-109（上货/取货失败）也必须轮询以驱动到「配送异常(6)」（P1-4），
  // 原写法 task_status >= 80 一律跳过，把这些非终态全挡在了轮询外。
  if (!t || [80, 110, 150].includes(Number(t.task_status)) || t.void_at) return
  if (!t.platform_task_id) return
  try {
    const q = '/open-api/v1/deliveryTask/basicList?idList=' + encodeURIComponent(t.platform_task_id)
    const r = await httpApi.requestPlatform('GET', q)
    if (r && r.code === 'COMM_200') {
      const data = r.data
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : [])
      const item = list.find((x) => x && String(x.id) === String(t.platform_task_id))
        || list.find((x) => x && x.outOrderNo && t.order_no && String(x.outOrderNo).indexOf(t.order_no) > -1)
      if (item && item.taskStatus !== undefined) {
        const st = item.taskStatus
        applyStatus(store, taskId, st, httpApi.STATUS_TEXT[st] || ('状态 ' + st))
        // 记录设备 SN 供位置接口使用
        if (item.deviceSn && !t.device_sn) {
          store.prepare('UPDATE delivery_tasks SET device_sn=? WHERE id=?').run(item.deviceSn, taskId)
        }
      }
    }
  } catch (e) { /* 轮询失败静默，等下一轮 */ }
}

module.exports = {
  TASK_TERMINAL,
  setOrderStateSink, emitOrderState,
  updateTask, applyStatus, syncTaskStatus
}
