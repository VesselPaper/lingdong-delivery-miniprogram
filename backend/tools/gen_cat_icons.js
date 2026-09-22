// 首页分类「彩色扁平插画」图标生成器
// 风格参考淘宝/京东首页金刚区：实心多色扁平插画（主色 + 暗部 + 高光），无描边、无渐变。
// 作用：把下列 SVG 烘成 base64 data-URI，写入 用户端/pages/index/cat-icons.wxss。
// 用法：node backend/tools/gen_cat_icons.js
'use strict'
const fs = require('fs')
const path = require('path')

// 统一 96x96 画布；每张图只用「主色 / 暗部 / 高光 / 奶白」四类色，保证成套一致
const ICONS = {
  // 面包糕点：吐司面包（顶皮高光 + 斜纹）
  bread: `<path d="M20 40c0-12 8-20 21-20h14c13 0 21 8 21 20v28c0 6-4 10-10 10H30c-6 0-10-4-10-10z" fill="#EFB25C"/><path d="M20 40c0-12 8-20 21-20h14c13 0 21 8 21 20 0 5-4 8-10 8H30c-6 0-10-3-10-8z" fill="#FFD9A0"/><path d="M55 20h-4v58h4c6 0 10-4 10-10V40c0-11-4-20-10-20z" fill="#DB9840" opacity=".45"/><path d="M32 32l7-7M44 32l7-7M56 32l7-7" stroke="#DB9840" stroke-width="3.4" stroke-linecap="round" fill="none"/>`,
  // 方便面/面/饭：白碗 + 面 + 筷子
  noodle: `<path d="M16 48h64c0 20-14 33-32 33S16 68 16 48z" fill="#F2F7FD"/><path d="M48 48h32c0 20-14 33-32 33-3 0-7-.5-10-1.6C49 72 55 61 55 48z" fill="#D6E4F3" opacity=".9"/><rect x="12" y="43" width="72" height="9" rx="4.5" fill="#C9DDF0"/><path d="M27 43c2-9 10-15 21-15s19 6 21 15z" fill="#F7C948"/><path d="M48 28c11 0 19 6 21 15H48z" fill="#E8B22F" opacity=".5"/><path d="M58 12l13 30" stroke="#C08A50" stroke-width="4.5" stroke-linecap="round"/><path d="M69 13l9 29" stroke="#D19C60" stroke-width="4.5" stroke-linecap="round"/>`,
  // 饼干零食：巧克力豆曲奇
  cookie: `<circle cx="48" cy="48" r="30" fill="#D9A05B"/><path d="M48 18a30 30 0 0 1 30 30 30 30 0 0 1-17.5 27.3A30 30 0 0 0 48 18z" fill="#C98A45" opacity=".45"/><circle cx="35" cy="41" r="4.6" fill="#7A4B2A"/><circle cx="56" cy="35" r="4.1" fill="#7A4B2A"/><circle cx="45" cy="59" r="4.6" fill="#7A4B2A"/><circle cx="62" cy="55" r="3.6" fill="#7A4B2A"/><circle cx="31" cy="57" r="3.6" fill="#7A4B2A"/>`,
  // 即食卤味：卤鸡腿（斜置椭圆肉 + 加粗骨头）
  meat: `<ellipse cx="58" cy="38" rx="20" ry="16" transform="rotate(-30 58 38)" fill="#C4703A"/><ellipse cx="54" cy="31" rx="9" ry="5.5" transform="rotate(-30 54 31)" fill="#DE8F55" opacity=".95"/><path d="M42 50 22 68" stroke="#FFF3E0" stroke-width="10" stroke-linecap="round"/><circle cx="19" cy="71" r="8" fill="#FFF3E0"/><circle cx="19" cy="71" r="3.4" fill="#E8D9C0"/>`,
  // 纸品洗护：抽纸盒
  tissue: `<path d="M20 42h56v32c0 4-3 7-7 7H27c-4 0-7-3-7-7z" fill="#6FB98A"/><path d="M48 42h28v32c0 4-3 7-7 7H48z" fill="#5AA276" opacity=".4"/><path d="M20 42h56v9H20z" fill="#8ED0A6"/><path d="M32 42c0-9 7-13 16-13s16 4 16 13z" fill="#FFFFFF"/><path d="M48 29c9 0 16 4 16 13H48z" fill="#E8F2EC"/><rect x="27" y="58" width="18" height="4.5" rx="2.2" fill="#FFFFFF" opacity=".75"/>`,
  // 饮品：奶茶杯（圆顶盖 + 吸管 + 杯身暗部，避免白杯在浅底上看不见）
  drink: `<path d="M29 36h38l-4.5 42c-.3 3-3 5.5-6 5.5H39.5c-3 0-5.7-2.5-6-5.5z" fill="#F7E7CE"/><path d="M48 36h19l-4.5 42c-.3 3-3 5.5-6 5.5H48z" fill="#E8D2B0" opacity=".8"/><path d="M48 78h8.5c3 0 5.7-2.5 6-5.5L66 36H48z" fill="#E8C89A" opacity=".55"/><path d="M27 36a21 21 0 0 1 42 0z" fill="#4FA8DC"/><path d="M48 15a21 21 0 0 1 21 21H48z" fill="#3E93C6" opacity=".5"/><path d="M57 10l-7 22" stroke="#E8703A" stroke-width="5" stroke-linecap="round"/>`,
  // 水果：苹果
  fruit: `<path d="M48 32c7-8 21-9 27 1 7 12 1 30-7 38-5 5-11 6-16 3-2-1-6-1-8 0-5 3-11 2-16-3-8-8-14-26-7-38 6-10 20-9 27-1z" fill="#E8604F"/><path d="M48 32c5-6 13-8 20-5-7 1-13 5-16 10-1-2-2-4-4-5z" fill="#F5806F"/><path d="M51 30c-1-6 1-10 5-13" stroke="#8A5A32" stroke-width="4" stroke-linecap="round"/><path d="M58 20c5-7 14-6 16 1-7 4-14 2-16-1z" fill="#5FA96B"/>`,
  // 冰/雪糕：甜筒
  icecream: `<path d="M30 46h36L51 80c-1.2 3-4.8 3-6 0z" fill="#E0A85C"/><path d="M48 46h18L51 80c-1.2 3-4.8 3-6 0z" fill="#C98A45" opacity=".5"/><path d="M33 55l30-6M36 63l24-5M39 71l18-4" stroke="#C98A45" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M30 46a18 18 0 0 1 36 0z" fill="#F2A0B8"/><path d="M48 28a18 18 0 0 1 18 18H48z" fill="#E88AA6" opacity=".5"/><circle cx="40" cy="36" r="4.2" fill="#FFC6D6" opacity=".85"/>`,
  // 礼/套餐：礼盒
  gift: `<rect x="20" y="44" width="56" height="32" rx="4" fill="#E8604F"/><path d="M48 44h28v32a4 4 0 0 1-4 4H48z" fill="#D2564E" opacity=".45"/><rect x="16" y="33" width="64" height="15" rx="4" fill="#F5806F"/><rect x="42" y="33" width="12" height="43" fill="#FFD79B"/><path d="M48 33c-6-9-17-11-19-4s7 11 19 4z" fill="#FFD79B"/><path d="M48 33c6-9 17-11 19-4s-7 11-19 4z" fill="#FFD79B"/>`,
  // 兜底：店铺门头
  store: `<path d="M20 42h56v36c0 3-2 5-5 5H25c-3 0-5-2-5-5z" fill="#7FB3E0"/><path d="M48 42h28v36c0 3-2 5-5 5H48z" fill="#639AD1" opacity=".5"/><path d="M17 26h62l4 15H13z" fill="#E8604F"/><path d="M22 26h10l-2.5 15H15zM42 26h10l-2.5 15H35zM62 26h10l-2.5 15H55z" fill="#FFFFFF" opacity=".85"/><rect x="38" y="57" width="20" height="26" rx="2.5" fill="#FFF3E0"/>`
}

