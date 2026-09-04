const api = require('../../utils/api')
const request = require('../../utils/request')

// 上货操作（一车多单 · 配送批次）
// 流程：批次列表（搜索定位）→ 选择批次 → 开舱放货 → 关舱 → 立即配送（整批出发）
// 展示：批次/订单/商品三层卡面分明；卡面标题用「批次 N / 订单 N」当日序号，
//       完整批次编号只在单批次详情显示、完整订单号只在订单详情页显示；商品一行一个（价格在数量前）。
const ORDER_ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }
const BATCH_TAG_CLASS = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue' }

Page({
  data: {
    deviceSn: '',
    batch: null,
    phase: 'idle', // idle 批次列表 | scanned 已选批次(可开舱) | open 已开舱 | loaded 已关舱(可派发) | dispatched 已派发
    keyword: '',
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
  rawOpen: [],
  rawReady: [],
  rawActive: [],

  onShow() {
    this.loadPending()
  },

  // 批次列表主入口（原始列表存 this.raw*，搜索过滤后写入 data）
  async loadPending() {
    try {
      this.setData({ loadingList: true })
      const data = await request.get(api.devicePending, {}, { silent: true })
      this.rawOpen = data.open_batches || []
      this.rawReady = data.ready_batches || []
      this.rawActive = data.active_batches || []
      this.setData({ pendingError: '', loadingList: false }, () => this.applySearch())
    } catch (e) {
      this.rawOpen = []
      this.rawReady = []
      this.rawActive = []
      this.setData({ loadingList: false, openBatches: [], readyBatches: [], activeBatches: [], pendingError: (e && e.message) || '获取批次失败' })
    }
  },

  // 为列表卡片附加操作标记/样式；订单附加状态色
  decorate(list, kind) {
    return list.map((b, idx) => Object.assign({}, b, {
      action: kind === 'open' ? 'dispatch' : (kind === 'ready' ? 'select' : ''),
      index: idx,
      statusTagClass: BATCH_TAG_CLASS[Number(b.status)] || 'tag-gray',
      orders: (b.orders || []).map((o) => Object.assign({}, o, {
        stClass: o.picked_up ? 'green' : (ORDER_ST_CLASS[Number(o.status)] || 'gray')
      }))
    }))
  },

  // ---------- 搜索：批次 / 订单 / 商品 / 点位 / 收餐人 ----------
  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.applySearch())
  },

  applySearch() {
    const kw = (this.data.keyword || '').trim().toLowerCase()
    const hit = (b) => {
      if (!kw) return true
      if (String(b.batch_no || '').toLowerCase().indexOf(kw) > -1) return true
      if (String(b.daily_seq || '') === kw) return true
      return (b.orders || []).some((o) =>
        String(o.order_no || '').toLowerCase().indexOf(kw) > -1 ||
        String(o.daily_seq || '') === kw ||
        String(o.landmark_name || '').toLowerCase().indexOf(kw) > -1 ||
        String(o.contact_name || '').toLowerCase().indexOf(kw) > -1 ||
        String(o.contact_phone || '').indexOf(kw) > -1 ||
        (o.items || []).some((it) => String(it.goods_name || '').toLowerCase().indexOf(kw) > -1))
    }
    this.setData({
      openBatches: this.decorate(this.rawOpen.filter(hit), 'open'),
      readyBatches: this.decorate(this.rawReady.filter(hit), 'ready'),
      activeBatches: this.decorate(this.rawActive.filter(hit), 'active')
    })
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

  // 从待上货批次列表选择（进入单批次详情，显示批次编号）
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
      keyword: ''
    })
  },

  // 组单中的批次 → 派车配送（创建全部平台任务）
  async dispatchBatch(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = this.data.openBatches.find((b) => b.id === id)
    if (!item) return
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '为批次 ' + (item.daily_seq || '') + ' 派车配送？',
        content: '本批共 ' + (item.total_orders || 0) + ' 单。派车后机器人将按规划路线依次配送，请准备好货品后开舱上货。',
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
      this.setData({ phase: 'open' })
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
            this.setData({ phase: 'loaded' })
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
      this.setData({ phase: 'dispatched', sliderX: 0 })
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
    this.setData({ deviceSn: '', batch: null, phase: 'idle', sliderX: 0, countdown: 0, countdownText: '' })
    this.loadPending()
  }
})
