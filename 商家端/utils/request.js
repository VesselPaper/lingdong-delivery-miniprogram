// 网络请求封装
const config = require('./config')

// 相对资源路径统一转成完整地址（后端上传的 /uploads/xxx）
function normalize(v) {
  if (typeof v === 'string') {
    if (v.indexOf('/uploads/') === 0) return config.baseUrl.replace(/\/api$/, '') + v
    return v
  }
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k in v) o[k] = normalize(v[k])
    return o
  }
  return v
}

function request(options) {
  const { url, method = 'GET', data = {}, needAuth = true, silent = false } = options

  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' }
    const token = wx.getStorageSync('token')
    if (needAuth && token) {
      header.Authorization = 'Bearer ' + token
    }

    wx.request({
      url: config.baseUrl + url,
      method,
      data,
      header,
      success(res) {
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          resolve(normalize(res.data.data))
        } else if (res.statusCode === 401) {
          // 登录失效：清除本地登录态并跳转登录页（不再反复弹提示）
          wx.removeStorageSync('token')
          wx.removeStorageSync('userInfo')
          wx.reLaunch({ url: '/pages/user/login' })
          reject(new Error('登录已失效'))
        } else {
          const msg = (res.data && res.data.msg) || '请求失败'
          if (!silent) wx.showToast({ title: msg, icon: 'none' })
          reject(new Error(msg))
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
  normalize
}
