# 任务页（底部四分类 + 批次分组 + 接单/异常处理）
> 页面路径：pages/orders/list（商家端小程序）


- **数据来源**：`onLoad` 解析 `?stage=`（直接选中四分类）或 `?tab=`（工作台异常入口的精确状态过滤，写入 `statusFilter`）；`onShow` → `shopState.loadShop()` + `load()` + `loadPendingCount()`；`onLoad` 订阅推送、`onUnload` 退订。
- **页面构成**：顶部搜索行（输入框占位「订单号 / 点位 / 商品」+ 右侧「配单上货」按钮带红点）；歇业提示条（`!shopOpen` 时显示「店铺当前歇业中，暂不接收新订单（已接订单正常配送）」）；中部列表 —— 待接单/异常为扁平 `order-card` 列表（卡内嵌操作按钮），待上货/配送中/待取货为 `batch-card` 批次分组列表；底部固定四分类 bar（待接单 / 待上货 / 配送中 / 待取货，图标 + 文案，选中态蓝）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 底部四分类 | onStage | 切换 `active`（accept/load/deliver/pickup）并清 `statusFilter` 后 `load()` | — |
| 搜索框 | onSearch | 本地过滤（`applyFilter`，匹配订单号/短号/当日序号/点位/收餐人）；兼容原生 input 与 search-box 两种事件形态 | — |
| 右上角「配单上货」 | goLoading | 红点数字来自 GET /api/merchant/device/pending（>99 显示 99+） | navigateTo /pages/device/loading |
| 扁平订单卡 | goDetail（order-card 冒泡事件） | 读 `e.detail.id` | navigateTo /pages/orders/detail?id= |
| 批次分组卡内订单 | goDetailByOrder | 读 `e.detail.id` | navigateTo /pages/orders/detail?id= |
| 确认接单 | confirmOrder | 歇业拦截 → 弹窗确认 → POST /api/merchant/order/confirm `{id}` | 成功 toast「已接单，并入批次 N」→ `load()` + `loadPendingCount()` |
| 异常-取消并退款 | refundOrder | 弹窗确认 → POST /api/merchant/order/exception/refund `{order_id}` | 成功 toast → `load()` |
| 异常-重新配送 | retryOrder | 弹窗确认 → POST /api/merchant/order/exception/retry `{order_id}` | 成功 toast「已重新并入批次」→ `load()` |

- **重点链路（任务页批次分组 → /api/merchant/orders?stage=）**：`load()` 按 `active` 拼 `?stage=accept|load|deliver|pickup`；`statusFilter` 非空时改拼 `?status=`（工作台异常入口）。返回列表先统一装饰（`payed`=status>0、`picked`=有取餐时间、时间去秒、状态色 class），再分流：待接单/异常走扁平列表；其余调 `groupByBatch(list, stage)` 按 `batch.batch_no`（无批次归 `__none__`）分组 —— 一个批次一个 `batch-card` 卡面（批次短号、状态标签、单数、件数、路线、已取 X/N 进度），批次内嵌套多单完整展示商品图/价/量。待取货阶段即使批次状态仍为「配送中」（取完才完成），卡片文案强制显示「待取货」。分组按 `daily_seq` 倒序，`__none__` 组沉底。
- **状态与边界**：歇业时接单按钮置灰并拦截（toast「店铺当前歇业中，无法接单」）；批次内订单子卡用 `catchtap` 阻止冒泡 —— 点单进订单详情、不会误触发整卡事件（本页批次卡未绑 cardtap，冒泡设计主要服务于上货配单页）；推送 `order_created` 时局部重拉当前列表与红点；空列表 `empty-view`「暂无订单」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
