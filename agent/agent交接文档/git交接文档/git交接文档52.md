提交：小程序扩容一期之后端多店地基（shop_id 收口 + 店铺上下文 + 隔离测试 + 扩容方案与调研文档）

> 编号：git 交接文档最大号 51 → 本份 52。
> 本份对应**一笔提交**（后端 + 测试 + 文档），与代码**同一次提交**（符合 AGENTS.md §8.3）。
> 提交号：**`3c75977`**（提交号本身由下一笔纯文档提交补记，见 git交接文档54）。
> 推送状态：**未推送**。需要负责人确认后再 `git push`。
> 同一轮的另半部分（用户端 / 商家端 / 大屏）在 git交接文档53（`392068b`）。

## 一、本次范围（23 个文件）

### 1. 数据结构与迁移

| 文件 | 改了什么 |
| --- | --- |
| `backend/db.js` | `shops` 补 `code`/`logo`/`category`/`address`/`pickup_landmark_id`/`min_order`/`pack_fee`/`owner_user_id`/`sort` 九列；`goods`/`orders`/`activities`/`coupons` 加 `shop_id INTEGER DEFAULT 1`；`orders` 加 `pickup_landmark_id`；`delivery_batches` 加 `shop_id` + 预留 `stops TEXT DEFAULT ''`；新建 `shop_members(shop_id,user_id,role)` + `ux_shop_members` 唯一索引，并按现有商家账号**幂等回填**；条码唯一性从"全库唯一"改成"一店一条码"（新 `idx_goods_shop_barcode_uniq`，旧全局索引 drop）；补 5 个按店索引 |
| `backend/services/shops.js`（新增，92 行） | 店铺上下文的**唯一来源**：`normalizeShopId` / `listShops` / `shopById` / `defaultShop` / `shopOfUser` / `memberRole` / `setMember` / `removeMember` / `removeAllMembers` / `nameMap`。其余域一律不自己写 SQL 判"我是哪家店" |
| `backend/domains/_shared.js` | `merchantGuard` 统一挂 `req.shopId` / `req.shopRole`；`ownerGuard` 改判 `req.shopRole`（`shop_members` 为权威，`users.merchant_role` 作兜底，保证只插了老字段的账号仍落 1 号店） |

### 2. 六个域按店收口（跨店读写一律 404，不泄露存在性）

| 文件 | 改了什么 |
| --- | --- |
| `backend/domains/goods/queries.js` | 商品/分类/活动查询全部带 `shop_id`；条码查重按店；活动归属校验 |
| `backend/domains/goods/routes.js` | 新增 `GET /shop/list`；`GET /shop/status` 支持 `?shop_id=`；`PUT /merchant/shop` 接受取货点/起送价/打包费/分类（`ownerGuard`）；活动跨店访问 404 |
| `backend/domains/goods/service.js` | `shopWithRuntime` 带上新字段；活动创建/改写的店铺归属校验 |
| `backend/domains/coupon/queries.js` | 券列表 `shop_id IN (0,?)`（0 = 平台券），商家端列表按店 |
| `backend/domains/coupon/routes.js` | `GET /coupon/list?shop_id=`；跨店改/上下架/删除 404 |
| `backend/domains/coupon/service.js` | 领券与核销校验券的店铺归属 |
| `backend/domains/order/queries.js` | `insert` 写 `shop_id` + `pickup_landmark_id`；新增 `listRefundsMerchant(store,status,shopId)` / `refundMerchantDetail` / `listCancelRequestsMerchant` / `cancelRequestMerchantDetail`，用 `JOIN orders` 收口到店 |
| `backend/domains/order/service.js` | `createOrder` 写店铺并**显式拒绝跨店商品**（「「名」不属于该店铺，请分店下单」）；`computeStats(store, shopId)` 重写，可按店统计（含退款/取消申请按 `order_id IN (SELECT …)`） |
| `backend/domains/order/routes.js` | 商家端订单/详情/异常/工作台统计/售后/取消申请全部传 `req.shopId`；两个 `handle` 入口跨店 404；`/order/list`、`/order/detail` 返回 `shop_id` + `shop_name` |
| `backend/domains/user/queries.js` | 购物车查询带 `g.shop_id` |
| `backend/domains/user/service.js` | `cartListWithPrice` 附 `shop_id` / `shop_name`（前端据此判混店） |
| `backend/domains/delivery/queries.js` | 新增 `batchByIdOfShop(store,id,shopId)`；`recentBatches` / `batchesByStatus` / `monitorTasks` 按店 |
| `backend/domains/delivery/routes.js` | 开舱/关舱/派车/mock 派车/删除/详情/待上货列表/监控/test-complete 全部按店（跨店 404，别人的批次也不出现在待上货里） |
| `backend/domains/admin/queries.js` | 新增 `allShops`、`todayOrdersByShop`；`activeBatchesOverview` 带 `shop_id`/`shop_name`；`recentEventsForBoard` 按实体反查 `shop_id`（订单/批次/任务三条子查询） |
| `backend/domains/admin/service.js` | `buildDashboard` 输出 `shops[]` + `stats.by_shop`（保留 `shop` 单店字段给老消费方）；`boardEventLine` 多店时给事件加店名前缀 |
| `backend/domains/admin/routes.js` | 商家账号新增/删除/改角色时同步 `shop_members`（建号可传 `shop_id`；删号连带清成员行，避免悬挂记录） |
| `backend/services/batch.js` | 组单按店取上货点、按店建批/选车，批次不变量加店铺校验 |
| `backend/services/points.js` | 新增 `loadingPointRowOf(store, shopId)`：本店配了取货点就用本店的，没配回退全局 |

