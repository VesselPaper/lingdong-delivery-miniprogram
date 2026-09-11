const api = require('../../utils/api')
const request = require('../../utils/request')
const pay = require('../../utils/pay')

// 下单时间展示（后端为本地时间 YYYY-MM-DD HH:MM:SS，去掉秒即可，避免时区解析差异）
function formatTime(t) {
  if (!t) return ''
  const s = String(t)
  return s.length >= 16 ? s.slice(0, 16) : s
}

// 订单状态 → 状态文字颜色 class（不同状态不同颜色，便于辨认）
const ST_CLASS = { 0: 'orange', 1: 'orange', 2: 'blue', 3: 'green', 4: 'gray', 5: 'gray', 6: 'red', 7: 'gray' }

// 排序：进行中（待支付/待接单/配送中/已送达）在前，已完结（已完成/取消/异常/退款）在后；
// 组内按下单时间早的在前
function sortOrders(list) {
  const ts = (o) => {
    const t = new Date(String(o.created_at || '').replace(' ', 'T')).getTime()
    return isNaN(t) ? 0 : t
  }
  return [...list].sort((a, b) => {
    const ga = Number(a.status) <= 3 ? 0 : 1
    const gb = Number(b.status) <= 3 ? 0 : 1
    if (ga !== gb) return ga - gb
    return ts(a) - ts(b)
  })
}

Page({
  data: {
    active: '',
    orders: []
  },

  onShow() {
    const tab = wx.getStorageSync('order_tab')
    if (tab !== '' && tab !== undefined && tab !== null) {
      wx.removeStorageSync('order_tab')
      this.setData({ active: String(tab) })
    }
    this.loadOrders()
    this.markRead()
  },

  // 进入订单列表视为已读订单动态（清除我的页红点）
  markRead() {
    request.post(api.orderMarkRead, {}, { silent: true }).catch(() => {})
  },

  onTab(e) {
    this.setData({ active: e.currentTarget.dataset.name })
    this.loadOrders()
  },

  async loadOrders() {
    try {
      const qs = this.data.active !== '' ? '?status=' + this.data.active : ''
      const list = sortOrders(await request.get(api.orderList + qs))
      const orders = await this.decorate(list)
      this.setData({ orders })
    } catch (e) { /* handled */ }
  },

  async decorate(list) {
    const out = []
    for (const o of list) {
      const detail = await request.get(api.orderDetail + '?id=' + o.id)
      const itemCount = detail.items.reduce((s, it) => s + it.quantity, 0)
      const first = detail.items[0] || {}
      out.push(Object.assign({}, o, {
        stClass: ST_CLASS[Number(o.status)] || 'gray',
        item_count: itemCount,
        first_name: first.goods_name || '',
        first_qty: first.quantity || 0,
        first_image: first.goods_image || '',
        // 下单时间（YYYY-MM-DD HH:mm，去掉秒）
        created_time: formatTime(o.created_at),
        // 取餐超时/正在取餐提示：已送达(3)未取时覆盖默认「已送达」文案
        status_text: (Number(o.status) === 3 && !detail.picked_up_at)
          ? (detail.picking_up_at ? '正在取餐'
            : Number(detail.pickup_timeout_stage) === 1 ? '取餐超时·稍后返回'
            : Number(detail.pickup_timeout_stage) === 2 ? '即将取消'
            : o.status_text)
          : o.status_text,
        // 取消相关标记（详情接口返回）：免费窗口内可直取消 / 超时须提交申请 / 已有待处理申请
        direct_cancelable: !!detail.direct_cancelable,
        request_cancelable: !!detail.request_cancelable,
        cancel_req_pending: !!(detail.cancel_request && Number(detail.cancel_request.status) === 0)
      }))
    }
    return out
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/order/detail?id=' + e.currentTarget.dataset.id })
  },

  async payOrder(e) {
    const order = this.data.orders.find((o) => o.id === Number(e.currentTarget.dataset.id))
    const id = order ? order.id : Number(e.currentTarget.dataset.id)
    try {
      await pay.payOrder(id)
      wx.showToast({ title: '支付成功', icon: 'success' })
      this.loadOrders()
    } catch (err) {
      if (err.message && err.message !== 'cancel') wx.showToast({ title: err.message, icon: 'none' })
    }
  },

  async cancelOrder(e) {
    const order = this.data.orders.find((o) => o.id === Number(e.currentTarget.dataset.id))
    // 超时未配送：直接引导提交取消申请
    if (order && order.request_cancelable && !order.direct_cancelable) {
      wx.navigateTo({ url: '/pages/order/cancelRequest?order_id=' + order.id })
      return
    }
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确定取消该订单？',
        confirmColor: '#3078C0',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!res) return
    try {
      await request.post(api.orderCancel, { id: Number(e.currentTarget.dataset.id) })
      wx.showToast({ title: '已取消', icon: 'success' })
      this.loadOrders()
    } catch (err) {
      if (err && err.message && err.message.indexOf('取消申请') > -1) {
        wx.navigateTo({ url: '/pages/order/cancelRequest?order_id=' + Number(e.currentTarget.dataset.id) })
      }
    }
  },

  goCancelRequest(e) {
    wx.navigateTo({ url: '/pages/order/cancelRequest?order_id=' + Number(e.currentTarget.dataset.id) })
  }
})
