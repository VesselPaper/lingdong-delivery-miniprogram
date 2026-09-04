// 组件库 · 统一搜索框（复用 app.wxss 的 .search-row/.search-box/.search-input/.search-ph）
// props: value, placeholder；事件: input(value), confirm(value)
Component({
  properties: {
    value: { type: String, value: '' },
    placeholder: { type: String, value: '搜索' }
  },
  methods: {
    onInput(e) {
      this.triggerEvent('input', e.detail.value)
    },
    onConfirm(e) {
      this.triggerEvent('confirm', e.detail.value)
    }
  }
})
