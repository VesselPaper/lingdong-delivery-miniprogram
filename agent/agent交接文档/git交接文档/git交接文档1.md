# git 交接文档 1（提交级交接 · 用户端 UI 打磨与首页定位重构）

> 生成：2026-09-19（星期六）。
> 仓库根：`C:\Users\82652\Desktop\lingdong-delivery`（git 仓库）。
> 远端：`git@github.com:VesselPaper/lingdong-delivery-miniprogram.git`，分支 `main`。
> 本文件记录**本次提交（2026-09-19 当日改动）**的范围、逐文件说明、校验结果与提交步骤。
> 会话背景见 `agent/agent交接文档/会话交接文档/交接文档1~9.md`。

---

## 0. 提交前基线

| 项 | 值 |
| --- | --- |
| 分支 | `main` |
| 提交前基线 | `89ba395`（商品图进版本库：42 张种子图迁到 `backend/seed_images/`，`/store-img` 托管，DB 前缀迁移） |
| 提交后 HEAD | `b0308a0`（= `origin/main`，已推送同步） |
| 提交人 | hsy `<826526708@qq.com>` |
| 铁律 | **每次 git 提交前必须先给用户确认框，经同意后才能 add/commit/push**；提交前先同步远端，**禁止 `--force`** |

---

## 1. 本次提交范围（2026-09-19 当日改动）

本次为**纯前端（双小程序）+ 文档整理**提交，**不含后端逻辑与数据库改动**。

### 1.1 根目录整理（一并提交）

| 状态 | 文件 | 说明 |
| --- | --- | --- |
| 删除 | `_apply_images.py` | 商品图批量写库的临时便捷脚本，数据已落库，无用 |
| 重命名 | `_nofind.json` → `backend/store_nofind.json` | 174 个无图商品台账，从根目录移入 backend |
| 重命名 | `_img_review.md` → `doc/商品图采集与抽查清单.md` | 图片抽查清单，从根目录移入 doc |

> 远端 `f38f77b` / `790e9c8` 也删除了这三个根目录文件，意图一致；merge 时保留本端的**迁移落位**（见 §6.2）。

### 1.2 今日代码改动（19 个文件）

| 文件 | 增/删 |
| --- | --- |
| `用户端/pages/index/index.js` | +237 |
| `用户端/pages/index/index.wxml` | +155 / −37 |
| `用户端/pages/index/index.wxss` | +254 |
| `用户端/pages/order/confirm.js` | +94 |
| `用户端/pages/order/confirm.wxml` | +4 / −2 |
| `用户端/pages/goods/list.js` | +57 |
| `用户端/pages/goods/list.wxml` | +3 / −2 |
| `用户端/pages/address/edit.js` | +5 / −2 |
| `用户端/pages/address/edit.wxml` | +3 / −9 |
| `用户端/pages/address/list.wxml` | +1 / −1 |
| `用户端/app.js` | +37 |
| `用户端/pages/user/login.js` | +2 / −1 |
| `用户端/pages/user/profile.js` | −7 |
| `用户端/pages/user/profile.wxml` | −6 |
| `用户端/pages/user/settings.wxml` | +3 / −5 |
| `用户端/pages/user/settings.wxss` | +11 |
| `商家端/pages/delivery/monitor.wxml` | +1 / −1 |
| `用户端/utils/config.js` | +2 / −2（局域网 IP） |
| `商家端/utils/config.js` | +3 / −3（局域网 IP） |

### 1.3 目录整理（今日）

`agent/agent交接文档/交接文档1~6.md` → `agent/agent交接文档/会话交接文档/交接文档1~6.md`
（6 个文件**内容逐字节一致**，纯移动，已比对 HEAD 版本确认 `完全一致=True`，git 识别为 100% rename。）

merge 时远端新增的 `交接文档7/8/9.md` 落在旧扁平路径，已一并 `git mv` 进 `会话交接文档/`。
最终结构：

```
agent/agent交接文档/
├── git交接文档/     git交接文档1.md（本文件）
└── 会话交接文档/    交接文档1.md ~ 交接文档9.md
```

### 1.4 本次新增

`agent/agent交接文档/git交接文档/git交接文档1.md`（本文件）。

