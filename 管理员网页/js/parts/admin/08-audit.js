
  // ---------- 操作日志（服务端持久化审计：成功与失败都在） ----------
  // 读 GET /admin/audit（后端由 auditMw 中间件统一写入，不依赖前端上报）。
  // 前端内存日志（#log）只作「本次会话回显」，与审计无关。
  // 人话显示（2026-09-26）：action 机器码 → 中文动作，target（order#12 等）→ 中文对象；
  // 动作筛选从自由输入改为下拉（值即后端 action 前缀，匹配逻辑不变）。
  var auditState = { offset: 0, limit: 50, total: 0, rows: [], loading: false }

  // action 机器码 → 中文动作（与后端 domains/**/routes.js 的 audit() 标注一一对应）
  var AUDIT_TEXT = {
    'admin/login': '登录',
    'admin/logout': '退出登录',
    'admin/password': '修改密码',
    'admin/task-cancel': '取消排队任务',
    'admin/task-close': '关闭平台任务',
    'admin/precreate-del': '删除预创建任务',
    'admin/drawer': '开关舱门',
    'admin/robot-summon': '召唤机器人',
    'admin/robot-stop': '驻停机器人',
    'admin/robot-recover': '恢复机器人任务',
    'admin/robot-stop-cancel': '停止并取消任务',
    'admin/robot-cancel-tasks': '取消机器人全部任务',
    'admin/control-grant': '获取设备控制权',
    'admin/control-release': '释放设备控制权',
    'admin/landmarks-sync': '同步平台点位',
    'admin/order-cancel': '取消订单',
    'admin/task-close-void': '关闭并作废任务',
    'admin/batch-cancel': '清理批次',
    'admin/orders-bulk-cancel': '批量取消订单',
    'admin/batches-bulk-cancel': '批量取消批次',
    'admin/tasks-bulk-close-void': '批量关闭作废任务',
    'admin/reset': '一键初始化',
    'admin/task-void': '作废任务',
    'admin/merchant-create': '创建商家账号',
    'admin/merchant-role': '修改商家权限',
    'admin/merchant-password': '重置商家密码',
    'admin/merchant-disable': '停用商家账号',
    'admin/merchant-enable': '启用商家账号',
    'admin/merchant-username': '修改商家用户名',
    'admin/merchant-delete': '删除商家账号',
    'batch/dispatch': '批次派车',
    'device/batch-open': '批次开舱',
    'device/batch-close': '批次关舱',
    'device/batch-dispatch': '批次开始配送',
    'test/mock-dispatch': '模拟派车',
    'test/complete': '测试完成任务',
    'device/scan': '商家扫码设备',
    'device/open-bin': '打开舱门',
    'device/close-bin': '关闭舱门',
    'device/dispatch': '配送任务下发',
    'shop/update': '修改店铺设置',
    'goods/stock': '修改商品库存',
    'goods/create': '上架商品',
    'goods/update': '修改商品',
    'goods/status': '商品上架停售',
    'activity/create': '创建活动',
    'activity/update': '修改活动',
    'activity/status': '活动启停',
    'activity/delete': '删除活动',
    'cancel-request/approve': '同意取消申请',
    'cancel-request/reject': '拒绝取消申请',
    'refund/approve': '同意退款',
    'refund/reject': '拒绝退款',
    'complaint/reply': '回复投诉',
    'order/confirm': '确认接单',
    'order/exception-retry': '订单异常重试',
    'order/exception-refund': '订单异常退款'
  }
  // 自动推导动作（后端 auditAction 兜底，形如「admin/order/cancel [POST]」）的路径段中文
  var AUDIT_SEG = {
    admin: '管理端', user: '用户端', merchant: '商家端', auth: '登录',
    order: '订单', goods: '商品', batch: '批次', task: '任务', device: '设备',
    shop: '店铺', activity: '活动', cart: '购物车', refund: '退款',
    'cancel-request': '取消申请', complaint: '投诉', platform: '平台',
    delivery: '配送', landmark: '点位', test: '测试'
  }
  var AUDIT_METHOD = { POST: '提交', PUT: '修改', DELETE: '删除', PATCH: '修改' }

  // 动作码 → 人话；显式字典优先，兜底解析「路径 [方法]」形式
  function auditText(a) {
    var s = String(a || '')
    if (AUDIT_TEXT[s]) return AUDIT_TEXT[s]
    var m = s.match(/^(.*?)\s*\[\s*([A-Z]+)\s*\]$/)
    if (m) {
      var segs = String(m[1]).split('/').filter(Boolean)
      var parts = segs.map(function (x) { return AUDIT_SEG[x] || x })
      var verb = AUDIT_METHOD[m[2]] || m[2]
      return parts.concat(verb).join(' · ')
    }
    return s || '未知操作'
  }

  // 对象码（order#12 等）→ 人话
  function auditTarget(t) {
    var s = String(t || '')
    var m = s.match(/^([a-zA-Z_]+)#(.+)$/)
    if (!m) return s
    var kind = { order: '订单', batch: '批次', task: '任务', 'platform_task': '平台任务', 'merchant-user': '商家账号', device: '设备', goods: '商品', activity: '活动', refund: '退款单', 'cancel_request': '取消申请', 'one-shot': '全局' }[m[1]]
    return kind ? kind + ' ' + m[2] : s
  }

  function auditQuery() {
    var role = ($('auditRole') && $('auditRole').value) || 'admin'
    var okv = ($('auditResult') && $('auditResult').value) || ''
    var act = ($('auditAction') && $('auditAction').value) || ''
    var qs = '?limit=' + auditState.limit + '&offset=' + auditState.offset + '&role=' + encodeURIComponent(role)
    if (okv !== '') qs += '&ok=' + encodeURIComponent(okv)
    if (act) qs += '&action=' + encodeURIComponent(act)
    return qs
  }

  function loadAudit(reset) {
    if (reset) auditState.offset = 0
    if (auditState.loading) return
    auditState.loading = true
    var box = $('auditBox')
    if (box && !auditState.rows.length) box.innerHTML = '<span class="mini">加载中…</span>'
    api('/audit' + auditQuery()).then(function (d) {
      auditState.total = Number(d.total || 0)
      auditState.rows = d.rows || []
      renderAudit()
    }).catch(function (e) {
      if (box) box.innerHTML = '<div class="empty">操作日志加载失败：' + esc(e.message) + '</div>'
    }).then(function () { auditState.loading = false })
  }

  function auditWho(r) {
    if (r.user_role === 'admin') return '管理员' + (r.user_id ? ' #' + r.user_id : '')
    if (r.user_role === 'merchant') return '商家' + (r.user_id ? ' #' + r.user_id : '')
    if (r.user_role === 'student') return '用户' + (r.user_id ? ' #' + r.user_id : '')
    return r.user_role || '匿名'
  }

  function renderAudit() {
    var box = $('auditBox')
    if (!box) return
    if (!auditState.rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-shield"/></svg>暂无符合条件的操作记录</div>'
    } else {
      box.innerHTML = auditState.rows.map(function (r) {
        var ok = Number(r.ok) === 1
        var act = auditText(r.action)
        var tgt = r.target ? auditTarget(r.target) : ''
        return '<div class="audit-row' + (ok ? '' : ' fail') + '">'
          + '<span class="audit-time">' + esc(r.created_at || '') + '</span>'
          + '<span class="audit-badge ' + (ok ? 'ok' : 'err') + '">' + (ok ? '成功' : '失败') + '</span>'
          + '<span class="audit-who">' + esc(auditWho(r)) + '</span>'
          + '<span class="audit-act" title="' + esc(r.action || '') + '">' + esc(act) + '</span>'
          + (tgt ? '<span class="audit-tgt">' + esc(tgt) + '</span>' : '')
          + '<span class="audit-detail">' + esc(r.detail || '') + '</span>'
          + '<span class="audit-ip">' + esc(r.ip || '') + (Number(r.ms) ? ' · ' + Number(r.ms) + 'ms' : '') + '</span>'
          + '</div>'
      }).join('')
    }
    var from = auditState.total ? auditState.offset + 1 : 0
    var to = Math.min(auditState.offset + auditState.limit, auditState.total)
    var info = $('auditInfo')
    if (info) info.textContent = '共 ' + auditState.total + ' 条，显示 ' + from + '–' + to
    var prev = $('auditPrev'), next = $('auditNext')
    if (prev) prev.disabled = auditState.offset <= 0
    if (next) next.disabled = auditState.offset + auditState.limit >= auditState.total
  }

  // ---------- 操作日志控件绑定 ----------
  ;(function wireAudit() {
    // 动作筛选下拉：选项 = 常用动作（值即后端 action 前缀，显示中文）
    var actSel = $('auditAction')
    if (actSel) {
      var common = [
        ['', '全部动作'],
        ['admin/merchant-create', '创建商家账号'],
        ['admin/merchant-username', '修改商家用户名'],
        ['admin/merchant-role', '修改商家权限'],
        ['admin/merchant-password', '重置商家密码'],
        ['admin/merchant-disable', '停用商家账号'],
        ['admin/merchant-enable', '启用商家账号'],
        ['admin/merchant-delete', '删除商家账号'],
        ['admin/order-cancel', '取消订单'],
        ['admin/orders-bulk-cancel', '批量取消订单'],
        ['admin/batch-cancel', '清理批次'],
        ['admin/batches-bulk-cancel', '批量取消批次'],
        ['admin/task-close-void', '关闭并作废任务'],
        ['admin/task-void', '作废任务'],
        ['admin/task-close', '关闭平台任务'],
        ['admin/drawer', '开关舱门'],
        ['admin/robot-summon', '召唤机器人'],
        ['admin/robot-stop', '驻停机器人'],
        ['admin/robot-stop-cancel', '停止并取消任务'],
        ['admin/reset', '一键初始化'],
        ['batch/dispatch', '批次派车'],
        ['device/dispatch', '配送任务下发'],
        ['device/open-bin', '打开舱门'],
        ['device/close-bin', '关闭舱门'],
        ['goods/create', '上架商品'],
        ['goods/status', '商品上架停售'],
        ['refund/approve', '同意退款'],
        ['cancel-request/approve', '同意取消申请'],
        ['admin/login', '登录']
      ]
      actSel.innerHTML = common.map(function (o) {
        return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'
      }).join('')
    }
    var role = $('auditRole'); if (role) role.addEventListener('change', function () { loadAudit(true) })
    var res = $('auditResult'); if (res) res.addEventListener('change', function () { loadAudit(true) })
    if (actSel) actSel.addEventListener('change', function () { loadAudit(true) })
    var reload = $('auditReload'); if (reload) reload.addEventListener('click', function () { loadAudit(false) })
    var prev = $('auditPrev')
    if (prev) prev.addEventListener('click', function () {
      auditState.offset = Math.max(0, auditState.offset - auditState.limit)
      loadAudit(false)
    })
    var next = $('auditNext')
    if (next) next.addEventListener('click', function () {
      if (auditState.offset + auditState.limit < auditState.total) {
        auditState.offset += auditState.limit
        loadAudit(false)
      }
    })
  })()
