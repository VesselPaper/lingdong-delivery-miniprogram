// user 域路由（薄路由壳）：登录 / 资料 / 购物车 / 地址
// 路由工厂：module.exports = (store, deps) => router；由 server.js 挂载到 /api 前缀（URL 不变）。
// 归属依据（05 方案）：只读写 users / addresses / cart 三张表（cart/list 跨 goods 只读 JOIN 除外）。

const express = require('express')
const path = require('path')
const fs = require('fs')
const { createShared } = require('../_shared')
const q = require('./queries')
const service = require('./service')

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads')

// 头像只接受位图；上限 2MB（微信 chooseAvatar 返回的是已裁剪的小图，正常远小于此）
const AVATAR_EXT = ['.jpg', '.jpeg', '.png', '.webp']
const AVATAR_MAX = 2 * 1024 * 1024

module.exports = (store, deps) => {
  const { auth, ok } = createShared(store)
  const router = express.Router()

  // ---------- 登录 ----------
  // 邀请码（按商家一条、首绑 openid、可吊销）+ 登录限流（防暴力试码）都在 service.login 内。
  router.post('/auth/login', async (req, res) => {
    const r = await service.login(store, deps, req.body, service.clientIp(req))
    if (r.error) return res.status(r.error.status).json({ code: r.error.status, msg: r.error.msg })
    ok(res, r.data)
  })

  // ---------- 用户资料 ----------
  // 安全审计 M1：只返回白名单字段（id/nickname/avatar/phone/role/…），
  // 绝不把 password_hash / token / openid 下发给客户端（openid 即用户端会话凭据）。
  router.get('/user/profile', auth, (req, res) => ok(res, service.sanitizeUser(req.user)))

  router.put('/user/profile', auth, (req, res) => {
    q.updateProfile(store, req.user.id, req.body.nickname, req.body.phone, req.body.avatar)
    ok(res, service.sanitizeUser(q.findById(store, req.user.id)))
  })

  // ---------- 头像上传 ----------
  // 微信 chooseAvatar 给的是本地临时文件，小程序端读成 base64 后走这里（与商家端图片上传同一套做法，
  // 不引 multipart 依赖）。上传成功即写入 users.avatar，少一次往返；返回的是更新后的用户。
  router.post('/user/avatar', auth, (req, res) => {
    const { name = 'avatar.jpg', data = '' } = req.body || {}
    if (!data) return res.status(400).json({ code: 400, msg: '文件为空' })
    const ext = (String(name).match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase()
    if (!AVATAR_EXT.includes(ext)) {
      return res.status(400).json({ code: 400, msg: '头像仅支持 jpg / png / webp' })
    }
    const buf = Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ''), 'base64')
    if (!buf.length) return res.status(400).json({ code: 400, msg: '图片内容为空' })
    if (buf.length > AVATAR_MAX) return res.status(400).json({ code: 400, msg: '头像不能超过 2MB' })
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const prefix = 'avatar_' + req.user.id + '_'
    const fname = prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + ext
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf)
    // 换头像后删掉本人上一张，避免 uploads 目录随换头像次数无限增长。
    // 三重校验：文件名必须带本人前缀、必须解析在 uploads 目录内、必须是普通文件——绝不误删他人文件。
    const old = String((q.findById(store, req.user.id) || {}).avatar || '')
    if (old.indexOf('/uploads/' + prefix) === 0) {
      const oldPath = path.resolve(UPLOAD_DIR, path.basename(old))
      if (oldPath.indexOf(path.resolve(UPLOAD_DIR) + path.sep) === 0 && fs.existsSync(oldPath) && fs.statSync(oldPath).isFile()) {
        try { fs.unlinkSync(oldPath) } catch (e) { /* 删不掉不影响换头像成功 */ }
      }
    }
    q.updateProfile(store, req.user.id, undefined, undefined, '/uploads/' + fname)
    ok(res, service.sanitizeUser(q.findById(store, req.user.id)))
  })

  // ---------- 当前配送楼栋 ----------
  // 首页顶部「选择楼栋」/ 我的页「收货地址」/ 结算页「送达楼栋」三处读写的是同一份数据，
  // 任一处修改，另外两处刷新后即可见；空串表示还没选过（前端显示「楼栋未填写」而不是默认校区）。
  router.get('/user/point', auth, (req, res) => {
    const u = q.findById(store, req.user.id) || {}
    ok(res, { landmark_id: u.landmark_id || '', landmark_name: u.landmark_name || '' })
  })

  router.put('/user/point', auth, (req, res) => {
    const { landmark_id } = req.body || {}
    const lmId = landmark_id === undefined || landmark_id === null ? '' : String(landmark_id)
    if (lmId) {
      // 必须命中可送达点位，避免前端传入脏 id 后结算页拿到一个不存在的楼栋
      const lm = store.prepare("SELECT * FROM landmarks WHERE id=? AND type='deliverPoint'").get(lmId)
      if (!lm) return res.status(400).json({ code: 400, msg: '送达点位不存在或不可用' })
      q.updatePoint(store, req.user.id, lmId, lm.name)
    } else {
      q.updatePoint(store, req.user.id, '', '')
    }
    const u = q.findById(store, req.user.id) || {}
    ok(res, { landmark_id: u.landmark_id || '', landmark_name: u.landmark_name || '' })
  })

  // ---------- 购物车 ----------
  // 购物车列表附折后价 price_now（展示估算；真实金额以 order 域 promotion 权威计算为准）
  router.get('/cart/list', auth, (req, res) => ok(res, service.cartListWithPrice(store, req.user.id)))

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
    // 安全审计 L5：地址簿文本截断，防无界文本撑库
    const cname = String(contact_name || '').slice(0, 30)
    const cdetail = String(detail || '').slice(0, 200)
    const lmName = String(landmark_name || '').slice(0, 50)
    // landmark_id 显式转字符串存储（node:sqlite 把整数绑定到 TEXT 列会存成 "2.0"，导致与点位 id 无法字符串匹配）
    const lmId = landmark_id === undefined || landmark_id === null ? '' : String(landmark_id)
    if (is_default) q.clearDefault(store, req.user.id)
    // 默认地址同时就是「当前配送楼栋」：一并更新三处共用的后端字段，
    // 这样在我的页把某地址设为默认后，首页顶部与结算页的楼栋会立刻跟着变。
    if (is_default && lmId) q.updatePoint(store, req.user.id, lmId, lmName)
    if (id) {
      q.addressUpdate(store, id, req.user.id, { contact_name: cname, contact_phone, lmId, landmark_name: lmName, detail: cdetail, is_default })
    } else {
      q.addressInsert(store, req.user.id, { contact_name: cname, contact_phone, lmId, landmark_name: lmName, detail: cdetail, is_default })
    }
    ok(res)
  })

  router.delete('/address/delete', auth, (req, res) => {
    q.addressDelete(store, req.body.id, req.user.id)
    ok(res)
  })

  return router
}
