// 支付封装：微信支付 JSAPI（后端统一下单返回参数，前端拉起收银台）
const api = require('./api')
const request = require('./request')

// 支付成功后轮询订单状态，等待支付回调把订单置为已收款（status>0）
// 真实链路：微信支付回调 /api/pay/notify 更新订单状态，前端轮询确认结果
function pollPaid(orderId, tries) {
  const max = tries || 10
  return new Promise((resolve) => {
    const check = (n) => {
      if (n <= 0) return resolve(false)
      request.get(api.orderDetail + '?id=' + orderId)
        .then((d) => {
          if (Number(d.status) > 0) return resolve(true)
          setTimeout(() => check(n - 1), 800)
        })
        .catch(() => setTimeout(() => check(n - 1), 800))
    }
    check(max)
  })
}

// 拉起微信支付并返回是否已确认收款
function payOrder(orderId) {
  return request.post(api.orderPay, { id: Number(orderId) })
    .then((res) => {
      const params = res && res.payParams
      if (!params) return Promise.reject(new Error('支付参数缺失'))
      return new Promise((resolve, reject) => {
        wx.requestPayment({
          timeStamp: params.timeStamp,
          nonceStr: params.nonceStr,
          package: params.package,
          signType: params.signType || 'RSA',
          paySign: params.paySign,
          success: () => {
            // 收银台回调成功：轮询订单确认已收款（支付回调可能稍后到达）
            pollPaid(orderId).then(() => resolve())
          },
          fail: (err) => {
            const msg = (err && err.errMsg) || ''
            reject(new Error(msg.indexOf('cancel') > -1 ? 'cancel' : '支付未完成'))
          }
        })
      })
    })
}

module.exports = { payOrder }
