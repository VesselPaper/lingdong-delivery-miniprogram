const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    items: [],
    total: '0.00',
    selectCount: 0,
    allSelected: true
  },

  onShow() {
    this.loadCart()
  },

  async loadCart() {
    try {
      const items = await request.get(api.cartList)
      const valid = items
        .filter((it) => it.goods_status === 1)
        .map((it) => Object.assign({}, it, { sold_out: Number(it.goods_stock) <= 0 }))
      const total = valid
        .filter((it) => it.selected)
        .reduce((s, it) => s + it.price_now * it.quantity, 0)
      const origTotal = valid
        .filter((it) => it.selected)
        .reduce((s, it) => s + it.price * it.quantity, 0)
      const selectCount = valid.filter((it) => it.selected).length
      this.setData({
        items: valid,
        total: total.toFixed(2),
        origTotal: origTotal.toFixed(2),
        selectCount,
        allSelected: valid.length > 0 && valid.every((it) => it.selected)
      })
      // 结算时也要用折后价/数量，下单价格以后端权威为准，这里仅展示估算
      const raw = valid.filter((it) => it.selected).map((it) => ({ goods_id: it.goods_id, quantity: it.quantity, price_now: it.price_now }))
      this.checkoutRaw = raw
    } catch (e) { /* handled */ }
  },

  async toggleSelect(e) {
    const { id, selected } = e.currentTarget.dataset
    await request.put(api.cartUpdate, { id: Number(id), selected: selected ? 0 : 1 })
    this.loadCart()
  },

  async toggleAll() {
    const target = !this.data.allSelected ? 1 : 0
    for (const it of this.data.items) {
      await request.put(api.cartUpdate, { id: it.id, selected: target })
    }
    this.loadCart()
  },

  async onQuantity(e) {
    const { id, delta } = e.currentTarget.dataset
    const it = this.data.items.find((x) => x.id === Number(id))
    if (!it) return
    if (Number(delta) > 0 && it.sold_out) {
      wx.showToast({ title: '「' + it.name + '」已售罄', icon: 'none' })
      return
    }
    const next = Number(it.quantity) + Number(delta)
    if (next < 1) {
      // 数量减到 0 = 从购物车移除该商品
      await request.del(api.cartRemove, { id: Number(id) })
    } else {
      await request.put(api.cartUpdate, { id: Number(id), quantity: next })
    }
    this.loadCart()
  },

  async checkout() {
    const selected = this.data.items.filter((it) => it.selected)
    if (!selected.length) {
      wx.showToast({ title: '请先选择商品', icon: 'none' })
      return
    }
    const soldOut = selected.find((it) => it.sold_out)
    if (soldOut) {
      wx.showToast({ title: '「' + soldOut.name + '」已售罄，请先移除', icon: 'none' })
      return
    }
    const items = selected.map((it) => ({ goods_id: it.goods_id, quantity: it.quantity }))
    wx.setStorageSync('checkout_items', items)
    wx.navigateTo({ url: '/pages/order/confirm' })
  }
})
