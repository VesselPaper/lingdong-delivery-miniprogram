// user 域业务逻辑：登录（用户端微信 / 商家端账号密码）、资料更新、购物车折后价
// 依赖注入：service 函数显式接收 (store, deps)；deps.runtime 提供登录凭据与运行模式。
// 2026-09-24：商家端登录从「微信+邀请码」改为「账号密码（管理员网页创建，店主/店员分级）」，
// 邀请码机制退役（merchantInvite.js 已删除）；密码哈希复用 adminAuth 的 scrypt 方案。

const crypto = require('crypto')
const q = require('./queries')
const adminAuth = require('../../services/adminAuth')
const promotion = require('../../services/promotion')

// 登录限流（按来源 IP）：防止暴力试密码。
// 内存级、单进程足够；多副本需换 Redis。
const LOGIN_LIMIT = 20
const LOGIN_WIN = 10 * 60 * 1000
const LOGIN_MAP_MAX = 10000   // 条目上限：超过就先清掉过期项，避免这张表无界增长
const loginFail = {
  _m: new Map(),
  _prune(t) {
    if (this._m.size <= LOGIN_MAP_MAX) return
    for (const [k, v] of this._m) if (t - v.t >= LOGIN_WIN) this._m.delete(k)
  },
  count(ip) { const t = Date.now(), r = this._m.get(ip); return (r && t - r.t < LOGIN_WIN) ? r.c : 0 },
  add(ip) { const t = Date.now(); this._prune(t); const r = this._m.get(ip); if (!r || t - r.t >= LOGIN_WIN) this._m.set(ip, { t, c: 1 }); else r.c++ },
  ok(ip) { const t = Date.now(), r = this._m.get(ip); if (r && t - r.t < LOGIN_WIN) r.c = Math.max(0, r.c - 2) }
}

// 客户端来源 IP（登录限流键）：默认只信 socket 对端地址。
// X-Forwarded-For 是客户端可随意伪造的请求头 —— 采信它会让限流形同虚设
// （每次换一个假 IP 就是全新的 20 次额度），并让上面的 Map 被任意撑大。
// 只有确实部署在反向代理之后时，才在 .env 设 TRUST_PROXY=1 采信 XFF。
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (xff) return xff
  }
  return (req.socket && req.socket.remoteAddress) || 'local'
}

// 演示模式 openid = demo_ + sha1(code)（RUN_MODE=production 下启动守卫会拒绝这种配置）
function demoOpenid(code) {
  return 'demo_' + crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 24)
}

