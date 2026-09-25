// 运行模式守卫：把「演示 / 试点 / 正式」三档做成启动时的强约束。
//
// 存在理由：本项目同时维护 mock 与真实两套通道（登录、支付、配送、设备控制各一套），
// 此前它们共用同一个 .env 且互不感知，实际出现过「演示登录 + 模拟支付 + 生产物流平台 +
// 前端假装已上货已送达」的组合 —— 0 元订单能真实调度生产机器人，而商家端的配送按钮只在本地空转。
// 本模块让这类跨层混用在启动阶段就无法成立。
//
// 两条设计约束：
//  1. 只拒绝启动，绝不静默改写 process.env。services/platform.js 与 services/wxpay.js 在模块
//     加载期就把 env 捕获成模块级常量，事后再改 env 不生效，静默修改只会造成「配置说一套、行为另一套」。
//  2. 依赖方向 runtime -> wxpay 单向。**禁止 require('./platform')**：platform 的 module.exports
//     位于文件末尾，一旦成环这里拿到的是空对象，守卫会静默失效。故本模块自行解析 PLATFORM_BASE。

const crypto = require('crypto')
const wxpay = require('./wxpay')

const MODES = ['demo', 'pilot', 'production']

// 与 services/platform.js:16 的默认值保持一致（默认指向测试环境，即安全侧）
const DEFAULT_PLATFORM_BASE = 'https://test-robox.eventec.cn/service-open-logis'

function envFlag(name) {
  return process.env[name] === 'true'
}

function platformHostOf(base) {
  try {
    return new URL(base).hostname
  } catch (e) {
    return ''
  }
}

// 生产物流平台判定：主机名不以 test- 开头即视为生产。
// 不能用 indexOf('robox.eventec.cn') 判断 —— test-robox.eventec.cn 也包含该子串。
function isProdHost(host) {
  return !!host && !/^test-/.test(host)
}

const mode = (function resolveMode() {
  const raw = String(process.env.RUN_MODE || '').trim().toLowerCase()
  if (!raw) return 'demo'
  return raw // 非法值交由 check() 报错，此处原样保留以便提示
})()

const platformBase = process.env.PLATFORM_BASE || DEFAULT_PLATFORM_BASE
const platformHost = platformHostOf(platformBase)
const prodPlatform = isProdHost(platformHost)
const platformMock = envFlag('PLATFORM_MOCK')
const payMock = envFlag('PAY_MOCK')
const unsafeProd = envFlag('ALLOW_UNSAFE_PROD_PLATFORM')

const wxAppid = process.env.WX_APPID || ''
const wxSecret = process.env.WX_SECRET || ''
// 商家端独立凭据（零栋商家）：与用户端（零栋GO）是不同的小程序，AppID/AppSecret 各自独立。
// 2026-09-24 起商家端登录已改为账号密码体系（users.username + scrypt），本凭据不再参与登录，仅保留兼容。
const merchantWxAppid = process.env.MERCHANT_WX_APPID || ''
const merchantWxSecret = process.env.MERCHANT_WX_SECRET || ''

// 派生标志（server.js 一律读这些，不再直接读 process.env，避免守卫与实际行为不一致）
const realPlatform = !platformMock
const realPay = !payMock
// 按端判定真实登录是否可用：user=用户端(零栋GO)、merchant=商家端(零栋商家)
function loginMode(client) {
  const c = client === 'merchant' ? 'merchant' : 'user'
  return c === 'merchant'
    ? (merchantWxAppid && merchantWxSecret ? 'real' : 'demo')
    : (wxAppid && wxSecret ? 'real' : 'demo')
}
// 返回某端 code2session 用的 appid/secret；缺凭据返回 null（调用方走演示登录）
function loginCreds(client) {
  if (loginMode(client) !== 'real') return null
  return client === 'merchant'
    ? { appid: merchantWxAppid, secret: merchantWxSecret }
    : { appid: wxAppid, secret: wxSecret }
}
// 任一端配齐即视为「真实登录已接通」（仅用于启动告警/describe；具体端判定用 loginMode）
const realLogin = !!(wxAppid && wxSecret) || !!(merchantWxAppid && merchantWxSecret)
// 设备控制（开舱/关舱/派发）是否走本地假装：仅演示档为真。
// 商家端不再硬编码该开关，由 /api/shop/status 与登录响应下发。
const deviceMock = mode === 'demo'

