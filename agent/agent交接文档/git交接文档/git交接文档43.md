提交：合并 origin/main（成员线的优惠券/商品删除/商品图）并解 11 处代码冲突

## 一、本次提交是什么

这不是一次普通提交，是 **merge 提交**：把远端 `origin/main` 上的 4 个成员提交合进本地 `main`。

| 项 | 值 |
| --- | --- |
| 本地合并前 HEAD | `8ff0604`（本次会话前三个文档提交之后） |
| 远端 HEAD | `origin/main` = 含 `6cab7c3`(优惠券全链路) `413c024`(删配送数据页) `9f1819a`(商品删除) `21909c3`(34 张商品图) |
| merge-base | `72cb732` |
| 合并方式 | **merge（不是 rebase）** |
| 合并规模 | **82 files changed, 5995 insertions(+), 498 deletions(-)** |
| 冲突数 | **11 个代码文件**（文档撞号已在 `6afe8e9`/`8ff0604` 先行解决，详见《git交接文档40》《git交接文档42》） |

合并进来的内容（按目录）：

| 目录 | 文件数 | 主要内容 |
| --- | --- | --- |
| `用户端/` | 29 | 优惠券领取页、购物车弹层组件（`components/cart-panel/`）、活动页、下单确认页可选券 |
| `backend/` | 13 | 券域（模板/用户券/最优券与优惠分摊）、自动退款收口 `cancelAndRefundOrder`、相关接口与测试 |
| `商家端/` | 13 | 券管理页、商品删除入口、文案简化 |
| `管理员网页/` | 10 | 删除「配送数据」整页；`停止并取消任务` 改为「先 dry_run 预演 → 显示将退款 N 单 ¥X → 再确认」 |
| `doc/` | 9 | 删《03_配送数据页.md》、页面骨架/构建机制/管理域接口文档同步 |
| `agent/` | 7 | 成员侧的会话与 git 交接文档 |

> **注意**：负责人此前对优惠券的态度是「不想要」，本轮决定是「先跳过：本轮不做优惠券」。
> 这次 merge **把成员那套券整链带进来了**（不是新写，是已经被成员推到远端、且已经在生产上跑着的代码）。
> 本次**未改动其任何语义**。要不要保留/下线，属于产品决策，见 §七 待办第 4 条。

## 二、11 处冲突逐个怎么解的（本节是本文档的核心）

先说明**判定原则**：不能用「git 说谁改了」定，要用「两边各自想干什么」定。
所以对每个文件都先取三方内容（`merge-base` / `HEAD` / `origin/main`）逐段看过再动。

### 1. `商家端/utils/api.js`（1 处，纯注释）

两侧是**同一处改动**：都为 `goodsDelete` 加了注释。代码完全一致，只有注释文字不同。

**取远端**：`// 删除商品（店主专属，真删行）：DELETE 单条 body {id}；批量 DELETE 走 goodsBatchDelete`
（远端那句写明了 DELETE 的 body 形状和批量走哪个键，比本地那句信息多。）

### 2. `backend/domains/order/service.js`（2 处）

**第 1 处**：本地新增了 `recordAutoRefund()`，远端新增了 `cancelAndRefundOrder()`。
两侧**都是新增、都还在用**，git 把两个函数体压成了「二选一」，实际必须**全要**。

**第 2 处**：`module.exports` 里各自导出自己的新函数，同样**合并导出**，并加注释说明谁是谁：

```js
// 自动退款与取消：两侧各自新增，别丢任何一个 ——
// `recordAutoRefund`（本地：异常管理清理入口复用）、`cancelAndRefundOrder`（远端：取消并退款+售后记录）
applyOrderCancelled, realRefundOrLocal, cancelAndRefundOrder, splitOrderChunks,
orderStatusText, recordAutoRefund,
```

**为什么必须全要（已核实调用点，不是猜的）**：

| 函数 | 调用点 |
| --- | --- |
| `recordAutoRefund` | `backend/domains/delivery/service.js:648` |
| `cancelAndRefundOrder` | `backend/domains/admin/routes.js:461`、`backend/domains/order/routes.js:471` |

