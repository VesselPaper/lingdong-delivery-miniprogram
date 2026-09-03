const api = require('../../utils/api')
const request = require('../../utils/request')
const pay = require('../../utils/pay')

Page({
  data: {
    id: null,
    order: {},
    items: []
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) })
  },

  onShow() {
    this.load()
  },

  async load() {
    try {
      const data = await request.get(api.orderDetail + '?id=' + this.data.id)
      this.setData({ order: data, items: data.items })
      wx.setNavigationBarTitle({ title: data.status_text })
    } catch (e) { /* handled */ }
  },

  async payOrder() {
    try {
      await pay.payOrder(this.data.id)
      wx.showToast({ title: '支付成功', icon: 'success' })
      this.load()
    } catch (e) {
      if (e.message && e.message !== 'cancel') wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  async cancelOrder() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确定取消该订单？',
        confirmColor: '#111111',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.post(api.orderCancel, { id: this.data.id })
      wx.showToast({ title: '已取消', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  async confirmReceive(code) {
    try {
      await request.post(api.deliveryConfirm, { order_id: this.data.id, scan_code: code || '' })
      wx.showToast({ title: '取餐成功', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  scanPickup() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => this.confirmReceive(res.result),
      fail: () => {}
    })
  },

  inputCode() {
    wx.showModal({
      title: '输入取餐码',
      editable: true,
      placeholderText: '请输入机器人屏幕上的取餐码',
      confirmColor: '#2E7CF6',
      success: (r) => {
        if (r.confirm && r.content) this.confirmReceive(String(r.content).trim())
      }
    })
  },

  goTrack() {
    wx.redirectTo({ url: '/pages/delivery/track?order_id=' + this.data.id })
  }
})
