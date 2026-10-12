/* ============================================================
 * tools/selfcheck.js —— 「成员 clone 后为什么跑不起来」一键自检
 * ------------------------------------------------------------
 * 用法（哪个目录都行）：
 *     node backend/tools/selfcheck.js
 *     cd backend && node tools/selfcheck.js
 *
 * 为什么有这个工具：以前"clone 后必配什么"只写在文档的一张表里，成员遇到问题只能靠猜；
 * 而这类问题的现象又特别误导 —— 缺 .env 报的是"运行模式与开关组合不合法"、缺地图数据
 * 是"车压楼 / 车不在路上"、缺双端 IP 是"登录失败"，全都看不出真正原因。
 *
 * 只读：不建库、不建目录、不写文件、不连平台、不改服务器数据。
 * ============================================================ */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const BACKEND = path.join(__dirname, '..')
const REPO = path.join(BACKEND, '..')
const DASH = path.join(REPO, '可视化大屏')
const MIN_NODE = [22, 13, 0]

let bad = 0, warn = 0
const ok = (t, d) => console.log('  ✔ ' + t + (d ? '   → ' + d : ''))
const no = (t, d) => { bad++; console.log('  ✗ ' + t + (d ? '   → ' + d : '')) }
const wa = (t, d) => { warn++; console.log('  ⚠ ' + t + (d ? '   → ' + d : '')) }
const head = (t) => console.log('\n=== ' + t + ' ===')

// ---------- 读 .env（只为展示与实际生效值；与 server.js 的加载规则一致：已存在的环境变量优先） ----------
function loadEnv() {
  const p = path.join(BACKEND, '.env')
  if (!fs.existsSync(p)) return { exists: false, file: p, keys: {} }
  const keys = {}
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
    if (k) {
      keys[k] = v
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
  return { exists: true, file: p, keys }
}
const env = loadEnv()
const val = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : String(process.env[k]))

console.log('送餐无人车 · 本机环境自检（' + new Date().toLocaleString('zh-CN') + '）')
console.log('仓库：' + REPO)

// ---------- A. 运行环境 ----------
head('A. 运行环境')
const nv = process.versions.node.split('.').map(Number)
const nvOk = nv[0] > MIN_NODE[0] || (nv[0] === MIN_NODE[0] && (nv[1] > MIN_NODE[1] || (nv[1] === MIN_NODE[1] && nv[2] >= MIN_NODE[2])))
if (nvOk) ok('Node 版本 ' + process.versions.node + '（后端用内置 node:sqlite，要求 ≥ 22.13）')
else no('Node 版本过低：' + process.versions.node + '，后端起不来（需要 ≥ 22.13，建议 24 LTS）')

for (const m of ['express', 'cors']) {
  try { require.resolve(m, { paths: [BACKEND] }); ok('依赖 ' + m + ' 已安装') }
  catch (e) { no('依赖 ' + m + ' 没装 → 在 backend/ 下执行 npm install') }
}

// ---------- B. 配置 ----------
head('B. 配置（backend/.env）')
if (env.exists) {
  ok('.env 存在', env.file)
} else {
  wa('.env 不存在 → 没关系：后端首次启动会**自动**从 .env.example 复制一份（示范/mock 档）')
}
console.log('     实际生效值：RUN_MODE=' + val('RUN_MODE', '(空 → 默认 demo)') +
  '  PLATFORM_MOCK=' + val('PLATFORM_MOCK', '(空)') +
  '  PAY_MOCK=' + val('PAY_MOCK', '(空)'))
const vr = Number(val('VIRTUAL_ROBOT', '0')) || 0
if (vr > 0) ok('虚拟测试车已打开（VIRTUAL_ROBOT=' + val('VIRTUAL_ROBOT', '1') + '，默认 4 台）→ 大屏/页面上看得到车')
else wa('虚拟测试车关闭（VIRTUAL_ROBOT=' + val('VIRTUAL_ROBOT', '0/空') + '）→ 没有真车时界面会显示"暂无车辆数据"')
if (val('TIANDITU_TK', '')) ok('天地图密钥已配（大屏在线底图可用）')
else wa('未配 TIANDITU_TK → 大屏底图会降级为备用底图（不影响功能）')

