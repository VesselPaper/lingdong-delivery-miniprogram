# 扫码取餐：扫车身二维码 + 取餐码定位订单
> 页面路径：pages/delivery/scanPickup（用户端小程序）


**页面职责**：按「无人车设备号 + 取餐码」定位本人待取餐订单的取餐页（需求 5），先扫码自动匹配，匹配不到回退输入取餐码（代取场景），随后复用开舱/取餐/关舱流程；支持同点多单一次关舱批量确认。

**进入路径**：订单详情「扫码取餐」`goScanPickup`（status 3）；配送追踪「扫码取餐」`goScanPickup`（status 3）；`options.sn` 可预填设备号。

**页面结构（wxml 骨架）**：两步式结构——① 步骤一（`phase === 'scan'`）：取餐头部（提示「扫无人车上的二维码，自动校验您的订单；代取请输取餐码」）→ 扫码字段卡（显示已识别设备号或「点击扫描无人车二维码」+「扫一扫」按钮；`scanFail` 时替换为「未匹配到您的订单」回退卡：再次扫码 / 输入取餐码）→ 取餐码输入行（6 位数字 input）+「确认取餐」按钮（设备号与取餐码齐备才解除禁用样式）→ 演示档「模拟扫码」入口；② 步骤二（`order` 已定位，`phase` 驱动）：取餐头部（ready 区分「已自动校验您的订单」/「校验通过」两种文案）→ 取餐凭证卡 → 同点多单卡（`my_multi`：本取货点 N 个订单 + 商品图清单，提示一起取走）→ 一车多单提示卡（`batch_order_count > 1`）→ 舱门状态卡 → 底部按钮区（打开舱门 / 关闭舱门（单多单动态绑定）/ 重新打开 / 完成）。

**页面要素与数据来源**：`onLoad` 读 storage `runtimeFlags`：`login === 'demo'` 时 `demo = true`（展示「模拟扫码」测试入口）；`options.sn` 预填 `deviceSn`。取餐码/设备号均在前端收集，定位订单走后端校验接口（见交互表），不直接拉订单接口；定位成功后 `order` 对象携带 `order_id / order_no / pickup_code / landmark_name / batch_id / landmark_id / my_multi / my_batch_orders / batch_order_count / batch_orders` 等字段供后续取餐与展示。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/delivery/scanPickup.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 扫码区（点击扫一扫） | `scanRobot` | `wx.scanCode` → `scan.parseDeviceSn` 解析（兼容 `LD-R:` 前缀剥离与纯设备号）；无效则 toast「二维码无效，请扫无人车上的二维码」 | 解析成功 → `deviceSn` 回显 + `matchByScan()` 自动校验 |
| 自动校验（扫码后） | `matchByScan` | POST `/api/delivery/pickup-by-scan`（`{ device_sn }`） | 返回 `auto_matched && order_id` → `phase: 'ready'`（toast「已自动匹配您的订单，点击开舱取餐」）；否则 `scanFail: true` 展示「未匹配到您的订单」回退卡 |
| 回退卡「再次扫码」 | `scanRobot` | 重扫设备号再自动校验 | 同上 |
| 回退卡「输入取餐码」 | `focusCode` | `scanFail: false`，隐藏提示卡、露出取餐码输入区（代取场景） | — |
| 取餐码输入 | `onCodeInput` | 6 位数字输入框（`type="number" maxlength="6"`）同步 `pickupCode` | 设备号与取餐码齐备时「确认取餐」按钮解除禁用态 |
| 确认取餐 | `verify` | 先校验设备号（空 → toast「请先扫无人车二维码」）与取餐码（空 → toast「请输入取餐码」）→ POST `/api/delivery/pickup-by-code`（`{ device_sn, pickup_code }`，后端校验归属） | 成功 → `phase: 'ready'` 进入取餐步骤；失败 toast `err.message` |
| 模拟扫码（演示档） | `mockScan` | 仅 `demo` 为真时显示：直接填入 `deviceSn = 'TESTROBOT001'` 并 toast「已填入演示设备号，请输入取餐码」 | 配合输入取餐码走 `verify` |
| 打开舱门 | `openBin` | `phase === 'ready'` | POST `/api/delivery/pickup-open`（`{ order_id: order.order_id }`） | `phase: 'open'`、40s 倒计时（toast 时长 3s） |
| 关闭舱门（单订单） | `closeBin` | `phase === 'open'` 且非 `my_multi` | POST `/api/delivery/pickup-close`（`{ order_id }`）——关舱即标记该单已取走 | `phase: 'done'` + toast「已关舱，取餐完成」 |
| 关闭舱门（同点多单） | `closeAllBin` | `phase === 'open'` 且 `order.my_multi`（关舱按钮动态绑定） | POST `/api/delivery/pickup-close-all`（`{ batch_id, landmark_id }`）——一次关舱 = 确认本取货点全部订单已取走，后端批量置已完成 | 成功按返回 `count` toast「已确认，N 单全部取走」→ `phase: 'done'` |
| 重新打开 | `reopen` | `phase === 'autoClosed'` | 调 `openBin()` | 同上 |
| 完成 | `done` | `phase === 'done'` | — | `wx.navigateBack()` |

**重点链路**：

- **扫码 → 定位 → 开舱 → 关舱 → 批次计数**：`wx.scanCode` 扫车身二维码 → `parseDeviceSn` 提取设备号 → POST `/api/delivery/pickup-by-scan` 按**登录账号**自动匹配（`auto_matched`）；未匹配（代取/识别不到）回退「输入取餐码 / 再次扫码」→ POST `/api/delivery/pickup-by-code` 按**车 + 取餐码**定位 → 开舱 POST `/api/delivery/pickup-open` → 关舱 POST `/api/delivery/pickup-close`（或 `pickup-close-all`）→ 后端标记取走并驱动配送追踪页的批次「已取 X / N 单」计数。
- **同点多单一起取**：`order.my_multi` 为真时展示「您在本取货点有 N 个订单」卡：列出 `my_batch_orders`（各订单号 + 点位 + 取餐码 + 商品图/价量），提示「打开舱门把以下订单的商品**一起**取走，点『关闭舱门』一次性确认全部订单取完」；此时关舱按钮绑定 `closeAllBin`，一次调用批量收尾，避免逐单关舱。
- **防错拿（P1-1）**：`batch_order_count > 1` 时展示同车订单清单（当前单标「本单」），提示按订单号核对取走自己的餐。

**状态与边界**：phase 状态机 `scan → ready → open → autoClosed / done`；`scanFail` 仅表示自动匹配未命中，`focusCode` 可切换回输入取餐码；「确认取餐」按钮的禁用态仅为样式（`btn-disabled`），逻辑校验仍在 `verify` 内完成；`demo` 仅当登录为 demo 账号时显示模拟入口；`onHide / onUnload` 清倒计时定时器；开舱/关舱/校验均有 `showLoading` 提示、失败停留在原状态并可重试。

---

[← 返回 05 页面与交互详解 索引](../README.md)
