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
  }
})
