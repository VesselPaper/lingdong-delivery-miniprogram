
  // ---------- 刷新与认证 ----------
  function refresh() {
    var tk = token()
    if (!tk) {
      setAuthBanner('未认证：请输入管理员令牌并保存后才能查看和管理', false)
      $('conn').textContent = '未认证'
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
        setAuthBanner('令牌无效：无法认证，不能查看和管理', true)
        log('认证失败：' + e.message, 'bad')
      } else {
        setAuthBanner('')
        log('刷新失败：' + e.message, 'bad')
      }
    }).then(function () { busy = false })
  }

  // ---------- 令牌（设置页） ----------
  function verifyToken(t) {
    return fetch('/api/admin/verify', { headers: { 'x-admin-token': t } })
      .then(function (r) { return r.status === 200 })
      .catch(function () { return false })
  }

  function renderTokenUI() {
    var inp = $('token'), st = $('tokenState'), msg = $('tokenMsg'), chg = $('tokenChange'), btn = $('saveToken')
    if (tokenVerified) {
      inp.value = ''
      inp.placeholder = '••••••'
      inp.disabled = true
      inp.classList.add('ok'); inp.classList.remove('err')
      st.innerHTML = '<svg class="ok-ico"><use href="#i-check"/></svg><span class="ok-txt">正确</span>'
      st.hidden = false
      msg.innerHTML = ''
      msg.className = 'token-msg ok'
      chg.hidden = false
      btn.hidden = true
    } else {
      inp.disabled = false
      inp.classList.remove('ok', 'err')
      if (!inp.value) inp.placeholder = '请输入令牌'
      st.hidden = true
      msg.className = 'token-msg'
      chg.hidden = true
      btn.hidden = false
    }
  }

  $('saveToken').onclick = function () {
    var t = $('token').value.trim()
    var inp = $('token'), msg = $('tokenMsg'), st = $('tokenState')
    if (!t) {
      msg.className = 'token-msg err'
      msg.innerHTML = '请输入令牌'
      inp.classList.add('err'); inp.classList.remove('ok')
      return
    }
    verifyToken(t).then(function (ok) {
      if (ok) {
        localStorage.setItem(TOKEN_KEY, t)
        tokenVerified = true
        renderTokenUI()
        log('令牌验证通过', 'green')
        toast('令牌验证通过', 'ok')
        refresh()
        connectWS() // 用新令牌重建实时推送连接
      } else {
        tokenVerified = false
        inp.classList.add('err'); inp.classList.remove('ok')
        st.innerHTML = '<svg class="err-ico"><use href="#i-close"/></svg>'
        st.hidden = false
        msg.className = 'token-msg err'
        msg.innerHTML = '令牌不正确'
        log('令牌验证失败：不匹配', 'bad')
      }
    })
  }

  $('changeToken').onclick = function () {
    localStorage.removeItem(TOKEN_KEY)
    tokenVerified = false
    $('token').value = ''
    $('tokenMsg').innerHTML = ''
    renderTokenUI()
    $('token').focus()
    state = null
    refresh()
    connectWS() // 旧令牌连接立即断开；输入新令牌并保存后由 connectWS 重建
    log('已清除令牌，等待重新输入', 'warn')
  }