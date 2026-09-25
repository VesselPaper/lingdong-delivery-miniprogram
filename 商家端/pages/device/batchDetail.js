const api = require('../../utils/api')
const request = require('../../utils/request')

// 批次上货详情（一车多单）：单批次卡面 + 模拟开舱/关舱/立即配送
// 入口：「上货配单」列表点「选择该批次上货」；左上角返回回到批次列表（上货配单页）。
// 完整批次编号在此弱化展示；商品一行一个（价格在数量前）；无页面内冗余返回按钮。

// 测试阶段开关：由后端运行模式下发（/api/shop/status 与登录响应 runtime.device_mock），不再前端硬编码。
// 取不到时默认 false —— 宁可走真实分支报错，也不可假装成功（P0-2 修复）。
// 真实代码已保留在对应方法内（DEVICE_MOCK=false 分支），后续直接切换即可。
const runtimeFlags = wx.getStorageSync('runtimeFlags') || {}
const DEVICE_MOCK = runtimeFlags.device_mock === true

const ORDER_ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

Page({
  data: {
    id: null,
    batch: null,
    phase: 'scanned', // pending 未定型(只读) | scanned 可开舱 | open 已开舱 | loaded 已关舱(可派发) | dispatched 已派发
    mock: DEVICE_MOCK, // 按钮标注：模拟打开舱门/打开舱门
    scanSn: '',        // 扫码带入的无人车编号（需求5）
    atLoadingPoint: false,
    dist: '',
    loadMsg: '',
    sliderX: 0,
    sliderAreaW: 600,
    sliderThumbW: 120,
    countdown: 0,
    countdownText: ''
  },
  timer: null,

  onLoad(options) {
    this.setData({
      id: Number(options.id),
      scanSn: String(options.sn || ''),
      atLoadingPoint: options.at === '1',
      dist: String(options.dist || ''),
      loadMsg: decodeURIComponent(String(options.lmsg || ''))
    })
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
      // 重进页面按后端批次/任务状态恢复操作阶段（问题2修复）：
      // 之前 phase 是纯前端本地状态，退出重进后回到 scanned → 按钮错乱（显示「打开舱门」且再开舱报错）。
      this.setData({ batch: this.decorate(b), phase: this.inferPhase(b) })
    } catch (e) { /* handled */ }
  },

  // 由后端状态推断初始 phase：scanned 可开舱 / open 已开舱 / loaded 可开始配送 / dispatched 已派发
  // 2026-09-17 适配 syncLoading=0 流程：定型后任务状态 0/10/20/30（待到达/已到达未开舱）→ 显示「打开舱门」；
  // 40 上货中（舱已开）→ 显示「关舱」；50 已上货 → 显示「开始配送」。
  inferPhase(b) {
    const st = Number(b.status)
    if (st === 0) return 'pending' // 组单中：未派车定型，详情页只读展示（不显示开舱/关舱操作）
    if (st === 2 || st === 3 || st === 4) return 'dispatched' // 配送中/已完成/已取消：不再可操作
    if (st === 1) {
      // 召唤多单配送无 delivery_tasks，orders[].task.statuses 恒为空 → 旧逻辑会退回 scanned（错误显示「打开舱门」）。
      // 优先用后端落库的 ready_dispatch：已关舱(货已装好) → 直接可「立即配送」。字段缺失则按 false 走旧逻辑。
      if (b.ready_dispatch === true) return 'loaded'
      const statuses = (b.orders || [])
        .map((o) => o.task && o.task.task_status)
        .filter((v) => v !== undefined && v !== null)
        .map(Number)
      if (!statuses.length) return 'scanned'
      const max = Math.max.apply(null, statuses)
      if (max >= 50) return 'loaded'   // 已上货（货装好）→ 开始配送
      if (max >= 40) return 'open'     // 上货中（舱已开）→ 关舱
      return 'scanned'                 // 待到达/已到达未开舱 → 打开舱门
    }
    return 'scanned' // 组单中（正常不在此页）或其它：可开舱
  },

  decorate(b) {
    const st = Number(b.status)
    const orders = (b.orders || []).map((o) => {
      if (o.picked_up) return Object.assign({}, o, { stClass: 'green', displayStatus: '已取' })
      const os = Number(o.status)
      let cls = ORDER_ST_CLASS[os] || 'gray'
      let ds = o.status_text || ''
      if (os === 6) { cls = 'red'; ds = '配送异常' }
      else if (os === 2) { cls = 'blue'; ds = '待上货' }
      return Object.assign({}, o, { stClass: cls, displayStatus: ds })
    })
    // 状态标签：批次内有「已送达未取走」的订单 → 显示「待取货」（与当前任务页待取货卡一致）
    const awaitingPickup = orders.some((o) => Number(o.status) === 3 && !o.picked_up)
    let statusText = b.status_text || ''
    let tagCls = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }[st] || 'tag-gray'
    if (awaitingPickup) { statusText = '待取货'; tagCls = 'tag-green' }
    // 已派发后的说明文案：配送中 / 已送达待取 / 已完成 / 异常分别给准确提示
    const delivered = orders.filter((o) => Number(o.status) >= 3).length
    let note = '机器人已出发，将按路线依次配送'
    if (st === 4) note = b.status_text === '批次已取消' ? '批次已取消' : '批次配送异常，请查看订单处理'
    else if (st === 3) note = orders.length && delivered === orders.length ? '批次配送已完成' : '货品已送达各点位，等待顾客取餐'
    else if (st === 2 && orders.length && delivered === orders.length) note = '货品已送达各点位，等待顾客取餐'
    return Object.assign({}, b, {
      statusTagClass: tagCls,
      status_text: statusText,
      // 已锁定·待配送：货已装好待发车（配单上货卡同款标记）
      dispatchMark: b.ready_dispatch === true,
      dispatchNote: note,
      orders
    })
  },

  // 批次卡面内点某单 → 进订单详情
  goOrderDetail(e) {
    const o = e.detail || {}
    if (o && o.id) wx.navigateTo({ url: '/pages/orders/detail?id=' + o.id })
  },

  // 打开舱门（整批验证）。测试阶段：模拟成功；真实代码保留在下方分支。
  openBin() {
    if (!this.data.batch) return
    if (DEVICE_MOCK) {
      wx.showLoading({ title: '开舱中' })
      setTimeout(() => {
        wx.hideLoading()
        this.setData({ phase: 'open' })
        wx.showModal({ title: '模拟开舱成功', content: '请放货', showCancel: false, confirmText: '知道了' })
      }, 600)
      return
    }
    // ---- 真实模式（保留，正式接入后启用）----
    wx.showLoading({ title: '开舱中' })
    request.post(api.batchOpenBin, { batch_id: this.data.batch.id }, { silent: true })
      .then((data) => {
        wx.hideLoading()
        // 车未到上货点：后端返回 200{waiting:true}，属「等待提示」不是错误 —— 不进入开舱态，让商家稍候重试
        if (data && data.waiting) {
          wx.showModal({
            title: '机器人前往上货点中',
            content: data.msg || '机器人还没到达上货点，请稍后再试',
            showCancel: false,
            confirmText: '知道了'
          })
          return
        }
        this.setData({ phase: 'open' })
        wx.showModal({ title: '舱门已打开', content: '请放货', showCancel: false, confirmText: '知道了' })
      })
      .catch((e) => {
        wx.hideLoading()
        wx.showModal({ title: '开舱失败', content: (e && e.message) || '开舱失败，请稍后重试', showCancel: false, confirmText: '知道了' })
      })
  },

  // 关舱（原地等待）。测试阶段：模拟成功；真实代码保留在下方分支。
  closeBin() {
    if (!this.data.batch) return
    if (DEVICE_MOCK) {
      wx.showModal({
        title: '是否立即配送',
        content: '确认关闭舱门？关闭舱门后机器人才会开始移动配送。',
        confirmText: '立即配送',
        cancelText: '稍后',
        confirmColor: '#3078C0',
        success: (r) => {
          // 舱门关闭后才允许配送：此处关舱已成功（模拟），是则直接开始配送
          this.setData({ phase: 'loaded' })
          if (r.confirm) {
            this.dispatchAll()
          } else {
            this.startCountdown(180)
          }
        }
      })
      return
    }
    // ---- 真实模式（保留，正式接入后启用）----
    wx.showLoading({ title: '关舱中' })
    request.post(api.batchCloseBin, { batch_id: this.data.batch.id }, { silent: true })
      .then(() => {
        wx.hideLoading()
        wx.showModal({
          title: '是否立即配送',
          content: '确认关闭舱门？关闭舱门后机器人才会开始移动配送。',
          confirmText: '立即配送',
          cancelText: '稍后',
          confirmColor: '#3078C0',
          success: (r) => {
            // 安全：平台确认关舱成功（舱门已关闭）后才允许开始配送
            this.setData({ phase: 'loaded' })
            if (r.confirm) {
              this.dispatchAll()
            } else {
              this.startCountdown(180)
            }
          }
        })
      })
      .catch((e) => {
        wx.hideLoading()
        wx.showModal({ title: '关舱失败', content: (e && e.message) || '关舱失败，请稍后重试', showCancel: false, confirmText: '知道了' })
      })
  },

  // 开始配送（整批确认上货）。测试阶段：模拟成功并推进本地状态；真实代码保留在下方分支。
  // 安全前置（P1-x）：舱门开着时车不能移动 —— 只有 phase=loaded（已关舱）才允许开始配送。
  dispatchAll() {
    if (!this.data.batch) return
    if (this.data.phase === 'dispatched') return
    if (this.data.phase !== 'loaded') {
      wx.showModal({ title: '请先关闭舱门', content: '关闭舱门后才能开始配送', showCancel: false, confirmText: '知道了' })
      return
    }
    if (DEVICE_MOCK) {
      wx.showLoading({ title: '开始配送' })
      // silent：结果由下方确认弹窗展示，避免 request 默认悬浮 toast 与其重叠
      request.post(api.batchMockDispatch, { batch_id: this.data.batch.id }, { silent: true })
        .then((r) => {
          wx.hideLoading()
          this.clearTimer()
          this.setData({ phase: 'dispatched', sliderX: 0 })
          // 测试阶段提示：配送时间模拟为 ~10 秒后送达；确认后返回批次列表
          wx.showModal({
            title: (r && r.msg) || '已模拟开始配送',
            showCancel: false,
            confirmText: '知道了',
            success: () => wx.navigateBack()
          })
        })
        .catch((e) => {
          wx.hideLoading()
          wx.showModal({ title: '开始配送失败', content: (e && e.message) || '请稍后重试', showCancel: false, confirmText: '知道了' })
        })
      return
    }
    // ---- 真实模式（保留，正式接入后启用）----
    wx.showLoading({ title: '开始配送' })
    request.post(api.batchDispatchAll, { batch_id: this.data.batch.id }, { silent: true })
      .then(() => {
        wx.hideLoading()
        this.clearTimer()
        this.setData({ phase: 'dispatched', sliderX: 0 })
        wx.showModal({
          title: '配送已开始',
          showCancel: false,
          confirmText: '知道了',
          success: () => wx.navigateBack()
        })
      })
      .catch((e) => {
        wx.hideLoading()
        wx.showModal({ title: '开始配送失败', content: (e && e.message) || '请稍后重试', showCancel: false, confirmText: '知道了' })
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
