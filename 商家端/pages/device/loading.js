const api = require('../../utils/api')
const request = require('../../utils/request')

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

  // 选择待上货批次 → 进入批次上货详情页（左上角返回回到本列表）
  selectBatch(e) {
    const item = e.detail || {}
    if (item && item.id) wx.navigateTo({ url: '/pages/device/batchDetail?id=' + item.id })
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
  }
})
