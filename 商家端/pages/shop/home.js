const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

Page({
  data: {
    stats: { pending: 0, delivering: 0 },
    shopOpen: true
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
  },

  async load() {
    try {
      const stats = await request.get(api.stats)
      this.setData({ stats })
    } catch (e) { /* handled */ }
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/list' })
  },

  // 我的任务四个分类按钮：跳转到对应订单分类（待接单1 / 异常6 / 售后5 / 未完结空=全部当前）
  goOrdersTab(e) {
    const tab = e.currentTarget.dataset.tab || ''
    wx.navigateTo({ url: '/pages/orders/list' + (tab !== '' ? '?tab=' + tab : '') })
  },

  goGoods() {
    wx.navigateTo({ url: '/pages/goods/list' })
  },

  goActivities() {
    wx.navigateTo({ url: '/pages/activity/list' })
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/orders/history' })
  },

  goAfterSale() {
    wx.showToast({ title: '历史售后功能开发中', icon: 'none' })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/shop/settings' })
  },

  goMonitor() {
    wx.navigateTo({ url: '/pages/delivery/monitor' })
  }
})
