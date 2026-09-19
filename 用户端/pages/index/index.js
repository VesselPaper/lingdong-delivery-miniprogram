const api = require('../../utils/api')
const request = require('../../utils/request')

const THEMES = {
  '热卤': { bg: '#F5F5F5', icon: 'app' },
  '卤味': { bg: '#F5F5F5', icon: 'app' },
  '饮品': { bg: '#F5F5F5', icon: 'app' },
  '套餐': { bg: '#F5F5F5', icon: 'app' }
}
const DEFAULT_THEME = { bg: '#F5F5F5', icon: 'app' }

// 分类 → 零售卡通图标（tdesign 图标名）与配色；按名称关键字匹配，未命中用默认
// 注意：更具体的词放前面，避免“面包糕点”被“面”抢先匹配成面条
const CATEGORY_STYLE = [
  { keys: ['面包', '糕点', '蛋糕', '烘焙'], icon: 'bread', color: '#D9942F', bg: '#FCF2E0' },
  { keys: ['方便面', '泡面', '米线', '粉丝', '面食'], icon: 'noodle', color: '#E8833A', bg: '#FDF0E4' },
  { keys: ['饼干', '零食', '膨化', '薯片'], icon: 'candy', color: '#E05B7E', bg: '#FCE9EF' },
  { keys: ['卤味', '热卤', '熟食', '肉'], icon: 'drumstick', color: '#C9702F', bg: '#FBEDE2' },
  { keys: ['纸品', '洗护', '清洁', '日用'], icon: 'shop', color: '#5C9E6E', bg: '#E8F4EB' },
  { keys: ['奶', '乳'], icon: 'milk', color: '#4A8FD4', bg: '#E8F1FC' },
  { keys: ['饮品', '饮料', '水', '茶'], icon: 'drink', color: '#2E9BD6', bg: '#E4F3FB' },
  { keys: ['水果', '果'], icon: 'watermelon', color: '#E0605B', bg: '#FCEAE9' },
  { keys: ['冰', '雪糕', '冷饮'], icon: 'ice-cream', color: '#7B6FD0', bg: '#EFEDFB' },
  { keys: ['米', '饭', '餐'], icon: 'rice', color: '#C9A227', bg: '#FAF4DF' },
  { keys: ['酒'], icon: 'beer', color: '#C79A3B', bg: '#FAF2DF' },
  { keys: ['糖', '巧克力'], icon: 'candy', color: '#D4652F', bg: '#FBEBE2' },
  { keys: ['礼', '套餐'], icon: 'gift', color: '#D2564E', bg: '#FCE9E7' }
]
const CATEGORY_FALLBACK = { icon: 'shop', color: '#3078C0', bg: '#EAF2FC' }

// 按分类名解析图标与配色
function styleOfCategory(name) {
  const n = String(name || '')
  const hit = CATEGORY_STYLE.find((s) => s.keys.some((k) => n.indexOf(k) > -1))
  return hit || CATEGORY_FALLBACK
}

const CAMPUS = '川师成龙校区'
const POINT_KEY = 'user_point'          // 用户最近一次选定的送达楼栋（下次下单沿用）
const HISTORY_KEY = 'search_history'    // 历史搜索记录
const HISTORY_MAX = 8

