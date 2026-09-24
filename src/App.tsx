import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent } from 'react'
import {
  deleteBook,
  deleteCollection,
  deleteQuote,
  exportBackup,
  getAllProgress,
  getBooks,
  getCollections,
  getQuotes,
  getSessions,
  getSettings,
  importBackup,
  patchBook,
  putBook,
  putCollection,
  putQuote,
  saveProgress,
  saveSettings,
  touchBook
} from './db'
import { importBook } from './importers'
import { BookReader } from './Reader'
import { estimateMinutesLeft, formatDate, formatDuration, hashHue } from './reader-utils'
import type { BookRecord, BookStatus, CollectionRecord, LibrarySort, QuoteRecord, ReaderSettings, ReadingProgress, ReadingSession } from './types'
import { DEFAULT_SETTINGS } from './types'

const ACCEPT = '.epub,.fb2,.txt,.pdf,application/epub+zip,application/pdf,text/plain'
type Tab = 'library' | 'quotes' | 'stats' | 'settings'
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function prettySize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`
  return `${(size / 1024 / 1024).toFixed(1)} МБ`
}

function bookStatus(book: BookRecord, progress?: ReadingProgress): BookStatus {
  if (book.status) return book.status
  if ((progress?.percentage ?? 0) >= 0.985) return 'finished'
  if ((progress?.percentage ?? 0) > 0) return 'reading'
  return 'not-started'
}

function statusLabel(status: BookStatus) {
  if (status === 'finished') return 'Прочитано'
  if (status === 'reading') return 'Читаю'
  return 'Не начато'
}

function Cover({ book, large = false }: { book: BookRecord; large?: boolean }) {
  const style = { '--cover-hue': hashHue(book.id) } as CSSProperties
  return <div className={`book-cover ${large ? 'large' : ''}`} style={style}>{book.cover ? <img src={book.cover} alt="" /> : <div className="generated-cover"><span>{book.title}</span><small>{book.author}</small></div>}<i>{book.format.toUpperCase()}</i></div>
}

function ProgressLine({ value }: { value: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return <div className="progress-line"><i style={{ width: `${percent}%` }} /></div>
}

function InstallHint({ settings, onChange, installPrompt }: { settings: ReaderSettings; onChange: (next: ReaderSettings) => void; installPrompt: BeforeInstallPromptEvent | null }) {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  if (standalone || settings.installHintDismissed) return null
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  return <div className="install-hint"><div><strong>Установить Читалку</strong><span>{installPrompt ? 'Откроется как отдельное приложение и останется доступной офлайн.' : isIos ? 'В Safari: Поделиться → «На экран Домой».' : 'Добавьте приложение на домашний экран из меню браузера.'}</span></div>{installPrompt && <button onClick={() => void installPrompt.prompt()}>Установить</button>}<button className="hint-close" aria-label="Закрыть" onClick={() => onChange({ ...settings, installHintDismissed: true })}>×</button></div>
}

function LibraryView({ books, progressMap, collections, importing, onImport, onOpen, onDetails, settings, onSettingsChange, installPrompt }: {
  books: BookRecord[]
  progressMap: Map<string, ReadingProgress>
  collections: CollectionRecord[]
  importing: boolean
  onImport: (files: File[]) => void
  onOpen: (book: BookRecord) => void
  onDetails: (book: BookRecord) => void
  settings: ReaderSettings
  onSettingsChange: (settings: ReaderSettings) => void
  installPrompt: BeforeInstallPromptEvent | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [filter, setFilter] = useState<'all' | 'favorites' | BookStatus>('all')
  const [collection, setCollection] = useState('all')
  const [dragging, setDragging] = useState(false)

  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('ru')
    const rows = books.filter((book) => {
      const progress = progressMap.get(book.id)
      const status = bookStatus(book, progress)
      if (term && !`${book.title} ${book.author} ${book.format}`.toLocaleLowerCase('ru').includes(term)) return false
      if (filter === 'favorites' && !book.favorite) return false
      if (filter !== 'all' && filter !== 'favorites' && status !== filter) return false
      if (collection !== 'all' && !book.collectionIds?.includes(collection)) return false
      return true
    })
    return rows.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'ru')
      if (sort === 'author') return a.author.localeCompare(b.author, 'ru')
      if (sort === 'added') return b.addedAt - a.addedAt
      if (sort === 'progress') return (progressMap.get(b.id)?.percentage ?? 0) - (progressMap.get(a.id)?.percentage ?? 0)
      return (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)
    })
  }, [books, collection, filter, progressMap, query, sort])

  const continueBook = useMemo(() => [...books].filter((book) => (progressMap.get(book.id)?.percentage ?? 0) > 0 && bookStatus(book, progressMap.get(book.id)) !== 'finished').sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0], [books, progressMap])
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => { const files = Array.from(event.target.files ?? []) as File[]; if (files.length) onImport(files); event.target.value = '' }
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); const files = Array.from(event.dataTransfer.files ?? []) as File[]; if (files.length) onImport(files) }

  return <main className={`app-page library-page ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
    <header className="hero-header"><div><div className="eyebrow">Личная библиотека</div><h1>Читалка</h1><p>EPUB, FB2, TXT и PDF. Всё остаётся на устройстве.</p></div><button className="primary-action" disabled={importing} onClick={() => inputRef.current?.click()}>{importing ? 'Импорт…' : '＋ Добавить'}</button><input ref={inputRef} className="visually-hidden" type="file" accept={ACCEPT} multiple onChange={handleFiles} /></header>
    <InstallHint settings={settings} onChange={onSettingsChange} installPrompt={installPrompt} />
    {continueBook && (() => { const progress = progressMap.get(continueBook.id)?.percentage ?? 0; return <button className="continue-card" onClick={() => onOpen(continueBook)}><Cover book={continueBook} large /><div><span className="section-kicker">Сейчас читаю</span><h2>{continueBook.title}</h2><p>{continueBook.author}</p><ProgressLine value={progress} /><small>{Math.round(progress * 100)}% · ≈ {estimateMinutesLeft(continueBook.size, progress, continueBook.format)} мин осталось</small></div><b>Продолжить ›</b></button> })()}
    <section className="library-controls"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название, автор или формат" /><kbd>{visible.length}</kbd></label><div className="chip-row">{([['all', 'Все'], ['reading', 'Читаю'], ['not-started', 'Не начато'], ['finished', 'Прочитано'], ['favorites', 'Избранное']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="select-row"><label>Сортировка<select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}><option value="recent">Недавно открытые</option><option value="added">Недавно добавленные</option><option value="title">По названию</option><option value="author">По автору</option><option value="progress">По прогрессу</option></select></label><label>Полка<select value={collection} onChange={(event) => setCollection(event.target.value)}><option value="all">Все полки</option>{collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div></section>
    {books.length === 0 ? <section className="empty-state"><div className="empty-glyph">⌁</div><h2>Здесь пока тихо</h2><p>Выберите сразу одну или несколько книг. Файлы сохранятся в IndexedDB и будут доступны без сети.</p><button onClick={() => inputRef.current?.click()}>Выбрать книги</button></section> : visible.length === 0 ? <section className="empty-state compact"><h2>Ничего не найдено</h2><p>Фильтры оказались эффективнее человеческой памяти.</p></section> : <section className="book-grid">{visible.map((book) => { const progress = progressMap.get(book.id)?.percentage ?? 0; const status = bookStatus(book, progressMap.get(book.id)); return <article className="book-card" key={book.id}><button className="book-main" onClick={() => onOpen(book)}><Cover book={book} /><div className="book-copy"><div className="book-title-line"><h2>{book.title}</h2>{book.favorite && <span title="Избранное">★</span>}</div><p>{book.author}</p><div className="book-badges"><span>{statusLabel(status)}</span><span>{formatDate(book.lastOpenedAt || book.addedAt)}</span></div><ProgressLine value={progress} /><small>{Math.round(progress * 100)}% · {prettySize(book.size)} · ≈ {estimateMinutesLeft(book.size, progress, book.format)} мин</small></div></button><button className="more-button" aria-label={`Действия с ${book.title}`} onClick={() => onDetails(book)}>•••</button></article> })}</section>}
    {dragging && <div className="drop-overlay">Отпустите файлы, чтобы добавить книги</div>}
  </main>
}

