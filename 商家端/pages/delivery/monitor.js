const api = require('../../utils/api')
const request = require('../../utils/request')

// 配送监控：真实校园地图（平台 mapInfo）+ 点位/路网 + 机器人实时位置 + 配送路线，
// 下方按「批次」分组展示配送中批次卡面（批次内嵌套多单）。
const ST_CLASS = { 1: 'orange', 2: 'blue', 3: 'green', 4: 'green', 5: 'gray', 6: 'red', 7: 'gray' }
const BATCH_TAG = { 0: 'tag-gray', 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-green', 4: 'tag-red' }

// 地图配色（与用户端追踪页点位观感一致）
const COLOR_ROAD = '#E1E7F0'
const COLOR_ROUTE = '#3078C0'
const COLOR_DELIVER = '#2BA471'
const COLOR_LOADING = '#F5A623'
const COLOR_ROBOT = '#3078C0'
const COLOR_LABEL = '#334155'
const COLOR_LABEL_LOADING = '#B45309'

Page({
  data: {
    robots: [],
    robotsError: '',
    batches: [],
    map: null,
    mapError: '',
    mapLoading: true,
    mapWidth: 0,
    mapHeight: 0,
    mapCounts: { deliver: 0, loading: 0, robots: 0 },
    mapUpdatedAt: ''
  },
  winWidth: 375,
  mapSig: '',

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

  nowText() {
    const d = new Date()
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  },

  // ---------- 真实地图 ----------
  async loadMap(force) {
    try {
      const map = await request.get(api.map, {}, { silent: true })
      const lms = map.landmarks || []
      const loading = lms.filter((l) => l.type === 'loadingPoint').length
      this.setData({
        mapError: '',
        mapLoading: false,
        mapCounts: { deliver: lms.length - loading, loading, robots: (map.robots || []).length },
        mapUpdatedAt: this.nowText()
      })
      const sig = this.mapSignature(map)
      if (force || sig !== this.mapSig) {
        this.mapSig = sig
        this.setData({ map }, () => this.layoutMap())
      } else {
        // 底图/路网/点位/路线都没变：只回填无人车位置。
        // 整张路网（graph 节点可能上百个）每 5 秒 setData 一遍会明显卡顿，底图也没必要重画。
        this.setData({ 'map.robots': map.robots || [] }, () => this.drawMap())
      }
    } catch (e) {
      this.mapSig = ''
      this.setData({ map: null, mapError: (e && e.message) || '获取地图失败', mapLoading: false })
    }
  },

  // 地图静态结构签名：只有它变了才整块重绘
  mapSignature(map) {
    const g = map.graph || {}
    const lms = map.landmarks || []
    const rts = (map.routes || [])
      .map((r) => r.batch_id + ':' + (r.stops || []).map((s) => s.stop).join('-'))
      .join(',')
    return [map.map_url, (g.nodes || []).length, (g.edges || []).length, lms.length, rts].join('|')
  },

  refreshMap() {
    this.loadMap(true)
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
    const map = this.data.map
    if (!map || !map.bbox || !this.data.mapWidth) return
    const bbox = map.bbox
    wx.createSelectorQuery().in(this).select('#mapCanvas').fields({ node: true, size: true }).exec((res) => {
      const f = res && res[0]
      if (!f || !f.node) return
      const canvas = f.node
      const W = Math.round(f.width || this.data.mapWidth)
      const H = Math.round(f.height || this.data.mapHeight)
      if (!W || !H) return
      // 高清屏按 DPR 放大画布后备存储（CSS 尺寸不变）：否则文字与线条会被拉伸发糊
      const dpr = wx.getSystemInfoSync().pixelRatio || 2
      // 每次重建后备存储：赋值 width 会顺带重置变换，避免重复绘制时 scale 叠加
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr) // 之后一律用 CSS px 作绘图单位
      ctx.clearRect(0, 0, W, H)

      const spanX = (bbox.maxX - bbox.minX) || 1
      const spanY = (bbox.maxY - bbox.minY) || 1
      const toXY = (x, y) => [
        (x - bbox.minX) / spanX * W,
        (bbox.maxY - y) / spanY * H
      ]

      // ---------- 文字避让 ----------
      // 点位密集时若每个点都无条件写名字，文字必然叠在一起。
      // 维护两份占位：标记（圆点/序号圈/车标）与文字，分开判断 ——
      //   第一轮：既不压标记、也不压文字（最干净）；
      //   第二轮兜底：只保证不压文字（车号、上货点是商家必须看到的，宁可压在小圆点上也不能丢）。
      // 候选位置按 上→下→右→左→四个斜角 × 近/远两档 依次尝试；
      // 优先级由调用顺序决定：无人车 > 上货点 > 配送点。
      const markerBoxes = []
      const textBoxes = []
      const reserve = (x, y, r) => markerBoxes.push({ l: x - r, r: x + r, t: y - r, b: y + r })
      const hits = (list, b) => list.some((p) => !(b.r < p.l || b.l > p.r || b.b < p.t || b.t > p.b))
      const boxAt = (cx, cy, tw, lh) => ({ l: cx - tw / 2 - 3, r: cx + tw / 2 + 3, t: cy - lh / 2 - 2, b: cy + lh / 2 + 2 })
      const inCanvas = (b) => b.l >= 1 && b.r <= W - 1 && b.t >= 1 && b.b <= H - 1
      const drawLabel = (text, x, y, opt) => {
        const o = opt || {}
        const lh = o.lh || 12
        const gap = o.gap === undefined ? 8 : o.gap
        ctx.font = o.font || '11px sans-serif'
        const tw = ctx.measureText(text).width
        // 8 个方向 × 近/远两档 = 16 个候选位：点位贴边时近档会越界，远档还能补上
        const dirs = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]]
        const spots = []
        ;[1, 2].forEach((mul) => {
          const g = gap * mul
          dirs.forEach((d) => spots.push([x + d[0] * (g + tw / 2), y + d[1] * (g + lh / 2)]))
        })
        for (let round = 0; round < 2; round++) {
          for (let i = 0; i < spots.length; i++) {
            const cx = spots[i][0]
            const cy = spots[i][1]
            const box = boxAt(cx, cy, tw, lh)
            if (!inCanvas(box)) continue
            if (hits(textBoxes, box)) continue
            if (round === 0 && hits(markerBoxes, box)) continue
            textBoxes.push(box)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            // 白描边打底：底图花纹复杂时纯色文字同样看不清
            ctx.lineWidth = 3
            ctx.strokeStyle = 'rgba(255,255,255,0.95)'
            ctx.strokeText(text, cx, cy)
            ctx.fillStyle = o.color || COLOR_LABEL
            ctx.fillText(text, cx, cy)
            return true
          }
        }
        return false
      }
      // 白圈 + 实心点：底图是校园平面图，纯色点容易糊进背景
      const marker = (x, y, r, color) => {
        ctx.beginPath()
        ctx.arc(x, y, r + 2, 0, 2 * Math.PI)
        ctx.fillStyle = '#FFFFFF'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(x, y, r, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
      }

      // ---------- 路网（固定路径 graph） ----------
      const nodeMap = {}
      const gNodes = (map.graph && map.graph.nodes) || []
      gNodes.forEach((n) => { nodeMap[n.id] = n })
      ctx.strokeStyle = COLOR_ROAD
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ;((map.graph && map.graph.edges) || []).forEach((e) => {
        const na = nodeMap[e[0]]
        const nb = nodeMap[e[1]]
        if (!na || !nb) return
        const p1 = toXY(na.x, na.y)
        const p2 = toXY(nb.x, nb.y)
        ctx.moveTo(p1[0], p1[1])
        ctx.lineTo(p2[0], p2[1])
      })
      ctx.stroke()

      // ---------- 配送路线（活跃批次折线 + 停靠序号） ----------
      ;(map.routes || []).forEach((rt) => {
        const stops = rt.stops || []
        if (!stops.length) return
        ctx.strokeStyle = COLOR_ROUTE
        ctx.lineWidth = 3
        ctx.lineJoin = 'round'
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        stops.forEach((s, i) => {
          const p = toXY(s.x, s.y)
          if (i === 0) ctx.moveTo(p[0], p[1])
          else ctx.lineTo(p[0], p[1])
        })
        ctx.stroke()
        ctx.globalAlpha = 1
        stops.forEach((s) => {
          const p = toXY(s.x, s.y)
          ctx.beginPath()
          ctx.arc(p[0], p[1], 9, 0, 2 * Math.PI)
          ctx.fillStyle = '#FFFFFF'
          ctx.fill()
          ctx.strokeStyle = COLOR_ROUTE
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.fillStyle = COLOR_ROUTE
          ctx.font = 'bold 10px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(s.stop), p[0], p[1] + 0.5)
          reserve(p[0], p[1], 11) // 序号圈占位，名字不会压在圈上
          // 序号本身也是文字：登记到文字占位，后面的点位名绝不会压上去
          textBoxes.push(boxAt(p[0], p[1], ctx.measureText(String(s.stop)).width, 11))
        })
      })

      // ---------- 点位（绿=配送点 / 橙=上货点） ----------
      const lms = map.landmarks || []
      lms.forEach((lm) => {
        const p = toXY(lm.x, lm.y)
        marker(p[0], p[1], 4.5, lm.type === 'loadingPoint' ? COLOR_LOADING : COLOR_DELIVER)
        reserve(p[0], p[1], 5)
      })

      // ---------- 无人车实时位置（蓝圆 + 朝向短线） ----------
      const cars = []
      ;(map.robots || []).forEach((rb) => {
        const p = toXY(rb.x, rb.y)
        const x = p[0]
        const y = p[1]
        marker(x, y, 8, COLOR_ROBOT)
        const rad = Number(rb.theta || 0)
        ctx.beginPath()
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2.5
        ctx.moveTo(x, y)
        ctx.lineTo(x + Math.cos(rad) * 15, y - Math.sin(rad) * 15)
        ctx.stroke()
        reserve(x, y, 13)
        // 只显示 SN 尾号：整串 R110A2603AUEQC00 太长，横铺在图上必然压住别的文字
        cars.push({ x, y, text: String(rb.device_sn || '').slice(-6) })
      })

      // ---------- 标签（按优先级：无人车 > 上货点 > 配送点） ----------
      cars.forEach((c) => drawLabel(c.text, c.x, c.y, { font: 'bold 10px sans-serif', color: COLOR_ROBOT, lh: 11 }))
      lms.filter((l) => l.type === 'loadingPoint').forEach((lm) => {
        const p = toXY(lm.x, lm.y)
        drawLabel(lm.name || '', p[0], p[1], { color: COLOR_LABEL_LOADING })
      })
      lms.filter((l) => l.type !== 'loadingPoint').forEach((lm) => {
        const p = toXY(lm.x, lm.y)
        drawLabel(lm.name || '', p[0], p[1], { color: COLOR_LABEL })
      })
    })
  },

  retryRobots() {
    this.loadRobots()
  },

  async loadRobots() {
    try {
      const robots = await request.get(api.robots, {}, { silent: true })
      this.setData({ robots: (robots || []).map((r) => this.decorateRobot(r)), robotsError: '' })
    } catch (e) {
      this.setData({ robots: [], robotsError: (e && e.message) || '获取机器人失败' })
    }
  },

  // 电量/状态补一份展示用派生值（模板里不能写复杂表达式）
  decorateRobot(r) {
    const b = (r.battery === null || r.battery === undefined) ? null : Number(r.battery)
    const st = String(r.machine_status || '')
    return Object.assign({}, r, {
      batteryPct: b === null ? 0 : Math.max(0, Math.min(100, b)),
      batteryText: b === null ? '—' : b + '%',
      batteryClass: b === null ? 'none' : (b < 20 ? 'low' : (b < 50 ? 'mid' : 'ok')),
      statusClass: !r.online ? 'off'
        : (st === 'exception' ? 'bad'
          : ((st === 'charging' || st === 'returnChargingPile') ? 'charging' : 'ok'))
    })
  },

  // 批次卡面内点某单 → 进订单详情
  goDetailByOrder(e) {
    const o = e.detail || {}
    if (o && o.id) wx.navigateTo({ url: '/pages/orders/detail?id=' + o.id })
  },

  // 点批次卡面 → 进批次详情页（进度 + 订单商品 + 配送状态说明）
  goBatchDetail(e) {
    const b = e.detail || {}
    if (b && b.id) wx.navigateTo({ url: '/pages/device/batchDetail?id=' + b.id })
  },

  // 本车二维码 → 打印贴车（商家配单上货 / 用户扫码取餐共用此码）
  goRobotQr(e) {
    const sn = (e.currentTarget.dataset && e.currentTarget.dataset.sn) || ''
    if (!sn) return
    wx.navigateTo({ url: '/pages/device/robotQr?sn=' + encodeURIComponent(sn) })
  }
})
