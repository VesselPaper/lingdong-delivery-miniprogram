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
      // 取餐超时提示（商家运营视角）：已送达(3)未取时按阶段给文案
      const st = Number(data.status)
      const pickupHint = (st === 3 && !data.picked_up_at)
        ? (data.picking_up_at ? '用户正在取餐（舱门已打开）'
          : Number(data.pickup_timeout_stage) === 1 ? '取餐超时：先送其他单，稍后返回，再等 15 分钟'
          : Number(data.pickup_timeout_stage) === 2 ? '已返回再等，即将取消退款，请留意'
          : '')
        : ''
      this.setData({
        order: Object.assign({}, data, { stClass: ST_CLASS[Number(data.status)] || 'gray' }),
        items: data.items,
        payed: data.status > 0,
        pickupHint
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
      wx.showToast({ title: '已接单，并入批次 ' + (r.batch_no || ''), icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  // 订单编号 / 批次号复制
  copyText(e) {
    const text = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.text : ''
    wx.setClipboardData({ data: String(text == null ? '' : text) })
  }
})