任一缺失 → 对应路径运行到就 `TypeError`。只取一边的解法会直接打断「停止并取消任务」或「退款」。

### 3. `backend/db.js`（2 处，纯注释）

**第 1 处**：`DEMO_GOODS` 常量上方的说明注释，两侧是同一次提取（本地写「成员 hsy 提取」，远端没署名）。
**取远端**（不把个人名字写进代码注释，也说明了行格式对应下方 `insGoods`）。

**第 2 处**：远端在「补商品种子图」注释里多了一个空 `//` 分隔行，**取远端**（可读性更好）。

### 4. `管理员网页/js/parts/admin/01-core.js`（1 处，注释）

`liveRobots` 这行注释：本地写「供地图小车/机器人卡显示」，远端写「供抽屉显示实时位置」。

**我先验证了它到底有没有人读**（用脚本扫全目录、排除定义/赋值/注释行）：

| 分支 | `liveRobots` 的真实读取点 |
| --- | --- |
| 本地 HEAD | **无** —— 只被赋值（`04-overview-ws.js:90`），从未被读取 |
| origin/main | `07-drawer.js:52` |

结论：本地删掉抽屉后，**这个变量已经是死变量**（地图渲染走的是 `window.mapOnLive` 直推，不读它）。
两条旧注释**都不准确**。于是**两边都不取，改写成事实**：

```js
// WS live 推送的机器人位置。当前**只赋值、无人读取**（渲染改走 window.mapOnLive 直推地图，
// 读它的唯一消费者 07-drawer 已随「配送数据」页一并移除）——留作兜底，别当成在用。
var liveRobots = []
```

### 5. `管理员网页/js/parts/admin/02-nav.js`（2 处，注释）

两侧都在删「配送数据」导航项，注释详略不同。**均取远端**（远端写清了「整页删除」的原因；另一处写明了「机器人控制页已移除：控制权与点位同步均由业务自动管理」）。

### 6. `管理员网页/js/parts/admin/03-menu.js`（1 处）

本地在删 `ctxOrder/ctxBatch/ctxTask` 处**加了说明注释**，远端是**纯删除（没有注释）**。
**取本地** —— 保留「为什么没有这些菜单」的说明，否则后来人会以为是漏了。
（这正是仓库 `AGENTS.md` §4.4「注释解释为什么」的口径。）

### 7. `管理员网页/js/parts/admin/05-render-cards.js`（modify/delete 冲突）

远端**删除**该文件（`413c024` 删「配送数据」整页）；本地把它**清空成 4 行说明注释**（同样是删页面，只是留了文件）。

两者意图一致（都要这页消失），**直接 `git rm` 删除**，理由与「文件已无任何引用」已核实：
全目录 grep `renderDataPage|dataTab|renderOrderCards|renderTaskCards|renderBatchCards` → **0 命中**，
`build.js` 清单里也已不含它。

### 8. `管理员网页/js/parts/admin/07-drawer.js`（1 处）

远端**仍在用**抽屉（209 行完整实现，且 `build.js` 清单里保留 07）；
本地把文件**清空成 4 行说明注释**（因为整页删了，抽屉没有入口）。

**取本地（移除），并把恢复条件写进文件注释**，方便日后要恢复时不用重新考古：

```js
// 2026-10-14 合并说明：远端那条线**仍在用**抽屉（build.js 清单里也留着 07）。
// 本次按本地口径（更新的一方：整页删除「配送数据」）保持移除。若日后要恢复抽屉，要同时做三件事：
//   ① build.js 清单补回 'js/parts/admin/07-drawer.js'
//   ② index.html 补回 #detailDrawer / #drawerTitle / #drawerBody 三个节点（本次取的是本地版，已无这些节点）
//   ③ 06 片 logout() 里的 closeDrawer() 调用本次已删除（本地线删抽屉时漏删，会 ReferenceError），恢复时要加回
```

### 9. `管理员网页/build.js`（1 处）

`TARGETS` 装配清单：本地已移除 `05-render-cards` 与 `07-drawer`，远端仍列 `07-drawer`。
**取本地（两者都不列）**，与 §7/§8 的处置一致，并补注释说明这是合并取舍。

