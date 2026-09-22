# 申请退款 / 投诉
> 页面路径：pages/order/refund（用户端小程序）


**页面职责**：对已送达、已完成或配送异常的订单发起退款或投诉申请，提交后由商家处理。

**进入路径**：订单详情「退款/投诉」`goRefund`（status 3 / 4 / 6）；配送追踪「申请退款」`goRefund`（status 6，P1-4 配送异常出口）。

**页面结构（wxml 骨架）**：申请类型卡（退款 `refund` / 投诉 `complaint` 两个图标选项，高亮由 `type` 驱动）→ 订单信息卡（订单号 / 金额 / 选退款时显示「退款说明：默认退订单全额，最终以商家处理为准」）→ 原因卡（textarea，标题随类型切换为「退款原因 / 投诉内容」，`maxlength=200` + 计数）→ 底部通栏「提交申请」按钮。

**页面要素与数据来源**：`onLoad` 取 `options.order_id` → `load()` → GET `/api/order/detail?id=`；默认申请类型 `type = 'refund'`（退款），可切换 `'complaint'`（投诉）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/order/refund.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 类型选择（退款 / 投诉） | `selectType` | 取 `data-type` 设 `type`，高亮切换；选「退款」时额外显示退款说明行 | — |
| 原因输入 | `onReason` | 同步 `reason`（textarea，`maxlength=200`，计数展示） | — |
| 提交申请 | `submit` | 原因必填校验 → `wx.showLoading` → POST `/api/refund/apply`（`{ order_id, type, reason }`） | 成功 toast「已提交，等待商家处理」→ 700ms 后 `navigateBack`；失败 toast `err.message` |

**重点链路**：**退款/投诉入口矩阵 → 售后记录闭环**：订单详情（status 3/4/6）与配送追踪（status 6，配送异常出口）跳转本页 → 提交 POST `/api/refund/apply` 建售后单 → 商家处理 → 用户端「我的售后记录」页（GET `/api/refund/list`）回显处理状态与 `merchant_reply`。

**状态与边界**：原因必填 ≤200 字；类型默认「退款」；提交中 loading 防重复操作；成功后自动返回上一页；投诉与退款共用同一表单与接口（仅 `type` 字段区分），退款单展示金额，投诉单不展示。

---

[← 返回 05 页面与交互详解 索引](../README.md)
