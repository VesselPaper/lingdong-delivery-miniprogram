const shopState = require('../../utils/shopState')
const request = require('../../utils/request')

Page({
  data: {
    business: 'open',
    autoAccept: false,
    deliveryFee: '1.00'
  },

  async onLoad() {
    await shopState.loadShop()
    this.setData({
      business: shopState.getBusiness(),
      autoAccept: shopState.getAutoAccept(),
      deliveryFee: shopState.getDeliveryFee().toFixed(2)
    })
  },

  async setBusiness(e) {
    const val = e.currentTarget.dataset.val
    await shopState.setBusiness(val)
    this.setData({ business: shopState.getBusiness() })
    if (shopState.getBusiness() === 'open') {
      wx.showToast({ title: '已切换为营业，可正常接单', icon: 'none' })
    } else {
      wx.showToast({ title: '已切换为歇业，暂停接单', icon: 'none' })
    }
  },

  async onAutoAccept(e) {
    const val = e.detail.value
    await shopState.setAutoAccept(val)
    this.setData({ autoAccept: shopState.getAutoAccept() })
    wx.showToast({ title: val ? '已开启自动接单' : '已关闭自动接单', icon: 'none' })
  },

  onFeeInput(e) {
    this.setData({ deliveryFee: e.detail.value })
  },

  // 失焦时才提交：避免边输边请求；非法值回退到后端当前值
  async onFeeBlur(e) {
    const raw = e.detail && e.detail.value !== undefined ? e.detail.value : this.data.deliveryFee
    const n = Number(raw)
    if (String(raw).trim() === '' || isNaN(n) || n < 0 || n > 999) {
      wx.showToast({ title: '请输入 0~999 的金额', icon: 'none' })
      this.setData({ deliveryFee: shopState.getDeliveryFee().toFixed(2) })
      return
    }
    await shopState.setDeliveryFee(n)
    const saved = shopState.getDeliveryFee().toFixed(2)
    this.setData({ deliveryFee: saved })
    wx.showToast({ title: '配送费已更新为 ¥' + saved, icon: 'none' })
  },

  goMonitor() {
    wx.navigateTo({ url: '/pages/delivery/monitor' })
  },

  logout() {
    // 统一清理：token / userInfo / runtimeFlags / shopInfo + globalData + 断开推送 WebSocket。
    // 店员手机常共用，只删 token 会让下一位登录者先看到上一位商家的营业状态与配送费。
    request.clearLoginState()
    wx.showToast({ title: '已退出', icon: 'success' })
    setTimeout(() => {
      wx.reLaunch({ url: '/pages/user/login' })
    }, 500)
  }
})
