# 首页（tab）：搜索入口 + 分类图标 + 热门商品流 + 加购与购物车角标
> 页面路径：pages/index/index（用户端小程序）


**页面职责**：聚合「搜索→商城、分类直达、热门商品流、一键加购、购物车角标与楼栋选择」的首页。

**页面结构（wxml 骨架）**：顶部定位行（可切楼栋）+ 搜索框（含历史面板与遮罩）→ 福利卡「零栋铺子」→ 分类图标行 → 按分类分组的商品流（每组「更多」+ 商品卡）→ 底部购物车悬浮条（cartCount>0 时出现）；楼栋选择弹层与加购飞入小球为浮层。

**页面要素与数据来源**：`onLoad` 仅 `loadHistory()`（读本地 storage `search_history`）。`onShow` 并发拉取：`loadGoods()` → GET `/api/goods/list`（分组取每类前 4 个热门商品）；`loadCart()` → GET `/api/cart/list`（`cartCount` 为数量合计，`cartTotal` 用后端折后价 `price_now` 计算）；`loadCategories()` → GET `/api/goods/categories`；`loadAddress()` → 有 token 时 GET `/api/address/list`，公开接口 GET `/api/landmarks`（过滤 `type === 'deliverPoint'` 的送达点位）并 GET `/api/user/point` 取当前楼栋（失败回退本地 storage `user_point`）；`loadShopStatus()` → GET `/api/shop/status`（`needAuth: false`，取配送费，兜底 1.00 元）；最后同步 tab `selected: 0`。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/index/index.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 顶部定位行 | `openPointPicker` | 展开楼栋选择弹层 | 弹层列表 = `points`（送达点位 + 关联地址的收件人/电话） |
| 弹层选楼栋 | `onPickPoint` | `rememberPoint` 写 storage `user_point`（landmark_id/name/addrId）→ 更新顶部文案 → `syncPoint` PUT `/api/user/point`（未登录静默跳过）→ toast「已切换至」 | 与我的页收货地址、结算页送达楼栋三处联动 |
| 弹层「清除选择」 | `clearPoint` | 移除 storage `user_point` → 顶部回「楼栋未填写」→ `syncPoint('')` 清后端 | — |
| 弹层遮罩/关闭 | `closePointPicker` | 收起弹层 | — |
| 搜索框点击/聚焦 | `onSearchTap` / `onSearchFocus` | 聚焦输入框并固定展开历史面板（`showHistory: true`） | 展示历史搜索标签 |
| 搜索输入 | `onSearchInput` | 记录 `keyword` | — |
| 键盘搜索键 | `onSearchConfirm` | `goSearch(关键词)`（空词则 `clearKeyword` 退出搜索态） | 见下方重点链路 |
| 搜索清除图标 | `clearKeyword` | 清空关键词、收起历史面板 | — |
| 历史标签 | `onHistoryTap` | 以该词 `goSearch(kw)` | 同上 |
| 历史清空 | `clearHistory` | 移除 storage `search_history` 并清空面板 | — |
| 历史遮罩 | `closeHistory` | 收起历史面板、退出聚焦 | — |
| 福利卡（零栋铺子） | `goAll` | 清空 storage `goods_category / goods_keyword / goods_focus` | `wx.switchTab` 商城 `/pages/goods/list` |
| 分类图标 / 分组「更多」 | `goCategory` | storage `goods_category = 分类名`，清空关键词与焦点标记 | `wx.switchTab` 商城 |
| 商品卡片 | `goDetail` | 读取 `data-id` | `wx.navigateTo('/pages/goods/detail?id=' + id)` |
| 商品卡「+」加购 | `addCart` | 售罄则 toast「已售罄」；否则 `bumpCart(1, 单价)` 乐观更新角标 + `flyCart.flyAfter` 飞入动画，POST `/api/cart/add`（`goods_id, quantity: 1`），失败调用回滚函数恢复 | 成功后购物车悬浮条角标/合计更新 |
| 底部购物车条（cartCount>0 显示） | `goCart` | — | `wx.navigateTo('/pages/cart/cart')` |

**重点链路**：

- **首页搜索 → 商城搜索**：`goSearch(kw)` 先 `saveHistory(k)`（写 storage `search_history`，去重置顶、上限 8 条）→ 写 storage `goods_keyword`、清空 `goods_category`、`goods_focus = 0` → `wx.switchTab('/pages/goods/list')`。商城页 `onShow` 读取并**消费**这三个键（读后 `removeStorageSync`），用关键词过滤商品并定位分类。
- **加购 → 购物车角标**：`addCart` 本地先 `bumpCart` 让角标数字与飞入动画同步，请求失败回滚；真实金额下次 `onShow` 由 `loadCart` 以 `price_now` 对账刷新。飞入动画由 `用户端/utils/flyCart.js → flyAfter` 实现：小球从触点飞向 `#cart-bar-icon` 中心（520ms 弧线），落地后购物车图标弹跳 + 角标跳动（类名交替保证连点也逐次播放）。
- **配送楼栋三处联动**：首页选楼栋 = 写本地 `user_point` + PUT `/api/user/point`；结算页、我的页地址列表读取同一后端字段，任一处修改其余两处下次进入即同步。

**状态与边界**：未选楼栋时顶部显示「楼栋未填写」而非默认校区名（避免误导已选好）；楼栋列表接口 `needAuth: false`，未登录也可先选（本地缓存兜底）；`deliveryFee` 取不到时兜底 1.00 元；购物车条仅 `cartCount > 0` 时渲染；`onUnload` 调 `flyCart.clear` 清理动画定时器。

---

[← 返回 05 页面与交互详解 索引](../README.md)
