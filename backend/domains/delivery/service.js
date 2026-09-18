// delivery 域核心业务：配送追踪/取餐、批次派车/上货/配送、平台回调、扫码上货、取餐超时两段式、超时未接单检测
// 依赖注入：函数显式接收 (store, deps)。deps = { runtime, platform, batch, goods, order, orderCancel }
//   - deps.batch     = services/batch（批次分组/路线/状态机，delivery 域库，步骤3 暂不并入本文件）
//   - deps.goods     = goods 域 service（settleSales 结算销量）
//   - deps.order     = order 域 service（applyOrderCancelled/realRefundOrLocal/PICKUP_*/DELIVERY_* 常量）
//   - deps.orderCancel = services/orderCancel（取消落库唯一实现）
// 跨域读写 orders / refunds 均带注释（05 方案明确允许 delivery→orders 例外；refund 落账跟随 order 域既有实现）。

const q = require('./queries')

// Route B（syncLoading=0）开舱获取的设备控制权，按批次暂存内存；「开始配送」时释放。
// 重启后按平台控制权超时自动失效，无 ctrlId 时开始配送直接放行（batch.ctrl_id 列持久化兜底）。
const batchCtrl = new Map() // batchId -> { ctrlId, deviceSn }

// 测试阶段模拟配送时间（到点后自动把批次订单标为已送达，见 timers.js 自动派车扫描）
const MOCK_ARRIVE_MS = Number(process.env.MOCK_ARRIVE_MS || 10 * 1000)

// ---------- 召唤多单配送编排 ----------
// 某一停靠点的所有订单都被取走（status 4 / picked_up_at）后，停这么久再召唤机器人去下一栋（交接文档9 §3.7）
const SUMMON_STOP_ADVANCE_MS = Number(process.env.SUMMON_STOP_ADVANCE_MS || 5 * 1000)
// 推进防重：一批次同一时刻只允许「召唤下站/召回」执行一次（双击/并发取餐触发多次 notify 时不重复召唤）
const summonAdvancing = new Set()

function parseBatchRoute(b) {
  try { return JSON.parse(b.route || '[]') } catch (e) { return [] }
}

// 到达某站：把该站订单 2→3 置「待取货」，并落库 current_stop
function markSummonStopArrived(store, deps, b, route, stopIndex) {
  const stop = route[Number(stopIndex) - 1]
  if (!stop) return
  const ids = (stop.order_ids || []).map(Number).filter(Boolean)
  for (const oid of ids) {
    const o = store.prepare('SELECT * FROM orders WHERE id=?').get(oid)
    if (o) { try { deps.order.arriveOrder(store, deps, o) } catch (e) { /* 单条失败不阻断 */ } }
  }
  q.setBatchCurrentStop(store, b.id, Number(stopIndex))
}

// 「立即配送」：巫师批次开始召唤多单配送，召唤到首站并置该站订单待取货。
async function startSummonDelivery(store, deps, batchId) {
  const b = q.batchById(store, batchId)
  if (!b) throw new Error('批次不存在')
  if (b.delivery_mode === 'summon' && Number(b.status) === 2) {
    return deps.batch.getBatchDetail(store, b.id) // 已开始，幂等返回
  }
  const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (1,2)').all(b.id)
  if (!orders.length) throw new Error('批次内没有待配送订单')
  let route = parseBatchRoute(b)
  if (!route.length) {
    route = deps.batch.planRoute(store, orders)
    if (!route.length) throw new Error('无可规划的配送点位')
    q.setBatchRoute(store, b.id, JSON.stringify(route))
  }
  // 批次置配送中
  store.prepare("UPDATE delivery_batches SET status=2, status_text='配送中', delivery_mode='summon', updated_at=datetime('now','localtime') WHERE id=?").run(b.id)
  const first = route[0]
  if (b.device_sn) {
    const r = await deps.platform.summonDeliveryToStop(store, b, first)
    if (!r.ok) throw new Error('召唤到首个配送点失败：' + r.msg)
  }
  markSummonStopArrived(store, deps, b, route, 1)
  console.log('[summon] 批次 ' + b.batch_no + ' 开始召唤配送，首站=' + (first.landmark_name || first.landmark_id) + ' 订单=' + (first.order_ids || []).length)
  return deps.batch.getBatchDetail(store, b.id)
}

