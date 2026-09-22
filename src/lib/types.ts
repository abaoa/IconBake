export interface GlyphInput {
  /** Class name used in CSS, e.g. "home" -> .iconbake-home */
  name: string
  /** Combined SVG path `d` string (already in one coordinate space). */
  d: string
  /** Source file name, kept for the demo / audit. */
  source?: string
}

export interface BuildOptions {
  family?: string
  em?: number
  /** First codepoint; PUA private area by default. */
  startCodepoint?: number
}

export interface GlyphMeta {
  name: string
  codepoint: number
  cssClass: string
  unicode: string // hex without 0x, e.g. "e001"
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
}
