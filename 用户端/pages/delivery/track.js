const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    orderId: null,
    order: {},
    task: null,
    position: null,
    percent: null,           // P1-12：后端按地图 bbox 归一化的百分比坐标 {x,y}，无真实坐标时为 null
    taskText: '等待接单',
    progressPercent: 0,
    progressStep: 0,
    posX: 10,
    posY: 80,
    empty: false,
    loading: false
  },

  onLoad(options) {
    const orderId = Number(options.order_id || 0)
    if (orderId) {
      this.setData({ orderId })
      this.load()
    } else {
      this.loadLatest()
    }
    // P1-12：轮询计时器统一由 onLoad/onShow 启动、onHide/onUnload 清理，
    // 防止页面在栈底时继续每 3 秒打一次追踪接口（后台轮询 + 返回后重复启动）。
    this.startPolling()
  },

  onShow() {
    // 从取餐页等返回时恢复轮询并立即刷新一次
    if (this.data.orderId) this.load(true)
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  startPolling() {
    if (this.timer) return
    this.timer = setInterval(() => this.load(true), 3000)
  },

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
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
    if (!this.data.orderId || this.data.loading) return
    this.setData({ loading: true })
    try {
      const data = await request.get(api.deliveryTrack + '?order_id=' + this.data.orderId)
      const task = data.task || null
      // 服务端已给出更准确的状态文案（含组单中/待上货等批次阶段）
      const taskText = data.task_text || (task ? task.status_text : data.order_status_text)
      const stepMap = { 0: 0, 10: 1, 20: 2, 30: 2, 50: 3, 60: 3, 70: 4, 80: 4 }
      const step = task ? (stepMap[task.task_status] || 0) : 0
      const percent = task ? Math.min(100, step * 25) : 0
      let posX = this.data.posX
      let posY = this.data.posY
      // P1-12：位置百分比由后端按真实坐标 ÷ 地图 bbox 计算下发（x 左→右、y 下→上）。
      // 原先这里读 data.position.step 做魔数换算 —— 后端从不返回 step，posX/posY 恒为 NaN，
      // 地图上的机器人点永远渲染不出来。mock 档无真实坐标 → percent 为 null，地图卡隐藏走文本展示。
      if (data.percent && data.percent.x !== undefined && data.percent.y !== undefined) {
        posX = data.percent.x
        posY = data.percent.y
      }
      this.setData({
        order: data,
        task,
        batch: data.batch || null,
        position: data.position || null,
        percent: data.percent || null,
        taskText,
        progressPercent: percent,
        progressStep: step,
        posX,
        posY,
        empty: false
      })
    } catch (e) { /* handled */ } finally {
      this.setData({ loading: false })
    }
  },

  refresh() {
    this.load()
  },

  goOrder() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  // 模拟扫码取餐（测试阶段）：不真扫码，直接进入取餐页（开舱/取餐/关舱逻辑在取餐页）
  simulatePickup() {
    if (!this.data.orderId) return wx.showToast({ title: '暂无可取餐订单', icon: 'none' })
    wx.navigateTo({ url: '/pages/delivery/pickup?order_id=' + this.data.orderId })
  },

  // P1-4：配送异常(6)订单的退款/投诉出口 —— 卡死或异常订单用户必须有自助入口
  goRefund() {
    if (!this.data.orderId) return
    wx.navigateTo({ url: '/pages/order/refund?order_id=' + this.data.orderId })
  }
})
