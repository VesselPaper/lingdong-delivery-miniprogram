// domains/_shared.js —— 各域共用的中间件与工具
// 依赖 store 的函数（auth / merchantGuard / adminGuard / audit）用工厂 createShared(store) 创建，
// 由 server.js 与各域 routes.js 在拿到 store 后调用一次；纯函数（ok / maskPhone / toStock）直接导出。
// 说明：本文件不依赖任何域，域间互相 require 时不会成环。

const crypto = require('crypto')
// 状态流水：audit() 顺带登记「操作者线索」，供采集器给状态迁移署名（见 services/statusEvents.js）
const statusEvents = require('../services/statusEvents')

// 管理员令牌：页面首次打开需输入（存 localStorage）；可用环境变量 ADMIN_TOKEN 覆盖
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '123456'

// 图片/静态资源对外基址（对齐真实上线）：
// 生产设 PUBLIC_ORIGIN = https://你的域名，后端在 ok() 里把 /uploads、/store-img 相对路径
// 统一拼成完整 URL 返回，前端不再各自拼 host；开发未设时回退到请求自身的 protocol+host（各 IP 自适应）。
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '')

// 资源绝对地址化：只处理后端自有的相对资源前缀（/uploads、/store-img），
// 已是完整地址、data:、以及商品快照里的本地包路径（/assets/...）一律原样返回。
function assetAbs(v, origin) {
  if (typeof v === 'string') {
    if (v.indexOf('/uploads/') === 0 || v.indexOf('/store-img/') === 0) return (origin || '') + v
    return v
  }
  if (Array.isArray(v)) return v.map((x) => assetAbs(x, origin))
  if (v && typeof v === 'object') {
    const o = {}
    for (const k in v) o[k] = assetAbs(v[k], origin)
    return o
  }
  return v
}

function originOf(res) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN
  if (res && res.req) return res.req.protocol + '://' + res.req.get('host')
  return ''
}

// 统一资源绝对地址化后再返回：所有接口的图片字段由后端给出完整 URL，前端去掉重复拼接。
function ok(res, data = null, msg = 'success') {
  res.json({ code: 0, msg, data: assetAbs(data, originOf(res)) })
}

// 手机号脱敏（P1-13）：商家端接口对外默认 138****0000，明文只在服务端内部逻辑使用
function maskPhone(p) {
  const s = String(p || '')
  if (!s) return ''
  return s.length <= 7 ? (s.slice(0, 1) + '****' + s.slice(-2)) : (s.slice(0, 3) + '****' + s.slice(-4))
}

// 库存值归一化：未传/空 → 默认 99（与商家端表单提示「不填默认 99」一致）；显式 0 必须保留为 0（修复「设库存 0 保存后被重置」）
function toStock(v, fallback = 99) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return isNaN(n) || n < 0 ? 0 : n
}

