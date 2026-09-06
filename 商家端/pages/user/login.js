const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    merchantCode: '',
    logging: false,
    loginDemo: false // 运行时标注：后端未配商家端微信凭据时按钮显示「模拟登录（演示）」
  },

  onShow() {
    const flags = wx.getStorageSync('runtimeFlags') || {}
    this.setData({ loginDemo: flags.login === 'demo' })
  },

  onCodeInput(e) {
    this.setData({ merchantCode: e.detail.value })
  },

  async wechatLogin() {
    if (this.data.logging) return
    this.setData({ logging: true })
    wx.showLoading({ title: '登录中' })
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject })
      })
      // client 标明商家端：后端用它选「零栋商家」的 appid/secret 走真实 code2session；
      // 不再传 role：服务端不接受客户端自报身份，商家权限只能凭 merchant_code 授予
      const res = await request.post(api.login, {
        code,
        client: 'merchant',
        nickname: '零栋铺子',
        merchant_code: String(this.data.merchantCode || '').trim()
      })
      wx.setStorageSync('token', res.token)
      wx.setStorageSync('userInfo', res.user)
      // 运行模式标志：设备控制（开舱/关舱/派发）走真实还是模拟分支由后端决定，前端不再硬编码
      wx.setStorageSync('runtimeFlags', res.runtime || {})
      wx.hideLoading()
      if (!res.user || res.user.role !== 'merchant') {
        wx.showModal({
          title: '当前不是商家账号',
          content: '请输入店主提供的商家邀请码后重新登录。',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' })
      }, 500)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '登录失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ logging: false })
    }
  }
})
