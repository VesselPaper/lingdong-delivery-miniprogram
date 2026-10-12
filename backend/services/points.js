// services/points.js —— 点位口径的**唯一取值入口**（2026-10-12 新增）
// ------------------------------------------------------------------
// 背景（真机实测）：平台上同一个场地会同时挂多张地图。2026-10-12 越凡把运营图换成
//   …_1d-9「东苑」（当天更新，车在这张图上跑）
// 但旧图
//   …_1d-1「东苑（备份）」
// 上的点位记录**仍然存在**，而且 `building/landmarkInfo` 把备份图的 10 条排在前面。
// 后果（换图当天实测）：
//   1) 同步按「名称+坐标」去重、先到先得 → 9 栋楼和一个「商铺上货」的 platform_landmark_id
//      永久留在**备份图**上；平台每 60s 重新同步一次都会把 sort/type/mapId 重写，
//      所以「直接改数据库」60 秒后就被覆盖，只有改代码才留得住。
//   2) 各模块一律 `WHERE type='loadingPoint' ORDER BY sort LIMIT 1` 取上货点 → 取到备份图那条
//      (-0.746, 3.801)，而真实上货点在库房外 (17.168, -3.435)，相距 19.3 m：
//      召唤/开舱门禁会把车叫到错误位置。
//
// 本模块把「当前运营图」和「上货点取值」收成两个入口，规则只有一条：
//   **当前运营图 = 平台报告的在线车所在图（curr_map_id）**，由同步过程写进 meta.active_map_id。
//   取不到（演示档/平台不可用/测试库没有 meta 表）就退回旧行为（按 sort 第一条），
//   保证既有行为与既有测试不受影响。
//
// 为什么放 services/ 而不是 domains/：batch（组单/路线）、platform（建任务/召唤）、
// delivery（用户端路线起点）三个域都要用同一个口径；放在任一个域里都会造成跨域依赖或成环。
const META_KEY = 'active_map_id'

// meta 表可能不存在（测试里的最小库）：一律吞掉异常，退回默认行为
function metaGet(store, key) {
  try {
    const r = store.prepare('SELECT value FROM meta WHERE key=?').get(key)
    return r && r.value ? String(r.value) : ''
  } catch (e) { return '' }
}

function metaSet(store, key, val) {
  try {
    store.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(val))
    return true
  } catch (e) { return false }
}

// 当前运营图（车所在图）。空串 = 未知 → 所有取值退回旧行为。
function activeMapId(store) {
  return metaGet(store, META_KEY)
}

function setActiveMapId(store, mapId) {
  if (!mapId) return false
  if (metaGet(store, META_KEY) === String(mapId)) return true
  return metaSet(store, META_KEY, mapId)
}

// 上货点取值（**全项目唯一入口**，别再各写一条 SQL）：
//   ① 当前运营图上、坐标非 (0,0) 的那条 —— 正常路径
//   ② 任意图上、坐标非 (0,0) 的那条 —— 运营图未知时的兜底（旧 batch.js 口径）
//   ③ 任意图上的第一条 —— 全库只有一条 (0,0) 占位点时也认（旧 platform.js 口径）
// 第③级存在的理由：坐标是不是 (0,0) 由调用方自己判断（batch 的 lmPoint 会把它当无坐标），
// 但 platform 侧还需要它的 platform_landmark_id / map_id 去建任务 —— 返回行比返回 null 更有用。
function loadingPointRow(store) {
  const pick = (sql, param) => {
    try { return (param === undefined ? store.prepare(sql).get() : store.prepare(sql).get(param)) || null } catch (e) { return null }
  }
  const am = activeMapId(store)
  let row = null
  if (am) {
    row = pick("SELECT * FROM landmarks WHERE type='loadingPoint' AND platform_map_id=? AND (pos_x != 0 OR pos_y != 0) ORDER BY sort, id LIMIT 1", am)
  }
  if (!row) row = pick("SELECT * FROM landmarks WHERE type='loadingPoint' AND (pos_x != 0 OR pos_y != 0) ORDER BY sort, id LIMIT 1")
  if (!row) row = pick("SELECT * FROM landmarks WHERE type='loadingPoint' ORDER BY sort, id LIMIT 1")
  return row
}

// 取「地图锚点」行：用哪一行去问平台要地图资源（mapInfo/mapId），就决定了
// 大屏与用户端追踪页显示的是哪张底图。
//   ① 当前运营图上的第一条（sort,id 排序）—— 正常路径，显示的就是车所在的那张图
//   ② 兜底：任意图上、有 platform_map_id 的第一条（运营图未知时的旧行为）
function anchorRow(store) {
  const pick = (sql, param) => {
    try { return (param === undefined ? store.prepare(sql).get() : store.prepare(sql).get(param)) || null } catch (e) { return null }
  }
  const am = activeMapId(store)
  let row = null
  if (am) row = pick("SELECT * FROM landmarks WHERE platform_map_id=? AND platform_map_id!='' ORDER BY sort, id LIMIT 1", am)
  if (!row) row = pick("SELECT * FROM landmarks WHERE platform_building_id != '' ORDER BY sort, id LIMIT 1")
  return row
}

// 同步去重判定：同名同坐标的两条记录同时存在于平台时，库里那条的身份该不该被这条覆盖。
// 只在「来的这条属于当前运营图、库里那条不属于」时返回 true ——
// 不知道运营图（act 为空）时返回 false，等于保持旧的「先到先得」行为。
function preferIncoming(incomingMapId, existingMapId, actMapId) {
  const inc = String(incomingMapId || '')
  const ex = String(existingMapId || '')
  const act = String(actMapId || '')
  if (!act) return false
  return inc === act && ex !== act
}

module.exports = { META_KEY, activeMapId, setActiveMapId, loadingPointRow, anchorRow, preferIncoming }
