const api = require('../../utils/api')
const request = require('../../utils/request')
const pay = require('../../utils/pay')

Page({
  data: {
    id: null,
    order: {},
    items: [],
    progress: 0,      // 配送进度：0 未接单 / 1 已接单 / 2 配送中 / 3 已送达
    progressText: '',
    payMock: false    // 运行时标注：支付按钮显示「模拟支付」
  },

  onLoad(options) {
    const flags = wx.getStorageSync('runtimeFlags') || {}
    this.setData({ id: Number(options.id), payMock: flags.pay_mock === true })
  },

  onShow() {
    this.load()
    // 查看订单详情视为已读动态（清除我的页红点）
    request.post(api.orderMarkRead, {}, { silent: true }).catch(() => {})
  },

  async load() {
    try {
      const data = await request.get(api.orderDetail + '?id=' + this.data.id)
      this.setData({ order: data, items: data.items, ...this.calcProgress(data) })
      wx.setNavigationBarTitle({ title: data.status_text })
    } catch (e) { /* handled */ }
  },

  // 配送进度条：已接单 / 配送中 / 已送达 三阶段，到达即填满该圆点
  calcProgress(data) {
    const st = Number(data.status)
    let progress = 0
    let text = ''
    if (st === 0) { progress = 0; text = '待支付' }
    else if (st === 1) { progress = 0; text = '待接单，商家正在备餐' }
    else if (st === 2) {
      const moving = data.task && Number(data.task.task_status) >= 50
      progress = moving ? 2 : 1
      text = moving ? '机器人配送中' : '已接单，等待装载配送'
    } else if (st === 3) { progress = 3; text = '机器人已到达 ' + (data.landmark_name || '取餐点') + '，请及时取餐' }
    else if (st === 4) { progress = 3; text = '已完成' }
    else { progress = 0; text = data.status_text || '' }
    return { progress, progressText: text }
  },

  async payOrder() {
    try {
      await pay.payOrder(this.data.id)
      wx.showToast({ title: '支付成功', icon: 'success' })
      this.load()
    } catch (e) {
      if (e.message && e.message !== 'cancel') wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  async cancelOrder() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确定取消该订单？',
        confirmColor: '#111111',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.post(api.orderCancel, { id: this.data.id })
      wx.showToast({ title: '已取消', icon: 'success' })
      this.load()
    } catch (e) {
      // 超过免费取消时间：引导提交取消申请
      if (e && e.message && e.message.indexOf('取消申请') > -1) {
        wx.showToast({ title: '已超过免费取消时间，转提交取消申请', icon: 'none' })
        setTimeout(() => this.goCancelRequest(), 600)
      }
    }
  },

  goCancelRequest() {
    wx.navigateTo({ url: '/pages/order/cancelRequest?order_id=' + this.data.id })
  },

  async confirmReceive(code) {
    try {
      await request.post(api.deliveryConfirm, { order_id: this.data.id, scan_code: code || '' })
      wx.showToast({ title: '取餐成功', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  // 扫码取餐（需求5）：进入扫码取餐页 —— 扫无人车二维码 + 输取餐码定位本人订单
  goScanPickup() {
    wx.navigateTo({ url: '/pages/delivery/scanPickup' })
  },

  goRefund() {
    wx.navigateTo({ url: '/pages/order/refund?order_id=' + this.data.id })
  }
})
