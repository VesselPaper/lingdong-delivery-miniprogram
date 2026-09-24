// services/statusEvents.js —— 业务状态流水（status_events）
// ------------------------------------------------------------------
// 目标：管理页「详情抽屉 → 状态时间线」能还原「每个状态变更的具体时间（含操作者）」。
//
// 两个写入来源：
//   ① diffOnce(store)  —— 集中采集器（常驻，由 server.js 每 2.5s 调用一次）
//        在内存里维护「活跃实体 → 状态」快照，比对发现变化就落一条；实体离开活跃集
//        （进入终态）时补记最后一次迁移。保证不漏，且对业务代码零侵入。
//   ② hintActor(target, actor, note) —— 操作者关联
//        现有 37 处 audit(req, action, target, detail) 已经知道「谁对哪个对象做了什么」，
//        这里把它登记成一条短时效线索；采集器捕获到该实体的迁移时就用这个操作者署名，
//        线索随即消费掉。于是无需在 28 处 SQL 写点埋点，也能得到 actor 归属。
//
// 为什么不逐个 SQL 写点埋点：状态写入分散在 10 个文件约 28 处（含测试文件），
// 逐个改会触碰派车/配送/取餐核心链路，与「改配送订单代码后必须回归全绿」的铁律冲突。
'use strict'

// 状态码 → 中文，用于 status_events.status_text 快照（写入那一刻的文案）。
// 说明：这是**面向管理页展示的精简字典**，与各域内部字典并非逐字等价：
//   · 订单与 admin 域一致；
//   · 批次 4 写「已取消」（batch.js 内部基准文案是「异常」，而 delivery_batches.status_text
//     实际入库还可能是「批次已取消」/「测试清理已取消」——这里取管理页口径）；
//   · 任务沿用管理页前端的口径（80「完成」、110「已取消」、120「挂起」；admin/service.js 的
//     ADMIN_TASK_STATUS 写的是「任务完成 / 任务取消 / 上货流程挂起」），并多出 1、71；
//     未覆盖的码（如 91~95 / 101~106 / 130~132 / 140）落库时兜底为「状态 n」。
const ORDER_STATUS_TEXT = { 0: '待支付', 1: '待接单', 2: '配送中', 3: '已送达', 4: '已完成', 5: '已取消', 6: '配送异常', 7: '已退款' }
const BATCH_STATUS_TEXT = { 0: '组单中', 1: '待上货', 2: '配送中', 3: '已完成', 4: '已取消' }
const TASK_STATUS_TEXT = {
  0: '排队中', 1: '已取消', 10: '已接收', 20: '去往上货点', 30: '到达上货点', 40: '上货中', 50: '已上货',
  60: '去往取货点', 70: '到达取货点', 71: '等待取餐', 80: '完成', 90: '上货失败', 100: '取货失败',
  110: '已取消', 120: '挂起', 150: '已关闭'
}

// 各实体的「活跃」判定（与 admin 域 history 过滤口径一致）：离开活跃集即视为进入终态
const ACTIVE = {
  order: { table: 'orders', col: 'status', where: 'status NOT IN (4,5,7)' },
  batch: { table: 'delivery_batches', col: 'status', where: 'status NOT IN (3,4)' },
  task: { table: 'delivery_tasks', col: 'task_status', where: 'task_status NOT IN (80,110,150)' }
}

function textOf(type, status) {
  const s = Number(status)
  if (type === 'order') return ORDER_STATUS_TEXT[s] || ('状态 ' + s)
  if (type === 'batch') return BATCH_STATUS_TEXT[s] || ('状态 ' + s)
  return TASK_STATUS_TEXT[s] || ('状态 ' + s)
}

