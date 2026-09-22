# 商城（tab）：左分类右商品联动 + 搜索 + 加购步进器 + 底部购物车栏
> 页面路径：pages/goods/list（用户端小程序）


**页面职责**：左右分栏的商品售卖页，承担搜索、分类联动、步进器加购与购物车悬浮栏。

**页面结构（wxml 骨架）**：顶部搜索区 → 店铺卡（名称/歇业标记/起送与配送费/营业时间）→ 主体左右分栏：左 `side` 分类栏（scroll-view）、右 `main` 商品滚动区（`scroll-into-view` 分组定位，组内商品卡含图/名/库存销量/价格/活动标签/步进器）→ 底部购物车悬浮条；历史面板与飞入小球为浮层。

**页面要素与数据来源**：`onLoad` 读 storage `goods_focus`（=1 则搜索框自动聚焦）、`loadHistory()`、`loadCategories()` → GET `/api/goods/categories`。`onShow` 同步 tab `selected: 1`，读取并消费 storage `goods_category / goods_keyword`（首页跳转带入，`pendingCategory` 暂存分类）；`loadGoods()` 并行 GET `/api/goods/list` + GET `/api/cart/list`（失败容错为空，构建 `cartMap` 得到各商品在车数量 `qty`）；`loadShopStatus()` → GET `/api/shop/status`（`shopClosed` 歇业标记、配送费兜底 1.00）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/goods/list.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 搜索输入（实时） | `onSearch` | 更新 `keyword` 并立即 `loadGoods()` 过滤 | 命中商品名或分类名（`indexOf` 匹配） |
| 键盘搜索键 | `onSearchConfirm` | `saveHistory(keyword)` + `loadGoods()` | 写 storage `search_history` |
| 历史标签 | `onHistoryTap` | `saveHistory(kw)` + 置关键词 + `loadGoods()` | 收起历史面板 |
| 无结果分类建议词 | `onSugTap` | `saveHistory(kw)` + 置关键词 + `loadGoods()` | 直接按分类搜索 |
| 历史清空/遮罩/聚焦展开 | `clearHistory` / `closeHistory` / `onSearchFocus` | 管理 `showHistory` 与 storage `search_history` | — |
| 左侧分类项 | `onCategoryClick` | 置 `scrollLockUntil`（500ms 滚动锁）→ `activeCategory` 高亮 → `mainTo = 'group-' + idx` | 右侧 `scroll-into-view` 滚动到对应分组 |
| 右侧商品滚动 | `onScroll` | 依据 `groupTops` 计算当前分组，联动左侧高亮 | 滚动锁期间不响应（防回弹） |
| 商品图加载完成 | `onImageLoad` | 延迟 80ms `_measure()` 重测分组标题位置 | 分类跟随不滞后 |
| 商品卡片 | `goDetail` | 读取 `data-id` | `wx.navigateTo('/pages/goods/detail?id=' + id)` |
| 步进器「+」/首加「+」 | `onStep`（delta=1） | 售罄商品 toast 拒绝；乐观 `bumpItem` + `bumpCartMap` 本地先变，POST `/api/cart/add`（`goods_id, quantity: 1`，对已在车的商品为累加）；`flyCart.flyAfter` 飞入动画 | 成功 `scheduleReconcile()` 320ms 后重拉对账 |
| 步进器「−」 | `onStep`（delta=-1） | 本地无该购物车行时先 `scheduleReconcile(0)` 拉真实数据；有行则：减后数量 >0 → PUT `/api/cart/update`（`id, quantity`）；减到 0 → DELETE `/api/cart/remove`（`id`） | 失败回滚 `bumpItem` 返回的还原函数 |
| 底部购物车条 | `goCart` | — | `wx.navigateTo('/pages/cart/cart')` |

**重点链路**：

- **搜索命中规则**：`loadGoods` 中 `keyword` 非空时，过滤条件为「商品名含关键词 或 分类名含关键词」（如搜「零食」命中分类「饼干零食」下全部商品）；无结果时给出前 4 个分类建议词（`noResultSugs`），点词即搜索该分类。
- **加购步进器与角标一致性**：`onStep` 先 `bumpItem`（改步进器 `qty` 与角标合计）+ `bumpCartMap`（维护 `cartMap` 目标数量，连点时后续请求携带的是累加/递减后的目标值，避免多个请求拿同一旧基数互相覆盖）→ 按目标数量选路（add/update/remove）→ 失败回滚快照 → 成功后防抖重拉 `loadGoods` 对账（连点只重拉一次）。
- **分类联动**：`computeTops`/`onImageLoad` 维护 `groupTops`，`onScroll` 随滚动高亮左侧分类；点击左侧分类时用 500ms 滚动锁抑制滚动事件反向干扰。
- **首页带入定位**：`pendingCategory` 在数据加载完成后定位到对应分组（`onCategoryClick` 触发 `mainTo` 滚动）。

**状态与边界**：售罄商品 `sold_out = stock <= 0`：显示「售罄」角标、步进器「+」禁用（已加购的仍可「−」减量），未加购时显示灰色禁用加购钮；搜索无结果显示空态；活动商品拼出「X折 / 已省¥」标签（`discount_label / save_amount`）；销量为 0 显示「暂无销量」、库存为 0 显示「售罄」；`onUnload` 清理飞入与对账定时器。

---

[← 返回 05 页面与交互详解 索引](../README.md)
