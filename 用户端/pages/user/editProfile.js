const api = require('../../utils/api')
const request = require('../../utils/request')

// 编辑个人信息：昵称 + 手机号（保存调 PUT /user/profile）
Page({
  data: {
    nickname: '',
    phone: '',
    saving: false
  },

  async onLoad() {
    try {
      const user = await request.get(api.getProfile)
      this.setData({ nickname: user.nickname || '', phone: user.phone || '' })
    } catch (e) { /* 未登录时 request 层会引导登录 */ }
  },

  onNickname(e) {
    this.setData({ nickname: e.detail.value })
  },

  onPhone(e) {
    this.setData({ phone: e.detail.value })
  },

  async save() {
    const nickname = String(this.data.nickname).trim()
    const phone = String(this.data.phone).trim()
    if (!nickname) { wx.showToast({ title: '请输入昵称', icon: 'none' }); return }
    if (phone && !/^1\d{10}$/.test(phone)) { wx.showToast({ title: '请填写正确的手机号', icon: 'none' }); return }
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中' })
    try {
      const user = await request.put(api.updateProfile, { nickname, phone })
      wx.setStorageSync('userInfo', user)
      wx.hideLoading()
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
    }
  }
})
