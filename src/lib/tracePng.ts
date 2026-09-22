// tracePng.ts
// Vectorize a raster image (PNG/JPG) into an SVG path string using imagetracerjs.
// The result is a combined `d` string (silhouette), ready for normalize()+font build.
import * as ImageTracer from 'imagetracerjs'

const OPTIONS = {
  // Monochrome silhouette: 2 colors, light quant cycles, drop tiny noise paths.
  numberofcolors: 2,
  colorquantcycles: 1,
  pathomit: 2,
  blurradius: 1,
  blurdelta: 32,
  roundcoords: 1,
  // Keep the larger (foreground) shape; we merge every path anyway.
  palettesize: 2,
  mincolorratio: 0,
}

export function tracePng(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('Canvas 2D context unavailable'))
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const svg = ImageTracer.imagedataToSVG(imageData, OPTIONS)
        URL.revokeObjectURL(url)
        resolve(svg)
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}

/** Pull every <path d="..."> out of an imagetracer SVG and join into one `d`. */
export function svgToCombinedD(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const parts: string[] = []
  doc.querySelectorAll('path').forEach(p => {
    const d = p.getAttribute('d')
    if (d) parts.push(d)
  })
  return parts.join(' ')
}
