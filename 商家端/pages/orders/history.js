const api = require('../../utils/api')
const request = require('../../utils/request')

// 下单时间展示（后端为本地时间 YYYY-MM-DD HH:MM:SS，去掉秒即可，避免时区解析差异）
function formatTime(t) {
  if (!t) return ''
  const s = String(t)
  return s.length >= 16 ? s.slice(0, 16) : s
}

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
      // 历史订单：已完成/已取消/配送异常
      const orders = await request.get(api.orders + '?scope=history')
      // 真实业务：订单状态 0=待支付，status>0 即已支付收款
      const list = orders.map((o) => ({ ...o, payed: Number(o.status) > 0, created_time: formatTime(o.created_at) }))
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