// 推进：当前站是否全取完 → 停 SUMMON_STOP_ADVANCE_MS → 召唤下一站（或全部送完召回上货点完成批次）。
// 由「批次取走计数钩子（countPicked → batch.registerSummonAdvance）」在每一次取饭后触发。
async function advanceSummonDelivery(store, deps, batchId) {
  const b = q.batchById(store, batchId)
  if (!b || b.delivery_mode !== 'summon') return
  const st = Number(b.status)
  // 只允许在「配送中(2)」推进下一站；「已完成(3)」可能是最后一单刚由 maybeCompleteBatch 标记，
  // 仍应进入完成收尾路径（召回上货点 + current_stop 归零）。
  if (st !== 2 && st !== 3) return
  const route = parseBatchRoute(b)
  if (!route.length) return
  const cur = Math.max(1, Number(b.current_stop || 0)) // 当前正在送第 cur 站
  const stop = route[cur - 1]
  if (stop) {
    const ids = (stop.order_ids || []).map(Number).filter(Boolean)
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      const remaining = store.prepare(`SELECT COUNT(*) c FROM orders WHERE id IN (${ph}) AND status IN (2,3)`).get(...ids)
      if (Number(remaining && remaining.c || 0) > 0) return // 本站未取完，继续等
    }
  }
  // 本站已全取完 → 防重后延迟推进
  if (summonAdvancing.has(batchId)) return
  summonAdvancing.add(batchId)
  setTimeout(async () => {
    try {
      const bb = q.batchById(store, batchId)
      if (!bb || bb.delivery_mode !== 'summon') return
      const r2 = parseBatchRoute(bb)
      if (!r2.length) return
      const curIdx = Math.max(1, Number(bb.current_stop || 0))
      if (Number(curIdx) !== cur) return // 已被其它路径推进过，放弃本次
      if (curIdx < r2.length && Number(bb.status) === 2) {
        const next = r2[curIdx]
        if (bb.device_sn) {
          const rr = await deps.platform.summonDeliveryToStop(store, bb, next)
          if (!rr.ok) { console.warn('[summon] 推进下站失败 batch=' + batchId + ' msg=' + rr.msg); return }
        }
        markSummonStopArrived(store, deps, bb, r2, curIdx + 1)
        console.log('[summon] 批次 ' + bb.batch_no + ' 推进到下一站=' + (next.landmark_name || next.landmark_id))
      } else if (curIdx >= r2.length) {
        // 全部站取完 → 召回上货点 + 批次完成收尾
        if (bb.device_sn) { try { await deps.platform.summonToLoadingPoint(store, bb.device_sn) } catch (e) { /* 召回失败不阻断完成 */ } }
        q.setBatchCompleted(store, batchId, bb.picked_orders || 0)
        q.setBatchCurrentStop(store, batchId, 0)
        console.log('[summon] 批次 ' + bb.batch_no + ' 全部取完，召唤召回上货点 → 已完成')
      }
    } catch (e) {
      console.warn('[summon] 推进异常 batch=' + batchId + ' msg=' + e.message)
    } finally {
      summonAdvancing.delete(batchId)
    }
  }, SUMMON_STOP_ADVANCE_MS)
}

// ---------- 配送追踪上下文（pickup-scan / pickup-by-code 共用） ----------
// 一车多单诚实化（P1-1 缓解）：返回同批订单，供取餐页提示「本车共 N 单，按订单号核对后取走自己的餐」
// 跨域只读：orders（delivery→orders 例外）
function pickupContext(store, order) {
  const task = order.delivery_task_id ? q.taskById(store, order.delivery_task_id) : null
  let batchOrders = []
  let batchOrderCount = 0
  if (order.batch_id) {
    batchOrders = store.prepare('SELECT id, order_no, daily_seq, landmark_name FROM orders WHERE batch_id=? AND status IN (2,3) ORDER BY id ASC').all(order.batch_id)
    batchOrderCount = batchOrders.length
  }
  return {
    order_id: order.id,
    order_no: order.order_no,
    pickup_code: order.pickup_code,
    landmark_name: order.landmark_name,
    batch_order_count: batchOrderCount,
    batch_orders: batchOrders,
    task: task ? { task_id: task.id, platform_task_id: task.platform_task_id, device_sn: task.device_sn, task_status: task.task_status, status_text: task.status_text } : null
  }
}

