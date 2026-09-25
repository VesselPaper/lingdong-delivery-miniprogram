// 未登录强制跳登录页（2026-09-24 加固：多入口兜底，防开发者工具/真机启动竞态）
// 背景：app.js onLaunch 的 reLaunch 在部分启动路径（开发者工具恢复页面栈、真机冷启动）下会被吞，
// 首页又允许游客浏览（商品/楼栋接口 needAuth=false），导致未登录停在首页。现各 tabBar 页
// onShow 开头调用 ensureLogin()：未登录 → reLaunch 登录页（清页面栈，登录后回首页/扫码回跳），
// 已登录/已在登录页 → 直接放行（返回 false）。
function ensureLogin() {
  let token = ''
  try { token = wx.getStorageSync('token') } catch (e) { /* 忽略 */ }
  if (token) return false
  try {
    const pages = getCurrentPages()
    const cur = pages && pages.length ? pages[pages.length - 1] : null
    if (cur && cur.route === 'pages/user/login') return false
  } catch (e) { /* 忽略 */ }
  wx.reLaunch({ url: '/pages/user/login', fail: () => undefined })
  return true
}

module.exports = { ensureLogin }
