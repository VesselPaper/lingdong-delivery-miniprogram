// 商家端实时推送客户端（微信小程序 WebSocket，配合后端 services/push.js）
// 用法：
//   const push = require('../../utils/push')
//   onLoad(){ this._onPush=(msg)=>{ if(msg.type==='order_created'){ this.load(); this.loadPendingCount() } }; push.subscribe(this._onPush) }
//   onUnload(){ push.unsubscribe(this._onPush) }
// 收到推送事件 → 页面自己调接口重拉 → 局部刷新（不整页重载）。
// 连接在首次 subscribe 时建立；断线指数退避自动重连；token 放在握手 header（沿用登录 token）。

const config = require('./config')

let task = null            // SocketTask
let closedByUser = false   // 主动销毁后不再重连
let reconnectTimer = null
let reconnectMs = 1500
const listeners = new Set()

function wsUrl() {
  let u = config.baseUrl || ''
  // http/https → ws/wss，去掉 /api 前缀，拼 /ws
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  u = u.replace(/\/api\/?$/, '')
  return (u || 'ws://127.0.0.1:3000') + '/ws'
}

function connect() {
  if (task || closedByUser) return
  if (!wx || !wx.connectSocket) return
  const token = wx.getStorageSync('token')
  let sock
  try {
    sock = wx.connectSocket({
      url: wsUrl(),
      header: token ? { Authorization: 'Bearer ' + token } : {}
    })
  } catch (e) { scheduleReconnect(); return }
  task = sock
  sock.onOpen(() => { reconnectMs = 1500 })
  sock.onMessage((e) => {
    if (!e || !e.data) return
    try { const msg = JSON.parse(e.data); emit(msg) } catch (err) { /* 非 JSON 忽略 */ }
  })
  sock.onClose(() => { task = null; scheduleReconnect() })
  sock.onError(() => { /* onClose 会触发重连 */ })
}

function scheduleReconnect() {
  if (closedByUser) return
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => { task = null; connect() }, reconnectMs)
  reconnectMs = Math.min(reconnectMs * 1.5, 15000)
}

function emit(msg) {
  for (const cb of [...listeners]) { try { cb(msg) } catch (e) { /* 单页处理异常不影响其它 */ } }
}

// 订阅推送；返回取消函数（也可用 unsubscribe）
function subscribe(cb) {
  if (typeof cb === 'function' && !listeners.has(cb)) { listeners.add(cb); connect() }
  return () => { listeners.delete(cb) }
}
function unsubscribe(cb) { listeners.delete(cb) }

// 显式断开并清空（登出/退出小程序时调用）
function destroy() {
  closedByUser = true
  clearTimeout(reconnectTimer)
  if (task) { try { if (task.close) task.close() } catch (e) {} }
  task = null
  listeners.clear()
}

module.exports = { subscribe, unsubscribe, destroy, connect, wsUrl }