// ---------- 批次派车（一车多单） ----------
// P1-7 并发抢占：先读后写存在竞争 —— 两个并发派车（自动派车扫描 + 商家手点）都会读到 status=0
// 并各自创建一套平台任务 → 同一批货被下发两次、真机被调度两次。现在任何 await 之前先用
// 条件更新抢占（status 0→1），只有抢到的一方才继续；失败方直接报「已派车」，绝不重复创建。
// 抢占后任一步失败则回滚：已建任务作废(void_at) + 批次回到组单中，不留半派车状态。
async function doDispatchBatch(store, deps, batchId, deviceSn) {
  const b = q.batchById(store, batchId)
  if (!b) throw new Error('批次不存在')
  // 需求3门禁（真实档）：先确认有可用且空闲的无人车，再占批次 —— 避免占位后再回滚。
  // 演示档（PLATFORM_MOCK=true）跳过：本地模拟不涉及真车。
  let sn = deviceSn || b.device_sn || ''
  if (deps.runtime.realPlatform) {
    if (!sn) {
      const r = await deps.platform.pickAvailableRobot()
      if (r && r.device_sn) sn = r.device_sn
    }
    if (!sn) {
      // 无可用车：给商家明确提示（设备状态 + 引导），而不是笼统报错
      let reason = '机器人未上线或处于忙碌状态'
      try {
        const dev = await deps.platform.getDeviceList()
        if (dev.ok && dev.robots && dev.robots.length) {
          const states = dev.robots.map((x) => `${x.name || x.device_sn}（${x.online ? '在线·' + (x.machine_text || '未知') : '离线'}）`).join('、')
          reason = '当前设备：' + states + '。请先开机上线后再派车上货'
        } else if (dev.ok && (!dev.robots || !dev.robots.length)) {
          reason = '平台暂无已注册机器人，请联系越凡确认设备配置'
        } else if (dev.msg) {
          reason = '查询设备状态失败：' + dev.msg
        }
      } catch (e) { /* 设备状态查询失败则用默认文案 */ }
      throw new Error('暂无可用无人车：' + reason)
    }
    const busy = await deps.platform.isRobotBusy(store, sn)
    if (busy.busy) throw new Error(busy.msg)
  }
  const claim = q.claimDispatch(store, batchId)
  if (claim.changes !== 1) throw new Error('该批次已派车，不能重复派车')
  try {
    // 跨域只读：批次内待配送订单（delivery→orders 例外）
    const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (1,2)').all(batchId)
    if (!orders.length) {
      q.revertDispatchNoRoute(store, batchId)
      throw new Error('批次内没有待配送订单')
    }
    // 路线规划推迟到「开始配送（关舱后）」执行（用户确认的设计：停靠顺序在货上完、关舱后才确定）。
    // 因此此处只创建平台任务，不传 route（createTasksForBatch 用固定 priority，仅作提示不影响目的地）；
    // 路线在 /merchant/device/batch/dispatch（立即配送/开始配送）时用 batch.planRoute 计算并写入 batch.route。
    q.setBatchDeviceSn(store, batchId, sn)
    // 同步内存中的批次对象，供 createTasksForBatch 取 device_sn（它创建平台任务必须指定设备）
    b.device_sn = sn
    if (!deps.runtime.summonDelivery) {
      // 一单一单送：创建 per-order 平台配送任务（route 在「开始配送」时规划）。
      await deps.platform.createTasksForBatch(store, b, orders, [])
    }
    // 召唤多单配送：不创建任何越凡配送任务，仅定型设备；路线与逐点召唤在「立即配送」时进行。
    // 兜底置为配送中（已由并入批次时置 2）
    store.prepare("UPDATE orders SET status=2, updated_at=datetime('now','localtime') WHERE batch_id=? AND status=1").run(batchId)
    console.log('[batch] 批次定型 ' + b.batch_no + ' 共' + orders.length + '单（路线待开始配送时规划）')
    return deps.batch.getBatchDetail(store, batchId)
  } catch (e) {
    // 回滚：作废本轮已创建的任务 + 批次退回组单中（device_sn/route 一并清掉，避免下次派车沿用旧路线）
    try {
      q.voidTasksByBatch(store, batchId, '派车失败，任务作废')
      q.revertDispatch(store, batchId)
    } catch (e2) { /* 回滚失败静默，下次派车时批次状态会再次校验 */ }
    throw e
  }
}

