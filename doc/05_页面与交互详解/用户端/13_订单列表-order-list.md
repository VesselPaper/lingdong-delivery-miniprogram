# 订单列表：状态筛选 + 进入已读清红点 + 取消/支付快捷操作
> 页面路径：pages/order/list（用户端小程序）


**页面职责**：按状态 Tab 展示本人全部订单，承载「去支付、取消订单（免费直取消 / 超时转申请）」等快捷操作，进入即清订单红点。

**进入路径**：我的页「我的订单」`goOrders`（全部 Tab）；我的页四个订单状态入口 `goOrdersTab`（data-status 0/2/3/4/空，写 storage `order_tab` 后进入并自动选中对应 Tab）；订单支付成功等操作后返回本页 `onShow` 自动刷新。

**页面结构（wxml 骨架）**：顶部 6 个状态 Tab（全部 / 待支付 0 / 待接单 1 / 配送中 2 / 已送达 3 / 已完成 4，高亮由 `active` 驱动）→ 订单卡片列表（头部：店铺名「零栋铺子」+ 状态文本；下单时间；首件商品图/名/数量；脚部：共 N 件 + 实付款金额 + 按状态渲染的操作按钮行）→ 空态（无订单时显示「暂无订单」图标文案）。

**页面要素与数据来源**：

- `onShow`：先读取并**消费** storage `order_tab`（我的页 `goOrdersTab` 写入的入口 Tab），`removeStorageSync` 后 `setData({ active })`；随后 `loadOrders()` 拉列表、`markRead()` 清红点。
- `loadOrders()`：GET `/api/order/list`，`active` 非空时拼 `?status=N`；结果先 `sortOrders` 排序，再 `decorate` 逐单补齐展示字段。
- `sortOrders()`：进行中（status ≤ 3）在前、已完结（status > 3）在后，组内按下单时间升序。
- `decorate(list)`：对每单再发 GET `/api/order/detail?id=`，补出下列字段：
  - `stClass`：状态颜色（`ST_CLASS = {0:orange, 1:orange, 2:blue, 3:green, 4:gray, 5:gray, 6:red, 7:gray}` → `st-<class>` 文本色）；
  - `item_count`：各商品 `quantity` 之和（「共 N 件」）；`first_name / first_qty / first_image`：首件商品展示；
  - `created_time`：`created_at` 去秒取前 16 位（后端为本地时间，避免时区解析差异）；
  - 状态文案覆盖（见重点链路）；`direct_cancelable / request_cancelable / cancel_req_pending`：三个取消分流标记。
- `markRead()`：POST `/api/user/order/mark-read`，`silent: true`，失败静默忽略。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/order/list.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 状态 Tab（全部/待支付/待接单/配送中/已送达/已完成） | `onTab` | 取 `data-name` 设 `active` 并重新 `loadOrders()` | 列表按状态重新筛选排序 |
| 订单卡片（非按钮区） | `goDetail` | 读 `data-id` | `wx.navigateTo('/pages/order/detail?id=' + id)` |
| 待支付卡片「取消订单」 | `cancelOrder` | 弹「确定取消该订单？」确认框 → 确认后 POST `/api/order/cancel`（`{ id }`） | 成功 toast「已取消」+ `loadOrders()` 刷新；失败 message 含「取消申请」→ 转 `goCancelRequest` 进申请页 |
| 待支付卡片「去支付」 | `payOrder` | 经 `utils/pay.js → payOrder(id)` 调 POST `/api/order/pay` | 成功 toast「支付成功」+ `loadOrders()`；失败按 `err.message` toast（`'cancel'` 静默） |
| 待接单卡片「取消订单」（免费窗口内） | `cancelOrder` | `direct_cancelable` 为真时走确认框 → POST `/api/order/cancel` | 同「待支付取消」 |
| 待接单卡片「提交取消申请」（超时后） | `goCancelRequest` | `request_cancelable` 为真且不可直取消时，`cancelOrder` 直接转此入口 | `wx.navigateTo('/pages/order/cancelRequest?order_id=' + id)` |
| 待接单卡片「取消申请处理中」（禁用态） | 无（纯展示） | `cancel_req_pending`（已有 status=0 的待处理申请）时渲染灰色禁用按钮 | 阻止重复提交申请 |

**重点链路**：

- **进入即清红点**：列表 `onShow`（及详情页 `onShow`）静默 POST `/api/user/order/mark-read` → 后端清除该用户未读动态 → 我的页红点（GET `/api/user/order/badge`）下次进入消失。
- **我的页订单入口联动**：我的页「订单」区四个入口（`goOrdersTab`）写 storage `order_tab` 后跳列表；列表 `onShow` 消费该键直接选中对应 Tab，实现「从我的页点配送中 → 列表直接停在配送中」的定位效果。
- **取消分流矩阵**（由详情接口的 `direct_cancelable / request_cancelable / cancel_request` 三标记驱动）：
  1. 免费取消窗口内（`direct_cancelable`）→ 确认框 → POST `/api/order/cancel` 直取消；
  2. 超时（`request_cancelable` 且不可直取消）→ 不弹确认框，直接跳「提交取消申请」页；
  3. 已有待处理申请（`cancel_request.status === 0`）→ 按钮置灰「取消申请处理中」；
  4. 直接调 `/api/order/cancel` 被后端拒绝（返回含「取消申请」的报错）→ 自动转申请页兜底。
- **已送达未取餐的状态文案覆盖**：`status === 3` 且 `picked_up_at` 为空时，列表状态文案不再显示「已送达」，按优先级取：`picking_up_at` →「正在取餐」；`pickup_timeout_stage === 1` →「取餐超时·稍后返回」；`=== 2` →「即将取消」；否则用后端 `status_text`。

**状态与边界**：无订单时显示空态「暂无订单」；卡片按钮用 `catchtap` 阻止冒泡到卡片跳转详情；`markRead` 失败静默；列表接口失败静默（`/* handled */`）保持旧数据；排序在「进行中优先」前提下按下单时间升序，越早的进行中单排越前。

---

[← 返回 05 页面与交互详解 索引](../README.md)
