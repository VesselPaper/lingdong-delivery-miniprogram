/* ============================================================
 * mapRecon.js —— 大屏「3D 图层重构」数据持久化（服务器端）
 * ------------------------------------------------------------
 * 背景：重构成果（楼栋/道路微调、新增/删除、改名）原先只存浏览器 localStorage
 *       （dash3d_recon），换设备就丢。这里把它升级为**服务器端真实数据**：
 *       存到 backend/data/map-recon.json，任何人打开大屏都读到同一份，编辑即持久。
 *
 * 数据形态与前端 window.MAP_DEFAULT_RECON / localStorage dash3d_recon 完全一致：
 *   { global, bld, road, delRoads, addRoads, delBlds, addBlds, bldNames, roadNames, roadCls, bldHeight }
 *
 * 只负责读写文件 + 基本结构兜底；不校验各字段的业务语义（由前端保证）。
 * 读失败/无文件时返回 null，由前端回退内置默认新地图。
 * ============================================================ */
'use strict'

const fs = require('fs')
const path = require('path')

const FILE = process.env.DASHBOARD_RECON_FILE
  ? path.resolve(process.env.DASHBOARD_RECON_FILE)
  : path.join(__dirname, '..', 'data', 'map-recon.json')

let cached = null   // 内存缓存，避免每次请求都读盘
let cachedAt = 0
const CACHE_MS = 500

module.exports = {
  // 读取服务器端重构数据；无数据/损坏返回 null
  get() {
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached
    cached = null
    cachedAt = Date.now()
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
      if (j && typeof j === 'object') cached = j
    } catch (e) { /* 首次运行尚无文件或损坏 */ }
    return cached
  },

  // 整体替换。返回 { ok, msg }。
  replace(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, msg: '数据格式不合法，需要 JSON 对象' }
    }
    try {
      const dir = path.dirname(FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8')
    } catch (e) {
      return { ok: false, msg: '写入失败：' + e.message }
    }
    cached = data
    cachedAt = Date.now()
    return { ok: true, msg: '已保存到服务器' }
  },

  // 清空服务器端记录（回退内置默认）。仅作运维入口，一般不用。返回 { ok }。
  clear() {
    cached = null
    cachedAt = Date.now()
    try {
      if (fs.existsSync(FILE)) fs.unlinkSync(FILE)
    } catch (e) { return { ok: false, msg: '删除失败：' + e.message } }
    return { ok: true }
  },

  // 仅路由调试用
  file() { return FILE }
}