// 管理员账号服务（方案A）：scrypt 密码哈希 + 随机 session token 的签发/校验/撤销
//
// 背景：管理员网页此前用「共享静态 ADMIN_TOKEN」鉴权——所有人同一把钥匙、无法区分操作者、
// 也无法单独禁用某人。方案A改为「用户名+密码登录 → 签发随机 session token」：
//   · 密码用 Node 内置 crypto.scrypt 加盐哈希（零依赖、抗 GPU 暴力），存 salt$hash
//   · session token = 32 字节随机 hex，存在 admin_sessions 表，过期（默认 7 天，ADMIN_SESSION_DAYS 可调）
//     后失效；吊销即删行；禁用账号后其全部 session 一并失效
//   · 过期时间用 SQLite datetime('now','localtime', '+N days') 计算，与鉴权比较同一时钟源

const crypto = require('crypto')

const SESSION_DAYS = Number(process.env.ADMIN_SESSION_DAYS || 7)

// scrypt 加盐哈希：返回 'salt$hash'（均为 hex）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return salt + '$' + hash
}

// 校验密码：恒定时间比较，避免时序侧信道
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 2) return false
  let calc, want
  try {
    calc = crypto.scryptSync(String(password), parts[0], 64)
    want = Buffer.from(parts[1], 'hex')
  } catch (e) {
    return false
  }
  return want.length === calc.length && crypto.timingSafeEqual(calc, want)
}

function findByUsername(store, username) {
  return store.prepare('SELECT * FROM admin_users WHERE username=?').get(String(username || '').trim()) || null
}

function createAdmin(store, { username, password, nickname = '', role = 'admin' }) {
  const u = String(username || '').trim()
  if (!u) throw new Error('账号不能为空')
  if (!password || String(password).length < 8) throw new Error('密码至少 8 位')
  const info = store.prepare('INSERT INTO admin_users (username, password_hash, nickname, role) VALUES (?,?,?,?)')
    .run(u, hashPassword(password), String(nickname || '').slice(0, 50), String(role || 'admin'))
  return store.prepare('SELECT * FROM admin_users WHERE id=?').get(Number(info.lastInsertRowid))
}

// 签发 session：过期时间在 SQL 里算（datetime('now','localtime', '+N days')）
function issueSession(store, adminId) {
  const token = crypto.randomBytes(32).toString('hex')
  store.prepare(`INSERT INTO admin_sessions (token, admin_user_id, expires_at)
    VALUES (?,?, datetime('now','localtime', ?))`).run(token, Number(adminId), '+' + SESSION_DAYS + ' days')
  return { token }
}

// 校验 session：未过期且账号启用才算有效；返回管理员信息或 null
function resolveSession(store, token) {
  if (!token) return null
  try {
    return store.prepare(`SELECT s.id AS session_id, s.expires_at,
        u.id, u.username, u.nickname, u.role, u.status
      FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.token=? AND s.expires_at > datetime('now','localtime')`).get(String(token)) || null
  } catch (e) {
    return null
  }
}

function revokeSession(store, token) {
  if (token) store.prepare('DELETE FROM admin_sessions WHERE token=?').run(String(token))
}

function revokeAllSessions(store, adminId) {
  store.prepare('DELETE FROM admin_sessions WHERE admin_user_id=?').run(Number(adminId))
}

// 启用的管理员数量（server 启动守卫用）
function enabledCount(store) {
  const r = store.prepare('SELECT COUNT(*) c FROM admin_users WHERE status=1').get()
  return Number((r && r.c) || 0)
}

module.exports = {
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  findByUsername,
  createAdmin,
  issueSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  enabledCount
}
