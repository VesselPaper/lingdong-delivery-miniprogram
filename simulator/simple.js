'use strict'
// ============================================================================
// 人话版：一次只回答一个问题 ——「我这组设置跑下来，好还是不好？」
//
//   双击 简单版.bat，或者：
//     node simple.js                       交互式（一路回车 = 用默认值）
//     node simple.js 15 2 271 8 30         锁定分钟 车数 订单数 小时数 承诺分钟
//
// 只用人话输出：不发大表、不讲策略、不绕。
// 想深挖再回去用 run.js。
// ============================================================================

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  你可以直接改这里的数字（改完重跑即可）                                  ║
// ╚══════════════════════════════════════════════════════════════════════╝
const 设定 = {
  锁定时间分钟: 15,        // 等多久才发车（你规则里的 15 分钟）
  无人车数量: 2,           // 有几辆车
  订单量: 271,             // 这段时间一共多少单
  时长小时: 8,             // 收单持续多少小时
  承诺送达分钟: 30,        // 用户端看到的"多久送到"

  // 判定"好/不好"的门槛（改这里就能改判定标准）
  最多允许超时单: 0,       // 超过承诺的单数上限
  最少余量倍数: 1.2,       // 车队至少还要剩多少余量（1.2 = 还能多吃 20%）
  平均等待上限分钟: 15,    // 平均每单等多久
  安全缓冲分钟: 5,         // 最长等待离承诺至少留多少余量
                           // （最长等待的实际上限 = 承诺送达分钟 − 安全缓冲分钟）

  // 一趟配送的耗时（秒）—— 最影响结果的一组数字，建议用真实日志校准
  上货秒: 120,
  站间行驶秒: 90,
  每站服务秒: 60,

  随机种子: 20261001,
  复跑次数: 5              // 换几组订单流验证稳定性
}
// ╔══════════════════════════════════════════════════════════════════════╝

const readline = require('readline')
const { BASE, LANDMARKS } = require('./lib/config')
const { generateArrivals } = require('./lib/generate')
const { simulate } = require('./lib/engine')
const { makeStrategy } = require('./lib/strategies')
const { computeMetrics, pad } = require('./lib/report')

const 默认窗口表 = [1, 3, 5, 8, 12, 15, 20]

// ---------- 跑一次 ----------
function 造配置(a, rate) {
  return Object.assign({}, BASE, {
    scenario: '人话版',
    hours: a.时长小时,
    cars: a.无人车数量,
    promiseMin: a.承诺送达分钟,
    windowMin: a.锁定时间分钟,
    ratePerHour: rate,
    peaks: [],
    tickSec: 5,
    tailMin: 180,
    useCoords: false,
    lockNeedsCar: false,
    timerMode: 'window',
    countMode: 'openOnly',
    carMode: 'static',
    loadingSec: a.上货秒,
    perStopTravelSec: a.站间行驶秒,
    stopServiceSec: a.每站服务秒,
    itemsDist: BASE.itemsDist.map((x) => x.slice()),
    landmarkWeights: BASE.landmarkWeights.slice(),
    compare: ['theirs'],
    landmarks: LANDMARKS.map((l) => Object.assign({}, l))
  })
}

// 订单流是概率生成的，这里微调到达率，让实际订单量贴近你填的数字
function 校准订单流(a, seed) {
  let rate = a.订单量 / a.时长小时
  let arrivals = []
  for (let i = 0; i < 6; i++) {
    const cfg = 造配置(a, rate)
    cfg.seed = seed
    arrivals = generateArrivals(cfg)
    if (Math.abs(arrivals.length - a.订单量) <= Math.max(1, a.订单量 * 0.004)) break
    rate = rate * (a.订单量 / Math.max(1, arrivals.length))
  }
  return { rate, arrivals }
}

function 跑(a, windowMin, arrivals, seed, 策略名, rate) {
  const cfg = 造配置(Object.assign({}, a, { 锁定时间分钟: windowMin }), rate === undefined ? a.订单量 / a.时长小时 : rate)
  cfg.seed = seed
  cfg.compare = [策略名 || 'theirs']
  // 订单流固定用校准好的那一串，保证只有窗口在变
  const res = simulate(cfg, arrivals, makeStrategy(cfg.compare[0]))
  return Object.assign({ strategy: { name: cfg.compare[0] } }, res)
}

