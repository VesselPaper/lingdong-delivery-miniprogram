const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    activities: []
  },

  onShow() {
    this.load()
  },

  async load() {
    try {
      const activities = await request.get(api.activities)
      this.setData({ activities })
    } catch (e) { /* handled */ }
  },

  add() {
    wx.navigateTo({ url: '/pages/activity/edit' })
  },

  noop() {},

  edit(e) {
    wx.navigateTo({ url: '/pages/activity/edit?id=' + e.currentTarget.dataset.id })
  },

  // 上下线：status 1 发布（用户端可见） / 0 下线
  async toggleStatus(e) {
    const { id, status } = e.currentTarget.dataset
    try {
      await request.put(api.activityStatus, { id: Number(id), status: Number(status) === 1 ? 0 : 1 })
      wx.showToast({ title: Number(status) === 1 ? '已下线' : '已发布', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  },

  async del(e) {
    const id = Number(e.currentTarget.dataset.id)
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除该活动？',
        confirmColor: '#3078C0',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.del(api.activities, { id })
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  }
})
