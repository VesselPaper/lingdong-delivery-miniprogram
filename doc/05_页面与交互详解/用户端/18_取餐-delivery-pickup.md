# 取餐页：开舱 → 取餐 → 关舱（40 秒自动关）
> 页面路径：pages/delivery/pickup（用户端小程序）


**页面职责**：订单已定位（`order_id` 已知）后的取餐操作页，状态机驱动「打开舱门 → 取走餐品 → 关闭舱门」全流程，超时自动关舱后可重新打开。

**进入路径**：已在 `app.json` 注册（pages/delivery/pickup）；`scanPickup.js` 顶部注释说明原设计为「pickup 依赖订单号直连（列表/详情进入）」，**但当前用户端代码中无任何页面导航进入本页**（见文末存疑点 3），实际取餐统一走 `delivery/scanPickup` 扫码定位。

**页面结构（wxml 骨架）**：取餐头部（「取餐」标题 + 按 `phase` 切换的状态提示文案）→ 取餐凭证卡（订单号 / 取餐码 / 送达点位）→ 一车多单诚实化提示卡（`batch_order_count > 1` 时）→ 舱门状态卡（`ready / open / autoClosed` 时：圆形舱门标识「开/关」+ 状态文字 + open 时 40s 倒计时 + autoClosed 时提示）→ 底部操作按钮区（按 `phase` 渲染单个按钮）。

**页面要素与数据来源**：`onLoad` 取 `options.order_id` → `load()` → **POST** `/api/delivery/pickup-scan`（`{ order_id }`，校验该单当前可取餐）→ 成功置 `phase: 'ready'` 并回填 `order`（含 `order_no / pickup_code / landmark_name / batch_order_count / batch_orders`）；失败置 `phase: 'done'` 并 toast「暂不能取餐」。

**页面状态机（phase 与按钮/文案对应）**：

| phase | 头部提示 | 舱门卡 | 底部按钮 |
| --- | --- | --- | --- |
| loading | —（`order.order_no` 未回填前头部不渲染） | 不渲染 | — |
| ready | 机器人已到达，点击「打开舱门」取餐 | 舱门待开启（圆点「关」） | 打开舱门（`openBin`） |
| open | 舱门已打开，请取走您的餐品 | 舱门已开启（圆点「开」）+ 40s 后自动关舱 | 关闭舱门（`closeBin`） |
| autoClosed | 舱门已自动关闭 | 舱门已关闭 + 提示可重新打开 | 重新打开（`reopen`） |
| done | 取餐完成 | 不渲染 | 完成（`done`） |

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/delivery/pickup.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 打开舱门 | `openBin` | `wx.showLoading('开舱中')` → POST `/api/delivery/pickup-open`（`{ order_id }`） | 成功 toast「舱门已打开，请取餐」→ `phase: 'open'`、`countdown: 40`、`startCountdown(40)`；失败 toast「开舱失败」 |
| 关闭舱门 | `closeBin` | `wx.showLoading('关舱中')` → POST `/api/delivery/pickup-close`（`{ order_id }`） | 成功清倒计时 → `phase: 'done'`、toast「已关舱，取餐完成」；**取走标记在此步完成**（P1-2） |
| 重新打开 | `reopen` | 直接调 `openBin()`（未取到餐可重开） | 回到开舱流程 |
| 完成 | `done` | — | `wx.navigateBack()` 返回来源页 |

**重点链路**：

- **取餐开舱 → 关舱 → 批次计数**：开舱 POST `/api/delivery/pickup-open`（仅开舱，**不再标记已取走**——P1-2 调整）→ 用户取餐 → 关舱 POST `/api/delivery/pickup-close` 时后端才标记该单已取走并累加批次已取数（`picked_orders`）；配送追踪页轮询即可看到「已取 X / N 单」增长。未取到餐可在自动关舱后点「重新打开」再次开舱，避免误标记。
- **40 秒自动关舱**：`startCountdown(40)` 每秒递减 `countdown`，归零后前端置 `phase: 'autoClosed'`（提示「长时间未关闭已自动关舱，若未取到餐可点击重新打开」）；倒计时仅在 `phase === 'open'` 期间展示。
- **一车多单诚实化提示（P1-1）**：`order.batch_order_count > 1` 时渲染「本车共 N 单」卡：按 `batch_orders` 列出各订单号（`code_short || daily_seq`）与送达点位，当前单标记「本单」，并提示「单舱多单无法完全隔离，请按订单号核对后取走自己的餐，勿错拿他人餐品」。

**状态与边界**：`onHide / onUnload` 一律 `clearTimer()` 清倒计时定时器；`pickup-scan` 校验失败时页面只剩「完成」按钮可返回；开舱/关舱期间 `showLoading` 提示，失败 toast 且停留在原 phase 可重试。

---

[← 返回 05 页面与交互详解 索引](../README.md)
