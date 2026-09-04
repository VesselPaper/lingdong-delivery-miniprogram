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
    // 查看订单详情视为已读动态（清除我的页红点）
    request.post(api.orderMarkRead, {}, { silent: true }).catch(() => {})
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
    } catch (e) {
      // 超过免费取消时间：引导提交取消申请
      if (e && e.message && e.message.indexOf('取消申请') > -1) {
        wx.showToast({ title: '已超过免费取消时间，转提交取消申请', icon: 'none' })
        setTimeout(() => this.goCancelRequest(), 600)
      }
    }
  },

  goCancelRequest() {
    wx.navigateTo({ url: '/pages/order/cancelRequest?order_id=' + this.data.id })
  },

  async confirmReceive(code) {
    try {
      await request.post(api.deliveryConfirm, { order_id: this.data.id, scan_code: code || '' })
      wx.showToast({ title: '取餐成功', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  // 模拟扫码取餐（测试阶段）：直接进入取餐页（开舱/取餐/关舱逻辑在取餐页）
  simulatePickup() {
    wx.navigateTo({ url: '/pages/delivery/pickup?order_id=' + this.data.id })
  },

  goTrack() {
    wx.redirectTo({ url: '/pages/delivery/track?order_id=' + this.data.id })
  },

  goRefund() {
    wx.navigateTo({ url: '/pages/order/refund?order_id=' + this.data.id })
  }
})
