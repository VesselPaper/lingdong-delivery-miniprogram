# 售后详情处理（同意退款改金额 / 拒绝 / 回复投诉）
> 页面路径：pages/orders/aftersaleDetail（商家端小程序）


- **数据来源**：`onLoad` 存 `id` 并立即 `load()` → GET /api/merchant/refund/detail?id=。
- **页面构成**：顶部类型/状态；「信息」卡（订单号 / 送达点位 / 订单金额与退款金额[退款类型] / 申请时间）；「申请原因」卡 + 已处理时追加「处理结果」；底部操作区（仅待处理显示）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 同意退款 | approve | `wx.showModal` 可编辑（占位「退款金额（留空=全额）」），输入为数字且 ≥0 才提交，否则按全额 → `handle('approve', amount, '')` | POST /api/merchant/refund/handle `{id, action, amount, reply}` → toast「已处理」→ `load()` |
| 拒绝退款 | reject | 可编辑弹窗填拒绝理由（必填，空则 toast 拦截）→ `handle('reject', undefined, reply)` | 同上 |
| 回复处理（投诉） | reply | 可编辑弹窗填处理意见 → `handle('reply', undefined, reply)` | 同上 |

- **重点链路**：三个处理动作统一走 `handle(action, amount, reply)` → POST /api/merchant/refund/handle；`handle` 内 `showLoading('处理中')`，失败 toast 展示 `e.message`。同意退款金额默认全额、可改金额，体现「同意退款改金额」能力。
- **状态与边界**：仅 `status === 0`（待处理）显示操作区；退款类型显示「拒绝退款 + 同意退款」双按钮，投诉类型只显示「回复处理」；已处理单只读展示处理结果。

---

[← 返回 05 页面与交互详解 索引](../README.md)
