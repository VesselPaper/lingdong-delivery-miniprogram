# 取消申请详情（同意 / 拒绝填理由）
> 页面路径：pages/orders/cancelRequestDetail（商家端小程序）


- **数据来源**：`onLoad` 存 `id` 并 `load()` → GET /api/merchant/cancel-request/detail?id=。
- **页面构成**：类型/状态头 + 「信息」卡（订单号 / 送达点位 / 订单金额 / 订单状态文字 / 申请时间）+ 「取消原因」卡 + 处理结果（已处理时）+ 底部操作区（待处理时）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 同意取消 | approve | 弹窗确认（提示「退款以实际支付通道为准」）→ `handle('approve', '')` | POST /api/merchant/cancel-request/handle `{id, action, reply}` → toast「已处理」→ `load()` |
| 拒绝取消 | reject | 可编辑弹窗填拒绝理由（必填，空则 toast 拦截）→ `handle('reject', reply)` | 同上 |

- **重点链路**：处理动作统一走 `handle(action, reply)` → POST /api/merchant/cancel-request/handle；同意后订单取消，已支付金额的退款以实际支付通道为准（弹窗文案明示）。
- **状态与边界**：仅 `status === 0` 显示操作区；拒绝理由必填；处理失败 toast 展示 `e.message`。

---

[← 返回 05 页面与交互详解 索引](../README.md)
