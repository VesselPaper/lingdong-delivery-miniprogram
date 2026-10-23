提交：补齐「建店」入口（管理员店铺接口）+ 隔离测试扩到 79 项 + 修掉测试库锁偶发失败

> 编号：git 交接文档 54 → 本份 55。
> 本份对应**一笔提交**（后端 admin 店铺接口 + 两个测试 + 文档），与代码**同一次提交**。
> 提交号：见 `git log --oneline -2`（提交号无法自指，`3c75977`/`392068b` 的做法与此一致）。
> 推送状态：**未推送**（负责人要求先真机验收）。

## 一、为什么还有这一笔

前两笔提交把"多店地基"做完了，但复核 `doc/16_小程序扩容方案.md` §6.3 时发现清单里还有一项没落地：

> `backend/domains/admin/*` ｜ 商家管理页增加店铺维度（**建店**、绑定店主、绑定取货点）

实际状态是：绑定店主已经做了（`/admin/merchants/create` 支持 `shop_id`），**建店没有**——想接第二家店只能手写 SQL 往 `shops` 里插一行。而"能接第二家店"正是一期的目标，留个手写 SQL 的口子等于目标没闭环（漏了 `code` 或 `sort`，前端排序和按 code 找店都会出错）。

管理员网页的**面板**仍然没做（方案自己把这项标为"需人工回归"），所以这笔只补接口：接口先能建店、能改店、能搬店主，网页要的时候直接调。

## 二、本次范围（6 个文件）

| 文件 | 改了什么 |
| --- | --- |
| `backend/services/shops.js` | 新增 `createShop(store, patch)`：名称必填（≤40 字）、`code` 唯一、金额夹在 0~999、`business_status` 只认 open/closed；新增 `updateShop(store, id, patch)`：**只改传了的字段**（改营业状态不会顺手把取货点/起送价清空），`code` 冲突抛错；内部小工具 `money()` / `codeTaken()` |
| `backend/domains/admin/queries.js` | 新增 `shopsAdminList(store)`：每店带 `goods_count`（商品数）、`today_orders`（今日单量）、`owner_username`（店主账号）、`member_count`（成员数），供店铺列表一眼判断"这家店配没配人、有没有货、今天有没有生意" |
| `backend/domains/admin/routes.js` | 新增 4 个管理员接口：`GET /admin/shops`（列表）、`POST /admin/shops/create`（建店）、`PUT /admin/shops/update`（改店，不存在 404）、`POST /admin/shops/bind-merchant`（把账号绑到店，可设 owner/staff）。搬店时**先清该账号的旧成员行**——`shopOfUser` 取的是最小 `shop_id`，不清会"绑了新店却还落旧店"。全部写审计 |
| `backend/tests/test_shop_isolation.js` | 新增第 [11] 组 18 项断言（总量 61 → 79）：无令牌 401/403、列表带店主/商品数/单量、建店缺名称 400、code 重复 400、建店成功且 `/shop/list` 立刻可见、改店只改传的字段（取货点 11 与起送价 15 不被清空）、改不存在的店 404、建商家账号带 `shop_id` 后登录即新店、搬店主后 `shop_members` 只剩一条、绑到不存在的店 404。同时补 `apiAdmin()` 辅助函数（管理员接口走 `x-admin-token`，不是 `Bearer`） |
| `backend/tests/test_cancel_tasks.js` | 测试自己那条库连接加 `PRAGMA busy_timeout = 5000`（见下"踩的坑"第 3 条） |
| `doc/16_小程序扩容方案.md` | §14.1 补「建店入口」一行、§14.2 断言数 61 → 79、§14.4 补"管理员网页没有店铺管理界面"这条遗留；开头改成"已分三笔提交到本地 main、尚未推送" |

## 三、遇到的问题 / 踩的坑

