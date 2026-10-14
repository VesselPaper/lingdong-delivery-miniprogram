// 活动商品页：从活动页点「打折/满减」活动进入，单独列出该活动适用的商品。
//
// 为什么独立成页而不是给商城带筛选（2026-10-14 用户反馈）：
//   商城是 tabBar 页，外部带筛选进 tab 会污染它的状态 —— 筛选后没有入口回到全量商品，
//   必须重新打开商城才恢复。独立页面有原生返回键（回活动页）、商城永远保持全量，
//   活动商品成为它自己的落地页，还能放活动标题与优惠摘要。
const api = require('../../utils/api')
const request = require('../../utils/request')
const session = require('../../utils/session')

const THEMES = {
  '热卤': { bg: '#F5F5F5', icon: 'app' },
  '卤味': { bg: '#F5F5F5', icon: 'app' },
  '饮品': { bg: '#F5F5F5', icon: 'app' },
  '套餐': { bg: '#F5F5F5', icon: 'app' }
}
const DEFAULT_THEME = { bg: '#F5F5F5', icon: 'shop' }

// 活动优惠一句话：打折 → 「8.5折」；满减 → 取最高档「满X减Y」
function promoText(a) {
  const cfg = a && a.config ? a.config : {}
  if (a.type === 'discount') {
    const d = Number(cfg.discount)
    if (d > 0 && d < 1) return (Math.round(d * 1000) / 10) + '折'
    return '活动价'
  }
  if (a.type === 'full_reduce' && Array.isArray(cfg.tiers) && cfg.tiers.length) {
    const t = cfg.tiers[cfg.tiers.length - 1] || cfg.tiers[0]
    return '满' + Number(t.threshold) + '减' + Number(t.reduce)
  }
  return ''
}

Page({
  data: {
    activityId: null,
    activityTitle: '',
    promo: '',        // 优惠摘要（头图下方一行）
    goods: [],
    loading: true
  },

  cartMap: {},        // goods_id -> 购物车行（对账用）

  onLoad(options) {
    if (session.ensureLogin()) return
    this.setData({ activityId: Number(options.id) })
    this.load()
  },

  async load() {
    try {
      const [acts, list, cart] = await Promise.all([
        request.get(api.activityList),
        request.get(api.goodsList),
        request.get(api.cartList).catch(() => [])
      ])
      const a = (acts || []).find((x) => Number(x.id) === Number(this.data.activityId)) || null
      const ids = (a && Array.isArray(a.config.goods_ids)) ? a.config.goods_ids.map(Number) : []
      const pick = {}
      ids.forEach((id) => { pick[id] = true })
      // 命中活动适用商品；全部下架/被移除时回落全量，不给空页（与商城 loadGoods 同口径）
      let filtered = (list || []).filter((g) => pick[Number(g.id)])
      if (!filtered.length) filtered = list || []

      const byGoods = {}
      ;(cart || []).forEach((it) => { byGoods[it.goods_id] = it })
      this.cartMap = byGoods

      const goods = filtered.map((g) => {
        const t = THEMES[g.category] || DEFAULT_THEME
        const c = byGoods[g.id]
        const price = Number(g.price || 0)
        const raw = g.sale_price
        const sale = raw === null || raw === undefined || raw === '' ? null : Number(raw)
        const hasPromo = sale !== null && !isNaN(sale) && sale < price
        const d = Number((g.discount_info || {}).discount || 0)
        const stock = Number(g.stock)
        return Object.assign({}, g, {
          theme: t.bg,
          icon: t.icon,
          qty: c ? c.quantity : 0,
          sold_out: stock <= 0,
          has_promo: hasPromo,
          discount_label: hasPromo ? (d > 0 && d < 1 ? (Math.round(d * 1000) / 10) + '折' : '活动价') : '',
          save_amount: hasPromo ? (price - sale).toFixed(2) : '',
          sales_text: Number(g.sales) > 0 ? '已售 ' + Number(g.sales) : '暂无销量'
        })
      })
      this.setData({
        activityTitle: (a && a.title) || '活动商品',
        promo: promoText(a),
        goods,
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  findGoods(gid) {
    return (this.data.goods || []).find((g) => Number(g.id) === gid) || null
  },

  // 加购/减购：乐观更新 + 服务端同步 + 对账（活动页没有底部购物车栏，不做飞入动画，
  // 数量用步进器就地反馈；请求失败回滚）
  async onStep(e) {
    const { id, delta } = e.currentTarget.dataset
    const gid = Number(id)
    const d = Number(delta)
    const g = this.findGoods(gid)
    if (d > 0 && g && g.sold_out) {
      wx.showToast({ title: '「' + g.name + '」已售罄', icon: 'none' })
      return
    }
    const before = this.cartMap[gid]
    if (d < 0 && (!before || !before.id)) return
    const nextQty = Math.max(0, (g ? g.qty : 0) + d)
    const patchQty = (q) => (this.data.goods || []).map((x) => (Number(x.id) === gid ? Object.assign({}, x, { qty: q }) : x))
    this.setData({ goods: patchQty(nextQty) })
    try {
      if (d > 0) {
        await request.post(api.cartAdd, { goods_id: gid, quantity: d })
      } else if (nextQty > 0 && before && before.id) {
        await request.put(api.cartUpdate, { id: before.id, quantity: nextQty })
      } else if (before && before.id) {
        await request.del(api.cartRemove, { id: before.id })
      }
      // 对账：拉一次权威购物车，数量与行 id 对齐（连点/多端并发防漂移）
      const cart = await request.get(api.cartList).catch(() => [])
      const byGoods = {}
      ;(cart || []).forEach((it) => { byGoods[it.goods_id] = it })
      this.cartMap = byGoods
      this.setData({
        goods: (this.data.goods || []).map((x) => Object.assign({}, x, { qty: byGoods[x.id] ? byGoods[x.id].quantity : 0 }))
      })
    } catch (err) {
      this.setData({ goods: patchQty(g ? g.qty : 0) })
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/goods/detail?id=' + e.currentTarget.dataset.id })
  }
})
