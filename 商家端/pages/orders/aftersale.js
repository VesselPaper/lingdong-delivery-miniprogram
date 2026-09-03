const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    list: [],
    active: '' // '' 全部 / 0 待处理 / 3 已退款 / 2 已拒绝 / 4 已处理
  },

  onShow() {
    this.load()
  },

  onTab(e) {
    this.setData({ active: e.currentTarget.dataset.name })
    this.load()
  },

  async load() {
    try {
      const qs = this.data.active !== '' ? '?status=' + this.data.active : ''
      const list = await request.get(api.refunds + qs, {}, { silent: true })
      this.setData({ list })
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/aftersaleDetail?id=' + e.currentTarget.dataset.id })
  }
})
