'use strict'
// ============================================================================
// 组单模拟器 · 命令行入口
//
//   node simulator/run.js                                  # 默认场景，三种策略对比
//   node simulator/run.js --scenario lunch                 # 午高峰
//   node simulator/run.js --all-scenarios                  # 跑遍所有预设场景
//   node simulator/run.js --strategy theirs --window 15
//   node simulator/run.js --timer perOrder --count allPending --carmode idle
//   node simulator/run.js --coords                          # 打开楼栋坐标（测试规则3）
//   node simulator/run.js --help
// ============================================================================

const { resolveConfig, SCENARIOS } = require('./lib/config')
const { generateArrivals } = require('./lib/generate')
const { simulate } = require('./lib/engine')
const { makeStrategy } = require('./lib/strategies')
const { computeMetrics, renderTable, renderStats, renderEtaByStop, verify } = require('./lib/report')

function help() {
  return [
    '组单模拟器 —— 用同一串订单流对比不同分批策略',
    '',
    '用法（注意当前所在目录，二选一）：',
    '  在项目根目录 lingdong-delivery 下：node simulator/run.js [选项]',
    '  已经 cd 进 simulator 目录：      node run.js [选项]',
    '  或直接双击：                     simulator/启动模拟器.bat',
    '',
    '场景：',
    ...Object.keys(SCENARIOS).map((k) => '  --scenario ' + k.padEnd(11) + SCENARIOS[k].label),
    '  --all-scenarios            依次跑遍上面所有场景',
    '',
    '策略：',
    '  --strategy current,theirs,deadline   要对比的策略（默认三个都跑）',
    '',
    '核心参数（默认值见 lib/config.js）：',
    '  --hours 8         收单时长（小时）        --rate 36      到达率（单/小时）',
    '  --cars 2          无人车数量              --capacity 12  单批件数上限',
    '  --window 15       你规则里的 15 分钟窗口',
    '  --adaptlow 3 --adapthigh 12   adaptive 策略低/高负载窗口',
    '  --promise 30      承诺送达（分钟）',
    '  --timer window|perOrder    情况2 的两种读法（默认 window）',
    '  --count openOnly|allPending 分支口径（默认 openOnly）',
    '  --carmode static|idle      车数口径（默认 static）',
    '  --coords / --no-coords     是否启用楼栋坐标（默认关闭，与真实库现状一致）',
    '  --seed 20261001            随机种子（决定订单流）',
    '  --tick 5                   仿真步长（秒）',
    '  --travel 90 --stop 60 --loading 120   无坐标时的行驶/停站/上货耗时（秒）',
    '  --speed 60                 有坐标时的车速（米/分钟）',
    '  --minwait 1.5              deadline 策略的车驱动最小等待（分钟）',
    '  --buffer 4                 deadline 策略的安全缓冲（分钟）',
    '  --json                     输出 JSON（便于二次处理）',
    '',
    '例：',
    '  node simulator/run.js --all-scenarios',
    '  node simulator/run.js --scenario lunch --timer perOrder --count allPending',
    '  node simulator/run.js --coords --scenario lunch --strategy current,theirs'
  ].join('\n')
}

function argvWithScenario(argv, name) {
  const rest = []
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--scenario') { i++; continue }
    if (argv[i] === '--all-scenarios') continue
    rest.push(argv[i])
  }
  return [argv[0], argv[1], '--scenario', name].concat(rest)
}

function runOne(cfg) {
  const arrivals = generateArrivals(cfg)
  const results = []
  for (const name of cfg.compare) {
    const strategy = makeStrategy(name)
    const res = simulate(cfg, arrivals, strategy)
    const problems = verify(res)
    if (problems.length) {
      console.error('\n❌ 不变量校验失败 [' + name + ']：' + problems.slice(0, 5).join('；') + '\n')
      process.exit(2)
    }
    results.push(Object.assign({ strategy }, res))
  }
  return { arrivals, results }
}

function header(cfg, arrivals) {
  const totalItems = arrivals.reduce((s, a) => s + a.items, 0)
  const peakTxt = (cfg.peaks || []).length
    ? cfg.peaks.map((p) => '第' + (p.startMin / 60) + '~' + (p.endMin / 60) + '小时 ×' + p.multiplier).join('，')
    : '无'
  return [
    '',
    '━━━ 场景：' + cfg.scenario + '（' + (SCENARIOS[cfg.scenario] ? SCENARIOS[cfg.scenario].label : '') + '）━━━',
    '  订单流：' + cfg.hours + ' 小时 / ' + cfg.ratePerHour + ' 单每时 / 峰段 ' + peakTxt +
      ' → ' + arrivals.length + ' 单、' + totalItems + ' 件（种子 ' + cfg.seed + '）',
    '  车队：' + cfg.cars + ' 台   容量：' + cfg.capacity + ' 件/批   承诺送达：' + cfg.promiseMin + ' 分钟',
    '  你的规则：窗口 ' + cfg.windowMin + ' 分钟   情况2读法：' + cfg.timerMode +
      '   分支口径：' + cfg.countMode + ' / ' + cfg.carMode,
    '  路线：' + (cfg.useCoords ? '启用楼栋坐标（规则3 生效，走最近邻+单数加权）' : '无坐标（退化分支：单数多的先送，与真实库现状一致）')
  ].join('\n')
}

