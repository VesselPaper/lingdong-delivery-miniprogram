// 外部条码库查询适配器（可替换的一个小模块）。
//
// 用途：商家扫到一个「本地商品表里没有的条码」时，去外部把这个商品的基础信息
// （名称/分类/主单位/售价）查回来，自动填进批量录入页，店员就不用一个字一个字敲了。
//
// 为什么单独放一个文件：商铺那边（③）的接口还没拿到。把调用点先固定在这里，
// 接口到位后只改这一个文件 —— 把 lookupByBarcode 内部换成真实请求即可，
// 路由（GET /merchant/goods/by-barcode）、前端页面、返回结构统统不用动。
//
// 约定返回结构（接口到位后必须照这个形状返回，其它代码依赖它）：
//   查到 → { ok: true, source: 'shop' | 'thirdparty', goods: { name, category, unit, price, barcode, image? } }
//   查不到/未接入/上游报错 → { ok: false, msg: '原因（会原样显示给商家）' }
//
// 对接时要向对方确认的字段：条码、名称、分类、主单位、售价、规格、图片，
// 以及鉴权方式（appid/secret？签名？token 有效期）和调用频率上限。
async function lookupByBarcode(barcode) {
  const code = String(barcode === undefined || barcode === null ? '' : barcode).trim()
  if (!code) return { ok: false, msg: '缺少条码' }
  // 占位实现：永远查不到。前端收到后会退化成「条码已带上、请手动填写名称和价格」，
  // 也就是没有外部库时扫码依然可用，只是不能自动识别全新商品。
  return { ok: false, msg: '未接入外部条码库，请手动填写商品信息' }
}

module.exports = { lookupByBarcode }
