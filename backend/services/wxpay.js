// 微信支付 V3（JSAPI）服务：统一下单、回调解密。
// 配置（环境变量）：
//   WXPAY_MCHID          商户号
//   WXPAY_SERIAL_NO      商户 API 证书序列号
//   WXPAY_PRIVATE_KEY    商户 API 私钥（PEM 内容，或 PEM 文件路径）
//   WXPAY_APIV3_KEY      APIv3 密钥（32 位）
//   WXPAY_NOTIFY_URL     支付回调地址（公网可达 https）
const crypto = require('crypto')
const fs = require('fs')

const MCHID = process.env.WXPAY_MCHID || ''
const SERIAL = process.env.WXPAY_SERIAL_NO || ''
const API_KEY = process.env.WXPAY_APIV3_KEY || ''
const NOTIFY_URL = process.env.WXPAY_NOTIFY_URL || ''

function loadPrivateKey() {
  let pem = process.env.WXPAY_PRIVATE_KEY || ''
  if (pem && pem.indexOf('-----BEGIN') !== 0) {
    try { pem = fs.readFileSync(pem, 'utf8') } catch (e) { pem = '' }
  }
  return pem
}

function enabled() {
  return !!(MCHID && SERIAL && API_KEY && NOTIFY_URL && loadPrivateKey())
}

function rsaSign(message) {
  const key = loadPrivateKey()
  if (!key) throw new Error('商户私钥未配置')
  return crypto.createSign('RSA-SHA256').update(message).sign(key, 'base64')
}

function authHeader(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000)
  const nonce = crypto.randomBytes(16).toString('hex')
  const message = method + '\n' + urlPath + '\n' + timestamp + '\n' + nonce + '\n' + (body ? JSON.stringify(body) : '') + '\n'
  const signature = rsaSign(message)
  return `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${SERIAL}"`
}

async function jsapiPay({ appid, openid, outTradeNo, description, amountFen }) {
  const urlPath = '/v3/pay/transactions/jsapi'
  const body = {
    appid,
    mchid: MCHID,
    description,
    out_trade_no: outTradeNo,
    notify_url: NOTIFY_URL,
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid }
  }
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader('POST', urlPath, body) },
    body: JSON.stringify(body)
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('微信下单失败：' + (data.message || data.code || resp.status))
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const pkg = 'prepay_id=' + data.prepay_id
  const paySign = rsaSign(appid + '\n' + timeStamp + '\n' + nonceStr + '\n' + pkg + '\n')
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
}

// 回调 resource 解密（AES-256-GCM，APIv3 密钥）
function decryptNotify(resource) {
  const buf = Buffer.from(resource.ciphertext, 'base64')
  const authTag = buf.subarray(buf.length - 16)
  const data = buf.subarray(0, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(API_KEY, 'utf8'), Buffer.from(resource.nonce, 'utf8'))
  decipher.setAuthTag(authTag)
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
  return JSON.parse(decipher.update(data).toString('utf8') + decipher.final('utf8'))
}

// ---------------- 退款（P0-5，凭据就绪后生效） ----------------
async function refund({ outTradeNo, outRefundNo, refundFen, totalFen, reason }) {
  const urlPath = '/v3/refund/domestic/refunds'
  const body = {
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason: reason || '',
    amount: { refund: refundFen, total: totalFen, currency: 'CNY' }
  }
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader('POST', urlPath, body) },
    body: JSON.stringify(body)
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('微信退款失败：' + (data.message || data.code || resp.status))
  return { refund_id: data.refund_id, out_refund_no: data.out_refund_no, status: data.status }
}

async function queryRefund(outRefundNo) {
  const urlPath = '/v3/refund/domestic/refunds/' + encodeURIComponent(outRefundNo)
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    headers: { Authorization: authHeader('GET', urlPath, '') }
  })
  const data = await resp.json()
  return resp.ok ? { ok: true, status: data.status, data } : { ok: false, msg: data.message || '查询退款失败' }
}

// ---------------- 支付回调验签（P0-6，凭据就绪后生效） ----------------
// 平台证书缓存：serial -> { cert, ts }，按官方建议 12h 刷新。
let certCache = new Map()
async function getPlatformCert(serial) {
  const hit = certCache.get(serial)
  if (hit && Date.now() - hit.ts < 12 * 3600 * 1000) return hit.cert
  const urlPath = '/v3/certificates'
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    headers: { Authorization: authHeader('GET', urlPath, '') }
  })
  if (!resp.ok) return null
  const data = await resp.json()
  for (const c of (data.data || [])) {
    try {
      const dec = decryptNotify(c.encrypt_certificate) // 结构与回调 resource 一致（APIv3 key AES-GCM）
      certCache.set(c.serial_no, { cert: dec.certificate, ts: Date.now() })
    } catch (e) { /* 忽略单条证书解析失败 */ }
  }
  return certCache.get(serial) ? certCache.get(serial).cert : null
}

async function verifyNotifySignature(headers, rawBody) {
  try {
    const serial = headers['wechatpay-serial']
    const sig = headers['wechatpay-signature']
    const timestamp = headers['wechatpay-timestamp']
    const nonce = headers['wechatpay-nonce']
    if (!serial || !sig || !timestamp || !nonce) return { ok: false, msg: '缺少验签头' }
    const cert = await getPlatformCert(serial)
    if (!cert) return { ok: false, msg: '平台证书不存在或拉取失败' }
    const message = timestamp + '\n' + nonce + '\n' + rawBody + '\n'
    const verifier = crypto.createVerify('RSA-SHA256')
    verifier.update(message)
    return { ok: verifier.verify(cert, sig, 'base64'), msg: '' }
  } catch (e) {
    return { ok: false, msg: '验签异常：' + e.message }
  }
}

module.exports = { enabled, jsapiPay, decryptNotify, refund, queryRefund, verifyNotifySignature }
