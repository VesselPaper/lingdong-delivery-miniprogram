# 订单详情：各状态操作按钮矩阵 + 配送进度条
> 页面路径：pages/order/detail（用户端小程序）


**页面职责**：展示订单全量信息（取餐码、配送信息、商品清单、取消申请记录）与配送进度条，按订单状态渲染不同的操作按钮（支付/取消/取餐/售后）。

**进入路径**：订单列表卡片 `goDetail`；我的售后记录「查看订单」`goOrder`；确认订单支付轮询（`utils/pay.js → pollPaid` 仅拉详情不回显）。

**页面结构（wxml 骨架）**：状态头部（`status_text` 大标题 + 按状态的条件副文案：3 已到达取餐 / 2 配送途中 / 1 备餐装载 / 0 尽快支付）→ 配送进度条卡（status 1~4 时显示「已接单 / 配送中 / 已送达」三圆点 + `progressText`）→ 取餐码卡（status ≥ 1 且有 `pickup_code` 时）→ 取消申请卡（`order.cancel_request` 存在时）→ 配送信息卡（送达点位 / 订单编号 / 备注 / 下单时间）→ 商品清单卡（店铺行 + 逐件商品图/名/数量/单价 + 合计）→ 底部操作按钮区 `foot-actions`（按状态矩阵渲染）。

**页面要素与数据来源**：

- `onLoad`：`id` 取 `options.id`；`payMock` 读 storage `runtimeFlags.pay_mock`（决定支付按钮文案为「模拟支付」）。
- `onShow`：`load()` 拉详情 + 静默 POST `/api/user/order/mark-read` 清红点。
- `load()`：GET `/api/order/detail?id=`，setData `order / items` 与 `calcProgress` 结果，并 `wx.setNavigationBarTitle` 为 `status_text`。
- `calcProgress(data)`：由 `status` + `task.task_status` + `picking_up_at / pickup_timeout_stage` 推导 `progress`（0~3 圆点进度）与 `progressText`，规则如下表：

| 订单状态 | progress | progressText |
| --- | --- | --- |
| 0 待支付 | 0 | 待支付 |
| 1 待接单 | 0 | 待接单，商家正在备餐 |
| 2 配送中（`task.task_status >= 50`） | 2 | 机器人配送中 |
| 2 配送中（未达 50） | 1 | 已接单，等待装载配送 |
| 3 已送达（`picking_up_at`） | 3 | 正在取餐（舱门已打开，请取出餐品并关舱） |
| 3 已送达（`pickup_timeout_stage === 1`） | 3 | 取餐超时，先送其他单，稍后返回本点位，请留意 |
| 3 已送达（`pickup_timeout_stage === 2`） | 3 | 已再次到达等待，即将取消订单，请尽快取餐 |
| 3 已送达（默认） | 3 | 机器人已到达 {landmark_name}，请及时取餐 |
| 4 已完成 | 3 | 已完成 |
| 其余（5/6/7 等） | 0 | 后端 `status_text` |

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/order/detail.js） | 显隐条件 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- | --- |
| 取消订单 | `cancelOrder` | status 0；或 status 1 且 `direct_cancelable` | 确认框 → POST `/api/order/cancel`（`{ id }`） | 成功 toast + `load()` 刷新；失败 message 含「取消申请」→ toast「已超过免费取消时间，转提交取消申请」并 600ms 后 `goCancelRequest` |
| 立即支付 / 模拟支付 | `payOrder` | status 0 | `utils/pay.js → payOrder(id)` 调 POST `/api/order/pay`；`payMock` 为真时按钮文案「模拟支付」 | 成功 toast + `load()`；失败按 message toast（`'cancel'` 静默） |
| 提交取消申请 | `goCancelRequest` | status 1 且 `request_cancelable` | 直接跳转（超时取消的唯一入口） | `wx.navigateTo('/pages/order/cancelRequest?order_id=' + id)` |
| 扫码取餐 | `goScanPickup` | status 3（已送达待取餐） | 跳扫码取餐页，扫车身二维码 + 输取餐码定位本人订单 | `wx.navigateTo('/pages/delivery/scanPickup')` |
| 退款/投诉 | `goRefund` | status 3 / 4 / 6（送达后、完成后、配送异常） | 跳申请页 | `wx.navigateTo('/pages/order/refund?order_id=' + id)` |
| （保留未绑定）模拟确认取餐 | `confirmReceive` | — | 定义于 detail.js：POST `/api/delivery/confirm`（`{ order_id, scan_code }`）成功后 toast「取餐成功」并刷新；当前 wxml 未绑定，实际取餐入口为扫码取餐页 | 历史保留的模拟链路 |

**重点链路**：

- **状态按钮矩阵（foot-actions）**：status 0 →「取消订单 + 立即支付/模拟支付」；status 1 → 按 `direct_cancelable / request_cancelable` 二选一（直取消 或 提交取消申请）；status 2（配送中）→ **无任何操作按钮**（配送中不可取消，需等送达或异常后走售后）；status 3 →「扫码取餐 + 退款/投诉」；status 4 / 6 →「退款/投诉」。status 5（已取消）等无按钮。
- **免费取消 → 超时转申请**：免费窗口内（后端 `direct_cancelable` 为真）点取消直接 POST `/api/order/cancel`；窗口外请求会被后端拒绝（报错含「取消申请」字样），前端捕获后 toast 提示并 600ms 后自动跳转 `cancelRequest` 页，用户改走人工审核。
- **配送进度条**：仅 status 1~4 显示「已接单 → 配送中 → 已送达」三圆点；到达阶段圆点填满（`progress` 值），下方 `progressText` 细化文案；已接单未建任务（status 2 且 `task_status < 50`）只亮到「已接单」。
- **取消申请记录**：`order.cancel_request` 存在时渲染独立卡片，展示 `status_text / reason / merchant_reply`（商家处理结果），申请处理结果在详情页闭环可见。
- **一车多单信息说明**：本页 wxml 无同批次信息卡；同批次（本车共 N 单 / 已取 X 单）信息实际展示于配送追踪页 `delivery/track`（batch 卡）与取餐系列页（见后文），本页仅提供取餐码与扫码取餐入口。

**状态与边界**：页面标题随 `status_text` 变化；status 6（配送异常）无头部副文案（仅状态标题）；`picking_up_at / pickup_timeout_stage` 注释明确后端语义为「正在取餐 / 0 无 / 1 一段超时 / 2 已返回再等 / 3 已驳回」，前端只处理 1、2 两段提示；取餐码卡提示「机器人到达后，扫车身二维码并输入该取餐码即可开舱」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
