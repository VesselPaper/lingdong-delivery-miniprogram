# git 交接文档 8

> 对应提交②：**单点登录 + 用户端账号密码登录**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `backend/db.js` | `users` 新增 `kicked_token` 列（**独立 meta 标记**迁移，不能与商家列共用标记，否则老库永远补不上）；新增 `admin_kicked_sessions` 表 |
| `backend/services/adminAuth.js` | `issueSession()` 先 `kickExistingSessions()`：把该管理员旧会话挪进被踢名单再删；新增 `wasKicked()` |
| `backend/domains/_shared.js` | `auth()` / `adminGuard()` 命中被踢名单时返回 **401 + `code:'SESSION_KICKED'`** + 中文提示"该账号已在别处登录，你已被踢下线" |
| `backend/domains/user/queries.js` | `setToken` 用 `SET kicked_token=token, token=?` —— SQLite 的 SET 右侧读的是更新前的值，正好把旧 token 存下来 |
| `backend/domains/user/service.js` | 用户端新增**账号密码登录**分支（复用管理员的 scrypt 校验），与商家端共用 `users` 表与单点登录语义 |
| `用户端/pages/user/login.{js,wxml,wxss}` | 登录页新增「用账号密码登录」（微信登录保留） |
| `用户端/utils/request.js`、`商家端/utils/request.js` | 401/403 且 `code==='SESSION_KICKED'` 时把提示写进 `login_notice` |
| `商家端/pages/user/login.js` | `onShow()` 弹"登录已失效"提示框（显示被踢原因） |
| `管理员网页/js/parts/admin/01-core.js` | 把 `code==='SESSION_KICKED'` 标成 `err.kicked`；`onUnauthorized(err)` 带上 error |
| `管理员网页/js/parts/admin/06-refresh-token.js` | 被踢时写明确横幅并保留，不被"登录已过期"覆盖 |
| `管理员网页/js/parts/admin/09b-ops.js` | 同上，操作失败时不覆盖被踢文案 |
| `管理员网页/admin.js` | `node build.js` 重新构建的产物 |

## 二、为什么这么改

三个原因叠加导致"成员登不进去"：①成员的库里没有账号（账号只在本地库，不进仓库）；②双端小程序写死了负责人本机局域网 IP；③用户端原来只有微信登录。②③在提交 `088144a` 与本提交里解决，①在提交③（默认账号自举）解决。

单点登录是负责人明确要的（"一个账号一处登录"），同时**不做复杂安全锁**（负责人明说"不要做太过于的安全锁，不然很不方便"）。

## 三、遇到的问题 / 踩的坑

1. **被顶下线必须能解释**：只删旧会话的话，旧页面只会收到笼统的"登录已过期"，用户以为系统坏了。所以专门加了"被踢名单"表/列，仅用于**解释一次**，不参与鉴权判定，过期即清理。
2. **登录接口自身的 401 不能触发全局会话失效回调**，否则会清空用户刚输入的账号密码（`01-core.js` 里 `path !== '/login'` 那个判断就是为此保留的）。
3. `users.token` 只有一个槽位：同一账号在用户端登录会顶掉它在商家端的会话，这是**有意为之**，已在 `user/service.js` 注释里写明。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| 本提交实际文件清单 | 15 个（见上表） |
| 登录函数级探针 `_tmp4\probes\verify\verify_login_sso.mjs` | 18/18 通过（《交接文档18》记录） |
| 登录 HTTP 端到端 `verify_login_http.mjs`（临时库 + 3199 + mock） | 12/12 通过 |
| 管理员网页真实浏览器 `verify_admin_login.mjs`（无头 Edge） | 默认账号登录成功；第二处登录后第一个标签被明确提示并弹回登录页；0 console 报错 |
| 后端回归 `backend/tests/test_*.js` | 11/11 exit=0 |
| 本轮是否重跑 | **未重跑**（本轮只做提交拆分，未改任何代码） |

## 五、提交信息原文

```
单点登录：同一账号只留一个会话，被顶下线时明确告知；用户端新增账号密码登录

- adminAuth：签发新会话前把该账号旧会话挪入 admin_kicked_sessions（不参与鉴权）
- _shared.auth/adminGuard：命中被踢名单返回 401 + code=SESSION_KICKED + 中文提示
- user.queries/service：用户端新增账号密码登录（复用 scrypt 校验），setToken 记录旧 token
- 双端 request.js：SESSION_KICKED 写入 login_notice；商家端登录页弹提示
- 管理员网页：err.kicked 透传，被踢文案不被通用文案覆盖
```

提交号：（见 `git log`）
是否已推送：**否**（四个提交一起推送）

## 六、遗留待办

- 小程序登录页新增的账号密码入口需要**人工目视一次**（AI 跑不了微信开发者工具）。
