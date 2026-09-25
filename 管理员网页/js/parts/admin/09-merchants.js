
  // ---------- 商家管理（商家账号：创建 / 列表 / 改角色 / 重置密码 / 禁用启用，2026-09-24 起替代邀请码） ----------
  // 后端：/api/admin/merchants*（admin 域）。商家端登录 = 用户名+密码（scrypt），角色 owner=店主 / staff=店员。
  // 说明：密码只在创建/重置时输入；列表永不返回密码与 token。
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
        + '<div class="mini">' + (m.name ? esc(m.name) + ' · ' : '') + '创建于 ' + esc(m.created_at || '') + '</div>'
        + '</div>'
        + '<div class="merchant-ops">'
        + '<button class="btn ghost sm" onclick="merchantRole(' + m.id + ')">改角色</button>'
        + '<button class="btn ghost sm" onclick="merchantPassword(' + m.id + ')">重置密码</button>'
        + (m.active
            ? '<button class="btn ghost sm" onclick="merchantDisable(' + m.id + ')">停用</button>'
            : '<button class="btn ghost sm" onclick="merchantEnable(' + m.id + ')">启用</button>')
        + '</div>'
        + '</div>'
    })
    list.innerHTML = html
  }

  // 创建：用户名+密码+角色
  function merchantCreate() {
    var username = $('merchantUsername').value.trim()
    var password = $('merchantPassword').value
    var nickname = $('merchantName').value.trim()
    var role = document.querySelector('input[name="merchantRole"]:checked')
    var msg = $('merchantCreateMsg')
    if (!username) { msg.className = 'token-msg err'; msg.innerHTML = '请填写用户名'; return }
    if (password.length < 6) { msg.className = 'token-msg err'; msg.innerHTML = '密码至少 6 位'; return }
    $('merchantCreate').disabled = true
    msg.className = 'token-msg'; msg.innerHTML = '创建中…'
    api('/merchants/create', 'POST', {
      username: username,
      password: password,
      nickname: nickname,
      merchant_role: role && role.value === 'owner' ? 'owner' : 'staff'
    }).then(function () {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg ok'
      msg.innerHTML = '已创建：' + esc(username)
      $('merchantUsername').value = ''; $('merchantPassword').value = ''; $('merchantName').value = ''
      loadMerchants()
    }).catch(function (e) {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg err'
      msg.innerHTML = esc((e && e.message) || '创建失败')
    })
  }
  window.merchantCreate = merchantCreate

  function merchantRole(id) {
    var m = (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
    if (!m) return
    var next = m.merchant_role === 'owner' ? 'staff' : 'owner'
    var nextTxt = next === 'owner' ? '店主' : '店员'
    openConfirmModal('修改角色', '将 <b>' + esc(m.username) + '</b> 的角色改为 <b>' + nextTxt + '</b>？', function () {
      api('/merchants/role', 'PUT', { id: id, merchant_role: next }).then(function () {
        toast('角色已改为' + nextTxt, 'ok')
        loadMerchants()
      }).catch(function (e) { opFail(e, '改角色') })
    })
  }
  window.merchantRole = merchantRole

  function merchantPassword(id) {
    var m = (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
    if (!m) return
    var input = '<div class="token-box"><span class="token-label">新密码</span>'
      + '<div class="token-input-wrap"><input id="merchantNewPass" type="password" placeholder="至少 6 位" autocomplete="off"></div></div>'
    openConfirmModal('重置密码', '为 <b>' + esc(m.username) + '</b> 设置新密码（将强制重新登录）：' + input, function () {
      var np = $('merchantNewPass') ? $('merchantNewPass').value : ''
      if (String(np).length < 6) { toast('新密码至少 6 位', 'err'); return }
      api('/merchants/password', 'POST', { id: id, password: np }).then(function () {
        toast('密码已重置', 'ok')
      }).catch(function (e) { opFail(e, '重置密码') })
    })
  }
  window.merchantPassword = merchantPassword

  function merchantDisable(id) {
    var m = (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
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
