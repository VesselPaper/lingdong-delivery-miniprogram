const api = require('../../utils/api')
const request = require('../../utils/request')
const avatar = require('../../utils/avatar')

// 用户端登录（2026-10-11 起两条路，都指向同一张 users 表）：
//   1) 微信一键登录（默认，生产用）：wx.login 的 code 换 openid，用户不需要账号；
//      2026-10-12 起登录页带「微信资料」：头像点一下=微信头像、昵称框点一下=微信昵称，
//      随 code 一起发给后端建档（新用户默认微信名/头像；老用户只补默认值，不覆盖自设昵称头像）。
//   2) 账号密码登录（联调/演示用）：账号由管理员网页「商家管理」创建，或由后端首次启动自举生成
//      （见 backend/services/bootstrap.js）。加它的原因：成员本机没配 WX_APPID/WX_SECRET 时
//      只有"模拟登录"，且必须先能连上后端；有账号密码后不依赖微信凭据也能进。
Page({
  data: {
    logging: false,
    loginDemo: false,   // 运行时标注：后端未配用户端微信凭据时按钮显示「模拟登录（演示）」
    username: '',
    password: '',
    showAccount: false,  // 账号密码表单默认收起；后端处于 demo 登录时自动展开（见 onShow）
    wechatNickname: '',  // 微信昵称（type=nickname，点一下即微信昵称）
    avatarPath: '',      // 选中的微信头像临时路径（预览用）
    avatarName: '',      // 头像文件名（带扩展名）
    avatarData: ''       // 头像 base64（登录时随微信资料建档）
  },

  onShow() {
    const flags = wx.getStorageSync('runtimeFlags') || {}
    // 演示环境（后端没配微信凭据）自动展开账号密码表单：此时它是唯一"像真登录"的入口
    const expand = flags.login === 'demo' && !this.accountToggled
    this.setData({ loginDemo: flags.login === 'demo', showAccount: expand || this.data.showAccount })

    // 单点登录：被"别处登录"踢下线的原因由 utils/request.js 写进 login_notice。
    // 用弹窗而不是 toast —— 会话失效时页面是被重新拉起来的，弹窗才留得住。
    const notice = wx.getStorageSync('login_notice')
    if (notice) {
      try { wx.removeStorageSync('login_notice') } catch (e) { /* 忽略 */ }
      wx.showModal({
        title: '登录已失效',
        content: String(notice),
        showCancel: false,
        confirmText: '重新登录'
      })
    }
  },

  toggleAccount() {
    this.accountToggled = true
    this.setData({ showAccount: !this.data.showAccount })
  },

  onUsernameInput(e) { this.setData({ username: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },

  // ---------- 微信资料（默认取微信昵称/头像） ----------
  // chooseAvatar：微信弹出的选择器默认就是用户当前微信头像，点一下即带出。
  // 这里只读成 base64 暂存，登录请求里随 code 一起建档；不单独走 /user/avatar（未登录没有 token）。
  async onChooseAvatar(e) {
    const url = e && e.detail && e.detail.avatarUrl
    if (!url) return
    this.setData({ avatarPath: url })
    try {
      const { name, data } = await avatar.readBase64(url)
      this.setData({ avatarName: name, avatarData: data })
    } catch (err) {
      wx.showToast({ title: '读取头像失败，可稍后重试', icon: 'none' })
    }
  },

  onNicknameInput(e) { this.setData({ wechatNickname: e.detail.value }) },
  onNicknameBlur(e) { this.setData({ wechatNickname: e.detail.value }) },

  // 登录成功后的统一后续动作（两条登录路径共用）
  afterLogin(res) {
    wx.setStorageSync('token', res.token)
    wx.setStorageSync('userInfo', res.user)
    wx.setStorageSync('runtimeFlags', res.runtime || {})
    wx.showToast({ title: '登录成功', icon: 'success' })
    setTimeout(() => {
      // 扫码直达场景：登录前在 scanPickup 页暂存了待校验设备号（pending_pickup_sn），
      // 登录成功后回跳取餐页继续校验（不丢扫码上下文）；否则回首页。
      const sn = wx.getStorageSync('pending_pickup_sn')
      if (sn) {
        wx.removeStorageSync('pending_pickup_sn')
        wx.reLaunch({ url: '/pages/delivery/scanPickup?sn=' + encodeURIComponent(sn), fail: () => undefined })
        return
      }
      // 登录成功后回到首页，不再强制切到“我的”（否则入口总落在“我的”）
      wx.switchTab({ url: '/pages/index/index', fail: () => undefined })
    }, 500)
  },

  async wechatLogin() {
    if (this.data.logging) return
    this.setData({ logging: true })
    wx.showLoading({ title: '登录中' })
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject })
      })
      // client 标明用户端：后端用它选「零栋GO」的 appid/secret 走真实 code2session
      // 带上微信资料（昵称/头像 base64）：新用户建档默认微信名/头像；老用户只补默认值不覆盖自设。
      const res = await request.post(api.login, {
        code, client: 'user',
        nickname: this.data.wechatNickname,
        avatarName: this.data.avatarName,
        avatarData: this.data.avatarData
      }, { needAuth: false }) // 登录接口免鉴权
      this.afterLogin(res)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '登录失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ logging: false })
      wx.hideLoading()
    }
  },

  // 账号密码登录：后端 client 仍传 user（与商家端同一套 scrypt 校验，只是不要求商家角色）
  async accountLogin() {
    if (this.data.logging) return
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    this.setData({ logging: true })
    wx.showLoading({ title: '登录中' })
    try {
      const res = await request.post(api.login, { username, password, client: 'user' }, { needAuth: false })
      this.afterLogin(res)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '登录失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ logging: false })
      wx.hideLoading()
    }
  }
})
