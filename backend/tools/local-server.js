// 本机测试后端（多店铺演示环境）
// ------------------------------------------------------------
// 为什么需要它：云端已经是正式后端（小程序默认连它），要在本机随便改、随便点、随便造单，
// 必须有一个**不碰真实平台、不碰云端数据**的本地后端。这个脚本一条命令做完四件事：
//   1) 选一个独立数据库（默认 data/lingdong-test.db，可 --fresh 重建、--copy-real 拷真数据）
//   2) 强制 PLATFORM_MOCK=true（绝不去连越凡生产平台、绝不召唤真车）
//   3) 造好多店铺演示数据（3 家店 + 每家店的商家账号 + 商品分流）
//   4) 起 server.js，打印三个前端地址与登录账号
//
// 用法（在 backend 目录下）：
//   node tools/local-server.mjs                 # 默认端口 3100，复用已有测试库
//   node tools/local-server.mjs --fresh         # 删掉测试库重建（含演示数据）
//   node tools/local-server.mjs --port 3200     # 换端口
//   node tools/local-server.mjs --copy-real     # 用当前 data/lingdong.db 的副本（真实数据的影子库）
//   node tools/local-server.mjs --no-seed       # 不造多店铺演示数据
//
// 为什么默认端口 3100 而不是 3000：本机 3000 被系统服务 gitfox 占用（非管理员无法释放），
// 3000 上起后端会直接 EACCES。换端口不影响任何功能，小程序端把地址改成 3100 即可。
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const BACKEND = path.join(__dirname, '..')
const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return (!v || v.startsWith('--')) ? true : v
}
const has = (name) => argv.indexOf('--' + name) > -1

const PORT = String(arg('port', '3100'))
const HOST = String(arg('host', '0.0.0.0'))
const DB_ARG = String(arg('db', path.join('data', 'lingdong-test.db')))
const DB_PATH = path.isAbsolute(DB_ARG) ? DB_ARG : path.join(BACKEND, DB_ARG)
const FRESH = has('fresh')
const COPY_REAL = has('copy-real')
const SEED = !has('no-seed')
// 商家初始密码：与后端自举账号同一套（.env 的 BOOTSTRAP_*_PASSWORD 可覆盖，这里只兜底）
const MERCHANT_PASS = 'ldpzjkxy2026'

// ---------- 1. 数据库准备 ----------
const realDb = path.join(BACKEND, 'data', 'lingdong.db')
if (FRESH) {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { fs.rmSync(f, { force: true }) } catch (e) { /* 忽略 */ }
  }
  console.log('[local] 已删除旧测试库：' + DB_PATH)
}
if (COPY_REAL && !fs.existsSync(DB_PATH) && fs.existsSync(realDb)) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(realDb + ext)) fs.copyFileSync(realDb + ext, DB_PATH + ext)
  }
  console.log('[local] 已从真实库复制一份影子库：' + DB_PATH)
}

// ---------- 2. 环境变量（必须在 require db 之前设好，DB_PATH 在模块加载期就定了） ----------
process.env.LINGDONG_DB = DB_PATH
process.env.PORT = PORT
process.env.BIND_HOST = HOST
// 关键三条：mock 平台 + 演示档 + 模拟支付。少了任一，本机就可能连上生产平台或真扣钱。
process.env.PLATFORM_MOCK = 'true'
process.env.RUN_MODE = 'demo'
process.env.PAY_MOCK = 'true'
process.env.BOOTSTRAP_ACCOUNTS = process.env.BOOTSTRAP_ACCOUNTS || '1'
process.env.VIRTUAL_ROBOT = process.env.VIRTUAL_ROBOT || '1'
// 微信登录/支付凭据留空：本机用账号密码登录，不碰微信侧
for (const k of ['WX_APPID', 'WX_SECRET', 'MERCHANT_WX_APPID', 'MERCHANT_WX_SECRET',
  'WXPAY_MCHID', 'WXPAY_SERIAL', 'WXPAY_KEY', 'WXPAY_CERT']) process.env[k] = ''

// ---------- 3. 建库 + 多店铺演示数据 ----------
const store = require('../db').init()
const adminAuth = require('../services/adminAuth')

