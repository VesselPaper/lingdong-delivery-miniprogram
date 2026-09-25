// 活动页：顶部渐变权益头 + 活动列表（后端 /activity/list，无进行中活动时显示空态）
const api = require('../../utils/api')
const request = require('../../utils/request')
const session = require('../../utils/session')

const fmtTime = (v) => {
  if (!v) return ''
  const s = String(v).replace('T', ' ').slice(0, 16)
  return s
}

Page({
  data: {
    activities: []
  },

  onShow() {
    // 未登录强制回登录页（与首页同一套兜底）
    if (session.ensureLogin()) return
    this.load()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  async load() {
    try {
      const activities = await request.get(api.activityList)
      // 只展示"进行中"活动，给不同类型附上展示文案与时间
      const list = (activities || [])
        .filter((a) => !a.state || a.state === 'active')
        .map((a) => {
          const item = Object.assign({}, a)
          const conf = a.config || {}
          if (a.type === 'discount' && Number(conf.discount) > 0 && Number(conf.discount) < 1) {
            const zhe = (Number(conf.discount) * 10).toFixed(1).replace(/\.0$/, '')
            item.highlight = `${zhe} 折`
            item.highlightTxt = '折扣活动'
            item.highlightSub = conf.scope === 'goods' ? '指定商品享受折扣' : '全场商品享受折扣'
          } else if (a.type === 'full_reduce' && Array.isArray(conf.tiers)) {
            const tops = conf.tiers.filter((t) => Number(t.threshold) > 0)
              .sort((x, y) => Number(x.threshold) - Number(y.threshold))
              .map((t) => `满${t.threshold}减${t.reduce}`)
            item.highlight = tops.length ? tops[tops.length - 1] : '满减优惠'
            item.highlightTxt = '满减活动'
            item.highlightSub = tops.length ? tops.join(' / ') : ''
          } else {
            item.highlight = ''
            item.highlightTxt = '活动'
          }
          // 起止时间展示
          item.timeTxt = (a.start_at || a.end_at)
            ? `${fmtTime(a.start_at)} — ${fmtTime(a.end_at)}`
            : ''
          return item
        })
      this.setData({ activities: list })
    } catch (e) { /* handled */ }
  },

  onActivity(e) {
    // 折扣/满减活动点击进商品售卖页；自由活动若配了链接则跳链接
    const { link, type } = e.currentTarget.dataset
    if (type === 'custom') {
      if (link) wx.navigateTo({ url: link })
    } else {
      wx.switchTab({ url: '/pages/goods/list' })
    }
  }
})