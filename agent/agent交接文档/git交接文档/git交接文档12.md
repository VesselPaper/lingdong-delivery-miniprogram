# git 交接文档 12

> 对应提交：**大屏地图显示真车定位 —— 平台代理接口故障时改走 EVIZ frame 兜底**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `backend/services/platform-http.js`（**仅 EVIZ 取位区域的 3 个 hunk**） | 新增 `parseEvizInner()`、`fetchEvizJson()` 与开关 `EVIZ_FRAME_FALLBACK`（默认开，`=0` 关闭）；`getDevicePosition()` 与 `getDevicePositionBySn()` 两处调用点由"直接请求平台代理接口"改为 `await fetchEvizJson(...)` |
| `agent/agent交接文档/git交接文档/git交接文档12.md` | 本文件 |

**与提交 `bd3ad30`（换图修复，见《git交接文档11》）共用同一个文件，但区域不重叠**：那次改的是 33–250 行（`pointsSvc` 接入、点位同步、`resolveActiveMapId`），本次只动 673–770 行（EVIZ 取位）。`bd3ad30` 提交时已用 hunk 级暂存把我的这 3 个 hunk 排除在外，并把我的补丁备份在 `_tmp4\probes\tools\platform-http.js.theirs.patch`。本次提交前已核对 `git diff` 里**只剩这 3 个 hunk**。

## 二、为什么这么改

**现象**：大屏地图上永远没有真车 —— `/api/dashboard/robot-positions` 恒返回 `{"robots":[],"msg":"在线车暂无有效定位"}`；而右栏车卡正常（在线、状态"召唤"、电量 98%），所以不是车掉线、不是网络、也不是"车空闲所以没坐标"（实测**车正在被召唤、批次配送中时同样没有**）。

**只读实测（2026-10-12，生产平台）**：

| 接口 | 结果 |
| --- | --- |
| `GET /open-api/v1/iotGatewayProxy/{SN}/buildingManager/om-api/EvizServer`（原先只用这条） | `COMM_500`：`I/O error on GET request for "http://service-iot-gateway-svc{SN}/…": Name does not resolve` —— 平台内部解析不到该设备的网关服务（**平台侧故障**） |
| `GET /open-api/v1/deviceRuntime/eviz/{SN}` | `COMM_200` "一切ok"，返回 OSS 上 `eviz_frame` 的**签名地址** |
| 下载该 frame 文件（7.9KB） | **纯 JSON**：`robotpose=[1106,2667,0.091]`、`locQuality=84.0`、timestamp 为当前时刻 |

结论：**平台一直有这台车的精准定位，是我们只走了一条已经坏掉的路**。改为两路兜底后，两条路返回的是**同一份 EvizServer 结构**、`robotpose` 数值相同，坐标口径不变（大屏投放与既有标定都不用改），顺带修好了开舱门禁所用的 `getDevicePosition()`。

## 三、遇到的问题 / 踩的坑

1. **frame 地址是签名 URL、约 15 分钟过期**（`Expires` 每次调用刷新）→ 必须拿到就立刻下载，地址不能缓存。
2. 平台返回的 `data` 常是「**字符串包着 JSON**」（内层序列化），必须先 `JSON.parse` 再取 `robotpose`，否则恒为空（2026-09-16 真机踩过同一个坑，本次抽成 `parseEvizInner()` 统一处理）。
3. **不要把这条兜底当成"平台已修好"**：代理接口的 `COMM_500` 是平台侧问题，需反馈越凡；我们只是不再被它卡死。
4. **两个 agent 并行改同一个文件 + 同时跑测试**（详见《git交接文档11》§三.3）：本次踩到的是 `backend/tests/test_batch_v2_e2e.js` **硬编码端口 3211**，两边同时跑会互相占用，现象是"自己的 server 起不来、却从对方的 server 拿到 200"。我这条 e2e 失败（exit=-1）**先误判为并发负载导致的超时**，后经对方查明是端口冲突；单独重跑即通过。**结论：两个 agent 不要同时跑 `backend/tests/`。**
5. 复用既有的 `httpGetBuffer()` 拿 frame 字节（原本用于底图代理下载，已带重定向与 10s 超时），不另写一套 HTTP。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| `node --check backend/services/platform-http.js` | 通过 |
| A/B 对照实测（真实平台，只读）`_tmp4\probes\tools\verify_eviz_fallback.mjs` | `EVIZ_FRAME_FALLBACK=0`（只走代理）→ **null**，复现故障；`=1`（兜底）→ **拿到位置**：`raw=[1106,2667]`、`x/y=19.042/8.477`、`locQuality=84.0`、耗时 855ms |
| 平台只读诊断 `probe_eviz_position.mjs` / `probe_eviz_frame.mjs` / `probe_mapinfo_compare.mjs` | 定位了 `COMM_500` 原文、frame 为纯 JSON、以及 `currMapId`(`…_1d-1` 备份图) 与车 frame `mapID`(`…_1d-9`) 不一致 |
| 后端回归 `test_batch_v2_e2e.js` 单独重跑 | **通过（8/8 断言，391 秒）**；全套 11 个测试因与对方并行跑撞端口未一次性跑完（见 §三.4） |
| 大屏验收探针 `probe_wall_car_state.mjs`（部署前基线） | 3 PASS / 1 FAIL —— 底图(1MB png)、地图数据(meta 5786×5406、12 点位)、在线真车均正常，**唯 FAIL 即"真车无实时定位"**（正是本次修复项） |
| 部署前版本核对 `check_cloud_matches_head.mjs` | 云端 6 个文件与 `bd3ad30` **逐一一致（差异仅为 CRLF/LF）** → 本次部署是干净的一步增量，不会回退对方修复 |
| 部署后复验 | 待办：重跑 `probe_wall_car_state.mjs` 第④项应转 PASS；再用无头 Edge 打开云端大屏，确认地图上出现该车、0 console 报错 |

## 五、提交信息原文

```
大屏地图显示真车定位：平台代理接口故障时改走 EVIZ frame 兜底

- 平台 iotGatewayProxy 对真车返回 COMM_500（service-iot-gateway-svc{SN}: Name does not resolve）
- 改为两路兜底：代理拿不到 robotpose 时走 deviceRuntime/eviz/{SN} → OSS frame 文件（纯 JSON）
- getDevicePosition / getDevicePositionBySn 两处调用点统一走 fetchEvizJson
- 开关 EVIZ_FRAME_FALLBACK=0 可只留代理路径，便于对照排查
```

提交号：（见 `git log`）
是否已推送：**否**

## 六、遗留待办

1. **把平台代理接口的 `COMM_500` 反馈越凡**（附 traceId），确认是"该设备网关服务未注册"还是"服务名拼接少一个连字符（`service-iot-gateway-svc` + 设备号）"。
2. 可选优化：代理故障时**按设备记忆**一段时间（如 5 分钟）再重试，避免每 3 秒都白打一次，取位耗时可由 ~855ms 降到 ~450ms。本次刻意不做，减少演示前改动面。
3. **实测真车前先把车从 `interaction`（或召唤待命）状态弄回 idle/standby/充电**，并结掉云端残留批次 `BD-261012-001`（见《git交接文档11》§六.2、§六.7），否则可能被 `isRobotBusy` 拦下。
4. 大屏物理上屏（1760×1200 像素 · P2）：比例 1.467 与 16:9 不同，等比适配后上下各有约 21cm 不发光带（LED 上看不出）；建议 PC 输出直接设 1760×1200，**不要**让处理器拉伸填满、**不要**加 `--force-device-scale-factor`。
