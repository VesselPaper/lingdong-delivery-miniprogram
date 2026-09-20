
  // ---- 点位（机器人自身点位，来自平台 landmarkInfo） ----
  function usableLandmarks(map) {
    return (map.landmarks || []).filter(function (m) { return !/固定路径/.test(String(m.name || '')) })
  }
  function updateLandmarks(map) {
    var lms = usableLandmarks(map)
    var seen = {}
    lms.forEach(function (m) {
      var key = m.id != null ? m.id : m.name
      seen[key] = true
      var g = ll(m)
      var mk = layers.lms[key]
      if (!mk) {
        var isPatrol = m.type === 'patrolPoint'
        if (isPatrol) {
          // 巡逻点：保留悬停泡泡
          mk = L.circleMarker(g, { radius: 5, weight: 2, color: '#ffffff', fillColor: '#6d4bc4', fillOpacity: 1 })
          mk.bindTooltip(m.name || '', { direction: 'top', offset: [0, -8], className: 'lmTip' })
        } else {
          // 取货点/上货点/充电点：色点 + 名字文字整体渲染在标记上，名字必然常驻可见
          var color = m.type === 'loadingPoint' ? '#e8890c' : m.type === 'chargePoint' ? '#2f9e44' : '#1d5bd6'
          var html = '<i class="lmDot" style="background:' + color + '"></i><b class="lmName">' + esc(m.name || '') + '</b>'
          mk = L.marker(g, { icon: L.divIcon({ className: 'lmWrap x' + m.type, html: html, iconAnchor: [6, 8] }) })
        }
        mk.addTo(mapObj)
        layers.lms[key] = mk
      } else {
        mk.setLatLng(g)
        if (mk.getTooltip && mk.getTooltip() && m.name) mk.setTooltipContent(m.name)
      }
    })
    Object.keys(layers.lms).forEach(function (k) {
      if (!seen[k]) { mapObj.removeLayer(layers.lms[k]); delete layers.lms[k] }
    })
  }

  // ---- 配送站位（车将前往的配送点，按停靠顺序编号；不再画配送连线/路网连线） ----
  function updateRoutes(routes) {
    var r = (routes || []).filter(function (x) { return x && x.stops && x.stops.length > 0 })[0]
    var seenN = {}
    ;((r && r.stops) || []).forEach(function (s) {
      var key = (r ? r.batch_id : 'x') + '_' + num(s.stop)
      seenN[key] = true
      var g = ll(s)
      var mk = layers.stops[key]
      if (!mk) {
        mk = L.marker(g, {
          icon: L.divIcon({ className: 'stopWrap', html: stopSvg(num(s.stop)), iconSize: [22, 28], iconAnchor: [11, 28] })
        })
        mk.addTo(mapObj)
        layers.stops[key] = mk
      } else mk.setLatLng(g)
    })
    Object.keys(layers.stops).forEach(function (k) {
      if (!seenN[k]) { mapObj.removeLayer(layers.stops[k]); delete layers.stops[k] }
    })
  }