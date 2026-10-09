# 可视化大屏 · 架构说明（ARCHITECTURE）

> 这是给「人 + AI agent」共同看的分层地图与读改指南。目标：**每个文件小而单一，
> 改某个功能只读相关的小文件，不超上下文、不出幻觉。**

## 1. 一句话架构

大屏 = **存数据(data/state) → 渲染(render) → 摆 UI(ui) → 编排(app)** 四层。
目前是原生 JS + `<script>` 顺序加载 + `window` 命名空间（保持 **file:// 双击可开、后端静态托管 /dashboard/ 可用**），**无构建工具，不引入 Vite/TS**。

## 2. 目录结构

```
可视化大屏/
  index.html              入口；按序加载各 js（见下方「加载顺序」）
  assets/                 标定数据 + 雷达底图（image/geo）
  css/                    样式
  js/
    scene3d/              3D 几何纯算法库（浏览器/Node 共用）
      math.js             mat4 + 向量 + 主题色 + 光照   （最独立，agent 几乎不读）
      triangulate.js      耳切三角化 + 网格累加器
      camera.js           透视相机 + 平台坐标→雷达像素 + 方位
    scene3d.js            3D 几何库主体：图元/建筑/静态场景/车辆/路线/路网（行号索引见 §4）
    render/
      gl3d/shaders.js     WebGL 着色器（纯 GLSL 定义）
    map3d-gl.js           WebGL 真 3D 渲染器（window.Map3DGL，默认渲染）
    map3d.js              2.5D Canvas 回退渲染器（window.Map3DFlat）
    map3d-core.js         2.5D 的几何核心（window.Map3DCore）
    map3d-entry.js        渲染器自动选择入口（window.Map3D）
    gl3d/recon.js         3D 图层重构面板控制器（独立抽出）
    dashboard/            大屏骨架（共享上下文 + 数据源 + UI 渲染 + 地图 + 编排）
      shared.js           公共常量/工具/DOM 快捷/Dash.state
      api.js              数据源（overview / robot-positions）
      views-ui.js         各 UI 渲染纯函数（时钟/指标/机器人/批次/告警/事件）
      map.js              Leaflet 实时地图 + 标定(?calib=1)
      main.js             编排者：apply/loop/boot/轮询/演示/内存守护/每日重载
  configs/
    default.js            默认大屏配置（多租户扩展入口）→ §5
  vendor/                 Leaflet（第三方库，勿改）
```

## 3. 加载顺序（index.html）

```
vendor/leaflet → assets/map-calibration → js/scene3d/{math,triangulate,camera}
→ js/scene3d → js/map3d-core → js/map3d → (MAP_ASSET_VER='3d38')
→ js/render/gl3d/shaders → js/gl3d/recon → js/map3d-gl → js/map3d-entry
→ js/dashboard/{shared,api,views-ui,map,main}
```

