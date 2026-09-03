const api = require('../../utils/api')
const request = require('../../utils/request')

const THEMES = { '热卤': '#F5F5F5', '卤味': '#F5F5F5', '饮品': '#F5F5F5', '套餐': '#F5F5F5' }
const ICONS = {
  '热卤': 'app', '卤味': 'app', '饮品': 'app', '套餐': 'app'
}

Page({
  data: {
    goods: [],
    filtered: [],
    keyword: '',
    stats: { onShelf: 0, offShelf: 0, soldOut: 0 }
  },

  onShow() {
    this.load()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter())
  },

  applyFilter() {
    const kw = this.data.keyword.trim()
    const filtered = kw
      ? this.data.goods.filter((g) => (g.name || '').toLowerCase().includes(kw.toLowerCase()))
      : this.data.goods
    this.setData({ filtered })
  },

  async load() {
    try {
      const list = await request.get(api.goods)
      const goods = list.map((g) => ({
        ...g,
        theme: THEMES[g.category] || '#F5F5F5',
        icon: ICONS[g.category] || 'shop'
      }))
      const stats = {
        onShelf: goods.filter((g) => g.status === 1).length,
        offShelf: goods.filter((g) => g.status === 0).length,
        soldOut: goods.filter((g) => Number(g.stock) <= 0).length
      }
      this.setData({ goods, stats }, () => this.applyFilter())
    } catch (e) { /* handled */ }
  },

  addGoods() {
    wx.navigateTo({ url: '/pages/goods/edit' })
  },

  editGoods(e) {
    wx.navigateTo({ url: '/pages/goods/edit?id=' + e.currentTarget.dataset.id })
  },

  markSoldOut() {
    wx.showToast({ title: '请通过编辑商品调整库存', icon: 'none' })
  },

  openFilter() {
    wx.showToast({ title: '筛选功能开发中', icon: 'none' })
  },

  async toggleStatus(e) {
    const id = Number(e.currentTarget.dataset.id)
    const status = Number(e.currentTarget.dataset.status)
    try {
      await request.put(api.goodsStatus, { id, status: status === 1 ? 0 : 1 })
      wx.showToast({ title: '已更新', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  }
})
