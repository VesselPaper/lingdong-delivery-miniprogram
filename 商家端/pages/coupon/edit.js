const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')
const promo = require('../../utils/promo')
const upload = require('../../utils/upload')

// 券类型：与后端 coupons.type 取值一一对应
const TYPE_LIST = [
  { value: 'full_reduce', label: '满减' },
  { value: 'discount', label: '折扣' },
  { value: 'no_threshold', label: '无门槛' }
]

const EMPTY_FORM = {
  title: '',
  threshold: '',      // 满减门槛（元）
  reduce: '',         // 抵扣金额（元）
  discount: '',       // 折扣，界面填「几折」（8.5），入库转乘数 0.85
  max_reduce: '',     // 折扣券封顶（元），空 = 不封顶
  valid_type: 'relative',
  relative_days: '7', // 领取后 N 天有效
  start_at: '',       // 绝对有效期用日期（入库补 00:00:00 / 23:59:59，按「整天」算）
  end_at: '',
  total_qty: '',      // 空 = 不限量
  per_user_limit: '1' // 空 = 不限领
}

Page({
  data: {
    id: null,
    typeList: TYPE_LIST,
    type: 'full_reduce',
    form: Object.assign({}, EMPTY_FORM),
    // 券图：用户端首页与活动页都是图片列表，券靠它呈现。启用必须有图（后端也会拦）
    image: '',
    enabled: true,               // 新建默认启用；停用的券用户领不到、结算也不可用
    scope: 'all',
    goodsList: [],
    categories: [],              // [{ name, count }]
    selectedGoods: [],
    selectedMap: {},
    selectedCats: [],
    selectedCatMap: {},
    // 选择范围面板：mode 决定渲染分类列表还是商品列表
    pickerOpen: false,
    pickerMode: 'goods',
    pickerCategory: '',
    pickerKeyword: '',
    pickerGoods: [],
    // 实时预览（用户端就是「图 + 规则 + 领取按钮」，所以不预览面额块）
    previewRule: '',
    previewScope: '',
    previewValid: ''
  },

  async onLoad(options) {
    if (!role.isOwner()) {
      wx.showToast({ title: '需要店主权限', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
      return
    }
    this.setData({ id: options.id ? Number(options.id) : null })

    // 商品列表一次拉全：既供「指定商品」挑选，也用来汇总分类给「指定分类」用
    let goodsList = []
    try {
      goodsList = (await request.get(api.goods)) || []
    } catch (e) { goodsList = [] }
    this.setData({ goodsList, categories: this.buildCategories(goodsList) })

    if (this.data.id) await this.loadCoupon()
    this.refreshPreview()
  },

  // 汇总分类（含每类商品数）
  buildCategories(list) {
    const map = {}
    ;(list || []).forEach((g) => {
      const c = g.category || '其他'
      map[c] = (map[c] || 0) + 1
    })
    return Object.keys(map).map((name) => ({ name, count: map[name] }))
  },

  // 编辑：从列表接口里取该券（券数量不多，列表页信息已够填表）
  async loadCoupon() {
    try {
      const list = (await request.get(api.coupons)) || []
      const c = list.find((x) => Number(x.id) === Number(this.data.id))
      if (!c) { wx.showToast({ title: '优惠券不存在', icon: 'none' }); return }
      const ids = promo.parseIds(c.scope_ids)
      const patch = {
        type: c.type || 'full_reduce',
        image: c.image || '',
        enabled: Number(c.status) === 1,
        scope: c.scope || 'all',
        form: {
          title: c.title || '',
          threshold: Number(c.threshold) > 0 ? String(c.threshold) : '',
          reduce: Number(c.reduce) > 0 ? String(c.reduce) : '',
          // 库里存乘数(0.85)，界面显示「几折」(8.5)
          discount: Number(c.discount) > 0 ? String(Math.round(Number(c.discount) * 100) / 10) : '',
          max_reduce: Number(c.max_reduce) > 0 ? String(c.max_reduce) : '',
          valid_type: c.valid_type === 'absolute' ? 'absolute' : 'relative',
          relative_days: Number(c.relative_days) > 0 ? String(c.relative_days) : '',
          start_at: c.start_at ? String(c.start_at).slice(0, 10) : '',
          end_at: c.end_at ? String(c.end_at).slice(0, 10) : '',
          total_qty: Number(c.total_qty) > 0 ? String(c.total_qty) : '',
          per_user_limit: Number(c.per_user_limit) > 0 ? String(c.per_user_limit) : ''
        }
      }
      if (c.scope === 'goods') {
        patch.selectedGoods = ids.map(Number).filter((n) => !isNaN(n))
        patch.selectedMap = this.mapOf(patch.selectedGoods)
      }
      if (c.scope === 'category') {
        patch.selectedCats = ids
        patch.selectedCatMap = this.mapOf(ids)
      }
      this.setData(patch)
    } catch (e) { /* handled */ }
  },

  mapOf(list) {
    const m = {}
    ;(list || []).forEach((k) => { m[k] = true })
    return m
  },

  // ---------- 券图 ----------
  async choosePoster() {
    try {
      const path = await upload.pickImage()
      wx.showLoading({ title: '上传中', mask: true })
      const url = await upload.uploadImage(path)
      wx.hideLoading()
      this.setData({ image: url }, () => this.refreshPreview())
    } catch (e) {
      wx.hideLoading()
      if (e && e.message && e.message !== '未选择图片') wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  removePoster() {
    this.setData({ image: '' }, () => this.refreshPreview())
  },

  previewPoster() {
    if (!this.data.image) return
    wx.previewImage({ urls: [this.data.image], current: this.data.image })
  },

  // ---------- 表单 ----------
  chooseType(e) {
    this.setData({ type: e.currentTarget.dataset.type }, () => this.refreshPreview())
  },

  onField(e) {
    const { field } = e.currentTarget.dataset
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: val }, () => this.refreshPreview())
  },

  onEnabled(e) {
    this.setData({ enabled: !!(e.detail && e.detail.value) })
  },

  setScope(e) {
    this.setData({ scope: e.currentTarget.dataset.scope }, () => this.refreshPreview())
  },

  setValidType(e) {
    this.setData({ 'form.valid_type': e.currentTarget.dataset.vt }, () => this.refreshPreview())
  },

  // ---------- 选择范围面板 ----------
  openPicker(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ pickerOpen: true, pickerMode: mode, pickerCategory: '', pickerKeyword: '' }, () => {
      if (mode === 'goods') this.applyPickerFilter()
    })
  },

  closePicker() { this.setData({ pickerOpen: false }) },

  noop() {},

  onPickerCategory(e) {
    this.setData({ pickerCategory: e.currentTarget.dataset.name || '' }, () => this.applyPickerFilter())
  },

  onPickerSearch(e) {
    this.setData({ pickerKeyword: e.detail.value }, () => this.applyPickerFilter())
  },

  // 面板内商品 = 分类筛选 + 关键词搜索（都在本地做，避免每次输入都打接口）
  applyPickerFilter() {
    const { goodsList, pickerCategory, pickerKeyword } = this.data
    const kw = String(pickerKeyword || '').trim()
    const list = (goodsList || []).filter((g) => {
      if (pickerCategory && (g.category || '其他') !== pickerCategory) return false
      if (kw && String(g.name || '').indexOf(kw) === -1) return false
      return true
    })
    this.setData({ pickerGoods: list })
  },

  toggleGoods(e) {
    const gid = Number(e.currentTarget.dataset.id)
    const sel = this.data.selectedGoods.slice()
    const i = sel.indexOf(gid)
    if (i > -1) sel.splice(i, 1); else sel.push(gid)
    this.setData({ selectedGoods: sel, selectedMap: this.mapOf(sel) }, () => this.refreshPreview())
  },

  toggleCat(e) {
    const name = e.currentTarget.dataset.name
    const sel = this.data.selectedCats.slice()
    const i = sel.indexOf(name)
    if (i > -1) sel.splice(i, 1); else sel.push(name)
    this.setData({ selectedCats: sel, selectedCatMap: this.mapOf(sel) }, () => this.refreshPreview())
  },

  // 批量全选当前筛选结果（按分类批量选商品的关键）
  selectAllVisible() {
    const sel = this.data.selectedGoods.slice()
    const seen = this.mapOf(sel)
    let added = 0
    ;(this.data.pickerGoods || []).forEach((g) => {
      if (!seen[g.id]) { sel.push(g.id); seen[g.id] = true; added++ }
    })
    if (!added) { wx.showToast({ title: '当前列表已全部选中', icon: 'none' }); return }
    this.setData({ selectedGoods: sel, selectedMap: this.mapOf(sel) }, () => this.refreshPreview())
    wx.showToast({ title: '已选中 ' + added + ' 件', icon: 'none' })
  },

  unselectAllVisible() {
    const drop = this.mapOf((this.data.pickerGoods || []).map((g) => g.id))
    const sel = this.data.selectedGoods.filter((id) => !drop[id])
    this.setData({ selectedGoods: sel, selectedMap: this.mapOf(sel) }, () => this.refreshPreview())
  },

  clearSelected() {
    if (this.data.pickerMode === 'goods') {
      this.setData({ selectedGoods: [], selectedMap: {} }, () => this.refreshPreview())
    } else {
      this.setData({ selectedCats: [], selectedCatMap: {} }, () => this.refreshPreview())
    }
  },

  // ---------- 实时预览 ----------
  refreshPreview() {
    const { type, form, scope, selectedGoods, selectedCats } = this.data
    const shape = {
      type,
      threshold: Number(form.threshold) || 0,
      reduce: Number(form.reduce) || 0,
      discount: Number(form.discount) / 10,
      max_reduce: Number(form.max_reduce) || 0,
      valid_type: form.valid_type,
      relative_days: Number(form.relative_days) || 0,
      start_at: form.start_at,
      end_at: form.end_at,
      scope,
      scope_ids: scope === 'goods' ? selectedGoods : selectedCats
    }
    this.setData({
      previewRule: promo.couponRule(shape),
      previewScope: promo.couponScope(shape),
      previewValid: promo.couponValid(shape)
    })
  },

  // ---------- 校验 ----------
  validate() {
    const { type, form, scope, selectedGoods, selectedCats, image, enabled } = this.data
    if (!String(form.title || '').trim()) { wx.showToast({ title: '请填写券名称', icon: 'none' }); return false }
    // 用户端靠图片呈现这张券，所以启用前必须配图（与活动的「发布必须有图」同一条规矩）
    if (enabled && !image) { wx.showToast({ title: '请先上传优惠券图片', icon: 'none' }); return false }
    if (type === 'full_reduce') {
      if (!(Number(form.threshold) > 0)) { wx.showToast({ title: '请填写满减门槛', icon: 'none' }); return false }
      if (!(Number(form.reduce) > 0)) { wx.showToast({ title: '请填写抵扣金额', icon: 'none' }); return false }
      if (Number(form.reduce) > Number(form.threshold)) { wx.showToast({ title: '抵扣金额不能大于门槛', icon: 'none' }); return false }
    }
    if (type === 'no_threshold' && !(Number(form.reduce) > 0)) {
      wx.showToast({ title: '请填写抵扣金额', icon: 'none' }); return false
    }
    if (type === 'discount') {
      const d = Number(form.discount)
      if (!(d > 0) || !(d < 10)) { wx.showToast({ title: '请填写有效的折扣（如 8.5）', icon: 'none' }); return false }
    }
    if (form.valid_type === 'relative' && !(Number(form.relative_days) > 0)) {
      wx.showToast({ title: '请填写领取后有效天数', icon: 'none' }); return false
    }
    if (scope === 'goods' && !selectedGoods.length) { wx.showToast({ title: '请选择适用商品', icon: 'none' }); return false }
    if (scope === 'category' && !selectedCats.length) { wx.showToast({ title: '请选择适用分类', icon: 'none' }); return false }
    return true
  },

  buildPayload() {
    const { id, type, form, scope, selectedGoods, selectedCats, enabled, image } = this.data
    const isDiscount = type === 'discount'
    const isFullReduce = type === 'full_reduce'
    return {
      id,
      title: String(form.title || '').trim(),
      type,
      image,
      // 不适用的字段一律归零，避免「从满减切到折扣」时把上一份数据留在库里
      threshold: isFullReduce ? Number(form.threshold) || 0 : 0,
      reduce: isDiscount ? 0 : (Number(form.reduce) || 0),
      discount: isDiscount ? Number(form.discount) / 10 : 0,
      max_reduce: isDiscount ? (Number(form.max_reduce) || 0) : 0,
      valid_type: form.valid_type,
      // 绝对有效期按「整天」算：开始当天 00:00:00 生效、结束当天 23:59:59 失效
      start_at: form.valid_type === 'absolute' && form.start_at ? form.start_at + ' 00:00:00' : '',
      end_at: form.valid_type === 'absolute' && form.end_at ? form.end_at + ' 23:59:59' : '',
      relative_days: form.valid_type === 'relative' ? (Number(form.relative_days) || 0) : 0,
      scope,
      scope_ids: scope === 'goods' ? selectedGoods : (scope === 'category' ? selectedCats : []),
      total_qty: Number(form.total_qty) || 0,          // 0 = 不限量
      per_user_limit: form.per_user_limit === '' ? 0 : (Number(form.per_user_limit) || 0),
      status: enabled ? 1 : 0
    }
  },

  async save() {
    if (!this.validate()) return
    const payload = this.buildPayload()
    const id = payload.id
    delete payload.id
    try {
      if (id) await request.put(api.coupons, Object.assign({}, payload, { id }))
      else await request.post(api.coupons, payload)
      wx.showToast({ title: id ? '已保存' : '已创建', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  }
})
