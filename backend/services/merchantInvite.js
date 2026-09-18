// 商家邀请码服务（收紧加固）
//
// 邀请码不再是一个所有人共享的静态口令，而是：
//   - 按商家一条，存于 merchant_invites 表，仅保存 sha256 哈希，明文不落库；
//   - 首次登录绑定 openid —— 一个码只能绑一个微信账号，多台设备/他人无法复用；
//   - 可逐个吊销（active=0）或 解绑（unbind，重置后可由新账号绑定）；
//   - 保留 MERCHANT_INVITE_CODE 作为旧的单一码兜底（无绑定，向后兼容测试）。
const crypto = require('crypto')

const LEGACY_ENV_VAR = 'MERCHANT_INVITE_CODE'

// 统一归一化：大小写不敏感
function norm(code) {
  return String(code || '').trim().toUpperCase()
}

// 哈希即存库值：sha256(归一化后的码)，hex
function sha(code) {
  return crypto.createHash('sha256').update(norm(code)).digest('hex')
}

function ctEq(a, b) {
  // 定长比较，避免时序侧信道
  const ba = Buffer.from(String(a), 'hex')
  const bb = Buffer.from(String(b), 'hex')
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

// 验证邀请码。返回 { ok, reason, name }
//   reason: missing | invalid | bound_other | ok | not_configured
// bind=true 表示真实登录态（启用了绑定与「已是商家免码」）；demo 档传 false 跳过绑定，便于联调。
function verify(store, code, openid, bind) {
  const given = norm(code)
  if (!given) return { ok: false, reason: 'missing' }

  // 1) 按商家邀请码（merchant_invites）
  const h = sha(given)
  const row = store.prepare('SELECT * FROM merchant_invites WHERE code_hash=? AND active=1').get(h)
  if (row) {
    if (bind && row.bound_openid) {
      if (row.bound_openid !== openid) return { ok: false, reason: 'bound_other' }
      return { ok: true, reason: 'ok', name: row.name }
    }
    if (bind && !row.bound_openid) {
      store.prepare('UPDATE merchant_invites SET bound_openid=? WHERE id=?').run(openid, row.id)
      return { ok: true, reason: 'ok', name: row.name }
    }
    return { ok: true, reason: 'ok', name: row.name } // demo 档：跳过绑定
  }

  // 2) 旧版单一码兜底（env，向后兼容；不启用 openid 绑定）
  const legacy = process.env[LEGACY_ENV_VAR] || ''
  if (legacy && ctEq(sha(given), sha(legacy))) {
    return { ok: true, reason: 'ok', name: 'ME' }
  }

  return { ok: false, reason: 'invalid' }
}

// 是否配置了任何有效邀请码（DB 有效条数 + env 旧码）
function configuredCount(store) {
  let n = 0
  try {
    const r = store.prepare('SELECT COUNT(*) AS c FROM merchant_invites WHERE active=1').get()
    n = r ? r.c : 0
  } catch (e) { n = 0 }
  if (process.env[LEGACY_ENV_VAR]) n += 1
  return n
}

// 邀请码错误信息（供登录接口直接返回给商家端）
function message(reason) {
  switch (reason) {
    case 'missing': return '请填写商家邀请码'
    case 'invalid': return '商家邀请码不正确'
    case 'bound_other': return '该邀请码已绑定其他账号，请使用本店铺的邀请码'
    case 'not_configured': return '商家邀请码尚未配置，请联系管理员开通'
    default: return '商家邀请码不正确'
  }
}

// 生成不可读混淆码（去掉 0/O/1/I，避免输错）
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generate(length = 8) {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += CHARSET[bytes[i] % CHARSET.length]
  return out
}

module.exports = { norm, sha, ctEq, verify, configuredCount, message, generate }