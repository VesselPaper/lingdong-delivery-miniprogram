# 上货配单批次列表（组单中 + 待上货，三层卡面）
> 页面路径：pages/device/loading（商家端小程序）


- **数据来源**：`onShow` → `loadPending()` → GET /api/merchant/device/pending（`silent`），取 `open_batches`（组单中）与 `ready_batches`（待上货）两组，原始数据存 `this.rawOpen/rawReady`。`onLoad` 订阅推送：收到 `order_created`（新单进组单中）**或 `batch_dispatched`（批次自动定型）**均 `loadPending()` 局部重拉——自动定型后批次从「组单中」移到「待上货」，卡面即时变化；`onUnload` 退订。
- **页面构成**：顶部**搜索行** = 内联 `search-box`（input 占位「搜索批次、订单、商品、点位」，`bindinput="onSearch"`）+ 右侧**方形扫码图标**（`.scan-square`，72rpx、t-icon scan 36rpx 蓝色、无文字提示，`bindtap="scanRobot"`）；有批次且未搜索时显示自动派车提示条「检测到有订单，配送车将到上货点等待，请做好上货准备」；「组单中（机器人已到上货点待命）」分组节 + `batch-card` 列表（每组卡面 = 批次短号 + 状态标签 + N 单 + 件数 + 路线 + 批次内订单子卡[取餐码/收餐人/商品明细] + 底部「上货（N件）」按钮）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 搜索框 | onSearch | 本地过滤（批次号/短号/当日序号/订单号/点位/收餐人/商品名）；兼容 `e.detail.value` 与 `e.detail` 两种事件形态 | — |
| 右上角扫码图标 | scanRobot | `wx.scanCode` → `scan.parseDeviceSn`（内容格式 `LD-R:<sn>`，兼容裸编号）→ POST /api/merchant/device/scan `{deviceSn}` | navigateTo /pages/device/batchDetail?batch_id=&sn=&at=&dist=&lmsg= |
| 批次卡「上货（N件）」 | selectBatch | 读事件载荷 → `enterBatch(b)`（组单中先定型，见下） | 见 enterBatch |
| 批次卡面 | goBatchDetail | 读 `e.detail` → **纯查看** `wx.navigateTo(/pages/device/batchDetail?id=)`，不执行定型/派车 | 见 14 号批次上货文档 |
| 批次内订单子卡 | goOrderDetail | 读 `e.detail.id` | navigateTo /pages/orders/detail?id= |

- **重点链路（上货按钮 → enterBatch → 批次详情/上货）**：`enterBatch(item)` 只由上货按钮触发——待上货批次（status=1）且 `robot_busy === true` 时弹窗拦截「暂无空闲机器人」（content 用后端 `robot_busy_msg`）；组单中批次（status=0）先 `showLoading('创建配送任务')` 并 POST /api/merchant/delivery/batch/dispatch `{batch_id}` 定型（机器人已到上货点待命，正常流程后端会自动定型，此处手动点按钮为即时定型），失败用弹窗（而非一闪而过的 toast）展示后端可操作提示「暂时无法上货」；成功后 `wx.navigateTo` → /pages/device/batchDetail?id=。
- **状态与边界**：只展示组单中 + 待上货两类批次；配送中/待取货请到任务页与配送监控查看（页头注释明示）。`decorate` 给卡面附加 `dispatchMark`（`ready_dispatch === true` → 「已锁定·待配送」标签）、`robotBusy/robotBusyLabel`（车忙提示）；组单中/待上货阶段订单统一显示「待上货」、已取显示「已取」、status=6 显示「配送异常」。`scanRobot` 失败时 `cancel` 静默返回，其余弹窗展示后端提示（车离线/车忙/无单可上/批次已派给别的车等）；二维码无效 toast「二维码无效，请扫无人车上的二维码」。空态区分「无批次」与「搜索无结果」两种文案。
- **组单中卡面动态效果**：batch-card 对 status=0 的批次显示**旋转圆环 + 「组单中」**（`@keyframes batch-spin`，见 23 号组件说明）；自动定型完成推送后重拉，卡面变为「待上货」标签——即组单完成的即时反馈。

---

[← 返回 05 页面与交互详解 索引](../README.md)