// ---------- 小工具 ----------
function 时长(分) {
  if (!isFinite(分)) return '—'
  if (分 >= 60) return Math.floor(分 / 60) + ' 小时 ' + Math.round(分 % 60) + ' 分'
  return 分.toFixed(1) + ' 分钟'
}
function 标(条件) { return 条件 ? '✓' : '✗' }
function 行(名, 值, 备注) {
  const 宽 = 26
  let n = 0
  for (const c of 名) n += c.codePointAt(0) > 0x2e80 ? 2 : 1
  const pad = ' '.repeat(Math.max(0, 宽 - n))
  return '  ' + 名 + pad + String(值) + (备注 ? '   ' + 备注 : '')
}
function 标题(t) {
  return '\n' + '═'.repeat(66) + '\n ' + t + '\n' + '═'.repeat(66)
}

// ---------- 判定 ----------
function 判定(m, a) {
  const 余量 = m.utilization > 0 ? 1 / m.utilization : Infinity
  const 最长等待上限 = a.承诺送达分钟 - a.安全缓冲分钟
  const 条 = [
    { 名: '有单超过承诺', 标准: '最多 ' + a.最多允许超时单 + ' 单', 过: m.overdue <= a.最多允许超时单, 实: m.overdue + ' 单' },
    { 名: '最长等待', 标准: '不超过 ' + 最长等待上限 + ' 分钟（承诺 ' + a.承诺送达分钟 + ' − 缓冲 ' + a.安全缓冲分钟 + '）', 过: m.waitMax <= 最长等待上限, 实: m.waitMax.toFixed(1) + ' 分钟' },
    { 名: '车队余量', 标准: '至少 ' + a.最少余量倍数 + ' 倍', 过: 余量 >= a.最少余量倍数, 实: 余量 === Infinity ? '∞' : 余量.toFixed(1) + ' 倍' },
    { 名: '平均等待', 标准: '不超过 ' + a.平均等待上限分钟 + ' 分钟', 过: m.waitMean <= a.平均等待上限分钟, 实: m.waitMean.toFixed(1) + ' 分钟' }
  ]
  const 没过 = 条.filter((x) => !x.过)
  const 结论 = 没过.length === 0 ? '好' : (没过.length === 1 ? '凑合（有一项没过）' : '不好')
  const 图标 = 没过.length === 0 ? '✅' : (没过.length === 1 ? '⚠️' : '❌')

  const 原因 = []
  if (m.overdue > 0) 原因.push('已经有 ' + m.overdue + ' 单破了「' + a.承诺送达分钟 + ' 分钟送到」的承诺')
  if (m.waitMax > 最长等待上限) 原因.push('最慢的一单等了 ' + m.waitMax.toFixed(1) + ' 分钟，超过承诺留的缓冲（上限 ' + 最长等待上限 + ' 分钟）')
  if (余量 < a.最少余量倍数) 原因.push('车排太满，余量只剩 ' + 余量.toFixed(1) + ' 倍 —— 单量一涨就会崩')
  if (m.waitMean > a.平均等待上限分钟) 原因.push('用户平均要等 ' + m.waitMean.toFixed(1) + ' 分钟，偏久')
  if (没过.length === 0) 原因.push('用户平均等 ' + m.waitMean.toFixed(1) + ' 分钟，' + m.trips + ' 趟发完，车还剩 ' + 余量.toFixed(1) + ' 倍余量')
  return { 条, 没过, 结论, 图标, 原因, 余量 }
}

