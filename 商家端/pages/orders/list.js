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
      const qs = this.data.active !== '' ? '?status=' + this.data.active : ''
      const orders = await request.get(api.orders + qs)
      // 真实业务：订单状态 0=待支付，status>0 即已支付收款
      const list = orders.map((o) => ({ ...o, payed: Number(o.status) > 0 }))
      this.setData({ orders: list }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.currentTarget.dataset.id })
  },

  scanOrder() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: (res) => this.handleScan(res.result),
      fail: () => { /* 用户取消或扫码失败 */ }
    })
  },

  handleScan(result) {
    if (!result) return
    let orderNo = ''
    let id = null
    try {
      const obj = JSON.parse(result)
      orderNo = obj.no || obj.order_no || ''
      id = obj.id || obj.order_id || null
    } catch (e) {
      orderNo = String(result).trim()
    }
    const matched = this.data.orders.find((o) =>
      (orderNo && o.order_no === orderNo) ||
      (id && String(o.id) === String(id)))
    if (!matched) {
      wx.showToast({ title: '未找到对应订单，请核对二维码', icon: 'none' })
      return
    }
    if (matched.status !== 1) {
      wx.showModal({
        title: '扫码配单',
        content: '订单 ' + matched.order_no + ' 当前状态：' + matched.status_text + '，无需接单',
        showCancel: false,
        confirmColor: '#3078C0'
      })
      return
    }
    if (!this.data.shopOpen) {
      wx.showToast({ title: '店铺当前歇业中，无法接单', icon: 'none' })
      return
    }
    if (shopState.getAutoAccept()) {
      this.doConfirm(matched.id, '自动接单')
      return
    }
    wx.showModal({
      title: '扫码配单',
      content: '匹配到订单 ' + matched.order_no + '（' + matched.status_text + '）\n是否确认接单？',
      confirmColor: '#3078C0',
      success: async (r) => {
        if (!r.confirm) return
        await this.doConfirm(matched.id, '已接单，机器人出发')
      }
    })
  },

  async doConfirm(id, okText) {
    try {
      await request.post(api.orderConfirm, { id: Number(id) })
      wx.showToast({ title: okText, icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
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
