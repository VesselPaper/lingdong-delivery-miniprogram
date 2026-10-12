// ============================================================================
// 「当前运营图 + 上货点唯一入口」回归测试（services/points.js + syncLandmarks）
// ----------------------------------------------------------------------------
// 为什么要测这个（2026-10-12 真机换图事故）：
//   越凡把运营图换成了「东苑」9 楼（mapId …_1d-9），但旧图「东苑（备份）」（…_1d-1）
//   上的点位记录仍在，而且 building/landmarkInfo 把**备份图的 10 条排在前面**。
//   旧代码按「名称+坐标」去重、先到先得 → 9 栋楼 + 一个商铺上货的 platform_landmark_id
//   永久留在备份图上；各模块又都按 `ORDER BY sort LIMIT 1` 取上货点 →
//   取到备份图 (-0.746, 3.801)，而真实上货点在库房外 (17.168, -3.435)，差 19.3 m。
//   平台每 60s 重同步一次会把这些列全部改写，所以「直接改数据库」留不住，只能改代码。
//
// 这个测试同时钉住四件事：
//   ① 同步时同名同坐标的两条记录，按**当前运营图**（车所在图）择一 → 就地改写成运营图的身份，
//      且**不改 sort**（sort 是取地图锚点的依据，改了会让大屏底图切不回运营图）
//   ② 上货点取值永远返回运营图那条（哪怕备份图那条 sort 更小）
//   ③ 反复同步是幂等的：不会重复插入、不会来回改
//   ④ 取不到运营图（或测试用的极简库没有 meta 表）时，退回旧的「按 sort 第一条」行为
//
// 安全：不起后端、不连任何真实平台 —— PLATFORM_BASE 指向本进程起的**假平台**，
//       端口取随机空闲端口，跑完关服删库。
// 用法：node tests/test_points_active_map.js
// ============================================================================
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) }
  else { fail++; console.log('  ✘ ' + msg) }
}
function eq(got, want, msg) { ok(String(got) === String(want), msg + `（实际 ${got}，期望 ${want}）`) }
function section(t) { console.log('\n=== ' + t + ' ===') }

const M_OLD = '1257237128126592_zcsdb3dd6396c824_1d-1'   // 「东苑（备份）」——旧图
const M_NEW = '1257237128126592_zcsdb3dd6396c824_1d-9'   // 「东苑」9 楼——在用图
const BUILDING_ID = '1257237128126592_zcsdb3dd6396c824'

// 真实生产坐标（与云端同步结果一致）
const BLDG = {
  东苑1栋: [-14.147, 109.278], 东苑2栋: [-14.969, 11.043], 东苑3栋: [-14.519, -69.209],
  东苑4栋: [-14.908, -50.382], 东苑5栋: [-14.979, 37.814], 东苑7栋: [231.945, 59.898],
  东苑11栋: [146.465, -56.382], 东苑12栋: [74.747, 24.772], 东苑13栋: [23.399, -107.831]
}
const LOAD_NEW = [17.168, -3.435]   // 库房外的真上货点（在用图上）
const LOAD_OLD = [-0.746, 3.801]    // 备份图上的旧上货点（离真点 19.3 m，是垃圾数据）

// 假平台返回的点位列表：**备份图 10 条排前面**（这就是事故的根源），在用图 11 条排后面
function platformPoints() {
  const out = []
  for (const [name, pos] of Object.entries(BLDG)) out.push({ landmarkId: 'old-' + name, landmarkName: name, pose: pos, mapId: M_OLD, floor: '1' })
  out.push({ landmarkId: 'old-商铺上货', landmarkName: '商铺上货', pose: LOAD_OLD, mapId: M_OLD, floor: '1' })
  for (const [name, pos] of Object.entries(BLDG)) out.push({ landmarkId: 'new-' + name, landmarkName: name, pose: pos, mapId: M_NEW, floor: '9' })
  out.push({ landmarkId: 'new-零栋库房', landmarkName: '零栋库房', pose: [14.05, -3.317], mapId: M_NEW, floor: '9' })
  out.push({ landmarkId: 'new-商铺上货', landmarkName: '商铺上货', pose: LOAD_NEW, mapId: M_NEW, floor: '9' })
  return out
}

