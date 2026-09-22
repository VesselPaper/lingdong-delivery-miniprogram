// admin 域 SQL：管理员工具 + 大屏只读聚合（05 方案允许 admin 只读跨表聚合；写操作经 order 域 service 落账）

// 编号格式化：人读短号（订单 MMDD-NN / 批次 B-MMDD-NN）
const seqSvc = require('../../services/seq')

module.exports = {
  // ---------- 状态总览聚合（只读，跨表例外） ----------
  activeBatches: (store) => store.prepare('SELECT id,batch_no,daily_seq,seq_date,status,status_text,device_sn,ctrl_id,total_orders,picked_orders,total_items,delivery_mode,current_stop,route,created_at,dispatched_at FROM delivery_batches WHERE status IN (0,1,2) ORDER BY id DESC LIMIT 50').all(),
  historyBatches: (store) => store.prepare('SELECT id,batch_no,daily_seq,seq_date,status,status_text,device_sn,ctrl_id,total_orders,picked_orders,total_items,delivery_mode,current_stop,route,created_at,dispatched_at FROM delivery_batches WHERE status NOT IN (0,1,2) ORDER BY id DESC LIMIT 100').all(),
  activeOrders: (store) => store.prepare('SELECT id,order_no,daily_seq,seq_date,status,batch_id,delivery_task_id,landmark_name,total_amount,created_at FROM orders WHERE status IN (2,3,6) ORDER BY id DESC LIMIT 50').all(),
  historyOrders: (store) => store.prepare('SELECT id,order_no,daily_seq,seq_date,status,batch_id,delivery_task_id,landmark_name,total_amount,created_at FROM orders WHERE status NOT IN (2,3,6) ORDER BY id DESC LIMIT 100').all(),
  activeTasks: (store) => store.prepare("SELECT id,order_id,batch_id,platform_task_id,device_sn,task_status,status_text,void_at,updated_at FROM delivery_tasks WHERE void_at IS NULL AND task_status < 80 ORDER BY id DESC LIMIT 50").all(),
  historyTasks: (store) => store.prepare("SELECT id,order_id,batch_id,platform_task_id,device_sn,task_status,status_text,void_at,updated_at FROM delivery_tasks WHERE void_at IS NOT NULL OR task_status >= 80 ORDER BY id DESC LIMIT 100").all(),
  stuckTasks: (store) => store.prepare('SELECT * FROM delivery_tasks WHERE void_at IS NULL AND task_status IN (20,30,40,50,60,70,71)').all(),
  badTasks: (store) => store.prepare('SELECT * FROM delivery_tasks WHERE void_at IS NULL AND task_status IN (90,100,120)').all(),
  platformActiveTasks: (store) => store.prepare("SELECT * FROM delivery_tasks WHERE device_sn!='' AND platform_task_id!='' AND void_at IS NULL AND task_status NOT IN (80,110,150)").all(),
  ctrlBatches: (store) => store.prepare("SELECT id,device_sn,ctrl_id FROM delivery_batches WHERE ctrl_id!=''").all(),
  allActiveOrders: (store) => store.prepare('SELECT * FROM orders WHERE status IN (0,1,2,3,6)').all(),
  allActiveBatches: (store) => store.prepare('SELECT id FROM delivery_batches WHERE status IN (0,1,2)').all(),
  orderById: (store, id) => store.prepare('SELECT * FROM orders WHERE id=?').get(Number(id)),
  // 订单行附商品图片/名称/数量（供管理页「商品信息卡面」展示；items 为简表）+ 人读短号
  orderCards: (store, orders) => {
    if (!orders || !orders.length) return []
    const getItems = store.prepare('SELECT goods_id, goods_name, goods_image, price, quantity FROM order_items WHERE order_id=? ORDER BY id')
    return orders.map((o) => {
      const items = getItems.all(o.id)
      return Object.assign({}, o, {
        code_short: seqSvc.orderShortOf(o.seq_date, o.created_at, o.daily_seq || o.id),
        items,
        first_image: items.length ? (items[0].goods_image || '') : '',
        first_name: items.length ? items[0].goods_name : '',
        first_qty: items.length ? Number(items[0].quantity || 0) : 0,
        item_count: items.reduce((s, it) => s + Number(it.quantity || 0), 0)
      })
    })
  },
  taskById: (store, id) => store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(Number(id)),
  batchById: (store, id) => store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(id)),
  batchOrders: (store, batchId) => store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (0,1,2,3,6)').all(Number(batchId)),
  // 批次内订单全量（含终态，供批次表展开查看；不受 history 100 条上限影响）
  batchOrdersAll: (store, batchId) => store.prepare('SELECT id,order_no,daily_seq,seq_date,status,batch_id,delivery_task_id,landmark_name,total_amount,pickup_code,picked_up_at,created_at FROM orders WHERE batch_id=? ORDER BY id').all(Number(batchId)),

  // ---------- 大屏聚合（只读，跨表例外） ----------
  activeBatchesOverview: (store) => store.prepare(`
    SELECT b.id, b.batch_no, b.daily_seq, b.status, b.status_text, b.device_sn, b.total_items,
      (SELECT COUNT(*) FROM orders o WHERE o.batch_id=b.id AND o.status IN (2,3)) AS active_orders,
      (SELECT COUNT(*) FROM orders o WHERE o.batch_id=b.id AND o.status=3 AND o.picked_up_at IS NULL) AS waiting_pickup
    FROM delivery_batches b WHERE b.status IN (0,1,2) ORDER BY b.id DESC LIMIT 12`).all(),
  pickupAlerts: (store) => store.prepare(`
    SELECT id, order_no, landmark_name, pickup_timeout_stage, delivered_at, picking_up_at
    FROM orders WHERE status=3 AND picked_up_at IS NULL AND IFNULL(pickup_timeout_stage,0) > 0
    ORDER BY pickup_timeout_stage DESC, id DESC LIMIT 10`).all(),
  shopRow: (store) => store.prepare('SELECT * FROM shops WHERE id=1').get(),

  // ---------- 管理员写操作（本地库唯一真相源） ----------
  voidTask: (store, id, text) => store.prepare("UPDATE delivery_tasks SET task_status=110, status_text=?, void_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?").run(text, Number(id)),
  clearBatchCtrl: (store, id) => store.prepare("UPDATE delivery_batches SET ctrl_id='' WHERE id=?").run(Number(id)),
  cleanBatch: (store, id) => store.prepare("UPDATE delivery_batches SET status=4, status_text='测试清理已取消', device_sn='', updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),

  // ---------- meta 键值（持久化小状态：控制权 ID 等；重启不丢） ----------
  getMeta: (store, key) => {
    const r = store.prepare('SELECT value FROM meta WHERE key=?').get(String(key))
    return r ? r.value : ''
  },
  setMeta: (store, key, value) => store.prepare(
    'INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(String(key), String(value)),
  delMeta: (store, key) => store.prepare('DELETE FROM meta WHERE key=?').run(String(key)),

  // 某设备涉及的活跃订单 / 活跃批次（「取消机器人全部任务」需按设备找出要统一落账的本地数据）
  activeOrdersByDevice: (store, deviceSn) => store.prepare(
    `SELECT o.* FROM orders o JOIN delivery_batches b ON b.id=o.batch_id
     WHERE b.device_sn=? AND o.status IN (0,1,2,3,6) ORDER BY o.id`).all(String(deviceSn)),
  activeBatchesByDevice: (store, deviceSn) => store.prepare(
    'SELECT id FROM delivery_batches WHERE device_sn=? AND status IN (0,1,2) ORDER BY id').all(String(deviceSn)),

  // ---------- 审计日志（管理页「操作日志」读服务端持久化审计，成功/失败都在） ----------
  auditLogs: (store, opt = {}) => {
    const limit = Math.min(Math.max(Number(opt.limit) || 50, 1), 200)
    const offset = Math.max(Number(opt.offset) || 0, 0)
    const where = []
    const args = []
    if (opt.role) { where.push('user_role=?'); args.push(String(opt.role)) }
    if (opt.action) { where.push('action LIKE ?'); args.push('%' + String(opt.action) + '%') }
    if (opt.ok === 0 || opt.ok === 1) { where.push('IFNULL(ok,1)=?'); args.push(Number(opt.ok)) }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : ''
    const total = store.prepare('SELECT COUNT(*) c FROM audit_logs' + w).get(...args).c
    const rows = store.prepare(`SELECT id, user_id, user_role, action, target, detail,
        IFNULL(ok,1) ok, IFNULL(status,0) status, IFNULL(ip,'') ip, IFNULL(ua,'') ua, IFNULL(ms,0) ms, created_at
      FROM audit_logs` + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, limit, offset)
    return { total, limit, offset, rows }
  },

  // ---------- 状态时间线（status_events） ----------  // 单实体事件（升序，便于前端按时间正序渲染时间线）
  eventsOf: (store, type, id, limit = 200) => store.prepare(
    `SELECT id, entity_type, entity_id, from_status, to_status, status_text, actor_type, actor_id, actor_name, note, created_at
     FROM status_events WHERE entity_type=? AND entity_id=? ORDER BY id ASC LIMIT ?`
  ).all(String(type), Number(id), Math.min(Math.max(Number(limit) || 200, 1), 500)),

  // 多实体事件（批次时间线要合并批内订单的事件）
  eventsOfMany: (store, type, ids, limit = 400) => {
    if (!ids || !ids.length) return []
    const ph = ids.map(() => '?').join(',')
    return store.prepare(
      `SELECT id, entity_type, entity_id, from_status, to_status, status_text, actor_type, actor_id, actor_name, note, created_at
       FROM status_events WHERE entity_type=? AND entity_id IN (${ph}) ORDER BY id ASC LIMIT ?`
    ).all(String(type), ...ids.map(Number), Math.min(Math.max(Number(limit) || 400, 1), 1000))
  },

  // 最近事件（供状态总览给每个实体附「最近变更」摘要）。
  // 用「取最近 N 条再在内存里按实体取最新」代替相关子查询：有界且不随表增长而变慢。
  recentEvents: (store, limit = 800) => store.prepare(
    `SELECT entity_type, entity_id, to_status, status_text, actor_type, actor_name, created_at
     FROM status_events ORDER BY id DESC LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 800, 1), 3000))
}
