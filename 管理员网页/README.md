# 管理员网页（零栋送餐·调度台）

按**数据域分层**组织；源码拆成小块放在 `js/parts/` 下，运行时仍是同一个闭包，
因此页面行为与单文件时代完全一致。**不要直接手改 `admin.js` / `admin-map.js`**，
它们是构建产物。

## 目录结构

```
管理员网页/
├─ index.html            页面骨架与布局（引用 css/*.css 与 admin.js / admin-map.js）
├─ build.js              拆分式构建脚本（用于 JS 拼接；CSS 不需要它）
├─ css/
│   ├─ base.css          设计变量/重置/布局/导航/报头
│   ├─ components.css    按钮/标签/表格/弹窗/开关/右键菜单/轻提示/响应式
│   └─ map.css           实时地图块 + Leaflet 覆盖层（小车/点位/轨迹/跟随）
├─ admin.js              构建产物（不要手改）
├─ admin-map.js          构建产物（不要手改）
└─ js/parts/             真正的源码，按领域拆分
   ├─ admin/  ── 管理页逻辑，对应 admin.js 的切块（9 片，顺序即拼接顺序）
   │   01-core.js           头部/IIFE/常量/基础工具(esc/log/toast/api/状态字典/配色)
   │   02-nav.js            导航(3 项：总览/配送数据/设置) + 标签页 + 活跃/历史/全部分段 + 搜索/筛选
   │   03-menu.js           右键菜单(破坏性操作唯一入口) + 机器人卡「更多操作」 + 复制编号 + 路线文本
   │   04-overview-ws.js    总览渲染 + 机器人卡片 + WebSocket 事件驱动 + 导航计数
   │   05-render-cards.js   配送数据卡片渲染（批次卡包裹订单子卡 / 订单卡 / 任务卡）
   │   06-refresh-token.js  刷新与认证 + 账号页
   │   07-drawer.js         详情抽屉：状态时间线 + 实时位置 + 商品明细
   │   08-audit.js          操作日志（服务端 audit_logs：成功与失败都在）
   │   09-ops.js            单项操作 + 召唤/开关舱弹窗 + 启动 + IIFE 收尾
   └─ map/    ── 校园地图逻辑，对应 admin-map.js 的切块
       01-init.js        地图初始化：元数据/坐标映射/雷达底图
       02-static.js      点位 + 配送站位（静态数据层）
       03-cars.js        无人车图层（实时位置 + 朝向）+ 批次聚焦
       04-render.js      renderMap / setMask / poll（整图渲染与拉取）
       05-live.js        mapOnLive + 跟随小车 + 轨迹 + boot（实时层）
```
> **IIFE 边界**：IIFE 的开头在 `01-core.js`，收尾（启动 + `})()`）在 `09-ops.js`，所以 **09 必须排在最后**。
> **被替换掉的旧分片（已删除）**：`03-select.js`（选择与批量）、`05-render-tables.js`（表格渲染）；旧的 `07-ops.js`（单项操作）改名为 `09-ops.js`。

CSS 拆分为三个独立 `<link>`，**不需要构建**；改样式直接编辑 `css/*.css` 即可。

## 怎么改

- 改逻辑：编辑 `js/parts/**` 下对应的文件 → 在管理员网页目录跑 `node build.js` → 刷新页面。
- **正向构建（`node build.js`）只依赖 `TARGETS`**——`build.js` 顶部的有序 parts 清单，顺序即拼接顺序。
- **`CUTS` 只在反拆（`node build.js --gen`）时使用**：从当前 `admin.js` / `admin-map.js` 按边界重新切出 parts 才读它。
- `CUTS` 是每个 part 的**最后一行号**（1-based），且 `cut_i` = 前 i 个 parts 的**行数之和**（拼接时用 `'\n'` 相连，
  分隔符被行边界吸收，所以不再额外 +1）。**改过 parts 后若要用 `--gen`，必须先按此式刷新 `CUTS`。**
- 当前值：
  - `admin.js: [161, 282, 433, 556, 787, 905, 1094, 1186, 1418]`
  - `admin-map.js: [100, 158, 220, 273, 382]`

## 数据流（事件驱动，无轮询）

1. 页面加载 → `admin.js` 校验令牌 → 连 `/ws` 订阅 `admin/live`。
2. 后端实时泵每 ~2.5s 推一次：
   - `{type:'live', robots, robot}` → `map/05-live.js` 原地更新小车位置/朝向 + 机器人卡片
     （详情抽屉开着时，同步刷新它的实时位置段，不整页重绘）；
   - `{type:'state_changed'}` → 数据有变则 `refresh()` 拉一次 `/api/admin/state`。
3. 地图初始全量（底图/点位/配送站位）一次性拉 `/api/admin/map`。
4. 按需拉取（都不是轮询）：
   - `GET /api/admin/audit` —— 总览 →「操作日志」标签（读服务端 `audit_logs`，按操作者/结果/动作筛选 + 分页）；
   - `GET /api/admin/timeline` —— 详情抽屉的状态时间线（老数据没有事件时，后端用现有时间列拼「推断节点」，前端明确标注）。
5. 前端内存日志（`#log`，「本次会话回显」折叠卡）只是本次会话的回显，刷新即清空，**不再冒充审计**。

## 说明

- `admin.js`/`admin-map.js` 为 LF 换行（构建时统一），与源码语义一致。
- 地图「跟随小车」按钮逻辑在 `map/05-live.js`；坐标换算在 `map/01-init.js`。