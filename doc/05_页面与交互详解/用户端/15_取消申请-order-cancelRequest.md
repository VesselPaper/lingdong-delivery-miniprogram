# 提交取消申请
> 页面路径：pages/order/cancelRequest（用户端小程序）


**页面职责**：为超过免费取消窗口的订单填写取消原因，提交后由商家审核决定是否同意取消。

**进入路径**：订单列表 `goCancelRequest`（超时转申请）；订单详情 `goCancelRequest`（或 `cancelOrder` 被拒后 600ms 自动转入）；`cancelOrder` 报错含「取消申请」时兜底转入。

**页面结构（wxml 骨架）**：订单信息卡（订单号 / 金额 / 订单状态 / 说明「已超过可自由取消时间，需提交申请由商家判断是否同意取消」）→ 取消原因卡（textarea，`maxlength=200`，右下角 n/200 计数）→ 底部通栏「提交取消申请」按钮。

**页面要素与数据来源**：`onLoad` 取 `options.order_id` → `load()` → GET `/api/order/detail?id=`，回填 `order` 后渲染信息卡（`order.order_no` 存在才显示）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/order/cancelRequest.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 取消原因输入 | `onReason` | 同步 `reason`（textarea，`maxlength=200`，实时显示 n/200 计数） | — |
| 提交取消申请 | `submit` | 原因 trim 后必填校验（空则 toast「请填写取消原因」）→ `wx.showLoading('提交中')` → POST `/api/order/cancel-request`（`{ order_id, reason }`） | 成功 toast「已提交，等待商家处理」→ 700ms 后 `wx.navigateBack()` 返回；失败 `wx.hideLoading()` + 按 `err.message` toast |

**重点链路**：**取消申请 → 后端处理闭环**：列表/详情页判断超时后跳转本页 → 用户填原因 → POST `/api/order/cancel-request` 建申请（status 0 待处理）→ 商家端审核 → 详情页 `order.cancel_request` 卡片回显 `status_text / merchant_reply`；申请处理中时列表页对应按钮置灰「取消申请处理中」，防止重复提交。

**状态与边界**：原因必填（trim 后判空）且 ≤200 字；提交期间 `showLoading` 提示，成功/失败均 `hideLoading`；成功 700ms 后自动返回，返回后列表 `onShow` 刷新可见新状态；取消申请提交成功不代表订单取消，最终以商家处理结果为准（页面说明文案已向用户明示）。

---

[← 返回 05 页面与交互详解 索引](../README.md)
