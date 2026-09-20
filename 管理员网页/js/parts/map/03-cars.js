
  // ---- 无人车（实时位置 + 朝向箭头） ----
  function updateCars(robots) {
    var seen = {}
    ;(robots || []).forEach(function (r) {
      var g = ll(r)
      seen[r.device_sn] = true
      var mk = layers.cars[r.device_sn]
      if (!mk) {
        mk = L.marker(g, {
          icon: L.divIcon({
            className: 'carWrap',
            html: '<span class="carSvg">' + CAR_SVG + '</span><span class="carName">' + String(r.device_sn || '').slice(-6) + '</span>',
            iconSize: [34, 40], iconAnchor: [17, 17]
          })
        })
        mk.addTo(mapObj)
        layers.cars[r.device_sn] = mk
      } else mk.setLatLng(g)
      // 世界系 θ（弧度，逆时针为正，y 向上）→ 屏幕像素系（y 向下）后旋转方向同步翻转，
      // 与北向翻转互相抵消，仍用 deg = 90 - θ
      var deg = HEADING_OFFSET - num(r.theta) * 180 / Math.PI
      var el = mk.getElement()
      var cs = el && el.querySelector('.carSvg')
      if (cs) cs.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)'
      if (r.text && mk.getTooltip && !mk.getTooltip()) {
        mk.bindTooltip(r.text, { direction: 'top', className: 'lmTip' })
      } else if (r.text && mk.getTooltip && mk.getTooltip()) {
        mk.setTooltipContent(r.text)
      }
    })
    Object.keys(layers.cars).forEach(function (sn) {
      if (!seen[sn]) { mapObj.removeLayer(layers.cars[sn]); delete layers.cars[sn] }
    })
  }

  // ---- 批次聚焦：高亮指定批次配送站位（其余降透明度），并定位到该批 ----
  function applyRouteFocus() {
    if (!mapObj) return
    var has = false
    var pts = []
    Object.keys(layers.stops).forEach(function (key) {
      var bid = String(key).split('_')[0]
      var on = focusBatch && String(bid) === String(focusBatch)
      if (on) has = true
      var mk = layers.stops[key]
      var el = mk && mk.getElement ? mk.getElement() : null
      if (el) { el.style.opacity = on ? '1' : '0.22'; el.classList.toggle('focusStop', !!on) }
      if (on) pts.push(mk.getLatLng())
    })
    if (focusBatch && has && lastFitBatch !== focusBatch) {
      lastFitBatch = focusBatch
      mapObj.fitBounds(pts, { padding: [55, 55] })
    } else if (!focusBatch) {
      lastFitBatch = null
    }
  }
  window.highlightBatchDetail = function (batchId) {
    focusBatch = batchId === undefined || batchId === null ? null : String(batchId)
    applyRouteFocus()
  }
  window.clearBatchFocus = function () { highlightBatchDetail(null) }