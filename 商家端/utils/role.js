// 商家角色工具（2026-09-24 起：账号体系，店主 owner / 店员 staff）
// 读本地缓存的 userInfo.merchant_role（登录时由后端下发）；页面 onShow 时刷新到 data.isOwner。
function currentUser() {
  try { return wx.getStorageSync('userInfo') || {} } catch (e) { return {} }
}
function isOwner() {
  return currentUser().merchant_role === 'owner'
}
function isStaff() {
  return currentUser().merchant_role === 'staff'
}
module.exports = { currentUser, isOwner, isStaff }
