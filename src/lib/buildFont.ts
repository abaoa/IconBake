// buildFont.ts
// Assemble an icon font from a list of glyph inputs using opentype.js, then emit
// TTF + WOFF and the companion assets. Everything runs in the browser.
import opentype from 'opentype.js'
import ttf2woff from 'ttf2woff'
import { parsePath, normalize, toOpentypePath } from './svgPath'
import { generateCss, generateHtml, generateJson, packageZip } from './pack'
import type { GlyphInput, BuildOptions, BuildResult, GlyphMeta } from './types'

export function sanitizeName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return s || 'icon'
}

function glyphPath(d: string, em: number): any {
  const cmds = parsePath(d)
  const norm = normalize(cmds, em)
  return toOpentypePath(norm, em)
}

export function buildFont(icons: GlyphInput[], opts: BuildOptions = {}): BuildResult {
  const em = opts.em ?? 1000
  const family = opts.family ?? 'iconbake'
  const start = opts.startCodepoint ?? 0xe001

  const glyphs: any[] = [new opentype.Glyph({ name: '.notdef', advanceWidth: em, path: new opentype.Path() })]
  const meta: GlyphMeta[] = []

  icons.forEach((icon, i) => {
    const codepoint = start + i
    const path = glyphPath(icon.d, em)
    const name = sanitizeName(icon.name)
    const glyph = new opentype.Glyph({ name, unicode: codepoint, advanceWidth: em, path })
    glyphs.push(glyph)
    meta.push({ name, codepoint, cssClass: `${family}-${name}`, unicode: codepoint.toString(16) })
  })

  const font = new opentype.Font({
    familyName: family,
    styleName: 'Regular',
    unitsPerEm: em,
    ascender: Math.round(em * 0.8),
    descender: -Math.round(em * 0.2),
    glyphs,
  })

  const ttfBuffer = font.toArrayBuffer()
  const ttf = new Uint8Array(ttfBuffer)
  const woff = (ttf2woff as any)(ttf) as Uint8Array

  const css = generateCss(family, meta)
  const html = generateHtml(family, meta, ttf)
  const json = generateJson(family, em, meta)

  return { family, em, ttf, woff, css, html, json, meta }
}

export async function buildAndZip(
  icons: GlyphInput[],
  opts: BuildOptions = {}
): Promise<{ result: BuildResult; zip: Blob }> {
  const result = buildFont(icons, opts)
  const zip = await packageZip(
    result.family,
    result.meta,
    result.em,
    result.ttf,
    result.woff,
    result.css,
    result.html,
    result.json
  )
  return { result, zip }
}
