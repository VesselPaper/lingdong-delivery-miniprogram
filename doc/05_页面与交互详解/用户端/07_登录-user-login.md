# 登录：微信一键登录 + 登录失效兜底
> 页面路径：pages/user/login（用户端小程序）


**页面职责**：微信一键登录入口，也是 401/403 清登录态后的兜底落点。

**页面结构（wxml 骨架）**：品牌区（logo + 「零栋GO」+ 副标题）→ 登录按钮区（「微信一键登录」/「模拟登录（演示）」+ 协议提示文案）。

**页面要素与数据来源**：`onShow` 读 storage `runtimeFlags`，若 `flags.login === 'demo'` 则按钮显示「模拟登录（演示）」（后端未配用户端微信凭据时的演示模式，提示「不产生真实微信身份」）。登录接口本身免鉴权（`needAuth: false`）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/user/login.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 「微信一键登录 / 模拟登录（演示）」 | `wechatLogin` | `logging` 重入保护 → `wx.showLoading('登录中')` → `wx.login` 取 code → POST `/api/auth/login`（`{ code, client: 'user', nickname: '' }`，`client: 'user'` 供后端选用户端 appid/secret 走真实 code2session）→ 成功写 storage `token / userInfo / runtimeFlags` → toast「登录成功」 | 500ms 后 `wx.switchTab('/pages/index/index')`（回首页而非强制回「我的」） |

**重点链路**：**401/403 清登录态**：登录态在 `用户端/utils/request.js` 统一维护——任一请求收到 401/403 → `clearLoginState()` 清掉 10 个 storage 键与 `globalData` → `toLogin()` 进本页；本页登录成功后重写 `token / userInfo / runtimeFlags`，被清掉的 `user_point / search_history` 等本地数据由各页面按需重建。`clearLoginState` 同时用于设置页「退出登录」（同一套清理路径，保证换人登录看不到上一位用户的状态）。

**状态与边界**：`logging` 期间按钮禁用防连点；登录失败按 `e.message` 弹 toast 并复位；登录成功固定回首页，避免入口总落在「我的」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