// ---------- C. 启动守卫（用后端自己的规则判，不复制逻辑） ----------
head('C. 启动守卫（后端自己的规则）')
try {
  const r = spawnSync(process.execPath, ['-e', "require('./services/runtime').assertBootable();console.log('__BOOTABLE__')"], {
    cwd: BACKEND, encoding: 'utf8', timeout: 20000, env: process.env
  })
  if (r.error) wa('无法自动校验（' + r.error.message + '）→ 直接启动后端看提示即可')
  else if (String(r.stdout || '').indexOf('__BOOTABLE__') >= 0) ok('当前配置可以通过启动守卫（不会一启动就退出）')
  else {
    no('当前配置**会被启动守卫拒绝**，后端起来就退出')
    const msg = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' / ')
    console.log('     原始提示：' + (msg || String(r.stderr || '').slice(0, 300)))
  }
} catch (e) { wa('启动守卫校验异常：' + e.message) }

// ---------- D. 运行时数据 ----------
head('D. backend/data/（不进仓库，缺失的后果各不相同）')
const dataDir = path.join(BACKEND, 'data')
const dbFile = path.join(dataDir, 'lingdong.db')
if (fs.existsSync(dbFile)) ok('lingdong.db 存在（订单/账号等本地数据）', fs.statSync(dbFile).size + ' 字节')
else wa('lingdong.db 不存在 → 首次启动会自动建库（空库：没有历史订单、没有账号，会被默认账号自举补上）')

const reconFile = path.join(dataDir, 'map-recon.json')
if (fs.existsSync(reconFile)) ok('map-recon.json 存在（大屏 3D 重构：楼/路微调）', fs.statSync(reconFile).size + ' 字节')
else wa('map-recon.json 不存在 → 大屏回退**仓库内置**的默认地图：楼/路位置与有这份数据的机器不同，' +
  '小车吸附位置也跟着不同（表现为"车压楼 / 车不在路上"）。要对齐就向负责人要这份文件')

const calibFile = path.join(dataDir, 'admin-calib.json')
if (fs.existsSync(calibFile)) ok('admin-calib.json 存在（定位自动标定）')
else wa('admin-calib.json 不存在 → 回退全局 POS_CAL，车/点位可能有整体偏移（界面无提示，属正常降级）')

// ---------- E. 账号（读库；库没有就跳过） ----------
head('E. 登录账号（都只存在本地库里，不随仓库走）')
if (fs.existsSync(dbFile)) {
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbFile, { readOnly: true })
    const adm = db.prepare("SELECT COUNT(*) AS c FROM admin_users WHERE status=1").get()
    const mer = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='merchant' AND username IS NOT NULL AND username!='' AND status=1").get()
    const stu = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='student' AND username IS NOT NULL AND username!='' AND status=1").get()
    if (adm && adm.c > 0) ok('管理员账号 ' + adm.c + ' 个（管理员网页 /admin/ 可登）')
    else no('管理员账号 0 个 → 非 demo 档会拒绝启动；后端首次启动会自动建一个，或手工 node tools/admin_user.js add')
    if (mer && mer.c > 0) ok('商家账号 ' + mer.c + ' 个（商家端小程序可登）')
    else wa('商家账号 0 个 → 商家端登不进去；后端首次启动会自动建一个（LDPZmar1），或去管理员网页「商家管理」建')
    if (stu && stu.c > 0) ok('用户端账号 ' + stu.c + ' 个（用户端小程序"账号密码登录"可登）')
    else wa('用户端账号 0 个 → 用户端只能用微信登录；后端首次启动会自动建一个（LDPZstu1）')
    db.close()
  } catch (e) { wa('读库失败（不影响其它检查）：' + e.message) }
} else {
  wa('库还不存在：首次启动会自动建库 + 自动补默认账号（LDPZadmin / LDPZmar1 / LDPZstu1，密码见启动日志）')
}

