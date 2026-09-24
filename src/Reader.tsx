import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import ePub from 'epubjs'
import * as pdfjsLib from 'pdfjs-dist'
import { deleteBookmark, getBookmarks, getProgress, putBookmark, putQuote, putSession, saveProgress } from './db'
import { decodeTxt, decodeXml, parseFb2 } from './importers'
import { attachPagesToToc, fb2ToDocument, paginateText, searchText, txtToDocument } from './reader-utils'
import type { BookRecord, Bookmark, ReaderSettings, SearchResult, TocItem } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type LocationState = { location: string; percentage: number; excerpt?: string; chapterTitle?: string }
type SearchFn = (query: string) => Promise<SearchResult[]>
type GoToFn = (location: string, page?: number) => Promise<void> | void

type ReaderChildProps = {
  book: BookRecord
  settings: ReaderSettings
  onLocation: (state: LocationState) => void
  onToc: (items: TocItem[]) => void
  registerSearch: (fn: SearchFn) => void
  registerGoTo: (fn: GoToFn) => void
  onSelection: (text: string, state: LocationState) => void
  onToggleUi: () => void
  onTurn: () => void
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

function resolvedTheme(theme: ReaderSettings['theme']) {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function themeColors(theme: ReaderSettings['theme']) {
  const value = theme === 'system' ? resolvedTheme(theme) : theme
  const map: Record<string, { background: string; color: string }> = {
    light: { background: '#fbfaf7', color: '#211d19' },
    paper: { background: '#f2efe7', color: '#24211d' },
    warm: { background: '#f3e5d3', color: '#34271d' },
    sepia: { background: '#eadcc0', color: '#382b20' },
    dark: { background: '#161514', color: '#e8e4dc' },
    oled: { background: '#000000', color: '#e8e8e8' }
  }
  return map[value] ?? map.light
}

function marginPx(size: ReaderSettings['marginSize']) {
  if (size === 'narrow') return 16
  if (size === 'wide') return 38
  return 24
}

function estimateCharsPerScreen(settings: ReaderSettings, width = window.innerWidth, height = window.innerHeight) {
  const usableWidth = Math.max(250, width - marginPx(settings.marginSize) * 2)
  const usableHeight = Math.max(360, height - 46)
  const baseEm = settings.fontFamily === 'serif' ? 0.52 : 0.54
  const averageCharWidth = settings.fontSize * Math.max(0.42, baseEm + settings.letterSpacing)
  const charsPerLine = Math.max(18, usableWidth / averageCharWidth)
  const linesPerScreen = Math.max(10, usableHeight / (settings.fontSize * settings.lineHeight))
  return Math.round(clamp(charsPerLine * linesPerScreen * 0.88, 420, 2400))
}

function readerBodyCss(settings: ReaderSettings) {
  const colors = themeColors(settings.theme)
  return {
    'font-size': `${settings.fontSize}px !important`,
    'line-height': `${settings.lineHeight} !important`,
    'font-family': `${settings.fontFamily === 'serif' ? 'Iowan Old Style, Charter, Georgia, serif' : '-apple-system, BlinkMacSystemFont, Arial, sans-serif'} !important`,
    'font-weight': `${settings.fontWeight} !important`,
    'letter-spacing': `${settings.letterSpacing}em !important`,
    'text-align': `${settings.textAlign} !important`,
    color: `${colors.color} !important`,
    background: `${colors.background} !important`,
    margin: '0 !important',
    'box-sizing': 'border-box !important',
    'min-height': '100vh !important',
    padding: `max(12px, env(safe-area-inset-top)) ${marginPx(settings.marginSize)}px max(2.2rem, calc(env(safe-area-inset-bottom) + 1.35rem)) !important`
  }
}

function flattenToc(items: any[], level = 0): TocItem[] {
  const result: TocItem[] = []
  for (const item of items ?? []) {
    result.push({ id: item.id || crypto.randomUUID(), label: item.label || 'Раздел', location: item.href || item.cfi || '', level })
    if (item.subitems?.length) result.push(...flattenToc(item.subitems, level + 1))
  }
  return result
}

function usePageAnimation(settings: ReaderSettings, onTurn: () => void) {
  const [direction, setDirection] = useState<'next' | 'prev' | null>(null)
  const locked = useRef(false)
  const animate = useCallback(async (nextDirection: 'next' | 'prev', action: () => Promise<void> | void) => {
    if (locked.current) return
    locked.current = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animated = settings.animations && !reduced
    try {
      if (!animated) {
        await action()
        onTurn()
        return
      }
      setDirection(null)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      setDirection(nextDirection)
      await delay(145)
      await action()
      onTurn()
      await delay(390)
    } finally {
      setDirection(null)
      locked.current = false
    }
  }, [onTurn, settings.animations])
  return { direction, animate }
}

function useTouchNavigator(elementRef: RefObject<HTMLElement | null>, onPrev: () => void, onNext: () => void, onCenter: () => void) {
  const startRef = useRef<{ x: number; y: number; t: number; pointerId: number } | null>(null)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, a, [data-no-gesture="true"]')) return
    startRef.current = { x: event.clientX, y: event.clientY, t: Date.now(), pointerId: event.pointerId }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = startRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
      elementRef.current?.style.setProperty('--drag-x', `${clamp(dx * 0.34, -58, 58)}px`)
    }
  }, [elementRef])

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = startRef.current
    if (!start || start.pointerId !== event.pointerId) return
    elementRef.current?.style.setProperty('--drag-x', '0px')
    startRef.current = null
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    const elapsed = Date.now() - start.t
    const selected = window.getSelection()?.toString().trim()
    if (selected || elapsed > 480) return
    if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      if (dx < 0) onNext()
      else onPrev()
      return
    }
    if (Math.abs(dx) < 14 && Math.abs(dy) < 14) {
      const rect = elementRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = (event.clientX - rect.left) / rect.width
      if (x < 0.26) onPrev()
      else if (x > 0.74) onNext()
      else onCenter()
    }
  }, [elementRef, onCenter, onNext, onPrev])

  return { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish }
}

