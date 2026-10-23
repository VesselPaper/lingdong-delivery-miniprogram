提交：小程序扩容一期之前端（用户端/商家端多店改造 + 大屏店铺标识）

> 编号：git 交接文档 52 → 本份 53。
> 本份对应**一笔提交**（用户端 + 商家端 + 可视化大屏），与代码**同一次提交**。
> 提交号：**`392068b`**（提交号本身由下一笔纯文档提交补记，见 git交接文档54）。
> 推送状态：**未推送**。
> 同一轮的后半部分（后端 + 测试 + 文档）在 git交接文档52（`3c75977`），应先于本笔提交。

## 一、本次范围（28 个文件）

### 1. 用户端（16 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `用户端/utils/shop.js`（新增） | 当前店铺的唯一入口：`getShopId/setShopId/DEFAULT_SHOP_ID/withShop`（给请求自动带店铺）+ `loadShops`（缓存店铺列表）+ `toConfirm(items,onMixed)`（**结算前统一拦混店**：校验一店、写 `checkout_items`/`checkout_shop_id`、跳结算页）；`singleShopOf`/`clearCache` |
| `用户端/utils/api.js` | 加 `shopList: '/shop/list'`、`shopStatus: '/shop/status'` |
| `用户端/pages/index/index.js` | 拉店铺列表 + `?shop_id=` 的营业状态；新增 `onShopTap()` 切店（只有一家店时不显示入口）；商品/分类/券/横幅全部按店；两个下单入口改走 `shopCtx.toConfirm` |
| `用户端/pages/index/index.wxml` `.wxss` | 店名不再写死，改为 `{{shopName}}`；可切店时右侧出现「切换」+ 下拉箭头；新增 `.coupon-switch` 样式 |
| `用户端/pages/goods/list.js` `.wxml` | 分类/商品按店；`loadShopStatus` 回填 `shopName`；商城页顶栏店名改为接口下发；下单入口走 `toConfirm` |
| `用户端/pages/goods/detail.js` `.wxml` `.wxss` | 详情按店请求（`{id, shop_id}`）；顶部新增「店铺」行显示店名（`.shop-line`） |
| `用户端/pages/cart/cart.js` `.wxml` `.wxss` | 计算条目涉及的店铺数：>1 家显示 `.mixed-tip` 提示「需要分店下单」、店铺行显示「多家店铺」、每条商品带 `.item-shop` 小标签；结算走 `toConfirm` |
| `用户端/pages/order/confirm.js` `.wxml` | 从 `options.shop_id` / `checkout_shop_id` / 当前店铺三处取本单店铺；商品与服务按该店请求；下单 body 带 `shop_id`，成功后清 `checkout_shop_id`；结算页店名改为 `{{shopName}}` |
| `用户端/pages/order/list.wxml` | 订单卡店名改 `{{item.shop_name || '零栋铺子'}}` |
| `用户端/pages/order/detail.wxml` | 商品区店名改 `{{order.shop_name || '零栋铺子'}}` |

### 2. 商家端（7 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `商家端/utils/shopState.js` | 新增 `updateShop(patch)`（统一走 `PUT /merchant/shop`，不再为每个字段复制一份 try/catch）+ `getMinOrder/getPackFee/getCategory/getPickupLandmarkId/getShopName` |
| `商家端/utils/api.js` | 加 `landmarks: '/landmarks'`（选本店取货点用，公开接口） |
| `商家端/pages/shop/settings.js` | 新增「店铺经营参数」：起送价、打包费（失焦提交 + 非法值回退）、店铺分类（ActionSheet，6 类候选）、本店取货点（只列 `loadingPoint` 类型，一店一个） |
| `商家端/pages/shop/settings.wxml` `.wxss` | 新卡只在店长可见（后端 `ownerGuard`）；新增 `.seg-value` 样式与提示文案 |
| `商家端/pages/user/profile.js` `.wxml` | 店名/分类按账号所属店铺显示（先读缓存秒显，再拉后端） |

### 3. 可视化大屏（4 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `可视化大屏/index.html` | 页头标题改「零栋 · 校园无人配送调度大屏」（**去店名**，按方案 §8.2）；`<title>` 同步；左栏新增 `#shopOverview`（多店概览，单店隐藏）；订单看板新增 `#todayByShop`（分店小字）；图例「上货点」→「各店上货点」；bump `?v=`（css 3d66 / views-ui 3d48） |
| `可视化大屏/js/dashboard/views-ui.js` | 新增 `renderShopOverview(shops,stats,mainShop)`（≤1 家店整块隐藏；歇业标灰）；`renderStats` 加 `by_shop` 分店小字；`renderBatches` 批次号后加「｜店名」（与主店同名则省略）；`renderRunState` 不再改标题（`titleShop` 已移除） |
| `可视化大屏/js/dashboard/main.js` | `apply()` 把 `d.shops / d.stats / d.shop` 交给 `renderShopOverview` |
| `可视化大屏/css/dashboard.css` | 新增 `.shopSplit`（分店小字换行 + 数字高亮） |

