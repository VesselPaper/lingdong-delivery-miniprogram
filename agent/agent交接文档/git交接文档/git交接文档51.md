提交：大屏点位错位修复（锁定小地图）+ 回归校园视角（el22/zoom0.85/楼体透明）+ 运行日志改读后端 status_events

> 编号：git 交接文档最大号 50 → 本份 51。
> 本份对应**三笔提交**（同一轮会话、同一主题：大屏）。
> **规矩偏差说明**：仓库 AGENTS.md §8.3 要求《git交接文档》与代码**同一次提交**。
> 本轮先提交了三笔代码、再补这份文档（第四笔）。原因是三笔提交在批准后立即推送了，
> 事后再改历史要 force push，而 force push 是明确禁止的。以后请在同一次提交里带上文档。

## 一、本次范围

### 提交 1 · `b55c6ca` 大屏点位错位修复（2 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `backend/services/platform-http.js` | 新增 `PLATFORM_ACTIVE_MAP_ID` 锁图：配了就一直用这张图，不再跟随"在线车所在图"自动切；`getMapOverview` 给每台车补 `map_id` / `not_on_map`；`getPlatformLandmarks` 只取当前图的点位；修掉 `pixelInside` 里 `meta` 先使用后声明的 TDZ 隐患 |
| `backend/.env.example` | 补 `PLATFORM_ACTIVE_MAP_ID` 说明 |

### 提交 2 · `5dc7a12` 回归校园视角 + 楼体默认半透明（1 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `可视化大屏/js/map3d-gl.js` | `resetView` 俯仰 30→22、缩放 0.75→0.85；`roofFade` 默认改 `true`；楼顶淡出曲线由 `(el-20)/25` 改为 `0.60 - 0.18*t`；`m3Fade` 按钮绑定与点击都同步 `on` 类 |

### 提交 3 · `d1e8b86` 运行日志改读后端 status_events（7 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `backend/domains/admin/queries.js` | 新增 `recentEventsForBoard(store, limit)`：`ORDER BY created_at DESC, id DESC LIMIT ?`，条数夹在 1..200 |
| `backend/domains/admin/service.js` | `buildDashboard` 输出 `log_events`（`{id,t,s,old}`）；今天 `HH:MM:SS`、非今天 `MM-DD HH:MM` 且 `old:true`；条数由 `DASHBOARD_EVENTS_LIMIT` 控制（默认 20）；查询异常退回 `[]`，不影响总览 |
| `可视化大屏/js/dashboard/views-ui.js` | 删掉 `diffEvents` / `pushEvent`，改成 `applyEvents`（后端给什么画什么）+ 纯渲染 `renderEvents`；顺带渲染"不在此地图"的车卡 |
| `可视化大屏/js/dashboard/main.js` | 不再维护 `prev` 快照；`apply()` 直接取 `overview.log_events`；新增 `splitRobots`，只把在本图的车交给 3D 层 |
| `可视化大屏/js/dashboard/shared.js` | 去掉 `prev` / `MAX_EVENTS`，加 `offMapRobots` |
| `可视化大屏/css/dashboard.css` | 新增 `.eventList .eTime`（原来写的 `.eventList time` 从来没命中过）、`.eventList li.old`、`.vcard.offmap`、`.robotStatus.s-warn` |
| `可视化大屏/index.html` | 按需 bump `?v=`（css 3d65 / shared 3d64 / views-ui 3d46 / main 3d66 / map3d-gl 3d92）；`m3Fade` 补 `class="on"` |

> `index.html` 同时服务提交 2（`map3d-gl.js` 的 `?v`）和提交 3（其余 `?v`），为避免 hunk 级拆包，整个文件放在提交 3。

## 二、遇到的问题 / 踩的坑

