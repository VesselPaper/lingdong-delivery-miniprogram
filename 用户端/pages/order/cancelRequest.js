const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    orderId: null,
    order: {},
    reason: ''
  },

  onLoad(options) {
    this.setData({ orderId: Number(options.order_id || 0) })
    this.load()
  },

  async load() {
    try {
      const data = await request.get(api.orderDetail + '?id=' + this.data.orderId)
      this.setData({ order: data })
    } catch (e) { /* handled */ }
  },

  onReason(e) {
    this.setData({ reason: e.detail.value })
  },

  async submit() {
    const reason = this.data.reason.trim()
    if (!reason) return wx.showToast({ title: '请填写取消原因', icon: 'none' })
    wx.showLoading({ title: '提交中' })
    try {
      await request.post(api.cancelRequest, { order_id: this.data.orderId, reason })
      wx.hideLoading()
      wx.showToast({ title: '已提交，等待商家处理', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    }
  },

  // 订单号复制
  copyText(e) {
    const text = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.text : ''
    wx.setClipboardData({ data: String(text == null ? '' : text) })
  }
})