function ReaderChrome({ title, chapter, progress, visible, onExit, onSettings, onBookmark, onTools }: {
  title: string
  chapter?: string
  progress: number
  visible: boolean
  onExit: () => void
  onSettings: () => void
  onBookmark: () => void
  onTools: () => void
}) {
  return <>
    <header className={`reader-chrome ${visible ? 'visible' : ''}`} data-no-gesture="true">
      <button className="round-button" onClick={onExit} aria-label="Вернуться в библиотеку">‹</button>
      <div className="reader-heading">
        <strong>{title}</strong>
        <span>{chapter || `${Math.round(progress * 100)}%`}</span>
        <div><i style={{ width: `${clamp(progress, 0, 1) * 100}%` }} /></div>
      </div>
      <button className="round-button text-button" onClick={onSettings} aria-label="Настройки чтения">Aa</button>
    </header>
    <div className={`reader-actions ${visible ? 'visible' : ''}`} data-no-gesture="true">
      <button onClick={onBookmark}>◇<span>Закладка</span></button>
      <button onClick={onTools}>☰<span>Книга</span></button>
    </div>
  </>
}

function ReaderDrawer({ open, onClose, toc, bookmarks, searchResults, searchQuery, searching, onSearchQuery, onSearch, onGoTo, onDeleteBookmark }: {
  open: boolean
  onClose: () => void
  toc: TocItem[]
  bookmarks: Bookmark[]
  searchResults: SearchResult[]
  searchQuery: string
  searching: boolean
  onSearchQuery: (value: string) => void
  onSearch: () => void
  onGoTo: (location: string, page?: number) => void
  onDeleteBookmark: (id: string) => void
}) {
  const [tab, setTab] = useState<'toc' | 'bookmarks' | 'search'>('toc')
  useEffect(() => { if (open) setTab('toc') }, [open])
  if (!open) return null
  return <div className="drawer-backdrop" onClick={onClose} data-no-gesture="true">
    <aside className="reader-drawer" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-handle" />
      <div className="drawer-tabs">
        <button className={tab === 'toc' ? 'active' : ''} onClick={() => setTab('toc')}>Оглавление</button>
        <button className={tab === 'bookmarks' ? 'active' : ''} onClick={() => setTab('bookmarks')}>Закладки</button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>Поиск</button>
      </div>
      {tab === 'toc' && <div className="drawer-list">{toc.length ? toc.map((item) => <button key={item.id} className="drawer-row" style={{ paddingLeft: `${16 + (item.level ?? 0) * 14}px` }} onClick={() => { onGoTo(item.location, item.page); onClose() }}><span>{item.label}</span><small>›</small></button>) : <div className="drawer-empty">В этой книге оглавление не найдено.</div>}</div>}
      {tab === 'bookmarks' && <div className="drawer-list">{bookmarks.length ? bookmarks.map((item) => <div className="bookmark-row" key={item.id}><button onClick={() => { onGoTo(item.location); onClose() }}><strong>{Math.round(item.percentage * 100)}%</strong><span>{item.excerpt || item.label || 'Сохранённая позиция'}</span></button><button className="mini-danger" onClick={() => onDeleteBookmark(item.id)}>×</button></div>) : <div className="drawer-empty">Закладок пока нет.</div>}</div>}
      {tab === 'search' && <div className="search-pane">
        <form onSubmit={(event) => { event.preventDefault(); onSearch() }}><input value={searchQuery} onChange={(event) => onSearchQuery(event.target.value)} placeholder="Слово или фраза" autoFocus /><button disabled={searching || !searchQuery.trim()}>{searching ? '…' : 'Найти'}</button></form>
        <div className="drawer-list search-results">{searchResults.map((item) => <button className="search-result" key={item.id} onClick={() => { onGoTo(item.location, item.page); onClose() }}><strong>{item.label}</strong>{item.excerpt && <span>{item.excerpt}</span>}</button>)}{!searching && searchQuery && searchResults.length === 0 && <div className="drawer-empty">Совпадений нет.</div>}</div>
      </div>}
    </aside>
  </div>
}

