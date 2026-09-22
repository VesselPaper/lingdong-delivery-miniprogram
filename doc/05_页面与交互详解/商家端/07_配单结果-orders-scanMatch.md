# 扫码配单结果页（旧入口保留）
> 页面路径：pages/orders/scanMatch（商家端小程序）


- **数据来源**：`onLoad` 存 `id`；`onShow` → `shopState.loadShop()` + `load()` → GET /api/merchant/order/detail?id=。
- **页面构成**：头部「扫码配单结果 / 已匹配到待接单订单，请确认接单」；「订单信息」卡（订单号 / 送达点位 / 收餐人 / 金额）；「商品明细」卡（图 + 名称 + 数量 + 价格）；底部「确认接单」主按钮 + 「查看订单详情」描边按钮。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 确认接单 | confirmOrder | 歇业拦截 → POST /api/merchant/order/confirm `{id}` | 成功 toast「已接单，机器人出发」→ 700ms `wx.navigateBack()` |
| 查看订单详情 | goDetail | — | `wx.redirectTo` → /pages/orders/detail?id=（替换当前页，避免栈堆积） |

- **重点链路**：扫码配单流程的旧入口页面，展示匹配到的待接单订单并确认接单，接单走与详情页/任务页相同的 `/api/merchant/order/confirm`。当前主流程已被「上货配单」批次化流程取代，本页保留以兼容旧扫码入口。
- **状态与边界**：`loading` 期间不渲染订单卡；歇业时按钮文案「店铺歇业中」并置禁用（`btn-disabled`），点击逻辑同样有 `shopOpen` 拦截。

---

[← 返回 05 页面与交互详解 索引](../README.md)
