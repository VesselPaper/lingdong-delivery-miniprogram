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
      const item = await request.get(api.cancelRequestDetail + '?id=' + this.data.id)
      this.setData({ item })
    } catch (e) { /* handled */ }
  },

  // 同意取消
  approve() {
    wx.showModal({
      title: '同意取消该订单？',
      content: '同意后订单将取消；已支付金额的退款以实际支付通道为准',
      confirmColor: '#2BA471',
      success: async (r) => {
        if (!r.confirm) return
        await this.handle('approve', '')
      }
    })
  },

  // 拒绝取消（填理由）
  reject() {
    wx.showModal({
      title: '拒绝取消',
      editable: true,
      placeholderText: '请填写拒绝理由',
      confirmColor: '#E64340',
      success: async (r) => {
        if (!r.confirm) return
        const reply = String(r.content || '').trim()
        if (!reply) return wx.showToast({ title: '请填写拒绝理由', icon: 'none' })
        await this.handle('reject', reply)
      }
    })
  },

  async handle(action, reply) {
    wx.showLoading({ title: '处理中' })
    try {
      await request.post(api.cancelRequestHandle, { id: this.data.id, action, reply })
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
