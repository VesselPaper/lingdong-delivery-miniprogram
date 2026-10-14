// 配送批次服务：一车多单，容量以「商品件数」计（一车最多 BATCH_MAX_ITEMS 件，默认 12 件）
// 现实模型：无人车单仓，可放多份商品 → 一次出车配送一个「批次」（最多 12 件商品）。
// 分批算法：best-fit 最优适配 —— 每单按商品件数放入「能容纳且当前最满」的组单中批次；
//  单件数 < 12 → 整单留在同一批；单件数 > 12 → 自动独占新批次。
// 关键点：
//  1. 每单独立取餐码（防拿错；平台 unloading/verify 按任务匹配取餐码开舱）。
//  2. 一个仓多个人拿：orders.picked_up_at 记录每单是否已被取走，全部取完 → 批次完成。
//  3. 多地点配送顺序：按点位分组后，从上货点做贪心最近邻排序（近似最小化顾客总等待），
//     停靠顺序写入 batch.route，平台任务按停靠顺序创建并以 priority 递减提示排程。
// 本模块只做数据库编排，不直接调用平台（平台调用在 services/platform.js，由 server.js 编排），
// 避免循环依赖。

// 编号服务：批次号 = 日期 + 当日序号（原子取号）
const seqSvc = require('./seq')
// 点位口径（当前运营图 / 上货点唯一取值入口）：叶子模块，只依赖 store → 不成环
const points = require('./points')

const BATCH_STATUS = {
  0: '组单中',
  1: '待上货',
  2: '配送中',
  3: '已完成',
  4: '异常'
}

// 一车最多多少件商品（现实仓容上限，以商品件数计，默认 12 件/车）
const BATCH_MAX_ITEMS = Number(process.env.BATCH_MAX_ITEMS || 12)
// 兼容旧引用（原「12 单」现为「12 件商品」口径）
const BATCH_MAX_ORDERS = BATCH_MAX_ITEMS
// 未满容批次的等待上限（默认 15 分钟）：从批次内「第一张订单的下单时间」起算，超过即定型。
// 三条刻意的设计（都是踩过坑换来的）：
//   ① 锚点是【订单下单时间】而不是【批次创建时间】（自动接单有延迟时两者能差几分钟）；
//   ② 默认 15 分钟而不是 90 秒 —— 90 秒只够凑 1~2 单，一车跑一趟成本收不回来；
//   ③ 锚点取【第一张】订单而不是最新一张 —— 否则持续来新单会让批次无限续命，永远发不出去。
const BATCH_HOLD_MS = Number(process.env.BATCH_HOLD_MS || 15 * 60 * 1000)
// 单数加权最近邻权重 α（ROUTE_COUNT_WEIGHT）：给「距离」按该站点订单数打折，
// 有效距离 = 距离平方 ÷ (订单数^α)。α=0 退化纯最近邻，越大越偏好多单楼栋。默认 0.5。
const ROUTE_COUNT_WEIGHT = Number(process.env.ROUTE_COUNT_WEIGHT || 0.5)

// ---------- 组单算法：v2 已是唯一实现（legacy 已于 2026-10-14 删除） ----------
// v2 = 商品/订单/批次三层层级、情况1·情况2 分支、可用车判定、
//      每趟时长上限、以「新订单产生」起算的 15 分钟窗口。
//
// 为什么没有开关了：
//   原来 legay/v2 双实现靠 BATCH_ALGO + BATCH_V2_READY 切换，回滚成本低。
//   但两套算法并存意味着每次改时机/容量规则都要改两处、测两处，实测中已经出现
//   「以为切了 v2、其实还在跑 legacy」的误判（BATCH_V2_READY 忘了给）。用户明确要求
//   「把旧算法直接删掉」，所以现在只保留 v2，删掉 legacy 的 best-fit 组批 + 90 秒定型。
//
// ⚠ 删掉之后就没有「改 .env 回滚」这条路了。剩下的回退手段只有两条：
//   ① 本地/远端分支 backup/pre-algo-rework-2026-10-14（改动前的快照）；
//   ② 云上 /opt/lingdong/bin/rollback.sh 退到上一个 release。
//
// 旧变量容忍：老 `.env`、云上 `backend.env` 里可能还留着 BATCH_ALGO / BATCH_V2_READY。
// 那两份文件不在仓库里、改不到，所以这里**只告警不报错** —— 后端必须照常起来，
// 行为一律按 v2 走，绝不因为一个过期变量把服务拦在门外。
const _legacyAlgoEnv = String(process.env.BATCH_ALGO || '').trim().toLowerCase()
const _legacyReadyEnv = String(process.env.BATCH_V2_READY || '').trim().toLowerCase()
if ((_legacyAlgoEnv && _legacyAlgoEnv !== 'v2') || (_legacyReadyEnv && _legacyReadyEnv !== 'true')) {
  console.warn('[batch] 检测到已废弃的组单开关（BATCH_ALGO=' + (_legacyAlgoEnv || '未设')
    + ' / BATCH_V2_READY=' + (_legacyReadyEnv || '未设') + '）：旧算法已删除，本次运行按 v2 执行，'
    + '请把这两行从 .env / backend.env 里删掉')
}

// 召唤多单配送的「推进钩子」：当某停靠点第单被取走（批次计数+1）时，通知 delivery 域去判断
// 「当前楼栋是否全取完 → 停 5s → 召唤下一栋」。hook 由 delivery/service.js 注册（registerSummonAdvance），
// 避免 batch.js 与 delivery 域循环依赖（本库不接受 deps）。
let summonAdvanceHook = null
function registerSummonAdvance(fn) { summonAdvanceHook = fn }
function notifySummonAdvance(batchId) {
  if (summonAdvanceHook) { try { summonAdvanceHook(batchId) } catch (e) { console.warn('[batch] summonAdvance hook 异常', e.message) } }
}

function statusText(st) {
  return BATCH_STATUS[Number(st)] || ('状态 ' + st)
}

// 点位/路线名称清洗：历史脏数据可能出现「??1?」「？？」等占位符，统一剔除。
// 返回 null 表示该名称无效（调用方回退到 landmarks 表或「未知点位」）。
function cleanName(name) {
  if (name === undefined || name === null) return null
  const s = String(name).replace(/[?？]/g, '').trim()
  return s || null
}

// 由 landmarks 表解析点位名称（按 id）；解析失败回退到传入名称，再失败为「未知点位」
function landmarkNameOf(store, landmarkId, fallback) {
  if (landmarkId) {
    const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(String(landmarkId))
    if (lm) return cleanName(lm.name) || fallback
  }
  return cleanName(fallback) || '未知点位'
}

function getBatch(store, batchId) {
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(batchId)) || null
}

// 订单商品件数（一个订单可能含多件商品；分批以「件」为单位）
// 单测/最小库可能没有 order_items 表 —— 此时按 0 件算，不让估时长把整条链路拖崩。
function orderItemCount(store, orderId) {
  try {
    const row = store.prepare('SELECT IFNULL(SUM(quantity),0) s FROM order_items WHERE order_id=?').get(orderId)
    return Number(row && row.s || 0)
  } catch (e) { return 0 }
}

// 手机号脱敏（P1-13）：商家端列表/详情默认只显示 138****0000，
// 明文手机号只在开舱验证等内部逻辑使用（服务端直接读库），对外一律脱敏。
function maskPhone(p) {
  const s = String(p || '')
  if (!s) return ''
  return s.length <= 7 ? (s.slice(0, 1) + '****' + s.slice(-2)) : (s.slice(0, 3) + '****' + s.slice(-4))
}

