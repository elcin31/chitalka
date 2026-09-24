export type BookFormat = 'epub' | 'fb2' | 'txt' | 'pdf'
export type ReaderTheme = 'system' | 'light' | 'paper' | 'warm' | 'sepia' | 'dark' | 'oled'
export type FontFamily = 'serif' | 'sans'
export type TextAlign = 'left' | 'justify'
export type MarginSize = 'narrow' | 'normal' | 'wide'
export type BookStatus = 'not-started' | 'reading' | 'finished'
export type LibrarySort = 'recent' | 'added' | 'title' | 'author' | 'progress'

export interface BookRecord {
  id: string
  title: string
  author: string
  format: BookFormat
  fileName: string
  mimeType: string
  size: number
  addedAt: number
  lastOpenedAt?: number
  finishedAt?: number
  cover?: string
  file: Blob
  favorite?: boolean
  status?: BookStatus
  collectionIds?: string[]
}

export interface ReadingProgress {
  bookId: string
  location: string
  percentage: number
  updatedAt: number
  chapterTitle?: string
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ReaderTheme
  fontFamily: FontFamily
  textAlign: TextAlign
  marginSize: MarginSize
  fontWeight: number
  letterSpacing: number
  brightness: number
  animations: boolean
  wakeLock: boolean
  dailyGoalMinutes: number
  installHintDismissed: boolean
}

export interface Bookmark {
  id: string
  bookId: string
  bookTitle: string
  location: string
  percentage: number
  excerpt?: string
  label?: string
  createdAt: number
}

export interface QuoteRecord {
  id: string
  bookId: string
  bookTitle: string
  text: string
  location: string
  percentage: number
  note?: string
  createdAt: number
}

export interface ReadingSession {
  id: string
  bookId: string
  bookTitle: string
  startedAt: number
  endedAt: number
  durationSec: number
  pagesTurned: number
}

export interface CollectionRecord {
  id: string
  name: string
  createdAt: number
}

export interface SearchResult {
  id: string
  label: string
  location: string
  percentage?: number
  page?: number
  excerpt?: string
}

export interface TocItem {
  id: string
  label: string
  location: string
  page?: number
  level?: number
}

export interface BackupPayload {
  version: 2
  exportedAt: number
  includesFiles: boolean
  books: Array<Omit<BookRecord, 'file'> & { fileBase64?: string }>
  progress: ReadingProgress[]
  settings: ReaderSettings
  bookmarks: Bookmark[]
  quotes: QuoteRecord[]
  sessions: ReadingSession[]
  collections: CollectionRecord[]
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 20,
  lineHeight: 1.65,
  theme: 'system',
  fontFamily: 'serif',
  textAlign: 'left',
  marginSize: 'normal',
  fontWeight: 400,
  letterSpacing: 0,
  brightness: 100,
  animations: true,
  wakeLock: true,
  dailyGoalMinutes: 30,
  installHintDismissed: false
}
