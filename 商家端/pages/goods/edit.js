const api = require('../../utils/api')
const request = require('../../utils/request')
const config = require('../../utils/config')

const ORIGIN = config.baseUrl.replace(/\/api$/, '')

const DEFAULT = {
  name: '', category: '热卤', price: '', original_price: '', stock: '99', description: '', image: ''
}
Page({
  data: {
    id: null,
    form: Object.assign({}, DEFAULT)
  },

  async onLoad(options) {
    this.setData({ id: options.id ? Number(options.id) : null })
    if (options.id) {
      try {
        const list = await request.get(api.goods)
        const item = list.find((g) => g.id === this.data.id)
        if (item) {
          this.setData({ form: {
            name: item.name, category: item.category, price: String(item.price),
            original_price: String(item.original_price || ''), stock: String(item.stock),
            description: item.description || '', image: item.image || ''
          }})
        }
      } catch (e) { /* handled */ }
    }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.detail
    this.setData({ ['form.' + field]: val })
  },

  async chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        wx.showLoading({ title: '上传中' })
        try {
          const data = await new Promise((resolve, reject) => {
            wx.getFileSystemManager().readFile({
              filePath: file.tempFilePath,
              encoding: 'base64',
              success: (r) => resolve(r.data),
              fail: reject
            })
          })
          const up = await request.post(api.upload, { name: file.fileName || 'img.jpg', data })
          this.setData({ 'form.image': up.url })
        } catch (e) { /* handled */ } finally {
          wx.hideLoading()
        }
      },
      fail: () => { /* 用户取消或选择失败 */ }
    })
  },

  removeImage() {
    this.setData({ 'form.image': '' })
  },

  previewImage() {
    if (!this.data.form.image) return
    wx.previewImage({ urls: [request.normalize(this.data.form.image)] })
  },

  async save() {
    const { form, id } = this.data
    if (!form.name) return wx.showToast({ title: '请填写商品名称', icon: 'none' })
    if (!form.price || Number(form.price) <= 0) return wx.showToast({ title: '请填写正确售价', icon: 'none' })
    const payload = {
      name: form.name,
      category: form.category || '其他',
      price: Number(form.price),
      original_price: Number(form.original_price || 0),
      stock: Number(form.stock || 99),
      description: form.description || '',
      image: (form.image || '').replace(ORIGIN, '')
    }
    try {
      if (id) {
        await request.put(api.goodsUpdate, Object.assign({}, payload, { id }))
      } else {
        await request.post(api.goods, payload)
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { /* handled */ }
  }
})
