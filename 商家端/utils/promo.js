// 活动优惠文案（商家端列表卡片、编辑页实时预览、用户端活动页共用一套口径）
// 之所以抽出来：同一份优惠在「列表页显示什么」和「编辑页预览什么」如果各写一套，
// 迟早出现列表写"8.5 折"、预览写"85%"这种同一活动两个说法的问题。

// 把折扣乘数(0.85) 说成「8.5 折」
function zheText(discount) {
  const d = Number(discount)
  if (!(d > 0) || !(d < 1)) return ''
  return String((d * 10).toFixed(1)).replace(/\.0$/, '')
}

// 活动的一句话优惠摘要。无配置/不合法时给明确兜底文案，不返回空串
// ——空串会让卡片那一行直接消失，商家以为漏了字段。
function summarize(activity) {
  const a = activity || {}
  const cfg = parseConfig(a.config)
  if (a.type === 'discount') {
    const zhe = zheText(cfg.discount)
    if (!zhe) return '折扣未设置'
    const scope = cfg.scope === 'goods' ? ('指定 ' + ((cfg.goods_ids || []).length) + ' 件商品') : '全场商品'
    return zhe + ' 折 · ' + scope
  }
  if (a.type === 'full_reduce') {
    const tiers = (Array.isArray(cfg.tiers) ? cfg.tiers : [])
      .filter((t) => Number(t.threshold) > 0 && Number(t.reduce) > 0)
      .sort((x, y) => Number(x.threshold) - Number(y.threshold))
    if (!tiers.length) return '满减未设置'
    return tiers.map((t) => '满' + t.threshold + '减' + t.reduce).join(' / ')
  }
  return '图片展示入口'
}

// config 的形态取决于调用方：后端商家端活动接口回的是**库里的 JSON 字符串**，
// 用户端接口（listActivitiesTyped）回的是**已解析对象**。这里统一收口，
// 否则「库里明明是 9 折，列表却显示折扣未设置」这类问题会反复出现。
function parseConfig(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const o = JSON.parse(String(raw))
    return o && typeof o === 'object' ? o : {}
  } catch (e) {
    return {}
  }
}

module.exports = { summarize, zheText, parseConfig }