function BookDetailSheet({ book, progress, collections, onClose, onChanged, onDelete }: { book: BookRecord; progress?: ReadingProgress; collections: CollectionRecord[]; onClose: () => void; onChanged: () => void; onDelete: () => void }) {
  const update = async (patch: Partial<BookRecord>) => { await patchBook(book.id, patch); onChanged() }
  const toggleCollection = async (id: string) => { const current = book.collectionIds ?? []; await update({ collectionIds: current.includes(id) ? current.filter((value) => value !== id) : [...current, id] }) }
  return <div className="sheet-backdrop" onClick={onClose}><section className="detail-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="detail-hero"><Cover book={book} large /><div><h2>{book.title}</h2><p>{book.author}</p><small>{book.format.toUpperCase()} · {prettySize(book.size)}</small></div></div><div className="detail-progress"><span>{Math.round((progress?.percentage ?? 0) * 100)}% прочитано</span><ProgressLine value={progress?.percentage ?? 0} /></div><div className="detail-actions"><button onClick={() => void update({ favorite: !book.favorite })}>{book.favorite ? '★ В избранном' : '☆ В избранное'}</button></div><div className="detail-section"><strong>Статус</strong><div className="segmented-control three">{(['not-started', 'reading', 'finished'] as BookStatus[]).map((status) => <button key={status} className={bookStatus(book, progress) === status ? 'active' : ''} onClick={() => void update({ status, finishedAt: status === 'finished' ? Date.now() : undefined })}>{statusLabel(status)}</button>)}</div></div><div className="detail-section"><strong>Полки</strong><div className="collection-checks">{collections.length ? collections.map((item) => <label key={item.id}><input type="checkbox" checked={book.collectionIds?.includes(item.id) ?? false} onChange={() => void toggleCollection(item.id)} /><span>{item.name}</span></label>) : <p>Полки можно создать в настройках.</p>}</div></div><div className="detail-info"><span>Добавлена <b>{new Date(book.addedAt).toLocaleDateString('ru')}</b></span><span>Файл <b>{book.fileName}</b></span></div><button className="danger-action" onClick={onDelete}>Удалить книгу и её данные</button></section></div>
}

