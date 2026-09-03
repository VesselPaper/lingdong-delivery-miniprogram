Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/user/profile', text: '我的', icon: 'user' }
    ]
  },

  methods: {
    onTap(e) {
      const path = e.currentTarget.dataset.path
      if (path) {
        wx.switchTab({ url: path })
      }
    },

    updateSelected() {
      const pages = getCurrentPages()
      const current = pages[pages.length - 1]
      if (!current) return
      const route = '/' + current.route
      const idx = this.data.list.findIndex((i) => i.pagePath === route)
      if (idx !== -1 && idx !== this.data.selected) {
        this.setData({ selected: idx })
      }
    }
  },

  lifetimes: {
    attached() {
      this.updateSelected()
    }
  },

  pageLifetimes: {
    show() {
      this.updateSelected()
    }
  }
})
