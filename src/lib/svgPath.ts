// svgPath.ts
// Parse an SVG path `d` string into absolute commands, normalize its bounding
// box into an em-square (y-down authoring space), then emit an opentype.js Path
// with the Y axis flipped (fonts use y-up).
import opentype from 'opentype.js'
//
// Supported commands: M m L l H h V v C c S s Q q T t A a Z z

export type AbsCmd =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'H'; x: number }
  | { t: 'V'; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'Q'; x1: number; y1: number; x: number; y: number }
  | { t: 'A'; rx: number; ry: number; rot: number; la: number; sp: number; x: number; y: number }
  | { t: 'Z' }

const TOKEN_RE = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g

export function parsePath(d: string): AbsCmd[] {
  const raw: (string)[] = []
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(d))) raw.push(m[1] ?? m[2]!)

  const n = raw.length
  let i = 0
  const cmds: AbsCmd[] = []
  let cx = 0, cy = 0, sx = 0, sy = 0
  let lastCtrlX = 0, lastCtrlY = 0
  let lastCmd = ''

  const num = () => parseFloat(raw[i++])

  while (i < n) {
    let c = raw[i]
    if (/[a-z]/.test(c) || /[A-Z]/.test(c)) {
      i++
    } else {
      // implicit repeat of previous command (M -> L, m -> l)
      if (lastCmd === 'M') c = 'L'
      else if (lastCmd === 'm') c = 'l'
      else c = lastCmd
    }
    const abs = c === c.toUpperCase()
    const code = c.toUpperCase()

    switch (code) {
      case 'M': {
        let x = num(), y = num()
        if (!abs) { x += cx; y += cy }
        sx = x; sy = y; cx = x; cy = y
        cmds.push({ t: 'M', x, y })
        lastCmd = 'M'
        break
      }
      case 'L': {
        let x = num(), y = num()
        if (!abs) { x += cx; y += cy }
        cx = x; cy = y
        cmds.push({ t: 'L', x, y })
        lastCmd = 'L'
        break
      }
      case 'H': {
        let x = num()
        if (!abs) x += cx
        cx = x
        cmds.push({ t: 'H', x })
        lastCmd = 'H'
        break
      }
      case 'V': {
        let y = num()
        if (!abs) y += cy
        cy = y
        cmds.push({ t: 'V', y })
        lastCmd = 'V'
        break
      }
      case 'C': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num()
        if (!abs) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy }
        lastCtrlX = x2; lastCtrlY = y2
        cx = x; cy = y
        cmds.push({ t: 'C', x1, y1, x2, y2, x, y })
        lastCmd = 'C'
        break
      }
      case 'S': {
        let x2 = num(), y2 = num(), x = num(), y = num()
        if (!abs) { x2 += cx; y2 += cy; x += cx; y += cy }
        let x1 = cx, y1 = cy
        if (lastCmd === 'C' || lastCmd === 'S') { x1 = 2 * cx - lastCtrlX; y1 = 2 * cy - lastCtrlY }
        lastCtrlX = x2; lastCtrlY = y2
        cx = x; cy = y
        cmds.push({ t: 'C', x1, y1, x2, y2, x, y })
        lastCmd = 'S'
        break
      }
      case 'Q': {
        let x1 = num(), y1 = num(), x = num(), y = num()
        if (!abs) { x1 += cx; y1 += cy; x += cx; y += cy }
        lastCtrlX = x1; lastCtrlY = y1
        cx = x; cy = y
        cmds.push({ t: 'Q', x1, y1, x, y })
        lastCmd = 'Q'
        break
      }
      case 'T': {
        let x = num(), y = num()
        if (!abs) { x += cx; y += cy }
        let x1 = cx, y1 = cy
        if (lastCmd === 'Q' || lastCmd === 'T') { x1 = 2 * cx - lastCtrlX; y1 = 2 * cy - lastCtrlY }
        lastCtrlX = x1; lastCtrlY = y1
        cx = x; cy = y
        cmds.push({ t: 'Q', x1, y1, x, y })
        lastCmd = 'T'
        break
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), la = num(), sp = num()
        let x = num(), y = num()
        if (!abs) { x += cx; y += cy }
        cx = x; cy = y
        cmds.push({ t: 'A', rx, ry, rot, la, sp, x, y })
        lastCmd = 'A'
        break
      }
      case 'Z': {
        cx = sx; cy = sy
        cmds.push({ t: 'Z' })
        lastCmd = 'Z'
        break
      }
      default:
        i++ // skip unknown
    }
  }
  return cmds
}

