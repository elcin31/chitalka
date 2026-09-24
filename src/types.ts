export type BookFormat = 'epub' | 'fb2' | 'txt' | 'pdf'
export type ReaderTheme = 'light' | 'dark' | 'sepia'
export type FontFamily = 'serif' | 'sans'

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
  cover?: string
  file: Blob
}

export interface ReadingProgress {
  bookId: string
  location: string
  percentage: number
  updatedAt: number
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ReaderTheme
  fontFamily: FontFamily
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 20,
  lineHeight: 1.65,
  theme: 'light',
  fontFamily: 'serif'
}
