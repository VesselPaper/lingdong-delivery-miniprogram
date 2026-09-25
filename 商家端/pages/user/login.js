const api = require('../../utils/api')
const request = require('../../utils/request')

// 商家登录（2026-09-24 起）：账号密码（管理员在管理员网页「商家管理」创建，角色店主/店员）。
// 不再走微信一键登录 + 邀请码；身份与权限全部由服务端账号体系决定。
Page({
  data: {
    username: '',
    password: '',
    logging: false,
    showPwd: false
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  // 密码可见性切换：眼睛图标点击后明文/黑点互切（showPwd=true 时 input password=false）
  togglePwd() {
    this.setData({ showPwd: !this.data.showPwd })
  },

  async accountLogin() {
    if (this.data.logging) return
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username || !password) {
      wx.showToast({ title: '请输入用户名和密码', icon: 'none' })
      return
    }
    this.setData({ logging: true })
    wx.showLoading({ title: '登录中' })
    try {
      const res = await request.post(api.login, {
        username,
        password,
        client: 'merchant'
      }, { needAuth: false }) // 登录接口本身免鉴权：未登录时必须发出，否则被 request 拦截永远登不进
      wx.hideLoading()
      // 先校验身份再落盘：非商家账号绝不留下 token，否则下次冷启动会跳过登录页直接进首页，
      // 之后所有 /merchant/* 都 403，用户只看到「无权限」却没有任何路径回登录页。
      if (!res.user || res.user.role !== 'merchant') {
        wx.showModal({
          title: '当前不是商家账号',
          content: '请使用管理员分配的商家账号登录。',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
      wx.setStorageSync('token', res.token)
      wx.setStorageSync('userInfo', res.user)
      // 运行模式标志：设备控制（开舱/关舱/派发）走真实还是模拟分支由后端决定，前端不再硬编码
      wx.setStorageSync('runtimeFlags', res.runtime || {})
      // 登录成功后回首页；并让首页自动进入「四川师范大学商铺」页（与冷启动同一条路径）
      const app = getApp()
      if (app && app.globalData) app.globalData.autoEnterShop = true
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
