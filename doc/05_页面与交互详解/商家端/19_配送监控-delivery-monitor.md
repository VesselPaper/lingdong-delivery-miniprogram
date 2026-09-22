# 配送监控（真实地图 canvas 绘制 + 5 秒轮询 + 机器人概览）
> 页面路径：pages/delivery/monitor（商家端小程序）


- **数据来源**：`onShow` 启动 `setInterval(load, 5000)`，`onHide/onUnload` 清理；每轮并行拉三路数据：GET /api/merchant/map（底图 map_url + bbox + 点位 + 路网 graph + 配送路线 routes + 机器人实时位置）、GET /api/merchant/robots（机器人列表）、GET /api/merchant/device/pending（取 `active_batches` 配送中批次）。
- **页面构成**：「实时地图」节（底图 image + 2D canvas 覆盖层；底部图例：配送点绿 / 上货点橙 / 无人车蓝 / 配送路线蓝线，各带数量；右上更新时间 + 「刷新」按钮）→ 「配送中的批次」节（`batch-card` 分组卡面，`showProgress` 已取 X/N + `showGoods` 商品明细，订单子卡可点）→ 机器人概览卡（名称 + SN + 在线标签 + 「本车二维码」按钮 + 运行状态 / 电量条 / 当前位置三列）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 地图刷新 | refreshMap | `loadMap(true)` 强制整块重绘 | — |
| 机器人列表重试 | retryRobots | 重拉 GET /api/merchant/robots | — |
| 批次内订单子卡 | goDetailByOrder | 读 `e.detail.id` | navigateTo /pages/orders/detail?id= |
| 本车二维码 | goRobotQr | 读 `data-sn` | navigateTo /pages/device/robotQr?sn= |

- **重点链路（监控轮询 /api/merchant/map）**：`loadMap` 先计算地图静态结构签名 `mapSignature`（`map_url + graph 节点数/边数 + 点数 + 活跃路线串`）；**签名未变只回填 `map.robots` 并重绘**，签名变化才整块重绘 —— 避免每 5 秒把上百个路网节点整批 setData 造成明显卡顿（代码注释明示）。`layoutMap` 按 bbox 纵横比（截断到 0.45~1.6）与窗口宽定容器尺寸（高 240~560px）；`drawMap` 用 2D canvas（按 DPR 放大后备存储防文字发糊，每次重建后备存储避免 scale 叠加），绘制顺序：路网灰线 → 活跃批次配送路线蓝折线 + 白色停靠序号圈 → 点位（绿=配送点 / 橙=上货点，白圈+实心点防糊进底图）→ 无人车（蓝圆 + 朝向短线，标签只显示 SN 尾号 6 位）→ 标签文字按「标记/文字双占位 + 8 方向 × 近远两档」避让（两轮兜底，优先级无人车 > 上货点 > 配送点）。图例数量 `mapCounts`（配送点数 / 上货点数 / 车数）与更新时间随每轮刷新。
- **状态与边界**：地图失败显示错误卡 + 「地图来自开放物流平台 building/mapInfo，请确认平台可用后刷新」提示 + 重试按钮；`decorateRobot` 派生展示值 —— 电量 null 显示「—」、<20 低电红 / <50 中 / 否则正常，离线置灰、`exception` 标红、`charging/returnChargingPile` 标充电中；机器人接口失败显示独立错误卡 +「配置平台凭据后重试」+ 重试；批次空态「暂无配送中的批次」；`onHide` 停轮询（返回上级页面不浪费流量）。

---

[← 返回 05 页面与交互详解 索引](../README.md)
