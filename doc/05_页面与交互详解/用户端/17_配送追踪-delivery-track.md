# 配送追踪：3 秒轮询 + 自绘地图 + 同批次进度
> 页面路径：pages/delivery/track（用户端小程序）


**页面职责**：实时追踪某订单对应机器人的配送状态：进度条、自绘地图（SLAM 百分比坐标，无经纬度故不用微信 map 组件）、机器人实时位置、一车多单同批次取餐进度，并提供刷新 / 扫码取餐 / 异常退款出口。

**进入路径**：已在 `app.json` 注册（pages/delivery/track），支持 `options.order_id` 直接追踪指定订单；**当前用户端代码中无任何页面导航进入本页**（见文末存疑点 3），无参数时本页也可自举：`loadLatest()` 自动挑一个进行中订单追踪。

**页面结构（wxml 骨架）**：空态（无订单时：图标 +「暂无配送中的订单」+ 去下单按钮）→ 机器人状态卡（机器人图标 + 名称 + `taskText` + 右侧 tag：配送异常 6 / 待取餐 3 / 配送中）+ 进度条（`progressPercent` 宽度的进度轨 + 「已接单/取餐/配送/送达」四标签）→ 自绘地图卡（`map.landmarks` 存在时：网格底图 + 路线折线 + 全部点位 + 机器人实时位置点 + 底部缩放条 ＋/－/复位 + 点位提示；否则降级为「机器人位置」文本卡）→ 配送异常卡（status 6）→ 配送进度卡（`task` 存在时显示 `task.status_text`）→ 同批次卡（`batch.multi_order` 时：批次号 / 本车订单共 N 单（满仓最多 12 件）/ 已取 X/N 单）→ 取餐凭证卡（取餐码 + 提示）→ 底部按钮区（刷新状态 / 扫码取餐 / 申请退款）。

**页面要素与数据来源**：

- `onLoad`：有 `options.order_id` 直接追踪该单；无参数时 `loadLatest()` 自动挑单——GET `/api/order/list`，优先取进行中订单（status 1/2/3），否则取最近一单，都无则置 `empty` 空态；随后 `startPolling()`。
- `load(silent)`：GET `/api/delivery/track?order_id=`，解析出以下数据：
  - `task`：机器人任务对象；`taskText`：取 `data.task_text`，其次 `task.status_text`，兜底 `order_status_text`；
  - `batch`：同批次对象（`multi_order / batch_no / total_orders / picked_orders`）；
  - `percent`：后端按地图 bbox 归一化的百分比坐标 `{x, y}`，无真实坐标时为 null（地图卡隐藏）；
  - `map`：`{ bbox, landmarks[], route[] }`，landmarks/route 均为百分比坐标；`position`：文本位置兜底。
- **任务状态 → 进度阶段映射**（`stepMap`，注释明确「必须覆盖全状态码，漏掉 40(上货中) 会让配送中订单的进度条回退到 0」）：

| 任务状态码 | 含义 | 进度步骤 |
| --- | --- | --- |
| 0 | 排队中 | 0 |
| 10 | 已接收 | 1 |
| 20 / 30 / 40 | 去上货点 / 到达上货点 / 上货中（取餐阶段） | 2 |
| 50 / 60 | 已上货 / 去往取货点（配送中） | 3 |
| 70 / 80 | 到达取货点 / 任务完成（送达） | 4 |
| 90~95、100~106、110、120、130~132、140、150 | 异常 / 失败 / 取消 / 关闭 | 0（进度归零，文案由 `taskText` 承担） |

