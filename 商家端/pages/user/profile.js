const role = require('../../utils/role')
const shopState = require('../../utils/shopState')

Page({
  data: {
    isOwner: false,
    shopName: '',   // 多店铺一期：店名由 /merchant/shop 下发，不再写死「零栋铺子」
    shopSub: ''
  },

  async onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    this.setData({ isOwner: role.isOwner() })
    // 缓存里先取一次（秒显），再拉后端最新（换店后立刻正确）
    this.setData({ shopName: shopState.getShopName() })
    await shopState.loadShop()
    this.setData({ shopName: shopState.getShopName(), shopSub: shopState.getCategory() })
  },

  notOpen() {
    wx.showToast({ title: '消息接收已关注', icon: 'none' })
  },

  showAgreement() {
    wx.showModal({
      title: '零栋用户协议',
      content: '欢迎使用零栋商家。本平台由零栋科技提供，商家入驻即视为同意本协议相关内容。',
      showCancel: false,
      confirmColor: '#3078C0'
    })
  },

  showPrivacy() {
    wx.showModal({
      title: '零栋隐私声明',
      content: '我们仅收集为完成配送所必需的信息（定位、联系方式、订单内容），并严格保护您的隐私安全。',
      showCancel: false,
      confirmColor: '#3078C0'
    })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/shop/settings' })
  }
})
