// user 域业务逻辑：登录（注册/升级商家，含邀请码方案A + 登录限流）、资料更新、购物车折后价
// 依赖注入：service 函数显式接收 (store, deps)；deps.runtime 提供登录凭据与运行模式。
// 邀请码服务（merchantInvite.js）为共享服务，纯函数 + store 注入，本域直接 require（与 goods 域
// require goodsStats 同款模式，不产生 require 环）。

const crypto = require('crypto')
const q = require('./queries')
const invite = require('../../services/merchantInvite')
const promotion = require('../../services/promotion')

// 登录限流（按来源 IP/端口）：防止对邀请码做暴力试错。
// 内存级、单进程足够；多副本需换 Redis。
const LOGIN_LIMIT = 20
const LOGIN_WIN = 10 * 60 * 1000
const loginFail = {
  _m: new Map(),
  count(ip) { const t = Date.now(), r = this._m.get(ip); return (r && t - r.t < LOGIN_WIN) ? r.c : 0 },
  add(ip) { const t = Date.now(), r = this._m.get(ip); if (!r || t - r.t >= LOGIN_WIN) this._m.set(ip, { t, c: 1 }); else r.c++ },
  ok(ip) { const t = Date.now(), r = this._m.get(ip); if (r && t - r.t < LOGIN_WIN) r.c = Math.max(0, r.c - 2) }
}

// 客户端来源 IP（登录限流键）
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local'
}

// 演示模式 openid = demo_ + sha1(code)（RUN_MODE=production 下启动守卫会拒绝这种配置）
function demoOpenid(code) {
  return 'demo_' + crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 24)
}

// 登录：真实微信 code2session（凭据就绪时）或演示模式。
// 返回 { error: {status, msg} } 或 { data }；HTTP 状态码由 routes 层翻译。
// 商家授权规则（方案A，收紧加固）：
//   - 商家端(client=merchant)：老商家 openid 免码续登；否则必填且校验邀请码 → 403；
//   - 用户端：填了正确邀请码则可凭码升级为商家（填错不报错、保持学生）；
//   - bind=真实登录态（!!creds）：首次使用绑定 openid（一码一微信）；demo 档跳过绑定便于联调。
async function login(store, deps, body, ip) {
  const { code, nickname = '', merchant_code = '', client = 'user' } = body || {}
  if (!code) return { error: { status: 400, msg: '缺少登录凭证' } }
  const clientKey = client === 'merchant' ? 'merchant' : 'user'

  // 限流：失败累计过多则暂时拒绝（防暴力试码）
  if (loginFail.count(ip) >= LOGIN_LIMIT) {
    return { error: { status: 429, msg: '登录尝试过于频繁，请稍后再试' } }
  }

  let openid = ''
  const creds = deps.runtime.loginCreds(clientKey)
  if (creds) {
    // 真实微信登录：零栋GO（用户端）与零栋商家（商家端）是不同小程序，用各自的 appid/secret
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

  // ---------- 邀请码校验 / 商家授权 ----------
  const givenCode = String(merchant_code || '').trim()
  let wantsMerchant = false
  const existingUser = q.findByOpenid(store, openid)

  if (client === 'merchant') {
    if (existingUser && existingUser.role === 'merchant') {
      // 已是商家的老用户不必每次输码（身份=该微信账号，复用既有授权）
      wantsMerchant = true
    } else {
      if (!givenCode) { loginFail.add(ip); return { error: { status: 403, msg: '请填写商家邀请码' } } }
      const v = invite.verify(store, givenCode, openid, !!creds)
      if (!v.ok) { loginFail.add(ip); return { error: { status: 403, msg: invite.message(v.reason) } } }
      wantsMerchant = true
    }
  } else {
    // 用户端：填了正确邀请码则可凭码升级为商家（不允许越权声明）
    if (givenCode && invite.verify(store, givenCode, openid, !!creds).ok) {
      wantsMerchant = true
    }
  }

  let user = existingUser
  if (!user) {
    // 新注册：只有持正确邀请码才成为商家
    const id = q.create(store, openid, nickname || '微信用户', wantsMerchant ? 'merchant' : 'student')
    user = q.findById(store, id)
  } else {
    if (nickname) q.updateNickname(store, user.id, nickname)
    // 已是商家的老用户不必每次输码；持正确邀请码则可把学生升级为商家
    if (wantsMerchant && user.role !== 'merchant') {
      q.upgradeToMerchant(store, user.id)
      console.log(`[auth] 用户 ${user.id} 凭邀请码升级为商家`)
    }
    user = q.findById(store, user.id)
  }
  loginFail.ok(ip)
  // runtime 标志随登录下发：商家端据此决定设备控制走真实还是模拟分支（不再前端硬编码）
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
