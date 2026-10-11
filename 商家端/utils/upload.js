// 图片上传：微信 chooseMedia/chooseImage 拿到的是本地临时路径，读成 base64 后
// POST /merchant/upload（后端存盘并返回可访问路径）。
// 抽成公共方法的原因：活动海报与商品图将来都要走同一条路，避免两处各写一份 base64 读文件逻辑。
const api = require('./api')
const request = require('./request')

// 返回 Promise<string>：成功给图片地址（/uploads/xxx.jpg）
function uploadImage(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: async (res) => {
        try {
          const m = String(filePath).match(/\.(\w+)$/)
          const ext = (m ? m[1] : 'jpg').toLowerCase()
          const data = await request.post(api.upload, { name: 'act_' + Date.now() + '.' + ext, data: res.data })
          const url = (data && (data.url || data.path)) || ''
          if (!url) return reject(new Error('上传成功但未返回图片地址'))
          resolve(url)
        } catch (e) { reject(e) }
      },
      fail: () => reject(new Error('读取图片失败'))
    })
  })
}

// 拍照 / 从相册选一张（优先用新版 chooseMedia，旧基础库回退 chooseImage）
function pickImage() {
  return new Promise((resolve, reject) => {
    const done = (p) => (p ? resolve(p) : reject(new Error('未选择图片')))
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        success: (r) => done(r.tempFiles && r.tempFiles[0] && r.tempFiles[0].tempFilePath),
        fail: () => reject(new Error('未选择图片'))
      })
      return
    }
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      success: (r) => done(r.tempFilePaths && r.tempFilePaths[0]),
      fail: () => reject(new Error('未选择图片'))
    })
  })
}

module.exports = { uploadImage, pickImage }