> 改动某一文件后：**若它是最后加载的（如 dashboard/*），刷新即可**；否则浏览器可能缓存，
> 需强刷（Ctrl+Shift+R）。改全局命名空间单文件时同档强刷。

## 4. scene3d.js 行号索引（改动只读对应段）

> scene3d.js 保留为内聚算法库（它内部函数互相裸调用、被 Node `tool_carcheck` require），
> 最独立的 math/triangulate/camera 已抽出。以下索引让 agent 改某功能**只读对应段落**：

| 起步行 | 功能段 | 你要改这类东西时读这里 |
|---|---|---|
| ~36 | 3D 图元（squareCap/ribbon/column/octa…） | 扁带、柱、八面体基本形状 |
| ~86 | 建筑（屋顶/墙面/描边/让路） | 楼栋外观、让路算法（**现已默认关闭**，见 README） |
| ~157 | 静态场景（buildStatic，把全图楼/路拼好） | 整体场景组装、主题彩色映射 |
| ~318 | 车辆（buildCar） | 送餐车 3D 模型 |
| ~399 | 光环/光柱（buildRing/buildBeam） | 车底光环、车顶光柱 |
| ~433 | 路线（buildRouteMesh） | 橙色的规划/演示路线 |
| ~447 | 演示路线（demoRoutePaths） | 演示档路线生成 |
| ~652 | 光照 | 光照方向/明暗 |

> ⚠️ 行号会随改动漂移，改前用 `grep "buildCar\|静态场景"` 刷新定位。

## 5. 多学校 / 多商家扩展（configs/）

当前为单租户（每校一套大屏可各自部署）。已有扩展入口 `configs/default.js`：

```js
window.DASH_TENANT_CONFIG = {
  key: 'some_school',
  product: { name, slogan, shopName, campus },
  modules: ['clock','metrics','robots','batches','alerts','events','map3d','recon'],
  map: { provider:'tianditu', reconEnabled:true },
  data: { /* 未来每校一套 baseUrl / 标定 / 坐标 */ }
}
```

**如何加一个新学校/商家**：
1. 复制 `configs/default.js` → `configs/<key>.js`，改 `key/product/modules/map/data`。
2. 大屏开发时用 `?tenant=<key>`（或在 index.html 里临时写 `window.__TENANT`）选中该配置。
3. 若该校有独立坐标标定 / 数据源，在 `data` 字段加，并在 `dashboard/*` 对应读取点接入（目前是预订点，尚未驱动硬编码）。
4. 若该校需要完全不同的模块：改 `modules` 数组启用/停用对应 `ui/*` 组件即可。

## 6. 关键命名空间（跨文件接口）

- `window.Scene3D` = scene3d.js 主体（3D 几何）；分件在 `window.Scene3DParts.{math,triangulate,camera}`。
- `window.Map3DCore` = map3d-core.js（2.5D 几何核心）。
- `window.Map3DGL` / `window.Map3DFlat` = 真 3D / 2.5D 渲染器。
- `window.Map3D` = entry 选出的当前渲染器（dashboard 只调它）。交互接口（两套渲染器可能只实现子集，调用方先判空）：
  `ensure / update / setRobots / setOpts / getOpts / resize` +
  `setSelected(sn, silent?)`、`getSelected()`、`setFollow(on, silent?)`、`isFollowing()`（选中/跟随由 `map3d-gl` 实现）。
  渲染器 → 大屏的回调挂在 `getOpts()` 返回的 opts 引用上（`onCarSelect(sn)` / `onFollowChange(on)`），
  直接改引用不触发 `setOpts` 的整场重建。
- `window.GL3DShaders` = WebGL 着色器定义。
- `window.Map3DGLRecon` = 重构面板控制器（bind 到一个 host 桥）。
- `window.Dash` = 大屏骨架：`{C, ctx, state, api, views, map, main}`。
- `window.DASH_TENANT_CONFIG` = 租户配置（§5）。

## 7. 测试与验证

- **离线工具**：`node tool_carcheck.js` —— 跑在 Node 上 require scene3d.js，质检车模/光环/光柱无 NaN、落地、尺寸正确。**改 scene3d 的任何几何后必须跑它**。
- **浏览器探针**：headless Chrome/Edge + CDP 验证页面零报错、`Map3D.ensure()` 起得来、重构下拉项数、`Dash` 各分件装载。
  交互回归可脚本化：`Dash.main.selectCar(sn)` / `Map3D.setSelected(sn)` 双向同步、合成 `mousedown+mousemove` 验证
  "拖动自动关跟随"、`Dash.main.setLeftHidden(true)` / `toggleMapFull()` 后断言 `#mapBox canvas.width === #mapBox.clientWidth`
  （DPR=1 时应完全相等，否则画布被拉伸）；截图核对车辆标注分级。
- 改动后建议：`node --check <file>` 先过语法 → 起后端(backend/server.js) → CDP 探针 → 真机强刷。

## 8. 约定（保持你好维护）

- **不引第三方构建**（保持双击即开）。改大屏不新增 `<script>` 依赖除非必要。
- 每个文件保持**单一职责**；新拆分时参考 `scene3d/{math,triangulate,camera}` 的 UMD + `window` 命名空间模式。
- 面向 agent：大文件继续用「分节注释 + 本文件行号索引」，让 agent 精准定位而非整篇读。