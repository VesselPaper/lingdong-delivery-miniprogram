const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')

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
      const list = orders.map((o) => ({ ...o, payed: Number(o.status) > 0 }))
      this.setData({ orders: list }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.currentTarget.dataset.id })
  },

  // 模拟扫码配单：不真扫码，从待接单订单里选一单，跳转扫码配单结果页确认接单
  simulateScan() {
    const pending = this.data.orders.filter((o) => o.status === 1)
    if (!pending.length) {
      wx.showToast({ title: '暂无待接单订单', icon: 'none' })
      return
    }
    const pick = (m) => wx.navigateTo({ url: '/pages/orders/scanMatch?id=' + m.id })
    if (pending.length === 1) {
      pick(pending[0])
      return
    }
    wx.showActionSheet({
      itemList: pending.map((o) => o.order_no + ' ' + (o.landmark_name || '')),
      success: (r) => pick(pending[r.tapIndex])
    })
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
        content: '接单后机器人将前往门店装载餐品并配送',
        confirmColor: '#3078C0',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.post(api.orderConfirm, { id })
      wx.showToast({ title: '已接单，机器人出发', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  }
})
