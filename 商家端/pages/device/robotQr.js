const api = require('../../utils/api')
const request = require('../../utils/request')

// 无人车二维码页：展示本车「取餐小程序码」（微信扫一扫直达用户端取餐页），供打印贴于车身。
// 一个码两端用：微信扫 → 进用户端取餐校验；商家在商家端小程序内 wx.scanCode 扫同一码
// （scene=纯设备号）→ parseDeviceSn 原样返回 → 配单上货流程不变。
Page({
  data: {
    sn: '',
    qrUrl: '',
    ready: false,
    loading: false,
    errMsg: ''
  },

  onLoad(options) {
    const sn = String(options.sn || '').trim()
    this.setData({ sn })
    if (sn) this.loadWxacode()
  },

  // 调后端生成/获取本车取餐小程序码（图片落盘 uploads/robot-qr/<sn>.png）
  async loadWxacode() {
    if (this.data.loading) return
    this.setData({ loading: true, errMsg: '' })
    try {
      const r = await request.post(api.deviceWxacode, { device_sn: this.data.sn })
      this.setData({ qrUrl: r.image_url, ready: true })
    } catch (e) {
      this.setData({ errMsg: (e && e.message) || '生成二维码失败，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 保存到相册，方便打印贴车
  saveQr() {
    if (!this.data.qrUrl || this.data.loading) return
    wx.showLoading({ title: '保存中' })
    wx.downloadFile({
      url: this.data.qrUrl,
      success: (r) => {
        wx.hideLoading()
        if (r.statusCode !== 200) { wx.showToast({ title: '下载二维码失败', icon: 'none' }); return }
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
        wx.hideLoading()
        wx.showToast({ title: '下载二维码失败，请重试', icon: 'none' })
      }
    })
  }
})