function TextReader(props: ReaderChildProps) {
  const { book, settings, onLocation, onToc, registerSearch, registerGoTo, onSelection, onToggleUi, onTurn } = props
  const stageRef = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<Array<{ text: string; start: number }>>([])
  const [fullText, setFullText] = useState('')
  const [page, setPage] = useState(0)
  const [toc, setToc] = useState<TocItem[]>([])
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const { direction, animate } = usePageAnimation(settings, onTurn)

  useEffect(() => {
    let timer = 0
    const onResize = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setViewport((current) => {
          const next = { width: window.innerWidth, height: window.innerHeight }
          if (Math.abs(next.width - current.width) < 30 && Math.abs(next.height - current.height) < 120) return current
          return next
        })
      }, 180)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize) }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const buffer = await book.file.arrayBuffer()
      const data = book.format === 'txt' ? txtToDocument(decodeTxt(buffer)) : fb2ToDocument(decodeXml(buffer))
      if (book.format === 'fb2') parseFb2(decodeXml(buffer))
      const target = estimateCharsPerScreen(settings, viewport.width, viewport.height)
      const nextPages = paginateText(data.text, target)
      const nextToc = attachPagesToToc(data.toc, nextPages)
      const progress = await getProgress(book.id)
      const saved = Math.round((progress?.percentage ?? 0) * Math.max(0, nextPages.length - 1))
      if (cancelled) return
      setFullText(data.text)
      setPages(nextPages)
      setToc(nextToc)
      setPage(clamp(Number.isFinite(saved) ? saved : 0, 0, Math.max(0, nextPages.length - 1)))
    })()
    return () => { cancelled = true }
  }, [book, settings.fontSize, settings.lineHeight, settings.fontFamily, settings.letterSpacing, settings.marginSize, viewport.height, viewport.width])

  const report = useCallback((nextPage: number) => {
    if (!pages.length) return
    const percentage = pages.length > 1 ? nextPage / (pages.length - 1) : 0
    const chapter = [...toc].reverse().find((item) => (item.page ?? 0) <= nextPage)?.label
    const state = { location: `page:${nextPage}`, percentage, excerpt: pages[nextPage]?.text.slice(0, 180), chapterTitle: chapter }
    onLocation(state)
    void saveProgress({ bookId: book.id, location: state.location, percentage, updatedAt: Date.now(), chapterTitle: chapter })
  }, [book.id, onLocation, pages, toc])

  useEffect(() => { if (pages.length) report(page) }, [page, pages.length, report])
  useEffect(() => { onToc(toc) }, [onToc, toc])

  useEffect(() => {
    registerSearch(async (query) => searchText(fullText, pages, query).map((match, index) => ({ id: `${match.index}-${index}`, label: `Страница ${match.page + 1}`, location: `page:${match.page}`, page: match.page, percentage: pages.length > 1 ? match.page / (pages.length - 1) : 0, excerpt: match.excerpt })))
    registerGoTo((location, targetPage) => {
      const value = targetPage ?? (location.startsWith('page:') ? Number(location.slice(5)) : 0)
      setPage(clamp(Number.isFinite(value) ? value : 0, 0, Math.max(0, pages.length - 1)))
    })
  }, [fullText, pages, registerGoTo, registerSearch])

  const go = useCallback((delta: number) => {
    const next = clamp(page + delta, 0, Math.max(0, pages.length - 1))
    if (next === page) return
    void animate(delta > 0 ? 'next' : 'prev', () => setPage(next))
  }, [animate, page, pages.length])

  const gestures = useTouchNavigator(stageRef, () => go(-1), () => go(1), onToggleUi)
  const captureSelection = () => window.setTimeout(() => {
    const selection = window.getSelection()?.toString().replace(/\s+/g, ' ').trim()
    if (selection && selection.length >= 2) onSelection(selection.slice(0, 1200), { location: `page:${page}`, percentage: pages.length > 1 ? page / (pages.length - 1) : 0, excerpt: selection.slice(0, 180), chapterTitle: [...toc].reverse().find((item) => (item.page ?? 0) <= page)?.label })
  }, 30)

  const colors = themeColors(settings.theme)
  const style = { '--reader-size': `${settings.fontSize}px`, '--reader-line': settings.lineHeight, '--reader-font': settings.fontFamily === 'serif' ? 'Iowan Old Style, Charter, Georgia, serif' : '-apple-system, BlinkMacSystemFont, Arial, sans-serif', '--reader-margin': `${marginPx(settings.marginSize)}px`, '--reader-weight': settings.fontWeight, '--reader-spacing': `${settings.letterSpacing}em`, '--reader-align': settings.textAlign, '--reader-bg': colors.background, '--reader-fg': colors.color } as CSSProperties
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => { gestures.onPointerUp(event); captureSelection() }
  const percentage = pages.length > 1 ? page / (pages.length - 1) : 0

  return <div ref={stageRef} className="reader-stage text-stage" style={style} onPointerDown={gestures.onPointerDown} onPointerMove={gestures.onPointerMove} onPointerUp={handlePointerUp} onPointerCancel={gestures.onPointerCancel}>
    <div className={`page-surface ${direction ? `turn-${direction}` : ''}`}>{pages[page]?.text.split(/\n\n+/).map((paragraph, index) => toc.some((item) => item.page === page && paragraph.startsWith(item.label)) ? <h2 key={index}>{paragraph}</h2> : <p key={index}>{paragraph}</p>)}</div>
    <div className="reader-footnote">{pages.length ? `Стр. ${page + 1} из ${pages.length} · ${Math.round(percentage * 100)}%` : 'Подготовка…'}</div>
  </div>
}

