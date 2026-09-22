# 商家登录（微信一键登录 + 邀请码）
> 页面路径：pages/user/login（商家端小程序）


- **数据来源**：`onShow` 读本地缓存 `runtimeFlags.login === 'demo'`，决定按钮文案「模拟登录（演示）」或「微信一键登录」，并显示对应演示模式说明行。
- **页面构成**：顶部品牌区（圆形 logo + 「零栋商家」+「商家登录管理商品与配送」）；中部「商家邀请码」输入框（占位「首次登录必填，由店主提供」）+ 提示「商家权限只能凭邀请码授予，客户端无法自行声明身份」；底部主按钮 + 协议声明「登录即同意《商家入驻协议》与《隐私政策》」。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 邀请码输入 | onCodeInput | 更新 `merchantCode` | — |
| 微信一键登录 | wechatLogin | `wx.login` 取 code → POST /api/auth/login（body：`code、client:'merchant'、nickname:'零栋铺子'、merchant_code`，`needAuth:false`） | 校验通过后 `wx.switchTab` → /pages/index/index |

- **重点链路**：登录接口显式传 `needAuth: false`（否则被 `request` 的未登录拦截永远发不出去）；`client:'merchant'` 供后端选择商家端 appid/secret 走真实 code2session，不再传 `role` —— 服务端不接受客户端自报身份，商家权限只能凭 `merchant_code` 授予。**先校验身份再落盘**：`res.user.role !== 'merchant'` 时弹窗「当前不是商家账号」并直接 return，绝不写 token —— 否则下次冷启动跳过登录页，之后所有 `/merchant/*` 都会 403，用户只看到「无权限」却没有任何路径回登录页。通过后依次写 `token`、`userInfo`、`runtimeFlags`（运行模式标志），置 `autoEnterShop = true`，toast「登录成功」后 500ms `wx.switchTab` 回首页。
- **状态与边界**：`logging` 防重复提交（按钮置灰）；失败 toast 展示后端 `msg` 或兜底文案；演示模式提示「当前后端未配置商家端微信凭据，登录为演示模式（不产生真实微信身份）」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
