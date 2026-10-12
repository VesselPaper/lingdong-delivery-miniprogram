const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')
const promo = require('../../utils/promo')

const TYPE = { full_reduce: '满减', discount: '折扣', no_threshold: '无门槛' }

// 顶部筛选：按「商家此刻能对它做什么」分组，与活动列表同一套思路
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'on', label: '启用中' },
  { key: 'off', label: '已停用' }
]

// 券的时间状态：与活动卡片同一口径（进行中 / 未开始 / 已结束），只按券自己的有效期算。
// 相对有效期是「领取之后才开始算」的，模板层面没有时间窗 —— 一律算进行中。
function timeState(c) {
  if (c.valid_type !== 'absolute') return { state: 'active', state_txt: '进行中' }
  const at = (t) => (t ? new Date(String(t).replace(' ', 'T')).getTime() : NaN)
  const now = Date.now()
  const s = at(c.start_at)
  const e = at(c.end_at)
  if (!isNaN(s) && now < s) return { state: 'pending', state_txt: '未开始' }
  if (!isNaN(e) && now > e) return { state: 'ended', state_txt: '已结束' }
  return { state: 'active', state_txt: '进行中' }
}

// 有效期缩写（卡片那行只放得下 10-12 ~ 10-15 这种）
function timeText(c) {
  if (c.valid_type === 'relative') {
    const d = Number(c.relative_days) || 0
    return d > 0 ? '领取后 ' + d + ' 天' : '长期有效'
  }
  const s = c.start_at ? String(c.start_at).slice(5, 10) : ''
  const e = c.end_at ? String(c.end_at).slice(5, 10) : ''
  if (s && e) return s + ' ~ ' + e
  if (e) return '至 ' + e
  return '长期有效'
}

Page({
  data: {
    coupons: [],
    all: [],
    tabs: [],
    filter: 'all',
    isOwner: false,
    loading: true
  },

  onShow() {
    this.setData({ isOwner: role.isOwner() })
    this.load()
  },

  async load() {
    try {
      const list = await request.get(api.coupons)
      const decorated = (list || []).map((c) => {
        const ts = timeState(c)
        const on = Number(c.status) === 1
        const total = Number(c.total_qty) || 0
        return Object.assign({}, c, {
          on,
          // 压在图上的上下架状态（和活动卡片的「已发布/草稿/已下线」同一个位置、同一个作用）
          statusText: on ? '启用中' : '已停用',
          statusClass: on ? 'tag-green' : 'tag-gray',
          // 时间状态只对启用中的券有意义：停用的券谈不上「进行中」
          state_txt: on ? ts.state_txt : '已停用',
          stateClass: on ? (ts.state === 'active' ? 'st-green' : (ts.state === 'pending' ? 'st-orange' : 'st-gray')) : 'st-gray',
          typeLabel: TYPE[c.type] || '满减',
          ruleText: promo.couponRule(c),
          timeTxt: timeText(c),
          // 券图是卡片主视觉；没图的券在用户端等于不存在，卡片上要显眼地提示
          noImage: !c.image,
          // 卡面只留一行次要信息（卡窄，两行会把图片挤没）：领取进度 + 限领
          stockText: (total > 0 ? '已领 ' + (Number(c.issued) || 0) + '/' + total : '不限量 · 已领 ' + (Number(c.issued) || 0))
            + ' · ' + (Number(c.per_user_limit) > 0 ? '限领 ' + c.per_user_limit + '/人' : '不限领')
        })
      })
      this.setData({ all: decorated, loading: false })
      this.applyFilter()
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  applyFilter() {
    const all = this.data.all || []
    const count = {
      all: all.length,
      on: all.filter((c) => c.on).length,
      off: all.filter((c) => !c.on).length
    }
    const tabs = FILTERS.map((f) => Object.assign({}, f, { count: count[f.key] || 0 }))
    const f = this.data.filter
    const list = f === 'all' ? all : all.filter((c) => (f === 'on' ? c.on : !c.on))
    this.setData({ tabs, coupons: list })
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.key }, () => this.applyFilter())
  },

  add() {
    wx.navigateTo({ url: '/pages/coupon/edit' })
  },

  edit(e) {
    wx.navigateTo({ url: '/pages/coupon/edit?id=' + e.currentTarget.dataset.id })
  },

  noop() {},

  // 卡片右下角「···」：状态切换与删除都收在这里，卡片正面只留「编辑」
  // （和活动卡片一样，避免一排按钮把图片挤没）
  onMore(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = (this.data.all || []).find((c) => Number(c.id) === id)
    if (!item) return
    const items = item.on ? ['停用', '删除优惠券'] : ['启用', '删除优惠券']
    wx.showActionSheet({
      itemList: items,
      success: (r) => {
        const label = items[r.tapIndex]
        if (label.indexOf('删除') === 0) return this.del(id)
        this.setStatus(id, item.on ? 0 : 1)
      }
    })
  },

  // 启用/停用：停用后用户不能再领，结算时已领的券判定为不可用
  async setStatus(id, next) {
    const item = (this.data.all || []).find((c) => Number(c.id) === id)
    // 用户端靠图片呈现券，没图的券启用后也没人看得到 —— 提前拦，别让商家吃一个接口报错
    if (next === 1 && item && !item.image) {
      wx.showToast({ title: '请先上传券图再启用', icon: 'none' })
      return
    }
    try {
      await request.put(api.couponStatus, { id, status: next })
      wx.showToast({ title: next ? '已启用' : '已停用', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  },

  async del(e) {
    const id = Number(e && e.currentTarget ? e.currentTarget.dataset.id : e)
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '删除该优惠券？',
        content: '删除后用户不能再领取，已领到的券也将无法使用。',
        confirmColor: '#E64340',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!ok) return
    try {
      await request.del(api.coupons, { id })
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  }
})