1. **点位整体偏移的真因是"两张地图"**：平台正在扩建，同一栋楼挂了两张图 —— 小图 `..._1d-99`（5786×5406，12 个点位）、大图 `..._1d-98`（16042×16677，17 个点位）。唯一在线车 `R110A2603AUEQC00` 上报的 `currMapId` 是**大图**，自动跟随就切到了大图，而底图还是小图，于是 `kw=2.772554`、`kh=3.084906` 不相等，点位越靠边偏得越多。锁定小图后 `kw=kh=1.0000`。
2. **点位重复去不掉**：东苑的点位在两张图上各存了一份（坐标差几厘米），按 `name|x|y` 去重认不出来，结果给了 23 条。改成在数据源头过滤 `p.mapId !== actMap`，正好 11 条。
3. **TDZ 坑**：`pixelInside` 用到的 `const meta` 声明在下面 40 多行，真跑会抛 `Cannot access 'meta' before initialization`。把 `meta` 块提到过滤之前，删掉重复声明。
4. **楼体透明"看起来没效果"**：淡出曲线是 `(el - 20) / 25`，俯仰降到 22 时只有 8% 淡出，等于没开。改成 `0.60 - 0.18*t`（el22≈0.556、el45≈0.49、el80≈0.42），低俯仰也看得出来。
5. **按钮状态反了**：`roofFade` 默认改成 `true`，但 `m3Fade` 没有初始 `on` 类 —— 用户看到"关"，第一次点反而是把效果关掉。绑定和点击都同步 `on`，HTML 上补 `class="on"`。
6. **`.eventList time` 是死选择器**：模板渲染的是 `<span class="eTime">`，这条 CSS 从来没有生效过（历史遗留）。这次补上 `.eTime`。
7. **日志排序有坑**：`id 31`（2026-10-08）比 `id 30`（2026-09-28）新，说明 id 顺序不等于时间顺序。排序改成 `created_at DESC, id DESC`。
8. **跨天时间会误导**：本地库里最新事件是 10-09、云上是 10-13，只显示 `HH:MM:SS` 会被当成"刚刚"。非今天的显示 `MM-DD HH:MM` 并置灰 `old`。
9. **服务器 `.env` 被写坏过一次**：用 `printf "\n..."` 追加把字面量 `n#` 写进了文件，变量也没写进去。改用 Node 脚本（`fs.readFileSync` / `writeFileSync`）按字节改，幂等。
10. **探针误报 FAIL**：`verify_offmap_card` 抓到的是另一张同 SN 的车卡；`verify_cloud_mapfix` 的阈值还是重复点位时代的 `inN >= 20`。都按新口径改了断言。
11. **PowerShell 的 `[exit code: 1]` 有时是假失败**：`node` 往 stderr 打 `ExperimentalWarning: SQLite is an experimental feature`，被判成错误，实际探针判定是"全部通过"。

## 三、校验记录

本机（全部 0 console 报错）：

| 探针 | 结果 |
| --- | --- |
| `verify_view_fade.mjs` | 通过。`viewState` = `{az:11.0418, el:22, panX:0, panY:0, zoom:0.85}`；滑块 22；`roofFade` true；按钮 `on`；楼体透明前后像素差异 **24.18%** 面积（噪声本底 2.74%，均值 1.401 vs 5.438） |
| `verify_resetview.mjs`（改口径到 22/0.85） | 通过。T1 楼栋名、T2 充电/上货点名可见，T3 取货点名按预期隐藏 |
| `verify_keys.mjs` | 通过，含「校验一致: true」 |
| `verify_layout.mjs` | 通过 |
| `verify_fix.mjs` | 通过，含「校验一致: true」 |
| `verify_board_log.mjs`（临时库 + 3199 端口） | 通过。刷新后日志仍在（证明已不依赖浏览器内存） |

云端（版本 `20261019-233008`）：

- `verify_cloud_view.mjs` 全绿：`el=22`、`zoom=0.85`、滑块 22、`roofFade` true、按钮 `on`、地图仍是小图 5786、0 console 报错。
- `/api/dashboard/overview` 实测：`meta = {width:5786,height:5406,resolution:0.05,origin:[-37.331894,-137.285003]}`、`landmarks=11`、`robots=1`、`log_events=20`，最前三条是 10-13 的批次/订单事件且 `old:true`。
- 截图：`_tmp4\shots\cloud-view-new.png`。

后端回归：`node _tmp4/probes/tools/run_backend_tests.mjs`（18 个 `test_*.js`）全绿。

## 四、提交信息原文

提交 1 `b55c6ca`：

