import { useEffect, useMemo, useRef, useState } from 'react'
import { bboxOf, parsePath } from './lib/svgPath'
import { svgToFillPath } from './lib/svgOutline'
import { tracePng, svgToCombinedD } from './lib/tracePng'
import { buildAndZip, buildFont, resolveFontMeta, sanitizeName, DEFAULT_STYLE_NAME, DEFAULT_VERSION } from './lib/buildFont'
import { checkLatestRelease, isNewer } from './lib/update'
import { openExternal } from './lib/openExternal'
import { isFontFaceSupported, nextPreviewFamily, registerPreviewFont, type PreviewFont } from './lib/previewFont'
import {
  analyzeFontFile,
  sniffFormat,
  isFontFileName,
  FORMAT_LABEL,
  FONT_ACCEPT,
  type FontFileAnalysis,
} from './lib/fontFile'
import { copyText } from './lib/clipboard'
import { RELEASES_URL, REPO_URL, WEBSITE_URL, VERSION } from './config'
import type { GlyphInput, FontMeta } from './lib/types'

interface IconItem {
  id: string
  name: string
  source: string
  kind: 'svg' | 'png'
  d: string
}

const DEFAULT_FAMILY = 'iconbake'
const DEFAULT_START = 'E001'
const DRAFT_KEY = 'iconbake-draft'
const PROJECT_FORMAT = 'iconbake-project'

/** 字体 name 表里可自定义的字段（顺序即表单顺序）。 */
const META_KEYS = [
  'styleName',
  'version',
  'copyright',
  'designer',
  'designerURL',
  'manufacturer',
  'manufacturerURL',
  'license',
  'licenseURL',
  'description',
] as const

/** 界面上的默认值：留空时构建器也会用同样的默认，这里填上是为了让用户看得见。 */
const DEFAULT_FONT_META: FontMeta = { styleName: DEFAULT_STYLE_NAME, version: DEFAULT_VERSION }

const EMPTY_META: FontMeta = { ...DEFAULT_FONT_META }

function pickFontMeta(v: any): FontMeta {
  const out: FontMeta = { ...DEFAULT_FONT_META }
  if (!v || typeof v !== 'object') return out
  for (const k of META_KEYS) {
    const s = v[k]
    out[k] = typeof s === 'string' ? s : ''
  }
  return out
}

/* ----------------------------------------------------------- project files */

interface ProjectData {
  family: string
  startCp: string
  icons: IconItem[]
  fontMeta: FontMeta
}

interface ProjectFile {
  format: string
  version: number
  family: string
  startCodepoint: number
  icons: Array<{ name: string; source: string; kind: 'svg' | 'png'; d: string }>
  fontMeta?: FontMeta
  savedAt?: string
}

/** Codepoint text -> number. Accepts "E001", "0xe001", "u+E001". */
function parseCodepoint(input: string): number | null {
  const m = /^\s*(?:0x|u\+)?([0-9a-fA-F]{1,6})\s*$/.exec(input)
  if (!m) return null
  const n = parseInt(m[1], 16)
  if (!isFinite(n) || n < 0x20 || n > 0x10ffff) return null
  return n
}

function formatCodepoint(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0')
}

/** 一个码位 = 一个字形，画出来就是这个字符。 */
function charOf(cp: number): string {
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** 预览字号档位（px）。 */
const PREVIEW_SIZES = [16, 24, 32, 48] as const

/** 右侧画布的标签页定义；顺序即渲染顺序。 */
const TABS: { id: Tab; label: string }[] = [
  { id: 'preview', label: '预览' },
  { id: 'info', label: '字体信息' },
  { id: 'file', label: '字体文件预览' },
]

let draftCache: ProjectData | null | undefined

function readDraft(): ProjectData | null {
  if (draftCache !== undefined) return draftCache
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return (draftCache = null)
    const d = JSON.parse(raw)
    if (!d || !Array.isArray(d.icons)) return (draftCache = null)
    const icons: IconItem[] = d.icons
      .filter((i: any) => i && typeof i.d === 'string' && typeof i.name === 'string')
      .map((i: any) => ({
        id: i.id || crypto.randomUUID(),
        name: i.name,
        source: i.source || '',
        kind: i.kind === 'png' ? 'png' : 'svg',
        d: i.d,
      }))
    draftCache = {
      family: typeof d.family === 'string' && d.family ? d.family : DEFAULT_FAMILY,
      startCp: typeof d.startCp === 'string' && d.startCp ? d.startCp : DEFAULT_START,
      icons,
      fontMeta: pickFontMeta(d.fontMeta),
    }
  } catch {
    draftCache = null
  }
  return draftCache
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/* -------------------------------------------------------------------- view */

function Preview({ d }: { d: string }) {
  const vb = useMemo(() => {
    try {
      const bb = bboxOf(parsePath(d))
      if (!isFinite(bb.minX)) return '0 0 1000 1000'
      const p = 8
      return `${bb.minX - p} ${bb.minY - p} ${bb.w + p * 2} ${bb.h + p * 2}`
    } catch {
      return '0 0 1000 1000'
    }
  }, [d])
  return (
    <svg viewBox={vb} className="preview" preserveAspectRatio="xMidYMid meet">
      <path d={d} fill="currentColor" />
    </svg>
  )
}

/** 把 fromId 这张卡片移到 targetId 所在的位置（顺序即码位顺序）。 */
function moveItem<T extends { id: string }>(list: T[], fromId: string, targetId: string): T[] {
  const a = list.findIndex((i) => i.id === fromId)
  const b = list.findIndex((i) => i.id === targetId)
  if (a < 0 || b < 0 || a === b) return list
  const next = list.slice()
  const [item] = next.splice(a, 1)
  next.splice(b, 0, item)
  return next
}

/**
 * 拖拽排序的命中测试：返回指针下方（或几何上最近）的另一张卡片的 id。
 * 落在卡片间隙或列表空白时用矩形距离兜底，避免“拖到缝里就没反应”。
 */
function hitTestCard(x: number, y: number, selfId: string): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const direct = el?.closest?.('li[data-id]') as HTMLElement | null
  const directId = direct?.dataset.id ?? null
  if (directId && directId !== selfId) return directId

  let bestId: string | null = null
  let bestDist = Infinity
  document.querySelectorAll<HTMLElement>('.list > li[data-id]').forEach((li) => {
    const r = li.getBoundingClientRect()
    const dx = Math.max(r.left - x, 0, x - r.right)
    const dy = Math.max(r.top - y, 0, y - r.bottom)
    const dist = Math.hypot(dx, dy)
    const id = li.dataset.id
    if (id && id !== selfId && dist < bestDist) {
      bestDist = dist
      bestId = id
    }
  })
  return bestId
}

