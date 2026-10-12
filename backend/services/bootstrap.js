// services/bootstrap.js —— 首次启动补齐「开箱即用」的默认账号
// ------------------------------------------------------------------
// 为什么需要它：账号只存在本地 SQLite（backend/data/lingdong.db），而这个库**不进仓库**。
// 成员 clone 后拿到的是一个全新的空库 —— 管理员账号只由 tools/admin_user.js 手工创建、
// 商家账号只能由管理员网页「商家管理」创建，于是形成死锁：
//   进不了管理员网页 → 建不出商家账号 → 商家端也登不进（用户端原本连账号密码入口都没有）。
// 本模块在**非正式档**首次启动时补上可用的默认账号，并把账号密码打印在控制台，
// 让「clone → 复制 .env.example 为 .env → 启动 → 能登」成立。
//
// 安全边界（刻意不做过度加固，负责人要求"别太多安全锁、不然很不方便"）：
//   · RUN_MODE=production 时**绝不**自动建号（默认口令上生产是真事故），仍要求手工建；
//   · 幂等：已经存在启用中的同类账号就完全不动（绝不会覆盖你改过的密码）；
//   · 想彻底关掉自举：.env 设 BOOTSTRAP_ACCOUNTS=0。
//
// .env 可覆盖（默认值见下）：
//   BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD
//   BOOTSTRAP_MERCHANT_USERNAME / BOOTSTRAP_MERCHANT_PASSWORD
//   BOOTSTRAP_STUDENT_USERNAME / BOOTSTRAP_STUDENT_PASSWORD
'use strict'
const adminAuth = require('./adminAuth')

const DEFAULT_PWD = 'ldpzjkxy2026'
const ADMIN_USER = process.env.BOOTSTRAP_ADMIN_USERNAME || 'LDPZadmin'
const ADMIN_PWD = process.env.BOOTSTRAP_ADMIN_PASSWORD || DEFAULT_PWD
const MERCHANT_USER = process.env.BOOTSTRAP_MERCHANT_USERNAME || 'LDPZmar1'
const MERCHANT_PWD = process.env.BOOTSTRAP_MERCHANT_PASSWORD || DEFAULT_PWD
const STUDENT_USER = process.env.BOOTSTRAP_STUDENT_USERNAME || 'LDPZstu1'
const STUDENT_PWD = process.env.BOOTSTRAP_STUDENT_PASSWORD || DEFAULT_PWD

function disabled() {
  const v = String(process.env.BOOTSTRAP_ACCOUNTS === undefined ? '' : process.env.BOOTSTRAP_ACCOUNTS).toLowerCase()
  return v === '0' || v === 'false' || v === 'off'
}

// 是否已存在「启用中的某类账号」。三类各自判断，避免"有管理员就不建商家账号"这种连带跳过。
function hasEnabledAdmin(store) {
  return adminAuth.enabledCount(store) > 0
}
function hasEnabledMerchant(store) {
  try {
    return !!store.prepare("SELECT id FROM users WHERE role='merchant' AND username IS NOT NULL AND username!='' AND status=1").get()
  } catch (e) { return false }
}
function hasEnabledStudent(store) {
  try {
    return !!store.prepare("SELECT id FROM users WHERE role='student' AND username IS NOT NULL AND username!='' AND status=1").get()
  } catch (e) { return false }
}
function usernameTaken(store, username) {
  try { return !!store.prepare('SELECT id FROM users WHERE username=?').get(String(username)) } catch (e) { return false }
}

// 在非正式档补齐默认账号；返回 { created, skipped }（供测试断言，日志才是给人看的）
function ensureDefaultAccounts(store, runtime) {
  const out = { created: [], skipped: [] }
  try {
    if (disabled()) return out
    const mode = (runtime && runtime.mode) || 'demo'
    if (mode === 'production') {
      out.skipped.push('RUN_MODE=production：不自动创建默认账号（请用 tools/admin_user.js 手工建管理员）')
      return out
    }

    // 1) 管理员（admin_users 表）—— 管理员网页 /admin/ 登录用
    if (!hasEnabledAdmin(store)) {
      try {
        adminAuth.createAdmin(store, { username: ADMIN_USER, password: ADMIN_PWD, nickname: '默认管理员' })
        out.created.push({ kind: '管理员', username: ADMIN_USER, password: ADMIN_PWD, where: '管理员网页  /admin/' })
      } catch (e) {
        out.skipped.push('管理员：' + e.message)
      }
    }

    // 2) 商家账号（users 表：role=merchant + username + password_hash）—— 商家端小程序登录用
    if (!hasEnabledMerchant(store)) {
      if (usernameTaken(store, MERCHANT_USER)) {
        out.skipped.push('商家端：账号 ' + MERCHANT_USER + ' 已存在，但不是启用中的商家账号（未改动）')
      } else {
        store.prepare(`INSERT INTO users (username, password_hash, role, merchant_role, nickname, status)
          VALUES (?,?,'merchant','owner','默认商家',1)`).run(MERCHANT_USER, adminAuth.hashPassword(MERCHANT_PWD))
        out.created.push({ kind: '商家端', username: MERCHANT_USER, password: MERCHANT_PWD, where: '商家端小程序（店主）' })
      }
    }

    // 3) 用户端账号（users 表：role=student + username + password_hash）—— 用户端小程序的账号密码登录用
    //    用户端 2026-10-11 起支持账号密码登录（此前只有微信一键登录）。
    if (!hasEnabledStudent(store)) {
      if (usernameTaken(store, STUDENT_USER)) {
        out.skipped.push('用户端：账号 ' + STUDENT_USER + ' 已存在，但不是启用中的用户端账号（未改动）')
      } else {
        store.prepare(`INSERT INTO users (username, password_hash, role, nickname, status)
          VALUES (?,?,'student','默认用户',1)`).run(STUDENT_USER, adminAuth.hashPassword(STUDENT_PWD))
        out.created.push({ kind: '用户端', username: STUDENT_USER, password: STUDENT_PWD, where: '用户端小程序（账号密码登录）' })
      }
    }

    if (out.created.length) printCreated(out.created)
    return out
  } catch (e) {
    console.warn('[bootstrap] 默认账号自举失败（不影响启动）：' + e.message)
    return out
  }
}

function printCreated(list) {
  console.log('')
  console.log('[bootstrap] 本机数据库原本没有可用账号，已自动创建以下默认账号（正式上线前请改密码）：')
  for (const a of list) console.log('    ' + a.kind + '：' + a.username + ' / ' + a.password + '    → ' + a.where)
  console.log('    改密码：管理员 node tools/admin_user.js reset --username ' + ADMIN_USER + '；')
  console.log('            商家/用户端账号在管理员网页「商家管理」里重置，或用 .env 的 BOOTSTRAP_*_PASSWORD 后删库重来。')
  console.log('')
}

module.exports = {
  ensureDefaultAccounts,
  DEFAULTS: {
    admin: { username: ADMIN_USER, password: ADMIN_PWD },
    merchant: { username: MERCHANT_USER, password: MERCHANT_PWD },
    student: { username: STUDENT_USER, password: STUDENT_PWD }
  }
}
