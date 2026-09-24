// fontFile.ts
// 读取用户从磁盘上选的字体文件（.ttf / .otf / .woff / .woff2），把里面的图标
// 字形列出来，交给「字体文件预览」面板渲染。
//
// 为什么能读：opentype.js 会解析 sfnt（ttf/otf）与 woff（自带 inflate）。
// 只有 woff2 例外 —— 它整表用 Brotli 压缩，opentype.js 没有实现。浏览器加载
// woff2 没问题，只是我们读不出字形表，此时面板降级成「只能试排文字」。
import opentype from 'opentype.js'
import { toArrayBuffer } from './previewFont'

/** `<input type=file>` 的 accept 值。 */
export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2'

/**
 * 私有区（PUA）码位段 —— 图标字体几乎都落在这里，所以默认只显示这些。
 * 除 BMP 的 E000–F8FF 外，还有补充私有区 A / B。
 */
const PUA_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
]

export function isPua(cp: number): boolean {
  return PUA_RANGES.some(([a, b]) => cp >= a && cp <= b)
}

export function isFontFileName(name: string): boolean {
  return /\.(?:ttf|otf|woff2?)$/i.test(name.trim())
}

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2' | 'other'

export const FORMAT_LABEL: Record<FontFormat, string> = {
  ttf: 'TTF',
  otf: 'OTF',
  woff: 'WOFF',
  woff2: 'WOFF2',
  other: '未知格式',
}

/** 只看开头 4 字节就够判断 —— 与 opentype.js 的判断依据一致。 */
export function sniffFormat(input: Uint8Array | ArrayBuffer): FontFormat {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (u.length < 4) return 'other'
  const sig = String.fromCharCode(u[0], u[1], u[2], u[3])
  if (sig === 'wOF2') return 'woff2'
  if (sig === 'wOFF') return 'woff'
  if (sig === 'OTTO') return 'otf'
  if (sig === 'true' || sig === 'ttcf') return 'ttf'
  // 0x00010000 —— 最常见的 TrueType 签名
  if (u[0] === 0x00 && u[1] === 0x01 && u[2] === 0x00 && u[3] === 0x00) return 'ttf'
  return 'other'
}

export interface FontGlyphInfo {
  /** 字形在字体里的序号（没有字形名时用它当标签）。 */
  index: number
  cp: number
  /** "0xE001" */
  cpText: string
  /** 字形名；系统字体常常没有名字（post 表为空），此时是空串。 */
  name: string
  pua: boolean
  /** 有没有轮廓 —— 空白字形（空格之类）画不出东西。 */
  hasOutline: boolean
}

export interface FontLigatureInfo {
  /** 展示用标签（可读文本优先，否则退化成字形名 / 序号）。 */
  label: string
  /** 可以真的敲出来的文本（推不出来时是空串）。 */
  text: string
  /** 连字产物的码位，没有就是 null。 */
  cp: number | null
  cpText: string
}

export interface FontFileAnalysis {
  format: FontFormat
  familyName: string
  styleName: string
  version: string
  unitsPerEm: number
  ascend: number
  descend: number
  /** 字体里字形总数（含 .notdef）。 */
  glyphTotal: number
  /** 有码位的字形，按码位升序。 */
  glyphs: FontGlyphInfo[]
  /** 其中落在私有区的个数。 */
  puaCount: number
  withOutline: number
  /** 有码位但没轮廓（空字形）的个数 —— 面板里会说明、不显示。 */
  blankCount: number
  ligatures: FontLigatureInfo[]
}

function hex(cp: number): string {
  return '0x' + cp.toString(16).toUpperCase().padStart(4, '0')
}

/** `getEnglishName` 找不到时会回退到任意语言；异常时给空串。 */
function englishName(font: any, key: string): string {
  try {
    const v = font.getEnglishName ? font.getEnglishName(key) : font.names?.[key]?.en
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

function glyphCodepoint(g: any): number | null {
  if (typeof g?.unicode === 'number') return g.unicode
  if (Array.isArray(g?.unicodes) && typeof g.unicodes[0] === 'number') return g.unicodes[0]
  return null
}

/**
 * 连字（GSUB lookup type 4）。图标字体有两种流派：要么每个图标一个私有区码位
 * （文本里只能敲那个码位），要么支持连字（敲 "home" 就出房子图标）。
 * 后者用 liga 表描述，这里只保留「能由字形名推导出可敲文本」的那些 ——
 * 名字推不出来的连字（如 uni0068）留在列表里也没法用。
 */
function extractLigatures(font: any): FontLigatureInfo[] {
  let found: any[] = []
  try {
    found = font.substitution?.getLigatures?.('liga') || []
  } catch {
    return []
  }
  const out: FontLigatureInfo[] = []
  const seen = new Set<string>()
  for (const l of found) {
    if (!l || !Array.isArray(l.sub) || typeof l.by !== 'number') continue
    const subNames = l.sub.map((id: number) => String((font.glyphs.get(id) || {}).name || ''))
    const byGlyph = font.glyphs.get(l.by) || {}
    const byName = String(byGlyph.name || '')
    const typeable =
      subNames.length > 1 && subNames.every((n) => n.length === 1 && n >= ' ' && n <= '~')
    const text = typeable ? subNames.join('') : ''
    const label = text || byName || `#${l.by}`
    const key = `${label}|${l.by}`
    if (seen.has(key)) continue
    seen.add(key)
    const cp = typeof byGlyph.unicode === 'number' ? byGlyph.unicode : null
    out.push({ label, text, cp, cpText: cp === null ? '' : hex(cp) })
  }
  return out
}

/**
 * 解析一个字体文件。抛错意味着「读不出字形表」——woff2、损坏文件、非字体文件，
 * 也可能是真的不支持（ttc 字体集合）。调用方据此决定是报错还是降级。
 */
export function analyzeFontFile(input: Uint8Array | ArrayBuffer): FontFileAnalysis {
  const format = sniffFormat(input)
  if (format === 'other') throw new Error('开头没有字体签名，不像字体文件')
  if (format === 'woff2') throw new Error('WOFF2 用 Brotli 压缩，这里读不出字形列表')

  const font: any = opentype.parse(toArrayBuffer(input instanceof Uint8Array ? input : new Uint8Array(input)))

  const glyphs: FontGlyphInfo[] = []
  let puaCount = 0
  let withOutline = 0
  for (let i = 0; i < font.glyphs.length; i++) {
    const g = font.glyphs.get(i)
    const cp = glyphCodepoint(g)
    if (cp === null) continue
    let hasOutline = false
    try {
      hasOutline = g.getPath(0, 0, 1000).commands.length > 0
    } catch {
      /* 单个字形坏掉不该拖垮整份列表 */
    }
    const pua = isPua(cp)
    if (pua) puaCount++
    if (hasOutline) withOutline++
    const name = String(g.name ?? '')
    glyphs.push({ index: i, cp, cpText: hex(cp), name: name === '.notdef' ? '' : name, pua, hasOutline })
  }
  glyphs.sort((a, b) => a.cp - b.cp)

  return {
    format,
    familyName: englishName(font, 'fontFamily'),
    styleName: englishName(font, 'fontSubfamily'),
    version: englishName(font, 'version'),
    unitsPerEm: font.unitsPerEm || 1000,
    ascend: font.ascender,
    descend: font.descender,
    glyphTotal: font.glyphs.length,
    glyphs,
    puaCount,
    withOutline,
    blankCount: glyphs.length - withOutline,
    ligatures: extractLigatures(font),
  }
}
