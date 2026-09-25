# 商家登录（账号密码，2026-09-24 起替代微信+邀请码）
> 页面路径：pages/user/login（商家端小程序）

- **数据来源**：无外部数据；表单为用户输入（用户名 + 密码）。
- **页面构成**：顶部品牌区（圆形 logo + 「零栋商家」+「商家登录管理商品与配送」）；两个输入框——用户名（占位「请输入用户名」）、密码（`type="password"`，确认键触发登录）；底部主按钮「登 录」（登录中显示「登录中…」并置灰防重复提交）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 用户名输入 | onUsernameInput | 更新 `username` | — |
| 密码输入 | onPasswordInput | 更新 `password` | — |
| 登录（按钮/确认键） | accountLogin | POST /api/auth/login（body：`username、password、client:'merchant'`，`needAuth:false`） | 校验通过后 `wx.switchTab` → /pages/index/index |

- **重点链路**：登录接口显式传 `needAuth: false`（否则被 `request` 的未登录拦截永远发不出去）；账号由管理员在管理员网页「商家管理」页创建（店主/店员）。**先校验身份再落盘**：`res.user.role !== 'merchant'` 时弹窗「当前不是商家账号」并直接 return，绝不写 token —— 否则下次冷启动跳过登录页，之后所有 `/merchant/*` 都会 403，用户只看到「无权限」却没有任何路径回登录页。通过后依次写 `token`、`userInfo`（含 `merchant_role`）、`runtimeFlags`（运行模式标志），置 `autoEnterShop = true`，toast「登录成功」后 500ms `wx.switchTab` 回首页。
- **权限落地**：`utils/role.js` 提供 `isOwner()`（读 `userInfo.merchant_role === 'owner'`）；店员登录后首页自动隐藏店主专属入口（活动管理、商铺设置），商品列表隐藏新增/改价，`goods/edit`、`activity/edit` 页 onLoad 有店主守卫。
- **状态与边界**：`logging` 防重复提交（按钮置灰）；本地先校验用户名/密码非空；失败 toast 展示后端 `msg` 或兜底文案。

---

[← 返回 05 页面与交互详解 索引](../README.md)
