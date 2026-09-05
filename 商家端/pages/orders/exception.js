const api = require('../../utils/api')
const request = require('../../utils/request')

function formatTime(t) {
  if (!t) return ''
  const s = String(t)
  return s.length >= 16 ? s.slice(0, 16) : s
}

const ST_CLASS = { 0: 'gray', 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

// 配送异常订单独立页：分类（全部/待处理/已处理）+ 搜索 + 处理操作（重新配送/取消并退款）
Page({
  data: {
    active: 'pending', // pending 待处理 / done 已处理 / all 全部
    list: [],
    filtered: [],
    keyword: ''
  },
  rawList: [],

  onShow() {
    this.load()
  },

  onTab(e) {
    this.setData({ active: e.currentTarget.dataset.name })
    this.load()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail }, () => this.applyFilter())
  },

  applyFilter() {
    const kw = this.data.keyword.trim().toLowerCase()
    const filtered = kw
      ? this.rawList.filter((o) =>
          (o.order_no || '').toLowerCase().includes(kw) ||
          String(o.daily_seq || '') === kw ||
          (o.landmark_name || '').toLowerCase().includes(kw) ||
          (o.first_name || '').toLowerCase().includes(kw))
      : this.rawList
    this.setData({ filtered })
  },

  async load() {
    try {
      const list = await request.get(api.orderExceptionList, { tab: this.data.active }, { silent: true })
      this.rawList = list.map((o) => ({
        ...o,
        payed: Number(o.status) > 0,
        created_time: formatTime(o.created_at),
        stClass: ST_CLASS[Number(o.status)] || 'gray'
      }))
      this.setData({ list: this.rawList }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.currentTarget.dataset.id })
  },

  async retryOrder(e) {
    const id = Number(e.currentTarget.dataset.id)
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '重新配送该订单？',
        content: '作废旧批次任务，订单将并入新的组单中批次，派车后重新上货配送。',
        confirmText: '重新配送',
        cancelText: '取消',
        confirmColor: '#3078C0',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      const r = await request.post(api.orderExceptionRetry, { order_id: id })
      wx.showToast({ title: r.msg || '已重新并入批次', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  async refundOrder(e) {
    const id = Number(e.currentTarget.dataset.id)
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '取消订单并退款？',
        content: '将取消该异常订单并原路退款，回补商品库存。',
        confirmText: '取消并退款',
        cancelText: '取消',
        confirmColor: '#E64340',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      const r = await request.post(api.orderExceptionRefund, { order_id: id })
      wx.showToast({ title: r.msg || '已退款', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  }
})