### 10. `管理员网页/index.html`（2 处）

- `<meta name="description">`：本地写的是「机器人状态监控、商家账号管理与操作日志」，远端写的含「状态时间线、危险操作」。
  **取本地** —— 那两项（时间线抽屉、危险操作页）本次都按本地口径移除了，取远端就成了假的描述。
- 左侧导航块注释：两侧都在说明「三项 / 配送数据已删」。**取远端**（远端把「为什么连任务级操作也不留」写清楚了）。

### 11. `管理员网页/admin.js`（1 处，**最大的一个：212 行**）

`admin.js` 是 `build.js` 把 `js/parts/admin/*.js` **拼出来的构建产物**（不是手写文件）。
合并时 git 一边看到「本地删了 07 片对应内容」，一边看到「远端新增了 07 片内容」，
于是把两边的 `admin.js`（构建产物）也当成源码去三方合并，产生了 212 行的冲突块。

**处理方式：不手工改这个产物。**
1. `git checkout --ours -- 管理员网页/admin.js` 先取本地构建产物；
2. 把 11 处冲突在**源码 parts** 里全部解完；
3. 跑 `node build.js` **重新生成** `admin.js`（1153 行）与 `admin-map.js`（382 行）。

`node build.js` 同时重新生成了 `admin-map.js`，**结果与索引逐字节一致**（无实际改动）——
说明 `map` 系列 parts 在这次合并里没有语义变化，可放心。

重建后核实 `admin.js`：`openDrawer`/`renderDrawer`/`drawerCtx`/`detailDrawer`/`drawerTitle`/`drawerBody`
/`renderDataPage`/`dataTab`/`actCloseVoid`/`actVoid` **全部 0 命中**，抽屉痕迹干净清除。

## 三、合并过程中**额外发现并修掉的一个真 bug**（不是冲突，是本地线自己漏的）

`管理员网页/js/parts/admin/06-refresh-token.js` 的 `logout()` 里有一行 `closeDrawer()`，
但抽屉（07 片）已在 2026-10-12 随「配送数据」页删除 —— **这个函数已经不存在了**。

后果：点「退出登录」时 `closeDrawer()` 抛 `ReferenceError`，**把它后面的 `showLogin()` 和日志一起中断**
（用户看到的表现是「点了退出没反应」）。这是本地那条线删抽屉时的漏网之鱼，两个分支都没发现，
因为两边都没跑过「退出登录」这条用例。

**本次删除该行并加注释说明**（恢复抽屉时要加回）。

## 四、校验记录（全部实跑，无一项靠推断）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check` × `db.js`/`order/service.js`/`商家端api.js`/`admin.js`/`admin-map.js`/`build.js` | 全部 exit 0 |
| 残留冲突标记 | 全仓库扫 `^<<<<<<< HEAD$`（排除 vendor/`miniprogram_npm`/`node_modules`/`agent`） | **0 命中** |
| 本机自检 | `node backend/tools/selfcheck.js` | **0 项 ✗**，3 项 ⚠（都是既有的降级项：无天地图 TK、无 `admin-calib.json`、用户端无本地账号） |
| 后端回归 | `backend/tests/` 全部 16 个（除 `test_batch_v2_e2e.js`） | **16/16 通过，失败数 0** |
| 慢速 E2E | `node tests\test_batch_v2_e2e.js` | **🎉 全部通过（8 项）**，详见下方 |
| 大屏布局 | `node _tmp4\probes\verify\verify_layout.mjs` | **总判定：全部通过**，0 console 报错 |
| 大屏键位 | `node _tmp4\probes\verify\verify_keys.mjs` | **总判定：全部通过**，**校验一致 true**，0 console 报错 |
| 三入口 | 起 `node server.js` 后请求 `/admin/`、`/dashboard/`、`/admin/admin.js`、`/admin/admin-map.js` | 全部 **200**（/admin/ 27138 字节、admin.js 56386 字节、admin-map.js 17665 字节） |
| 接口在不在 | `/api/admin/state`、`/api/merchant/stats` | **401**（接口在，只是没带 token；401 即证明路由已挂） |
| **管理端真实浏览器** | `node _tmp4\probes\verify\verify_admin_login.mjs` | **总判定：全部通过**；登录/SSO 踢下线/自动弹回登录页均 PASS；**console 报错 0 条** |

