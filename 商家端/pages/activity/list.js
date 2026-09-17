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
      const now = Date.now()
      const TYPE = { custom: '自由', discount: '打折', full_reduce: '满减' }
      const decorated = activities.map((a) => {
        const at = (t) => (t ? new Date(t.replace(' ', 'T')).getTime() : NaN)
        const s = at(a.start_at), e = at(a.end_at)
        let state = 'active', state_txt = '进行中'
        if (!isNaN(s) && now < s) { state = 'pending'; state_txt = '未开始' }
        else if (!isNaN(e) && now > e) { state = 'ended'; state_txt = '已结束' }
        // 已下线覆盖时间状态
        if (a.status !== 1) { state = 'offline'; state_txt = '已下线' }
        return Object.assign({}, a, {
          type_txt: TYPE[a.type] || '展示',
          state, state_txt
        })
      })
      this.setData({ activities: decorated })
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
