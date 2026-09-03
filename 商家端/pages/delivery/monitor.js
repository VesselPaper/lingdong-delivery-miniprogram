const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    robots: [],
    robotsError: '',
    tasks: []
  },

  onShow() {
    this.load()
    this.timer = setInterval(() => this.load(true), 5000)
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
      const tasks = await request.get(api.deliveryMonitor, {}, { silent: true })
      this.setData({ tasks })
    } catch (e) { /* 静默：错误以页面状态呈现 */ }
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
  }
})
