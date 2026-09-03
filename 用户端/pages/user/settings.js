const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    form: { nickname: '', phone: '' }
  },

  onLoad() {
    const info = wx.getStorageSync('userInfo')
    if (info) {
      this.setData({ form: { nickname: info.nickname || '', phone: info.phone || '' } })
    }
    this.loadProfile()
  },

  async loadProfile() {
    try {
      const user = await request.get(api.getProfile)
      this.setData({ form: { nickname: user.nickname || '', phone: user.phone || '' } })
    } catch (e) { /* handled */ }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const v = e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: v })
  },

  async save() {
    const { nickname, phone } = this.data.form
    if (phone && !/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
      return
    }
    try {
      const user = await request.put(api.updateProfile, { nickname, phone })
      wx.setStorageSync('userInfo', user)
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmColor: '#2E7CF6',
      success: (r) => {
        if (!r.confirm) return
        wx.removeStorageSync('token')
        wx.removeStorageSync('userInfo')
        wx.reLaunch({ url: '/pages/user/login' })
      }
    })
  }
})
