# 批次上货详情（模拟/真实开舱 → 关舱 → 立即配送）
> 页面路径：pages/device/batchDetail（商家端小程序）


- **数据来源**：`onLoad` 解析 `?id=&sn=&at=&dist=&lmsg=`（扫码带入无人车编号、是否在上货点、距离与提示）；`onShow` → `load()` → GET /api/merchant/delivery/batch/detail `{batch_id}`（`silent`）。
- **页面构成**：扫码带入时顶部显示无人车位置横幅（`atLoadingPoint` 为 1 → 绿「无人车已在上货点 ✓」+「设备 SN 已就位，可以开舱上货」；否则灰「无人车未在上货点」+ 距离/提示）；`batch-card` 单批次详情（`showNo` 弱化展示完整批次编号 + `showGoods` 完整商品明细）；底部操作区按阶段渲染唯一按钮（打开舱门 / 关舱 / 圆形「开始配送」+ 倒计时提示 / 派发成功态）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 打开舱门（模拟/真实） | openBin | 模拟：600ms 后本地置 `phase='open'` + toast「模拟开舱成功，请放货」；真实：POST /api/merchant/device/batch/open-bin `{batch_id}`（silent），返回 `waiting` 时弹「机器人前往上货点中」提示并**不**进入开舱态 | phase 推进到 open |
| 关舱 | closeBin | 模拟：直接置 `phase='loaded'`；真实：POST /api/merchant/device/batch/close-bin `{batch_id}`（silent）成功后 | 弹「是否立即配送」（确认关舱后机器人才移动）→ 确认走 `dispatchAll`，否则 `startCountdown(180)` 启动 180s 建议配送倒计时 |
| 圆形「开始配送」 | dispatchAll | 前置校验 `phase === 'loaded'`（舱门开着车不能移动，未关舱 toast「请先关闭舱门后再开始配送」）；模拟：POST /api/merchant/device/batch/mock-dispatch；真实：POST /api/merchant/device/batch/dispatch（silent） | 成功清倒计时、置 `phase='dispatched'`，1.6~2.2s 后 `wx.navigateBack()` 自动返回批次列表 |
| 滑块「开始配送」 | onSliderChange / onSliderEnd | 记录 `sliderX`；松手时拖到底（`sliderAreaW - sliderThumbW - 20`）触发 `dispatchAll`，否则回弹归零 | 同上 |

- **重点链路（开舱/关舱/立即配送 → /api/merchant/device/batch/open-bin|close-bin|dispatch）**：页面按「scanned 可开舱 → open 已开舱 → loaded 已关舱 → dispatched 已派发」四阶段渲染唯一操作按钮。`inferPhase(b)` 由后端批次/任务状态**恢复**操作阶段（修复退出重进后按钮错乱问题）：status 2/3/4 → dispatched（配送中/已完成/已取消，不可再操作）；status 1 优先看后端落库 `ready_dispatch === true`（已关舱 → 直接「立即配送」），否则取各订单 `task.task_status` 最大值：≥50 已上货 → loaded、≥40 上货中 → open、其余 → scanned。模拟/真实分支由登录下发的 `runtimeFlags.device_mock` 决定，取不到默认 false —— 宁可走真实分支报错，也不可假装成功（代码注释 P0-2 修复）。真实代码分支完整保留在方法内（`DEVICE_MOCK=false` 分支），后续直接切换即可。
- **状态与边界**：已派发显示成功态「机器人已出发，将按路线依次配送」后自动返回，无页面内冗余返回按钮；`onHide/onUnload` 清理倒计时定时器（`clearTimer`），`onReady` 按窗口宽度换算滑块尺寸；倒计时归零文案切换为「已超过建议等待时长，请尽快开始配送」；批次加载中显示「加载中…」占位卡。

---

[← 返回 05 页面与交互详解 索引](../README.md)
