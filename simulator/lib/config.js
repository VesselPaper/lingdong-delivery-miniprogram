'use strict'
// ============================================================================
// 组单模拟器 · 默认配置、场景预设、命令行解析
//
// 这个目录完全独立：不 require backend/ 下任何文件、不读写真实数据库、
// 不改动任何既有代码。删掉整个 simulator/ 目录即可完全回退。
// ============================================================================

// 9 个送达点（deliverPoint）+ 1 个取货点（loadingPoint），与 backend/data/lingdong.db
// 的 landmarks 表一致（id 1 = 商铺上货，id 2~10 = 东苑各栋）。
//
// ⚠️ x/y 是【示例坐标（虚构，单位米）】，只用于演示你规则 3「楼栋间距更近」的效果。
//    真实库里这 10 个点位的坐标当前全是 (0,0)，规则 3 实际不生效（planRoute 会走
//    「无坐标 → 单数多的先送」的退化分支）。真实坐标请先跑
//    POST /api/merchant/landmarks/sync 从平台同步后，再回填到这里。
const LANDMARKS = [
  { id: 1,  name: '商铺上货', type: 'loadingPoint', sort: 1,  x: 17.57,  y: 6.52 },
  { id: 2,  name: '东苑1栋',  type: 'deliverPoint', sort: 2,  x: -14.15, y: 109.28 },
  { id: 3,  name: '东苑2栋',  type: 'deliverPoint', sort: 3,  x: -14.97, y: 11.04 },
  { id: 4,  name: '东苑3栋',  type: 'deliverPoint', sort: 4,  x: -14.52, y: -69.21 },
  { id: 5,  name: '东苑4栋',  type: 'deliverPoint', sort: 5,  x: -14.91, y: -50.38 },
  { id: 6,  name: '东苑5栋',  type: 'deliverPoint', sort: 6,  x: -14.98, y: 37.81 },
  { id: 7,  name: '东苑7栋',  type: 'deliverPoint', sort: 7,  x: 231.95, y: 59.90 },
  { id: 8,  name: '东苑11栋', type: 'deliverPoint', sort: 8,  x: 146.47, y: -56.38 },
  { id: 9,  name: '东苑12栋', type: 'deliverPoint', sort: 9,  x: 74.75,  y: 24.77 },
  { id: 10, name: '东苑13栋', type: 'deliverPoint', sort: 10, x: 23.40,  y: -107.83 }
]

