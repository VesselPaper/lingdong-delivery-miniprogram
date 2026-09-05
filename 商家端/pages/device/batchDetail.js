const api = require('../../utils/api')
const request = require('../../utils/request')

// 批次上货详情（一车多单）：单批次卡面 + 模拟开舱/关舱/立即配送
// 入口：「上货配单」列表点「选择该批次上货」；左上角返回回到批次列表（上货配单页）。
// 完整批次编号在此弱化展示；商品一行一个（价格在数量前）；无页面内冗余返回按钮。

// 测试阶段开关：无真机器人时模拟开舱/关舱/配送，走通全流程；正式接入真机器人后改为 false。
// 真实代码已保留在对应方法内（DEVICE_MOCK=false 分支），后续直接切换即可。
const DEVICE_MOCK = true

const ORDER_ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

Page({
  data: {
    id: null,
    batch: null,
    phase: 'scanned', // scanned 可开舱 | open 已开舱 | loaded 已关舱(可派发) | dispatched 已派发
    sliderX: 0,
    sliderAreaW: 600,
    sliderThumbW: 120,
    countdown: 0,
    countdownText: ''
  },
  timer: null,

  onLoad(options) {
    this.setData({ id: Number(options.id) })
  },

  onShow() {
    this.load()
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

  async load() {
    try {
      const b = await request.get(api.batchDetail, { batch_id: this.data.id }, { silent: true })
      this.setData({ batch: this.decorate(b) })
    } catch (e) { /* handled */ }
  },

  decorate(b) {
    return Object.assign({}, b, {
      statusTagClass: { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }[Number(b.status)] || 'tag-gray',
      orders: (b.orders || []).map((o) => {
        if (o.picked_up) return Object.assign({}, o, { stClass: 'green', displayStatus: '已取' })
        const st = Number(o.status)
        let cls = ORDER_ST_CLASS[st] || 'gray'
        let ds = o.status_text || ''
        if (st === 6) { cls = 'red'; ds = '配送异常' }
        else if (st === 2) { cls = 'blue'; ds = '待上货' }
        return Object.assign({}, o, { stClass: cls, displayStatus: ds })
      })
    })
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
        .then((r) => {
          wx.hideLoading()
          this.clearTimer()
          this.setData({ phase: 'dispatched', sliderX: 0 })
          // 测试阶段提示：配送时间模拟为 ~10 秒后送达
          wx.showToast({ title: (r && r.msg) || '已模拟开始配送', icon: 'none', duration: 2500 })
          // 配送完成自动返回批次列表（上货配单页），无需页面内返回按钮
          setTimeout(() => wx.navigateBack(), 1600)
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
        setTimeout(() => wx.navigateBack(), 1400)
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

  onReady() {
    const win = wx.getSystemInfoSync()
    const areaPx = Math.round(600 * win.windowWidth / 750)
    const thumbPx = Math.round(120 * win.windowWidth / 750)
    this.setData({ sliderAreaW: areaPx, sliderThumbW: thumbPx })
  }
})
