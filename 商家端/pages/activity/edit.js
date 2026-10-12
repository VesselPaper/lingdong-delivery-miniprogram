const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')
const promo = require('../../utils/promo')
const upload = require('../../utils/upload')

// 活动类型：图片不是一种类型，而是贴在任意类型上的「外观」。
// 所以「纯展示」= 只配图不配规则；打折/满减可以另外配海报。
const TYPE_LIST = [
  { value: 'discount', label: '打折' },
  { value: 'full_reduce', label: '满减' },
  { value: 'custom', label: '纯展示' }
]

// 活动状态文案：0=草稿（从未发布）/ 1=已发布（用户端生效）/ 2=已下线（发布过又下线）
const STATUS_TEXT = { 0: '草稿', 1: '已发布', 2: '已下线' }

function fmtTime(v) {
  return v ? String(v).slice(0, 16) : ''
}

// 活动有效期的展示文案（编辑页信息条 + 预览区共用）
function timeText(form) {
  if (!form.start_at && !form.end_at) return '长期有效'
  return (form.start_at || '未设置') + ' ~ ' + (form.end_at || '未设置')
}

Page({
  data: {
    id: null,
    typeList: TYPE_LIST,
    type: 'discount',
    form: { title: '', subtitle: '', link: '', sort: '0', start_at: '', end_at: '' },
    // 长期活动：不设起止日期（用户端显示「长期有效」）。
    // 由 form 的两个日期是否都为空推导，避免出现「开关开着但日期还在」的矛盾状态。
    longTerm: true,
    image: '',                     // 活动海报（/uploads/xxx.jpg），三种类型都可配
    discount: '',
    discountCalcHint: '',
    scope: 'all',
    goodsList: [],                 // 全部商品（含 category）
    selectedGoods: [],
    selectedMap: {},
    tiers: [{ threshold: '', reduce: '' }],
    customDetail: '',
    // 排序改成下拉选择：选项数量随当前活动总数（含已发布与草稿）自动变化，
    // 不用商家自己猜一个数字（原来是个自由输入的 number 框）
    sortOptions: [],
    sortIndex: 0,
    status: 0,
    statusText: '',
    // 商品选择面板
    pickerOpen: false,
    pickerCategory: '',            // '' = 全部分类
    pickerCategories: [],          // [{ name, count }]
    pickerGoods: [],
    pickerKeyword: '',
    // 实时预览
    previewOpen: true,
    previewPromo: ''
  },

  previewTimer: null,

  async onLoad(options) {
    // 活动编辑店主专属：店员直达（如分享卡片）时拦截
    if (!role.isOwner()) {
      wx.showToast({ title: '需要店主权限', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
      return
    }
    this.setData({ id: options.id ? Number(options.id) : null })

    // 商品列表供「指定商品」挑选 + 分类筛选（后端一次给全量，本地按分类过滤，避免每切一次分类就打一次接口）
    try {
      const goodsList = await request.get(api.goods)
      this.setData({ goodsList: goodsList || [], pickerCategories: this.buildCategories(goodsList || []) })
    } catch (e) { /* handled */ }

    // 活动列表：编辑已有活动要读它的内容，新建要数活动总数来生成排序选项。只请求一次，两处复用。
    let activities = []
    try {
      activities = (await request.get(api.activities)) || []
    } catch (e) { activities = [] }
    if (this.data.id) this.applyActivity(activities)
    this.loadSortOptions(activities)
    this.refreshPreview()
  },

  onUnload() {
    clearTimeout(this.previewTimer)
  },

  // 从商品列表汇总分类（含每类数量），供筛选标签显示
  buildCategories(list) {
    const map = {}
    ;(list || []).forEach((g) => {
      const c = g.category || '其他'
      map[c] = (map[c] || 0) + 1
    })
    return Object.keys(map).map((name) => ({ name, count: map[name] }))
  },

  // 排序下拉的选项：数量跟着现有活动总数走（含已发布与草稿）。
  //   编辑已有活动 → 总数不变，选项数 = 现有活动数
  //   新建活动     → 算上新活动自己，选项数 = 现有活动数 + 1
  // 文案用「第 N 位」而不是干巴巴的数字：商家才知道选了会排在前面还是后面。
  loadSortOptions(existing) {
    const list = existing || []
    const n = list.length
    const max = n + (this.data.id ? 0 : 1)

    // 当前排序值：编辑时取该活动自己的 sort，新建时默认排最后（不插队）
    let current = this.data.id
      ? (Number((list.find((a) => Number(a.id) === Number(this.data.id)) || {}).sort) || 1)
      : n + 1
    // 历史数据的 sort 可能超出当前活动数（删过活动的情况），往上补齐选项，避免选择器落空
    current = Math.max(1, Math.min(current, 999))

    const total = Math.max(max, current)
    const options = []
    for (let i = 1; i <= total; i++) options.push('第 ' + i + ' 位')

    this.setData({
      sortOptions: options,
      sortIndex: current - 1,   // 选项下标 = 排序值 - 1
      'form.sort': String(current)
    })
  },

  // 把后端返回的活动内容填进表单（list 由 onLoad 一次拉取后传入，避免重复请求）
  applyActivity(list) {
    try {
      const item = (list || []).find((a) => Number(a.id) === Number(this.data.id))
      if (!item) return
      let cfg = {}
      try { cfg = JSON.parse(item.config || '{}') || {} } catch (e) { cfg = {} }
      const type = item.type === 'full_reduce' ? 'full_reduce' : (item.type === 'discount' ? 'discount' : 'custom')
      const patch = {
        type,
        image: item.image || '',
        status: Number(item.status),
        statusText: STATUS_TEXT[Number(item.status)] || '草稿',
        form: {
          title: item.title || '',
          subtitle: item.subtitle || '',
          link: item.link || '',
          sort: String(item.sort || 0),
          start_at: fmtTime(item.start_at),
          end_at: fmtTime(item.end_at)
        }
      }
      if (type === 'discount') {
        // 库里存的是乘数(0.85)，界面用「几折」(8.5)
        patch.discount = cfg.discount !== undefined ? String(Math.round(Number(cfg.discount) * 100) / 10) : ''
        patch.discountCalcHint = this.calcHint(patch.discount)
      }
      if (type === 'full_reduce') {
        patch.tiers = (Array.isArray(cfg.tiers) && cfg.tiers.length)
          ? cfg.tiers.map((t) => ({ threshold: String(t.threshold || ''), reduce: String(t.reduce || '') }))
          : [{ threshold: '', reduce: '' }]
      }
      // 适用范围对打折/满减都生效
      if (type !== 'custom') {
        patch.scope = cfg.scope === 'goods' ? 'goods' : 'all'
        patch.selectedGoods = Array.isArray(cfg.goods_ids) ? cfg.goods_ids.map(Number) : []
        patch.selectedMap = this.mapSelected(patch.selectedGoods)
      }
      if (type === 'custom') patch.customDetail = item.subtitle || ''
      // 长期标志由「两个日期是否都为空」推导（唯一真源是 form，不改真相）
      patch.longTerm = !patch.form.start_at && !patch.form.end_at
      this.setData(patch)
      this.refreshPreview()
    } catch (e) { /* handled */ }
  },

  // ---------- 基础字段 ----------
  chooseType(e) {
    this.setData({ type: e.currentTarget.dataset.type }, () => this.refreshPreview())
  },

  // 排序下拉：第 N 项对应排序值 N（小 → 靠前，后端 ORDER BY sort 就是这么排的）
  onSortChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ sortIndex: idx, 'form.sort': String(idx + 1) })
  },

  // 长期开关：打开=不设起止日期（后端按空值即不设限处理），关闭=展开日期让商家填
  onLongTerm(e) {
    const on = !!(e.detail && e.detail.value)
    this.setData({
      longTerm: on,
      // 切换时清掉已选日期与选择器的值，避免留下「长期但仍有日期」的脏状态
      'form.start_at': '',
      'form.end_at': ''
    })
  },

  onField(e) {
    const { field } = e.currentTarget.dataset
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: val }, () => this.refreshPreview())
  },

  setScope(e) {
    this.setData({ scope: e.currentTarget.dataset.scope }, () => this.refreshPreview())
  },

  onDiscountInput(e) {
    this.setData(
      { discount: e.detail.value, discountCalcHint: this.calcHint(e.detail.value) },
      () => this.refreshPreview()
    )
  },

  calcHint(val) {
    const d = Number(val)
    if (!(d > 0) || !(d < 10)) return ''
    return '示例：¥10 商品按 ' + d + ' 折 ≈ ¥' + d.toFixed(2)
  },

  // ---------- 活动海报 ----------
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

  // ---------- 满减档位 ----------
  onTierField(e) {
    const { idx, field } = e.currentTarget.dataset
    const tiers = this.data.tiers.slice()
    tiers[idx] = Object.assign({}, tiers[idx], { [field]: e.detail.value })
    this.setData({ tiers }, () => this.refreshPreview())
  },
  addTier() {
    this.setData({ tiers: this.data.tiers.concat([{ threshold: '', reduce: '' }]) })
  },
  removeTier(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const tiers = this.data.tiers.slice()
    tiers.splice(idx, 1)
    this.setData({ tiers }, () => this.refreshPreview())
  },

  onCustomDetail(e) { this.setData({ customDetail: e.detail.value }) },

  // ---------- 商品选择面板 ----------
  openPicker() {
    // 每次打开重置筛选，避免上次的分类残留造成「明明选了商品却看不到」
    this.setData({ pickerOpen: true, pickerCategory: '', pickerKeyword: '' }, () => this.applyPickerFilter())
  },
  closePicker() { this.setData({ pickerOpen: false }) },
  noop() {},

  onPickerCategory(e) {
    const name = e.currentTarget.dataset.name || ''
    this.setData({ pickerCategory: name }, () => this.applyPickerFilter())
  },

  onPickerSearch(e) {
    this.setData({ pickerKeyword: e.detail.value }, () => this.applyPickerFilter())
  },

  // 面板内商品列表 = 分类筛选 + 关键词搜索（都在本地做，避免每次输入都请求接口）
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

  // 勾选/取消单个商品
  toggleGoods(e) {
    const gid = Number(e.currentTarget.dataset.id)
    const sel = this.data.selectedGoods.slice()
    const idx = sel.indexOf(gid)
    if (idx > -1) sel.splice(idx, 1); else sel.push(gid)
    this.setData({ selectedGoods: sel, selectedMap: this.mapSelected(sel) }, () => this.refreshPreview())
  },

  // 批量：全选当前筛选出来的商品（分类筛选后的结果，这是「根据分类批量选择」的关键）
  selectAllVisible() {
    const sel = this.data.selectedGoods.slice()
    const seen = {}
    sel.forEach((id) => { seen[id] = true })
    let added = 0
    ;(this.data.pickerGoods || []).forEach((g) => {
      if (!seen[g.id]) { sel.push(g.id); seen[g.id] = true; added++ }
    })
    if (!added) { wx.showToast({ title: '当前列表已全部选中', icon: 'none' }); return }
    this.setData({ selectedGoods: sel, selectedMap: this.mapSelected(sel) }, () => this.refreshPreview())
    wx.showToast({ title: '已选中 ' + added + ' 件', icon: 'none' })
  },

  // 批量：取消当前筛选出来的商品（只动眼前这些，不影响别的分类已选的）
  unselectAllVisible() {
    const drop = {}
    ;(this.data.pickerGoods || []).forEach((g) => { drop[g.id] = true })
    const sel = this.data.selectedGoods.filter((id) => !drop[id])
    this.setData({ selectedGoods: sel, selectedMap: this.mapSelected(sel) }, () => this.refreshPreview())
  },

  clearSelected() {
    this.setData({ selectedGoods: [], selectedMap: {} }, () => this.refreshPreview())
  },

  mapSelected(sel) {
    const m = {}
    ;(sel || []).forEach((id) => { m[id] = true })
    return m
  },

  // ---------- 实时预览 ----------
  togglePreview() {
    this.setData({ previewOpen: !this.data.previewOpen })
  },

  // 预览文案跟着表单走；节流合并连续输入（每敲一个字都重算没有意义）
  refreshPreview() {
    clearTimeout(this.previewTimer)
    this.previewTimer = setTimeout(() => this.computePreview(), 120)
  },

  computePreview() {
    const { type, discount, scope, selectedGoods, tiers } = this.data
    let config = {}
    if (type === 'discount') {
      config = { scope, goods_ids: scope === 'goods' ? selectedGoods : [], discount: Number(discount) / 10 }
    } else if (type === 'full_reduce') {
      config = {
        scope,
        goods_ids: scope === 'goods' ? selectedGoods : [],
        tiers: (tiers || [])
          .filter((t) => String(t.threshold).trim() !== '' && String(t.reduce).trim() !== '')
          .map((t) => ({ threshold: Number(t.threshold), reduce: Number(t.reduce) }))
      }
    }
    this.setData({ previewPromo: promo.summarize({ type, config }) })
  },

  // ---------- 校验 ----------
  // 草稿只要求有标题：「保存草稿」是给商家存半成品的，此时折扣/满减还没算清楚是常态。
  // 发布才需要完整校验 —— 否则就等于把半成品推给用户端。
  validateTitle() {
    if (!String(this.data.form.title || '').trim()) {
      wx.showToast({ title: '请填写活动标题', icon: 'none' })
      return false
    }
    // 图片是发布的硬性条件，而后端对**已发布**的活动连「仅保存」也会校验图片
    // （保存不能把已发布活动降级）。所以这里提前拦，别让商家点了保存才吃一个接口报错。
    const needsImage = this.data.type === 'custom' || this.data.status === 1 || this.data.status === 2
    if (needsImage && !this.data.image) {
      wx.showToast({ title: '请先上传活动图片', icon: 'none' })
      return false
    }
    return true
  },

  // 发布前的完整校验
  validateAll() {
    if (!this.validateTitle()) return false
    const { type, discount, scope, selectedGoods, tiers } = this.data
    if (type === 'discount') {
      const d = Number(discount)
      if (!(d > 0) || !(d < 10)) { wx.showToast({ title: '请填写有效的折扣(0-10，如 8.5)', icon: 'none' }); return false }
      if (scope === 'goods' && !selectedGoods.length) { wx.showToast({ title: '请选择参与折扣的商品', icon: 'none' }); return false }
    }
    if (type === 'full_reduce') {
      const clean = tiers.filter((t) => String(t.threshold).trim() !== '' && String(t.reduce).trim() !== '')
      if (!clean.length) { wx.showToast({ title: '请至少填写一档满减', icon: 'none' }); return false }
      for (const t of clean) {
        if (!(Number(t.threshold) > 0) || !(Number(t.reduce) > 0)) {
          wx.showToast({ title: '满减档位需为正数金额', icon: 'none' }); return false
        }
      }
      if (scope === 'goods' && !selectedGoods.length) { wx.showToast({ title: '请选择参与满减的商品', icon: 'none' }); return false }
    }
    return true
  },

  buildPayload() {
    const { id, type, form, image, discount, scope, selectedGoods, tiers } = this.data
    const start = form.start_at ? form.start_at.replace('T', ' ').replace(/:$/, '') : ''
    const end = form.end_at ? form.end_at.replace('T', ' ').replace(/:$/, '') : ''
    const payload = {
      id,
      title: form.title.trim(),
      subtitle: form.subtitle || '',
      image: image || '',
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
        tiers: (tiers || [])
          .filter((t) => String(t.threshold).trim() !== '' && String(t.reduce).trim() !== '')
          .map((t) => ({ threshold: Number(t.threshold), reduce: Number(t.reduce) }))
      }
    }
    return payload
  },

  // 保存草稿：只存进商家端，不推到用户端（status_action='draft' 后端不改上下架状态）
  saveDraft() { return this.save('draft') },

  // 发布：完整校验 → 保存 → 上架到用户端（草稿转已发布；已下线的活动借此重新上架）
  publish() { return this.save('publish') },

  async save(statusAction) {
    if (statusAction === 'publish' ? !this.validateAll() : !this.validateTitle()) return
    const payload = this.buildPayload()
    const id = payload.id
    delete payload.id
    // 状态动作交给后端裁决（前端传的值可能过期），前端只负责表达商家意图
    payload.status_action = statusAction
    const publishing = statusAction === 'publish'
    try {
      if (id) {
        await request.put(api.activities, Object.assign({}, payload, { id }))
      } else {
        await request.post(api.activities, payload)
      }
      wx.showToast({ title: publishing ? '已发布' : '已保存草稿', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  }
})
