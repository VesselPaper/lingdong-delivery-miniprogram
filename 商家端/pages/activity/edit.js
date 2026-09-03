const api = require('../../utils/api')
const request = require('../../utils/request')

const DEFAULT = { title: '', subtitle: '', link: '', sort: '0' }

Page({
  data: {
    id: null,
    form: Object.assign({}, DEFAULT)
  },

  async onLoad(options) {
    this.setData({ id: options.id ? Number(options.id) : null })
    if (options.id) {
      try {
        const list = await request.get(api.activities)
        const item = list.find((a) => a.id === this.data.id)
        if (item) {
          this.setData({
            form: {
              title: item.title || '',
              subtitle: item.subtitle || '',
              link: item.link || '',
              sort: String(item.sort || 0)
            }
          })
        }
      } catch (e) { /* handled */ }
    }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: val })
  },

  async save() {
    const { form, id } = this.data
    if (!form.title.trim()) return wx.showToast({ title: '请填写活动标题', icon: 'none' })
    const payload = {
      title: form.title.trim(),
      subtitle: form.subtitle || '',
      link: form.link || '',
      sort: Number(form.sort || 0)
    }
    try {
      if (id) {
        await request.put(api.activities, Object.assign({}, payload, { id }))
      } else {
        await request.post(api.activities, payload)
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  }
})
