# git 交接文档 2（提交级交接 · 双端 config.js baseUrl(IP) 提交规则固化）

> 生成：2026-09-24。
> 仓库根：`D:\01_Code\Personal\Software\送餐无人车\校内快递配送机器人`（git 仓库）。
> 远端：`github.com/VesselPaper/lingdong-delivery-miniprogram.git`，分支 `feature/summon-delivery`。
> 本文件记录**本次提交（2026-09-24 当日改动）**的范围、逐文件说明、校验结果与提交步骤。
> 会话背景见 `agent/agent交接文档/会话交接文档/交接文档12.md`。

---

## 0. 提交前基线

| 项 | 值 |
| --- | --- |
| 分支 | `feature/summon-delivery` |
| 提交前 HEAD | `9751b9d`（fix(管理员网页): 「全部状态」在活跃分段下看不到终态 → 自动切到全部段） |
| 提交后 HEAD | `0783066`（= 本地，未推送） |
| 提交人 | VesselPaper `<timeline04@qq.com>` |
| 铁律 | **每次 git 提交前必须先给用户确认框，经同意后才能 add/commit/push**；**双端 config.js 的 baseUrl(IP) 是成员本机配置，一律不提交**；推送前先同步远端，**禁止 `--force`** |

---

## 1. 本次提交范围（2026-09-24）

本次为**纯文档**提交，**不含任何代码与数据库改动**，核心是把「IP 不提交」规则写进文档，供新成员/新会话遵循。

| 状态 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `README.md` | §二.8 成员同步：明确 `config.js` 的 baseUrl(IP) 是成员本机配置**一律不提交**——提交代码用 `git add` 指定文件、不要把 config.js 用 `git add .` 带进去；pull 冲突用 `git stash` 保留本机值 |
| 修改 | `agent/agent交接文档/会话交接文档/交接文档12.md` | 铁律第1条重写：IP 不提交（原因 + 操作方法）；另新增铁律第6条「提交必须先确认」 |

> 注：本次只提交上述两个文档。双端 `config.js` 的 IP 改动（`10.75.155.19` → `10.6.64.100`，本机当前局域网 IP）**保持本地未提交**，符合「IP 是成员本机配置、不提交」规则。

---

## 2. 逐文件改动说明

### 2.1 `README.md`（§二.8 成员同步更新）

原句「config.js 的 baseUrl、backend/.env 这类本机配置尽量不提交」升级为硬规则：

> `config.js` 的 baseUrl（**IP 是成员本机配置，一律不提交**——提交代码时用 `git add` 指定文件，不要把 config.js 用 `git add .` 带进去）、`backend/.env` 这类本机配置尽量不提交（如已提交，成员用 `git stash` 保留本机值）。

### 2.2 `交接文档12.md`（铁律更新）

- **铁律第1条**（两处 baseUrl）重写：删除旧 IP 字样，明确「**IP 是成员本机配置，不提交**（每个人的网络环境不同，提交会互相覆盖）」，给出操作方法（本地改 ENV.dev / LAN_BASE、`git add` 指定文件、冲突用 `git stash`），并保留「上线前必须换正式域名」提醒。
- **新增铁律第6条**：**任何 git 提交（commit / push）必须先经用户（项目负责人）明确同意，禁止独自提交**；每次提交前把待提交文件清单、提交说明展示给用户确认。

---

## 3. 提交信息

```
docs: 双端 config.js baseUrl(IP) 为成员本机配置、不提交（铁律+README 同步）
```

---

## 4. 提交前校验记录（2026-09-24）

| 校验项 | 结果 |
| --- | --- |
| 本次提交是否只含 2 个文档（`git add` 指定文件） | 通过（README.md + 交接文档12.md） |
| 双端 `config.js` 是否未被带入提交 | 通过（提交后仍为 ` M` 未暂存状态） |
| 提交前已向用户展示文件清单并获确认 | 通过（用户明确同意后执行） |

**未做**：无代码改动，无需回归测试（铁律第5条仅约束配送/订单代码改动）。

---

## 5. 实际提交结果（2026-09-24）

| 提交 | 说明 |
| --- | --- |
| `0783066` | **本次提交**：docs: 双端 config.js baseUrl(IP) 为成员本机配置、不提交（铁律+README 同步）— 2 files changed, 2 insertions(+), 2 deletions(-) |

- **未推送**：按用户此前决定「暂时不推，保持本地提交」；且按新铁律，推送需另行经用户确认。
- 本地分支 `feature/summon-delivery` 现 ahead origin **9** 个提交（8 个历史 + 本次 `0783066`）。

---

## 6. 风险与注意事项

1. **IP 不提交是硬规则**：成员各自机器 IP 不同，提交会互相覆盖；新成员 clone 后需把自己的局域网 IP 填进两处 `config.js`（`用户端/utils/config.js` ENV.dev、`商家端/utils/config.js` LAN_BASE）。
2. **`git add .` 风险**：全量暂存会误带 config.js，务必用 `git add` 指定文件；若已误暂存可用 `git restore --staged <文件>` 撤出。
3. **pull 冲突**：远端若也改过 config.js 同一行，pull 会报冲突——先 `git stash` → `git pull` → `git stash pop` 保留本机 IP（README §二.8 已写明）。
4. **提交需确认**：任何 commit/push 前必须先向用户展示清单并获同意，禁止独自提交。

---

## 7. 遗留待办

1. 双端 `config.js` IP 已改本机 `10.6.64.100`（未提交），微信开发者工具需重新编译验证网络异常已修复。
2. 若后续要推送全部本地提交（现 ahead 9），须先经用户确认，且 push 前先 `git pull --rebase origin feature/summon-delivery`。
