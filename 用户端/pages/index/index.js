const api = require('../../utils/api')
const request = require('../../utils/request')
const flyCart = require('../../utils/flyCart')
const session = require('../../utils/session')

const THEMES = {
  '热卤': { bg: '#F5F5F5', icon: 'app' },
  '卤味': { bg: '#F5F5F5', icon: 'app' },
  '饮品': { bg: '#F5F5F5', icon: 'app' },
  '套餐': { bg: '#F5F5F5', icon: 'app' }
}
const DEFAULT_THEME = { bg: '#F5F5F5', icon: 'app' }

// 分类 → 彩色扁平插画图标（见 pages/index/cat-icons.wxss，由 backend/tools/gen_cat_icons.js 生成）与圆形底色
// 规则顺序即优先级：更具体的词放前面，避免「面包糕点」被面条/米饭菜规则抢走、「水果」被「水」抢走
const CATEGORY_STYLE = [
  { keys: ['面包', '糕点', '蛋糕', '烘焙'], icon: 'bread', bg: '#FCF2E0' },
  { keys: ['方便面', '泡面', '米线', '粉丝', '面食', '米', '饭', '餐'], icon: 'noodle', bg: '#FDF0E4' },
  { keys: ['饼干', '零食', '膨化', '薯片', '糖', '巧克力'], icon: 'cookie', bg: '#FCE9EF' },
  { keys: ['卤味', '热卤', '熟食', '肉'], icon: 'meat', bg: '#FBEDE2' },
  { keys: ['纸品', '洗护', '清洁', '日用'], icon: 'tissue', bg: '#E8F4EB' },
  { keys: ['水果', '果'], icon: 'fruit', bg: '#FCEAE9' },
  { keys: ['冰', '雪糕', '冷饮'], icon: 'icecream', bg: '#EFEDFB' },
  { keys: ['奶', '乳', '饮品', '饮料', '水', '茶', '酒'], icon: 'drink', bg: '#E4F3FB' },
  { keys: ['礼', '套餐'], icon: 'gift', bg: '#FCE9E7' }
]
const CATEGORY_FALLBACK = { icon: 'store', bg: '#EAF2FC' }

// 按分类名解析图标与配色
function styleOfCategory(name) {
  const n = String(name || '')
  const hit = CATEGORY_STYLE.find((s) => s.keys.some((k) => n.indexOf(k) > -1))
  return hit || CATEGORY_FALLBACK
}

// 未选择楼栋时的占位文案：此前直接显示「川师成龙校区」，会让用户误以为已经选好了配送楼栋
const POINT_UNSET = '楼栋未填写'
const POINT_KEY = 'user_point'          // 楼栋本地缓存（真源在后端 /user/point，未登录时先用它）
const HISTORY_KEY = 'search_history'    // 历史搜索记录
const HISTORY_MAX = 8

