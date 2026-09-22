# 活动编辑（三种类型 + 全场/指定商品 + 满减多档）
> 页面路径：pages/activity/edit（商家端小程序）


- **数据来源**：`onLoad` 拉 GET /api/merchant/goods 作为「指定商品」多选池；有 `?id=` 时从 GET /api/merchant/activities 中 `find` 并解析 `config` JSON 回填（折扣、范围、指定商品、满减档位；自由活动取 `subtitle` 为详情）。类型选项 `TYPE_LIST`：商品打折 / 满减 / 自由活动（默认选中「商品打折」）。
- **页面构成**：类型选择卡（三选一卡片，含说明文案）→ 基础信息卡（标题 / 副标题 / 跳转链接[仅 custom] / 排序 / 生效日期 / 失效日期，后两者为 `picker mode="date"`）→ 适用范围卡（全场商品 / 指定商品，指定时展开商品多选列表，勾选态 + 已选件数）→ 折扣卡（0~10 之间，实时折算提示）或满减卡（多档「满 X 元减 Y 元」，可增删）→ 底部「保存」+ 发布说明提示。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 活动类型 | chooseType | discount / full_reduce / custom 三选一 | 联动渲染折扣/满减/链接表单 |
| 基础信息输入 | onField | 标题、副标题、跳转链接（仅 custom）、排序、生效/失效日期 | — |
| 适用范围 | setScope | all 全场 / goods 指定商品 | 指定商品时展开多选列表 |
| 指定商品多选 | toggleGoods | 维护 `selectedGoods` 数组与 `selectedMap`（WXML 无法调用 indexOf，按 id 判勾选） | — |
| 折扣输入 | onDiscountInput / calcHint | 实时折算提示（8.5 → 「示例：¥10 商品按 8.5 折 ≈ ¥8.50」） | — |
| 满减档位 | onTierField / addTier / removeTier | 多档「满 X 元减 Y 元」，可增删（仅剩一档时隐藏删除） | — |
| 保存 | save | `validate()` 校验 → `buildPayload()` 组包 → 有 `id` 走 PUT /api/merchant/activities，无则 POST /api/merchant/activities | 成功 toast「已保存」→ 500ms `wx.navigateBack()` |

- **重点链路**：`buildPayload` 把商家输入的「几折」（如 8.5）转换为乘数 `0.85` 入库（注释明确与后端 `goodsPricePayload/promotion` 口径一致）；满减只提交填写完整的档位（threshold/reduce 均非空且为正数），空档被过滤；`config = {scope, goods_ids, discount|tiers}`；时间去掉 `T` 与末尾冒号后提交。编辑回填时折扣值按 `Math.round(Number(cfg.discount) * 10 * 10) / 10` 还原为「几折」。
- **状态与边界**：校验规则 —— 标题必填；打折需 0<折扣<10 且指定商品范围下商品非空；满减至少一档、档位金额为正、指定商品范围下商品非空；保存后默认发布（自由活动纯展示，页面底部提示文案区分两类发布语义）。

---

[← 返回 05 页面与交互详解 索引](../README.md)
