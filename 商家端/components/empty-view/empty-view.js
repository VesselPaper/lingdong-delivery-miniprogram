// 组件库 · 空态（复用 app.wxss 的 .empty）
// props: show, text, icon
Component({
  properties: {
    show: { type: Boolean, value: true },
    text: { type: String, value: '暂无数据' },
    icon: { type: String, value: 'app' }
  }
})
