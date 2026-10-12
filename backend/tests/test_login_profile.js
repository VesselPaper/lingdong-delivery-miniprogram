// 微信登录「默认取微信昵称/头像」测试（Mock 模式 + 临时库 + 独立端口）
// 用法：node test_login_profile.js
//
// 覆盖（2026-10-12 负责人要求：用户名/头像默认 = 微信名/微信头像）：
//   ① 新用户带 nickname+avatar 登录 → 建档即微信名 + 头像已落盘（/uploads/avatar_*）
//   ② 老用户再登录不带资料 → 昵称/头像保持
//   ③ 老用户自设过昵称 → 登录带微信名也不覆盖（自设优先）
//   ④ 默认占位「微信用户」→ 下次登录带微信名时被替换成微信名
//   ⑤ 空头像 base64 → 不建档、不报错
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const PORT = 3107
const TMP_DB = path.join(os.tmpdir(), 'lingdong_login_' + Date.now() + '.db')
const BASE = 'http://127.0.0.1:' + PORT + '/api'
// 1x1 透明 PNG 的 base64
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let child = null
let db = null

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        RUN_MODE: 'demo', PORT: String(PORT), PLATFORM_MOCK: 'true', LINGDONG_DB: TMP_DB,
        PAY_MOCK: 'true', WX_APPID: '', WX_SECRET: '', MERCHANT_WX_APPID: '', MERCHANT_WX_SECRET: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    const t0 = Date.now()
    const timer = setInterval(async () => {
      try {
        const r = await fetch(BASE + '/shop/status')
        if (r.ok) { clearInterval(timer); resolve() }
      } catch (e) { /* not up yet */ }
      if (Date.now() - t0 > 15000) { clearInterval(timer); reject(new Error('server start timeout\n' + log)) }
    }, 300)
  })
}

async function api(method, pathname, body, token) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return res.json().catch(() => ({}))
}

let bad = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✘ ' + msg); bad++ } else { console.log('  ✔ ' + msg) }
}

;(async () => {
  try {
    await startServer()
    console.log('[1] server up (mock, port ' + PORT + ')')
    db = new DatabaseSync(TMP_DB)
    const login = (code, extra) => api('POST', '/auth/login', Object.assign({ code, client: 'user' }, extra || {}))

    // ---------- ① 新用户带微信资料 → 建档即微信名 + 头像落盘 ----------
    const r1 = await login('code-a-1', { nickname: '张三', avatarName: 'avatar.png', avatarData: PNG_B64 })
    assert(r1.code === 0 && r1.data.user.nickname === '张三', '新用户昵称 = 微信名「张三」')
    const u1 = db.prepare("SELECT * FROM users WHERE nickname='张三'").get()
    assert(!!u1 && String(u1.avatar || '').indexOf('/uploads/avatar_' + u1.id + '_') === 0, '新用户头像已写入 /uploads/avatar_*')
    const avFile = path.join(__dirname, '..', 'uploads', String(u1.avatar).replace('/uploads/', ''))
    assert(fs.existsSync(avFile), '头像文件已落盘（' + path.basename(avFile) + '）')
    assert(!!r1.data.user.avatar, '登录返回的 user 带 avatar 完整地址')

    // ---------- ② 老用户再登录（不带资料）→ 昵称/头像保持 ----------
    const r2 = await login('code-a-1', {})
    assert(r2.code === 0 && r2.data.user.nickname === '张三' && !!r2.data.user.avatar, '老用户再登录：微信名/头像保持')

    // ---------- ③ 老用户自设过昵称 → 登录带微信名也不覆盖 ----------
    const token = r2.data.token
    await api('PUT', '/user/profile', { nickname: '小李' }, token)
    const r3 = await login('code-a-1', { nickname: '王五' })
    assert(r3.code === 0 && r3.data.user.nickname === '小李', '自设昵称「小李」不被微信名覆盖（实际=' + r3.data.user.nickname + '）')

    // ---------- ④ 默认占位「微信用户」→ 带微信名登录时被替换 ----------
    const r4 = await login('code-b-1', {}) // 不带资料 → 默认「微信用户」
    assert(r4.code === 0 && r4.data.user.nickname === '微信用户', '不带资料新用户默认昵称「微信用户」')
    const r5 = await login('code-b-1', { nickname: '赵六' })
    assert(r5.code === 0 && r5.data.user.nickname === '赵六', '默认占位被微信名替换成「赵六」')

    // ---------- ⑤ 空头像 base64 → 不建档不报错 ----------
    const r6 = await login('code-c-1', { nickname: '钱七', avatarName: 'avatar.png', avatarData: '' })
    assert(r6.code === 0 && r6.data.user.nickname === '钱七' && !r6.data.user.avatar, '空头像 base64：正常登录、无头像、不报错')

    console.log(bad ? '\n=== 微信资料登录测试失败 ' + bad + ' 项 ===' : '\n✅ 微信资料登录测试全部通过')
  } catch (e) {
    console.error('\n❌ 测试异常：' + (e && e.stack || e))
    bad++
  } finally {
    try { if (db) db.close() } catch (e) {}
    if (child) { try { child.kill() } catch (e) {} }
    await new Promise((r) => setTimeout(r, 400))
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f) } catch (e) {} }
    process.exit(bad ? 1 : 0)
  }
})()
