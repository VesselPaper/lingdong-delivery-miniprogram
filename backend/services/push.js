// services/push.js —— 极简 WebSocket 推送服务（供商家端/用户端实时刷新，无第三方依赖）
// 无需引入 ws 包：用 Node 内置 http.Server 的 upgrade 事件 + RFC6455 握手/帧编码自实现。
// 场景：用户下单支付成功 → backend 写入订单 → push.broadcast({type:'order_created',...})
//       → 前端收到推送事件 → 自动重拉列表/红点，局部更新，不整页重载。
//
// 只做「服务端 → 客户端」单向广播：客户端无需发送业务数据。读取侧仅需处理
// ping(9)/pong/close(8) 帧保持连接健康，业务帧(文本/二进制)直接忽略。
// 连接鉴权：upgrade 时校验 Authorization: Bearer <token>（沿用登录 token），未通过即断连。
// 安全审计 2026-09-26 H2：validateToken 可返回角色 'admin' / 'user'（或 truthy 任意值=普通用户），
// 主题订阅按角色过滤 —— 'admin/live' 只允许管理员订阅，杜绝学生/店员 token 偷看机器人实时数据。

const crypto = require('crypto')
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const clients = new Set() // 每个元素：{ socket }

// 资源上限：手写 WS 必须自己设闸，否则单连接即可顶爆单进程内存。
// 实测（未加限制时）：一个声明 1TB 帧长的连接持续推数据，进程 RSS 涨到 356MB 且不被拒绝，
// 直到 Buffer.concat 触顶 OOM —— 而该进程同时承担派车调度与平台回调接收，OOM 等于全站停摆。
const MAX_FRAME_BYTES = 64 * 1024        // 单帧上限（业务只收订阅帧，几十字节足够）
const MAX_BUFFER_BYTES = 256 * 1024      // 单连接接收缓冲上限
const MAX_CLIENTS = 200                  // 并发连接上限
const IDLE_TIMEOUT_MS = 10 * 60 * 1000   // 空闲连接回收（客户端掉网无 FIN 时避免永久驻留；客户端会自动重连）

// 单帧编码（server→client 不掩码）：opcode 0x1 文本
function encodeFrame(payload, opcode) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))
  const len = buf.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, buf])
}

function sendFrame(socket, payload, opcode) {
  if (!socket || socket.destroyed) return false
  try { socket.write(encodeFrame(payload, opcode)); return true } catch (e) { return false }
}

