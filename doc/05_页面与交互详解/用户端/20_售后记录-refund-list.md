# 我的售后记录
> 页面路径：pages/refund/list（用户端小程序）


**页面职责**：集中展示本人全部退款/投诉申请的进度与商家处理结果，并可跳回对应订单详情。

**进入路径**：我的页「售后记录」`goRefundList`（用户端/pages/user/profile.js）→ `wx.navigateTo('/pages/refund/list')`。

**页面结构（wxml 骨架）**：售后单卡片列表（每条：类型徽标「投诉 / 退款」+ 状态文案（处理中 warn 色 / 已完结 ok 色）→ 订单号 → 退款金额（仅退款单）→ 申请原因（超出省略）→ 商家处理（有回复时）→「查看订单 ›」链接）→ 空态「暂无售后记录」。

**页面要素与数据来源**：`onShow` → `load()` → GET `/api/refund/list`（无分页，一次性返回全部售后单）。每条记录字段：`type`（refund/complaint）、`status / status_text`、`order_no / order_id`、`amount`（退款金额）、`reason`、`merchant_reply`。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/refund/list.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 「查看订单 ›」 | `goOrder` | 读 `data-order`（`item.order_id` 存在时渲染） | `wx.navigateTo('/pages/order/detail?id=' + orderId)` |

**重点链路**：**申请 → 处理 → 结果回显闭环**：`order/refund` 页提交 POST `/api/refund/apply` 后，本页 GET `/api/refund/list` 即可见新售后单（status 0 处理中）；商家处理完成后 `merchant_reply` 与更新后的 `status_text` 在此回显；「查看订单」跳订单详情可结合 `cancel_request` 卡了解整单处理脉络。

**状态与边界**：空列表显示「暂无售后记录」；加载失败静默保持旧数据；售后类型仅退款单展示金额行，投诉单不展示；商家未回复时不渲染「商家处理」行。

---

[← 返回 05 页面与交互详解 索引](../README.md)
