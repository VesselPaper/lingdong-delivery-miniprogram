/* ============================================================
   管理员页「拆分式构建」脚本（方案A）
   ------------------------------------------------------------
   · 逻辑：源码按数据域拆在 js/parts/ 下的小文件中，运行时是同一个闭包，
     因此函数/变量引用与拆分前完全一致 → 行为不变。
   · 用法：
     node build.js           按清单把 js/parts 下各小文件拼回 admin.js 与 admin-map.js
     node build.js --gen     从当前 admin.js / admin-map.js 按边界重新切分生成 parts
                              （首次以及你直接改了输出文件想重新拆一次时用）
   · 约定：直接改 js/parts/ 下的小文件，改完跑 `node build.js` 生效。
   ============================================================ */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = __dirname

// 输出文件 ← 有序 parts 清单（顺序即拼接顺序，务必与你拆块边界一致）
const TARGETS = [
  {
    out: 'admin.js',
    parts: [
      'js/parts/admin/01-core.js',           // 头部/IIFE/常量/基础工具(esc/log/toast/api/状态字典)
      'js/parts/admin/02-nav.js',            // 导航 + 标签页 + 搜索/筛选 + 批次自动展开
      'js/parts/admin/03-select.js',         // 选择与批量操作 + 右键菜单 + 复制 + 批次展开
      'js/parts/admin/04-overview-ws.js',    // 总览页渲染 + 机器人卡片 + WebSocket 事件驱动 + 导航计数
      'js/parts/admin/05-render-tables.js',  // 任务页 + 批次/订单/本地任务/平台任务 各表格渲染
      'js/parts/admin/06-refresh-token.js',  // 刷新与认证 + 令牌设置页
      'js/parts/admin/07-ops.js',            // 单项危险操作 + 召唤/开关舱弹窗 + 批量按钮 + 启动
    ],
  },
  {
    out: 'admin-map.js',
    parts: [
      'js/parts/map/01-init.js',             // 地图初始化：元数据/坐标映射/雷达底图
      'js/parts/map/02-static.js',           // 点位 + 配送站位（静态数据层）
      'js/parts/map/03-cars.js',             // 无人车图层（实时位置 + 朝向）+ 批次聚焦
      'js/parts/map/04-render.js',           // renderMap/setMask/poll（整图渲染与拉取）
      'js/parts/map/05-live.js',             // mapOnLive + 跟随小车 + 轨迹 + boot（实时层）
    ],
  },
]

// 每个输出文件：parts 各自切块的「最后一行号」(1-based)；行号即边界，切块单调递增
const CUTS = {
  'admin.js': [128, 266, 540, 651, 977, 1081, 1286],
  'admin-map.js': [100, 158, 220, 273, 370],
}

function readLines(name) {
  return fs.readFileSync(full(name), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
}
function full(name) { return path.join(ROOT, name) }

// --gen：从当前输出文件按 CUTS 边界切回 parts（保证与输出逐字节等价）
function gen() {
  for (const t of TARGETS) {
    const all = readLines(t.out)
    const cuts = CUTS[t.out]
    let prev = 0 // 0-based 起
    for (let i = 0; i < cuts.length; i++) {
      const end = cuts[i] - 1 // 转 0-based（含）
      const slice = all.slice(prev, end + 1)
      const name = t.parts[i]
      fs.mkdirSync(path.dirname(full(name)), { recursive: true })
      fs.writeFileSync(full(name), slice.join('\n'))
      console.log(`gen  ${name}  (${slice.length} 行, 行 ${prev + 1}~${end + 1})`)
      prev = end + 1
    }
    if (prev < all.length) console.warn(`警告：${t.out} 还有 ${all.length - prev} 行未切（边界后于文件总长？）`)
  }
}

// 默认：把 parts 拼回输出文件
function build() {
  for (const t of TARGETS) {
    const chunks = t.parts.map((p) => readLines(p))
    const out = chunks.map((c) => c.join('\n')).join('\n')
    fs.writeFileSync(full(t.out), out)
    console.log(`build ${t.out}  (${out.split('\n').length} 行)`)
  }
}

if (process.argv.includes('--gen')) gen()
else build()