const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

Page({
  data: {
    stats: { pending: 0, delivering: 0 },
    shopOpen: true,
    pendingBatchCount: 0
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
    this.loadPendingBatches()
  },

  // 待上货/组单中批次数量（配单入口角标）
  async loadPendingBatches() {
    try {
      const data = await request.get(api.devicePending, {}, { silent: true })
      const cnt = ((data.open_batches || []).length + (data.ready_batches || []).length)
      this.setData({ pendingBatchCount: cnt })
    } catch (e) { /* 忽略 */ }
  },

  // 去配单 / 上货（一车多单批次页）
  goLoading() {
    wx.navigateTo({ url: '/pages/device/loading' })
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

  goCancelRequests() {
    wx.navigateTo({ url: '/pages/orders/cancelRequests' })
  },

  goAfterSale() {
    wx.navigateTo({ url: '/pages/orders/aftersale' })
  },

  goAftersale() {
    wx.navigateTo({ url: '/pages/orders/aftersale' })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/shop/settings' })
  },

  goMonitor() {
    wx.navigateTo({ url: '/pages/delivery/monitor' })
  }
})
