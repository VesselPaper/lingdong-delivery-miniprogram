const api = require('../../utils/api')
const request = require('../../utils/request')
const pay = require('../../utils/pay')

Page({
  data: {
    active: '',
    orders: []
  },

  onShow() {
    const tab = wx.getStorageSync('order_tab')
    if (tab !== '' && tab !== undefined && tab !== null) {
      wx.removeStorageSync('order_tab')
      this.setData({ active: String(tab) })
    }
    this.loadOrders()
  },

  onTab(e) {
    this.setData({ active: e.currentTarget.dataset.name })
    this.loadOrders()
  },

  async loadOrders() {
    try {
      const qs = this.data.active !== '' ? '?status=' + this.data.active : ''
      const list = await request.get(api.orderList + qs)
      const orders = await this.decorate(list)
      this.setData({ orders })
    } catch (e) { /* handled */ }
  },

  async decorate(list) {
    const out = []
    for (const o of list) {
      const detail = await request.get(api.orderDetail + '?id=' + o.id)
      const itemCount = detail.items.reduce((s, it) => s + it.quantity, 0)
      const first = detail.items[0] || {}
      out.push(Object.assign({}, o, {
        item_count: itemCount,
        first_name: first.goods_name || '',
        first_qty: first.quantity || 0,
        first_image: first.goods_image || ''
      }))
    }
    return out
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/order/detail?id=' + e.currentTarget.dataset.id })
  },

  async payOrder(e) {
    const order = this.data.orders.find((o) => o.id === Number(e.currentTarget.dataset.id))
    const id = order ? order.id : Number(e.currentTarget.dataset.id)
    try {
      await pay.payOrder(id)
      wx.showToast({ title: '支付成功', icon: 'success' })
      this.loadOrders()
    } catch (err) {
      if (err.message && err.message !== 'cancel') wx.showToast({ title: err.message, icon: 'none' })
    }
  },

  async cancelOrder(e) {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确定取消该订单？',
        confirmColor: '#2E7CF6',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.post(api.orderCancel, { id: Number(e.currentTarget.dataset.id) })
      wx.showToast({ title: '已取消', icon: 'success' })
      this.loadOrders()
    } catch (err) { /* handled */ }
  }
})