Page({
  data: {
    location: POINT_UNSET,     // 顶部定位：未选楼栋时显示「楼栋未填写」，选定后显示楼栋名
    pointUnset: true,          // 是否处于「未选择」态（用于文案样式区分）
    deliveryFee: '1.00',       // 店铺配送费（商家端可配置）
    points: [],                // 全部可送达楼栋（与已有地址关联）
    addresses: [],             // 用户地址簿（仅用于关联昵称/手机号）
    pickedPointId: null,       // 当前选定的楼栋 id（弹层里打勾）
    showPointPicker: false,    // 地址选择弹层
    history: [],               // 历史搜索
    showHistory: false,        // 历史搜索面板是否展开
    searchFocus: false,        // 搜索框是否处于聚焦态
    keyword: '',               // 首页搜索关键词（确认后携带跳转商城页执行搜索）
    categories: [],            // 分类按钮
    hotGroups: [],             // 热门商品分组（每行一个分类）
    cartCount: 0,
    cartTotal: '0.00',
    flyBall: { show: false, x: 0, y: 0, dx: 0, dy: 0, move: false },  // 加购飞入的小球
    cartBounceCls: '',    // 购物车图标弹跳（与商城页共用一套动画）
    cartBadgeCls: ''      // 角标跳动
  },

  allGoods: [],

  onLoad() {
    this.loadHistory()
  },

  onUnload() {
    flyCart.clear(this)
  },

  onShow() {
    // 未登录强制回登录页（覆盖冷启动竞态：开发者工具恢复页面栈时 app.js 的 reLaunch 可能被吞）
    if (session.ensureLogin()) return
    this.loadGoods()
    this.loadCart()
    this.loadCategories()
    this.loadAddress()
    this.loadShopStatus()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
  },

  // 店铺配送费（商家端可配置，默认 1 元）
  async loadShopStatus() {
    try {
      const shop = await request.get(api.shopStatus, {}, { needAuth: false })
      const f = Number(shop && shop.delivery_fee)
      this.setData({ deliveryFee: (isNaN(f) || f < 0 ? 1 : f).toFixed(2) })
    } catch (e) { /* handled */ }
  },

  // 历史搜索记录（本地）
  loadHistory() {
    const history = wx.getStorageSync(HISTORY_KEY) || []
    this.setData({ history: Array.isArray(history) ? history.slice(0, HISTORY_MAX) : [] })
  },

  // 配送楼栋：真源在后端 /user/point —— 与「我的页 → 收货地址」「结算页 → 送达楼栋」是同一份数据，
  // 任一处修改，另外两处下次进入即可见。
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

    // 当前楼栋以后端为准；未登录（或接口失败）时回退本地缓存，保证离线也能先选
    let cur = null
    if (token) {
      try { cur = await request.get(api.userPoint) } catch (e) { cur = null }
    }
    if (!cur || !cur.landmark_id) {
      const saved = wx.getStorageSync(POINT_KEY)
      cur = saved && saved.landmark_id ? { landmark_id: saved.landmark_id } : null
    }
    const hit = cur && cur.landmark_id
      ? merged.find((p) => Number(p.id) === Number(cur.landmark_id))
      : null
    this.setData({
      addresses,
      points: merged,
      pickedPointId: hit ? hit.id : null,
      // 没选过楼栋时不再冒充「川师成龙校区」，而是明确告诉用户还没填
      location: hit ? hit.name : POINT_UNSET,
      pointUnset: !hit
    })
  },

  openPointPicker() {
    this.setData({ showPointPicker: true })
  },

  closePointPicker() {
    this.setData({ showPointPicker: false })
  },

  // 选择楼栋：本地缓存 + 写入后端（三处联动的关键）
  async onPickPoint(e) {
    const point = this.data.points[Number(e.currentTarget.dataset.index)]
    if (!point) return
    this.rememberPoint(point)
    this.setData({ location: point.name, pickedPointId: point.id, showPointPicker: false, pointUnset: false })
    await this.syncPoint(point.id)
    wx.showToast({ title: '已切换至' + point.name, icon: 'none' })
  },

  // 同步到后端；未登录时静默跳过（本地已记住，登录后 loadAddress 会以本地值回填）
  async syncPoint(landmarkId) {
    const token = wx.getStorageSync('token')
    if (!token) return
    try {
      await request.put(api.userPoint, { landmark_id: landmarkId === null || landmarkId === undefined ? '' : String(landmarkId) })
    } catch (e) { /* 网络异常不阻塞选择，下次进入会以本地缓存回填 */ }
  },

  // 记住选定的楼栋（只存楼栋信息，不动昵称/手机号）
  rememberPoint(point) {
    wx.setStorageSync(POINT_KEY, {
      landmark_id: point.id,
      name: point.name,
      addrId: point.addrId || null
    })
  },

  // 清除已选楼栋，回到「未填写」态（后端与本地一起清）
  async clearPoint() {
    wx.removeStorageSync(POINT_KEY)
    this.setData({ location: POINT_UNSET, pickedPointId: null, showPointPicker: false, pointUnset: true })
    await this.syncPoint('')
  },

  async loadCategories() {
    try {
      const list = await request.get(api.goodsCategories)
      // 分类按钮：每个分类按名称配零售卡通图标与配色
      const categories = (list || []).map((name) => {
        const s = styleOfCategory(name)
        return { name, icon: s.icon, bg: s.bg }
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
          items: goods.filter((g) => g.category === name).slice(0, 4)
        }))
        .filter((g) => g.items.length)
      this.setData({ goods, hotGroups })
    } catch (e) { /* toast 已由 request 处理 */ }
  },

  async loadCart() {
    try {
      const list = await request.get(api.cartList)
      const count = list.reduce((s, it) => s + it.quantity, 0)
      // 用 price_now（后端已按活动折后价算好）而不是 price，否则有活动时首页合计会比商城页偏高
      const total = list.reduce((s, it) => s + (it.price_now !== undefined ? it.price_now : it.price) * it.quantity, 0)
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
    this.goSearch(v)
  },

  // 点历史记录：直接以该词搜索（跳商城页执行，与商城搜索一致）
  onHistoryTap(e) {
    const kw = e.currentTarget.dataset.kw
    this.setData({ keyword: kw })
    this.goSearch(kw)
  },

  // 记录历史搜索（去重、置顶、限量）
  saveHistory(kw) {
    const k = String(kw || '').trim()
    if (!k) return
    const history = [k].concat((this.data.history || []).filter((h) => h !== k)).slice(0, HISTORY_MAX)
    wx.setStorageSync(HISTORY_KEY, history)
    this.setData({ history })
  },

  // 首页搜索统一入口：记录历史 → 携带关键词跳转商城页搜索（不再在首页内联展示结果）
  goSearch(kw) {
    const k = String(kw || '').trim()
    if (!k) {
      this.clearKeyword()
      return
    }
    this.saveHistory(k)
    this.setData({ keyword: k, showHistory: false, searchFocus: false })
    wx.setStorageSync('goods_keyword', k)
    wx.setStorageSync('goods_category', '')
    wx.setStorageSync('goods_focus', 0)
    wx.switchTab({ url: '/pages/goods/list' })
  },

  // 退出搜索态，回到首页常态
  clearKeyword() {
    this.setData({ keyword: '', showHistory: false, searchFocus: false })
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
    const id = Number(e.currentTarget.dataset.id)
    const g = this.findGoods(id)
    if (g && Number(g.stock) <= 0) {
      wx.showToast({ title: '「' + g.name + '」已售罄', icon: 'none' })
      return
    }
    // 乐观更新：本地先 +1，让角标数字与飞入动画同时发生；请求失败再回滚
    const back = this.bumpCart(1, g ? Number(g.sale_price || g.price) : 0)   // 与 loadCart 的 price_now 口径一致
    flyCart.flyAfter(this, e)
    try {
      await request.post(api.cartAdd, { goods_id: id, quantity: 1 })
    } catch (err) {
      back()
    }
  },

  // 商品查一次（用于加购判断库存）
  findGoods(id) {
    for (const grp of this.data.hotGroups) {
      const hit = (grp.items || []).find((x) => Number(x.id) === id)
      if (hit) return hit
    }
    return null
  },

  // 本地加减购物车角标，返回「回滚」函数（真实金额仍以后端 cart/list 为准，这里只为手感）
  bumpCart(delta, unitPrice) {
    const prev = { cartCount: this.data.cartCount, cartTotal: this.data.cartTotal }
    const count = Math.max(0, prev.cartCount + delta)
    const total = Math.max(0, Number(prev.cartTotal) + delta * (Number(unitPrice) || 0))
    this.setData({ cartCount: count, cartTotal: total.toFixed(2) })
    return () => this.setData(prev)
  }
})