function ensureShop(name, code, extra) {
  const hit = store.prepare('SELECT * FROM shops WHERE code=?').get(code)
  if (hit) return { shop: hit, created: false }
  const p = extra || {}
  const r = store.prepare(
    `INSERT INTO shops (name, code, category, address, pickup_landmark_id, min_order, pack_fee, business_status, auto_accept, sort)
     VALUES (?,?,?,?,?,?,?,'open',0,?)`
  ).run(name, code, p.category || '', p.address || '', String(p.pickup_landmark_id || ''),
    Number(p.min_order || 0), Number(p.pack_fee || 0), Number(p.sort || 0))
  return { shop: store.prepare('SELECT * FROM shops WHERE id=?').get(Number(r.lastInsertRowid)), created: true }
}

function ensureMerchant(username, nickname, shopId, role) {
  let u = store.prepare('SELECT * FROM users WHERE username=?').get(username)
  if (!u) {
    const r = store.prepare(
      "INSERT INTO users (username, password_hash, role, merchant_role, status, nickname) VALUES (?,?,'merchant',?,1,?)"
    ).run(username, adminAuth.hashPassword(MERCHANT_PASS), role === 'owner' ? 'owner' : 'staff', nickname)
    u = store.prepare('SELECT * FROM users WHERE id=?').get(Number(r.lastInsertRowid))
  }
  const m = store.prepare('SELECT id FROM shop_members WHERE shop_id=? AND user_id=?').get(Number(shopId), Number(u.id))
  if (!m) {
    store.prepare('INSERT INTO shop_members (shop_id, user_id, role) VALUES (?,?,?)')
      .run(Number(shopId), Number(u.id), role === 'owner' ? 'owner' : 'staff')
  }
  return u
}

let seedInfo = null
if (SEED) {
  // 2 号店：东苑超市（把一部分演示商品划给它，这样两家店的商品列表看得出来差异）
  // 3 号店：南苑面馆（歇业，用来验"歇业标签"与"看不到别家店的货"）
  const b = ensureShop('东苑超市', 'shop-b', { category: '超市便利店', address: '东苑生活区', min_order: 10, sort: 1 })
  const c = ensureShop('南苑面馆', 'shop-c', { category: '餐饮', address: '南苑食堂旁', min_order: 15, pack_fee: 1.5, sort: 2 })
  // 3 号店默认歇业：本地测试时能直接看到「歇业」态
  store.prepare("UPDATE shops SET business_status='closed' WHERE code='shop-c'").run()

  // 商品分流：1 号店留大头，2 号店拿 6 个，3 号店拿 3 个（只在首次插入时动，避免每次启动越搬越少）
  const total = Number(store.prepare('SELECT COUNT(*) AS c FROM goods').get().c)
  const shop2Goods = Number(store.prepare('SELECT COUNT(*) AS c FROM goods WHERE shop_id=?').get(Number(b.shop.id)).c)
  if (shop2Goods === 0 && total > 9) {
    const moveTo2 = store.prepare('SELECT id FROM goods ORDER BY id LIMIT 6').all().map((r) => Number(r.id))
    const moveTo3 = store.prepare('SELECT id FROM goods ORDER BY id DESC LIMIT 3').all().map((r) => Number(r.id))
    const setShop = store.prepare('UPDATE goods SET shop_id=? WHERE id=?')
    for (const id of moveTo2) setShop.run(Number(b.shop.id), id)
    for (const id of moveTo3) setShop.run(Number(c.shop.id), id)
  }

  // 每家店一个店主账号。1 号店的 LDPZmar1 本可由后端自举创建，但这个脚本先建账号、再起 server，
  // 自举会认为「商家账号已存在」而跳过 —— 所以三个账号都在这里建，行为才稳定可预期。
  ensureMerchant('LDPZmar1', '零栋铺子', 1, 'owner')
  ensureMerchant('LDPZmar2', '东苑超市', b.shop.id, 'owner')
  ensureMerchant('LDPZmar3', '南苑面馆', c.shop.id, 'owner')

  const rows = store.prepare(
    `SELECT s.id, s.name, s.business_status,
       (SELECT COUNT(*) FROM goods g WHERE g.shop_id=s.id) AS goods,
       (SELECT COUNT(*) FROM shop_members m WHERE m.shop_id=s.id) AS members
     FROM shops s ORDER BY IFNULL(s.sort,0), s.id`
  ).all()
  seedInfo = { shops: rows, createdB: b.created, createdC: c.created }
}
store.close()

