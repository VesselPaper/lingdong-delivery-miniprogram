// coupon 域路由（薄路由壳）：券管理（商家端）+ 领券/我的券（用户端）+ 结算可用券
// 由 server.js 挂载到 /api 前缀（URL 与端口不变）。
// 本域只读写 coupons / user_coupons 两张表；结算算券时跨域**只读** goods（取价格与分类）。

const express = require('express')
const { createShared } = require('../_shared')
const q = require('./queries')
const service = require('./service')

module.exports = (store, deps) => {
  const { auth, ownerGuard, audit, ok } = createShared(store)
  const router = express.Router()

  // ---------- 用户端 ----------
  // 可领券列表：要登录才准（mine_count 需要知道「我已领几张」，未登录无从判断）
  router.get('/coupon/list', auth, (req, res) => ok(res, service.listForUser(store, req.user.id)))

  router.post('/coupon/receive', auth, (req, res) => {
    const r = service.receive(store, req.user.id, (req.body || {}).coupon_id)
    if (r.error) return res.status(400).json({ code: 400, msg: r.error })
    ok(res, r.data)
  })

  router.get('/coupon/mine', auth, (req, res) => ok(res, service.myList(store, req.user.id)))

  // 结算页：传当前勾选商品 → 可用券 / 不可用券（含原因） / 最优推荐
  router.post('/coupon/usable', auth, (req, res) => {
    const items = (req.body || {}).items || []
    ok(res, service.usableFor(store, req.user.id, items))
  })

  // ---------- 商家端（店主专属，与活动管理同级） ----------
  router.get('/merchant/coupons', ownerGuard, (req, res) => ok(res, q.listAll(store)))

  router.post('/merchant/coupons', ownerGuard, (req, res) => {
    const n = service.normalizeCoupon(req.body)
    if (n.error) return res.status(400).json({ code: 400, msg: n.error })
    const id = q.insert(store, n.value)
    audit(req, 'coupon/create', 'coupon#' + id, 'title=' + n.value.title + ' type=' + n.value.type)
    ok(res, { id })
  })

  router.put('/merchant/coupons', ownerGuard, (req, res) => {
    const id = Number((req.body || {}).id)
    if (!id) return res.status(400).json({ code: 400, msg: '缺少券ID' })
    const cur = q.findById(store, id)
    if (!cur) return res.status(404).json({ code: 404, msg: '优惠券不存在' })
    // 用库里的值兜底，前端只传变化字段也不会把其它字段清空
    const n = service.normalizeCoupon(Object.assign({}, cur, req.body))
    if (n.error) return res.status(400).json({ code: 400, msg: n.error })
    q.update(store, id, n.value)
    audit(req, 'coupon/update', 'coupon#' + id, 'title=' + n.value.title)
    ok(res)
  })

  // 启用/停用：停用后用户不能再领，已领的券在结算时判定为不可用
  router.put('/merchant/coupons/status', ownerGuard, (req, res) => {
    const { id, status } = req.body || {}
    if (!id) return res.status(400).json({ code: 400, msg: '缺少券ID' })
    q.updateStatus(store, id, status)
    audit(req, 'coupon/status', 'coupon#' + id, 'status=' + Number(status))
    ok(res)
  })

  // 删除券模板（已发的用户券记录保留，但因其模板不存在会判定为不可用）
  router.delete('/merchant/coupons', ownerGuard, (req, res) => {
    const id = Number((req.body || {}).id)
    if (!id) return res.status(400).json({ code: 400, msg: '缺少券ID' })
    q.remove(store, id)
    audit(req, 'coupon/delete', 'coupon#' + id, '')
    ok(res)
  })

  return router
}