// 兜底组批：不做任何打分，直接 best-fit —— 取「能容纳本单件数且当前最满」的在收批次，没有就新建。
// 只在两种情况下用得到，正常单永远走 getOrCreateOpenBatchV2：
//   ① 单件数 > BATCH_MAX_ITEMS（一车装不下这一单）：任何批次都塞不进，必须独占一批，
//      否则这一单会在候选里被全部跳过、每次调用都新建空批次 → 批次爆炸；
//   ② 调用方拿不到 order（旧调用路径 / 单测直接调）：没有楼栋与下单时间就算不出 v2 的分，
//      退回 best-fit 保证不崩，行为也比"每次新建"合理。
// 容量一律实时算（SUM(order_items.quantity)），不信 delivery_batches.total_items 缓存列 ——
// 历史上出现过「UI 实时口径 8 件、调度器读缓存列 3 件」的分叉。
function bestFitOpenBatch(store, itemCount) {
  const n = Number(itemCount || 0)
  const b = store.prepare(`
    SELECT b.id, IFNULL(SUM(oi.quantity), 0) AS items
    FROM delivery_batches b
    LEFT JOIN orders o ON o.batch_id = b.id AND o.status IN (1,2)
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE b.status = 0
    GROUP BY b.id
    HAVING items + ? <= ?
    ORDER BY items DESC, b.id DESC LIMIT 1`).get(n, BATCH_MAX_ITEMS)
  if (b) return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(b.id))
  // 编号：日期 + 当日序号（原子取号，见 services/seq.js）；商家端卡面展示短号「B-MMDD-NN」
  const { day: seqDay, seq } = seqSvc.nextSeq(store, 'batch')
  const batchNo = seqSvc.batchNo(seqDay, seq)
  const info = store.prepare('INSERT INTO delivery_batches (batch_no, status, status_text, total_orders, total_items, daily_seq, seq_date) VALUES (?,0,?,0,0,?,?)')
    .run(batchNo, BATCH_STATUS[0], seq, seqDay)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(info.lastInsertRowid))
}

// ==================== v2 组批：参数 ====================
// 单位说明：距离一律「米」，用 landmarks.pos_x/pos_y 真实坐标算直线距离，再乘绕行系数
// （无人车走路网，不是直线飞）。
//
// ⚠ 下面这些数值目前都是【模拟器标定出来的估计值】，不是实测值。真实配送跑通后回填即可，
//   全部走环境变量，不需要改代码。特别是 speedMpm：真实车速是 1.0~1.5 m/s（÷1.3 绕行 ≈ 46~69 米/分），
//   实测前先用 60（≈1.0 m/s）。
//
// 注意 stopWaitSec 是【期望】等待，用于估时长；每站等待的【上限】是另一个参数，
// 由取餐看门狗（order/service.js 的 PICKUP_* 系列）负责，两者不要混用。
const V2 = {
  speedMpm: Number(process.env.BATCH_SPEED_MPM || 60),                 // 车辆速度 米/分（60 ≈ 1.0 m/s）
  detour: Number(process.env.BATCH_DETOUR || 1.3),                     // 绕行系数：路网距离 ÷ 直线距离
  loadingSec: Number(process.env.BATCH_LOADING_SEC || 120),            // 上货固定耗时
  stopServiceSec: Number(process.env.BATCH_STOP_SERVICE_SEC || 30),    // 每站停靠/开舱
  stopWaitSec: Number(process.env.BATCH_STOP_WAIT_SEC || 70),          // 每站等用户取餐【期望】耗时（不是上限）
  perOrderOpenSec: Number(process.env.BATCH_PER_ORDER_OPEN_SEC || 10), // 每单开舱
  maxTripMin: Number(process.env.BATCH_MAX_TRIP_MIN || 15),            // ★每趟时长上限，取代「最多 3 个楼栋」
  // 打分权重：各分项先归一化到 0~1 再加权，权重才可解释、可调
  wDuration: Number(process.env.BATCH_W_DURATION || 1.0),              // 越接近时长上限越差
  wSameBuilding: Number(process.env.BATCH_W_SAME_BLDG || 1.5),         // 同楼栋优先合并
  wOrderAge: Number(process.env.BATCH_W_ORDER_AGE || 0.3),             // 先来先填（优先填更老的批次）
  wDistance: Number(process.env.BATCH_W_DISTANCE || 0.8),              // 楼栋间距近的优先
  // 迟滞：情况1/情况2/情况3 的判定要连续稳定这么久才真的切换，避免车一上线/离线就来回跳
  hysteresisMs: Number(process.env.BATCH_HYSTERESIS_MS || 30 * 1000),
  // 硬上限：订单在组单中批次里等超过这么久，无条件发出去（防死锁的最后一层网）
  hardMaxMs: Number(process.env.BATCH_HARD_MAX_MS || 20 * 60 * 1000)
}
// 距离归一化参考值（米）：校园尺度上最远的东苑7栋约 220.9 m，取 250 做满量程
const V2_REF_DIST_M = 250

// 运力压力系数 K（BATCH_PRESSURE_K）：待发批次数 ≥ K × 可用车数时，说明积压已经明显超过
// 车的消化能力 —— 再按标准 15 分钟攒单只会让队列越排越长，所以把攒单窗口缩短。
// 用户 2026-10-14 定的规则：缩短的判据是「待发批次数 ≫ 可用车数」，取 K=2。
// K ≤ 1 等于关掉这条规则（永远不缩短）。
const BATCH_PRESSURE_K = Math.max(1, Number(process.env.BATCH_PRESSURE_K || 2))

// 攒单窗口的分钟数（按运力压力动态调整）。返回值用于「到点判定」，全流程只有一个口径。
// 不能小于 3 分钟：再短就等于不攒单，每单单独发一趟，车全在路上跑。
function batchHoldMs(openCount, available, now) {
  const n = Number(openCount || 0)
  const avail = Math.max(1, Number(available || 0))
  // 压力比 = 待发批次数 ÷ 可用车数。1 = 刚好排得下；2 = 得跑两轮才消化完。
  const ratio = n / avail
  if (ratio < BATCH_PRESSURE_K) return BATCH_HOLD_MS
  // 缩短幅度：压得越狠缩得越短，但最多缩到标准窗口的一半（比值 ≥ 2K 封顶）。
  const shrink = Math.max(0.5, BATCH_PRESSURE_K / ratio)
  return Math.max(3 * 60 * 1000, Math.round(BATCH_HOLD_MS * shrink))
}

// ---------- v2 纯函数层（不碰数据库，可单测、可重放） ----------

// 时间字符串 → 毫秒时间戳；不可解析返回 null
function parseTime(v) {
  const t = new Date(String(v || '').replace(' ', 'T')).getTime()
  return isNaN(t) ? null : t
}

// 点位坐标：pos_x/pos_y 都是 0 视为「无坐标」
function lmPoint(landmark) {
  if (!landmark) return null
  const x = Number(landmark.pos_x) || 0
  const y = Number(landmark.pos_y) || 0
  return (x === 0 && y === 0) ? null : { x, y }
}

// 两个坐标之间的路网距离（米）= 直线距离 × 绕行系数
function v2DistM(a, b) {
  if (!a || !b) return 0
  const dx = a.x - b.x, dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy) * V2.detour
}

// 从起点依次经过各站的路网距离（米）。排序口径与 planRouteLegacy 完全一致
// 行程起点（上货点坐标）。
// ★ 不能直接用 lmPoint(loading)：lmPoint 把 (0,0) 当「无坐标」返回 null，而有的点位就真的在
//   原点附近（测试标定里上货点正是 (0,0)）。起点为 null 时，最近邻循环里 `cur && p` 恒假、
//   所有候选得分都是 0 → 排序静默退化成「按输入顺序」，而且不报错。
//   这里退一步取 {x:0,y:0} 当原点：排序结果确定、可复现；真机上货点有真实坐标时行为不变。
function routeOriginPt(loading) {
  return lmPoint(loading) || { x: 0, y: 0 }
}

