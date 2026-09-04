const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

// 订单状态 → 文字颜色 class
const ST_CLASS = { 0: 'gray', 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

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
        order: Object.assign({}, data, { stClass: ST_CLASS[Number(data.status)] || 'gray' }),
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
        content: '接单后订单并入配送批次（一车最多 12 单），派车后机器人前往门店装载',
        confirmColor: '#2E7CF6',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      const r = await request.post(api.orderConfirm, { id: this.data.id })
      wx.showToast({ title: '已接单', icon: 'success' })
      this.load()
      // 优化流程：接单后直达配单/上货页
      const go = await new Promise((resolve2) => {
        wx.showModal({
          title: '订单已并入配送批次',
          content: '是否立即前往配单页，为批次派车并上货配送？',
          confirmText: '去配单',
          cancelText: '稍后',
          confirmColor: '#2E7CF6',
          success: (r2) => resolve2(r2.confirm)
        })
      })
      if (go) wx.navigateTo({ url: '/pages/device/loading' })
    } catch (e) { /* handled */ }
  },

  goLoad() {
    wx.navigateTo({ url: '/pages/device/loading' })
  },

  // 测试辅助：真实模式无真机器人时，把卡在配送中的订单/整批标记为已送达，用户端可继续取餐完成
  // 若订单在批次内，默认整批标记（一车多单）
  testComplete() {
    console.log('[detail] testComplete clicked, id=' + this.data.id)
    const batch = this.data.order.batch
    const isBatch = batch && Number(batch.total_orders) > 0
    const doComplete = () => {
      wx.showLoading({ title: '标记中' })
      const body = batch && Number(batch.id) ? { batch_id: batch.id, status: 3 } : { order_id: this.data.id, status: 3 }
      request.post(api.deliveryTestComplete, body)
        .then(() => {
          wx.hideLoading()
          wx.showToast({ title: '已标记已送达', icon: 'success' })
          this.load()
        })
        .catch((e) => {
          wx.hideLoading()
          wx.showToast({ title: (e && e.message) || '操作失败', icon: 'none' })
        })
    }
    if (isBatch) {
      wx.showModal({
        title: '标记整批送达',
        content: '本单属于配送批次 ' + batch.batch_no + '（共 ' + batch.total_orders + ' 单），将整批标记为已送达，用户即可取餐。',
        confirmText: '整批送达',
        confirmColor: '#2E7CF6',
        success: (r) => { if (r.confirm) doComplete() }
      })
    } else {
      doComplete()
    }
  }
})
