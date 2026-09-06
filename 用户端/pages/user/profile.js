const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    user: {},
    userInitial: '零',
    orderBadge: { unread: false, count: 0, paying: 0, delivering: 0, arrived: 0, finished: 0 }
  },

  onShow() {
    this.load()
    this.loadBadge()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
  },

  async load() {
    try {
      const user = await request.get(api.getProfile)
      const initial = user.nickname ? user.nickname.charAt(0) : '零'
      this.setData({ user, userInitial: initial })
    } catch (e) {
      this.setData({ user: {}, userInitial: '零' })
    }
  },

  // 订单红点：订单到达（待接单）/状态已接单（配送中）等未读动态提示
  async loadBadge() {
    try {
      const badge = await request.get(api.orderBadge, {}, { silent: true })
      this.setData({ orderBadge: badge || { unread: false, count: 0 } })
    } catch (e) { /* 忽略 */ }
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/user/login' })
  },

  // 头像区点击：未登录 → 登录页；已登录 → 编辑个人信息
  onUserTap() {
    if (this.data.user && this.data.user.openid) {
      wx.navigateTo({ url: '/pages/user/editProfile' })
    } else {
      this.goLogin()
    }
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/order/list' })
  },

  goOrdersTab(e) {
    wx.setStorageSync('order_tab', e.currentTarget.dataset.status)
    wx.navigateTo({ url: '/pages/order/list' })
  },

  goAddress() {
    wx.navigateTo({ url: '/pages/address/list' })
  },

  goRefundList() {
    wx.navigateTo({ url: '/pages/refund/list' })
  },

  showInfo() {
    wx.showModal({
      title: '配送说明',
      content: '机器人配送时段 11:00-13:00、17:00-19:00。下单后商家备餐装载，机器人自动配送至所选点位，到达后凭取餐码开舱取餐。',
      showCancel: false
    })
  },

  contactService() {
    wx.showModal({
      title: '联系客服',
      content: '如遇问题请联系零栋铺子门店或配送技术群反馈。',
      showCancel: false
    })
  },

  goSetting() {
    wx.navigateTo({ url: '/pages/user/settings' })
  },

  logout() {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
    this.setData({ user: {} })
    wx.showToast({ title: '已退出', icon: 'success' })
  }
})
