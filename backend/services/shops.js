// 店铺上下文（多店铺地基，2026-10-23，见 doc/16_小程序扩容方案.md 一期）
// ------------------------------------------------------------
// 这里只回答两个问题：「当前请求属于哪家店」和「某账号属于哪家店」。
// 为什么不把这些写进各域 queries：goods / order / delivery / admin 四个域都要用，
// 各写一份必然出现「A 域默认 1 号店、B 域默认 0」这种串店 bug。
//
// 兼容口径（重要）：一期所有存量数据都归 1 号店；没有店铺归属的商家账号也默认 1 号店。
// 这样老接口、老数据、老测试的行为完全不变，多店能力是「加出来」的而不是「换掉」的。

const DEFAULT_SHOP_ID = 1

// 入参一律走这里：非法/空 → 默认店。避免 Number('')=0 这种脏值一路传到 SQL 里变成「查不到任何店」。
function normalizeShopId(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SHOP_ID
}

function listShops(store) {
  return store.prepare('SELECT * FROM shops ORDER BY sort, id').all()
}

function shopById(store, id) {
  return store.prepare('SELECT * FROM shops WHERE id=?').get(normalizeShopId(id))
}

// 默认店不存在时（极端空库）返回 undefined，由调用方决定兜底文案，不在这里造一条假店
function defaultShop(store) {
  return store.prepare('SELECT * FROM shops WHERE id=?').get(DEFAULT_SHOP_ID)
}

// 账号 → 店铺。先查成员表；查不到再按旧规则兜底：
//   · 商家账号（role=merchant 且有 username）→ 1 号店（存量账号兼容，见 backfillLegacyMembers）
//   · 其它（学生/未登录）→ 1 号店（用户端一期只对接默认店）
// 排序用 id（最早建立的那条归属）：一期一个账号只属于一家店，
// 万一历史数据里同一账号挂了多条（旧版回填的坑，见下），也要稳定地取第一条，而不是按 shop_id 最小值。
function shopOfUser(store, user) {
  if (user && user.id) {
    const m = store.prepare('SELECT shop_id FROM shop_members WHERE user_id=? ORDER BY id LIMIT 1').get(Number(user.id))
    if (m && m.shop_id) return normalizeShopId(m.shop_id)
  }
  return DEFAULT_SHOP_ID
}

// 存量商家账号归位（每次启动跑一遍，幂等）。
// 2026-10-23 修 bug：旧写法是「给所有商家账号插一条 1 号店成员行，靠唯一索引去重」——
// 唯一索引是 (shop_id, user_id)，所以已经属于 2 号店的账号仍会被补一条 1 号店的行，
// 而 shopOfUser 取的是最小 shop_id，于是**每次重启所有商家都被悄悄打回 1 号店**。
// 现在的口径：只给「一条成员行都没有」的账号补 1 号店，已有归属一律不动。
function backfillLegacyMembers(store) {
  const r = store.prepare(
    `INSERT OR IGNORE INTO shop_members (shop_id, user_id, role)
     SELECT 1, u.id, CASE WHEN u.merchant_role='owner' THEN 'owner' ELSE 'staff' END
     FROM users u
     WHERE u.role='merchant' AND u.username IS NOT NULL AND u.username != ''
       AND NOT EXISTS (SELECT 1 FROM shop_members m WHERE m.user_id = u.id)`
  ).run()
  return Number(r.changes || 0)
}

function memberRole(store, userId, shopId) {
  const r = store.prepare('SELECT role FROM shop_members WHERE user_id=? AND shop_id=?')
    .get(Number(userId), normalizeShopId(shopId))
  return r ? String(r.role || 'staff') : ''
}

// 把账号挂到店铺（管理员建商家账号 / 改店铺时用）。已存在则更新角色，不重复插行。
function setMember(store, shopId, userId, role) {
  const sid = normalizeShopId(shopId)
  const uid = Number(userId)
  if (!uid) return false
  const r = String(role) === 'owner' ? 'owner' : 'staff'
  const cur = store.prepare('SELECT id FROM shop_members WHERE shop_id=? AND user_id=?').get(sid, uid)
  if (cur) {
    store.prepare('UPDATE shop_members SET role=? WHERE id=?').run(r, cur.id)
  } else {
    store.prepare('INSERT INTO shop_members (shop_id, user_id, role) VALUES (?,?,?)').run(sid, uid, r)
  }
  return true
}

function removeMember(store, shopId, userId) {
  return store.prepare('DELETE FROM shop_members WHERE shop_id=? AND user_id=?')
    .run(normalizeShopId(shopId), Number(userId)).changes > 0
}

