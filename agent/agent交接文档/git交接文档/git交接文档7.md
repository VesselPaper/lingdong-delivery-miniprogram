# git 交接文档 7

> 对应提交①：**虚拟车与真实派车彻底隔离**。本文件与该提交一起提交。

## 一、提交范围

| 文件 | 改了什么 |
| --- | --- |
| `backend/services/platform-http.js` | `getDeviceList(opts)` 改为**默认不并入虚拟车**，只有传 `{withVirtual:true}` 的纯展示调用点才并；新增 `virtualBlocked(deviceSn, what)`，在授权/开舱/关舱/驻停/确认上货/强制关任务/查询设备任务/门禁判定等处一律拒绝虚拟车（判定只看设备号，**与开关无关**，开关关掉后残留的 LD-SIM-* 同样挡住） |
| `backend/services/platform.js` | 自动挑车（`pickAvailableRobot`）与召唤（`summonToLoadingPoint` / `summonToPoint`）统一走 `dispatchableRobots()` 排除虚拟车；导出 `virtualRobotStatus` / `ensureVirtualRoute` |
| `backend/services/autoLoad.js` | 自动召唤的候选车排除虚拟车 |
| `backend/domains/admin/live.js`、`domains/admin/routes.js`、`domains/admin/service.js` | 纯展示路径显式传 `{withVirtual:true}`（大屏/管理页要能看到模拟车跑）；`service.js` 另下发地图 `meta`（平台栅格元数据，前端坐标映射用它而不是 bbox 拉伸）与 `virtual_robot` 诊断字段 |
| `backend/domains/delivery/routes.js` | 商家端 `/merchant/robots` 显式开口 |
| `backend/.env.example` | 补虚拟车开关说明；默认 `VIRTUAL_ROBOT=1` / `VIRTUAL_ROBOT_COUNT=4`（成员 clone 后照抄就能看到车，否则空库+没真车时左栏是"暂无车辆数据"，容易被误判成没跑起来） |
| `doc/07_配送平台对接.md` | 同步虚拟车接入口径 |
| `doc/上线计划/01~06 + README`（7 篇） | 早先那批上线计划文档（本次一并提交） |

## 二、为什么这么改

虚拟车是**接口层模拟数据**，平台侧并不存在该设备。原来的写法是"默认并入、业务处各自记得过滤"，而 `getDeviceList` 是全后端业务判定的共用入口（派车/召唤/忙闲判定/运力统计/上货门禁），漏一处就会把假设备当成真车下发指令。改成"最底层默认摘掉、展示路径显式开口"，业务代码就不可能拿到它。

## 三、遇到的问题 / 踩的坑

1. **`platform-http.js` 一个文件横跨两个提交**：里面既有本提交的虚拟车隔离，又有提交③的"标定文件读不出来要留痕"。本次用 `git apply --cached` 按 hunk 拆分，只把 `withVirtual` / `virtualBlocked` 相关 hunk 暂存进来。
2. 拆 hunk 后必须双向验证：`git diff --cached` 里只有①的 hunk，`git diff`（工作区）里只剩标定告警那一段。**否则会把③的内容混进①或漏掉**。
3. `.env.example`、`domains/admin/service.js` 是 `MM` 状态（暂存区与工作区各有改动），必须确保取的是**工作区完整版本**，不要只提交暂存区的半份。

## 四、校验记录

| 项 | 结果 |
| --- | --- |
| 本提交实际文件清单 | 16 个（见上表；其中 `platform-http.js` 只含①的 hunk） |
| hunk 拆分双向核对 | `--cached` 只含虚拟车 hunk；工作区只剩 `loadAutoCalib` 告警 hunk（留给提交③） |
| 代码行为验证 | 引用《交接文档18》的实测：后端回归 11/11 通过；`VIRTUAL_ROBOT=1` 时大屏能看到模拟车、真实派车路径拿不到它 |
| 本轮是否重跑测试 | **未重跑**（本轮只做提交拆分，未改任何代码） |

## 五、提交信息原文

```
虚拟车与真实派车彻底隔离：接口层默认摘掉模拟车，展示路径显式开口

- getDeviceList() 默认不并入虚拟车（仅展示路径传 {withVirtual:true}）
- 新增 virtualBlocked()：虚拟车一律拒绝设备控制/开舱/驻停/派单/门禁判定等真实平台指令
- platform.js / autoLoad.js：自动挑车与自动召唤排除虚拟车
- .env.example：补虚拟车开关说明，默认 VIRTUAL_ROBOT=1 / COUNT=4
- doc/07 与 doc/上线计划/ 同步
```

提交号：（见 `git log`）
是否已推送：**否**（四个提交一起推送）

## 六、遗留待办

- 大屏工具栏死代码：`map3d-gl.js` 绑定的 `#m3Path` / `#m3Route` / `#m3Road` 在 `index.html` 里已无对应按钮，不影响功能，想清理再说。
