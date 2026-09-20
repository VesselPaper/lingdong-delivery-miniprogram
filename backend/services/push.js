// services/push.js —— 极简 WebSocket 推送服务（供商家端/用户端实时刷新，无第三方依赖）
// 无需引入 ws 包：用 Node 内置 http.Server 的 upgrade 事件 + RFC6455 握手/帧编码自实现。
// 场景：用户下单支付成功 → backend 写入订单 → push.broadcast({type:'order_created',...})
//       → 前端收到推送事件 → 自动重拉列表/红点，局部更新，不整页重载。
//
// 只做「服务端 → 客户端」单向广播：客户端无需发送业务数据。读取侧仅需处理
// ping(9)/pong/close(8) 帧保持连接健康，业务帧(文本/二进制)直接忽略。
// 连接鉴权：upgrade 时校验 Authorization: Bearer <token>（沿用登录 token），未通过即断连。

const crypto = require('crypto')
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const clients = new Set() // 每个元素：{ socket }

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
      const key = req.headers['sec-websocket-key']
      if (!key) { socket.destroy(); return }
      // 鉴权：Bearer token（兼容 query ?token=，便于排查）
      let token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      if (!token && url.includes('token=')) {
        const m = url.match(/[?&]token=([^&]+)/)
        if (m) token = decodeURIComponent(m[1])
      }
      if (!validateToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      )
      socket.setNoDelay(true)
      const client = { socket, topics: new Set() }
      clients.add(client)

      let buffer = Buffer.alloc(0)
      const cleanup = () => { clients.delete(client); if (!socket.destroyed) { try { socket.destroy() } catch (e) {} } }
      const onData = (chunk) => {
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
                client.topics = new Set(msg.topics.map(String))
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