// ---------- 交互式问数字 ----------
function 问数字() {
  // 用行队列而不是 rl.question：一次性灌进来的多行不会被丢掉（管道/脚本调用也能跑），
  // 并且 stdin 提前结束时用默认值兜底，不会静默挂死。
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const 队列 = []
  let 等待 = null
  rl.on('line', (l) => {
    if (等待) { const w = 等待; 等待 = null; w(l) } else 队列.push(l)
  })
  rl.on('close', () => { if (等待) { const w = 等待; 等待 = null; w('') } })
  const ask = (q, def) => new Promise((res) => {
    process.stdout.write('  ' + q + ' [' + def + ']：')
    const 收 = (l) => {
      const v = String(l).trim()
      res(v === '' || !isFinite(Number(v)) ? def : Number(v))
    }
    if (队列.length) return 收(队列.shift())
    等待 = 收
  })
  return (async () => {
    console.log(标题('先告诉我几个数字（直接回车 = 用括号里的默认值）'))
    const a = Object.assign({}, 设定)
    a.锁定时间分钟 = await ask('等多少分钟才发车', 设定.锁定时间分钟)
    a.无人车数量 = await ask('有几辆车', 设定.无人车数量)
    a.订单量 = await ask('这段时间一共多少单', 设定.订单量)
    a.时长小时 = await ask('收单持续多少小时', 设定.时长小时)
    a.承诺送达分钟 = await ask('跟用户承诺多少分钟送到', 设定.承诺送达分钟)
    console.log('')
    rl.close()
    return a
  })()
}

