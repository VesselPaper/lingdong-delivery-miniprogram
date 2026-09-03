// 接口定义（商家端）
const api = {
  login: '/auth/login',
  stats: '/merchant/stats',
  shop: '/merchant/shop',
  orders: '/merchant/orders',
  orderDetail: '/merchant/order/detail',
  orderConfirm: '/merchant/order/confirm',
  deliveryTestComplete: '/merchant/delivery/test-complete',
  goods: '/merchant/goods',
  goodsUpdate: '/merchant/goods',
  goodsStatus: '/merchant/goods/status',
  upload: '/merchant/upload',
  deliveryMonitor: '/merchant/delivery/monitor',
  robots: '/merchant/robots',
  activities: '/merchant/activities',
  activityStatus: '/merchant/activities/status',
  deviceScan: '/merchant/device/scan',
  devicePending: '/merchant/device/pending',
  deviceOpenBin: '/merchant/device/open-bin',
  deviceCloseBin: '/merchant/device/close-bin',
  deviceDispatch: '/merchant/device/dispatch',
  refunds: '/merchant/refunds',
  refundDetail: '/merchant/refund/detail',
  refundHandle: '/merchant/refund/handle'
}

module.exports = api
