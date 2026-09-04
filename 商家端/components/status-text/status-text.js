// 组件库 · 状态文字（按状态色板着色，复用 app.wxss 的 .st-*）
// props: cls(st-orange/st-blue/st-green/st-red/st-gray), text
Component({
  properties: {
    cls: { type: String, value: 'gray' },
    text: { type: String, value: '' }
  }
})
