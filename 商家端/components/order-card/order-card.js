// 组件库 · 订单卡（扁平订单，带商品摘要；用于任务页待接单/异常等）
// props: order（含 daily_seq/stClass/displayStatus/first_image/first_name/first_qty/item_count/
//                 landmark_name/batch/created_time/total_amount/status/payed）
// events: tap（整卡点击进详情）；插槽放置 CTA 操作按钮
Component({
  properties: {
    order: { type: Object, value: {} }
  },
  methods: {
    onTap() {
      this.triggerEvent('tap', this.data.order)
    }
  }
})
