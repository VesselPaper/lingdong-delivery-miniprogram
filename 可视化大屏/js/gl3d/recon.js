/* ============================================================
 * gl3d/recon.js — 真 3D 渲染器的「3D 图层重构」面板控制器
 * ------------------------------------------------------------
 * 它不改投影/渲染/颜色，只负责「把灰色 OSM 路网/楼体逐栋逐路校补到雷达激光图真实位置」。
 *
 * 交互升级（本次）：
 *   · 点杀选取：切到「楼栋/道路」后，直接在地图上点道路/楼栋 → 金色高亮选中，即进入编辑；
 *   · 改名 / 删除 / 新增（楼栋与道路通用）；
 *   · 新增道路画折线、新增楼栋画轮廓（多边型，完成时闭合）；软删除（重置可恢复）。
 *
 * 数据模型（与主渲染器共享，存放在 host.state）：
 *   RECON.global / bld / road / delRoads / addRoads / delBlds / addBlds /
 *          bldNames / roadNames / roadCls / bldHeight
 *   键约定：原建筑/道路用下标 '#i'；新增对象（addBlds/addRoads）用 '#add:'+序。
 * 结果持久化 localStorage「dash3d_recon」。
 *
 * 接线：仅持有一个 host（由 map3d-gl.js 构造并调用 bind()），
 *       所有对主渲染器的调用都经 host。
 * ============================================================ */
