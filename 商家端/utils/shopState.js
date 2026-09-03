// 店铺营业状态与自动接单：真实后端状态（/api/merchant/shop）
// 本地仅做缓存，设置与读取均以后端为准
const api = require('./api')
const request = require('./request')

const KEY = 'shopInfo'

function cacheShop(shop) {
  if (shop) wx.setStorageSync(KEY, shop)
  return shop
}

function cached() {
  return wx.getStorageSync(KEY) || {}
}

// 从后端拉取店铺状态并缓存；失败时回退本地缓存
async function loadShop() {
  try {
    const shop = await request.get(api.shop)
    return cacheShop(shop)
  } catch (e) {
    return cached()
  }
}

function getBusiness() {
  return cached().business_status || 'open'
}

function isOpen() {
  return getBusiness() === 'open'
}

function getAutoAccept() {
  return !!cached().auto_accept
}

async function setBusiness(val) {
  const business_status = val === 'closed' ? 'closed' : 'open'
  try {
    const shop = await request.put(api.shop, { business_status })
    return cacheShop(shop)
  } catch (e) {
    const s = cached()
    s.business_status = business_status
    return cacheShop(s)
  }
}

async function setAutoAccept(val) {
  const auto_accept = !!val ? 1 : 0
  try {
    const shop = await request.put(api.shop, { auto_accept })
    return cacheShop(shop)
  } catch (e) {
    const s = cached()
    s.auto_accept = auto_accept
    return cacheShop(s)
  }
}

module.exports = { loadShop, getBusiness, isOpen, setBusiness, getAutoAccept, setAutoAccept }
