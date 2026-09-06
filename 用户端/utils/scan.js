// 扫码内容解析：自生成二维码内容格式为 LD-R:<deviceSn>
// 兼容直接扫到纯设备编号的情况（容错）
function parseDeviceSn(raw) {
  if (!raw) return ''
  const s = String(raw).trim()
  if (s.indexOf('LD-R:') === 0) return s.slice(5).trim()
  return s
}

module.exports = { parseDeviceSn }
