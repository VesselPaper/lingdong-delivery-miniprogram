# git 交接文档 16

> 对应提交：**大屏：地面坐标网格（淡青细线，默认开，可关）**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `可视化大屏/js/scene3d.js` | 新增 `pushLine()` 图元；`buildStatic` 里生成地面坐标网格（10m 间距、仅地图区域、淡青 alpha 0.35），返回 `scene.grid` |
| `可视化大屏/js/map3d-gl.js` | `opts.grid`（默认开）；`drawMesh` 加 `mode` 参数（支持 `gl.LINES`，默认仍 TRIANGLES）；`rebuildStaticMesh` 上传 `bufs.grid`；渲染循环在**底板/道路之上、楼体之下**画网格；绑定「地面网格」按钮 |
| `可视化大屏/index.html` | 新增「地面网格」按钮；`map3d-gl.js?v=3d87→3d88`、`scene3d.js?v=3d68→3d69` |
| `agent/agent交接文档/git交接文档/git交接文档16.md` | 本文件 |

## 二、为什么这么改

负责人要求"在地面加一些网格，但要保证画面不杂乱"。原先的程序化蓝色网格曾在负责人要求下移除（`shaders.js` / `scene3d.js` 里留有移除注释），本次重新加回但做了克制处理：

- **只覆盖雷达图范围（地图区域）**，不延伸到外圈深蓝"桌面" → 保留干净边框；
- **间距 10m**、淡青细线 **alpha 0.35** → 整校缩远约 30 条淡线，放大是干净坐标参考；
- **画在底板/道路之上、楼体之下**（关深度测试、不写深度）→ 楼/车/路线在其后正常盖住它；
- 工具栏新增「地面网格」按钮（默认开），觉得乱可随时关。

## 三、遇到的问题 / 踩的坑

1. `drawMesh` 原来硬编码 `TRIANGLES` → 给它加了个 `mode` 参数（默认 `gl.TRIANGLES`，网格用 `gl.LINES`），**旧调用都不受影响**（不传即三角形）。
2. 网格法线取**光照方向**（`norm(LIGHT)`）→ 片元光照系数恒为 1、按顶点色原样输出，颜色/透明度可精确控制；否则会被场景光照压暗或提亮，浅色细线看不清。
3. 验证仍用临时只读服务 `serve_dashboard_local.mjs`（本机文件 + `/api` 只读代理云端，POST 一律 403）→ `verify_keys/guard/fix`（要 POST 还原 recon）仍未跑；只读的 `verify_layout` 全绿。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| `node --check 可视化大屏/js/map3d-gl.js` / `scene3d.js` | 通过 |
| 网格 A/B（`probe_grid_ab.mjs`，本机改版 + 云端真实数据） | 开/关差 **1.92%**，噪声底 0.66%（净效果 ~1.3%）；截图体积开/关差 97KB；`#m3Grid` 按钮存在且默认 `on` |
| `verify_layout.mjs`（只读） | 全部通过、0 console 报错 |
| 临时服务清理 | `serve_dashboard_local.mjs` 已停、3000 端口已释放 |

## 五、提交信息原文

```
大屏：地面坐标网格（淡青细线，默认开，可关）

- scene3d.js：新增 pushLine 图元；buildStatic 生成地面坐标网格（10m 间距、仅地图区域）返回 scene.grid
- map3d-gl.js：opts.grid 默认开；drawMesh 加 mode 参数支持 gl.LINES；渲染循环在底板/道路之上、楼体之下画网格；绑定「地面网格」按钮
- index.html：新增「地面网格」按钮；map3d-gl.js 3d87→3d88、scene3d.js 3d68→3d69
```

提交号：（见 `git log`）
是否已推送：**否**

## 六、遗留待办

1. **部署**（负责人已批准本次提交后部署）：从 `main` 打包 → `app-install.sh`。注意部署会把 main 上**全部已提交内容**带上线，含另一个 agent 已提交未上线的 `56a71fb`（召唤连续失败熔断）与 `564e610`（召唤失败持续重试）—— 明天演示大概率需要；如不想带，需单独说明改打包方式。
2. 网格目前只在 **3D 渲染器**（Map3DGL）；2.5D 兜底渲染器（WebGL 起不来时）未加（低用）。
3. 间距/透明度如需微调：`scene3d.js` `buildStatic` 里 `GP = 10m`、alpha `0.35`。