// 假平台：只答三个同步用到的接口
function startFakePlatform(carMapId) {
  const pts = platformPoints()
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (u.pathname.endsWith('/building/buildingList')) {
      return send({ code: 'COMM_200', data: { buildingList: [{ buildingId: BUILDING_ID, buildingName: '四川师范大学成龙校区' }] } })
    }
    if (u.pathname.endsWith('/building/landmarkInfo')) return send({ code: 'COMM_200', data: pts })
    if (u.pathname.endsWith('/deviceRuntime/runtimeStatusList')) {
      return send({ code: 'COMM_200', data: { data: [{ deviceSn: 'TEST-SN-1', name: '测试车', onlineStatus: 1, currMapId: carMapId, machineStatus: 'idle', batteryLevel: 99 }] } })
    }
    return send({ code: 'COMM_404', msg: '假平台没有这个接口：' + u.pathname })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)))
}

// 极简 landmarks 表（含平台映射列）+ meta + orders（同步里的去重清理要查 orders）
function makeDb(rows) {
  const p = path.join(os.tmpdir(), 'lingdong_test_points_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db')
  const db = new DatabaseSync(p)
  db.exec(`CREATE TABLE landmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, building TEXT DEFAULT '',
    floor TEXT DEFAULT '', type TEXT DEFAULT 'deliverPoint', sort INTEGER DEFAULT 0,
    platform_building_id TEXT DEFAULT '', platform_map_id TEXT DEFAULT '', platform_landmark_id TEXT DEFAULT '',
    pos_x REAL DEFAULT 0, pos_y REAL DEFAULT 0)`)
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`)
  db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, landmark_id TEXT)`)
  if (rows && rows.length) {
    const ins = db.prepare('INSERT INTO landmarks (name,floor,type,sort,platform_building_id,platform_map_id,platform_landmark_id,pos_x,pos_y) VALUES (?,?,?,?,?,?,?,?,?)')
    for (const r of rows) ins.run(r.name, r.floor || '', r.type, r.sort, BUILDING_ID, r.mapId, r.lmId, r.pos[0], r.pos[1])
  }
  return { db, p }
}

// 云端现状（改之前的样子）：9 栋楼 + 旧商铺上货 共 10 行都挂在备份图上，sort 依次 1..10
function productionSeedRows() {
  const rows = []
  let sort = 1
  for (const [name, pos] of Object.entries(BLDG)) rows.push({ name, type: 'deliverPoint', sort: sort++, mapId: M_OLD, lmId: 'old-' + name, pos, floor: '1' })
  rows.push({ name: '商铺上货', type: 'loadingPoint', sort: sort++, mapId: M_OLD, lmId: 'old-商铺上货', pos: LOAD_OLD, floor: '1' })
  return rows
}

const anchorMapOf = (db) => {
  const r = db.prepare("SELECT platform_map_id FROM landmarks WHERE platform_landmark_id != '' OR platform_landmark_id IS NOT NULL ORDER BY sort LIMIT 1").get()
  return r ? r.platform_map_id : ''
}

