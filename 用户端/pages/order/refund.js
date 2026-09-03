const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    orderId: null,
    order: {},
    type: 'refund', // refund 退款 / complaint 投诉
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

  selectType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
  },

  onReason(e) {
    this.setData({ reason: e.detail.value })
  },

  async submit() {
    const reason = this.data.reason.trim()
    if (!reason) return wx.showToast({ title: '请填写申请原因', icon: 'none' })
    wx.showLoading({ title: '提交中' })
    try {
      await request.post(api.refundApply, { order_id: this.data.orderId, type: this.data.type, reason })
      wx.hideLoading()
      wx.showToast({ title: '已提交，等待商家处理', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    }
  }
})
