// 活动页：顶部渐变权益头 + 活动图片列表（后端 /activity/list，无进行中活动时显示空态）
const api = require('../../utils/api')
const request = require('../../utils/request')
const session = require('../../utils/session')

Page({
  data: {
    activities: [],
    // 券与折扣/满减活动并排展示：同样是「一张图 = 一个优惠」，所以过滤口径也一致 ——
    // 只展示「可领取 + 有图」的券；已领/抢光/过期的券留在券页，不在这里占位
    coupons: []
  },

  onShow() {
    // 未登录强制回登录页（与首页同一套兜底）
    if (session.ensureLogin()) return
    this.load()
    this.loadCoupons()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  // 券图：与活动图同列，只有「可领取」的才出现
  async loadCoupons() {
    try {
      const list = await request.get(api.couponList, {}, { silent: true })
      this.setData({ coupons: (list || []).filter((c) => c.state === 'ok' && c.image) })
    } catch (e) {
      this.setData({ coupons: [] })
    }
  },

  // 领券：领完这张图从活动页消失（已进「我的券」）
  async receiveCoupon(e) {
    const id = Number(e.currentTarget.dataset.id)
    try {
      const r = await request.post(api.couponReceive, { coupon_id: id })
      wx.showToast({
        title: r && r.expire_at ? '已领取，' + String(r.expire_at).slice(0, 10) + ' 到期' : '领取成功',
        icon: 'none'
      })
      this.loadCoupons()
    } catch (err) { /* handled */ }
  },

  async load() {
    try {
      const activities = await request.get(api.activityList)
      // 只展示「进行中 + 有图」的规则活动：
      //   · 纯展示活动属于首页轮播（商家把它当图片入口用）
      //   · 没配图的活动在用户端没有表现形态（这里整页都是图片），所以过滤掉
      const list = (activities || []).filter((a) =>
        a.type !== 'custom' && (!a.state || a.state === 'active') && a.image
      )
      this.setData({ activities: list })
    } catch (e) { /* handled */ }
  },

  onActivity(e) {
    // 点活动卡片：
    //   · 打折/满减且有适用商品 → 跳独立「活动商品」页（2026-10-14 改：不再给商城带筛选 ——
    //     商城是 tabBar 页，外部带筛选会污染 tab 状态，筛选后没有入口回全量、必须重开商城才恢复）
    //   · 全场活动（无具体商品集合）→ 直接进商城全量
    //   · 纯展示活动 → 跳到商家配置的链接；都没配就明确提示，而不是点了没反应。
    const a = this.data.activities[Number(e.currentTarget.dataset.index)]
    if (!a) return
    const ids = (a.config && Array.isArray(a.config.goods_ids)) ? a.config.goods_ids : []
    if (a.type !== 'custom' && ids.length) {
      wx.navigateTo({ url: '/pages/activity/goods?id=' + a.id })
      return
    }
    if (a.type !== 'custom') {
      wx.switchTab({ url: '/pages/goods/list' })
      return
    }
    if (a.link) { wx.navigateTo({ url: a.link }); return }
    wx.showToast({ title: '该活动暂无跳转目标', icon: 'none' })
  }
})