function conclusions(results) {
  if (results.length < 2) return ''
  const ms = results.map((r) => ({ name: r.strategy.name, m: computeMetrics(r) }))
  const by = (f) => ms.slice().sort((a, b) => f(a.m) - f(b.m))
  const lines = []
  lines.push('  趟数最少：' + by((m) => m.trips).map((x) => x.name + '(' + x.m.trips + ')').slice(0, 3).join(' < '))
  lines.push('  停靠最少：' + by((m) => m.totalStops).map((x) => x.name + '(' + x.m.totalStops + ')').slice(0, 3).join(' < '))
  lines.push('  等待最短：' + by((m) => m.waitMean).map((x) => x.name + '(' + x.m.waitMean.toFixed(1) + '分)').slice(0, 3).join(' < '))
  lines.push('  超时最少：' + by((m) => m.overdue).map((x) => x.name + '(' + x.m.overdue + ')').slice(0, 3).join(' < '))
  const a = ms.find((x) => x.name === 'current')
  const b = ms.find((x) => x.name === 'theirs')
  if (a && b) {
    const d = (x, y, digits) => ((y - x) >= 0 ? '+' : '') + (y - x).toFixed(digits === undefined ? 1 : digits)
    lines.push('  你的规则 vs 现有实现：趟数 ' + d(a.m.trips, b.m.trips, 0) +
      '，载货率 ' + d(a.m.loadFactor * 100, b.m.loadFactor * 100) + 'pp' +
      '，总停靠 ' + d(a.m.totalStops, b.m.totalStops, 0) +
      '，平均等待 ' + d(a.m.waitMean, b.m.waitMean) + ' 分' +
      '，超时单 ' + d(a.m.overdue, b.m.overdue, 0))
  }
  return '━━━ 结论速览 ━━━\n' + lines.join('\n')
}

function main() {
  const argv = process.argv
  let cfgs
  try {
    if (argv.indexOf('--all-scenarios') >= 0) {
      cfgs = Object.keys(SCENARIOS).map((n) => resolveConfig(argvWithScenario(argv, n)))
    } else {
      cfgs = [resolveConfig(argv)]
    }
  } catch (e) {
    console.error('参数错误：' + e.message + '\n\n' + help())
    process.exit(1)
  }
  if (cfgs[0].help) { console.log(help()); return }
  const unknown = cfgs[0].unknownArgs || []
  if (unknown.length) {
    console.warn('⚠ 未知参数被忽略：' + unknown.map((k) => '--' + k).join('，') + '（用 --help 看可用参数）')
  }

  const jsonOut = []
  for (const cfg of cfgs) {
    const { arrivals, results } = runOne(cfg)
    if (cfg.json) {
      jsonOut.push({
        scenario: cfg.scenario,
        config: { hours: cfg.hours, ratePerHour: cfg.ratePerHour, cars: cfg.cars, capacity: cfg.capacity, windowMin: cfg.windowMin, promiseMin: cfg.promiseMin, timerMode: cfg.timerMode, countMode: cfg.countMode, carMode: cfg.carMode, useCoords: cfg.useCoords, seed: cfg.seed },
        arrivals: arrivals.length,
        strategies: results.map((r) => Object.assign({ name: r.strategy.name }, computeMetrics(r)))
      })
      continue
    }
    if (cfg.quiet) continue
    console.log(header(cfg, arrivals))
    console.log('')
    console.log(renderTable(results).text)
    console.log('')
    const st = renderStats(results)
    if (st) { console.log(st); console.log('') }
    const eta = renderEtaByStop(results)
    if (eta) { console.log(eta); console.log('') }
    console.log(conclusions(results))
  }

  if (jsonOut.length) console.log(JSON.stringify(jsonOut.length === 1 ? jsonOut[0] : jsonOut, null, 2))
  if (!cfgs[0].quiet && !cfgs[0].json) {
    console.log('')
    console.log('提示：--help 看全部参数；换 --seed / --scenario / --rate 可做敏感性测试。')
    console.log('      本目录不读写真实数据库、不引 backend/ 代码，删掉整个 simulator/ 即可回退。')
  }
}

main()