// 账号被删除时清掉它在所有店的成员行（连带清理，避免留下指向空账号的悬挂成员）
function removeAllMembers(store, userId) {
  return store.prepare('DELETE FROM shop_members WHERE user_id=?').run(Number(userId)).changes
}

// shop_id → 店名。列表接口要给每条数据补店名时用它，避免 N+1 查询
function nameMap(store) {
  const map = new Map()
  for (const s of listShops(store)) map.set(Number(s.id), s.name || ('店铺' + s.id))
  return map
}

// ---------------- 建店 / 改店（管理员网页「店铺管理」用） ----------------
// 为什么放在这里而不是 admin/queries：建店要保证「1 号店一定存在」「code 唯一」，
// 这两个约束所有调用方都要满足，写死在 admin 域会让以后的运维脚本绕过它们。

// 金额字段：非法/空 → 回落当前值（新建时 0），并夹在 0~999
function money(v, fallback) {
  const n = Number(v)
  if (v === undefined || v === null || String(v).trim() === '' || isNaN(n)) return fallback
  return Math.max(0, Math.min(999, Math.round(n * 100) / 100))
}

function codeTaken(store, code, exceptId) {
  const c = String(code || '').trim()
  if (!c) return false
  const row = store.prepare('SELECT id FROM shops WHERE code=?').get(c)
  return !!(row && Number(row.id) !== Number(exceptId))
}

function createShop(store, patch) {
  const p = patch || {}
  const name = String(p.name || '').trim()
  if (!name) throw new Error('请填写店铺名称')
  if (name.length > 40) throw new Error('店铺名称最多 40 字')
  const code = String(p.code || '').trim()
  if (code && codeTaken(store, code, 0)) throw new Error('店铺编码已存在')
  const r = store.prepare(
    `INSERT INTO shops (name, code, logo, category, address, pickup_landmark_id,
                        min_order, pack_fee, business_status, auto_accept, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    name, code, String(p.logo || ''), String(p.category || ''), String(p.address || ''),
    String(p.pickup_landmark_id || ''), money(p.min_order, 0), money(p.pack_fee, 0),
    p.business_status === 'closed' ? 'closed' : 'open', Number(p.auto_accept) === 1 ? 1 : 0,
    Number.isFinite(Number(p.sort)) ? Number(p.sort) : 0
  )
  return shopById(store, Number(r.lastInsertRowid))
}

// 改店：只改传了的字段（其余保持原值），避免"保存营业状态"顺手把取货点清空
function updateShop(store, id, patch) {
  const cur = shopById(store, id)
  if (!cur) return null
  const p = patch || {}
  const next = {
    name: p.name === undefined ? cur.name : String(p.name || '').trim() || cur.name,
    code: p.code === undefined ? (cur.code || '') : String(p.code || '').trim(),
    logo: p.logo === undefined ? (cur.logo || '') : String(p.logo || ''),
    category: p.category === undefined ? (cur.category || '') : String(p.category || ''),
    address: p.address === undefined ? (cur.address || '') : String(p.address || ''),
    pickup_landmark_id: p.pickup_landmark_id === undefined ? String(cur.pickup_landmark_id || '') : String(p.pickup_landmark_id || ''),
    min_order: p.min_order === undefined ? Number(cur.min_order || 0) : money(p.min_order, Number(cur.min_order || 0)),
    pack_fee: p.pack_fee === undefined ? Number(cur.pack_fee || 0) : money(p.pack_fee, Number(cur.pack_fee || 0)),
    business_status: p.business_status === undefined ? (cur.business_status || 'open') : (p.business_status === 'closed' ? 'closed' : 'open'),
    auto_accept: p.auto_accept === undefined ? Number(cur.auto_accept || 0) : (Number(p.auto_accept) === 1 ? 1 : 0),
    sort: p.sort === undefined ? Number(cur.sort || 0) : (Number.isFinite(Number(p.sort)) ? Number(p.sort) : Number(cur.sort || 0))
  }
  if (codeTaken(store, next.code, cur.id)) throw new Error('店铺编码已存在')
  store.prepare(
    `UPDATE shops SET name=?, code=?, logo=?, category=?, address=?, pickup_landmark_id=?,
            min_order=?, pack_fee=?, business_status=?, auto_accept=?, sort=? WHERE id=?`
  ).run(next.name, next.code, next.logo, next.category, next.address, next.pickup_landmark_id,
    next.min_order, next.pack_fee, next.business_status, next.auto_accept, next.sort, Number(cur.id))
  return shopById(store, cur.id)
}

module.exports = {
  DEFAULT_SHOP_ID,
  normalizeShopId,
  listShops,
  shopById,
  defaultShop,
  shopOfUser,
  backfillLegacyMembers,
  memberRole,
  setMember,
  removeMember,
  removeAllMembers,
  nameMap,
  createShop,
  updateShop
}
