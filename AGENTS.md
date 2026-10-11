# AGENTS.md · 送餐无人车 / 校内快递配送机器人

> 本文件放在 **git 仓库根**，随代码一起同步给所有成员。
> 任何 AI 客户端（DSH / Codex / Cursor / Zed / Copilot / Claude 等）在本仓库里工作时，**请先读完本文件再动代码**。
> 它只回答三件事：**东西放在哪**、**代码怎么写 / 怎么拆**、**提交和验证有什么硬规矩**。
> 最后更新：2026-10-11。

---

## 0. 开工前先读这四份

| 顺序 | 文件 | 作用 |
| --- | --- | --- |
| 1 | 本文件 `AGENTS.md` | 工程规范：目录、拆分、提交、验证（长期有效） |
| 2 | `README.md` | 怎么启动、怎么导入微信开发者工具、多人协作流程、常见问题 |
| 3 | `agent/agent交接文档/会话交接文档/` 里**编号最大**的那份 | 项目**当前现状**与待办（编号越大越新，本文件不重复现状） |
| 4 | `agent/agent交接文档/git交接文档/` 里**编号最大**的那份 | 最近一次提交改了什么、踩了什么坑 |

> 现状类信息（跑到哪一步、什么还没做）**只写在交接文档里**，不要抄进本文件，避免两份内容打架。

---

## 1. 项目一句话

校园场景的**无人车送餐 / 校内快递配送**系统：用户在微信小程序下单 → 商家端接单备货 → 后端把配送任务下发给**越凡（robox）开放物流平台** → 真实无人车执行配送 → 一台挂在办公室的**可视化大屏**实时展示车辆轨迹与订单状态。

后端是**一个 Node 进程**，同时托管三个前端：小程序接口 `/api`、管理员网页 `/admin/`、可视化大屏 `/dashboard/`。

---

## 2. 怎么跑起来

```powershell
# 1) 后端（端口 3000）
cd backend
node server.js          # 或直接双击仓库根的「启动服务器.bat」

# 2) 回归测试（改配送 / 订单后必跑）
cd backend
node tests\test_batch_flow.js     # 其余 test_*.js 同理

# 3) 小程序：微信开发者工具分别导入 用户端\ 与 商家端\
# 4) 管理员网页 http://localhost:3000/admin/    大屏 http://localhost:3000/dashboard/
```

- **Node 必须 ≥ 22.13**（建议 24 LTS）。后端用的是 Node 内置 `node:sqlite`（`backend/db.js`），低于该版本起不来。
- 依赖只有 `express` + `cors`，无编译型模块，`cd backend && npm install` 即可。
- 本地配置写在 `backend/.env`（**不进仓库**，见 §6）。

---

## 3. 目录结构：每个文件夹放什么