---

## 2. 逐文件改动说明

### 2.1 首页 `用户端/pages/index/*`（本次改动主体）

**定位 / 楼栋选择（重做两轮后的最终形态）**

- 数据源改为 `GET /api/landmarks`（公开接口，`needAuth: false`，未登录也能选楼栋），过滤 `type === 'deliverPoint'` 得到**全部可送达楼栋**（东苑1/2/3/4/5/7/11/12/13 栋，共 9 个）。
- 弹层列出**全部楼栋**（不是地址）；已有地址的楼栋显示**关联**的昵称+手机号（`addrId/addrName/addrPhone` 仅用于展示，**不写回地址簿**）。
- 顶部定位默认 `川师成龙校区`（`CAMPUS`）；**仅当** `user_point` 里有最近选定楼栋时才自动显示该楼栋。
- 选定楼栋写入 `user_point = { landmark_id, name, addrId }` —— 只存楼栋信息，**不动昵称/手机号**。
- `resetToCampus()` 清空 `user_point`，定位回校区。

**独立搜索**

- 搜索框由"点击跳商城"改为**首页内独立搜索**：真实 `<input>` + `onSearchTap`（聚焦并固定展开历史）。
- 历史搜索 `search_history`（本地，去重置顶，上限 8 条）；透明 `.history-mask` 点空白处收起；**去掉了 `bindblur`**（原 180ms 定时隐藏导致"只闪现一下"）。
- 搜索结果直接渲染在首页 `searchResults`（匹配商品名或分类），`取消` 退出搜索态。

**分类按钮 + 热门商品**

- 新增 `CATEGORY_STYLE` 关键字→零售卡通图标/配色映射（**具体词在前**，避免"面包糕点"被"面"抢先匹配成 noodle）；未命中走 `CATEGORY_FALLBACK`。
- `.cat-bar` 横向可滚分类按钮，点击 `goCategory` → 写 `goods_category` 后 `switchTab` 到商城。
- `hotGroups`：按分类分组、每组取前 4 个热门商品，成排（两列网格）展示。

**福利卡片**

- 去掉"免配送费"角标，只保留"机器人自动配送至所选点位"；卡片/箭头 `bindtap="goAll"` 跳商城。

### 2.2 结算页 `用户端/pages/order/confirm.js|wxml`

- 新增 `POINT_KEY = 'user_point'`。
- 默认送达地址优先级改为 **首页选定楼栋 > 默认地址 > 第一条 > 上次下单**（`pickDeliveryAddress()` / `applyPickedAddress()`）。
- 新增 `latestAddress()`：本地记录的最近使用地址（`addrId`）> 最近新建（id 最大）> 默认地址 > 第一条。
- `applyAddress(addr, keepContact)` 新增 `keepContact` 参数：`true` 时**只换送达地址/点位**，昵称/手机号沿用已保存的值（仅当为空才用地址里的兜底）。
- `choosePoint()`（结算页手动换楼栋）同样只换点位，昵称/手机号保持最近一次地址的数据。
- 下单成功后回写 `user_point = { landmark_id, name, addrId }` —— "最近一次下单用的楼栋"即首页显示的那个。
- `confirm.wxml`：送达地址行去掉 `detail` 拼接；楼栋选择项去掉 `floor` 拼接（解决"四川师范大学成龙校区1"）。

### 2.3 商城列表 `用户端/pages/goods/list.js|wxml`

- `onShow` 读取并**立即清除** `goods_category` / `goods_keyword`（消费即清，避免下次误用），存入 `this.pendingCategory`。
- `loadGoods` 完成后：若 `pendingCategory` 命中分组 → 直接 `onCategoryClick` 定位并 `return`；否则校验 `activeCategory` 仍存在，不存在则回落首组（解决"滑动后延续旧分类不跳转"）。
- `computeTops()` 加节流（`_recomputeTimer`），拆出 `_measure()`：重新查询 `#main-scroll` 与 `.group-title` 位置并**立即校正高亮**。
- 新增 `onImageLoad()`（80ms 防抖 → `_measure()`），商品图 `lazy-load bindload`；图片加载改变分组高度后重测，消除分类跟随滞后。
- `onCategoryClick` 的跳转由 `setTimeout 60ms` 改为 `wx.nextTick`，每次点击都能稳定跳转。
- `list.wxml`：去掉主滚动区的 `scroll-with-animation`（与 `scroll-into-view` 冲突导致跳转不干脆）。

