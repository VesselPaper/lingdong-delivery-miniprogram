# git 交接文档 11

> 对应提交：**修复换图后点位指向失效图（改成接口驱动，代码里不留平台会变的数据）**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 说明 |
| --- | --- |
| `backend/services/points.js`（**新增**） | 点位口径唯一入口。①当前运营图 = 平台报告的**在线车所在图**（`curr_map_id`）→ 写 `meta.active_map_id`；②`loadingPointRow(store)` 上货点三级取值（运营图+有坐标 → 任意图+有坐标 → 任意图第一条）；③`anchorRow(store)` 供底图选图；④`preferIncoming()` 同步改写判定。运营图取不到时行为与改动前逐字一致 |
| `backend/services/platform-http.js` | ①新增 `resolveActiveMapId()`（每次同步按接口查在线车所在图，结果缓存 `ACTIVE_MAP_TTL_MS`，默认 2 分钟）；②`syncLandmarks` 同名同坐标去重从「先到先得」改为「**运营图优先 + 就地改写**库里那行的平台身份列」（id 不变、不新增行）；③`sort` 语义修正为「物理点位位次」；④`getMapRaw` 底图锚点改用 `points.anchorRow`；⑤同步结果多返回 `repointed/activeMapId` |
| `backend/services/batch.js` | `loadingPointOf()` 收口到 `points.loadingPointRow`（对外行为不变：前两级都排除 `(0,0)` 占位点） |
| `backend/services/platform.js` | 7 处「建任务/召唤取上货点」统一走 `loadingOf()` → `points.loadingPointRow`（原先 `ORDER BY sort LIMIT 1`，不看地图） |
| `backend/domains/delivery/queries.js` | `loadingPointFirst`（用户端追踪页路线折线起点）收口到同一入口，与批次模块取同一条记录 |
| `backend/server.js` | 点位同步日志新增「改写到运营图 N」与「运营图 <mapId>」，云端一眼能核对 |
| `backend/db.js` | 离线演示种子里的**真实**平台 id（`MID=…_1d-1` + 10 个 landmarkId，换图后已全部失效）改成 **`demo-*` 占位**（`demo-building` / `demo-map-1` / `demo-lm-01…10`），名称/楼层/类型/排序不变 |
| `backend/tests/test_points_active_map.js`（**新增**） | 28 项断言：改写 9 栋楼、sort 稳定、二次同步幂等、兜底行为、`preferIncoming` 真值表。用**假平台**（本进程 HTTP server + 随机端口）跑真实 `syncLandmarks`，不连真实平台 |
| `backend/.env.example` | 新增 `ACTIVE_MAP_TTL_MS` 开关说明 |
| `doc/03_数据库设计.md` | 种子表说明改为「演示点位用 `demo-*` 占位；配平台时表为空、由接口实时同步」 |
| `doc/07_配送平台对接.md` | §7.6 补「同名同坐标去重 + 当前运营图 + 上货点唯一入口 + 底图锚点」规则 |
| `doc/14_组单算法v2待办与实测清单.md` | 把「`loadingPointFirst` 有同样隐患、暂未改动」这条更新为已修 |
| `agent/agent交接文档/git交接文档/git交接文档11.md` | 本文件 |

**未包含**：

1. `backend/services/platform-http.js` 里**另一个 agent 正在改的 Eviz 位置兜底那 3 个 hunk**（`fetchEvizJson` / `getDevicePosition` / `getDevicePositionBySn`）。同一个文件被两处并行修改，本次用 **hunk 级暂存**（`git apply --cached`）只提交本提交需要的 6 个 hunk，未 `git add` 整文件、未用 `git commit -- <路径>`（§8 硬规矩）。对方那部分补丁留在 `_tmp4\probes\tools\platform-http.js.theirs.patch` 备查。
2. `agent/agent交接文档/会话交接文档/交接文档20.md`：上一轮会话写下的、一直躺在工作区未提交，本次先不动（见 §六）。

## 二、这次解决的真问题（换图事故，两次）

**第一层（今天上午）**：越凡把运营图换成「东苑」9 楼（`…_1d-9`），但旧图「东苑（备份）」（`…_1d-1`）上的点位记录仍在，且 `landmarkInfo` 把旧图 10 条排在前面。旧代码按「名称+坐标」去重、先到先得，于是：

