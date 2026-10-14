提交：组单 v2 转正删 legacy + 动态窗口 K=2 + 大屏实时动态修复 + 开舱互斥闸

## 一、本次范围

| 文件 | 改了什么 |
| --- | --- |
| `backend/services/batch.js` | ① v2 转正：删 `getOrCreateOpenBatchLegacy` / `planRouteLegacy` / `shouldAutoLockLegacy` 及全部 legacy 分发分支；`BATCH_ALGO`/`BATCH_V2_READY` 开关删除，只留旧 env 容忍告警（残留 `BATCH_ALGO=legacy` 只 warn 不报错）。② 动态窗口：`BATCH_PRESSURE_K`（默认 2）、`batchHoldMs`（待发≥K×可用车→窗口缩短，最短 3 分钟）、`situationOf` 三档。③ `planRouteV2` 真实现：楼栋聚类 + `v2OrderStops`（单数加权最近邻）+ 每趟≤maxTripMin 截断 + `routeOriginPt` 兜底 (0,0)。④ 锁定后可加单：`openBatchCandidates` 含 `status IN (0,1)` 且 `bin_opened_at IS NULL` 且 `loaded_at IS NULL`（修「锁定后订单进不来」）。⑤ `checkInvariants` 同步覆盖待上货未装货批次 |
| `backend/domains/delivery/timers.js` | ④ 自动定型收敛到 `planAutoLock` 唯一入口（删 legacy 逐批判定分支）；注释更新（不再提 BATCH_WAIT_MS） |
| `backend/domains/delivery/routes.js` | 需求6 互斥闸：open-bin（召唤/Route B 两路径）加「车在动→拒开舱（car_moving）」；close-bin 加「车在动→拒关舱」；dispatch 加「舱门未关→拒立即配送（bin_open）」 |
| `backend/domains/delivery/service.js` | `startSummonDelivery` 顶部加 bin_open 门禁（覆盖看门狗自愈路径，双保险） |
| `backend/services/platform-http.js` | 新增 `robotMoving`（机器状态集 `['Delivery','delivery','patrol','Patrol']` 判移动）+ 导出 |
| `backend/services/platform.js` | 转发 `robotMoving` 到 deps.platform |
| `backend/tests/test_batch_v2_timing.js` | 更新为「唯一实现」口径：删 legacy 开关断言、加 K=2/三档/窗口缩短/`situationOf` 纯函数断言；临时库表补 `bin_opened_at`/`loaded_at` 等列；§2b 新增情况3 缩短窗口用例 |
| `backend/tests/test_batch_v2_invariants.js` | 函数名 `planAutoLockV2`→`planAutoLock`、`shouldAutoLockV2`→`shouldAutoLock`；临时库表补列 |
| `backend/tests/test_door_mutex.js` | **新增**：需求6 互斥闸 e2e（mock）——开舱置位→舱门开着立即配送被拦(bin_open)→关舱清标记→放行；开舱幂等；robotMoving 出口形状 |
| `doc/14_组单算法v2待办与实测清单.md` | §八 两行过时项更新（开关已删、legacy 已删）+ 追加 §十一 变更节（v2 转正、新行为表、回滚通道、指向 doc/15） |
| `doc/15_上货点真实任务与组单v2落地.md` | **新增**：P3 上货点真实任务设计（lightTask 5 分钟到期返程 + keepLoadingSummon 4 分钟破坏性重召唤 =「开仓就走」根因；create/direct 驻停机制；衔接顺序硬规则）+ F1~F6 真机验证清单 + P4 动态承诺公式 + 本会话已完成/待办 |
| `可视化大屏/index.html` | 需求5a 清冗余：删 subTitle/kvMode/kvPlatform(顶栏副行)/整个 footer/图例 lgPath·lgRoad/7 处 `.en` 标签/微小文案行（.sub、robot-cap、.note）；工具栏 title 缩短并修「\*\*」泄漏；`?v=` bump（css 3d3→3d4、views-ui 3d43→3d44、map 3d42→3d43、main 3d63→3d64） |
| `可视化大屏/css/dashboard.css` | 删死规则：`.h-text`/`.h-meta`/`.note`/`.robot-cap`/`.lgPath`/`.lgRoad`/`.footer` |
| `可视化大屏/js/dashboard/views-ui.js` | 需求4 修复：`diffEvents` 末尾写回 `state.prev = d`（此前分件时弄丢，右侧实时动态恒空）；首帧补「大屏已连接后端」一行；`renderRunState` 删 kvMode/kvPlatform/subTitle 写入 |
| `可视化大屏/js/dashboard/main.js` | `apply()` 注释更新（state.prev 写回在 diffEvents 内）；删 `footMid` 写入 |
| `可视化大屏/js/dashboard/map.js` | 天地图密钥缺失提示去掉 env 变量名（不泄漏配置项名） |
| `agent/agent交接文档/git交接文档/git交接文档45.md` | 本文件 |

