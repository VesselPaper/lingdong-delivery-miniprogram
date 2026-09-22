// delivery 域专属表：delivery_tasks / delivery_batches / landmarks
// 本文件只写本域三张表；跨域读（orders/order_items）以只读形式出现在 service.js/routes.js 并注释（delivery→orders 是 05 方案明确允许的例外）。

module.exports = {
  // ---------- delivery_tasks ----------
  taskById: (store, id) => store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(Number(id)),
  taskByOrder: (store, orderId) => store.prepare('SELECT * FROM delivery_tasks WHERE order_id=?').get(Number(orderId)),
  taskByPlatformId: (store, platformTaskId) => store.prepare('SELECT * FROM delivery_tasks WHERE platform_task_id=?').get(String(platformTaskId)),
  tasksByBatch: (store, batchId) => store.prepare('SELECT * FROM delivery_tasks WHERE batch_id=?').all(Number(batchId)),
  setTaskDeviceSn: (store, taskId, sn) => store.prepare('UPDATE delivery_tasks SET device_sn=? WHERE id=?').run(sn, Number(taskId)),
  setBatchTasksDeviceSn: (store, batchId, sn) => store.prepare("UPDATE delivery_tasks SET device_sn=? WHERE batch_id=? AND (device_sn='' OR device_sn IS NULL)").run(sn, Number(batchId)),
  voidTasksByBatch: (store, batchId, text) => store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text=?,
    void_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
    WHERE batch_id=? AND void_at IS NULL`).run(text, Number(batchId)),
  // 异常重配必须按 order_id 精确作废（不能按 batch_id，会误伤同批次其他订单）
  voidTasksByOrder: (store, orderId, text) => store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text=?,
    void_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
    WHERE order_id=? AND task_status < 80 AND void_at IS NULL`).run(text, Number(orderId)),
  voidTaskByOrderRevisit: (store, orderId) => store.prepare(`UPDATE delivery_tasks SET task_status=110, status_text='取餐超时返程，任务作废',
    void_at=COALESCE(void_at, datetime('now','localtime')), updated_at=datetime('now','localtime')
    WHERE order_id=? AND void_at IS NULL AND task_status < 80`).run(Number(orderId)),
  setTaskStatus: (store, id, status, text) => store.prepare("UPDATE delivery_tasks SET task_status=?, status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(Number(status), text, Number(id)),
  setTaskStatusText: (store, id, text) => store.prepare("UPDATE delivery_tasks SET status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(text, Number(id)),
  setTaskStatusTextKeep: (store, id, text) => store.prepare("UPDATE delivery_tasks SET status_text=?, updated_at=datetime('now','localtime') WHERE id=?").run(text, Number(id)),
  setTaskStatusByOrder: (store, orderId, status, text) => store.prepare("UPDATE delivery_tasks SET task_status=?, status_text=?, updated_at=datetime('now','localtime') WHERE order_id=?").run(Number(status), text, Number(orderId)),
  setTaskRecall: (store, id, ok, msg) => store.prepare("UPDATE delivery_tasks SET recall_status=?, recall_error=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(ok ? 1 : 2, ok ? '' : String(msg || '').slice(0, 200), Number(id)),
  setTaskStatusByBatchBelow: (store, batchId, status, text) => store.prepare("UPDATE delivery_tasks SET task_status=?, status_text=?, updated_at=datetime('now','localtime') WHERE batch_id=? AND task_status < ?")
    .run(Number(status), text, Number(batchId), Number(status)),
  monitorTasks: (store) => store.prepare(`
    SELECT d.*, o.order_no, o.landmark_name, o.status AS order_status, o.daily_seq AS order_daily_seq, o.seq_date AS order_seq_date
    FROM delivery_tasks d JOIN orders o ON d.order_id = o.id
    WHERE d.task_status < 80 OR (d.task_status >= 90 AND d.task_status < 110)
    ORDER BY d.id DESC`).all(),

  // ---------- delivery_batches ----------
  batchById: (store, id) => store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(id)),
  recentBatches: (store, limit) => store.prepare('SELECT * FROM delivery_batches ORDER BY id DESC LIMIT ?').all(Number(limit || 20)),
  batchesByStatus: (store, status, limit) => store.prepare('SELECT * FROM delivery_batches WHERE status=? ORDER BY id DESC LIMIT ?').all(Number(status), Number(limit || 10)),
  batchesByStatusIn: (store, statuses, order, limit) => {
    const ph = statuses.map(() => '?').join(',')
    return store.prepare(`SELECT * FROM delivery_batches WHERE status IN (${ph}) ORDER BY id ${order} LIMIT ?`).all(...statuses, Number(limit || 20))
  },
  batchByStatusDeviceSn: (store, status, sn) => store.prepare('SELECT * FROM delivery_batches WHERE status=? AND device_sn=? ORDER BY id DESC LIMIT 1').get(Number(status), String(sn)),
  setBatchDeviceSn: (store, id, sn) => store.prepare("UPDATE delivery_batches SET device_sn=?, updated_at=datetime('now','localtime') WHERE id=?").run(String(sn || ''), Number(id)),
  setBatchCtrlId: (store, id, ctrlId) => store.prepare("UPDATE delivery_batches SET ctrl_id=?, updated_at=datetime('now','localtime') WHERE id=?").run(String(ctrlId || ''), Number(id)),
  setBatchRoute: (store, id, routeJson) => store.prepare("UPDATE delivery_batches SET route=?, updated_at=datetime('now','localtime') WHERE id=?").run(String(routeJson || ''), Number(id)),
  setBatchMockArrive: (store, id, seconds) => store.prepare("UPDATE delivery_batches SET mock_arrive_at=datetime('now','localtime', ?), updated_at=datetime('now','localtime') WHERE id=?")
    .run('+' + Math.round(Number(seconds)) + ' seconds', Number(id)),
  clearBatchMockArrive: (store, id) => store.prepare("UPDATE delivery_batches SET mock_arrive_at=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),
  claimDispatch: (store, id) => store.prepare(`
    UPDATE delivery_batches SET status=1, status_text='待上货',
      dispatched_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
    WHERE id=? AND status=0`).run(Number(id)),
  setBatchCurrentStop: (store, id, stop) => store.prepare("UPDATE delivery_batches SET current_stop=?, updated_at=datetime('now','localtime') WHERE id=?").run(Number(stop || 0), Number(id)),
  setBatchDeliveryMode: (store, id, mode) => store.prepare("UPDATE delivery_batches SET delivery_mode=?, updated_at=datetime('now','localtime') WHERE id=?").run(String(mode || ''), Number(id)),
  setBatchLightTask: (store, id, lightTaskId) => store.prepare("UPDATE delivery_batches SET light_task_id=?, updated_at=datetime('now','localtime') WHERE id=?").run(String(lightTaskId || ''), Number(id)),
  setBatchLoadedAt: (store, id) => store.prepare("UPDATE delivery_batches SET loaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),
  clearBatchLoadedAt: (store, id) => store.prepare("UPDATE delivery_batches SET loaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),
  revertDispatch: (store, id) => store.prepare("UPDATE delivery_batches SET status=0, status_text='组单中', device_sn='', route='', dispatched_at=NULL, updated_at=datetime('now','localtime') WHERE id=?")
    .run(Number(id)),
  revertDispatchNoRoute: (store, id) => store.prepare("UPDATE delivery_batches SET status=0, status_text='组单中', dispatched_at=NULL, updated_at=datetime('now','localtime') WHERE id=?")
    .run(Number(id)),
  setBatchLoading: (store, id) => store.prepare("UPDATE delivery_batches SET status=1, status_text='待上货', updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),
  setBatchDelivering: (store, id) => store.prepare("UPDATE delivery_batches SET status=2, status_text='配送中', updated_at=datetime('now','localtime') WHERE id=?").run(Number(id)),
  setBatchCompleted: (store, id, picked) => store.prepare("UPDATE delivery_batches SET status=3, status_text='已完成', picked_orders=?, completed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
    .run(Number(picked || 0), Number(id)),
  // 待上货批次里已有已送达订单（配送已真正开始）→ 推进为配送中
  batchAdvanceIfDelivered: (store, id) => store.prepare("UPDATE delivery_batches SET status=2, status_text='配送中', updated_at=datetime('now','localtime') WHERE id=? AND status=1").run(Number(id)),
  arrivedBatches: (store) => store.prepare("SELECT * FROM delivery_batches WHERE status=2 AND mock_arrive_at IS NOT NULL AND mock_arrive_at <= datetime('now','localtime')").all(),

  // ---------- landmarks ----------
  landmarksAll: (store) => store.prepare('SELECT * FROM landmarks ORDER BY sort').all(),
  landmarksWithPos: (store) => store.prepare('SELECT id,name,type,pos_x,pos_y FROM landmarks WHERE pos_x IS NOT NULL AND pos_y IS NOT NULL').all(),
  loadingPointFirst: (store) => store.prepare("SELECT pos_x,pos_y FROM landmarks WHERE type='loadingPoint' ORDER BY sort LIMIT 1").get(),
  landmarkById: (store, id) => store.prepare('SELECT * FROM landmarks WHERE id=?').get(String(id)),
  landmarkPosById: (store, id) => store.prepare('SELECT name,pos_x,pos_y FROM landmarks WHERE id=?').get(String(id)),
  deliverPointById: (store, id) => store.prepare("SELECT * FROM landmarks WHERE id=? AND type='deliverPoint'").get(String(id)),
  userByToken: (store, token) => store.prepare('SELECT id FROM users WHERE openid=?').get(String(token || ''))
}
