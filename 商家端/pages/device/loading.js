const api = require('../../utils/api')
const request = require('../../utils/request')
const scan = require('../../utils/scan')
const push = require('../../utils/push')

// 上货配单（一车多单 · 配送批次列表）
// 只展示「组单中（可派车） + 待上货（可上货）」两类批次；配送中/待取货请看任务页与配送监控。
// 点「选择该批次上货」进入批次上货详情页（pages/device/batchDetail，左上角返回回到本列表）。
// 卡面标题用「批次 N / 订单 N」当日序号，完整批次编号只在批次详情弱化显示。

const ORDER_ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }
const BATCH_TAG_CLASS = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }

Page({
  data: {
    keyword: '',
    openBatches: [],
    readyBatches: [],
    loadingList: true
  },
  rawOpen: [],
  rawReady: [],

  onLoad() {
    // 收到「新订单 / 批次定型」推送 → 配单页(/device/loading)局部重拉批次列表：
    // 新单进组单中需即时出现；自动定型后批次从「组单中」移到「待上货」，卡面不能一直停在组单中。
    this._onPush = (msg) => {
      if (msg && (msg.type === 'order_created' || msg.type === 'batch_dispatched')) { this.loadPending() }
    }
    push.subscribe(this._onPush)
  },

  onUnload() {
    push.unsubscribe(this._onPush)
  },

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
      this.setData({ loadingList: false }, () => this.applySearch())
    } catch (e) {
      this.rawOpen = []
      this.rawReady = []
      this.setData({ loadingList: false, openBatches: [], readyBatches: [] })
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
      // 组单中/待上货批次统一走「上货」入口（派车由后端接单后自动完成，商家不再手动派车）
      let action = (kind === 'open' || kind === 'ready') ? 'select' : ''
      if (kind === 'ready' && orders.length && orders.every((o) => Number(o.status) === 6)) action = ''
      return Object.assign({}, b, {
        action,
        index: idx,
        statusTagClass: BATCH_TAG_CLASS[Number(b.status)] || 'tag-gray',
        orders,
        // 问题3：已关舱(货装好)的批次 → 卡片标注「已锁定·待配送」
        dispatchMark: b.ready_dispatch === true,
        // 问题3/4：批次指派车是否忙 → 卡面给禁用/忙提示 + 上货入口拦截
        robotBusy: b.robot_busy === true,
        robotBusyLabel: b.robot_busy_msg || '无人车正在配送中，请稍后再试'
      })
    })
  },

  // ---------- 搜索：批次 / 订单 / 商品 / 点位 / 收餐人 ----------
  onSearch(e) {
    // 兼容原生 input（e.detail.value）与 search-box 组件（e.detail 直接为值）
    const v = (e.detail && e.detail.value !== undefined) ? e.detail.value : e.detail
    this.setData({ keyword: v || '' }, () => this.applySearch())
  },

  applySearch() {
    const kw = (this.data.keyword || '').trim().toLowerCase()
    const hit = (b) => {
      if (!kw) return true
      if (String(b.batch_no || '').toLowerCase().indexOf(kw) > -1) return true
      if (String(b.code_short || '').toLowerCase().indexOf(kw) > -1) return true
      if (String(b.daily_seq || '') === kw) return true
      return (b.orders || []).some((o) =>
        String(o.order_no || '').toLowerCase().indexOf(kw) > -1 ||
        String(o.code_short || '').toLowerCase().indexOf(kw) > -1 ||
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

  // 上货按钮：批次定型 + 进入上货详情页
  selectBatch(e) {
    this.enterBatch(e.detail || {})
  },

  // 点批次卡面 → 只查看批次详情（不执行定型/派车；组单中批次在详情页会提示先点上货定型）
  goBatchDetail(e) {
    const item = e.detail || {}
    if (!item || !item.id) return
    wx.navigateTo({ url: '/pages/device/batchDetail?id=' + item.id })
  },

  // 点批次内订单卡面 → 查看该订单详情
  goOrderDetail(e) {
    const o = e.detail || {}
    if (o && o.id) wx.navigateTo({ url: '/pages/orders/detail?id=' + o.id })
  },

  // 进入批次上货详情页
  //  - 组单中批次（status=0）：先创建配送任务定型（机器人已在上货点待命），再进入上货页
  //  - 待上货批次（status=1）：已定型，直接进入上货页
  async enterBatch(item) {
    if (!item || !item.id) return
    const st = Number(item.status)
    // 问题4：待上货批次指派车正忙（配送/占用）时，禁止进入详情打断配送。
    // robot_busy 由后端 pending 下发（decorate 已带下来）；字段缺失按可用处理。
    if (st === 1 && item.robot_busy === true) {
      wx.showModal({
        title: '暂无空闲机器人',
        content: item.robot_busy_msg || '无人车正在配送，请稍后再上货',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    if (st === 0) {
      wx.showLoading({ title: '创建配送任务' })
      try {
        // silent：失败原因由下方确认弹窗展示，避免 request 默认悬浮 toast 与其重叠
        await request.post(api.batchDispatch, { batch_id: item.id }, { silent: true })
        wx.hideLoading()
      } catch (err) {
        wx.hideLoading()
        // 明确提示（弹窗而非一闪而过的 toast）：机器人离线/忙碌等要给商家可操作的引导
        wx.showModal({
          title: '暂时无法上货',
          content: (err && err.message) || '创建配送任务失败，请稍后重试',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
    }
    wx.navigateTo({ url: '/pages/device/batchDetail?id=' + item.id })
  },

  // 扫无人车二维码（需求5）：真实摄像头扫码 → 识别设备 → 进入该车待上货批次上货页
  async scanRobot() {
    try {
      const raw = await new Promise((resolve, reject) => {
        wx.scanCode({ success: (r) => resolve(r.result), fail: reject })
      })
      const sn = scan.parseDeviceSn(raw)
      if (!sn) {
        wx.showModal({ title: '二维码无效', content: '请扫无人车上的二维码', showCancel: false, confirmText: '知道了' })
        return
      }
      wx.showLoading({ title: '识别无人车' })
      // silent：失败原因由下方确认弹窗展示，避免 request 默认悬浮 toast 与其重叠
      const data = await request.post(api.deviceScan, { deviceSn: sn }, { silent: true })
      wx.hideLoading()
      if (!data || !data.batch_id) {
        wx.showModal({ title: '未识别到待上货批次', showCancel: false, confirmText: '知道了' })
        return
      }
      const q = 'batch_id=' + data.batch_id
        + '&sn=' + encodeURIComponent(data.device_sn || sn)
        + '&at=' + (data.at_loading_point ? '1' : '0')
        + '&dist=' + (data.distance_m === null || data.distance_m === undefined ? '' : data.distance_m)
        + '&lmsg=' + encodeURIComponent(data.loading_msg || '')
      wx.navigateTo({ url: '/pages/device/batchDetail?' + q })
    } catch (e) {
      wx.hideLoading()
      const msg = (e && e.message) || ''
      if (msg.indexOf('cancel') > -1) return
      // 扫码是商家的主动动作，失败原因需要看清才能据此操作（车离线 / 车忙 / 无单可上 / 批次已派给别的车），
      // 统一用弹窗展示后端下发的可操作提示，不用一闪而过的 toast。
      wx.showModal({
        title: '暂时无法上货',
        content: msg || '扫码失败，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    }
  }
})