```
提交：大屏点位错位修复（锁定小地图 1d-99，kw/kh 回到 1:1）

越凡平台正在扩建地图，同一栋楼挂了两张图：
小图 1257237128126592_zcsdb3dd6396c824_1d-99（5786x5406，12 个点位）
大图 1257237128126592_zcsdb3dd6396c824_1d-98（16042x16677，17 个点位）

唯一在线车 R110A2603AUEQC00 上报 currMapId 是大图，自动跟随就切到了大图，
但底图还是小图 5786x5406，于是换算系数 kw=2.772554 / kh=3.084906 不相等，
点位越靠边偏得越多。

- 新增 PLATFORM_ACTIVE_MAP_ID：配了就锁定这张图，不再跟随在线车所在图
- 大屏底盘与业务仍用小图，backend/.env 填小图 mapId
- getMapOverview 顺带给出每台车的 map_id / not_on_map
- getPlatformLandmarks 只取当前图的点位（东西两苑在大图上重复一份，去重去不掉）
- 修掉 pixelInside 里 meta 先使用后声明的 TDZ 隐患

云端实测：meta 为 5786x5406、kw=kh=1.0000、11 个点位全部在界内、0 个越界、无重复。

注意：扩建完成后要换大图时，把 PLATFORM_ACTIVE_MAP_ID 改成大图的 mapId
（或留空恢复自动跟随），并重新标定大图底图。
```

提交 2 `5dc7a12`：

```
提交：大屏回归校园视角更平视更紧凑（el 30→22、zoom 0.75→0.85）+ 楼体默认半透明

- resetView 默认俯仰 30 → 22，缩放 0.75 → 0.85（更接近人眼高度、画面更满）
- roofFade 默认改为开，首次进入就是半透明楼体
- 楼顶淡出曲线重调：原来是 (el-20)/25，俯仰降到 22 时只有 8% 淡出、等于没效果；
  改成 0.60 - 0.18*t（el22 约 0.556，el45 约 0.49，el80 约 0.42），低俯仰也看得出来
- 修掉「效果默认开着、按钮却显示关」：绑定和点击都同步 on 类，HTML 上补 class="on"

实测：el22 时楼体透明前后像素差异 24.18% 面积（噪声本底 2.74%），0 console 报错。
```

提交 3 `d1e8b86`：

```
提交：大屏运行日志改为读后端 status_events（刷新不丢、多屏一致）

原来的日志是前端自己比对上一次快照算出来的差分，只活在浏览器内存里：
刷新就没了，多块屏各算各的，也没有留痕可查。

后端：
- admin/queries.js 新增 recentEventsForBoard，按 created_at DESC, id DESC 取最近 N 条
- admin/service.js 输出 overview.log_events，字段精简为 { id, t, s, old }
  t 是今天则 HH:MM:SS，不是今天则 MM-DD HH:MM 并标 old（本地库里有 9 月的老数据，
  只显示时分秒会误当成今天）
- 条数由 DASHBOARD_EVENTS_LIMIT 控制，默认 20；查询失败退回空数组，不影响总览

前端：
- views-ui.js 删掉 diffEvents / pushEvent，改成 applyEvents + 纯渲染 renderEvents
- main.js 不再维护 prev 快照，直接取 overview.log_events
- 非今天的事件加 old 类置灰
- 修掉从来没能命中的 .eventList time 选择器（实际渲染的是 span.eTime）

写入逻辑没动，仍是 services/statusEvents.js 原有轮询 + audit 留痕。
```

## 五、提交号

`b55c6ca`（点位错位） → `5dc7a12`（视角 + 透明） → `d1e8b86`（日志持久化）

## 六、是否已推送

是。`git push origin main` 后复核 `git status -sb` = `## main...origin/main`（0 ahead / 0 behind），`origin/main` = `d1e8b86874253228daa1c7586f205d35c6c31e6e`。

## 七、遗留待办

1. **换大图时要重做标定**：扩建完成后把 `PLATFORM_ACTIVE_MAP_ID` 改成大图 mapId（或留空恢复自动跟随），并重新标定大图底图。西苑 2/3/4、5/6 栋目前只在大图上，是被有意过滤掉的。
2. **`el=22` 已接近平视，主要遮挡是墙（原本 26% 透明）而不是楼顶**。如果还要更"通透"，该调的是墙体 alpha，不是楼顶。
3. `doc/文档/进度报告2.docx` 仍是未跟踪文件（本轮没碰，也没提交）。
