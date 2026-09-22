# 商品编辑（图片上传、分类选择器选现有或新增）
> 页面路径：pages/goods/edit（商家端小程序）


- **数据来源**：`onLoad`：有 `?id=` 时从 GET /api/merchant/goods 全量列表中 `find` 出该商品回填表单（名称/分类/价格/原价/库存/描述/图片/条码/单位）；同时 `loadCategories()` → GET /api/merchant/goods/categories 供分类选择。
- **页面构成**：表单卡（商品名称、分类选择器）+ 图片卡（「添加商品图片」或预览 + 右上角移除，提示「最多 1 张」）+ 价格库存卡（售价 / 原价[选填划线价] / 库存[默认 99] / 条码 / 主单位）+ 描述卡（textarea ≤200 字）+ 底部固定「保存商品」；分类选择为底部弹层（现有分类 chip + 「＋新增分类」输入行）。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 各输入框 | onField | 按 `data-field` 更新 `form`（兼容 change/input 事件形态） | — |
| 添加商品图片 | chooseImage | `wx.chooseMedia`（相册/拍摄、压缩、count=1）→ `getFileSystemManager().readFile` 转 base64 → POST /api/merchant/upload `{name, data}` | 成功后 `form.image = up.url`（完整 URL） |
| 预览图片 | previewImage | `wx.previewImage` | — |
| 移除图片 | removeImage | 清空 `form.image`（catchtap 防冒泡） | — |
| 分类选择器 | openCategoryPicker / chooseCategory / startNewCategory / onNewCategory / confirmNewCategory | 弹层列出现有分类；点选即回填；「＋新增分类」输入后校验非空，与现有重名直接选中，否则本地追加并选中 | — |
| 保存商品 | save | 校验名称非空、售价 >0 → 组 payload → 有 `id` 走 PUT /api/merchant/goods，无则 POST /api/merchant/goods（`image` 经 `toRel` 还原为相对路径入库） | 成功 toast「已保存」→ 500ms `wx.navigateBack()` |

- **重点链路**：`toRel(u)` 用正则去掉上传返回完整 URL 的协议+主机（不绑定特定 host）再入库；保存成功返回列表后 `onShow` 自动重拉，新商品/改价立即可见。默认表单 `DEFAULT`：分类「热卤」、库存「99」。
- **状态与边界**：校验失败 toast 提示并停留在页面；图片上传失败不中断其他字段编辑（`finally` 中 hideLoading）。

---

[← 返回 05 页面与交互详解 索引](../README.md)
