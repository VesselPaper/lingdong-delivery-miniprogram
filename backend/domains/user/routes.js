// user 域路由（薄路由壳）：登录 / 资料 / 购物车 / 地址
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// 归属依据（05 方案）：只读写 users / addresses / cart 三张表（cart/list 跨 goods 只读 JOIN 除外）。

const express = require('express')
const { createShared } = require('../_shared')
const q = require('./queries')
const service = require('./service')

module.exports = (store, deps) => {
  const { auth, ok } = createShared(store)
  const router = express.Router()

  // ---------- 登录 ----------
  // 【临时放开】测试阶段暂不校验邀请码：商家端(client=merchant)登录即授予商家角色，方便联调；
  // 恢复邀请码校验时取消 service.js 内对应注释即可。
  router.post('/auth/login', async (req, res) => {
    const { code } = req.body || {}
    if (!code) return res.status(400).json({ code: 400, msg: '缺少登录凭证' })
    const r = await service.login(store, deps, req.body)
    if (r.error) return res.status(r.error.status).json({ code: r.error.status, msg: r.error.msg })
    ok(res, r.data)
  })

  // ---------- 用户资料 ----------
  router.get('/user/profile', auth, (req, res) => ok(res, req.user))

  router.put('/user/profile', auth, (req, res) => {
    q.updateProfile(store, req.user.id, req.body.nickname, req.body.phone)
    ok(res, q.findById(store, req.user.id))
  })

  // ---------- 购物车 ----------
  router.get('/cart/list', auth, (req, res) => ok(res, q.cartList(store, req.user.id)))

  router.post('/cart/add', auth, (req, res) => {
    const { goods_id, quantity = 1 } = req.body || {}
    const exist = q.cartFind(store, req.user.id, goods_id)
    if (exist) {
      q.cartAddQty(store, exist.id, quantity)
    } else {
      q.cartInsert(store, req.user.id, goods_id, quantity)
    }
    ok(res)
  })

  router.put('/cart/update', auth, (req, res) => {
    const { id, quantity, selected } = req.body || {}
    if (quantity !== undefined) q.cartUpdateQty(store, id, quantity, req.user.id)
    if (selected !== undefined) q.cartUpdateSelected(store, id, selected, req.user.id)
    ok(res)
  })

  router.delete('/cart/remove', auth, (req, res) => {
    q.cartRemove(store, req.body.id, req.user.id)
    ok(res)
  })

  // ---------- 地址 ----------
  router.get('/address/list', auth, (req, res) => ok(res, q.addressList(store, req.user.id)))

  router.post('/address/save', auth, (req, res) => {
    const { id, contact_name, contact_phone, landmark_id, landmark_name, detail, is_default } = req.body || {}
    // landmark_id 显式转字符串存储（node:sqlite 把整数绑定到 TEXT 列会存成 "2.0"，导致与点位 id 无法字符串匹配）
    const lmId = landmark_id === undefined || landmark_id === null ? '' : String(landmark_id)
    if (is_default) q.clearDefault(store, req.user.id)
    if (id) {
      q.addressUpdate(store, id, req.user.id, { contact_name, contact_phone, lmId, landmark_name, detail, is_default })
    } else {
      q.addressInsert(store, req.user.id, { contact_name, contact_phone, lmId, landmark_name, detail, is_default })
    }
    ok(res)
  })

  router.delete('/address/delete', auth, (req, res) => {
    q.addressDelete(store, req.body.id, req.user.id)
    ok(res)
  })

  return router
}