// 单数加权最近邻排序（纯函数）：反复挑「有效距离最小」的未访问站。
//  有效距离 = 直线距离² ÷ (该站单数^ROUTE_COUNT_WEIGHT)
// 为什么要单数加权、不纯按距离：同距离下（甚至稍远一点点）单数多的楼栋先送，
// 否则 1 单的近楼栋会抢在 5 单楼栋前面，把多单楼栋所有人的等待一起拖长。
// 返回原 stops 数组的重排副本；无坐标的站排序结果不保证有意义（调用方自行兜底）。
function v2OrderStops(from, stops) {
  let cur = from
  const rest = stops.slice()
  const out = []
  while (rest.length) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < rest.length; i++) {
      const p = rest[i].pt
      const d2 = (cur && p)
        ? (Math.pow(cur.x - p.x, 2) + Math.pow(cur.y - p.y, 2)) / Math.pow(Math.max(1, rest[i].n || 1), ROUTE_COUNT_WEIGHT)
        : 0
      if (d2 < bestD) { bestD = d2; best = i }
    }
    const s = rest.splice(best, 1)[0]
    out.push(s)
    cur = s.pt || cur
  }
  return out
}

// 按给定顺序累加路网距离（米）。直线距离 × 绕行系数（无人车走路网，不是直线飞）。
function v2PathDistanceM(from, orderedStops) {
  let cur = from, total = 0
  for (const s of orderedStops) {
    if (cur && s.pt) total += Math.sqrt(Math.pow(cur.x - s.pt.x, 2) + Math.pow(cur.y - s.pt.y, 2))
    if (s.pt) cur = s.pt
  }
  return total * V2.detour
}

// 从起点依次经过各站的路网距离（米）。排序口径与 planRouteV2 完全一致
// （单数加权最近邻 d² ÷ n^α），保证「估时长用的顺序」和「实际派车顺序」是同一个。
// stops: [{ pt: {x,y}|null, n: 该站单数 }]
function v2RouteDistanceM(from, stops) {
  return v2PathDistanceM(from, v2OrderStops(from, stops))
}

// 一趟的预计分钟数 = 上货 + 行驶 + 每站(停靠+等用户) + 每单开舱。
// 不含返程（返程由「召回」单独处理，不计入本趟时长上限）。
function v2EstimateTripMin(loadingPt, stops, items) {
  const travelMin = v2RouteDistanceM(loadingPt, stops) / Math.max(1, V2.speedMpm)
  const fixedSec = V2.loadingSec
    + stops.length * (V2.stopServiceSec + V2.stopWaitSec)
    + Number(items || 0) * V2.perOrderOpenSec
  return travelMin + fixedSec / 60
}

// 候选批次打分（纯函数）：分数越高越该把这一单并进去。
//   + 同楼栋                     → 「同楼栋优先合并」
//   + 批次第一张订单已等越久      → 「先来先填」（老批次先被填满、先离开）
//   − 离批次已有楼栋的最近距离    → 「多楼栋时优先楼栋间距近的」
//   − 加入后时长 ÷ 上限          → 「每趟 ≤15 分钟」
function v2ScoreCandidate(cand, orderPt, orderLandmarkId, orderItems) {
  const sameBuilding = (orderLandmarkId != null && cand.landmarkIds.has(String(orderLandmarkId))) ? 1 : 0

  const stops = cand.stops.concat([{ pt: orderPt, n: 1 }])
  const tripMin = v2EstimateTripMin(cand.loadingPt, stops, cand.items + Number(orderItems || 0))
  const durationTerm = Math.min(1, tripMin / Math.max(1, V2.maxTripMin))

  let nearest = V2_REF_DIST_M
  if (cand.stops.length > 0) for (const s of cand.stops) nearest = Math.min(nearest, v2DistM(s.pt, orderPt))
  const distTerm = Math.min(1, nearest / V2_REF_DIST_M)

  const ageMin = Math.max(0, (Date.now() - (cand.firstOrderAt || Date.now())) / 60000)
  const ageTerm = Math.min(1, ageMin / Math.max(1, BATCH_HOLD_MS / 60000))

  return V2.wSameBuilding * sameBuilding + V2.wOrderAge * ageTerm
       - V2.wDuration * durationTerm - V2.wDistance * distTerm
}

// ---------- v2 数据库层 ----------

// 某个点位的坐标（landmarks 表只有 11 行，不做缓存，避免点位同步后读到旧坐标）
function landmarkPointOf(store, landmarkId) {
  try {
    return lmPoint(store.prepare('SELECT * FROM landmarks WHERE id=?').get(landmarkId))
  } catch (e) { return null }
}

// 上货点取值：**口径已收口到 services/points.js**（全项目唯一入口，别再各写一条 SQL）。
// 选点规则见 points.js 头注释：优先「当前运营图」（车所在图）上那条 —— 平台上同时挂着
// 在用图与备份图、同名点各有不同 landmarkId，只按 sort 取第一条会命中备份图的旧位置。
// 这里保留本函数名与「排除 (0,0) 占位点」的语义：points.loadingPointRow 的前两级都排除 (0,0)，
// 只有全库仅剩一条 (0,0) 占位点时才返回它 —— 而 lmPoint() 对 (0,0) 仍返回 null，
// 所以「上货点 → 第 1 站」那一段的行为与拆分前逐字一致（见 lmPoint 注释）。
function loadingPointOf(store) {
  return points.loadingPointRow(store)
}

// 可以继续收单的批次候选快照，供打分使用。
// cand = { id, status, items, firstOrderAt, landmarkIds:Set, stops:[{landmark_id,pt,n}], loadingPt }
//
// ★ 这里包含「已定型待上货(status=1)」的批次，是 2026-10-14 修的一个实打实的 bug：
//   原来只认 status=0，于是自动定型（组单中→待上货）一发生，这个批次就对所有组批逻辑
//   整体隐身了 —— 新单进不来、旧单也出不去，商家上货时明明还有空位却只能干看着。
//   正确口径：**已锁定但还没开始装货**的批次仍然可以进单。
//   「还没开始装货」= bin_opened_at 为空（商家没点开舱）且 loaded_at 为空（没有"已装好待配送"标记）。
//   一旦开过舱/装过货，就不再收新单 —— 车上的货和单据已经对不上了。
function openBatchCandidates(store) {
  const loading = loadingPointOf(store)
  const loadingPt = lmPoint(loading)
  const rows = store.prepare(`
    SELECT o.batch_id AS batch_id, o.landmark_id AS landmark_id, o.created_at AS created_at,
           b.status AS bstatus,
           IFNULL((SELECT SUM(quantity) FROM order_items WHERE order_id = o.id), 0) AS qty
    FROM orders o
    JOIN delivery_batches b ON b.id = o.batch_id
    WHERE o.status IN (1,2)
      AND b.status IN (0,1)
      AND b.bin_opened_at IS NULL
      AND b.loaded_at IS NULL
    ORDER BY o.batch_id, o.id`).all()

  const byBatch = new Map()
  for (const r of rows) {
    const id = Number(r.batch_id)
    let c = byBatch.get(id)
    if (!c) { c = { id, status: Number(r.bstatus || 0), items: 0, firstOrderAt: null, landmarkIds: new Set(), stops: [], counts: new Map(), loadingPt }; byBatch.set(id, c) }
    c.items += Number(r.qty || 0)
    const t = parseTime(r.created_at)
    if (t !== null && (c.firstOrderAt === null || t < c.firstOrderAt)) c.firstOrderAt = t
    const lid = r.landmark_id == null ? '' : String(r.landmark_id)
    c.counts.set(lid, (c.counts.get(lid) || 0) + 1)
  }
  for (const c of byBatch.values()) {
    for (const [lid, n] of c.counts) {
      c.landmarkIds.add(lid)
      c.stops.push({ landmark_id: lid, pt: landmarkPointOf(store, lid), n })
    }
  }
  return [...byBatch.values()]
}

