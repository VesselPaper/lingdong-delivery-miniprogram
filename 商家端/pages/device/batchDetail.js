const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')

// 批次上货页（一车多单）—— 新流程（2026-10-06 改版）
// ---------------------------------------------------------------------------
// 旧流程：进页面 →【打开舱门】→ 放货 →【关舱】→ 弹窗问是否立即配送 → 配送
// 新流程：点「上货」进页面 → 自动开舱 → 放货 →【立即配送】→ 二次确认 → 自动关舱 + 立即配送
//
// 改版要点：
//   1) 开舱自动化：进入页面时若舱门未开，自动调用开舱接口，商家不再手动点「打开舱门」。
//      配单页点「上货」、扫车身二维码、退出后重进 —— 三条入口共用这一处逻辑，行为一致。
//   2) 关舱并入配送：「立即配送」内部先关舱再派发。真实环境下车在舱门打开时不能移动，
//      因此关舱不能省，但商家只需要按一个按钮，不必理解「先关舱才能走」这层机械约束。
//   3) 移除手动「打开舱门 / 关舱」按钮：按钮少一个，误操作面少一个。
//
// 入口：「上货配单」列表点「上货（N件）」；左上角返回回到批次列表（上货配单页）。
// 完整批次编号在此弱化展示；商品一行一个（价格在数量前）；无页面内冗余返回按钮。

// 测试阶段开关：由后端运行模式下发（/api/shop/status 与登录响应 runtime.device_mock），不再前端硬编码。
// 取不到时默认 false —— 宁可走真实分支报错，也不可假装成功（P0-2 修复）。
const runtimeFlags = wx.getStorageSync('runtimeFlags') || {}
const DEVICE_MOCK = runtimeFlags.device_mock === true

const ORDER_ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }

// 自动开舱失败后的重试节奏：机器人还没到上货点时后端会返回 waiting，
// 这时不该让商家自己盯着屏幕反复点，页面自己隔几秒重试一次即可。
// 但有次数上限 —— 机器人长时间不来（离线/被别的批次占用）时不能无限打后端，
// 到上限后停下并保留「重新尝试开舱」按钮交给商家决定。
const OPEN_RETRY_MS = 5000
const OPEN_RETRY_MAX = 24   // 24 × 5s ≈ 2 分钟

