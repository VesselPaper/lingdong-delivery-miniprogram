# 06 · 接口与数据协议（目录）

> 本文档为项目自建后端（Node.js + Express + SQLite）接口的权威路由与数据协议说明。
> 路由清单直接提取自 `backend/domains/{user,goods,order,delivery,admin}/routes.js` 与 `backend/server.js`
> （全部路由经 `app.use('/api', …)` 挂载），与线上代码保持一致；业务实现细节对照各域 `service.js`、
> `queries.js` 与 `backend/services/*`。

## 子文档导航

| 子文档 | 内容 |
| --- | --- |
| [00_通用约定与错误码.md](00_通用约定与错误码.md) | Base URL、统一响应结构、鉴权方式、公开接口、分页/编号约定 + HTTP 状态码与业务失败约定 |
| [01_用户与商品接口.md](01_用户与商品接口.md) | user 域：登录/资料/楼栋/购物车/地址/红点；goods 域：商品/活动/店铺状态（含商家商品·活动管理） |
| [02_订单接口.md](02_订单接口.md) | order 域：下单/支付/列表/取消/申请/售后/商家订单 |
| [03_配送接口.md](03_配送接口.md) | delivery 域：点位/配送追踪/用户取餐/批次设备/平台回调 |
| [04_商家接口.md](04_商家接口.md) | merchant（商家端跨域聚合）：工作台/任务/上货/监控 |
| [05_管理域与大屏接口.md](05_管理域与大屏接口.md) | admin 域：管理员登录/会话/管理操作；dashboard 只读聚合；公开 shop/status |
| [06_关键接口详述.md](06_关键接口详述.md) | 12 个核心接口的出入参 JSON 示例与处理逻辑要点 |
| [07_WebSocket推送.md](07_WebSocket推送.md) | /ws 连接校验、订阅协议、推送事件与载荷 |

## 二、接口清单（按域）

> 分域依据文件归属（`backend/domains/*/routes.js`），URL 均为 `/api` 前缀下的实际路由。
> 商家端（`/api/merchant/*`）接口分散在 goods / order / delivery 三个域文件中，详见 [04_商家接口.md](04_商家接口.md)。
