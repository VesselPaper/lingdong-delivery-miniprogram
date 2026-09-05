const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

Page({
  data: {
    stats: { pending: 0, ready_load: 0, delivering: 0, pickup: 0, exception: 0, aftersale: 0, cancel_requests: 0 },
    shopOpen: true,
    pendingBatchCount: 0
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
    this.loadPendingBatches()
  },

  // 待上货/组单中批次数量（底部「配单上货」按钮角标）
  async loadPendingBatches() {
    try {
      const data = await request.get(api.devicePending, {}, { silent: true })
      const cnt = ((data.open_batches || []).length + (data.ready_batches || []).length)
      this.setData({ pendingBatchCount: cnt })
    } catch (e) { /* 忽略 */ }
  },

  // 底部圆形按钮 / 主面板「待上货」：进入上货操作页（一车多单批次页）
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

  // 主面板分类跳转：待接单/待取货走任务页 stage 过滤，异常走状态过滤
  goOrdersTab(e) {
    const tab = e.currentTarget.dataset.tab || ''
    wx.navigateTo({ url: '/pages/orders/list' + (tab !== '' ? '?tab=' + tab : '') })
  },

  goOrdersStage(e) {
    const stage = e.currentTarget.dataset.stage || 'accept'
    wx.navigateTo({ url: '/pages/orders/list?stage=' + stage })
  },

  // 主面板「待取货」：任务页待取货分类
  goPickup() {
    wx.navigateTo({ url: '/pages/orders/list?stage=pickup' })
  },

  // 主面板「异常」：独立异常订单页（可分类/搜索/处理）
  goException() {
    wx.navigateTo({ url: '/pages/orders/exception' })
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