无 task 时按订单状态兜底：`order_status 2` → 步骤 1（已接单未建任务），`3` → 步骤 4（已送达待取餐）。`progressPercent = Math.min(100, step * 25)`。
- 机器人位置：`data.percent.x / y` 存在则覆盖 `posX / posY`（兜底 10 / 80）。
- 轮询：`startPolling()` 起 `setInterval(load(true), 3000)`，`onLoad/onShow` 启动、`onHide/onUnload` 停止（注释：防止页面在栈底时继续每 3 秒打接口）；`onShow` 还会立即刷一次（从取餐页返回时恢复）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/delivery/track.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 刷新状态 | `refresh` | `load()` 立即重拉 GET `/api/delivery/track?order_id=`（打断轮询节奏手动刷新） | 进度条/地图/批次数据更新 |
| 扫码取餐（status 3 显示） | `goScanPickup` | 已送达待取餐时跳扫码取餐页 | `wx.navigateTo('/pages/delivery/scanPickup')` |
| 申请退款（status 6 显示） | `goRefund` | 配送异常出口（P1-4），有 `orderId` 才跳转 | `wx.navigateTo('/pages/order/refund?order_id=' + orderId)` |
| 地图双指缩放 / 单指平移 | `onMapTouchStart` / `onMapTouchMove` / `onMapTouchEnd` | 双指记录初始距离与比例算 `mapScale`；单指累计位移写入 `mapOffsetX/Y`（`catchtouch*` 阻止冒泡） | 自绘地图容器 transform 实时生效 |
| 地图「＋」放大 | `onZoomIn` | `applyMapScale(mapScale * 1.3)`，范围钳制 0.8~4 | — |
| 地图「－」缩小 | `onZoomOut` | `applyMapScale(mapScale / 1.3)` | — |
| 地图「复位」 | `onMapReset` | `mapScale = 1, mapOffsetX/Y = 0` | — |
| 空态「去下单」 | `goOrder` | **track.js 中未定义该函数（见文末存疑点 1），点击无实际行为** | — |
| 轮询请求失败 | —（`load` 内部） | 3 秒轮询以 `silent` 静默失败，不弹 toast（防断网刷屏）；`loading` 锁防重入 | 下次轮询自动恢复 |

**重点链路**：

- **追踪轮询生命周期**：进入页面 `startPolling`（3s）→ `load(true)` 拉取并渲染 → 页面隐藏/卸载 `stopPolling` → 从取餐页返回 `onShow` 立即刷一次再续轮询。`loading` 为真时跳过本次拉取，避免弱网下轮询叠加。
- **进度条阶段**：`stepMap` 把机器人任务状态码（10 已接收 → 20/30/40 取餐 → 50/60 配送 → 70/80 送达）压成 4 阶段，`step * 25` 得到进度百分比，四个标签「已接单 / 取餐 / 配送 / 送达」按 `progressStep` 点亮；异常状态码归零但文案保留（`taskText`）。
- **同批次一车多单进度（本车共 N 单 / 已取 X 单）**：`batch.multi_order` 为真时渲染「本车配送批次 {batch_no}」卡：`本车订单 共 {total_orders} 单（满仓最多 12 件）`、`已取餐 {picked_orders} / {total_orders} 单`，并提示「其他用户取走后本车才算配送完成」——即关舱动作（`/delivery/pickup-close` / `pickup-close-all`）驱动 `picked_orders` 增长，轮询可见。
- **自绘地图**：`map.landmarks` 存在时渲染地图卡：网格底图 + `route` 相邻停靠点连线（`routeSegLen / routeSegDeg` 计算线段长度与旋转角，`hidden` 跳过首点）+ 全部点位（上货点 `type === 'loadingPoint'` 特殊样式）+ 机器人实时位置点（`percent` 非空才渲染）；无真实坐标（`percent` 为 null）时降级为「机器人位置」文本卡并标注「当前为演示模式」。
- **配送异常出口（P1-4）**：`order.order_status === 6` 时顶部 tag 显示「配送异常」、渲染异常说明卡（「机器人故障/长时间无进展…请申请退款或联系商家处理；您的餐款会按售后结果退回」），底部出现「申请退款」按钮直达 `order/refund`。

**状态与边界**：空态「暂无配送中的订单」+ 去下单按钮（按钮函数未实现，见存疑点 1）；`taskText` 优先服务端下发文案；地图缩放范围 `mapScaleMin 0.8 / mapScaleMax 4`；`posX / posY` 兜底 10/80 保证首次渲染有值；轮询与手动刷新共用 `load`，`loading` 互斥。

---

[← 返回 05 页面与交互详解 索引](../README.md)
