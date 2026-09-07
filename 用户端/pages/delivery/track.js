const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    orderId: null,
    order: {},
    task: null,
    position: null,
    percent: null,           // P1-12：后端按地图 bbox 归一化的百分比坐标 {x,y}，无真实坐标时为 null
    map: null,               // 地图数据：{ bbox, landmarks[], route[] }（landmarks/route 均为百分比坐标）
    taskText: '等待接单',
    progressPercent: 0,
    progressStep: 0,
    posX: 10,
    posY: 80,
    // 地图缩放/平移（自绘地图，非微信 map 组件：平台坐标为 SLAM 米制，无经纬度）
    mapScale: 1,
    mapScaleMin: 0.8,
    mapScaleMax: 4,
    mapOffsetX: 0,
    mapOffsetY: 0,
    mapMoving: false,
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
        map: data.map || null,
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

  noop() {},

  // 路线折线段：两点百分比坐标 → 线段长度（%）与角度（deg）
  routeSegLen(a, b) {
    const dx = Number(b.x) - Number(a.x)
    const dy = Number(b.y) - Number(a.y)
    return Math.sqrt(dx * dx + dy * dy)
  },

  routeSegDeg(a, b) {
    const dx = Number(b.x) - Number(a.x)
    const dy = Number(b.y) - Number(a.y)
    // CSS 坐标 y 向下，百分比坐标 y 向下（已按 bbox 归一化），atan2 直接算
    return Math.round(Math.atan2(dy, dx) * 180 / Math.PI)
  },

  // ---------- 地图缩放/平移（自绘地图） ----------
  onMapTouchStart(e) {
    const t = e.touches || []
    if (t.length >= 2) {
      // 双指：记录初始距离与中心，进入缩放模式
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
      this._pinch = { dist: d, scale: this.data.mapScale }
    } else {
      // 单指：记录起点，进入平移模式
      this._pan = { x: t[0] && t[0].clientX, y: t[0] && t[0].clientY, ox: this.data.mapOffsetX, oy: this.data.mapOffsetY }
      this.setData({ mapMoving: true })
    }
  },

  onMapTouchMove(e) {
    const t = e.touches || []
    if (this._pinch && t.length >= 2) {
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
      if (this._pinch.dist > 0) {
        const next = this._pinch.scale * (d / this._pinch.dist)
        this.applyMapScale(next)
      }
    } else if (this._pan && t.length === 1) {
      const dx = t[0].clientX - this._pan.x
      const dy = t[0].clientY - this._pan.y
      this.setData({
        mapOffsetX: this._pan.ox + dx,
        mapOffsetY: this._pan.oy + dy
      })
    }
  },

  onMapTouchEnd() {
    this._pinch = null
    this._pan = null
    this.setData({ mapMoving: false })
  },

  // 应用缩放（以地图中心为锚点，限制范围）
  applyMapScale(next) {
    const s = Math.max(this.data.mapScaleMin, Math.min(this.data.mapScaleMax, next))
    this.setData({ mapScale: s })
  },

  onZoomIn() {
    this.applyMapScale(this.data.mapScale * 1.3)
  },

  onZoomOut() {
    this.applyMapScale(this.data.mapScale / 1.3)
  },

  onMapReset() {
    this.setData({ mapScale: 1, mapOffsetX: 0, mapOffsetY: 0 })
  },

  // 扫码取餐（需求5）：进入扫码取餐页 —— 扫无人车二维码 + 输取餐码定位本人订单
  goScanPickup() {
    wx.navigateTo({ url: '/pages/delivery/scanPickup' })
  },

  // P1-4：配送异常(6)订单的退款/投诉出口 —— 卡死或异常订单用户必须有自助入口
  goRefund() {
    if (!this.data.orderId) return
    wx.navigateTo({ url: '/pages/order/refund?order_id=' + this.data.orderId })
  }
})
