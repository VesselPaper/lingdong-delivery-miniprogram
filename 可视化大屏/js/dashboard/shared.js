/* ============================================================
 * js/dashboard/shared.js — 大屏共享上下文
 * ------------------------------------------------------------
 * 原 dashboard.js 的公共部分：请求常量、DOM 快捷选择、全局内存状态 state、
 * 通用工具函数（txt/setClass/num…）。所有分件通过 window.Dash 访问同一
 * 上下文，避免每个文件重复声明、也避免往全局塞一堆变量。
 *
 * 结构：window.Dash = { C, ctx, state, api, views, map, calib, main }
 *    - C      常量（轮询间隔/上限/API 地址等）
 *    - ctx    公共工具与 DOM 快捷函数（$ 、txt、setClass、num…）
 *    - state  内存状态（机器/批次/告警/事件 的当前快照）
 *    - api    数据源（fetchOverview/fetchRobotPositions）
 *    - views  各 UI 渲染纯函数
 *    - map    Leaflet 地图驱动
 *    - calib  标定（?calib=1）
 *    - main   编排（apply/loop/boot）
 * ============================================================ */
window.Dash = (function () {
  'use strict'

  var C = {
    POLL_MS: 5000,
    FETCH_TIMEOUT: 8000,
    RELOAD_HOUR: 4,
    MEM_LIMIT: 800 * 1024 * 1024,
    MAP_PAD: 0,
    HEADING_OFFSET: 90,
    MAX_ROBOTS: 6,
    MAX_BATCHES: 4,
    MAX_ALERTS: 3,
    MAX_EVENTS: 8
  }
  // file:// 直接双击打开时，接口指向本机后端；否则走同源相对路径
  C.API = location.protocol === 'file:'
    ? 'http://127.0.0.1:3000/api/dashboard/overview'
    : '/api/dashboard/overview'
  C.API_ROBOTS = location.protocol === 'file:'
    ? 'http://127.0.0.1:3000/api/dashboard/robot-positions'
    : '/api/dashboard/robot-positions'
  C.API_VIRTUAL = location.protocol === 'file:'
    ? 'http://127.0.0.1:3000/api/dashboard/virtual-robot'
    : '/api/dashboard/virtual-robot'
  C.ROBOT_POLL_MS = 1000

  // 公共工具
  function pad2(n) { return n < 10 ? '0' + n : '' + n }
  function hhmmss(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) }
  function txt(node, value) {
    var s = value === undefined || value === null ? '' : String(value)
    if (node && node.textContent !== s) node.textContent = s
  }
  function setClass(node, cls) { if (node && node.className !== cls) node.className = cls }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0 }
  function $(id) { return document.getElementById(id) }

  var state = {
    mapKey: '',
    mapBBox: null,
    mapReady: false,
    sigRoads: '',
    sigLm: '',
    sigRoutes: '',
    cars: {},          // device_sn -> element
    stopEls: [],
    events: [],
    prev: null,
    lastData: null,
    lastOkTs: 0,
    reloadDay: '',
    demoCarsOn: false  // 演示车已在 3D 地图开启（setOpts 触发重建，只调一次）
  }

  return { C: C, ctx: { pad2: pad2, hhmmss: hhmmss, txt: txt, setClass: setClass, num: num, $: $ }, state: state, api: {}, views: {}, map: {}, calib: {}, main: {} }
})()