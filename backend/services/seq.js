// 编号服务（batch/order 共用）：日期 + 当日序号的「原子取号」与「完整号 / 人读短号」格式化
//
// 设计要点（见批次号/订单号重构方案）：
//  · 系统号（order_no/batch_no）与「人读短号」分开：系统号要全局唯一且不可变（微信支付 out_trade_no、
//    退款单号、平台 outOrderNo 都靠它），人读短号只负责商家/管理员/用户看得懂、念得出、贴袋能扫。
//  · 序号每天重置，但**日期写进号里** → 跨天不再歧义（`0923-07` 永远指 9/23 的第 7 单）。
//  · 取号不再用 COUNT(*)（删行会重复），改为 seq_counters 计数器表原子递增；
//    首次取号时以当日 MAX(daily_seq)+1 作种子，保证即使计数器表刚建也不会重用历史号。
//  · 日期一律在 SQL 里算（date('now','localtime')），与 created_at 同源，避免 Node/SQLite 时区漂移。
//
// 格式：
//   订单完整号 LD-YYMMDD-NNNN（如 LD-250923-0007）｜ 短号 MMDD-NN（如 0923-07）
//   批次完整号 BD-YYMMDD-NNN （如 BD-250923-003） ｜ 短号 B-MMDD-NN（如 B-0923-03）

// 取号域 → 承载该域的「当日序号」的表（表名是内部常量白名单，不来自外部输入）
const SCOPES = { order: 'orders', batch: 'delivery_batches' }

// 当日日期（本地时区，YYYY-MM-DD）——与 orders/delivery_batches.created_at 同一时钟源
function today(store) {
  return store.prepare("SELECT date('now','localtime') AS d").get().d
}

// 原子取号：返回 { day: 'YYYY-MM-DD', seq: 当日序号 }
// 单线程同步执行（Node + node:sqlite 同步 API），不存在同进程并发抢占；跨进程由 SQLite 写锁串行化。
function nextSeq(store, scope) {
  const table = SCOPES[scope]
  if (!table) throw new Error('未知取号域：' + scope)
  const day = today(store)
  // 种子：当日已有最大序号 + 1（首次取号/计数器表被清空时也不会重用历史号）
  const seed = Number(store.prepare(`SELECT IFNULL(MAX(daily_seq),0) AS m FROM ${table} WHERE seq_date=?`).get(day).m) + 1
  store.prepare(
    `INSERT INTO seq_counters (scope, day, last_seq) VALUES (?,?,?)
     ON CONFLICT(scope, day) DO UPDATE SET last_seq = last_seq + 1`
  ).run(scope, day, seed)
  const row = store.prepare('SELECT last_seq FROM seq_counters WHERE scope=? AND day=?').get(scope, day)
  return { day, seq: Number(row.last_seq) }
}

// ---------- 格式化 ----------
const pad = (n, w) => String(n).padStart(w, '0')
const ymd = (day) => String(day).slice(2).replace(/-/g, '')   // 2025-09-23 → 250923
const mmdd = (day) => String(day).slice(5).replace(/-/g, '')  // 2025-09-23 → 0923

const orderNo = (day, seq) => 'LD-' + ymd(day) + '-' + pad(seq, 4)
const batchNo = (day, seq) => 'BD-' + ymd(day) + '-' + pad(seq, 3)
const orderShort = (day, seq) => mmdd(day) + '-' + pad(seq, 2)
const batchShort = (day, seq) => 'B-' + mmdd(day) + '-' + pad(seq, 2)

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))

// 历史数据兜底：只有 created_at + daily_seq 时，用创建日期拼短号（seq_date 缺失也不影响展示）
function orderShortOf(seqDate, createdAt, seq) {
  const d = (seqDate && String(seqDate).slice(0, 10)) || String(createdAt || '').slice(0, 10)
  return isDay(d) && Number(seq) > 0 ? orderShort(d, Number(seq)) : ''
}
function batchShortOf(seqDate, createdAt, seq) {
  const d = (seqDate && String(seqDate).slice(0, 10)) || String(createdAt || '').slice(0, 10)
  return isDay(d) && Number(seq) > 0 ? batchShort(d, Number(seq)) : ''
}

module.exports = {
  SCOPES, today, nextSeq,
  orderNo, batchNo, orderShort, batchShort,
  orderShortOf, batchShortOf
}