const BASE = {
  scenario: 'steady',
  hours: 8,              // 收单时长（小时）
  tailMin: 180,          // 收单结束后继续仿真到"全部送完"的最长尾巴
  tickSec: 5,            // 仿真步长（秒）
  seed: 20261001,
  ratePerHour: 36,       // 基础到达率（订单/小时）
  peaks: [],             // [{ startMin, endMin, multiplier }]
  itemsDist: [[1, 0.70], [2, 0.20], [3, 0.10]],  // [件数, 权重]
  landmarkWeights: [0.24, 0.16, 0.12, 0.10, 0.09, 0.08, 0.08, 0.07, 0.06],
  cars: 2,               // 无人车数量（你规则里的"无人车数量"）
  capacity: 12,          // 单批商品件数上限（与 BATCH_MAX_ITEMS 一致）
  windowMin: 15,         // 你规则里的 15 分钟固定窗口
  adaptLow: 3,           // adaptive 策略：低负载时的窗口（分钟）
  adaptHigh: 12,         // adaptive 策略：高负载时的窗口（分钟）
  promiseMin: 30,        // 用户端「尽快送达」= 下单 + 30 分钟（confirm.js asapEta）
  bufferMin: 4,          // deadline 策略的安全缓冲
  minWaitMin: 1.5,       // deadline 策略「车驱动」的最小等待（90 秒，对齐现有 BATCH_WAIT_MS）
  loadingSec: 120,       // 上货装车耗时
  perStopTravelSec: 90,  // 无坐标时：站间行驶耗时
  stopServiceSec: 30,    // 每站固定开销（停稳 + 呼叫 + 开箱准备）；
                         // 原来的 60 秒里"等用户取餐"的部分，现在由下面的用户响应模型负责
  speedMpm: 60,          // 有坐标时：车速（米/分钟）

  // ---- 用户取餐行为（新增）----
  // 机器人到站后，用户不一定马上下来。每家每户的下楼时间不同，机器人只能等有限时间。
  userRespMedianSec: 40, // 用户响应（下楼/走到车边）时长中位数（秒）
  userRespSigma: 0.9,    // 对数正态的 sigma，越大尾巴越长（少数人很慢）
  maxWaitAtStopSec: 180, // 机器人在一个站最多等多久（秒）；等人超过这个数就算没取到，需要二次配送
  openPerOrderSec: 10,   // 每单开箱/取餐的串行耗时（秒）
  etaPriorWaitSec: 70,   // 系统"预测 ETA"时假设的每站等待时长（秒）；真实系统应从历史数据学出来
  maxStopsPerBatch: 0,   // 一个批次最多几个楼栋；0 = 不限（这是"停靠数"约束，当前系统只约束件数）
  sameBuildingMinItems: 0, // 「同楼栋凑够就发」的阈值（件）；批次只含 1 个楼栋且件数达到它就立即发车。0 = 关闭
  maxTripMin: 0,         // 单趟预计时长上限（分钟）；加入某单后预计超过它就放不进去。0 = 不限
  alpha: 0.5,            // planRoute 的单数权重 α
  useCoords: false,      // 默认关闭，与真实库现状（坐标全 0）一致
  rule3: true,           // 有坐标时是否启用你规则 3
  timerMode: 'window',   // theirs：情况2 用滚动窗口(window) 还是按批计时(perOrder)
  countMode: 'openOnly', // theirs 分支口径：未定型 / 未定型+待上货
  carMode: 'static',     // theirs 分支口径：车队总数 / 当前空闲车
  lockNeedsCar: false,   // 定型是否必须有空闲车（真实档 doDispatchBatch 是这样；默认关闭以贴近你的规则文本）
  compare: ['current', 'theirs', 'adaptive', 'deadline'],
  json: false,
  quiet: false
}

const SCENARIOS = {
  steady:     { label: '常态 36 单/时·无峰',              ratePerHour: 36,  peaks: [] },
  lunch:      { label: '午高峰 36 单/时 + 第2~3小时三倍',   ratePerHour: 36,  peaks: [{ startMin: 120, endMin: 180, multiplier: 3 }] },
  offpeak:    { label: '低峰 12 单/时',                    ratePerHour: 12,  peaks: [] },
  lowdensity: { label: '低密度 12 单/时·9栋均匀',           ratePerHour: 12,  peaks: [], landmarkWeights: [1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9] },
  rush:       { label: '极端高峰 120 单/时·2台车',          ratePerHour: 120, peaks: [] }
}

const NUM_KEYS = ['hours', 'tailMin', 'tickSec', 'seed', 'ratePerHour', 'cars', 'capacity',
  'windowMin', 'adaptLow', 'adaptHigh', 'promiseMin', 'bufferMin', 'minWaitMin', 'loadingSec', 'perStopTravelSec',
  'stopServiceSec', 'speedMpm', 'alpha',
  'userRespMedianSec', 'userRespSigma', 'maxWaitAtStopSec', 'openPerOrderSec', 'etaPriorWaitSec', 'maxStopsPerBatch',
  'sameBuildingMinItems', 'maxTripMin']
