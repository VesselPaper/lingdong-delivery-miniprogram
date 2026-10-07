// 环境配置
// 商家端不存放开放物流平台凭据，平台调用由后端完成。

// 后端地址按【小程序环境版本】自动选择，避免每次换网络 / 上线都要手改 IP。
//   develop = 微信开发者工具、真机调试
//   trial   = 体验版（微信后台点「上传」后设为体验版）
//   release = 正式版
//
// ⚠️ 部署到服务器时只需要改两处：
//   1) 把下面的 PROD_BASE 换成你的线上域名（微信要求 https，不能用 IP）
//   2) 微信公众平台 → 开发管理 → 开发设置 → 服务器域名
//      把该域名同时加进「request 合法域名」和「socket 合法域名」（两个都要加）
//      WebSocket 地址由 utils/push.js 自动从 baseUrl 推导（https→wss），无需另配
const PROD_BASE = 'https://请换成你的域名/api'

const BASES = {
  develop: 'http://localhost:3000/api', // 开发者工具模拟器：和后端同机，localhost 永远有效
  trial: PROD_BASE,
  release: PROD_BASE
}

// 真机调试：手机和电脑不是同一台机器，localhost 不通，必须指向电脑的局域网 IP。
// IP 随网络 / DHCP 变化，换了网络先 `ipconfig` 看 WLAN 的 IPv4 地址，再改下面这一行。
BASES.develop = 'http://192.168.70.50:3000/api'   // 2026-10-07 当前 WLAN IP

let envVersion = 'develop'
try {
  envVersion = (wx.getAccountInfoSync().miniProgram.envVersion) || 'develop'
} catch (e) { /* 不在小程序环境时按 develop 处理 */ }

module.exports = {
  baseUrl: BASES[envVersion] || BASES.develop,
  env: envVersion
}
