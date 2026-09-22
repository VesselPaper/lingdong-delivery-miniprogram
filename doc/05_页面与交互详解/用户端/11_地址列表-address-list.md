# 收货地址列表：增删改 / 默认 / 切换送达
> 页面路径：pages/address/list（用户端小程序）


**页面职责**：收货地址簿管理，并作为「当前送达楼栋」的切换入口。

**页面结构（wxml 骨架）**：地址卡列表（联系人/电话 + 「默认」「当前送达」标签 + 楼栋行 + 「设为默认」「送到这里」操作 + 删除图标）→ 底部「新增地址」按钮；无地址时显示空态。

**页面要素与数据来源**：`onShow` 并行：`load()` → GET `/api/address/list`；`loadPoint()` → GET `/api/user/point`（`pointId` 用于标记「当前送达」并决定是否显示「送到这里」按钮）。

**交互清单**：

| 按钮/交互 | 触发函数（用户端/pages/address/list.js） | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 底部「新增地址」 | `add` | — | `wx.navigateTo('/pages/address/edit')` |
| 地址卡片（主体） | `edit` | 读取 `data-id` | `wx.navigateTo('/pages/address/edit?id=' + id)` |
| 「设为默认」 | `setDefault` | POST `/api/address/save`（该地址全字段回传 + `is_default: 1`，避免覆盖空字段）→ toast「已设为默认」 | 刷新列表 |
| 「送到这里」 | `setPoint` | PUT `/api/user/point`（`landmark_id = 该地址的楼栋`）→ 更新 `pointId` → toast「已切换至」 | 首页顶部/结算页楼栋同步 |
| 删除图标 | `del` | `wx.showModal` 确认 → DELETE `/api/address/delete`（`id`）→ toast「已删除」 | 刷新列表 |

**重点链路**：**地址 ↔ 当前送达楼栋**：地址列表与首页顶部、结算页共享后端 `/api/user/point`；「送到这里」即把当前配送楼栋切换为该地址的楼栋，是「地址管理」与「配送点位」的联动入口。

**状态与边界**：默认地址显示「默认」标签；`pointId == landmark_id` 的地址显示「当前送达」标签并隐藏「送到这里」；删除必须模态确认；无地址显示空态。

---

[← 返回 05 页面与交互详解 索引](../README.md)