function ReaderSettingsSheet({ settings, fixedLayout, onChange, onClose }: { settings: ReaderSettings; fixedLayout: boolean; onChange: (settings: ReaderSettings) => void; onClose: () => void }) {
  const set = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => onChange({ ...settings, [key]: value })
  const themes: Array<[ReaderSettings['theme'], string]> = [['system', 'Авто'], ['light', 'Светлая'], ['paper', 'Бумага'], ['warm', 'Тёплая'], ['sepia', 'Сепия'], ['dark', 'Ночь'], ['oled', 'OLED']]
  return <div className="sheet-backdrop" onClick={onClose}><section className="settings-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><h2>Вид страницы</h2><button onClick={onClose}>Готово</button></div>{fixedLayout && <p className="settings-note">PDF имеет фиксированную вёрстку. Типографические настройки применяются к EPUB, FB2 и TXT.</p>}<label className="range-setting"><span>Размер текста <b>{settings.fontSize}px</b></span><input type="range" min="15" max="36" value={settings.fontSize} disabled={fixedLayout} onChange={(event) => set('fontSize', Number(event.target.value))} /></label><label className="range-setting"><span>Межстрочный интервал <b>{settings.lineHeight.toFixed(2)}</b></span><input type="range" min="1.2" max="2.15" step="0.05" value={settings.lineHeight} disabled={fixedLayout} onChange={(event) => set('lineHeight', Number(event.target.value))} /></label><label className="range-setting"><span>Толщина <b>{settings.fontWeight}</b></span><input type="range" min="350" max="650" step="50" value={settings.fontWeight} disabled={fixedLayout} onChange={(event) => set('fontWeight', Number(event.target.value))} /></label><label className="range-setting"><span>Межбуквенный интервал <b>{settings.letterSpacing.toFixed(2)}</b></span><input type="range" min="-0.03" max="0.08" step="0.01" value={settings.letterSpacing} disabled={fixedLayout} onChange={(event) => set('letterSpacing', Number(event.target.value))} /></label><div className="setting-block"><span>Тема</span><div className="theme-grid">{themes.map(([value, label]) => <button key={value} className={`theme-swatch swatch-${value} ${settings.theme === value ? 'active' : ''}`} onClick={() => set('theme', value)}><i />{label}</button>)}</div></div><div className="setting-block"><span>Шрифт</span><div className="segmented-control"><button className={settings.fontFamily === 'serif' ? 'active serif' : 'serif'} disabled={fixedLayout} onClick={() => set('fontFamily', 'serif')}>С засечками</button><button className={settings.fontFamily === 'sans' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('fontFamily', 'sans')}>Без засечек</button></div></div><div className="setting-block"><span>Выравнивание</span><div className="segmented-control"><button className={settings.textAlign === 'left' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('textAlign', 'left')}>По левому</button><button className={settings.textAlign === 'justify' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('textAlign', 'justify')}>По ширине</button></div></div><div className="setting-block"><span>Поля</span><div className="segmented-control three"><button className={settings.marginSize === 'narrow' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('marginSize', 'narrow')}>Узкие</button><button className={settings.marginSize === 'normal' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('marginSize', 'normal')}>Обычные</button><button className={settings.marginSize === 'wide' ? 'active' : ''} disabled={fixedLayout} onClick={() => set('marginSize', 'wide')}>Широкие</button></div></div><label className="range-setting"><span>Яркость страницы <b>{settings.brightness}%</b></span><input type="range" min="55" max="100" value={settings.brightness} onChange={(event) => set('brightness', Number(event.target.value))} /></label><label className="toggle-setting"><span><b>Анимация перелистывания</b><small>Свайп и мягкий переход страницы</small></span><input type="checkbox" checked={settings.animations} onChange={(event) => set('animations', event.target.checked)} /></label><label className="toggle-setting"><span><b>Не выключать экран</b><small>Screen Wake Lock, если поддерживается браузером</small></span><input type="checkbox" checked={settings.wakeLock} onChange={(event) => set('wakeLock', event.target.checked)} /></label></section></div>
}

