const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

// 扫码配单结果页（扫码后）：展示匹配到的待接单订单，确认接单
Page({
  data: {
    id: null,
    order: {},
    items: [],
    shopOpen: true,
    loading: true
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) })
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
  },

  async load() {
    try {
      const data = await request.get(api.orderDetail + '?id=' + this.data.id)
      this.setData({ order: data, items: data.items || [], loading: false })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  async confirmOrder() {
    if (!this.data.shopOpen) {
      wx.showToast({ title: '店铺当前歇业中，无法接单', icon: 'none' })
      return
    }
    try {
      await request.post(api.orderConfirm, { id: this.data.id })
      wx.showToast({ title: '已接单，机器人出发', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) { /* handled */ }
  },

  goDetail() {
    wx.redirectTo({ url: '/pages/orders/detail?id=' + this.data.id })
  },

  // 订单号复制
  copyText(e) {
    const text = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.text : ''
    wx.setClipboardData({ data: String(text == null ? '' : text) })
  }
})
