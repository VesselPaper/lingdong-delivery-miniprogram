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
    keyword: '',
    focus: false,
    categories: [],
    activeCategory: '',
    groups: [],
    cartCount: 0,
    cartTotal: '0.00',
    mainTo: '',
    shopClosed: false
  },

  cartMap: {},
  groupTops: [],
  scrollTop: 0,
  scrollLockUntil: 0,
  activeIdx: -1,

  onLoad() {
    const focus = wx.getStorageSync('goods_focus') === 1
    this.setData({ focus })
    this.loadCategories()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    this.loadGoods()
    this.loadShopStatus()
  },

  // 店铺营业状态：歇业时店铺卡展示「歇业」标签
  async loadShopStatus() {
    try {
      const shop = await request.get(api.shopStatus)
      this.setData({ shopClosed: shop.business_status === 'closed' })
    } catch (e) { /* 默认按营业处理 */ }
  },

  onSearch(e) {
    const v = e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail
    this.setData({ keyword: v }, () => this.loadGoods())
  },

  onSearchConfirm() {
    this.loadGoods()
  },

  async loadCategories() {
    try {
      const categories = await request.get(api.goodsCategories)
      this.setData({ categories })
    } catch (e) { /* handled */ }
  },

  async loadGoods() {
    try {
      const [list, cart] = await Promise.all([
        request.get(api.goodsList),
        request.get(api.cartList).catch(() => [])
      ])
      const byGoods = {}
      cart.forEach((it) => { byGoods[it.goods_id] = it })
      this.cartMap = byGoods

      const kw = this.data.keyword.trim()
      const filtered = kw ? list.filter((g) => g.name.indexOf(kw) > -1) : list
      const catOrder = this.data.categories.slice()
      filtered.forEach((g) => {
        if (catOrder.indexOf(g.category) === -1) catOrder.push(g.category)
      })
      const groups = catOrder
        .map((name) => ({
          name,
          items: filtered
            .filter((g) => g.category === name)
            .map((g) => {
              const t = THEMES[g.category] || DEFAULT_THEME
              const c = byGoods[g.id]
              return Object.assign({}, g, { theme: t.bg, icon: t.icon, qty: c ? c.quantity : 0 })
            })
        }))
        .filter((g) => g.items.length > 0)

      const count = cart.reduce((s, it) => s + it.quantity, 0)
      const total = cart.reduce((s, it) => s + it.price * it.quantity, 0)
      this.setData({ groups, cartCount: count, cartTotal: total.toFixed(2) }, () => {
        if (!this.data.activeCategory && groups.length) {
          this.setData({ activeCategory: groups[0].name })
        }
        this.computeTops()
      })
    } catch (e) { /* handled */ }
  },

  // 计算每个分类标题在滚动内容中的绝对位置
  computeTops() {
    this.groupTops = []
    this.activeIdx = -1
    const scrollTop = this.scrollTop
    wx.nextTick(() => {
      const q = this.createSelectorQuery()
      q.select('#main-scroll').boundingClientRect()
      q.selectAll('.group-title').boundingClientRect()
      q.exec((res) => {
        if (!res || !res[0] || !res[1]) return
        const containerTop = res[0].top
        this.groupTops = res[1].map((r) => r.top - containerTop + scrollTop)
      })
    })
  },

  // 点击左侧分类：右侧滚动到对应分组
  onCategoryClick(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const group = this.data.groups[idx]
    if (!group) return
    this.scrollLockUntil = Date.now() + 500
    this.activeIdx = idx
    this.setData({ activeCategory: group.name, mainTo: '' })
    setTimeout(() => {
      this.setData({ mainTo: 'group-' + idx })
    }, 60)
  },

  // 右侧滚动：当前分类跟随
  onScroll(e) {
    this.scrollTop = e.detail.scrollTop
    if (Date.now() < this.scrollLockUntil) return
    if (!this.groupTops.length) return
    const st = e.detail.scrollTop
    let idx = 0
    for (let i = 0; i < this.groupTops.length; i++) {
      if (st >= this.groupTops[i] - 8) idx = i
    }
    if (idx !== this.activeIdx) {
      this.activeIdx = idx
      const g = this.data.groups[idx]
      if (g && g.name !== this.data.activeCategory) {
        this.setData({ activeCategory: g.name })
      }
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/goods/detail?id=' + e.currentTarget.dataset.id })
  },

  goCart() {
    wx.navigateTo({ url: '/pages/cart/cart' })
  },

  async onStep(e) {
    const { id, delta } = e.currentTarget.dataset
    const gid = Number(id)
    const cur = this.cartMap[gid]
    try {
      if (Number(delta) > 0) {
        if (cur) {
          await request.put(api.cartUpdate, { id: cur.id, quantity: cur.quantity + 1 })
        } else {
          await request.post(api.cartAdd, { goods_id: gid, quantity: 1 })
        }
      } else if (cur) {
        if (cur.quantity > 1) {
          await request.put(api.cartUpdate, { id: cur.id, quantity: cur.quantity - 1 })
        } else {
          // 数量为 1 时再点减号 = 从购物车移除该商品
          await request.del(api.cartRemove, { id: cur.id })
        }
      }
      this.loadGoods()
    } catch (err) { /* handled */ }
  }
})
