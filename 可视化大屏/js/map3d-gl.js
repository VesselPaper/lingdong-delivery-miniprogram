/* ============================================================
 * map3d-gl.js — 真三维全息地图（原生 WebGL，无第三方依赖）
 * ------------------------------------------------------------
 * 风格：数字孪生全息（深蓝底 #0A1929 + 发光网格地面 + 玻璃楼体 + 青色描边 +
 *       青绿发光路网 + 橙色规划路线 + 白色小车带定位光环/光柱 + 全息标签）。
 *
 * 为什么自己写 WebGL 而不引 three.js：大屏约定「无第三方前端依赖」，且要能离线跑。
 * 几何与相机数学全部来自 scene3d.js（与 mapfit/preview3d_gl.js 共用），
 * 所以 Node 出的预览图 == 浏览器所见。
 *
 * 渲染顺序（透明度的关键）：
 *   opaque（底板/屋顶/描边/路网/钉标，写深度）
 *   → ground（贴图 + 程序化网格，写深度）
 *   → glass（墙面，混合、不写深度、按楼从远到近）
 *   → 车辆/光环/光柱（不透明车体 + 混合光环）
 * 因为墙面不写深度，**机器人走到楼后面依然可见**（这正是用户要的）。
 *
 * 操作：左键拖动=环绕 · 滚轮=缩放 · 右键/Shift+拖动=平移 · 双击=复位 · 单指/双指（触摸）
 * ============================================================ */
