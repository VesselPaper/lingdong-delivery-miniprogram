const api = require('../../utils/api')
const request = require('../../utils/request')
const avatar = require('../../utils/avatar')

const ROLE_TEXT = { student: '学生', merchant: '商家' }

// 按码点取首字，避免 emoji / 生僻字被截成半个字符
function firstChar(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return ''
  return Array.from(s)[0]
}

// 11 位手机号排成 3-4-4，其他格式原样展示
function formatPhone(phone) {
  const s = String(phone == null ? '' : phone).replace(/\s/g, '')
  if (!/^\d{11}$/.test(s)) return s
  return s.slice(0, 3) + ' ' + s.slice(3, 7) + ' ' + s.slice(7)
}

Page({
  data: {
    user: {},
    userInitial: '零',
    roleText: '',
    phoneText: '',
    orderBadge: { unread: false, count: 0, paying: 0, delivering: 0, arrived: 0, finished: 0 },
    pointName: ''   // 当前配送楼栋（与首页顶部、结算页楼栋是同一份后端数据）
  },

  onShow() {
    this.load()
    this.loadBadge()
    this.loadPoint()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
  },

  // 收货地址行展示当前配送楼栋，让用户知道「这里改的就是首页/结算页那个楼栋」
  async loadPoint() {
    try {
      const p = await request.get(api.userPoint)
      this.setData({ pointName: (p && p.landmark_name) || '' })
    } catch (e) {
      this.setData({ pointName: '' })
    }
  },

  async load() {
    try {
      this.applyUser(await request.get(api.getProfile))
    } catch (e) {
      this.applyUser({})
    }
  },

  // 头像/昵称/身份标签/手机号都来自后端真实字段，不做任何补位造假
  applyUser(raw) {
    const user = raw || {}
    this.setData({
      user,
      userInitial: firstChar(user.nickname) || '零',
      roleText: ROLE_TEXT[user.role] || '',
      phoneText: formatPhone(user.phone)
    })
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

  // 头像按钮被点：未登录时 open-type 为空串（不会弹微信头像选择器），这里引导去登录
  onAvatarTap() {
    if (!this.data.user.openid) this.goLogin()
  },

  // 微信头像选择器回调（open-type="chooseAvatar"）：上传后直接用后端返回的用户刷新卡片
  onChooseAvatar(e) {
    avatar.chooseAndSave((user) => this.applyUser(user))(e)
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
      content: '机器人配送时段 08:00-20:00。下单后商家备餐装载，机器人自动配送至所选点位，到达后凭取餐码开舱取餐。',
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
  }
})
