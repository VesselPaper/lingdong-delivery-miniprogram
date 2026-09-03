const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    orderId: null,
    order: {},
    task: null,
    position: null,
    taskText: '等待接单',
    progressPercent: 0,
    progressStep: 0,
    posX: 10,
    posY: 80,
    empty: false
  },

  onLoad(options) {
    const orderId = Number(options.order_id || 0)
    if (orderId) {
      this.setData({ orderId })
      this.load()
    } else {
      this.loadLatest()
    }
    this.timer = setInterval(() => this.load(true), 3000)
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
  },

  // 从订单列表自动挑一个进行中的订单（优先配送中/已送达/待接单，否则最近一单）
  async loadLatest() {
    try {
      const list = await request.get(api.orderList)
      if (!list || !list.length) {
        this.setData({ empty: true })
        return
      }
      const active = list.filter((o) => o.status === 1 || o.status === 2 || o.status === 3)
      const pick = active.length ? active[0] : list[0]
      this.setData({ orderId: pick.id, empty: false })
      this.load()
    } catch (e) {
      this.setData({ empty: true })
    }
  },

  async load(silent) {
    if (!this.data.orderId) return
    try {
      const data = await request.get(api.deliveryTrack + '?order_id=' + this.data.orderId)
      const task = data.task || null
      const taskText = task ? task.status_text : data.order_status_text
      const stepMap = { 0: 0, 10: 1, 20: 2, 30: 2, 50: 3, 60: 3, 70: 4, 80: 4 }
      const step = task ? (stepMap[task.task_status] || 0) : 0
      const percent = task ? Math.min(100, step * 25) : 0
      let posX = this.data.posX
      let posY = this.data.posY
      if (data.position) {
        posX = 10 + (data.position.step / 3) * 70
        posY = 80 - (data.position.step / 3) * 55
      }
      this.setData({
        order: data,
        task,
        taskText,
        progressPercent: percent,
        progressStep: step,
        posX,
        posY,
        empty: false
      })
    } catch (e) { /* handled */ }
  },

  refresh() {
    this.load()
  },

  goOrder() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  async confirmReceive(code) {
    try {
      await request.post(api.deliveryConfirm, { order_id: this.data.orderId, scan_code: code || '' })
      wx.showToast({ title: '取餐成功', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  },

  scanPickup() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => this.confirmReceive(res.result),
      fail: () => {}
    })
  },

  // 模拟扫码取餐：测试用，模拟已扫到机器人取餐码并验证通过，直接完成取餐
  simulatePickup() {
    this.confirmReceive('')
  },

  inputCode() {
    wx.showModal({
      title: '输入取餐码',
      editable: true,
      placeholderText: '请输入机器人屏幕上的取餐码',
      confirmColor: '#2E7CF6',
      success: (r) => {
        if (r.confirm && r.content) this.confirmReceive(String(r.content).trim())
      }
    })
  }
})