- 9 栋楼 + 一个「商铺上货」的 `platform_landmark_id` 被永久钉在**备份图**上；
- 各模块按 `ORDER BY sort LIMIT 1` 取上货点 → 取到备份图 `(-0.746, 3.801)`，真实上货点在库房外 `(17.168, -3.435)`，**差 19.3 米**；
- 平台每 60s 重同步一次会把这些列全部重写 → **改数据库留不住**，只能改代码。

**第二层（负责人随后删掉备份图）**：备份图连同它的 10 个点位被删除后，平台把 9 栋楼的点位 id **全换成了新 id**（`05f66b22…` → `b8db9be9…` 等），而库里那 9 行因为「同位置重复跳过」一直保留**已删除的旧 id**。`platform_landmark_id` 正是下发平台任务/召唤用的字段（`platform.js:453`、`delivery/service.js:500`）→ **用户下到东苑各栋的订单会派车失败**。这是本次提交必须尽快上线的直接原因。

修完后的行为（云端日志可核对）：`点位已从平台同步… · 改写到运营图 9 / 同位置重复跳过 9 · 运营图 …_1d-9`。

## 三、遇到的问题 / 踩的坑

1. **"代码里不留平台的会变数据"这条要求，落地时有个坑**：把演示种子的 `platform_*` 直接清空后，`test_summon_flow` 立刻红了 —— mock/演示档建任务/召唤时 `platform.js` 会校验这三个字段非空（`platform.js:307`、`:453`）。所以最终做法不是留空，而是写**明显不是平台 id 的 `demo-*` 占位**：演示链路照常跑通，代码里也不再有任何真实平台 id；而且占位 id 与真实 id 必然不等，真接上平台时同步会按「名称+坐标」把它们就地改写成真实身份，不留幽灵点位。（这条弯路值得记：**"去掉静态数据"要先想清楚谁在消费它**，光删字段会把演示/mock 链路删坏。）
2. **同一个文件被两个 agent 并行修改**（对方的 Eviz 位置兜底在本文件里）。若按普通流程 `git add <文件>`，会把对方未完成的工作一起提交；部署包又是从**工作区**打包的，还会把半成品带上云。本提交因此：①只 hunk 级暂存自己的改动；②部署从**提交导出的干净源码树**打包，不碰对方工作区。工具：`_tmp4\probes\tools\split_hunks.mjs`（按 hunk 拆 diff + 校验能否干净套用索引）。
   - 更正一条我先前的误判：对方引用的 `httpGetBuffer` **本来就有**（`platform-http.js:497`，且已在模块导出里），所以对方那 3 个 hunk 是自洽的，不是半成品。
3. **两个 agent 同时跑 `backend/tests/`** 会撞测试里**硬编码的端口**（`test_batch_v2_e2e.js` 用 3211）。踩到的现象极具误导性：自己的 server 因端口占用起不来 → `waitUp` 却从**对方的 server** 拿到 200 → 随后 `injectCoords` 打开的是自己那个只建了 `users/meta` 的临时库 → 报 **`no such table: landmarks`**，看着像"后端起不来/建表失败"，实际是端口冲突。**结论：两个 agent 不要同时跑测试；看到这个报错先查 3211 的占用者。**
4. **测试脚本失败时会留下孤儿进程**（server 子进程不随父进程退出）。排查用 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` + `Get-NetTCPConnection -State Listen -LocalPort 3211`。
5. **`sort` 的语义陷阱**（由新测试抓出来）：同一个物理点在平台上有多条记录时，若用"原始记录行号"当 `sort`，第二条改写到同一行时又按自己的行号写 → **每重同步一次 sort 就跳一次**，`getMapRaw` 的 `ORDER BY sort LIMIT 1` 会漂回旧图那条（大屏底图跟着切）。修法是按「名称+坐标」去重后编号，同一物理点每轮位次相同。
6. **假平台测试可行**：`requestPlatform` 用 `node:http` + `PLATFORM_BASE`，所以在本进程起一个假平台、把 `PLATFORM_BASE` 指到 `127.0.0.1:<随机端口>` 就能真跑 `syncLandmarks`（不需要打桩、不碰真平台）。`platformReady()` 只看 APPID/SECRET/PRINCIPALID 是否非空，补三个假值即可。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| 新增测试 `tests/test_points_active_map.js` | **28 项全通过**（改写 9 栋楼 / 上货点取运营图 / 锚点在运营图 / 二次同步幂等 / 兜底 / 真值表） |
| 既有 10 个后端测试 | **全绿**：`test_batch_v2_invariants`(15) `test_order_ahead`(30) `test_batch_v2_timing`(25) `test_status_events` `test_audit_mw` `test_activity_draft` `test_control_ctrlid` `test_cancel_tasks` `test_batch_flow` `test_summon_flow`（改 `db.js` 种子后逐个复跑确认） |
| `test_batch_v2_e2e.js`（v2 vs legacy 对比，约 7 分钟） | 提交时**补跑中**（先前两次都被另一个 agent 的并行测试撞端口）；结果见《会话交接文档》补记 |
| `node --check` | 改动/新增的 8 个后端文件均通过（仅语法检查，不作为验证） |
| 真实平台 | **未连接、未写**：新增测试全程走假平台；本地后端未启动；本次只对云端做**只读**探针（`/tmp/cloud_*.mjs`） |

## 五、提交信息原文

```
修复换图后点位指向失效图（改为接口驱动）＋ 演示种子去真实平台 id

