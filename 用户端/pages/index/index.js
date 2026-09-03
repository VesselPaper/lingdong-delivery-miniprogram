const api = require('../../utils/api')
const request = require('../../utils/request')

const THEMES = {
  '热卤': { bg: '#F5F5F5', icon: 'app' },
  '卤味': { bg: '#F5F5F5', icon: 'app' },
  '饮品': { bg: '#F5F5F5', icon: 'app' },
  '套餐': { bg: '#F5F5F5', icon: 'app' }
}
const DEFAULT_THEME = { bg: '#F5F5F5', icon: 'app' }

Page({
  data: {
    goods: [],
    cartCount: 0,
    cartTotal: '0.00'
  },

  onShow() {
    this.loadGoods()
    this.loadCart()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
  },

  async loadGoods() {
    try {
      const list = await request.get(api.goodsList)
      const goods = list.map((g) => {
        const t = THEMES[g.category] || DEFAULT_THEME
        return Object.assign({}, g, { theme: t.bg, icon: t.icon })
      })
      this.setData({ goods })
    } catch (e) { /* toast 已由 request 处理 */ }
  },

  async loadCart() {
    try {
      const list = await request.get(api.cartList)
      const count = list.reduce((s, it) => s + it.quantity, 0)
      const total = list.reduce((s, it) => s + it.price * it.quantity, 0)
      this.setData({ cartCount: count, cartTotal: total.toFixed(2) })
    } catch (e) { /* handled */ }
  },

  goSearch() {
    wx.setStorageSync('goods_category', '')
    wx.setStorageSync('goods_focus', 1)
    wx.switchTab({ url: '/pages/goods/list' })
  },

  goAll() {
    wx.setStorageSync('goods_category', '')
    wx.setStorageSync('goods_focus', 0)
    wx.switchTab({ url: '/pages/goods/list' })
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/goods/detail?id=' + e.currentTarget.dataset.id })
  },

  goCart() {
    wx.navigateTo({ url: '/pages/cart/cart' })
  },

  async addCart(e) {
    const id = e.currentTarget.dataset.id
    try {
      await request.post(api.cartAdd, { goods_id: id, quantity: 1 })
      wx.showToast({ title: '已加入购物车', icon: 'success' })
      this.loadCart()
    } catch (err) { /* handled */ }
  }
})