| 路径 | 放什么 |
| --- | --- |
| `backend/server.js` | 唯一入口：装配中间件、挂载各域路由、静态托管三个前端 |
| `backend/db.js` | 建库 / 迁移 / 语句封装（`node:sqlite`，已开 WAL） |
| `backend/domains/<域>/` | **按业务域分层**，现有五个域：`admin`、`delivery`、`goods`、`order`、`user`。每个域内部固定是 `routes.js`（HTTP 入口）+ `service.js`（业务）+ `queries.js`（SQL），按需加 `timers.js`（定时器）、`live.js`（实时推送）。域内共用的小工具放 `domains/_shared.js` |
| `backend/services/` | **跨域共用能力**：平台对接 `platform.js` / `platform-http.js` / `platform-mock.js` / `platform-callbacks.js`、组单 `batch.js`、虚拟车 `virtualRobot.js`、推送 `push.js`、运行时开关 `runtime.js`、订单取消 `orderCancel.js`、状态事件 `statusEvents.js` 等 |
| `backend/tests/` | 可直接 `node` 跑的回归测试 `test_*.js`（10 个） |
| `backend/tools/` | 运维小工具（建管理员、生成分类图标等） |
| `backend/data/` | **不进仓库**：`lingdong.db`（+ `-wal`/`-shm`）、`map-recon.json`（大屏 3D 重构）、`admin-calib.json`（定位标定） |
| `backend/seed_images/` `backend/uploads/` | 种子商品图（**在仓库里**）/ 运行时上传（**不进仓库**） |
| `用户端/` `商家端/` | 两个微信小程序。`pages/<页面>/{js,json,wxml,wxss}`；`utils/api.js` 是**接口定义清单**、`request.js` 请求封装、`config.js` 环境地址、`pay.js` 支付；`components/` 自定义组件；`custom-tab-bar/` 底部栏；`miniprogram_npm/` 第三方编译产物（**别手改**） |
| `管理员网页/` | 原生 web。`admin.js` 是入口装配，实际功能按块放在 `js/parts/admin/`、`js/parts/map/`；样式在 `css/`；`vendor/` 第三方库（**别手改**） |
| `可视化大屏/` | **零构建** vanilla JS + WebGL2 3D 地图。`index.html` 用 `<script src="...?v=xxx">` **按顺序**加载：`js/dashboard/`（外壳 `main.js`、接口 `api.js`、地图 `map.js`、视图 `views-ui.js`、共用 `shared.js`）、`js/map3d-gl.js`（3D 主渲染）、`js/scene3d/`（相机/数学/三角化）、`js/gl3d/recon.js`（3D 重构）、`assets/`（底图与标定，`map-calibration.js` **不进仓库**）、`deploy/`（大屏机启动脚本与看门狗）、`configs/default.js`（多租户预留模板，**暂不接入**） |
| `simulator/` | 模拟小车：`run.js` / `simple.js` / `lib/` |
| `doc/` | 项目文档：编号件 `01_…` ~ `14_…`（产品、架构、数据库、状态字典、测试回归等）+ 专题子目录 `04_核心业务链路/`、`05_页面与交互详解/`、`06_接口与数据协议/`、`上线计划/`、`逻辑树/` |
| `agent/agent交接文档/` | `会话交接文档/`（每次会话追加一份）、`git交接文档/`（每次提交新增一份）；`agent/理思路文件夹/` 是链路梳理笔记 |

### 3.1 新增代码该放哪（落位规则，别随手扔）

- **后端新功能** → 在 `backend/domains/` 下建/进对应域，写进 `<域>/routes.js` + `service.js`；跨域复用的能力才放 `backend/services/`。
  **不要**往 `server.js` 里堆业务逻辑，也不要写进别人的域。
- **管理员网页新面板** → `管理员网页/js/parts/admin/`（地图相关放 `js/parts/map/`），并在 `admin.js` 里注册。
- **大屏新模块** → `可视化大屏/js/dashboard/`（外壳与数据）或新建 `js/<模块>/`，并在 `index.html` 里按加载顺序注册 + **bump `?v=` 版本号**。
- **小程序新页面** → `pages/<页面>/` 四件套 + 在 `app.json` 注册；新接口同时加到该端的 `utils/api.js`。
- **文档** → 编号件放 `doc/NN_名称.md`，专题放 `doc/<专题目录>/`。
- **一次性脚本、探针、临时文件** → **不要放仓库里**（见 §9）。

---

## 4. 代码规范：文件大了就拆

### 4.1 原则

- **单文件超过 400~500 行就该考虑拆**。项目历史上做过多次目录大整理，拆分后的结构对人和 AI 都更好读、更好改。
- 拆分的例子就在仓库里，照抄这个模式：
  - 后端：`domains/order/{routes,service,queries}.js`（按职责横切）
  - 管理员网页：`js/parts/admin/`、`js/parts/map/`（按功能块切）
  - 大屏：`js/dashboard/`、`js/scene3d/`、`js/gl3d/`、`js/render/`（按模块切）
- **拆分纪律**：**只搬不改**。分件后函数名、行为、接口路径、`?v=` 加载顺序都不能变；**一次提交只做一件事**，拆完必须按 §5 回归。

### 4.2 当前优先拆分清单（2026-10-11 实测行数）

