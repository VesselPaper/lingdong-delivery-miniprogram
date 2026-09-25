# 04 · 核心业务链路（目录）

最后更新：2026-09-25
说明：覆盖「登录 → 选购下单 → 支付 → 接单组单 → 上货 → 配送 → 取餐 → 完成/取消/售后」的完整业务闭环，以及商家端与管理员的会话链路。每节按统一模板书写：触发点 → 请求接口 → 后端处理函数（代码定位）→ 状态流转 → 落库字段 → 结果返回/后续。
配套文档：`doc/06_接口与数据协议/`（接口细节）、`doc/08_常量与状态字典.md`（状态字典）、`doc/05_页面与交互详解/`（页面级前后端链路）。

## 子文档导航

| 子文档 | 内容 |
| --- | --- |
| [00_状态与约定.md](00_状态与约定.md) | 状态字典速查（订单/批次/任务）、运行模式与通用鉴权约定 |
| [01_登录与商品库存.md](01_登录与商品库存.md) | 用户登录（演示/真实）、商品浏览与库存/销量结算 |
| [02_下单支付与接单组单.md](02_下单支付与接单组单.md) | 下单（拆单/编号/优惠）、支付、商家接单与 best-fit 组单 |
| [03_上货与配送.md](03_上货与配送.md) | 上货（开舱/关舱）、召唤与直发两种配送模式、路线规划 |
| [04_取餐与完成.md](04_取餐与完成.md) | 用户取餐（开舱/关舱）、批次完成条件 |
| [05_取消与售后.md](05_取消与售后.md) | 免费窗口取消、取消申请、退款/投诉与异常配送处理 |
| [06_取餐超时与管理会话.md](06_取餐超时与管理会话.md) | 取餐超时两段式、管理员登录与会话 |

阅读约定：
- 「后端处理函数（代码定位）」一律给出真实文件路径与函数名，格式 `backend/domains/xxx/service.js → 函数名`，可在仓库直接定位；
- 「状态流转」中的数字状态与 doc/08_常量与状态字典.md、backend/db.js 表注释保持一致（orders.status 0~7、delivery_batches.status 0~4、delivery_tasks.task_status 0~150）；
- 「落库字段」只列本链路实际写入的表与关键列，只读接口标注「无（只读）」；
- 定时器类链路（自动接单、超时扫描、自动派车）标注扫描间隔与开关条件，恒开/仅真实档逐条注明。

## 12. 链路速查（关键函数定位）

| 链路 | 入口路由 | 核心函数（代码定位） |
| --- | --- | --- |
| 登录 | /api/auth/login | backend/domains/user/service.js → login / demoOpenid / clientIp |
| 商品列表 | /api/goods/list | backend/domains/goods/routes.js + service.js → withPromoPrices |
| 扣库存 | 下单内 | backend/domains/goods/service.js → deductStock |
| 结算销量 | 送达/完成多入口 | backend/services/goodsStats.js → settleSales |
| 回补库存 | 取消/退款 | backend/services/goodsStats.js → restoreStock（orderCancel.cancelLocal 调用） |
| 下单 | /api/order/create | backend/domains/order/service.js → createOrder / splitOrderChunks / pickupCodeNew |
| 支付 | /api/order/pay | backend/domains/order/service.js → payOrder / maybeAutoAccept |
| 接单 | /api/merchant/order/confirm | backend/services/batch.js → addOrderToBatch / getOrCreateOpenBatch |
| 派车 | /api/merchant/delivery/batch/dispatch | backend/domains/delivery/service.js → doDispatchBatch |
| 路线规划 | 派车/开始配送 | backend/services/batch.js → planRoute |
| 上货 | /api/merchant/device/batch/open-bin | backend/domains/delivery/routes.js + service.js → ensureLoadingArrival |
| 立即配送 | /api/merchant/device/batch/dispatch | backend/domains/delivery/service.js → startSummonDelivery / advanceSummonDelivery / ensureStopArrival |
| 任务联动 | 平台回调 | backend/services/platform.js → applyStatus |
| 取餐 | /api/delivery/pickup-open/close | backend/domains/delivery/routes.js + order/service.js → fulfillOrder |
| 取消 | /api/order/cancel | backend/domains/order/service.js → applyOrderCancelled + services/orderCancel.js → cancelLocal |
| 售后 | /api/merchant/refund/handle | backend/domains/order/routes.js + service.js → realRefundOrLocal |
| 超时两段式 | 定时扫描 | backend/domains/delivery/service.js → scanPickupTimeouts / revisitUnpickedOrder / rejectUnpickedOrder |
| 管理员登录 | /api/admin/login | backend/domains/admin/routes.js + services/adminAuth.js → issueSession / resolveSession / revokeSession |

## 13. 存疑与说明

1. **批次自动定型已实现（2026-09-25 起）**：timers.js 第④扫描体（BATCH_SCAN_MS 默认 15s）对 status=0 组单中批次执行自动定型——商品件数 ≥ BATCH_MAX_ITEMS（12）满容或成立超 BATCH_WAIT_MS（90s）即调 `doDispatchBatch`（status 0→1 待上货，指派设备）；失败（如暂无空闲车辆）60s 节流重试（`autoRetryAt` Map），车一上线自动补定型；成功广播 `batch_dispatched`，商家端卡面即时从「组单中」圆环变「待上货」。并发安全由 `q.claimDispatch`（status 0→1 条件更新）保证。商家手动「上货」按钮与扫码定型仍可用（即时定型）。
2. **试点退款为本地标记**：PAY_MOCK 或未配置微信支付商户参数时，退款/取消退款仅落本地状态（订单 7 + refunds 记录 + 回补库存），不产生真实资金流；`RUN_MODE=production` 启动守卫强制真实支付通道，真实退款在 `realRefundOrLocal` 内按 pay_channel=wxpay 且 wxpay.enabled() 才执行。
3. **演示登录 token 不可吊销**：token 即 openid（demo_+sha1 派生），无服务端登出；仅 demo 档可用，正式档被启动守卫拒绝。
4. **同点位多单取餐**：pickup-close-all 一次关舱确认该用户本批次本点位的全部待取订单，若用户在同一点位有多单且只取走部分，会一并置已完成——产品上以「一次性取走全部」为前提，需在交互上向用户明示。
