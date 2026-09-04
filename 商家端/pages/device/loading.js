const api = require('../../utils/api')
const request = require('../../utils/request')

// 上货操作（一车多单 · 配送批次）
// 流程：批次列表 →（组单中批次「派车配送」/ 待上货批次「选择」或「模拟扫码」）
//      → 已选批次（可开舱）→ 开舱放货 → 关舱 → 立即配送（整批出发）
// 展示：与「我的任务」一致的卡片布局，批次/订单/商品三层卡面分明，商品一行一个完整展示。
Page({
  data: {
    deviceSn: '',
    batch: null,
    phase: 'idle', // idle 批次列表 | scanned 已选批次(可开舱) | open 已开舱 | loaded 已关舱(可派发) | dispatched 已派发
    statusText: '请选择待上货批次，或为组单中的批次派车',
    openBatches: [],
    readyBatches: [],
    activeBatches: [],
    pendingError: '',
    loadingList: true,
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

  // 批次列表主入口
  async loadPending() {
    try {
      this.setData({ loadingList: true })
      const data = await request.get(api.devicePending, {}, { silent: true })
      this.setData({
        openBatches: this.decorate(data.open_batches || [], 'open'),
        readyBatches: this.decorate(data.ready_batches || [], 'ready'),
        activeBatches: this.decorate(data.active_batches || [], 'active'),
        pendingError: '',
        loadingList: false
      })
    } catch (e) {
      this.setData({ loadingList: false, openBatches: [], readyBatches: [], activeBatches: [], pendingError: (e && e.message) || '获取批次失败' })
    }
  },

  // 为列表卡片附加操作标记与样式
  decorate(list, kind) {
    return list.map((b, idx) => Object.assign({}, b, {
      action: kind === 'open' ? 'dispatch' : (kind === 'ready' ? 'select' : ''),
      index: idx,
      tagClass: kind === 'open' ? 'tag-blue' : (kind === 'ready' ? 'tag-green' : 'tag-orange')
    }))
  },

  onReady() {
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

  // 从待上货批次列表直接选择（等同扫码定位）
  selectBatch(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const item = this.data.readyBatches[idx]
    if (!item) return
    this.selectBatchItem(item)
  },

  selectBatchItem(item) {
    const sn = item.device_sn || 'SIMROBOT' + String(item.id).padStart(4, '0')
    const batch = Object.assign({}, item)
    delete batch.action
    delete batch.index
    this.setData({
      deviceSn: sn,
      batch,
      phase: 'scanned',
      statusText: '已选择批次，点击「打开舱门」放入本批 ' + (item.total_orders || 0) + ' 单货品'
    })
  },

  // 模拟扫码识别机器人（测试阶段：不真扫码，定位待上货批次）
  simulateScanRobot() {
    if (!this.data.readyBatches.length) {
      if (this.data.openBatches.length) {
        wx.showToast({ title: '组单中的批次请先「派车配送」', icon: 'none' })
      } else {
        wx.showToast({ title: '暂无待上货批次', icon: 'none' })
      }
      return
    }
    const item = this.data.readyBatches[0]
    // 测试阶段：用固定模拟设备号定位（真实机器人接入后替换为真实扫码）
    const sn = item.device_sn || 'SIMROBOT0001'
    wx.showLoading({ title: '识别机器人' })
    request.post(api.deviceScan, { deviceSn: sn })
      .then((res) => {
        wx.hideLoading()
        const batch = Object.assign({}, res)
        delete batch.action
        delete batch.index
        this.setData({
          deviceSn: sn,
          batch,
          phase: 'scanned',
          statusText: '已识别机器人，批次 ' + res.batch_no + ' 共 ' + (res.total_orders || 0) + ' 单，点击「打开舱门」放货'
        })
      })
      .catch((e) => {
        wx.hideLoading()
        // 扫码失败（如真实模式无该设备）→ 回退为直接选择待上货批次
        wx.showToast({ title: (e && e.message) || '识别失败，已直接选择批次', icon: 'none' })
        this.selectBatchItem(item)
      })
  },

  // 组单中的批次 → 派车配送（创建全部平台任务）
  async dispatchBatch(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = this.data.openBatches.find((b) => b.id === id)
    if (!item) return
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '为该批次派车配送？',
        content: '批次 ' + (item.batch_no || '') + ' 共 ' + (item.total_orders || 0) + ' 单。派车后机器人将按规划路线依次配送，请准备好货品后开舱上货。',
        confirmText: '派车',
        confirmColor: '#3078C0',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    wx.showLoading({ title: '派车中' })
    try {
      await request.post(api.batchDispatch, { batch_id: id })
      wx.hideLoading()
      wx.showToast({ title: '已派车，机器人前往上货点', icon: 'success' })
      this.loadPending()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '派车失败', icon: 'none' })
    }
  },

  // 开舱（整批验证）
  async openBin() {
    if (!this.data.batch) return
    wx.showLoading({ title: '开舱中' })
    try {
      await request.post(api.batchOpenBin, { batch_id: this.data.batch.id })
      this.setData({ phase: 'open', statusText: '舱门已打开，请放入本批全部货品' })
      wx.hideLoading()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '开舱失败', icon: 'none' })
    }
  },

  // 关舱（原地等待）
  async closeBin() {
    if (!this.data.batch) return
    wx.showLoading({ title: '关舱中' })
    try {
      await request.post(api.batchCloseBin, { batch_id: this.data.batch.id })
      wx.hideLoading()
      wx.showModal({
        title: '是否立即配送？',
        content: '本批 ' + (this.data.batch.total_orders || 0) + ' 单已装车。选择「否」可稍后滑动「立即配送」开始。',
        confirmText: '立即配送',
        cancelText: '稍后',
        confirmColor: '#3078C0',
        success: (r) => {
          if (r.confirm) {
            this.dispatchAll()
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

  // 开始配送（整批确认上货）
  async dispatchAll() {
    if (!this.data.batch || this.data.phase === 'dispatched') return
    wx.showLoading({ title: '开始配送' })
    try {
      await request.post(api.batchDispatchAll, { batch_id: this.data.batch.id })
      this.clearTimer()
      this.setData({ phase: 'dispatched', sliderX: 0, statusText: '机器人已出发，将按路线依次配送' })
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
      this.dispatchAll()
    } else {
      this.setData({ sliderX: 0 })
    }
  },

  reset() {
    this.clearTimer()
    this.setData({ deviceSn: '', batch: null, phase: 'idle', sliderX: 0, countdown: 0, countdownText: '', statusText: '请选择待上货批次，或为组单中的批次派车' })
    this.loadPending()
  }
})
