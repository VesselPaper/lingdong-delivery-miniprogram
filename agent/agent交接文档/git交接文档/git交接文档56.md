提交：本机测试后端（多店铺演示环境）+ 修掉「重启把店主搬回 1 号店」

> 编号：git 交接文档 55 → 本份 56。
> 本份对应**一笔提交**（本机测试后端脚本 + 启动自愈修复 + 测试 + 文档），与代码**同一次提交**。
> 提交号：见 `git log --oneline -2`（提交号无法自指）。
> 推送状态：**未推送**（负责人要求先真机验收，四笔旧提交 `3c75977`/`392068b`/`9b24758`/`8a7efe3` 也还没推）。

## 一、为什么还有这一笔

云端 `47.108.151.96:3000` 现在跑的是正式后端，小程序默认也连它。一期多店改造要在手机上反复「切店 → 加购 → 下单」，直接连着云端试等于拿生产库和生产平台做实验（下单会真进库、`PLATFORM_MOCK` 关着时还可能碰真实调度）。而按老办法在本机 `node server.js` 起后端，用 `.env` 里的真实凭据又会构成「两台机器同时连真实平台」——这是项目明令禁止的。

所以这笔补一个**只走 mock、独立库、一条命令**的本机测试后端；顺带在这一轮真机联调里挖出一个真 bug（见下）。

## 二、本次范围（7 个文件，其中 1 个新增）

| 文件 | 改了什么 |
| --- | --- |
| `backend/tools/local-server.js`（新增，185 行） | 本机测试后端启动器。`--port`（默认 3100）/`--host`/`--db`/`--fresh`/`--copy-real`/`--no-seed`。强制 `LINGDONG_DB` 指独立库、`RUN_MODE=demo`、`PLATFORM_MOCK=true`、`PAY_MOCK=true`、`VIRTUAL_ROBOT=1`、清空微信/支付凭据；种 3 家店（零栋铺子 / 东苑超市 / 南苑面馆·歇业）+ 商品分流 + 三个店主账号；打印库路径、三端地址、店铺/账号清单、**手机该用哪个网卡 IP**；最后 `spawn` 起 `server.js` |
| `backend/services/shops.js` | 新增 `backfillLegacyMembers(store)`：只给「`shop_members` 里一行都没有」的商家账号补 1 号店（`NOT EXISTS` 守卫），返回新增行数；`shopOfUser` 的取值顺序由 `ORDER BY shop_id` 改为 `ORDER BY id`（以首条成员行为准，不再受店铺编号影响） |
| `backend/db.js` | 启动自愈从**内联 SQL**改为调用 `require('./services/shops').backfillLegacyMembers(db)`（失败静默，与原来一致），保证只有一份实现 |
| `backend/tests/test_shop_isolation.js` | 新增第 [12] 组 7 项断言（全量 12 组 89 项）：自愈只补「完全没有成员行」的账号、连跑两次幂等、自愈后 A/B 账号仍各在自己店；反向验证真·存量账号会被补进 1 号店、补过之后不再重复 |
| `doc/16_小程序扩容方案.md` | 新增 §14.5「本机测试后端」；开头提交状态改「已分四笔提交」；§14.2 断言数改为 12 组 89 项（旧写的 11 组 79 项是早前版本留下的数字，按实际打印的 ✔ 重数） |
| `README.md` | 新增 §3.1「推荐：一条命令起本机测试后端」，含参数表与手机连法；§1.3 的「本机不要再常驻起后端」补一句"只做本机联调请走 3.1（mock 档不连真实平台，可与云端同时开着）" |
| `agent/agent交接文档/...` | 本份 + `会话交接文档/交接文档31.md` |

## 三、遇到的问题 / 踩的坑

