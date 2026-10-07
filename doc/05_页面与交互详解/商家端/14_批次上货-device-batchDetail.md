# 批次上货详情（自动开舱 → 放货 → 立即配送）
> 页面路径：pages/device/batchDetail（商家端小程序）

> **2026-10-06 改版**：移除手动「打开舱门 / 关舱」按钮。开舱改为**进页面自动执行**，关舱并入「立即配送」。
> 商家只需两个动作：① 进页面（舱门自动开）→ ② 放好货点【立即配送】→ 二次确认 → 车走。


- **数据来源**：`onLoad` 解析 `?id=&sn=&at=&dist=&lmsg=`（扫码带入无人车编号、是否在上货点、距离与提示）；`onShow` → `load()` → GET /api/merchant/delivery/batch/detail `{batch_id}`（`silent`）。
- **页面构成**：扫码带入时顶部显示无人车位置横幅（`atLoadingPoint` 为 1 → 绿「无人车已在上货点 ✓」+「设备 SN 已就位，舱门将自动打开」；否则灰「无人车未在上货点」+ 距离/提示）；`batch-card` 单批次详情（`showNo` 弱化展示完整批次编号 + `showGoods` 完整商品明细 + `showProgress` + `orderTap`，点批次内订单子卡 `goOrderDetail` 进订单详情）；底部操作区按阶段渲染：

  | phase | 操作区 | 说明 |
  | --- | --- | --- |
  | `pending` | 橙色只读提示条 `.pending-tip`「批次尚未派车定型，如需上货请返回配单上货页点击上货」 | 组单中未定型，无任何操作按钮 |
  | `scanned` | 蓝色自动开舱状态区 `.open-status`：「正在打开舱门…」或失败/等待原因 + 蓝色小按钮「重新尝试开舱」 | 进页面自动开舱，**无手动开舱按钮** |
  | `open` | 圆形「立即配送」`.dispatch-circle` + 提示「舱门已打开，请放入货品，放好后点击下方按钮」 | 舱已开，等商家放货 |
  | `loaded` | 同一个圆形「立即配送」+ 提示「货品已装好，点击按钮立即出发」 | 已关舱；倒计时期间提示改为「建议 Ns 内发起配送」 |
  | `dispatched` | 绿色成功态 + `dispatchNote` | 已派发，自动返回 |

  派发后的说明文案 `dispatchNote` 按状态区分：「机器人已出发，将按路线依次配送」/ 全送达「货品已送达各点位，等待顾客取餐」/ 「批次配送已完成」/ 异常「批次配送异常，请查看订单处理」/ 取消「批次已取消」。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 自动开舱（进页面即触发，**无按钮**） | ensureBinOpen | 仅当 phase='scanned' 时 POST /api/merchant/device/batch/open-bin `{batch_id}`（silent）；返回 `waiting`（车未到上货点）或失败 → 不进入开舱态，写 `openError` 并 `scheduleOpenRetry()` 每 5s 自动重试，**上限 24 次（约 2 分钟）** | 成功置 `phase='open'`；到上限停手并保留「重新尝试开舱」按钮交商家决定 |
| 重新尝试开舱 | retryOpenBin | 重置重试计数后调 `ensureBinOpen()` | 同上 |
| 圆形「立即配送」 | confirmDispatch | 前置校验 `phase ∈ {open, loaded}`；弹二次确认「**是否立即发起配送？**」（确认键「立即配送」/ 取消键「再等等」） | 确认 → `closeAndDispatch()`；取消 → `startCountdown(180)` 启动 180s 建议配送倒计时 |
| （内部，无独立按钮）关舱 + 派发 | closeAndDispatch → dispatchAll | 舱还开着（phase='open'）时先 POST /api/merchant/device/batch/close-bin `{batch_id}`（silent，`showLoading('关舱中')`）→ 置 `phase='loaded'` → 再走 `dispatchAll`：模拟档 POST /api/merchant/device/batch/mock-dispatch；真实档 POST /api/merchant/device/batch/dispatch（silent）。`dispatchAll` 内仍保留 `phase === 'loaded'` 前置校验（未关舱不给派发） | 成功清倒计时、置 `phase='dispatched'`，弹「配送已开始」→ `wx.navigateBack()` 返回批次列表 |
| 删除批次 | deleteBatch → doDeleteBatch | 弹窗二次确认（**文案里带批内订单数**：会取消全部 N 单、作废机器人任务、回补库存、召回机器人、释放设备控制权且不可撤销）→ POST /api/merchant/delivery/batch/delete `{batch_id}`（silent） | 弹出「批次已删除」（含已取消单数；有 `failed` 项则列出前 3 条）→ `navigateBack()` 回列表 |

