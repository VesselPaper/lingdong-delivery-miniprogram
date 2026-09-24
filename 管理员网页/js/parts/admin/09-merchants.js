
  // ---------- 商家管理（商家入驻邀请码：创建 / 列表 / 吊销 / 启用 / 解绑） ----------
  // 后端：/api/admin/merchants*（admin 域，2026-09-24 新增）。
  // 说明：邀请码只存哈希，明文只在创建时返回一次；列表只显示绑定/有效状态。
  var merchantsCache = null

  function loadMerchants() {
    api('/merchants').then(function (d) {
      merchantsCache = d
      renderMerchants()
      log('商家列表已加载（' + (d.merchants || []).length + ' 家）')
    }).catch(function (e) {
      if (!isUnauthorized(e)) {
        var box = $('merchantList'); if (box) box.innerHTML = '<span class="mini bad">加载失败：' + esc(e.message) + '</span>'
        log('商家列表加载失败：' + e.message, 'bad')
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
    var cnt = $('merchantCount'); if (cnt) cnt.textContent = '共 ' + ms.length + ' 家商家'
    var tag = $('merchantTag')
    if (tag) {
      tag.textContent = d.configured ? '邀请码可用' : '暂无有效邀请码'
      tag.className = 'tag ' + (d.configured ? '' : 'red')
    }
    if (!ms.length) { list.innerHTML = '<span class="mini">还没有商家邀请码，请先在左侧创建。</span>'; return }
    var html = ''
    ms.forEach(function (m) {
      var stateCls = m.active ? 'green' : 'gray'
      var stateTxt = m.active ? '有效' : '已吊销'
      var boundTxt = m.bound ? ('已绑定 ' + esc(m.bound_openid || '')) : '未绑定'
      html += '<div class="merchant-row">'
        + '<div class="merchant-main">'
        + '<div class="merchant-name">' + esc(m.name || '（未命名）') + (m.active ? '' : ' <span class="tag gray">已吊销</span>') + '</div>'
        + '<div class="mini">' + (m.note ? esc(m.note) + ' · ' : '') + '创建于 ' + esc(m.created_at || '') + '</div>'
        + '<div class="mini">' + boundTxt + '</div>'
        + '</div>'
        + '<div class="merchant-ops">'
        + (m.active
            ? '<button class="btn ghost sm" onclick="merchantRevoke(' + m.id + ')">吊销</button>'
            : '<button class="btn ghost sm" onclick="merchantActivate(' + m.id + ')">启用</button>')
        + (m.bound ? '<button class="btn ghost sm" onclick="merchantUnbind(' + m.id + ')">解绑</button>' : '')
        + '</div>'
        + '</div>'
    })
    list.innerHTML = html
  }

  // 创建：生成邀请码并展示明文（只此一次）
  function merchantCreate() {
    var name = $('merchantName').value.trim()
    var code = $('merchantCode').value.trim()
    var note = $('merchantNote').value.trim()
    var msg = $('merchantCreateMsg')
    if (!name) { msg.className = 'token-msg err'; msg.innerHTML = '请填写店名'; return }
    $('merchantCreate').disabled = true
    msg.className = 'token-msg'; msg.innerHTML = '生成中…'
    api('/merchants/create', 'POST', { name: name, note: note, code: code }).then(function (d) {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg ok'
      msg.innerHTML = '已生成邀请码（店名：' + esc(name) + '）：<b class="mono">' + esc(d.code) + '</b>'
        + '<div class="mini">明文只显示这一次，请立即复制并线下发给该商家；重新生成会吊销旧码。</div>'
      $('merchantName').value = ''; $('merchantCode').value = ''; $('merchantNote').value = ''
      loadMerchants()
    }).catch(function (e) {
      $('merchantCreate').disabled = false
      msg.className = 'token-msg err'
      msg.innerHTML = esc((e && e.message) || '生成失败')
    })
  }
  window.merchantCreate = merchantCreate

  function merchantRevoke(id) {
    var m = (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
    var name = m ? (m.name || '') : ''
    openConfirmModal('吊销邀请码', '吊销后 <b>' + esc(name || '该商家') + '</b> 将无法再使用此邀请码登录（已登录的商家不受影响）。确定吊销？', function () {
      api('/merchants/revoke', 'POST', { id: id }).then(function () {
        toast('已吊销', 'ok')
        loadMerchants()
      }).catch(function (e) { opFail(e, '吊销') })
    })
  }
  window.merchantRevoke = merchantRevoke

  function merchantActivate(id) {
    api('/merchants/activate', 'POST', { id: id }).then(function () {
      toast('已重新启用', 'ok')
      loadMerchants()
    }).catch(function (e) { opFail(e, '启用') })
  }
  window.merchantActivate = merchantActivate

  function merchantUnbind(id) {
    var m = (merchantsCache && merchantsCache.merchants || []).find(function (x) { return x.id === id })
    var name = m ? (m.name || '') : ''
    openConfirmModal('解绑邀请码', '解绑后 <b>' + esc(name || '该商家') + '</b> 的原绑定微信失效，该码可由另一个微信重新绑定。确定解绑？', function () {
      api('/merchants/unbind', 'POST', { id: id }).then(function () {
        toast('已解绑', 'ok')
        loadMerchants()
      }).catch(function (e) { opFail(e, '解绑') })
    })
  }
  window.merchantUnbind = merchantUnbind

  // 页面事件绑定
  var cBtn = $('merchantCreate')
  if (cBtn) cBtn.onclick = merchantCreate
  var rBtn = $('merchantReload')
  if (rBtn) rBtn.onclick = loadMerchants
