// 当前店铺上下文（多店铺一期，2026-10-23，见 doc/16_小程序扩容方案.md）
// ------------------------------------------------------------
// 一期只有一个"当前店铺"的概念：用户端所有按店取数据的接口（商品、分类、活动、券、店铺状态）
// 都带上 shop_id；没带时后端按 1 号店处理 —— 这也是老版本小程序的兼容路径。
//
// 为什么把它收在一个文件里：店铺 id 会出现在首页、商城、详情、结算、订单五处，
// 每处各写一遍 wx.getStorageSync 必然出现"首页 1 号店、商城 2 号店"的串店 bug。

const request = require('./request')
const api = require('./api')

const KEY = 'current_shop_id'     // 本地记住的当前店铺（切店后一直生效）
const LIST_KEY = 'shop_list'      // 店铺列表缓存（首页/商城每次进都要，不重复请求）
const DEFAULT_SHOP_ID = 1

function normalize(id) {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SHOP_ID
}

function getShopId() {
  try {
    return normalize(wx.getStorageSync(KEY))
  } catch (e) {
    return DEFAULT_SHOP_ID
  }
}

function setShopId(id) {
  const v = normalize(id)
  try { wx.setStorageSync(KEY, v) } catch (e) { /* 忽略 */ }
  return v
}

// 给接口参数补上 shop_id（GET 走 query，POST 走 body，request.js 两者都接受 data）
function withShop(data) {
  return Object.assign({}, data || {}, { shop_id: getShopId() })
}

// 店铺列表：先给缓存（首屏不闪），需要最新时传 force
async function loadShops(force) {
  if (!force) {
    try {
      const cached = wx.getStorageSync(LIST_KEY)
      if (Array.isArray(cached) && cached.length) return cached
    } catch (e) { /* 忽略 */ }
  }
  const list = (await request.get(api.shopList, {}, { needAuth: false, silent: true })) || []
  try { wx.setStorageSync(LIST_KEY, list) } catch (e) { /* 忽略 */ }
  return list
}

// 当前店铺对象；店铺已下线（列表里没有）时回退列表第一家，避免停在一家不存在的店
function pickCurrent(list) {
  const shops = Array.isArray(list) ? list : []
  const id = getShopId()
  const hit = shops.find((s) => normalize(s.id) === id)
  if (hit) return hit
  if (shops.length) {
    setShopId(shops[0].id)
    return shops[0]
  }
  return { id: DEFAULT_SHOP_ID, name: '', business_status: 'open', delivery_fee: 1 }
}

function clearCache() {
  try { wx.removeStorageSync(LIST_KEY) } catch (e) { /* 忽略 */ }
}

// 勾选商品 → 单店校验。一期一辆车一趟只去一家店取货（见 doc/16 §七），
// 所以混店结算必须挡在结算页之前，并且说清是哪几家店，而不是让后端回一句
// 「商品不属于该店铺」——那句话用户看不懂。
// 返回 { ok, shopId, names }；ok=false 时 names 是涉及到的店名。
function singleShopOf(items) {
  const ids = []
  const names = []
  ;(items || []).forEach((it) => {
    const sid = normalize(it && it.shop_id)
    if (ids.indexOf(sid) === -1) {
      ids.push(sid)
      names.push((it && it.shop_name) || ('店铺' + sid))
    }
  })
  return { ok: ids.length <= 1, shopId: ids[0] || getShopId(), names }
}

// 进结算页的统一入口：勾选商品 → 单店校验 → 写 storage（刷新结算页能恢复）→ 跳转
// 商城页、首页底部栏、购物车页三处都走这里，避免各写一份「混店怎么办」。
function toConfirm(items, onMixed) {
  const r = singleShopOf(items)
  if (!r.ok) {
    if (typeof onMixed === 'function') onMixed(r.names)
    else {
      wx.showModal({
        title: '需要分开下单',
        content: '「' + r.names.join('」「') + '」的商品不能一起结算：一次配送只去一家店取货。请只勾选同一家店的商品。',
        showCancel: false,
        confirmText: '知道了'
      })
    }
    return false
  }
  wx.setStorageSync('checkout_items', (items || []).map((it) => ({ goods_id: it.goods_id, quantity: it.quantity })))
  wx.setStorageSync('checkout_shop_id', r.shopId)
  wx.navigateTo({ url: '/pages/order/confirm?shop_id=' + r.shopId })
  return true
}

module.exports = {
  DEFAULT_SHOP_ID,
  getShopId,
  setShopId,
  withShop,
  loadShops,
  pickCurrent,
  clearCache,
  singleShopOf,
  toConfirm
}
