
  // ---- 控件绑定 ----
  function wire() {
    var rt = $('mapResetBtn')
    if (rt) rt.addEventListener('click', function () {
      if (!mapObj) return
      if (META && META.width > 0) mapObj.fitBounds([[0, 0], [META.height, META.width]], { padding: [8, 8] })
      else mapObj.setView([0, 0], 1)
    })
    window.addEventListener('resize', function () { if (mapObj) setTimeout(function () { mapObj.invalidateSize() }, 80) })
  }

  // 供总览页标签切回机器人页时刷新地图尺寸
  window.invalidateAdminMap = function () {
    if (mapObj) setTimeout(function () { mapObj.invalidateSize() }, 60)
  }

  // 事件驱动：实时位置由后端推送（admin.js 收到 live 事件后调用本函数），原地只更新小车，不整体重拉。
  window.mapOnLive = function (robots) {
    if (!mapObj || !META) return // 底图/元数据未就绪，先等完整地图（初次加载 + WS 重连时 reloadAdminMap）
    var arr = Array.isArray(robots) ? robots : []
    if (arr.length) mapFollowTarget = arr[0]
    updateCars(arr)
    trackCar(arr)
    if (followCar && mapFollowTarget) {
      var c = ll(mapFollowTarget)
      // 首次进入：按 FOLLOW_M 放大并居中到小车（之后不再强制定位中心）
      if (mapObj.getZoom() < mapFollowZoom) {
        mapObj.fitBounds([[c[0] - padPx, c[1] - padPx], [c[0] + padPx, c[1] + padPx]], { animate: false })
      } else {
        // 「边沿跟随」：小车在中部约 33% 安全区时保持不动，让它先在视野里真实跑动；
        // 只有驶出安全区（接近边缘）才平滑平移追过去，避免「永远钉在屏幕中心→看着像没动」。
        var pt = mapObj.latLngToContainerPoint(L.latLng(c))
        var ctr = mapObj.getSize().divideBy(2)
        var limX = mapObj.getSize().x * 0.33
        var limY = mapObj.getSize().y * 0.33
        if (Math.abs(pt.x - ctr.x) > limX || Math.abs(pt.y - ctr.y) > limY) {
          mapObj.panTo(c, { animate: true })
        }
      }
    }
    // 实时心跳：每次 live 事件刷新「时间戳 + 各车坐标」，直观确认位置在刷
    var foot = $('mapFoot')
    if (foot) {
      var t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      var live = arr.map(function (r) { return '#' + String(r.device_sn || '').slice(-4) + '=' + num(r.x).toFixed(1) + ',' + num(r.y).toFixed(1) }).join('; ')
      foot.innerHTML = '<span class="live-dot"></span>' + esc((mapFootBase || '') + ' · 实时位置 ' + t + (live ? ' [' + live + ']' : ''))
    }
  }

  // ---- 跟随小车：读取第一次放大倍数后只居中不平移视野；DELETE 掉旧 target 确保跟随正确 ----
  var mapFollowTarget = null
  var mapFollowZoom = 0
  var padPx = 0
  function ensureFollowBtn() {
    if (document.getElementById('followCarBtn') || !mapObj) return
    var b = document.createElement('button')
    b.id = 'followCarBtn'; b.type = 'button'; b.className = 'followBtn'
    b.textContent = '跟随小车'
    b.addEventListener('click', function () {
      followCar = !followCar
      b.classList.toggle('on', followCar)
      b.textContent = followCar ? '跟随中·取消' : '跟随小车'
      if (followCar && mapFollowTarget && META) {
        padPx = Math.round((FOLLOW_M / META.resolution) / 2) // FOLLOW_M(米) 一半对应多少像素
        mapFollowZoom = (mapObj.getZoom() || 0) + 1
        var c = ll(mapFollowTarget)
        mapObj.fitBounds([[c[0] - padPx, c[1] - padPx], [c[0] + padPx, c[1] + padPx]], { animate: false })
      }
    })
    mapObj.getContainer().appendChild(b)
  }

  // 记录每台车最近位置，画轨迹（即使小位移也能看出在实时推进）
  function trackCar(arr) {
    arr.forEach(function (r) {
      var sn = r.device_sn
      if (!sn) return
      var b = trailBuff[sn] = (trailBuff[sn] || [])
      b.push([num(r.x), num(r.y)])
      if (b.length > 80) b.shift()
      if (b.length >= 2) {
        var pts = b.map(function (p) { return ll({ x: p[0], y: p[1] }) })
        if (!trails[sn]) trails[sn] = L.polyline(pts, { color: '#2f9e44', weight: 2, opacity: .55, dashArray: '4 6' }).addTo(mapObj)
        else trails[sn].setLatLngs(pts)
      }
    })
  }

  // WS 重连/初次加载时拉一次完整地图（点位/路网/配送站位/元数据）；之后实时位置走 mapOnLive。
  window.reloadAdminMap = function () { poll() }

  // 排障钩子：读取当前缩放状态
  window.adminMapDebug = function () {
    if (!mapObj) return null
    return { zoom: mapObj.getZoom(), minZoom: mapObj.getMinZoom(), center: mapObj.getCenter(), size: mapObj.getSize() }
  }

  function boot() {
    wire()
    initMap()
    ensureFollowBtn()
    // 初次加载拉一次完整地图（底图/点位/配送站位）；实时位置之后由 WS 推送（admin.mapOnLive），不再 4s 轮询。
    poll()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()