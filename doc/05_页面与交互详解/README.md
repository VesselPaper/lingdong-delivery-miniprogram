# 05 · 页面与交互详解（目录）

最后更新：2026-09-25
说明：本项目全部前端界面的逐页逐按钮详解，**一个页面一个文档**，按端分子目录存放；每个页面文档的写法统一为：页面职责 → 数据来源（onLoad/onShow 接口）→ 交互清单表（按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转）→ 重点链路单列 → 状态与边界。

## 目录结构

```
05_页面与交互详解/
├── README.md                ← 本索引
├── 用户端/                   # 用户端小程序：00 公共文件 + 20 个页面文档
├── 商家端/                   # 商家端小程序：00 公共文件 + 22 个页面文档 + 23 组件说明
└── 管理端与大屏/             # 浏览器端：01 管理员网页 + 02 可视化大屏
```

## 用户端（微信小程序，18 个页面 + tabBar）

| 页面路径 | 文档 |
| --- | --- |
| pages/index/index 首页 | [01_首页-index.md](用户端/01_首页-index.md) |
| pages/goods/list 商城 | [02_商城-goods-list.md](用户端/02_商城-goods-list.md) |
| pages/goods/detail 商品详情 | [03_商品详情-goods-detail.md](用户端/03_商品详情-goods-detail.md) |
| pages/cart/cart 购物车 | [04_购物车-cart.md](用户端/04_购物车-cart.md) |
| pages/order/confirm 确认订单 | [05_确认订单-order-confirm.md](用户端/05_确认订单-order-confirm.md) |
| pages/activity/index 活动列表 | [06_活动列表-activity-index.md](用户端/06_活动列表-activity-index.md) |
| pages/user/login 登录 | [07_登录-user-login.md](用户端/07_登录-user-login.md) |
| pages/user/profile 我的 | [08_我的-user-profile.md](用户端/08_我的-user-profile.md) |
| pages/user/settings 设置 | [09_设置-user-settings.md](用户端/09_设置-user-settings.md) |
| pages/user/editProfile 编辑资料 | [10_编辑资料-user-editProfile.md](用户端/10_编辑资料-user-editProfile.md) |
| pages/address/list 地址列表 | [11_地址列表-address-list.md](用户端/11_地址列表-address-list.md) |
| pages/address/edit 地址编辑 | [12_编辑地址-address-edit.md](用户端/12_编辑地址-address-edit.md) |
| pages/order/list 订单列表 | [13_订单列表-order-list.md](用户端/13_订单列表-order-list.md) |
| pages/order/detail 订单详情 | [14_订单详情-order-detail.md](用户端/14_订单详情-order-detail.md) |
| pages/order/cancelRequest 取消申请 | [15_取消申请-order-cancelRequest.md](用户端/15_取消申请-order-cancelRequest.md) |
| pages/order/refund 退款投诉 | [16_退款投诉-order-refund.md](用户端/16_退款投诉-order-refund.md) |
| pages/delivery/track 配送追踪 | [17_配送追踪-delivery-track.md](用户端/17_配送追踪-delivery-track.md) |
| pages/delivery/pickup 取餐 | [18_取餐-delivery-pickup.md](用户端/18_取餐-delivery-pickup.md) |
| pages/delivery/scanPickup 扫码取餐 | [19_扫码取餐-delivery-scanPickup.md](用户端/19_扫码取餐-delivery-scanPickup.md) |
| pages/refund/list 售后记录 | [20_售后记录-refund-list.md](用户端/20_售后记录-refund-list.md) |
| — 公共文件 — | [00_公共约定与接口速览.md](用户端/00_公共约定与接口速览.md)（请求封装/登录态/tab/接口速览/跨页联动/存疑点） |

## 商家端（微信小程序，22 个页面 + 6 组件）