// ---------- 主流程 ----------
async function main() {
  const argv = process.argv.slice(2)
  let a
  if (argv.length >= 1) {
    a = Object.assign({}, 设定)
    if (argv[0] !== undefined && argv[0] !== '') a.锁定时间分钟 = Number(argv[0])
    if (argv[1] !== undefined) a.无人车数量 = Number(argv[1])
    if (argv[2] !== undefined) a.订单量 = Number(argv[2])
    if (argv[3] !== undefined) a.时长小时 = Number(argv[3])
    if (argv[4] !== undefined) a.承诺送达分钟 = Number(argv[4])
    if (argv[5] !== undefined) a.随机种子 = Number(argv[5])
    for (const k of ['锁定时间分钟', '无人车数量', '订单量', '时长小时', '承诺送达分钟']) {
      if (!isFinite(a[k]) || a[k] <= 0) { console.error('数字不对：' + k + ' = ' + a[k]); process.exit(1) }
    }
  } else {
    a = await 问数字()
  }

  const { rate, arrivals } = 校准订单流(a, a.随机种子)
  const res = 跑(a, a.锁定时间分钟, arrivals, a.随机种子, null, rate)
  const m = computeMetrics(res)
  const 判 = 判定(m, a)

  const 车辆数 = a.无人车数量
  const 楼栋集合 = new Set(arrivals.map((o) => o.lm))
  const 每车趟数 = m.trips / 车辆数
  const 每车在路 = res.state.cars.reduce((s, c) => s + c.busyTotal, 0) / 车辆数
  const 每车栋次 = m.totalStops / 车辆数

  // ============ 一、这次算的是什么 ============
  console.log(标题('一、这次算的是什么'))
  console.log(行('锁定时间（等多久才发车）', a.锁定时间分钟 + ' 分钟'))
  console.log(行('无人车', 车辆数 + ' 辆'))
  console.log(行('订单量', m.orders + ' 单 / ' + m.totalItems + ' 件'))
  console.log(行('收单时长', a.时长小时 + ' 小时'))
  console.log(行('订单来自', 楼栋集合.size + ' 个楼栋'))
  console.log(行('跟用户承诺', a.承诺送达分钟 + ' 分钟送到'))

  // ============ 二、跑完的实际结果 ============
  console.log(标题('二、跑完的实际结果'))
  console.log(行('发车趟数（批次量）', m.trips + ' 趟'))
  console.log(行('一辆车跑了', 每车趟数.toFixed(1) + ' 趟', '（' + m.trips + ' 趟 ÷ ' + 车辆数 + ' 辆车）'))
  console.log(行('一辆车总共在路上', 时长(每车在路), '（占 ' + (m.utilization * 100).toFixed(0) + '% 的时间）'))
  console.log(行('平均一趟装', m.avgItemsPerTrip.toFixed(1) + ' 件', '（上限 12 件）'))
  console.log(行('平均一趟经过', m.avgStopsPerTrip.toFixed(1) + ' 个楼栋'))
  console.log(行('一辆车总共经过', 每车栋次.toFixed(0) + ' 栋次', '（' + m.totalStops + ' 次停靠 ÷ ' + 车辆数 + ' 辆车）'))
  console.log(行('只跑 1 个楼栋的趟数', m.singleStop + ' 趟', '（占 ' + (m.singleStopRatio * 100).toFixed(0) + '%）'))
  console.log(行('从开始到全部送完', 时长(res.finalNow)))
  console.log(行('用户平均等', m.waitMean.toFixed(1) + ' 分钟'))
  console.log(行('用户最长等', m.waitMax.toFixed(1) + ' 分钟'))
  console.log(行('超过 ' + a.承诺送达分钟 + ' 分钟的单', m.overdue + ' 单'))

  // ============ 三、结论 ============
  console.log(标题('三、结论：' + 判.图标 + ' ' + 判.结论))
  console.log('  逐条对照（门槛在 simple.js 顶部「设定」里，你可以自己改）：')
  for (const c of 判.条) {
    console.log('   ' + 标(c.过) + ' ' + c.名 + '：' + c.实 + '（要求' + c.标准 + '）')
  }
  console.log('')
  for (const r of 判.原因) console.log('   → ' + r)

  // ============ 四、换几种订单流复跑（防止被单一随机结果骗） ============
  const 复跑 = []
  for (let i = 0; i < a.复跑次数; i++) {
    const seed = a.随机种子 + i * 137
    const 流 = 校准订单流(a, seed)
    const rr = 跑(a, a.锁定时间分钟, 流.arrivals, seed, null, 流.rate)
    const mm = computeMetrics(rr)
    复跑.push({ 单数: mm.orders, 等待: mm.waitMean, 超时: mm.overdue })
  }
  const 等待们 = 复跑.map((x) => x.等待)
  const 超时们 = 复跑.map((x) => x.超时)
  console.log(标题('四、换个订单流还成立吗？（' + a.复跑次数 + ' 组复跑）'))
  console.log(行('订单量范围', Math.min(...复跑.map((x) => x.单数)) + ' ~ ' + Math.max(...复跑.map((x) => x.单数)) + ' 单'))
  console.log(行('平均等待范围', Math.min(...等待们).toFixed(1) + ' ~ ' + Math.max(...等待们).toFixed(1) + ' 分钟'))
  console.log(行('超时单数范围', Math.min(...超时们) + ' ~ ' + Math.max(...超时们) + ' 单'))
  console.log('  （范围越窄 = 结果越可预期；范围很宽 = 说明这套设置踩在临界点上，随时会崩）')

  // ============ 五、锁定时间该填多少 ============
  const 窗口们 = 默认窗口表.concat([a.锁定时间分钟]).filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => x - y)
  const 扫描 = 窗口们.map((w) => {
    const r = 跑(a, w, arrivals, a.随机种子, null, rate)
    return { w, m: computeMetrics(r) }
  })
  // 推荐规则（三步，明写出来让你能自己改）：
  //   ① 一单都不超时  ② 最长等待离承诺至少留「安全缓冲分钟」  ③ 在上面两条都满足的前提下，挑趟数最少
  const 合格 = 扫描.filter((x) => x.m.overdue === 0 && x.m.waitMax <= a.承诺送达分钟 - a.安全缓冲分钟)
  const 推荐 = (合格.length ? 合格 : 扫描).slice().sort((x, y) => (x.m.trips - y.m.trips) || (x.m.waitMean - y.m.waitMean))[0]
  const 等待最少 = 扫描.slice().sort((x, y) => x.m.waitMean - y.m.waitMean)[0]

  console.log(标题('五、锁定时间填多少最好？（同一批订单，只改这一个数字）'))
  console.log('  ' + pad('锁定时间', 10) + pad('发车趟数', 10, 'right') + pad('平均等', 10, 'right') + pad('最长等', 11, 'right') + pad('超时单', 9, 'right') + pad('只跑1楼栋', 11, 'right'))
  console.log('  ' + '─'.repeat(62))
  for (const x of 扫描) {
    const 你 = x.w === a.锁定时间分钟 ? '  ←你填的' : ''
    const 荐 = x.w === 推荐.w ? '  ★推荐' : ''
    console.log(
      '  ' + pad(x.w + ' 分钟', 10) +
      pad(x.m.trips + ' 趟', 10, 'right') +
      pad(x.m.waitMean.toFixed(1) + ' 分', 10, 'right') +
      pad(x.m.waitMax.toFixed(1) + ' 分', 11, 'right') +
      pad(x.m.overdue + ' 单', 9, 'right') +
      pad((x.m.singleStopRatio * 100).toFixed(0) + '%', 11, 'right') +
      你 + 荐
    )
  }
  console.log('')
  console.log('  趋势：越往右 → 趟数越少（' + 扫描[0].m.trips + ' → ' + 扫描[扫描.length - 1].m.trips + ' 趟），车越省；')
  console.log('        但等待是「先降后升」的，最短在 ' + 等待最少.w + ' 分钟（' + 等待最少.m.waitMean.toFixed(1) + ' 分）。')
  console.log('        原因：窗口太短 → 车被一堆小批次占住，吞吐反而下降；窗口太长 → 单子压在仓里干等。')
  console.log('')
  console.log('  推荐规则（三步）：① 一单都不超时  ② 最长等待离 ' + a.承诺送达分钟 + ' 分钟承诺至少留 ' + a.安全缓冲分钟 + ' 分钟缓冲  ③ 再挑趟数最少')

  if (合格.length === 0) {
    // 所有窗口都不达标 → 瓶颈不是窗口，是运力。这里直接算出至少要几辆车。
    console.log('  ⚠ 没有任何锁定时间能同时满足上面两条 —— 问题不在窗口，在车不够。')
    let 需要车 = null
    for (let c = a.无人车数量 + 1; c <= a.无人车数量 + 5; c++) {
      const aa = Object.assign({}, a, { 无人车数量: c })
      const 行不行 = 窗口们.some((w) => {
        const mm = computeMetrics(跑(aa, w, arrivals, a.随机种子, null, rate))
        return mm.overdue === 0 && mm.waitMax <= a.承诺送达分钟 - a.安全缓冲分钟
      })
      if (行不行) { 需要车 = c; break }
    }
    console.log('  → ' + (需要车
      ? '把车加到 ' + 需要车 + ' 辆，就存在能达标的锁定时间（其余条件不变）'
      : '加到 ' + (a.无人车数量 + 5) + ' 辆还是不行 —— 得从订单量、时长或承诺时间上想办法'))
  } else {
    console.log('  推荐：' + 推荐.w + ' 分钟 → ' + 推荐.m.trips + ' 趟，平均等 ' + 推荐.m.waitMean.toFixed(1) + ' 分钟，最长等 ' + 推荐.m.waitMax.toFixed(1) + ' 分钟，超时 ' + 推荐.m.overdue + ' 单')
  }

  // ============ 六、参考 ============
  const 现有 = computeMetrics(跑(a, a.锁定时间分钟, arrivals, a.随机种子, 'current', rate))
  const 余量文 = (mm) => mm.utilization > 0 ? (1 / mm.utilization).toFixed(1) + ' 倍' : '∞'
  console.log(标题('六、参考：换个做法会怎样'))
  console.log('  ' + pad('你填的 ' + a.锁定时间分钟 + ' 分钟', 26) + '→  ' + m.trips + ' 趟，平均等 ' + m.waitMean.toFixed(1) + ' 分，最长等 ' + m.waitMax.toFixed(1) + ' 分，超时 ' + m.overdue + ' 单，余量 ' + 余量文(m))
  console.log('  ' + pad('90 秒就发车（现有做法）', 26) + '→  ' + 现有.trips + ' 趟，平均等 ' + 现有.waitMean.toFixed(1) + ' 分，最长等 ' + 现有.waitMax.toFixed(1) + ' 分，超时 ' + 现有.overdue + ' 单，余量 ' + 余量文(现有))
  console.log('  ' + pad(推荐.w + ' 分钟（推荐）', 26) + '→  ' + 推荐.m.trips + ' 趟，平均等 ' + 推荐.m.waitMean.toFixed(1) + ' 分，最长等 ' + 推荐.m.waitMax.toFixed(1) + ' 分，超时 ' + 推荐.m.overdue + ' 单，余量 ' + 余量文(推荐.m) + (合格.length === 0 ? '   （仅供参考：这条不达标）' : ''))
  console.log('')
  console.log('  想改数字：直接编辑本文件顶部的「设定」，或运行时带上参数：')
  console.log('    node simple.js ' + a.锁定时间分钟 + ' ' + a.无人车数量 + ' ' + a.订单量 + ' ' + a.时长小时 + ' ' + a.承诺送达分钟 + '      （锁定分钟 车数 订单数 小时数 承诺分钟）')
  console.log('')
}

main().catch((e) => { console.error('出错了：' + e.message); process.exit(1) })
