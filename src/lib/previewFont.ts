// previewFont.ts
// Register an already-built TTF with the browser so the UI can render real
// glyphs (`font-family: <name>`) instead of the source SVG path. This is the
// only way to see what the icon actually looks like *as a font* — hinting,
// advance width and vertical metrics included.

export interface PreviewFont {
  /** Generated family name — feed it to `font-family`. */
  family: string
  /** Remove the face from the document (call before registering a new one). */
  dispose(): void
}

/** `FontFace` / `document.fonts` are both required; jsdom has neither. */
export function isFontFaceSupported(): boolean {
  return typeof FontFace !== 'undefined' && typeof document !== 'undefined' && !!document.fonts
}

/** A Uint8Array may be a view into a larger buffer — FontFace wants exact bytes. */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) return u.buffer as ArrayBuffer
  return u.slice().buffer as ArrayBuffer
}

let seq = 0

/** Unique per registration: reusing a family name would keep stale glyphs. */
export function nextPreviewFamily(prefix = 'IconBakePreview'): string {
  return `${prefix}${++seq}`
}

/**
 * Register `ttf` under `family` and resolve once the face is usable.
 * `load()` is awaited on purpose — rendering before it settles shows .notdef.
 */
export async function registerPreviewFont(family: string, ttf: Uint8Array): Promise<PreviewFont> {
  if (!isFontFaceSupported()) throw new Error('当前环境不支持 FontFace，无法预览字体渲染')
  const face = new FontFace(family, toArrayBuffer(ttf))
  await face.load()
  document.fonts.add(face)
  let done = false
  return {
    family,
    dispose() {
      if (done) return
      done = true
      try {
        document.fonts.delete(face)
      } catch {
        /* already gone — nothing to clean up */
      }
    },
  }
}
