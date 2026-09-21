// 网络请求封装
const config = require('./config')

// 图片地址已由后端统一返回完整 URL（/uploads、/store-img 已拼好主机），前端不再拼接。
// normalize 保留为恒等导出，避免历史引用因删除而崩溃；新代码无需再调用。
function normalize(v) { return v }

function request(options) {
  const { url, method = 'GET', data = {}, needAuth = true } = options

  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' }
    const token = wx.getStorageSync('token')
    if (needAuth && !token) {
      // 未登录：不发请求，直接进登录页（消除未登录时的 401 红字）
      wx.navigateTo({ url: '/pages/user/login' })
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
      success(res) {
        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          resolve(res.data.data)
        } else if (res.statusCode === 401) {
          // 登录失效，跳转登录页
          wx.removeStorageSync('token')
          wx.navigateTo({ url: '/pages/user/login' })
          reject(new Error('登录已失效'))
        } else {
          const body = res.data || {}
          const msg = body.msg || '请求失败'
          wx.showToast({ title: msg, icon: 'none', duration: 3000 })
          const err = new Error(msg)
          err.code = body.code
          err.reason = body.reason
          reject(err)
        }
      },
      fail(err) {
        wx.showToast({ title: '网络异常', icon: 'none' })
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
  normalize
}
