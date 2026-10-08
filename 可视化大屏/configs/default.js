/* ============================================================
 * configs/default.js — 默认大屏配置（单租户占位 / 通用模板）
 * ------------------------------------------------------------
 * 为「多学校 / 多商家」做的可扩展入口。每新增一个学校/商家，就新增
 * 一份 configs/<key>.js 并复制本模板中的「差异项」。
 *   - key     租户标识：URL ?tenant=<key> 或后端注入 window.__TENANT 选择
 *   - product 商户品牌：标题/口号/铺子名
 *   - brand   主题/皮肤（未来可替换 styles/*.css 或注入色板）
 *   - modules 要启用的大屏模块（未启用则不加载对应 ui/ 组件）
 *   - map     底图源、是否开重新构面板等地图相关开关
 *   - 说明     未来接各校坐标标定/数据源时在此扩展 data/api/baseUrl 字段
 *
 * 注意：本文件是纯声明，不驱动现有代码（当前代码仍用硬编码值），
 *       作为「未来扩展预订点」。接入时只需让 app/boot-config.js 读取
 *       对应键并替换引用即可。
 * ============================================================ */
window.DASH_TENANT_CONFIG = {
  key: 'default',
  product: {
    name: '零栋无人送餐',
    slogan: '零栋掌上送餐 · 校园即时配送',
    shopName: '零栋铺子',
    campus: '四川师范大学成龙校区'
  },
  brand: {
    theme: 'zygarde',            // 皮肤标识（对应未来 styles/<theme>.css）
    primary: '#16c7ff'
  },
  modules: [
    'clock',
    'metrics',
    'robots',
    'batches',
    'alerts',
    'events',
    'map3d',
    'recon'                     // 3D 图层重构面板
  ],
  map: {
    provider: 'tianditu',        // 底图源（与 dashboard/map.js 的 TILE_PROVIDER 对应）
    reconEnabled: true
  },
  data: {
    // 未来多租户：每校一份 baseUrl / 标定(scale_px_per_m, origin…)
    //  exampleSchool: { apiBase: '/api/', scalePxPerM: 19.45 }
  }
}