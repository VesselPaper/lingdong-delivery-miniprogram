# 配送异常（全部/待处理/已处理 + 搜索 + 重新配送/取消退款）
> 页面路径：pages/orders/exception（商家端小程序）


- **数据来源**：`onShow` → `load()` → GET /api/merchant/orders/exception（query `tab`：`pending` 待处理 / `done` 已处理 / `all` 全部）。
- **页面构成**：顶部三分类 tab（全部 / 待处理 / 已处理）+ `search-box`（占位「订单号 / 点位 / 商品」）；列表卡面 = 订单号 + 下单时间 + 已收款标签 + 状态文字（已处理显示 `handled_text`）+ `goods-row` 商品明细 + 批次/点位 + 合计 + 底部操作区。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 三分类 tab | onTab | 更新 `active` 后 `load()` | — |
| 搜索框 | onSearch | 本地过滤（订单号/短号/当日序号/点位/收餐人） | — |
| 异常订单卡 | goDetail | 读 `data-id` | navigateTo /pages/orders/detail?id= |
| 取消并退款 | refundOrder | 弹窗确认 → POST /api/merchant/order/exception/refund `{order_id}` | 成功 toast → `load()` |
| 重新配送 | retryOrder | 弹窗确认 → POST /api/merchant/order/exception/retry `{order_id}` | 成功 toast「已重新并入批次」→ `load()` |

- **重点链路（异常重配/退款 → /api/merchant/order/exception/retry|refund）**：未处理订单显示「取消并退款（描边红）+ 重新配送（实心蓝）」双按钮，均有 `catchtap` 防冒泡与弹窗二次确认；已处理订单仅显示「handled_text（处理时间）」文字。两条接口与任务页共用后端逻辑：`retry` 作废旧批次任务、订单并入新的组单中批次，派车后重新上货配送；`refund` 取消异常订单并原路退款、回补商品库存。
- **状态与边界**：请求带 `silent`；空态 `empty-view`「暂无配送异常订单」；操作按钮二次确认防误触。

---

[← 返回 05 页面与交互详解 索引](../README.md)