async function main() {
  const srv = await startFakePlatform(M_NEW)
  const port = srv.address().port
  process.env.PLATFORM_BASE = 'http://127.0.0.1:' + port
  process.env.PLATFORM_APPID = 'test-appid'
  process.env.PLATFORM_SECRET = 'test-secret'
  process.env.PLATFORM_PRINCIPALID = 'test-principal'
  process.env.PLATFORM_MOCK = 'false'
  process.env.VIRTUAL_ROBOT = '0'
  process.env.RUN_MODE = 'demo'
  process.env.PLATFORM_CALLBACK_BASE = ''
  const h = require('../services/platform-http.js')
  const points = require('../services/points.js')

  try {
    section('① 同步把同名同坐标的点位改写到「当前运营图」（车所在图）')
    const { db } = makeDb(productionSeedRows())
    eq(db.prepare('SELECT COUNT(*) c FROM landmarks').get().c, 10, '改前：库里有 10 行（全在备份图上）')
    const r1 = await h.syncLandmarks(db)
    ok(r1 && r1.ok, '同步成功（走的是假平台，不碰真实平台）')
    eq(r1.activeMapId, M_NEW, '识别出当前运营图 = 车所在图（9 楼那张）')
    eq(r1.repointed, 9, '9 栋楼被就地改写到运营图')
    eq(r1.inserted, 2, '新增 2 行（零栋库房 + 运营图上的商铺上货）')
    eq(r1.skipped, 0, '没有需要跳过的同位置记录残留')
    const names = Object.keys(BLDG).map((n) => `'${n}'`).join(',')
    const moved = db.prepare(`SELECT COUNT(*) c FROM landmarks WHERE name IN (${names}) AND platform_map_id=?`).get(M_NEW).c
    eq(moved, 9, '9 栋楼现在都在运营图上')
    const s1 = db.prepare("SELECT sort, platform_landmark_id FROM landmarks WHERE name='东苑1栋'").get()
    eq(s1.platform_landmark_id, 'new-东苑1栋', '东苑1栋 的平台点位 ID 换成了运营图的')
    eq(s1.sort, 1, '★ sort 没有被改写（否则取地图锚点会跟着漂）')

    section('② 上货点只认运营图那条（哪怕备份图那条 sort 更小）')
    const lp = points.loadingPointRow(db)
    eq(lp.platform_map_id, M_NEW, '上货点取自运营图')
    eq(lp.pos_x, LOAD_NEW[0], '上货点 x = 库房外的真上货点')
    eq(lp.pos_y, LOAD_NEW[1], '上货点 y = 库房外的真上货点')
    const stillThere = db.prepare("SELECT pos_x, pos_y FROM landmarks WHERE type='loadingPoint' AND platform_map_id=?").get(M_OLD)
    ok(!!stillThere, '备份图那条老上货点仍留在库里（只是不再被选中）')
    eq(anchorMapOf(db), M_NEW, '★ 取地图锚点（sort 最小那行）也落在运营图上 → 大屏底图会自动切到 9 楼那张')

    section('③ 反复同步幂等（每 60s 一次，不能来回改、不能重复插）')
    const r2 = await h.syncLandmarks(db)
    ok(r2.ok, '第二次同步成功')
    eq(r2.repointed, 0, '第二次同步不再需要改写')
    eq(r2.inserted, 0, '第二次同步不新增行')
    eq(r2.skipped, 9, '第二次同步把备份图那 9 条正确跳过')
    eq(db.prepare('SELECT COUNT(*) c FROM landmarks').get().c, 12, '库里稳定在 12 行')
    eq(anchorMapOf(db), M_NEW, '锚点仍是运营图')

    section('④ 取不到运营图 / 极简库没有 meta 表 → 退回旧的按 sort 第一条')
    const { db: bare } = makeDb([
      { name: '商铺上货', type: 'loadingPoint', sort: 10, mapId: '', lmId: '', pos: LOAD_OLD },
      { name: '商铺上货', type: 'loadingPoint', sort: 12, mapId: '', lmId: '', pos: LOAD_NEW },
      { name: '占位上货点', type: 'loadingPoint', sort: 1, mapId: '', lmId: '', pos: [0, 0] }
    ])
    eq(points.activeMapId(bare), '', '没有 meta 记录 → 运营图未知')
    const fallback = points.loadingPointRow(bare)
    eq(fallback.pos_x, LOAD_OLD[0], '退回「按 sort 第一条 + 排除 (0,0) 占位点」')
    bare.exec('DELETE FROM landmarks WHERE pos_x != 0 OR pos_y != 0')
    eq(points.loadingPointRow(bare).sort, 1, '全库只剩 (0,0) 占位点时才认它（保持旧 platform.js 行为）')

    section('⑤ 改写判定（preferIncoming）真值表')
    ok(points.preferIncoming(M_NEW, M_OLD, M_NEW) === true, '来的是运营图 + 库里不是 → 改写')
    ok(points.preferIncoming(M_NEW, M_NEW, M_NEW) === false, '两边都是运营图 → 不改写')
    ok(points.preferIncoming(M_OLD, M_NEW, M_NEW) === false, '来的是备份图 + 库里是运营图 → 不改写（不能被反向改回去）')
    ok(points.preferIncoming(M_NEW, M_OLD, '') === false, '运营图未知 → 保持旧行为')
    ok(points.preferIncoming('', '', '') === false, '空值不炸')
  } catch (e) {
    fail++
    console.log('  ✘ 抛异常：' + (e && e.stack ? e.stack : e))
  } finally {
    srv.close()
  }

  console.log('\n' + (fail === 0 ? '全部通过：' : '有失败：') + pass + ' 项通过 / ' + fail + ' 项失败')
  process.exit(fail === 0 ? 0 : 1)
}

main()
