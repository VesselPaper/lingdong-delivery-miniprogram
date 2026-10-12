# git 交接文档 27

> 对应提交：**删除能力收口到商家端「订单异常管理」（店长专用）＋ 管理员网页移除订单/任务管理（只管机器人）**。
> 编号说明：26 号之前被并行的另一个 agent 占用，本次用 27。

## 一、提交范围

### A. 商家端：删除按钮从正常流程移除，收口到店长专用入口

| 文件 | 改了什么 |
| --- | --- |
| `商家端/pages/device/batchDetail.wxml/js` | **移除**底部「删除批次」按钮与 `deleteBatch/doDeleteBatch/canDeleteBatch`（含 `role` 引入） |
| `商家端/pages/orders/detail.wxml/js` | **移除**底部「删除订单」按钮与 `deleteOrder/canDelete/DELETABLE`（含 `role` 引入） |
| `商家端/pages/shop/settings.wxml/js` | 新增「订单异常管理」入口行（`wx:if isOwner`，店长专用；**不进首页常用功能图标区**） |
| `商家端/pages/shop/orderAdmin.{js,json,wxml,wxss}`（**新增**） | 订单异常管理页：订单/批次两个标签，可清理列表 + 二次确认清理；非店长进页面直接弹无权限 |
| `商家端/utils/api.js` | 新增 `orderAdminClear: /merchant/admin/order/clear` |
| `商家端/app.json` | 注册 `pages/shop/orderAdmin` |

### B. 后端：清理订单/批次的业务语义

| 文件 | 改了什么 |
| --- | --- |
| `backend/db.js` | orders 表迁移新增 `cancel_note TEXT DEFAULT ''`（用户可见取消原因） |
| `backend/services/orderCancel.js` | `cancelLocal` 支持 `opts.cancelNote`：取消/退款时写 `cancel_note`（幂等，只写一次） |
| `backend/domains/order/service.js` | 新增 `orderStatusText(order)`（cancel_note 存在且状态 5/7 → 「订单异常（已取消/已退款）」）；新增 `recordAutoRefund`（自动退款单落账，供跨域调用） |
| `backend/domains/order/routes.js` | **新增 `POST /merchant/admin/order/clear`**（ownerGuard）：驳回进行中任务 + 已付款先真实退款 → 订单置 7 / 未付款置 5，`cancelNote='订单异常'`，写退款单 + 审计；用户端 `/order/list`、`/order/detail` 状态文案改走 `orderStatusText` |
| `backend/domains/delivery/service.js` | `deleteBatch` 增强：批内订单**逐单按是否付款退款**（已付款→7+退款单，未付款→5），`cancelNote='订单异常'` |
| `backend/domains/delivery/routes.js` | 配送追踪 `order_status_text` 改走 `deps.order.orderStatusText` |
| `backend/server.js` | delivery 域 deps 注入 `wxpay`（deleteBatch 退款需要） |

### C. 管理员网页：移除订单/任务管理（只管机器人）

| 文件 | 改了什么 |
| --- | --- |
| `管理员网页/index.html` | 移除导航「配送数据」项、`page-data` 整节（批次/订单/任务）、设置页「危险操作」标签与面板、「一键初始化状态」按钮、详情抽屉标记；meta/注释同步 |
| `管理员网页/build.js` | 装配清单移除 `05-render-cards.js`、`07-drawer.js`（CUTS 表未同步，仅 `--gen` 用，勿再跑） |
| `管理员网页/js/parts/admin/01-core.js` | 移除 dataTab/dataScope/searchQ/statusFilter 全局变量 |
| `管理员网页/js/parts/admin/02-nav.js` | 移除 PAGE_META.data、navTo data 分支、dataTabs/dataScope/dataStatus/搜索 全部接线与函数 |
| `管理员网页/js/parts/admin/03-menu.js` | 移除订单/批次/任务右键菜单（ctxOrder/ctxBatch/ctxTask）；保留机器人「更多操作」 |
| `管理员网页/js/parts/admin/04-overview-ws.js` | 移除 renderDataPage/renderNavCount 调用与侧栏徽标、抽屉实时位置引用 |
| `管理员网页/js/parts/admin/09b-ops.js` | 移除「一键初始化」按钮接线、drawerCtx 刷新、数据页启动代码（fillStatusOptions/wireSearch/showPanel dataPanel） |
| `管理员网页/js/parts/admin/05-render-cards.js`、`07-drawer.js` | 改为说明头（不再参与构建） |
| `管理员网页/admin.js` | `node build.js` 重构建（1765 → 1172 行） |

## 二、为什么这么改（负责人 2026-10-12 定的口径）

