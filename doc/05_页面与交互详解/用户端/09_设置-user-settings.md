# 设置：昵称 / 手机号 / 退出登录清 storage
> 页面路径：pages/user/settings（用户端小程序）


**页面职责**：修改昵称与手机号；提供退出登录唯一入口。

**页面结构（wxml 骨架）**：个人信息卡（昵称输入 + 手机号输入 + 卡片内「保存修改」按钮 + 提示文案）→ 账号卡（「退出登录」危险样式行）。

**页面要素与数据来源**：`onLoad` 先读本地 storage `userInfo` 回填表单，再 `loadProfile()` → GET `/api/user/profile` 以后端为准覆盖。昵称输入框 `type="nickname"`（微信昵称填写能力，键盘上方可直接选用微信昵称）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/user/settings.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 昵称/手机号输入 | `onField` | 按 `data-field` 更新表单 | — |
| 「保存修改」 | `save` | 手机号非空时校验 `/^1\d{10}$/` → PUT `/api/user/profile`（`nickname, phone`）→ 写 storage `userInfo` → toast「已保存」 | 500ms 后 `wx.navigateBack()` |
| 「退出登录」 | `logout` | `wx.showModal` 二次确认（confirm 才继续）→ `request.clearLoginState()`（清 10 个 storage 键 + `globalData`，与 401/403 失效路径同一套） | `wx.reLaunch('/pages/user/login')` |

**状态与边界**：手机号格式错误弹 toast 不提交；退出登录前必须经模态确认，防止误触；清 storage 覆盖 `token / userInfo / runtimeFlags / last_confirm / checkout_items / user_point / search_history / order_tab / goods_category / goods_keyword / goods_focus`，避免换人登录后残留上一位用户的收货信息与搜索记录。

---

[← 返回 05 页面与交互详解 索引](../README.md)
