提交：P4 动态承诺时间（后端公式 + /order/promise + 用户端尽快送达动态化）

## 一、本次范围

| 文件 | 改了什么 |
| --- | --- |
| `backend/domains/order/service.js` | 新增 `estimatePromise(store, deps, landmarkId)`：承诺 = 攒单剩余（batchHoldMs，与组单窗口同一口径）+ 排队等车（待发批次数超出可用车 × 每趟行程）+ 路网行程（v2EstimateTripMin 真实坐标）+ 缓冲（PROMISE_BUFFER_MIN）；超 PROMISE_MAX_MINUTES 返回 `{busy:true}` 不给数字。`createOrder` 响应挂 `promise`（拆单共用一次计算） |
| `backend/domains/order/routes.js` | 新增 `GET /order/promise?landmark_id=`（下单确认页选点拉取）；`/order/detail` 响应挂 `promise` |
| `backend/domains/delivery/timers.js` | `carState` 结果缓存到模块级 `lastCarState` + 导出 `cachedCarState()`（P4 读取"最近一轮扫描"的可用车，不阻塞下单/详情） |
| `backend/server.js` | orderRoutes deps 注入 `cachedCarState: deliveryTimers.cachedCarState` |
| `backend/.env.example` | 批次段更新（BATCH_WAIT_MS 已删 → BATCH_HOLD_MS + BATCH_PRESSURE_K）；新增 P4 承诺参数（PROMISE_MAX_MINUTES=30 / PROMISE_BUFFER_MIN=3 / PROMISE_DEFAULT_CARS=2） |
| `backend/tests/test_promise_eta.js` | **新增**：8 项单元测试（无压力近楼栋 18~26 分钟 / 压力下窗口缩短+排队 / 远楼栋+高压力 busy=true / 无坐标退化 / 车况缓存生效） |
| `用户端/pages/order/confirm.js` | 「尽快送达」不再硬编码 +30 分钟：`loadPromise()` 按选中点拉 `/order/promise`，`promiseMin`/`promiseBusy` 驱动 `asapEtaText`（「预计 HH:MM 送达」或「当前繁忙」）；换点/进页触发重算 |
| `用户端/pages/order/confirm.wxml` | 尽快送达展示改 `asapEtaText`（含时间选择弹层）；busy 时加 `busy` 样式类 |
| `用户端/pages/order/detail.wxml` | 配送信息加「预计送达：约 N 分钟内送达 / 当前繁忙，未承诺时间」 |
| `用户端/utils/api.js` | 加 `orderPromise: '/order/promise'` |
| `doc/15_上货点真实任务与组单v2落地.md` | §五 已完成补 P4；待办加「指定时间档未联动动态承诺」 |
| `agent/agent交接文档/git交接文档/git交接文档46.md` | 本文件 |

**不在本次提交**：`_tmp4\probes\tools\check_promise_endpoint.mjs`（仓库外探针）。

## 二、遇到的问题 / 踩的坑

1. **承诺在"下单前"展示需要轻量端点**：`/order/create` 返回的 promise 是下单后才拿到，太晚。加 `GET /order/promise?landmark_id=`，确认页选点即拉取，与下单响应口径一致。
2. **可用车不能每次下单都查平台**：`createOrder` 是同步路由，不能 await 平台 HTTP。方案：`carState` 每轮扫描（BATCH_SCAN_MS=15s）后缓存结果，promise 读缓存（新鲜度 ≤15s），无缓存用 `PROMISE_DEFAULT_CARS` 兜底。
3. **本地档微信 code 登录失败**：验证 `/order/promise` 时 student code 登录 401（pilot 档无微信凭据），改用账号密码登录（LDPZstu1）后通过。
4. **用户端确认页时间选择器**：`asapEta` 原是固定 +30 分钟，改动态后保留 30 分钟作"承诺接口失败"兜底，不因网络抖动把展示搞空。

## 三、校验记录

- `node --check`：order service/routes、server、delivery timers、用户端 confirm.js/detail.js/api.js 全部 exit 0。
- 后端回归：`run_backend_tests.mjs` → **18/18 通过**（新增 `test_promise_eta.js` 8 项）。
- 端点实测（本机后端）：`/order/promise?landmark_id=8`（东苑1栋近）→ 24 分钟；`=13`（东苑7栋远）→ 27 分钟（真实坐标行程生效）；`=9999`（不存在）→ 18 分钟（固定粗估兜底，不崩）。
- 提交前 `git status --short` 确认工作区只有本表文件。

## 四、提交信息原文

```
提交：P4 动态承诺时间（后端公式 + /order/promise + 用户端尽快送达动态化）

后端：estimatePromise = 攒单剩余(batchHoldMs 同口径) + 排队等车(待发-可用车×每趟)
  + 路网行程(v2EstimateTripMin 真实坐标) + 缓冲(PROMISE_BUFFER_MIN)；
  超 PROMISE_MAX_MINUTES=30 返回 busy（前端显示「当前繁忙」不撒谎）。
  新增 GET /order/promise?landmark_id= 供确认页选点拉取；create/detail 响应带 promise。
  可用车读 carState 最近一轮扫描缓存（≤15s 新鲜度，不阻塞下单），无缓存退 PROMISE_DEFAULT_CARS。
用户端：确认页「尽快送达」不再硬编码 30 分钟，按后端承诺动态显示；
  订单详情加「约 N 分钟内送达 / 当前繁忙」。
测试：test_promise_eta.js 8 项通过；全量 18/18 通过。
```

## 五、提交号

`（本提交自身的提交号无法写进自己，见下一次文档提交或 git log）`

## 六、是否已推送

是（`git pull --rebase` 后 `git push origin main`；推送后复核 `origin/main...HEAD` = `0  0`）。
