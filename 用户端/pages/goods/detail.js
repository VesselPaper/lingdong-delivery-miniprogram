const api = require('../../utils/api')
const request = require('../../utils/request')

const THEMES = {
  '热卤': { bg: '#F5F5F5', icon: 'app' },
  '卤味': { bg: '#F5F5F5', icon: 'app' },
  '饮品': { bg: '#F5F5F5', icon: 'app' },
  '套餐': { bg: '#F5F5F5', icon: 'app' }
}
const DEFAULT_THEME = { bg: '#F5F5F5', icon: 'shop' }
// 配送费兜底值：正常从 /shop/status 取（商家端可配置），接口异常时不至于把费用显示成 0
const FALLBACK_FEE = 1

Page({
  data: {
    id: null,
    goods: {},
    theme: DEFAULT_THEME.bg,
    icon: DEFAULT_THEME.icon,
    inStock: true,
    cartQty: 0,
    // 价格构成：原价 / 活动价 / 省了多少 / 配送费 分开呈现，让用户看清钱花在哪、省在哪
    hasPromo: false,
    discountLabel: '',
    saveAmount: '0.00',
    deliveryFee: FALLBACK_FEE.toFixed(2),
    unitPayable: '0.00',
    showFeeDetail: false
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
      this.applyPrice(goods)
      wx.setNavigationBarTitle({ title: goods.name })
    } catch (e) { /* handled */ }
  },

  // 配送费取店铺当前配置；失败用兜底值，不阻塞商品展示
  async fetchFee() {
    try {
      const shop = await request.get(api.shopStatus, {}, { needAuth: false })
      const f = Number(shop && shop.delivery_fee)
      return isNaN(f) || f < 0 ? FALLBACK_FEE : f
    } catch (e) {
      return FALLBACK_FEE
    }
  },

  // 拆分价格：活动价与配送费各自独立，避免"活动价里含没含配送费"看不明白
  async applyPrice(goods) {
    const fee = await this.fetchFee()
    const price = Number(goods.price || 0)
    const raw = goods.sale_price
    const sale = raw === null || raw === undefined || raw === '' ? null : Number(raw)
    const hasPromo = sale !== null && !isNaN(sale) && sale < price
    const info = goods.discount_info || {}
    const d = Number(info.discount || 0)
    const now = hasPromo ? sale : price
    this.setData({
      hasPromo,
      discountLabel: d > 0 && d < 1 ? (Math.round(d * 1000) / 10) + ' 折' : '活动价',
      saveAmount: (hasPromo ? price - sale : 0).toFixed(2),
      deliveryFee: fee.toFixed(2),
      unitPayable: (now + fee).toFixed(2)
    })
  },

  // 商品图点击放大（支持双指缩放与保存）
  previewImage() {
    const url = this.data.goods.image
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  toggleFeeDetail() {
    this.setData({ showFeeDetail: !this.data.showFeeDetail })
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