| 页面路径 | 文档 |
| --- | --- |
| pages/index/index 首页 | [01_首页-index.md](商家端/01_首页-index.md) |
| pages/user/login 商家登录 | [02_登录-user-login.md](商家端/02_登录-user-login.md) |
| pages/shop/home 工作台 | [03_工作台-shop-home.md](商家端/03_工作台-shop-home.md) |
| pages/orders/list 任务页 | [04_任务页-orders-list.md](商家端/04_任务页-orders-list.md) |
| pages/orders/history 历史订单 | [05_历史订单-orders-history.md](商家端/05_历史订单-orders-history.md) |
| pages/orders/detail 订单详情 | [06_订单详情-orders-detail.md](商家端/06_订单详情-orders-detail.md) |
| pages/orders/scanMatch 配单结果 | [07_配单结果-orders-scanMatch.md](商家端/07_配单结果-orders-scanMatch.md) |
| pages/orders/aftersale 售后列表 | [08_售后列表-orders-aftersale.md](商家端/08_售后列表-orders-aftersale.md) |
| pages/orders/aftersaleDetail 售后详情 | [09_售后详情-orders-aftersaleDetail.md](商家端/09_售后详情-orders-aftersaleDetail.md) |
| pages/orders/cancelRequests 取消申请列表 | [10_取消申请列表-orders-cancelRequests.md](商家端/10_取消申请列表-orders-cancelRequests.md) |
| pages/orders/cancelRequestDetail 取消申请详情 | [11_取消申请详情-orders-cancelRequestDetail.md](商家端/11_取消申请详情-orders-cancelRequestDetail.md) |
| pages/orders/exception 配送异常 | [12_配送异常-orders-exception.md](商家端/12_配送异常-orders-exception.md) |
| pages/device/loading 上货配单 | [13_上货配单-device-loading.md](商家端/13_上货配单-device-loading.md) |
| pages/device/batchDetail 批次上货 | [14_批次上货-device-batchDetail.md](商家端/14_批次上货-device-batchDetail.md) |
| pages/goods/list 商品管理 | [15_商品管理-goods-list.md](商家端/15_商品管理-goods-list.md) |
| pages/goods/edit 商品编辑 | [16_商品编辑-goods-edit.md](商家端/16_商品编辑-goods-edit.md) |
| pages/activity/list 活动管理 | [17_活动管理-activity-list.md](商家端/17_活动管理-activity-list.md) |
| pages/activity/edit 活动编辑 | [18_活动编辑-activity-edit.md](商家端/18_活动编辑-activity-edit.md) |
| pages/delivery/monitor 配送监控 | [19_配送监控-delivery-monitor.md](商家端/19_配送监控-delivery-monitor.md) |
| pages/device/robotQr 无人车二维码 | [20_机器人二维码-device-robotQr.md](商家端/20_机器人二维码-device-robotQr.md) |
| pages/shop/settings 店铺设置 | [21_店铺设置-shop-settings.md](商家端/21_店铺设置-shop-settings.md) |
| pages/user/profile 我的 | [22_我的-user-profile.md](商家端/22_我的-user-profile.md) |
| — 组件 — | [23_组件说明.md](商家端/23_组件说明.md)（batch-card / order-card / goods-row / status-text / search-box / empty-view） |
| — 公共文件 — | [00_页面总览与通用机制.md](商家端/00_页面总览与通用机制.md)（页面清单/导航关系/数据加载时机/状态样式映射/跨页链路小结） |

## 管理端与大屏（浏览器，后端同端口）

管理员网页含登录 + 四个页面视图（总览 / 配送任务 / 历史记录 / 设置），**一个视图一个文档**；大屏为单页看板：

| 页面 | 文档 |
| --- | --- |
| 管理员网页（/admin） | [README.md](管理端与大屏/README.md) 索引 → `管理员网页/00~06`：骨架与通用机制 / 登录与会话 / 总览页 / 配送任务页 / 历史记录页 / 设置页 / 构建机制 |
| 可视化大屏（/dashboard） | [可视化大屏.md](管理端与大屏/可视化大屏.md)（布局/数据源/3D 地图/刷新部署） |

## 阅读约定

- 页面数量与路由以两端 `app.json` 实际注册为准（用户端 20 页 + 商家端 22 页，含 tabBar）；
- 每个页面文档独立成文，公共逻辑（请求封装、登录态、storage 键、接口速览）集中在各端 `00_` 文件，页面文档内直接引用；
- 交互表中的「触发函数」一律为页面 js 内真实函数名，「接口」为完整路径（如 `POST /api/order/create`），与后端路由一一对应。
