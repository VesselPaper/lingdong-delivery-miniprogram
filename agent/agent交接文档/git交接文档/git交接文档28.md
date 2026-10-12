# git 交接文档 28

> 对应提交：**大屏：点位图标改为 3D 物理遮挡（被楼挡住就真的被挡住）**。本文件与该提交一起提交。
> 编号说明：27 号刚被并行的另一个 agent 占用（`1d11843` 商家端删除收口），本次用 28。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `可视化大屏/js/render/gl3d/shaders.js` | 新增 `VS_PIN`/`FS_PIN`（无光照 billboard 着色器，按顶点色直出），导出 |
| `可视化大屏/js/scene3d.js` | 新增 `buildPin(col)`：定位针图元（针身三角 + 针头八边形，局部 +Y 为高、底在 y=0），导出 |
| `可视化大屏/js/map3d-gl.js` | ① 点位收集/优先级去重抽成 `collectSitePins()`（每帧在 render 里算，存 `_sitePins`，图标与名称共用）；② 渲染循环在玻璃墙之后、路线之前**画 3D 点位图标**（billboard 矩阵 `sitePinMatrix` + `drawSitePin`，参与深度测试 → 被楼/屋顶真正遮挡；depthMask(false) 不写深度）；③ 叠加层只负责点位**名称**（图标不再画在叠加层） |
| `可视化大屏/index.html` | `map3d-gl.js?v=3d89→3d90`、`scene3d.js?v=3d68→3d69`、`shaders.js?v=3d42→3d43` |
| `agent/agent交接文档/git交接文档/git交接文档28.md` | 本文件 |

## 二、为什么改

负责人要求：点位图标"不是不显示，是被遮挡" —— 即图标要像物理物体一样参与 3D 深度，被楼挡住时真的被挡住（换角度可见），而不是永远悬在最上层。图标从叠加层搬进 3D 场景（billboard + 深度测试）。墙（玻璃层）不写深度，与车/路线同一套遮挡口径。

## 三、遇到的问题 / 踩的坑

1. **`bindAttr` 要的是 WebGLBuffer**：第一版把 `S.buildPin()` 的原始 Float32Array（`finalize` 结果）直接传给 `bindAttr` → 每帧 `TypeError: parameter 2 is not of type 'WebGLBuffer'`，站点名全灭。修正：`pinMeshes()` 里先 `uploadMesh()` 上传成 GPU buffer 再画。
2. billboard 矩阵用"本地 +Y→屏幕向上、+X→屏幕向右、+Z→朝向相机"的列主序矩阵，避免照抄 `mat4.lookAt`（那是视图矩阵，带相机平移，不能当模型矩阵用）。
3. 实测确认：**商铺上货的图标在默认视角不可见** —— 它在建模楼「新楼4」足迹内，被屋顶物理遮挡（这正是要求的行为）；放大后也只有名称出现、图标仍被楼挡。绿色点位（东苑/充电点）正常可见。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| `node --check`（map3d-gl.js / scene3d.js / shaders.js） | 通过 |
| 渲染异常探针 `probe_site_pin_err.mjs` | 0 异常 |
| `verify_labels.mjs`（本机改版 + 云端数据） | 全部通过、0 console 报错（名称逻辑未动） |
| 像素统计（截图） | 默认视角绿色点位图标可见、黄色商铺上货图标被楼遮挡；放大后名称出现 |

## 五、提交信息原文

```
大屏：点位图标改为 3D 物理遮挡（被楼挡住就真的被挡住）

- 新增无光照 billboard 着色器 VS_PIN/FS_PIN 与 buildPin 定位针图元
- 点位收集/去重抽成 collectSitePins()，图标在 3D 场景画（深度测试 → 物理遮挡），叠加层只画名称
- index.html：map3d-gl 3d89→3d90、scene3d 3d68→3d69、shaders 3d42→3d43
```

提交号：（见 `git log`）
是否已推送：**否**

## 六、遗留待办

1. 2.5D 兜底渲染器未做点位物理遮挡（低用）。
2. 若发现某些点位图标"永远被楼挡看不见"，可考虑给被遮挡的图标加"半透明提示"或按角度放宽（当前严格物理遮挡）。
