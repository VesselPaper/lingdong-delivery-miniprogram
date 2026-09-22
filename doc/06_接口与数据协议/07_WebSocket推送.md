# 06 · 接口与数据协议 · 07 WebSocket 实时推送

## 四、WebSocket 实时推送

### 4.1 连接与校验

| 项 | 约定 |
| --- | --- |
| 路径 | `ws://<host>/ws`（仅接受 `/ws`，其余 upgrade 直接断开） |
| 鉴权 | 握手请求头 `Authorization: Bearer <token>`，或兼容 `?token=` 查询串（排查用）；校验不通过回 401 并断开 |
| token 语义 | `server.js → push.attach(validateToken)`：先查 `admin_sessions`（有效未过期且账号启用），再查 `users.openid` —— 管理员与用户/商家共用同一通道 |
| 方向 | 仅服务端→客户端单向广播；客户端业务帧被忽略（只处理 ping/pong/close） |
| 资源上限 | 并发连接 `MAX_CLIENTS=200`、单帧 `MAX_FRAME_BYTES=64KB`、接收缓冲 `MAX_BUFFER_BYTES=256KB`、空闲 `IDLE_TIMEOUT_MS=10 分钟` 回收 |

### 4.2 订阅协议

客户端可发送主题订阅帧（`services/push.js`，文本帧 JSON）：

```json
{ "type": "sub", "topics": ["admin/live"] }
```

订阅后服务端 `broadcastTopic(topic, payload)` 只推给订阅该主题的客户端；未订阅主题的客户端只收全量广播。无订阅者时后台泵自动跳过（零开销）。

### 4.3 推送事件与载荷（grep `push.broadcast` / `broadcastTopic` 调用点）

| 事件 | 触发点 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `order_created`（全量广播） | `order/routes.js /pay/notify` 回调置已支付成功；`order/service.js payOrder` 模拟档支付成功 | `{ "type": "order_created", "order_id": 7 }` | 新订单支付成立 → 商家端红点/待接单列表局部刷新 |
| `live`（主题 `admin/live`） | `admin/live.js` 泵（`ADMIN_LIVE_MS` 默认 2.5s） | `{ "type": "live", "ts": 0, "robots": [ { "device_sn": "…", "x": 1, "y": 2, "theta": 0, "text": "…" } ], "robot": {…} }` | 机器人实时位置 + 首位机器状态 → 管理员页地图小车/机器人卡片原地更新 |
| `state_changed`（主题 `admin/live`） | `admin/live.js` 变更检测（活跃订单/批次/任务计数+最大更新时间+主机器人状态指纹变化时） | `{ "type": "state_changed", "ts": 0 }` | 前端收到后拉一次 `GET /api/admin/state` 全量刷新 |

客户端约定：收到 `order_created` 后重拉商家订单列表/工作台统计；收到 `state_changed` 后拉管理员状态总览；断线自动重连（服务端空闲 10 分钟会回收半开连接）。

---

---

[← 返回 06_接口与数据协议 索引](README.md)
