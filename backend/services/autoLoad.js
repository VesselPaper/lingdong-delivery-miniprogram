// services/autoLoad.js —— 「有单自动去上货点」调度器（事件驱动，非轮询；仅召唤模式下生效）
// 触发：用户下单支付成功 → order 域 maybeAutoAccept 并入批次后，调 registerOnOrder 注入的钩子 schedule()。
// dispatch(evaluate)：选目标车 → 按车当前状态决策，只对「真正空闲」的车发召唤去上货点：
//   ① 车正在配送/被召唤(lightTask/delivery/interaction) → 不打断，跳过；
//       「送完自动回上货点」由 delivery/service.advanceSummonDelivery 完成路径已保证，无需这里做。
//   ② 车已在上货点途中/到达(light_task_id 到 30)       → 幂等跳过，不发重复召唤。
//   ③ 车空闲/待机/充电/返程(return*)                  → summonToLoadingPoint(该车)，记录 light_task_id。
//   ④ 车离线/异常                                     → 跳过 + 日志（绝不对故障车硬发召唤）。
// 防抖：AUTO_LOAD_DEBOUNCE_MS 内多单只评估一次，避免召唤刷屏。

const AUTO_LOAD_DEBOUNCE_MS = Number(process.env.AUTO_LOAD_DEBOUNCE_MS || 5 * 1000)
// 可被主动召唤去上货点的状态：真正空闲（不含 lightTask/delivery/interaction —— 那些属于在忙/被召唤，跳过）
const SUMMONABLE = ['idle', 'standby', 'charging', 'returnChargingPile', 'returnStandby']
// 已在路上/已到的召唤状态：仍活动，不需重复召唤
const ACTIVE_LIGHT = [0, 10, 20]

let debounceTimer = null

// 事件入口：新单并入批次后调用；防抖合并，随后 evaluate
function schedule(store, deps) {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { evaluate(store, deps).catch((e) => console.warn('[autoLoad] 调度异常', e.message)) }, AUTO_LOAD_DEBOUNCE_MS)
}

async function evaluate(store, deps) {
  if (!deps.runtime || !deps.runtime.summonDelivery) return
  // 找最新一个「可上货」批次（组单中/待上货，且有待配送订单）
  const b = store.prepare(`
    SELECT id,total_orders,total_items,device_sn,light_task_id,status
    FROM delivery_batches WHERE status IN (0,1)
    AND total_orders > 0 ORDER BY id DESC LIMIT 1`).get()
  if (!b) return

  const list = await deps.platform.getDeviceList()
  if (!list.ok || !list.robots || !list.robots.length) return

  // 选择目标车：
  //   已指派批次的车 → 只在它「在线且空闲」时才召唤（忙/在送则跳过，等它送完由完成路径带回上货点）
  //   未指派批次    → 挑一台在线的空闲车
  let robot = null
  if (b.device_sn) {
    const mr = list.robots.find((x) => x.online && x.device_sn === b.device_sn)
    if (mr && SUMMONABLE.includes(mr.machine_status)) robot = mr
  } else {
    robot = list.robots.find((x) => x.online && SUMMONABLE.includes(x.machine_status))
  }
  if (!robot) {
    console.log('[autoLoad] 目标车在配送/离线，跳过召唤（送完由完成路径自动回上货点）')
    return // 分支①/④：送完由完成路径自动回上货点；离线则由后续订单/商家开舱兜底
  }

  // 分支②：已有活动召唤在去上货点（含已被本调度或开舱召过的情况）
  if (b.light_task_id) {
    const qr = await deps.platform.queryLightTask(b.light_task_id)
    if (qr.ok && ACTIVE_LIGHT.includes(qr.status)) {
      console.log('[autoLoad] 车 ' + robot.device_sn + ' 已在去上货点途中(status=' + qr.status + ')，跳过重复召唤')
      return
    }
  }

  // 分支③：召唤该车去上货点
  const r = await deps.platform.summonToLoadingPoint(store, robot.device_sn)
  if (!r.ok) { console.warn('[autoLoad] 召唤 ' + robot.device_sn + ' 去上货点失败: ' + r.msg); return }
  // 记录 light_task_id（供开舱到达门禁查询）；批次未指派车时把该车记为本次上货目标
  if (r.light_task_id) {
    store.prepare("UPDATE delivery_batches SET light_task_id=?, updated_at=datetime('now','localtime') WHERE id=?").run(r.light_task_id, b.id)
  }
  if (!b.device_sn) {
    store.prepare("UPDATE delivery_batches SET device_sn=?, updated_at=datetime('now','localtime') WHERE id=?").run(robot.device_sn, b.id)
  }
  console.log('[autoLoad] 车 ' + robot.device_sn + ' 召唤去上货点 (lightTaskId=' + (r.light_task_id || '') + ')')
}

module.exports = { schedule, evaluate }