1. **每次重启都把店主搬回 1 号店（真 bug，本轮核心）**。现象：本机测试后端里 `LDPZmar2`/`LDPZmar3` 明明种到了 2/3 号店，登录后 `/merchant/shop` 却永远返回零栋铺子。查 `shop_members` 发现同一账号同时有 `(1,1)` 和 `(2,1)` 两行。根因两处叠加：`db.js` 启动自愈的 SQL 是 `INSERT OR IGNORE ... SELECT 1, u.id ...` 且唯一索引是 `(shop_id,user_id)` —— 换个店再插一次永远不冲突，于是**每次启动都给所有商家账号补一条 1 号店行**；`shopOfUser` 又按 `ORDER BY shop_id` 取最小，于是已归 2/3 号店的店主被静默改回 1 号店。隔离测试没抓到是因为它每次新建临时库、只跑一次。修法与断言见上表，`[12]` 组就是钉这个。
2. **旧进程占着端口，我一度以为在跑新代码**。第一版 `local-server.mjs` 起在 3110，改完代码重新 `--fresh` 时新进程直接 `EADDRINUSE` 退出，但请求仍打到了 14:52 那个**跑旧代码的进程**上，于是"改了没效果"、看到的还是旧的成员行数据。教训：**重启前先按端口找 OwningProcess 杀掉**（`Get-NetTCPConnection -LocalPort 3100 -State Listen`），别只看 job 是否"已完成"——父进程退出后子 `node server.js` 会变成孤儿继续占端口。
3. **`local-server.mjs` 起不来**：`ReferenceError: require is not defined in ES module scope`。后端 `package.json` 没有 `"type": "module"`，`.mjs` 后缀强制 ESM 而脚本是 CJS 写法，改名为 `local-server.js` 即可。
4. **`test_shop_isolation.js` 端口写死 3110**，我的本地测试后端一开始也起在 3110，导致测试子进程 `EADDRINUSE` 死掉、健康检查却打到了我的服务上（"server up" 假通过）然后临时库建表炸掉。现在本地服务默认回 3100，跑回归前确认 3110 空闲。
5. **网卡枚举顺序坑**：`os.networkInterfaces()` 第一张非内网网卡在这台机器上是 Radmin VPN（26.x），照它写进 `config.js` 手机必然连不上。启动器改成只挑「无线/有线」网卡、把 VPN/VMware/Wi-Fi Direct/PPPoE 标成「虚拟」并全列出来；一张真网卡都没有时（本次 WLAN 就是断开的）明确提示"先把电脑连上 Wi-Fi 再重跑"。
6. **判读方式**（老坑复述）：`node tests\test_x.js 2>&1 | ...` 会把 SQLite `ExperimentalWarning` 并进来，pwsh 报 `[exit code: 1]` 但实际是绿的。本轮改用 `_tmp4/probes/tools/run_backend_suite.cjs`（`spawn` 直接拿子进程退出码 + 汇总），不再受管道影响。

## 四、校验记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | 改动 JS 逐个 `node --check` | ✔ 通过 |
| 隔离测试（12 组 89 项） | `node tests\test_shop_isolation.js` | ✔ 全部通过，0 个 ✘ |
| 全量回归（20 个文件） | `node _tmp4\probes\tools\run_backend_suite.cjs` | ✔ 20/20 通过（含 `test_batch_v2_e2e.js` 394s） |
| 本机测试后端 · 归属 | `node _tmp4\probes\tools\check_local_shops.cjs 3100` | ✔ `LDPZmar1→1 零栋铺子`、`LDPZmar2→2 东苑超市`、`LDPZmar3→3 南苑面馆` |
| 本机测试后端 · 两种启动 | `--fresh` 与「重启复用同库」各跑一次 | ✔ 两次归属完全一致（自愈幂等，不再搬店） |
| 本机测试后端 · 三端可达 | `/admin/`、`/dashboard/`、`/api/shop/list` | ✔ 均 200（前两个返回 HTML，`shop/list` 返回 3 家店） |
| 演示数据 | 启动横幅 | ✔ 3 家店、商品 217/6/3、成员各 1（说明回填不再重复插行） |

## 五、提交信息原文

```
提交：本机测试后端（多店铺演示环境）+ 修掉「重启把店主搬回 1 号店」

云端 3000 已是正式后端，多店改造要在手机上反复切店下单，不能拿生产库和生产平台做实验。
新增 backend/tools/local-server.js：一条命令起独立库 + 强制 mock + 3 家演示店与各自店主，
启动横幅给出管理网页/大屏/API 地址和「手机该用哪张网卡的 IP」。

同时修 db.js 的存量商家回填：原内联 SQL 没有排重条件、唯一索引又是 (shop_id,user_id)，
每次启动都给所有商家账号补一条 1 号店成员行；shopOfUser 按 shop_id 取最小，
于是已归 2/3 号店的店主每次重启被静默搬回 1 号店。

- tools/local-server.js（新增）：--port/--fresh/--copy-real/--no-seed；只推无线/有线网卡
- services/shops.js：backfillLegacyMembers（NOT EXISTS 守卫）+ shopOfUser 改 ORDER BY id
- db.js：启动自愈改为调用 backfillLegacyMembers，删掉内联 SQL
- test_shop_isolation：第 [12] 组 7 项断言（重启不搬店 + 存量账号仍补 1 号店）
- doc/16：新增 §14.5 本机测试后端；断言数改 12 组 89 项
- README：新增 §3.1 一条命令起本机测试后端
```

- 提交号：见 `git log --oneline -2`
- 推送：**未推送**

## 六、遗留待办

1. 小程序真机验收（负责人自己在微信开发者工具跑；现在多了本机测试后端这条路，可以直接连着 3100 试多店）。
2. 四笔旧提交 + 本笔一起 `git pull --rebase` 后推 `origin/main`（等负责人口令）。
3. 管理员网页的店铺管理面板（接口已就绪，界面未做）。
4. 起送价 / 打包费进计价链路、店铺列表/详情页、多点上货（二期）。
