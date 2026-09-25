const api = require('../../utils/api')
const request = require('../../utils/request')

// 取餐页（扫码后）：打开舱门 → 取餐 → 关闭舱门（40s 自动关）→ 可重新打开
Page({
  data: {
    orderId: null,
    order: {},
    phase: 'loading', // loading | ready | open | autoClosed | done
    countdown: 0
  },
  timer: null,

  onLoad(options) {
    this.setData({ orderId: Number(options.order_id || 0) })
    this.load()
  },

  onHide() { this.clearTimer() },
  onUnload() { this.clearTimer() },

  clearTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  async load() {
    if (!this.data.orderId) return
    try {
      const order = await request.post(api.pickupScan, { order_id: this.data.orderId })
      this.setData({ order, phase: 'ready' })
    } catch (e) {
      this.setData({ phase: 'done' })
      wx.showToast({ title: (e && e.message) || '暂不能取餐', icon: 'none' })
    }
  },

  // 打开舱门取餐（P1-2：开舱不再标记已取走 —— 取走标记在「关闭舱门」时完成，未取到餐可重新打开）
  async openBin() {
    wx.showLoading({ title: '开舱中' })
    try {
      await request.post(api.pickupOpen, { order_id: this.data.orderId })
      wx.hideLoading()
      wx.showToast({ title: '舱门已打开，请取餐', icon: 'success' })
      this.setData({ phase: 'open', countdown: 40 })
      this.startCountdown(40)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '开舱失败', icon: 'none' })
    }
  },

  // 关闭舱门
  async closeBin() {
    wx.showLoading({ title: '关舱中' })
    try {
      await request.post(api.pickupClose, { order_id: this.data.orderId })
      wx.hideLoading()
      this.clearTimer()
      this.setData({ phase: 'done', countdown: 0 })
      wx.showToast({ title: '已关舱，取餐完成', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '关舱失败', icon: 'none' })
    }
  },

  // 40s 倒计时：超时未关舱视为平台已自动关舱，可重新打开
  startCountdown(sec) {
    this.clearTimer()
    this.setData({ countdown: sec })
    this.timer = setInterval(() => {
      const n = this.data.countdown - 1
      if (n <= 0) {
        this.clearTimer()
        this.setData({ phase: 'autoClosed', countdown: 0 })
      } else {
        this.setData({ countdown: n })
      }
    }, 1000)
  },

  // 重新打开舱门（防止未取到餐）
  reopen() {
    this.openBin()
  },

  done() {
    wx.navigateBack()
  },

  // 取餐凭证复制：订单号 / 取餐码
  copyText(e) {
    const text = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.text : ''
    wx.setClipboardData({ data: String(text == null ? '' : text) })
  }
})
