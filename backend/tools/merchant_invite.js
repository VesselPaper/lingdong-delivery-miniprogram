#!/usr/bin/env node
// 商家邀请码维护脚本（方案A）
//
// 在 backend 目录下运行（会读取与 server 相同的数据库 data/lingdong.db，可用 LINGDONG_DB 覆盖）：
//
//   生成邀请码（不传 --code 则自动生成随机码，只打印这一次）：
//     node tools/merchant_invite.js add --name "东苑1栋" [--note "首次洽谈" ] [--code 自定码]
//   列出全部邀请码（只显示 id/商家/是否已绑定/是否有效，不显示明文）：
//     node tools/merchant_invite.js list
//   吊销（作废，无法再登录）：
//     node tools/merchant_invite.js revoke --id 1
//   重新启用：
//     node tools/merchant_invite.js activate --id 1
//   解绑（清掉已绑定的 openid，允许另一个账号重新使用该码）：
//     node tools/merchant_invite.js unbind --id 1
const { init } = require('../db')
const invite = require('../services/merchantInvite')

const store = init()
const args = process.argv.slice(2)
const sub = (args[0] || '').toLowerCase()
const get = (k) => { const i = args.indexOf(k); return (i >= 0 && args[i + 1] !== undefined) ? args[i + 1] : '' }

const R = {
  add() {
    let code = get('--code')
    if (!code) code = invite.generate()
    const name = get('--name') || '商家'
    const note = get('--note') || ''
    const h = invite.sha(code)
    const exist = store.prepare('SELECT id, active, bound_openid FROM merchant_invites WHERE code_hash=?').get(h)
    if (exist) {
      if (exist.active === 1) {
        console.error(`[失败] 该码已存在且有效（id=${exist.id}），同一码表里只能有一条记录，无需重复添加。`)
        console.error(`        要发给别人： 先 unbind --id ${exist.id}；要作废换新码：先 revoke --id ${exist.id}，再用新码 add。`)
        process.exit(1)
      }
      // 已吊销的同码：重新启用 + 清空绑定 + 更新店名/备注，直接复用
      store.prepare("UPDATE merchant_invites SET active=1, bound_openid='', name=?, note=? WHERE id=?").run(name, note, exist.id)
      console.log(`[OK] 检测到已吊销的同码 id=${exist.id}，已重新启用并更新为「${name}」（绑定已清空，可重新登录）`)
      console.log(`[码] ${code}`)
      return
    }
    const r = store.prepare('INSERT INTO merchant_invites (code_hash, name, note) VALUES (?,?,?)').run(h, name, note)
    console.log(`[OK] 已生成邀请码 id=${r.lastInsertRowid}  商家=${name}${note ? '  备注=' + note : ''}`)
    console.log('[码] ' + code)
    console.log('      ---- 明文只显示这一次，系统只保存其哈希；请线下交给对应商家。')
  },
  list() {
    const rows = store.prepare('SELECT id, name, note, bound_openid, active, created_at FROM merchant_invites ORDER BY id DESC').all()
    if (!rows.length) { console.log('（暂无邀请码）'); return }
    console.log('id  | 商家         | 状态   | 绑定         | 创建时间')
    rows.forEach((r) => {
      console.log([
        String(r.id).padEnd(3),
        (String(r.name).slice(0, 10)).padEnd(13),
        (r.active ? '有效' : '已吊销').padEnd(6),
        (r.bound_openid ? (String(r.bound_openid).slice(0, 12) + '…') : '未绑定').padEnd(12),
        String(r.created_at)
      ].join(' | '))
    })
  },
  revoke() {
    const id = Number(get('--id'))
    if (!id) { console.error('用法：revoke --id <编号>；编号见 list'); process.exit(1) }
    const r = store.prepare('UPDATE merchant_invites SET active=0 WHERE id=?').run(id)
    console.log(r.changes ? `[OK] 已吊销 id=${id}` : `[未操作] 未找到 id=${id}`)
  },
  activate() {
    const id = Number(get('--id'))
    if (!id) { console.error('用法：activate --id <编号>'); process.exit(1) }
    const r = store.prepare('UPDATE merchant_invites SET active=1 WHERE id=?').run(id)
    console.log(r.changes ? `[OK] 已重新启用 id=${id}` : `[未操作] 未找到 id=${id}`)
  },
  unbind() {
    const id = Number(get('--id'))
    if (!id) { console.error('用法：unbind --id <编号>'); process.exit(1) }
    const r = store.prepare('UPDATE merchant_invites SET bound_openid=? WHERE id=?').run('', id)
    console.log(r.changes ? `[OK] 已解绑 id=${id}，可用新账号重新绑定` : `[未操作] 未找到 id=${id}`)
  }
}

const usage = () => {
  console.log('用法：node tools/merchant_invite.js <命令> [参数]')
  console.log('  add --name 商家名 [--note 备注] [--code 自定码]')
  console.log('  list')
  console.log('  revoke --id <编号>   吊销(作废)')
  console.log('  activate --id <编号> 重新启用')
  console.log('  unbind --id <编号>   解绑 openid')
}
if (!R[sub]) { usage(); process.exit(sub ? 1 : 0) }
R[sub]()