## 二、遇到的问题 / 踩的坑

1. **首页那处"逻辑"写成了恒假表达式**：`if (!picked || shopCtx.normalize ? false : false) return` —— 运算符优先级让整个条件恒为 `false`，切店后不刷新。改成 `if (!picked) return`。
2. **店名还有四处写死**：首页改了，但商城页顶栏、结算页、订单列表、订单详情四处仍硬编码「零栋铺子」，多店后会出现"在 A 店下单、订单里写 B 店"。四处全部改为接口下发 + 空值回退。
3. **大屏标题一度自相矛盾**：早前一版把店名塞进页头（`#titleShop`），与方案 §8.2「页头去店名，全局看板」冲突——多店时页头写一家店会让人误以为只统计那家。最终按方案去掉，`<title>` 同步改。
4. **`renderRunState` 依赖 `shop` 字段**：`d.shop` 永远取 1 号店，多店后左栏"店铺"一行的语义变成"主店"，所以补了 `shops[]` + 概览块，避免误读。
5. **本机 3000 端口被占**：`gitfox.exe`（Session 0 的系统服务）监听 3000，后端 `EACCES`。探针改跑 3010，并给四个基线探针加 `DASH_BASE`（默认仍 3000，行为不变）。
6. **不要用 pilot 真平台档跑探针**：会把点位同步打到生产平台，并对真车反复重试召唤。一律 `PLATFORM_MOCK=true`。

## 三、校验记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法（11 个改动 JS） | `node --check` | ✔ 全部通过 |
| 编码（22 个改动文件） | Node 按 UTF-8 读、查 `U+FFFD` 与 BOM | ✔ 0 问题（无乱码、无 BOM） |
| 大屏键位/视角 | `node "_tmp4\probes\verify\verify_keys.mjs"` | ✔ 全部 PASS、0 console 报错、「校验一致 true」 |
| 大屏三栏布局 | `node "_tmp4\probes\verify\verify_layout.mjs"` | ✔ 全部 PASS、0 console 报错 |
| 大屏触屏手势 | `node "_tmp4\probes\verify\verify_touch.mjs"` | ✔ 全部 PASS、0 console 报错 |
| 大屏启动读服务器数据 + 自动保存 | `node "_tmp4\probes\verify\verify_fix.mjs"` | ✔ 全部 PASS、0 console 报错、「校验一致 true」 |
| 大屏多店文案（本轮新写） | `node "_tmp4\probes\verify\verify_shop_ui.mjs"` | ✔ 14 项 PASS：单店时概览/分店小字隐藏、批次不加店名；两家店时概览两行、歇业标注、单量、分店小字、批次「｜店名」、事件前缀全部正确，0 console 报错 |
| 小程序真机链路 | 微信开发者工具 | ✘ **未做**（本机无可用环境），由负责人在开发者工具里验收 |

> 四个基线探针与新增的 `verify_shop_ui.mjs` 都在负责人工作区 `_tmp4\probes\verify\`，**不在仓库**。
> 本轮给 `verify_keys / verify_layout / verify_touch / verify_fix` 加了 `DASH_BASE` 环境变量（默认 3000 不变），用于 3000 被占用时指向备用端口。

## 四、提交信息原文

```
提交：小程序扩容一期之前端（用户端/商家端多店改造 + 大屏店铺标识）

后端多店能力已在上一笔提交落地，这笔是两端小程序与大屏的实际使用侧。

- 用户端：新增 utils/shop.js（当前店铺 / 请求带店 / 混店结算统一拦截）；
  首页可切店（仅一家店时不显示入口）；商城、详情、购物车、结算、订单全部按店
  请求并显示店名；混店购物车给明确提示，结算前拦下
- 商家端：shopState 支持起送价/打包费/分类/本店取货点；店铺设置新「经营参数」卡
  （仅店长可改，取货点只列机器人能到的上货点）；「我的」按所属店铺显示店名
- 大屏：页头去店名；左栏多店「店铺概览」（店名+今日单量，歇业标灰）；
  订单看板分店小字；批次「｜店名」；实时动态多店加店名前缀；图例改「各店上货点」；
  单店时以上全部隐藏，观感与改造前一致
```

提交号与推送状态：

- 提交号：**`392068b`**（`git log --oneline -3` 里两条中的第二条）
- 推送：**未推送**

## 五、遗留待办

1. **小程序真机验收**（负责人自己做）：用户端「切店 → 加购 → 混店拦截 → 单店结算 → 支付 → 订单列表/详情看店名」；商家端「店铺设置改取货点/起送价 → 商品/订单/批次只看到本店」。
2. 推送与（需要时）云上部署。
3. 二期：起送价/打包费进计价链路、店铺列表页与店铺详情页、多点停靠。
