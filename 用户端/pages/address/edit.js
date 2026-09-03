const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    id: null,
    form: { contact_name: '', contact_phone: '', landmark_id: '', landmark_name: '', detail: '', is_default: false },
    points: [],
    showPicker: false
  },

  async onLoad(options) {
    this.setData({ id: options.id ? Number(options.id) : null })
    this.loadPoints()
    if (options.id) this.loadDetail()
  },

  async loadPoints() {
    try {
      const points = await request.get(api.landmarkList)
      this.setData({ points })
    } catch (e) { /* handled */ }
  },

  async loadDetail() {
    try {
      const list = await request.get(api.addressList)
      const item = list.find((a) => a.id === this.data.id)
      if (item) this.setData({ form: Object.assign({}, item, { is_default: !!item.is_default }) })
    } catch (e) { /* handled */ }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const v = e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: v })
  },

  onDefault(e) {
    const v = e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail
    this.setData({ 'form.is_default': !!v })
  },

  showPicker() { this.setData({ showPicker: true }) },
  closePicker() { this.setData({ showPicker: false }) },
  noop() {},

  choosePoint(e) {
    const item = e.currentTarget.dataset.item
    this.setData({ 'form.landmark_id': String(item.id), 'form.landmark_name': item.name, showPicker: false })
  },

  async save() {
    const { form, id } = this.data
    if (!form.contact_name) return wx.showToast({ title: '请填写收货人', icon: 'none' })
    if (!/^1\d{10}$/.test(form.contact_phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    if (!form.landmark_name) return wx.showToast({ title: '请选择送达点位', icon: 'none' })
    try {
      await request.post(api.addressSave, Object.assign({}, form, { is_default: form.is_default ? 1 : 0, id }))
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  }
})
