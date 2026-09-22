const shopState = require('../../utils/shopState')

Page({
  data: {
    keyword: '',
    shopOpen: true
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    // 启动（或刚登录）后自动进入「四川师范大学商铺」页；只自动跳一次，
    // 用户从商铺页返回首页后不会再被弹进去（标志由 app.js / 登录页置位）。
    const app = getApp()
    if (app && app.globalData && app.globalData.autoEnterShop) {
      app.globalData.autoEnterShop = false
      wx.navigateTo({ url: '/pages/shop/home' })
    }
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
  },

  lockSort() {
    wx.showToast({ title: '锁定排序功能开发中', icon: 'none' })
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/home' })
  }
})
