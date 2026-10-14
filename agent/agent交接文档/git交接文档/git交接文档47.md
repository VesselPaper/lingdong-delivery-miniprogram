提交：活动编辑器 UX 整改（类型改下拉 + 清除解释小字）

## 一、本次范围

| 文件 | 改了什么 |
| --- | --- |
| `商家端/pages/activity/edit.wxml` | ① 活动类型从「三个并排方框 + 高亮选中」改为原生 `<picker mode="selector">` 下拉（商家反馈"把全部选项摆在外面用高亮当选中太冗杂"）。② 删除打折框下方的示例小字（`calc-hint`，如「示例：¥10 商品按 8.5 折 ≈ ¥8.50」）。③ 删除顶部解释条 `warn-bar`（「该活动已发布但没有配图…」——发布校验弹窗已覆盖，冗余文案去掉） |
| `商家端/pages/activity/edit.js` | ① 新增 `typeLabels`/`typeIndex` 数据；`chooseType`（点方框）→ `onTypeChange`（下拉 change）；`applyActivity` 同步 `typeIndex`。② 删除 `discountCalcHint` 数据、`calcHint()` 函数、`onDiscountInput` 里的 hint 计算、`applyActivity` 里的 hint 赋值 |
| `商家端/pages/activity/edit.wxss` | ① 新增 `.type-select`（类型下拉选择行样式，复用 `.picker-value/.picker-picked`）。② 删除死样式：`.type-row/.type-item/.type-item.type-on/.type-name/.type-on .type-name/.type-desc`、`.warn-bar/.warn-text`、`.calc-hint`、以及本就未使用的 `.status-hint/.tip/.pick-tip/.poster-tip/.poster-tip-sub` |
| `用户端/pages/user/settings.wxml` | 删除个人信息卡底部解释小字「昵称与手机号用于配送时联系你；点击昵称框可直接选用微信昵称。」（昵称用法已由 placeholder「点击可选用微信昵称」覆盖，冗余） |
| `用户端/pages/user/settings.wxss` | 删除随之变死的 `.hint` 规则 |
| `agent/agent交接文档/git交接文档/git交接文档47.md` | 本文件 |

**为什么只删这些、不删更多**：扫了整个商家端 + 用户端的 wxml，「解释小字」只有活动编辑页与 settings 页这两处。其余命中（输入框 placeholder「例如：8.5」、操作流程指引「舱门已打开，请放入货品」、空状态、取消/退款说明、HTML 注释）都是**功能性文案**，删了会降低可用性，保留。

## 二、遇到的问题 / 踩的坑

1. **`type` 与下拉选中项要保持同步**：picker 的 `value` 是下标，活动类型是字符串值。改下拉后有两处要同步：新活动默认 `typeIndex=0`；编辑已有活动时 `applyActivity` 要按 `type` 反查 `typeIndex`，否则下拉永远停在第一项。
2. **wxss 死类要逐个确认**：`.status-hint/.tip/.pick-tip/.poster-tip/.poster-tip-sub` 在 wxml 里从没引用过（历史残留），一并清掉；`.scope-row/.scope-item`（全场/指定商品）仍在使用，保留 —— 只有两项互斥选项用分段控件是标准做法，没改下拉。
3. **wxml 里 `customDetail` 是死字段**（JS 有 `onCustomDetail`，wxml 没有对应输入框）—— 本轮不动，避免顺手引入行为变化。

## 三、校验记录

- `node --check`：`edit.js`、`settings.js` 均 exit 0（wxml/wxss 为模板与样式，无独立语法检查；微信开发者工具最终预览为准）。
- grep 复查：`discountCalcHint|calcHint|warn-bar|calc-hint|status-hint|poster-tip|pick-tip|示例：` 在 activity 目录 **0 命中**；`.hint` 在 settings 页无 wxml 引用。
- 后端无改动，未跑后端回归（本轮纯前端模板/样式/页面逻辑）。

## 四、提交信息原文

```
提交：活动编辑器 UX 整改（类型改下拉 + 清除解释小字）

商家端活动编辑页：活动类型从三个并排方框+高亮改为下拉选择（picker）；
删除打折框示例小字（calc-hint）与顶部解释条（warn-bar）；清理关联死样式。
用户端 settings：删除个人信息卡下冗余解释小字（昵称用法已被 placeholder 覆盖）。
保留功能性文案（placeholder/流程指引/空状态/退款说明），只删纯解释类小字。
```

## 五、提交号

`（本提交自身的提交号无法写进自己，见下一次文档提交或 git log）`

## 六、是否已推送

否（2026-10-14 提交时 GitHub 443 网络抖动，推送被 `Connection reset` 挡住；提交 `0ca9a03` 安全在本地，
推送成功后把本节改为「是」并回填推送范围。其余历史提交 32f577b / 9df74bb 均已推送）。
