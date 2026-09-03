const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    deviceSn: '',
    order: null,
    phase: 'idle', // idle 待选择 | scanned 已选择(可开舱) | open 已开舱(可关舱) | loaded 已关舱(可派发) | dispatched 已派发
    statusText: '请选择待上货任务，或扫描机器人二维码定位',
    pending: [],
    pendingError: '',
    sliderX: 0,
    sliderAreaW: 600,
    sliderThumbW: 120,
    countdown: 0,
    countdownText: ''
  },
  timer: null,

  onShow() {
    this.loadPending()
  },

  // 待上货任务列表（主入口）：机器人已到上货点/上货中的任务
  async loadPending() {
    try {
      const pending = await request.get(api.devicePending, {}, { silent: true })
      this.setData({ pending, pendingError: '' })
    } catch (e) {
      this.setData({ pending: [], pendingError: (e && e.message) || '获取待上货任务失败' })
    }
  },

  selectTask(e) {
    const item = this.data.pending[e.currentTarget.dataset.index]
    if (!item) return
    if (!item.device_sn) {
      wx.showToast({ title: '机器人编号未同步，请稍后重试', icon: 'none' })
      return
    }
    this.setData({
      deviceSn: item.device_sn,
      order: item,
      phase: 'scanned',
      statusText: '已选择待上货订单，点击「打开舱门」放入货品'
    })
  },

  onReady() {
    // movable-view 的 x 单位是 px，需要按屏幕宽度换算
    const win = wx.getSystemInfoSync()
    const areaPx = Math.round(600 * win.windowWidth / 750)
    const thumbPx = Math.round(120 * win.windowWidth / 750)
    this.setData({ sliderAreaW: areaPx, sliderThumbW: thumbPx })
  },

  onHide() { this.clearTimer() },
  onUnload() { this.clearTimer() },

  clearTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  startCountdown(sec) {
    this.clearTimer()
    this.setData({ countdown: sec, countdownText: '建议 ' + sec + 's 内开始配送' })
    this.timer = setInterval(() => {
      const n = this.data.countdown - 1
      if (n <= 0) {
        this.clearTimer()
        this.setData({ countdown: 0, countdownText: '已超过建议等待时长，请尽快开始配送' })
      } else {
        this.setData({ countdown: n, countdownText: '建议 ' + n + 's 内开始配送' })
      }
    }, 1000)
  },

  // 扫码识别机器人（二维码内容为设备编号 deviceSn）
  scanRobot() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: (r) => {
        const sn = String(r.result || '').trim()
        if (!sn) {
          wx.showToast({ title: '未识别到有效二维码', icon: 'none' })
          return
        }
        // 设备编号形如 R105A2601A76GK00K00（字母+数字），识别到其它内容视为无效二维码
        if (!/^[A-Za-z0-9_-]{10,}$/.test(sn)) {
          wx.showToast({ title: '二维码无效，请扫描机器人屏幕上的二维码', icon: 'none' })
          return
        }
        this.setData({ deviceSn: sn })
        this.doScan()
      },
      fail: () => {}
    })
  },

  async doScan() {
    if (!this.data.deviceSn) return wx.showToast({ title: '未识别到设备号', icon: 'none' })
    wx.showLoading({ title: '识别机器人' })
    try {
      const order = await request.post(api.deviceScan, { deviceSn: this.data.deviceSn })
      this.setData({ order, phase: 'scanned', statusText: '已识别机器人，点击「打开舱门」放入货品' })
      wx.hideLoading()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '识别失败', icon: 'none' })
    }
  },

  async openBin() {
    if (!this.data.order) return
    wx.showLoading({ title: '开舱中' })
    try {
      await request.post(api.deviceOpenBin, { task_id: this.data.order.task_id })
      this.setData({ phase: 'open', statusText: '舱门已打开，请放入货品' })
      wx.hideLoading()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '开舱失败', icon: 'none' })
    }
  },

  async closeBin() {
    if (!this.data.order) return
    wx.showLoading({ title: '关舱中' })
    try {
      await request.post(api.deviceCloseBin, { task_id: this.data.order.task_id })
      wx.hideLoading()
      wx.showModal({
        title: '是否立即配送？',
        content: '选择「否」可稍后在页面下方滑动「立即配送」开始',
        confirmText: '立即配送',
        cancelText: '稍后',
        confirmColor: '#3078C0',
        success: (r) => {
          if (r.confirm) {
            this.dispatch()
          } else {
            this.setData({ phase: 'loaded', statusText: '已关舱，机器人原地等待' })
            this.startCountdown(180)
          }
        }
      })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '关舱失败', icon: 'none' })
    }
  },

  async dispatch() {
    if (!this.data.order || this.data.phase === 'dispatched') return
    wx.showLoading({ title: '开始配送' })
    try {
      await request.post(api.deviceDispatch, { task_id: this.data.order.task_id })
      this.clearTimer()
      this.setData({ phase: 'dispatched', sliderX: 0, statusText: '机器人已出发配送' })
      wx.hideLoading()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '开始配送失败', icon: 'none' })
    }
  },

  onSliderChange(e) {
    this.setData({ sliderX: e.detail.x })
  },
  onSliderEnd() {
    const maxX = this.data.sliderAreaW - this.data.sliderThumbW - 20
    if (this.data.sliderX >= maxX) {
      this.dispatch()
    } else {
      this.setData({ sliderX: 0 })
    }
  },

  reset() {
    this.clearTimer()
    this.setData({ deviceSn: '', order: null, phase: 'idle', sliderX: 0, countdown: 0, countdownText: '', statusText: '请选择待上货任务，或扫描机器人二维码定位' })
    this.loadPending()
  }
})