// 召唤多单配送（SUMMON_DELIVERY=true）：弃用越凡配送任务接口，改用
// 「召唤(summonToPoint) + 开关舱门(drawerCtrl)」逐点推进。默认 false=沿用一单一单送。
const summonDelivery = envFlag('SUMMON_DELIVERY')
// 路线规划单数权重 α（ROUTE_COUNT_WEIGHT）：给"距离"按该站点订单数打折，
// α=0 退化为纯最近邻；越大越偏好多单楼栋。默认 0.5（√ 开方，见效又不过猛）。
const routeCountWeight = Number(process.env.ROUTE_COUNT_WEIGHT || 0.5)
// 召唤模式点位到达门禁半径（机器人测距距目标点 ≤ 该米数判为已到；MOCK 档恒到）
const arriveRadiusM = Number(process.env.ARRIVE_RADIUS_M || 2.0)
// 定位标定系数：getDevicePosition 返回 SLAM 网格坐标 → 局部米的换算（现场真机标定）
const posMPerUnit = Number(process.env.POS_M_PER_UNIT || 1.0)

// 平台回调防伪令牌：拼在 feedbackDeliveryTaskUrl / checkBizOrderStatusUrl 的 query 上，回调时校验。
// 未显式配置时由 PLATFORM_SECRET 派生 —— 必须跨重启稳定，否则重启前创建的任务回调会被全部拒收。
const callbackToken = (function resolveToken() {
  const explicit = process.env.PLATFORM_CALLBACK_TOKEN || ''
  if (explicit) return explicit
  const secret = process.env.PLATFORM_SECRET || ''
  if (!secret) return ''
  return crypto.createHash('sha256').update('lingdong-callback:' + secret).digest('hex').slice(0, 32)
})()

// 逐档校验。返回 { ok, errors, warnings }，不直接退出，便于测试。
function check() {
  const errors = []
  const warnings = []

  if (!MODES.includes(mode)) {
    errors.push(`RUN_MODE="${mode}" 不是合法取值，只能是 demo / pilot / production（留空默认 demo）`)
    return { ok: false, errors, warnings }
  }

  if (mode === 'demo') {
    if (realPlatform) {
      errors.push(
        'RUN_MODE=demo 要求 PLATFORM_MOCK=true：演示档禁止连接任何真实物流平台。\n' +
        `  当前 PLATFORM_MOCK=${process.env.PLATFORM_MOCK || '(未设置)'}，PLATFORM_BASE=${platformBase}\n` +
        '  整改：在 backend/.env 设 PLATFORM_MOCK=true；若要联调真机请改用 RUN_MODE=pilot'
      )
    }
  }

  if (mode === 'pilot') {
    if (realPlatform && prodPlatform && !unsafeProd) {
      errors.push(
        `RUN_MODE=pilot 不允许连接【生产】物流平台（${platformHost}）。\n` +
        '  三选一整改：\n' +
        `  1) PLATFORM_BASE 改为测试环境（主机名以 test- 开头，如 ${DEFAULT_PLATFORM_BASE}）\n` +
        '  2) RUN_MODE=production，并备齐真实微信登录（WX_APPID/WX_SECRET）与微信支付四要素\n' +
        '  3) 设 ALLOW_UNSAFE_PROD_PLATFORM=true 显式承担风险（启动与每次派车都会告警）'
      )
    }
    if (platformMock) {
      warnings.push('RUN_MODE=pilot 但 PLATFORM_MOCK=true：配送走本地模拟，设备控制却是真实分支，通常不是想要的组合')
    }
  }

  if (mode === 'production') {
    if (platformMock) errors.push('RUN_MODE=production 不允许 PLATFORM_MOCK=true：正式档必须走真实配送')
    if (payMock) errors.push('RUN_MODE=production 不允许 PAY_MOCK=true：正式档必须真实收款')
    if (!(wxAppid && wxSecret)) errors.push('RUN_MODE=production 要求用户端真实微信登录：配置 WX_APPID 与 WX_SECRET')
    // 商家端登录已是账号密码体系（2026-09-24 起），不依赖商家端微信凭据，无需在此校验
    if (!wxpay.enabled()) {
      errors.push(
        'RUN_MODE=production 要求微信支付四要素齐备：' +
        'WXPAY_MCHID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY / WXPAY_APIV3_KEY / WXPAY_NOTIFY_URL'
      )
    }
    if (!prodPlatform) warnings.push(`RUN_MODE=production 但 PLATFORM_BASE 指向非生产环境（${platformHost}）`)
  }

  // 管理员鉴权已改为「账号 + session token」（方案A，见 services/adminAuth.js），
  // 静态 ADMIN_TOKEN 不再参与鉴权。账号是否就绪由 server.js 启动时按 admin_users 表校验；
  // 这里仅提示遗留配置可清理，不再作为启动硬约束。
  const adminToken = process.env.ADMIN_TOKEN || ''
  if (adminToken && adminToken !== '123456') {
    warnings.push('ADMIN_TOKEN 已不再参与鉴权（管理员网页改为账号密码登录 + session token），可从 .env 移除')
  }

  // 跨档通用告警
  if (realPlatform && prodPlatform && unsafeProd && mode !== 'production') {
    warnings.push(
      `ALLOW_UNSAFE_PROD_PLATFORM=true：正在以 ${mode} 档连接【生产】物流平台 ${platformHost}，` +
      '真实机器人会被真实调度，但登录/支付可能仍是模拟的。每次派车都会再次告警。'
    )
  }
  if (!realLogin) {
    warnings.push('未配置任何微信登录凭据：登录走演示模式，token=demo_+sha1(客户端 code)，可预测、不可吊销')
  } else {
    if (loginMode('user') !== 'real') warnings.push('用户端(零栋GO)未配置 WX_APPID/WX_SECRET：该端登录走演示模式')
    if (merchantWxAppid || merchantWxSecret) warnings.push('已配置 MERCHANT_WX_APPID/MERCHANT_WX_SECRET：商家端登录已改账号密码（2026-09-24 起），该凭据不再参与登录，可从 .env 移除')
  }
  if (!realPay) {
    warnings.push('PAY_MOCK=true 或未配置支付四要素：支付不产生真实资金流，退款接口也不会真实退钱')
  }
  if (realPlatform && !callbackToken) {
    warnings.push('无法派生 PLATFORM_CALLBACK_TOKEN（PLATFORM_SECRET 为空）：平台回调将不做防伪校验')
  }

  return { ok: errors.length === 0, errors, warnings }
}

