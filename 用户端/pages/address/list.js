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

  // 设为默认地址（复用保存接口，回传该地址全字段 + is_default=1，避免覆盖字段为空）
  async setDefault(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = this.data.list.find((a) => Number(a.id) === id)
    if (!item) return
    try {
      await request.post(api.addressSave, Object.assign({}, item, { is_default: 1, id }))
      wx.showToast({ title: '已设为默认', icon: 'success' })
      this.load()
    } catch (e) { /* handled */ }
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
