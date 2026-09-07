const api = require('../../utils/api')
const request = require('../../utils/request')
const pay = require('../../utils/pay')

const LAST_KEY = 'last_confirm'

Page({
  data: {
    items: [],
    total: '0.00',
    points: [],
    selectedPoint: null,
    showPicker: false,
    addresses: [],
    selectedAddress: null,
    remark: '',
    contactName: '',
    contactPhone: '',
    submitting: false,
    deliveryMode: 'asap',          // asap=尽快送达；scheduled=指定时间
    asapEta: '',                   // 尽快送达的预计到达时间 HH:MM
    scheduledTime: '',             // 指定时间的显示值
    timeOptions: [],               // 指定时间候选（依据当前真实时间向后递增生成）
    showTimeSheet: false,
    shopClosed: false,
    payMock: false                 // 运行时标注：结算按钮显示「模拟支付」
  },

  async onLoad(options) {
    this.ready = false
    const flags = wx.getStorageSync('runtimeFlags') || {}
    this.setData({ payMock: flags.pay_mock === true })
    const cached = wx.getStorageSync('checkout_items')
    if (options.goods_id) {
      try {
        const g = await request.get(api.goodsDetail + '?id=' + options.goods_id)
        const quantity = Number(options.quantity || 1)
        this.setData({
          items: [{ goods_id: g.id, name: g.name, price: g.price, quantity, total: (g.price * quantity).toFixed(2) }],
          total: (g.price * quantity).toFixed(2)
        })
      } catch (e) { /* handled */ }
    } else if (cached && cached.length) {
      const items = []
      try {
        for (const it of cached) {
          const g = await request.get(api.goodsDetail + '?id=' + it.goods_id)
          items.push({ goods_id: g.id, name: g.name, price: g.price, quantity: it.quantity, total: (g.price * it.quantity).toFixed(2) })
        }
        const total = items.reduce((s, it) => s + Number(it.total), 0)
        this.setData({ items, total: total.toFixed(2) })
      } catch (e) { /* handled */ }
    }
    // 先加载点位与已存收货地址，再回填收餐信息
    await Promise.all([this.loadPoints(), this.loadAddresses()])
    this.loadUser()
    this.loadShopStatus()
    this.buildTimeOptions()
    this.ready = true
  },

  // 读取店铺营业状态：歇业时禁止下单、结算按钮置灰
  async loadShopStatus() {
    try {
      const shop = await request.get(api.shopStatus)
      this.setData({ shopClosed: shop.business_status === 'closed' })
    } catch (e) { /* 默认按营业处理 */ }
  },

  // 从地址管理页新增/编辑返回时刷新地址
  async onShow() {
    if (!this.ready) return
    await this.loadAddresses()
    if (!this.data.selectedAddress) this.applyBestAddress()
  },

  // 回填上次下单记住的点位/姓名/电话/备注（无已存地址时的兜底）
  applyLast() {
    const last = wx.getStorageSync(LAST_KEY)
    if (!last) return
    const patch = {}
    if (last.point && !this.data.selectedPoint) patch.selectedPoint = last.point
    if (last.name) patch.contactName = last.name
    if (last.phone) patch.contactPhone = last.phone
    if (last.remark !== undefined) patch.remark = last.remark
    this.setData(patch)
  },

  // 自动选择默认地址（否则取第一条）；无地址时回填上次下单
  applyBestAddress() {
    const { addresses } = this.data
    const def = addresses.find((a) => a.is_default) || addresses[0]
    if (def) {
      this.applyAddress(def)
    } else {
      this.applyLast()
    }
  },

  // 根据收货地址填充送达点位 + 收餐人
  applyAddress(addr) {
    if (!addr) return
    // 数值比较兜底（历史地址 landmark_id 可能是 "2.0" 文本）
    const point = this.data.points.find((p) => Number(p.id) === Number(addr.landmark_id))
    const patch = {
      selectedAddress: addr,
      contactName: addr.contact_name || '',
      contactPhone: addr.contact_phone || ''
    }
    if (point) patch.selectedPoint = point
    this.setData(patch)
  },

  async loadPoints() {
    try {
      const points = await request.get(api.landmarkList)
      this.setData({ points })
    } catch (e) { /* handled */ }
  },

  async loadAddresses() {
    try {
      const addresses = await request.get(api.addressList)
      this.setData({ addresses })
    } catch (e) { /* handled */ }
  },

  async loadUser() {
    try {
      const user = await request.get(api.getProfile)
      this.setData({ contactName: user.nickname || '', contactPhone: user.phone || '' })
    } catch (e) { /* handled */ }
    this.applyBestAddress()
  },

  showPointPicker() {
    this.setData({ showPicker: true })
  },

  closePicker() {
    this.setData({ showPicker: false })
  },

  noop() {},

  // 选择送达楼栋：仅更换送达点位，收餐人/详细地址仍沿用默认地址信息
  choosePoint(e) {
    this.setData({ selectedPoint: e.currentTarget.dataset.item, showPicker: false })
  },

  openTimeSheet() {
    this.setData({ showTimeSheet: true })
  },

  closeTimeSheet() {
    this.setData({ showTimeSheet: false })
  },

  // 依据当前真实时间向后生成送达时间：默认「尽快送达」（约 30 分钟后），
  // 指定时间从当前时刻起每 30 分钟一档依次递增（不再展示全部时段）
  buildTimeOptions() {
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes())
    const now = new Date()
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0)
    const asap = new Date(base.getTime() + 30 * 60000)
    const options = []
    for (let i = 1; i <= 6; i++) {
      const start = new Date(base.getTime() + i * 30 * 60000)
      const end = new Date(start.getTime() + 20 * 60000)
      options.push({ value: fmt(start) + '-' + fmt(end) })
    }
    this.setData({ deliveryMode: 'asap', asapEta: fmt(asap), scheduledTime: '', timeOptions: options })
  },

  chooseAsap() {
    this.setData({ deliveryMode: 'asap', scheduledTime: '', showTimeSheet: false })
  },

  chooseScheduled(e) {
    const item = e.currentTarget.dataset.item
    this.setData({ deliveryMode: 'scheduled', scheduledTime: item.value, showTimeSheet: false })
  },

  onRemark(e) { this.setData({ remark: e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail }) },
  onName(e) { this.setData({ contactName: e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail }) },
  onPhone(e) { this.setData({ contactPhone: e.detail && typeof e.detail === 'object' ? e.detail.value : e.detail }) },

  async submit() {
    if (this.data.submitting) return   // 重入保护（P0-3 顺带：防重复提交）
    if (this.data.shopClosed) {
      wx.showToast({ title: '店铺歇业中，暂无法下单', icon: 'none' })
      return
    }
    const { items, selectedPoint, remark, contactName, contactPhone, selectedAddress } = this.data
    if (!items.length) return
    // 超出单车容量不再拦截：后端会自动拆分成多个订单分批配送，这里仅提示用户
    const totalQty = items.reduce((s, it) => s + Number(it.quantity || 0), 0)
    if (totalQty > 12) {
      wx.showToast({ title: '您购买的商品较多，将自动拆分为多个订单分批配送', icon: 'none', duration: 2500 })
    }
    if (!selectedPoint) {
      wx.showToast({ title: '请选择送达点位', icon: 'none' })
      return
    }
    if (!contactName) {
      wx.showToast({ title: '请填写收餐人姓名', icon: 'none' })
      return
    }
    if (!/^1\d{10}$/.test(contactPhone)) {
      wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const res = await request.post(api.orderCreate, {
        landmark_id: String(selectedPoint.id),
        landmark_name: selectedPoint.name,
        remark,
        contact_name: contactName,
        contact_phone: contactPhone,
        address_id: selectedAddress ? selectedAddress.id : undefined,
        items: items.map((it) => ({ goods_id: it.goods_id, quantity: it.quantity }))
      })
      wx.removeStorageSync('checkout_items')
      // 记住本次下单选项，并同步到用户信息
      wx.setStorageSync(LAST_KEY, {
        point: selectedPoint,
        name: contactName,
        phone: contactPhone,
        remark
      })
      request.put(api.updateProfile, { nickname: contactName, phone: contactPhone }).catch(() => {})
      // 拆单：后端返回 orders 数组时逐个支付（mock 支付无成本），否则按单订单处理
      const orderIds = res.split ? (res.orders || []).map((o) => o.order_id) : [res.order_id]
      let paid = 0
      for (const oid of orderIds) {
        try {
          await pay.payOrder(oid)
          paid += 1
        } catch (e) { /* 用户取消或支付失败：订单已生成，稍后可支付 */ }
      }
      if (orderIds.length > 1) {
        wx.showToast({ title: '已拆为 ' + orderIds.length + ' 个订单，将分批配送', icon: 'none', duration: 2500 })
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/order/list' })
        }, 700)
      } else {
        wx.showToast({ title: paid ? '支付成功' : '订单已生成，请稍后支付', icon: paid ? 'success' : 'none' })
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.order_id })
        }, 600)
      }
    } catch (e) {
      this.setData({ submitting: false })
    }
  }
})
