// pack.ts
// Generate the companion assets (CSS, demo HTML, JSON) and a downloadable .zip.
import JSZip from 'jszip'
import type { GlyphMeta } from './types'

/** `@font-face` 声明。`src` 为 CSS 的 src 列表（文件引用或 data URI）。 */
function fontFaceRules(family: string, src: string): string[] {
  return [
    `@font-face {`,
    `  font-family: '${family}';`,
    `  src: ${src};`,
    `  font-weight: normal;`,
    `  font-style: normal;`,
    `  font-display: block;`,
    `}`,
  ]
}

/** 引用同目录字体文件的 src（用于 .css 文件）。 */
function fileSrc(family: string): string {
  return `url('${family}.woff') format('woff'),\n       url('${family}.ttf') format('truetype')`
}

/** 基础 class + 每个字形的 ::before 取字符规则。CSS 与预览页共用。 */
function glyphRules(family: string, meta: GlyphMeta[]): string[] {
  const L: string[] = []
  L.push(``)
  L.push(`.${family} {`)
  L.push(`  font-family: '${family}' !important;`)
  L.push(`  font-weight: normal;`)
  L.push(`  font-style: normal;`)
  L.push(`  font-variant: normal;`)
  L.push(`  text-rendering: auto;`)
  L.push(`  line-height: 1;`)
  L.push(`  -webkit-font-smoothing: antialiased;`)
  L.push(`}`)
  for (const g of meta) {
    L.push(``)
    L.push(`.${g.cssClass}::before {`)
    L.push(`  content: "\\${g.unicode}";`)
    L.push(`}`)
  }
  return L
}

export function generateCss(family: string, meta: GlyphMeta[]): string {
  return [...fontFaceRules(family, fileSrc(family)), ...glyphRules(family, meta)].join('\n') + '\n'
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(bin)
}

export function generateHtml(family: string, meta: GlyphMeta[], ttf: Uint8Array): string {
  const dataUri = `data:font/ttf;base64,${toBase64(ttf)}`
  const items = meta.map(g => {
    return `    <li><span class="ic ${family} ${g.cssClass}"></span><code>${g.cssClass}</code><code>0x${g.unicode}</code></li>`
  }).join('\n')
  // 预览页必须内联完整的取字符规则（::before content），否则 span 是空的、什么都看不到。
  const rules = [...fontFaceRules(family, `url('${dataUri}') format('truetype')`), ...glyphRules(family, meta)].join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${family} 图标字体预览</title>
<style>
${rules}

  /* 以下仅为预览页样式，与字体本身无关 */
  body { font-family: system-ui, sans-serif; padding: 24px; color: #222; }
  h1 { font-size: 20px; }
  p.hint { color: #666; font-size: 13px; margin-top: -6px; }
  ul { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; padding: 0; }
  li { border: 1px solid #eee; border-radius: 8px; padding: 12px; text-align: center; }
  .ic { font-size: 40px; display: block; margin-bottom: 8px; color: #111; }
  code { display: block; font-size: 11px; color: #888; }
</style>
</head>
<body>
<h1>${family} — 共 ${meta.length} 个图标</h1>
<p class="hint">字体已内嵌在本文件中，单文件即可预览。</p>
<ul>
${items}
</ul>
</body>
</html>
`
}

export function generateJson(family: string, em: number, meta: GlyphMeta[]): string {
  const icons = meta.map(g => ({
    name: g.name,
    cssClass: g.cssClass,
    codepoint: g.codepoint,
    unicode: '0x' + g.unicode,
  }))
  return JSON.stringify({ family, em, icons }, null, 2) + '\n'
}

export async function packageZip(
  family: string,
  meta: GlyphMeta[],
  em: number,
  ttf: Uint8Array,
  woff: Uint8Array,
  css: string,
  html: string,
  json: string
): Promise<Blob> {
  const zip = new JSZip()
  zip.file(`${family}.css`, css)
  zip.file(`${family}.html`, html)
  zip.file(`${family}.json`, json)
  zip.file(`${family}.ttf`, ttf)
  zip.file(`${family}.woff`, woff)
  const first = meta[0]
  const readme = `# ${family}

由 IconBake 生成 —— 把图片烘焙成图标字体。

共 **${meta.length}** 个图标，码位从 \`0x${first ? first.unicode : 'e001'}\` 开始（Unicode 私有区 PUA，不会与系统字体冲突）。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| \`${family}.woff\` | 字体文件（Web 优先用它，体积更小） |
| \`${family}.ttf\` | 字体文件（桌面端 / 设计软件用） |
| \`${family}.css\` | \`@font-face\` 声明 + 各图标的 \`::before\` 取字符规则 |
| \`${family}.html\` | 独立预览页，字体已内嵌，双击即可看全部图标 |
| \`${family}.json\` | 图标名 → 码位映射，便于脚本或其他工具读取 |

## 用法

1. 把 \`${family}.css\` 和字体文件放到同一目录下，引入样式表：

\`\`\`html
<link rel="stylesheet" href="${family}.css">
\`\`\`

2. 直接用图标 class 写标签，标签内**不需要**填任何文字：

\`\`\`html
<span class="${first ? first.cssClass : family + '-icon'}"></span>
\`\`\`

图标由 CSS 的 \`::before { content: "\\e001" }\` 渲染，所以标签保持空即可。

## 图标清单

| 图标 | class | 码位 |
| --- | --- | --- |
${meta.map(g => `| ${g.name} | \`${g.cssClass}\` | \`0x${g.unicode}\` |`).join('\n')}
`
  zip.file('README.md', readme)
  return zip.generateAsync({ type: 'blob' })
}
