const api = require('../../utils/api')
const request = require('../../utils/request')

Page({
  data: {
    id: null,
    item: {}
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) })
    this.load()
  },

  async load() {
    try {
      const item = await request.get(api.refundDetail + '?id=' + this.data.id)
      this.setData({ item })
    } catch (e) { /* handled */ }
  },

  // 同意退款（金额默认全额，可改）
  approve() {
    wx.showModal({
      title: '同意退款',
      editable: true,
      placeholderText: '退款金额（留空=全额）',
      confirmColor: '#2BA471',
      success: async (r) => {
        if (!r.confirm) return
        const content = String(r.content || '').trim()
        const amount = content && !isNaN(Number(content)) && Number(content) >= 0 ? Number(content) : undefined
        await this.handle('approve', amount, '')
      }
    })
  },

  // 拒绝退款（填理由）
  reject() {
    wx.showModal({
      title: '拒绝退款',
      editable: true,
      placeholderText: '请填写拒绝理由',
      confirmColor: '#E64340',
      success: async (r) => {
        if (!r.confirm) return
        const reply = String(r.content || '').trim()
        if (!reply) return wx.showToast({ title: '请填写拒绝理由', icon: 'none' })
        await this.handle('reject', undefined, reply)
      }
    })
  },

  // 回复投诉
  reply() {
    wx.showModal({
      title: '回复投诉',
      editable: true,
      placeholderText: '请输入处理意见',
      confirmColor: '#3078C0',
      success: async (r) => {
        if (!r.confirm) return
        await this.handle('reply', undefined, String(r.content || '').trim())
      }
    })
  },

  async handle(action, amount, reply) {
    wx.showLoading({ title: '处理中' })
    try {
      await request.post(api.refundHandle, { id: this.data.id, action, amount, reply })
      wx.hideLoading()
      wx.showToast({ title: '已处理', icon: 'success' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '处理失败', icon: 'none' })
    }
  },

  // 订单号复制
  copyText(e) {
    const text = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.text : ''
    wx.setClipboardData({ data: String(text == null ? '' : text) })
  }
})
