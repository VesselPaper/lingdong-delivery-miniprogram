# git 交接文档 15

> **编号说明（2026-10-12 补）**：本文件在本地提交时编号为 11；推送前 `git pull --rebase` 发现远端已有同名的
> `git交接文档11.md`（优惠券会话的提交 `6cab7c3`，**已推送、不能改号**），为避免撞号，rebase 时把本文件
> **顺延为 15**（12 已被另一个尚未提交的会话占用，13/14 属「商品删除 + 商品图」那两次提交）。**正文内容未改。**
>
> 对应提交⑤（本轮两件事合并为一次提交）：**①「停止并取消任务」从「取消不退钱」改成「未送达单取消并自动退款」；
> ② 管理员「配送数据」页整页删除**（用户定调：订单相关操作全部归商家端小程序，管理员侧不留订单/批次/任务入口）。
> 本文件与该提交一起提交。

## 一、提交范围

| 文件 | 说明 |
| --- | --- |
| `backend/domains/order/service.js` | 新增并导出 `cancelAndRefundOrder(store, deps, order, opts)`：**先真实退款、成功后才落库置 7**（失败返回 `{ok:false, stage:'refund'}`，订单保持原状），随后作废任务 + 回补库存 + 摘批次 + 平台召回，并写一条 `refunds` 自动售后记录（`type=refund`、`status=3`、`reason`/`reply` 由调用方给）。它把「取消并退款 + 自动售后记录」收成一个入口，供自动退款路径复用 |
| `backend/domains/order/routes.js` | `POST /merchant/order/exception/refund`（商家「配送异常 → 取消退款」）改为复用 `cancelAndRefundOrder`，删掉内联的「退款 → 落账 → 写售后」三段。**对外行为不变**：退款失败仍 502，落库冲突仍 409；售后 `reason` 仍是「配送异常，商家取消并退款」（作废任务的 `status_text` 由「异常退款，任务作废」变为同一句话，仅文案） |
| `backend/domains/admin/routes.js` | `POST /admin/robot/cancel-tasks` 语义收敛：① 新增 `dry_run:true` 预演（只回 `{refundable, refund_amount, delivered}`，不落任何库）；② 只对**未送达**（`0/1/2/6`）的订单走 `cancelAndRefundOrder`，并在 `failed[]` 里逐单报退款失败；③ **已送达(`3`) 的单跳过**（不退款、不关它的平台任务，交给既有「取餐超时驳回退款」）；④ 返回值新增 `refund_amount`、`skipped_delivered`，审计 detail 写明「取消并退款 N 单 ¥X / 跳过已送达 M 单」 |
| `管理员网页/js/parts/admin/09b-ops.js` | `actStopCancel` 改为两步：先 `dry_run` 拿影响范围，确认框显示「将取消并自动退款 N 单，合计 ¥X；另有 M 单已送达不退款」，确认后才真调 |
| `管理员网页/admin.js` | 上述分件的构建产物（`node build.js` 重生成；`admin-map.js` 无漂移） |
| `backend/tests/test_cancel_tasks.js` | 用例扩到 3 单：断言订单落成 `7`（原为 `5`）、写了 2 条含「小车」的售后记录、已送达单保持 `3` 且无售后记录/任务未作废、`dry_run` 不改数据、`refund_amount` 与 `skipped_delivered` 正确 |
| `doc/06_接口与数据协议/05_管理域与大屏接口.md` | 接口契约（入参加 `dry_run`、出参加 `refund_amount`/`skipped_delivered`、`dry_run` 的出参）+ 实现顺序改为 0~5 步（含退款与跳过的规则） |
| `doc/07_配送平台对接.md` | 平台对接表里该接口的说明；§9.5 追加「2026-10-12 语义收敛」一条（含商家端复用同一实现） |
| `doc/05_页面与交互详解/管理端与大屏/管理员网页/02_总览页.md` | 总览页操作表里「停止并取消任务」的交互（先预演 → 确认框 → 执行） |
| `管理员网页/index.html` | **删左侧「配送数据」导航项 + 整个 `#page-data` 区块**（三标签 / 搜索 / 活跃-历史-全部分段 / 状态筛选 / 三个面板 / 只读提示条），导航从 4 项回到 3 项（总览 / 商家管理 / 设置）；段号重排（设置=02，商家管理仍在设置之后）、顶部 meta 描述与导航注释同步 |
| `管理员网页/js/parts/admin/05-render-cards.js` | **整文件删除**（229 行：`renderDataPage / inScope / inStatus / hit / goodsNames / orderGoodsRows / batchCardHtml / orderSubCardHtml / renderBatchCards / renderOrderCards / renderTaskCards`）——它只服务配送数据页 |
| `管理员网页/js/parts/admin/02-nav.js` | 删 `PAGE_META.data`、`navTo` 里的 `renderDataPage()`、配送数据页的标签/分段/状态筛选三块接线，以及随之无用的 `fillStatusOptions / wireSearch / statusFitsActive`（`wireTabs / showPanel / setTabActive` 保留） |
| `管理员网页/js/parts/admin/03-menu.js` | 删 `ctxBatch / ctxOrder / ctxTask` 三个卡片右键菜单与只被它们使用的 `findOrder / findBatch / findTask`；保留 `showCtx / hideCtx / showRobotMenu / copyText / parseRoute / batchRouteText / currentStopText / goBatchMap` |
| `管理员网页/js/parts/admin/04-overview-ws.js` | `render()` 不再调 `renderDataPage()`；删侧栏徽标 `renderNavCount`（`#navTaskCount` 已随导航项删除） |
| `管理员网页/js/parts/admin/07-drawer.js` | **接收 `orderGoodsRows`**（原在 05 分片定义，抽屉是它唯一调用方，不搬就是断链，见 §二.6）；操作区提示文案改为「订单相关操作一律在商家端小程序」 |
| `管理员网页/js/parts/admin/09b-ops.js` | 删 `actCloseVoid / actVoid`（任务级「关闭并作废 / 仅作废」的唯一入口）；启动段删 `fillStatusOptions('batch') / wireSearch('dataSearch') / showPanel('dataPanel', …)` |
| `管理员网页/js/parts/admin/01-core.js` | 删页面级状态变量 `dataTab / dataScope / searchQ / statusFilter` 与卡片专用工具 `tag / orderTag / batchTag / taskTag / batchHeadColor / lastEventText`（抽屉在用的 `statusDotClass`、三个状态字典保留）；头部注释改写为「导航三项 + 订单相关操作一律在商家端」 |
| `管理员网页/build.js` | TARGETS 去掉 05 分片并同步注释；**CUTS 表按新分片重算**（`admin.js: [119, 193, 282, 389, 514, 723, 944, 1156, 1381]`） |
| `doc/05_页面与交互详解/管理端与大屏/管理员网页/03_配送数据页.md` | **整文件删除**（页面已不存在）；同目录 `README.md`、`00_页面骨架与通用机制.md`、`06_构建机制.md` 同步改（导航四项→三项、删页面/分片行、CUTS 数值与片间依赖表刷新、05 编号留空说明） |
| `doc/06_接口与数据协议/05_管理域与大屏接口.md` | `/admin/task/{cancel,close,void,close-void}`、`/admin/precreate/del` 标注「**管理页已无入口**，保留作兼容」（前端已不调用任何 `/admin/task/*`） |
| `doc/09_测试与回归.md` | 管理员侧回归步骤改写：不再有配送数据页，改为断言导航三项 + 产物无残留标识 + 相关接口仍可用 |
| `doc/12_安全审计报告.md` | 补注：报告提到的 `05-render-cards.js` / `orderSubCardHtml` 已随本次删除，同源 `orderGoodsRows` 搬入抽屉，原修复仍生效 |
| `agent/agent交接文档/git交接文档/git交接文档11.md`、`会话交接文档/交接文档20.md` | 本文件与本次会话快照 |

