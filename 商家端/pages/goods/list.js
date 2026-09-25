const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')

const THEMES = { '热卤': '#F5F5F5', '卤味': '#F5F5F5', '饮品': '#F5F5F5', '套餐': '#F5F5F5' }
const ICONS = {
  '热卤': 'app', '卤味': 'app', '饮品': 'app', '套餐': 'app'
}

Page({
  data: {
    goods: [],
    filtered: [],
    keyword: '',
    stats: { onShelf: 0, offShelf: 0, soldOut: 0 },
    isOwner: false
  },

  onShow() {
    this.setData({ isOwner: role.isOwner() })
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
        icon: ICONS[g.category] || 'shop',
        sold_out: Number(g.stock) <= 0
      }))
      const stats = {
        onShelf: goods.filter((g) => g.status === 1).length,
        offShelf: goods.filter((g) => g.status === 0).length,
        soldOut: goods.filter((g) => g.sold_out).length
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

  // 标记售罄：直接把库存置 0（后端已修复「设 0 回落 999」）；已售罄 → 恢复库存 99
  async markSoldOut(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = this.data.goods.find((g) => g.id === id)
    if (!item) return
    if (item.sold_out) {
      const res = await new Promise((resolve) => {
        wx.showModal({
          title: '恢复库存',
          content: '当前库存为 0（售罄）。恢复库存后用户端将重新可下单。恢复为多少？',
          editable: true,
          placeholderText: '默认 99',
          confirmColor: '#3078C0',
          success: (r) => resolve(r.confirm ? r.content : null)
        })
      })
      if (res === null || res === undefined) return
      const n = Math.max(0, parseInt(res, 10) || 99)
      try {
        await request.put(api.goodsStock, { id, stock: n })
        wx.showToast({ title: '已恢复库存 ' + n, icon: 'success' })
        this.load()
      } catch (err) { /* handled */ }
      return
    }
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '标记售罄',
        content: '将「' + item.name + '」库存直接置为 0，用户端立即显示售罄且无法下单。确定？',
        confirmText: '标记售罄',
        confirmColor: '#E64340',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!confirm) return
    try {
      await request.put(api.goodsStock, { id, stock: 0 })
      wx.showToast({ title: '已标记售罄', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
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
