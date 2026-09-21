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
    // 冷启动入口已固定为首页（pages[0]）；仅补一道保险。
    this._landOnHomeIfNeeded()
  },

  // 记录离开小程序的时间，用于在 onShow 区分“重新打开”与“快速切回”
  onHide() {
    this._hideAt = Date.now()
  },

  onShow() {
    // 冷启动（首次 onShow）：首页本就在，无需处理
    if (!this._hideAt) return
    const gap = Date.now() - this._hideAt
    this._hideAt = 0
    // 本次进入距上次离开超过阈值 → 视为“重新打开小程序”，回首页；
    // 很快切回（<2.5s，例如在系统层一闪而过）则不打断当前页面。
    if (gap < 2500) return
    this._goHome()
  },

  _landOnHomeIfNeeded() {
    if (this._homeGuarded || typeof getCurrentPages !== 'function') return
    this._homeGuarded = true
    setTimeout(() => {
      if (this._isNotHome()) this._goHome()
    }, 0)
  },

  _isNotHome() {
    const pages = getCurrentPages()
    const cur = pages && pages.length ? pages[pages.length - 1] : null
    return !cur || cur.route !== 'pages/index/index'
  },

  _goHome() {
    if (!this._isNotHome()) return
    wx.switchTab({ url: '/pages/index/index' })
  }
})
