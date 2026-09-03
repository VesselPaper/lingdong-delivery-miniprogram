Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/goods/list', text: '商城', icon: 'cart' },
      { pagePath: '/pages/activity/index', text: '活动', icon: 'activity' },
      { pagePath: '/pages/user/profile', text: '我的', icon: 'robot-1' }
    ]
  },
  methods: {
    switchTab(e) {
      const idx = Number(e.currentTarget.dataset.index)
      wx.switchTab({ url: this.data.list[idx].pagePath })
    }
  }
})
