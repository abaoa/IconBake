// buildFont.ts
// Assemble an icon font from a list of glyph inputs using opentype.js, then emit
// TTF + WOFF and the companion assets. Everything runs in the browser.
import opentype from 'opentype.js'
import ttf2woff from 'ttf2woff'
import { parsePath, normalize, toOpentypePath } from './svgPath'
import { generateCss, generateHtml, generateJson, packageZip } from './pack'
import type { GlyphInput, BuildOptions, BuildResult, GlyphMeta, FontMeta } from './types'

export function sanitizeName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return s || 'icon'
}

export const DEFAULT_STYLE_NAME = 'Regular'
export const DEFAULT_VERSION = '1.0'

/** Blank strings must become undefined so opentype.js keeps its own defaults. */
function clean(v?: string): string | undefined {
  const s = (v ?? '').trim()
  return s ? s : undefined
}

/** "1.2" -> "Version 1.2"; a string that already says "Version" is left alone. */
export function formatVersion(v?: string): string | undefined {
  const s = clean(v)
  if (!s) return undefined
  return /^version\b/i.test(s) ? s : `Version ${s}`
}

/**
 * Build the `name` record set, filling in sensible defaults and deriving the
 * fields the user does not type (fullName / postScriptName).
 * `postScriptName` may not contain whitespace, so it is always sanitised.
 */
export function resolveFontMeta(family: string, meta: FontMeta = {}) {
  const styleName = clean(meta.styleName) ?? DEFAULT_STYLE_NAME
  return {
    styleName,
    fullName: `${family} ${styleName}`,
    postScriptName: `${family}${styleName}`.replace(/[^A-Za-z0-9._-]/g, ''),
    version: formatVersion(meta.version) ?? formatVersion(DEFAULT_VERSION),
    copyright: clean(meta.copyright),
    designer: clean(meta.designer),
    designerURL: clean(meta.designerURL),
    manufacturer: clean(meta.manufacturer),
    manufacturerURL: clean(meta.manufacturerURL),
    license: clean(meta.license),
    licenseURL: clean(meta.licenseURL),
    description: clean(meta.description),
  }
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
  const info = resolveFontMeta(family, opts.meta)

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
    styleName: info.styleName,
    unitsPerEm: em,
    ascender: Math.round(em * 0.8),
    descender: -Math.round(em * 0.2),
    glyphs,
    // Identification records — opentype.js writes a single space when these are
    // absent, which shows up as blank rows in font managers.
    fullName: info.fullName,
    postScriptName: info.postScriptName,
    version: info.version,
    copyright: info.copyright,
    designer: info.designer,
    designerURL: info.designerURL,
    manufacturer: info.manufacturer,
    manufacturerURL: info.manufacturerURL,
    license: info.license,
    licenseURL: info.licenseURL,
    description: info.description,
  })

  // 没填的可选字段：整条删除 name 记录。opentype.js 对空值会写一个空格
  // （为避免 macOS 抱怨），结果字体信息面板里会出现一堆空白行。
  const OPTIONAL_NAME_KEYS = [
    'copyright',
    'designer',
    'designerURL',
    'manufacturer',
    'manufacturerURL',
    'license',
    'licenseURL',
    'description',
    'trademark',
  ]
  for (const key of OPTIONAL_NAME_KEYS) {
    const rec = font.names?.[key]
    const value = rec?.en ?? (rec ? Object.values(rec)[0] : '')
    if (!String(value ?? '').trim()) delete font.names[key]
  }

  const ttfBuffer = font.toArrayBuffer()
  const ttf = new Uint8Array(ttfBuffer)
  const woff = (ttf2woff as any)(ttf) as Uint8Array

  const css = generateCss(family, meta)
  const html = generateHtml(family, meta, ttf)
  const json = generateJson(family, em, meta, info)

  return { family, em, ttf, woff, css, html, json, meta, info }
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
    result.json,
    result.info
  )
  return { result, zip }
}