// 新建一个「组单中」批次（bestFitOpenBatch 的建批段单独抽出来，供打分路径直接新建）
function createOpenBatchV2(store) {
  const { day: seqDay, seq } = seqSvc.nextSeq(store, 'batch')
  const batchNo = seqSvc.batchNo(seqDay, seq)
  const info = store.prepare('INSERT INTO delivery_batches (batch_no, status, status_text, total_orders, total_items, daily_seq, seq_date) VALUES (?,0,?,0,0,?,?)')
    .run(batchNo, BATCH_STATUS[0], seq, seqDay)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(info.lastInsertRowid))
}

// 组批决策：这一单该并入哪个可收单批次（组单中 或 已定型但还没开始装货），还是新建一个。
//   硬约束①：件数 + 本单 ≤ BATCH_MAX_ITEMS（单批次商品总数上限，默认 12 件）
//   硬约束②：加入后预计时长 ≤ V2.maxTripMin —— 单站兜底：只有一个站点时无条件放行。
//            否则像东苑7栋（220.9 m）这种远点会永远凑不出合规批次 → 死锁，订单永远发不出去。
//   软约束：按 v2ScoreCandidate 打分取最高（同楼栋优先 / 先来先填 / 楼栋间距近优先 / 时长余量）。
// ctx = { order }：需要订单的 landmark_id / created_at 才能算同楼栋与楼栋间距。
// 拿不到 order（旧调用方）或超容订单 → 退回 bestFitOpenBatch，保证不崩。
function getOrCreateOpenBatchV2(store, itemCount, ctx) {
  const n = Number(itemCount || 0)
  const order = ctx && ctx.order
  if (!order || n > BATCH_MAX_ITEMS) return bestFitOpenBatch(store, itemCount)

  const orderPt = landmarkPointOf(store, order.landmark_id)
  let best = null, bestScore = -Infinity
  for (const c of openBatchCandidates(store)) {
    if (c.items + n > BATCH_MAX_ITEMS) continue // 硬约束①：件数
    const stops = c.stops.concat([{ pt: orderPt, n: 1 }])
    if (stops.length > 1 && v2EstimateTripMin(c.loadingPt, stops, c.items + n) > V2.maxTripMin) continue // 硬约束②
    const sc = v2ScoreCandidate(c, orderPt, order.landmark_id, n)
    if (sc > bestScore) { bestScore = sc; best = c }
  }
  if (best) return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(Number(best.id))
  return createOpenBatchV2(store)
}

// 组批入口：v2 是唯一实现（legacy 已删除）。
function getOrCreateOpenBatch(store, itemCount, ctx) {
  return getOrCreateOpenBatchV2(store, itemCount, ctx)
}

