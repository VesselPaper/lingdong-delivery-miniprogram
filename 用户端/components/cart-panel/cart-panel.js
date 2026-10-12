// 已加购商品面板（美团式底部弹层）
// 交互：在商城/首页点购物车栏 → 从底部滑出；下滑（拖把手）或点遮罩收起、继续挑商品；
//       点「去结算」才进入结算页。
// 做成组件的原因：商城页与首页各有一个购物车栏，逻辑写两份迟早不一致。
const api = require('../../utils/api')
const request = require('../../utils/request')

Component({
  properties: {
    visible: { type: Boolean, value: false }
  },

  data: {
    items: [],
    total: '0.00',
    saveTotal: '0.00',
    deliveryFee: '1.00',
    selectCount: 0,
    allSelected: false,
    dragY: 0,        // 拖动位移（向下为正）
    dragging: false,
    sheetHeight: 0   // 面板高度（px），由商品数算出：scroll-view 必须有确定高度才能滚动
  },

  observers: {
    visible(v) {
      if (v) {
        // 先按现有商品数给个高度：数据回来前若高度为 0，面板会「打不开」
        this.setData({
          dragY: 0,
          dragging: false,
          sheetHeight: this.computeSheetHeight(this.data.items.length)
        })
        this.loadCart()
        this.loadShopStatus()
      } else {
        this.setData({ dragY: 0, dragging: false })
      }
    }
  },

  methods: {
    async loadShopStatus() {
      try {
        const shop = await request.get(api.shopStatus, {}, { needAuth: false })
        const f = Number(shop && shop.delivery_fee)
        this.setData({ deliveryFee: (isNaN(f) || f < 0 ? 1 : f).toFixed(2) })
      } catch (e) { /* handled */ }
    },

    async loadCart() {
      try {
        const items = await request.get(api.cartList)
        this.applyItems(items)
      } catch (e) { /* handled */ }
    },

    // 金额与展示字段的唯一计算入口（与购物车页同一套口径，避免两个入口算出两个数）
    applyItems(rawItems) {
      const valid = (rawItems || [])
        .filter((it) => it.goods_status === 1)
        .map((it) => {
          const price = Number(it.price || 0)
          const now = Number(it.price_now !== undefined && it.price_now !== null ? it.price_now : it.price)
          return Object.assign({}, it, {
            sold_out: Number(it.goods_stock) <= 0,
            has_promo: now < price
          })
        })
      const chosen = valid.filter((it) => it.selected)
      const total = chosen.reduce((s, it) => s + Number(it.price_now) * Number(it.quantity || 0), 0)
      const origTotal = chosen.reduce((s, it) => s + Number(it.price) * Number(it.quantity || 0), 0)
      this.setData({
        items: valid,
        total: total.toFixed(2),
        saveTotal: Math.max(0, origTotal - total).toFixed(2),
        selectCount: chosen.length,
        allSelected: valid.length > 0 && valid.every((it) => it.selected),
        sheetHeight: this.computeSheetHeight(valid.length)
      })
      // 通知页面刷新底部购物车栏的角标与金额
      this.triggerEvent('changed')
    },

    // 面板高度：商品少时贴合内容，多时封顶屏幕 70%。
    // 必须给确定高度 —— scroll-view 放在只设了 max-height 的 flex 容器里拿不到高度，
    // 列表会塌成 0、只露出把手和标题（这正是「只有底下一点、看不到商品」的原因）。
    computeSheetHeight(count) {
      let screenH = 667
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        screenH = (info && info.windowHeight) || 667
      } catch (e) { /* 用默认值兜底 */ }
      const maxH = Math.round(screenH * 0.7)
      const itemH = 66      // 单个商品行高度（px）
      const chrome = 235    // 把手 + 优惠条 + 标题 + 费用行 + 底部栏（含安全区余量）
      const want = count * itemH + chrome
      return Math.max(240, Math.min(want, maxH))
    },

    // ---------- 关闭 ----------
    onClose() {
      this.triggerEvent('close')
    },

    // 把手拖动：向下拖到一定距离松手即收起（美团式下滑关闭）
    onDragStart(e) {
      this._startY = e.touches[0].clientY
      this.setData({ dragging: true })
    },

    onDragMove(e) {
      if (this._startY === undefined) return
      const dy = e.touches[0].clientY - this._startY
      // 只允许向下拖（向上不放大面板）
      this.setData({ dragY: dy > 0 ? dy : 0 })
    },

    onDragEnd() {
      const dy = this.data.dragY
      this.setData({ dragging: false })
      if (dy > 80) {
        this.setData({ dragY: 0 })
        this.triggerEvent('close')
      } else {
        this.setData({ dragY: 0 })
      }
      this._startY = undefined
    },

    // ---------- 商品操作 ----------
    async toggleSelect(e) {
      const id = Number(e.currentTarget.dataset.id)
      const it = this.data.items.find((x) => x.id === id)
      if (!it) return
      const next = it.selected ? 0 : 1
      const snapshot = this.data.items
      this.applyItems(snapshot.map((x) => (x.id === id ? Object.assign({}, x, { selected: next }) : x)))
      try {
        await request.put(api.cartUpdate, { id, selected: next })
      } catch (err) {
        this.applyItems(snapshot)
      }
    },

    async toggleAll() {
      const target = this.data.allSelected ? 0 : 1
      const snapshot = this.data.items
      this.applyItems(snapshot.map((x) => Object.assign({}, x, { selected: target })))
      try {
        for (const it of snapshot) {
          await request.put(api.cartUpdate, { id: it.id, selected: target })
        }
      } catch (err) {
        this.applyItems(snapshot)
      }
    },

    async onQuantity(e) {
      const { id, delta } = e.currentTarget.dataset
      const rowId = Number(id)
      const it = this.data.items.find((x) => x.id === rowId)
      if (!it) return
      if (Number(delta) > 0 && it.sold_out) {
        wx.showToast({ title: '「' + it.name + '」已售罄', icon: 'none' })
        return
      }
      const next = Number(it.quantity) + Number(delta)
      const snapshot = this.data.items

      if (next < 1) {
        this.applyItems(snapshot.filter((x) => x.id !== rowId))
        try {
          await request.del(api.cartRemove, { id: rowId })
        } catch (err) {
          this.applyItems(snapshot)
        }
        return
      }

      this.applyItems(snapshot.map((x) => (x.id === rowId ? Object.assign({}, x, { quantity: next }) : x)))
      try {
        await request.put(api.cartUpdate, { id: rowId, quantity: next })
      } catch (err) {
        this.applyItems(snapshot)
      }
    },

    async clearAll() {
      const ok = await new Promise((resolve) => {
        wx.showModal({
          title: '清空已加购商品？',
          content: '将移除全部商品，不可撤销。',
          confirmColor: '#E64340',
          success: (r) => resolve(r.confirm)
        })
      })
      if (!ok) return
      const snapshot = this.data.items
      this.applyItems([])
      try {
        for (const it of snapshot) {
          await request.del(api.cartRemove, { id: it.id })
        }
        wx.showToast({ title: '已清空', icon: 'success' })
      } catch (err) {
        this.applyItems(snapshot)
      }
    },

    // 去结算：把勾选商品交给页面（由页面写 storage 并跳转，组件不负责导航）
    onCheckout() {
      const selected = this.data.items.filter((it) => it.selected)
      if (!selected.length) {
        wx.showToast({ title: '请先选择商品', icon: 'none' })
        return
      }
      const soldOut = selected.find((it) => it.sold_out)
      if (soldOut) {
        wx.showToast({ title: '「' + soldOut.name + '」已售罄，请先移除', icon: 'none' })
        return
      }
      this.triggerEvent('checkout', {
        items: selected.map((it) => ({ goods_id: it.goods_id, quantity: it.quantity }))
      })
    },

    // 查看完整购物车页（面板底部次要入口）
    onOpenCartPage() {
      this.triggerEvent('close')
      wx.navigateTo({ url: '/pages/cart/cart' })
    }
  }
})
