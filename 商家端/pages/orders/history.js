const api = require('../../utils/api')
const request = require('../../utils/request')

// 下单时间展示（后端为本地时间 YYYY-MM-DD HH:MM:SS，去掉秒即可，避免时区解析差异）
function formatTime(t) {
  if (!t) return ''
  const s = String(t)
  return s.length >= 16 ? s.slice(0, 16) : s
}

// 订单状态 → 文字颜色 class
const ST_CLASS = { 0: 'gray', 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

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
    this.setData({ keyword: e.detail }, () => this.applyFilter())
  },

  applyFilter() {
    const kw = this.data.keyword.trim().toLowerCase()
    const filtered = kw
      ? this.data.orders.filter((o) =>
          (o.order_no || '').toLowerCase().includes(kw) ||
          (o.code_short || '').toLowerCase().includes(kw) ||
          String(o.daily_seq || '') === kw ||
          (o.landmark_name || '').toLowerCase().includes(kw) ||
          (o.items || []).some((it) => (it.goods_name || '').toLowerCase().includes(kw)))
      : this.data.orders
    this.setData({ filtered })
  },

  async load() {
    try {
      // 历史订单：已完成/已取消/配送异常/已退款（后端附带 items 商品明细与所属批次）
      const orders = await request.get(api.orders + '?scope=history')
      const list = orders.map((o) => ({
        ...o,
        payed: Number(o.status) > 0,
        created_time: formatTime(o.created_at),
        stClass: ST_CLASS[Number(o.status)] || 'gray'
      }))
      this.setData({ orders: list }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.currentTarget.dataset.id })
  }
})
