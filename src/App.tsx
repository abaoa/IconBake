import { useEffect, useMemo, useRef, useState } from 'react'
import { bboxOf, parsePath } from './lib/svgPath'
import { extractSvgPaths } from './lib/extractSvg'
import { tracePng, svgToCombinedD } from './lib/tracePng'
import { buildAndZip } from './lib/buildFont'
import { checkLatestRelease, isNewer } from './lib/update'
import { openExternal } from './lib/openExternal'
import { RELEASES_URL, REPO_URL, WEBSITE_URL, VERSION } from './config'
import type { GlyphInput } from './lib/types'

interface IconItem {
  id: string
  name: string
  source: string
  kind: 'svg' | 'png'
  d: string
}

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

export default function App() {
  const [icons, setIcons] = useState<IconItem[]>([])
  const [family, setFamily] = useState('iconbake')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState('')
  const [dragOver, setDragOver] = useState(false)
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

  function toggleTheme() {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'))
  }

  async function addFiles(files: FileList | File[]) {
    setError('')
    const list = Array.from(files)
    for (const file of list) {
      const lower = file.name.toLowerCase()
      const base = file.name.replace(/\.[^.]+$/, '')
      try {
        if (lower.endsWith('.svg')) {
          const text = await file.text()
          const d = extractSvgPaths(text)
          if (!d.trim()) {
            setError(`"${file.name}" 没有可识别的路径`)
            continue
          }
          pushIcon({ name: base, source: file.name, kind: 'svg', d })
        } else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
          setLog(`正在矢量化 ${file.name} …`)
          const svg = await tracePng(file)
          const d = svgToCombinedD(svg)
          if (!d.trim()) {
            setError(`"${file.name}" 矢量化失败（可能是空白图片）`)
            continue
          }
          pushIcon({ name: base, source: file.name, kind: 'png', d })
          setLog('')
        } else {
          setError(`不支持的文件类型：${file.name}`)
        }
      } catch (e) {
        setError(`处理 ${file.name} 出错：${(e as Error).message}`)
      }
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

  async function bake() {
    if (icons.length === 0) {
      setError('先添加至少一个图标')
      return
    }
    setBusy(true)
    setError('')
    setLog('正在生成字体…')
    try {
      const inputs: GlyphInput[] = icons.map((i) => ({ name: i.name, d: i.d, source: i.source }))
      const { zip, result } = await buildAndZip(inputs, { family: family || 'iconbake' })
      const url = URL.createObjectURL(zip)
      const a = document.createElement('a')
      a.href = url
      a.download = `${family || 'iconbake'}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setLog(`完成：${result.meta.length} 个图标 → ${result.family}.zip`)
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

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__brand">
          <div className="logo">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" aria-hidden="true" />
          </div>
          <div>
            <h1>IconBake</h1>
            <p>把 SVG / PNG 图片“烘焙”成一个图标字体</p>
          </div>
        </div>
        <div className="hero__actions">
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
          <span className="badge">纯前端 · 本地处理 · 不上传服务器</span>
        </div>
      </header>

      <section
        className={`drop ${dragOver ? 'drop--active' : ''}`}
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
        <strong>拖拽图片到这里，或点击选择</strong>
        <span>支持 SVG（推荐）、PNG / JPG（会矢量化为单色剪影）</span>
      </section>

      {error && <div className="alert alert--error">{error}</div>}
      {log && <div className="alert alert--info">{log}</div>}

      <div className="controls">
        <label className="field">
          <span>字体名</span>
          <input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="iconbake" />
        </label>
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

      {icons.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">🍳</div>
          <p>还没有图标</p>
          <span>拖几张 SVG / PNG 进来，开始烘焙你的图标字体吧</span>
        </div>
      ) : (
        <ul className="list">
          {icons.map((i) => (
            <li key={i.id}>
              <div className="card__preview">
                <Preview d={i.d} />
              </div>
              <input className="card__name" value={i.name} onChange={(e) => rename(i.id, e.target.value)} />
              <div className="card__meta">
                <span className={`tag tag--${i.kind}`}>{i.kind.toUpperCase()}</span>
                <button className="card__del" onClick={() => remove(i.id)} title="移除">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

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
    </div>
  )
}
