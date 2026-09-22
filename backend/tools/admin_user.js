// 管理员账号管理（方案A：账号密码登录，替代共享静态 ADMIN_TOKEN）
// 用法（在 backend 目录下执行）：
//   node tools/admin_user.js add --username admin [--password xxx] [--nickname 名称] [--gen]
//   node tools/admin_user.js list
//   node tools/admin_user.js disable --username admin
//   node tools/admin_user.js enable --username admin
//   node tools/admin_user.js reset --username admin --password xxx [--gen]
// 说明：
//   · 密码至少 8 位；--gen 自动生成 16 位强密码并只打印一次
//   · disable 会同时吊销该账号全部已登录 session；reset 改密后同样要求重新登录
'use strict'
const db = require('../db')
const adminAuth = require('../services/adminAuth')

const store = db.init()

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def
}
function has(name) {
  return process.argv.includes('--' + name)
}
function randomPassword() {
  // 去掉易混淆字符（0/O、1/l/I）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}
function resolvePassword() {
  const gen = has('gen')
  let p = arg('password', '')
  if (!p && gen) p = randomPassword()
  if (!p || String(p).length < 8) {
    console.error('请用 --password 提供至少 8 位的密码，或用 --gen 自动生成')
    process.exit(1)
  }
  return { p, gen }
}

const cmd = process.argv[2] || 'help'
try {
  if (cmd === 'add') {
    const { p, gen } = resolvePassword()
    const admin = adminAuth.createAdmin(store, { username: arg('username', ''), password: p, nickname: arg('nickname', '') })
    console.log('已创建管理员：' + admin.username + (admin.nickname ? '（' + admin.nickname + '）' : '') + '（id=' + admin.id + '）')
    if (gen) console.log('初始密码（只显示这一次）：' + p)
    console.log('现在可在管理员网页 /admin 用该账号登录。')
  } else if (cmd === 'list') {
    const rows = store.prepare('SELECT id, username, nickname, role, status, created_at, last_login_at FROM admin_users ORDER BY id').all()
    if (!rows.length) { console.log('（尚无管理员账号）'); process.exit(0) }
    for (const r of rows) {
      console.log('#%d  %s%s  状态=%s  角色=%s  创建=%s  最后登录=%s',
        r.id, r.username, r.nickname ? '（' + r.nickname + '）' : '',
        Number(r.status) === 1 ? '启用' : '禁用', r.role || 'admin', r.created_at, r.last_login_at || '—')
    }
  } else if (cmd === 'disable' || cmd === 'enable') {
    const username = String(arg('username', '')).trim()
    const st = cmd === 'disable' ? 0 : 1
    const admin = adminAuth.findByUsername(store, username)
    if (!admin) { console.error('未找到账号：' + username); process.exit(1) }
    store.prepare('UPDATE admin_users SET status=? WHERE id=?').run(st, admin.id)
    if (!st) adminAuth.revokeAllSessions(store, admin.id)
    console.log('已' + (st ? '启用' : '禁用') + '：' + username)
  } else if (cmd === 'reset') {
    const username = String(arg('username', '')).trim()
    const { p, gen } = resolvePassword()
    const admin = adminAuth.findByUsername(store, username)
    if (!admin) { console.error('未找到账号：' + username); process.exit(1) }
    store.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(adminAuth.hashPassword(p), admin.id)
    adminAuth.revokeAllSessions(store, admin.id)
    console.log('已重置 ' + username + ' 的密码' + (gen ? '（新密码只显示这一次）：' + p : '') + '，请重新登录')
  } else {
    console.log('用法：node tools/admin_user.js <add|list|disable|enable|reset> [--username x] [--password x] [--gen] [--nickname x]')
  }
} catch (e) {
  console.error('操作失败：' + e.message)
  process.exit(1)
}