## 二、遇到的问题 / 踩的坑

1. **mock 平台每 4s 自动推进任务，探针数据会自己变**：`backend/services/platform-mock.js` 的 `mockAdvance` 按 `MOCK_STEPS` 每 4s 推进一格，派车后几分钟内 3 单全被推成「已送达」——第一次探针因此拿到「可退款 0 单 / 已送达 3 单」，用例不确定。做法：探针**在开浏览器前直接改临时库**把订单复位成「2 单未送达(2) + 1 单已送达(3)」，此时 mock 任务链已走完（`idx >= MOCK_STEPS.length` 后不再续定时器），状态稳定。
2. **单点登录把探针自己的 token 踢掉了**：探针先用 API 登录拿 `x-admin-token` 做预检，随后**页面登录**会把该会话踢下线，再拿旧 token 调 `/admin/state` 得到 401（`data` 为 `undefined`），探针崩在 `stBefore.data.orders`。做法：页面登录之后要复核数据时**重新登录**拿新 token（顺序上放在页面断言之后，避免踢掉页面会话影响日志断言）。
3. **批次计数断言得跟着新语义改**：已送达单被跳过后仍挂在批次上，`cleanBatch` 只置状态不归零计数，所以 `delivery_batches.total_orders` 是 `1`（不是原来的 `0`）。断言改成「只扣回未送达 2 单，已送达 1 单仍挂着」。
4. **退款与落库不可能严格同事务**（真实退款是外部调用）：沿用商家异常退款的既有顺序「先退款成功 → 再抢占落库」。抢占失败（订单已被别处处理）时钱已退，因此 `cancelAndRefundOrder` 显式返回 `stage:'claim'`，由调用方转 409/`failed[]`，**不静默吞**。
5. **确认框必须带数字**：一辆车常态 4~5 单，原确认框只写「取消关联订单（回补库存、摘批次）」，按下去会退掉多少钱不可见。故新增 `dry_run` 让确认框写成「N 单 / ¥X / 已送达 M 单」。
6. **分片之间有真依赖，删分片前必须查依赖表**：`doc/05_…/06_构建机制.md` 的片间依赖表写着「`07-drawer.js` 用 `05-render-cards.js → orderGoodsRows`」，核对后确认是**真断链**（抽屉第 158 行调用它，且它是全局唯一调用方）。`node --check admin.js` 只验语法，跨分片的未定义引用完全查不出来（拼接后的 IIFE 语法合法）。做法：把 `orderGoodsRows` 原样搬进 `07-drawer.js`，并在真实浏览器里 `window.openDrawer('order', <真实订单>)` 实测渲染出「商品明细」才收工。
7. **删分片必须同步重算 `CUTS`**：`build.js` 的 `CUTS` 只被 `--gen` 使用，陈旧不会让正向构建报错，但会让下一个人 `--gen` 时按错误边界切碎源码。按「各分片 `split(/\r?\n/).length` 累计」重算，并核对末项 == 产物总行数（本次 1381 行，对得上）。
8. **残留引用要扫两遍**：`Select-String -SimpleMatch` 不能配 `|` 交替（第一遍扫出「无残留」是**假阴性**），改用正则重扫才找出 `doc/05、06、09、12` 里一串已删页面/分片的引用。另外 `admin.js` 头两遍剩下的 `dataPanel`/`ctxTask` 命中其实是注释文字，改掉注释措辞后才归零。

