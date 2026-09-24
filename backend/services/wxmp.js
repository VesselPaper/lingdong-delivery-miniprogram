// 微信小程序服务（小程序码等）：
//   - getAccessToken：WX_APPID + WX_SECRET 换取 access_token（内存缓存，约 7000s 自动续期）
//   - getWxacodeUnlimit：生成「不限制数量的小程序码」（getwxacodeunlimit），微信扫一扫直达小程序页面
// 配置（环境变量，与登录 code2session 同一套用户端凭据，见 services/runtime.js → loginCreds）：
//   WX_APPID / WX_SECRET
// 依赖说明：本文件只依赖 process.env（server.js 的 .env 加载最先执行），不依赖任何域/服务，无成环风险。

const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'
const WXACODE_URL = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit'

// access_token 缓存：有效期 7200s，提前 200s 续期；获取失败保留旧 token 兜底
let tokenCache = { token: '', expireAt: 0 }

function enabled() {
  return !!(WX_APPID && WX_SECRET)
}

// 获取接口调用凭据（access_token），带内存缓存
async function getAccessToken() {
  if (!enabled()) return { ok: false, msg: '未配置 WX_APPID/WX_SECRET' }
  if (tokenCache.token && Date.now() < tokenCache.expireAt) return { ok: true, token: tokenCache.token }

  const url = TOKEN_URL + '?grant_type=client_credential&appid=' + encodeURIComponent(WX_APPID)
    + '&secret=' + encodeURIComponent(WX_SECRET)
  let resp
  try {
    resp = await fetch(url)
  } catch (e) {
    // 网络异常：若还有未过期的旧 token 先用旧 token（平台侧 token 实际有效期比 expires_in 宽裕）
    if (tokenCache.token) return { ok: true, token: tokenCache.token, stale: true }
    return { ok: false, msg: '获取 access_token 网络异常：' + (e && e.message) }
  }
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data.access_token) {
    return { ok: false, msg: '获取 access_token 失败：' + (data.errmsg || data.errcode || resp.status) }
  }
  tokenCache = {
    token: data.access_token,
    expireAt: Date.now() + (Number(data.expires_in || 7200) - 200) * 1000
  }
  return { ok: true, token: data.access_token }
}

// 生成不限制数量的小程序码：微信扫一扫直达 page，scene 在页面 onLoad(options.scene)（需 decodeURIComponent）。
// scene 限制：最长 32 个可见字符，只支持数字、大小写字母以及部分特殊字符（建议只放纯设备号/短码）。
// envVersion：release=正式版（发布后全用户可扫）、trial=体验版（仅体验成员）、develop=开发版（仅开发者）。
async function getWxacodeUnlimit({ scene = '', page = '', envVersion = 'release', width = 430 }) {
  if (!enabled()) return { ok: false, msg: '未配置 WX_APPID/WX_SECRET' }
  if (!scene) return { ok: false, msg: '缺少 scene 参数' }
  if (String(scene).length > 32) return { ok: false, msg: 'scene 超过 32 个可见字符' }

  const at = await getAccessToken()
  if (!at.ok) return at

  const body = {
    scene: String(scene),
    page: String(page || ''),
    check_path: false,
    env_version: String(envVersion || 'release'),
    width: Number(width) || 430
  }
  let resp
  try {
    resp = await fetch(WXACODE_URL + '?access_token=' + encodeURIComponent(at.token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e) {
    return { ok: false, msg: '生成小程序码网络异常：' + (e && e.message) }
  }

  const buf = Buffer.from(await resp.arrayBuffer())
  // 微信接口错误时返回 JSON（{errcode, errmsg}），成功时返回图片二进制。
  // 按 Content-Type 判断：application/json 视为错误，image/* 视为成功。
  const ctype = String(resp.headers.get('content-type') || '')
  if (!resp.ok || ctype.indexOf('image') === -1) {
    let msg = '生成小程序码失败：HTTP ' + resp.status
    try {
      const j = JSON.parse(buf.toString('utf8'))
      if (j && j.errmsg) msg = '生成小程序码失败：' + j.errmsg
    } catch (e) { /* 非 JSON 错误体，保留 HTTP 提示 */ }
    return { ok: false, msg }
  }
  return { ok: true, buffer: buf }
}

module.exports = { enabled, getAccessToken, getWxacodeUnlimit }