// 接单并入批次：订单 1 待接单 → 2 配送中，挂到最优适配批次（以商品件数计容量）
// 注意：并入的目标批次可能是「已定型待上货但还没开舱」的批次（见 openBatchCandidates 注释）——
// 这是 2026-10-14 起的有意行为，不是漏洞：还没装货就有空位就该能进单。
function addOrderToBatch(store, order) {
  const itemCount = orderItemCount(store, order.id)
  const batch = getOrCreateOpenBatch(store, itemCount, { order })
  // batch_removed_at 必须一并清空：「配送异常重新配送」会先摘除本单再并入新批次，
  // 留着旧标记会让本单在新批次里再也摘不掉（计数永久虚高）。
  store.prepare("UPDATE orders SET batch_id=?, status=2, batch_removed_at=NULL, updated_at=datetime('now','localtime') WHERE id=?")
    .run(batch.id, order.id)
  store.prepare("UPDATE delivery_batches SET total_orders=total_orders+1, total_items=total_items+?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(itemCount, batch.id)
  return store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(batch.id)
}

// 订单取消/退款时从批次移除（仅计数，订单保留 batch_id 供审计）
// 幂等：同一订单会被「用户取消 / 平台推送 110 / 商家异常退款」多条路径摘除，
// 此前每条都再扣一次 total_orders 与 total_items，MAX(0,…) 只是把负数掩盖成 0。
function removeOrderFromBatch(store, order) {
  if (!order || !order.batch_id) return
  // 传入的 order 可能是取消前读的旧快照，标记一律以库中现值为准
  const cur = store.prepare('SELECT batch_removed_at FROM orders WHERE id=?').get(order.id)
  if (cur && cur.batch_removed_at) return
  const itemCount = orderItemCount(store, order.id)
  store.prepare("UPDATE delivery_batches SET total_orders=MAX(0,total_orders-1), total_items=MAX(0,total_items-?), updated_at=datetime('now','localtime') WHERE id=?")
    .run(itemCount, order.batch_id)
  store.prepare("UPDATE orders SET batch_removed_at=datetime('now','localtime') WHERE id=?").run(order.id)
  // 组单中的批次如果空了，标记异常以便回收（下一单会新建）
  const b = getBatch(store, order.batch_id)
  if (b && Number(b.status) === 0 && Number(b.total_orders) <= 0) {
    store.prepare("UPDATE delivery_batches SET status=4, status_text='批次已取消', updated_at=datetime('now','localtime') WHERE id=?")
      .run(b.id)
  }
}

// 批次已取走计数（幂等护栏在 order 域 markOrderPicked / fulfillOrder 已做，本函数只对仍生效的单+批计数）。
// 也被 order.service.fulfillOrder 跨域调用，作为 delivery 域对订单「已完成」的批次侧落账。
function countPicked(store, order) {
  if (!order) return
  const row = store.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
  if (!row) return
  if ([5, 7].includes(Number(row.status)) || row.cancelled_at) return
  if (row.batch_id) {
    store.prepare("UPDATE delivery_batches SET picked_orders=picked_orders+1, updated_at=datetime('now','localtime') WHERE id=?")
      .run(row.batch_id)
    const b = getBatch(store, row.batch_id)
    maybeCompleteBatch(store, row.batch_id)
    // 召唤模式：取完扇动推进钩子（delivery 域判断是否该推下一栋 / 召回）。
    // 注意不限制 status=2 —— 最后一单取走时 maybeCompleteBatch 可能已把批次置 3，
    // 若guard成 [2] 会挡住「召回上货点 + current_stop 归零」的收尾路径。
    if (b && b.delivery_mode === 'summon') {
      notifySummonAdvance(row.batch_id)
    }
  }
}

// 批次完成判断：批次内所有「有效订单」（配送中/已送达/已完成，排除取消/退款/异常）都已取走或平台任务已完成
function maybeCompleteBatch(store, batchId) {
  const b = getBatch(store, batchId)
  if (!b || ![1, 2].includes(Number(b.status))) return
  const stats = store.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN o.picked_up_at IS NOT NULL OR d.task_status >= 80 THEN 1 ELSE 0 END) AS done
    FROM orders o
    LEFT JOIN delivery_tasks d ON d.order_id = o.id
    WHERE o.batch_id=? AND o.status IN (2,3,4)`).get(batchId)
  const total = Number(stats && stats.total || 0)
  const done = Number(stats && stats.done || 0)
  if (total > 0 && done >= total) {
    store.prepare("UPDATE delivery_batches SET status=3, status_text='已完成', picked_orders=?, completed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
      .run(done, batchId)
  }
}

// 平台任务状态变化联动批次（由 platform.applyStatus 调用）
function onTaskStatus(store, task, status) {
  if (!task || !task.batch_id) return
  const order = store.prepare('SELECT * FROM orders WHERE id=?').get(task.order_id)
  if (!order) return
  if (Number(status) === 80) {
    // 任务完成(80) ≠ 用户已取走：只有用户真正「关舱取走」（pickup-close 置了 picked_up_at）才算已取、
    // 计入批次完成。平台 40s 自动关舱流转的 80 不在此列 —— 未取餐订单保持已送达(3)，由取餐超时扫描处理。
    // 取走本身（picked_up_at + status=4）由 order 域收口（markOrderPicked/fulfillOrder），这里只补批次计数。
    if (order.picked_up_at) countPicked(store, order)
  } else if (Number(status) === 110 || Number(status) === 150) {
    // 任务取消/关闭：订单已由 applyStatus 置为已取消；批次计数校正
    if (Number(order.status) === 5) removeOrderFromBatch(store, order)
  }
}

// ---------- 路径规划（多地点配送顺序，最小化顾客总等待） ----------
// 分组：同一楼栋多单合并为一站（客观上就是同一个位置，分开停毫无意义）。
// 排序：单数加权最近邻，见 v2OrderStops。
// v2 相对旧实现多一条：**停靠顺序自带「每趟 ≤ maxTripMin」的截断** ——
//   先按加权最近邻排出候选顺序，再逐步试算「加上这一站的预计分钟数」，
//   一旦超上限就停手，把剩下的站留给下一趟。这就是"每趟 ≤15 分钟"真正生效的地方：
//   旧实现只在组批时用它当并单门槛，停靠顺序里完全没有这层约束，
//   结果可能出现「组批时算的是 3 站 14 分钟、实际排出来绕成 18 分钟」。
function planRouteV2(store, orders, _ctx) {
  const loading = loadingPointOf(store)
  const groups = new Map()
  for (const o of orders) {
    const lid = String(o.landmark_id || '')
    if (!lid) continue
    if (!groups.has(lid)) {
      const lm = store.prepare('SELECT * FROM landmarks WHERE id=?').get(lid) || null
      // 名称清洗：脏点位名（含 ? 占位符）优先以 landmarks 表为准，再回退订单名/未知
      groups.set(lid, { landmark: lm, name: landmarkNameOf(store, lid, o.landmark_name), orders: [] })
    }
    groups.get(lid).orders.push(o)
  }
  const arr = [...groups.values()]
  if (!arr.length) return []

  // 无坐标（点位还没同步坐标）：退化为【单数从多到少，同单数按点位 sort】。
  // 这不是"排序"，是"没法排序时的确定性兜底"—— 至少保证多单楼栋先送、结果可复现。
  const hasCoord = arr.some((g) => g.landmark && (Number(g.landmark.pos_x) || Number(g.landmark.pos_y)))
  if (!hasCoord) {
    const byCountThenSort = (a, b) => (b.orders.length - a.orders.length)
      || ((a.landmark ? Number(a.landmark.sort || 99) : 99) - (b.landmark ? Number(b.landmark.sort || 99) : 99))
    arr.sort(byCountThenSort)
    return arr.map((g, i) => ({ stop: i + 1, landmark_id: g.landmark ? g.landmark.id : g.orders[0].landmark_id, landmark_name: g.name, order_ids: g.orders.map((o) => o.id) }))
  }

  const loadingPt = lmPoint(loading)
  const items = arr.reduce((s, g) => s + g.orders.reduce((x, o) => x + orderItemCount(store, o.id), 0), 0)
  const origin = routeOriginPt(loading)
  const ordered = v2OrderStops(origin, arr.map((g) => ({ g, pt: lmPoint(g.landmark), n: g.orders.length || 1 })))

  const route = []
  let dropped = 0
  for (let i = 0; i < ordered.length; i++) {
    const trial = ordered.slice(0, i + 1).map((x) => ({ pt: x.pt, n: x.n }))
    const mins = v2EstimateTripMin(origin, trial, items)
    // 单站兜底：第一个站点无条件收下 —— 否则最远的东苑7栋永远排不进来（与组批硬约束②同一口径）
    if (i > 0 && mins > V2.maxTripMin) { dropped = ordered.length - i; break }
    const st = ordered[i]
    route.push({ stop: route.length + 1, landmark_id: st.g.landmark.id, landmark_name: st.g.name, order_ids: st.g.orders.map((o) => o.id) })
  }
  if (dropped > 0) {
    // 留痕：真出现"这一趟装不下全部站"时，说明组批的硬约束②和实际排线结果不一致，要能查
    console.warn('[batch] 排线截断：' + dropped + ' 站超过每趟 ' + V2.maxTripMin + ' 分钟上限，留给下一趟')
  }
  return route
}

// 路线规划入口：v2 是唯一实现（legacy 已删除）。
function planRoute(store, orders, ctx) {
  return planRouteV2(store, orders, ctx)
}

// ---------- 批次自动定型判定 ----------
// 只有一条规则（v2）：满容立即定型，否则从「第一张订单的下单时间」起算满 BATCH_HOLD_MS 定型。
// 情况1/情况2 的成批时机在下面的 planAutoLock 里，本函数只回答「这一批到点了吗」。

// 批次内「第一张订单的下单时间」—— 计时锚点。
// 只算仍在批次内的有效单（status 1 待接单 / 2 配送中），已取消或已摘除的不计入。
// 取不到订单时间时回落到批次创建时间；两者都不可解析则返回 null（调用方保守处理：当作已到点）。
function firstOrderAt(store, batch) {
  let raw = ''
  try {
    const row = store.prepare(
      'SELECT MIN(created_at) AS first_at FROM orders WHERE batch_id=? AND status IN (1,2)'
    ).get(Number(batch.id))
    raw = (row && row.first_at) || ''
  } catch (e) { raw = '' }
  if (!raw) raw = batch.created_at || ''
  const t = new Date(String(raw).replace(' ', 'T')).getTime()
  return isNaN(t) ? null : t
}

// 定型规则：满容不等待；否则从「第一张订单的下单时间」起算满 BATCH_HOLD_MS 即到点。
function shouldAutoLock(store, batch, items, _ctx) {
  // 满容：不等待，立即成型
  if (Number(items || 0) >= BATCH_MAX_ITEMS) return true
  const anchor = firstOrderAt(store, batch)
  // 锚点不可解析（数据脏）→ 当作已到点直接发：宁可早发，也不能让这张单永远发不出去。
  // 正常情况下走不到这里（created_at 有库默认值）。
  if (anchor === null) return true
  return Date.now() >= anchor + BATCH_HOLD_MS
}

// ---------- 成批时机层：情况1 / 情况2 / 情况3 ----------
// 未定型批次数 = 只数「组单中」（status=0）。
// 已定型待上货（status=1）【不算】—— 它已经锁定了（虽然还能加单，但不再占用"等车"的名额）。
// 这条口径定死之后，"锁定会让未定型数不降反升"的自激就不存在了。
function openBatchCount(store) {
  const r = store.prepare('SELECT COUNT(*) c FROM delivery_batches WHERE status = 0').get()
  return Number((r && r.c) || 0)
}

// 迟滞：情况切换不因为一次抖动就跳，要连续稳定 BATCH_HYSTERESIS_MS 才切。
// 就像空调不会在 25.9° 和 26.1° 之间疯狂开关机。
const _situation = { current: 1, pending: 0, pendingSince: 0 }
function resetSituation() { _situation.current = 1; _situation.pending = 0; _situation.pendingSince = 0 }

// 情况判定（纯函数）：待发批次数 vs 可用车数。
//   1 = 排得下：待发 ≤ 可用车 → 车够，各自到自己那个窗口点就走。
//   2 = 略紧：待发 > 可用车，但还没到 K 倍 → 仍按窗口成批锁，窗口长度不变。
//   3 = 明显积压：待发 ≥ K × 可用车 → 成批锁，且把攒单窗口缩短（见 batchHoldMs）。
// 可用车 = 0 时一律回情况1（继续攒单）：车全在外面跑，锁了也派不出去，只会把批次切得更碎。
function situationOf(openCount, available) {
  const avail = Number(available || 0)
  if (avail < 1) return 1
  const n = Number(openCount || 0)
  if (n <= avail) return 1
  return n >= BATCH_PRESSURE_K * avail ? 3 : 2
}
// 对外只暴露"是不是成批锁"（情况 2/3 都要成批锁），迟滞也挂在它上面，
// 这样 2↔3 之间因为压力比小幅波动来回跳时不会重置迟滞计时。
function isBatchLockSituation(sit) { return Number(sit) >= 2 }

function currentSituation() { return _situation.current }
function stabilizeSituation(raw, now) {
  if (raw === _situation.current) { _situation.pending = 0; return _situation.current }
  if (_situation.pending !== raw) { _situation.pending = raw; _situation.pendingSince = now }
  // 连续稳定满 hysteresisMs 才真的切（hysteresisMs=0 时立即切，便于测试或直接关掉迟滞）
  if (now - _situation.pendingSince >= V2.hysteresisMs) { _situation.current = raw; _situation.pending = 0 }
  return _situation.current
}

// 本轮该锁定哪些批次。返回【有序】batchId 数组，顺序 = 派车优先级：
// 第一张订单最早的先走（车不够时只发得出去前面几个）。
//
// 情况1（待发 ≤ 可用车）：车够 → 各自到自己那个窗口点才锁。
// 情况2/3（待发 > 可用车）：车不够 → 按窗口成批锁：
//   窗口起点 t0 = 当前最早那张「第一张订单」的下单时间，窗口 = [t0, t0+holdMs)；
//   等窗口起点那个批次到点时，把窗口内所有批次一起锁（含还没到自己那个点的）。
//   锁完它们就离开「组单中」，下一轮扫描自然从剩下的最早批次重新起一个窗口 —— 这就是"递归循环"。
//   也正因为被锁的批次会离开「组单中」，扫多少次都不会重复锁同一批（天然幂等）。
//
// 前提：成批锁要求【至少 1 台可用车】。可用车 = 0 说明车全在外面跑，
//   这时候锁了也派不出去，只会让每一单都自成一个小批次 → 退回情况1，继续攒单。
//
// ctx.cars = { total, available, occupied }，由 timers.js 查平台后传入（batch.js 不碰平台）。
function planAutoLock(store, ctx) {
  const now = Date.now()
  const cars = (ctx && ctx.cars) || null
  const available = cars ? Number(cars.available || 0) : 0

  const list = []
  for (const b of store.prepare('SELECT * FROM delivery_batches WHERE status = 0 ORDER BY id ASC').all()) {
    const cnt = store.prepare(`
      SELECT COUNT(DISTINCT o.id) c, IFNULL(SUM(oi.quantity),0) items
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id=? AND o.status IN (1,2)`).get(b.id)
    if (Number((cnt && cnt.c) || 0) <= 0) continue // 空批次不管
    list.push({ id: Number(b.id), items: Number((cnt && cnt.items) || 0), anchor: firstOrderAt(store, b) })
  }
  if (!list.length) return []

  // 优先级：第一张订单最早的先走；拿不到时间的排最后，同时间按批次 id
  const key = (x) => (x.anchor === null ? Infinity : x.anchor)
  list.sort((x, y) => (key(x) - key(y)) || (x.id - y.id))

  // 窗口长度由【压力】决定：待发越多、车越少，攒单窗口越短。整轮共用一个窗口长度，
  // 不能每批各算各的 —— 否则同一轮里前面的批次用长窗口、后面的用短窗口，锁定顺序会自相矛盾。
  const openCount = openBatchCount(store)
  const holdMs = batchHoldMs(openCount, available, now)
  // 到点判定用本轮实际窗口（不是常量）：缩短窗口时"到点"要跟着提前，否则缩短形同虚设。
  for (const x of list) x.due = x.anchor === null || now >= x.anchor + holdMs

  // 满容的无论什么情况都立即锁（不等待）
  const full = list.filter((x) => x.items >= BATCH_MAX_ITEMS)
  const rest = list.filter((x) => x.items < BATCH_MAX_ITEMS)
  const due = rest.filter((x) => x.due)

  // 情况判定（带迟滞）。可用车 0 台 → 强制情况1，继续攒单。
  const raw = situationOf(openCount, available)
  const situation = available >= 1 ? stabilizeSituation(raw, now) : 1

  const chosen = new Set(full.map((x) => x.id))
  // 到点的一律发 —— 这是「窗口到点必走」的底线，情况1/2/3 都一样。
  // 必须单独兜住：到点的批次未必落在同一个窗口里（比如已经等了 40 分钟的那批，
  // 它的锚点远早于当前窗口起点），只靠窗口选择会把它漏掉 → 饿死。
  for (const x of due) chosen.add(x.id)
  if (isBatchLockSituation(situation)) {
    // 车不够：把窗口内「还没到点」的批次也一起带走
    const anchorBase = (due.find((x) => x.anchor !== null) || {}).anchor
    if (anchorBase !== null && anchorBase !== undefined) {
      const winEnd = anchorBase + holdMs
      for (const x of rest) {
        if (x.anchor === null) continue // anchor 为 null 的已经在 due 里了
        if (x.anchor >= anchorBase && x.anchor < winEnd) chosen.add(x.id)
      }
    }
  }
  // 硬上限兜底：等太久的无条件发。防止"窗口一直卡在某一段"把后面的批次饿死。
  for (const x of rest) {
    if (x.anchor !== null && now - x.anchor > V2.hardMaxMs) chosen.add(x.id)
  }
  return list.filter((x) => chosen.has(x.id)).map((x) => x.id)
}

// ---------- 全局不变量自检（收口）----------
// 把「不该出现的情况」变成可自动检查的断言，跑一遍就知道有没有问题。
// 分两类：
//   结构不变量 —— 每个批次都该满足：件数 ≤12、每趟时长 ≤15分、站点 ≥1
//                 （status 0 组单中 与 status 1 已定型未装货 都要查 —— status 1 仍可加单，
//                   2026-10-14 起这是有意行为，所以它的容量约束同样必须成立）
//   活性不变量 —— 每张没送完的订单最终一定发得出去（防死锁）
// 返回 { ok, violations: [{ type, detail, ref }], checked_at }
// 注意：批次数量级很小（同时最多几十个），这里用逐批查询换可读性，不做批量优化。
function checkInvariants(store) {
  const v = []
  const add = (type, detail, ref) => v.push({ type, detail, ref: ref || '' })
  const now = Date.now()

  // ---- 结构不变量：还会变动内容的批次（组单中 + 已定型未装货）----
  const loading = loadingPointOf(store)
  const loadingPt = lmPoint(loading)
  const openBatches = store.prepare(`
    SELECT * FROM delivery_batches
    WHERE status IN (0,1) AND bin_opened_at IS NULL AND loaded_at IS NULL`).all()
  for (const b of openBatches) {
    const cnt = store.prepare(`
      SELECT COUNT(DISTINCT o.id) c, IFNULL(SUM(oi.quantity),0) items
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id=? AND o.status IN (1,2)`).get(b.id)
    const n = Number((cnt && cnt.c) || 0)
    const items = Number((cnt && cnt.items) || 0)
    // 已定型(1)的批次空了不算错（商家可能把单转走），组单中(0)空了要回收
    if (n <= 0) {
      if (Number(b.status) === 0) add('EMPTY_BATCH', `组单中批次 ${b.batch_no || '#' + b.id} 没有任何有效订单`, 'batch#' + b.id)
      continue
    }
    if (items > BATCH_MAX_ITEMS) {
      add('OVER_CAPACITY', `批次 ${b.batch_no || '#' + b.id} 装了 ${items} 件，超过上限 ${BATCH_MAX_ITEMS}`, 'batch#' + b.id)
    }
    const lms = store.prepare('SELECT DISTINCT landmark_id FROM orders WHERE batch_id=? AND status IN (1,2)').all(b.id)
    if (lms.length <= 0) { add('NO_STOP', `批次 ${b.batch_no || '#' + b.id} 有订单但算不出站点`, 'batch#' + b.id); continue }
    if (lms.length > 1) {
      // 单站例外：只有一个楼栋时不受时长上限约束（否则最远的东苑7栋永远发不出去）
      const stops = lms.map((r) => ({ pt: landmarkPointOf(store, r.landmark_id), n: 1 }))
      const mins = v2EstimateTripMin(loadingPt, stops, items)
      if (mins > V2.maxTripMin) {
        add('OVER_TRIP', `批次 ${b.batch_no || '#' + b.id} 有 ${lms.length} 站，预计 ${mins.toFixed(1)} 分钟 > 上限 ${V2.maxTripMin} 分钟`, 'batch#' + b.id)
      }
    }
  }

  // ---- 活性不变量：没送完的订单最终必须发得出去 ----
  const pending = store.prepare(`
    SELECT o.id, o.order_no, o.batch_id, o.created_at,
           b.status AS bstatus, b.batch_no AS bno
    FROM orders o LEFT JOIN delivery_batches b ON b.id = o.batch_id
    WHERE o.status IN (1,2)`).all()
  for (const o of pending) {
    const label = o.order_no || ('#' + o.id)
    if (o.batch_id === null || o.batch_id === undefined) {
      add('ORDER_NO_BATCH', `订单 ${label} 还没送完，却没挂到任何批次上`, 'order#' + o.id); continue
    }
    if (o.bstatus === null || o.bstatus === undefined) {
      add('ORDER_BATCH_MISSING', `订单 ${label} 挂的批次 #${o.batch_id} 不存在`, 'order#' + o.id); continue
    }
    const bs = Number(o.bstatus)
    if (bs !== 0 && bs !== 1 && bs !== 2) {
      add('ORDER_ORPHAN', `订单 ${label} 还没送完，但它所在的批次 ${o.bno || '#' + o.batch_id} 已经是「${BATCH_STATUS[bs] || bs}」`, 'order#' + o.id); continue
    }
    if (bs === 0) {
      const t = parseTime(o.created_at)
      if (t !== null && now - t > V2.hardMaxMs) {
        const waited = ((now - t) / 60000).toFixed(1)
        add('ORDER_STUCK', `订单 ${label} 在组单中批次 ${o.bno || '#' + o.batch_id} 里等了 ${waited} 分钟还没发出（硬上限 ${(V2.hardMaxMs / 60000).toFixed(0)} 分钟）`, 'order#' + o.id)
      }
    }
  }

  return { ok: v.length === 0, violations: v, checked_at: new Date().toISOString() }
}
// 批次详情（含订单、商品明细与路线），供商家/用户端展示
function getBatchDetail(store, batchId) {
  const b = getBatch(store, batchId)
  if (!b) return null
  const orders = store.prepare('SELECT * FROM orders WHERE batch_id=? ORDER BY id ASC').all(batchId).map((o) => {
    const t = o.delivery_task_id ? store.prepare('SELECT * FROM delivery_tasks WHERE id=?').get(o.delivery_task_id) : null
    // 订单商品明细：上货操作页需逐单逐商品展示（一行一个商品）
    const items = store.prepare('SELECT id, goods_id, goods_name, goods_image, price, quantity FROM order_items WHERE order_id=?').all(o.id)
    // 点位名清洗：脏数据（??1?）以 landmarks 表为准回退
    const lmName = landmarkNameOf(store, o.landmark_id, o.landmark_name)
    return {
      id: o.id, order_no: o.order_no, status: o.status, status_text: statusText(o.status),
      daily_seq: Number(o.daily_seq || o.id),
      code_short: seqSvc.orderShortOf(o.seq_date, o.created_at, o.daily_seq || o.id),
      landmark_id: o.landmark_id, landmark_name: lmName,
      contact_name: o.contact_name, contact_phone: maskPhone(o.contact_phone),
      pickup_code: o.pickup_code, total_amount: o.total_amount,
      created_at: o.created_at,
      picked_up: !!o.picked_up_at,
      items,
      task: t ? { id: t.id, platform_task_id: t.platform_task_id, device_sn: t.device_sn, task_status: t.task_status, status_text: t.status_text, recall_status: Number(t.recall_status || 0), recall_error: t.recall_error || '' } : null
    }
  })
  let route = []
  try { route = JSON.parse(b.route || '[]') } catch (e) { route = [] }
  // 已取餐数以实际订单 picked_up_at 动态统计（与展示自洽，避免计数器漂移）
  const picked = orders.filter((o) => o.picked_up).length
  const distinctLandmarks = [...new Set(orders.map((o) => o.landmark_name).filter(Boolean))]
  // 路线文本：剔除脏点位名，缺失时回退到订单点位/未知
  const cleanStops = route
    .map((r) => ({ ...r, landmark_name: cleanName(r.landmark_name) || landmarkNameOf(store, r.landmark_id, orders.find((o) => String(o.landmark_id) === String(r.landmark_id)) && orders.find((o) => String(o.landmark_id) === String(r.landmark_id)).landmark_name) || '未知点位' }))
    .filter((r) => r.landmark_name && r.landmark_name !== '未知点位')
  const routeText = cleanStops.length ? cleanStops.map((r) => r.landmark_name).join(' → ') : (distinctLandmarks.join('、') || '')
  const totalItems = orders.reduce((s, o) => s + (o.items || []).reduce((x, it) => x + Number(it.quantity || 0), 0), 0)
  return {
    id: b.id, batch_no: b.batch_no, status: b.status, status_text: b.status_text || statusText(b.status),
    daily_seq: Number(b.daily_seq || b.id),
    code_short: seqSvc.batchShortOf(b.seq_date, b.created_at, b.daily_seq || b.id),
    device_sn: b.device_sn, total_orders: orders.length, total_items: totalItems, picked_orders: picked,
    delivery_mode: b.delivery_mode || '', current_stop: Number(b.current_stop || 0),
    loaded_at: b.loaded_at || '', ready_dispatch: !!(Number(b.status) === 1 && b.loaded_at),
    // 舱门已开（open-bin 落库、close-bin 清空）：上货页据此判断该显示「放货中」还是重新开舱。
    // 开舱已自动化，不能靠配送任务状态推断 —— 演示档不推进任务状态，真机档回调也可能延迟。
    bin_opened: !!b.bin_opened_at,
    created_at: b.created_at, dispatched_at: b.dispatched_at, completed_at: b.completed_at,
    route: cleanStops, route_text: routeText, route_stops_text: distinctLandmarks.join('、'),
    orders
  }
}

