const shopState = require('../../utils/shopState')

Page({
  data: {
    business: 'open',
    autoAccept: false
  },

  async onLoad() {
    await shopState.loadShop()
    this.setData({
      business: shopState.getBusiness(),
      autoAccept: shopState.getAutoAccept()
    })
  },

  async setBusiness(e) {
    const val = e.currentTarget.dataset.val
    await shopState.setBusiness(val)
    this.setData({ business: shopState.getBusiness() })
    if (shopState.getBusiness() === 'open') {
      wx.showToast({ title: '已切换为营业，可正常接单', icon: 'none' })
    } else {
      wx.showToast({ title: '已切换为歇业，暂停接单', icon: 'none' })
    }
  },

  async onAutoAccept(e) {
    const val = e.detail.value
    await shopState.setAutoAccept(val)
    this.setData({ autoAccept: shopState.getAutoAccept() })
    wx.showToast({ title: val ? '已开启自动接单' : '已关闭自动接单', icon: 'none' })
  },

  goMonitor() {
    wx.navigateTo({ url: '/pages/delivery/monitor' })
  },

  logout() {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
    wx.showToast({ title: '已退出', icon: 'success' })
    setTimeout(() => {
      wx.reLaunch({ url: '/pages/user/login' })
    }, 500)
  }
})
