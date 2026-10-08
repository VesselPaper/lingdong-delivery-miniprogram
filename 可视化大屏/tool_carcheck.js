/* 车模几何自检（离线，用 Node 直接 require scene3d.js）
 * 用途：改完 buildCar / buildRing / buildBeam 后确认几何有效（无 NaN、落地、尺寸合理）。
 * 用法：node 可视化大屏/tool_carcheck.js
 */
const path = require('path')
const S = require(path.join(__dirname, 'js', 'scene3d.js'))

const pxPerM = 19.45          // 场景像素/米（map-calibration scale_px_per_m 量级）
const CAR_SCALE = 3.0         // 与 map3d-gl.js 的 CAR_SCALE 默认值一致

function bbox(pos) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity
  let nan = 0
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { nan++; continue }
    mnx = Math.min(mnx, x); mxx = Math.max(mxx, x)
    mny = Math.min(mny, y); mxy = Math.max(mxy, y)
    mnz = Math.min(mnz, z); mxz = Math.max(mxz, z)
  }
  return { nan, mnx, mxx, mny, mxy, mnz, mxz }
}

let fail = 0
function check(label, cond, detail) {
  console.log(`${cond ? '  OK  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) fail++
}

console.log('=== 车模 buildCar ===')
for (const scale of [1, CAR_SCALE]) {
  const car = S.buildCar(pxPerM, scale)
  const b = bbox(car.pos)
  const nTri = car.pos.length / 9
  const w = (b.mxx - b.mnx) / pxPerM, h = (b.mxy - b.mny) / pxPerM, d = (b.mxz - b.mnz) / pxPerM
  console.log(`scale=${scale}: ${nTri} 三角形  尺寸 ${w.toFixed(2)}长 × ${d.toFixed(2)}宽 × ${h.toFixed(2)}高 (m)  yMin=${b.mny.toFixed(3)}  height=${car.height.toFixed(1)}px`)
  check(`scale=${scale} 无 NaN`, b.nan === 0, `nan=${b.nan}`)
  check(`scale=${scale} 落地 y≈0`, Math.abs(b.mny) < 1e-6, `yMin=${b.mny}`)
  check(`scale=${scale} 尺寸随倍数缩放`, Math.abs(w - (1.32 * scale) / 1) < 1.0, `宽=${w.toFixed(2)}`)
}

console.log('\n=== 光环 buildRing(半径=车长*0.92) ===')
for (const scale of [1, CAR_SCALE]) {
  const r = 1.3 * scale * 0.92
  const ring = S.buildRing(pxPerM, r)
  const b = bbox(ring.pos)
  const rOuter = Math.max(b.mxx - b.mnx, b.mxz - b.mnz) / 2 / pxPerM
  console.log(`scale=${scale}: ${ring.pos.length / 9} 三角形  外半径 ${rOuter.toFixed(2)}m (期望≈${r.toFixed(2)})`)
  check(`scale=${scale} 光环无 NaN`, b.nan === 0)
  check(`scale=${scale} 光环半径匹配车长`, Math.abs(rOuter - r) < 0.15, `Δ=${(rOuter - r).toFixed(3)}`)
}

console.log('\n=== 光柱 buildBeam ===')
{
  const beam = S.buildBeam(pxPerM, 1.3 * CAR_SCALE * 2.2, 0.24 * CAR_SCALE)
  const b = bbox(beam.pos)
  console.log(`光柱: ${beam.pos.length / 9} 三角形  高 ${((b.mxy - b.mny) / pxPerM).toFixed(2)}m  宽 ${((b.mxx - b.mnx) / pxPerM).toFixed(2)}m`)
  check('光柱无 NaN', b.nan === 0)
  check('光柱贴地起步', b.mny / pxPerM > 0.5 && b.mny / pxPerM < 0.8, `yMin=${(b.mny / pxPerM).toFixed(2)}m`)
}

console.log('\n=== carMatrix 朝向 ===')
{
  const m0 = S.carMatrix(10, 20, 0, 0)
  const m90 = S.carMatrix(10, 20, Math.PI / 2, 0)
  check('carMatrix 输出 16 元素', m0.length === 16)
  check('theta 变化矩阵不同', m0.some((v, i) => Math.abs(v - m90[i]) > 1e-6))
}

console.log(fail ? `\n❌ ${fail} 项未通过` : '\n✅ 全部通过')
process.exit(fail ? 1 : 0)