Page({
  data: {
    id: null,
    batch: null,
    // pending 组单中(只读) | scanned 待开舱(自动开舱中/失败可重试) | open 舱已开待放货 | loaded 已关舱待配送 | dispatched 已配送
    phase: 'scanned',
    opening: false,      // 正在自动开舱
    openError: '',       // 开舱失败/等待的原因（展示给商家，附重试按钮）
    canRetryOpen: false, // 是否显示「重新尝试开舱」（自动重试仍在跑时不给按钮，避免重复点）
    scanSn: '',          // 扫码带入的无人车编号（需求5）
    atLoadingPoint: false,
    dist: '',
    loadMsg: '',
    countdown: 0,
    countdownText: '',
    hintWarn: false,      // 倒计时超时后提示转警示色
    canDeleteBatch: false // 删除批次：店主专属 + 只对活跃批次开放
  },
  timer: null,
  openTimer: null,     // 自动开舱重试计时器
  _opening: false,     // 开舱请求进行中（防重入，避免 onShow 与 load 并发各发一次）
  _retryCount: 0,      // 本轮自动重试已用次数

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

  onHide() { this.clearTimers() },
  onUnload() { this.clearTimers() },

  clearTimers() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
  },

  startCountdown(sec) {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.setData({ countdown: sec, countdownText: '建议 ' + sec + 's 内发起配送', hintWarn: false })
    this.timer = setInterval(() => {
      const n = this.data.countdown - 1
      if (n <= 0) {
        clearInterval(this.timer); this.timer = null
        // 超时后保留文案（不清空），只是转警示色 —— 货一直躺在舱里才是要提醒的事
        this.setData({ countdown: 0, countdownText: '已超过建议等待时长，请尽快发起配送', hintWarn: true })
      } else {
        this.setData({ countdown: n, countdownText: '建议 ' + n + 's 内发起配送' })
      }
    }, 1000)
  },

  async load() {
    try {
      const b = await request.get(api.batchDetail, { batch_id: this.data.id }, { silent: true })
      // 重进页面按后端批次/任务状态恢复操作阶段（问题2修复）：
      // 之前 phase 是纯前端本地状态，退出重进后回到 scanned → 按钮错乱。
      const phase = this.inferPhase(b)
      this.setData({
        batch: this.decorate(b),
        phase,
        // 删除批次：店主专属，且只对活跃批次开放（组单中/待上货/配送中），与后端口径保持一致；
        // 前端先拦一道，免得店员点了才弹"无权限"——request.js 遇 403 会清登录态把人踢回登录页。
        canDeleteBatch: role.isOwner() && [0, 1, 2].indexOf(Number(b.status)) >= 0
      })
      // 舱门没开就自动开 —— 这是「点『上货』即自动开盖」的落点，也兜住扫码入口与中途重进。
      if (phase === 'scanned') this.ensureBinOpen()
    } catch (e) { /* handled */ }
  },

  // 由后端状态推断初始 phase
  // 只用后端两个持久标记：ready_dispatch=已关舱、bin_opened=已开舱。
  // status=1 的三个子状态与这两个标记一一对应（都无=舱没开 / bin_opened=舱已开 / ready_dispatch=已关舱），
  // 所以不需要第三条判据。
  inferPhase(b) {
    const st = Number(b.status)
    if (st === 0) return 'pending' // 组单中：未派车定型，详情页只读展示
    if (st === 2 || st === 3 || st === 4) return 'dispatched' // 配送中/已完成/已取消：不再可操作
    if (st === 1) {
      if (b.ready_dispatch === true) return 'loaded' // 已关舱（货装好）→ 立即配送
      if (b.bin_opened === true) return 'open'       // 舱已开 → 请放货，等「立即配送」
      // 两个标记都没有 = 舱没开过 → 自动开舱（本页存在意义的那条路径）。
      //
      // 曾经这里用「订单任务状态」兜底（max>=50 → loaded），2026-10-06 实测证明是错的：
      //   演示档 mock 状态机不等商家操作，定型后每 4s 自主推进一级，28s 就把任务推到 80「任务完成」；
      //   自动定型又在 90s 就发生。于是商家打开页面时任务早已 80，而舱其实从没开过 ——
      //   实测 bin_opened=false / ready_dispatch=false / task_status=80 → 误判成 loaded，
      //   自动开舱被整条跳过，页面直接显示「货品已装好，点击按钮立即出发」。
      //   真机档同理：任务到 40/50 是平台回调的滞后信息，晚于我们的开舱动作，且召唤模式压根没有任务。
      // 老数据（本次迁移前开的舱、没有 bin_opened_at）会落到这里重开一次舱 —— 开舱接口已幂等，无害。
      return 'scanned'
    }
    return 'scanned'
  },

  // ---------- 自动开舱 ----------
  // 由 load() 在 phase=scanned 时调用，也可由「重新尝试开舱」按钮手动触发。
  // 幂等：已在请求中直接返回；舱已开（phase 非 scanned）不再重复调用，避免重复下发平台指令。
  ensureBinOpen() {
    if (!this.data.batch || this.data.phase !== 'scanned') return
    if (this._opening) return
    this._opening = true
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
    this.setData({ opening: true, openError: '', canRetryOpen: false })
    request.post(api.batchOpenBin, { batch_id: this.data.batch.id }, { silent: true })
      .then((data) => {
        this._opening = false
        // 车未到上货点：后端返回 200{waiting:true}，属「等待提示」不是错误 ——
        // 不进入开舱态，稍后自动重试（商家也可以点按钮立刻重试）
        if (data && data.waiting) {
          this.setData({ opening: false, openError: data.msg || '机器人还没到达上货点，正在等待…', canRetryOpen: true })
          this.scheduleOpenRetry()
          return
        }
        this._retryCount = 0
        this.setData({ phase: 'open', opening: false, openError: '', canRetryOpen: false })
      })
      .catch((e) => {
        this._opening = false
        this.setData({
          opening: false,
          openError: (e && e.message) || '开舱失败，请稍后重试',
          canRetryOpen: true
        })
        this.scheduleOpenRetry()
      })
  },

  // 自动重试：机器人走到上货点通常要几十秒，让页面自己等，不逼商家守着屏幕点。
  // 到 OPEN_RETRY_MAX 次就停手 —— 一直打后端既没用也会盖住真正的原因（车离线/被占用），
  // 此时保留「重新尝试开舱」按钮，由商家判断要不要继续。
  scheduleOpenRetry() {
    if (this.openTimer) return
    if (this._retryCount >= OPEN_RETRY_MAX) {
      this.setData({ openError: (this.data.openError || '舱门暂未打开') + '（已自动重试 ' + OPEN_RETRY_MAX + ' 次，可手动重试）', canRetryOpen: true })
      return
    }
    this._retryCount += 1
    this.openTimer = setTimeout(() => {
      this.openTimer = null
      if (this.data.phase === 'scanned') this.ensureBinOpen()
    }, OPEN_RETRY_MS)
  },

  // 商家手动重试：重置计数，重新走一轮自动重试
  retryOpenBin() {
    this._retryCount = 0
    this.ensureBinOpen()
  },

  // ---------- 删除批次（店主专属；2026-10-07 从管理员网页「清理批次」迁来） ----------
  // 这一步会连带删掉批内全部订单（作废机器人任务 + 回补库存 + 平台召回）并释放设备控制权，
  // 所以确认弹窗必须把"会波及哪些单"说清楚：商家以为只删一个批次、实际砍掉好几单，是最容易出事的误解。
  deleteBatch() {
    const b = this.data.batch
    if (!b) return
    const n = (b.orders || []).length
    wx.showModal({
      title: '删除批次',
      content: '将取消该批次内全部 ' + n + ' 个订单（作废机器人任务、回补库存、召回机器人）并释放设备控制权。用户端会看到订单已取消，不可撤销。确定删除？',
      confirmText: '删除',
      confirmColor: '#E64340',
      success: (r) => { if (r.confirm) this.doDeleteBatch() }
    })
  },

  async doDeleteBatch() {
    wx.showLoading({ title: '删除中' })
    try {
      const out = await request.post(api.batchDelete, { batch_id: this.data.batch.id }, { silent: true })
      wx.hideLoading()
      this.clearTimers()
      const failed = (out && out.failed) || []
      wx.showModal({
        title: '批次已删除',
        content: '已取消 ' + ((out && out.cancelled) || 0) + ' 个订单'
          + (failed.length ? '，另有 ' + failed.length + ' 项未成功：' + failed.slice(0, 3).join('；') : ''),
        showCancel: false,
        confirmText: '知道了',
        success: () => wx.navigateBack()
      })
    } catch (e) {
      wx.hideLoading()
      wx.showModal({ title: '删除失败', content: (e && e.message) || '请稍后重试', showCancel: false, confirmText: '知道了' })
    }
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

  // ---------- 立即配送（唯一操作入口） ----------
  // 放好货后点它 → 二次确认 → 关舱（若还开着）+ 启动配送。
  // 二次确认是防误触：一旦发起，机器人就出发了，没有撤回入口。
  confirmDispatch() {
    if (!this.data.batch) return
    const phase = this.data.phase
    if (phase === 'dispatched') return
    if (phase !== 'open' && phase !== 'loaded') return
    wx.showModal({
      title: '是否立即发起配送？',
      content: phase === 'open'
        ? '机器人将关闭舱门并立即出发，请确认货品已全部放入。'
        : '机器人将立即出发，请确认货品已全部放入。',
      confirmText: '立即配送',
      cancelText: '再等等',
      confirmColor: '#3078C0',
      success: (r) => {
        if (r.confirm) this.closeAndDispatch()
        else this.startCountdown(180)   // 先不配送：起个提醒倒计时，别让货一直躺在舱里
      }
    })
  },

  // 关舱 + 立即配送。关舱不能省：真实环境下车在舱门打开时不允许移动。
  async closeAndDispatch() {
    if (this.data.phase === 'open') {
      wx.showLoading({ title: '关舱中' })
      try {
        await request.post(api.batchCloseBin, { batch_id: this.data.batch.id }, { silent: true })
        this.setData({ phase: 'loaded' })
        wx.hideLoading()
      } catch (e) {
        wx.hideLoading()
        wx.showModal({
          title: '关舱失败',
          content: (e && e.message) || '关舱失败，请稍后重试',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
    }
    this.dispatchAll()
  },

  // 开始配送（整批确认上货）。测试阶段走模拟接口；真实模式走平台确认上货 + 释放控制权。
  dispatchAll() {
    if (!this.data.batch) return
    if (this.data.phase === 'dispatched') return
    // 安全前置（P1-x）：舱门开着时车不能移动 —— 只有已关舱(loaded)才允许开始配送
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
          this.clearTimers()
          this._opening = false
          this.setData({ phase: 'dispatched' })
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
    // ---- 真实模式 ----
    wx.showLoading({ title: '开始配送' })
    request.post(api.batchDispatchAll, { batch_id: this.data.batch.id }, { silent: true })
      .then(() => {
        wx.hideLoading()
        this.clearTimers()
        this._opening = false
        this.setData({ phase: 'dispatched' })
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
  }
})
