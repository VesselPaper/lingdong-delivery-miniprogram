# 无人车二维码（打印贴车用，监控页跳转）
> 页面路径：pages/device/robotQr（商家端小程序）


- **数据来源**：无接口。`onLoad` 接收 `?sn=`，拼二维码内容 `LD-R:<sn>`；`onReady` 用本地 qrcode 库（`商家端/utils/vendor/qrcode`）生成码矩阵并在 2D canvas 上按 DPR 绘制（留 4 模块静区）。
- **页面构成**：二维码卡（canvas + 无人车编号 + 提示「商家扫此码可配单上货；用户扫此码后输入取餐码取餐」）+ 底部「保存二维码（打印后贴于无人车）」按钮。
- **交互清单**：

| 按钮/交互 | 触发函数 | 行为与调用的接口 | 后续链路/跳转 |
| --- | --- | --- | --- |
| 保存二维码 | saveQr | `wx.canvasToTempFilePath` → `wx.saveImageToPhotosAlbum` | 成功 toast「已保存到相册，可打印贴于无人车」；相册权限被拒弹「去设置」→ `wx.openSetting` |

- **状态与边界**：二维码内容与上货配单页 `scan.parseDeviceSn` 的解析规则（`LD-R:` 前缀）一一对应；`saving` 防重复保存；canvas 未就绪（`ready` false）时按钮禁用。

---

[← 返回 05 页面与交互详解 索引](../README.md)