| 行数 | 文件 | 备注 |
| --- | --- | --- |
| 2171 | `可视化大屏/js/map3d-gl.js` | 3D 主渲染，**拆之前先问用户** |
| 1754 | `管理员网页/admin.js` | 入口装配，可继续拆到 `js/parts/` |
| 1466 | `backend/services/platform-http.js` | 平台对接，可拆请求/标定/点位 |
| 900 | `backend/services/batch.js` | 组单算法，可拆算分与约束 |
| 840 | `backend/domains/delivery/routes.js` | |
| 778 | `backend/domains/admin/routes.js` | |
| 677 | `backend/db.js` | 建表与迁移可分离 |
| 670 | `backend/services/platform.js` | |
| 660 | `backend/domains/delivery/service.js` | |
| 641 | `可视化大屏/js/gl3d/recon.js` | |
| 550 | `可视化大屏/js/map3d.js` | **不拆**（2.5D 兜底，低用，用户已明确） |
| 498 / 452 | `backend/domains/order/routes.js` / `service.js` | |
| 450 / 571 | `用户端/pages/order/confirm.js` / `confirm.wxss` | |

### 4.3 这些**不要**拆（不是源码）

`*/miniprogram_npm/*`、`*/vendor/*`、`backend/package-lock.json`、`backend/store_goods.json`（数据）、`可视化大屏/assets/map-calibration.json`（标定数据）、`doc/逻辑树/*.excalidraw`（绘图工具生成）、`*.log`。

### 4.4 代码风格

- 中文注释、中文提交说明；注释解释「为什么」，不复述代码。
- 后端沿用现有风格：域内 `routes.js` 只做参数校验与响应，业务逻辑落在 `service.js`，SQL 集中在 `queries.js`。
- 前端零构建，不要引入打包器 / npm 依赖到大屏与管理员网页。

---

## 5. 改完必须验证（`node --check` 不算验证）

| 改动范围 | 必须做的验证 |
| --- | --- |
| 配送 / 订单 / 组单 | 在 `backend/` 下逐个跑 `node tests\test_*.js`，10 个测试文件必须**全绿** |
| 后端接口 | 起服务后真调一次接口（用 `node -e "fetch(...)"`，**不要**用 `Invoke-WebRequest`，非交互 pwsh 下会走 IE 引擎失败） |
| 可视化大屏 | **真实浏览器**（CDP 无头 Edge）跑回归探针：键位、三栏布局、启动读服务器数据、保存防护等，要求 **0 console 报错**，并确认服务器地图数据被原样还原 |
| 小程序 | 微信开发者工具真机 / 模拟器预览一次；改了 `config.js` 或域名要留意「网络异常」 |
| 平台对接 | 只对 mock（`PLATFORM_MOCK=true`）验证，**禁止拿生产平台做实验** |