### 2.4 地址 `用户端/pages/address/*`

- `edit.wxml`：**删除"详细地址"输入框**（该功能下线）；`edit.js` 的 `form` 去掉 `detail`，`save()` 显式提交 `detail: ''` 防旧数据残留。
- `edit.wxml` / `list.wxml`：点位/地址展示去掉 `floor` 与 `detail` 拼接。

### 2.5 我的 / 登录 `用户端/pages/user/*`、`用户端/app.js`

- `login.js`：登录成功后 `switchTab` 由 `/pages/user/profile` 改为 `/pages/index/index` —— **这是"每次进入都先落在我的"的真正根因**。
- `app.js`：新增 `onHide`（记 `_hideAt`）/ `onShow`（间隔 ≥2500ms 视为重新打开 → `_goHome()`），加 `_landHomeIfNeeded()` / `_isNotHome()` / `_goHome()` 兜底；冷启动入口固定为 `pages[0] = pages/index/index`。
- `profile.wxml`：删除主页面"退出登录"cell；`profile.js`：删除死代码 `logout()`。
- `settings.wxml`：退出登录改为独立 cell（去 chevron/value）；`settings.wxss` 新增 `.logout-cell` / `.logout-label`，**红色** `#E34D59`。

### 2.6 商家端

- `pages/delivery/monitor.wxml`：「当前位置」去掉 `floor` 拼接，只显示 `{{item.building}}`（同"成龙校区1"问题）。

### 2.7 局域网 IP（真机预览用）

- `用户端/utils/config.js`：`dev.baseUrl` → `http://192.168.70.50:3000/api`
- `商家端/utils/config.js`：`LAN_BASE` → `http://192.168.70.50:3000/api`
- 当前为**手机热点**网段（WLAN）。换网络后需同步改这两处。

---

## 3. 后端 / 数据库：本次无改动

- `backend/server.js` 的 `/store-img` 静态托管、`backend/seed_images/` 42 张图、`backend/db.js` 的图片回填逻辑**均已在 `89ba395` 提交**，本次不再包含。
- `backend/data/lingdong.db` 被 `.gitignore` 忽略，不进版本库；楼栋名在库中本就是干净的（`东苑1栋` 等），本次只改前端显示层，**未改数据库**。

---

## 4. 提交信息

```
用户端 UI 打磨：首页定位改为全楼栋选择 + 独立搜索 + 分类图标；登录后落首页；退出登录归并到设置

- 首页 index：定位弹层改为列出全部可送达楼栋（/landmarks?type=deliverPoint，needAuth=false），
  与地址簿仅做关联展示（昵称/手机号），选定只写 user_point={landmark_id,name,addrId}；
  搜索框改为首页独立搜索（真实 input + 历史搜索固定展开，去掉 bindblur 闪现问题）；
  新增 CATEGORY_STYLE 分类卡通图标映射与 hotGroups 分类成排热门商品；福利卡去掉"免配送费"
- 结算 confirm：默认地址优先级改为 首页选定楼栋 > 默认地址 > 第一条 > 上次下单；
  新增 latestAddress()；applyAddress(addr, keepContact) 支持只换地址不动昵称/手机号；
  下单成功回写 user_point，使"最近一次下单楼栋"与首页一致
- 商城 list：消费即清 goods_category/goods_keyword；图片 bindload 防抖重测分组位置，
  立即校正高亮；分类点击改 wx.nextTick；去掉 scroll-with-animation
- 地址：删除"详细地址"输入框（功能下线），清理 detail/floor 展示拼接
- 我的/登录：登录后 switchTab 到首页（修复总落在"我的"）；app.js onShow/onHide 回首页兜底；
  退出登录从主页移除，仅保留设置页并改为红色
- 商家端 monitor：当前位置去掉 floor 拼接
- 配置：局域网 IP 更新为 192.168.70.50（手机热点）
- 文档整理：交接文档 1~6 移入 会话交接文档/；_nofind.json→backend/、_img_review.md→doc/；
  删除临时脚本 _apply_images.py；新增 git交接文档1
```

