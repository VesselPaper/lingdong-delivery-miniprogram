// 零栋无人送餐后端
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

// 轻量 .env 加载（零依赖）：backend/.env 存在时读取，格式 KEY=VALUE（# 注释行）
// 注意：必须最先执行——services/platform 与 services/wxpay 在模块加载时就读取 env，
// 若晚于 require 执行，APPID/SECRET 等将被捕获为空。
;(function loadEnvFile() {
  try {
    const p = path.join(__dirname, '.env')
    if (!fs.existsSync(p)) return
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      const k = t.slice(0, i).trim()
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
      if (k && process.env[k] === undefined) process.env[k] = v
    }
  } catch (e) { /* 忽略 .env 读取异常 */ }
})()

const express = require('express')
const cors = require('cors')
const { init } = require('./db')
// 运行模式守卫必须在 require('./services/platform') 之前执行：platform.js 在模块加载期
// 就把 PLATFORM_MOCK 等 env 捕获成常量，晚于它校验就无法再阻止非法组合启动。
const runtime = require('./services/runtime')
runtime.assertBootable()
const platform = require('./services/platform')
const wxpay = require('./services/wxpay')
const batch = require('./services/batch')
const orderCancel = require('./services/orderCancel')
// 商家邀请码：登录校验在 user 域 service 内；此处用于启动日志统计有效码数
const invite = require('./services/merchantInvite')

// 分层域（domains/）：按数据项拆分的路由工厂 (store, deps) => router；URL 与原先内联路由完全一致
const { createShared } = require('./domains/_shared')
const userRoutes = require('./domains/user/routes')
const userService = require('./domains/user/service')
const goodsRoutes = require('./domains/goods/routes')
const goodsService = require('./domains/goods/service')
const orderRoutes = require('./domains/order/routes')
const orderService = require('./domains/order/service')
const deliveryRoutes = require('./domains/delivery/routes')
const deliveryTimers = require('./domains/delivery/timers')
const adminRoutes = require('./domains/admin/routes')

// 派车告警以注入方式挂到平台适配层，避免 platform.js 反向依赖 runtime.js 形成环
platform.setDispatchHook(runtime.warnIfUnsafeDispatch)

const store = init()
const app = express()
const PORT = process.env.PORT || 3000
const UPLOAD_DIR = path.join(__dirname, 'uploads')
// 数据可视化大屏（只读展示页）：主机浏览器访问 http://<IP>:3000/dashboard 即可全屏展示
const DASHBOARD_DIR = path.join(__dirname, '..', '可视化大屏')
// 管理员工具页（查看/修复机器人状态）：http://<IP>:3000/admin
// 管理员令牌：页面首次打开需输入（存 localStorage）；校验逻辑在 domains/_shared（ADMIN_TOKEN 默认 '123456'，env 可覆盖）
const ADMIN_DIR = path.join(__dirname, '..', '管理员网页')

const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

app.use(cors())
// 仅对支付回调路径保存原始报文（供 P0-6 平台证书验签）；其它路径（如 8mb 图片上传）不缓存，避免内存翻倍
app.use(express.json({ limit: '8mb', verify: (req, res, buf) => { if (req.originalUrl === '/api/pay/notify') req.rawBody = buf } }))
app.use('/uploads', express.static(UPLOAD_DIR))
// 管理员工具页（静态）：http://<IP>:3000/admin；API 在 domains/admin/routes.js（adminGuard）
// serve-static 对目录请求自带 301 → /admin/，页面里相对路径（admin.js）因此能正确解析。
app.use('/admin', express.static(ADMIN_DIR))
// 大屏页面（静态）与只读聚合接口（/api/dashboard/overview，见下方）。
// 走路径而非单独起服务：大屏主机只需访问后端同一个端口，不再多一个进程/端口要运维。
// 这里只挂 express.static，不再自建 '/dashboard' 路由：Express 默认不区分结尾斜杠，
// 自建路由会把 /dashboard 与 /dashboard/ 一起匹配，造成「重定向到自己」的死循环。
// serve-static 对目录请求自带 301 → /dashboard/，index.html 里的相对路径（css/… js/…）因此能正确解析。
app.use('/dashboard', express.static(DASHBOARD_DIR))

