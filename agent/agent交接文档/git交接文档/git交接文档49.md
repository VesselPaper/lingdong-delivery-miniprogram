提交：更新会话交接文档27 的云上部署状态（已部署 20261014-151526）

## 一、本次范围

| 文件 | 改了什么 |
| --- | --- |
| `交接文档27.md` | 待办 #6「云上部署」由「云上未部署、落后两个提交」更新为「✅ 已部署 `20261014-151526`」，补验证结果与回滚通道 |
| `git交接文档49.md` | 本文件 |

## 二、遇到的问题 / 踩的坑

1. **Windows tar 解 UTF-8 中文路径报 `Invalid empty pathname`**：`git archive | tar -x` 两条路都失败 —— 管道传二进制在沙箱里被破坏（bad header checksum）；改用 `git archive -o file.tar` 写文件后 `tar -xf` 又因 Windows bsdtar 解码 UTF-8 中文名报错。**正解 = `git worktree add --detach <临时目录> HEAD`**（原生处理中文名，不经 tar），打包用 `--src` 指向该工作树。
2. **ssh 远端命令别用内层双引号**：`grep -iE "error|warn"` 里的双引号被 PowerShell 吃掉，bash 把 `|` 当管道拆分报 `command not found`。拆成无引号的简单命令即可。
3. **打包按 git 提交而非工作区**：`build-package.mjs --src <工作树>` 确保不带工作区里的半成品（两个 agent 同时改同一批文件时的老坑）。

## 三、校验记录（部署后）

- `/opt/lingdong/releases/20261014-151526`，`lingdong.service` active (running)。
- 自检：`/api/goods/list`、`/admin/`、`/dashboard/` 均 200（服务器内 + 公网各验一次）。
- 新版证据：线上 `/dashboard/` HTML 已无 `footMid`（旧页脚清理生效）；`/api/order/promise?landmark_id=8` 返回 401（路由存在，而非 404）。
- journalctl 无 error；`lingdong-backup` 已生成 `lingdong-20261014-151637.db.gz`。

## 四、提交信息原文

```
提交：更新会话交接文档27 的云上部署状态（已部署 20261014-151526）
```

## 五、提交号

`（本提交自身的提交号无法写进自己，见下一次文档提交或 git log）`

## 六、是否已推送

是（走 7890 代理；推送后复核 `origin/main...HEAD` = `0  0`）。