// ---------- F. 大屏资源 ----------
head('F. 可视化大屏资源')
const need = [
  ['assets/map-calibration.js', '标定数据（**在仓库里**，不用索取）'],
  ['assets/radar-ground-dark.png', '雷达底图（「雷达图」按钮用的就是它）'],
  ['js/map3d-gl.js', '3D 主渲染'],
  ['js/dashboard/main.js', '大屏外壳'],
  ['vendor/leaflet.js', '2.5D 兜底地图']
]
for (const [rel, why] of need) {
  const p = path.join(DASH, rel)
  if (fs.existsSync(p)) ok(rel + '（' + why + '）')
  else no(rel + ' 缺失 → ' + why + '：相关功能会降级或点了没反应！仓库里应该有，先 git status 看看是不是被误删')
}
const indexPath = path.join(DASH, 'index.html')
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, 'utf8')
  const vers = html.match(/([\w/-]+\.js)\?v=([0-9a-z]+)/g) || []
  ok('index.html 可读，共 ' + vers.length + ' 个带 ?v= 的脚本（改了 JS 记得 bump 版本号）')
  if (/\uFFFD/.test(html) || /\?\/[a-z]+>/.test(html)) no('index.html 有乱码/被吃掉的 < 字符（不要用 shell 的 Get-Content/Set-Content 改中文文件！）')
} else no('可视化大屏/index.html 缺失')

// ---------- G. 双端小程序地址 ----------
head('G. 双端小程序的开发机地址（仓库里是**占位符**）')
for (const p of [['用户端', path.join(REPO, '用户端', 'utils', 'config.js')], ['商家端', path.join(REPO, '商家端', 'utils', 'config.js')]]) {
  const [name, file] = p
  if (!fs.existsSync(file)) { no(name + ' utils/config.js 缺失'); continue }
  const s = fs.readFileSync(file, 'utf8')
  const m = s.match(/BASES\.develop\s*=\s*'([^']+)'/)
  const cur = m ? m[1] : '(未找到 BASES.develop 赋值)'
  if (cur.indexOf('192.168.1.100') >= 0) {
    wa(name + ' 仍是占位符：' + cur + ' → 真机预览必须改成你自己电脑的局域网 IP（ipconfig 看 WLAN 的 IPv4）；' +
      '只用开发者工具模拟器就删掉这一行（上一行的 localhost 就够）')
  } else if (cur.indexOf('localhost') >= 0 || cur.indexOf('127.0.0.1') >= 0) {
    ok(name + ' 指向本机：' + cur + '（模拟器可用；真机预览要改成局域网 IP）')
  } else {
    ok(name + ' 已改成：' + cur + '（确认手机和电脑在同一个网段；改完别提交这个文件）')
  }
}

// ---------- H. 结论 ----------
head('结论')
if (bad === 0 && warn === 0) console.log('  一切就绪：直接 cd backend && node server.js，然后打开 http://localhost:3000/admin/ 与 /dashboard/')
else console.log('  有 ' + bad + ' 项「✗」（会导致跑不起来 / 功能坏掉）和 ' + warn + ' 项「⚠」（会降级但不影响启动，看上面的说明按需处理）')
console.log('  默认账号（首次启动自动创建并在日志里打印）：管理员 LDPZadmin / 商家端 LDPZmar1 / 用户端 LDPZstu1，密码见启动日志或 .env 的 BOOTSTRAP_*_PASSWORD')
console.log('  更多说明见仓库根 AGENTS.md 的 §2.1 与 §6。')
process.exit(0)
