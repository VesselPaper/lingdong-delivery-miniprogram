// domains/_shared.js —— 各域共用的中间件与工具
// 依赖 store 的函数（auth / merchantGuard / adminGuard / audit）用工厂 createShared(store) 创建，
// 由 server.js 与各域 routes.js 在拿到 store 后调用一次；纯函数（ok / maskPhone / toStock）直接导出。
// 说明：本文件不依赖任何域，域间互相 require 时不会成环。

const crypto = require('crypto')

// 管理员令牌：页面首次打开需输入（存 localStorage）；可用环境变量 ADMIN_TOKEN 覆盖
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '123456'

function ok(res, data = null, msg = 'success') {
  res.json({ code: 0, msg, data })
}

// 手机号脱敏（P1-13）：商家端接口对外默认 138****0000，明文只在服务端内部逻辑使用
function maskPhone(p) {
  const s = String(p || '')
  if (!s) return ''
  return s.length <= 7 ? (s.slice(0, 1) + '****' + s.slice(-2)) : (s.slice(0, 3) + '****' + s.slice(-4))
}

// 库存值归一化：未传/空 → 默认 999；显式 0 必须保留为 0（修复「设库存 0 保存后变回 999」）
function toStock(v, fallback = 999) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return isNaN(n) || n < 0 ? 0 : n
}

// 工厂：注入 store 后返回依赖它的中间件与审计函数（store 由 server.js 注入，无模块级单例）
function createShared(store) {
  // 简易鉴权：token = openid 的哈希，正式环境可换 JWT
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    if (!token) return res.status(401).json({ code: 401, msg: '未登录' })
    const row = store.prepare('SELECT * FROM users WHERE openid=?').get(token)
    if (!row) return res.status(401).json({ code: 401, msg: '登录失效' })
    req.user = row
    next()
  }

  function merchantGuard(req, res, next) {
    auth(req, res, () => {
      if (req.user.role !== 'merchant') return res.status(403).json({ code: 403, msg: '无权限' })
      next()
    })
  }

  function adminGuard(req, res, next) {
    const given = String(req.headers['x-admin-token'] || req.query.token || '')
    if (!given) return res.status(401).json({ code: 401, msg: '缺少管理员令牌' })
    const a = crypto.createHash('sha256').update(given).digest()
    const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest()
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ code: 401, msg: '管理员令牌无效' })
    next()
  }

  // 商家敏感操作审计（P1-13）：改价/上下架/退款/取消/派车/设备控制/活动全部落 audit_logs，
  // 配合手机号脱敏形成「展示最小化、操作可追溯」的隐私与责任闭环。
  function audit(req, action, target, detail) {
    try {
      store.prepare('INSERT INTO audit_logs (user_id, user_role, action, target, detail) VALUES (?,?,?,?,?)')
        .run(req.user ? req.user.id : 0, req.user ? (req.user.role || '') : '', action, String(target || ''), String(detail || '').slice(0, 500))
    } catch (e) { /* 审计失败不阻断业务 */ }
  }

  return { auth, merchantGuard, adminGuard, audit, ok, maskPhone, toStock }
}

module.exports = { createShared, ok, maskPhone, toStock, ADMIN_TOKEN }
