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
    }
    // 不再强制跳登录页：未登录可浏览（首页/商城等公开接口），
    // 需要登录的操作（下单/取餐/我的页头像区）会引导去登录页。
  }
})