---

## 5. 提交前校验记录（2026-09-19）

| 校验项 | 结果 |
| --- | --- |
| `node --check 用户端/pages/index/index.js` | 通过 |
| `node --check 用户端/pages/order/confirm.js` | 通过 |
| `node --check 用户端/pages/address/edit.js` / `list.js` | 通过 |
| `node --check 用户端/app.js` | 通过 |
| `index.wxml` 标签平衡 | `view 61/61`、`block 2/2` |
| `order/confirm.wxml` 标签平衡 | `view 73/73` |
| `address/edit.wxml` / `list.wxml` 标签平衡 | `21/21`、`14/14` |
| `商家端/delivery/monitor.wxml` 标签平衡 | `view 51/51` |
| `index.wxss` 花括号平衡 | `65/65` |
| 用户端 wxml 残留 `form.detail` / `.detail` | 0 处 |
| 全仓库 `item.floor` 显示残留 | 0 处 |
| 首页残留旧引用（`loadPoints`/`onPickPoint`/`pickedId`/`goNewAddress`） | 0 处 |
| 交接文档 1~6 移动是否为纯改名 | 6/6 `完全一致=True` |
| `backend/seed_images` 跟踪数 | 42（已在 `89ba395` 提交） |

**未做**：微信开发者工具真机/模拟器回归（需用户在工具内重新编译验证）。

---

## 6. 实际提交结果（已完成，2026-09-19 20:12~20:2x）

### 6.1 提交记录

| 提交 | 说明 |
| --- | --- |
| `7e0b8f6` | **本次主体提交**：用户端 UI 打磨（29 files changed, 1045 insertions, 161 deletions） |
| `b0308a0` | **合并提交**：`Merge origin/main`（合入大屏科技风 + 3D 地图、管理员网页、召唤多单改造文档） |
| `790e9c8` | （远端）清理：移除一次性商品图临时清单 `_img_review.md` / `_nofind.json` |
| `f38f77b` | （远端）清理：移除一次性商品图落库脚本 `_apply_images.py` |

- 推送结果：`790e9c8..b0308a0  main -> main`
- 推送后 `HEAD == origin/main == b0308a0`，工作区**干净**。

### 6.2 执行过程与踩坑

1. `git pull origin main` **失败**（`error: Your local changes ... would be overwritten by merge`）——
   因为 `用户端/utils/config.js`、`商家端/utils/config.js` 本地已改而远端也改了同一行。
   **正确顺序是：先 commit 本地，再 merge**（不是先 pull）。
