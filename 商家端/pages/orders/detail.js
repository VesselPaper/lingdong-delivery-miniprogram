const api = require('../../utils/api')
const request = require('../../utils/request')
const shopState = require('../../utils/shopState')
const role = require('../../utils/role')

// 订单状态 → 文字颜色 class
const ST_CLASS = { 0: 'gray', 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

// 可删除的订单状态（与后端 / 原管理页口径一致）：待支付/待接单/配送中/已送达/配送异常。
// 已完成/已取消/已退款是终态，再删一次会重走回补库存，把库存越补越多。
const DELETABLE = [0, 1, 2, 3, 6]

Page({
  data: {
    id: null,
    order: {},
    items: [],
    payed: false,
    shopOpen: true,
    canDelete: false     // 删除订单：店主专属 + 仅可删状态
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
        order: Object.assign({}, data, { stClass: ST_CLASS[st] || 'gray' }),
        items: data.items,
        payed: data.status > 0,
        pickupHint,
        // 删除订单：店主专属，且只对可删状态开放。前端先拦一道——若等后端 403，
        // request.js 会清登录态并把店员直接踢回登录页，比"看不到按钮"难看得多。
        canDelete: role.isOwner() && DELETABLE.indexOf(st) >= 0
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

  // 删除订单（店主专属；2026-10-07 从管理员网页「删除订单」迁来）
  // 后端会作废机器人任务 + 回补库存 + 从批次摘除 + 平台召回，所以必须二次确认：
  // 用户那边订单会直接变成已取消、机器人也会被叫回来，没有撤回入口。
  async deleteOrder() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除订单',
        content: '该订单将被取消：机器人任务一并作废、库存回补，用户端会看到订单已取消。不可撤销，确定删除？',
        confirmText: '删除',
        confirmColor: '#E64340',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    wx.showLoading({ title: '删除中' })
    try {
      await request.post(api.orderDelete, { order_id: this.data.id }, { silent: true })
      wx.hideLoading()
      wx.showToast({ title: '订单已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      wx.hideLoading()
      wx.showModal({ title: '删除失败', content: (e && e.message) || '请稍后重试', showCancel: false, confirmText: '知道了' })
    }
  },

  // 订单编号 / 批次号复制
  copyText(e) {
    const text = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.text : ''
    wx.setClipboardData({ data: String(text == null ? '' : text) })
  }
})
