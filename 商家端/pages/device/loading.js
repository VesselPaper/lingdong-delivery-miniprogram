const api = require('../../utils/api')
const request = require('../../utils/request')

// 上货配单（一车多单 · 配送批次）
// 流程：批次列表（搜索定位）→ 选择批次 → 模拟打开舱门 → 关闭舱门 → 立即配送（整批出发）
// 展示：批次/订单/商品三层卡面分明；卡面标题用「批次 N / 订单 N」当日序号，
//       完整批次编号只在单批次详情显示、完整订单号只在订单详情页显示；商品一行一个（价格在数量前）。
// 本页只展示「组单中（可派车） + 待上货（可上货）」，配送中/待取货请看任务页与配送监控。

// 测试阶段开关：无真机器人时模拟开舱/关舱/配送，走通全流程；正式接入真机器人后改为 false。
// 真实代码已保留在对应方法内（DEVICE_MOCK=false 分支），后续直接切换即可。
const DEVICE_MOCK = true

const ORDER_ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }
const BATCH_TAG_CLASS = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }

Page({
  data: {
    batch: null,
    phase: 'idle', // idle 批次列表 | scanned 已选批次(可开舱) | open 已开舱 | loaded 已关舱(可派发) | dispatched 已派发
    keyword: '',
    openBatches: [],
    readyBatches: [],
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
      this.setData({ pendingError: '', loadingList: false }, () => this.applySearch())
    } catch (e) {
      this.rawOpen = []
      this.rawReady = []
      this.setData({ loadingList: false, openBatches: [], readyBatches: [], pendingError: (e && e.message) || '获取批次失败' })
    }
  },

  // 为列表卡片附加操作标记/样式；订单附加状态色与分类文案
  decorate(list, kind) {
    const pendingPhase = (kind === 'open' || kind === 'ready') // 组单中/待上货阶段的订单统一显示「待上货」
    return list.map((b, idx) => {
      const orders = (b.orders || []).map((o) => {
        if (o.picked_up) return Object.assign({}, o, { stClass: 'green', displayStatus: '已取' })
        const st = Number(o.status)
        let cls = ORDER_ST_CLASS[st] || 'gray'
        let ds = o.status_text || ''
        if (st === 6) { cls = 'red'; ds = '配送异常' }
        else if (pendingPhase && st === 2) { cls = 'blue'; ds = '待上货' }
        return Object.assign({}, o, { stClass: cls, displayStatus: ds })
      })
      // 待上货批次全为配送异常订单：不提供「选择该批次上货」（改由任务页异常处理）
      let action = kind === 'open' ? 'dispatch' : (kind === 'ready' ? 'select' : '')
      if (kind === 'ready' && orders.length && orders.every((o) => Number(o.status) === 6)) action = ''
      return Object.assign({}, b, { action, index: idx, statusTagClass: BATCH_TAG_CLASS[Number(b.status)] || 'tag-gray', orders })
    })
  },

  // ---------- 搜索：批次 / 订单 / 商品 / 点位 / 收餐人 ----------
  onSearch(e) {
    this.setData({ keyword: e.detail }, () => this.applySearch())
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
      readyBatches: this.decorate(this.rawReady.filter(hit), 'ready')
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
    this.selectBatchItem(e.detail || {})
  },

  selectBatchItem(item) {
    if (!item || !item.id) return
    const batch = Object.assign({}, item)
    delete batch.action
    delete batch.index
    this.setData({ batch, phase: 'scanned', keyword: '' })
  },

  // 组单中的批次 → 派车配送（创建全部平台任务）
  async dispatchBatch(e) {
    const item = e.detail || {}
    if (!item || !item.id) return
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
      await request.post(api.batchDispatch, { batch_id: item.id })
      wx.hideLoading()
      wx.showToast({ title: '已派车，机器人前往上货点', icon: 'success' })
      this.loadPending()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '派车失败', icon: 'none' })
    }
  },

  // 打开舱门（整批验证）。测试阶段：模拟成功；真实代码保留在下方分支。
  openBin() {
    if (!this.data.batch) return
    if (DEVICE_MOCK) {
      wx.showLoading({ title: '开舱中' })
      setTimeout(() => {
        wx.hideLoading()
        this.setData({ phase: 'open' })
        wx.showToast({ title: '模拟开舱成功', icon: 'success' })
      }, 600)
      return
    }
    // ---- 真实模式（保留，正式接入后启用）----
    wx.showLoading({ title: '开舱中' })
    request.post(api.batchOpenBin, { batch_id: this.data.batch.id })
      .then(() => { wx.hideLoading(); this.setData({ phase: 'open' }) })
      .catch((e) => { wx.hideLoading(); wx.showToast({ title: (e && e.message) || '开舱失败', icon: 'none' }) })
  },

  // 关舱（原地等待）。测试阶段：模拟成功；真实代码保留在下方分支。
  closeBin() {
    if (!this.data.batch) return
    if (DEVICE_MOCK) {
      wx.showModal({
        title: '是否立即配送？',
        content: '本批 ' + (this.data.batch.total_orders || 0) + ' 单已装车（模拟）。选择「否」可稍后滑动「立即配送」开始。',
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
      return
    }
    // ---- 真实模式（保留，正式接入后启用）----
    wx.showLoading({ title: '关舱中' })
    request.post(api.batchCloseBin, { batch_id: this.data.batch.id })
      .then(() => {
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
      })
      .catch((e) => { wx.hideLoading(); wx.showToast({ title: (e && e.message) || '关舱失败', icon: 'none' }) })
  },

  // 开始配送（整批确认上货）。测试阶段：模拟成功并推进本地状态；真实代码保留在下方分支。
  dispatchAll() {
    if (!this.data.batch || this.data.phase === 'dispatched') return
    if (DEVICE_MOCK) {
      wx.showLoading({ title: '开始配送' })
      request.post(api.batchMockDispatch, { batch_id: this.data.batch.id })
        .then(() => {
          wx.hideLoading()
          this.clearTimer()
          this.setData({ phase: 'dispatched', sliderX: 0 })
          wx.showToast({ title: '已模拟开始配送', icon: 'success' })
          // 配送完成后自动回到批次列表，方便继续下一批（不再需要「返回批次列表」按钮）
          setTimeout(() => this.reset(), 1400)
        })
        .catch((e) => {
          wx.hideLoading()
          wx.showToast({ title: (e && e.message) || '开始配送失败', icon: 'none' })
        })
      return
    }
    // ---- 真实模式（保留，正式接入后启用）----
    wx.showLoading({ title: '开始配送' })
    request.post(api.batchDispatchAll, { batch_id: this.data.batch.id })
      .then(() => {
        wx.hideLoading()
        this.clearTimer()
        this.setData({ phase: 'dispatched', sliderX: 0 })
      })
      .catch((e) => {
        wx.hideLoading()
        wx.showToast({ title: (e && e.message) || '开始配送失败', icon: 'none' })
      })
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

  // 配送完成后自动回到批次列表；页面内不提供多余返回按钮（左上角系统返回走标准返回）
  reset() {
    this.clearTimer()
    this.setData({ batch: null, phase: 'idle', sliderX: 0, countdown: 0, countdownText: '' })
    this.loadPending()
  }
})
