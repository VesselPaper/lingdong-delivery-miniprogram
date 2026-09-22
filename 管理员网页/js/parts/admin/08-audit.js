
  // ---------- 操作日志（服务端持久化审计：成功与失败都在） ----------
  // 读 GET /admin/audit（后端由 auditMw 中间件统一写入，不依赖前端上报）。
  // 前端内存日志（#log）只作「本次会话回显」，与审计无关。
  var auditState = { offset: 0, limit: 50, total: 0, rows: [], loading: false }

  function auditQuery() {
    var role = ($('auditRole') && $('auditRole').value) || 'admin'
    var okv = ($('auditResult') && $('auditResult').value) || ''
    var act = ($('auditAction') && $('auditAction').value.trim()) || ''
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
    if (r.user_role === 'admin') return '管理员' + (r.user_id ? '#' + r.user_id : '')
    if (r.user_role === 'merchant') return '商家' + (r.user_id ? '#' + r.user_id : '')
    if (r.user_role === 'student') return '用户' + (r.user_id ? '#' + r.user_id : '')
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
        return '<div class="audit-row' + (ok ? '' : ' fail') + '">'
          + '<span class="audit-time">' + esc(r.created_at || '') + '</span>'
          + '<span class="audit-badge ' + (ok ? 'ok' : 'err') + '">' + (ok ? '成功' : '失败') + '</span>'
          + '<span class="audit-who">' + esc(auditWho(r)) + '</span>'
          + '<span class="audit-act">' + esc(r.action || '') + '</span>'
          + (r.target ? '<span class="audit-tgt">' + esc(r.target) + '</span>' : '')
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
    var role = $('auditRole'); if (role) role.addEventListener('change', function () { loadAudit(true) })
    var res = $('auditResult'); if (res) res.addEventListener('change', function () { loadAudit(true) })
    var act = $('auditAction')
    if (act) {
      act.addEventListener('input', function () {
        clearTimeout(act._t)
        act._t = setTimeout(function () { loadAudit(true) }, 220)
      })
    }
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
