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
//   · 商家账号（role=merchant 且有 username）→ 1 号店（存量账号兼容，见 db.js 的 shop_members 回填）
//   · 其它（学生/未登录）→ 1 号店（用户端一期只对接默认店）
function shopOfUser(store, user) {
  if (user && user.id) {
    const m = store.prepare('SELECT shop_id FROM shop_members WHERE user_id=? ORDER BY shop_id LIMIT 1').get(Number(user.id))
    if (m && m.shop_id) return normalizeShopId(m.shop_id)
  }
  return DEFAULT_SHOP_ID
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

module.exports = {
  DEFAULT_SHOP_ID,
  normalizeShopId,
  listShops,
  shopById,
  defaultShop,
  shopOfUser,
  memberRole,
  setMember,
  removeMember,
  removeAllMembers,
  nameMap
}
