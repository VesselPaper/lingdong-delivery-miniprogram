const api = require('../../utils/api')
const request = require('../../utils/request')
const session = require('../../utils/session')

// 适用范围 / 有效期文案：券的规则在结算页也要能一眼读懂，列表页先把它说清楚
function parseIds(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v : []
  } catch (e) { return [] }
}

function money(v) {
  return Number(Number(v) || 0).toFixed(2).replace(/\.00$/, '')
}

function scopeText(c) {
  const n = parseIds(c.scope_ids).length
  if (c.scope === 'goods') return '指定 ' + n + ' 件商品可用'
  if (c.scope === 'category') return '指定 ' + n + ' 个分类可用'
  return '全场通用'
}

function validText(c) {
  if (c.valid_type === 'relative') {
    const d = Number(c.relative_days) || 0
    return d > 0 ? '领取后 ' + d + ' 天内有效' : '长期有效'
  }
  const s = c.start_at ? String(c.start_at).slice(0, 10) : ''
  const e = c.end_at ? String(c.end_at).slice(0, 10) : ''
  if (!s && !e) return '长期有效'
  return (s || '不限') + ' ~ ' + (e || '不限')
}

// 面额块大字 + 券型名
function face(c) {
  if (c.type === 'discount') {
    const d = Number(c.discount)
    const zhe = (d > 0 && d < 1) ? String((d * 10).toFixed(1)).replace(/\.0$/, '') : ''
    return { faceText: zhe ? zhe + '折' : '折扣', faceZhe: true, typeLabel: '折扣券' }
  }
  return {
    faceText: '¥' + money(c.reduce),
    faceZhe: false,
    typeLabel: c.type === 'no_threshold' ? '无门槛' : '满减券'
  }
}

// 可领券的状态徽标：已领取 / 已抢光 / 已过期 / 可领取
const STATE = {
  ok: { text: '立即领取', cls: 'ok', disabled: false },
  received: { text: '已领取', cls: 'grey', disabled: true },
  soldout: { text: '已抢光', cls: 'grey', disabled: true },
  expired: { text: '已过期', cls: 'grey', disabled: true }
}

Page({
  data: {
    tab: 'receive',        // receive = 可领取；mine = 我的券
    list: [],
    loading: true,
    // 我的券分三类：未使用 / 已使用 / 已过期
    mineTab: 'unused',
    mine: { unused: [], used: [], expired: [], count: 0 },
    mineTabs: []
  },

  onShow() {
    if (session.ensureLogin()) return
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    await Promise.all([this.loadReceive(), this.loadMine()])
    this.setData({ loading: false })
  },

  // 可领券：附「我已领几张 / 剩余多少」，按钮据此置灰
  async loadReceive() {
    try {
      const list = (await request.get(api.couponList)) || []
      this.setData({
        list: list.map((c) => Object.assign({}, c, face(c), {
          scopeTxt: scopeText(c),
          validTxt: validText(c),
          remainTxt: Number(c.left) < 0 ? '不限量' : '剩 ' + c.left + ' 张',
          button: STATE[c.state] || STATE.ok
        }))
      })
    } catch (e) { /* handled */ }
  },

  // 我的券：读取时后端会顺手把过期券标记掉，所以每次进来都是准的
  async loadMine() {
    try {
      const m = (await request.get(api.couponMine)) || { unused: [], used: [], expired: [], count: 0 }
      const deco = (arr) => (arr || []).map((c) => Object.assign({}, c, face(c), {
        scopeTxt: scopeText(c),
        validTxt: validText(c),
        expireTxt: c.expire_at ? String(c.expire_at).slice(0, 10) + ' 到期' : validText(c),
        // 后端可能返回已删除模板的券（title 为 null），给个兜底名免得卡片空白
        title: c.title || '优惠券'
      }))
      this.setData({
        mine: {
          unused: deco(m.unused),
          used: deco(m.used),
          expired: deco(m.expired),
          count: Number(m.count) || 0
        },
        mineTabs: [
          { key: 'unused', label: '未使用', count: (m.unused || []).length },
          { key: 'used', label: '已使用', count: (m.used || []).length },
          { key: 'expired', label: '已过期', count: (m.expired || []).length }
        ]
      })
    } catch (e) { /* handled */ }
  },

  setTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  setMineTab(e) {
    this.setData({ mineTab: e.currentTarget.dataset.key })
  },

  async receive(e) {
    const id = Number(e.currentTarget.dataset.id)
    try {
      const r = await request.post(api.couponReceive, { coupon_id: id })
      wx.showToast({ title: r && r.expire_at ? '已领取，' + String(r.expire_at).slice(0, 10) + ' 到期' : '领取成功', icon: 'none' })
      this.load()
    } catch (err) { /* handled */ }
  },

  // 去逛逛：从券页直接去商城挑商品，符合「领完就想用」的动线
  goMall() {
    wx.switchTab({ url: '/pages/goods/list' })
  }
})