// 工厂：注入 store 后返回依赖它的中间件与审计函数（store 由 server.js 注入，无模块级单例）
function createShared(store) {
  // 简易鉴权：token = 账号密码登录签发的随机串（users.token）或用户端微信 openid（兼容存量）。
  // 2026-09-24：商家账号登录签发随机 token（可吊销）；用户端微信登录仍以 openid 为 token，两者互不冲突。
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    if (!token) return res.status(401).json({ code: 401, msg: '未登录' })
    const row = store.prepare('SELECT * FROM users WHERE token=? OR openid=?').get(token, token)
    if (!row) return res.status(401).json({ code: 401, msg: '登录失效' })
    req.user = row
    next()
  }

  function merchantGuard(req, res, next) {
    auth(req, res, () => {
      const u = req.user
      if (!u || u.role !== 'merchant') return res.status(403).json({ code: 403, msg: '无权限' })
      // 2026-09-24 起商家权限只认账号体系：username 非空且启用。
      // 旧微信商家账号（无 username）与停用账号一律拒绝——封死「微信登录直接当商家」的历史路径。
      if (!u.username || Number(u.status) !== 1) return res.status(403).json({ code: 403, msg: '账号已停用或无效' })
      next()
    })
  }

  // 店主专属守卫：在 merchantGuard 基础上要求 merchant_role==='owner'
  function ownerGuard(req, res, next) {
    merchantGuard(req, res, () => {
      if (req.user.merchant_role !== 'owner') return res.status(403).json({ code: 403, msg: '需要店主权限' })
      next()
    })
  }

  function adminGuard(req, res, next) {
    // 方案A：x-admin-token = 登录签发的随机 session token；不再使用共享静态 ADMIN_TOKEN。
    // 只认请求头：曾支持 ?token= 查询串，令牌会因此进入访问日志/浏览器历史/Referer，已移除。
    const given = String(req.headers['x-admin-token'] || '')
    const s = given ? store.prepare(`SELECT s.id AS session_id, s.expires_at,
        u.id, u.username, u.nickname, u.role, u.status
      FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.token=? AND s.expires_at > datetime('now','localtime')`).get(given) : null
    if (!s || Number(s.status) !== 1) {
      return res.status(401).json({ code: 401, msg: '未登录或登录已过期' })
    }
    req.admin = { id: s.id, username: s.username, nickname: s.nickname || '', role: s.role || 'admin' }
    next()
  }

  // 商家敏感操作审计（P1-13）：改价/上下架/退款/取消/派车/设备控制/活动全部落 audit_logs，
  // 配合手机号脱敏形成「展示最小化、操作可追溯」的隐私与责任闭环。
  // 管理员操作（方案A）同样落审计：身份 = 登录的管理员账号（user_id=管理员id, user_role='admin'）。
  //
  // 2026-09 重构：audit() 改为「纯标注」——只把语义写进 req._audit，不直接落库。
  // 真正的写入由 auditMw 在响应时统一完成，好处：
  //   ① 新增写接口自动进审计（中间件兜底），不再依赖每个 handler 记得手写一行；
  //      （此前管理端 14 个写接口就是因为漏写 audit() 而没有留痕）
  //   ② 成功与失败都留痕：失败时 detail 取响应 msg；
  //   ③ 现有 audit(req, action, target, detail) 调用签名不变，一行都不用改。
  function audit(req, action, target, detail) {
    if (!req) return
    req._audit = {
      action: String(action || ''),
      target: String(target || ''),
      detail: String(detail || '')
    }
    // 顺带登记「操作者线索」：采集器捕获到 target 所指实体的状态迁移时，用这个操作者署名。
    // 这样 37 处已有的 audit() 调用无需改动，就为状态时间线补上了 actor 归属。
    const actor = req.admin
      ? { type: 'admin', id: req.admin.id, name: req.admin.username }
      : (req.user
        ? { type: req.user.role === 'merchant' ? 'merchant' : 'user', id: req.user.id, name: req.user.nickname || '' }
        : null)
    if (actor) statusEvents.hintActor(String(target || ''), actor, String(detail || ''))
  }

  // ---------- 审计中间件：写请求统一落库（成功与失败都记） ----------
  // 只读（GET/HEAD/OPTIONS）不记；高频且无审计价值的写路径由 AUDIT_EXCLUDE_PREFIXES 排除，
  // 否则用户端加购物车/改地址这类操作会把审计表刷爆。
  // 注意：中间件挂在 app.use('/api', ...)，此时 req.path 已被剥掉挂载前缀，
  // 所以排除判断与动作推导一律用 req.originalUrl（完整路径）。
  const AUDIT_EXCLUDE = String(process.env.AUDIT_EXCLUDE_PREFIXES === undefined
    ? '/api/cart,/api/address,/api/user,/api/pay/notify'
    : process.env.AUDIT_EXCLUDE_PREFIXES)
    .split(',').map((s) => s.trim()).filter(Boolean)

  function fullPathOf(req) {
    return String((req && (req.originalUrl || req.url || req.path)) || '').split('?')[0]
  }

  // 从请求体里挑一个最能代表「操作对象」的字段，形如 order#123 / device_sn#Z201...
  const AUDIT_ID_FIELDS = ['order_id', 'batch_id', 'task_id', 'platform_task_id', 'goods_id', 'activity_id', 'id', 'device_sn']
  function auditTarget(req) {
    const b = (req && req.body) || {}
    for (const k of AUDIT_ID_FIELDS) {
      const v = b[k]
      if (v === undefined || v === null || v === '') continue
      return k.replace(/_id$/, '') + '#' + String(v).slice(0, 60)
    }
    return ''
  }

  // 由路径推导动作码：POST /api/admin/order/cancel → admin/order/cancel [POST]
  // 本项目所有 id 都在 body/query（路径无动态段），故路径即稳定的动作标识。
  function auditAction(req) {
    const p = fullPathOf(req).replace(/^\/+/, '').replace(/^api\//, '').replace(/\/+$/, '')
    return (p || 'unknown') + ' [' + String((req && req.method) || '').toUpperCase() + ']'
  }

  function auditMw(req, res, next) {
    const method = String(req.method || '').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const path = fullPathOf(req)
    if (AUDIT_EXCLUDE.some((pre) => path.indexOf(pre) === 0)) return next()

    const startedAt = Date.now()
    let done = false
    let failMsg = ''

    function write() {
      if (done) return
      done = true
      try {
        // 身份：adminGuard 设 req.admin / auth 设 req.user（两者都在响应前完成，故此处读取可靠）
        const actor = req.admin
          ? { id: req.admin.id, role: 'admin', name: req.admin.username }
          : (req.user
            ? { id: req.user.id, role: req.user.role || '', name: req.user.nickname || '' }
            : { id: 0, role: '', name: '' })
        const ann = req._audit || {}
        const status = Number(res.statusCode) || 0
        const okFlag = status >= 200 && status < 400
        // 成功用标注 detail；失败优先用标注 detail，否则取响应 msg（如「原密码不正确」）
        const detail = ann.detail || (okFlag ? '' : failMsg)
        store.prepare(`INSERT INTO audit_logs
          (user_id, user_role, action, target, detail, ok, status, ip, ua, ms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          actor.id, actor.role,
          String(ann.action || auditAction(req)).slice(0, 120),
          String(ann.target || auditTarget(req)).slice(0, 120),
          String(detail || '').slice(0, 500),
          okFlag ? 1 : 0, status,
          String(req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 60),
          String(req.headers['user-agent'] || '').slice(0, 200),
          Date.now() - startedAt
        )
      } catch (e) { /* 审计失败不阻断业务 */ }
    }

    // 包一层 res.json 取失败原因，并在响应前落库（此时 audit() 标注一定已写入）
    const origJson = res.json.bind(res)
    res.json = function (body) {
      try {
        if (body && typeof body === 'object' && Number(body.code) !== 0) failMsg = String(body.msg || '')
      } catch (e) { /* 忽略 */ }
      write()
      return origJson(body)
    }
    // 兜底：非 JSON 响应（res.send/end）或连接中断时也要落库
    res.on('finish', write)
    res.on('close', write)
    next()
  }

  return { auth, merchantGuard, ownerGuard, adminGuard, audit, auditMw, ok, maskPhone, toStock }
}

module.exports = { createShared, ok, maskPhone, toStock, ADMIN_TOKEN, assetAbs, PUBLIC_ORIGIN }
