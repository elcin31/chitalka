import { openDB, type DBSchema } from 'idb'
import type { BookRecord, ReaderSettings, ReadingProgress } from './types'
import { DEFAULT_SETTINGS } from './types'

interface ChitalkaDB extends DBSchema {
  books: {
    key: string
    value: BookRecord
    indexes: { 'by-addedAt': number }
  }
  progress: {
    key: string
    value: ReadingProgress
  }
  settings: {
    key: string
    value: ReaderSettings & { id: string }
  }
}

const dbPromise = openDB<ChitalkaDB>('chitalka-db', 1, {
  upgrade(db) {
    const books = db.createObjectStore('books', { keyPath: 'id' })
    books.createIndex('by-addedAt', 'addedAt')
    db.createObjectStore('progress', { keyPath: 'bookId' })
    db.createObjectStore('settings', { keyPath: 'id' })
  }
})

export async function getBooks() {
  const db = await dbPromise
  const books = await db.getAllFromIndex('books', 'by-addedAt')
  return books.reverse()
}

export async function getBook(id: string) {
  return (await dbPromise).get('books', id)
}

export async function putBook(book: BookRecord) {
  await (await dbPromise).put('books', book)
}

export async function deleteBook(id: string) {
  const db = await dbPromise
  const tx = db.transaction(['books', 'progress'], 'readwrite')
  await Promise.all([tx.objectStore('books').delete(id), tx.objectStore('progress').delete(id), tx.done])
}

export async function touchBook(id: string) {
  const book = await getBook(id)
  if (!book) return
  await putBook({ ...book, lastOpenedAt: Date.now() })
}

export async function getProgress(bookId: string) {
  return (await dbPromise).get('progress', bookId)
}

export async function saveProgress(progress: ReadingProgress) {
  await (await dbPromise).put('progress', progress)
}

export async function getSettings(): Promise<ReaderSettings> {
  const value = await (await dbPromise).get('settings', 'reader')
  if (!value) return DEFAULT_SETTINGS
  const { id: _id, ...settings } = value
  return settings
}

export async function saveSettings(settings: ReaderSettings) {
  await (await dbPromise).put('settings', { id: 'reader', ...settings })
}