Page({
  data: {
    location: CAMPUS,          // 顶部定位：默认校区，选定楼栋后显示楼栋名
    points: [],                // 全部可送达楼栋（与已有地址关联）
    addresses: [],             // 用户地址簿（仅用于关联昵称/手机号）
    pickedPointId: null,       // 当前选定的楼栋 id（弹层里打勾）
    showPointPicker: false,    // 地址选择弹层
    history: [],               // 历史搜索
    showHistory: false,        // 历史搜索面板是否展开
    searchFocus: false,        // 搜索框是否处于聚焦态
    keyword: '',               // 首页独立搜索关键词
    searching: false,          // 是否处于搜索结果态
    searchResults: [],         // 搜索结果
    categories: [],            // 分类按钮
    hotGroups: [],             // 热门商品分组（每行一个分类）
    cartCount: 0,
    cartTotal: '0.00'
  },

  allGoods: [],

  onLoad() {
    this.loadHistory()
  },

  onShow() {
    this.loadGoods()
    this.loadCart()
    this.loadCategories()
    this.loadAddress()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
  },

  // 历史搜索记录（本地）
  loadHistory() {
    const history = wx.getStorageSync(HISTORY_KEY) || []
    this.setData({ history: Array.isArray(history) ? history.slice(0, HISTORY_MAX) : [] })
  },

  // 配送定位：列出全部可送达楼栋；与已有地址关联，默认选中最近一次使用的楼栋
  async loadAddress() {
    const token = wx.getStorageSync('token')
    let addresses = []
    if (token) {
      try {
        addresses = (await request.get(api.addressList)) || []
      } catch (e) { addresses = [] }
    }
    let points = []
    try {
      // 楼栋列表是公开接口：未登录也要能选楼栋，故 needAuth=false（避免被拉去登录页）
      const list = await request.get(api.landmarkList, {}, { needAuth: false })
      // 送达点位只展示机器人可送达的取餐点（deliverPoint），排除商铺上货点（loadingPoint）
      points = (list || []).filter((p) => p.type === 'deliverPoint')
    } catch (e) { points = [] }

    // 关联：楼栋 ← 地址簿里同点位最近的一条地址（仅用于展示，不改地址数据）
    const merged = points.map((p) => {
      const addr = addresses.find((a) => Number(a.landmark_id) === Number(p.id)) || null
      return Object.assign({}, p, {
        addrId: addr ? addr.id : null,
        addrName: addr ? addr.contact_name : '',
        addrPhone: addr ? addr.contact_phone : ''
      })
    })

    // 初始定位为校区；用户最近配送/选择过一次楼栋时，自动显示那个楼栋
    const saved = wx.getStorageSync(POINT_KEY)
    const bySaved = saved && saved.landmark_id
      ? merged.find((p) => Number(p.id) === Number(saved.landmark_id))
      : null
    this.setData({
      addresses,
      points: merged,
      pickedPointId: bySaved ? bySaved.id : null,
      location: bySaved ? bySaved.name : CAMPUS
    })
  },

  openPointPicker() {
    this.setData({ showPointPicker: true })
  },

  closePointPicker() {
    this.setData({ showPointPicker: false })
  },

  // 选择楼栋：本次定位与下次下单都用它；昵称/手机号沿用最近一次地址的数据
  onPickPoint(e) {
    const point = this.data.points[Number(e.currentTarget.dataset.index)]
    if (!point) return
    this.rememberPoint(point)
    this.setData({ location: point.name, pickedPointId: point.id, showPointPicker: false })
    wx.showToast({ title: '已切换至' + point.name, icon: 'none' })
  },

  // 记住选定的楼栋（只存楼栋信息，不动昵称/手机号）
  rememberPoint(point) {
    wx.setStorageSync(POINT_KEY, {
      landmark_id: point.id,
      name: point.name,
      addrId: point.addrId || null
    })
  },

  resetToCampus() {
    wx.removeStorageSync(POINT_KEY)
    this.setData({ location: CAMPUS, pickedPointId: null, showPointPicker: false })
  },

  async loadCategories() {
    try {
      const list = await request.get(api.goodsCategories)
      // 分类按钮：每个分类按名称配零售卡通图标与配色
      const categories = (list || []).map((name) => {
        const s = styleOfCategory(name)
        return { name, icon: s.icon, color: s.color, bg: s.bg }
      })
      this.setData({ categories })
    } catch (e) { /* handled */ }
  },

  async loadGoods() {
    try {
      const list = await request.get(api.goodsList)
      const goods = list.map((g) => {
        const t = THEMES[g.category] || DEFAULT_THEME
        return Object.assign({}, g, { theme: t.bg, icon: t.icon })
      })
      this.allGoods = goods
      // 分类按钮下方：按分类分组，每组取前 4 个热门商品，成排展示
      const order = this.data.categories.map((c) => c.name)
      goods.forEach((g) => { if (order.indexOf(g.category) === -1) order.push(g.category) })
      const hotGroups = order
        .map((name) => ({
          name,
          icon: styleOfCategory(name).icon,
          color: styleOfCategory(name).color,
          items: goods.filter((g) => g.category === name).slice(0, 4)
        }))
        .filter((g) => g.items.length)
      this.setData({ goods, hotGroups })
      // 若正处于搜索结果态，数据刷新后同步刷新结果
      if (this.data.searching) this.doSearch(this.data.keyword, true)
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

  /* ---------- 首页独立搜索 ---------- */

  onSearchFocus() {
    this.setData({ showHistory: true })
  },

  // 点搜索框任意位置：聚焦输入框并固定展开历史（不依赖 blur，避免闪现即收）
  onSearchTap() {
    this.setData({ searchFocus: true, showHistory: true })
  },

  // 收起历史（仅由明确操作触发：选历史、搜索、清空、点空白处）
  closeHistory() {
    this.setData({ showHistory: false, searchFocus: false })
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearchConfirm(e) {
    const v = e && e.detail && e.detail.value !== undefined ? e.detail.value : this.data.keyword
    this.doSearch(v)
  },

  // 点历史记录：直接以该词搜索（不再跳商城、无需二次点击）
  onHistoryTap(e) {
    const kw = e.currentTarget.dataset.kw
    this.setData({ keyword: kw })
    this.doSearch(kw)
  },

  // 记录历史搜索（去重、置顶、限量）
  saveHistory(kw) {
    const k = String(kw || '').trim()
    if (!k) return
    const history = [k].concat((this.data.history || []).filter((h) => h !== k)).slice(0, HISTORY_MAX)
    wx.setStorageSync(HISTORY_KEY, history)
    this.setData({ history })
  },

  // 执行搜索：命中商品名或分类，结果直接展示在首页
  doSearch(kw, keepHistory) {
    const k = String(kw || '').trim()
    if (!k) {
      this.setData({ searching: false, searchResults: [], showHistory: false, searchFocus: false })
      return
    }
    if (!keepHistory) this.saveHistory(k)
    const results = (this.allGoods || []).filter(
      (g) => (g.name || '').indexOf(k) > -1 || (g.category || '').indexOf(k) > -1
    )
    this.setData({ keyword: k, searching: true, searchResults: results, showHistory: false, searchFocus: false })
  },

  // 退出搜索态，回到首页常态
  clearKeyword() {
    this.setData({ keyword: '', searching: false, searchResults: [], showHistory: false, searchFocus: false })
  },

  clearHistory() {
    wx.removeStorageSync(HISTORY_KEY)
    this.setData({ history: [] })
  },

  /* ---------- 跳转 ---------- */

  goAll() {
    wx.setStorageSync('goods_category', '')
    wx.setStorageSync('goods_keyword', '')
    wx.setStorageSync('goods_focus', 0)
    wx.switchTab({ url: '/pages/goods/list' })
  },

  // 分类按钮 / 卡片箭头：直接跳转商城对应分类
  goCategory(e) {
    const name = e.currentTarget.dataset.name || ''
    wx.setStorageSync('goods_category', name)
    wx.setStorageSync('goods_keyword', '')
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