const BOOL_KEYS = ['useCoords', 'rule3', 'lockNeedsCar', 'json', 'quiet']
const ALIAS = {
  hours: 'hours', tail: 'tailMin', tick: 'tickSec', seed: 'seed', rate: 'ratePerHour',
  cars: 'cars', capacity: 'capacity', window: 'windowMin', adaptlow: 'adaptLow', adapthigh: 'adaptHigh',
  promise: 'promiseMin',
  buffer: 'bufferMin', minwait: 'minWaitMin', loading: 'loadingSec',
  travel: 'perStopTravelSec', stop: 'stopServiceSec', speed: 'speedMpm', alpha: 'alpha',
  maxstops: 'maxStopsPerBatch', maxwait: 'maxWaitAtStopSec', respmedian: 'userRespMedianSec',
  samebldg: 'sameBuildingMinItems', maxtrip: 'maxTripMin',
  respsigma: 'userRespSigma', openper: 'openPerOrderSec', etawait: 'etaPriorWaitSec',
  timer: 'timerMode', count: 'countMode', carmode: 'carMode', scenario: 'scenario',
  strategy: 'strategy', lockneedscar: 'lockNeedsCar', lockneedsCar: 'lockNeedsCar'
}

function resolveConfig(argv) {
  const args = (argv || []).slice(2)

  // 第一遍：只找场景名
  let scenarioName = BASE.scenario
  for (let i = 0; i < args.length; i++) if (args[i] === '--scenario') scenarioName = args[i + 1]
  const sc = SCENARIOS[scenarioName]
  if (!sc) throw new Error('未知场景：' + scenarioName + '（可选：' + Object.keys(SCENARIOS).join(' / ') + '）')

  const cfg = Object.assign({}, BASE, sc, {
    scenario: scenarioName,
    peaks: (sc.peaks || []).map((p) => Object.assign({}, p)),
    itemsDist: BASE.itemsDist.map((x) => x.slice()),
    landmarkWeights: (sc.landmarkWeights || BASE.landmarkWeights).slice(),
    compare: BASE.compare.slice(),
    landmarks: LANDMARKS.map((l) => Object.assign({}, l))
  })

  // 第二遍：命令行覆盖（优先级最高）
  const unknown = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') { cfg.help = true; continue }
    if (a === '--coords') { cfg.useCoords = true; continue }
    if (a === '--no-coords') { cfg.useCoords = false; continue }
    if (a === '--json') { cfg.json = true; continue }
    if (a === '--quiet') { cfg.quiet = true; continue }
    if (!a.startsWith('--')) continue
    const rawKey = a.slice(2)
    const key = ALIAS[rawKey] || rawKey
    if (key === 'coords') { cfg.useCoords = true; continue }
    const val = args[i + 1]
    if (key === 'scenario') { i++; continue } // 已处理
    if (key === 'strategy') {
      i++
      cfg.compare = String(val || '').split(',').map((s) => s.trim()).filter(Boolean)
      continue
    }
    if (NUM_KEYS.indexOf(key) >= 0) {
      i++
      const n = Number(val)
      if (!isFinite(n)) throw new Error('参数 --' + rawKey + ' 需要数值，收到：' + val)
      cfg[key] = n
      continue
    }
    if (BOOL_KEYS.indexOf(key) >= 0) {
      if (val === undefined || String(val).startsWith('--')) { cfg[key] = true }
      else { i++; cfg[key] = !(val === 'false' || val === '0') }
      continue
    }
    if (key === 'timerMode' || key === 'countMode' || key === 'carMode') {
      i++
      cfg[key] = String(val)
      continue
    }
    if (val === undefined || String(val).startsWith('--')) cfg[key] = true
    else { i++; cfg[key] = isNaN(Number(val)) ? val : Number(val) }
    if (!(key in BASE)) unknown.push(rawKey)
  }
  cfg.unknownArgs = unknown

  // 校验
  const validTimer = ['window', 'perOrder']
  if (validTimer.indexOf(cfg.timerMode) < 0) throw new Error('--timer 只能是 window / perOrder')
  if (['openOnly', 'allPending'].indexOf(cfg.countMode) < 0) throw new Error('--count 只能是 openOnly / allPending')
  if (['static', 'idle'].indexOf(cfg.carMode) < 0) throw new Error('--carmode 只能是 static / idle')
  if (cfg.capacity <= 0) throw new Error('容量必须 > 0')

  return cfg
}

module.exports = { LANDMARKS, BASE, SCENARIOS, resolveConfig, NUM_KEYS, BOOL_KEYS, ALIAS }