// ---------- 平台回调 ----------
// 回调防伪：令牌在创建排队任务时以 ?token= 拼进 feedbackDeliveryTaskUrl / checkBizOrderStatusUrl。
// 这些回调地址经 cloudflared 公网可达，此前任何人都能 POST 一条伪造的 taskStatus，
// 把任意订单驱动成「已送达」并结算销量，甚至驱动退款流程。
// 无法派生令牌时（PLATFORM_SECRET 为空且未显式配置 PLATFORM_CALLBACK_TOKEN）选择放行：
// 那种情况下本来就没有真实平台对接，一律拦住只会让本地演示全线失败；启动日志已就此告警。
function callbackAuthorized(req, deps) {
  const expected = deps.runtime.callbackToken
  if (!expected) return true
  const given = String(req.query.token || req.params.token || (req.body && req.body.token) || '')
  if (!given) return false
  // 定长摘要比较，避免通过响应时间逐位猜解
  const crypto = require('crypto')
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function cbDenied(res) {
  console.warn('[platform] 回调防伪校验失败，已拒绝')
  res.status(403).json({ code: 'FAIL', msg: 'invalid token' })
}

function platformStatusText(code) {
  const map = {
    0: '排队中', 10: '任务已接收', 20: '去往上货点', 30: '到达上货点',
    40: '上货中', 50: '已上货', 60: '去往取货点', 70: '到达取货点', 80: '任务完成',
    90: '上货失败', 100: '取货失败', 110: '任务取消', 120: '上货流程挂起', 130: '下货流程挂起', 140: '待完善', 150: '任务被关闭'
  }
  return map[Number(code)] || ('状态 ' + code)
}

// feedbackDeliveryTaskUrl：平台在任务状态变更时 POST 到这里，同步任务与订单状态
function handleDeliveryCallback(store, deps, req, res) {
  if (!callbackAuthorized(req, deps)) return cbDenied(res)
  const body = req.body || {}
  // 兼容多种报文形态：直接字段 / task 包装 / data 包装（DeliveryTaskBasicVo 结构）
  const src = (body.data && typeof body.data === 'object') ? body.data : body
  const taskId = src.taskId || src.id || (src.task && src.task.id)
  const status = src.taskStatus !== undefined ? src.taskStatus
    : (src.task && src.task.taskStatus)
  if (!taskId || status === undefined) {
    return res.json({ code: 'FAIL', msg: '缺少任务ID或状态' })
  }
  const row = q.taskByPlatformId(store, taskId)
  if (!row) {
    return res.json({ code: 'FAIL', msg: '任务不存在' })
  }
  deps.platform.applyStatus(store, row.id, Number(status), src.taskStatusText || platformStatusText(status))
  // 同步设备编号
  const sn = src.deviceSn || (src.task && src.task.deviceSn)
  if (sn && !row.device_sn) {
    q.setTaskDeviceSn(store, row.id, sn)
  }
  res.json({ code: 'SUCCESS', msg: 'ok' })
}

// checkBizOrderStatusUrl：设备端在关键节点检查业务订单状态（是否已退款/人工送达等）
// 返回值格式以 Apifox open-logis_1.0 文档为准：HttpMethod 必须为 POST、公开访问，
// 需要强制关闭任务时返回 keyEvent（taskSubStatus 201 已退款 / 202 人工送达）。
function handleCheckOrder(store, deps, req, res) {
  if (!callbackAuthorized(req, deps)) return cbDenied(res)
  const orderNo = req.query.orderNo || req.query.outOrderNo || (req.body && (req.body.orderNo || req.body.outOrderNo))
  if (!orderNo) return res.json({ code: 'FAIL', msg: '缺少订单号' })
  // 跨域只读：orders（delivery→orders 例外）
  const order = store.prepare('SELECT * FROM orders WHERE order_no=?').get(String(orderNo))
  if (!order) return res.json({ code: 'FAIL', msg: '订单不存在' })
  const st = Number(order.status)
  // 5已取消 与 7已退款 都必须让设备强制关任务。原先只判 5，已退款订单平台侧永远收不到
  // forceCloseTask，机器人照送不误 —— 钱退了、餐也送到了。
  // taskSubStatus 按对接文档只有 201已退款 / 202人工送达 两种，故用 eventDesc 区分具体原因。
  if (st === 5 || st === 7 || order.cancelled_at) {
    return res.json({
      code: 'COMM_200',
      data: {
        keyEvent: {
          eventName: 'forceCloseTask',
          taskSubStatus: 201,
          eventDesc: st === 7 ? '订单已退款' : '订单已取消'
        }
      },
      msg: 'ok'
    })
  }
  // 订单正常：无强制关闭事件
  res.json({ code: 'COMM_200', data: null, msg: 'ok' })
}

// 设备异常上报回调（T 任务类 / R 机器类 / I IOT 类 / N 导航类）
function handleExceptionCallback(deps, req, res) {
  if (!callbackAuthorized(req, deps)) return cbDenied(res)
  const body = req.body || {}
  console.warn('[platform] 设备异常上报', JSON.stringify(body))
  res.json({ code: 'SUCCESS', msg: 'ok' })
}

// ---------- 扫码上货 ----------
// 按 task_id 定位待上货任务（带取餐码，供开舱验证/确认上货）
function getLoadingTask(store, body) {
  const id = Number((body || {}).task_id)
  if (!id) return null
  // 跨域只读：orders.pickup_code（delivery→orders 例外）
  return store.prepare('SELECT d.*, o.pickup_code FROM delivery_tasks d JOIN orders o ON o.id=d.order_id WHERE d.id=?').get(id)
}

// 测试/异常后批次状态重算：全部有效订单已取走 → 已完成；
// 批次内已有已送达(3)/已完成(4)订单（配送已真正开始）→ 推进为配送中(2)；
// 否则保持待上货（批次尚未派发，订单仍为待上货状态）。
function reconcileBatchState(store, batchId) {
  const b = q.batchById(store, batchId)
  if (!b) return
  // 跨域只读：orders（delivery→orders 例外）
  const stats = store.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN o.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN o.status IN (3,4) THEN 1 ELSE 0 END) AS delivered
    FROM orders o WHERE o.batch_id=? AND o.status IN (2,3,4)`).get(batchId)
  const total = Number(stats && stats.total || 0)
  const done = Number(stats && stats.done || 0)
  const delivered = Number(stats && stats.delivered || 0)
  if (total > 0 && done >= total) {
    q.setBatchCompleted(store, batchId, done)
  } else if (delivered > 0 && Number(b.status) === 1) {
    q.batchAdvanceIfDelivered(store, batchId)
  }
}

// ---------- 取餐超时（已送达无人取餐）两段式处理 ----------
// 订单「已送达(3)」后一直没人取（picked_up_at 为空且未在「正在取餐」picking_up_at 置位期间，计时暂停）：
//   一段 PICKUP_TIMEOUT_MS（默认 15 分钟）→ stage=1：若批次还有别的单，重排路线（本单停靠点移到最后，
//     机器人先送其他单）并提示用户；无其他单则继续等待。
//   其他单送完/取完后 → 重建任务让机器人「回来再等」（recreatePickupTask，真实平台行为待与越凡确认），
//     记 pickup_revisit_at，stage=2。
//   二段：pickup_revisit_at + PICKUP_RETRY_TIMEOUT_MS（默认 15 分钟）仍没取 → 驳回（取消并退款）。
// 打开舱门=「正在取餐」，计时暂停；超过 PICKUP_PICKING_GUARD_MS（默认 5 分钟）未关舱视为打开后没取，计时恢复。

// 把某订单的停靠点移到批次路线末尾（「先送其他单」的展示/地图顺序；机器人实际顺序由平台按任务调度）
function moveStopToEnd(store, batchId, orderId) {
  const b = q.batchById(store, batchId)
  if (!b) return
  let route = []
  try { route = JSON.parse(b.route || '[]') } catch (e) { route = [] }
  if (!route.length) return
  const idx = route.findIndex((s) => (s.order_ids || []).map(String).includes(String(orderId)))
  if (idx < 0) return
  const [stop] = route.splice(idx, 1)
  route.push(stop)
  route.forEach((s, i) => { s.stop = i + 1 })
  q.setBatchRoute(store, batchId, JSON.stringify(route))
}

// 返程再等：一段超时单在其批次其他单都送完/取完后，重建任务让机器人再回来等（stage=2 起算二段窗口）
async function revisitUnpickedOrder(store, deps, orderId) {
  // 跨域只读+写：orders（delivery→orders 例外）
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(orderId))
  if (!order || Number(order.status) !== 3 || order.picked_up_at) return
  const claim = store.prepare(`UPDATE orders SET pickup_timeout_stage=2, pickup_revisit_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
    WHERE id=? AND status=3 AND picked_up_at IS NULL AND pickup_timeout_stage=1`).run(order.id)
  if (claim.changes !== 1) return
  // 作废旧任务（若还有非终态挂着的），再召唤/重建同卸载点位让机器人回来等
  q.voidTaskByOrderRevisit(store, order.id)
  try {
    const b = q.batchById(store, order.batch_id)
    if (b) {
      if (b.delivery_mode === 'summon' && deps.platform.summonToPoint && b.device_sn) {
        // 召唤模式无配送任务，重建会走 queue/create 与"无任务召唤"模型冲突：
        // 直接召唤到该单取餐点位等（不走越凡配送任务重建）
        const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(Number(order.landmark_id))
        if (lm && lm.platform_landmark_id) await deps.platform.summonToPoint(store, b.device_sn, lm.platform_landmark_id)
      } else {
        await deps.platform.recreatePickupTask(store, b, order)
      }
    }
  } catch (e) { console.warn('[pickup] 返程重建/召唤失败 order=' + order.id, e.message) }
  console.log('[pickup] 取餐超时返程再等 order=' + order.id + '（stage=2，二段等待中）')
}

// 驳回取餐超时单（二段仍没取）：取消并退款（真实微信退款或本地标记），作废任务/摘除批次/回补库存走 orderCancel
async function rejectUnpickedOrder(store, deps, orderId) {
  // 跨域只读：orders（delivery→orders 例外）
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(Number(orderId))
  if (!order || Number(order.status) !== 3 || order.picked_up_at) return
  const ref = await deps.order.realRefundOrLocal(store, { orderCancel: deps.orderCancel, platform: deps.platform }, order, null, Number(order.total_amount))
  if (!ref.ok) { console.warn('[pickup] 驳回退款失败 order=' + order.id + ' ' + ref.msg); return }
  const c = await deps.order.applyOrderCancelled(store, { orderCancel: deps.orderCancel, platform: deps.platform }, order, { finalStatus: 7, reason: '取餐超时，订单驳回退款' })
  if (!c.claimed) return
  // 跨域写 refunds：跟随 order 域既有实现（取消落账统一走 orderCancel；此处补一条自动退款售后记录）
  store.prepare("INSERT INTO refunds (order_id, user_id, type, reason, amount, status, merchant_reply, handled_at, wx_refund_no) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'),?)")
    .run(order.id, order.user_id, 'refund', '取餐超时，订单驳回退款', order.total_amount, 3, '取餐超时自动退款', ref.refundNo || '')
  store.prepare("UPDATE orders SET pickup_timeout_stage=3, updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
  console.log('[pickup] 取餐超时驳回退款 order=' + order.id + ' amount=' + order.total_amount + ' user=' + order.user_id)
}

async function scanPickupTimeouts(store, deps) {
  const { PICKUP_PICKING_GUARD_MS, PICKUP_TIMEOUT_MS, PICKUP_RETRY_TIMEOUT_MS } = deps.order
  try {
    const now = new Date()
    const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
    // 1) 取餐守卫：正在取餐超过守卫窗口仍未关舱 → 视为「打开后没取」，清位回待取货（计时恢复，防永久暂停卡死）
    const guardCut = fmt(new Date(now.getTime() - PICKUP_PICKING_GUARD_MS))
    store.prepare(`UPDATE orders SET picking_up_at=NULL, updated_at=datetime('now','localtime')
      WHERE status=3 AND picked_up_at IS NULL AND picking_up_at IS NOT NULL AND picking_up_at < ?`).run(guardCut)
    // 2) 一段超时：已送达超窗口、未取、未在取餐中、未处理过 → stage=1（重排路线 + 提示）
    const cs1 = fmt(new Date(now.getTime() - PICKUP_TIMEOUT_MS))
    const stage1 = store.prepare(`SELECT o.id, o.batch_id FROM orders o
      WHERE o.status=3 AND o.picked_up_at IS NULL AND o.picking_up_at IS NULL AND o.pickup_timeout_stage=0
        AND o.delivered_at IS NOT NULL AND o.delivered_at < ?`).all(cs1)
    for (const r of stage1) {
      const claim = store.prepare(`UPDATE orders SET pickup_timeout_stage=1, updated_at=datetime('now','localtime')
        WHERE id=? AND status=3 AND picked_up_at IS NULL AND picking_up_at IS NULL AND pickup_timeout_stage=0`).run(r.id)
      if (claim.changes !== 1) continue
      const otherCnt = r.batch_id ? store.prepare(`
        SELECT COUNT(*) c FROM orders WHERE batch_id=? AND id<>? AND status IN (2,3) AND picked_up_at IS NULL`).get(r.batch_id, r.id) : null
      const hasOther = Number(otherCnt && otherCnt.c || 0) > 0
      if (hasOther) {
        try { moveStopToEnd(store, r.batch_id, r.id) } catch (e) { /* 重排失败静默 */ }
        console.log('[pickup] 取餐超时(一段) order=' + r.id + ' 批次=' + r.batch_id + '：先送其他单，稍后返回')
      } else {
        console.log('[pickup] 取餐超时(一段) order=' + r.id + ' 批次=' + r.batch_id + '：无其他单，继续等待')
      }
    }
    // 3) 返程再访问：一段超时单所在批次不再有「配送中/未超时待取」的其他单时，重建任务让机器人回来等
    const revisitCand = store.prepare(`SELECT o.id, o.batch_id FROM orders o
      WHERE o.status=3 AND o.picked_up_at IS NULL AND o.picking_up_at IS NULL AND o.pickup_timeout_stage=1
        AND o.pickup_revisit_at IS NULL AND o.delivered_at IS NOT NULL AND o.delivered_at < ?`).all(cs1)
    for (const r of revisitCand) {
      const waitCnt = r.batch_id ? store.prepare(`
        SELECT COUNT(*) c FROM orders
        WHERE batch_id=? AND id<>? AND (status=2 OR (status=3 AND picked_up_at IS NULL AND pickup_timeout_stage=0))`).get(r.batch_id, r.id) : null
      if (Number(waitCnt && waitCnt.c || 0) > 0) continue
      try { await revisitUnpickedOrder(store, deps, r.id) } catch (e) { console.warn('[pickup] 返程再访问失败 order=' + r.id, e.message) }
    }
    // 4) 二段超时：返程后再等满 PICKUP_RETRY_TIMEOUT_MS 仍没取 → 驳回（取消并退款）
    const cs2 = fmt(new Date(now.getTime() - PICKUP_RETRY_TIMEOUT_MS))
    const stage2 = store.prepare(`SELECT o.id FROM orders o
      WHERE o.status=3 AND o.picked_up_at IS NULL AND o.picking_up_at IS NULL AND o.pickup_timeout_stage=2
        AND o.pickup_revisit_at IS NOT NULL AND o.pickup_revisit_at < ?`).all(cs2)
    for (const r of stage2) {
      try { await rejectUnpickedOrder(store, deps, r.id) } catch (e) { console.warn('[pickup] 驳回取餐超时单失败 order=' + r.id, e.message) }
    }
  } catch (e) { /* 扫描异常静默（遵循日志精简约定） */ }
}

// 超时未接单检测：机器人长时间未接单/任务挂起 → 订单标记「配送异常(6)」，由商家处理。
// 阈值默认 15 分钟，可用环境变量 DELIVERY_TIMEOUT_MS 覆盖；扫描间隔 DELIVERY_SCAN_MS（默认 60s）。
function scanStuckDeliveries(store, deps) {
  const { DELIVERY_TIMEOUT_MS } = deps.order
  try {
    const cutoff = new Date(Date.now() - DELIVERY_TIMEOUT_MS)
    const cs = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0') + '-' + String(cutoff.getDate()).padStart(2, '0') +
      ' ' + String(cutoff.getHours()).padStart(2, '0') + ':' + String(cutoff.getMinutes()).padStart(2, '0') + ':' + String(cutoff.getSeconds()).padStart(2, '0')
    const rows = store.prepare(`
      SELECT d.id, d.order_id, d.task_status FROM delivery_tasks d JOIN orders o ON o.id = d.order_id
      WHERE o.status = 2 AND d.task_status NOT IN (70,80,110,150) AND d.void_at IS NULL AND d.updated_at < ?`).all(cs)
    for (const r of rows) {
      store.prepare("UPDATE orders SET status=6, updated_at=datetime('now','localtime') WHERE id=? AND status=2").run(r.order_id)
      store.prepare("UPDATE delivery_tasks SET status_text='机器人长时间未接单或任务挂起（超时' + (?) + '分钟），订单已标记配送异常', updated_at=datetime('now','localtime') WHERE id=?")
        .run(Math.round(DELIVERY_TIMEOUT_MS / 60000), r.id)
      console.warn('[delivery] 配送超时未接单 → 配送异常 order=' + r.order_id + ' task=' + r.id + ' task_status=' + r.task_status)
    }
  } catch (e) { /* 扫描异常静默 */ }
}

// ---------- 模拟配送到达（timers.js 自动派车扫描调用） ----------
// P1-4：模拟到达不再依赖内存 setTimeout（纯内存、重启即丢 → 配送中的订单会永久卡死）。
// mock_arrive_at 已落库，由后台定时任务到点统一处理，重启可自愈。
function processMockArrivals(store, deps) {
  const arrivals = q.arrivedBatches(store)
  for (const b of arrivals) {
    // 跨域只读：批次内配送中订单（delivery→orders 例外）
    const orderIds = store.prepare('SELECT id FROM orders WHERE batch_id=? AND status=2').all(b.id).map((r) => r.id)
    for (const oid of orderIds) {
      q.setTaskStatusByOrder(store, oid, 70, '到达取货点（模拟）')
      store.prepare("UPDATE orders SET status=3, delivered_at=COALESCE(delivered_at, datetime('now','localtime')), updated_at=datetime('now','localtime') WHERE id=?").run(oid)
      try { deps.goods.settleSales(store, oid) } catch (e) { /* 忽略 */ }
    }
    reconcileBatchState(store, b.id)
    q.clearBatchMockArrive(store, b.id)
    console.log('[batch] 模拟配送到达（测试）batch=' + b.batch_no + ' 订单 ' + orderIds.length + ' 单 → 待取货')
  }
}

module.exports = {
  batchCtrl, MOCK_ARRIVE_MS,
  pickupContext, doDispatchBatch,
  callbackAuthorized, cbDenied, platformStatusText,
  handleDeliveryCallback, handleCheckOrder, handleExceptionCallback,
  getLoadingTask, reconcileBatchState,
  moveStopToEnd, revisitUnpickedOrder, rejectUnpickedOrder,
  scanPickupTimeouts, scanStuckDeliveries, processMockArrivals,
  startSummonDelivery, advanceSummonDelivery
}
