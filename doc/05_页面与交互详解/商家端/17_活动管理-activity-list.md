# 活动管理（新建/编辑/发布/下线/删除）
> 页面路径：pages/activity/list（商家端小程序）


- **数据来源**：`onShow` → `load()` → GET /api/merchant/activities；前端按 `start_at/end_at` 与当前时间派生 `pending 未开始 / active 进行中 / ended 已结束`，`status !== 1`（已下线）覆盖时间状态；类型映射 `custom→自由 / discount→打折 / full_reduce→满减`。
- **页面构成**：头部「活动管理」+ 右上角「新建活动」；活动卡 = 标题 + 已发布/已下线标签 + 类型徽标 + 时间状态徽标（进行中绿 / 已下线灰 / 未开始·已结束蓝）+ 副标题 + 链接行（「链接：xxx」或「无跳转链接」）+ 底部「下线/发布」与「删除」按钮（外层 `catchtap="noop"` 拦截冒泡，避免误进编辑页）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 新建活动 | add | — | navigateTo /pages/activity/edit |
| 活动卡 | edit | 读 `data-id` | navigateTo /pages/activity/edit?id= |
| 发布/下线 | toggleStatus | PUT /api/merchant/activities/status `{id, status}`（1↔0 翻转） | 成功 toast「已发布/已下线」→ `load()` |
| 删除 | del | 弹窗确认 → DELETE /api/merchant/activities `{id}` | 成功 toast「已删除」→ `load()` |

- **重点链路**：上下线开关与删除均即时生效；`noop()` 为空函数占位，仅用于阻止事件冒泡。
- **状态与边界**：空态「暂无活动，点击右上角新建」；时间解析把 `' '` 替换为 `'T'` 后取毫秒比较（兼容后端本地时间格式）。

---

[← 返回 05 页面与交互详解 索引](../README.md)
