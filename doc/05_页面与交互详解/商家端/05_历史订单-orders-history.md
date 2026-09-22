# 历史订单（已完成/已取消/异常 + 商品明细）
> 页面路径：pages/orders/history（商家端小程序）


- **数据来源**：`onShow` → `load()` → GET /api/merchant/orders?scope=history，后端附带 `items` 商品明细与所属批次。
- **页面构成**：顶部 `search-box`（占位「订单号 / 商品 / 点位」）；列表卡面 = 「订单 N」标题 + 下单时间 + 已收款标签（payed）+ 状态文字 + `goods-row` 逐行商品明细（图/名称/价格/数量）+ 底部批次信息与点位 + 「合计 ¥」金额。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 搜索框 | onSearch | 本地过滤（订单号/短号/当日序号/点位/商品名，`e.detail` 为值） | — |
| 订单卡 | goDetail | 读 `data-id` | navigateTo /pages/orders/detail?id= |

- **重点链路**：历史范围含已完成/已取消/配送异常/已退款四类终态；`applyFilter` 对商品明细做 `items.some(goods_name)` 匹配，支持按商品名搜历史单；时间经 `formatTime` 去秒展示。
- **状态与边界**：复用 `ST_CLASS` 状态色板；空列表 `empty-view`「暂无历史订单」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
