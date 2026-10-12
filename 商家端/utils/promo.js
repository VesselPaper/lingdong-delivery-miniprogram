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

// ---------- 优惠券文案（商家端列表卡片、编辑页预览共用一套口径） ----------
// 与后端 services/coupon.js 的 describe() 保持同一说法：同一张券在商家端和用户端看到的规则必须一致，
// 否则会出现「商家以为满30减5、用户看到的是满30减3」这种对不上账的投诉。

// 金额去掉多余的两位小数：5.00 → 5
function money(v) {
  return Number(Number(v) || 0).toFixed(2).replace(/\.00$/, '')
}

// 券的一句话规则文案
function couponRule(c) {
  const o = c || {}
  const t = o.type || 'full_reduce'
  if (t === 'discount') {
    const zhe = zheText(o.discount)
    if (!zhe) return '折扣未设置'
    return zhe + '折' + (Number(o.max_reduce) > 0 ? '（最高减¥' + money(o.max_reduce) + '）' : '')
  }
  if (t === 'no_threshold') {
    return Number(o.reduce) > 0 ? '无门槛减¥' + money(o.reduce) : '抵扣金额未设置'
  }
  return Number(o.reduce) > 0 ? '满¥' + money(o.threshold) + '减¥' + money(o.reduce) : '满减未设置'
}

// 适用范围：scope_ids 在库里是 JSON 字符串（商家端接口回原始行），也可能已被解析成数组
function parseIds(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  if (!raw) return []
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v.map(String) : []
  } catch (e) {
    return []
  }
}

function couponScope(c) {
  const o = c || {}
  const n = parseIds(o.scope_ids).length
  if (o.scope === 'goods') return '指定 ' + n + ' 件商品'
  if (o.scope === 'category') return '指定 ' + n + ' 个分类'
  return '全场通用'
}

// 有效期：相对有效期按「领取后 N 天」算，绝对有效期给日期区间
function couponValid(c) {
  const o = c || {}
  if (o.valid_type === 'relative') {
    const d = Number(o.relative_days) || 0
    return d > 0 ? '领取后 ' + d + ' 天内有效' : '有效期未设置'
  }
  const s = o.start_at ? String(o.start_at).slice(0, 10) : ''
  const e = o.end_at ? String(o.end_at).slice(0, 10) : ''
  if (!s && !e) return '长期有效'
  return (s || '不限') + ' ~ ' + (e || '不限')
}

module.exports = {
  summarize, zheText, parseConfig,
  money, couponRule, couponScope, couponValid, parseIds
}
