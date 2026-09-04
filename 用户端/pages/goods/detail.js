const api = require('../../utils/api')
const request = require('../../utils/request')

const THEMES = {
  '热卤': { bg: '#F5F5F5', icon: 'app' },
  '卤味': { bg: '#F5F5F5', icon: 'app' },
  '饮品': { bg: '#F5F5F5', icon: 'app' },
  '套餐': { bg: '#F5F5F5', icon: 'app' }
}
const DEFAULT_THEME = { bg: '#F5F5F5', icon: 'shop' }

Page({
  data: {
    id: null,
    goods: {},
    theme: DEFAULT_THEME.bg,
    icon: DEFAULT_THEME.icon,
    inStock: true,
    cartQty: 0
  },

  cartItem: null,

  onLoad(options) {
    this.setData({ id: Number(options.id) })
    this.loadDetail()
  },

  onShow() {
    this.loadCartQty()
  },

  async loadDetail() {
    try {
      const goods = await request.get(api.goodsDetail + '?id=' + this.data.id)
      const t = THEMES[goods.category] || DEFAULT_THEME
      this.setData({
        goods,
        theme: t.bg,
        icon: t.icon,
        inStock: goods.stock > 0
      })
      wx.setNavigationBarTitle({ title: goods.name })
    } catch (e) { /* handled */ }
  },

  async loadCartQty() {
    try {
      const list = await request.get(api.cartList)
      const it = list.find((x) => Number(x.goods_id) === Number(this.data.id))
      this.cartItem = it || null
      this.setData({ cartQty: it ? it.quantity : 0 })
    } catch (e) { /* handled */ }
  },

  async onStep(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const cur = this.cartItem
    try {
      if (delta > 0) {
        if (Number(this.data.goods.stock) <= 0) {
          wx.showToast({ title: '商品已售罄', icon: 'none' })
          return
        }
        if (cur) {
          await request.put(api.cartUpdate, { id: cur.id, quantity: cur.quantity + 1 })
        } else {
          await request.post(api.cartAdd, { goods_id: this.data.id, quantity: 1 })
        }
      } else if (cur) {
        if (cur.quantity > 1) {
          await request.put(api.cartUpdate, { id: cur.id, quantity: cur.quantity - 1 })
        } else {
          // 数量为 1 时再点减号 = 从购物车移除该商品
          await request.del(api.cartRemove, { id: cur.id })
        }
      }
      this.loadCartQty()
    } catch (e) { /* handled */ }
  },

  goCart() {
    wx.navigateTo({ url: '/pages/cart/cart' })
  }
})
