const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    list: []
  },

  onShow() {
    this.load()
  },

  async load() {
    try {
      const list = await request.get(api.refundList)
      this.setData({ list })
    } catch (e) { /* handled */ }
  },

  goOrder(e) {
    wx.navigateTo({ url: '/pages/order/detail?id=' + e.currentTarget.dataset.order })
  }
})
