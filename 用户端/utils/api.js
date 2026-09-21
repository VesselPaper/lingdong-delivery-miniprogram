// 接口定义（用户端）
// 所有接口指向自建后端，由后端对接开放物流平台。

const api = {
  // 用户
  login: '/auth/login',
  getProfile: '/user/profile',
  updateProfile: '/user/profile',
  // 头像上传：微信 chooseAvatar 的本地临时图读成 base64 后 POST，后端存盘并写入 users.avatar
  userAvatar: '/user/avatar',

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
  cancelRequest: '/order/cancel-request',
  cancelRequestList: '/order/cancel-request/list',
  // 我的页订单红点（未读动态）
  orderBadge: '/user/order/badge',
  orderMarkRead: '/user/order/mark-read',

  // 配送
  deliveryTrack: '/delivery/track',
  deliveryConfirm: '/delivery/confirm',
  pickupScan: '/delivery/pickup-scan',
  pickupByCode: '/delivery/pickup-by-code',
  pickupByScan: '/delivery/pickup-by-scan',
  pickupOpen: '/delivery/pickup-open',
  pickupClose: '/delivery/pickup-close',
  pickupCloseAll: '/delivery/pickup-close-all',

  // 活动
  activityList: '/activity/list',

  // 地址
  addressList: '/address/list',
  addressSave: '/address/save',
  addressDelete: '/address/delete',

  // 当前配送楼栋：首页顶部「选择楼栋」/ 我的页「收货地址」/ 结算页「送达楼栋」
  // 三处读写的是同一份后端数据，任一处修改另外两处都会同步
  userPoint: '/user/point',

  // 售后（退款/投诉）
  refundApply: '/refund/apply',
  refundList: '/refund/list',

  // 点位
  landmarkList: '/landmarks',
  // 店铺状态（公开，歇业判断）
  shopStatus: '/shop/status'
}

module.exports = api
