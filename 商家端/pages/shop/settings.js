const shopState = require('../../utils/shopState')
const request = require('../../utils/request')
const role = require('../../utils/role')
const api = require('../../utils/api')

// 店铺分类候选（多店铺一期先给固定几类，二期做商家自助申请类目时再放开）
const CATEGORIES = ['餐饮', '超市便利店', '水果生鲜', '烘焙甜品', '快递代取', '其他']

Page({
  data: {
    business: 'open',
    autoAccept: false,
    deliveryFee: '1.00',
    // 多店铺一期（doc/16 §6.4）：起送价 / 打包费 / 店铺分类 / 本店取货点
    minOrder: '0.00',
    packFee: '0.00',
    category: '',
    categories: CATEGORIES,
    pickupId: '',
    pickupName: '',
    loadingPoints: [],
    isOwner: false // 订单异常管理入口：店长专属，不进首页常用功能图标区
  },

  async onLoad() {
    await shopState.loadShop()
    this.setData({
      business: shopState.getBusiness(),
      autoAccept: shopState.getAutoAccept(),
      deliveryFee: shopState.getDeliveryFee().toFixed(2),
      minOrder: shopState.getMinOrder().toFixed(2),
      packFee: shopState.getPackFee().toFixed(2),
      category: shopState.getCategory(),
      pickupId: shopState.getPickupLandmarkId(),
      isOwner: role.isOwner()
    })
    if (this.data.isOwner) this.loadLoadingPoints()
    this.syncPickupName()
  },

  // 上货点（loadingPoint）列表：本店取货点只能从机器人能到的上货点里选，
  // 否则批次会取到一个机器人去不了的点，整批派不出去。
  async loadLoadingPoints() {
    try {
      const list = (await request.get(api.landmarks, {}, { needAuth: false })) || []
      const loadingPoints = list.filter((p) => p.type === 'loadingPoint')
      this.setData({ loadingPoints })
      this.syncPickupName()
    } catch (e) { /* 取不到就只显示已保存的点位 id，不阻塞其它设置 */ }
  },

  syncPickupName() {
    const id = String(this.data.pickupId || '')
    const hit = (this.data.loadingPoints || []).find((p) => String(p.id) === id)
    this.setData({ pickupName: hit ? hit.name : (id ? '点位 ' + id : '') })
  },

  // 选本店取货点：一店一个上货点（一辆车一趟只去一家店装货）
  onPickPickup() {
    const pts = this.data.loadingPoints || []
    if (!pts.length) {
      wx.showToast({ title: '暂无可选上货点', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: pts.map((p) => p.name),
      success: async (r) => {
        const picked = pts[r.tapIndex]
        if (!picked) return
        await shopState.updateShop({ pickup_landmark_id: String(picked.id) })
        this.setData({ pickupId: String(picked.id), pickupName: picked.name })
        wx.showToast({ title: '取货点已设为' + picked.name, icon: 'none' })
      }
    })
  },

  onPickCategory() {
    wx.showActionSheet({
      itemList: CATEGORIES,
      success: async (r) => {
        const val = CATEGORIES[r.tapIndex]
        if (!val) return
        await shopState.updateShop({ category: val })
        this.setData({ category: val })
        wx.showToast({ title: '分类已改为' + val, icon: 'none' })
      }
    })
  },

  onMinOrderInput(e) { this.setData({ minOrder: e.detail.value }) },

  async onMinOrderBlur(e) {
    const raw = e.detail && e.detail.value !== undefined ? e.detail.value : this.data.minOrder
    const n = Number(raw)
    if (String(raw).trim() === '' || isNaN(n) || n < 0 || n > 999) {
      wx.showToast({ title: '请输入 0~999 的金额', icon: 'none' })
      this.setData({ minOrder: shopState.getMinOrder().toFixed(2) })
      return
    }
    await shopState.updateShop({ min_order: n })
    const saved = shopState.getMinOrder().toFixed(2)
    this.setData({ minOrder: saved })
    wx.showToast({ title: '起送价已更新为 ¥' + saved, icon: 'none' })
  },

  onPackFeeInput(e) { this.setData({ packFee: e.detail.value }) },

  async onPackFeeBlur(e) {
    const raw = e.detail && e.detail.value !== undefined ? e.detail.value : this.data.packFee
    const n = Number(raw)
    if (String(raw).trim() === '' || isNaN(n) || n < 0 || n > 999) {
      wx.showToast({ title: '请输入 0~999 的金额', icon: 'none' })
      this.setData({ packFee: shopState.getPackFee().toFixed(2) })
      return
    }
    await shopState.updateShop({ pack_fee: n })
    const saved = shopState.getPackFee().toFixed(2)
    this.setData({ packFee: saved })
    wx.showToast({ title: '打包费已更新为 ¥' + saved, icon: 'none' })
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

  // 订单异常管理（店长专用）：异常/垃圾订单的清理入口（清理会驳回任务、付款退款、用户端显示「订单异常」）
  goOrderAdmin() {
    wx.navigateTo({ url: '/pages/shop/orderAdmin' })
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
