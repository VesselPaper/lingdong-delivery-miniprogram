const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  async wechatLogin() {
    wx.showLoading({ title: '登录中' })
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject })
      })
      const res = await request.post(api.login, { code, role: 'merchant', nickname: '零栋铺子' })
      wx.setStorageSync('token', res.token)
      wx.setStorageSync('userInfo', res.user)
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' })
      }, 500)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '登录失败，请稍后重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  }
})