window.Map3DGLRecon = (function () {
  'use strict'

  var host = null           // 由 map3d-gl.js 注入
  var reconMode = 'global'  // mode ∈ {global, bld, road}
  var reconSelKey = null    // 供下拉回显；编辑对象以 editRec 为准
  var editRec = null        // 当前编辑对象：{kind,key,name,subtype}；null=未选中

  /* ---------------- 撤销 / 还原历史栈 ----------------
   * 每次会改动 RECON 的操作（微调/旋转/缩放/改名/删除/新增/重置）前 pushHist() 把「操作前」状态
   * 压入 undoStack；undo() 弹出一个并压入 redoStack。新操作会清空 redoStack。
   */
  var undoStack = []        // 每次操作前的历史状态（回溯依据）
  var redoStack = []        // 撤销掉的状态（可还原）
  var HIST_MAX = 120
  // 本次会话是否真的改过东西：只用于给「保存」加一道闸 ——
  // 页面刚打开、一次都没改过时禁止写服务器，避免"加载失败退化成内置默认地图后
  // 顺手点一下保存"把服务器上的版本整个覆盖掉。单向：改过就永久为 true。
  var dirty = false
  function pushHist() {
    var R = RECON(); if (!R) return
    dirty = true
    undoStack.push(cloneRecon(R))
    if (undoStack.length > HIST_MAX) undoStack.shift()
    redoStack = []          // 新操作使既有「还原」失效
    updateHistButtons()
  }
  function cloneRecon(R) {
    return JSON.parse(JSON.stringify(R))
  }
  // 把快照写回主渲染器（替换 RECON 并重建 + 刷新选中）
  function applySnapshot(snap) {
    if (host && host.setRECON) host.setRECON(snap)
    rebuildGrey()
    // 撤销后若当前编辑对象不存在，需重新定位
    if (editRec) {
      var keys = editKeys()
      var list = reconMode === 'bld' ? keys.bld : keys.road
      if (list.indexOf(editRec.key) < 0) { editRec = null; setEdited(null) }
    }
    fillReconSelect()
    updateReconDelta()
    cancelSync()
    persistBackend('已撤回/还原（已保存到服务器）')
  }
  // 把当前 RECON 同步给服务器（撤回/还原也是真实业务操作，改动要落到后端共享）
  function persistBackend(note) {
    // 本机立即生效
    if (host && host.saveRecon) host.saveRecon()
    var api = window.Dash && window.Dash.api && window.Dash.api.saveRecon
    if (api) {
      api(RECON()).then(function () {
        var n = document.getElementById('alignNote'); if (n) n.textContent = note || '已同步到服务器'
      }).catch(function (e) {
        var n = document.getElementById('alignNote'); if (n) n.textContent = '已保存本机；写服务器失败'
      })
    } else {
      var n2 = document.getElementById('alignNote'); if (n2) n2.textContent = '已保存本机（localStorage）'
    }
  }
  /* ---------------- 改动后自动保存 ----------------
   * 任何会改 RECON 的操作结束后延迟 1.2s 统一写一次服务器：
   * 连续点方向键 / 连点缩放时只在"停下来"之后发一次 POST，不刷屏。
   * 手动「保存」与「撤回/还原」会先取消待执行的自动保存，避免重复写。 */
  var syncTimer = null
  function cancelSync() { if (syncTimer) { clearTimeout(syncTimer); syncTimer = null } }
  function scheduleSync() {
    cancelSync()
    syncTimer = setTimeout(function () {
      syncTimer = null
      persistBackend('已自动保存到服务器（全局生效）')
    }, 1200)
  }
  function undo() {
    if (!undoStack.length) return
    redoStack.push(cloneRecon(RECON()))
    applySnapshot(undoStack.pop())
    updateHistButtons()
  }
  function redo() {
    if (!redoStack.length) return
    undoStack.push(cloneRecon(RECON()))
    applySnapshot(redoStack.pop())
    updateHistButtons()
  }
  function updateHistButtons() {
    var u = document.getElementById('alUndo')
    if (u) u.disabled = (undoStack.length === 0)
    var r = document.getElementById('alRedo')
    if (r) r.disabled = (redoStack.length === 0)
  }
  function clearHist() {
    undoStack = []; redoStack = []; updateHistButtons()
  }

  /* ---------------- 状态读写（经 host 转发到主渲染器闭包） ---------------- */
  function RECON() { return host ? host.RECON() : null }
  function calib() { return host ? host.calib() : null }
  function getScene() { return host ? host.scene() : null }
  function rebuildGrey() { if (host && host.rebuildGrey) host.rebuildGrey() }
  function rebuildReconScene() { rebuildGrey(); updateReconDelta() }
  function setEdited(v) { if (host && host.setEdited) host.setEdited(v) }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

  /* ---------------- 目标对象定位 ----------------
   * 下拉键列表（bld:['#0','#1',...]，road 同理），列表值= key 字符串。
   * 额外列出新增对象（#add:n）与软删标记（显示（已隐藏））。
   */
  function editKeys() {
    var R = RECON()
    var c = calib()
    var out = { bld: [], road: [] }
    if (!c) return out
    var bb = Array.isArray(c.buildings) ? c.buildings : []
    var rr = Array.isArray(c.roads) ? c.roads : []
    for (var i = 0; i < bb.length; i++) {
      if (R && R.delBlds && R.delBlds['#' + i]) continue
      out.bld.push('#' + i)
    }
    for (var j = 0; j < rr.length; j++) {
      var r = rr[j]
      if (R && R.delRoads && (R.delRoads['#' + j] || R.delRoads[r.name])) continue
      out.road.push('#' + j)
    }
    ;(R && R.addBlds ? R.addBlds : []).forEach(function (b, k) { out.bld.push('#add:' + k) })
    ;(R && R.addRoads ? R.addRoads : []).forEach(function (r, k) { out.road.push('#add:' + k) })
    return out
  }
  function editKeyName(kind, key) {
    var R = RECON()
    var c = calib()
    if (key == null) return ''
    if (kind === 'bld') {
      if (String(key).indexOf('#add:') === 0) {
        var ab = (R && R.addBlds ? R.addBlds : [])[Number(String(key).split(':')[1])]
        return (ab && ab.name) || '新楼'
      }
      var bi = Number(String(key).replace(/^\#/, ''))
      var b = c && c.buildings ? c.buildings[bi] : null
      return (b && b.name) || ('楼栋#' + bi)
    }
    if (String(key).indexOf('#add:') === 0) {
      var ar = (R && R.addRoads ? R.addRoads : [])[Number(String(key).split(':')[1])]
      return (ar && ar.name) || '新路'
    }
    var ri = Number(String(key).replace(/^\#/, ''))
    var r = c && c.roads ? c.roads[ri] : null
    return (r && r.name) || ('道路#' + ri)
  }
  // 当前编辑对象在 RECON 里的数据引用（global 时返回 null；偏移/新增对象返回本体）
  function reconEntry() {
    var R = RECON(); if (!R) return null
    if (reconMode === 'global') return R.global
    var rec = editRec || {}
    if (rec.subtype === 'add') {
      if (rec.kind === 'bld') {
        var ab = (R.addBlds || [])[Number(String(rec.key).split(':')[1])]
        return ab || null
      }
      var ar = (R.addRoads || [])[Number(String(rec.key).split(':')[1])]
      return ar || null
    }
    if (rec.kind === 'bld') {
      var bi = Number(String(rec.key).replace(/^\#/, ''))
      if (!R.bld[rec.key]) R.bld[rec.key] = { dx: 0, dy: 0 }
      return R.bld[rec.key]
    }
    var ri = Number(String(rec.key).replace(/^\#/, ''))
    if (!R.road[rec.key]) R.road[rec.key] = { dx: 0, dy: 0 }
    return R.road[rec.key]
  }
  // 当前选中楼栋的默认高度（米）：原楼栋读标定，新增楼栋读本体 height_m
  function bldDefaultHeight() {
    var R = RECON(), c = calib()
    if (!editRec || editRec.kind !== 'bld') return null
    if (editRec.subtype === 'add') {
      var ab = (R && R.addBlds ? R.addBlds : [])[Number(String(editRec.key).split(':')[1])]
      if (ab) return num(ab.height_m) || 12
      return null
    }
    var bi = Number(String(editRec.key).replace(/^\#/, ''))
    var b = c && c.buildings ? c.buildings[bi] : null
    return b ? num(b.height_m) : null
  }
  // 当前有效高度：bldHeight 覆盖优先，否则默认高度
  function bldCurrentHeight() {
    var R = RECON()
    var def = bldDefaultHeight()
    if (editRec && editRec.subtype === 'orig') {
      var h = R && R.bldHeight && R.bldHeight[editRec.key]
      if (typeof h === 'number' && isFinite(h)) return h
    }
    return def
  }
  // 更新高度行显示（仅 bld 模式且有选中时显示）
  function updateHeightRow() {
    var row = document.getElementById('alHeightRow')
    var val = document.getElementById('alHeightVal')
    if (!row || !val) return
    if (reconMode !== 'bld' || !editRec) { row.style.display = 'none'; return }
    row.style.display = 'flex'
    var h = bldCurrentHeight()
    val.textContent = (h == null) ? '—' : h.toFixed(1) + 'm'
  }
  function updateReconDelta() {
    var el = document.getElementById('alignDelta')
    if (!el) return
    updateHeightRow()
    var R = RECON(); if (!R) return
    var sc = getScene()
    var cal = calib()
    var ppm = sc && sc.pxPerM ? sc.pxPerM : (cal && cal.scale_px_per_m) || 19.45
    if (reconMode === 'global') {
      var g = R.global
      el.textContent = '全域 → X ' + (g.tx / ppm).toFixed(1) + 'm · Y ' + (g.ty / ppm).toFixed(1) +
        'm · 旋转 ' + g.rot.toFixed(1) + '°' + (g.sc !== 1 ? ' · 缩放 ' + g.sc.toFixed(3) : '')
      return
    }
    if (!editRec) { el.textContent = '未选中，请在地图上点选' + (reconMode === 'bld' ? '楼栋' : '道路'); return }
    var name = editRec.name || editKeyName(reconMode, editRec.key)
    if (editRec.subtype === 'add') {
      var e = reconEntry()
      var cnt = (reconMode === 'bld' && e && Array.isArray(e.ring)) ? e.ring.length : (Array.isArray(e && e.pts) ? e.pts.length : 0)
      var atxt = '新增' + (reconMode === 'bld' ? '楼栋' : '道路') + '「' + name + '」' + (cnt ? ' · ' + cnt + ' 点' : '')
      if (e) { var rv = num(e.rot), sv = (typeof e.sc === 'number' && e.sc > 0) ? e.sc : 1; if (rv) atxt += ' · 旋转 ' + rv.toFixed(1) + '°'; if (sv !== 1) atxt += ' · 缩放 ' + sv.toFixed(3) }
      el.textContent = atxt
      return
    }
    var e2 = reconEntry()
    if (!e2) { el.textContent = '未选中'; return }
    var txt = (reconMode === 'bld' ? '楼栋 ' : '道路 ') + name + ' → X ' + (e2.dx / ppm).toFixed(1) + 'm · Y ' + (e2.dy / ppm).toFixed(1) + 'm'
    var rv2 = num(e2.rot), sv2 = (typeof e2.sc === 'number' && e2.sc > 0) ? e2.sc : 1
    if (rv2) txt += ' · 旋转 ' + rv2.toFixed(1) + '°'
    if (sv2 !== 1) txt += ' · 缩放 ' + sv2.toFixed(3)
    el.textContent = txt
  }
  function fillReconSelect() {
    var sel = document.getElementById('reconSel')
    var modeWrap = document.getElementById('reconModeWrap')
    var editBtns = document.getElementById('reconEditBtns')
    var addHint = document.getElementById('reconAddHint')
    if (!sel) return
    var show = reconMode !== 'global'
    if (modeWrap) modeWrap.style.display = show ? 'block' : 'none'
    if (editBtns) editBtns.style.display = show ? 'flex' : 'none'
    if (addHint) addHint.hidden = true
    while (sel.firstChild) sel.removeChild(sel.firstChild)
    if (!show) { reconSelKey = null; setEdited(null); updateReconDelta(); return }
    var keys = editKeys()
    var list = reconMode === 'bld' ? keys.bld : keys.road
    // 保持当前 editRec 选中；否则留空让用户去地图点选
    var curKey = editRec && editRec.kind === reconMode ? editRec.key : null
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option')
      o.value = list[i]
      o.textContent = editKeyName(reconMode, list[i])
      if (list[i] === curKey) o.selected = true
      sel.appendChild(o)
    }
    if (!curKey) {
      reconSelKey = null; editRec = null; setEdited(null)
    } else {
      reconSelKey = curKey
    }
    updateReconDelta()
  }
  // 设定编辑对象并点亮高亮与下拉（高亮在叠加层逐帧绘制，只需写到 host 即可）
  function selectEdit(key) {
    if (key == null) { editRec = null; setEdited(null); updateReconDelta(); return }
    editRec = { kind: reconMode, key: String(key), name: editKeyName(reconMode, String(key)), subtype: String(key).indexOf('#add:') === 0 ? 'add' : 'orig' }
    setEdited({ kind: reconMode, key: editRec.key, name: editRec.name, subtype: editRec.subtype })
    var sel = document.getElementById('reconSel')
    if (sel) { sel.value = editRec.key }
    updateReconDelta()
  }
  // 点击地图命中后回调（由地图点击监听调用）
  function pickAt(xy) {
    if (reconMode === 'global') return null
    var r = host && host.pickAt ? host.pickAt(xy[0], xy[1]) : null
    if (r && r.kind === reconMode) {
      reconSelKey = r.key
      fillReconSelect()
      selectEdit(r.key)
    } else {
      selectEdit(null)
      var n = document.getElementById('alignNote')
      if (n) n.textContent = '未命中' + (reconMode === 'bld' ? '楼栋' : '道路') + '，请点在线条/轮廓上再试'
    }
    return r
  }
  function bindReconControls(al, panel) {
    if (!al || !panel) return
    var step = 1
    function setStep(v) { step = v; if (host && host.setStep) host.setStep(v) }
    var ppmOf = function () { var sc = getScene(); return sc ? sc.pxPerM : 19.45 }
    var apply = function () { rebuildReconScene() }
    al.addEventListener('click', function () {
      panel.hidden = !panel.hidden
      al.classList.toggle('on', !panel.hidden)
      if (!panel.hidden) { fillReconSelect(); updateReconDelta() }
    })
    Array.prototype.forEach.call(panel.querySelectorAll('[data-recon-mode]'), function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-recon-mode')
        if (reconDrawActive()) { if (host && host.cancelReconDraw) host.cancelReconDraw() }
        reconMode = m
        Array.prototype.forEach.call(panel.querySelectorAll('[data-recon-mode]'), function (x) {
          x.classList.toggle('on', x === b)
        })
        editRec = null; setEdited(null)
        fillReconSelect(); updateReconDelta()
      })
    })
    var sel = panel.querySelector('#reconSel')
    if (sel) sel.addEventListener('change', function () { if (sel.value) selectEdit(sel.value) })
    // 旋转滑块：实时显示角度，点「应用旋转」写入
    var rotDrag = panel.querySelector('#alRotDrag')
    var rotVal = panel.querySelector('#alRotVal')
    var rotApply = panel.querySelector('#alRotApply')
    if (rotDrag) rotDrag.addEventListener('input', function () {
      var v = Number(rotDrag.value)
      if (rotVal) rotVal.textContent = v + '°'
    })
    if (rotApply) rotApply.addEventListener('click', function () {
      var v = rotDrag ? Number(rotDrag.value) : 0
      if (rotVal) rotVal.textContent = v + '°'
      applyObjRotTo(v)
    })
    function nudge(dx, dy) {
      var R = RECON(); if (!R) return
      pushHist()
      var s = step * ppmOf()
      if (reconMode === 'global') { R.global.tx += dx * s; R.global.ty += dy * s; apply(); scheduleSync(); return }
      var e = reconEntry()
      if (!e) return
      if (editRec && editRec.subtype === 'add') {
        if (reconMode === 'bld' && Array.isArray(e.ring)) {
          for (var i = 0; i < e.ring.length; i++) { e.ring[i][0] += dx * s; e.ring[i][1] += dy * s }
        } else if (Array.isArray(e.pts)) {
          for (var j = 0; j < e.pts.length; j++) { e.pts[j][0] += dx * s; e.pts[j][1] += dy * s }
        }
      }
      else { e.dx += dx * s; e.dy += dy * s }
      apply()
      scheduleSync()
    }
    // 对选中对象应用旋转 deltaRot（度）或缩放 deltaSc（倍）。global 模式退化为全域变换。
    function applyObjRotScale(deltaRot, deltaSc) {
      var R = RECON(); if (!R) return
      pushHist()
      if (reconMode === 'global') {
        if (deltaRot) R.global.rot = num(R.global.rot) + deltaRot
        if (deltaSc) R.global.sc = Math.max(0.5, num(R.global.sc) + deltaSc)
        apply(); scheduleSync(); return
      }
      if (!editRec) {
        var nn = document.getElementById('alignNote'); if (nn) nn.textContent = '请先在地图上选中要旋转/缩放的' + (reconMode === 'bld' ? '楼栋' : '道路')
        return
      }
      var e = reconEntry()
      if (!e) return
      if (deltaRot) e.rot = num(e.rot) + deltaRot
      if (deltaSc) {
        var cur = (typeof e.sc === 'number' && e.sc > 0) ? e.sc : 1
        e.sc = Math.max(0.5, cur + deltaSc)
      }
      apply()
      scheduleSync()
    }
    // 把选中的对象（或 global）旋转到指定**绝对角度**（度）。供滑块使用。
    function applyObjRotTo(deg) {
      var R = RECON(); if (!R) return
      pushHist()
      if (reconMode === 'global') { R.global.rot = num(deg); apply(); scheduleSync(); return }
      if (!editRec) { var nn = document.getElementById('alignNote'); if (nn) nn.textContent = '请先在地图上选中要旋转的' + (reconMode === 'bld' ? '楼栋' : '道路'); return }
      var e = reconEntry()
      if (!e) return
      e.rot = num(deg)
      apply()
      scheduleSync()
    }
    // 对选中楼栋增减高度 deltaH（米）。仅 bld 模式生效。
    function applyBldHeight(deltaH) {
      var R = RECON(); if (!R) return
      if (reconMode !== 'bld' || !editRec || editRec.kind !== 'bld') {
        var nh = document.getElementById('alignNote'); if (nh) nh.textContent = '请先在「楼栋」模式下选中一栋楼'
        return
      }
      pushHist()
      var cur = bldCurrentHeight()
      if (editRec.subtype === 'add') {
        var ab = (R.addBlds || [])[Number(editRec.key.split(':')[1])]
        if (ab) ab.height_m = Math.max(1, (cur == null ? 12 : cur) + num(deltaH))
      } else {
        R.bldHeight = R.bldHeight || {}
        R.bldHeight[editRec.key] = Math.max(1, (cur == null ? 12 : cur) + num(deltaH))
      }
      apply()
      scheduleSync()
      var nh2 = document.getElementById('alignNote')
      if (nh2) nh2.textContent = '已调整楼栋高度 ' + (bldCurrentHeight() == null ? '—' : bldCurrentHeight().toFixed(1)) + 'm'
    }
    Array.prototype.forEach.call(panel.querySelectorAll('[data-dx]'), function (b) {
      if (b.getAttribute('data-dx') == null) return
      b.addEventListener('click', function () { nudge(Number(b.getAttribute('data-dx')), Number(b.getAttribute('data-dy'))) })
    })
    Array.prototype.forEach.call(panel.querySelectorAll('[data-rot]'), function (b) {
      b.addEventListener('click', function () {
        applyObjRotScale(Number(b.getAttribute('data-rot')), 0)
      })
    })
    Array.prototype.forEach.call(panel.querySelectorAll('[data-sc-inc]'), function (b) {
      b.addEventListener('click', function () {
        applyObjRotScale(0, Number(b.getAttribute('data-sc-inc')))
      })
    })
    Array.prototype.forEach.call(panel.querySelectorAll('[data-h-inc]'), function (b) {
      b.addEventListener('click', function () {
        applyBldHeight(Number(b.getAttribute('data-h-inc')))
      })
    })
    var reset = panel.querySelector('#alReset')
    if (reset) reset.addEventListener('click', function () {
      var R = RECON(); if (!R) return
      pushHist()
      if (reconMode === 'global') R.global = { tx: 0, ty: 0, rot: 0, sc: 1 }
      else if (editRec) {
        if (editRec.subtype === 'add') {
          if (reconMode === 'bld' && R.addBlds) { R.addBlds.splice(Number(editRec.key.split(':')[1]), 1); selectEdit(null) }
          else if (R.addRoads) R.addRoads.splice(Number(editRec.key.split(':')[1]), 1)
        } else if (reconMode === 'bld') {
          R.bld[editRec.key] = { dx: 0, dy: 0 }
          if (R.delBlds) delete R.delBlds[editRec.key]
          if (R.bldNames) delete R.bldNames[editRec.key]
        } else {
          R.road[editRec.key] = { dx: 0, dy: 0 }
          if (R.delRoads) delete R.delRoads[editRec.key]
          if (R.roadNames) delete R.roadNames[editRec.key]
        }
      }
      apply()
      scheduleSync()
      var n = panel.querySelector('#alignNote'); if (n) n.textContent = '已重置当前对象（正在自动保存…）'
    })
    // ---- 改名 ----
    var rename = panel.querySelector('#alRename')
    if (rename) rename.addEventListener('click', function () {
      if (reconMode === 'global' || !editRec) { var nn = document.getElementById('alignNote'); if (nn) nn.textContent = '请先选中要改名的' + (reconMode === 'bld' ? '楼栋' : '道路'); return }
      var R = RECON(); if (!R) return
      var oldName = editRec.name
      var newNm = window.prompt('给「' + oldName + '」重新命名：', oldName)
      if (!newNm || !newNm.trim()) return
      newNm = newNm.trim()
      pushHist()
      if (reconMode === 'bld') {
        if (editRec.subtype === 'add') {
          var ab = (R.addBlds || [])[Number(editRec.key.split(':')[1])]
          if (ab) ab.name = newNm
        } else {
          R.bldNames = R.bldNames || {}; R.bldNames[editRec.key] = newNm
        }
        rebuildReconScene()
        scheduleSync()
        var nb = document.getElementById('alignNote'); if (nb) nb.textContent = '已把楼栋「' + oldName + '」改名「' + newNm + '」（正在自动保存…）'
      } else {
        if (editRec.subtype === 'add') {
          var ar = (R.addRoads || [])[Number(editRec.key.split(':')[1])]
          if (ar) ar.name = newNm
        } else {
          R.roadNames = R.roadNames || {}; R.roadNames[editRec.key] = newNm
        }
        rebuildReconScene()
        scheduleSync()
        var nr = document.getElementById('alignNote'); if (nr) nr.textContent = '已把道路「' + oldName + '」改名「' + newNm + '」（正在自动保存…）'
      }
      fillReconSelect(); updateReconDelta()
    })
    // ---- 删除（软删除：重名可恢复） ----
    var del = panel.querySelector('#alDel')
    if (del) del.addEventListener('click', function () {
      if (reconMode === 'global' || !editRec) { var nd = document.getElementById('alignNote'); if (nd) nd.textContent = '请先选中要删除的' + (reconMode === 'bld' ? '楼栋' : '道路'); return }
      var R = RECON(); if (!R) return
      pushHist()
      var name = editRec.name
      if (reconMode === 'bld') {
        if (editRec.subtype === 'add') {
          var ab = (R.addBlds || []); ab.splice(Number(editRec.key.split(':')[1]), 1)
        } else {
          R.delBlds = R.delBlds || {}; R.delBlds[editRec.key] = true
        }
      } else {
        if (editRec.subtype === 'add') {
          var ar = (R.addRoads || []); ar.splice(Number(editRec.key.split(':')[1]), 1)
        } else {
          R.delRoads = R.delRoads || {}; R.delRoads[editRec.key] = true
        }
      }
      editRec = null; setEdited(null)
      apply()
      scheduleSync()
      var ne = document.getElementById('alignNote'); if (ne) ne.textContent = '已删除「' + name + '」（软删除，点「重置」可恢复；正在自动保存…）'
      fillReconSelect()
    })
    // ---- 新增（道路折线 / 楼栋轮廓） ----
    var addObj = panel.querySelector('#alAddObj')
    if (addObj) addObj.addEventListener('click', function () {
      if (reconMode === 'global') return
      if (host && host.beginReconDraw) host.beginReconDraw(reconMode === 'bld' ? 'bld' : 'road')
      var ah = document.getElementById('reconAddHint'); if (ah) ah.hidden = false
    })
    var fin = panel.querySelector('#alFinishDraw')
    if (fin) fin.addEventListener('click', function () {
      if (host && host.finishReconDraw) host.finishReconDraw()
      var ah = document.getElementById('reconAddHint'); if (ah) ah.hidden = true
      fillReconSelect()
    })
    var canc = panel.querySelector('#alCancelDraw')
    if (canc) canc.addEventListener('click', function () {
      if (host && host.cancelReconDraw) host.cancelReconDraw()
      var ah = document.getElementById('reconAddHint'); if (ah) ah.hidden = true
      var n = panel.querySelector('#alignNote'); if (n) n.textContent = '已取消画线'
    })
    var read = panel.querySelector('#alRead')
    if (read) read.addEventListener('click', function () {
      // 优先从服务器读取（全局一致）；服务器没有时回退本机 localStorage
      var api = window.Dash && window.Dash.api && window.Dash.api.getRecon ? window.Dash.api : null
      if (api) {
        api.getRecon().then(function (d) {
          if (d && d.recon && typeof d.recon === 'object') {
            if (host && host.setRECON) host.setRECON(JSON.parse(JSON.stringify(d.recon)))
            rebuildReconScene()
            fillReconSelect(); apply()
            var n = panel.querySelector('#alignNote')
            if (n) n.textContent = '已读取服务器上的重构数据'
          } else {
            if (host && host.loadRecon) host.loadRecon()
            fillReconSelect(); apply()
            var n2 = panel.querySelector('#alignNote')
            if (n2) n2.textContent = '服务器暂无重构数据，已读取本机存档 dash3d_recon'
          }
        }).catch(function () {
          if (host && host.loadRecon) host.loadRecon()
          fillReconSelect(); apply()
          var n3 = panel.querySelector('#alignNote')
          if (n3) n3.textContent = '读取服务器失败，已读取本机存档 dash3d_recon'
        })
      } else {
        if (host && host.loadRecon) host.loadRecon()
        fillReconSelect(); apply()
        var n4 = panel.querySelector('#alignNote')
        if (n4) n4.textContent = '已读取本机存档 dash3d_recon'
      }
    })
    var sav = panel.querySelector('#alSave')
    if (sav) sav.addEventListener('click', function () {
      // 闸：本次会话一次都没改过 → 不写服务器（防止用内置默认地图覆盖服务器版本）
      if (!dirty) {
        var ns = panel.querySelector('#alignNote')
        if (ns) ns.textContent = '没有需要保存的改动'
        return
      }
      cancelSync()   // 手动保存优先，取消待执行的自动保存，避免重复写
      // 本地 localStorage 立即生效（兼容旧版）
      if (host && host.saveRecon) host.saveRecon()
      updateReconDelta()
      // 同时写服务器：让任何设备打开都看到这份重构（全局共享，真实业务持久化）
      var rec = window.Dash && window.Dash.api && window.Dash.api.saveRecon ? RECON() : null
      if (rec && window.Dash.api.saveRecon) {
        window.Dash.api.saveRecon(rec)
          .then(function () {
            var n = panel.querySelector('#alignNote')
            if (n) n.textContent = '已保存：本机 + 服务器（全局生效，任何设备打开都一致）'
          })
          .catch(function (e) {
            var n = panel.querySelector('#alignNote')
            if (n) n.textContent = '已保存到本机；写服务器失败（' + (e && e.message ? e.message : '未知') + '）'
          })
      } else {
        var n2 = panel.querySelector('#alignNote')
        if (n2) n2.textContent = '已保存到本机（localStorage: dash3d_recon）→ 刷新后仍生效'
      }
    })
    // ---- 撤销 / 还原 ----
    var und = panel.querySelector('#alUndo')
    if (und) und.addEventListener('click', function () { undo() })
    var redoBt = panel.querySelector('#alRedo')
    if (redoBt) redoBt.addEventListener('click', function () { redo() })
    // ---- 地图点击拾取：由主渲染器 map3d-gl.js 的画布 click 调 window.Map3DGLRecon.pickAt ----
    document.addEventListener('keydown', function (e) {
      if (panel.hidden) return
      var k = e.key, h = true
      if (k === 'ArrowLeft') nudge(-1, 0)
      else if (k === 'ArrowRight') nudge(1, 0)
      else if (k === 'ArrowUp') nudge(0, -1)
      else if (k === 'ArrowDown') nudge(0, 1)
      else h = false
      if (h) e.preventDefault()
    })
  }
  // 主渲染器在画布上触发的点选顶起（供 bindInput click 调用）
  function reconDrawActive() { return host && host.reconDrawActive ? host.reconDrawActive() : false }

  /* ---------------- 对外接口 ---------------- */
  return {
    bind: function (h) { host = h },
    bindReconControls: bindReconControls,
    fillReconSelect: fillReconSelect,
    updateReconDelta: updateReconDelta,
    reconKeys: editKeys,
    mode: function () { return reconMode },
    pickAt: pickAt,
    openPanel: function () { fillReconSelect(); updateReconDelta() },
    // 供主渲染器在真正改动 RECON 前调用一次（例如「新增道路/楼栋」完成落库）
    beforeChange: pushHist,
    // 供主渲染器在新增道路/楼栋落库后调用：延迟统一写服务器
    scheduleSync: scheduleSync,
    undo: undo,
    redo: redo,
    canUndo: function () { return undoStack.length > 0 },
    canRedo: function () { return redoStack.length > 0 }
  }
})()