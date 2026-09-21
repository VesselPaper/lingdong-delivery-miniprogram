// 头像选择/上传（「我的」页与「编辑个人信息」页共用）
//
// 微信的规则：小程序拿不到用户的微信头像，必须由用户主动点一次 <button open-type="chooseAvatar">，
// 微信弹出的选择器里默认就是用户当前的微信头像 —— 所以「默认微信头像」是靠这个按钮实现的，
// 不是后台静默读取（wx.getUserProfile 的头像能力早已被微信回收）。
//
// chooseAvatar 给到的是本地临时文件路径，这里读成 base64 再 POST 给后端存盘（与商家端图片上传同一套做法）。

const api = require('./api')
const request = require('./request')

const EXT_OK = ['.jpg', '.jpeg', '.png', '.webp']

// 上传本地临时头像，成功返回后端保存后的用户对象（avatar 已是可直接用的完整 URL）
function upload(tempFilePath) {
  return new Promise((resolve, reject) => {
    if (!tempFilePath) {
      reject(new Error('没有取到头像文件'))
      return
    }
    const raw = String(tempFilePath)
    const matched = (raw.match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase()
    const name = 'avatar' + (EXT_OK.includes(matched) ? matched : '.jpg')
    wx.getFileSystemManager().readFile({
      filePath: raw,
      encoding: 'base64',
      success(res) {
        request.post(api.userAvatar, { name, data: res.data }).then(resolve).catch(reject)
      },
      fail() {
        reject(new Error('读取头像失败，请重试'))
      }
    })
  })
}

// 统一的「选头像 → 上传 → 回填」流程，页面只需要给出上传成功后怎么刷新自己
// onDone(user) 由页面提供；上传中会显示 loading，失败弹 toast
function chooseAndSave(onDone) {
  return (e) => {
    const url = e && e.detail && e.detail.avatarUrl
    if (!url) return
    wx.showLoading({ title: '上传中', mask: true })
    upload(url)
      .then((user) => {
        wx.hideLoading()
        wx.setStorageSync('userInfo', user)
        wx.showToast({ title: '头像已更新', icon: 'success' })
        if (typeof onDone === 'function') onDone(user)
      })
      .catch((err) => {
        wx.hideLoading()
        // request 层已经对接口错误弹过 toast，这里只兜住「读文件失败」这类本地错误
        const msg = (err && err.message) || ''
        if (msg && msg.indexOf('读取头像失败') === 0) {
          wx.showToast({ title: msg, icon: 'none' })
        }
      })
  }
}

module.exports = { upload, chooseAndSave }
