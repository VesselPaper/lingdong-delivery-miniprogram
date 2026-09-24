const api = require('../../utils/api')
const request = require('../../utils/request')
const scan = require('../../utils/scan')

// 扫码取餐页（需求5）：扫无人车二维码 → 输入取餐码 → 校验归属 → 开舱/取餐/关舱。
// 与 pickup 页的区别：pickup 依赖订单号直连（列表/详情进入），本页走「车 + 取餐码」定位本人订单。
// 需求 2026-09-24（微信扫一扫直达）：小程序码 scene=纯设备号 → onLoad 自动解析并校验，
// 未登录先存 pending_pickup_sn（登录成功后回跳本页继续），无订单/配送中按 status_hint 分流提示。
Page({
  data: {
    deviceSn: '',
    pickupCode: '',
    order: null,
    phase: 'scan',   // scan=待扫码输码 | ready=已定位可取餐 | open=已开舱 | autoClosed | done
    countdown: 0,
    scanFail: false, // 扫码自动校验未匹配到本人订单 → 展示「输入取餐码 / 再次扫码」回退
    statusHint: '',  // 未匹配时的后端提示：delivering=配送中 | none=无订单
    hintOrder: null, // delivering 时的订单信息（order_id/order_no/landmark_name）
    demo: false // 演示档（登录为 demo 时提供「模拟扫码」测试入口，按钮带「演示」标注）
  },
  timer: null,

  onLoad(options) {
    const flags = wx.getStorageSync('runtimeFlags') || {}
    // 微信扫一扫直达（小程序码）：scene 是 URL 编码的纯设备号；旧入口 options.sn 兼容
    let sn = String(options.sn || '')
    if (!sn && options.scene) {
      try {
        sn = decodeURIComponent(String(options.scene)).trim()
      } catch (e) { /* 解析失败视为空 */ }
    }
    // 未登录：先记下待校验设备号，登录成功后会回跳本页继续（见 login.js）
    if (sn && !wx.getStorageSync('token')) {
      wx.setStorageSync('pending_pickup_sn', sn)
    }
    this.setData({
      demo: flags.login === 'demo',
      deviceSn: sn
    })
    // 带设备号进入（微信扫一扫直达 / 链接带 sn）：自动校验，免手动扫码
    if (sn) this.matchByScan()
  },

  onHide() { this.clearTimer() },
  onUnload() { this.clearTimer() },

  clearTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  // 扫无人车二维码（真实摄像头 wx.scanCode）→ 自动校验账号（本人在该车有待取餐订单则免输码）
  scanRobot() {
    wx.scanCode({
      success: (r) => {
        const sn = scan.parseDeviceSn(r.result)
        if (!sn) { wx.showToast({ title: '二维码无效，请扫无人车上的二维码', icon: 'none' }); return }
        this.setData({ deviceSn: sn, scanFail: false })
        // 先按登录账号自动匹配：匹配到直接可取餐；匹配不到保留取餐码输入（代取场景）
        this.matchByScan()
      },
      fail: () => {}
    })
  },

  // 自动校验：当前登录账号在该无人车上是否有待取餐订单（2026-09-24 起按 status_hint 区分无订单/配送中）
  async matchByScan() {
    const sn = String(this.data.deviceSn).trim()
    if (!sn) { this.setData({ scanFail: true }); return }
    wx.showLoading({ title: '自动校验中' })
    try {
      const data = await request.post(api.pickupByScan, { device_sn: sn })
      wx.hideLoading()
      if (data && data.auto_matched && data.order_id) {
        this.setData({ order: data, phase: 'ready', autoMatched: true, scanFail: false, statusHint: '', hintOrder: null })
        wx.showToast({ title: '已自动匹配您的订单，点击开舱取餐', icon: 'none', duration: 2000 })
      } else {
        // 未匹配到本人待取餐订单：按后端提示分流（delivering=配送中 / none=无订单）
        this.setData({
          scanFail: true,
          statusHint: (data && data.status_hint) || 'none',
          hintOrder: (data && data.status_hint === 'delivering') ? data : null
        })
      }
    } catch (e) {
      wx.hideLoading()
      this.setData({ scanFail: true, statusHint: 'none', hintOrder: null })
    }
  },

  // 「输入取餐码」回退：隐藏未匹配提示，展示取餐码输入区
  focusCode() {
    this.setData({ scanFail: false })
  },

  // 无订单/配送中提示里的「查看我的订单」
  goOrders() {
    wx.navigateTo({ url: '/pages/order/list' })
  },

  // 无订单提示里的「去商城下单」
  goShop() {
    wx.switchTab({ url: '/pages/goods/list' })
  },

  // 配送中提示里的「查看该订单」
  goOrder() {
    const id = this.data.hintOrder && this.data.hintOrder.order_id
    if (!id) { this.goOrders(); return }
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },

  // 演示档测试入口：直接填入测试设备号（按钮已标注「演示」）
  mockScan() {
    this.setData({ deviceSn: 'TESTROBOT001' })
    wx.showToast({ title: '已填入演示设备号，请输入取餐码', icon: 'none' })
  },

  onCodeInput(e) {
    this.setData({ pickupCode: e.detail.value })
  },

  // 校验：无人车 + 取餐码 → 定位本人待取餐订单（后端校验归属）
  async verify() {
    const sn = String(this.data.deviceSn).trim()
    const code = String(this.data.pickupCode).trim()
    if (!sn) { wx.showToast({ title: '请先扫无人车二维码', icon: 'none' }); return }
    if (!code) { wx.showToast({ title: '请输入取餐码', icon: 'none' }); return }
    wx.showLoading({ title: '校验中' })
    try {
      const order = await request.post(api.pickupByCode, { device_sn: sn, pickup_code: code })
      wx.hideLoading()
      this.setData({ order, phase: 'ready', scanFail: false })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '校验失败', icon: 'none' })
    }
  },

  // 打开舱门取餐（取走标记在「关闭舱门」时完成，未取到餐可重新打开）
  async openBin() {
    const orderId = this.data.order.order_id
    wx.showLoading({ title: '开舱中' })
    try {
      await request.post(api.pickupOpen, { order_id: orderId })
      wx.hideLoading()
      wx.showToast({ title: '舱门已打开，请取餐', icon: 'success', duration: 3000 })
      this.setData({ phase: 'open', countdown: 40 })
      this.startCountdown(40)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '开舱失败', icon: 'none', duration: 3000 })
    }
  },

  // 单订单关舱取走（非多单：只关当前这一单，标记该单已完成）
  async closeBin() {
    const orderId = this.data.order.order_id
    wx.showLoading({ title: '关舱中' })
    try {
      await request.post(api.pickupClose, { order_id: orderId })
      wx.hideLoading()
      this.clearTimer()
      this.setData({ phase: 'done', countdown: 0 })
      wx.showToast({ title: '已关舱，取餐完成', icon: 'success', duration: 3000 })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '关舱失败', icon: 'none', duration: 3000 })
    }
  },

  // 【同点多单一起取】一次关舱 = 确认本取货点全部订单都已取走（后端批量置已完成）
  async closeAllBin() {
    const { batch_id, landmark_id } = this.data.order
    wx.showLoading({ title: '确认取走' })
    try {
      const r = await request.post(api.pickupCloseAll, { batch_id, landmark_id })
      wx.hideLoading()
      this.clearTimer()
      this.setData({ phase: 'done', countdown: 0 })
      wx.showToast({ title: (r && r.count) ? ('已确认，' + r.count + ' 单全部取走') : '已确认取走', icon: 'success', duration: 3000 })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '取走确认失败', icon: 'none', duration: 3000 })
    }
  },

  startCountdown(sec) {
    this.clearTimer()
    this.setData({ countdown: sec })
    this.timer = setInterval(() => {
      const n = this.data.countdown - 1
      if (n <= 0) {
        this.clearTimer()
        this.setData({ phase: 'autoClosed', countdown: 0 })
      } else {
        this.setData({ countdown: n })
      }
    }, 1000)
  },

  reopen() { this.openBin() },

  done() {
    wx.navigateBack()
  }
})
