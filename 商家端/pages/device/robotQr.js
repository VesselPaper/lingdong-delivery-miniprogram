const qrcode = require('../../utils/vendor/qrcode')

// 无人车二维码页：展示本车二维码（内容 LD-R:<deviceSn>），供打印贴于车身。
// 商家扫该码 → 配单上货；用户扫该码 → 输入取餐码取餐。
Page({
  data: {
    sn: '',
    qrText: '',
    ready: false,
    saving: false
  },
  canvasNode: null,

  onLoad(options) {
    const sn = String(options.sn || '').trim()
    this.setData({ sn, qrText: sn ? 'LD-R:' + sn : '' })
  },

  onReady() {
    this.drawQr()
  },

  drawQr() {
    const text = this.data.qrText
    if (!text) return
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    wx.createSelectorQuery().in(this).select('#qrCanvas').fields({ node: true, size: true }).exec((res) => {
      const f = res && res[0]
      if (!f || !f.node) return
      const canvas = f.node
      this.canvasNode = canvas
      const dpr = (wx.getSystemInfoSync().pixelRatio) || 2
      const size = Math.min(f.width || 240, f.height || 240)
      canvas.width = size * dpr
      canvas.height = size * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, size)
      const cell = size / (n + 8)
      ctx.fillStyle = '#000000'
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(Math.floor((c + 4) * cell), Math.floor((r + 4) * cell), Math.ceil(cell), Math.ceil(cell))
          }
        }
      }
      this.setData({ ready: true })
    })
  },

  // 保存到相册，方便打印贴车
  saveQr() {
    if (this.data.saving || !this.canvasNode) return
    this.setData({ saving: true })
    wx.canvasToTempFilePath({
      canvas: this.canvasNode,
      success: (r) => {
        this.setData({ saving: false })
        wx.saveImageToPhotosAlbum({
          filePath: r.tempFilePath,
          success: () => wx.showToast({ title: '已保存到相册，可打印贴于无人车', icon: 'none' }),
          fail: (e) => {
            const msg = (e && e.errMsg) || ''
            if (msg.indexOf('auth') > -1 || msg.indexOf('deny') > -1) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许保存图片到相册，然后重试。',
                confirmText: '去设置',
                success: (m) => { if (m.confirm) wx.openSetting() }
              })
            } else {
              wx.showToast({ title: '保存失败，请重试', icon: 'none' })
            }
          }
        })
      },
      fail: () => {
        this.setData({ saving: false })
        wx.showToast({ title: '生成图片失败', icon: 'none' })
      }
    })
  }
})
