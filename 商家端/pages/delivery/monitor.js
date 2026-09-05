const api = require('../../utils/api')
const request = require('../../utils/request')

// 配送监控：真实校园地图（平台 mapInfo）+ 点位/路网 + 机器人实时位置 + 配送路线，
// 下方按「批次」分组展示配送中批次卡面（批次内嵌套多单）。
const ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }
const BATCH_TAG = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }

Page({
  data: {
    robots: [],
    robotsError: '',
    batches: [],
    map: null,
    mapError: '',
    mapLoading: true,
    mapWidth: 0,
    mapHeight: 0
  },
  winWidth: 375,

  onShow() {
    const info = wx.getSystemInfoSync()
    this.winWidth = info.windowWidth
    this.load()
    this.timer = setInterval(() => this.load(), 5000)
  },

  onHide() {
    if (this.timer) clearInterval(this.timer)
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
  },

  async load() {
    this.loadRobots()
    this.loadMap()
    try {
      const data = await request.get(api.devicePending, {}, { silent: true })
      this.setData({
        batches: (data.active_batches || []).map((b) => this.decorate(b))
      })
    } catch (e) { /* 静默 */ }
  },

  decorate(b) {
    return Object.assign({}, b, {
      statusTagClass: BATCH_TAG[Number(b.status)] || 'tag-blue',
      orders: (b.orders || []).map((o) => {
        if (o.picked_up) return Object.assign({}, o, { stClass: 'green', displayStatus: '已取' })
        const st = Number(o.status)
        let cls = ST_CLASS[st] || 'gray'
        let ds = o.status_text || ''
        if (st === 2) { cls = 'blue'; ds = '配送中' }
        else if (st === 3) { cls = 'green'; ds = '待取货' }
        else if (st === 6) { cls = 'red'; ds = '配送异常' }
        return Object.assign({}, o, { stClass: cls, displayStatus: ds })
      })
    })
  },

  // ---------- 真实地图 ----------
  async loadMap() {
    try {
      const map = await request.get(api.map, {}, { silent: true })
      this.setData({ map, mapError: '', mapLoading: false })
      this.layoutMap()
    } catch (e) {
      this.setData({ map: null, mapError: (e && e.message) || '获取地图失败', mapLoading: false })
    }
  },

  // 按 bbox 纵横比设置容器尺寸（px），随后绘制
  layoutMap() {
    const map = this.data.map
    if (!map || !map.bbox) return
    const w = this.winWidth - 48 * this.winWidth / 750 // 容器宽（左右各 24rpx 外边距）
    let aspect = (map.bbox.maxY - map.bbox.minY) / (map.bbox.maxX - map.bbox.minX)
    aspect = Math.max(0.45, Math.min(1.6, aspect))
    const h = Math.max(240, Math.min(560, w * aspect))
    this.setData({ mapWidth: Math.round(w), mapHeight: Math.round(h) }, () => this.drawMap())
  },

  drawMap() {
    if (!this.data.map || !this.data.mapWidth) return
    const map = this.data.map
    const bbox = map.bbox
    wx.createSelectorQuery().in(this).select('#mapCanvas').fields({ node: true, size: true }).exec((res) => {
      const f = res && res[0]
      if (!f || !f.node) return
      const canvas = f.node
      const W = Math.round(f.width || this.data.mapWidth)
      const H = Math.round(f.height || this.data.mapHeight)
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, W, H)
      const toXY = (x, y) => [
        (x - bbox.minX) / (bbox.maxX - bbox.minX) * W,
        (bbox.maxY - y) / (bbox.maxY - bbox.minY) * H
      ]
      // 路网（固定路径 graph）
      const nodes = map.graph.nodes || []
      ctx.strokeStyle = '#E1E7F0'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ;(map.graph.edges || []).forEach(([a, b]) => {
        const na = nodes.find((n) => n.id === a)
        const nb = nodes.find((n) => n.id === b)
        if (!na || !nb) return
        const [ax, ay] = toXY(na.x, na.y)
        const [bx, by] = toXY(nb.x, nb.y)
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
      })
      ctx.stroke()
      // 配送路线（活跃批次折线 + 停靠顺序标记）
      ;(map.routes || []).forEach((rt) => {
        if (!rt.stops || !rt.stops.length) return
        ctx.strokeStyle = '#3078C0'
        ctx.lineWidth = 3
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        rt.stops.forEach((s, i) => {
          const [x, y] = toXY(s.x, s.y)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()
        ctx.globalAlpha = 1
        rt.stops.forEach((s) => {
          const [x, y] = toXY(s.x, s.y)
          ctx.beginPath()
          ctx.fillStyle = '#FFFFFF'
          ctx.arc(x, y, 6, 0, 2 * Math.PI)
          ctx.fill()
          ctx.strokeStyle = '#3078C0'
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.fillStyle = '#3078C0'
          ctx.font = 'bold 10px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(s.stop), x, y + 0.5)
        })
      })
      // 点位（绿=配送点 / 橙=上货点）
      ;(map.landmarks || []).forEach((lm) => {
        const [x, y] = toXY(lm.x, lm.y)
        ctx.beginPath()
        ctx.fillStyle = lm.type === 'loadingPoint' ? '#F5A623' : '#2BA471'
        ctx.arc(x, y, 4.5, 0, 2 * Math.PI)
        ctx.fill()
        ctx.fillStyle = '#333333'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(lm.name, x, y - 6)
      })
      // 机器人实时位置（蓝色圆 + 朝向短线）
      ;(map.robots || []).forEach((rb) => {
        const [x, y] = toXY(rb.x, rb.y)
        ctx.beginPath()
        ctx.fillStyle = '#3078C0'
        ctx.arc(x, y, 8, 0, 2 * Math.PI)
        ctx.fill()
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2
        ctx.stroke()
        const rad = Number(rb.theta || 0)
        ctx.beginPath()
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2
        ctx.moveTo(x, y)
        ctx.lineTo(x + Math.cos(rad) * 14, y - Math.sin(rad) * 14)
        ctx.stroke()
        ctx.fillStyle = '#3078C0'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(rb.device_sn, x, y + 10)
      })
    })
  },

  retryRobots() {
    this.loadRobots()
  },

  async loadRobots() {
    try {
      const robots = await request.get(api.robots, {}, { silent: true })
      this.setData({ robots, robotsError: '' })
    } catch (e) {
      this.setData({ robots: [], robotsError: (e && e.message) || '获取机器人失败' })
    }
  },

  // 批次卡面内点某单 → 进订单详情
  goDetailByOrder(e) {
    const o = e.detail || {}
    if (o && o.id) wx.navigateTo({ url: '/pages/orders/detail?id=' + o.id })
  }
})