function PdfReader(props: ReaderChildProps) {
  const { book, settings, onLocation, onToc, registerSearch, registerGoTo, onToggleUi, onTurn } = props
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pdfRef = useRef<any>(null)
  const taskRef = useRef<any>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const { direction, animate } = usePageAnimation(settings, onTurn)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const pdf = await pdfjsLib.getDocument({ data: await book.file.arrayBuffer() }).promise
      const saved = await getProgress(book.id)
      if (cancelled) { await pdf.destroy(); return }
      pdfRef.current = pdf
      setPages(pdf.numPages)
      const savedPage = saved?.location.startsWith('pdf:') ? Number(saved.location.slice(4)) : Math.max(1, Math.round((saved?.percentage ?? 0) * pdf.numPages))
      setPage(clamp(Number.isFinite(savedPage) ? savedPage : 1, 1, pdf.numPages))
      onToc([])
    })()
    return () => { cancelled = true; taskRef.current?.cancel?.(); void pdfRef.current?.destroy?.(); pdfRef.current = null }
  }, [book, onToc])

  useEffect(() => {
    const pdf = pdfRef.current
    const canvas = canvasRef.current
    if (!pdf || !canvas) return
    let cancelled = false
    ;(async () => {
      try {
        taskRef.current?.cancel?.()
        const pdfPage = await pdf.getPage(page)
        if (cancelled) return
        const base = pdfPage.getViewport({ scale: 1 })
        const cssWidth = Math.min(window.innerWidth, 1100)
        const scale = (cssWidth * window.devicePixelRatio) / base.width
        const viewport = pdfPage.getViewport({ scale })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${viewport.width / window.devicePixelRatio}px`
        canvas.style.height = `${viewport.height / window.devicePixelRatio}px`
        const context = canvas.getContext('2d')
        if (!context) return
        const task = pdfPage.render({ canvasContext: context, viewport })
        taskRef.current = task
        await task.promise
      } catch (error: any) {
        if (error?.name !== 'RenderingCancelledException') console.error(error)
      }
    })()
    const percentage = pages > 1 ? (page - 1) / (pages - 1) : 0
    const state = { location: `pdf:${page}`, percentage, excerpt: `Страница ${page}` }
    onLocation(state)
    void saveProgress({ bookId: book.id, location: state.location, percentage, updatedAt: Date.now() })
    return () => { cancelled = true }
  }, [book.id, onLocation, page, pages])

  useEffect(() => {
    registerGoTo((location, targetPage) => {
      const parsed = targetPage ?? (location.startsWith('pdf:') ? Number(location.slice(4)) : 1)
      setPage((current) => clamp(Number.isFinite(parsed) ? parsed : current, 1, pages))
    })
    registerSearch(async (query) => {
      const pdf = pdfRef.current
      const term = query.trim().toLocaleLowerCase('ru')
      if (!pdf || !term) return []
      const results: SearchResult[] = []
      for (let number = 1; number <= pdf.numPages && results.length < 80; number += 1) {
        const pdfPage = await pdf.getPage(number)
        const text = await pdfPage.getTextContent()
        const source = text.items.map((item: any) => item.str || '').join(' ')
        const index = source.toLocaleLowerCase('ru').indexOf(term)
        if (index >= 0) results.push({ id: `pdf-${number}`, label: `Страница ${number}`, location: `pdf:${number}`, page: number, percentage: pdf.numPages > 1 ? (number - 1) / (pdf.numPages - 1) : 0, excerpt: source.slice(Math.max(0, index - 60), index + term.length + 100).replace(/\s+/g, ' ').trim() })
      }
      return results
    })
  }, [pages, registerGoTo, registerSearch])

  const go = useCallback((delta: number) => {
    const next = clamp(page + delta, 1, pages)
    if (next === page) return
    void animate(delta > 0 ? 'next' : 'prev', () => setPage(next))
  }, [animate, page, pages])
  const gestures = useTouchNavigator(stageRef, () => go(-1), () => go(1), onToggleUi)
  const percentage = pages > 1 ? (page - 1) / (pages - 1) : 0

  return <div ref={stageRef} className="reader-stage pdf-stage" onPointerDown={gestures.onPointerDown} onPointerMove={gestures.onPointerMove} onPointerUp={gestures.onPointerUp} onPointerCancel={gestures.onPointerCancel}>
    <div className={`pdf-page ${direction ? `turn-${direction}` : ''}`}><canvas ref={canvasRef} /></div>
    <div className="reader-footnote">Стр. {page} из {pages} · {Math.round(percentage * 100)}%</div>
  </div>
}

function EpubReader(props: ReaderChildProps) {
  const { book, settings, onLocation, onToc, registerSearch, registerGoTo, onSelection, onToggleUi, onTurn } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<any>(null)
  const renditionRef = useRef<any>(null)
  const turnRef = useRef<(delta: number) => Promise<void>>(async () => undefined)
  const [ready, setReady] = useState(false)
  const [pageInfo, setPageInfo] = useState({ page: 1, total: 1, percentage: 0 })
  const { direction, animate } = usePageAnimation(settings, onTurn)

  const turn = useCallback(async (delta: number) => {
    const rendition = renditionRef.current
    if (!rendition) return
    await animate(delta > 0 ? 'next' : 'prev', async () => { if (delta > 0) await rendition.next(); else await rendition.prev() })
  }, [animate])
  turnRef.current = turn

  useEffect(() => {
    if (!hostRef.current) return
    let dead = false
    const cleanupFns: Array<() => void> = []
    ;(async () => {
      const instance = ePub(await book.file.arrayBuffer())
      bookRef.current = instance
      await instance.ready
      if (dead) return
      const navigation = flattenToc(instance.navigation?.toc ?? [])
      onToc(navigation)
      const rendition = instance.renderTo(hostRef.current!, { width: '100%', height: '100%', spread: 'none', flow: 'paginated' })
      renditionRef.current = rendition
      rendition.themes.default({ body: readerBodyCss(settings) })
      rendition.on('relocated', (loc: any) => {
        const percentage = Number(loc?.start?.percentage ?? 0)
        const safePercentage = Number.isFinite(percentage) ? percentage : 0
        const displayedPage = Number(loc?.start?.displayed?.page ?? 1)
        const displayedTotal = Number(loc?.start?.displayed?.total ?? 1)
        const pageNumber = Number.isFinite(displayedPage) && displayedPage > 0 ? displayedPage : 1
        const pageTotal = Number.isFinite(displayedTotal) && displayedTotal > 0 ? displayedTotal : 1
        const href = String(loc?.start?.href || '')
        const hrefBase = href.split('#')[0]
        const chapter = navigation.find((item) => item.location.split('#')[0] === hrefBase)?.label
        setPageInfo({ page: pageNumber, total: pageTotal, percentage: safePercentage })
        const state = { location: loc?.start?.cfi || '', percentage: safePercentage, excerpt: `Страница ${pageNumber} из ${pageTotal} в разделе`, chapterTitle: chapter || href }
        onLocation(state)
        void saveProgress({ bookId: book.id, location: state.location, percentage: state.percentage, updatedAt: Date.now(), chapterTitle: state.chapterTitle })
      })
      rendition.on('selected', (cfiRange: string, contents: any) => {
        const text = contents?.window?.getSelection?.()?.toString?.()?.replace(/\s+/g, ' ').trim()
        if (text) onSelection(text.slice(0, 1200), { location: cfiRange, percentage: 0, excerpt: text.slice(0, 180) })
      })
      rendition.on('rendered', (_section: any, view: any) => {
        const doc = view?.document || view?.contents?.document
        if (!doc) return
        let start: { x: number; y: number; t: number } | null = null
        let moved = false
        const touchStart = (event: TouchEvent) => { const touch = event.touches[0]; if (touch) { start = { x: touch.clientX, y: touch.clientY, t: Date.now() }; moved = false } }
        const touchMove = (event: TouchEvent) => {
          if (!start || !event.touches[0]) return
          const dx = event.touches[0].clientX - start.x
          const dy = event.touches[0].clientY - start.y
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { moved = true; hostRef.current?.style.setProperty('--drag-x', `${clamp(dx * 0.28, -54, 54)}px`) }
        }
        const touchEnd = (event: TouchEvent) => {
          if (!start) return
          hostRef.current?.style.setProperty('--drag-x', '0px')
          const touch = event.changedTouches[0]
          if (!touch) return
          const dx = touch.clientX - start.x
          const dy = touch.clientY - start.y
          const elapsed = Date.now() - start.t
          const selected = doc.getSelection?.()?.toString()?.trim()
          const width = doc.documentElement?.clientWidth || window.innerWidth
          if (!selected && elapsed < 480) {
            if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.1) { if (dx < 0) void turnRef.current(1); else void turnRef.current(-1) }
            else if (!moved && Math.abs(dx) < 14 && Math.abs(dy) < 14) { const x = touch.clientX / width; if (x < 0.26) void turnRef.current(-1); else if (x > 0.74) void turnRef.current(1); else onToggleUi() }
          }
          start = null
        }
        doc.addEventListener('touchstart', touchStart, { passive: true })
        doc.addEventListener('touchmove', touchMove, { passive: true })
        doc.addEventListener('touchend', touchEnd, { passive: true })
        cleanupFns.push(() => { doc.removeEventListener('touchstart', touchStart); doc.removeEventListener('touchmove', touchMove); doc.removeEventListener('touchend', touchEnd) })
      })
      const progress = await getProgress(book.id)
      await rendition.display(progress?.location || undefined)
      if (!dead) setReady(true)
    })()
    return () => { dead = true; cleanupFns.forEach((fn) => fn()); renditionRef.current?.destroy?.(); bookRef.current?.destroy?.(); renditionRef.current = null; bookRef.current = null }
  }, [book, onLocation, onSelection, onToc, onToggleUi])

  useEffect(() => { if (renditionRef.current) renditionRef.current.themes.default({ body: readerBodyCss(settings) }) }, [settings])

  useEffect(() => {
    registerGoTo(async (location) => { if (location && renditionRef.current) await renditionRef.current.display(location) })
    registerSearch(async (query) => {
      const instance = bookRef.current
      const term = query.trim()
      if (!instance || !term) return []
      const sections: any[] = []
      instance.spine.each((section: any) => sections.push(section))
      const results: SearchResult[] = []
      for (const section of sections) {
        if (results.length >= 60) break
        try {
          await section.load(instance.load.bind(instance))
          const found = section.find(term) || []
          for (const match of found.slice(0, 8)) { results.push({ id: match.cfi || crypto.randomUUID(), label: section.href || 'Совпадение', location: match.cfi, excerpt: match.excerpt?.replace(/\s+/g, ' ').trim() }); if (results.length >= 60) break }
          section.unload?.()
        } catch { section.unload?.() }
      }
      return results
    })
  }, [registerGoTo, registerSearch])

  return <div className="reader-stage epub-stage">
    <div ref={hostRef} className={`epub-host ${direction ? `turn-${direction}` : ''}`} />
    {!ready && <div className="reader-loading">Открываем книгу…</div>}
    <button className="epub-edge epub-edge-left" onClick={() => void turn(-1)} aria-label="Предыдущая страница" />
    <button className="epub-edge epub-edge-right" onClick={() => void turn(1)} aria-label="Следующая страница" />
    <div className="reader-footnote">Стр. {pageInfo.page} из {pageInfo.total} в разделе · {Math.round(pageInfo.percentage * 100)}% книги</div>
  </div>
}

export function BookReader({ book, settings, onExit, onSettings, onDataChanged }: { book: BookRecord; settings: ReaderSettings; onExit: () => void; onSettings: () => void; onDataChanged: () => void }) {
  const [showUi, setShowUi] = useState(true)
  const [location, setLocation] = useState<LocationState>({ location: '', percentage: 0 })
  const [toc, setToc] = useState<TocItem[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selection, setSelection] = useState<{ text: string; state: LocationState } | null>(null)
  const searchRef = useRef<SearchFn>(async () => [])
  const goToRef = useRef<GoToFn>(() => undefined)
  const sessionStart = useRef(Date.now())
  const pagesTurned = useRef(0)
  const flushed = useRef(false)
  const [systemThemeTick, setSystemThemeTick] = useState(0)

  const theme = useMemo(() => { void systemThemeTick; return resolvedTheme(settings.theme) }, [settings.theme, systemThemeTick])
  const reloadBookmarks = useCallback(() => { void getBookmarks(book.id).then(setBookmarks) }, [book.id])
  const handleSelection = useCallback((text: string, state: LocationState) => setSelection({ text, state }), [])
  const handleToggleUi = useCallback(() => setShowUi((value) => !value), [])
  const handleTurn = useCallback(() => { pagesTurned.current += 1 }, [])
  const registerSearch = useCallback((fn: SearchFn) => { searchRef.current = fn }, [])
  const registerGoTo = useCallback((fn: GoToFn) => { goToRef.current = fn }, [])
  useEffect(reloadBookmarks, [reloadBookmarks])

  useEffect(() => {
    if (settings.theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => setSystemThemeTick((value) => value + 1)
    media.addEventListener?.('change', listener)
    return () => media.removeEventListener?.('change', listener)
  }, [settings.theme])

  useEffect(() => {
    if (!settings.wakeLock) return
    let sentinel: { release: () => Promise<void> } | null = null
    let active = true
    const acquire = async () => {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }
      if (!active || document.visibilityState !== 'visible' || !nav.wakeLock) return
      try { sentinel = await nav.wakeLock.request('screen') } catch { /* unsupported */ }
    }
    void acquire()
    const visibility = () => { if (document.visibilityState === 'visible') void acquire() }
    document.addEventListener('visibilitychange', visibility)
    return () => { active = false; document.removeEventListener('visibilitychange', visibility); void sentinel?.release?.() }
  }, [settings.wakeLock])

  const flushSession = useCallback(() => {
    if (flushed.current) return
    flushed.current = true
    const endedAt = Date.now()
    void putSession({ id: crypto.randomUUID(), bookId: book.id, bookTitle: book.title, startedAt: sessionStart.current, endedAt, durationSec: Math.max(0, Math.round((endedAt - sessionStart.current) / 1000)), pagesTurned: pagesTurned.current }).then(onDataChanged)
  }, [book.id, book.title, onDataChanged])
  useEffect(() => () => flushSession(), [flushSession])

  const addBookmark = async () => {
    if (!location.location) return
    await putBookmark({ id: crypto.randomUUID(), bookId: book.id, bookTitle: book.title, location: location.location, percentage: location.percentage, excerpt: location.excerpt || location.chapterTitle, createdAt: Date.now() })
    reloadBookmarks(); onDataChanged()
  }
  const saveSelection = async () => {
    if (!selection) return
    await putQuote({ id: crypto.randomUUID(), bookId: book.id, bookTitle: book.title, text: selection.text, location: selection.state.location || location.location, percentage: selection.state.percentage || location.percentage, createdAt: Date.now() })
    setSelection(null); window.getSelection()?.removeAllRanges(); onDataChanged()
  }
  const runSearch = async () => { if (!searchQuery.trim()) return; setSearching(true); try { setSearchResults(await searchRef.current(searchQuery)) } finally { setSearching(false) } }

  const common: ReaderChildProps = {
    book, settings, onLocation: setLocation, onToc: setToc,
    registerSearch, registerGoTo,
    onSelection: handleSelection, onToggleUi: handleToggleUi, onTurn: handleTurn
  }

  return <div className={`reader reader-theme-${theme}`} style={{ '--reader-brightness': settings.brightness / 100 } as CSSProperties}>
    <div className="reader-brightness-layer" />
    <ReaderChrome title={book.title} chapter={location.chapterTitle} progress={location.percentage} visible={showUi} onExit={() => { flushSession(); onExit() }} onSettings={onSettings} onBookmark={() => void addBookmark()} onTools={() => setDrawerOpen(true)} />
    {book.format === 'epub' ? <EpubReader {...common} /> : book.format === 'pdf' ? <PdfReader {...common} /> : <TextReader {...common} />}
    {selection && <div className="selection-popover" data-no-gesture="true"><span>{selection.text.length > 90 ? `${selection.text.slice(0, 90)}…` : selection.text}</span><button onClick={() => void saveSelection()}>Сохранить цитату</button><button className="selection-close" onClick={() => setSelection(null)}>×</button></div>}
    <ReaderDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} toc={toc} bookmarks={bookmarks} searchResults={searchResults} searchQuery={searchQuery} searching={searching} onSearchQuery={setSearchQuery} onSearch={() => void runSearch()} onGoTo={(loc, page) => { void goToRef.current(loc, page) }} onDeleteBookmark={(id) => { void deleteBookmark(id).then(() => { reloadBookmarks(); onDataChanged() }) }} />
  </div>
}
