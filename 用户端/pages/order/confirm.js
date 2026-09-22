const api = require('../../utils/api')
const request = require('../../utils/request')
const pay = require('../../utils/pay')

const LAST_KEY = 'last_confirm'

Page({
  data: {
    items: [],
    total: '0.00',
    subtotal: '0.00',
    promoBanner: null,
    promoReduce: '0.00',
    promoPayable: '0.00',
    promoCandidates: [],     // 可选优惠活动候选 [{id,type,title,desc,reduce,payable,selected}]
    selectedActivityId: null, // 用户选中的活动 id（null=未选/回退最优）
    couponShow: false,       // 优惠选择面板
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
    payMock: false,                // 运行时标注：结算按钮显示「模拟支付」
    deliveryFee: '1.00',           // 配送费（商家端可配置，默认 1 元）
    goodsPayable: '0.00',          // 商品实付（原价合计 - 活动优惠）
    origTotal: '0.00',             // 原价合计 + 配送费（用于划线的「原价」对照）
    payableTotal: '0.00'           // 最终应付 = 商品实付 + 配送费
  },

  async onLoad(options) {
    this.ready = false
    const flags = wx.getStorageSync('runtimeFlags') || {}
    this.setData({ payMock: flags.pay_mock === true })
    const cached = wx.getStorageSync('checkout_items')
    this.checkoutItems = []
    if (options.goods_id) {
      try {
        const g = await request.get(api.goodsDetail + '?id=' + options.goods_id)
        const quantity = Number(options.quantity || 1)
        const priceNow = g.sale_price || g.price
        this.setData({
          items: [{ goods_id: g.id, name: g.name, image: g.image || '', price: g.price, price_now: priceNow, quantity, total: (priceNow * quantity).toFixed(2), orig: (g.price * quantity).toFixed(2) }],
          total: (priceNow * quantity).toFixed(2),
          subtotal: (g.price * quantity).toFixed(2)
        })
        this.checkoutItems = [{ goods_id: g.id, quantity }]
      } catch (e) { /* handled */ }
    } else if (cached && cached.length) {
      const items = []
      this.checkoutItems = cached
      try {
        for (const it of cached) {
          const g = await request.get(api.goodsDetail + '?id=' + it.goods_id)
          const priceNow = g.sale_price || g.price
          items.push({ goods_id: g.id, name: g.name, image: g.image || '', price: g.price, price_now: priceNow, quantity: it.quantity, total: (priceNow * it.quantity).toFixed(2), orig: (g.price * it.quantity).toFixed(2) })
        }
        const total = items.reduce((s, it) => s + Number(it.total), 0)
        const subtotal = items.reduce((s, it) => s + Number(it.orig), 0)
        this.setData({ items, total: total.toFixed(2), subtotal: subtotal.toFixed(2) })
      } catch (e) { /* handled */ }
    }
    // 加载活动并估算优惠金额（仅展示；下单价格以后端权威计算为准）
    await this.loadPromo()
    // 先加载点位与已存收货地址，再回填收餐信息
    await Promise.all([this.loadPoints(), this.loadAddresses()])
    await this.loadUser()
    // 后端记录的「当前配送楼栋」优先级最高：首页顶部与我的页收货地址维护的正是它
    await this.loadCurrentPoint()
    this.loadShopStatus()
    this.buildTimeOptions()
    this.ready = true
  },

  // 活动起止时间 → 优惠面板上的有效期文案（仅当设置了时间窗时展示）
  promoValidText(a) {
    const at = (t) => (t ? new Date(String(t).replace(' ', 'T')).getTime() : NaN)
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (x) => x ? pad(x.getMonth() + 1) + '-' + pad(x.getDate()) : ''
    const s = at(a && a.start_at), e = at(a && a.end_at)
    if (isNaN(s) && isNaN(e)) return ''
    if (!isNaN(s) && !isNaN(e)) {
      const sd = new Date(s), ed = new Date(e)
      return '活动期 ' + fmt(sd) + ' ~ ' + fmt(ed)
    }
    if (!isNaN(e)) return '有效期至 ' + fmt(new Date(e))
    return '活动进行中'
  },

  // 估算优惠：生成可选优惠候选列表 + 自动推荐优惠最大的一个
  async loadPromo() {
    if (!this.data.items || !this.data.items.length) return
    try {
      const list = await request.get(api.activityList)
      const acts = (list || []).filter((a) => a.state === 'active' || !a.state)
      const subtotal = Number(this.data.subtotal || this.data.items.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0))
      // 逐活动计算优惠：满减按档位、折扣按折后差（金额统一取两位小数）
      const round2 = (n) => Math.round((Number(n) + 1e-9) * 100) / 100
      const candidates = []
      for (const a of acts) {
        if (a.type === 'discount' && Number(a.config && a.config.discount) > 0 && Number(a.config.discount) < 1) {
          let est = 0
          const gids = (a.config.goods_ids || []).map(Number)
          for (const it of this.data.items) {
            if (a.config.scope === 'goods' && !gids.includes(Number(it.goods_id))) continue
            est += (Number(it.price) - Number(it.price_now)) * Number(it.quantity)
          }
          const zhe = (Number(a.config.discount) * 10).toFixed(1).replace(/\.0$/, '')
          const r = round2(est)
          if (r > 0) candidates.push({ id: a.id, type: 'discount', title: a.title || '', desc: `商品${zhe}折`, reduce: r, zhe, valid: this.promoValidText(a) })
        } else if (a.type === 'full_reduce') {
          const tiers = (a.config && a.config.tiers || []).filter((t) => Number(t.threshold) > 0)
          let scopeSubtotal = subtotal
          if (a.config && a.config.scope === 'goods') {
            scopeSubtotal = 0
            const gids = (a.config.goods_ids || []).map(Number)
            for (const it of this.data.items) if (gids.includes(Number(it.goods_id))) scopeSubtotal += Number(it.price) * Number(it.quantity)
          }
          let reduce = 0
          for (const t of tiers) if (scopeSubtotal >= Number(t.threshold)) reduce = Math.max(reduce, Number(t.reduce))
          const r = round2(reduce)
          if (r > 0) candidates.push({ id: a.id, type: 'full_reduce', title: a.title || '', desc: tiers.map((t) => '满' + t.threshold + '减' + t.reduce).join(' / '), reduce: r, valid: this.promoValidText(a) })
        }
      }
      // 无任何可用的优惠时：仅标记折扣差异展示
      if (!candidates.length) { this.derivePromo(); return }
      // 按优惠额降序，自动推荐第一个（最大）
      candidates.sort((x, y) => y.reduce - x.reduce)
      const best = candidates[0]
      this.setData({
        // 面额大字：折扣显示「X折」、满减显示「-¥X」；recommend=系统推荐最优；selected=当前选中
        promoCandidates: candidates.map((c) => Object.assign({}, c, {
          reduceTxt: c.reduce.toFixed(2),
          payable: (subtotal - c.reduce).toFixed(2),
          amountText: c.type === 'discount' ? (c.zhe || '') + '折' : '-¥' + c.reduce.toFixed(2),
          selected: c.id === best.id,
          recommend: c.id === best.id
        })),
        selectedActivityId: best.id
      })
      this.pickPromo(best.id, subtotal)
    } catch (e) { /* handled */ }
  },

  // 勾选/取消勾选优惠：点已选中的优惠再点一次 = 取消勾选（回到无优惠）；点其它 = 切换选中
  // 面板不自动关闭，用户可反复勾选/取消，点遮罩或右上角关闭
  chooseCoupon(e) {
    const id = Number(e.currentTarget.dataset.id)
    const subtotal = Number(this.data.subtotal || 0)
    if (this.data.selectedActivityId === id) {
      // 已选中 → 取消勾选，恢复无优惠（recommend 角标一并清除，避免「未使用优惠」时还残留推荐标记）
      this.setData({
        promoCandidates: this.data.promoCandidates.map((c) => Object.assign({}, c, { selected: false, recommend: false })),
        selectedActivityId: null
      })
      this.clearPromo(subtotal)
      return
    }
    this.setData({
      promoCandidates: this.data.promoCandidates.map((c) => Object.assign({}, c, { selected: c.id === id })),
      selectedActivityId: id
    })
    this.pickPromo(id, subtotal)
  },

  showCoupons() { this.setData({ couponShow: true }) },
  hideCoupons() { this.setData({ couponShow: false }) },

  // 根据选中的候选活动算出横幅 / 应付
  pickPromo(id, subtotal) {
    const cand = this.data.promoCandidates.find((c) => c.id === id)
    if (!cand) { this.clearPromo(subtotal); return }
    const banner = {
      icon: cand.type === 'discount' ? 'discount' : 'decrease',
      title: cand.desc,
      sub: cand.type === 'discount' ? `已选：${cand.title || '商品折扣'}` : '满减已生效',
      reduce: cand.reduce.toFixed(2),
      payable: (subtotal - cand.reduce).toFixed(2),
      origin: subtotal.toFixed(2),
      type: cand.type
    }
    this.setData({
      promoBanner: banner,
      promoReduce: banner.reduce,
      promoPayable: banner.payable
    }, () => this.recomputeTotal())
  },

  clearPromo(subtotal) {
    this.setData({ promoBanner: null, promoReduce: '0.00', promoPayable: this.data.total }, () => this.recomputeTotal())
  },

  // 兼容：仅折扣（活动接口无满减命中）时直出折扣横幅
  derivePromo() {
    const subtotal = Number(this.data.subtotal || 0)
    const discountEst = this.data.items.reduce((s, it) => s + (Number(it.price) - Number(it.price_now)) * Number(it.quantity), 0)
    const banner = discountEst > 0
      ? { icon: 'discount', title: '商品折扣优惠', sub: '已按活动价结算', reduce: discountEst.toFixed(2), payable: (subtotal - discountEst).toFixed(2), origin: subtotal.toFixed(2), type: 'discount' }
      : null
    this.setData({
      promoBanner: banner,
      promoReduce: banner ? banner.reduce : '0.00',
      promoPayable: banner ? banner.payable : this.data.total
    }, () => this.recomputeTotal())
  },

  // 读取店铺营业状态 + 配送费：歇业时禁止下单；配送费由商家端配置
  async loadShopStatus() {
    try {
      const shop = await request.get(api.shopStatus)
      const f = Number(shop && shop.delivery_fee)
      this.setData({
        shopClosed: shop.business_status === 'closed',
        deliveryFee: (isNaN(f) || f < 0 ? 1 : f).toFixed(2)
      }, () => this.recomputeTotal())
    } catch (e) { this.recomputeTotal() }
  },

  // 统一重算「商品实付 / 原价对照 / 最终应付」：配送费只在最后加一次，不参与活动折扣
  recomputeTotal() {
    const fee = Number(this.data.deliveryFee || 0)
    const subtotal = Number(this.data.subtotal || 0)
    const goodsPayable = this.data.promoBanner ? Number(this.data.promoBanner.payable) : Number(this.data.total || 0)
    this.setData({
      goodsPayable: goodsPayable.toFixed(2),
      origTotal: (subtotal + fee).toFixed(2),
      payableTotal: (goodsPayable + fee).toFixed(2)
    })
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
      // 送达点位只展示机器人可送达的取餐点（deliverPoint），排除商铺上货点（loadingPoint）
      this.setData({ points: (points || []).filter((p) => p.type === 'deliverPoint') })
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

  // 选择送达楼栋：同时写回后端，让首页顶部与我的页收货地址跟着变
  async choosePoint(e) {
    const point = e.currentTarget.dataset.item
    this.setData({ selectedPoint: point, showPicker: false })
    try {
      await request.put(api.userPoint, { landmark_id: String(point.id) })
    } catch (err) { /* 网络异常不阻塞本单，后端仍会按提交的 landmark_id 校验 */ }
  },

  // 读取后端记录的当前楼栋（与首页/我的页共用），覆盖地址簿推断出来的点位
  async loadCurrentPoint() {
    try {
      const p = await request.get(api.userPoint)
      if (!p || !p.landmark_id) return
      const hit = this.data.points.find((x) => Number(x.id) === Number(p.landmark_id))
      if (hit) this.setData({ selectedPoint: hit })
    } catch (e) { /* handled */ }
  },

  openTimeSheet() {
    this.setData({ showTimeSheet: true })
  },

  closeTimeSheet() {
    this.setData({ showTimeSheet: false })
  },

  // 依据当前真实时间向后生成送达时间：默认「尽快送达」（约 30 分钟后），
  // 指定时间从当前时刻起每 30 分钟一档依次递增；只保留落在配送时段 08:00-20:00 内的档位
  buildTimeOptions() {
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes())
    const now = new Date()
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0)
    const asap = new Date(base.getTime() + 30 * 60000)
    const OPEN = 8 * 60      // 08:00
    const CLOSE = 20 * 60    // 20:00
    const inWindow = (d) => { const m = d.getHours() * 60 + d.getMinutes(); return m >= OPEN && m <= CLOSE }
    const options = []
    for (let i = 1; i <= 6; i++) {
      const start = new Date(base.getTime() + i * 30 * 60000)
      const end = new Date(start.getTime() + 20 * 60000)
      if (!inWindow(start) || !inWindow(end)) continue
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
        // 0 = 不使用优惠；null（无候选）也按 0 处理，后端不再自动套用活动
        activity_id: this.data.selectedActivityId || 0,
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