**不在本次提交**：`backend/services/road-distance.js`（未跟踪新文件，坐标系探针证实平台米↔OSM 路网无可靠仿射桥，**已删除**，退直线×绕行）；探针都在 `_tmp4\probes\`（仓库外）。

## 二、遇到的问题 / 踩的坑

1. **`lmPoint((0,0))` 返回 null 会让路线排序静默退化**：`planRouteV2` 起点取 `lmPoint(loading)`，
   而测试标定里上货点恰在 (0,0) → `cur && p` 恒假、所有候选得分 0 → 排序退化成输入序且不报错，
   `test_summon_flow` 的「α=0 退纯最近邻」用例因此失败。修法：`routeOriginPt` 对 null 起点兜底 `{x:0,y:0}`。
2. **`diffEvents` 首帧处理**：直接给 `if (p)` 分支加首帧逻辑会把对比体放错分支；先写了 `if (!p){...return}` 再把旧体接上，靠 `read` 核对才没留悬空代码。
3. **PowerShell 文件排序误导编号**：`Sort-Object Name` 是字典序（`44 < 6`），交接文档取最大号必须数值排序。
4. **探针验证坐标桥**：平台米（东苑1~5 X 全 ≈-15）与 OSM 本地米（同一批楼栋散布 30~6300）连仿射都拟合不上（平均残差 2.7km）→ 按计划删 `road-distance.js`，不交付"看起来合理但错误"的路网估算。

## 三、校验记录

- `node --check`：batch/timers/routes/service/platform-http/platform/大屏 views-ui/main/map 全部 exit 0。
- 后端回归：`_tmp4/probes/tools/run_backend_tests.mjs` → **17/17 通过**（含新增 `test_door_mutex.js` 21 项；`test_batch_v2_timing.js` 35 项、`test_batch_v2_invariants.js` 15 项、`test_summon_flow.js` 全过）。
- 大屏真实浏览器 CDP：`verify_keys.mjs` + `verify_layout.mjs` 全部通过、**0 console 报错**、「校验一致 true」；新增回归探针 `probe_dash_events_snapshot.mjs` 8 项通过（state.prev 写回 + 三事件产出）。
- index.html 标签平衡：div 73/73、section 3/3、main 1/1、footer 0。
- 提交前 `git status --short` 确认工作区只有本表文件（无残留探针/临时文件）。

## 四、提交信息原文

```
提交：组单 v2 转正删 legacy + 动态窗口 K=2 + 大屏实时动态修复 + 开舱互斥闸

P1：batch.js 删 legacy 组批/定型/路线三套实现，v2 唯一；旧 BATCH_ALGO/BATCH_V2_READY
  只告警不报错；timers 自动定型收敛到 planAutoLock 唯一入口。
P2：锁定后可加单（status IN (0,1) 且未开舱未装货）；动态窗口 BATCH_PRESSURE_K=2 三档，
  待发≥K×可用车时 batchHoldMs 缩短窗口；planRouteV2 真实现（楼栋聚类+单数加权最近邻
  +每趟≤15分钟截断+(0,0)起点兜底）。
需求4：大屏 diffEvents 写回 state.prev（分件时弄丢，实时动态恒空）+ 首帧已连接提示。
需求5a：大屏去冗余（顶栏副行/整个footer/图例死项/7处英文标签/微小文案）+ ?v bump。
需求6：开舱/关舱/立即配送互斥闸（robotMoving 车动拒开关舱 + bin_open 拒配送）。
road-distance.js 删除（平台米↔OSM路网无可靠坐标桥，退直线×绕行）。
测试：17/17 全绿（新增 test_door_mutex 21 项）；大屏 CDP 探针 0 console 报错。
```

## 五、提交号

`（本提交自身的提交号无法写进自己，见下一次文档提交或 git log）`

## 六、是否已推送

是（`git pull --rebase` 后 `git push origin main`；推送后 `git fetch origin` 复核 `git rev-list --left-right --count origin/main...HEAD` = `0  0`）。
