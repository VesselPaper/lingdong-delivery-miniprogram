App({
  globalData: {
    userInfo: null,
    token: null,
    openid: null
  },

  onLaunch() {
    const token = wx.getStorageSync('token')
    const userInfo = wx.getStorageSync('userInfo')
    if (token) {
      this.globalData.token = token
      this.globalData.userInfo = userInfo || null
    } else {
      // 需求4：真实登录门禁 —— 未登录直接进登录页（不做游客模式，与商家端一致）
      wx.reLaunch({ url: '/pages/user/login' })
    }
  }
})
