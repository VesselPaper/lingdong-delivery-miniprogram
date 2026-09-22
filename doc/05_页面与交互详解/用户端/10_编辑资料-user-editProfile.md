# 编辑个人信息：头像即选即传 + 昵称/手机号
> 页面路径：pages/user/editProfile（用户端小程序）


**页面职责**：独立的个人资料编辑页（我的页卡片「编辑」进入），头像单独即传即存。

**页面结构（wxml 骨架）**：信息卡（头像按钮 + 昵称输入 + 手机号输入）→ 提示文案 → 底部「保存」按钮。

**页面要素与数据来源**：`onLoad` → GET `/api/user/profile` 回填 `avatarUrl / nickname / phone`（未登录时 request 层自动引导登录）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/user/editProfile.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 头像（`open-type="chooseAvatar"`） | `onChooseAvatar` | `avatar.chooseAndSave`：读临时头像为 base64 → POST `/api/user/avatar`（`name, data`）→ 写 storage `userInfo` → 回填 `avatarUrl`（选中即上传即保存，不等「保存」按钮） | 上传中 loading、失败 toast |
| 昵称输入（`type="nickname"`） | `onNickname` | 记录昵称（最长 20 字） | — |
| 手机号输入 | `onPhone` | 记录手机号（最长 11 位，选填） | — |
| 「保存」 | `save` | 昵称必填、手机号格式校验 → `saving` 防重 → PUT `/api/user/profile`（`nickname, phone`）→ 写 storage `userInfo` → toast「已保存」 | 500ms 后 `wx.navigateBack()` |

**状态与边界**：昵称为空或手机号不合法弹 toast 不提交；保存失败复位 `saving` 并 toast 错误信息；头像与昵称/手机号分属两个接口，头像改动立即生效。头像上传细节在 `用户端/utils/avatar.js`：微信规定小程序拿不到用户微信头像，必须由用户主动点 `chooseAvatar` 按钮，选择器默认即为微信头像。

---

[← 返回 05 页面与交互详解 索引](../README.md)