function QuotesView({ quotes, books, onChanged, onOpenQuote }: { quotes: QuoteRecord[]; books: BookRecord[]; onChanged: () => void; onOpenQuote: (quote: QuoteRecord) => void }) {
  const [query, setQuery] = useState('')
  const visible = quotes.filter((quote) => `${quote.text} ${quote.note ?? ''} ${quote.bookTitle}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
  const updateNote = async (quote: QuoteRecord, note: string) => { await putQuote({ ...quote, note }); onChanged() }
  return <main className="app-page"><header className="simple-header"><div className="eyebrow">Ваши мысли</div><h1>Цитаты</h1><p>Выделения и заметки хранятся только в этом браузере.</p></header><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Искать по цитатам и заметкам" /><kbd>{visible.length}</kbd></label>{visible.length ? <section className="quote-grid">{visible.map((quote) => <article className="quote-card" key={quote.id}><button className="quote-open" disabled={!books.some((book) => book.id === quote.bookId)} onClick={() => onOpenQuote(quote)}><blockquote>“{quote.text}”</blockquote><span>{quote.bookTitle} · {Math.round(quote.percentage * 100)}%</span></button><textarea defaultValue={quote.note ?? ''} placeholder="Добавить заметку…" onBlur={(event) => void updateNote(quote, event.currentTarget.value)} /><button className="text-danger" onClick={() => void deleteQuote(quote.id).then(onChanged)}>Удалить</button></article>)}</section> : <section className="empty-state compact"><h2>Цитат пока нет</h2><p>Выделите текст в EPUB, FB2 или TXT и сохраните его прямо из ридера.</p></section>}</main>
}

function startOfDay(timestamp: number) { const date = new Date(timestamp); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() }

function StatsView({ sessions, books, settings }: { sessions: ReadingSession[]; books: BookRecord[]; settings: ReaderSettings }) {
  const now = Date.now(); const today = startOfDay(now); const week = now - 7 * 86400000; const month = now - 30 * 86400000
  const todaySeconds = sessions.filter((row) => row.startedAt >= today).reduce((sum, row) => sum + row.durationSec, 0)
  const weekSeconds = sessions.filter((row) => row.startedAt >= week).reduce((sum, row) => sum + row.durationSec, 0)
  const monthSeconds = sessions.filter((row) => row.startedAt >= month).reduce((sum, row) => sum + row.durationSec, 0)
  const days = new Set(sessions.filter((row) => row.durationSec >= 60).map((row) => startOfDay(row.startedAt)))
  let streak = 0
  for (let cursor = today; days.has(cursor) || (cursor === today && days.has(cursor - 86400000)); cursor -= 86400000) { if (days.has(cursor)) streak += 1; else if (cursor === today) continue; else break }
  const goal = Math.max(1, settings.dailyGoalMinutes * 60)
  const finished = books.filter((book) => book.status === 'finished').length
  const recent = sessions.slice(0, 12)
  const perBook = new Map<string, number>(); sessions.forEach((row) => perBook.set(row.bookTitle, (perBook.get(row.bookTitle) ?? 0) + row.durationSec)); const favorite = [...perBook.entries()].sort((a, b) => b[1] - a[1])[0]
  return <main className="app-page"><header className="simple-header"><div className="eyebrow">Без слежки, просто цифры</div><h1>Статистика</h1><p>Считается локально по вашим сессиям чтения.</p></header><section className="goal-card"><div><span>Цель на сегодня</span><strong>{Math.round(todaySeconds / 60)} / {settings.dailyGoalMinutes} мин</strong></div><ProgressLine value={todaySeconds / goal} /></section><section className="stats-grid"><article><span>Серия</span><strong>{streak}</strong><small>дней подряд</small></article><article><span>7 дней</span><strong>{Math.round(weekSeconds / 60)}</strong><small>минут чтения</small></article><article><span>30 дней</span><strong>{Math.round(monthSeconds / 360) / 10}</strong><small>часов чтения</small></article><article><span>Завершено</span><strong>{finished}</strong><small>книг</small></article></section>{favorite && <section className="stat-highlight"><span>Больше всего времени</span><strong>{favorite[0]}</strong><small>{formatDuration(favorite[1])}</small></section>}<section className="history-section"><h2>История чтения</h2>{recent.length ? recent.map((row) => <article key={row.id}><div><strong>{row.bookTitle}</strong><span>{new Date(row.startedAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div><b>{formatDuration(row.durationSec)}</b><small>{row.pagesTurned} перелистываний</small></article>) : <p className="muted">После нескольких сессий здесь появится история.</p>}</section></main>
}

function SettingsView({ settings, collections, onSettingsChange, onCollectionsChanged, onBackupImported }: { settings: ReaderSettings; collections: CollectionRecord[]; onSettingsChange: (settings: ReaderSettings) => void; onCollectionsChanged: () => void; onBackupImported: () => void }) {
  const restoreRef = useRef<HTMLInputElement>(null)
  const [newCollection, setNewCollection] = useState('')
  const set = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => onSettingsChange({ ...settings, [key]: value })
  const addCollection = async () => { const name = newCollection.trim(); if (!name) return; await putCollection({ id: crypto.randomUUID(), name, createdAt: Date.now() }); setNewCollection(''); onCollectionsChanged() }
  const downloadBackup = async (includeFiles: boolean) => { const payload = await exportBackup(includeFiles); const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `chitalka-backup-${new Date().toISOString().slice(0, 10)}${includeFiles ? '-full' : '-meta'}.json`; a.click(); URL.revokeObjectURL(url) }
  const restore = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; await importBackup(JSON.parse(await file.text())); onBackupImported() }
  return <main className="app-page"><header className="simple-header"><div className="eyebrow">Локально и спокойно</div><h1>Настройки</h1><p>Никаких аккаунтов, облака, аналитики или внешних API.</p></header><section className="settings-card"><div className="settings-row"><span><strong>Цель чтения</strong><small>Сколько минут в день</small></span><input className="number-input" type="number" min="5" max="300" value={settings.dailyGoalMinutes} onChange={(event) => set('dailyGoalMinutes', Math.max(5, Number(event.target.value) || 30))} /></div><label className="settings-row"><span><strong>Анимация страниц</strong><small>Можно отключить для минимального движения</small></span><input type="checkbox" checked={settings.animations} onChange={(event) => set('animations', event.target.checked)} /></label><label className="settings-row"><span><strong>Wake Lock</strong><small>Не гасить экран во время чтения</small></span><input type="checkbox" checked={settings.wakeLock} onChange={(event) => set('wakeLock', event.target.checked)} /></label></section><section className="settings-card"><div className="card-heading"><div><strong>Полки</strong><small>Соберите книги по темам</small></div></div><form className="collection-form" onSubmit={(event) => { event.preventDefault(); void addCollection() }}><input value={newCollection} onChange={(event) => setNewCollection(event.target.value)} placeholder="Например, Философия" /><button>Добавить</button></form><div className="collection-list">{collections.map((item) => <div key={item.id}><span>{item.name}</span><button onClick={() => void deleteCollection(item.id).then(onCollectionsChanged)}>Удалить</button></div>)}</div></section><section className="settings-card"><div className="card-heading"><div><strong>Резервная копия</strong><small>JSON можно сохранить в «Файлы» и восстановить позже</small></div></div><div className="backup-actions"><button onClick={() => void downloadBackup(false)}>Метаданные</button><button onClick={() => void downloadBackup(true)}>Полная копия с книгами</button><button onClick={() => restoreRef.current?.click()}>Восстановить</button><input ref={restoreRef} type="file" className="visually-hidden" accept="application/json,.json" onChange={(event) => void restore(event)} /></div><p className="settings-footnote">Полная копия может быть большой: сами EPUB/PDF/FB2/TXT кодируются внутрь JSON. Зато это действительно резервная копия, а не философская концепция резервной копии.</p></section><section className="privacy-card"><strong>Приватность</strong><p>Книги, прогресс, цитаты, заметки, полки и статистика сохраняются в IndexedDB этого браузера. Приложение не отправляет содержимое книг на сервер.</p></section></main>
}

function BottomNav({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const items: Array<[Tab, string, string]> = [['library', '▤', 'Библиотека'], ['quotes', '“', 'Цитаты'], ['stats', '◫', 'Статистика'], ['settings', '⚙', 'Настройки']]
  return <nav className="bottom-nav">{items.map(([value, icon, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => onTab(value)}><i>{icon}</i><span>{label}</span></button>)}</nav>
}

export default function App() {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [progress, setProgress] = useState<ReadingProgress[]>([])
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [sessions, setSessions] = useState<ReadingSession[]>([])
  const [collections, setCollections] = useState<CollectionRecord[]>([])
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [activeBook, setActiveBook] = useState<BookRecord | null>(null)
  const [detailBook, setDetailBook] = useState<BookRecord | null>(null)
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('library')
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState('')
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)

  const reload = useCallback(async () => {
    const [nextBooks, nextProgress, nextQuotes, nextSessions, nextCollections, nextSettings] = await Promise.all([getBooks(), getAllProgress(), getQuotes(), getSessions(), getCollections(), getSettings()])
    setBooks(nextBooks); setProgress(nextProgress); setQuotes(nextQuotes); setSessions(nextSessions); setCollections(nextCollections); setSettings(nextSettings)
    setActiveBook((current) => current ? nextBooks.find((book) => book.id === current.id) ?? current : null)
    setDetailBook((current) => current ? nextBooks.find((book) => book.id === current.id) ?? null : null)
  }, [])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { const handler = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent) }; window.addEventListener('beforeinstallprompt', handler); return () => window.removeEventListener('beforeinstallprompt', handler) }, [])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(''), 3200); return () => clearTimeout(id) }, [toast])
  const progressMap = useMemo(() => new Map(progress.map((row) => [row.bookId, row])), [progress])

  const updateSettings = async (next: ReaderSettings) => { setSettings(next); await saveSettings(next) }
  const importFiles = async (files: File[]) => {
    setImporting(true); let added = 0; const errors: string[] = []
    for (const file of files) { try { await putBook(await importBook(file)); added += 1 } catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : 'ошибка'}`) } }
    setImporting(false); await reload(); setToast(errors.length ? `Добавлено ${added}. Не удалось: ${errors.slice(0, 2).join('; ')}` : added > 1 ? `Добавлено книг: ${added}` : 'Книга добавлена')
  }
  const openBook = async (book: BookRecord) => { await touchBook(book.id); setActiveBook({ ...book, lastOpenedAt: Date.now(), status: book.status === 'finished' ? 'finished' : 'reading' }); setTab('library'); void reload() }
  const openQuote = async (quote: QuoteRecord) => { const book = books.find((item) => item.id === quote.bookId); if (!book) return; await saveProgress({ bookId: book.id, location: quote.location, percentage: quote.percentage, updatedAt: Date.now() }); await openBook(book) }
  const removeBook = async (book: BookRecord) => { if (!window.confirm(`Удалить «${book.title}»? Будут удалены прогресс, цитаты, закладки и история этой книги.`)) return; await deleteBook(book.id); setDetailBook(null); if (activeBook?.id === book.id) setActiveBook(null); await reload() }

  if (activeBook) return <><BookReader book={activeBook} settings={settings} onExit={() => { setActiveBook(null); setReaderSettingsOpen(false); void reload() }} onSettings={() => setReaderSettingsOpen(true)} onDataChanged={reload} />{readerSettingsOpen && <ReaderSettingsSheet settings={settings} fixedLayout={activeBook.format === 'pdf'} onChange={(next) => void updateSettings(next)} onClose={() => setReaderSettingsOpen(false)} />}{toast && <div className="toast">{toast}</div>}</>

  return <div className="app-shell">
    {tab === 'library' && <LibraryView books={books} progressMap={progressMap} collections={collections} importing={importing} onImport={importFiles} onOpen={(book) => void openBook(book)} onDetails={setDetailBook} settings={settings} onSettingsChange={(next) => void updateSettings(next)} installPrompt={installPrompt} />}
    {tab === 'quotes' && <QuotesView quotes={quotes} books={books} onChanged={() => void reload()} onOpenQuote={(quote) => void openQuote(quote)} />}
    {tab === 'stats' && <StatsView sessions={sessions} books={books} settings={settings} />}
    {tab === 'settings' && <SettingsView settings={settings} collections={collections} onSettingsChange={(next) => void updateSettings(next)} onCollectionsChanged={() => void reload()} onBackupImported={() => { void reload(); setToast('Резервная копия восстановлена') }} />}
    <BottomNav tab={tab} onTab={setTab} />
    {detailBook && <BookDetailSheet book={detailBook} progress={progressMap.get(detailBook.id)} collections={collections} onClose={() => setDetailBook(null)} onChanged={() => void reload()} onDelete={() => void removeBook(detailBook)} />}
    {toast && <div className="toast">{toast}</div>}
  </div>
}
