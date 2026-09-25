// services/platform-mock.js —— 开放物流平台对接·本地模拟状态机（结构评审 P0-2 拆分件之三）
// ------------------------------------------------------------------
// 职责：PLATFORM_MOCK=true 时的本地配送模拟 —— 任务按 MOCK_STEPS 每 4s 推进，推进结果
// 统一经 platform-callbacks.applyStatus 落账（与真实回调/轮询共用同一条状态同步咽喉）。
// 仅被入口 platform.js（createQueueTask / createTasksForBatch 的 MOCK 分支）与 orderCancel 调用。
'use strict'

const callbacks = require('./platform-callbacks')

const MOCK_STEPS = [
  { code: 0, text: '排队中' },
  { code: 10, text: '任务已接收' },
  { code: 20, text: '去往上货点' },
  { code: 30, text: '到达上货点' },
  { code: 50, text: '已上货' },
  { code: 60, text: '去往取货点' },
  { code: 70, text: '到达取货点' },
  { code: 80, text: '任务完成' }
]
const mockTasks = new Map() // taskId -> { step, timer }

function mockAdvance(store, taskId) {
  const t = mockTasks.get(taskId)
  if (!t) return
  const idx = t.step + 1
  if (idx >= MOCK_STEPS.length) {
    callbacks.applyStatus(store, taskId, 80, '任务完成')
    return
  }
  t.step = idx
  callbacks.applyStatus(store, taskId, MOCK_STEPS[idx].code, MOCK_STEPS[idx].text)
  t.timer = setTimeout(() => mockAdvance(store, taskId), 4000)
}

// 停止本地模拟推进。mockAdvance 会自己续 setTimeout 且此前无人 clearTimeout，
// 取消订单后它仍会每 4s 把状态往前推，是「已取消订单复活成已送达」最稳定的复现路径。
// 由 orderCancel.cancelLocal 在作废任务时调用。
function cancelMockTask(taskId) {
  const id = Number(taskId)
  const t = mockTasks.get(id)
  if (!t) return false
  if (t.timer) clearTimeout(t.timer)
  mockTasks.delete(id)
  return true
}

module.exports = { MOCK_STEPS, mockTasks, mockAdvance, cancelMockTask }