// ---------- 提前提醒：车现在开到哪了 / 我这一单还有多久到 ----------
// 目的：让用户提前下楼。原先用户只看到「配送中」三个字，无从判断该不该动身，
// 结果车到了、人还在楼上，每站白等 V2.stopWaitSec（70 秒），一路往后拖累后面的站。
// 提前 BATCH_ADVANCE_STOPS 站开始提示，把用户下楼反应时间从约 100 秒压到约 40 秒。
const ADVANCE_STOPS = Math.max(1, Number(process.env.BATCH_ADVANCE_STOPS || 2))

// 批次路线的规范形态：[{ stop, landmark_id, pt:{x,y}|null, n:该站单数 }]
// 直接读 batch.route（planRoute 已排好序），这个顺序就是车实际走的顺序，这里绝不重排 ——
// 用户看到的「还有 N 站」必须和车真实的行进顺序一致。
// route 为空时（老数据 / 演示档订单被 mock 自动送达）按 landmark_id 回退分组，顺序取点位 sort。
function batchStopsOf(store, batch) {
  let raw = []
  try { raw = JSON.parse(batch.route || '[]') } catch (e) { raw = [] }
  if (!Array.isArray(raw)) raw = []
  let stops = raw.map((r, i) => ({
    stop: Number(r.stop || i + 1),
    landmark_id: String(r.landmark_id || ''),
    pt: landmarkPointOf(store, r.landmark_id),
    n: Array.isArray(r.order_ids) ? Math.max(1, r.order_ids.length) : 1
  }))
  if (!stops.length) {
    const rows = store.prepare(`
      SELECT o.landmark_id AS lid, COUNT(*) AS n, MIN(l.sort) AS srt
      FROM orders o LEFT JOIN landmarks l ON l.id = o.landmark_id
      WHERE o.batch_id = ? AND o.landmark_id IS NOT NULL AND o.landmark_id != ''
      GROUP BY o.landmark_id ORDER BY srt, o.landmark_id`).all(batch.id)
    stops = rows.map((r, i) => ({
      stop: i + 1, landmark_id: String(r.lid || ''), pt: landmarkPointOf(store, r.lid), n: Number(r.n || 1)
    }))
  }
  return stops
}

