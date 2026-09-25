# 工作台（四态主面板 + 异常/售后次面板 + 配单上货角标按钮）
> 页面路径：pages/shop/home（商家端小程序）


- **数据来源**：`onShow` → `shopState.loadShop()`（GET /api/merchant/shop）→ `load()`（GET /api/merchant/stats，返回 `pending/ready_load/delivering/pickup/exception/aftersale/cancel_requests`）→ `loadPendingBatches()`（GET /api/merchant/device/pending 的 `pending_orders` 字段）。`onLoad` 订阅推送，`onUnload` 退订。
- **页面构成**：「我的任务」卡 = 头部（标题 + 营业标签 + 全部订单入口）+ 四态网格（待接单蓝 / 待上货绿 / 配送中橙 / 待取货紫，各含图标 + 大数字 + 文案）+ 次面板行（异常红字 / 售后橙字角标）；「常用功能」卡 = 六宫格（商品管理 / 活动管理 / 历史订单 / 取消申请[带红点] / 配送监控 / 商铺设置）；底部居中悬浮圆形「配单上货」大按钮（白色图标 + 文案 + 右上角数字角标）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 全部订单 | goOrders | — | navigateTo /pages/orders/list |
| 待接单/待上货/配送中 | goOrdersStage | 读 `data-stage`（accept/load/deliver） | navigateTo /pages/orders/list?stage=xxx |
| 待取货 | goPickup | — | navigateTo /pages/orders/list?stage=pickup |
| 异常 | goException | — | navigateTo /pages/orders/exception |
| 售后 | goAftersale | — | navigateTo /pages/orders/aftersale |
| 商品管理 | goGoods | — | navigateTo /pages/goods/list |
| 活动管理 | goActivities | — | navigateTo /pages/activity/list |
| 历史订单 | goHistory | — | navigateTo /pages/orders/history |
| 取消申请 | goCancelRequests | — | navigateTo /pages/orders/cancelRequests |
| 配送监控 | goMonitor | — | navigateTo /pages/delivery/monitor |
| 商铺设置 | goSettings | — | navigateTo /pages/shop/settings |
| 底部圆形「配单上货」 | goLoading | — | navigateTo /pages/device/loading |

- **重点链路（工作台四态数字 → /api/merchant/stats）**：`onShow` 每次进入都重拉 `stats`；四个格子角标数字来自 `stats.pending / ready_load / delivering / pickup`，为 0 时加 `zero` 样式置灰弱化；次面板 `stats.exception`（红）、`stats.aftersale`（橙）仅在非 0 时醒目；「取消申请」入口在 `stats.cancel_requests` 非 0 时显示红点；底部圆形按钮角标 `pendingBatchCount` > 0 才渲染。收到推送 `order_created` 或 `batch_dispatched` 时 `load()` + `loadPendingBatches()` 局部刷新，不整页重载。
- **状态与边界**：头部营业标签与歇业态同步自 `shopState`；主面板与底部按钮共用 `goLoading` 同一入口，全部订单与四态点击都带正确的 `stage/tab` 参数直达任务页对应分类。

---

[← 返回 05 页面与交互详解 索引](../README.md)
