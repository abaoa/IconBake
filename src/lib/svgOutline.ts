// svgOutline.ts
// Turn an SVG document into ONE fill-ready path `d` string.
//
// The important bit: icon sets like Lucide / Feather / Tabler draw with
// `fill="none" stroke="currentColor" stroke-width="2"`. Feeding those `d` strings
// straight into a font builder fills the *center line* of the stroke, which turns a
// bell into a blob. So strokes are expanded into real outlines here (Clipper offset),
// which is what a font actually needs.
//
// Also handled: style inheritance (svg / g / element), `style=""` vs presentation
// attributes, transforms, basic shapes, and `fill-rule="evenodd"` (rewritten to the
// non-zero winding that TrueType uses).
import ClipperLib from 'clipper-lib'
import { parsePath, arcToCubics, type AbsCmd } from './svgPath'

const SHAPE_SELECTOR = 'path,rect,circle,ellipse,polygon,polyline,line'

// SVG user units. 0.015 of a 24-unit icon ≈ 0.06% — invisible, but keeps point counts sane.
const FLATTEN_TOL = 0.015
// Clipper works on integers; 1000 sub-units per SVG unit = 0.001 unit precision.
const CLIPPER_SCALE = 1000
const ARC_TOLERANCE = 0.05 * CLIPPER_SCALE
const MITER_LIMIT = 2

export interface SubPath {
  pts: Array<[number, number]>
  closed: boolean
}

export interface Matrix {
  a: number; b: number; c: number; d: number; e: number; f: number
}

export interface OutlineStats {
  /** shapes painted with fill */
  fillShapes: number
  /** shapes painted with stroke, expanded into outlines */
  strokeShapes: number
  /** shapes with neither fill nor stroke */
  skipped: number
  /** shapes whose transform had to be baked (curves became polylines) */
  transformed: number
}

export interface OutlineResult {
  d: string
  stats: OutlineStats
}

/* ------------------------------------------------------------------ matrix */

function identity(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

/** m1 · m2 — point goes through m2 first, then m1. */
function mul(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]
}

function isIdentity(m: Matrix): boolean {
  return (
    Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 &&
    Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9 &&
    Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9
  )
}

const TRANSFORM_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g

export function parseTransform(str: string): Matrix {
  let m = identity()
  if (!str) return m
  TRANSFORM_RE.lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = TRANSFORM_RE.exec(str))) {
    const fn = hit[1].toLowerCase()
    const args = hit[2].split(/[\s,]+/).map(Number).filter((n) => !isNaN(n))
    let local = identity()
    switch (fn) {
      case 'matrix':
        if (args.length >= 6) local = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] }
        break
      case 'translate':
        local = { a: 1, b: 0, c: 0, d: 1, e: args[0] || 0, f: args.length > 1 ? args[1] : 0 }
        break
      case 'scale': {
        const sx = args.length ? args[0] : 1
        const sy = args.length > 1 ? args[1] : sx
        local = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
        break
      }
      case 'rotate': {
        const deg = args[0] || 0
        const rad = (deg * Math.PI) / 180
        const cos = Math.cos(rad), sin = Math.sin(rad)
        const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
        if (args.length >= 3) {
          const cx = args[1], cy = args[2]
          local = mul(mul({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, rot), { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy })
        } else {
          local = rot
        }
        break
      }
      case 'skewx':
        local = { a: 1, b: 0, c: Math.tan(((args[0] || 0) * Math.PI) / 180), d: 1, e: 0, f: 0 }
        break
      case 'skewy':
        local = { a: 1, b: Math.tan(((args[0] || 0) * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 }
        break
      default:
        break
    }
    // "translate(10) scale(2)" means the point is scaled first, then translated.
    m = mul(m, local)
  }
  return m
}

/* ------------------------------------------------------------------- styles */

interface Style {
  fill: string
  stroke: string
  strokeWidth: number
  lineCap: 'butt' | 'round' | 'square'
  lineJoin: 'miter' | 'round' | 'bevel'
  fillRule: 'nonzero' | 'evenodd'
  hasRawStrokeWidth: boolean
}

const PAINT_KEYS = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'display',
] as const

/** Declarations on one element: presentation attributes first, then `style=""` wins. */
function ownDecls(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of PAINT_KEYS) {
    const v = el.getAttribute(k)
    if (v !== null && v.trim() !== '') out[k] = v.trim()
  }
  const styleAttr = el.getAttribute('style')
  if (styleAttr) {
    for (const part of styleAttr.split(';')) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      const k = part.slice(0, idx).trim().toLowerCase()
      const v = part.slice(idx + 1).trim()
      if (k && v) out[k] = v
    }
  }
  return out
}

