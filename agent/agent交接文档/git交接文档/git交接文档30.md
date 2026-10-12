# git 交接文档 30

> 对应提交：**同步成员推送（6cab7c3..21909c3）中的「商品删除能力」+「34 张商品图」+「文档」**。
> 编号说明：29 号之前被并行 agent / 成员占用，本次用 30。

## 一、背景：这次"同步"的范围是怎么定的

成员 `hsy` 推送了 `6cab7c3..21909c3` 三个提交（`413c024` / `9f1819a` / `21909c3`），但：
- `6cab7c3`（优惠券全链路）**负责人之前明确不先要**，本次依旧**不同步**（成员的新提交都叠在它上面，所以只能挑选同步，不能整段 merge）；
- `413c024` 的「管理页删除配送数据整页」**我们自己已在 `1d11843` 做过**（实现不同），不再重复同步；它里面的「停止并取消任务改为未送达单自动退款」是**行为改动，未在负责人点名的三段内容里，本次未带**（待负责人表态）；
- 成员自己的交接文档（git交接文档13/14/15、会话22/23）因编号与本地冲突，**不引入**。

**本次同步的就是负责人点名的三段内容里我们能落地的：①商品删除能力 ②商品图 ③对应文档。**

## 二、提交范围

### ① 商品删除能力（来自 9f1819a）

| 文件 | 内容 |
| --- | --- |
| `backend/domains/goods/routes.js` | 新增 `DELETE /merchant/goods`（单条，id 支持 body/query）与 `POST /merchant/goods/batch-delete`（上限 `BATCH_MAX` 200）——店主专属 `ownerGuard` + 审计；**只删 goods 行**，`order_items` 是下单快照、历史订单照常显示，`cart` 残留行由用户端按 goods_status=1 过滤 |
| `backend/domains/goods/queries.js` | 新增 `deleteById` |
| `backend/tests/test_goods_delete.js` | 新增回归测试（成员的第 12 个，本地第 14 个） |
| `backend/tools/goods_cleanup.js` | 服务器一键清理演示种子商品：默认只预览、`--apply` 才真删且删前 VACUUM INTO 备份 |
| `backend/db.js` | **手工合并**（我们改过它）：抽出 `DEMO_GOODS` 常量（seed() 与清理工具共用同一份演示名单）、seed() 改用它、`module.exports` 加 `DEMO_GOODS` |
| `商家端/pages/goods/list.{js,wxml,wxss}` | 商品列表新增红色「删除」（仅 `isOwner`），二次确认、说明不可恢复且历史订单不受影响 |
| `商家端/utils/api.js` | **手工合并**：新增 `goodsDelete` / `goodsBatchDelete`（保留我们加的 `orderAdminClear`） |

### ② 商品图（来自 21909c3）

| 文件 | 内容 |
| --- | --- |
| `backend/seed_images/`（34 个新文件） | 13 张网络核验真图 + 21 张占位图（同品牌近似款/同品类，待日后替换），本机 216/216 商品有图 |
| `backend/db.js` | **手工合并**：`applySeedImages` 增强 —— 空图之外，**image 指向的 /store-img/ 文件已不存在**（历史坏路径/错扩展名）也按同名种子图修正，商家后台上传的 /uploads/ 一律不碰 |

### ③ 文档（来自 9f1819a / 413c024 的文档部分按需）

| 文件 | 内容 |
| --- | --- |
| `doc/01_产品与页面总览.md` | 商品删除能力补记 |
| `doc/05_页面与交互详解/商家端/15_商品管理-goods-list.md` | 删除按钮说明 |
| `doc/06_接口与数据协议/01_用户与商品接口.md` | DELETE /merchant/goods 接口说明 |
| `doc/06_接口与数据协议/04_商家接口.md` | batch-delete 接口说明 |
| `agent/agent交接文档/git交接文档/git交接文档30.md` | 本文件 |

**未包含**：优惠券全套；`413c024` 的管理页删除（已由 `1d11843` 覆盖）与其「取消任务自动退款」行为改动；成员自己的交接文档；AGENTS.md（本地 AGENTS.md 有并行 agent 未提交的改动，测试数等它那边提交时一起带）。

