# git 交接文档 33

> 对应提交：**大屏：点位图标复原为原叠加层"定位针"（撤销 3D 物理遮挡方案）**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `可视化大屏/js/map3d-gl.js` | 撤销 3D 点位图标：删除 `collectSitePins`/`sitePinMatrix`/`drawSitePin`/`pinMeshes`/`_sitePins`/`progs.pin` 与 3D 绘制段；**恢复叠加层点位绘制**（地面小圆环 + 针身 + 圆头 + 中心孔 + 光晕，永远可见） |
| `可视化大屏/js/scene3d.js` | 删除 `buildPin` |
| `可视化大屏/js/render/gl3d/shaders.js` | 删除 `VS_PIN`/`FS_PIN` |
| `可视化大屏/index.html` | 版本号还原（map3d-gl 3d90→3d89、shaders 3d43→3d42、scene3d 3d69→3d68，与内容一致） |
| `agent/agent交接文档/git交接文档/git交接文档33.md` | 本文件 |

**保留**：`46bf2dc` 的"点位名称被遮挡时隐藏（只留图标）"、`6a6dda9` 的图例等后续改动不动。

## 二、为什么改

负责人反馈 3D 点位图标"不好看/像小三角形/看不清"，要求**复原成原来的图标**（叠加层定位针，永远可见）。`git revert 59667da 323c080` 干净撤销（保留交接文档 28/32 作历史记录）。

## 三、遇到的问题 / 踩的坑

1. `git revert --no-commit 59667da 323c080`（**先新后旧**的顺序，否则 59667da 的反向会去改已被删掉的 buildPin → 冲突）。
2. revert 会连交接文档 28/32 的删除一起暂存 → 用 `git restore --source=HEAD --staged --worktree` 恢复（历史记录保留）。
3. 版本号：撤销后 index.html 回到 46bf2dc 的一致值（3d89/3d42/3d68），内容与版本匹配、缓存安全。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| `node --check`（map3d-gl.js / scene3d.js / shaders.js） | 通过 |
| 3D 针代码残留检查 | 0 处 |
| `verify_labels.mjs`（本机改版 + 云端数据） | 全部通过、0 console 报错 |
| 渲染异常探针 | 0 异常 |

## 五、提交信息原文

```
大屏：点位图标复原为原叠加层"定位针"（撤销 3D 物理遮挡方案）

- revert 59667da + 323c080：删除 3D billboard 点位图标（buildPin/VS_PIN/collectSitePins 等）
- 恢复叠加层点位绘制（定位针永远可见）；保留点位名称"被遮挡隐藏"
```

提交号：（见 `git log`）
是否已推送：**否**

## 六、遗留待办

1. 物理遮挡方案被否（图标要永远可见）—— 如后续又想"被楼挡"的视觉效果，需换方案（如仅半透明提示）。
2. 点位名称"被遮挡隐藏"仍生效（46bf2dc）。
