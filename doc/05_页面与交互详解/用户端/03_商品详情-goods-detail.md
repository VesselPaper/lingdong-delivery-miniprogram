# 商品详情：数量步进 + 加购
> 页面路径：pages/goods/detail（用户端小程序）


**页面职责**：商品信息与价格构成展示，步进器直接操作购物车数量。

**页面结构（wxml 骨架）**：商品大图（点击全屏预览）→ 信息卡（名称/售罄徽标/价格行/活动标签/省多少/库存提示 + 步进器）→ 配送说明卡 → 免责声明卡 → 底部栏（价格/配送费明细入口/去结算）；费用明细弹层为浮层。

**页面要素与数据来源**：`onLoad` 取 `options.id` → `loadDetail()` → GET `/api/goods/detail?id=`（成功后 `wx.setNavigationBarTitle` 为商品名）；`onShow` → `loadCartQty()` → GET `/api/cart/list`，定位本商品行得到 `cartQty`。`applyPrice` 内 `fetchFee()` → GET `/api/shop/status`（`needAuth: false`，失败兜底 1 元），按 `sale_price < price` 判定活动价，算出 `discountLabel / saveAmount / deliveryFee / unitPayable`（单件到手价 = 活动价 + 配送费）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/goods/detail.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 商品大图 | `previewImage` | `wx.previewImage` 全屏预览（可缩放/保存） | — |
| 底部「配送费…明细」/费用明细弹层 | `toggleFeeDetail` | 展开/收起费用明细面板（原价/优惠/配送费/单件到手价，附「配送费按整单收取一次」说明） | — |
| 步进器「+」 | `onStep`（delta=1） | 售罄 toast 拒绝；购物车已有该商品 → PUT `/api/cart/update`（`id, quantity+1`）；没有 → POST `/api/cart/add`（`goods_id, quantity: 1`） | 成功后 `loadCartQty` 刷新步进器数量 |
| 步进器「−」 | `onStep`（delta=-1） | 数量 >1 → PUT `/api/cart/update`（减 1）；数量为 1 → DELETE `/api/cart/remove`（整行移除） | 成功后 `loadCartQty` 刷新 |
| 底部「去结算」 | `goCart` | — | `wx.navigateTo('/pages/cart/cart')` |

**重点链路**：**加购即改购物车**：详情页没有独立的加购按钮，数量增减直接写后端购物车；步进器显示的是当前在车数量（`cartQty`），与商城/首页角标同源（`/api/cart/list`）。费用明细把「原价 / 活动优惠 / 配送费 / 单件到手价」拆开呈现，配送费按整单收取一次，不随件数增加。

**状态与边界**：售罄（`stock <= 0`）时：顶部「售罄」徽标、「库存为 0，暂不可下单」提示、步进器「+」禁用、底部按钮变「已售罄」并禁用；未加购时「−」为禁用态；配送费接口失败用兜底值 1.00，不阻塞商品展示。

---

[← 返回 05 页面与交互详解 索引](../README.md)
