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
// 批次状态 → 标签 class / 文案
const BATCH_TAG = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }
const BATCH_TEXT = { 0: '组单中', 1: '待上货', 2: '配送中', 3: '已完成', 4: '异常' }
// 底部四分类（待接单/待上货/配送中/待取货）；待上货/配送中/待取货按批次分组展示

Page({
  data: {
    active: 'accept',
    statusFilter: '',   // 从工作台跳转的精确状态过滤（如异常 6）
    orders: [],         // 扁平订单（待接单 / 异常）
    groups: [],         // 按批次分组（待上货 / 配送中 / 待取货）
    keyword: '',
    shopOpen: true
  },
  rawOrders: [],
  rawGroups: [],

  async onShow() {
    await shopState.loadShop()
    this.setData({ shopOpen: shopState.isOpen() })
    this.load()
  },

  onLoad(options) {
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

  // 兼容原生 input（e.detail.value）与 search-box 组件（e.detail 直接为值）
  onSearch(e) {
    const v = (e.detail && e.detail.value !== undefined) ? e.detail.value : e.detail
    this.setData({ keyword: v || '' }, () => this.applyFilter())
  },

  match(o, kw) {
    return (o.order_no || '').toLowerCase().includes(kw) ||
      String(o.daily_seq || '') === kw ||
      (o.landmark_name || '').toLowerCase().includes(kw) ||
      (o.first_name || '').toLowerCase().includes(kw)
  },

  applyFilter() {
    const kw = this.data.keyword.trim().toLowerCase()
    if (this.data.active === 'accept' || this.data.statusFilter !== '') {
      this.setData({ orders: kw ? this.rawOrders.filter((o) => this.match(o, kw)) : this.rawOrders })
    } else {
      this.setData({ groups: kw ? this.rawGroups.filter((g) => g.orders.some((o) => this.match(o, kw))) : this.rawGroups })
    }
  },

  async load() {
    try {
      const qs = this.data.statusFilter !== ''
        ? '?status=' + this.data.statusFilter
        : '?stage=' + (this.data.active || 'accept')
      const orders = await request.get(api.orders + qs)
      const list = orders.map((o) => ({
        ...o,
        payed: Number(o.status) > 0,
        picked: !!o.picked_up_at,
        created_time: formatTime(o.created_at),
        stClass: ST_CLASS[Number(o.status)] || 'gray',
        // 分类文案：按 stage_text 显示（待上货/配送中/待取货），已取则显示「已取」
        displayStatus: o.picked_up_at ? '已取' : (o.stage_text || o.status_text || '')
      }))
      if (this.data.active === 'accept' || this.data.statusFilter !== '') {
        this.rawOrders = list
        this.rawGroups = []
        this.setData({ orders: list, groups: [] }, () => this.applyFilter())
      } else {
        this.rawOrders = []
        this.rawGroups = this.groupByBatch(list)
        this.setData({ orders: [], groups: this.rawGroups }, () => this.applyFilter())
      }
    } catch (e) { /* handled */ }
  },

  // 按批次分组（一车多单：一个批次一个卡面，批次内嵌套多单）
  groupByBatch(list) {
    const map = new Map()
    for (const o of list) {
      const key = o.batch ? (o.batch.batch_no || 'g' + o.batch.daily_seq) : '__none__'
      if (!map.has(key)) {
        const bs = o.batch ? Number(o.batch.status) : -1
        map.set(key, {
          id: key,
          batch_no: o.batch ? o.batch.batch_no : '',
          daily_seq: o.batch ? o.batch.daily_seq : 0,
          status: o.batch ? o.batch.status : null,
          status_text: o.batch ? (BATCH_TEXT[bs] || '') : '未组单',
          statusTagClass: o.batch ? (BATCH_TAG[bs] || 'tag-gray') : 'tag-gray',
          total_orders: 0,
          picked_orders: 0,
          orders: []
        })
      }
      const g = map.get(key)
      g.orders.push(o)
      if (o.picked) g.picked_orders += 1
    }
    const arr = [...map.values()]
    arr.forEach((g) => { g.total_orders = g.orders.length })
    arr.sort((a, b) => {
      if (a.id === '__none__') return 1
      if (b.id === '__none__') return -1
      return Number(b.daily_seq) - Number(a.daily_seq)
    })
    return arr
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/orders/detail?id=' + e.detail.id })
  },
  // 批次分组卡面内点某单 → 进订单详情
  goDetailByOrder(e) {
    const o = e.detail || {}
    if (o && o.id) wx.navigateTo({ url: '/pages/orders/detail?id=' + o.id })
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
  },

  // ---------- 配送异常订单处理 ----------
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
