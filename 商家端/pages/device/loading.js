const api = require('../../utils/api')
const request = require('../../utils/request')
const scan = require('../../utils/scan')

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

  // 上货按钮：批次定型 + 进入上货详情页
  //  - 组单中批次（status=0）：先创建配送任务定型（机器人已在上货点待命），再进入上货页
  //  - 待上货批次（status=1）：已定型，直接进入上货页
  async selectBatch(e) {
    const item = e.detail || {}
    if (!item || !item.id) return
    const st = Number(item.status)
    if (st === 0) {
      wx.showLoading({ title: '创建配送任务' })
      try {
        await request.post(api.batchDispatch, { batch_id: item.id })
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
      if (!sn) { wx.showToast({ title: '二维码无效，请扫无人车上的二维码', icon: 'none' }); return }
      wx.showLoading({ title: '识别无人车' })
      const data = await request.post(api.deviceScan, { deviceSn: sn })
      wx.hideLoading()
      if (!data || !data.batch_id) { wx.showToast({ title: '未识别到待上货批次', icon: 'none' }); return }
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
      if (msg.indexOf('没有待上货') > -1 || msg.indexOf('先派车') > -1) {
        wx.showModal({
          title: '该无人车暂无待上货批次',
          content: '请先在商家端「接单」，接单后机器人会自动前往上货点；待其到达后再扫码上货。',
          showCancel: false
        })
      } else {
        wx.showToast({ title: msg || '扫码失败', icon: 'none' })
      }
    }
  }
})