// 根路径直接进管理员页（三服务同端口：小程序 API=/api、管理员=/admin、大屏=/dashboard/，各自独立 URL）
// 注意必须带尾部斜杠：/admin 无斜杠时，页面里相对路径（admin.js）会被解析成 /admin.js 而 404
app.get('/', (req, res) => res.redirect('/admin/'))

// 公共中间件/工具（auth / merchantGuard / adminGuard / audit / maskPhone / toStock / ok）
// 统一来自 domains/_shared，依赖 store 的部分由工厂 createShared(store) 注入（server.js 与各域 routes 同一套实现）。
const { auth, merchantGuard, adminGuard, audit, ok, maskPhone, toStock } = createShared(store)

// ---------- 分层域挂载：user / goods / order / delivery / admin（URL 与原先内联路由一致，前端零改动） ----------
// user 域：/api/auth/*、/api/user/*、/api/cart/*、/api/address/*（domains/user/routes.js）
// goods 域：/api/goods/*、/api/activity/*、/api/shop/status、/api/merchant/{shop,upload,goods,activities}*（domains/goods/routes.js）
// order 域：/api/order/*、/api/pay/*、/api/refund/*、/api/merchant/{orders,cancel-requests,refunds,stats}* 等（domains/order/routes.js）
// delivery 域：/api/delivery/*、/api/merchant/delivery/*、/api/merchant/device/*、/api/platform/*、/api/merchant/{robots,map}*（domains/delivery/routes.js）
// admin 域：/api/dashboard/*（大屏只读聚合，免登录）+ /api/admin/*（管理员工具，adminGuard）（domains/admin/routes.js）
app.use('/api', userRoutes(store, { runtime, goods: goodsService }))
app.use('/api', goodsRoutes(store, { runtime }))
app.use('/api', orderRoutes(store, {
  runtime, wxpay, batch, platform, orderCancel,
  goods: goodsService, user: userService
}))
app.use('/api', deliveryRoutes(store, {
  runtime, platform, batch, orderCancel,
  goods: goodsService, order: orderService
}))
app.use('/api', adminRoutes(store, {
  runtime, platform, orderCancel,
  goods: goodsService, order: orderService
}))

// delivery 域 4 个后台定时器统一装配：①轮询兜底 ②超时未接单 ③取餐超时两段式 ④批次自动派车（domains/delivery/timers.js）
deliveryTimers.start(store, {
  runtime, platform, batch, orderCancel,
  goods: goodsService, order: orderService
})

app.listen(PORT, () => {
  const d = runtime.describe()
  console.log(`[lingdong-backend] listening on http://127.0.0.1:${PORT}`)
  console.log(`[lingdong-backend] 运行模式 RUN_MODE=${d.run_mode}`)
  console.log(`[lingdong-backend]   登录：${d.real_login ? '真实微信 code2session' : '演示（token 可预测，不可用于真实运营）'}`)
  console.log(`[lingdong-backend]   支付：${d.real_pay ? '微信支付 V3' : '模拟（不产生资金流，退款也不会真实退钱）'}`)
  if (d.real_platform) {
    console.log(`[lingdong-backend]   配送：开放物流平台真实模式 ${d.platform_host}${d.prod_platform ? '【生产】' : '【测试】'}${d.unsafe_prod ? ' (ALLOW_UNSAFE_PROD_PLATFORM)' : ''}`)
    if (!platform.platformReady()) {
      console.warn('[lingdong-backend]   ⚠ 未配置 PLATFORM_APPID/PLATFORM_SECRET，任务不会真正下发')
    }
  } else {
    console.log('[lingdong-backend]   配送：本地 Mock 状态机（PLATFORM_MOCK=true）')
  }
  console.log(`[lingdong-backend]   设备控制：${d.device_mock ? '本地模拟（开舱/关舱/派发均为假成功）' : '真实分支（调用平台设备控制接口）'}`)
  // 邀请码状态：以 merchant_invites 表的有效条数 + 旧单一码 env 为准（按商家一条、首绑、可吊销）
  const invCount = invite.configuredCount(store)
  console.log('[lingdong-backend]   商家邀请码已启用：' + invCount + ' 个有效' + (invCount ? '' : ' → 尚未配置，商家端登录将被拒绝'))
})