// 车当前在第几站（1-based；0 = 还没出发）。
// 取该批次所有任务里「已进入配送阶段」（状态 60 去往取货点 ~ 89）的【最大】站号：
// 前面的站任务停在 70(已到达)/80(完成)，取最小会永远卡在第 1 站，所以必须取最大。
function batchCurrentStop(store, batchId, stops) {
  const idx = new Map(stops.map((s, i) => [s.landmark_id, i + 1]))
  let cur = 0
  const rows = store.prepare(`
    SELECT t.task_status AS st, o.landmark_id AS lid
    FROM delivery_tasks t JOIN orders o ON o.id = t.order_id
    WHERE o.batch_id = ? AND t.void_at IS NULL`).all(batchId)
  for (const r of rows) {
    const st = Number(r.st || 0)
    if (st < 60 || st >= 90) continue
    const s = idx.get(String(r.lid || ''))
    if (s && s > cur) cur = s
  }
  return cur
}

// 从「车现在的位置」走到第 toStop 站的预计分钟数。
// 不含上货时间（V2.loadingSec）—— 那是出发前的事，用户等的是这段。
// 口径与 v2EstimateTripMin 一致：路网距离 ÷ 车速 + 中途每站(停靠+等用户) + 中途每单开舱。
function remainingEtaMin(loadingPt, stops, fromStop, toStop) {
  const from = Math.max(0, Number(fromStop) || 0)
  const to = Math.max(1, Number(toStop) || 1)
  let cur = from >= 1 ? (stops[from - 1] || {}).pt : loadingPt
  let dist = 0
  for (let i = from; i <= to - 1; i++) {           // stops 下标 = 站号 - 1；含我这站那一段
    const p = (stops[i] || {}).pt
    if (cur && p) dist += Math.sqrt(Math.pow(cur.x - p.x, 2) + Math.pow(cur.y - p.y, 2)) * V2.detour
    if (p) cur = p
  }
  let dwellSec = 0
  for (let i = from; i <= to - 2; i++) {           // 严格在我这站【之前】的中途站
    dwellSec += V2.stopServiceSec + V2.stopWaitSec + Number((stops[i] || {}).n || 0) * V2.perOrderOpenSec
  }
  return dist / Math.max(1, V2.speedMpm) + dwellSec / 60
}

