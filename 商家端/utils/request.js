// 网络请求封装
const config = require('./config')

// 图片地址已由后端统一返回完整 URL（/uploads、/store-img 已拼好主机），商家端不再拼接。
// normalize 保留为恒等导出，避免历史引用因删除而崩溃；新代码无需再调用。
function normalize(v) { return v }

// 退出登录 / 登录失效的统一清理清单：
// userInfo 含手机号等个人信息；runtimeFlags / shopInfo 是本地缓存 —— 店员手机常共用，
// 不清干净会让换人登录后的工作台先显示上一位商家的营业状态、自动接单开关与配送费。
// WebSocket 也带着上一位商家的 token 连着，必须一起断开。
const SESSION_KEYS = ['token', 'userInfo', 'runtimeFlags', 'shopInfo']

function clearLoginState() {
  SESSION_KEYS.forEach((k) => { try { wx.removeStorageSync(k) } catch (e) { /* 忽略 */ } })
  try {
    const app = getApp()
    if (app && app.globalData) { app.globalData.token = null; app.globalData.userInfo = null }
  } catch (e) { /* 忽略 */ }
  try { require('./push').destroy() } catch (e) { /* 忽略 */ }
}

function request(options) {
  const { url, method = 'GET', data = {}, needAuth = true, silent = false } = options

  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' }
    const token = wx.getStorageSync('token')
    if (needAuth && !token) {
      // 未登录：不发请求，直接进登录页（消除未登录时的 401 红字）
      wx.reLaunch({ url: '/pages/user/login' })
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
      timeout: 15000,   // 默认 60s 太长：配送监控每 5 秒一轮，弱网下会堆积悬挂请求且界面像卡死
      success(res) {
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          resolve(res.data.data)
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          // 登录失效 / 不是商家身份：清登录态并回登录页。
          // 403 必须同等处理 —— 否则非商家账号一旦登录就永久卡在「无权限」，没有任何路径回登录页。
          clearLoginState()
          const msg = (res.data && res.data.msg) || (res.statusCode === 401 ? '登录已失效' : '当前账号不是商家')
          if (res.statusCode === 403) wx.showToast({ title: msg, icon: 'none', duration: 3000 })
          wx.reLaunch({ url: '/pages/user/login' })
          const err = new Error(msg)
          err.code = res.statusCode
          reject(err)
        } else {
          const body = res.data || {}
          const msg = body.msg || '请求失败'
          // 提示停留久一点（默认 1.5s 用户看不完），统一 3s
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
  get(url, data, options) { return request({ url, data, method: 'GET', ...options }) },
  post(url, data, options) { return request({ url, data, method: 'POST', ...options }) },
  put(url, data, options) { return request({ url, data, method: 'PUT', ...options }) },
  del(url, data, options) { return request({ url, data, method: 'DELETE', ...options }) },
  normalize,
  clearLoginState
}
