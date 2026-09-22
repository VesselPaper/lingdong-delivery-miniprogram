# 收货地址编辑：新增 / 编辑 + 送达点位选择
> 页面路径：pages/address/edit（用户端小程序）


**页面职责**：新增或编辑一条收货地址（联系人 + 手机号 + 送达点位 + 是否默认）。

**页面结构（wxml 骨架）**：联系人信息卡（收货人/手机号）→ 送达点位卡（选择行 + 弹层）→ 默认地址开关卡 → 底部「保存」按钮。

**页面要素与数据来源**：`onLoad` 读 `options.id`（有 id = 编辑，无 = 新增）；`loadPoints()` → GET `/api/landmarks`（过滤 `deliverPoint` 送达点位）；有 id 时 `loadDetail()` → GET `/api/address/list` 找到该条回填表单（`is_default` 转布尔）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/address/edit.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 收货人 / 手机号输入 | `onField` | 按 `data-field` 更新 `form.contact_name / contact_phone` | — |
| 「设为默认地址」开关 | `onDefault` | 更新 `form.is_default` | — |
| 送达点位行 | `showPicker` / `closePicker` | 展开/收起点位选择弹层（点位名 + building） | — |
| 弹层选点位 | `choosePoint` | 置 `form.landmark_id / landmark_name` 并收起弹层 | — |
| 底部「保存」 | `save` | 校验收货人非空、手机号 `/^1\d{10}$/`、已选点位 → POST `/api/address/save`（表单全字段 + `detail: ''`（详细地址已下线，统一提交空串）+ `is_default: 1|0` + `id`）→ toast「已保存」 | 500ms 后 `wx.navigateBack()`（返回列表/结算页由对方 `onShow` 刷新） |

**状态与边界**：新增与编辑共用本页，靠 `id` 区分；未选点位时点位行显示占位文案「请选择机器人送达点位」；三项校验任一不过弹 toast 不提交。

---

[← 返回 05 页面与交互详解 索引](../README.md)
