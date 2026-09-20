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
   ├─ admin/  ── 管理页逻辑，对应 admin.js 的切块
   │   01-core.js           头部/常量/基础工具(esc/log/toast/api/状态字典)
   │   02-nav.js            导航 + 标签页 + 搜索/筛选 + 批次自动展开
   │   03-select.js         选择/批量操作 + 右键菜单 + 复制 + 批次展开
   │   04-overview-ws.js    总览页 + 机器人卡片 + WebSocket 事件驱动 + 导航计数
   │   05-render-tables.js  任务页 + 批次/订单/本地任务/平台任务 表格渲染
   │   06-refresh-token.js  刷新/认证 + 令牌设置
   │   07-ops.js            单项危险操作 + 召唤/开关舱弹窗 + 批量按钮 + 启动
   └─ map/    ── 校园地图逻辑，对应 admin-map.js 的切块
       01-init.js        地图初始化：元数据/坐标映射/雷达底图
       02-static.js      点位 + 配送站位（静态数据层）
       03-cars.js        无人车图层（实时位置 + 朝向）+ 批次聚焦
       04-render.js      renderMap / setMask / poll（整图渲染与拉取）
       05-live.js        mapOnLive + 跟随小车 + 轨迹 + boot（实时层）
```
CSS 拆分为三个独立 `<link>`，**不需要构建**；改样式直接编辑 `css/*.css` 即可。

## 怎么改

- 改逻辑：编辑 `js/parts/**` 下对应的文件 → 在管理员网页目录跑 `node build.js` → 刷新页面。
- 换了个布局/位置想重新切分：跑 `node build.js --gen`（从当前 `admin.js`/`admin-map.js`
  按边界重新生成 parts）。
- 切块边界在 `build.js` 顶部的 `CUTS` 里（每个 part 的最后行号，1-based）。

## 数据流（事件驱动，无轮询）

1. 页面加载 → `admin.js` 校验令牌 → 连 `/ws` 订阅 `admin/live`。
2. 后端实时泵每 ~2.5s 推一次：
   - `{type:'live', robots, robot}` → `map/05-live.js` 原地更新小车位置/朝向 + 机器人卡片；
   - `{type:'state_changed'}` → 数据有变则 `refresh()` 拉一次 `/api/admin/state`。
3. 地图初始全量（底图/点位/配送站位）一次性拉 `/api/admin/map`。

## 说明

- `admin.js`/`admin-map.js` 为 LF 换行（构建时统一），与源码语义一致。
- 地图「跟随小车」按钮逻辑在 `map/05-live.js`；坐标换算在 `map/01-init.js`。