// ---------- 4. 打印信息并起服务 ----------
// 只取一张「手机能连上」的网卡：本机装了 Radmin VPN / VMware / Hyper-V，
// os.networkInterfaces() 的枚举顺序会把 26.x 的虚拟网卡排在最前，照它写进 config.js 手机就连不上。
const VIRTUAL_NIC = /radmin|vmware|virtualbox|vethernet|hyper-v|loopback|tailscale|zerotier|docker|wsl|wi-?fi direct|本地连接\s*\*|宽带连接|pppoe|wan miniport/i
const WIFI_NIC = /wi-?fi|wlan|无线|以太网|ethernet/i
function lanNICs() {
  const os = require('os')
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal || n.address.startsWith('169.254.')) continue
      const virtual = VIRTUAL_NIC.test(name)
      out.push({ name: name, address: n.address, virtual: virtual, wifi: WIFI_NIC.test(name) })
    }
  }
  // 真实网卡优先，其中无线/以太网优先；虚拟网卡垫底
  out.sort((a, b) => (Number(a.virtual) - Number(b.virtual)) || (Number(b.wifi) - Number(a.wifi)))
  return out
}
const NICS = lanNICs()
const HAS_REAL_NIC = NICS.some((n) => !n.virtual)
const LAN = (NICS[0] && NICS[0].address) || '127.0.0.1'
const line = '='.repeat(64)
console.log('\n' + line)
console.log('本机测试后端 · 多店铺演示环境')
console.log(line)
console.log('数据库      ' + DB_PATH + (COPY_REAL ? '（真实库副本）' : ''))
console.log('运行模式    RUN_MODE=demo · PLATFORM_MOCK=true · PAY_MOCK=true（不连生产平台、不真扣钱）')
console.log('监听        http://' + HOST + ':' + PORT + '   （局域网：' + (HAS_REAL_NIC ? 'http://' + LAN + ':' + PORT : '未检测到可用网卡，见下方提示') + '）')
console.log('')
console.log('管理网页    http://127.0.0.1:' + PORT + '/admin/')
console.log('可视化大屏  http://127.0.0.1:' + PORT + '/dashboard/')
console.log('接口前缀    http://127.0.0.1:' + PORT + '/api')
console.log('')
if (NICS.length > 1) {
  console.log('本机网卡（手机连 Wi-Fi 时用「无线/以太网」那张，VPN/虚拟网卡的地址手机连不上）')
  for (const n of NICS) {
    console.log('  ' + n.address.padEnd(16) + (n.virtual ? '虚拟' : (n.wifi ? '无线/有线' : '其它')) + '  ' + n.name)
  }
  console.log('')
}
if (seedInfo) {
  console.log('店铺（id / 名称 / 状态 / 商品数 / 成员数）')
  for (const s of seedInfo.shops) {
    console.log('  ' + String(s.id).padEnd(3) + (s.name || '').padEnd(12) +
      (s.business_status === 'open' ? '营业' : '歇业').padEnd(4) + ' 商品 ' + String(s.goods).padStart(3) + '  成员 ' + s.members)
  }
  console.log('')
  console.log('账号（密码统一 ' + MERCHANT_PASS + '）')
  console.log('  管理员    LDPZadmin   → /admin/')
  console.log('  1 号店主  LDPZmar1    → 零栋铺子')
  console.log('  2 号店主  LDPZmar2    → 东苑超市')
  console.log('  3 号店主  LDPZmar3    → 南苑面馆（歇业）')
  console.log('  学生      LDPZstu1    → 用户端小程序')
  console.log('')
}
console.log('小程序怎么连它：双端 utils/config.js 第 20 行的 CLOUD_BASE（改完不要提交）')
if (HAS_REAL_NIC) {
  console.log("  const CLOUD_BASE = 'http://" + LAN + ':' + PORT + "/api'")
} else {
  console.log("  const CLOUD_BASE = 'http://<电脑 Wi-Fi 的 IP>:" + PORT + "/api'   ← 先把电脑连上 Wi-Fi，重跑本命令会直接给出地址")
}
console.log('  用户端/商家端 两个 config.js 都要改；手机预览：详情 → 本地设置 → 不校验合法域名，手机与电脑同一个 Wi-Fi')
if (!HAS_REAL_NIC) console.log('  ⚠ 没检测到可用的 Wi-Fi/有线网卡（笔记本 WLAN 断开了？）：电脑连上 Wi-Fi 后重跑这条命令，再按上面地址改 config.js')
console.log(line)
console.log('按 Ctrl+C 停止\n')

const child = spawn(process.execPath, ['server.js'], {
  cwd: BACKEND,
  env: process.env,
  stdio: 'inherit'
})
child.on('exit', (code) => process.exit(code === null ? 0 : code))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig) } catch (e) { /* 忽略 */ } })
}
