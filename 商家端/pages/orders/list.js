const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

// 下单时间展示（后端为本地时间 YYYY-MM-DD HH:MM:SS，去掉秒即可，避免时区解析差异）
function formatTime(t) {
  if (!t) return ''
  const s = String(t)
  return s.length >= 16 ? s.slice(0, 16) : s
}

// 订单状态 → 文字颜色 class（不同状态不同颜色）
const ST_CLASS = { 0: 'gray', 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

Page({
  data: {
    active: 'accept',   // 底部四分类：accept 待接单 / load 待上货 / deliver 待配送 / pickup 待取货
    statusFilter: '',   // 从工作台跳转的精确状态过滤（如异常 6）
    orders: [],
    filtered: [],
    keyword: '',
    shopOpen: true
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
  },

  onLoad(options) {
    // 支持：?stage=accept|load|deliver|pickup（底部四分类）/ ?tab=状态号（如异常 6）
    if (options && options.stage) {
      this.setData({ active: options.stage })
    } else if (options && options.tab !== undefined && options.tab !== '') {
      this.setData({ statusFilter: String(options.tab), active: '' })
    }
  },

  onStage(e) {
    this.setData({ active: e.currentTarget.dataset.stage, statusFilter: '' })
    this.load()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter())
  },

  applyFilter() {
    const kw = this.data.keyword.trim().toLowerCase()
    const filtered = kw
      ? this.data.orders.filter((o) =>
          (o.order_no || '').toLowerCase().includes(kw) ||
          String(o.daily_seq || '') === kw ||
          (o.landmark_name || '').toLowerCase().includes(kw) ||
          (o.first_name || '').toLowerCase().includes(kw))
      : this.data.orders
    this.setData({ filtered })
  },

  async load() {
    try {
      const qs = this.data.statusFilter !== ''
        ? '?status=' + this.data.statusFilter
        : '?stage=' + (this.data.active || 'accept')
      const orders = await request.get(api.orders + qs)
      // 真实业务：订单状态 0=待支付，status>0 即已支付收款
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
  },

  // 右上角「配单上货」：进入配单/上货页（一车多单批次流程）
  goLoading() {
    wx.navigateTo({ url: '/pages/device/loading' })
  },

  async confirmOrder(e) {
    if (!this.data.shopOpen) {
      wx.showToast({ title: '店铺当前歇业中，无法接单', icon: 'none' })
      return
    }
    const id = Number(e.currentTarget.dataset.id)
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确认接单',
        content: '接单后订单并入配送批次（一车最多 12 单），派车后机器人前往门店装载配送',
        confirmColor: '#3078C0',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      const r = await request.post(api.orderConfirm, { id })
      wx.showToast({ title: '已接单，并入批次 ' + (r.batch_no || ''), icon: 'success' })
      this.load()
      // 优化流程：接单后直达配单/上货页，免去「任务→商品→扫码配单」多步操作
      const go = await new Promise((resolve2) => {
        wx.showModal({
          title: '订单已并入配送批次',
          content: '是否立即前往配单页，为批次派车并上货配送？',
          confirmText: '去配单',
          cancelText: '稍后',
          confirmColor: '#3078C0',
          success: (r2) => resolve2(r2.confirm)
        })
      })
      if (go) wx.navigateTo({ url: '/pages/device/loading' })
    } catch (e) { /* handled */ }
  }
})