// 每张图的配色（用于预览/文档）；实际颜色已烘进 SVG
const PALETTE = {
  bread: '#EFB25C', noodle: '#F7C948', cookie: '#D9A05B', meat: '#C4703A', tissue: '#6FB98A',
  drink: '#4FA8DC', fruit: '#E8604F', icecream: '#F2A0B8', gift: '#E8604F', store: '#7FB3E0'
}

function svgOf(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" fill="none">${body}</svg>`
}

const lines = []
lines.push('/* 首页分类彩色扁平插画图标（SVG data-URI）——由 backend/tools/gen_cat_icons.js 生成，勿手改 */')
lines.push('/* 风格：淘宝/京东首页金刚区式实心多色扁平插画，无描边无渐变 */')
lines.push('.cat-ic {')
lines.push('  width: 52rpx;')
lines.push('  height: 52rpx;')
lines.push('  background-repeat: no-repeat;')
lines.push('  background-position: center;')
lines.push('  background-size: contain;')
lines.push('}')
for (const [name, body] of Object.entries(ICONS)) {
  const b64 = Buffer.from(svgOf(body), 'utf8').toString('base64')
  lines.push(`.cat-ic-${name} { background-image: url("data:image/svg+xml;base64,${b64}"); }`)
}

const out = path.join(__dirname, '..', '..', '用户端', 'pages', 'index', 'cat-icons.wxss')
fs.writeFileSync(out, lines.join('\n') + '\n')
console.log('written ' + out + ' (' + Object.keys(ICONS).length + ' icons, ' + fs.statSync(out).size + ' bytes)')
module.exports = { ICONS, PALETTE, svgOf }