function flattenPoints(cmds: AbsCmd[]): Array<[number, number]> {
  let cx = 0, cy = 0, sx = 0, sy = 0
  const pts: Array<[number, number]> = []
  for (const c of cmds) {
    switch (c.t) {
      case 'M': cx = c.x; cy = c.y; sx = c.x; sy = c.y; pts.push([c.x, c.y]); break
      case 'L': cx = c.x; cy = c.y; pts.push([c.x, c.y]); break
      case 'H': cx = c.x; pts.push([c.x, cy]); break
      case 'V': cy = c.y; pts.push([cx, c.y]); break
      case 'C': pts.push([c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]); cx = c.x; cy = c.y; break
      case 'Q': pts.push([c.x1, c.y1], [c.x, c.y]); cx = c.x; cy = c.y; break
      case 'A': pts.push([c.x, c.y]); cx = c.x; cy = c.y; break
      case 'Z': cx = sx; cy = sy; break
    }
  }
  return pts
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number }

export function bboxOf(cmds: AbsCmd[]): BBox {
  const pts = flattenPoints(cmds)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!isFinite(minX)) { minX = minY = maxX = maxY = 0 }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

// Fit the path's bbox into an em square with padding, centered.
export function normalize(cmds: AbsCmd[], em = 1000, pad = 64): AbsCmd[] {
  const bb = bboxOf(cmds)
  const target = em - pad * 2
  const scale = bb.w === 0 && bb.h === 0 ? 1 : target / Math.max(bb.w, bb.h || 1)
  const marginX = (em - bb.w * scale) / 2
  const marginY = (em - bb.h * scale) / 2
  const tx = (x: number) => x * scale + marginX - bb.minX * scale
  const ty = (y: number) => y * scale + marginY - bb.minY * scale
  return cmds.map((c) => {
    switch (c.t) {
      case 'M': return { t: 'M', x: tx(c.x), y: ty(c.y) }
      case 'L': return { t: 'L', x: tx(c.x), y: ty(c.y) }
      case 'H': return { t: 'H', x: tx(c.x) }
      case 'V': return { t: 'V', y: ty(c.y) }
      case 'C': return { t: 'C', x1: tx(c.x1), y1: ty(c.y1), x2: tx(c.x2), y2: ty(c.y2), x: tx(c.x), y: ty(c.y) }
      case 'Q': return { t: 'Q', x1: tx(c.x1), y1: ty(c.y1), x: tx(c.x), y: ty(c.y) }
      case 'A': return { t: 'A', rx: c.rx * scale, ry: c.ry * scale, rot: c.rot, la: c.la, sp: c.sp, x: tx(c.x), y: ty(c.y) }
      case 'Z': return { t: 'Z' }
    }
  })
}

