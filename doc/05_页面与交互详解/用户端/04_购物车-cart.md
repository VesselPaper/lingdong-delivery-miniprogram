# 购物车：选中 / 数量步进 / 删除 / 结算
> 页面路径：pages/cart/cart（用户端小程序）


**页面职责**：已选商品管理：勾选、数量调整、删除与结算入口。

**页面结构（wxml 骨架）**：头部「已选购商品（N件）」→ 店铺行（零栋铺子/无人车配送）→ 商品列表（勾选圈/图/名称/售罄标记/价格/步进器）→ 底部栏（全选/商品合计/去结算(N)）；空态「购物车还是空的」替代列表。

**页面要素与数据来源**：`onShow` → `loadCart()` → GET `/api/cart/list`。仅展示 `goods_status === 1` 的有效商品，`sold_out = goods_stock <= 0`；`total / origTotal` 只统计已勾选项（`total` 用折后价 `price_now`，`origTotal` 用原价，用于划线对照）；`selectCount` 为勾选件数；`allSelected` 为全部勾选；勾选项的 `{goods_id, quantity, price_now}` 存为 `checkoutRaw` 供结算使用。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/cart/cart.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 单项勾选圈 | `toggleSelect` | PUT `/api/cart/update`（`id, selected: 0|1`）→ `loadCart()` 刷新 | 合计/全选态联动 |
| 「全选」 | `toggleAll` | 逐项 PUT `/api/cart/update`（`selected` 全部置 1 或 0）→ 刷新 | — |
| 步进器「+」 | `onQuantity`（delta=1） | 售罄 toast「已售罄」拒绝；否则 PUT `/api/cart/update`（`quantity+1`） | 刷新列表 |
| 步进器「−」 | `onQuantity`（delta=-1） | 数量减到 0 → DELETE `/api/cart/remove`（整行移除）；否则 PUT `/api/cart/update`（减 1） | 刷新列表 |
| 「去结算(N)」 | `checkout` | 无勾选 toast「请先选择商品」；勾选含售罄 toast「已售罄，请先移除」；通过后写 storage `checkout_items`（勾选项的 `{goods_id, quantity}`） | `wx.navigateTo('/pages/order/confirm')` |

**重点链路**：**勾选 → 结算**：`checkout` 只把「勾选且未售罄」的商品写入 `checkout_items` 再进确认订单页；确认页 `onLoad` 读取该 storage 逐商品回源详情价。合计为展示估算，下单价格以后端权威计算为准。

**状态与边界**：空车显示「购物车还是空的」空态（底部栏隐藏）；售罄商品仍可勾选、可减量移除，但不可加量、不可结算；删除走「数量减到 0」同一路径（DELETE `/api/cart/remove`）。

---

[← 返回 05 页面与交互详解 索引](../README.md)
