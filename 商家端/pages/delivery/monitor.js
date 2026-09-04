const api = require('../../utils/api')
const request = require('../../utils/request')

// 配送中监控：按「批次」分组展示（一个批次一个卡面，批次内嵌套多个订单），与上货配单页同布局。
// 数据来源 /merchant/device/pending 的 active_batches（批次状态=配送中）。
const ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }
const BATCH_TAG = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }

Page({
  data: {
    robots: [],
    robotsError: '',
    batches: []
  },

  onShow() {
    this.load()
    this.timer = setInterval(() => this.load(), 5000)
  },

  onHide() {
    if (this.timer) clearInterval(this.timer)
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
  },

  async load() {
    this.loadRobots()
    try {
      const data = await request.get(api.devicePending, {}, { silent: true })
      this.setData({
        batches: (data.active_batches || []).map((b) => this.decorate(b))
      })
    } catch (e) { /* 静默：错误以页面状态呈现 */ }
  },

  decorate(b) {
    return Object.assign({}, b, {
      statusTagClass: BATCH_TAG[Number(b.status)] || 'tag-blue',
      orders: (b.orders || []).map((o) => {
        if (o.picked_up) return Object.assign({}, o, { stClass: 'green', displayStatus: '已取' })
        const st = Number(o.status)
        let cls = ST_CLASS[st] || 'gray'
        let ds = o.status_text || ''
        if (st === 2) { cls = 'blue'; ds = '配送中' }
        else if (st === 3) { cls = 'green'; ds = '待取货' }
        else if (st === 6) { cls = 'red'; ds = '配送异常' }
        return Object.assign({}, o, { stClass: cls, displayStatus: ds })
      })
    })
  },

  // 机器人真实状态（silent：轮询失败不弹 toast，以错误卡呈现，不刷屏）
  async loadRobots() {
    try {
      const robots = await request.get(api.robots, {}, { silent: true })
      this.setData({ robots, robotsError: '' })
    } catch (e) {
      this.setData({ robots: [], robotsError: (e && e.message) || '获取机器人失败' })
    }
  },

  retryRobots() {
    this.loadRobots()
  },

  goLoad() {
    wx.navigateTo({ url: '/pages/device/loading' })
  },

  // 批次卡面内点某单 → 进订单详情
  goDetailByOrder(e) {
    const o = e.detail || {}
    if (o && o.id) wx.navigateTo({ url: '/pages/orders/detail?id=' + o.id })
  }
})
