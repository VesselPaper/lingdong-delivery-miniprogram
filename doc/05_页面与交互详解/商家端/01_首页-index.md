# 首页 tab：站点入口与营业状态
> 页面路径：pages/index/index（商家端小程序）


- **数据来源**：`onShow` → `商家端/pages/index/index.js → onShow` 调 `shopState.loadShop()`（GET /api/merchant/shop）后 `setData({ shopOpen })`，商铺卡片右上角渲染「营业中（绿）/歇业中（灰）」标签。
- **页面构成**：顶部搜索框（占位「请输入商铺名称」）+「锁定排序」图标按钮；中部商铺卡片 = 商铺名「四川师范大学商铺」+ 营业标签 + 「上次访问」角标 + 底部「进入站点」行（时间图标 + 蓝色文字）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 搜索输入框 | onSearch | 仅更新本地 `keyword`，本页未参与过滤 | — |
| 锁定排序 | lockSort | toast「锁定排序功能开发中」 | — |
| 商铺卡片（进入站点） | goShop | — | `wx.navigateTo` → /pages/shop/home |
| tabBar 选中态同步 | onShow | `getTabBar().setData({ selected: 0 })` | — |

- **重点链路**：冷启动（`app.js → onLaunch` 检测到 token）或刚登录（登录页置位）都会把 `globalData.autoEnterShop` 置 true；首页 `onShow` 消费该标志（先置 false 再跳转），保证**只自动跳一次**，用户从工作台返回首页后不会再被弹进去。
- **状态与边界**：未登录冷启动由 `app.js → onLaunch` 直接 `reLaunch` 登录页，首页不会闪现；`shopOpen` 仅用于标签展示，真实开关以后端为准。

---

[← 返回 05 页面与交互详解 索引](../README.md)
