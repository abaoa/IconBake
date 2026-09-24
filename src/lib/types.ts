export interface GlyphInput {
  /** Class name used in CSS, e.g. "home" -> .iconbake-home */
  name: string
  /** Combined SVG path `d` string (already in one coordinate space). */
  d: string
  /** Source file name, kept for the demo / audit. */
  source?: string
}

/**
 * Optional identification records written into the font's `name` table
 * (the fields font managers / design software show in "font info").
 * Everything is optional — blanks fall back to safe defaults.
 */
export interface FontMeta {
  /** Style / weight name, e.g. "Regular". */
  styleName?: string
  /** Human version string, e.g. "1.0" — stored as "Version 1.0". */
  version?: string
  copyright?: string
  designer?: string
  designerURL?: string
  manufacturer?: string
  manufacturerURL?: string
  license?: string
  licenseURL?: string
  description?: string
}

export interface BuildOptions {
  family?: string
  em?: number
  /** First codepoint; PUA private area by default. */
  startCodepoint?: number
  meta?: FontMeta
}

export interface GlyphMeta {
  name: string
  codepoint: number
  cssClass: string
  unicode: string // hex without 0x, e.g. "e001"
}

/**
 * `FontMeta` after defaults are applied and derived fields are computed —
 * this is exactly what ends up in the `name` table.
 */
export interface ResolvedFontMeta {
  styleName: string
  fullName: string
  postScriptName: string
  version: string
  copyright?: string
  designer?: string
  designerURL?: string
  manufacturer?: string
  manufacturerURL?: string
  license?: string
  licenseURL?: string
  description?: string
}

export interface BuildResult {
  family: string
  em: number
  ttf: Uint8Array
  woff: Uint8Array
  css: string
  html: string
  json: string
  meta: GlyphMeta[]
  /** Resolved identification records actually written into the font. */
  info: ResolvedFontMeta
}
