const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')

// 订单异常管理（店长专用；2026-10-12 起，订单清理能力从「订单详情/批次详情」收口到这里）
// 入口在商铺设置页（不进首页常用功能图标区，避免店员误触）。
// 清理一个订单/批次时后端会：驳回正在进行的任务、付过钱就真实退款、摘批次回补库存，
// 用户端显示「订单异常（已取消/已退款）」，不暴露"管理员删除"。
// 可清理口径：订单 0待支付/1待接单/2配送中/3已送达/6配送异常（4已完成/5已取消/7已退款是终态）；
//            批次 0组单中/1待上货/2配送中（3已完成/4已取消是终态）。
const ORDER_CLEARABLE = [0, 1, 2, 3, 6]
const BATCH_CLEARABLE = [0, 1, 2]
const ORDER_ST_CLASS = { 0: 'gray', 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

Page({
  data: {
    isOwner: false,
    tab: 'order',          // order | batch
    orders: [],
    batches: [],
    loading: false
  },

  onLoad() {
    if (!role.isOwner()) {
      wx.showModal({ title: '无权限', content: '订单异常管理仅店长可用', showCancel: false, confirmText: '知道了' })
      return
    }
    this.setData({ isOwner: true })
  },

  onShow() {
    if (this.data.isOwner) this.loadAll()
  },

  async loadAll() {
    this.setData({ loading: true })
    await Promise.all([this.loadOrders(), this.loadBatches()])
    this.setData({ loading: false })
  },

  // 订单列表：取全量订单，前端按可清理口径过滤（异常/垃圾订单都在这）
  async loadOrders() {
    try {
      const list = await request.get(api.orders, {}, { silent: true })
      const clearable = (list || []).filter((o) => ORDER_CLEARABLE.indexOf(Number(o.status)) >= 0)
      this.setData({
        orders: clearable.map((o) => Object.assign({}, o, {
          stClass: ORDER_ST_CLASS[Number(o.status)] || 'gray',
          item_count: (o.items || []).reduce((s, it) => s + Number(it.quantity || 0), 0)
        }))
      })
    } catch (e) {
      this.setData({ orders: [] })
    }
  },

  // 批次列表：只留可清理的活跃批次
  async loadBatches() {
    try {
      const list = await request.get(api.batchList, {}, { silent: true })
      this.setData({ batches: (list || []).filter((b) => BATCH_CLEARABLE.indexOf(Number(b.status)) >= 0) })
    } catch (e) {
      this.setData({ batches: [] })
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  // ---------- 清理订单 ----------
  clearOrder(e) {
    const id = Number(e.currentTarget.dataset.id)
    const o = this.data.orders.find((x) => x.id === id)
    if (!o) return
    const refundHint = Number(o.status) >= 1 ? '订单已付款，将原路退款。' : '订单未付款，仅取消。'
    wx.showModal({
      title: '清理订单',
      content: '订单 ' + (o.code_short || o.order_no || id) + '：驳回正在进行的任务并摘批次、回补库存。' + refundHint + '用户端将显示「订单异常」，不可撤销。确定清理？',
      confirmText: '清理',
      confirmColor: '#E64340',
      success: (r) => { if (r.confirm) this.doClearOrder(id) }
    })
  },

  async doClearOrder(id) {
    wx.showLoading({ title: '清理中' })
    try {
      const r = await request.post(api.orderAdminClear, { order_id: id }, { silent: true })
      wx.hideLoading()
      wx.showToast({ title: (r && r.msg) || '已清理', icon: 'none' })
      this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showModal({ title: '清理失败', content: (e && e.message) || '请稍后重试', showCancel: false, confirmText: '知道了' })
    }
  },

  // ---------- 清理批次（批内订单逐单按是否付款退款） ----------
  clearBatch(e) {
    const id = Number(e.currentTarget.dataset.id)
    const b = this.data.batches.find((x) => x.id === id)
    if (!b) return
    const n = (b.orders || []).length
    wx.showModal({
      title: '清理批次',
      content: '批次 ' + (b.batch_no || '#' + id) + '：批内 ' + n + ' 个订单逐单处理（驳回任务、付过款的原路退款、摘批次回补库存），用户端将显示「订单异常」，不可撤销。确定清理？',
      confirmText: '清理',
      confirmColor: '#E64340',
      success: (r) => { if (r.confirm) this.doClearBatch(id) }
    })
  },

  async doClearBatch(id) {
    wx.showLoading({ title: '清理中' })
    try {
      const out = await request.post(api.batchDelete, { batch_id: id }, { silent: true })
      wx.hideLoading()
      const failed = (out && out.failed) || []
      wx.showModal({
        title: '批次已清理',
        content: '已清理 ' + ((out && out.cancelled) || 0) + ' 个订单'
          + (failed.length ? '，另有 ' + failed.length + ' 项未成功：' + failed.slice(0, 3).join('；') : ''),
        showCancel: false,
        confirmText: '知道了'
      })
      this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showModal({ title: '清理失败', content: (e && e.message) || '请稍后重试', showCancel: false, confirmText: '知道了' })
    }
  }
})
