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
  _recomputeTimer: null,

  onLoad() {
    const focus = wx.getStorageSync('goods_focus') === 1
    this.setData({ focus })
    this.loadCategories()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    // 首页跳转带入的分类 / 关键词（消费后即清除，避免下次误用）
    const cat = wx.getStorageSync('goods_category') || ''
    const kw = wx.getStorageSync('goods_keyword') || ''
    if (cat) wx.removeStorageSync('goods_category')
    if (kw) wx.removeStorageSync('goods_keyword')
    this.pendingCategory = cat
    if (kw && kw !== this.data.keyword) this.setData({ keyword: kw })
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
              return Object.assign({}, g, { theme: t.bg, icon: t.icon, qty: c ? c.quantity : 0, sold_out: Number(g.stock) <= 0 })
            })
        }))
        .filter((g) => g.items.length > 0)

      const count = cart.reduce((s, it) => s + it.quantity, 0)
      const total = cart.reduce((s, it) => s + (it.price_now !== undefined ? it.price_now : it.price) * it.quantity, 0)
      this.setData({ groups, cartCount: count, cartTotal: total.toFixed(2) }, () => {
        // 首页带入的分类：加载完直接定位到该分组
        const target = this.pendingCategory
        this.pendingCategory = ''
        const ti = target ? groups.findIndex((g) => g.name === target) : -1
        if (ti > -1) {
          this.onCategoryClick({ currentTarget: { dataset: { index: ti } } })
          return
        }
        // 校验当前选中分类仍存在；否则回落到首组，避免筛选后“延续旧的分类”
        const stillActive = groups.some((g) => g.name === this.data.activeCategory)
        if (!stillActive && groups.length) {
          this.setData({ activeCategory: groups[0].name })
        }
        this.computeTops()
      })
    } catch (e) { /* handled */ }
  },

  // 计算每个分类标题在滚动内容中的绝对位置（带节流，图片加载后都会重算）
  computeTops() {
    if (this._recomputeTimer) { clearTimeout(this._recomputeTimer); this._recomputeTimer = null }
    this._measure()
  },

  // 商品图加载完成会改变分组高度 → 延迟 80ms 重测位置，保证分类跟随不滞后
  onImageLoad() {
    if (this._recomputeTimer) { clearTimeout(this._recomputeTimer) }
    this._recomputeTimer = setTimeout(() => {
      this._recomputeTimer = null
      this._measure()
    }, 80)
  },

  _measure() {
    const scrollTop = this.scrollTop
    wx.nextTick(() => {
      const q = this.createSelectorQuery()
      q.select('#main-scroll').boundingClientRect()
      q.selectAll('.group-title').boundingClientRect()
      q.exec((res) => {
        if (!res || !res[0] || !res[1] || !res[1].length) return
        const containerTop = res[0].top
        this.groupTops = res[1].map((r) => r.top - containerTop + scrollTop)
        // 用最新位置立刻校正一次高亮，消除“延迟/延续旧分类”
        const st = Math.max(0, this.scrollTop || 0)
        let idx = 0
        for (let i = 0; i < this.groupTops.length; i++) {
          if (st >= this.groupTops[i] - 8) idx = i
        }
        const g = this.data.groups[idx]
        if (g && g.name !== this.data.activeCategory) {
          this.activeIdx = idx
          this.setData({ activeCategory: g.name })
        }
      })
    })
  },

  // 点击左侧分类：右侧滚动到对应分组（nextTick 稳触发，每次都能跳）
  onCategoryClick(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const group = this.data.groups[idx]
    if (!group) return
    this.scrollLockUntil = Date.now() + 500
    this.activeIdx = idx
    this.setData({ activeCategory: group.name, mainTo: '' })
    wx.nextTick(() => {
      this.setData({ mainTo: 'group-' + idx })
    })
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
        // 售罄商品禁止加购
        const g = this.data.groups.reduce((acc, grp) => acc.concat(grp.items), []).find((x) => x.id === gid)
        if (g && g.sold_out) {
          wx.showToast({ title: '「' + g.name + '」已售罄', icon: 'none' })
          return
        }
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