## 三、校验记录

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 回归测试 | `backend/` 下逐个 `node tests\test_*.js`（11 个） | **全绿**；其中 `test_cancel_tasks.js` 由 35 项扩到 45 项断言全过；`test_batch_flow.js`（覆盖商家异常退款路径）通过 |
| 后端接口 | mock 后端（`PLATFORM_MOCK=true` + 临时库 + 独立端口）真调 `POST /admin/robot/cancel-tasks` | `cancelled=2`、`refund_amount=23.8`、`skipped_delivered=1`、`failed=[]`；审计 detail 与预期一致 |
| 管理页前端 | CDP 无头 Chrome 走完整链路：登录 → 机器人卡「更多操作 → 停止并取消任务」→ 确认框 → 确认执行 → 落库复核 | 全部通过：确认框文案「将取消并自动退款 2 单，合计 ¥23.80…另有 1 单已送达…」；订单 `7,7,3`；2 条「小车异常」售后记录；已送达单无售后记录、任务未作废；审计 `ok=1` |
| console 报错 | 同上探针 | 唯一一条是 `GET /api/dashboard/map-image` 502，响应体 `{"code":502,"msg":"本地演示模式无平台底图"}`——**演示档固有条目**，与本改动无关（任何 mock 后端打开管理页都会出现） |
| 管理页前端（删除后复验，新探针） | CDP 无头 Chrome：登录 → 导航结构 → 三页切换 → 机器人卡右键菜单 → `openDrawer('order', <真实订单>)` | **9/9 全过**：导航 `总览/商家管理/设置` 共 3 项、DOM 无 `#page-data / #dataSearch / #navTaskCount`、三个页面区块齐全且 `navTo` 标题正确、右键菜单 3 项（含 1 个危险项）、抽屉渲染出「商品明细」+ 缩略图（证明 `orderGoodsRows` 搬迁成功、无 ReferenceError）；console 报错 0（仅过滤掉上面那条 demo 档 map-image 502） |
| 产物残留扫描 | `Select-String` 扫 `管理员网页/admin.js` 与 `index.html` | `renderDataPage / dataPanel / navTaskCount / dataTabs / dataScope / dataSearch / ctxTask / ctxBatch / ctxOrder / actCloseVoid / actVoid / lastEventText / batchHeadColor / orderTag / taskTag / page-data / navTo('data')` 全部 **0** 命中 |
| 构建自检 | `node build.js` + `node --check admin.js` | 产物 1381 行、语法通过；`admin-map.js` 仍 382 行（本轮未动 map 分片，无漂移） |
| 平台安全 | 探针只用 `PLATFORM_MOCK=true` + 临时库 | 未触碰生产平台（AGENTS §5） |

