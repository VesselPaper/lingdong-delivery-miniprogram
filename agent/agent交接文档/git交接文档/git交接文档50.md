提交：用户端购物车修复（面板去结算露出 + 清空红点竞态）+ 活动商品独立落地页

## 一、本次范围（全部在 用户端/，无后端改动）

| 文件 | 改了什么 |
| --- | --- |
| `用户端/components/cart-panel/cart-panel.wxss` | **购物车面板去结算被覆盖**：`.cp-sheet` 的 `bottom` 从 `0` 改为 `calc(248rpx + env(safe-area-inset-bottom))` —— 面板底部（去结算脚条）停在页面「底部购物车栏」上方（横条底 116rpx + 高约 120rpx ≈ 顶 236rpx），去结算露出、不再被横条盖住；购物车横条保留（负责人 2026-10-14 明确要求"底部应该在购物车横条的上方，把去结算漏出来"） |
| `用户端/components/cart-panel/cart-panel.js` | **清空购物车后角标残留（竞态）**：`applyItems` 不再同步触发 `changed`（乐观更新时页面会读到还没删完的旧购物车）；改为 勾选/全选/数量/清空 四个操作在 `await` 服务端**落定后**再 `triggerEvent('changed')`，页面此时拉到的才是权威购物车 |
| `用户端/pages/index/index.wxml` `用户端/pages/goods/list.wxml` | cart-bar 的 `wx:if` 恢复为 `{{cartCount}}`（撤回上一版"面板展开时隐藏横条"的做法，横条保留、面板底部上移） |
| `用户端/pages/activity/goods.js` `.wxml` `.wxss` `.json` | **新增：活动商品独立落地页**（`/pages/activity/goods?id=`）—— 活动标题 + 优惠摘要头（打折→「8.5折」、满减→「满X减Y」），商品卡片与商城同款（折扣标签/省下金额/售罄态/步进器加购），空态兜底，原生返回键 |
| `用户端/pages/activity/index.js` | 点打折/满减活动 → `navigateTo` 活动商品页（原：写 `goods_id_filter` storage 后 switchTab 进商城，污染 tab 状态导致"回不到全量、必须重开商城"） |
| `用户端/pages/index/index.js` | 首页轮播图（纯展示活动带商品）→ 同样跳活动商品页，不再给商城带筛选 |
| `用户端/app.json` | 注册 `pages/activity/goods` |

**为什么活动商品独立成页而不是给商城带筛选**：商城是 tabBar 页，`switchTab` 不支持 query，只能走 storage 带筛选 —— 筛选消费一次后没有入口回全量，必须重开商城才恢复（用户反馈）。独立页面有原生返回键、商城永远全量、还能放活动头图/优惠摘要，是真实小程序"活动落地页"的标准做法。

## 二、遇到的问题 / 踩的坑

1. **先做了"面板展开时隐藏购物车横条"被否**：第一版修复是把 cart-bar 改为 `wx:if="{{cartCount && !cartPanelShow}}"`（面板自带底栏，隐藏页面横条避免重叠）。负责人反馈：**横条要保留，面板底部应停在横条上方**。已回滚 wx:if 并改 `.cp-sheet` 的 bottom 偏移。
2. **角标竞态**：`applyItems` 原在函数尾同步 `triggerEvent('changed')`，而它既被"乐观更新"调、也被"服务端落定后"调 —— 乐观更新时页面 `loadCart()` 抢在 DELETE 完成前执行，读到旧数量。修复 = 触发时机移到 `await` 之后。
3. **PowerShell 内联 node 引号问题**：`node -e` 里含 `wx:if="..."` 转义引号在 pwsh 5.1 下解析失败，改用 grep 工具核对（UTF-8 安全）。

## 三、校验记录

- `node --check`：cart-panel.js、activity/goods.js、activity/index.js、index/index.js 全部 exit 0。
- `app.json` 已注册 `pages/activity/goods`。
- `goods_id_filter` 已无写入方（activity/index、index/index 均改走新页面；list.js 仅剩防御性读取，无副作用）。
- cart-bar `wx:if` 两页均恢复 `{{cartCount}}`；`.cp-sheet` bottom 偏移已按横条几何计算（248rpx）。
- 小程序页面效果需微信开发者工具预览/上传后确认（本机无微信开发者工具自动化）。

## 四、提交信息原文

```
提交：用户端购物车修复（面板去结算露出 + 清空红点竞态）+ 活动商品独立落地页

购物车：面板底部停在购物车横条上方（去结算露出、横条保留）；清空/改数量后
  changed 事件改为服务端落定后触发，修复清空后角标残留的竞态。
活动商品：新增独立落地页 /pages/activity/goods（活动标题+优惠摘要+商品卡片+加购），
  活动页与首页轮播改跳此页，不再用 storage 筛选污染商城 tab（回不到全量的问题根除）。
```

## 五、提交号

`（本提交自身的提交号无法写进自己，见下一次文档提交或 git log）`

## 六、是否已推送

是（走 7890 代理；推送后复核 `origin/main...HEAD` = `0  0`）。
