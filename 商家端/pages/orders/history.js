const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    orders: [],
    filtered: [],
    keyword: ''
  },

  onShow() {
    this.load()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter())
  },

  applyFilter() {
    const kw = this.data.keyword.trim()
    const filtered = kw
      ? this.data.orders.filter((o) =>
          (o.order_no || '').toLowerCase().includes(kw.toLowerCase()) ||
          (o.landmark_name || '').toLowerCase().includes(kw.toLowerCase()))
      : this.data.orders
    this.setData({ filtered })
  },

  async load() {
    try {
      const orders = await request.get(api.orders + '?status=4')
      // 真实业务：订单状态 0=待支付，status>0 即已支付收款
      const list = orders.map((o) => ({ ...o, payed: Number(o.status) > 0 }))
      this.setData({ orders: list }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.currentTarget.dataset.id })
  },

  openFilter() {
    wx.showToast({ title: '筛选功能开发中', icon: 'none' })
  }
})
