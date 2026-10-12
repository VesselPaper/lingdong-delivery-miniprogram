// 商品清理：删掉「离线演示档的种子商品」（零栋热卤/饮品/套餐那 10 条）。
//
// 为什么需要一个工具：门店商品是按条码增量导入的（db.js importStoreGoods），导入**不会**删掉
// 库里已有的其它商品（商家自己加的商品要保住）。于是「先跑演示建了种子商品、后导入门店 Excel」
// 的库里，那 10 条种子商品会一直挂在用户端/商家端商品列表里 —— 只能真删才清得掉。
//
// 用法（在 backend 目录下执行）：
//   node tools/goods_cleanup.js            # 预览：只列出会删哪些，不动任何数据（默认）
//   node tools/goods_cleanup.js --apply    # 真删（先自动备份数据库文件，再在一个事务里删）
//   LINGDONG_DB=/abs/path/lingdong.db node tools/goods_cleanup.js --apply   # 库不在默认位置时
//
// 匹配规则（刻意保守，宁可漏删也不误删门店商品）：
//   名称 == DEMO_GOODS 里的名字（与 db.js 同一份常量）**且** 条码为空。
//   门店 Excel 导入的商品每一条都带条码，所以「同名 + 无条码」几乎只可能是演示种子。
//
// 删除范围：只有 goods 表。order_items 是下单快照（名称/图/价格都在行内），历史订单不受影响；
// cart 的残留行不动 —— 用户端购物车按 g.status=1 过滤，残留行既不显示也进不了结算。
'use strict'
const fs = require('fs')
const path = require('path')

// .env 里的 LINGDONG_DB 必须在我们 require('../db') 之前生效：db.js 在模块加载期就把库路径定死了。
// 不读它的话，生产机 .env 里改过库路径时，本工具会在默认路径上凭空建一个新库（还会写入演示种子），
// 然后在错误的库上「删得很成功」，真库一点没动。
;(function loadDbPathFromEnvFile() {
  if (process.env.LINGDONG_DB) return
  try {
    const p = path.join(__dirname, '..', '.env')
    if (!fs.existsSync(p)) return
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      if (t.slice(0, i).trim() !== 'LINGDONG_DB') continue
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
      if (v) process.env.LINGDONG_DB = v
      return
    }
  } catch (e) { /* 读不到就按默认路径 */ }
})()

const db = require('../db')

const APPLY = process.argv.includes('--apply')
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const store = db.init()
const noImage = (g) => !String(g.image === undefined || g.image === null ? '' : g.image).trim()

const total = Number(store.prepare('SELECT COUNT(*) AS c FROM goods').get().c || 0)
// 名称 + 无条码：见文件头「匹配规则」
const seedNames = db.DEMO_GOODS.map((r) => String(r[0]))
const hits = store.prepare(
  `SELECT id, name, category, price, stock, barcode, image FROM goods
   WHERE (barcode IS NULL OR TRIM(barcode)='') ORDER BY id`).all()
  .filter((g) => seedNames.indexOf(String(g.name)) > -1)

console.log('[goods_cleanup] 数据库：' + db.DB_PATH)
console.log('[goods_cleanup] 当前商品总数：' + total)
console.log('[goods_cleanup] 命中演示种子商品：' + hits.length + ' 条（名称匹配 + 条码为空）')
for (const g of hits) {
  console.log(`  id=${g.id}  ${g.name}  分类=${g.category}  售价=${g.price}  库存=${g.stock}  条码=${g.barcode || '(空)'}`)
}

if (!hits.length) {
  console.log('[goods_cleanup] 没有可清理的演示种子商品，什么都不用做。')
  process.exit(0)
}

// 安全闸：命中了库里全部商品 —— 说明这是个刚建出来的空库（只有演示种子），
// 多半是库路径不对（比如 .env 里的 LINGDONG_DB 没生效）。这种库不该清，先让人核对路径。
if (hits.length >= total) {
  console.error('[goods_cleanup] 中止：命中的商品数等于库里商品总数（' + total + '），这看起来是空库/新库，')
  console.error('[goods_cleanup]       不是「导入门店商品后残留种子」的情况。请先确认数据库路径是否正确。')
  process.exit(1)
}

if (!APPLY) {
  console.log('')
  console.log('[goods_cleanup] 以上是预览，**没有改动任何数据**。确认无误后执行：')
  console.log('    node tools/goods_cleanup.js --apply')
  process.exit(0)
}

// 备份：优先 VACUUM INTO（WAL 模式下也能得到一致的单文件快照），失败再退回文件复制。
const bak = db.DB_PATH + '.bak_before_goods_cleanup_' + stamp()
try {
  store.exec("VACUUM INTO '" + bak.replace(/'/g, "''") + "'")
} catch (e) {
  fs.copyFileSync(db.DB_PATH, bak)
}
console.log('[goods_cleanup] 已备份数据库 → ' + bak)

store.exec('BEGIN')
try {
  const del = store.prepare('DELETE FROM goods WHERE id=?')
  for (const g of hits) del.run(g.id)
  store.exec('COMMIT')
} catch (e) {
  store.exec('ROLLBACK')
  console.error('[goods_cleanup] 删除失败已回滚：' + e.message)
  process.exit(1)
}
console.log('[goods_cleanup] 已删除 ' + hits.length + ' 条演示种子商品')

// 删完立刻给出「还有多少商品没有图片」——旧商品清掉之后，剩下的无图商品才是真要补图的那些。
const rows = store.prepare('SELECT id, name, category, barcode, image FROM goods ORDER BY id').all()
const noImg = rows.filter(noImage)
console.log('')
console.log('[goods_cleanup] 删除后商品总数：' + rows.length)
console.log('[goods_cleanup] 其中没有图片的商品：' + noImg.length + ' 个' + (noImg.length ? '（需要在商家端「价格库存」里逐个上传）' : ''))
for (const g of noImg) {
  console.log(`  - id=${g.id}  ${g.name}  分类=${g.category}  条码=${g.barcode || '(空)'}`)
}
console.log('')
console.log('[goods_cleanup] 完成。历史订单明细不受影响（order_items 存的是下单快照）。')