2. 首次 `git commit -F` 用了 `Out-File -Encoding utf8`，会在提交信息首行写入 **BOM**（`\ufeff`）；
   已用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` + `git commit --amend -F` 修正。
   **后续提交务必用 `UTF8Encoding($false)` 写消息文件。**
3. `git merge origin/main` 产生 4 处冲突，均已解决：

| 冲突 | 类型 | 解决方式 |
| --- | --- | --- |
| `用户端/utils/config.js` | content | 保留本机当前可达 IP **`192.168.70.50`**（手机热点），并补一行"换网络后需同步修改"注释 |
| `商家端/utils/config.js` | content | 同上，`LAN_BASE = 'http://192.168.70.50:3000/api'` |
| `backend/store_nofind.json` | rename/delete | 远端删除、本端已迁移 → **保留迁移结果**（不回退删除） |
| `doc/商品图采集与抽查清单.md` | rename/delete | 同上 |

   > 注：远端 `f38f77b`/`790e9c8` 已删除根目录 `_apply_images.py`/`_img_review.md`/`_nofind.json`，
   > 与本端"迁移而非删除"的意图一致，故保留本端的迁移落位。

4. 远端新增的 `交接文档7/8/9.md` 落在**旧扁平路径** `agent/agent交接文档/`；
   为与新结构一致，已 `git mv` 到 `agent/agent交接文档/会话交接文档/`。

### 6.3 本次实际纳入的文件

- **代码 19 个**：`用户端/pages/index/{index.js,index.wxml,index.wxss}`、`用户端/pages/order/{confirm.js,confirm.wxml}`、`用户端/pages/goods/{list.js,list.wxml}`、`用户端/pages/address/{edit.js,edit.wxml,list.wxml}`、`用户端/app.js`、`用户端/pages/user/{login.js,profile.js,profile.wxml,settings.wxml,settings.wxss}`、`商家端/pages/delivery/monitor.wxml`、`用户端/utils/config.js`、`商家端/utils/config.js`
- **文档/整理**：新增 `agent/agent交接文档/git交接文档/git交接文档1.md`；`交接文档1~6.md` 移入 `会话交接文档/`（纯移动，100% rename）；`_apply_images.py` 删除；`_nofind.json` → `backend/store_nofind.json`；`_img_review.md` → `doc/商品图采集与抽查清单.md`
- **随 merge 一并纳入（远端内容）**：`可视化大屏/`（科技风皮肤 + 3D 地图 + logo/机器人贴图 + 校准数据）、`管理员网页/`（admin-map/leaflet）、`backend/domains/admin/*`、`backend/services/platform.js`、`README.md`、`打开可视化大屏.bat`、`打开管理员网页.bat`、`交接文档7/8/9.md`

### 6.4 复现命令

```powershell
# 1) 先提交本地（避免 pull 被本地改动阻塞）
git add -A
[System.IO.File]::WriteAllText("$env:TEMP\m.txt", $msg, (New-Object System.Text.UTF8Encoding($false)))
git commit -F "$env:TEMP\m.txt"

# 2) 再合并远端
git fetch origin main
git merge origin/main --no-edit
#   解决冲突后：git add <冲突文件>

# 3) 推送（禁止 --force）
git push origin main
```

---

## 7. 风险与注意事项

1. **局域网 IP 入库**：`192.168.70.50` 是当前手机热点网段，其他人 clone 后需改成自己电脑的 WLAN IPv4（`ipconfig`）。历史上已多次这样做（上一版为 `10.75.178.153`）。
2. **`user_point` 结构变更**：由 `{id,name}` 改为 `{landmark_id,name,addrId}`。旧缓存里的 `{id,name}` 因 `landmark_id` 缺失会被判为无效 → 定位回落校区，属**预期降级**，用户重选一次即可（无需迁移代码）。
3. **`addresses.detail` 列保留**：前端不再采集/展示，但后端 `address/save` 仍兼容空串，**无需改后端、无需迁移数据库**。
4. **`scroll-with-animation` 被移除**：商城左右联动改为无动画直接定位，换取"点击必跳"的确定性。
5. **`app.js` 的 2500ms 阈值**：低于该值的快速切回不打断当前页面；若真机上出现"切回来没回首页"，可下调阈值。
6. **`/landmarks` 用 `needAuth:false`**：该接口本就公开，未登录可浏览楼栋；下单仍需登录。

---

## 8. 遗留待办（不在本次提交内）

1. **174 个商品仍无图**（台账 `backend/store_nofind.json`，共 216 商品、已填 42）：需决定占位图 / 离线回源 / 京东·1688（有反爬，需代理）。
2. **`doc/商品图采集与抽查清单.md` 中 ⚠️ 近似/存疑项**需人工核对：巧乐角（桃李可可味）、元气葡萄柚标题、GR226 层数 3 vs 4、依能蜜柠/蜜桃（品牌近似）、她研社奶滑小方系列、康师傅老母鸡汤 64g、汤达人·肥汁米线 98g×6杯、统一春佛/双萃 500ml、营养快线 450、外星人青柠 950×3 赠品。
3. **图片版权风险**：42 张为苏宁第三方品牌实拍图，仓库/服务若公开存在商标与授权暴露；`seed_images/` 随 git 跟踪（clone 即见），后续新增会自动进版本库。
4. **微信开发者工具需重新编译**验证本次 UI 改动（旧代码常驻内存会让修复"看起来无效"）。
5. **未提交的本地辅助脚本**：根目录 `pull-from-github.ps1` / `push-to-github.ps1` 被 `.gitignore` 的 `*.ps1` 忽略，仅本地使用。