window.Map3DGL = (function () {
  'use strict'
  var S = window.Scene3D
  var ASSET = 'assets/'

  var box = null, glc = null, gl = null, ovc = null, ov = null
  var W = 0, H = 0, DPR = 1
  var started = false, ready = false, failed = false
  var calib = null, groundTex = null, groundReady = false
  var progs = {}, bufs = {}
  var scene = null, carMesh = null, ringMesh = null, beamMesh = null
  // 默认值：保留**灰色校园道路**与底图、楼体；关掉橙色规划路线与青色荧光测绘线
  // （用户要求"不要取消灰色的线，先不要黄色的" → 再去掉荧光绿的线条）。
  var opts = {
    el: 82, heightScale: 0.58,
    labels: true,          // 楼栋名称
    paths: false,          // 测绘骨架线（青色荧光线条）—— 默认关闭
    roads: true,           // OSM 校园道路（灰色）—— 保留
    route: false,          // 橙色规划/演示路线 —— 默认关闭
    routeFlow: false,      // 路线上的"流光"动态效果 —— 默认关闭（用户要求：不要动态效果）
    demoCars: false,       // 演示车辆 —— 默认关闭：没有真实车辆数据时地图上不显示任何车
    spin: false, follow: false, roofFade: false
  }
  var cam = null, fitDist = 0
  var view = { az: 0, el: 82, zoom: 1, target: null, panX: 0, panY: 0 }
  var live = { bbox: null, robots: [], routes: [], landmarks: [], fleet: {} }
  var robotAnim = {}, demo = null, routeMeshData = null, routeKey = '', roadNet = null
  var errEl = null, tipEl = null, maskEl = null
  var isGL2 = false

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }
  // 失败时把已插入的画布摘掉，让回退渲染器（2.5D）能干净地接管地图区
  function fail(why) {
    failed = true
    try {
      if (glc && glc.parentNode) glc.parentNode.removeChild(glc)
      if (ovc && ovc.parentNode) ovc.parentNode.removeChild(ovc)
    } catch (e) { /* ignore */ }
    if (maskEl) { maskEl.hidden = false; maskEl.textContent = why }
    if (window.console && console.warn) console.warn('[Map3D] ' + why)
  }
  function probe() {
    try {
      var c = document.createElement('canvas')
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
    } catch (e) { return false }
  }

  /* ---------------- 着色器 ---------------- */
  var VS_MESH = [
    'attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol; attribute float aAux;',
    'uniform mat4 uViewProj; uniform mat4 uModel;',
    'uniform vec3 uLight; uniform float uAmbient; uniform float uDiffuse; uniform float uAlphaMul;',
    'varying vec4 vCol; varying float vAux;',
    'void main() {',
    '  mat3 rot = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz);',
    '  vec3 n = normalize(rot * aNrm);',
    '  float d = max(0.0, dot(n, uLight));',
    '  float k = uAmbient + uDiffuse * d;',
    '  vCol = vec4(min(vec3(1.0), aCol.rgb * k), aCol.a * uAlphaMul);',
    '  vAux = aAux;',
    '  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);',
    '}'
  ].join('\n')
  // 流光：沿路线弧长做流动高光（片元级，随深度正常遮挡）
  var FS_MESH = [
    'precision mediump float;',
    'varying vec4 vCol; varying float vAux;',
    'uniform float uFlowAmp; uniform float uFlowScale; uniform float uTime;',
    'void main() {',
    '  vec3 c = vCol.rgb;',
    '  float ph = fract(vAux * uFlowScale - uTime * 0.42);',
    '  float hl = smoothstep(0.55, 0.90, ph) * (1.0 - smoothstep(0.90, 1.0, ph));',
    '  c += vec3(1.0, 0.88, 0.52) * hl * uFlowAmp;',
    '  gl_FragColor = vec4(min(vec3(1.0), c), vCol.a);',
    '}'
  ].join('\n')
  var VS_GROUND = [
    'attribute vec3 aPos; attribute vec2 aUV;',
    'uniform mat4 uViewProj;',
    'varying vec2 vUV; varying vec2 vWorld;',
    'void main() { vUV = aUV; vWorld = aPos.xz; gl_Position = uViewProj * vec4(aPos, 1.0); }'
  ].join('\n')
  // 程序化发光网格：**不使用 fwidth**。
  // 原因：WebGL2 上下文里编译 GLSL ES 1.00 着色器时，导数函数不保证可用
  //（实测报 "no matching overloaded function found: fwidth"），
  // 而 GLSL ES 3.00 又要改写整套 attr/varying 语法。
  // 于是改成：CPU 按相机算"1 像素等于多少世界单位"，把线宽 uLineW 传进来做 smoothstep ——
  // 全平台可用，且线宽在屏幕上恒定。
  var FS_GROUND = [
    'precision mediump float;',
    'varying vec2 vUV; varying vec2 vWorld;',
    'uniform sampler2D uTex;',
    'uniform float uStep; uniform float uMajor; uniform float uLineW;',
    'uniform vec3 uGridCol; uniform vec3 uMajorCol;',
    'void main() {',
    '  vec4 base = texture2D(uTex, vUV);',
    '  vec2 g = fract(vWorld / uStep);',
    '  float ddx = min(g.x, 1.0 - g.x) * uStep;',
    '  float ddz = min(g.y, 1.0 - g.y) * uStep;',
    '  float line = 1.0 - smoothstep(uLineW * 0.45, uLineW, min(ddx, ddz));',
    '  vec2 gm = fract(vWorld / (uStep * uMajor));',
    '  float mdx = min(gm.x, 1.0 - gm.x) * uStep * uMajor;',
    '  float mdz = min(gm.y, 1.0 - gm.y) * uStep * uMajor;',
    '  float majorLine = 1.0 - smoothstep(uLineW * 0.6, uLineW * 1.5, min(mdx, mdz));',
    '  vec3 col = base.rgb;',
    '  col += uGridCol * line * 0.40;',
    '  col += uMajorCol * majorLine * 0.55;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n')

  function compile(src, type) {
    var s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  function program(vsSrc, fsSrc, names) {
    var p = gl.createProgram()
    gl.attachShader(p, compile(vsSrc, gl.VERTEX_SHADER))
    gl.attachShader(p, compile(fsSrc, gl.FRAGMENT_SHADER))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    var u = {}
    for (var i = 0; i < names.length; i++) u[names[i]] = gl.getUniformLocation(p, names[i])
    return { p: p, u: u }
  }

  /* ---------------- 初始化 ---------------- */
  function ensure() {
    if (started || failed) return
    started = true
    box = document.getElementById('mapBox')
    maskEl = document.getElementById('mapMask')
    tipEl = document.getElementById('mapTip')
    if (!box) return
    glc = document.createElement('canvas')
    glc.style.position = 'absolute'; glc.style.inset = '0'
    glc.style.width = '100%'; glc.style.height = '100%'; glc.style.zIndex = '1'
    box.appendChild(glc)
    ovc = document.createElement('canvas')
    ovc.style.position = 'absolute'; ovc.style.inset = '0'
    ovc.style.width = '100%'; ovc.style.height = '100%'; ovc.style.zIndex = '2'
    ovc.style.pointerEvents = 'none'
    box.appendChild(ovc)
    gl = glc.getContext('webgl2', { antialias: true, alpha: false, depth: true })
    isGL2 = !!gl
    if (!gl) gl = glc.getContext('webgl', { antialias: true, alpha: false, depth: true })
    if (!gl) return fail('当前浏览器不支持 WebGL，无法显示立体地图')
    ov = ovc.getContext('2d')
    try {
      progs.mesh = program(VS_MESH, FS_MESH, ['uViewProj', 'uModel', 'uLight', 'uAmbient', 'uDiffuse', 'uAlphaMul', 'uFlowAmp', 'uFlowScale', 'uTime'])
      progs.ground = program(VS_GROUND, FS_GROUND,
        ['uViewProj', 'uTex', 'uStep', 'uMajor', 'uLineW', 'uGridCol', 'uMajorCol'])
    } catch (e) { return fail('WebGL 着色器编译失败：' + e.message) }
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    var bg = S.THEME.bg
    gl.clearColor(bg[0], bg[1], bg[2], 1)

    bindControls()
    bindInput()
    resize()
    window.addEventListener('resize', resize)
    loadAssets()
    requestAnimationFrame(frame)
  }

  function loadAssets() {
    if (window.MAP_CALIBRATION) applyCalib(window.MAP_CALIBRATION)
    else {
      var xhr = new XMLHttpRequest()
      xhr.open('GET', ASSET + 'map-calibration.json', true)
      xhr.onload = function () {
        if (xhr.status !== 200 && xhr.status !== 0) return fail('标定文件 HTTP ' + xhr.status)
        try { applyCalib(JSON.parse(xhr.responseText)) } catch (e) { fail('标定文件解析失败：' + e.message) }
      }
      xhr.onerror = function () { fail('标定文件加载失败（file:// 会拦截 XHR，需用 script 方式引入）') }
      try { xhr.send() } catch (e) { fail('标定文件请求异常：' + e.message) }
    }
    var im = new Image()
    im.onload = function () {
      groundTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, groundTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      groundReady = true
    }
    im.onerror = function () { groundReady = false }
    im.src = ASSET + 'radar-ground-dark.png?v=' + (window.MAP_ASSET_VER || '1')
  }

  function applyCalib(c) {
    if (!c || !c.buildings || !c.buildings.length) return fail('标定数据为空')
    calib = c
    rebuild()
    ready = true
    if (maskEl) maskEl.hidden = true
    if (tipEl) {
      tipEl.hidden = false
      tipEl.textContent = c.buildings.length + ' 栋楼 · ' + (c.paths || []).length + ' 段雷达路线 · ' +
        '拖动旋转 / 滚轮缩放 / 右键平移'
    }
  }

  /* ---------------- 几何上传 ---------------- */
  function uploadMesh(mesh) {
    var b = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), aux: null, count: mesh.count }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col); gl.bufferData(gl.ARRAY_BUFFER, mesh.col, gl.STATIC_DRAW)
    if (mesh.aux) {
      b.aux = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, b.aux); gl.bufferData(gl.ARRAY_BUFFER, mesh.aux, gl.STATIC_DRAW)
    }
    return b
  }
  function dropMesh(b) { if (b) { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.nrm); gl.deleteBuffer(b.col); if (b.aux) gl.deleteBuffer(b.aux) } }

  function rebuild() {
    if (!gl || !calib) return
    scene = S.buildStatic(calib, {
      roads: opts.roads, paths: opts.paths, labels: opts.labels, heightScale: opts.heightScale
    })
    // 道路拓扑网：规划路线用它做"吸附 + 最短路"，保证黄线一定压在灰色道路上
    roadNet = S.buildRoadGraph(calib.roads || [])
    dropMesh(bufs.opaque); bufs.opaque = uploadMesh(scene.opaque)
    dropMesh(bufs.roofs); bufs.roofs = uploadMesh(scene.roofs)
    dropMesh(bufs.glass); bufs.glass = uploadMesh(scene.glass)
    carMesh = S.buildCar(scene.pxPerM); dropMesh(bufs.car); bufs.car = uploadMesh(carMesh)
    ringMesh = S.buildRing(scene.pxPerM); dropMesh(bufs.ring); bufs.ring = uploadMesh(ringMesh)
    beamMesh = S.buildBeam(scene.pxPerM); dropMesh(bufs.beam); bufs.beam = uploadMesh(beamMesh)
    if (!bufs.ground) {
      bufs.ground = { pos: gl.createBuffer(), uv: gl.createBuffer(), count: 4 }
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ground.uv)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(scene.ground.uv), gl.STATIC_DRAW)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ground.pos)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(scene.ground.pos), gl.STATIC_DRAW)

    if (view.az === 0) view.az = S.principalAzimuth(calib.buildings)
    view.target = scene.bounds.center.slice()

    // 演示路线（橙色，沿雷达骨架最长连通路径）；真实模式由平台下发路线，改用叠加层绘制
    // 路线网格：只在打开「路线」时构建（演示档用骨架主路线；真实档用平台途经点）
    dropMesh(bufs.route)
    bufs.route = null
    routeKey = ''
    if (opts.route) {
      routeMeshData = S.buildRouteMesh(S.demoRoutePaths(calib), scene.pxPerM)
      bufs.route = uploadMesh(routeMeshData)
      flowScale = 1 / (9 * scene.pxPerM)     // 流光节距：约每 9 m 一个高光
    }
    demo = null
    updateCamera(true)
  }

  /* ---------------- 相机 ---------------- */
  function updateCamera(refit) {
    if (!scene || !W || !H) return          // 面板还没布局出尺寸时不要算相机（会出 NaN）
    if (refit || !fitDist) {
      var c = S.fitCamera(W, H, scene.bounds, { az: view.az, el: view.el, fov: 34, target: view.target, margin: 0.93 })
      fitDist = c.fitDist
    }
    cam = S.makeCamera(W, H, scene.bounds, {
      az: view.az, el: view.el, fov: 34,
      dist: fitDist * view.zoom,
      target: [view.target[0] + view.panX, view.target[1], view.target[2] + view.panY]
    })
    cam.vpF32 = new Float32Array(cam.viewProj)
  }

  function resize() {
    if (!box || !gl) return
    DPR = Math.min(2, window.devicePixelRatio || 1)
    W = box.clientWidth || 0
    H = box.clientHeight || 0
    if (!W || !H) return
    glc.width = Math.round(W * DPR); glc.height = Math.round(H * DPR)
    ovc.width = Math.round(W * DPR); ovc.height = Math.round(H * DPR)
    gl.viewport(0, 0, glc.width, glc.height)
    updateCamera(true)
  }

  function resetView() {
    view.az = S.principalAzimuth(calib ? calib.buildings : null)
    view.el = opts.el
    view.zoom = 1
    view.panX = 0; view.panY = 0
    if (scene) view.target = scene.bounds.center.slice()
    updateCamera(true)
  }

  /* ---------------- 交互 ---------------- */
  function bindInput() {
    glc.style.cursor = 'grab'
    glc.style.touchAction = 'none'
    var drag = null
    glc.addEventListener('contextmenu', function (e) { e.preventDefault() })
    glc.addEventListener('mousedown', function (e) {
      e.preventDefault()
      drag = { x: e.clientX, y: e.clientY, az: view.az, el: view.el, tx: view.panX, tz: view.panY, pan: (e.button === 2 || e.shiftKey) }
      glc.style.cursor = drag.pan ? 'move' : 'grabbing'
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y
      if (drag.pan) {
        var scale = (fitDist * view.zoom) / Math.max(W, H) * 1.6
        var az = view.az * S.D2R
        view.panX = drag.tx - (Math.cos(az) * dx * scale + Math.sin(az) * -dy * scale)
        view.panY = drag.tz - (-Math.sin(az) * dx * scale + Math.cos(az) * -dy * scale)
      } else {
        view.az = drag.az - dx * 0.28
        view.el = Math.max(3, Math.min(88, drag.el + dy * 0.22))
        syncTiltSlider()
      }
      updateCamera(false)
    })
    window.addEventListener('mouseup', function () { if (drag) { drag = null; glc.style.cursor = 'grab' } })
    glc.addEventListener('wheel', function (e) {
      e.preventDefault()
      view.zoom = Math.min(6, Math.max(0.12, view.zoom * (e.deltaY < 0 ? 1 / 1.12 : 1.12)))
      updateCamera(false)
    }, { passive: false })
    glc.addEventListener('dblclick', resetView)
    var touch = null
    glc.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        touch = { mode: 'rot', x: e.touches[0].clientX, y: e.touches[0].clientY, az: view.az, el: view.el }
      } else if (e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1]
        touch = { mode: 'pinch', d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: view.zoom }
      }
    }, { passive: true })
    glc.addEventListener('touchmove', function (e) {
      if (!touch) return
      e.preventDefault()
      if (touch.mode === 'rot' && e.touches.length === 1) {
        view.az = touch.az - (e.touches[0].clientX - touch.x) * 0.3
        view.el = Math.max(3, Math.min(88, touch.el + (e.touches[0].clientY - touch.y) * 0.24))
      } else if (touch.mode === 'pinch' && e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1]
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        view.zoom = Math.min(6, Math.max(0.12, touch.zoom * (touch.d / Math.max(1, d))))
      }
      updateCamera(false)
    }, { passive: false })
    glc.addEventListener('touchend', function () { touch = null }, { passive: true })
  }

  function syncTiltSlider() {
    var t = document.getElementById('m3Tilt')
    if (t) t.value = String(Math.round(view.el))
  }
  function bindControls() {
    var tilt = document.getElementById('m3Tilt')
    if (tilt) {
      tilt.min = 3; tilt.max = 88
      tilt.addEventListener('input', function () { opts.el = Number(tilt.value); view.el = opts.el; updateCamera(false) })
    }
    var hgt = document.getElementById('m3Height')
    if (hgt) hgt.addEventListener('input', function () { opts.heightScale = Number(hgt.value) / 100; rebuild() })
    var lb = document.getElementById('m3Label')
    if (lb) lb.addEventListener('click', function () { opts.labels = !opts.labels; lb.classList.toggle('on', opts.labels); rebuild() })
    var pth = document.getElementById('m3Path')
    if (pth) pth.addEventListener('click', function () { opts.paths = !opts.paths; pth.classList.toggle('on', opts.paths); rebuild() })
    var rt = document.getElementById('m3Route')
    if (rt) rt.addEventListener('click', function () { opts.route = !opts.route; rt.classList.toggle('on', opts.route); rebuild() })
    var rd = document.getElementById('m3Road')
    if (rd) rd.addEventListener('click', function () { opts.roads = !opts.roads; rd.classList.toggle('on', opts.roads); rebuild() })
    var sp = document.getElementById('m3Spin')
    if (sp) sp.addEventListener('click', function () { opts.spin = !opts.spin; sp.classList.toggle('on', opts.spin) })
    var fo = document.getElementById('m3Follow')
    if (fo) fo.addEventListener('click', function () { opts.follow = !opts.follow; fo.classList.toggle('on', opts.follow) })
    var fd = document.getElementById('m3Fade')
    if (fd) fd.addEventListener('click', function () { opts.roofFade = !opts.roofFade; fd.classList.toggle('on', opts.roofFade) })
    var rst = document.getElementById('mapReset')
    if (rst) { rst.hidden = false; rst.onclick = resetView }
  }

  /* ---------------- 绘制 ---------------- */
  function bindAttr(prog, name, buf, size) {
    var loc = gl.getAttribLocation(prog, name)
    if (loc < 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
  }
  var _ident = null, _light = null, _now = 0
  function identF32() { if (!_ident) _ident = new Float32Array(S.mat4.identity()); return _ident }
  function lightF32() { if (!_light) _light = new Float32Array(S.LIGHT); return _light }

  function drawMesh(buf, model, alphaMul, flowAmp) {
    if (!buf) return
    var pr = progs.mesh, p = pr.p
    gl.useProgram(p)
    bindAttr(p, 'aPos', buf.pos, 3)
    bindAttr(p, 'aNrm', buf.nrm, 3)
    bindAttr(p, 'aCol', buf.col, 4)
    var auxLoc = gl.getAttribLocation(p, 'aAux')
    if (auxLoc >= 0) {
      if (buf.aux) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.aux)
        gl.enableVertexAttribArray(auxLoc)
        gl.vertexAttribPointer(auxLoc, 1, gl.FLOAT, false, 0, 0)
      } else {
        gl.disableVertexAttribArray(auxLoc)
        gl.vertexAttrib1f(auxLoc, 0)
      }
    }
    gl.uniformMatrix4fv(pr.u.uViewProj, false, cam.vpF32)
    gl.uniformMatrix4fv(pr.u.uModel, false, model ? new Float32Array(model) : identF32())
    gl.uniform3fv(pr.u.uLight, lightF32())
    gl.uniform1f(pr.u.uAmbient, S.AMBIENT)
    gl.uniform1f(pr.u.uDiffuse, S.DIFFUSE)
    gl.uniform1f(pr.u.uAlphaMul, alphaMul == null ? 1 : alphaMul)
    gl.uniform1f(pr.u.uTime, _now)
    gl.uniform1f(pr.u.uFlowAmp, flowAmp == null ? 0 : flowAmp)
    gl.uniform1f(pr.u.uFlowScale, flowScale)
    gl.drawArrays(gl.TRIANGLES, 0, buf.count)
  }
  var flowScale = 0
  function drawGround() {
    if (!groundReady || !bufs.ground) return
    var pr = progs.ground, p = pr.p
    gl.useProgram(p)
    bindAttr(p, 'aPos', bufs.ground.pos, 3)
    bindAttr(p, 'aUV', bufs.ground.uv, 2)
    gl.uniformMatrix4fv(pr.u.uViewProj, false, cam.vpF32)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, groundTex)
    gl.uniform1i(pr.u.uTex, 0)
    gl.uniform1f(pr.u.uStep, 20 * scene.pxPerM)       // 20 m 细网格
    gl.uniform1f(pr.u.uMajor, 5)                      // 每 5 格一条主线（100 m）
    // 线宽：按"1 像素 = 多少世界单位"换算，屏幕上恒定约 1.2px（不用 fwidth）
    var worldPerPx = 2 * cam.dist * Math.tan(cam.fov / 2) / Math.max(1, H)
    var step = 20 * scene.pxPerM
    gl.uniform1f(pr.u.uLineW, Math.min(step * 0.28, Math.max(worldPerPx * 1.25, step * 0.0025)))
    var gc = S.THEME.gridMinor, mc = [0.30, 0.78, 0.95]
    gl.uniform3f(pr.u.uGridCol, gc[0], gc[1], gc[2])
    gl.uniform3f(pr.u.uMajorCol, mc[0], mc[1], mc[2])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  function drawGlass() {
    if (!bufs.glass || !bufs.glass.count) return
    var pr = progs.mesh, p = pr.p
    gl.useProgram(p)
    bindAttr(p, 'aPos', bufs.glass.pos, 3)
    bindAttr(p, 'aNrm', bufs.glass.nrm, 3)
    bindAttr(p, 'aCol', bufs.glass.col, 4)
    gl.uniformMatrix4fv(pr.u.uViewProj, false, cam.vpF32)
    gl.uniformMatrix4fv(pr.u.uModel, false, identF32())
    gl.uniform3fv(pr.u.uLight, lightF32())
    gl.uniform1f(pr.u.uAmbient, S.AMBIENT)
    gl.uniform1f(pr.u.uDiffuse, S.DIFFUSE)
    gl.depthMask(false)
    var c = cam.eye
    var order = scene.glassRanges.map(function (r, i) { return { i: i, d: Math.hypot(r.cx - c[0], r.cz - c[2]) } })
      .sort(function (a, b) { return b.d - a.d })
    for (var k = 0; k < order.length; k++) {
      var r = scene.glassRanges[order[k].i]
      gl.drawArrays(gl.TRIANGLES, r.start, r.count)
    }
    gl.depthMask(true)
  }

  /* ---------------- 数据 ---------------- */
  function update(map, d) {
    if (!started) ensure()
    if (d && d.robots) {
      var f = {}
      for (var i = 0; i < d.robots.length; i++) f[d.robots[i].device_sn] = d.robots[i]
      live.fleet = f
    }
    if (map) {
      live.bbox = map.bbox || null
      live.robots = map.robots || []
      live.routes = map.routes || []
      live.landmarks = map.landmarks || []
      ingestRobots(live.robots)
    } else {
      live.bbox = null; live.robots = []; live.routes = []; live.landmarks = []
    }
    syncRouteMesh()
  }

  // 把一批"平台坐标的机器人"并进 robotAnim（每帧向目标插值 → 看起来是连续移动）
  function ingestRobots(list) {
    var seen = {}
    for (var j = 0; j < (list || []).length; j++) {
      var r = list[j]
      if (!r || !r.device_sn) continue
      if (r.x == null || r.y == null || !isFinite(num(r.x)) || !isFinite(num(r.y))) continue
      var sn = r.device_sn
      seen[sn] = 1
      var a = robotAnim[sn]
      if (a) {
        a.tx = num(r.x); a.ty = num(r.y); a.tt = num(r.theta); a.on = true
        if (r.text) a.text = r.text
      } else {
        // 首次出现：直接落位，避免从 (0,0) 飘过来
        robotAnim[sn] = {
          x: num(r.x), y: num(r.y), th: num(r.theta),
          tx: num(r.x), ty: num(r.y), tt: num(r.theta), on: true, text: r.text || ''
        }
      }
    }
    for (var kk in robotAnim) if (!seen[kk]) robotAnim[kk].on = false
  }

  // 高频轮询入口：只更新车辆位置（不动配准/路线/点位）。
  // 大屏用 /api/dashboard/robot-positions 每 ~1s 调一次，车就能"实时走"。
  function setRobots(list) {
    if (!started) ensure()
    live.robots = list || []
    ingestRobots(live.robots)
    // 车只在「楼层/建筑」同一个场地里显示；不在同一 building 的先不画
    return live.robots.length
  }

  // 路线网格：演示档用骨架主路线；真实档用平台下发的途经点（做重采样+平滑后成带）
  function syncRouteMesh() {
    if (!calib || !scene) return
    if (!opts.route) {           // 「路线」关掉时不构建、不显示
      if (routeKey !== '') { routeKey = ''; dropMesh(bufs.route); bufs.route = null }
      return
    }
    var key, paths
    if (live.bbox && live.routes && live.routes.length) {
      var p2r = S.makePlatformToRadar(live.bbox, scene.radarW, scene.radarH)
      if (!p2r) return
      var polys = []
      for (var i = 0; i < live.routes.length; i++) {
        var stops = (live.routes[i] && live.routes[i].stops) || []
        if (stops.length < 2) continue
        var pts = []
        for (var s = 0; s < stops.length; s++) {
          var rp = p2r(stops[s].x, stops[s].y)
          pts.push([rp[0], rp[1]])
        }
        if (pts.length >= 2) polys.push({ pts: snapToRoads(pts) })
      }
      if (!polys.length) return
      paths = polys
      key = 'live:' + polys.length + ':' + polys[0].pts.length + ':' + Math.round(polys[0].pts[0][0]) + ',' + Math.round(polys[0].pts[0][1])
    } else {
      paths = S.demoRoutePaths(calib)
      key = 'demo'
    }
    if (key === routeKey) return
    routeKey = key
    dropMesh(bufs.route)
    routeMeshData = S.buildRouteMesh(paths, scene.pxPerM)
    bufs.route = uploadMesh(routeMeshData)
  }
  // 途经点 → 贴路折线（方案A + 方案B 一起用）
  //   ① 先用道路拓扑图在途经点之间走最短路 → 结果天然落在灰色道路中线上
  //   ② 图不连通/吸附失败时退回"投影吸附"：把每个点压到最近的校园道路中线上
  //   ③ 最后道格拉斯-普克抽稀：直线段只留两端、拐弯保留拐点（不做曲线平滑）
  function snapToRoads(pts) {
    var tol = 0.25 * scene.pxPerM
    if (roadNet) {
      var routed = S.routeOnRoads(roadNet, pts)
      if (routed && routed.length >= 2) return S.simplifyPath(routed, tol)
    }
    var out = []
    for (var i = 0; i < pts.length; i++) out.push(projectOnRoads(pts[i]))
    return S.simplifyPath(out, tol)
  }
  // 把一个点投影到最近的道路中线上
  function projectOnRoads(p) {
    var roads = (calib && calib.roads) || []
    var best = null, bd = Infinity
    for (var i = 0; i < roads.length; i++) {
      var q = roads[i].pts || []
      for (var k = 0; k + 1 < q.length; k++) {
        var a = q[k], b = q[k + 1]
        var vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy
        var t = L2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2 : 0
        t = Math.max(0, Math.min(1, t))
        var x = a[0] + vx * t, y = a[1] + vy * t
        var d = Math.hypot(p[0] - x, p[1] - y)
        if (d < bd) { bd = d; best = [x, y] }
      }
    }
    return best || [p[0], p[1]]
  }
  // 保留给旧调用（现在改用 snapToRoads）
  function smoothPolyline(pts, step) {
    if (pts.length < 3) return pts
    var out = [pts[0]], acc = 0
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1]
      var L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L < 1e-9) continue
      var t = 0
      while (acc + (L - t) >= step) {
        t += step - acc
        var k = t / L
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k])
        acc = 0
      }
      acc += L - t
    }
    out.push(pts[pts.length - 1])
    for (var p = 0; p < 2; p++) {
      for (var j = 1; j < out.length - 1; j++) {
        out[j] = [(out[j - 1][0] + 2 * out[j][0] + out[j + 1][0]) / 4,
          (out[j - 1][1] + 2 * out[j][1] + out[j + 1][1]) / 4]
      }
    }
    return out
  }

  function initDemo() {
    // 演示车沿"演示路线"跑（该路线取自雷达骨架，真在走廊上）
    var paths = S.demoRoutePaths(calib)
    var pts = (paths[0] && paths[0].pts) || []
    if (pts.length < 2) return null
    var segs = [], total = 0
    for (var j = 0; j < pts.length - 1; j++) {
      var L = Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1])
      segs.push({ a: pts[j], b: pts[j + 1], L: L, acc: total })
      total += L
    }
    if (!(total > 1)) return null
    var cars = []
    for (var i = 0; i < 3; i++) {
      cars.push({ segs: segs, total: total, off: total * (0.08 + 0.3 * i), sp: total * 0.02, sn: '演示车 0' + (i + 1) })
    }
    return cars
  }
  function demoPos(t) {
    if (!demo) return []
    var out = []
    for (var i = 0; i < demo.length; i++) {
      var c = demo[i]
      var p = (t * c.sp + c.off) % c.total
      for (var j = 0; j < c.segs.length; j++) {
        var s = c.segs[j]
        if (p <= s.acc + s.L) {
          var k = s.L ? (p - s.acc) / s.L : 0
          out.push({
            x: s.a[0] + (s.b[0] - s.a[0]) * k, z: s.a[1] + (s.b[1] - s.a[1]) * k,
            th: Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]), sn: c.sn, demo: true
          })
          break
        }
      }
    }
    return out
  }

  var lastT = 0
  function frame(ts) {
    requestAnimationFrame(frame)
    if (!gl || !ready || !scene) return
    if (!W || !H) { resize(); return }       // 首次布局尚未确定尺寸：重试
    var t = (ts || 0) / 1000
    var dt = Math.min(0.1, t - lastT); lastT = t
    _now = t
    if (opts.spin) { view.az += dt * 6; updateCamera(false) }

    // 车辆世界坐标（先算，跟随模式要用）
    var cars = [], anyLive = false
    for (var k in robotAnim) {
      var a = robotAnim[k]
      if (!a.on) continue
      anyLive = true
      a.x += (a.tx - a.x) * 0.12; a.y += (a.ty - a.y) * 0.12
      var da = a.tt - a.th
      while (da > Math.PI) da -= 6.2832
      while (da < -Math.PI) da += 6.2832
      a.th += da * 0.15
      cars.push({ x: a.x, z: a.y, th: a.th, sn: a.sn || k, live: true, text: a.text })
    }
    var conv = null
    if (anyLive) {
      conv = S.makePlatformToRadar(live.bbox, scene.radarW, scene.radarH)
      if (!conv) cars = []
      else for (var ci = 0; ci < cars.length; ci++) { var q = conv(cars[ci].x, cars[ci].z); cars[ci].x = q[0]; cars[ci].z = q[1] }
    }
    if (!anyLive) {
      // 没有真实车辆：默认一台车都不画（用户要求）；opts.demoCars 打开时才跑演示车
      if (opts.demoCars) { if (!demo) demo = initDemo(); cars = demoPos(t) }
      else cars = []
    }

    // 跟随：把视图中心平滑移到第一台车
    if (opts.follow && cars.length) {
      var tgt = cars[0]
      var cx = scene.bounds.center[0] + view.panX, cz = scene.bounds.center[2] + view.panY
      view.panX += (tgt.x - cx) * 0.06
      view.panY += (tgt.z - cz) * 0.06
      updateCamera(false)
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    drawMesh(bufs.opaque, null)
    drawGround()

    // 屋顶默认**实心可见**（楼必须看得见）；只有打开「楼体透明」时才随俯角淡出，
    // 用于临时看清被楼压住的道路。淡出时关闭 depthMask，让楼后的车也能透出来。
    var roofAlpha = 1
    if (opts.roofFade) {
      var t2 = Math.max(0, Math.min(1, (view.el - 45) / 35))
      roofAlpha = 1 - 0.66 * t2
    }
    gl.depthMask(roofAlpha > 0.985)
    drawMesh(bufs.roofs, null, roofAlpha)
    gl.depthMask(true)

    drawGlass()

    // 路线：**正常参与深度测试**（所以它永远贴在地面道路上，不会压在楼上）。
    // 流光（按弧长在着色器里算）默认关闭 —— opts.routeFlow 打开才有动态效果。
    if (bufs.route) {
      gl.depthMask(true)
      drawMesh(bufs.route, null, 1, opts.routeFlow ? 1 : 0)
    }

    for (var m = 0; m < cars.length; m++) {
      var c = cars[m]
      var mtx = S.carMatrix(c.x, c.z, c.th, 0)
      gl.depthMask(false)
      drawMesh(bufs.ring, mtx)
      drawMesh(bufs.beam, mtx)
      gl.depthMask(true)
      drawMesh(bufs.car, mtx)
    }
    drawOverlay(t, cars)
  }

  /* ---------------- 2D 叠加层：全息标签 / 橙色路线 / 车辆数据 ---------------- */
  function drawOverlay(t, cars) {
    if (!ov) return
    var g = ov
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ovc.width, ovc.height)
    g.setTransform(DPR, 0, 0, DPR, 0, 0)

    // 路线不再画在叠加层：3D 里那条带子参与深度测试，所以才"贴合地面道路"。
    // 叠加层只负责：车辆定位标记、数据牌、楼栋标签、被偏移楼栋的真实位置提示。

    // ---- 车辆：定位光环 + 光柱 + 数据牌（叠加层，保证"永远看得见车在哪"）----
    g.textBaseline = 'middle'
    for (var ci = 0; ci < cars.length; ci++) {
      var c = cars[ci]
      drawCarMarker(g, c)
      var top = S.projectPoint(cam, W, H, [c.x, carMesh.height + 3.2 * scene.pxPerM, c.z])
      if (!top) continue
      var info = live.fleet[c.sn]
      var lines = []
      if (c.demo) lines.push('演示车 · 配送中')
      else if (info) {
        lines.push(info.machine_text || info.machine_status || '在线')
        if (info.battery != null) lines.push('电量 ' + info.battery + '%')
      } else lines.push('无人车')
      drawPlate(g, top[0], top[1] - 26, lines, '#7ff0ff')
    }

    // ---- 被"视图偏移"的楼：用虚线 + 小圆圈标出真实位置 ----
    // 注意：**不再画那串黄字**（"真实位置 · 视图已偏移 Xm"）。用户明确要求
    // 东苑12栋 / 东苑13栋 / 第三学生食堂 不要显示这串文字（这三栋就是全部被偏移的楼），
    // 所以这里直接去掉文本，只留中性的虚线 + 圆圈做"真实位置"点位提示。
    if (scene.moved && scene.moved.length && opts.labels) {
      g.save()
      g.setLineDash([4, 4])
      g.strokeStyle = 'rgba(140,200,220,0.55)'
      g.lineWidth = 1.2
      for (var mi = 0; mi < scene.moved.length; mi++) {
        var mv = scene.moved[mi]
        var a = S.projectPoint(cam, W, H, [mv.true_center[0], 2, mv.true_center[1]])
        var b = S.projectPoint(cam, W, H, [mv.shown_center[0], 2, mv.shown_center[1]])
        if (!a || !b) continue
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke()
        g.beginPath(); g.arc(a[0], a[1], 4, 0, 6.2832); g.stroke()
      }
      g.restore()
    }

    if (!opts.labels) return
    // 楼栋全息标签
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.2)
    var items = []
    for (var b = 0; b < (calib.buildings || []).length; b++) {
      var bd = calib.buildings[b]
      if (!/栋/.test(bd.name || '')) continue
      var hpx = num(bd.height_m) * scene.pxPerM * opts.heightScale + 4.5 * scene.pxPerM
      var tip = S.projectPoint(cam, W, H, [bd.center[0], hpx, bd.center[1]])
      if (!tip) continue
      g.strokeStyle = 'rgba(120,235,255,' + (0.20 + 0.35 * pulse).toFixed(3) + ')'
      g.lineWidth = 2
      g.beginPath(); g.arc(tip[0], tip[1], 6 + 8 * pulse, 0, 6.2832); g.stroke()
      items.push({ text: bd.name, x: tip[0] + 9, y: tip[1] - 4, kind: 'name' })
    }
    for (var b2 = 0; b2 < (calib.buildings || []).length; b2++) {
      var bd2 = calib.buildings[b2]
      if (/栋/.test(bd2.name || '')) continue
      if (bd2.no_label === true) continue          // 标定里标记为"只渲染体块、不画名字"的楼
      var h2 = num(bd2.height_m) * scene.pxPerM * opts.heightScale + 0.4 * scene.pxPerM
      var tp = S.projectPoint(cam, W, H, [bd2.center[0], h2, bd2.center[1]])
      if (tp) items.push({ text: bd2.name, x: tp[0] + 7, y: tp[1], kind: 'other' })
    }
    items.sort(function (a, b) { return a.y - b.y || a.x - b.x })
    var placed = []
    for (var k2 = 0; k2 < items.length; k2++) {
      var it = items[k2]
      var wpx = String(it.text).length * 12.5 + 6, hpx2 = 15
      for (var att = 0; att < 5; att++) {
        var box = { x0: it.x - 1, y0: it.y - hpx2 / 2, x1: it.x + wpx, y1: it.y + hpx2 / 2 }
        var hit = false
        for (var pi = 0; pi < placed.length; pi++) {
          var P = placed[pi]
          if (box.x0 < P.x1 && box.x1 > P.x0 && box.y0 < P.y1 && box.y1 > P.y0) { hit = true; break }
        }
        if (!hit) break
        it.y += 15
      }
      placed.push({ x0: it.x - 1, y0: it.y - hpx2 / 2, x1: it.x + wpx, y1: it.y + hpx2 / 2 })
      var big = it.kind === 'name'
      g.font = (big ? 'bold 12px ' : '11px ') + '"Microsoft YaHei",sans-serif'
      g.lineWidth = 3
      g.strokeStyle = 'rgba(6,18,32,0.85)'
      g.strokeText(it.text, it.x, it.y)
      g.fillStyle = big ? '#9ef2ff' : '#7fb6d9'
      g.fillText(it.text, it.x, it.y)
    }
  }
  function strokePath(g, pts) {
    g.beginPath()
    g.moveTo(pts[0][0], pts[0][1])
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
    g.stroke()
  }
  // 叠加层用的路线折线（雷达像素）：真实档取平台路线，演示档取骨架主路线
  var _routeCache = null
  function routePolylines() {
    if (live.bbox && live.routes && live.routes.length) {
      var p2r = S.makePlatformToRadar(live.bbox, scene.radarW, scene.radarH)
      if (!p2r) return []
      var out = [], cacheKey = 'live' + live.routes.length
      if (_routeCache && _routeCache.key === cacheKey) return _routeCache.data
      for (var i = 0; i < live.routes.length; i++) {
        var stops = (live.routes[i] && live.routes[i].stops) || []
        if (stops.length < 2) continue
        var poly = []
        for (var s = 0; s < stops.length; s++) {
          var rp = p2r(stops[s].x, stops[s].y)
          poly.push([rp[0], rp[1]])
        }
        if (poly.length >= 2) out.push(poly)
      }
      _routeCache = { key: cacheKey, data: out }
      return out
    }
    var paths = S.demoRoutePaths(calib)
    var demo = []
    for (var k = 0; k < paths.length; k++) if (paths[k].pts && paths[k].pts.length > 1) demo.push(paths[k].pts)
    return demo
  }
  // 车辆定位标记：地面光环（按透视投影成正圆）+ 垂直光柱 + 中心点
  function drawCarMarker(g, c) {
    var r = 2.7 * scene.pxPerM
    var seg = 28
    var ring = []
    for (var i = 0; i <= seg; i++) {
      var a = i / seg * 2 * Math.PI
      var sp = S.projectPoint(cam, W, H, [c.x + Math.cos(a) * r, 0.8, c.z + Math.sin(a) * r])
      if (sp) ring.push(sp)
    }
    if (ring.length > 3) {
      g.save()
      g.shadowColor = 'rgba(80,220,255,0.9)'
      g.shadowBlur = 10
      g.strokeStyle = 'rgba(120,235,255,0.9)'
      g.lineWidth = 1.6
      g.beginPath()
      g.moveTo(ring[0][0], ring[0][1])
      for (var k = 1; k < ring.length; k++) g.lineTo(ring[k][0], ring[k][1])
      g.closePath()
      g.stroke()
      g.restore()
    }
    // 光柱：车顶 -> 地面
    var tipTop = S.projectPoint(cam, W, H, [c.x, 6.5 * scene.pxPerM, c.z])
    var tipBot = S.projectPoint(cam, W, H, [c.x, 0.2, c.z])
    if (tipTop && tipBot) {
      var grd = g.createLinearGradient(tipTop[0], tipTop[1], tipBot[0], tipBot[1])
      grd.addColorStop(0, 'rgba(120,235,255,0.05)')
      grd.addColorStop(1, 'rgba(120,235,255,0.85)')
      g.save()
      g.strokeStyle = grd
      g.lineWidth = 3
      g.beginPath(); g.moveTo(tipTop[0], tipTop[1]); g.lineTo(tipBot[0], tipBot[1]); g.stroke()
      g.fillStyle = '#eafcff'
      g.shadowColor = '#7ff0ff'; g.shadowBlur = 12
      g.beginPath(); g.arc(tipBot[0], tipBot[1], 3.4, 0, 6.2832); g.fill()
      g.restore()
    }
  }
  // 全息数据牌：深色底 + 青色描边 + 发光文字
  function drawPlate(g, x, y, lines, color) {
    if (!lines.length) return
    g.font = '11px "Microsoft YaHei",sans-serif'
    var wmax = 0
    for (var i = 0; i < lines.length; i++) wmax = Math.max(wmax, g.measureText(lines[i]).width)
    var w = wmax + 16, h = lines.length * 14 + 8
    var x0 = x - w / 2, y0 = y - h
    g.save()
    g.fillStyle = 'rgba(6,20,34,0.72)'
    g.strokeStyle = 'rgba(80,220,255,0.75)'
    g.lineWidth = 1
    roundRect(g, x0, y0, w, h, 4)
    g.fill(); g.stroke()
    // 引线
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, y0 + h); g.stroke()
    g.shadowColor = color; g.shadowBlur = 8
    g.fillStyle = color
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (var k = 0; k < lines.length; k++) g.fillText(lines[k], x, y0 + 11 + k * 14)
    g.restore()
    g.textAlign = 'start'
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }

  /* ---------------- API ---------------- */
  function setOpts(o) {
    for (var k in o) if (o.hasOwnProperty(k)) opts[k] = o[k]
    if (o.el != null) view.el = o.el
    rebuild()
  }
  function getOpts() { return opts }

  return {
    ensure: ensure, update: update, resetView: resetView,
    setOpts: setOpts, getOpts: getOpts, probe: probe,
    setRobots: setRobots,
    isReady: function () { return ready }, hasFailed: function () { return failed }
  }
})()
