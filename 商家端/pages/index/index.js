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