1. **管理员接口不是 `Bearer`**：`adminGuard` 读的是 `x-admin-token` 头（账号密码登录签发的 session token）。第一次在隔离测试里用 `Authorization: Bearer` 调 `/admin/shops` 全部 401，17 项断言连带失败。定位方式：起了个临时后端（端口 3123）直接 `fetch` 打一次 `/admin/login` + `/admin/shops`，看到 `{"code":401,"msg":"未登录或登录已过期"}` 才反应过来是头名不对。
2. **改店必须"只改传了的字段"**：如果按 `req.body` 整行覆盖，管理员只点一下"歇业"，取货点、起送价、分类就会被空值冲掉。`updateShop()` 对每个字段都按"传了就改、没传保持原值"处理，测试里专门断言了这一点。
3. **`test_cancel_tasks.js` 偶发 `database is locked`**：全量跑时通过管道收集输出，测试自己那条 `DatabaseSync` 连接在 server 写入热点上不等 busy 直接报错（`Error: database is locked` at `test_cancel_tasks.js:137`），单跑 3 次都是通过 —— 典型的时序型 flake。修法是给测试自己的连接加 `PRAGMA busy_timeout = 5000`。**其它测试也有同样的写法**（`new DatabaseSync(TMP_DB)` 后立刻读），这次只修了实际复现过的这一个，其余等真的复现再补。
4. **判读方式**：`node tests\test_x.js 2>&1 | ...` 会把 Node 的 SQLite `ExperimentalWarning`（stderr）并进来，pwsh 于是报 `[exit code: 1]`，实际是绿的。要看输出里的「全部通过 / ✘」，或 `> 文件 2>&1` 后再 `$LASTEXITCODE`。

## 四、校验记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check` 改动 JS | ✔ 通过 |
| 隔离测试（79 项） | `node tests\test_shop_isolation.js` | ✔ 全部通过，退出码 0，0 个 ✘ |
| 偶发失败复验 | `node tests\test_cancel_tasks.js` 连跑 3 次 | ✔ 3/3 通过（EXIT=0，无异常行） |
| 全量回归（20 个文件） | 逐个 `node tests\test_*.js > log 2>&1` 取真实退出码 | ✔ 19/20；唯一不绿的是上面修掉之前的 `test_cancel_tasks.js`，修后单跑 3 次全绿 |
| 接口手测 | 临时后端 3123：`/admin/login` → `/admin/shops` → `/admin/shops/create` | ✔ 建店返回完整店铺行 |

## 五、提交信息原文

```
提交：补齐「建店」入口（管理员店铺接口）+ 隔离测试扩到 79 项 + 修掉测试库锁偶发失败

方案 §6.3 的「管理员侧建店」此前只做了绑定店主，建店还得手写 SQL —— 而"能接第二家店"
正是一期的目标，所以补上接口（管理员网页面板按方案留待人工回归时再做）。

- services/shops.js：createShop / updateShop（只改传了的字段、code 唯一、金额夹 0~999）
- admin/queries.js：shopsAdminList（带店主账号/商品数/今日单量/成员数）
- admin/routes.js：GET /admin/shops、POST /admin/shops/create、PUT /admin/shops/update、
  POST /admin/shops/bind-merchant（搬店清旧成员行，避免 shopOfUser 仍落旧店）
- test_shop_isolation：第 [11] 组 18 项断言（总量 79），apiAdmin 走 x-admin-token
- test_cancel_tasks：测试自身连接加 busy_timeout，修掉偶发 database is locked
- doc/16：§14 补建店入口与遗留、断言数、提交状态
```

- 提交号：见 `git log --oneline -2`
- 推送：**未推送**

## 六、遗留待办

1. **管理员网页的店铺管理面板**（建店/改店/绑定店主的界面）——接口已就绪，面板未做；按方案属于"需人工回归"的项。
2. 小程序真机验收（负责人自己在微信开发者工具跑）。
3. 推送与云上部署（等负责人口令）。
4. 起送价/打包费进计价链路（二期规则先定）。
