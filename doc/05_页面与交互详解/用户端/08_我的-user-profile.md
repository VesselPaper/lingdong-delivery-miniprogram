# 我的（tab）：订单红点 / 地址 / 售后 / 设置入口
> 页面路径：pages/user/profile（用户端小程序）


**页面职责**：个人中心，聚合订单状态入口、配送楼栋、售后与设置。

**页面结构（wxml 骨架）**：用户卡片（头像按钮 + 昵称/身份标签/手机号 + 「编辑/登录」入口）→ 「我的订单」宫格（待付款/配送中/已送达/已完成/全部订单，前三项带红点数字）→ 菜单卡（收货地址/售后记录/配送说明/联系客服/设置）→ 页脚文案。

**页面要素与数据来源**：`onShow` 并发拉取：`load()` → GET `/api/user/profile`（`applyUser` 计算首字头像 `userInitial`、身份 `roleText`（student→学生 / merchant→商家）、手机号 `phoneText` 去除空白）；`loadBadge()` → GET `/api/user/order/badge`（`silent: true`，订单未读红点：`paying / delivering / arrived / count / unread`）；`loadPoint()` → GET `/api/user/point`（收货地址行展示当前配送楼栋 `pointName`）；同步 tab `selected: 3`。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/user/profile.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 头像按钮 | `onAvatarTap` / `onChooseAvatar` | 未登录（无 `openid`）→ `goLogin()`；已登录按钮带 `open-type="chooseAvatar"`，选头像后经 `avatar.chooseAndSave` 读 base64 上传 POST `/api/user/avatar` → 用返回的 user 刷新卡片 | 未登录跳 `/pages/user/login` |
| 用户卡片主体 | `onUserTap` | 已登录 → 编辑资料；未登录 → 登录 | `/pages/user/editProfile` 或登录页 |
| 订单宫格（待付款/配送中/已送达/已完成/全部订单） | `goOrdersTab` | 写 storage `order_tab = data-status`（空串 = 全部） | `wx.navigateTo('/pages/order/list')` |
| 订单红点数字 | —（展示 `orderBadge` 各计数） | 由 `/api/user/order/badge` 驱动，进入订单列表后由订单列表页标记已读 | — |
| 收货地址 | `goAddress` | 行内展示当前楼栋 `pointName`（改的就是首页/结算页那个楼栋） | `wx.navigateTo('/pages/address/list')` |
| 售后记录 | `goRefundList` | — | `wx.navigateTo('/pages/refund/list')` |
| 配送说明 | `showInfo` | `wx.showModal` 展示机器人配送时段与取餐说明 | — |
| 联系客服 | `contactService` | `wx.showModal` 展示联系门店/技术群提示 | — |
| 设置 | `goSetting` | — | `wx.navigateTo('/pages/user/settings')` |

**状态与边界**：未登录态卡片显示「未登录 / 登录后即可下单、查看配送进度」；头像/昵称/身份/手机号均取后端真实字段，不做补位；红点接口静默失败不影响页面；未配置楼栋时地址行显示「未设置楼栋」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
