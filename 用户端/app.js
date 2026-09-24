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
    // 未登录：自动跳到登录页（登录成功后会 switchTab 回首页，闭环由 login 页处理）。
    // 已登录：冷启动入口固定为首页（pages[0]）；仅补一道保险。
    if (!token) {
      this._goLogin()
    } else {
      this._landOnHomeIfNeeded()
    }
  },

  // 记录离开小程序的时间，用于在 onShow 区分“重新打开”与“快速切回”
  onHide() {
    this._hideAt = Date.now()
  },

  onShow() {
    // 冷启动（首次 onShow）：登录态已在 onLaunch 处理过，无需重复
    if (!this._hideAt) return
    const gap = Date.now() - this._hideAt
    this._hideAt = 0
    // 本次进入距上次离开超过阈值 → 视为“重新打开小程序”；
    // 很快切回（<2.5s，例如在系统层一闪而过）则不打断当前页面。
    if (gap < 2500) return
    // 重新打开时若登录态已丢失（例如被清缓存），同样先回登录页
    if (!wx.getStorageSync('token')) {
      this._goLogin()
      return
    }
    this._goHome()
  },

  // 自动跳登录页：带锁防 onLaunch/onShow 并发叠跳；已是登录页则不重复跳。
  // 登录页非 tabBar 页，必须用 reLaunch（switchTab 会找不到页面）。
  _goLogin() {
    if (this._loginJumping || typeof getCurrentPages !== 'function') return
    this._loginJumping = true
    setTimeout(() => {
      this._loginJumping = false
      const pages = getCurrentPages()
      const cur = pages && pages.length ? pages[pages.length - 1] : null
      if (cur && cur.route === 'pages/user/login') return
      wx.reLaunch({ url: '/pages/user/login', fail: () => undefined })
    }, 0)
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
