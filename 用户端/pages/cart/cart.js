const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    items: [],
    total: '0.00',        // 勾选商品的折后合计（预估）
    origTotal: '0.00',    // 勾选商品的原价合计（用于算省了多少）
    saveTotal: '0.00',    // 预估可省金额
    deliveryFee: '1.00',  // 商家端可配置，用于「包含配送费」提示
    selectCount: 0,
    allSelected: true
  },

  onShow() {
    this.loadCart()
    this.loadShopStatus()
  },

  // 配送费（商家端配置，默认 1 元）
  async loadShopStatus() {
    try {
      const shop = await request.get(api.shopStatus, {}, { needAuth: false })
      const f = Number(shop && shop.delivery_fee)
      this.setData({ deliveryFee: (isNaN(f) || f < 0 ? 1 : f).toFixed(2) })
    } catch (e) { /* handled */ }
  },

  async loadCart() {
    try {
      const items = await request.get(api.cartList)
      this.applyItems(items)
    } catch (e) { /* handled */ }
  },

  // 展示字段与金额的**唯一**计算入口：
  // 勾选/改数量都走这里，保证「底部金额与优惠实时跟着勾选变」只有一处逻辑，不会两条路径算出两个数
  applyItems(rawItems) {
    const valid = (rawItems || [])
      .filter((it) => it.goods_status === 1)
      .map((it) => {
        const price = Number(it.price || 0)
        const now = Number(it.price_now !== undefined && it.price_now !== null ? it.price_now : it.price)
        return Object.assign({}, it, {
          sold_out: Number(it.goods_stock) <= 0,
          has_promo: now < price,
          save_amount: Math.max(0, price - now)
        })
      })
    const chosen = valid.filter((it) => it.selected)
    const total = chosen.reduce((s, it) => s + Number(it.price_now) * Number(it.quantity || 0), 0)
    const origTotal = chosen.reduce((s, it) => s + Number(it.price) * Number(it.quantity || 0), 0)
    this.setData({
      items: valid,
      total: total.toFixed(2),
      origTotal: origTotal.toFixed(2),
      saveTotal: Math.max(0, origTotal - total).toFixed(2),
      selectCount: chosen.length,
      allSelected: valid.length > 0 && valid.every((it) => it.selected)
    })
  },

  // 勾选 / 取消：先改本地让金额立刻变化，再提交；失败回滚。
  // （原来 await 之后再整表重拉，点一下要等一个来回，金额才跳）
  async toggleSelect(e) {
    const id = Number(e.currentTarget.dataset.id)
    const it = this.data.items.find((x) => x.id === id)
    if (!it) return
    const next = it.selected ? 0 : 1
    const snapshot = this.data.items
    this.applyItems(snapshot.map((x) => (x.id === id ? Object.assign({}, x, { selected: next }) : x)))
    try {
      await request.put(api.cartUpdate, { id, selected: next })
    } catch (err) {
      this.applyItems(snapshot)
    }
  },

  async toggleAll() {
    const target = this.data.allSelected ? 0 : 1
    const snapshot = this.data.items
    this.applyItems(snapshot.map((x) => Object.assign({}, x, { selected: target })))
    try {
      for (const it of snapshot) {
        await request.put(api.cartUpdate, { id: it.id, selected: target })
      }
    } catch (err) {
      this.applyItems(snapshot)
    }
  },

  async onQuantity(e) {
    const { id, delta } = e.currentTarget.dataset
    const rowId = Number(id)
    const it = this.data.items.find((x) => x.id === rowId)
    if (!it) return
    if (Number(delta) > 0 && it.sold_out) {
      wx.showToast({ title: '「' + it.name + '」已售罄', icon: 'none' })
      return
    }
    const next = Number(it.quantity) + Number(delta)
    const snapshot = this.data.items

    // 数量减到 0 = 从购物车移除该商品
    if (next < 1) {
      this.applyItems(snapshot.filter((x) => x.id !== rowId))
      try {
        await request.del(api.cartRemove, { id: rowId })
      } catch (err) {
        this.applyItems(snapshot)
      }
      return
    }

    this.applyItems(snapshot.map((x) => (x.id === rowId ? Object.assign({}, x, { quantity: next }) : x)))
    try {
      await request.put(api.cartUpdate, { id: rowId, quantity: next })
    } catch (err) {
      this.applyItems(snapshot)
    }
  },

  // 清空购物车：不可撤销，二次确认
  async clearAll() {
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '清空购物车？',
        content: '将移除全部已加购商品，不可撤销。',
        confirmColor: '#E64340',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!ok) return
    const snapshot = this.data.items
    this.applyItems([])
    try {
      for (const it of snapshot) {
        await request.del(api.cartRemove, { id: it.id })
      }
      wx.showToast({ title: '已清空', icon: 'success' })
    } catch (err) {
      this.applyItems(snapshot)
      wx.showToast({ title: '清空失败，请重试', icon: 'none' })
    }
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
