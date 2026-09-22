# 确认订单：送达信息 / 优惠券面板 / 商品清单 / 提交支付
> 页面路径：pages/order/confirm（用户端小程序）


**页面职责**：下单前确认送达信息、选择优惠并提交支付的核心结算页。

**页面结构（wxml 骨架）**：信息卡（送达楼栋行 / 收货人行 / 联系电话行 / 预计送达时间行）→ 商品卡（优惠行 + 店铺行 + 优惠横幅 + 商品清单 + 费用明细 + 备注输入）→ 底部支付栏（共计/支付按钮）；楼栋弹层、时间面板、优惠面板三个浮层。

**页面要素与数据来源**：`onLoad` 串行初始化：读 storage `runtimeFlags` 得到 `payMock`（按钮显示「模拟支付」）；商品来源二选一——URL 带 `?goods_id=&quantity=`（立即购买，GET `/api/goods/detail`）或 storage `checkout_items`（购物车结算，逐商品 GET `/api/goods/detail` 回源现价）；`loadPromo()` → GET `/api/activity/list` 估算可用优惠；`Promise.all([loadPoints, loadAddresses])` → GET `/api/landmarks`（过滤 `deliverPoint`）+ GET `/api/address/list`；`loadUser()` → GET `/api/user/profile` 回填收餐人；`loadCurrentPoint()` → GET `/api/user/point`（后端记录的当前楼栋优先级最高）；`loadShopStatus()` → GET `/api/shop/status`（歇业/配送费）；`buildTimeOptions()` 生成送达时间档。`onShow` 在地址页返回后刷新地址并回填最佳地址（`applyBestAddress`）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/order/confirm.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 送达楼栋行 | `showPointPicker` / `closePicker` | 展开/收起楼栋选择弹层（仅 `deliverPoint` 点位，显示楼栋名 + building） | — |
| 弹层选楼栋 | `choosePoint` | 置 `selectedPoint` → PUT `/api/user/point`（`landmark_id`）同步后端（失败不阻塞本单） | 与首页顶部/我的页地址联动 |
| 收货人 / 联系电话输入 | `onName` / `onPhone` | 记录表单值 | — |
| 预计送达时间行 | `openTimeSheet` / `closeTimeSheet` | 展开/收起时间选择面板 | 默认「尽快送达」（当前时间 +30 分钟），指定时间每 30 分钟一档、过滤出 08:00-20:00 内的档位 |
| 「尽快送达」 | `chooseAsap` | `deliveryMode = 'asap'`，清空 `scheduledTime` | — |
| 指定时间档 | `chooseScheduled` | `deliveryMode = 'scheduled'`，记录 `scheduledTime` | — |
| 「优惠」行 / 优惠横幅 | `showCoupons` / `hideCoupons` | 展开/收起优惠选择面板 | 见下方重点链路 |
| 优惠候选卡片 | `chooseCoupon` | 点未选中项 → 切换勾选并 `pickPromo` 重算；点已选中项 → 取消勾选（`selectedActivityId = null`、清 `recommend` 标记）→ `clearPromo` 恢复无优惠 | 面板不自动关闭，可反复勾选/取消 |
| 备注输入 | `onRemark` | 记录备注 | — |
| 底部「支付/模拟支付」 | `submit` | 校验后 POST `/api/order/create` → 逐个订单支付 | 见下方重点链路 |

**重点链路**：

- **优惠勾选/取消**：`loadPromo` 按「折扣（`discount`）」与「满减（`full_reduce`）」逐活动估算优惠额（折扣按「原价−活动价」差额累计、满减按档位门槛取最大档），按优惠额降序排序，**自动勾选并推荐优惠最大的一项**（`recommend: true` 角标）。`chooseCoupon` 点已勾选项 = 取消勾选：`selectedActivityId` 置 `null`、所有候选 `selected/recommend` 清 false、`clearPromo` 恢复无优惠——提交时 `activity_id: selectedActivityId || 0`，即**取消后以 `activity_id = 0` 表示不使用任何优惠**（无候选也按 0 处理，后端不再自动套用活动）；`pickPromo` 生成横幅（折扣/满减图标、「已选/满减已生效」副文案）并重算 `promoReduce / promoPayable`。优惠面板文案注明「同一笔订单最多使用 1 个优惠 · 再点一次可取消勾选」。
- **提交订单 → 支付**：`submit` 重入保护（`submitting`）→ 校验店铺歇业、点位、收餐人姓名、手机号（`/^1\d{10}$/`），商品总数 >12 仅提示「将自动拆分为多个订单分批配送」（不拦截）→ POST `/api/order/create`（`landmark_id / landmark_name / remark / contact_name / contact_phone / address_id / activity_id / items`）→ 成功后清除 `checkout_items`、写 storage `last_confirm`（点位/姓名/电话/备注供下次回填）、异步 PUT `/api/user/profile`（同步昵称/手机号）→ 若后端拆单（`res.split`）则对 `res.orders` 逐个 `pay.payOrder` 后 toast「已拆为 N 个订单」并 `redirectTo('/pages/order/list')`；否则支付后 toast「支付成功 / 订单已生成」并 `redirectTo('/pages/order/detail?id=')`。
- **支付封装**：`用户端/utils/pay.js → payOrder`：POST `/api/order/pay`（`id`）→ 后端返回 `mock: true`（模拟支付）直接视为成功；否则用 `payParams` 拉起 `wx.requestPayment`，成功后 `pollPaid` 每 800ms 轮询 GET `/api/order/detail?id=`（最多 10 次）确认 `status > 0`（等待微信支付回调写库）。
- **地址回填**：`applyBestAddress` 优先默认地址（`is_default`），其次第一条地址，无地址时用 `last_confirm` 回填上次下单的点位/姓名/电话/备注；`applyAddress` 同时根据地址的 `landmark_id` 匹配送达点位。

**状态与边界**：歇业时按钮变「店铺歇业」并禁用提交；无可用优惠显示「暂无可用」；配送费只加一次且不参与活动折扣（`recomputeTotal` 分别算 `goodsPayable / origTotal / payableTotal`，`origTotal` 为划线原价对照）；支付失败/用户取消不阻塞（订单已生成，可稍后支付）；提交中按钮禁用防重复。

---

[← 返回 05 页面与交互详解 索引](../README.md)
