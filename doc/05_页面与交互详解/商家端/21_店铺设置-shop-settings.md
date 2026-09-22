# 店铺设置（营业/歇业、自动接单、配送费、退出登录）
> 页面路径：pages/shop/settings（商家端小程序）


- **数据来源**：`onLoad` → `shopState.loadShop()`（GET /api/merchant/shop）后回填 `business / autoAccept / deliveryFee`（配送费非法值回退 1 元，`toFixed(2)` 展示）。
- **页面构成**：「商铺设置」卡 = 营业状态分段控件（歇业/营业，选中态蓝）+ 自动接单 switch + 配送费输入行（¥ 前缀 + digit 输入框 + 「/单」后缀）；底部说明文字（歇业暂停接单、自动接单开启后扫码直接接单、配送费整单收取一次）；第二卡 = 「配送监控」入口 + 「退出登录」（红字）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 营业/歇业分段 | setBusiness | `shopState.setBusiness(val)` → PUT /api/merchant/shop `{business_status: 'open'|'closed'}` | 成功 toast「已切换为营业，可正常接单 / 已切换为歇业，暂停接单」 |
| 自动接单开关 | onAutoAccept | `shopState.setAutoAccept(val)` → PUT /api/merchant/shop `{auto_accept: 1|0}` | 成功 toast 开启/关闭提示 |
| 配送费输入（失焦提交） | onFeeInput / onFeeBlur | 校验 0~999 数字（空/非数字/越界 toast「请输入 0~999 的金额」并回退）；合法则 `shopState.setDeliveryFee(n)` → PUT /api/merchant/shop `{delivery_fee}`（限 0~999、保留两位小数） | 成功 toast「配送费已更新为 ¥xx.xx」 |
| 配送监控入口 | goMonitor | — | navigateTo /pages/delivery/monitor |
| 退出登录 | logout | `request.clearLoginState()`（清 token/userInfo/runtimeFlags/shopInfo + globalData + 断开推送 WebSocket） | 500ms 后 `wx.reLaunch` → /pages/user/login |

- **重点链路**：设置与读取均以后端为真源，本地仅缓存（`shopState.js` 注释明示）；`setBusiness/setAutoAccept/setDeliveryFee` 请求失败时乐观更新本地缓存保证 UI 不卡死。配送费**失焦才提交**，避免边输边请求；改价不影响已产生的历史订单（页面提示文案一致）。
- **状态与边界**：歇业期间暂停接新单、已接订单正常配送；自动接单开启后扫码将直接接单；退出登录清理彻底，防止共用店员手机时下一位登录者看到上一位商家的营业状态、自动接单开关与配送费。

---

[← 返回 05 页面与交互详解 索引](../README.md)
