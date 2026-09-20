
  // ---- 渲染一轮 ----
  function renderMap(d) {
    initMap()
    var mask = $('mapMask')
    if (!mapObj) {
      if (mask) { mask.innerHTML = '<span class="spinner"></span><span>地图组件加载失败</span>'; mask.hidden = false }
      return
    }
    if (!d) return
    if (d.meta) META = d.meta
    lastData = d
    applyRadar()
    updateLandmarks(d)
    updateRoutes(d.routes)
    updateCars(d.robots)
    var foot = $('mapFoot')
    if (foot) {
      var res = META ? ' · 雷达图 ' + META.width + '×' + META.height : ''
      var stopsN = (d.routes || []).reduce(function (s, x) { return s + (((x && x.stops) || []).length) }, 0)
      mapFootBase = '点位 ' + usableLandmarks(d).length + ' 个 · 配送站位 ' + stopsN + ' 个 · 无人车 ' + (d.robots || []).length + ' 台' + res
      foot.textContent = mapFootBase + ' · 更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    setTimeout(function () { if (mapObj) mapObj.invalidateSize() }, 60)
    applyRouteFocus()
  }

  function setMask(text, show) {
    var mask = $('mapMask')
    if (!mask) return
    if (show) { mask.innerHTML = '<span class="spinner"></span><span>' + text + '</span>'; mask.hidden = false }
    else mask.hidden = true
  }

  // ---- 轮询 ----
  function poll() {
    var tk = localStorage.getItem(TOKEN_KEY)
    if (!tk) { setMask('等待令牌…', true); return }
    if (!mapObj) initMap()
    fetch('/api/admin/map', { headers: { 'x-admin-token': tk }, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '地图获取失败')
        setMask('', false)
        renderMap(j.data)
      })
      .catch(function (e) {
        if (String(e && e.message).indexOf('令牌') >= 0 || (e && e.message === '管理员令牌无效')) { setMask('令牌无效', true); return }
        setMask('地图数据获取失败', true)
        var foot = $('mapFoot')
        if (foot) foot.textContent = '地图获取失败：' + (e && e.message ? e.message : '网络错误')
      })
  }