> 大屏回归基线脚本在负责人的工作区 `_tmp4\probes\verify\`，**不在本仓库**。
> 如果你本地没有这套脚本，**先问用户索取**，不要凭肉眼或"看起来没报错"就宣称验证通过。

---

## 6. 什么不进仓库 / 新成员 clone 后必须自己补

| 项 | 为什么不在仓库 | clone 后怎么办 |
| --- | --- | --- |
| `backend/.env` | 含真实凭据（平台 appid/secret、微信支付、AppSecret），由负责人在线下发 | 复制 `backend/.env.example` 为 `.env`，本地演示保持 `PLATFORM_MOCK=true` 即可跑通 |
| 双端 `utils/config.js` 里的开发机 IP | 每人局域网 IP 不同，提交会互相覆盖 | 自己改 `BASES.develop` 为**你本机**的局域网 IP（真机调试用）；**不要把自己的 IP 提交上去** |
| `backend/data/` | 运行时数据（含 WAL） | 首次启动自动建库并写入种子数据；需要历史数据向负责人要 |
| `backend/uploads/` | 运行时上传 | 不用管，按需生成 |
| `可视化大屏/assets/map-calibration.js` | 校准流程生成 | 向负责人索取，或重跑 `可视化大屏/deploy/` 下的校准脚本 |
| `接口/` 平台 OpenAPI 导出 | 官方导出里**带示例凭据**，且体量大 | 见 §7 |

---

## 7. 接口文档在哪（改对接前必看）

改平台对接、加接口之前，**先确认接口的真实契约**，不要凭命名猜字段。

| 想要的接口 | 去哪找 |
| --- | --- |
| **越凡（robox）开放物流平台**官方规格 | 负责人本机工作区的 `接口\默认模块.openapi.json`（OpenAPI 文件，**不在仓库里**）。**若你本地找不到这份文件，先问用户**，不要凭猜测硬写对接代码 |
| 平台对接的落地说明（我们怎么用的） | `doc/07_配送平台对接.md` |
| 自建后端 HTTP 接口 | 各域 `backend/domains/<域>/routes.js`（真实来源）；`doc/06_接口与数据协议/` 是整理稿 |
| 小程序调了哪些后端接口 | `用户端/utils/api.js`、`商家端/utils/api.js` |
| 数据库表与字段 | `doc/03_数据库设计.md` + `backend/db.js` |

**约定**：新增或修改接口时，要**同时**更新调用方（`utils/api.js`）、对应文档（`doc/06_接口与数据协议/`）和测试，避免出现「后端加了接口但小程序不知道」。

---

## 8. git 提交规范（硬要求）

1. **提交前必须得到用户（项目负责人）明确同意**，禁止自行 `commit` / `push`。提交前把**待提交文件清单 + 提交说明**展示给用户确认。
2. **只 `git add` 精确路径**，禁止 `git add .`（会把 `config.js` 的本机 IP 等本机配置一起带进去）。
3. **每一次提交，都要在 `agent/agent交接文档/git交接文档/` 新增一份《git交接文档N.md》**（N = 现有最大编号 + 1；现有 1、2），**和代码放在同一次提交里**，不要事后补。内容至少包含：
   - 本次提交范围（逐文件说明，哪个文件改了什么功能）
   - **遇到的问题 / 踩的坑**（没遇到就写「无」）
   - 校验记录（跑了哪些测试 / 探针，结果如何）
   - 提交信息原文、提交号、**是否已推送**（未推送必须写明）
   - 遗留待办
4. 推送前先 `git pull --rebase`，**禁止 `--force`**（会丢弃其他成员的提交）。
5. 每完成一段会话工作，在 `agent/agent交接文档/会话交接文档/` **追加新一份**交接文档（编号递增）：写当前现状、已核实的结论、待办、被否决的方案，供下一个会话接手。
6. 线上/生产相关的凭据、IP、`appid`/`secret` **一律不进仓库**。

---

## 9. 绝对不要做的事

- **不要用 shell 读写中文文件**（`Get-Content` / `Set-Content` / `Out-File` / `>`）。pwsh 默认按 GBK 解码 UTF-8：中文会变乱码，而且**会吃掉 `<` 字符**（历史事故：`</b>` 被写成乱码导致大屏地图高度塌成 0）。一律用编辑器 / `read` / `edit` / `write`，或写 `.mjs` 用 Node 按字节读写。
- **不要重构后端分层**（现有 `domains/` + `services/` 结构是良好的，只做整理）。
- **不要拆 `可视化大屏/js/map3d-core.js` 与 `map3d.js`**（2.5D 兜底、低用）。
- **不要接入 `可视化大屏/configs/default.js`**（多租户预留模板，也不要往 `index.html` 加它的 script）。
- **不要动小车的青色导航线 / 吸附网** —— 那是机器人固定行驶规则；灰色 OSM 层才是可重构对象。
- **不要把探针 / 一次性脚本 / 临时文件留在仓库目录里**。
- **不要重复调用同一个工具**（同一命令 / 同一个文件只读一次），不要把同一份现状抄进多份文档。
- **不要在两台机器上同时跑后端**（SQLite 双写、重复拉单、重复连平台）。

---

## 10. 新成员 / 新会话上手 6 步

1. **读**：本文件 → `README.md` → 最新《会话交接文档》→ 最新《git交接文档》。
2. **clone** 仓库，确认在 `main` 分支。
3. **装环境**：Node ≥ 22.13（建议 24 LTS）+ 微信开发者工具。
4. **补本地配置**：`backend/.env`（向负责人要凭据，或先用 mock）、双端 `utils/config.js` 的 `BASES.develop` 改成你自己的局域网 IP。
5. **跑通**：起后端（3000）→ 打开 `/admin/` 与 `/dashboard/` → 需要的话跑一遍 `backend/tests/`。
6. **动代码前**先 `read` 目标文件与所在域的邻居文件（`routes.js` / `service.js` / `queries.js`），确认落位规则（§3.1）与拆分规范（§4）后再改。

---

## 11. 本文件的维护

目录结构、分层方式、提交规范发生变化时，**在提交代码的同时更新本文件**（和《git交接文档》一起提交）。
本文件只写**长期有效的规范**；项目当前进度、待办、已知问题一律写进《会话交接文档》，不要往这里搬。
