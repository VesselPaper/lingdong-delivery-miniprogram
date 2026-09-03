const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    list: []
  },

  onShow() {
    this.load()
  },

  async load() {
    try {
      const list = await request.get(api.addressList)
      this.setData({ list })
    } catch (e) { /* handled */ }
  },

  add() {
    wx.navigateTo({ url: '/pages/address/edit' })
  },

  edit(e) {
    wx.navigateTo({ url: '/pages/address/edit?id=' + e.currentTarget.dataset.id })
  },

  async del(e) {
    const id = Number(e.currentTarget.dataset.id)
    const res = await new Promise((resolve) => {
      wx.showModal({ title: '删除该地址？', confirmColor: '#111111', success: (r) => resolve(r.confirm) })
    })
    if (!res) return
    try {
      await request.del(api.addressDelete, { id })
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
  }
})
