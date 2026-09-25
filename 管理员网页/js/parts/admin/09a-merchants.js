
  // ---------- 商家管理（商家账号：创建 / 列表 / 编辑 / 停用启用，2026-09-24 起替代邀请码） ----------
  // 后端：/api/admin/merchants*（admin 域）。商家端登录 = 用户名+密码（scrypt），角色 owner=店主 / staff=店员。
  // 说明：密码只在创建/重置时输入；列表永不返回密码与 token。
  // 结构（2026-09-26 调整）：列表每行只留「编辑」与「启用/停用」两个按钮（启用绿、停用红便于区分）；
  // 修改权限 / 重置密码 / 删除账号 / 修改用户名 全部收敛进「编辑」弹窗。
  var merchantsCache = null

  function loadMerchants() {
    api('/merchants').then(function (d) {
      merchantsCache = d
      renderMerchants()
    }).catch(function (e) {
      if (!isUnauthorized(e)) {
        var box = $('merchantList'); if (box) box.innerHTML = '<span class="mini bad">加载失败：' + esc(e.message) + '</span>'
      }
    })
  }
  window.loadMerchants = loadMerchants

  function merchantById(id) {
    return (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
  }

  function renderMerchants() {
    var list = $('merchantList')
    if (!list) return
    var d = merchantsCache
    if (!d) { list.innerHTML = '<span class="mini">加载中…</span>'; return }
    var ms = d.merchants || []
    var cnt = $('merchantCount'); if (cnt) cnt.textContent = '共 ' + ms.length + ' 个账号'
    if (!ms.length) { list.innerHTML = '<span class="mini">暂无账号</span>'; return }
    var html = ''
    ms.forEach(function (m) {
      var roleTxt = m.merchant_role === 'owner' ? '店主' : '店员'
      var roleCls = m.merchant_role === 'owner' ? 'blue' : 'violet'
      var stateTxt = m.active ? '启用' : '停用'
      var stateCls = m.active ? 'green' : 'gray'
      html += '<div class="merchant-row">'
        + '<div class="merchant-main">'
        + '<div class="merchant-name">' + esc(m.username || '') + ' <span class="tag ' + roleCls + '">' + roleTxt + '</span> <span class="tag ' + stateCls + '">' + stateTxt + '</span></div>'
        + '<div class="mini">创建于 ' + esc(m.created_at || '') + '</div>'
        + '</div>'
        + '<div class="merchant-ops">'
        + '<button class="btn ghost sm" onclick="merchantEdit(' + m.id + ')">编辑</button>'
        + (m.active
            ? '<button class="btn danger sm" onclick="merchantDisable(' + m.id + ')">停用</button>'
            : '<button class="btn ok sm" onclick="merchantEnable(' + m.id + ')">启用</button>')
        + '</div>'
        + '</div>'
    })
    list.innerHTML = html
  }

  // 创建：用户名+密码+权限（店名不再收集：单店铺模式，账号即登录身份）
  function merchantCreate() {
    var username = $('merchantUsername').value.trim()
    var password = $('merchantPassword').value
    var role = document.querySelector('input[name="merchantRole"]:checked')
    var msg = $('merchantCreateMsg')
    if (!username) { msg.className = 'token-msg err'; msg.innerHTML = '请填写用户名'; return }
    if (password.length < 8) { msg.className = 'token-msg err'; msg.innerHTML = '密码至少 8 位'; return }
    $('merchantCreate').disabled = true
    msg.className = 'token-msg'; msg.innerHTML = '创建中…'
    api('/merchants/create', 'POST', {
      username: username,
      password: password,
      merchant_role: role && role.value === 'owner' ? 'owner' : 'staff'
    }).then(function () {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg ok'
      msg.innerHTML = '已创建：' + esc(username)
      $('merchantUsername').value = ''; $('merchantPassword').value = ''
      loadMerchants()
    }).catch(function (e) {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg err'
      msg.innerHTML = esc((e && e.message) || '创建失败')
    })
  }
  window.merchantCreate = merchantCreate

  // ---------- 编辑弹窗：用户名 / 权限 / 重置密码 / 删除账号，右下角统一保存 ----------
  var merchantEditId = null

  function merchantEdit(id) {
    var m = merchantById(id)
    if (!m) return
    merchantEditId = id
    var html = ''
      + '<div class="token-box">'
      + '<span class="token-label">用户名</span>'
      + '<div class="token-input-wrap"><input id="merEditUsername" value="' + esc(m.username || '') + '" placeholder="2~32 位字母/数字/下划线" autocomplete="off" spellcheck="false"></div>'
      + '</div>'
      + '<div class="token-box">'
      + '<span class="token-label">权限</span>'
      + '<div class="row-radio">'
      + '<label class="radio"><input type="radio" name="merEditRole" value="owner" ' + (m.merchant_role === 'owner' ? 'checked' : '') + '><span>店主</span></label>'
      + '<label class="radio"><input type="radio" name="merEditRole" value="staff" ' + (m.merchant_role !== 'owner' ? 'checked' : '') + '><span>店员</span></label>'
      + '</div>'
      + '</div>'
      + '<div class="token-box">'
      + '<span class="token-label">重置密码</span>'
      + '<button class="btn ghost sm" type="button" onclick="merchantEditTogglePass()"><svg><use href="#i-key"/></svg><span>重置密码</span></button>'
      + '<div class="token-input-wrap" id="merEditPassWrap" hidden>'
      + '<input id="merEditPass" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" spellcheck="false">'
      + '</div>'
      + '</div>'
      + '<div class="token-msg" id="merchantEditMsg"></div>'
    $('merchantEditTitle').textContent = '编辑商家账号'
    $('merchantEditBody').innerHTML = html
    $('merchantEditModal').hidden = false
    var first = $('merEditUsername'); if (first) { try { first.focus() } catch (e) {} }
  }
  window.merchantEdit = merchantEdit
  window.closeMerchantEdit = function () { $('merchantEditModal').hidden = true; merchantEditId = null }
  $('merchantEditModal').addEventListener('click', function (e) {
    if (e.target === $('merchantEditModal')) closeMerchantEdit()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('merchantEditModal').hidden) closeMerchantEdit()
  })

  // 重置密码按钮：点击展开新密码输入框（再次点击收起）
  function merchantEditTogglePass() {
    var wrap = $('merEditPassWrap')
    if (wrap) wrap.hidden = !wrap.hidden
    if (!wrap.hidden) { var p = $('merEditPass'); if (p) { try { p.focus() } catch (e) {} } }
  }
  window.merchantEditTogglePass = merchantEditTogglePass

  // 统一保存：用户名 / 权限 / 密码 只提交有变更的字段，逐个落库；全部成功才关弹窗
  function merchantEditSave() {
    var m = merchantById(merchantEditId)
    if (!m) return
    var msg = $('merchantEditMsg')
    var tasks = []
    var nu = $('merEditUsername') ? $('merEditUsername').value.trim() : ''
    if (nu !== m.username) {
      if (!/^[A-Za-z0-9_]{2,32}$/.test(nu)) { if (msg) { msg.className = 'token-msg err'; msg.innerHTML = '用户名限 2~32 位字母/数字/下划线' } ; return }
      tasks.push({ label: '用户名', fn: function () { return api('/merchants/username', 'PUT', { id: merchantEditId, username: nu }) } })
    }
    var sel = document.querySelector('input[name="merEditRole"]:checked')
    var nr = sel && sel.value === 'owner' ? 'owner' : 'staff'
    if (nr !== m.merchant_role) {
      tasks.push({ label: '权限', fn: function () { return api('/merchants/role', 'PUT', { id: merchantEditId, merchant_role: nr }) } })
    }
    var np = $('merEditPass') ? $('merEditPass').value : ''
    if (np) {
      if (String(np).length < 8) { if (msg) { msg.className = 'token-msg err'; msg.innerHTML = '新密码至少 8 位' } ; return }
      tasks.push({ label: '密码', fn: function () { return api('/merchants/password', 'POST', { id: merchantEditId, password: np }) } })
    }
    if (!tasks.length) { if (msg) { msg.className = 'token-msg warn'; msg.innerHTML = '没有需要保存的修改' } ; return }
    if (msg) { msg.className = 'token-msg'; msg.innerHTML = '保存中…' }
    var i = 0
    function next() {
      if (i >= tasks.length) {
        if (msg) { msg.className = 'token-msg ok'; msg.innerHTML = '已保存' }
        toast('商家账号已保存', 'ok')
        loadMerchants()
        setTimeout(closeMerchantEdit, 400)
        return
      }
      tasks[i].fn().then(function () { i++; next() }).catch(function (e) {
        if (msg) { msg.className = 'token-msg err'; msg.innerHTML = esc((e && e.message) || '保存失败') }
        opFail(e, '保存商家账号')
      })
    }
    next()
  }
  window.merchantEditSave = merchantEditSave

  // 删除该账号（右下角）：二次确认后物理删除，历史订单不受影响
  function merchantDelete() {
    var m = merchantById(merchantEditId)
    if (!m) return
    openConfirmModal('删除商家账号', '删除后 <b>' + esc(m.username || '') + '</b> 将无法登录，不可恢复。确定删除？', function () {
      api('/merchants/delete', 'POST', { id: merchantEditId }).then(function () {
        toast('账号已删除', 'ok')
        closeMerchantEdit()
        loadMerchants()
      }).catch(function (e) { opFail(e, '删除账号') })
    })
  }
  window.merchantDelete = merchantDelete

  function merchantDisable(id) {
    var m = merchantById(id)
    var name = m ? (m.username || '') : ''
    openConfirmModal('停用账号', '停用后 <b>' + esc(name || '该账号') + '</b> 将无法登录（已登录也会失效）。确定停用？', function () {
      api('/merchants/disable', 'POST', { id: id }).then(function () {
        toast('已停用', 'ok')
        loadMerchants()
      }).catch(function (e) { opFail(e, '停用') })
    })
  }
  window.merchantDisable = merchantDisable

  function merchantEnable(id) {
    api('/merchants/enable', 'POST', { id: id }).then(function () {
      toast('已启用', 'ok')
      loadMerchants()
    }).catch(function (e) { opFail(e, '启用') })
  }
  window.merchantEnable = merchantEnable

  // 页面事件绑定
  var cBtn = $('merchantCreate')
  if (cBtn) cBtn.onclick = merchantCreate
  var rBtn = $('merchantReload')
  if (rBtn) rBtn.onclick = loadMerchants
