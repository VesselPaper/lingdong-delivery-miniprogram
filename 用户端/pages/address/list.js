const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    list: [],
    pointId: ''    // 当前配送楼栋 id（与首页顶部、结算页楼栋是同一份后端数据）
  },

  onShow() {
    this.load()
    this.loadPoint()
  },

  async load() {
    try {
      const list = await request.get(api.addressList)
      this.setData({ list })
    } catch (e) { /* handled */ }
  },

  // 当前楼栋以后端为准，用于在列表里标出「当前送达」并决定是否显示「送到这里」
  async loadPoint() {
    try {
      const p = await request.get(api.userPoint)
      this.setData({ pointId: p && p.landmark_id ? String(p.landmark_id) : '' })
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

  // 直接切换当前配送楼栋：写的是后端 /user/point，首页顶部与结算页楼栋会同步变化
  async setPoint(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = this.data.list.find((a) => Number(a.id) === id)
    if (!item || !item.landmark_id) return
    try {
      await request.put(api.userPoint, { landmark_id: String(item.landmark_id) })
      this.setData({ pointId: String(item.landmark_id) })
      wx.showToast({ title: '已切换至' + (item.landmark_name || '该楼栋'), icon: 'none' })
    } catch (err) { /* handled */ }
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