其中 `verify_admin_login.mjs` 是自己起临时库 + 临时后端（3197 端口）+ CDP 无头 Edge 跑的，
**验证的是本次合并重建后的 `admin.js`**，所以它同时证明「构建产物没坏」与「页面无白屏」。

## 五、提交信息原文

```
合并 origin/main：成员线（优惠券/商品删除/商品图/删配送数据页）并入本地

冲突 11 处，逐个解：
- order/service.js：两侧各自新增的函数 recordAutoRefund 与 cancelAndRefundOrder 全部保留并导出
  （已核实二者都还有调用点，缺一即 TypeError）
- 管理员网页：按本地口径（整页删除「配送数据」）移除抽屉与卡片渲染；
  05-render-cards.js 删除、07-drawer.js 清空并写明恢复条件、build.js 清单同步、index.html 描述同步
- admin.js 是 build.js 的构建产物，不手工改：git checkout --ours 后跑 node build.js 重新生成
- db.js / 商家端 api.js / 01-core.js / 02-nav.js：注释择详者保留；liveRobots 已核实为死变量，注释改写为事实
另修一个本地线漏掉的 bug：06 片 logout() 调用已删除的 closeDrawer() 会抛 ReferenceError，
导致退出登录中断（本次删除该行）。

校验：16/16 后端测试通过 + selfcheck 0 项 ✗ + 三入口 200 + 管理端真实浏览器探针全部通过（0 console 报错）。
```

## 六、提交号与推送状态

- 提交号：**`f45883f`**（merge 提交）
- 是否已推送：**是**。2026-10-14 已推到 `origin/main`（推送范围 `21909c3..f45883f`，含本次会话 4 个提交）。
  同步的备份分支：`backup/pre-algo-rework-2026-10-14` → `ab7fff0`（改造前基线，本地与远端都在）。

**慢速 E2E 实测数据（顺手验证了 v2 相对 legacy 的优势，对下一个里程碑有用）**

```
指标                  v2      legacy
批次数                 9       3
平均件数               3.7     11.0
平均站点数             2.6     7.3
平均行程(分)          12.8    31.5
最大行程(分)          14.9    34.6
★ 超过15分的批次        0       3
没进批次的订单          0       0
```

8 项断言全部通过，包含：v2 档确实跑在 v2 上（日志无「回落 legacy」警告）、v2 没有一趟超过 15 分钟、
v2 没有订单漏在批次外、对照组有效（legacy 确实产生 3 个超 15 分钟批次）。
**注意**：legacy 的「3/3 个多站批次超过 15 分钟」是它的已知缺陷，不是本次合并引入的回归。
另有 1 项信息性输出不算断言：`ℹ️ legacy 有 3 / 3 个多站批次超过 15 分钟`。

## 七、遗留待办

1. **合并后必须补跑一次大屏探针**（`verify_keys.mjs` / `verify_layout.mjs`）：本次合并动了
   `管理员网页/`，**没动** `可视化大屏/`（已核实该目录 0 冲突、0 改动），但三入口同进程托管，
   合并后仍应确认大屏未被牵连。
2. **优惠券的归属要拍板**（见 §一 的提醒）：本次是被动合并进来的，未改语义。
   若决定下线，要单独一次提交，别和算法改造混在一起。
3. `git交接文档40/41/42` 里的「提交号」栏与「是否已推送」栏还没回填（当时按规范先留空，
   推送时一并补）。这三份已提交，若要回填需再开一次文档提交。
4. 编号规范建议（取号前先 fetch、按远端最大号 +1）仍待负责人拍板，未改 `AGENTS.md`。
5. 下一个里程碑：**组单算法 v2 转正 + 删除 legacy + 上货点改用真实配送任务**（已获负责人批准的方案）。