// Convert an elliptical-arc command into cubic bezier segments (absolute, y-down
// authoring space). Returns a list of [x1,y1,x2,y2,x,y] control/end points.
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  large: number, sweep: number, x2: number, y2: number
): Array<[number, number, number, number, number, number]> {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]]
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  let rxl = Math.abs(rx), ryl = Math.abs(ry)
  const lambda = (x1p * x1p) / (rxl * rxl) + (y1p * y1p) / (ryl * ryl)
  if (lambda > 1) { const s = Math.sqrt(lambda); rxl *= s; ryl *= s }
  const sign = large === sweep ? -1 : 1
  const co = sign * Math.sqrt(
    Math.max(0, (rxl * rxl * ryl * ryl - rxl * rxl * y1p * y1p - ryl * ryl * x1p * x1p) /
      (rxl * rxl * y1p * y1p + ryl * ryl * x1p * x1p))
  )
  const cxp = (co * (rxl * y1p)) / ryl
  const cyp = (co * (-ryl * x1p)) / rxl
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1
    let a = Math.max(-1, Math.min(1, dot / len))
    let ang = Math.acos(a)
    if (ux * vy - uy * vx < 0) ang = -ang
    return ang
  }
  const th1 = angle(1, 0, (x1p - cxp) / rxl, (y1p - cyp) / ryl)
  let dth = angle((x1p - cxp) / rxl, (y1p - cyp) / ryl, (-x1p - cxp) / rxl, (-y1p - cyp) / ryl)
  if (sweep === 0 && dth > 0) dth -= 2 * Math.PI
  if (sweep === 1 && dth < 0) dth += 2 * Math.PI

  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)))
  const step = dth / segs
  const out: Array<[number, number, number, number, number, number]> = []
  let prevX = x1, prevY = y1
  for (let s = 0; s < segs; s++) {
    const a1 = th1 + s * step
    const a2 = a1 + step
    const ex = cx + rxl * Math.cos(a2)
    const ey = cy + ryl * Math.sin(a2)
    const k = (4 / 3) * Math.tan(step / 4)
    const t1x = -rxl * Math.sin(a1), t1y = ryl * Math.cos(a1)
    const t2x = -rxl * Math.sin(a2), t2y = ryl * Math.cos(a2)
    const c1xu = rxl * Math.cos(a1) - k * t1x
    const c1yu = ryl * Math.sin(a1) - k * t1y
    const c2xu = rxl * Math.cos(a2) + k * t2x
    const c2yu = ryl * Math.sin(a2) + k * t2y
    const c1x = cx + c1xu * cosP - c1yu * sinP
    const c1y = cy + c1xu * sinP + c1yu * cosP
    const c2x = cx + c2xu * cosP - c2yu * sinP
    const c2y = cy + c2xu * sinP + c2yu * cosP
    out.push([c1x, c1y, c2x, c2y, ex, ey])
    prevX = ex; prevY = ey
  }
  return out
}

// Build an opentype.js Path. Incoming cmds are in normalized y-down authoring
// space (0..em). Fonts are y-up, so we flip: Y' = em - y.
export function toOpentypePath(cmds: AbsCmd[], em = 1000): any {
  const p = new opentype.Path()
  let cxD = 0, cyD = 0, sxD = 0, syD = 0
  const FY = (y: number) => em - y
  for (const c of cmds) {
    switch (c.t) {
      case 'M': { cxD = c.x; cyD = c.y; sxD = c.x; syD = c.y; p.moveTo(c.x, FY(c.y)); break }
      case 'L': { cxD = c.x; cyD = c.y; p.lineTo(c.x, FY(c.y)); break }
      case 'H': { cxD = c.x; p.lineTo(c.x, FY(cyD)); break }
      case 'V': { cyD = c.y; p.lineTo(cxD, FY(c.y)); break }
      case 'C': {
        p.curveTo(c.x1, FY(c.y1), c.x2, FY(c.y2), c.x, FY(c.y))
        cxD = c.x; cyD = c.y; break
      }
      case 'Q': {
        p.quadTo(c.x1, FY(c.y1), c.x, FY(c.y))
        cxD = c.x; cyD = c.y; break
      }
      case 'A': {
        const cubics = arcToCubics(cxD, cyD, c.rx, c.ry, c.rot, c.la, c.sp, c.x, c.y)
        for (const [x1, y1, x2, y2, x, y] of cubics) {
          p.curveTo(x1, FY(y1), x2, FY(y2), x, FY(y))
        }
        cxD = c.x; cyD = c.y; break
      }
      case 'Z': { p.close(); cxD = sxD; cyD = syD; break }
    }
  }
  return p
}
