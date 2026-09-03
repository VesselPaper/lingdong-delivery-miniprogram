// 接口定义（用户端）
// 所有接口指向自建后端，由后端对接开放物流平台。

const api = {
  // 用户
  login: '/auth/login',
  getProfile: '/user/profile',
  updateProfile: '/user/profile',

  // 商品
  goodsCategories: '/goods/categories',
  goodsList: '/goods/list',
  goodsDetail: '/goods/detail',

  // 购物车
  cartList: '/cart/list',
  cartAdd: '/cart/add',
  cartUpdate: '/cart/update',
  cartRemove: '/cart/remove',

  // 订单
  orderCreate: '/order/create',
  orderPay: '/order/pay',
  orderList: '/order/list',
  orderDetail: '/order/detail',
  orderCancel: '/order/cancel',

  // 配送
  deliveryTrack: '/delivery/track',
  deliveryConfirm: '/delivery/confirm',
  pickupScan: '/delivery/pickup-scan',
  pickupOpen: '/delivery/pickup-open',
  pickupClose: '/delivery/pickup-close',

  // 活动
  activityList: '/activity/list',

  // 地址
  addressList: '/address/list',
  addressSave: '/address/save',
  addressDelete: '/address/delete',

  // 售后（退款/投诉）
  refundApply: '/refund/apply',
  refundList: '/refund/list',

  // 点位
  landmarkList: '/landmarks'
}

module.exports = api