- **删除批次（2026-10-07 从管理员网页「清理批次」迁入，店主专属）**：`canDeleteBatch = role.isOwner() && [0,1,2].includes(batch.status)`。后端只允许删活跃批次（组单中 / 待上货 / 配送中），终态返回 400 —— 重复删会把已回补的库存再动一次。按钮放在底部操作区、用分隔线隔开（`.del-batch`）：**它离圆形「立即配送」很近，误点一下就是好几单被取消**，所以缓冲要留够，并在按钮下方给出后果提示 `.del-batch-hint`。后端在前端拦一道之外仍做二次校验（店员调接口返回 403「需要店主权限」）。

- **重点链路（自动开舱 → 立即配送 → 关舱 + /api/merchant/device/batch/open-bin|close-bin|dispatch）**：页面按「pending 未定型(只读) → scanned 待开舱(自动开舱/可重试) → open 舱已开待放货 → loaded 已关舱待配送 → dispatched 已派发」五阶段渲染操作区。

  **为什么开舱放在这一页而不是配单页**：配单页点「上货」、扫车身二维码、退出后重进 —— 三条入口都落到本页，自动开舱只写一处逻辑即可行为一致；也不会让商家卡在列表页等开舱。

  **为什么关舱不能省**：真实环境下车在舱门打开时不允许移动，所以「立即配送」内部必须先关舱再派发。但商家不需要理解这层机械约束，只需要按一个按钮，因此关舱没有独立按钮。

  `inferPhase(b)` 由后端**持久标记**恢复操作阶段（修复退出重进后按钮错乱问题）：`status=0` → pending；status 2/3/4 → dispatched（配送中/已完成/已取消，不可再操作）；status 1 优先看 `ready_dispatch === true`（已关舱 → loaded），再看 `bin_opened === true`（舱已开 → open）；两个标记都缺时兜底取各订单 `task.task_status` 最大值：≥50 已上货 → loaded、≥40 上货中 → open、其余 → scanned。模拟/真实分支由登录下发的 `runtimeFlags.device_mock` 决定，取不到默认 false —— 宁可走真实分支报错，也不可假装成功（代码注释 P0-2 修复）。真实代码分支完整保留在方法内（`DEVICE_MOCK=false` 分支），后续直接切换即可。
- **「舱门已开」为什么要落库**（2026-10-06 修复）：开舱自动化后，页面重进 / 自动重试都会重复调用 open-bin，必须有持久状态可判断，否则页面不知道已经开过舱。**不能用配送任务状态（40）代替**——演示档 `verifyBatchLoading` 不推进任务状态（实测恒为 0），真机档平台回调也可能延迟，据此判断会让页面误以为没开舱而**无限重试开舱**。
  - 后端新增 `delivery_batches.bin_opened_at`（open-bin 置位、close-bin 清空，见 `db.js` / `queries.js`），并由 `batch.js:getBatchDetail` 下发为 `bin_opened`。
  - open-bin 同时加了**幂等保护**：已开过舱直接返回 `{opened:0, already_open:true}`，不重复下发平台指令（真实档每次开舱都 `grantControl` 并存 `ctrl_id`，重复下发会多占一个控制会话）。
  - 这同时修掉了历史遗留的「问题2」：以前 phase 是纯前端本地状态，退出重进会回到 scanned，显示已失效的开舱按钮。
- **状态与边界**：已派发显示成功态后自动返回，无页面内冗余返回按钮；`onHide/onUnload` 清理**倒计时与开舱重试两个定时器**（`clearTimers`）；倒计时归零文案切换为「已超过建议等待时长，请尽快发起配送」并转警示色（`hintWarn`）；批次加载中显示「加载中…」占位卡。开舱请求用实例标志 `_opening` 防重入（`onShow` 与 `load()` 可能并发触发），重试次数记在 `_retryCount`。

---

[← 返回 05 页面与交互详解 索引](../README.md)
