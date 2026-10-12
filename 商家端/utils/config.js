// 环境配置
// 商家端不存放开放物流平台凭据，平台调用由后端完成。

// 后端地址按【小程序环境版本】自动选择，避免每次换网络 / 上线都要手改 IP。
//   develop = 微信开发者工具、真机调试
//   trial   = 体验版（微信后台点「上传」后设为体验版）
//   release = 正式版
//
// ⚠️ 地址来源只有两处，换地址只改这里：
//   1) CLOUD_BASE —— 云端后端（现在的正式后端，http + IP）
//   2) PROD_BASE  —— 以后有域名 + 备案 + https 时用；微信的体验版/正式版只认 https 域名
//
// 2026-10-12 起 develop 默认指向【云端后端】，所以 clone 下来**不用改任何地址**就能：
//   · 在微信开发者工具里直接跑
//   · 扫码在手机上预览（开发版，不需要和你电脑在同一个网络）
// 手机预览注意两点：
//   1) 开发者工具里勾上「详情 → 本地设置 → 不校验合法域名」（云地址是 http + IP，微信默认不放行）
//   2) develop 连的是**生产后端**，会连真实无人车；不要拿它下测试单、派测试车
const CLOUD_BASE = 'http://47.108.151.96:3000/api'

// 只想连本机后端（局域网联调）时：把上面那行注释掉，启用下面这行并改成你电脑的 WLAN IPv4；
// 改完**不要提交**这个文件，否则会把云端默认值覆盖掉。
// const CLOUD_BASE = 'http://192.168.1.100:3000/api'

// 以后上域名时把这里换成线上域名，并确保是 https（微信要求）
const PROD_BASE = 'https://请换成你的域名/api'

const BASES = {
  develop: CLOUD_BASE,
  trial: PROD_BASE,
  release: PROD_BASE
}

let envVersion = 'develop'
try {
  envVersion = (wx.getAccountInfoSync().miniProgram.envVersion) || 'develop'
} catch (e) { /* 不在小程序环境时按 develop 处理 */ }

module.exports = {
  baseUrl: BASES[envVersion] || BASES.develop,
  env: envVersion
}
