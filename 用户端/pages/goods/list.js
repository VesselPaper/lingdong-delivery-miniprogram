const api = require('../../utils/api')
const request = require('../../utils/request')
const flyCart = require('../../utils/flyCart')

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
    shopClosed: false,
    deliveryFee: '1.00',
    flyBall: { show: false, x: 0, y: 0, dx: 0, dy: 0, move: false },  // 加购飞入的小球
    cartBounceCls: '',    // 购物车图标弹跳（与首页共用一套动画）
    cartBadgeCls: ''      // 角标跳动
  },

  cartMap: {},
  groupTops: [],
  scrollTop: 0,
  scrollLockUntil: 0,
  activeIdx: -1,
  _recomputeTimer: null,
  _reconcileTimer: null,

  onLoad() {
    const focus = wx.getStorageSync('goods_focus') === 1
    this.setData({ focus })
    this.loadCategories()
  },

  onUnload() {
    flyCart.clear(this)
    clearTimeout(this._recomputeTimer)
    clearTimeout(this._reconcileTimer)
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

  // 店铺营业状态 + 配送费（配送费由商家端配置，默认 1 元）
  async loadShopStatus() {
    try {
      const shop = await request.get(api.shopStatus)
      const f = Number(shop && shop.delivery_fee)
      this.setData({
        shopClosed: shop.business_status === 'closed',
        deliveryFee: (isNaN(f) || f < 0 ? 1 : f).toFixed(2)
      })
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
              const price = Number(g.price || 0)
              const raw = g.sale_price
              const sale = raw === null || raw === undefined || raw === '' ? null : Number(raw)
              const hasPromo = sale !== null && !isNaN(sale) && sale < price
              const d = Number((g.discount_info || {}).discount || 0)
              const stock = Number(g.stock)
              const sales = Number(g.sales)
              return Object.assign({}, g, {
                theme: t.bg,
                icon: t.icon,
                qty: c ? c.quantity : 0,
                sold_out: stock <= 0,
                // 活动展示：折扣力度 + 省下的金额分开给，前端拼成「8.5折 省¥0.67」的标签
                has_promo: hasPromo,
                discount_label: hasPromo ? (d > 0 && d < 1 ? (Math.round(d * 1000) / 10) + '折' : '活动价') : '',
                save_amount: hasPromo ? (price - sale).toFixed(2) : '',
                // 库存与销量文案（销量为 0 时不显示「已售 0」，改为「暂无销量」更自然）
                sales_text: sales > 0 ? '已售 ' + sales : '暂无销量',
                stock_text: stock > 0 ? '库存 ' + stock : '售罄'
              })
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
    const d = Number(delta)
    const cur = this.cartMap[gid]
    const g = this.findGoods(gid)

    if (d > 0) {
      // 售罄商品禁止加购
      if (g && g.sold_out) {
        wx.showToast({ title: '「' + g.name + '」已售罄', icon: 'none' })
        return
      }
    } else if (!cur || !cur.id) {
      // 减号要按后端行 id 改绝对数量；刚加购还没对账回来时先拉一次真实数据
      this.scheduleReconcile(0)
      return
    }

    // 乐观更新：本地先动，让角标/步进器与飞入动画同时发生；请求失败再回滚
    const back = this.bumpItem(gid, d, g)
    const { before, after } = this.bumpCartMap(gid, d)
    if (d > 0) flyCart.flyAfter(this, e)

    try {
      if (d > 0) {
        // cart/add 对「已在购物车」的商品是累加（不是覆盖），所以连点直接多发几次即可，
        // 不需要先拿到行 id，也不存在多个请求拿同一个旧基数互相覆盖的问题
        await request.post(api.cartAdd, { goods_id: gid, quantity: d })
      } else if (after && after.quantity > 0) {
        await request.put(api.cartUpdate, { id: after.id, quantity: after.quantity })
      } else if (before && before.id) {
        // 数量减到 0 = 从购物车移除该商品
        await request.del(api.cartRemove, { id: before.id })
      }
    } catch (err) {
      back()
      if (before) this.cartMap[gid] = before
      else delete this.cartMap[gid]
      return
    }
    this.scheduleReconcile()
  },

  // 商品查一次（列表 + 搜索态共用）
  findGoods(gid) {
    for (const grp of this.data.groups) {
      const hit = (grp.items || []).find((x) => Number(x.id) === gid)
      if (hit) return hit
    }
    return null
  },

  // 本地先改步进器数量与角标合计，返回「回滚」函数（真实金额仍以后端 cart/list 为准，这里只为手感）
  bumpItem(gid, delta, g) {
    const prev = { groups: this.data.groups, cartCount: this.data.cartCount, cartTotal: this.data.cartTotal }
    const price = Number((g && (g.has_promo ? g.sale_price : g.price)) || 0)
    let count = prev.cartCount
    let total = Number(prev.cartTotal)
    const groups = prev.groups.map((grp) => Object.assign({}, grp, {
      items: (grp.items || []).map((it) => {
        if (Number(it.id) !== gid) return it
        count += delta
        total += delta * price
        return Object.assign({}, it, { qty: Math.max(0, Number(it.qty || 0) + delta) })
      })
    }))
    this.setData({
      groups,
      cartCount: Math.max(0, count),
      cartTotal: Math.max(0, total).toFixed(2)
    })
    return () => this.setData(prev)
  },

  // 本地维护购物车数量：连点时后续请求用的是「累加/递减后的目标值」，
  // 不会几个请求都拿同一个旧基数去覆盖。返回改动前后的快照供请求选路与回滚。
  bumpCartMap(gid, d) {
    const before = this.cartMap[gid] ? Object.assign({}, this.cartMap[gid]) : null
    if (this.cartMap[gid]) {
      this.cartMap[gid].quantity = Math.max(0, Number(this.cartMap[gid].quantity || 0) + d)
    } else if (d > 0) {
      // 后端还没有这一行：先占位（id 待对账补上），加号仍然走 cart/add
      this.cartMap[gid] = { id: null, goods_id: gid, quantity: d }
    }
    const after = this.cartMap[gid] ? Object.assign({}, this.cartMap[gid]) : null
    if (this.cartMap[gid] && this.cartMap[gid].quantity === 0) delete this.cartMap[gid]
    return { before, after }
  },

  // 成功后静默对账：连点只重拉一次，避免每点一下都整表刷新
  scheduleReconcile(delay = 320) {
    clearTimeout(this._reconcileTimer)
    this._reconcileTimer = setTimeout(() => {
      this._reconcileTimer = null
      this.loadGoods()
    }, delay)
  }
})
