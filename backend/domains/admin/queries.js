// admin 域 SQL：管理员工具 + 大屏只读聚合（05 方案允许 admin 只读跨表聚合；写操作经 order 域 service 落账）

module.exports = {
  // ---------- 状态总览聚合（只读，跨表例外） ----------
  activeBatches: (store) => store.prepare('SELECT id,batch_no,status,status_text,device_sn,ctrl_id,total_orders,picked_orders,total_items,delivery_mode,current_stop,route,created_at,dispatched_at FROM delivery_batches WHERE status IN (0,1,2) ORDER BY id DESC LIMIT 50').all(),
  historyBatches: (store) => store.prepare('SELECT id,batch_no,status,status_text,device_sn,ctrl_id,total_orders,picked_orders,total_items,delivery_mode,current_stop,route,created_at,dispatched_at FROM delivery_batches WHERE status NOT IN (0,1,2) ORDER BY id DESC LIMIT 100').all(),
  activeOrders: (store) => store.prepare('SELECT id,order_no,status,batch_id,delivery_task_id,landmark_name,total_amount,created_at FROM orders WHERE status IN (2,3,6) ORDER BY id DESC LIMIT 50').all(),
  historyOrders: (store) => store.prepare('SELECT id,order_no,status,batch_id,delivery_task_id,landmark_name,total_amount,created_at FROM orders WHERE status NOT IN (2,3,6) ORDER BY id DESC LIMIT 100').all(),
  activeTasks: (store) => store.prepare("SELECT id,order_id,batch_id,platform_task_id,device_sn,task_status,status_text,void_at,updated_at FROM delivery_tasks WHERE void_at IS NULL AND task_status < 80 ORDER BY id DESC LIMIT 50").all(),
  historyTasks: (store) => store.prepare("SELECT id,order_id,batch_id,platform_task_id,device_sn,task_status,status_text,void_at,updated_at FROM delivery_tasks WHERE void_at IS NOT NULL OR task_status >= 80 ORDER BY id DESC LIMIT 100").all(),
  stuckTasks: (store) => store.prepare('SELECT * FROM delivery_tasks WHERE void_at IS NULL AND task_status IN (20,30,40,50,60,70,71)').all(),
  badTasks: (store) => store.prepare('SELECT * FROM delivery_tasks WHERE void_at IS NULL AND task_status IN (90,100,120)').all(),
  platformActiveTasks: (store) => store.prepare("SELECT * FROM delivery_tasks WHERE device_sn!='' AND platform_task_id!='' AND void_at IS NULL AND task_status NOT IN (80,110,150)").all(),
  ctrlBatches: (store) => store.prepare("SELECT id,device_sn,ctrl_id FROM delivery_batches WHERE ctrl_id!=''").all(),
  allActiveOrders: (store) => store.prepare('SELECT * FROM orders WHERE status IN (0,1,2,3,6)').all(),
  allActiveBatches: (store) => store.prepare('SELECT id FROM delivery_batches WHERE status IN (0,1,2)').all(),
  orderById: (store, id) => store.prepare('SELECT * FROM orders WHERE id=?').get(Number(id)),
  taskById: (store, id) => store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(Number(id)),
  batchById: (store, id) => store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(id)),
  batchOrders: (store, batchId) => store.prepare('SELECT * FROM orders WHERE batch_id=? AND status IN (0,1,2,3,6)').all(Number(batchId)),
  // 批次内订单全量（含终态，供批次表展开查看；不受 history 100 条上限影响）
  batchOrdersAll: (store, batchId) => store.prepare('SELECT id,order_no,status,batch_id,delivery_task_id,landmark_name,total_amount,pickup_code,picked_up_at,created_at FROM orders WHERE batch_id=? ORDER BY id').all(Number(batchId)),

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
  cleanBatch: (store, id) => store.prepare("UPDATE delivery_batches SET status=4, status_text='测试清理已取消', device_sn='', updated_at=datetime('now','localtime') WHERE id=?").run(Number(id))
}
