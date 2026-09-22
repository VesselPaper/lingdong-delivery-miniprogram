App({
  globalData: {
    shopInfo: null,
    token: null,
    // 本次启动是否自动进入「四川师范大学商铺」页：首页 onShow 消费一次后置 false，
    // 这样只有冷启动（或刚登录）会自动跳，用户从商铺页返回首页后不会被再次弹进去。
    autoEnterShop: false
  },

  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
      this.globalData.autoEnterShop = true
    } else {
      // 未登录：跳转登录页（测试阶段点击微信登录直接成功；正式环境走真实微信登录）
      wx.reLaunch({ url: '/pages/user/login' })
    }
  }
})