- services/points.js（新增）：点位口径唯一入口。当前运营图 = 平台报告的在线车所在图
  （curr_map_id，写 meta.active_map_id）；loadingPointRow 优先取运营图上「有坐标」的上货点；
  anchorRow 供底图选图。取不到运营图时与改动前逐字一致。
- platform-http.js：syncLandmarks 同名同坐标去重改为「运营图优先 + 就地改写平台身份」，
  sort 语义修正为物理点位位次（否则每轮重同步都会漂）；getMapRaw 锚点改用 anchorRow。
- batch.js / platform.js / domains/delivery/queries.js：上货点取值统一走 points.loadingPointRow
  （原先 9 处各写一条 SQL、口径不一致：batch 排除 (0,0)，platform/queries 不排除）。
- server.js：同步日志加「改写到运营图 N」与运营图 id，便于云端核对。
- db.js：离线演示种子的真实平台 id（MID=…_1d-1 与 10 个 landmarkId，换图后已失效）
  改成 demo-* 占位；名称/楼层/类型/排序不变（mock 链路的非空校验仍然满足）。
- tests/test_points_active_map.js（新增）：28 项断言覆盖改写 / sort 稳定 / 幂等 / 兜底 / 真值表。
- .env.example 新增 ACTIVE_MAP_TTL_MS；doc/03、doc/07 §7.6、doc/14 同步。
```

提交号：（见 `git log`）
是否已推送：**否**（等负责人确认后再推送）

## 六、遗留待办

1. **`agent/agent交接文档/会话交接文档/交接文档20.md` 仍未入库**（上一轮会话的现状快照，一直躺在工作区）。负责人本次说"不用着急提交"，故未纳入本次提交；下次提交时可一并补进仓库。
2. **实测前必须把车从 `interaction` 状态弄回 `idle`/`standby`/充电**：`interaction` 在 `platform-http.js` 的**忙**集合里，会让批次定型/派车/开舱全被 `isRobotBusy` 拦下。
3. **库里那条失效的旧上货点行（`id=10`，`sort=10`，坐标 `(-0.746,3.801)`，`map_id=…_1d-1`）会留在库里**：本次改动让上货点取值优先取运营图，所以它不会被选用（不影响功能）；但它对应的平台点位已被删除，属于垃圾行。**不建议手工删**（删了也不影响代码行为），可在下一次平台同步后观察是否还碍事。
4. **Eviz 网关 `COMM_500`**：取车位置/雷达失败（网关地址被拼成 `service-iot-gateway-svc<SN>`），影响大屏与用户端追踪的"车在哪"，**不影响**开舱/派车（那两条走 `/deviceCtrl/*`）。用户反馈由另一个 agent 处理。
5. **`ORDER_NO_BATCH` 是误报**：`checkInvariants` 把 `status=1`（待接单）的订单也算进"该挂批次"的候选集，而 `batch_id` 全库只在接单时写（`batch.js:345`）→ 待接单必报。建议把候选集收窄到 `status=2`（另一次改动）。同一函数里 `ORDER_STUCK` 用下单时间比 20 分钟，接单后定型前也可能误报。
6. **组单算法实测**（负责人已定）：先按线上现状 **legacy** 跑通全链路，再切 `BATCH_ALGO=v2` + `BATCH_V2_READY=true` 对比。注意 `planRouteV2` 目前直通 `planRouteLegacy`（"每趟时长上限"只作用在组批，不作用在停靠顺序）。
7. 云端还有一笔上一轮的实测残留：批次 `BD-261012-001`（`status=2 配送中`，订单 `LD-261012-0001` 送零栋库房，`picked_orders=0`，舱门从未打开，召唤任务已于 17:03 终态）。**下次实测前先把它结掉或重开**，否则订单 #1 会一直挂在"配送中"。
