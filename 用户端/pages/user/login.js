const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    logging: false,
    loginDemo: false // 运行时标注：后端未配用户端微信凭据时按钮显示「模拟登录（演示）」
  },

  onShow() {
    const flags = wx.getStorageSync('runtimeFlags') || {}
    this.setData({ loginDemo: flags.login === 'demo' })
  },

  async wechatLogin() {
    if (this.data.logging) return
    this.setData({ logging: true })
    wx.showLoading({ title: '登录中' })
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject })
      })
      // client 标明用户端：后端用它选「零栋GO」的 appid/secret 走真实 code2session
      const res = await request.post(api.login, { code, client: 'user', nickname: '' })
      wx.setStorageSync('token', res.token)
      wx.setStorageSync('userInfo', res.user)
      wx.setStorageSync('runtimeFlags', res.runtime || {})
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/user/profile', fail: () => wx.navigateBack() })
      }, 500)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '登录失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ logging: false })
      wx.hideLoading()
    }
  }
})
