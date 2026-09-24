import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import ePub from 'epubjs'
import * as pdfjsLib from 'pdfjs-dist'
import { deleteBook, getBooks, getProgress, getSettings, putBook, saveProgress, saveSettings, touchBook } from './db'
import { decodeTxt, decodeXml, importBook, parseFb2 } from './importers'
import type { BookRecord, ReaderSettings } from './types'
import { DEFAULT_SETTINGS } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

const ACCEPT = '.epub,.fb2,.txt,.pdf,application/epub+zip,application/pdf,text/plain'

function prettySize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`
  return `${(size / 1024 / 1024).toFixed(1)} МБ`
}

function initials(title: string) {
  return title.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'К'
}

function toParagraphs(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function chunkText(text: string, max = 4200) {
  const paragraphs = toParagraphs(text).split(/\n\s*\n/)
  const pages: string[] = []
  let page = ''
  for (const paragraph of paragraphs) {
    const next = page ? `${page}\n\n${paragraph}` : paragraph
    if (next.length > max && page) {
      pages.push(page)
      page = paragraph
    } else {
      page = next
    }
  }
  if (page) pages.push(page)
  return pages.length ? pages : ['']
}

function fb2ToText(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const body = doc.getElementsByTagName('body')[0]
  if (!body) return ''
  const blocks = Array.from(body.querySelectorAll('title, p, subtitle, poem, cite'))
  return blocks.map((node) => {
    const value = node.textContent?.replace(/\s+/g, ' ').trim() || ''
    return node.tagName.toLowerCase() === 'title' ? `\n${value.toUpperCase()}\n` : value
  }).filter(Boolean).join('\n\n')
}

function IconButton({ label, onClick, children, className = '' }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return <button className={`icon-button ${className}`} onClick={onClick} aria-label={label}>{children}</button>
}

function Library({ books, onImport, onOpen, onDelete, importing }: {
  books: BookRecord[]
  onImport: (file: File) => void
  onOpen: (book: BookRecord) => void
  onDelete: (book: BookRecord) => void
  importing: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onImport(file)
    event.target.value = ''
  }

  return (
    <main className="library-shell">
      <header className="library-header">
        <div>
          <div className="eyebrow">Локальная библиотека</div>
          <h1>Читалка</h1>
          <p>Книги остаются только на этом устройстве.</p>
        </div>
        <button className="primary" disabled={importing} onClick={() => inputRef.current?.click()}>
          <span>{importing ? 'Импорт…' : 'Добавить книгу'}</span>
          <strong>＋</strong>
        </button>
        <input ref={inputRef} className="visually-hidden" type="file" accept={ACCEPT} onChange={handleChange} />
      </header>

      {books.length === 0 ? (
        <section className="empty-state">
          <div className="empty-icon">⌁</div>
          <h2>Библиотека пустая</h2>
          <p>Добавьте EPUB, FB2, TXT или PDF с телефона. После импорта файл хранится в IndexedDB и доступен офлайн.</p>
          <button className="secondary" onClick={() => inputRef.current?.click()}>Выбрать файл</button>
        </section>
      ) : (
        <section className="book-grid" aria-label="Библиотека книг">
          {books.map((book) => (
            <article className="book-card" key={book.id}>
              <button className="book-open" onClick={() => onOpen(book)}>
                <div className="cover">
                  {book.cover ? <img src={book.cover} alt="" /> : <span>{initials(book.title)}</span>}
                  <i>{book.format.toUpperCase()}</i>
                </div>
                <div className="book-meta">
                  <h2>{book.title}</h2>
                  <p>{book.author}</p>
                  <small>{prettySize(book.size)}</small>
                </div>
              </button>
              <button className="delete" onClick={() => onDelete(book)} aria-label={`Удалить ${book.title}`}>Удалить</button>
            </article>
          ))}
        </section>
      )}
      <footer>Без аккаунта · без аналитики · без загрузки файлов на сервер</footer>
    </main>
  )
}

function SettingsPanel({ settings, onChange, onClose, fixedLayout }: {
  settings: ReaderSettings
  onChange: (settings: ReaderSettings) => void
  onClose: () => void
  fixedLayout: boolean
}) {
  const set = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => onChange({ ...settings, [key]: value })
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <section className="settings-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title"><h2>Настройки чтения</h2><button onClick={onClose}>Готово</button></div>
        {fixedLayout && <p className="fixed-note">PDF имеет фиксированную вёрстку, поэтому размер и межстрочный интервал текста не меняются.</p>}
        <label>
          <span>Размер текста <b>{settings.fontSize}px</b></span>
          <input type="range" min="15" max="34" value={settings.fontSize} disabled={fixedLayout} onChange={(e) => set('fontSize', Number(e.target.value))} />
        </label>
        <label>
          <span>Интервал <b>{settings.lineHeight.toFixed(2)}</b></span>
          <input type="range" min="1.2" max="2.1" step="0.05" value={settings.lineHeight} disabled={fixedLayout} onChange={(e) => set('lineHeight', Number(e.target.value))} />
        </label>
        <div className="setting-group">
          <span>Тема</span>
          <div className="segmented three">
            {(['light', 'sepia', 'dark'] as const).map((theme) => <button key={theme} className={settings.theme === theme ? 'active' : ''} onClick={() => set('theme', theme)}>{theme === 'light' ? 'Светлая' : theme === 'sepia' ? 'Сепия' : 'Тёмная'}</button>)}
          </div>
        </div>
        <div className="setting-group">
          <span>Шрифт</span>
          <div className="segmented">
            <button className={settings.fontFamily === 'serif' ? 'active serif' : 'serif'} disabled={fixedLayout} onClick={() => set('fontFamily', 'serif')}>С засечками</button>
            <button className={settings.fontFamily === 'sans' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('fontFamily', 'sans')}>Без засечек</button>
          </div>
        </div>
      </section>
    </div>
  )
}

function TextReader({ book, settings, onExit, onSettings }: { book: BookRecord; settings: ReaderSettings; onExit: () => void; onSettings: () => void }) {
  const [pages, setPages] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [showUi, setShowUi] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const buffer = await book.file.arrayBuffer()
      let text = ''
      if (book.format === 'txt') text = decodeTxt(buffer)
      else {
        const decoded = decodeXml(buffer)
        parseFb2(decoded)
        text = fb2ToText(decoded)
      }
      const nextPages = chunkText(text, Math.max(2400, Math.round(4800 * (20 / settings.fontSize))))
      const progress = await getProgress(book.id)
      const savedPage = progress ? Math.round(progress.percentage * Math.max(nextPages.length - 1, 0)) : 0
      if (!cancelled) {
        setPages(nextPages)
        setPage(Math.min(Math.max(savedPage, 0), Math.max(nextPages.length - 1, 0)))
      }
    })()
    return () => { cancelled = true }
  }, [book, settings.fontSize])

  const go = (next: number) => {
    const value = Math.max(0, Math.min(next, pages.length - 1))
    setPage(value)
    void saveProgress({ bookId: book.id, location: `page:${value}`, percentage: pages.length > 1 ? value / (pages.length - 1) : 0, updatedAt: Date.now() })
  }

  const style = { '--reader-size': `${settings.fontSize}px`, '--reader-line': settings.lineHeight, '--reader-font': settings.fontFamily === 'serif' ? 'Iowan Old Style, Charter, Georgia, serif' : '-apple-system, BlinkMacSystemFont, Inter, sans-serif' } as CSSProperties

  return (
    <div className={`reader theme-${settings.theme}`} style={style}>
      <ReaderChrome title={book.title} show={showUi} onExit={onExit} onSettings={onSettings} progress={pages.length ? (page + 1) / pages.length : 0} />
      <div className="text-page"><div>{pages[page]?.split(/\n\n+/).map((p, index) => <p key={index}>{p}</p>)}</div></div>
      <TapZones onPrev={() => go(page - 1)} onNext={() => go(page + 1)} onCenter={() => setShowUi((value) => !value)} />
      {showUi && <div className="page-counter">{pages.length ? `${page + 1} / ${pages.length}` : 'Подготовка…'}</div>}
    </div>
  )
}

function EpubReader({ book, settings, onExit, onSettings }: { book: BookRecord; settings: ReaderSettings; onExit: () => void; onSettings: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<any>(null)
  const [showUi, setShowUi] = useState(true)
  const [progress, setProgressState] = useState(0)

  useEffect(() => {
    if (!hostRef.current) return
    let dead = false
    let bookInstance: any
    ;(async () => {
      const buffer = await book.file.arrayBuffer()
      if (dead) return
      bookInstance = ePub(buffer)
      await bookInstance.ready
      const rendition = bookInstance.renderTo(hostRef.current!, { width: '100%', height: '100%', spread: 'none', flow: 'paginated' })
      renditionRef.current = rendition
      const progressRow = await getProgress(book.id)
      const css = readerCss(settings)
      rendition.themes.default({ body: css })
      rendition.on('relocated', (location: any) => {
        const fraction = location?.start?.percentage ?? 0
        setProgressState(fraction)
        void saveProgress({ bookId: book.id, location: location.start.cfi, percentage: fraction, updatedAt: Date.now() })
      })
      await rendition.display(progressRow?.location || undefined)
    })()
    return () => {
      dead = true
      renditionRef.current?.destroy?.()
      bookInstance?.destroy?.()
      renditionRef.current = null
    }
  }, [book])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    rendition.themes.default({ body: readerCss(settings) })
  }, [settings])

  return (
    <div className={`reader theme-${settings.theme}`}>
      <ReaderChrome title={book.title} show={showUi} onExit={onExit} onSettings={onSettings} progress={progress} />
      <div className="epub-host" ref={hostRef} />
      <TapZones onPrev={() => renditionRef.current?.prev()} onNext={() => renditionRef.current?.next()} onCenter={() => setShowUi((value) => !value)} />
    </div>
  )
}

function readerCss(settings: ReaderSettings) {
  return {
    'font-size': `${settings.fontSize}px !important`,
    'line-height': `${settings.lineHeight} !important`,
    'font-family': `${settings.fontFamily === 'serif' ? 'Georgia, serif' : 'Arial, sans-serif'} !important`,
    color: `${settings.theme === 'dark' ? '#e8e2d9' : '#211d19'} !important`,
    background: `${settings.theme === 'dark' ? '#141210' : settings.theme === 'sepia' ? '#eadfc8' : '#faf8f3'} !important`,
    padding: '2.8rem 1.15rem 4rem !important'
  }
}

function PdfReader({ book, settings, onExit, onSettings }: { book: BookRecord; settings: ReaderSettings; onExit: () => void; onSettings: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pdfRef = useRef<any>(null)
  const renderRef = useRef<any>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [showUi, setShowUi] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const buffer = await book.file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
      pdfRef.current = pdf
      const saved = await getProgress(book.id)
      const savedPage = saved?.location.startsWith('pdf:') ? Number(saved.location.slice(4)) : 1
      if (!cancelled) {
        setPages(pdf.numPages)
        setPage(Math.min(Math.max(savedPage, 1), pdf.numPages))
      }
    })()
    return () => {
      cancelled = true
      renderRef.current?.cancel?.()
      pdfRef.current?.destroy?.()
      pdfRef.current = null
    }
  }, [book])

  useEffect(() => {
    const pdf = pdfRef.current
    const canvas = canvasRef.current
    if (!pdf || !canvas) return
    let cancelled = false
    ;(async () => {
      renderRef.current?.cancel?.()
      const pdfPage = await pdf.getPage(page)
      if (cancelled) return
      const base = pdfPage.getViewport({ scale: 1 })
      const width = Math.min(window.innerWidth, 900) * window.devicePixelRatio
      const scale = Math.max(0.5, (width - 24 * window.devicePixelRatio) / base.width)
      const viewport = pdfPage.getViewport({ scale })
      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.width = `${viewport.width / window.devicePixelRatio}px`
      canvas.style.height = `${viewport.height / window.devicePixelRatio}px`
      const context = canvas.getContext('2d')
      if (!context) return
      const task = pdfPage.render({ canvasContext: context, viewport })
      renderRef.current = task
      await task.promise.catch((error: any) => { if (error?.name !== 'RenderingCancelledException') throw error })
      void saveProgress({ bookId: book.id, location: `pdf:${page}`, percentage: pages > 1 ? (page - 1) / (pages - 1) : 0, updatedAt: Date.now() })
    })()
    return () => { cancelled = true; renderRef.current?.cancel?.() }
  }, [page, pages])

  const go = (value: number) => setPage(Math.max(1, Math.min(value, pages)))
  return (
    <div className={`reader pdf-reader theme-${settings.theme}`}>
      <ReaderChrome title={book.title} show={showUi} onExit={onExit} onSettings={onSettings} progress={pages > 1 ? page / pages : 0} />
      <div className="pdf-stage"><canvas ref={canvasRef} /></div>
      <TapZones onPrev={() => go(page - 1)} onNext={() => go(page + 1)} onCenter={() => setShowUi((value) => !value)} />
      {showUi && <div className="page-counter">{page} / {pages}</div>}
    </div>
  )
}

function ReaderChrome({ title, show, onExit, onSettings, progress }: { title: string; show: boolean; onExit: () => void; onSettings: () => void; progress: number }) {
  return (
    <div className={`reader-chrome ${show ? 'visible' : ''}`}>
      <IconButton label="Вернуться в библиотеку" onClick={onExit}>‹</IconButton>
      <div className="reader-title"><span>{title}</span><div><i style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} /></div></div>
      <IconButton label="Настройки чтения" onClick={onSettings} className="chrome-aa">Aa</IconButton>
    </div>
  )
}

function TapZones({ onPrev, onNext, onCenter }: { onPrev: () => void; onNext: () => void; onCenter: () => void }) {
  return <div className="tap-zones" aria-hidden="true"><button onClick={onPrev} /><button onClick={onCenter} /><button onClick={onNext} /></div>
}

function Reader({ book, settings, onSettings, onExit }: { book: BookRecord; settings: ReaderSettings; onSettings: () => void; onExit: () => void }) {
  return (
    <div className="reader-frame">
      {book.format === 'epub'
        ? <EpubReader book={book} settings={settings} onExit={onExit} onSettings={onSettings} />
        : book.format === 'pdf'
          ? <PdfReader book={book} settings={settings} onExit={onExit} onSettings={onSettings} />
          : <TextReader book={book} settings={settings} onExit={onExit} onSettings={onSettings} />}
    </div>
  )
}

export default function App() {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [current, setCurrent] = useState<BookRecord | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void Promise.all([getBooks(), getSettings()]).then(([storedBooks, storedSettings]) => {
      setBooks(storedBooks)
      setSettings(storedSettings)
    })
  }, [])

  const sortedBooks = useMemo(() => [...books].sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt)), [books])

  const handleImport = async (file: File) => {
    setImporting(true)
    setNotice('')
    try {
      const book = await importBook(file)
      await putBook(book)
      setBooks((items) => [book, ...items])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось импортировать книгу')
    } finally {
      setImporting(false)
    }
  }

  const handleOpen = async (book: BookRecord) => {
    const next = { ...book, lastOpenedAt: Date.now() }
    setCurrent(next)
    setBooks((items) => items.map((item) => item.id === book.id ? next : item))
    void touchBook(book.id)
  }

  const handleDelete = async (book: BookRecord) => {
    if (!window.confirm(`Удалить «${book.title}» с этого устройства?`)) return
    await deleteBook(book.id)
    setBooks((items) => items.filter((item) => item.id !== book.id))
  }

  const handleSettings = (next: ReaderSettings) => {
    setSettings(next)
    void saveSettings(next)
  }

  return (
    <>
      {current ? <Reader book={current} settings={settings} onSettings={() => setShowSettings(true)} onExit={() => setCurrent(null)} /> : <Library books={sortedBooks} onImport={handleImport} onOpen={handleOpen} onDelete={handleDelete} importing={importing} />}
      {showSettings && <SettingsPanel settings={settings} onChange={handleSettings} onClose={() => setShowSettings(false)} fixedLayout={current?.format === 'pdf'} />}
      {notice && <button className="toast" onClick={() => setNotice('')}>{notice}</button>}
    </>
  )
}