## 三、遇到的问题 / 踩的坑

1. **成员的提交叠在优惠券之上，不能整段 merge**：`6cab7c3`（优惠券）不在本地历史里，直接 pull/merge 会把券带进来。只能**文件级挑选** + 对双方都改过的文件（db.js、api.js）**手工合并**。
2. **db.js 手工合并**：成员在 6cab7c3（含券表）基础上改 db.js，我们在 72cb732（无券表、有 cancel_note 迁移）基础上改 db.js。不能整文件 checkout（会把券表 + 丢掉 cancel_note）。逐块合：DEMO_GOODS 常量、seed() 改用、applySeedImages 增强、导出。**改完跑全量测试确认没把结构改坏**。
3. **api.js 手工合并**：成员加 goods 删除三行，我们加过 orderAdminClear，两边不同行，直接叠加。
4. **goods/list.wxml 基准核验**：先 `git diff 6cab7c3 HEAD -- 商家端/pages/goods/list.wxml` 确认本地 = 券版（我们 4b26d18 同步过它的文案清理），再确认成员版相对 6cab7c3 只加了删除按钮 → 整文件 checkout 安全。
5. **成员交接文档撞号**：git交接文档13/14/15、会话22/23 都是成员在自己分支（基于 72cb732）上写的，编号与我们本地冲突，不引入（各自保留自己那份）。
6. **413c024 的行为改动需要负责人表态**：`「停止并取消任务」改为未送达单取消并自动退款` —— 改的是 admin 机器人「停止并取消任务」的后端行为（backend/domains/admin/routes.js + order 域）。本次**没有同步**，等负责人说要不要。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| 成员新增 `tests/test_goods_delete.js` | **通过** |
| 既有 13 个后端测试（含 `test_order_admin_clear` 等） | **全绿**（14/14） |
| `node --check` | db.js / goods 域 / test / tools 全过 |
| seed_images | 216 个文件（成员口径：216/216 商品有图、URL 全 200） |
| 商家端 goods/list.js | 确认含 `isOwner` 门控 + `deleteGoods`（调 `request.del(api.goodsDelete)`） |
| 真实平台 | 未下发任何指令；本机后端未启动；清理工具未在本机对任何库执行 |

## 五、提交信息原文

```
同步成员推送中的「商品删除能力」+「34 张商品图」+「对应文档」

成员 6cab7c3..21909c3 推送，但 6cab7c3（优惠券）负责人明确不先要，
413c024 的管理页删除我们已在 1d11843 做过，故只挑选同步：
- goods 域新增 DELETE /merchant/goods 与 POST /merchant/goods/batch-delete（店主专属+审计，
  只删 goods 行，历史订单快照/购物车引用不动）+ tools/goods_cleanup.js（--apply 才真删且先备份）
  + tests/test_goods_delete.js
- seed_images 补 34 张（13 真图 + 21 占位）；db.js applySeedImages 增强：空图与坏路径一并修正
- db.js / 商家端 api.js 与本地改动手工合并（保留 cancel_note / orderAdminClear）
- 同步 4 处文档

配套《git交接文档30》。
```

提交号：（见 `git log`）
是否已推送：**否**（等负责人确认）

## 六、遗留待办

1. **413c024 的「停止并取消任务→未送达单自动退款」**：未同步，等负责人表态（同步的话单独提一个提交）。
2. **AGENTS.md 测试数**：成员改成了 13 个；本地 AGENTS.md 有并行 agent 未提交改动，等它提交时一起带（或负责人指定谁来改）。
3. **推送到 GitHub**：本地未推的提交已累积较多（地图修复/召唤/删除能力收口/本提交 + 并行 agent 的大屏多个），等负责人确认后统一 `git pull --rebase` 处理。
4. **21 张占位图**：全网找不到原图，成员已注明待日后替换（真图替换时直接换 seed_images 文件 + 名称匹配即可）。
