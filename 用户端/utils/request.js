// 网络请求封装
const config = require('./config')

// 图片地址已由后端统一返回完整 URL（/uploads、/store-img 已拼好主机），前端不再拼接。
// normalize 保留为恒等导出，避免历史引用因删除而崩溃；新代码无需再调用。
function normalize(v) { return v }

// 退出登录 / 登录失效的统一清理清单：
// userInfo 是后端 users 表整行（含 openid、手机号），last_confirm 含收餐人姓名/电话/备注 ——
// 不清干净等于把个人信息留在本机缓存里（合规问题），换人登录还会看到上一位用户的状态。
const SESSION_KEYS = [
  'token', 'userInfo', 'runtimeFlags', 'last_confirm', 'checkout_items', 'user_point',
  'search_history', 'order_tab', 'goods_category', 'goods_keyword', 'goods_focus'
]

function clearLoginState() {
  SESSION_KEYS.forEach((k) => { try { wx.removeStorageSync(k) } catch (e) { /* 忽略 */ } })
  try {
    const app = getApp()
    if (app && app.globalData) { app.globalData.token = null; app.globalData.userInfo = null }
  } catch (e) { /* 忽略 */ }
}

// 登录页跳转锁：首页/商城 onShow 会并发发多个请求，每个失败分支各跳一次会叠出多层登录页，
// 从登录页返回后又触发新一轮（页面栈满 10 层后报 page limit exceeded）。这里保证同一时间只跳一次。
let redirecting = false
function toLogin() {
  if (redirecting) return
  // 当前已在登录页（例如 app 层已 reLaunch 过去）则不再重复跳，避免叠层
  try {
    const pages = getCurrentPages()
    const cur = pages && pages.length ? pages[pages.length - 1] : null
    if (cur && cur.route === 'pages/user/login') return
  } catch (e) { /* 忽略 */ }
  redirecting = true
  wx.navigateTo({
    url: '/pages/user/login',
    complete: () => setTimeout(() => { redirecting = false }, 800)
  })
}

function request(options) {
  const { url, method = 'GET', data = {}, needAuth = true, silent = false } = options

  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' }
    const token = wx.getStorageSync('token')
    if (needAuth && !token) {
      // 未登录：不发请求，直接进登录页（消除未登录时的 401 红字）
      toLogin()
      reject(new Error('请先登录'))
      return
    }
    if (needAuth && token) {
      header.Authorization = 'Bearer ' + token
    }

    wx.request({
      url: config.baseUrl + url,
      method,
      data,
      header,
      timeout: 10000,   // 默认 60s 太长：弱网下结算页会白屏一分钟且无法操作
      success(res) {
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          resolve(res.data.data)
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          // 登录失效 / 无权限：清登录态回登录页。
          // 403 必须同等处理，否则商家身份失效等场景会永久卡在「无权限」而无路可回。
          clearLoginState()
          toLogin()
          const msg = (res.data && res.data.msg) || (res.statusCode === 401 ? '登录已失效' : '无权限')
          if (res.statusCode === 403 && !silent) wx.showToast({ title: msg, icon: 'none', duration: 3000 })
          const err = new Error(msg)
          err.code = res.statusCode
          reject(err)
        } else {
          const body = res.data || {}
          const msg = body.msg || '请求失败'
          // silent：轮询类请求（配送追踪每 3 秒一次）失败时不弹提示，否则断网时会刷屏
          if (!silent) wx.showToast({ title: msg, icon: 'none', duration: 3000 })
          const err = new Error(msg)
          err.code = body.code
          err.reason = body.reason
          reject(err)
        }
      },
      fail(err) {
        if (!silent) wx.showToast({ title: '网络异常', icon: 'none' })
        reject(err)
      }
    })
  })
}

module.exports = {
  get(url, data, options) {
    return request({ url, data, method: 'GET', ...options })
  },
  post(url, data, options) {
    return request({ url, data, method: 'POST', ...options })
  },
  put(url, data, options) {
    return request({ url, data, method: 'PUT', ...options })
  },
  del(url, data, options) {
    return request({ url, data, method: 'DELETE', ...options })
  },
  normalize,
  clearLoginState
}
