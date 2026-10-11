const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')
const promo = require('../../utils/promo')

const TYPE = { custom: '展示', discount: '打折', full_reduce: '满减' }

// 列表顶部筛选：按「商家此刻能对它做什么」分组（这也是他点进来的动机）
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },    // 已发布且在当前时间窗内
  { key: 'draft', label: '草稿' },
  { key: 'offline', label: '已下线' },
  { key: 'ended', label: '已结束' }
]

// 第二个筛选维度：活动类型（与上架状态正交）。
// key 直接用 activities.type 的值，避免再做一层映射。
const TYPE_TABS = [
  { key: 'discount', label: '打折' },
  { key: 'full_reduce', label: '满减' },
  { key: 'custom', label: '纯展示' }
]

Page({
  data: {
    activities: [],        // 当前筛选后要渲染的
    all: [],               // 全量（切换筛选时不再请求）
    tabs: [],
    filter: 'all',
    // 活动类型筛选（第二个维度）：与上架状态正交，商家既能看「哪些在进行中」，
    // 也能一眼看出「打折/满减/纯展示各有哪些活动」
    typeTabs: [],
    typeFilter: 'all',
    isOwner: false
  },

  onShow() {
    this.setData({ isOwner: role.isOwner() })
    this.load()
  },

  async load() {
    try {
      const activities = await request.get(api.activities)
      const now = Date.now()
      const decorated = (activities || []).map((a) => {
        const at = (t) => (t ? new Date(t.replace(' ', 'T')).getTime() : NaN)
        const s = at(a.start_at), e = at(a.end_at)
        let state = 'active', state_txt = '进行中'
        if (!isNaN(s) && now < s) { state = 'pending'; state_txt = '未开始' }
        else if (!isNaN(e) && now > e) { state = 'ended'; state_txt = '已结束' }
        // 上下架优先级最高：草稿/已下线谈不上「进行中」
        const st = Number(a.status)
        if (st === 0) { state = 'draft'; state_txt = '草稿' }
        else if (st === 2) { state = 'offline'; state_txt = '已下线' }
        return Object.assign({}, a, {
          type_txt: TYPE[a.type] || '展示',
          state, state_txt,
          statusText: st === 1 ? '已发布' : (st === 2 ? '已下线' : '草稿'),
          // 卡片上给状态徽章用（压在图片左上角）
          statusClass: st === 1 ? 'tag-green' : (st === 2 ? 'tag-orange' : 'tag-gray'),
          // 时间状态只对已发布的活动有意义
          stateClass: state === 'active' ? 'st-green' : (state === 'pending' ? 'st-orange' : 'st-gray'),
          timeTxt: (a.start_at || a.end_at)
            ? (String(a.start_at || '').slice(5, 16) + ' ~ ' + String(a.end_at || '').slice(5, 16))
            : '长期有效',
          promoText: promo.summarize(a)
        })
      })
      this.setData({ all: decorated })
      this.applyFilter()
    } catch (e) { /* handled */ }
  },

  // 生成筛选标签 + 计数，并按当前筛选刷新网格。
  // 两个维度正交：① 上架/时间状态  ② 活动类型（打折/满减/纯展示）
  applyFilter() {
    const all = this.data.all || []
    // 只有已发布的活动才计入「进行中/已结束」——草稿和已下线归它们自己的分类
    const inActive = (a) => a.status === 1 && (a.state === 'active' || a.state === 'pending')
    const count = {
      all: all.length,
      active: all.filter(inActive).length,
      draft: all.filter((a) => a.status === 0).length,
      offline: all.filter((a) => a.status === 2).length,
      ended: all.filter((a) => a.status === 1 && a.state === 'ended').length
    }
    const tabs = FILTERS.map((f) => Object.assign({}, f, { count: count[f.key] || 0 }))

    // 类型标签：计数按当前状态筛选动态算（这样「草稿里有几个打折」也看得见）
    const byState = all.filter((a) => {
      const f = this.data.filter
      if (f === 'active') return inActive(a)
      if (f === 'draft') return a.status === 0
      if (f === 'offline') return a.status === 2
      if (f === 'ended') return a.status === 1 && a.state === 'ended'
      return true
    })
    const typeCount = (t) => byState.filter((a) => a.type === t).length
    const typeTabs = [{ key: 'all', label: '全部类型', count: byState.length }].concat(
      TYPE_TABS.map((t) => Object.assign({}, t, { count: typeCount(t.key) }))
    )

    const tf = this.data.typeFilter
    const list = tf === 'all' ? byState : byState.filter((a) => a.type === tf)
    this.setData({ tabs, typeTabs, activities: list })
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.key }, () => this.applyFilter())
  },

  setTypeFilter(e) {
    this.setData({ typeFilter: e.currentTarget.dataset.key }, () => this.applyFilter())
  },

  add() {
    wx.navigateTo({ url: '/pages/activity/edit' })
  },

  noop() {},

  edit(e) {
    this.openEdit(e.currentTarget.dataset.id)
  },

  // 编辑页承载「发布」动作：未发布的活动从这里进去确认后发布。
  // 不在列表里直接一键发布 —— 草稿往往是半成品，直接上线会推到用户端。
  goPublish(e) {
    this.openEdit(e.currentTarget.dataset.id)
  },

  openEdit(id) {
    wx.navigateTo({ url: '/pages/activity/edit?id=' + id })
  },

  // 已发布活动：弹出操作菜单，避免按钮常驻卡片（卡片要让位给图片和优惠信息）
  onMore(e) {
    const id = Number(e.currentTarget.dataset.id)
    const item = (this.data.all || []).find((a) => Number(a.id) === id)
    if (!item) return
    const published = item.status === 1
    const items = published ? ['下线（用户端不再展示）', '删除活动'] : ['去发布', '删除活动']
    wx.showActionSheet({
      itemList: items,
      success: (r) => {
        const label = items[r.tapIndex]
        if (label.indexOf('删除') === 0) return this.del(id)
        if (label.indexOf('下线') === 0) return this.offline(id)
        this.openEdit(id)
      }
    })
  },

  // 下线：action='offline'（置 status=2，用户端隐藏并停止参与折扣/满减）
  async offline(id) {
    try {
      await request.put(api.activityStatus, { id: Number(id), action: 'offline' })
      wx.showToast({ title: '已下线', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  },

  async del(e) {
    const id = Number(e && e.currentTarget ? e.currentTarget.dataset.id : e)
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除该活动？',
        content: '删除后不可恢复，用户端也会立即下架。',
        confirmColor: '#E64340',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.del(api.activities, { id })
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } catch (err) { /* handled */ }
  }
})
