// 活动页：顶部渐变权益头 + 活动列表（后端 /activity/list，无进行中活动时显示空态）
const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    activities: []
  },

  onShow() {
    this.load()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  async load() {
    try {
      const activities = await request.get(api.activityList)
      this.setData({ activities })
    } catch (e) { /* handled */ }
  },

  onActivity(e) {
    const link = e.currentTarget.dataset.link
    if (link) wx.navigateTo({ url: link })
  }
})
