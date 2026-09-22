# 取消申请列表（全部/待处理/已同意/已拒绝）
> 页面路径：pages/orders/cancelRequests（商家端小程序）


- **数据来源**：`onShow` → `load()` → GET /api/merchant/cancel-requests（`active` 非空拼 `?status=`，取值 '' / 0 / 3 / 2）。
- **页面构成**：顶部四分类 tab（全部 / 待处理 / 已同意 / 已拒绝）；列表卡面 = 「取消申请」类型标签 + 状态文字（待处理标黄）+ 订单号 + 送达点位 + 原因（单行省略）+ 处理回复（已处理时）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 四分类 tab | onTab | 更新 `active` 后 `load()` | — |
| 申请卡 | goDetail | 读 `data-id` | navigateTo /pages/orders/cancelRequestDetail?id= |

- **重点链路**：工作台「取消申请」入口红点（`stats.cancel_requests`）→ 本列表待处理 tab → 详情处理，形成完整的用户取消申请处理闭环。
- **状态与边界**：请求带 `silent`；空列表「暂无取消申请」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