- 商家端正常流程（上货页/订单详情/批次详情）里的删除按钮**撤掉**；
- 清理能力收口到一个**店长专用入口**（商铺设置页里，不在首页常用图标上；店员不可见，后端 ownerGuard 双保险）；
- 清理一个订单/批次时：**进行中 → 驳回任务**（统一落账作废平台任务+平台召回）、**付过钱 → 真实退款**、用户端显示 **「订单异常（已退款/已取消）」**，**绝不出现"管理员删除"**；
- 管理员网页细分后**只管机器人**：订单/任务管理页面（配送数据：批次/订单/任务）与「一键初始化」从页面移除，订单相关管理只在商家端进行。

## 三、遇到的问题 / 踩的坑

1. **edit 工具吞换行（差点炸掉整个后端）**：改 `order/service.js` 时两次"去掉结尾空行"的编辑把下一行并进了上一行 —— `const FREE_CANCEL_WINDOW_MS = ...` 被并进注释直接失效，`realRefundOrLocal` 的函数体首行被并进函数签名。前者是**运行时 ReferenceError**（服务起不来，被新测试的 server start timeout 抓到），后者语法上无害但很丑。**教训：不要用"去掉结尾换行"的编辑来"整理空白"，要么整段替换、要么只加内容。**
2. **新测试里"订单任务作废"一度验证不到**：测试环境 `BATCH_WAIT_MS=100000`，批次一直停在组单中、任务还没创建，清理自然没有任务可作废。修正：清理前先调 `POST /merchant/delivery/batch/dispatch` 定型生成任务，再清理断言任务已作废。
3. **店长/店员建号**：测试建号时把店长密码 hash 写成占位 `'x'`，登录拿不到 token → `owner.data.token` undefined。修正：两个号都用 `adminAuth.hashPassword('test123456')`。
4. **管理员网页移除是大手术，用"删 UI + 删引用 + 重构建 + 残留 grep"四步**：先改 parts（源），`node build.js` 重拼 admin.js，再 `node --check` + grep 确认没有 `renderDataPage/openDrawer/drawerCtx/fillStatusOptions/wireSearch/dataTab/navTaskCount/$('reset')` 等悬挂引用。index.html 的 meta/注释也一并更新，避免"配送数据"字样残留。
5. **并行 agent 抢号**：git交接文档 15~26 都被并行 agent 占用，本次用 27；提交前照例断言索引清单。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| 新增 `tests/test_order_admin_clear.js` | **19/19 通过**（店员 403 / 已付款退款+作废任务+退款单 / 未付款取消 / 用户端「订单异常（已退款/已取消）」/ 终态 400 / 批次逐单退款） |
| 既有 12 个后端测试 | **全绿**（含 `test_status_events`、`test_audit_mw`——它们用 `/merchant/order/delete`，未受影响） |
| `node --check` | 改动的后端文件 + 重构建的 admin.js/admin-map.js 全过（仅语法检查，不作为验证） |
| 管理员网页残留 grep | parts 目录无数据页/抽屉/一键初始化悬挂引用；index.html 无 `page-data/detailDrawer/reset` 残留 |
| 商家端残留 grep | 旧页无 `deleteBatch/deleteOrder/canDelete*` 遗留（`api.batchDelete` 仅新 orderAdmin 页在用） |
| 真实平台 | 未下发任何指令；本机后端未启动 |

## 五、提交信息原文

```
删除能力收口到商家端「订单异常管理」（店长专用）＋ 管理员网页只管机器人

商家端：上货页/订单详情/批次详情的删除按钮移除；商铺设置新增店长专属
「订单异常管理」入口（不进首页常用图标）；清理=驳回进行中任务+付款退款+
用户端显示「订单异常（已退款/已取消）」，不暴露"管理员删除"。
后端：orders 加 cancel_note；新增 POST /merchant/admin/order/clear（ownerGuard）；
deleteBatch 逐单按是否付款退款；用户端状态文案走 orderStatusText。
管理员网页：移除「配送数据」页（批次/订单/任务）与「一键初始化」，只管机器人；
订单相关管理只在商家端进行。
新增 test_order_admin_clear（19 项断言）；全量回归全绿。

配套《git交接文档27》。
```

提交号：（见 `git log`）
是否已推送：**否**（等负责人确认）

## 六、遗留待办

1. **推送到 GitHub**：本地未推的提交（地图修复/召唤熔断与持续重试/大屏若干/文案同步/本提交）等负责人确认后一起处理。
2. **商家端店员身份在微信开发者工具里实测**：店员登录 → 商铺设置无「订单异常管理」入口、且进不了该页（后端 403 兜底）。
3. **管理员网页真实浏览器回归**：部署后打开 `/admin/` 确认三页导航正常、无 console 报错（本地后端不能起，只能线上验）。
4. **订单/批次清理的确认文案与用户端展示**已在实现内；若后续要更细（如清理时选原因），在 orderAdmin 页扩展即可。
