# git 交接文档 9

> 对应提交③：**消灭"我这儿行他那儿不行"（成员环境依赖 + 静默失败）**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `backend/services/bootstrap.js`（**新增**） | 非 `production` 档首次启动自动补齐三个默认账号（管理员 `LDPZadmin`、商家端 `LDPZmar1`、用户端 `LDPZstu1`）并把账号密码打印到控制台；幂等；`BOOTSTRAP_ACCOUNTS=0` 关闭；账号密码可用 `BOOTSTRAP_*_USERNAME/_PASSWORD` 覆盖。**`production` 档不自动建号**（默认口令上生产是真事故） |
| `backend/tools/selfcheck.js`（**新增**） | 一条命令列出"clone 后必配清单"：Node 版本、依赖、`.env`、启动守卫、`data/` 各文件、账号数、大屏资源、双端小程序地址。只读、无副作用、不连平台 |
| `backend/server.js` | `backend/.env` 缺失时**自动**从 `.env.example` 复制一份（已存在绝不覆盖）；启动时调用默认账号自举 |
| `backend/services/mapRecon.js` | 重构数据**文件存在却读不出来**时 `console.warn`（以前静默回退内置地图，表现为"负责人那边楼是新的、成员那边是旧的"且毫无线索） |
| `backend/services/platform-http.js`（**仅 `loadAutoCalib` 那一段 hunk**） | 标定文件存在却读不出来时 `console.warn`（以前静默回退全局 POS_CAL，车/点位整体偏移而界面无提示） |
| `可视化大屏/js/dashboard/main.js` | 新增 `wakeMap()`：**启动时无条件先建地图渲染器**（不再等接口成功）→ 工具栏按钮随之可用；接口失败把原因写进地图提示条；位置轮询失败限流告警（首次 + 每 30 次） |
| `可视化大屏/js/map3d-gl.js` | 雷达底图 png 加载失败不再静默：告警 + 把原因写进地图遮罩 |
| `可视化大屏/index.html` | `map3d-gl.js?v=3d85→3d86`、`js/dashboard/main.js?v=3d61→3d63`（改前端 JS 必须 bump） |

## 二、为什么这么改

负责人报的现象是"很多功能在我这儿正常，成员拉下来就失效，典型是点『雷达图』没反应"。根因不是权限也不是网络，而是**静默失败**：

- 缺 `.env` 时后端直接 `exit(1)`，报的是"运行模式与开关组合不合法"，完全看不出真因（实际是少了 `.env`）。
- 大屏的 3D 渲染器（连带走工具栏所有按钮的事件绑定）只在第一次 `renderMap()` 里创建，而 `renderMap()` 原先只被"接口成功后的 `apply()`"调用 → 后端没起时地图区永久停在"地图数据加载中…"、按钮全死、**console 一条报错都没有**。
- 标定/重构数据读取失败、雷达底图加载失败都是静默回退，出问题时零线索。

## 三、遇到的问题 / 踩的坑

1. 本提交与提交①**共用 `platform-http.js`**：本提交只取 `loadAutoCalib` 那一段 hunk（提交①已把虚拟车相关 hunk 提交走）。提交后 `git diff` 里应只剩这一段。
2. `.env` 自动复制必须"**已存在则绝不覆盖**"：否则会覆盖成员或服务器上真实的凭据文件——这是数据丢失级别的事故。
3. `bootstrap.js` 必须在启动守卫**之后**调用（守卫会因为"没有管理员且非 demo 档"直接退出），顺序写错会导致自举根本没机会跑。
4. 大屏改 JS 必须同时 bump `index.html` 里的 `?v=`，否则浏览器拿缓存，成员会以为"改了没生效"。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| 本提交实际文件清单 | 8 个（含 `platform-http.js` 的部分 hunk） |
| `.env` 自举探针 `verify_env_bootstrap.mjs`（临时目录副本，不碰真实 `.env`） | 9/9 通过 |
| 大屏"后端不可用"探针 `verify_map_offline.mjs` | 修复前 `canvas 数=0`、按钮全死；修复后地图正常、按钮可反复开关、提示条写明"后端未连接"、0 console 报错 |
| 大屏基线 `verify_keys.mjs` + `verify_layout.mjs` | 全部通过、0 console 报错、服务器地图数据 sha256 原样还原 |
| `node backend/tools/selfcheck.js` | 实跑通过（并查出负责人本机两处隐藏降级） |
| 本轮是否重跑 | **未重跑**（本轮只做提交拆分，未改任何代码） |

## 五、提交信息原文

```
消灭"我这儿行他那儿不行"：缺 .env 自动补、默认账号自举、静默失败留痕

- server.js：backend/.env 缺失时自动从 .env.example 复制（已存在绝不覆盖）
- 新增 services/bootstrap.js：非 production 档首次启动补默认账号并打印，解决 clone 后没人能登
- 新增 tools/selfcheck.js：一条命令列出 clone 后必配项与缺项后果
- mapRecon / loadAutoCalib：文件存在却读不出来时 console.warn（以前静默回退）
- 大屏：启动即建地图（不再等接口）、雷达底图失败告警、bump ?v=
```

提交号：（见 `git log`）
是否已推送：**否**（四个提交一起推送）

## 六、遗留待办

- `selfcheck.js` 里"仓库里是**占位符**"的措辞已过时（`config.js` 现在默认指向云端后端），且服务器上跑时会因没有小程序目录而报两条 `✗`，属正常——待小改（需负责人批准）。
