# 商品管理（上下架 / 售罄统计 / 价格库存入口）
> 页面路径：pages/goods/list（商家端小程序）


- **数据来源**：`onShow` → `load()` → GET /api/merchant/goods；本地派生统计 `onShelf`（status=1）、`offShelf`（status=0）、`soldOut`（stock≤0），以及卡面主题色（`THEMES`，热卤/卤味/饮品/套餐固定浅灰）与兜底图标（`ICONS`）。
- **页面构成**：顶部搜索行（占位「请输入商品名称」+ 筛选图标按钮）；统计卡（商品统计标题 + 「新增商品」按钮 + 上架/下架/售罄三个数字）；商品列表卡 = 图片（无图用分类主题色块 + 图标兜底）+ 名称（售罄加红「售罄」标签）+ 分类/条码/单位 + 库存/已售 + 价格 + 底部三动作（下架/上架、价格库存、标记售罄/恢复库存）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 搜索框 | onSearch | 本地按商品名过滤 | — |
| 筛选按钮 | openFilter | toast「筛选功能开发中」 | — |
| 新增商品 | addGoods | — | navigateTo /pages/goods/edit |
| 上下架 | toggleStatus | PUT /api/merchant/goods/status `{id, status}`（1↔0 翻转） | 成功 toast「已更新」→ `load()` |
| 价格库存 | editGoods | 读 `data-id` | navigateTo /pages/goods/edit?id= |
| 标记售罄 / 恢复库存 | markSoldOut | 弹窗确认 → PUT /api/merchant/goods/stock `{id, stock: 0}`；已售罄时弹可编辑弹窗填恢复数量（默认 99）→ PUT /api/merchant/goods/stock `{id, stock: n}` | 成功 toast → `load()` |

- **重点链路**：标记售罄 = 库存直接置 0（用户端立即显示售罄且无法下单）；恢复库存可自定义（`parseInt` 失败回退 99、最小 0）。`sold_out` 派生自 `stock <= 0`，售罄统计随列表刷新联动。
- **状态与边界**：`applyFilter` 用 `toLowerCase` 不区分大小写匹配商品名；列表空态「暂无商品」。

---

[← 返回 05 页面与交互详解 索引](../README.md)
