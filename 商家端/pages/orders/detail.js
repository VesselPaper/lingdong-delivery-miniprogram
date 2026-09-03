const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

Page({
  data: {
    id: null,
    order: {},
    items: [],
    payed: false,
    shopOpen: true
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
      this.setData({
        order: data,
        items: data.items,
        payed: data.status > 0
      })
    } catch (e) { /* handled */ }
  },

  async confirmOrder() {
    if (!this.data.shopOpen) {
      wx.showToast({ title: '店铺当前歇业中，无法接单', icon: 'none' })
      return
    }
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确认接单',
        content: '确认后将创建配送任务，机器人前往门店装载',
        confirmColor: '#2E7CF6',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.post(api.orderConfirm, { id: this.data.id })
      wx.showToast({ title: '已接单', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  back() {
    wx.navigateBack()
  },

  goLoad() {
    wx.navigateTo({ url: '/pages/device/loading' })
  }
})
