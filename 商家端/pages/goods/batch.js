// 商品批量录入：两种进货方式，共用后端同一个批量接口
//   ① 粘贴：从 Excel / 表格复制一片区域，长按贴进来，自动按列拆成一行行商品
//   ② 扫码：对着商品条码连着扫，扫一个加一行；库里已录过的会自动带出名称/分类/单位/售价
// 提交后逐行回显结果（新增 / 更新 / 跳过 / 失败+原因），并且只把失败的行留下继续改，不用整批重来。
const api = require('../../utils/api')
const request = require('../../utils/request')
const role = require('../../utils/role')

// 粘贴的列识别：优先认表头行，认不出来就按默认列序。
// 为什么按列名认而不是写死位置：每个人从 Excel 复制的列顺序不一定一样，
// 位置写死的话列一换就整批录错，而且错得没有任何提示。
const COL_WORDS = [
  { key: 'name', words: ['商品名称', '名称', '商品名', '品名'] },
  { key: 'barcode', words: ['商品条码', '条形码', '条码', '编码'] },
  { key: 'category', words: ['商品分类', '分类', '类别'] },
  { key: 'unit', words: ['主单位', '单位'] },
  { key: 'price', words: ['售价', '价格', '单价', '零售价'] },
  { key: 'stock', words: ['库存量', '库存', '数量', '存货'] }
]
const DEFAULT_ORDER = ['name', 'barcode', 'category', 'unit', 'price', 'stock']

// Excel 复制出来是 Tab 分隔；手动从记事本贴的常常是逗号分隔。两种都认。
function splitLine(line) {
  return line.indexOf('\t') > -1 ? line.split('\t') : line.split(',')
}

// 粘贴文本 → 商品行数组。usedHeader 用来给用户一句「已识别表头」的反馈，
// 否则他会猜「我这样贴到底对没对上」。
function parsePaste(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (!lines.length) return { rows: [], usedHeader: false }
  const cells = lines.map(splitLine)
  const hitOf = (h) => COL_WORDS.find((c) => c.words.some((w) => h.indexOf(w) > -1))
  let order = DEFAULT_ORDER
  let start = 0
  const head = cells[0].map((c) => String(c || '').trim())
  const mapped = head.map((h) => { const x = hitOf(h); return x ? x.key : '' })
  const hits = mapped.filter(Boolean).length
  const nonEmpty = head.filter((h) => h !== '').length
  // 表头判定（两种都算）：
  //   a) 命中 2 格以上 —— 列名没全认识也能用，比如「名称/条码/备注」
  //   b) 每一格都是认识的列名 —— 为了照顾「单列粘贴」：表头只有「名称」一格，
  //      按 a 的标准认不出来，表头就会变成一条名叫「名称」的商品，很难看
  // 另外必须认得出名称列，否则认了表头也不知道哪列是商品名。
  if (mapped.indexOf('name') > -1 && (hits >= 2 || (hits >= 1 && hits === nonEmpty))) {
    order = mapped
    start = 1
  }
  const rows = []
  for (let i = start; i < cells.length; i++) {
    const cs = cells[i]
    const r = { name: '', barcode: '', category: '', unit: '', price: '', stock: '' }
    order.forEach((k, ci) => { if (k) r[k] = String(cs[ci] === undefined ? '' : cs[ci]).trim() })
    if (!r.name && !r.barcode && !r.price) continue   // 空行丢掉
    rows.push(r)
  }
  return { rows, usedHeader: start === 1 }
}

// 提交前本地预校验：能一眼看出的问题先在页面上标出来，不浪费一次请求。
// 规则跟后端保持一致（名称必填、价格 0~9999、同一批里条码不重复）——
// 口径不同会出现「这里说没问题、提交后又说失败」的割裂感。
function markRows(rows) {
  const seen = {}
  return rows.map((r, i) => {
    const line = i + 1
    let bad = ''
    const name = String(r.name || '').trim()
    const priceS = String(r.price === undefined || r.price === null ? '' : r.price).trim()
    const p = Number(priceS)
    if (!name) bad = '请填写商品名称'
    else if (priceS === '' || !isFinite(p) || p < 0 || p > 9999) bad = '价格需在 0~9999'
    else {
      const bc = String(r.barcode || '').trim()
      if (bc) {
        if (seen[bc]) bad = '条码与第 ' + seen[bc] + ' 行重复'
        else seen[bc] = line
      }
    }
    return Object.assign({}, r, { line, bad })
  })
}

