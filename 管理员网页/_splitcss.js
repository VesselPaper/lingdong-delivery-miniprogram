'use strict'
const fs = require('fs')
const path = require('path')
const base = 'D:/01_Code/Personal/Software/送餐无人车/校内快递配送机器人/管理员网页/'
const all = fs.readFileSync(base + 'admin.css', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
// 行号区间(1-based, 含首尾也必须连续有序) → 0-based 索引区间
const ranges = {
  'css/base.css': [[1, 121]],
  'css/components.css': [[123, 378], [401, 417], [484, 568]],
  'css/map.css': [[380, 400], [419, 482]],
}
for (const f of Object.keys(ranges)) {
  const lines = []
  for (const [a, b] of ranges[f]) {
    for (let i = a - 1; i <= b - 1; i++) lines.push(all[i])
  }
  const dir = path.dirname(path.join(base, f))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(base, f), lines.join('\n') + '\n')
  console.log(f, '->', lines.length, '行')
}
// 自检：三文件行数之和 + 每文件行号总数是否覆盖被分配的区间
let total = 0
for (const f of Object.keys(ranges)) {
  total += ranges[f].reduce((s, [a, b]) => s + (b - a + 1), 0)
}
console.log('分配区间总行数 =', total, '(admin.css 共', all.length, '行)')