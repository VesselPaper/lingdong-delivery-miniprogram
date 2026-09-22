# 活动列表（tab）
> 页面路径：pages/activity/index（用户端小程序）


**页面职责**：展示后端进行中的折扣/满减活动，引导进入商城或自定义链接。

**页面结构（wxml 骨架）**：顶部渐变权益头（「超值权益」）→ 活动卡片列表（标题 + 折扣/满减类型角标 + 高亮面额 + 适用范围 + 起止时间 + 「去逛逛/查看详情」按钮）；无活动时显示空态。

**页面要素与数据来源**：`onShow` → `load()` → GET `/api/activity/list`，只保留进行中活动（`state` 为空或 `'active'`），按类型加工展示文案：`discount` 折扣活动（如「8.5 折」+「指定/全场商品享受折扣」）、`full_reduce` 满减活动（档位升序拼接「满X减Y / …」，最高档作大字）；有起止时间则生成 `timeTxt`；同步 tab `selected: 2`。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/activity/index.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 活动卡片 | `onActivity` | 读取 `data-type / data-link`：`type === 'custom'` 且有 `link` → `wx.navigateTo(link)`；其余（折扣/满减） | `wx.switchTab('/pages/goods/list')` 进商城浏览 |

**状态与边界**：无进行中活动显示「暂无进行中的活动」空态；`custom` 活动无 `link` 时点卡片无跳转。

---

[← 返回 05 页面与交互详解 索引](../README.md)
