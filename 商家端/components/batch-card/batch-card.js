// 组件库 · 批次卡（一车多单：一个批次一个卡面，内部嵌套多个订单，订单内逐商品展示）
// 用于：上货配单页 / 配送中监控 / 任务页按批次分组（配送中/待取货/待上货）
// props:
//   b            批次对象（getBatchDetail 结构；订单需预置 stClass 与 displayStatus）
//   showNo       是否显示完整批次编号（单批次详情弱化展示）
//   showProgress 是否显示「已取 X / N 单」进度
//   showGoods    是否显示订单内商品明细行
//   action       '' | 'select'(选择该批次上货) | 'dispatch'(派车配送)
//   selectText   select 按钮文案（默认「选择该批次上货」）
// events: select(b) / dispatch(b) / ordertap(order) / cardtap(b)
//   整卡点击（cardtap）：上货配单页用来「点卡面看批次详情」；订单子卡与按钮用 catchtap 阻止冒泡，不会误触发
Component({
  properties: {
    b: { type: Object, value: {} },
    showNo: { type: Boolean, value: false },
    showProgress: { type: Boolean, value: false },
    showGoods: { type: Boolean, value: false },
    orderTap: { type: Boolean, value: false },
    action: { type: String, value: '' },
    selectText: { type: String, value: '选择该批次上货' }
  },
  methods: {
    onCardTap() {
      this.triggerEvent('cardtap', this.data.b)
    },
    onSelect() {
      this.triggerEvent('select', this.data.b)
    },
    onDispatch() {
      this.triggerEvent('dispatch', this.data.b)
    },
    onOrderTap(e) {
      const o = e.currentTarget.dataset.o
      if (o) this.triggerEvent('ordertap', o)
    }
  }
})
