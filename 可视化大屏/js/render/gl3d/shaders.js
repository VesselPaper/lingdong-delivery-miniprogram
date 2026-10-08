/* ============================================================
 * render/gl3d/shaders.js — WebGL 着色器（纯 GLSL 字符串定义）
 * ------------------------------------------------------------
 * 从 map3d-gl.js 的「着色器」块抽出。不含任何 gl/scene/闭包依赖，
 * 只导出四个成品着色器字符串（内部已 join 好）。
 *
 *   VS_MESH / FS_MESH     ：楼体、路线、车辆网格（带流光的片元着色）
 *   VS_GROUND / FS_GROUND ：雷达底图地面（按亮度抠背景 + 边界羽化）
 * ============================================================ */
window.GL3DShaders = (function () {
  'use strict'

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
    'varying vec2 vUV;',
    'void main() { vUV = aUV; gl_Position = uViewProj * vec4(aPos, 1.0); }'
  ].join('\n')

  // 雷达底图：按亮度抠背景（背景 RGB(10,25,41) 亮度≈41/255，走廊≈86/255），
  // 只保留**有宽度的可通行区**，背景透明 → 不再出现"一块正方形地面"；
  // 同时去掉原先的程序化蓝色网格（地面网格已按负责人要求移除）。
  var FS_GROUND = [
    'precision mediump float;',
    'varying vec2 vUV;',
    'uniform sampler2D uTex;',
    'uniform float uFade; uniform float uFadeSoft; uniform float uOpacity;',
    'void main() {',
    '  vec4 base = texture2D(uTex, vUV);',
    '  float lum = max(base.r, max(base.g, base.b));',
    '  float a = smoothstep(uFade, uFade + uFadeSoft, lum) * uOpacity;',
    // 图像边界羽化：即使有内容靠近边缘，也不会切出一条硬直边
    '  float e = min(min(vUV.x, 1.0 - vUV.x), min(vUV.y, 1.0 - vUV.y));',
    '  a *= smoothstep(0.0, 0.012, e);',
    '  gl_FragColor = vec4(base.rgb, a);',
    '}'
  ].join('\n')

  return { VS_MESH: VS_MESH, FS_MESH: FS_MESH, VS_GROUND: VS_GROUND, FS_GROUND: FS_GROUND }
})()