// 登录：用户端走真实微信 code2session（凭据就绪时）；商家端走账号密码（管理员网页创建）。
// 返回 { error: {status, msg} } 或 { data }；HTTP 状态码由 routes 层翻译。
// 商家账号规则（2026-09-24）：
//   - 商家端(client=merchant)：必须「用户名+密码」；校验 scrypt 密码 + 账号启用(status=1)；
//     成功签发随机 token（存 users.token，可吊销），返回 user 含 merchant_role（owner/staff）；
//   - 用户端(client=user)：微信登录（openid 即 token），与商家账号体系互不相干；
//   - 邀请码机制已退役：任何入口都不再校验 merchant_code，学生也不再能凭码升级为商家。
async function login(store, deps, body, ip) {
  const { code, nickname = '', username = '', password = '', client = 'user' } = body || {}
  const clientKey = client === 'merchant' ? 'merchant' : 'user'

  // 限流：失败累计过多则暂时拒绝（防暴力试密码/试码）
  if (loginFail.count(ip) >= LOGIN_LIMIT) {
    return { error: { status: 429, msg: '登录尝试过于频繁，请稍后再试' } }
  }

  // ==================== 商家端：账号密码登录 ====================
  if (client === 'merchant') {
    const u = String(username || '').trim()
    const p = String(password || '')
    if (!u || !p) { loginFail.add(ip); return { error: { status: 400, msg: '请输入账号和密码' } } }
    const row = q.findByUsername(store, u)
    if (!row || row.role !== 'merchant' || !adminAuth.verifyPassword(p, row.password_hash || '')) {
      loginFail.add(ip)
      return { error: { status: 403, msg: '账号或密码错误' } }
    }
    if (Number(row.status) !== 1) { loginFail.add(ip); return { error: { status: 403, msg: '账号已停用，请联系管理员' } } }
    const token = crypto.randomBytes(32).toString('hex')
    q.setToken(store, row.id, token)
    loginFail.ok(ip)
    const rt = deps.runtime
    return {
      data: {
        token,
        user: q.findById(store, row.id),
        runtime: { mode: rt.mode, device_mock: rt.deviceMock, pay_mock: !rt.realPay, login: rt.loginMode(clientKey) }
      }
    }
  }

  // ==================== 用户端：微信登录（不变） ====================
  if (!code) return { error: { status: 400, msg: '缺少登录凭证' } }
  let openid = ''
  const creds = deps.runtime.loginCreds(clientKey)
  if (creds) {
    // 真实微信登录：零栋GO（用户端）
    try {
      const u = 'https://api.weixin.qq.com/sns/jscode2session'
        + '?appid=' + encodeURIComponent(creds.appid)
        + '&secret=' + encodeURIComponent(creds.secret)
        + '&js_code=' + encodeURIComponent(code)
        + '&grant_type=authorization_code'
      const resp = await fetch(u)
      const data = await resp.json()
      if (!data.openid) { loginFail.add(ip); return { error: { status: 401, msg: '微信登录失败：' + (data.errmsg || '未知错误') } } }
      openid = data.openid
    } catch (e) {
      loginFail.add(ip)
      return { error: { status: 500, msg: '登录服务异常' } }
    }
  } else {
    // ==================== 演示模式 ====================
    // 以 code 的稳定哈希作为 openid，同一设备账号稳定，便于预览页面。
    // token 即 openid：可预测、不可吊销，因此 RUN_MODE=production 下启动守卫拒绝这种配置。
    openid = demoOpenid(code)
  }

  let user = q.findByOpenid(store, openid)
  if (!user) {
    // 新用户一律学生（邀请码机制退役后不再存在「凭码升级商家」路径）
    const id = q.create(store, openid, nickname || '微信用户', 'student')
    user = q.findById(store, id)
  } else {
    if (nickname) q.updateNickname(store, user.id, nickname)
    user = q.findById(store, user.id)
  }
  loginFail.ok(ip)
  const rt = deps.runtime
  return {
    data: {
      token: user.openid,
      user,
      runtime: { mode: rt.mode, device_mock: rt.deviceMock, pay_mock: !rt.realPay, login: rt.loginMode(clientKey) }
    }
  }
}

// 购物车列表附折后价（price_now，展示估算；真实金额以 order 域 promotion 权威计算为准）
// 跨域只读：cart 表 JOIN goods 属 user 域已允许的例外；活动价展示逻辑与 goods 域同一份（promotion 服务）。
function cartListWithPrice(store, userId) {
  const rows = q.cartList(store, userId)
  const active = promotion.loadActive(store).filter((a) => a.type === 'discount')
  return rows.map((r) => {
    let sale_price = null
    for (const a of active) {
      if (promotion.goodsInScope(a, r.goods_id)) {
        const d = Number((a._cfg || {}).discount)
        if (d > 0 && d < 1) { sale_price = Math.round(Number(r.price) * d * 100) / 100; break }
      }
    }
    return Object.assign({}, r, { price_now: sale_price || r.price })
  })
}

// 跨域入口：order 域下单成功后删除购物车（只删本次下单包含的商品，P1-6）
// order.service 通过 deps.user 调用，避免直接查 user 域表。
function removeCartItems(store, userId, goodsIds) {
  q.removeCartItems(store, userId, goodsIds)
}

module.exports = { login, clientIp, cartListWithPrice, removeCartItems }
