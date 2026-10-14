
  // ---------- 刷新与认证（方案A：账号密码 → 随机 session token） ----------
  function refresh() {
    var tk = token()
    if (!tk) {
      setAuthBanner('未登录：请使用管理员账号登录', false)
      $('conn').textContent = '未登录'
      return
    }
    if (busy) return
    busy = true
    $('conn').textContent = '加载中…'
    setAuthBanner('')
    api('/state').then(function (d) {
      state = d
      render()
      $('conn').textContent = '更新于 ' + d.server_time
      log('状态已刷新（机器人 ' + (d.robot ? d.robot.machine_status : '无') + '，平台任务 ' + (d.platform_tasks || []).length + '，告警 ' + (d.alerts || []).length + '）')
    }).catch(function (e) {
      $('conn').textContent = ''
      if (isUnauthorized(e)) {
        state = null
        // 被"别处登录"踢下线时，onUnauthorized 已经写了明确提示，这里不要用笼统文案覆盖它
        if (!e.kicked) setAuthBanner('登录已过期：请重新登录', true)
        log('认证失败：' + e.message, 'bad')
      } else {
        setAuthBanner('')
        log('刷新失败：' + e.message, 'bad')
      }
    }).then(function () { busy = false })
  }

  // ---------- 登录 / 会话（方案A） ----------
  function showLogin() {
    var m = $('loginMask')
    if (m) m.hidden = false
    var u = $('loginUser')
    if (u) { u.value = ''; try { u.focus() } catch (e) {} }
    var p = $('loginPass'); if (p) p.value = ''
    var e = $('loginErr'); if (e) { e.hidden = true; e.textContent = '' }
    setAuthBanner('')
    var c = $('conn'); if (c) c.textContent = '未登录'
  }
  function hideLogin() { var m = $('loginMask'); if (m) m.hidden = true }

  function adminLogin() {
    var username = $('loginUser').value.trim()
    var password = $('loginPass').value
    var err = $('loginErr')
    if (!username || !password) { err.textContent = '请输入账号和密码'; err.hidden = false; return }
    $('loginBtn').disabled = true
    err.textContent = ''
    api('/login', 'POST', { username: username, password: password }).then(function (d) {
      localStorage.setItem(TOKEN_KEY, d.token)
      currentAdmin = d.admin
      hideLogin()
      renderAccountUI()
      log('管理员 ' + d.admin.username + ' 登录成功', 'green')
      refresh()
      connectWS()
    }).catch(function (e) {
      $('loginBtn').disabled = false
      err.textContent = (e && e.message) || '登录失败'
      err.hidden = false
      log('登录失败：' + ((e && e.message) || ''), 'bad')
    })
  }

  function logout() {
    var tk = token()
    if (tk) api('/logout', 'POST', {}).catch(function () {})
    localStorage.removeItem(TOKEN_KEY)
    currentAdmin = null
    state = null
    if (ws) { try { ws.close() } catch (e) {} ws = null }
    // 2026-10-14 修：这里原先调 closeDrawer()，但抽屉（07 片）已在 2026-10-12 随「配送数据」页被删除，
    // 函数不存在 → 退出登录时会抛 ReferenceError，把后面的 showLogin()/日志一起中断（表现为点了退出没反应）。
    showLogin()
    log('已退出登录', 'warn')
  }

  function changePassword() {
    var oldP = $('oldPass').value, np1 = $('np1').value, np2 = $('np2').value
    var msg = $('tokenMsg')
    if (!oldP || !np1) { msg.className = 'token-msg err'; msg.innerHTML = '请填写原密码与新密码'; return }
    if (np1 !== np2) { msg.className = 'token-msg err'; msg.innerHTML = '两次输入的新密码不一致'; return }
    if (np1.length < 8) { msg.className = 'token-msg err'; msg.innerHTML = '新密码至少 8 位'; return }
    api('/password', 'POST', { old_password: oldP, new_password: np1 }).then(function () {
      msg.className = 'token-msg ok'
      msg.innerHTML = '密码已修改，请重新登录'
      setTimeout(logout, 800)
    }).catch(function (e) {
      msg.className = 'token-msg err'
      msg.innerHTML = (e && e.message) || '修改失败'
    })
  }

  function renderAccountUI() {
    var a = $('accountName'), r = $('accountRole')
    if (a) a.textContent = currentAdmin ? currentAdmin.username : '—'
    if (r) r.textContent = currentAdmin
      ? (currentAdmin.nickname ? currentAdmin.nickname + ' · ' : '') + (currentAdmin.role || 'admin')
      : ''
    var msg = $('tokenMsg'); if (msg) { msg.className = 'token-msg'; msg.innerHTML = '' }
    ;[$('oldPass'), $('np1'), $('np2')].forEach(function (x) { if (x) x.value = '' })
  }

  // 会话失效（任意接口 401）统一回调 → 弹登录页
  // 单点登录（2026-10-11）：同一管理员只允许一个会话，被新登录顶掉时后端回 code=SESSION_KICKED；
  // 必须告诉用户"账号在别处登录了"，否则他只会看到登录页莫名弹出、以为系统坏了。
  onUnauthorized = function (e) {
    currentAdmin = null
    showLogin()
    if (e && e.kicked) {
      setAuthBanner('该账号已在别处登录，你已被踢下线：请重新登录', true)
      log('会话被踢下线：该管理员账号在其他地方登录了', 'bad')
    }
  }

  // 登录页 / 账号页事件
  $('loginBtn').onclick = adminLogin
  $('loginPass').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') adminLogin() })
  $('loginUser').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { var p = $('loginPass'); if (p) p.focus() } })
  $('logoutBtn').onclick = logout
  $('savePass').onclick = changePassword
