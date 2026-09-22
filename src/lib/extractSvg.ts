// extractSvg.ts
// Extract one combined SVG path `d` string from an uploaded .svg file.
// Multiple shapes (path / rect / circle / ellipse / polygon / polyline / line)
// are converted to path data and concatenated so the whole icon shares one
// coordinate space and can be normalized together.

function num(v: string | null, d = 0): number {
  const n = parseFloat(v ?? '')
  return isNaN(n) ? d : n
}

function shapeToPath(el: Element): string | null {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'path':
      return el.getAttribute('d') || null
    case 'rect': {
      const x = num(el.getAttribute('x')), y = num(el.getAttribute('y'))
      const w = num(el.getAttribute('width')), h = num(el.getAttribute('height'))
      if (w <= 0 || h <= 0) return null
      return `M${x} ${y}H${x + w}V${y + h}H${x}Z`
    }
    case 'circle': {
      const cx = num(el.getAttribute('cx')), cy = num(el.getAttribute('cy')), r = num(el.getAttribute('r'))
      if (r <= 0) return null
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`
    }
    case 'ellipse': {
      const cx = num(el.getAttribute('cx')), cy = num(el.getAttribute('cy'))
      const rx = num(el.getAttribute('rx')), ry = num(el.getAttribute('ry'))
      if (rx <= 0 || ry <= 0) return null
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
    }
    case 'polygon':
    case 'polyline': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n))
      if (pts.length < 4) return null
      let d = ''
      for (let i = 0; i < pts.length; i += 2) d += (i === 0 ? 'M' : 'L') + pts[i] + ' ' + pts[i + 1] + ' '
      if (tag === 'polygon') d += 'Z'
      return d.trim()
    }
    case 'line': {
      const x1 = num(el.getAttribute('x1')), y1 = num(el.getAttribute('y1'))
      const x2 = num(el.getAttribute('x2')), y2 = num(el.getAttribute('y2'))
      return `M${x1} ${y1}L${x2} ${y2}`
    }
    default:
      return null
  }
}

export function extractSvgPaths(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg) return ''
  const parts: string[] = []
  svg.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,line').forEach(el => {
    const d = shapeToPath(el)
    if (d) parts.push(d)
  })
  return parts.join(' ')
}
