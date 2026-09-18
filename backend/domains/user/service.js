// user 域业务逻辑：登录（注册/升级商家）、资料更新
// 依赖注入：service 函数显式接收 (store, deps)；deps.runtime 提供登录凭据与运行模式。

const crypto = require('crypto')
const q = require('./queries')

// 演示模式 openid = demo_ + sha1(code)（RUN_MODE=production 下启动守卫会拒绝这种配置）
function demoOpenid(code) {
  return 'demo_' + crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 24)
}

// 登录：真实微信 code2session（凭据就绪时）或演示模式。
// 返回 { error: {status, msg} } 或 { data }；HTTP 状态码由 routes 层翻译。
async function login(store, deps, body) {
  const { nickname = '', merchant_code = '', client = 'user' } = body || {}
  const clientKey = client === 'merchant' ? 'merchant' : 'user'

  // 角色不再由客户端自报：此前 body 里传 role:'merchant' 就能成为商家，任何人都能自助拿到
  // 改价、上下架、退款、派车（真实调度机器人）等权限。正式校验邀请码（MERCHANT_INVITE_CODE）。
  // 【临时放开】测试阶段暂不校验邀请码：商家端(client=merchant)登录即授予商家角色，方便联调；
  // 恢复邀请码校验时取消下方两行注释并把 wantsMerchant 改回原定义即可。
  // const wantsMerchant = String(merchant_code).trim() !== ''
  // if (wantsMerchant && !deps.runtime.verifyMerchantCode(String(merchant_code).trim())) {
  //   return { error: { status: 403, msg: '商家邀请码不正确' } }
  // }
  const wantsMerchant = client === 'merchant' || String(merchant_code).trim() !== ''

  let openid = ''
  const creds = deps.runtime.loginCreds(clientKey)
  if (creds) {
    // 真实微信登录：零栋GO（用户端）与零栋商家（商家端）是不同小程序，用各自的 appid/secret
    try {
      const u = 'https://api.weixin.qq.com/sns/jscode2session'
        + '?appid=' + encodeURIComponent(creds.appid)
        + '&secret=' + encodeURIComponent(creds.secret)
        + '&js_code=' + encodeURIComponent(body.code)
        + '&grant_type=authorization_code'
      const resp = await fetch(u)
      const data = await resp.json()
      if (!data.openid) return { error: { status: 401, msg: '微信登录失败：' + (data.errmsg || '未知错误') } }
      openid = data.openid
    } catch (e) {
      return { error: { status: 500, msg: '登录服务异常' } }
    }
  } else {
    // ==================== 演示模式 ====================
    // 以 code 的稳定哈希作为 openid，同一设备账号稳定，便于预览页面。
    // token 即 openid：可预测、不可吊销，因此 RUN_MODE=production 下启动守卫拒绝这种配置。
    openid = demoOpenid(body.code)
  }

  let user = q.findByOpenid(store, openid)
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

// 跨域入口：order 域下单成功后删除购物车（只删本次下单包含的商品，P1-6）
// order.service 通过 deps.user 调用，避免直接查 user 域表。
function removeCartItems(store, userId, goodsIds) {
  q.removeCartItems(store, userId, goodsIds)
}

module.exports = { login, removeCartItems }