function attach(server, opts) {
  const validateToken = (opts && opts.validateToken) || (() => true)
  server.on('upgrade', (req, socket) => {
    try {
      if (!socket || !req) return
      const url = req.url || ''
      // 只接受 /ws 路径
      if (!/^\/ws(\?|$)/.test(url)) { socket.destroy(); return }
      // 并发上限：防止连接数无上限堆积
      if (clients.size >= MAX_CLIENTS) { socket.destroy(); return }
      const key = req.headers['sec-websocket-key']
      if (!key) { socket.destroy(); return }
      // 鉴权：Authorization: Bearer <token>（小程序端），或 Sec-WebSocket-Protocol 子协议
      // 'bearer-<token>'（浏览器 WebSocket 无法自定义 header，管理员页用子协议携带）。
      // 安全审计 L7：不再支持 query ?token=（会话凭据会进入访问日志/浏览器历史/代理层）。
      let token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      let viaProtocol = false
      if (!token) {
        const proto = String(req.headers['sec-websocket-protocol'] || '')
        const pm = proto.match(/bearer-([A-Za-z0-9]+)/i)
        if (pm) { token = pm[1]; viaProtocol = true }
      }
      const v = validateToken(token)
      if (!v) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      // 角色：'admin'=管理员（可订阅管理主题），其余任何有效 token=普通登录用户
      const role = v === 'admin' ? 'admin' : 'user'
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
      // 子协议来源的 token 必须在握手响应中回显同一子协议，否则浏览器拒绝连接
      const respProto = viaProtocol ? '\r\nSec-WebSocket-Protocol: bearer-' + token : ''
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + respProto + '\r\n\r\n'
      )
      socket.setNoDelay(true)
      const client = { socket, topics: new Set(), role }
      clients.add(client)

      let buffer = Buffer.alloc(0)
      const cleanup = () => { clients.delete(client); if (!socket.destroyed) { try { socket.destroy() } catch (e) {} } }
      // 空闲回收：半开连接（客户端掉网无 FIN）不会自己消失，会永久占住 socket 与 clients 条目
      socket.setTimeout(IDLE_TIMEOUT_MS, cleanup)
      const onData = (chunk) => {
        // 单连接缓冲上限：不设限时客户端可声明超大帧长并持续发送，直到 Buffer.concat 把内存顶爆
        if (buffer.length + chunk.length > MAX_BUFFER_BYTES) { cleanup(); return }
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          if (buffer.length < 2) return
          const b0 = buffer[0]
          const b1 = buffer[1]
          const opcode = b0 & 0x0f
          const masked = !!(b1 & 0x80)
          let len = b1 & 0x7f
          let offset = 2
          let maskKey = null
          if (len === 126) {
            if (buffer.length < 4) return
            len = buffer.readUInt16BE(2); offset = 4
          } else if (len === 127) {
            if (buffer.length < 10) return
            len = Number(buffer.readBigUInt64BE(2)); offset = 10
          }
          // 单帧上限：业务帧只可能是几十字节的订阅消息，超限直接断开
          if (len > MAX_FRAME_BYTES) { cleanup(); return }
          if (masked) { if (buffer.length < offset + 4) return; maskKey = buffer.slice(offset, offset + 4); offset += 4 }
          if (buffer.length < offset + len) return // 等待完整帧
          let frame = buffer.slice(offset, offset + len)
          // 客户端→服务端帧必须掩码：用 4 字节 maskKey 对负载逐字节 XOR 解掩码，否则 JSON 解析失败
          if (maskKey) {
            const f = Buffer.alloc(frame.length)
            for (let i = 0; i < frame.length; i++) f[i] = frame[i] ^ maskKey[i % 4]
            frame = f
          }
          buffer = buffer.slice(offset + len)
          if (opcode === 0x8) { // close
            cleanup(); return
          } else if (opcode === 0x9) { // ping → pong
            sendFrame(socket, frame, 0xA)
          } else if (opcode === 0x1) { // 文本帧：可选主题订阅 {type:'sub',topics:[...]}
            try {
              const msg = JSON.parse(frame.toString('utf8'))
              if (msg && msg.type === 'sub' && Array.isArray(msg.topics)) {
                // 安全审计 H2：管理主题（admin/live）仅管理员可订阅，其余主题登录即可
                const allowed = msg.topics.map(String).filter((t) => {
                  if (t === 'admin/live') return client.role === 'admin'
                  return true
                })
                client.topics = new Set(allowed)
              }
            } catch (e) { /* 非订阅帧忽略 */ }
          } // 其余（二进制/续帧）忽略：我们是只推送端
        }
      }
      socket.on('data', onData)
      socket.on('close', cleanup)
      socket.on('error', cleanup)
      socket.on('end', cleanup)
    } catch (e) { /* 升级异常安全忽略 */ try { socket.destroy() } catch (e2) {} }
  })
}

// 向所有已连接客户端广播（可多次调用；无客户端连接则为 no-op）
function broadcast(payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload || {})
  let n = 0
  for (const c of clients) { if (sendFrame(c.socket, msg, 0x1)) n++ }
  return n
}

function connectionCount() { return clients.size }

// 按主题精准广播：仅发给订阅了该主题的客户端（如管理员实时地图只推到 admin/live，
// 不会把高频位置刷给商家端/用户端）。无订阅者时为 no-op。
function broadcastTopic(topic, payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload || {})
  let n = 0
  for (const c of clients) {
    if (c.topics && c.topics.has(String(topic))) { if (sendFrame(c.socket, msg, 0x1)) n++ }
  }
  return n
}

// 订阅某主题的客户端数量（供后台实时泵判断「要不要费力抓取位置/做变更检测」）
function topicCount(topic) {
  let n = 0
  for (const c of clients) { if (c.topics && c.topics.has(String(topic))) n++ }
  return n
}

module.exports = { attach, broadcast, broadcastTopic, topicCount, connectionCount }