/* ------------------------------------------------------------ font preview */

/** 已就绪的字体渲染出来的一个字符；未就绪时用占位块，避免闪一堆豆腐块。 */
function GlyphChar({ char, ready, size }: { char: string; ready: boolean; size?: number }) {
  if (!ready) return <span className="glyph-skeleton" aria-hidden="true" />
  return (
    <span className="glyph-char" style={size ? { fontSize: `${size}px` } : undefined}>
      {char}
    </span>
  )
}

/**
 * 「字体预览」：真的把待生成的字体构建一遍，注册成浏览器字体再渲染。
 * 列表里的缩略图画的是原始路径，看不出字体的实际效果（缩放、居中、基线、
 * 度量），这里用的是同一个 `buildFont`，所以看到的就是安装后的样子。
 */
function FontPreviewPanel({
  icons,
  family,
  startValue,
  fontMeta,
}: {
  icons: IconItem[]
  family: string
  startValue: number | null
  fontMeta: FontMeta
}) {
  const [size, setSize] = useState<number>(32)
  const [ready, setReady] = useState('')
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const [copied, setCopied] = useState('')
  const handleRef = useRef<PreviewFont | null>(null)

  const inputs = useMemo<GlyphInput[]>(
    () => icons.map((i) => ({ name: i.name, d: i.d, source: i.source })),
    [icons]
  )

  const glyphs = useMemo(() => {
    if (startValue === null) return []
    const f = family || DEFAULT_FAMILY
    return icons.map((i, idx) => {
      const cp = startValue + idx
      return {
        id: i.id,
        char: charOf(cp),
        cls: `${f}-${sanitizeName(i.name)}`,
        cpText: `0x${formatCodepoint(cp)}`,
      }
    })
  }, [icons, family, startValue])

  // 重建字体：改写一次输入就重跑一遍 buildFont（同步、纯 JS），因此防抖。
  // 面板常驻（标签页切走只是 hidden，不卸载），所以字体只构建一次，
  // 重新切回预览不会闪骨架；码位/字体名变了才重建。
  useEffect(() => {
    if (inputs.length === 0 || startValue === null) return
    if (!isFontFaceSupported()) {
      setFail('当前环境不支持字体渲染预览，可改用列表里的原图缩略图')
      return
    }
    let cancelled = false
    setBusy(true)
    const timer = setTimeout(() => {
      try {
        const { ttf } = buildFont(inputs, {
          family: family || DEFAULT_FAMILY,
          startCodepoint: startValue,
          meta: fontMeta,
        })
        registerPreviewFont(nextPreviewFamily(), ttf)
          .then((h) => {
            if (cancelled) {
              h.dispose() // 已被下一次重建取代
              return
            }
            handleRef.current?.dispose()
            handleRef.current = h
            setReady(h.family)
            setFail('')
            setBusy(false)
          })
          .catch((e: Error) => {
            if (cancelled) return
            setFail(`字体注册失败：${e.message}`)
            setBusy(false)
          })
      } catch (e) {
        if (cancelled) return
        setFail(`字体生成失败：${(e as Error).message}`)
        setBusy(false)
      }
    }, 320)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [inputs, family, startValue, fontMeta])

  useEffect(
    () => () => {
      handleRef.current?.dispose()
      handleRef.current = null
    },
    []
  )

  async function copyAll() {
    const ok = await copyText(glyphs.map((g) => g.char).join(''))
    setCopied(ok ? `已复制 ${glyphs.length} 个字符` : '复制失败，请手动选择字符')
    setTimeout(() => setCopied(''), 2400)
  }

  const fontStack = ready ? `"${ready}", sans-serif` : undefined
  const inline = glyphs.slice(0, 4)

  return (
    <section className="fontpreview">
      <div className="panel__head">
        <span className="fontpreview__title">
          字体预览
          <span className="fontpreview__badge">实时</span>
        </span>
        <span className="fontpreview__sub">
          用真实构建出来的字体渲染 —— 与安装后的效果一致，可换字号、可复制字符
        </span>
      </div>
      <div className="fontpreview__body">
        {fail ? (
          <div className="fontpreview__fail">{fail}</div>
        ) : icons.length === 0 ? (
          <div className="fontpreview__fail">先添加图标，这里会显示它们作为字体的真实渲染效果</div>
        ) : (
          <>
            <div className="fontpreview__bar">
              <div className="fontpreview__sizes" role="group" aria-label="预览字号">
                <span className="fontpreview__bar-label">字号</span>
                {PREVIEW_SIZES.map((s) => (
                  <button
                    key={s}
                    className={`chip ${size === s ? 'chip--on' : ''}`}
                    onClick={() => setSize(s)}
                    title={`${s}px`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="fontpreview__bar-right">
                {busy && <span className="fontpreview__status">正在构建字体…</span>}
                <button className="ghost ghost--sm" onClick={copyAll} disabled={!ready}>
                  复制全部字符
                </button>
                <span className="fontpreview__status">{copied}</span>
              </div>
            </div>

            <div className="fontpreview__grid" style={{ fontFamily: fontStack }}>
              {glyphs.map((g) => (
                <figure className="glyph" key={g.id}>
                  <div className="glyph__box">
                    <GlyphChar char={g.char} ready={!!ready} size={size} />
                  </div>
                  <figcaption>
                    <span className="glyph__name" title={g.cls}>
                      {g.cls}
                    </span>
                    <code className="glyph__cp">{g.cpText}</code>
                  </figcaption>
                </figure>
              ))}
            </div>

            <div className="fontpreview__inline">
              <span className="fontpreview__bar-label">排进文字里</span>
              <p className="fontpreview__text" style={{ fontFamily: fontStack }}>
                {inline.map((g) => (
                  <GlyphChar key={g.id} char={g.char} ready={!!ready} />
                ))}
                图标会跟随字号与文字颜色，和旁边的中英文保持同一基线。
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------- 字体文件预览（外部） */

/** 一次最多渲染多少个字形格，超出用「显示更多」翻页。 */
const FILE_GLYPH_PAGE = 240

/**
 * 「字体文件预览」：读一个磁盘上的字体文件，把里面的图标字形列出来。
 * 用途有两个 —— 看别人的图标字体里有什么，以及核对自己刚导出的字体。
 * 与上面的「字体预览」不同：那个是构建途中即时生成的字体，这个是现成文件。
 */
function FontFilePanel() {
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const [note, setNote] = useState('')
  const [fileName, setFileName] = useState('')
  const [analysis, setAnalysis] = useState<FontFileAnalysis | null>(null)
  const [family, setFamily] = useState('')
  const [scope, setScope] = useState<'pua' | 'all'>('pua')
  const [query, setQuery] = useState('')
  const [size, setSize] = useState<number>(32)
  const [limit, setLimit] = useState(FILE_GLYPH_PAGE)
  const [sample, setSample] = useState('')
  const [status, setStatus] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const handleRef = useRef<PreviewFont | null>(null)

  useEffect(
    () => () => {
      handleRef.current?.dispose()
      handleRef.current = null
    },
    []
  )

  function reset() {
    handleRef.current?.dispose()
    handleRef.current = null
    setFamily('')
    setAnalysis(null)
    setFileName('')
    setFail('')
    setNote('')
    setQuery('')
    setSample('')
    setStatus('')
    setLimit(FILE_GLYPH_PAGE)
  }

  async function load(file: File) {
    if (!isFontFileName(file.name)) {
      setFail(`"${file.name}" 不是字体文件，支持 .ttf / .otf / .woff / .woff2`)
      return
    }
    // 先把上一个卸掉，别让两个预览字体同时挂着
    handleRef.current?.dispose()
    handleRef.current = null
    setFamily('')
    setBusy(true)
    setFail('')
    setNote('')
    setStatus('')
    setAnalysis(null)
    setQuery('')
    setSample('')
    setLimit(FILE_GLYPH_PAGE)
    setFileName(file.name)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const format = sniffFormat(bytes)

      // 开头就不是字体签名，别往下走 —— 否则会拿一段垃圾去注册字体，
      // 报出来的错也会变成「解析失败但仍可试排」这种误导性提示。
      if (format === 'other') {
        setFail(`"${file.name}" 看起来不是字体文件（开头没有字体签名）`)
        return
      }

      let a: FontFileAnalysis | null = null
      let parseError = ''
      try {
        a = analyzeFontFile(bytes)
      } catch (e) {
        parseError = (e as Error).message
      }

      // 读不出字形表也可能只是 woff2 —— 浏览器照样能渲染它，此时降级成「只能试排文字」
      let registered = ''
      if (isFontFaceSupported()) {
        try {
          const h = await registerPreviewFont(nextPreviewFamily('IconBakeFile'), bytes)
          handleRef.current = h
          registered = h.family
          setFamily(h.family)
        } catch {
          /* 解析与注册都失败时，下面一起给提示 */
        }
      }

      if (!a && !registered) {
        setFail(`读不出这个文件：${parseError || '不是可识别的字体'}`)
        return
      }
      if (a) {
        setAnalysis(a)
        setScope(a.puaCount > 0 ? 'pua' : 'all')
        setSample(
          a.glyphs
            .filter((g) => g.hasOutline)
            .slice(0, 8)
            .map((g) => charOf(g.cp))
            .join('')
        )
      } else if (format === 'woff2') {
        setNote('WOFF2 的字形表用 Brotli 压过，这里读不出图标清单（浏览器渲染不受影响）—— 可以用下面的文本框试排字符。')
      } else {
        setNote(`读不出字形清单：${parseError}。下面的文本框仍可试排字符。`)
      }
    } catch (e) {
      setFail('读取失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) load(f)
    e.target.value = ''
  }

  /** 当前范围 + 搜索词下真正会显示的字形。 */
  const filtered = useMemo(() => {
    if (!analysis) return []
    const q = query.trim().toLowerCase().replace(/^0x/, '')
    return analysis.glyphs.filter((g) => {
      if (!g.hasOutline) return false
      if (scope === 'pua' && !g.pua) return false
      if (!q) return true
      return (
        g.cpText.toLowerCase().includes(q) ||
        g.cpText.toLowerCase().replace(/^0x/, '') === q ||
        g.name.toLowerCase().includes(q) ||
        `#${g.index}` === q
      )
    })
  }, [analysis, scope, query])

  async function copyChars(text: string, label: string) {
    if (!text) return
    const ok = await copyText(text)
    setStatus(ok ? label : '复制失败，请手动选择字符')
    setTimeout(() => setStatus(''), 2400)
  }

  const fontStack = family ? `"${family}", sans-serif` : undefined
  const shown = filtered.slice(0, limit)
  const sampleRow = (
    <div className="fontpreview__inline">
      <span className="fontpreview__bar-label">试排文字</span>
      <input
        className="fontfile__sample"
        style={{ fontFamily: fontStack }}
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        placeholder="在这里敲字符，看它们排成文字的样子"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  )

  return (
    <section className="fontpreview fontfile">
      <div className="panel__head">
        <span className="fontpreview__title">
          字体文件预览
          <span className="fontpreview__badge">外部文件</span>
        </span>
        <span className="fontpreview__sub">
          打开磁盘上的字体文件，看它里面装了哪些图标 —— 也可以用来核对刚导出的字体
        </span>
      </div>
      <div className="fontpreview__body fontfile__body">
        <input ref={fileRef} type="file" accept={FONT_ACCEPT} hidden onChange={onPick} />
        {fileName ? (
          <div className="fontfile__head">
            <code className="fontfile__file" title={fileName}>
              {fileName}
            </code>
            {analysis && <span className="fontfile__fmt">{FORMAT_LABEL[analysis.format]}</span>}
            {busy && <span className="fontpreview__status">正在解析…</span>}
            <div className="fontfile__head-ops">
              <button className="ghost ghost--sm" onClick={() => fileRef.current?.click()}>
                换个文件
              </button>
              <button className="ghost ghost--sm" onClick={reset}>
                移除
              </button>
            </div>
          </div>
        ) : (
          <div
            className={`fontfile__drop ${dragOver ? 'is-over' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer?.files?.[0]
              if (f) load(f)
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7V5a1 1 0 0 1 1-1h5l2 3h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
              <path d="M9 13h6M9 17h4" />
            </svg>
            <strong>选择一个字体文件，或把它拖到这里</strong>
            <span>支持 .ttf / .otf / .woff / .woff2 —— 解析与渲染都在本地完成，不会上传</span>
          </div>
        )}

        {fail && <div className="fontpreview__fail">{fail}</div>}
        {note && <div className="fontpreview__fail">{note}</div>}

        {analysis && (
          <dl className="fontfile__facts">
            <div className="fontfile__fact">
              <dt>字体族</dt>
              <dd title={analysis.familyName}>{analysis.familyName || '（未命名）'}</dd>
            </div>
            <div className="fontfile__fact">
              <dt>样式</dt>
              <dd>{analysis.styleName || '—'}</dd>
            </div>
            <div className="fontfile__fact">
              <dt>版本</dt>
              <dd>{analysis.version || '—'}</dd>
            </div>
            <div className="fontfile__fact">
              <dt>字形</dt>
              <dd>
                {analysis.glyphTotal} 个，{analysis.withOutline} 个有轮廓
                {analysis.blankCount ? `（${analysis.blankCount} 个空白已隐藏）` : ''}
              </dd>
            </div>
            <div className="fontfile__fact">
              <dt>私有区码位</dt>
              <dd>{analysis.puaCount} 个</dd>
            </div>
            <div className="fontfile__fact">
              <dt>em / 上伸 / 下伸</dt>
              <dd>
                {analysis.unitsPerEm} / {analysis.ascend} / {analysis.descend}
              </dd>
            </div>
          </dl>
        )}

        {analysis && family && (
          <>
            <div className="fontpreview__bar">
              <div className="fontpreview__sizes" role="group" aria-label="显示范围">
                <span className="fontpreview__bar-label">范围</span>
                <button
                  className={`chip ${scope === 'pua' ? 'chip--on' : ''}`}
                  onClick={() => {
                    setScope('pua')
                    setLimit(FILE_GLYPH_PAGE)
                  }}
                  title="只显示图标字体常用的私有区码位"
                >
                  私有区 {analysis.puaCount}
                </button>
                <button
                  className={`chip ${scope === 'all' ? 'chip--on' : ''}`}
                  onClick={() => {
                    setScope('all')
                    setLimit(FILE_GLYPH_PAGE)
                  }}
                  title="显示所有带码位的字形"
                >
                  全部 {analysis.withOutline}
                </button>
              </div>
              <div className="fontpreview__bar-right">
                <input
                  className="fontfile__search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setLimit(FILE_GLYPH_PAGE)
                  }}
                  placeholder="搜字形名或码位，如 e700 / home"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="fontpreview__bar">
              <div className="fontpreview__sizes" role="group" aria-label="预览字号">
                <span className="fontpreview__bar-label">字号</span>
                {PREVIEW_SIZES.map((s) => (
                  <button key={s} className={`chip ${size === s ? 'chip--on' : ''}`} onClick={() => setSize(s)} title={`${s}px`}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="fontpreview__bar-right">
                <span className="fontpreview__status">显示 {filtered.length} 个字形</span>
                <button
                  className="ghost ghost--sm"
                  onClick={() =>
                    copyChars(
                      filtered.map((g) => charOf(g.cp)).join(''),
                      `已复制 ${filtered.length} 个字符`
                    )
                  }
                  disabled={!filtered.length}
                >
                  复制全部字符
                </button>
                <span className="fontpreview__status">{status}</span>
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="fontpreview__fail">没有匹配的字形</div>
            ) : (
              <div className="fontpreview__grid" style={{ fontFamily: fontStack }}>
                {shown.map((g) => (
                  <figure className="glyph" key={g.index}>
                    <button
                      className="glyph__box glyph__box--btn"
                      onClick={() => copyChars(charOf(g.cp), `已复制 ${g.cpText} 的字符`)}
                      title={`点击复制这个字符（${g.cpText}）`}
                    >
                      <span className="glyph-char" style={{ fontSize: `${size}px` }}>
                        {charOf(g.cp)}
                      </span>
                    </button>
                    <figcaption>
                      <span className="glyph__name" title={g.name || `字形 #${g.index}`}>
                        {g.name || `#${g.index}`}
                      </span>
                      <code className="glyph__cp">{g.cpText}</code>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}

            {filtered.length > shown.length && (
              <div className="fontfile__more">
                <button className="ghost ghost--sm" onClick={() => setLimit((l) => l + FILE_GLYPH_PAGE)}>
                  显示更多（还有 {filtered.length - shown.length} 个）
                </button>
              </div>
            )}

            {analysis.ligatures.length > 0 && (
              <div className="fontfile__ligs">
                <span className="fontpreview__bar-label">连字 {analysis.ligatures.length}</span>
                {analysis.ligatures.slice(0, 80).map((l) => (
                  <button
                    key={`${l.label}|${l.cpText}`}
                    className="chip"
                    style={{ fontFamily: fontStack }}
                    disabled={!l.text}
                    onClick={() => setSample((s) => s + l.text)}
                    title={l.text ? `插入 “${l.text}”` : '推断不出可敲的文本'}
                  >
                    {l.text || l.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {family && sampleRow}
      </div>
    </section>
  )
}

/* --------------------------------------------- 字体信息（name 表自定义） */

function FontInfoPanel({
  fontMeta,
  setMetaField,
  fontInfo,
  onReset,
}: {
  fontMeta: FontMeta
  setMetaField: (key: keyof FontMeta, value: string) => void
  fontInfo: { fullName: string; postScriptName: string; version: string }
  onReset: () => void
}) {
  return (
    <section className="fontinfo">
      <div className="panel__head">
        <span className="fontinfo__title">
          字体信息
          <span className="fontinfo__badge">可选</span>
        </span>
        <span className="fontinfo__sub">样式名、版本、版权、作者、许可 —— 会写进字体文件，安装后能被系统与设计软件读到</span>
      </div>
      <div className="fontinfo__body">
        <div className="fontinfo__grid">
          <label className="field">
            <span>样式名</span>
            <input
              value={fontMeta.styleName ?? ''}
              onChange={(e) => setMetaField('styleName', e.target.value)}
              placeholder={DEFAULT_STYLE_NAME}
            />
          </label>
          <label className="field">
            <span>版本</span>
            <input
              value={fontMeta.version ?? ''}
              onChange={(e) => setMetaField('version', e.target.value)}
              placeholder={DEFAULT_VERSION}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field field--wide">
            <span>版权</span>
            <input
              value={fontMeta.copyright ?? ''}
              onChange={(e) => setMetaField('copyright', e.target.value)}
              placeholder="© 2026 你的名字"
            />
          </label>
          <label className="field">
            <span>设计者</span>
            <input
              value={fontMeta.designer ?? ''}
              onChange={(e) => setMetaField('designer', e.target.value)}
              placeholder="可选"
            />
          </label>
          <label className="field">
            <span>设计者链接</span>
            <input
              value={fontMeta.designerURL ?? ''}
              onChange={(e) => setMetaField('designerURL', e.target.value)}
              placeholder="https://"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>制造商 / 团队</span>
            <input
              value={fontMeta.manufacturer ?? ''}
              onChange={(e) => setMetaField('manufacturer', e.target.value)}
              placeholder="可选"
            />
          </label>
          <label className="field">
            <span>制造商链接</span>
            <input
              value={fontMeta.manufacturerURL ?? ''}
              onChange={(e) => setMetaField('manufacturerURL', e.target.value)}
              placeholder="https://"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>许可</span>
            <input
              value={fontMeta.license ?? ''}
              onChange={(e) => setMetaField('license', e.target.value)}
              placeholder="如 MIT / SIL OFL 1.1"
            />
          </label>
          <label className="field">
            <span>许可链接</span>
            <input
              value={fontMeta.licenseURL ?? ''}
              onChange={(e) => setMetaField('licenseURL', e.target.value)}
              placeholder="https://"
              spellCheck={false}
            />
          </label>
          <label className="field field--wide">
            <span>描述</span>
            <input
              value={fontMeta.description ?? ''}
              onChange={(e) => setMetaField('description', e.target.value)}
              placeholder="一句话说明这套图标（可选）"
            />
          </label>
        </div>

        <div className="fontinfo__derived">
          <div className="fontinfo__derived-label">实际写入字体文件的记录</div>
          <div className="fontinfo__derived-list">
            <code>完整名称 · {fontInfo.fullName}</code>
            <code>PostScript 名 · {fontInfo.postScriptName}</code>
            <code>{fontInfo.version}</code>
          </div>
          <button
            className="ghost ghost--sm"
            onClick={onReset}
            title="把上面的字段恢复为默认值"
          >
            重置
          </button>
        </div>
      </div>
    </section>
  )
}

/* --------------------------------------------------------------------- App */
type Tab = 'preview' | 'info' | 'file'

export default function App() {
  const draft = readDraft()
  const [icons, setIcons] = useState<IconItem[]>(() => draft?.icons ?? [])
  const [family, setFamily] = useState(() => draft?.family ?? DEFAULT_FAMILY)
  const [startCp, setStartCp] = useState(() => draft?.startCp ?? DEFAULT_START)
  const [fontMeta, setFontMeta] = useState<FontMeta>(() => draft?.fontMeta ?? { ...EMPTY_META })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('preview')
  const [update, setUpdate] = useState<{ status: 'idle' | 'checking' | 'ok' | 'new' | 'error'; text: string; url?: string }>({
    status: 'idle',
    text: '',
  })
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const saved = localStorage.getItem('iconbake-theme')
    if (saved === 'dark' || saved === 'light') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const projectRef = useRef<HTMLInputElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return 316
    const saved = localStorage.getItem('iconbake-sidebar-width')
    const n = saved ? parseInt(saved, 10) : NaN
    return isFinite(n) && n >= 220 && n <= 600 ? n : 316
  })
  const resizeDrag = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null)

  const startValue = parseCodepoint(startCp)
  const cpBad = startValue === null

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('iconbake-theme', theme)
  }, [theme])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (!localStorage.getItem('iconbake-theme')) {
        setTheme(mq.matches ? 'dark' : 'light')
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Auto-stash the working set so a refresh / accidental close doesn't lose it.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ family, startCp, icons, fontMeta }))
        draftCache = { family, startCp, icons, fontMeta }
      } catch {
        /* quota — the explicit "保存项目" file is the real safety net */
      }
    }, 300)
    return () => clearTimeout(t)
  }, [icons, family, startCp, fontMeta])

  function setMetaField(key: keyof FontMeta, value: string) {
    setFontMeta((prev) => ({ ...prev, [key]: value }))
  }

  function toggleTheme() {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'))
  }

  useEffect(() => {
    localStorage.setItem('iconbake-sidebar-width', String(sidebarWidth))
  }, [sidebarWidth])

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    resizeDrag.current = { startX: e.clientX, startWidth: sidebarWidth, lastWidth: sidebarWidth }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 浏览器不支持指针捕获时，resizer 本身很小，靠 onPointerMove 也基本够用 */
    }
  }

  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeDrag.current) return
    const dx = e.clientX - resizeDrag.current.startX
    const next = Math.min(600, Math.max(220, resizeDrag.current.startWidth + dx))
    // 直接改 DOM 上的 CSS 变量，避免每次鼠标移动都重渲染整棵组件树（图标多了会卡）
    resizeDrag.current.lastWidth = next
    layoutRef.current?.style.setProperty('--sidebar-width', `${next}px`)
  }

  function endResize() {
    // 松手时才提交到 state：持久化到 localStorage + 触发一次重渲染对齐
    if (resizeDrag.current) setSidebarWidth(resizeDrag.current.lastWidth)
    resizeDrag.current = null
  }

  /** 标签页支持 ← / → 方向键切换（WAI-ARIA tabs 模式）。 */
  function onTabKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const idx = TABS.findIndex((t) => t.id === activeTab)
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = TABS[(idx + dir + TABS.length) % TABS.length]
    setActiveTab(next.id)
    document.getElementById(`tab-${next.id}`)?.focus()
  }

  async function addFiles(files: FileList | File[]) {
    setError('')
    const list = Array.from(files)
    let strokeShapes = 0
    let added = 0
    for (const file of list) {
      const lower = file.name.toLowerCase()
      const base = file.name.replace(/\.[^.]+$/, '')
      try {
        if (lower.endsWith('.svg')) {
          const text = await file.text()
          // Stroke-drawn icons (Lucide / Feather / Tabler) are expanded into real
          // outlines here — feeding the raw `d` to the font builder would fill the
          // stroke's center line instead of the stroke itself.
          const { d, stats } = svgToFillPath(text)
          if (!d.trim()) {
            setError(`"${file.name}" 里没有可识别的图形`)
            continue
          }
          strokeShapes += stats.strokeShapes
          pushIcon({ name: base, source: file.name, kind: 'svg', d })
          added++
        } else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
          setLog(`正在矢量化 ${file.name} …`)
          const svg = await tracePng(file)
          const d = svgToCombinedD(svg)
          if (!d.trim()) {
            setError(`"${file.name}" 矢量化失败（可能是空白图片）`)
            continue
          }
          pushIcon({ name: base, source: file.name, kind: 'png', d })
          added++
          setLog('')
        } else {
          setError(`不支持的文件类型：${file.name}`)
        }
      } catch (e) {
        setError(`处理 ${file.name} 出错：${(e as Error).message}`)
      }
    }
    if (added && strokeShapes) {
      setLog(`已添加 ${added} 个图标，其中 ${strokeShapes} 个描边图形已展开为轮廓`)
    } else if (added) {
      setLog(`已添加 ${added} 个图标`)
    }
  }

  function pushIcon(p: Omit<IconItem, 'id'>) {
    setIcons((prev) => [...prev, { ...p, id: crypto.randomUUID() }])
  }

  function rename(id: string, name: string) {
    setIcons((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)))
  }

  function remove(id: string) {
    setIcons((prev) => prev.filter((i) => i.id !== id))
  }

  /** Shift one icon by `delta` positions (ordering drives the codepoint assignment). */
  function move(id: string, delta: number) {
    setIcons((prev) => {
      const from = prev.findIndex((i) => i.id === id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= prev.length) return prev
      const next = prev.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  // ---- 卡片拖拽排序：用指针事件自己实现 ----------------------------------
  // 不用 HTML5 drag & drop —— 桌面端 Tauri 会在窗口层面接管拖放，webview 里连
  // dragstart 都不会触发（官方文档：fileDropEnabled 需置 false 前端才能用 DnD），
  // 卡片就“拖不动”。指针事件在浏览器与 Tauri 中行为一致，也便于用真实鼠标事件验证。
  // 监听挂在 window 上：指针移到别的卡片上方时事件目标会变，挂在卡片上会中断拖拽。
  const dragRef = useRef<{ id: string; x0: number; y0: number; active: boolean; over: string | null } | null>(null)

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current
      if (!d) return
      if (!d.active) {
        // 超过阈值才算拖拽，避免和“点一下”抢事件
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return
        d.active = true
        setDragId(d.id)
      }
      const over = hitTestCard(e.clientX, e.clientY, d.id)
      if (over !== d.over) {
        d.over = over
        setOverId(over)
      }
    }

    function onUp() {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      setDragId(null)
      setOverId(null)
      if (d.active && d.over) setIcons((prev) => moveItem(prev, d.id, d.over as string))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  function cardPointerDown(e: React.PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0) return
    e.preventDefault() // 阻止原生图片拖拽 / 选文字干扰指针事件
    dragRef.current = { id, x0: e.clientX, y0: e.clientY, active: false, over: null }
    try {
      // 指针捕获让指针移出卡片/窗口后仍能收到 up 事件（监听在 window 上，属双保险）
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 不支持指针捕获时，window 监听仍能兜住 */
    }
  }

  function saveProject() {
    const data: ProjectFile = {
      format: PROJECT_FORMAT,
      version: 1,
      family,
      startCodepoint: startValue ?? 0xe001,
      icons: icons.map(({ name, source, kind, d }) => ({ name, source, kind, d })),
      fontMeta,
      savedAt: new Date().toISOString(),
    }
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${family || DEFAULT_FAMILY}.iconbake.json`)
    setLog(`项目已保存：${family || DEFAULT_FAMILY}.iconbake.json（${icons.length} 个图标）`)
  }

  async function openProject(file: File) {
    setError('')
    try {
      const data = JSON.parse(await file.text())
      if (!data || data.format !== PROJECT_FORMAT || !Array.isArray(data.icons)) {
        setError('这不是 IconBake 项目文件（缺少 format 标记）')
        return
      }
      const loaded: IconItem[] = data.icons
        .filter((i: any) => i && typeof i.d === 'string')
        .map((i: any) => ({
          id: crypto.randomUUID(),
          name: String(i.name ?? 'icon'),
          source: String(i.source ?? ''),
          kind: i.kind === 'png' ? 'png' : 'svg',
          d: i.d,
        }))
      setIcons(loaded)
      if (typeof data.family === 'string' && data.family) setFamily(data.family)
      // 旧项目文件没有 fontMeta 字段 —— 保留当前填写的内容，不要清空。
      if (data.fontMeta && typeof data.fontMeta === 'object') setFontMeta(pickFontMeta(data.fontMeta))
      if (typeof data.startCodepoint === 'number' && data.startCodepoint > 0) {
        setStartCp(formatCodepoint(data.startCodepoint))
      }
      setLog(`已打开项目：${data.family ?? DEFAULT_FAMILY} · ${loaded.length} 个图标`)
    } catch (e) {
      setError('项目文件读取失败：' + (e as Error).message)
    }
  }

  function clearAll() {
    setIcons([])
    setError('')
    setLog('列表已清空')
  }

  async function bake() {
    if (icons.length === 0) {
      setError('先添加至少一个图标')
      return
    }
    if (startValue === null) {
      setError('起始码位格式不对，示例：E001')
      return
    }
    setBusy(true)
    setError('')
    setLog('正在生成字体…')
    try {
      const inputs: GlyphInput[] = icons.map((i) => ({ name: i.name, d: i.d, source: i.source }))
      const name = family || DEFAULT_FAMILY
      const { zip, result } = await buildAndZip(inputs, {
        family: name,
        startCodepoint: startValue,
        meta: fontMeta,
      })
      download(zip, `${name}.zip`)
      const last = result.meta[result.meta.length - 1]
      setLog(`完成：${result.meta.length} 个图标 → ${name}.zip（码位 0x${result.meta[0].unicode} – 0x${last.unicode}）`)
    } catch (e) {
      setError('生成失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function checkUpdate() {
    setUpdate({ status: 'checking', text: '检查中…' })
    try {
      const latest = await checkLatestRelease()
      if (isNewer(VERSION, latest.version)) {
        setUpdate({ status: 'new', text: `发现新版 v${latest.version}`, url: latest.htmlUrl || RELEASES_URL })
      } else {
        setUpdate({ status: 'ok', text: `当前 v${VERSION} 已是最新` })
      }
    } catch (e) {
      setUpdate({ status: 'error', text: '检查失败：' + (e as Error).message })
    }
  }

  const rangeEnd = startValue !== null && icons.length ? startValue + icons.length - 1 : null
  /** 实时预览这些字段最终会写成什么（含派生出来的完整名 / PostScript 名）。 */
  const fontInfo = useMemo(() => resolveFontMeta(family || DEFAULT_FAMILY, fontMeta), [family, fontMeta])

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <div className="logo logo--sm">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" aria-hidden="true" />
          </div>
          <div>
            <h1>IconBake</h1>
            <span className="topbar__tag">纯前端 · 本地处理 · 不上传</span>
          </div>
        </div>
        <div className="topbar__actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button className="ghost" onClick={saveProject} disabled={icons.length === 0} title="把当前图标与设置保存为 .iconbake.json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            保存项目
          </button>
          <button className="ghost" onClick={() => projectRef.current?.click()} title="打开之前保存的 .iconbake.json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            打开
          </button>
          <input
            ref={projectRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) openProject(f)
              e.target.value = ''
            }}
          />
          <button className="bake" onClick={bake} disabled={busy || icons.length === 0}>
            {busy ? (
              <span className="spinner" />
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
                烘焙并下载
              </>
            )}
            <span className="count">{icons.length}</span>
          </button>
        </div>
      </header>

      <div className="layout" ref={layoutRef} style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
        <aside className="sidebar">
          <section
            className={`drop drop--compact ${dragOver ? 'drop--active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files)
            }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".svg,.png,.jpg,.jpeg"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="drop__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <strong>添加图标</strong>
            <span>拖拽图片进来，或点击选择</span>
          </section>

          {error && <div className="alert alert--error">{error}</div>}
          {log && <div className="alert alert--info">{log}</div>}

          {icons.length === 0 ? (
            <div className="empty">
              <div className="empty__icon">🍳</div>
              <p>还没有图标</p>
              <span>拖几张 SVG / PNG 进来，开始烘焙你的图标字体吧</span>
            </div>
          ) : (
            <>
              <div className="listbar">
                <span className="listbar__hint">拖动卡片、或点 ← → 调整顺序 —— 顺序决定码位</span>
                <button className="ghost ghost--sm" onClick={clearAll}>
                  清空
                </button>
              </div>
              <ul className="list">
                {icons.map((i, idx) => (
                  <li
                    key={i.id}
                    data-id={i.id}
                    className={`${dragId === i.id ? 'is-drag' : ''} ${overId === i.id && dragId !== i.id ? 'is-over' : ''}`}
                  >
                    <div
                      className="card__preview"
                      onPointerDown={(e) => cardPointerDown(e, i.id)}
                      title="按住拖动调整顺序"
                    >
                      <Preview d={i.d} />
                      <span className="card__no">{idx + 1}</span>
                    </div>
                    <input className="card__name" value={i.name} onChange={(e) => rename(i.id, e.target.value)} />
                    <div className="card__meta">
                      <span className={`tag tag--${i.kind}`}>{i.kind.toUpperCase()}</span>
                      <div className="card__ops">
                        <button onClick={() => move(i.id, -1)} disabled={idx === 0} title="前移">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                          </svg>
                        </button>
                        <button onClick={() => move(i.id, 1)} disabled={idx === icons.length - 1} title="后移">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
                        <button className="card__del" onClick={() => remove(i.id)} title="移除">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <code className="card__cp">
                      {startValue !== null ? `0x${formatCodepoint(startValue + idx)}` : '—'}
                    </code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <div
          className="resizer"
          onPointerDown={startResize}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          title="左右拖动调整面板宽度"
        >
          <div className="resizer__handle" />
        </div>

        <main className="canvas">
          <section className="card settings">
            <div className="field">
              <span>字体名</span>
              <input value={family} onChange={(e) => setFamily(e.target.value)} placeholder={DEFAULT_FAMILY} />
            </div>
            <div className={`field field--cp ${cpBad ? 'field--bad' : ''}`}>
              <span>起始码位</span>
              <input
                value={startCp}
                onChange={(e) => setStartCp(e.target.value)}
                placeholder={DEFAULT_START}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="field field--range">
              <span>码位范围</span>
              <div className="field__value">
                {startValue !== null && rangeEnd !== null
                  ? `0x${formatCodepoint(startValue)} – 0x${formatCodepoint(rangeEnd)}`
                  : '—'}
              </div>
            </div>
          </section>

          <div className="tabs">
            <div className="tabs__bar" role="tablist" aria-label="图标字体视图" onKeyDown={onTabKey}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  role="tab"
                  aria-selected={activeTab === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={activeTab === t.id ? 0 : -1}
                  className={`tab ${activeTab === t.id ? 'tab--on' : ''}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="tab-panel" id="panel-preview" role="tabpanel" aria-labelledby="tab-preview" hidden={activeTab !== 'preview'}>
              <FontPreviewPanel icons={icons} family={family} startValue={startValue} fontMeta={fontMeta} />
            </div>
            <div className="tab-panel" id="panel-info" role="tabpanel" aria-labelledby="tab-info" hidden={activeTab !== 'info'}>
              <FontInfoPanel
                fontMeta={fontMeta}
                setMetaField={setMetaField}
                fontInfo={fontInfo}
                onReset={() => setFontMeta({ ...EMPTY_META })}
              />
            </div>
            <div className="tab-panel" id="panel-file" role="tabpanel" aria-labelledby="tab-file" hidden={activeTab !== 'file'}>
              <FontFilePanel />
            </div>
          </div>

          <footer className="footer">
            <div className="footer__links">
              <button className="link" onClick={() => openExternal(REPO_URL)}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
                </svg>
                GitHub 开源
              </button>
              <button className="link" onClick={() => openExternal(WEBSITE_URL)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                官网
              </button>
            </div>

            <div className="footer__version">
              <span>v{VERSION}</span>
              <button
                className={`update update--${update.status}`}
                onClick={checkUpdate}
                disabled={update.status === 'checking'}
                title={update.status === 'new' && update.url ? '去下载新版' : '检查更新'}
              >
                {update.status === 'idle' && '检查更新'}
                {update.status === 'checking' && (
                  <>
                    <span className="spinner spinner--sm" />
                    检查中
                  </>
                )}
                {update.status === 'ok' && update.text}
                {update.status === 'error' && update.text}
                {update.status === 'new' && (
                  <>
                    {update.text}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </>
                )}
              </button>
              {update.status === 'new' && update.url && (
                <button className="link link--small" onClick={() => openExternal(update.url!)}>
                  去下载
                </button>
              )}
            </div>
          </footer>
        </main>
      </div>
    </div>
  )
}
