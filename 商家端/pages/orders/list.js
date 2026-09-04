const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

// 下单时间展示（后端为本地时间 YYYY-MM-DD HH:MM:SS，去掉秒即可，避免时区解析差异）
function formatTime(t) {
  if (!t) return ''
  const s = String(t)
  return s.length >= 16 ? s.slice(0, 16) : s
}

Page({
  data: {
    active: '',
    orders: [],
    filtered: [],
    keyword: '',
    showFilter: false,
    filterTime: '',
    shopOpen: true
  },

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
  },

  onLoad(options) {
    // 支持从工作台跳转指定分类：?tab=1 待接单 / 6 异常 / 5 售后（空=全部当前）
    if (options && options.tab !== undefined && options.tab !== '') {
      this.setData({ active: options.tab })
    }
  },

  onTab(e) {
    this.setData({ active: e.currentTarget.dataset.name })
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
      // 当前任务：全部 tab 只显示执行中的订单（待接单/配送中/等待取餐）；具体 tab 按状态过滤
      const qs = this.data.active !== '' ? '?status=' + this.data.active : '?scope=active'
      const orders = await request.get(api.orders + qs)
      // 真实业务：订单状态 0=待支付，status>0 即已支付收款
      const list = orders.map((o) => ({ ...o, payed: Number(o.status) > 0, created_time: formatTime(o.created_at) }))
      this.setData({ orders: list }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.currentTarget.dataset.id })
  },

  // 模拟扫码配单（测试阶段）：不真扫码，直接进入配单/上货页（一车多单批次流程）
  simulateScan() {
    wx.navigateTo({ url: '/pages/device/loading' })
  },

  openFilter() {
    this.setData({ showFilter: true })
  },

  closeFilter() {
    this.setData({ showFilter: false })
  },

  setFilterTime(e) {
    this.setData({ filterTime: e.currentTarget.dataset.val })
  },

  resetFilter() {
    this.setData({ filterTime: '' })
    this.closeFilter()
  },

  confirmFilter() {
    this.closeFilter()
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
