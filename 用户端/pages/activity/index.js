// 活动页：顶部渐变权益头 + 活动图片列表（后端 /activity/list，无进行中活动时显示空态）
const api = require('../../utils/api')
const request = require('../../utils/request')
const session = require('../../utils/session')

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
    // 点活动卡片：有适用商品 → 商城只显示这些商品（活动适用的那批）；
    // 否则（纯展示活动）跳到商家配置的链接；都没配就明确提示，而不是点了没反应。
    const a = this.data.activities[Number(e.currentTarget.dataset.index)]
    if (!a) return
    const ids = (a.config && Array.isArray(a.config.goods_ids)) ? a.config.goods_ids : []
    if (a.type !== 'custom' && ids.length) {
      wx.setStorageSync('goods_id_filter', ids.map(Number))
      wx.setStorageSync('goods_category', '')
      wx.setStorageSync('goods_keyword', '')
      wx.setStorageSync('goods_focus', 0)
      wx.switchTab({ url: '/pages/goods/list' })
      return
    }
    if (a.type !== 'custom') {
      // 全场活动：没有具体商品集合，直接进商城
      wx.setStorageSync('goods_category', '')
      wx.setStorageSync('goods_keyword', '')
      wx.setStorageSync('goods_focus', 0)
      wx.switchTab({ url: '/pages/goods/list' })
      return
    }
    if (a.link) { wx.navigateTo({ url: a.link }); return }
    wx.showToast({ title: '该活动暂无跳转目标', icon: 'none' })
  }
})