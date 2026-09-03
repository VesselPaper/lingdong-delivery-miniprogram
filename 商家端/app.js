App({
  globalData: {
    shopInfo: null,
    token: null
  },

  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
    } else {
      // 未登录：跳转登录页（测试阶段点击微信登录直接成功；正式环境走真实微信登录）
      wx.reLaunch({ url: '/pages/user/login' })
    }
  }
})