function isNonePaint(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '' || s === 'none' || s === 'transparent'
}

function parseLength(v: string | undefined): number | null {
  if (v === undefined) return null
  const m = /^\s*([+-]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/.exec(v)
  if (!m) return null
  const n = parseFloat(m[1])
  if (isNaN(n)) return null
  switch (m[2]) {
    // Only px-like absolute units are meaningful inside an icon viewBox.
    case 'pt': return n * (96 / 72)
    case 'pc': return n * 16
    case 'mm': return n * (96 / 25.4)
    case 'cm': return n * (96 / 2.54)
    case 'in': return n * 96
    default: return n
  }
}

const DEFAULT_STYLE: Style = {
  fill: 'black', // SVG initial value: fill is black
  stroke: 'none',
  strokeWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  fillRule: 'nonzero',
  hasRawStrokeWidth: false,
}

/** Compose inherited style along the ancestor chain (root -> element). */
function resolveStyle(chain: Element[]): Style {
  const s: Style = { ...DEFAULT_STYLE }
  for (const el of chain) {
    const d = ownDecls(el)
    if ('fill' in d) s.fill = d.fill
    if ('stroke' in d) s.stroke = d.stroke
    if ('stroke-width' in d) {
      const w = parseLength(d['stroke-width'])
      if (w !== null) {
        s.strokeWidth = w
        s.hasRawStrokeWidth = true
      }
    }
    if ('stroke-linecap' in d) {
      const c = d['stroke-linecap'].toLowerCase()
      if (c === 'butt' || c === 'round' || c === 'square') s.lineCap = c
    }
    if ('stroke-linejoin' in d) {
      const j = d['stroke-linejoin'].toLowerCase()
      if (j === 'miter' || j === 'round' || j === 'bevel') s.lineJoin = j
      else if (j === 'miter-clip' || j === 'arcs') s.lineJoin = 'miter'
    }
    if ('fill-rule' in d) {
      const r = d['fill-rule'].toLowerCase()
      if (r === 'nonzero' || r === 'evenodd') s.fillRule = r
    }
    if (d.display && d.display.toLowerCase() === 'none') s.fill = 'none'
  }
  return s
}

/* ------------------------------------------------------------------ shapes */

function shapeToPath(el: Element): string | null {
  const tag = el.tagName.toLowerCase()
  const num = (name: string, def = 0) => {
    const n = parseFloat(el.getAttribute(name) ?? '')
    return isNaN(n) ? def : n
  }
  switch (tag) {
    case 'path':
      return el.getAttribute('d') || null
    case 'rect': {
      const x = num('x'), y = num('y'), w = num('width'), h = num('height')
      if (w <= 0 || h <= 0) return null
      const rx = Math.min(num('rx', -1) >= 0 ? num('rx') : num('ry', 0), w / 2)
      const ry = Math.min(num('ry', -1) >= 0 ? num('ry') : num('rx', 0), h / 2)
      if (rx > 0 || ry > 0) {
        return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
          `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
          `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      }
      return `M${x} ${y}H${x + w}V${y + h}H${x}Z`
    }
    case 'circle': {
      const cx = num('cx'), cy = num('cy'), r = num('r')
      if (r <= 0) return null
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`
    }
    case 'ellipse': {
      const cx = num('cx'), cy = num('cy'), rx = num('rx'), ry = num('ry')
      if (rx <= 0 || ry <= 0) return null
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
    }
    case 'polygon':
    case 'polyline': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n))
      if (pts.length < 4) return null
      let d = ''
      for (let i = 0; i + 1 < pts.length; i += 2) d += (i === 0 ? 'M' : 'L') + pts[i] + ' ' + pts[i + 1] + ' '
      if (tag === 'polygon') d += 'Z'
      return d.trim()
    }
    case 'line': {
      const x1 = num('x1'), y1 = num('y1'), x2 = num('x2'), y2 = num('y2')
      return `M${x1} ${y1}L${x2} ${y2}`
    }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- flatten */

function cubicFlatEnough(p0: number[], p1: number[], p2: number[], p3: number[], tol2: number): boolean {
  const dx = p3[0] - p0[0]
  const dy = p3[1] - p0[1]
  const chord = dx * dx + dy * dy
  if (chord < 1e-12) {
    const a = (p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2
    const b = (p2[0] - p0[0]) ** 2 + (p2[1] - p0[1]) ** 2
    return Math.max(a, b) <= tol2
  }
  const c1 = Math.abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx)
  const c2 = Math.abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx)
  const m = Math.max(c1, c2)
  return m * m <= tol2 * chord
}

function flattenCubic(
  p0: number[], p1: number[], p2: number[], p3: number[],
  tol2: number, depth: number, push: (p: [number, number]) => void
): void {
  if (depth >= 18 || cubicFlatEnough(p0, p1, p2, p3, tol2)) {
    push([p3[0], p3[1]])
    return
  }
  const mid = (a: number[], b: number[]): number[] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3)
  const p012 = mid(p01, p12), p123 = mid(p12, p23)
  const p0123 = mid(p012, p123)
  flattenCubic(p0, p01, p012, p0123, tol2, depth + 1, push)
  flattenCubic(p0123, p123, p23, p3, tol2, depth + 1, push)
}

/** Flatten all commands into polylines (curves become line segments). */
export function flattenSubPaths(cmds: AbsCmd[], tol = FLATTEN_TOL): SubPath[] {
  const tol2 = tol * tol
  const subs: SubPath[] = []
  let cur: SubPath | null = null
  let cx = 0, cy = 0, sx = 0, sy = 0
  const push = (p: [number, number]) => {
    if (cur) cur.pts.push(p)
  }
  for (const c of cmds) {
    switch (c.t) {
      case 'M':
        cur = { pts: [[c.x, c.y]], closed: false }
        subs.push(cur)
        cx = c.x; cy = c.y; sx = c.x; sy = c.y
        break
      case 'L':
        push([c.x, c.y]); cx = c.x; cy = c.y
        break
      case 'H':
        push([c.x, cy]); cx = c.x
        break
      case 'V':
        push([cx, c.y]); cy = c.y
        break
      case 'C':
        flattenCubic([cx, cy], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y], tol2, 0, push)
        cx = c.x; cy = c.y
        break
      case 'Q': {
        const c1: number[] = [cx + (2 / 3) * (c.x1 - cx), cy + (2 / 3) * (c.y1 - cy)]
        const c2: number[] = [c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y)]
        flattenCubic([cx, cy], c1, c2, [c.x, c.y], tol2, 0, push)
        cx = c.x; cy = c.y
        break
      }
      case 'A': {
        const cubics = arcToCubics(cx, cy, c.rx, c.ry, c.rot, c.la, c.sp, c.x, c.y)
        for (const [x1, y1, x2, y2, ex, ey] of cubics) {
          flattenCubic([cx, cy], [x1, y1], [x2, y2], [ex, ey], tol2, 0, push)
          cx = ex; cy = ey
        }
        break
      }
      case 'Z':
        if (cur) {
          cur.closed = true
          const first = cur.pts[0]
          const last = cur.pts[cur.pts.length - 1]
          if (first && last && Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6 && cur.pts.length > 2) {
            cur.pts.pop()
          }
        }
        cx = sx; cy = sy
        break
    }
  }
  return subs.filter((s) => s.pts.length >= 2)
}

/** Apply a matrix to flattened sub-paths. */
function transformSubPaths(subs: SubPath[], m: Matrix): SubPath[] {
  if (isIdentity(m)) return subs
  return subs.map((s) => ({ closed: s.closed, pts: s.pts.map(([x, y]) => applyMatrix(m, x, y)) }))
}

/* ---------------------------------------------------------------- clipping */

function toClipperPath(s: SubPath): Array<{ X: number; Y: number }> {
  return s.pts.map(([x, y]) => ({
    X: Math.round(x * CLIPPER_SCALE),
    Y: Math.round(y * CLIPPER_SCALE),
  }))
}

// Always reference clipper's own enums: the integer values are NOT in the order
// you'd expect (etOpenSquare=0 / etOpenRound=1 / etOpenButt=2 / etClosedLine=3).
const JOIN_BY_NAME: Record<string, string> = {
  miter: 'jtMiter',
  round: 'jtRound',
  bevel: 'jtSquare', // Clipper has no true bevel; square is the closest join
}

const END_BY_CAP: Record<string, string> = {
  butt: 'etOpenButt',
  square: 'etOpenSquare',
  round: 'etOpenRound',
}

function joinTypeOf(join: string): number {
  return ClipperLib.JoinType[JOIN_BY_NAME[join] ?? 'jtRound']
}

function endTypeOf(cap: string, closed: boolean): number {
  if (closed) return ClipperLib.EndType.etClosedLine
  return ClipperLib.EndType[END_BY_CAP[cap] ?? 'etOpenRound']
}

/** Expand stroked polylines into closed outline polygons. */
function offsetSubPaths(subs: SubPath[], width: number, cap: string, join: string): any[] {
  const co = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE)
  for (const s of subs) {
    if (s.pts.length < 2) continue
    co.AddPath(toClipperPath(s), joinTypeOf(join), endTypeOf(cap, s.closed))
  }
  const solution = new ClipperLib.Paths()
  co.Execute(solution, (width / 2) * CLIPPER_SCALE)
  if (!solution.length) return []
  // Merge overlaps so winding is consistent for non-zero fills.
  const merged = ClipperLib.Clipper.SimplifyPolygons(solution, ClipperLib.PolyFillType.pftNonZero)
  return merged && merged.length ? merged : solution
}

/** Rewrite an even-odd polygon set into non-zero-friendly wound polygons. */
function evenOddToNonZero(subs: SubPath[]): any[] {
  const paths = subs.filter((s) => s.pts.length >= 3).map(toClipperPath)
  if (!paths.length) return []
  const merged = ClipperLib.Clipper.SimplifyPolygons(paths, ClipperLib.PolyFillType.pftEvenOdd)
  return merged && merged.length ? merged : paths
}

function clipperPathsToD(paths: any[]): string {
  const out: string[] = []
  for (const p of paths) {
    if (!p || p.length < 3) continue
    let d = ''
    for (let i = 0; i < p.length; i++) {
      const x = (p[i].X / CLIPPER_SCALE).toFixed(3)
      const y = (p[i].Y / CLIPPER_SCALE).toFixed(3)
      d += (i === 0 ? 'M' : 'L') + x + ' ' + y
    }
    out.push(d + 'Z')
  }
  return out.join(' ')
}

/* ------------------------------------------------------------------- entry */

export interface OutlineOptions {
  /** Flattening tolerance in SVG user units. */
  tolerance?: number
}

export function svgToFillPath(svgText: string, opts: OutlineOptions = {}): OutlineResult {
  const tol = opts.tolerance ?? FLATTEN_TOL
  const stats: OutlineStats = { fillShapes: 0, strokeShapes: 0, skipped: 0, transformed: 0 }
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const root = doc.querySelector('svg') || doc.documentElement
  if (!root) return { d: '', stats }

  const parts: string[] = []
  const elements = Array.from(root.querySelectorAll(SHAPE_SELECTOR))

  for (const el of elements) {
    const d = shapeToPath(el)
    if (!d || !d.trim()) {
      stats.skipped++
      continue
    }
    // Ancestor chain, root -> element, so inherited paint and transforms compose correctly.
    // The <svg> root itself must be included: icon sets declare paint there.
    const chain: Element[] = []
    let node: Element | null = el
    while (node) {
      chain.unshift(node)
      if ((node.tagName || '').toLowerCase() === 'svg') break
      node = node.parentElement
    }
    const style = resolveStyle(chain)
    const matrix = chain.reduce<Matrix>((acc, n) => mul(acc, parseTransform(n.getAttribute('transform') || '')), identity())

    const strokeOn = !isNonePaint(style.stroke) && style.strokeWidth > 0
    const fillOn = !isNonePaint(style.fill)

    if (strokeOn) {
      let subs = flattenSubPaths(parsePath(d), tol)
      if (!subs.length) {
        stats.skipped++
        continue
      }
      if (!isIdentity(matrix)) subs = transformSubPaths(subs, matrix)
      const outlines = offsetSubPaths(subs, style.strokeWidth, style.lineCap, style.lineJoin)
      if (outlines.length) {
        parts.push(clipperPathsToD(outlines))
        stats.strokeShapes++
      } else {
        stats.skipped++
      }
    }

    if (fillOn) {
      if (!isIdentity(matrix) || style.fillRule === 'evenodd') {
        // Curves have to become polylines here, but the winding gets fixed up.
        const subs = transformSubPaths(flattenSubPaths(parsePath(d), tol), matrix)
        const fixed = evenOddToNonZero(subs)
        if (fixed.length) {
          parts.push(clipperPathsToD(fixed))
          stats.fillShapes++
          if (!isIdentity(matrix)) stats.transformed++
        } else {
          stats.skipped++
        }
      } else {
        // Untouched: keeps the original bezier precision.
        parts.push(d)
        stats.fillShapes++
      }
    }

    if (!strokeOn && !fillOn) stats.skipped++
  }

  return { d: parts.join(' '), stats }
}

/** Kept for the PNG path / legacy callers: just the combined `d`. */
export function extractSvgPaths(svgText: string): string {
  return svgToFillPath(svgText).d
}