### 3. 测试与文档

| 文件 | 改了什么 |
| --- | --- |
| `backend/tests/test_shop_isolation.js`（新增） | 10 组 61 项断言：跨店商品/订单/批次读写 404、一店一条码、公开读 `?shop_id=`、工作台统计按店、售后与取消申请按店、待上货列表隔离、老账号回落 1 号店 |
| `backend/tests/test_batch_v2_e2e.js` | 老批量接口已删除，相关两段改走 `legacyGone` 跳过分支（其余 6 项照跑，不再假失败） |
| `doc/16_小程序扩容方案.md`（新增，412 行） | 扩容方案主体 + **§十四 一期实施记录**（改动清单、验收结果、与方案的偏差、遗留） |
| `doc/地图与定位/`（3 份，新增） | 上一轮换供应商调研的三份文档（地图精度提问清单 / 换供应商复盘与选型标准 / 给下家公司的要求清单） |
| `doc/README.md` | 索引补 13~16 行（16 标注 §十四 实施记录） |
| `agent/agent交接文档/会话交接文档/交接文档29.md` | 上一轮（换供应商调研）的会话交接 |
| `agent/agent交接文档/会话交接文档/交接文档30.md` | 本轮会话交接：现状、已验证项、本机两个坑、待办 |

## 二、遇到的问题 / 踩的坑

1. **`db.js` 里重复声明 `batchCols`**：加列时又写了一遍 `const batchCols`，直接 `SyntaxError` 起不来。改成复用已有的表结构快照。
2. **`createOrder` 里 `const { landmark_id, ... }` 被同名遮蔽**：解构出了两个同名变量，运行时报重复声明。删掉多余那行。
3. **测试脚本的"假失败"**：`node tests\test_x.js 2>&1 | ...` 会把 Node 的 SQLite `ExperimentalWarning`（stderr）并入，pwsh 于是报 `[exit code: 1]`，实际全绿。判读要看输出里的「全部通过 / ✘」，不是退出码。`2>$null` 单独跑一次才能看真实退出码。
4. **`shops` 表老数据没有 `code`**：种子店铺补 `code='default'`，否则按 code 查店一律查不到。
5. **`loadingPointOf` 不能只取全局第一条**：多店后第一家店配了取货点，第二家店的批次会被派到别人的上货点。改成 `loadingPointRowOf(store, shopId)` 优先本店。
6. **`ownerGuard` 兼容性**：如果直接改成只认 `shop_members`，只插了 `users.merchant_role` 的老测试账号会全部 403。最终以 `shop_members` 为权威、`merchant_role` 作兜底。
7. **老批次会让后端每次启动都对真车重试召唤**：库里 `BD-260925-003`（9 月 25 日、状态"待上货"、真车 `R110A2603AUEQC00`）导致 pilot 档启动后持续重试。跑探针时必须 `PLATFORM_MOCK=true`，**不要用 pilot 真平台档做任何实验**。

## 三、校验记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 多店隔离 | `cd backend && node tests\test_shop_isolation.js` | ✔ 全部通过（61 项） |
| 全量回归 | 逐个 `node tests\test_*.js`（20 个文件） | ✔ 20/20（`test_summon_flow.js` 收尾文案为「全链路通过」，退出码 0） |
| 迁移演练 | `node "_tmp4\probes\tools\check_shop_migration.mjs"`（真实库副本） | ✔ 216 商品 / 143 订单全归 1 号店，成员回填 2 行，重跑幂等 |
| 语法 | `node --check` 全部改动 JS | ✔ 通过 |

大屏与小程序两端的验证记在 git交接文档53。

## 四、提交信息原文

```
提交：小程序扩容一期之后端多店地基（shop_id 收口 + 店铺上下文 + 隔离测试 + 扩容方案与调研文档）

一期目标：能接第二家店内店铺，而不改资金链路。核心是"加列 + 过滤"：
所有存量数据回落 shop_id=1，老客户端不传店铺参数时行为完全不变。

- db.js：shops 补 9 列；goods/orders/activities/coupons 加 shop_id DEFAULT 1；
  orders.pickup_landmark_id；delivery_batches.shop_id + stops 预留；shop_members
  与存量商家回填；条码唯一性改为「一店一条码」；补 5 个按店索引
- 新增 services/shops.js：店铺上下文唯一来源（归属/角色/名称映射）
- goods/coupon/order/user/delivery/admin 六域按 shop_id 收口，跨店读写一律 404
- 履约按店取上货点、按店建批与派车校验
- 新增 tests/test_shop_isolation.js（61 项断言）；test_batch_v2_e2e 适配老批量已删除
- 文档：doc/16 扩容方案（含 §十四 一期实施记录）+ doc/地图与定位 三份调研
  + 索引 + 会话交接 29/30 + 本份 git 交接
```

提交号与推送状态：

- 提交号：**`3c75977`**（`git log --oneline -3` 里两条中的第一条）
- 推送：**未推送**

## 五、遗留待办

1. 推送（需负责人确认）。
2. 云上未部署，仍为 `20261019-233008`，可 `rollback.sh` 回退。
3. 清理卡住的老批次 `BD-260925-003`（真车召唤重试源头）。
4. 起送价/打包费只入库，**未进计价链路**（二期规则确定后再写）。