const RESULT_TEXT = { created: '新增成功', updated: '已更新', skipped: '已跳过', failed: '失败' }

function blankRow() {
  return { name: '', barcode: '', category: '', unit: '', price: '', stock: '99', state: '', resultText: '' }
}

Page({
  data: {
    tab: 'paste',          // paste（表格粘贴）| scan（扫码）
    pasteText: '',
    bulkCategory: '',
    rows: [],              // 待提交商品行
    badCount: 0,
    ifExists: 'skip',      // 条码已存在时：skip 跳过 / update 覆盖更新
    submitting: false,
    summary: null          // 上一次提交的结果摘要
  },

  onLoad() {
    // 新增商品含定价 → 店主专属。店员（如从分享卡片直达）在这里拦下并退回，
    // 否则请求会拿到 403，而 403 会清登录态把人踢回登录页，体验更差。
    if (!role.isOwner()) {
      wx.showToast({ title: '需要店主权限', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
    }
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  onPasteInput(e) { this.setData({ pasteText: e.detail.value }) },

  // 整表重算（行号 + 校验），改完一行、删一行、解析完都要走这里
  refresh(rows) {
    const marked = markRows(rows)
    this.setData({ rows: marked, badCount: marked.filter((x) => x.bad).length })
  },

  // 追加行：分几次贴、边扫边加，攒够了一起提交
  appendRows(list) {
    this.refresh(this.data.rows.concat(list.map((r) => Object.assign(blankRow(), r))))
  },

  doParse() {
    if (!String(this.data.pasteText || '').trim()) {
      return wx.showToast({ title: '请先粘贴内容', icon: 'none' })
    }
    const { rows, usedHeader } = parsePaste(this.data.pasteText)
    if (!rows.length) return wx.showToast({ title: '没解析出商品行', icon: 'none' })
    this.appendRows(rows)
    this.setData({ pasteText: '' })
    wx.showToast({ title: '解析出 ' + rows.length + ' 行' + (usedHeader ? '，已识别表头' : ''), icon: 'none' })
  },

  // 扫一个条码 → 查本地商品表 → 有就整行带出来，没有就只带条码等商家补名称和售价
  scanOne() {
    wx.scanCode({
      scanType: ['barCode', 'qrCode'],
      success: async (res) => {
        const code = String(res.result || '').trim()
        if (!code) return
        if (this.data.rows.some((r) => String(r.barcode || '').trim() === code)) {
          return wx.showToast({ title: '这个条码已在列表里', icon: 'none' })
        }
        wx.showLoading({ title: '查询中' })
        try {
          const d = await request.get(api.goodsByBarcode, { code }, { silent: true })
          if (d && d.found && d.goods) {
            const g = d.goods
            this.appendRows([{
              name: g.name || '',
              barcode: g.barcode || code,
              category: g.category || '',
              unit: g.unit || '',
              price: g.price === undefined || g.price === null ? '' : String(g.price),
              state: 'found',
              resultText: '已识别：库里已有这个商品，提交时按下方「条码已存在时」处理'
            }])
          } else {
            this.appendRows([{
              barcode: code,
              state: 'new',
              resultText: '库里没有这个条码，请补名称和售价'
            }])
          }
        } catch (e) { /* silent 已抑制提示，这里不再弹 */ } finally {
          wx.hideLoading()
        }
      },
      fail: () => { /* 用户取消扫码 */ }
    })
  },

  // 逐字输入时只更新这一格、并清掉这一格自己的错误标记；
  // 整表校验留到失焦时算 —— 否则边打字边飘红，还没输完就提示「价格不合法」。
  onRowField(e) {
    const i = Number(e.currentTarget.dataset.i)
    const field = e.currentTarget.dataset.field
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.detail
    if (!this.data.rows[i]) return
    this.setData({
      ['rows[' + i + '].' + field]: val,
      ['rows[' + i + '].bad']: '',
      ['rows[' + i + '].state']: '',
      ['rows[' + i + '].resultText']: ''
    })
  },

  onRowBlur() { this.refresh(this.data.rows) },

  delRow(e) {
    const i = Number(e.currentTarget.dataset.i)
    const rows = this.data.rows.slice()
    rows.splice(i, 1)
    this.refresh(rows)
  },

  clearAll() {
    if (!this.data.rows.length) return
    wx.showModal({
      title: '清空列表',
      content: '确定清空当前 ' + this.data.rows.length + ' 行吗？',
      success: (r) => {
        if (r.confirm) { this.refresh([]); this.setData({ summary: null }) }
      }
    })
  },

  onBulkCategory(e) { this.setData({ bulkCategory: e.detail.value }) },

  // 统一分类：整批进货常常同一个分类，一行行填太烦。只填给还没填分类的行，不覆盖已填的。
  applyBulkCategory() {
    const cat = String(this.data.bulkCategory || '').trim()
    if (!cat) return wx.showToast({ title: '请先输入分类名', icon: 'none' })
    const rows = this.data.rows.map((r) => (String(r.category || '').trim() ? r : Object.assign({}, r, { category: cat })))
    this.refresh(rows)
    wx.showToast({ title: '已填入未设分类的行', icon: 'none' })
  },

  onIfExists(e) { this.setData({ ifExists: e.detail.value ? 'update' : 'skip' }) },

  async submit() {
    const rows = markRows(this.data.rows)
    const bad = rows.filter((r) => r.bad)
    this.setData({ rows, badCount: bad.length })
    if (!rows.length) return wx.showToast({ title: '还没有要录入的商品', icon: 'none' })
    if (bad.length) {
      return wx.showModal({
        title: '还有 ' + bad.length + ' 行没填对',
        content: '第 ' + bad.slice(0, 8).map((r) => r.line).join('、') + (bad.length > 8 ? ' 等' : '') + ' 行已在列表里标红，改完再提交。',
        showCancel: false
      })
    }
    const items = rows.map((r) => ({
      name: String(r.name || '').trim(),
      barcode: String(r.barcode || '').trim(),
      category: String(r.category || '').trim(),
      unit: String(r.unit || '').trim(),
      price: Number(String(r.price).trim()),
      stock: String(r.stock === undefined || r.stock === null || r.stock === '' ? '99' : r.stock).trim()
    }))
    this.setData({ submitting: true })
    try {
      const res = await request.post(api.goodsBatch, { items, if_exists: this.data.ifExists })
      const by = {}
      ;(res.results || []).forEach((x) => { by[x.index] = x })
      const marked = rows.map((r, i) => {
        const x = by[i]
        if (!x) return r
        const badge = x.result === 'created' ? 'ok' : x.result === 'updated' ? 'upd' : x.result === 'skipped' ? 'skip' : 'fail'
        return Object.assign({}, r, {
          state: badge,
          resultText: (RESULT_TEXT[x.result] || x.result) + (x.reason ? '：' + x.reason : '')
        })
      })
      const left = marked.filter((r) => r.state === 'fail')
      this.setData({ summary: res })
      if (left.length) {
        // 只留失败的行：成功的已经入库，留着再提交一次会被当「已存在」跳过，反而看不清
        this.refresh(left)
        wx.showToast({
          title: '成功 ' + (res.created + res.updated) + ' 条，' + left.length + ' 条待修改',
          icon: 'none',
          duration: 3000
        })
      } else {
        this.refresh([])
        wx.showModal({
          title: '录入完成',
          content: '新增 ' + res.created + ' 条，更新 ' + res.updated + ' 条，跳过 ' + res.skipped + ' 条。' +
            (res.skipped ? '跳过的都是条码已存在的商品；想覆盖它们，把「条码已存在时」改成「更新」再提交一次。' : ''),
          showCancel: false
        })
      }
    } catch (e) {
      /* 请求封装已经弹过提示（失败原因逐条在 msg 里） */
    } finally {
      this.setData({ submitting: false })
    }
  }
})
