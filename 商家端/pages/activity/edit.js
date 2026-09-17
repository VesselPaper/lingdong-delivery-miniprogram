const api = require('../../utils/api')
const request = require('../../utils/request')

const TYPE_LIST = [
  { value: 'discount', label: '商品打折', desc: '全场或指定商品按 X 折出售' },
  { value: 'full_reduce', label: '满减', desc: '满 X 元减 Y 元，可多档' },
  { value: 'custom', label: '自由活动', desc: '纯展示，可自定义内容与跳转' }
]

function fmtTime(v) {
  return v ? String(v).slice(0, 16) : ''
}

Page({
  data: {
    id: null,
    typeList: TYPE_LIST,
    type: 'discount',              // 默认从最常用的「商品打折」开始
    form: { title: '', subtitle: '', link: '', sort: '0', start_at: '', end_at: '' },
    discount: '',                  // 折扣，如 8.5 表示 85 折
    discountCalcHint: '',          // 折扣折算提示文案
    scope: 'all',                  // all 全场 / goods 指定商品
    goodsList: [],                 // 全部商品（用于指定商品多选）
    selectedGoods: [],             // 已选商品 id 数组
    selectedMap: {},               // 已选商品 id -> true（WXML 渲染用）
    tiers: [{ threshold: '', reduce: '' }],  // 满减多档
    customDetail: ''
  },

  async onLoad(options) {
    this.setData({ id: options.id ? Number(options.id) : null })
    // 加载全部商品供「指定商品」选择
    try {
      const goodsList = await request.get(api.goods)
      this.setData({ goodsList })
    } catch (e) { /* handled */ }

    if (this.data.id) {
      try {
        const list = await request.get(api.activities)
        const item = list.find((a) => a.id === this.data.id)
        if (!item) return
        let cfg = {}
        try { cfg = JSON.parse(item.config || '{}') || {} } catch (e) { cfg = {} }
        const patch = {
          type: item.type === 'custom' ? 'custom' : (item.type === 'full_reduce' ? 'full_reduce' : 'discount'),
          form: {
            title: item.title || '',
            subtitle: item.subtitle || '',
            link: item.link || '',
            sort: String(item.sort || 0),
            start_at: fmtTime(item.start_at),
            end_at: fmtTime(item.end_at)
          }
        }
        if (this.data.type === 'discount') {
          patch.discount = cfg.discount !== undefined ? String(Math.round(Number(cfg.discount) * 10 * 10) / 10) : ''
          patch.scope = cfg.scope === 'goods' ? 'goods' : 'all'
          patch.selectedGoods = Array.isArray(cfg.goods_ids) ? cfg.goods_ids.map(Number) : []
          patch.selectedMap = this.mapSelected(patch.selectedGoods)
        }
        if (this.data.type === 'full_reduce') {
          patch.tiers = (Array.isArray(cfg.tiers) && cfg.tiers.length)
            ? cfg.tiers.map((t) => ({ threshold: String(t.threshold || ''), reduce: String(t.reduce || '') }))
            : [{ threshold: '', reduce: '' }]
          patch.scope = cfg.scope === 'goods' ? 'goods' : 'all'
          patch.selectedGoods = Array.isArray(cfg.goods_ids) ? cfg.goods_ids.map(Number) : []
          patch.selectedMap = this.mapSelected(patch.selectedGoods)
        }
        if (this.data.type === 'custom') patch.customDetail = item.subtitle || ''
        this.setData(patch)
      } catch (e) { /* handled */ }
    }
  },

  chooseType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
  },

  onField(e) {
    const { field } = e.currentTarget.dataset
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: val })
  },

  setScope(e) { this.setData({ scope: e.currentTarget.dataset.scope }) },

  onDiscountInput(e) { 
    this.setData({ discount: e.detail.value, discountCalcHint: this.calcHint(e.detail.value) })
  },

  calcHint(val) {
    const d = Number(val)
    if (!(d > 0) || !(d < 10)) return ''
    return '示例：¥10 商品按 ' + d + ' 折 ≈ ¥' + (d).toFixed(2)
  },

  // 指定商品多选：selectedMap 供 WXML 直接按 id 判断（WXML 不能调用 indexOf）
  toggleGoods(e) {
    const gid = Number(e.currentTarget.dataset.id)
    let sel = this.data.selectedGoods.slice()
    const idx = sel.indexOf(gid)
    if (idx > -1) sel.splice(idx, 1); else sel.push(gid)
    this.setData({ selectedGoods: sel, selectedMap: this.mapSelected(sel) })
  },

  mapSelected(sel) {
    const m = {}
    ;(sel || []).forEach((id) => { m[id] = true })
    return m
  },

  // 满减档位
  onTierField(e) {
    const { idx, field } = e.currentTarget.dataset
    const tiers = this.data.tiers.slice()
    tiers[idx] = Object.assign({}, tiers[idx], { [field]: e.detail.value })
    this.setData({ tiers })
  },
  addTier() {
    this.setData({ tiers: this.data.tiers.concat([{ threshold: '', reduce: '' }]) })
  },
  removeTier(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const tiers = this.data.tiers.slice()
    tiers.splice(idx, 1)
    this.setData({ tiers })
  },

  onCustomDetail(e) { this.setData({ customDetail: e.detail.value }) },

  validate() {
    const { type, form, discount, scope, selectedGoods, tiers } = this.data
    if (!form.title.trim()) { wx.showToast({ title: '请填写活动标题', icon: 'none' }); return null }
    if (type === 'discount') {
      const d = Number(discount)
      if (!(d > 0) || !(d < 10)) { wx.showToast({ title: '请填写有效的折扣(0-10，如 8.5)', icon: 'none' }); return null }
      if (scope === 'goods' && !selectedGoods.length) { wx.showToast({ title: '请选择参与折扣的商品', icon: 'none' }); return null }
    }
    if (type === 'full_reduce') {
      const clean = tiers.filter((t) => String(t.threshold).trim() !== '' && String(t.reduce).trim() !== '')
      if (!clean.length) { wx.showToast({ title: '请至少填写一档满减', icon: 'none' }); return null }
      for (const t of clean) {
        if (!(Number(t.threshold) > 0) || !(Number(t.reduce) > 0)) {
          wx.showToast({ title: '满减档位需为正数金额', icon: 'none' }); return null
        }
      }
      if (scope === 'goods' && !selectedGoods.length) { wx.showToast({ title: '请选择参与满减的商品', icon: 'none' }); return null }
    }
    return true
  },

  buildPayload() {
    const { id, type, form, discount, scope, selectedGoods, tiers } = this.data
    const start = form.start_at ? form.start_at.replace('T', ' ').replace(/:$/, '') : ''
    const end = form.end_at ? form.end_at.replace('T', ' ').replace(/:$/, '') : ''
    const payload = {
      id,
      title: form.title.trim(),
      subtitle: form.subtitle || '',
      link: form.link || '',
      sort: Number(form.sort || 0),
      start_at: start,
      end_at: end,
      type,
      config: {}
    }
    if (type === 'discount') {
      payload.config = {
        scope,
        goods_ids: scope === 'goods' ? selectedGoods : [],
        // 商家输入"几折"(如 8.5)，存库统一用乘数(0.85)，与后端 goodsPricePayload/promotion 一致
        discount: Number(discount) / 10
      }
    } else if (type === 'full_reduce') {
      payload.config = {
        scope,
        goods_ids: scope === 'goods' ? selectedGoods : [],
        tiers: tiers
          .filter((t) => String(t.threshold).trim() !== '' && String(t.reduce).trim() !== '')
          .map((t) => ({ threshold: Number(t.threshold), reduce: Number(t.reduce) }))
      }
    }
    return payload
  },

  async save() {
    if (!this.validate()) return
    const payload = this.buildPayload()
    const isEdit = !!payload.id
    const saveId = payload.id
    delete payload.id
    try {
      if (isEdit) {
        await request.put(api.activities, Object.assign({}, payload, { id: saveId }))
      } else {
        await request.post(api.activities, payload)
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  }
})