// ---------- ① 落一条事件 ----------
function record(store, ev) {
  try {
    const type = String((ev && (ev.entity_type || ev.type)) || '')
    if (!type || ev.entity_id === undefined || ev.entity_id === null || ev.to_status === undefined) return false
    store.prepare(`INSERT INTO status_events
      (entity_type, entity_id, from_status, to_status, status_text, actor_type, actor_id, actor_name, note)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      type,
      Number(ev.entity_id),
      (ev.from_status === undefined || ev.from_status === null) ? null : Number(ev.from_status),
      Number(ev.to_status),
      String(ev.status_text || textOf(type, ev.to_status)).slice(0, 40),
      String(ev.actor_type || 'system').slice(0, 20),
      Number(ev.actor_id || 0),
      String(ev.actor_name || '').slice(0, 60),
      String(ev.note || '').slice(0, 300)
    )
    return true
  } catch (e) { return false }
}

// ---------- ② 操作者线索（由 _shared.js 的 audit() 登记） ----------
const HINT_TTL_MS = Number(process.env.STATUS_HINT_TTL_MS || 20000)
const hints = new Map()   // 'order#12' -> { actor_type, actor_id, actor_name, note, at }

function hintActor(target, actor, note) {
  const t = String(target || '')
  if (t.indexOf('#') < 0) return
  hints.set(t, {
    actor_type: String((actor && actor.type) || 'system'),
    actor_id: Number((actor && actor.id) || 0),
    actor_name: String((actor && actor.name) || '').slice(0, 60),
    note: String(note || '').slice(0, 300),
    at: Date.now()
  })
  // 防泄漏：线索表不该无界增长
  if (hints.size > 500) {
    const now = Date.now()
    for (const [k, v] of hints) if (now - v.at > HINT_TTL_MS) hints.delete(k)
    if (hints.size > 500) hints.delete(hints.keys().next().value)
  }
}

// 取用线索（命中即消费，避免误归因到后续迁移）
function takeHint(type, id) {
  const key = type + '#' + id
  const h = hints.get(key)
  if (!h) return null
  hints.delete(key)
  if (Date.now() - h.at > HINT_TTL_MS) return null
  return h
}

// 记录一次迁移：优先用操作者线索署名，否则记为 system
function recordTransition(store, type, id, fromStatus, toStatus, fallbackNote) {
  const h = takeHint(type, id)
  return record(store, {
    entity_type: type,
    entity_id: id,
    from_status: fromStatus,
    to_status: toStatus,
    actor_type: h ? h.actor_type : 'system',
    actor_id: h ? h.actor_id : 0,
    actor_name: h ? h.actor_name : '',
    note: h && h.note ? h.note : (fallbackNote || '')
  })
}

// ---------- ③ 集中采集器 ----------
const snap = { order: new Map(), batch: new Map(), task: new Map() }
let primed = false

function diffOnce(store) {
  try {
    for (const type of ['order', 'batch', 'task']) {
      const cfg = ACTIVE[type]
      const m = snap[type]
      const rows = store.prepare(`SELECT id, ${cfg.col} AS st FROM ${cfg.table} WHERE ${cfg.where}`).all()
      const seen = new Set()
      for (const r of rows) {
        const id = r.id
        const cur = Number(r.st)
        seen.add(id)
        const prev = m.get(id)
        if (prev === undefined) {
          // 首次见到（新建实体，或采集器启动后新出现）：记一条起点，无 from_status
          if (primed) recordTransition(store, type, id, null, cur, '采集器捕获（新进入活跃集）')
        } else if (prev !== cur) {
          recordTransition(store, type, id, prev, cur, '采集器捕获')
        }
        m.set(id, cur)
      }
      // 离开活跃集 = 进入终态：补记最后一次迁移后移出快照（避免快照无限增长）
      const gone = []
      for (const id of m.keys()) if (!seen.has(id)) gone.push(id)
      if (gone.length) {
        const ph = gone.map(() => '?').join(',')
        const still = store.prepare(`SELECT id, ${cfg.col} AS st FROM ${cfg.table} WHERE id IN (${ph})`).all(...gone)
        const stillIds = new Set()
        for (const r of still) {
          stillIds.add(r.id)
          const prev = m.get(r.id)
          const cur = Number(r.st)
          if (prev !== cur) recordTransition(store, type, r.id, prev, cur, '采集器捕获（终态）')
          m.delete(r.id)
        }
        for (const id of gone) if (!stillIds.has(id)) m.delete(id)   // 行已被删除
      }
    }
    primed = true
  } catch (e) { /* 采集失败不阻断业务 */ }
}

// 供测试/排障：重置快照与线索
function _reset() { snap.order.clear(); snap.batch.clear(); snap.task.clear(); primed = false; hints.clear() }

module.exports = {
  record, diffOnce, hintActor, recordTransition, textOf, _reset,
  ORDER_STATUS_TEXT, BATCH_STATUS_TEXT, TASK_STATUS_TEXT
}
