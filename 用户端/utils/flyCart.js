// 加购飞入动画（首页 / 商城共用，保证两处手感完全一致）
//
// 一次点击给三层反馈：轻震动 → 小球从点到的「+」沿弧线飞进购物车图标 → 购物车图标弹跳 + 角标跳动。
//
// 小球用两层 view 实现弧线：外层走 X（linear）、内层走 Y（ease-in）。两条时间曲线不同，
// 合成出来的路径就是一条「先横向甩出去、再加速下坠」的弧线；比在 @keyframes 里塞动态值
// （CSS 变量 / calc）兼容性稳得多，也不需要逐帧 setData。
//
// 用法（页面）：
//   const flyCart = require('../../utils/flyCart')
//   onPlus(e) {
//     flyCart.flyAfter(this, e, () => this.applyCartDelta(id, +1))   // afterRender 里做乐观更新
//     this.syncCart(id, +1)                                          // 再真正发请求
//   }

const DURATION = 520        // 必须与 app.wxss 里 .fly-x / .fly-y 的 transition 时长一致
const TARGET_SEL = '#cart-bar-icon'

// tap 事件取触点：changedTouches → touches → detail，都拿不到就返回 null
function tapPoint(e) {
  const ev = e || {}
  const t = (ev.changedTouches && ev.changedTouches[0]) || (ev.touches && ev.touches[0]) || null
  if (t && typeof t.clientX === 'number' && typeof t.clientY === 'number') {
    return { x: t.clientX, y: t.clientY }
  }
  const d = ev.detail || {}
  if (typeof d.x === 'number' && typeof d.y === 'number') return { x: d.x, y: d.y }
  return null
}

// 轻震动：部分机型与开发者工具不支持，失败不能影响加购本身
function vibrate() {
  try {
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  } catch (e) { /* 忽略 */ }
}

// 购物车图标弹跳 + 角标跳动。
// 两组类名交替使用：连点时如果类名不变，CSS 动画不会重新播放，交替命名可以让每一次点击都有反馈。
function bounce(page) {
  if (!page) return
  page._bounceFlip = !page._bounceFlip
  const a = page._bounceFlip
  page.setData({
    cartBounceCls: a ? 'bounce-a' : 'bounce-b',
    cartBadgeCls: a ? 'badge-pop-a' : 'badge-pop-b'
  })
  clearTimeout(page._bounceTimer)
  page._bounceTimer = setTimeout(() => {
    page.setData({ cartBounceCls: '', cartBadgeCls: '' })
  }, DURATION + 60)
}

// 量购物车图标的落点后放飞小球
function launch(page, from) {
  if (!page || !from) return
  page.createSelectorQuery()
    .select(TARGET_SEL)
    .boundingClientRect((rect) => {
      // 购物车条还没渲染出来（例如首次加购时数据还没更新）→ 只保留震动，不硬飞到一个不存在的点
      if (!rect) return
      const dx = rect.left + rect.width / 2 - from.x
      const dy = rect.top + rect.height / 2 - from.y
      page.setData({ flyBall: { show: true, x: from.x, y: from.y, dx, dy, move: false } })
      clearTimeout(page._flyTimer)
      // 先以起点渲染一帧，再位移，CSS transition 才会真正跑起来（同一帧内改两次不会触发过渡）
      setTimeout(() => page.setData({ 'flyBall.move': true }), 20)
      page._flyTimer = setTimeout(() => {
        page.setData({ 'flyBall.show': false })
        bounce(page)
      }, 20 + DURATION)
    })
    .exec()
}

// 点「+」的统一入口。
// afterRender：页面在这里做乐观更新（本地先 +1，让数字和动画同时变），购物车条也会因此渲染出来，
// 所以落点要等视图更新之后再量。
function flyAfter(page, e, afterRender) {
  const from = tapPoint(e)
  vibrate()
  if (typeof afterRender === 'function') afterRender()
  if (!from) return
  wx.nextTick(() => launch(page, from))
}

// 页面 onUnload 时调用，避免定时器在页面销毁后还去 setData
function clear(page) {
  if (!page) return
  clearTimeout(page._flyTimer)
  clearTimeout(page._bounceTimer)
}

module.exports = { flyAfter, bounce, clear, DURATION }