// 启动断言：打印诊断信息，不合法则退出进程。必须在 require('./platform') 之前调用。
// 为精简控制台输出，合法的运行提示（warnings）合并为一行简短汇总，不再逐条长警告。
function assertBootable() {
  const r = check()
  if (r.ok) {
    if (r.warnings.length) {
      const topics = r.warnings.map((w) => w.split('：')[0] || w.slice(0, 8)).join(' / ')
      console.log('[runtime] 运行提示：' + topics)
    }
    return r
  }
  console.error('\n[runtime] 启动被拒绝：运行模式与开关组合不合法\n')
  r.errors.forEach((e, i) => console.error(`  ${i + 1}. ${e.split('\n').join('\n     ')}\n`))
  console.error('  说明见 backend/.env.example 的「运行模式」章节。\n')
  process.exit(1)
}

// 供启动日志与 /api/shop/status 使用
function describe() {
  return {
    run_mode: MODES.includes(mode) ? mode : 'invalid:' + mode,
    device_mock: deviceMock,
    real_login: realLogin,
    login_user: loginMode('user'),
    login_merchant: 'acct', // 商家端登录为账号密码体系（2026-09-24 起），不再依赖商家端微信凭据
    real_pay: realPay,
    pay_mock: payMock,
    real_platform: realPlatform,
    platform_host: platformHost,
    prod_platform: prodPlatform,
    unsafe_prod: unsafeProd,
    summon_delivery: summonDelivery,
    route_count_weight: routeCountWeight,
    arrive_radius_m: arriveRadiusM,
    pos_m_per_unit: posMPerUnit,
    callback_token_configured: !!callbackToken
  }
}

// 派车告警已按要求静默：pilot 档连接生产平台的真实调度风险只在启动摘要提示一次，
// 不再每次派车刷屏「真实机器人会被真实调度」。
function warnIfUnsafeDispatch() {
  return
}

module.exports = {
  MODES,
  mode,
  deviceMock,
  realPlatform,
  realPay,
  realLogin,
  prodPlatform,
  unsafeProd,
  platformBase,
  platformHost,
  callbackToken,
  summonDelivery,
  routeCountWeight,
  arriveRadiusM,
  posMPerUnit,
  check,
  assertBootable,
  describe,
  warnIfUnsafeDispatch,
  loginMode,
  loginCreds
}