> 探针脚本 `ld-admin-probe-seed.js` / `ld-admin-cancel-probe.js` 放在 `%TEMP%`，**不进仓库**（§9）；探针进程已清理（3219/9334 端口均已释放，无残留 Chrome）。

## 四、提交信息原文

```
管理页删除「配送数据」整页；「停止并取消任务」改为未送达单取消并自动退款

- 订单相关操作全部归商家端小程序：管理页删除「配送数据」导航项与 #page-data 整块
  （标签/搜索/分段/状态筛选、批次-订单-任务卡片渲染分片、三个卡片右键菜单、
    任务级「关闭并作废 / 仅作废」入口），导航回到三项：总览 / 商家管理 / 设置
- 跨分片函数 orderGoodsRows 随分片删除搬入 07-drawer.js（抽屉是唯一调用方，否则断链）；
  build.js TARGETS/CUTS 重算（admin.js 1381 行）
- /admin/task/* 等接口保留不动（回归测试与「一键初始化」复用），文档标注「管理页已无入口」
- 「停止并取消任务」：未送达(0/1/2/6)单取消并自动退款（先真实退款成功才置 7）+ 写 refunds 自动售后记录；
  已送达(3)单跳过不退款（交取餐超时驳回流程）；新增 dry_run 预演；返回 refund_amount/skipped_delivered
- 测试 test_cancel_tasks.js 扩到 3 单覆盖新语义；文档 doc/05、06、07、09、12 同步
- 校验：11 个回归测试全绿 + 两轮 CDP 无头浏览器探针（管理页结构 9/9、取消退款确认链路全过，0 console 报错）
```

提交号：（提交后见 `git log`）
是否已推送：**否**（待用户确认后推送）

## 五、遗留待办

1. **自动退款在演示档只是账面标记**：`realRefundOrLocal` 仅在 `order.pay_channel === 'wxpay' && deps.wxpay.enabled()` 时真退钱，否则打日志 `[refund] … 仅本地标记已退款（无可退资金）`。当前 `backend/.env` 是 `PAY_MOCK=true`，所以「已退款」没有真钱到用户账户——**上线前必须配微信支付四要素**，否则「小车异常自动退款」只是状态。
2. **退款失败无自动补偿**：见 §二.4，`stage:'claim'` 时钱已退而订单未落库，只做返回与审计留痕，未做自动对账。
3. **召唤仍可能把订单变成「已取消且不退款」**：平台把被中断的任务置 `110/150` 时，`platform-callbacks.js` 会 `cancelLocal({finalStatus:5})`。本轮按用户决定**不动召唤**。
4. **（本轮已解决）** 管理员「配送数据」页任务栏操作：已随整页删除，`actCloseVoid / actVoid` 与 `ctxTask` 一并下线；后端 `/admin/task/close-void`、`/admin/task/void` 保留（见 §一）。
5. **详情抽屉（`07-drawer.js`）现在没有入口**：它原本只由配送数据页的卡片打开（卡片没了 → `openDrawer` 全局无调用方）。保留还是删除**待用户拍板**：保留 = 189 行不可达代码 + 一个维护点；删除 = 同时下线「状态时间线」视图与 `GET /admin/timeline` 的前端唯一使用者。
6. **配送数据页的死 CSS 未清**：`管理员网页/css/` 里 `.bcard / .tcard / .cards / .empty / .seg / .readonly-hint` 等规则已无 DOM 使用者（不影响渲染）。本轮**故意不动**（删 CSS 得配视觉回归，而它对功能零风险）；要清建议单独一轮。
7. **云端仍是旧版本**：`47.108.151.96:3000` 跑的还是删除前的产物，线上「配送数据」页仍在（用户暂时无法部署）。仓库里产物已更新，部署时拉取 + 重启即可（静态文件由后端从磁盘直读，不需要额外构建）。
8. **本机未提交改动勿混入提交**：`用户端/utils/config.js`（局域网 IP）、`商家端/pages/orders/list.js`（用户自己的导航栈守卫）。提交时只 `git add` 精确路径（§8.2）；已删文件也要显式 `git add <路径>`（或在提示下用 `git rm`），别用 `git add .`。