// 给一张订单算出「提前提醒」所需的全部信息。纯读、无副作用 —— 追踪页每 3 秒轮询调一次也很轻。
// 返回 state：none(无批次) / waiting(还没出发) / approaching(在路上) / arriving(已到本楼) / done(已结束)
function orderAhead(store, order) {
  const blank = {
    state: 'none', stops_ahead: null, eta_min: null, total_stops: null,
    current_stop: null, my_stop: null, prepare: false, text: ''
  }
  if (!order || !order.batch_id) return blank
  const b = store.prepare('SELECT * FROM delivery_batches WHERE id=?').get(order.batch_id)
  if (!b) return blank
  const st = Number(b.status)
  if (st === 3) return Object.assign({}, blank, { state: 'done' })
  if (st === 4) return blank
  if (st === 0) return Object.assign({}, blank, { state: 'waiting', text: '商家已接单，正在组车' })
  if (st === 1) return Object.assign({}, blank, { state: 'waiting', text: '机器人正在上货，马上出发' })

  const stops = batchStopsOf(store, b)
  if (!stops.length) return Object.assign({}, blank, { state: 'waiting', text: '机器人正在上货，马上出发' })
  const my = stops.findIndex((s) => s.landmark_id === String(order.landmark_id || '')) + 1
  if (!my) return Object.assign({}, blank, { state: 'waiting', total_stops: stops.length })

  const cur = batchCurrentStop(store, b.id, stops)
  const ahead = Math.max(0, my - cur)
  const loading = loadingPointOf(store)
  const eta = remainingEtaMin(lmPoint(loading), stops, cur, my)
  const mins = Math.max(1, Math.round(eta))
  const out = {
    state: ahead <= 0 ? 'arriving' : 'approaching',
    stops_ahead: ahead,
    eta_min: Math.round(eta * 10) / 10,
    total_stops: stops.length,
    current_stop: cur,
    my_stop: my,
    prepare: ahead <= ADVANCE_STOPS,
    text: ''
  }
  if (ahead <= 0) out.text = '机器人已到达您楼下，请尽快取餐'
  else if (ahead === 1) out.text = '机器人还有 1 站到您楼下，约 ' + mins + ' 分钟，请准备下楼'
  else out.text = '机器人还有 ' + ahead + ' 站到您楼下，约 ' + mins + ' 分钟，请提前下楼等候'
  return out
}

module.exports = {
  BATCH_STATUS, BATCH_MAX_ORDERS, BATCH_MAX_ITEMS, statusText, cleanName, landmarkNameOf,
  orderItemCount, getBatch, getOrCreateOpenBatch, addOrderToBatch, removeOrderFromBatch,
  countPicked, maybeCompleteBatch, onTaskStatus, planRoute, getBatchDetail,
  registerSummonAdvance,
  // 组单算法：v2 是唯一实现（legacy 已于 2026-10-14 删除，见文件头注释）。
  // 时机层对外只有 planAutoLock（本轮该锁哪些批）+ shouldAutoLock（单批到点了吗，兜底路径）。
  shouldAutoLock, firstOrderAt, BATCH_HOLD_MS, batchHoldMs, BATCH_PRESSURE_K,
  planAutoLock, openBatchCount, situationOf, isBatchLockSituation, resetSituation, currentSituation,
  checkInvariants,
  // 提前提醒（用户端追踪页轮询读取）
  orderAhead, ADVANCE_STOPS, batchStopsOf, batchCurrentStop, remainingEtaMin,
  loadingPointOf,
  // v2 组批（纯函数层单独导出，便于单测与重放）
  V2, v2EstimateTripMin, v2ScoreCandidate, v2RouteDistanceM, v2OrderStops, v2PathDistanceM,
  v2DistM, lmPoint, parseTime,
  openBatchCandidates, landmarkPointOf, bestFitOpenBatch, createOpenBatchV2,
  getOrCreateOpenBatchV2, planRouteV2,
  // 调试用：把模块级常量暴露给探针，避免"到底是哪个权重生效"靠猜（仅探针使用）
  __debugRouteWeight: () => ROUTE_COUNT_WEIGHT
}
