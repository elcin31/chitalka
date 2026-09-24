import { openDB, type DBSchema } from 'idb'
import type {
  BackupPayload,
  BookRecord,
  Bookmark,
  CollectionRecord,
  QuoteRecord,
  ReaderSettings,
  ReadingProgress,
  ReadingSession
} from './types'
import { DEFAULT_SETTINGS } from './types'

interface ChitalkaDB extends DBSchema {
  books: {
    key: string
    value: BookRecord
    indexes: { 'by-addedAt': number; 'by-lastOpenedAt': number }
  }
  progress: {
    key: string
    value: ReadingProgress
  }
  settings: {
    key: string
    value: ReaderSettings & { id: string }
  }
  bookmarks: {
    key: string
    value: Bookmark
    indexes: { 'by-bookId': string; 'by-createdAt': number }
  }
  quotes: {
    key: string
    value: QuoteRecord
    indexes: { 'by-bookId': string; 'by-createdAt': number }
  }
  sessions: {
    key: string
    value: ReadingSession
    indexes: { 'by-bookId': string; 'by-startedAt': number }
  }
  collections: {
    key: string
    value: CollectionRecord
    indexes: { 'by-createdAt': number }
  }
}

const dbPromise = openDB<ChitalkaDB>('chitalka-db', 2, {
  upgrade(db, oldVersion, _newVersion, transaction) {
    if (oldVersion < 1) {
      const books = db.createObjectStore('books', { keyPath: 'id' })
      books.createIndex('by-addedAt', 'addedAt')
      books.createIndex('by-lastOpenedAt', 'lastOpenedAt')
      db.createObjectStore('progress', { keyPath: 'bookId' })
      db.createObjectStore('settings', { keyPath: 'id' })
    } else if (oldVersion < 2) {
      const books = transaction.objectStore('books')
      if (!books.indexNames.contains('by-lastOpenedAt')) books.createIndex('by-lastOpenedAt', 'lastOpenedAt')
    }

    if (!db.objectStoreNames.contains('bookmarks')) {
      const store = db.createObjectStore('bookmarks', { keyPath: 'id' })
      store.createIndex('by-bookId', 'bookId')
      store.createIndex('by-createdAt', 'createdAt')
    }
    if (!db.objectStoreNames.contains('quotes')) {
      const store = db.createObjectStore('quotes', { keyPath: 'id' })
      store.createIndex('by-bookId', 'bookId')
      store.createIndex('by-createdAt', 'createdAt')
    }
    if (!db.objectStoreNames.contains('sessions')) {
      const store = db.createObjectStore('sessions', { keyPath: 'id' })
      store.createIndex('by-bookId', 'bookId')
      store.createIndex('by-startedAt', 'startedAt')
    }
    if (!db.objectStoreNames.contains('collections')) {
      const store = db.createObjectStore('collections', { keyPath: 'id' })
      store.createIndex('by-createdAt', 'createdAt')
    }
  }
})

export async function getBooks() {
  const db = await dbPromise
  const books = await db.getAll('books')
  return books.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
}

export async function getBook(id: string) {
  return (await dbPromise).get('books', id)
}

export async function putBook(book: BookRecord) {
  await (await dbPromise).put('books', book)
}

export async function patchBook(id: string, patch: Partial<BookRecord>) {
  const book = await getBook(id)
  if (!book) return
  await putBook({ ...book, ...patch })
}

export async function deleteBook(id: string) {
  const db = await dbPromise
  const tx = db.transaction(['books', 'progress', 'bookmarks', 'quotes', 'sessions'], 'readwrite')
  const bookmarkKeys = await tx.objectStore('bookmarks').index('by-bookId').getAllKeys(id)
  const quoteKeys = await tx.objectStore('quotes').index('by-bookId').getAllKeys(id)
  const sessionKeys = await tx.objectStore('sessions').index('by-bookId').getAllKeys(id)
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('progress').delete(id),
    ...bookmarkKeys.map((key) => tx.objectStore('bookmarks').delete(key)),
    ...quoteKeys.map((key) => tx.objectStore('quotes').delete(key)),
    ...sessionKeys.map((key) => tx.objectStore('sessions').delete(key))
  ])
  await tx.done
}

export async function touchBook(id: string) {
  const book = await getBook(id)
  if (!book) return
  await putBook({ ...book, lastOpenedAt: Date.now(), status: book.status === 'finished' ? 'finished' : 'reading' })
}

export async function getProgress(bookId: string) {
  return (await dbPromise).get('progress', bookId)
}

export async function getAllProgress() {
  return (await dbPromise).getAll('progress')
}

export async function saveProgress(progress: ReadingProgress) {
  const db = await dbPromise
  const tx = db.transaction(['progress', 'books'], 'readwrite')
  await tx.objectStore('progress').put(progress)
  const book = await tx.objectStore('books').get(progress.bookId)
  if (book) {
    const finished = progress.percentage >= 0.985
    await tx.objectStore('books').put({
      ...book,
      status: finished ? 'finished' : progress.percentage > 0 ? 'reading' : (book.status ?? 'not-started'),
      finishedAt: finished ? (book.finishedAt ?? Date.now()) : book.finishedAt
    })
  }
  await tx.done
}

export async function getSettings(): Promise<ReaderSettings> {
  const value = await (await dbPromise).get('settings', 'reader')
  if (!value) return { ...DEFAULT_SETTINGS }
  const { id: _id, ...settings } = value
  return { ...DEFAULT_SETTINGS, ...settings }
}

export async function saveSettings(settings: ReaderSettings) {
  await (await dbPromise).put('settings', { id: 'reader', ...settings })
}

export async function getBookmarks(bookId?: string) {
  const db = await dbPromise
  const rows = bookId
    ? await db.getAllFromIndex('bookmarks', 'by-bookId', bookId)
    : await db.getAll('bookmarks')
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putBookmark(bookmark: Bookmark) {
  await (await dbPromise).put('bookmarks', bookmark)
}

export async function deleteBookmark(id: string) {
  await (await dbPromise).delete('bookmarks', id)
}

export async function getQuotes(bookId?: string) {
  const db = await dbPromise
  const rows = bookId
    ? await db.getAllFromIndex('quotes', 'by-bookId', bookId)
    : await db.getAll('quotes')
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putQuote(quote: QuoteRecord) {
  await (await dbPromise).put('quotes', quote)
}

export async function deleteQuote(id: string) {
  await (await dbPromise).delete('quotes', id)
}

export async function getSessions() {
  const rows = await (await dbPromise).getAll('sessions')
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

export async function putSession(session: ReadingSession) {
  if (session.durationSec < 5) return
  await (await dbPromise).put('sessions', session)
}

export async function getCollections() {
  const rows = await (await dbPromise).getAll('collections')
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function putCollection(collection: CollectionRecord) {
  await (await dbPromise).put('collections', collection)
}

export async function deleteCollection(id: string) {
  const db = await dbPromise
  const tx = db.transaction(['collections', 'books'], 'readwrite')
  await tx.objectStore('collections').delete(id)
  const books = await tx.objectStore('books').getAll()
  await Promise.all(books.map((book) => {
    if (!book.collectionIds?.includes(id)) return Promise.resolve()
    return tx.objectStore('books').put({ ...book, collectionIds: book.collectionIds.filter((value) => value !== id) })
  }))
  await tx.done
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function exportBackup(includeFiles: boolean): Promise<BackupPayload> {
  const db = await dbPromise
  const [books, progress, settings, bookmarks, quotes, sessions, collections] = await Promise.all([
    db.getAll('books'),
    db.getAll('progress'),
    getSettings(),
    db.getAll('bookmarks'),
    db.getAll('quotes'),
    db.getAll('sessions'),
    db.getAll('collections')
  ])

  const encodedBooks: BackupPayload['books'] = []
  for (const book of books) {
    const { file, ...meta } = book
    encodedBooks.push({
      ...meta,
      fileBase64: includeFiles ? bytesToBase64(new Uint8Array(await file.arrayBuffer())) : undefined
    })
  }

  return {
    version: 2,
    exportedAt: Date.now(),
    includesFiles: includeFiles,
    books: encodedBooks,
    progress,
    settings,
    bookmarks,
    quotes,
    sessions,
    collections
  }
}

export async function importBackup(payload: BackupPayload) {
  if (!payload || payload.version !== 2 || !Array.isArray(payload.books)) {
    throw new Error('Неподдерживаемый файл резервной копии')
  }

  const db = await dbPromise
  const tx = db.transaction(['books', 'progress', 'settings', 'bookmarks', 'quotes', 'sessions', 'collections'], 'readwrite')
  for (const item of payload.books) {
    const { fileBase64, ...meta } = item
    if (!fileBase64) continue
    const bytes = base64ToBytes(fileBase64)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const file = new Blob([buffer], { type: meta.mimeType || 'application/octet-stream' })
    await tx.objectStore('books').put({ ...meta, file })
  }
  for (const row of payload.progress ?? []) await tx.objectStore('progress').put(row)
  await tx.objectStore('settings').put({ id: 'reader', ...DEFAULT_SETTINGS, ...(payload.settings ?? {}) })
  for (const row of payload.bookmarks ?? []) await tx.objectStore('bookmarks').put(row)
  for (const row of payload.quotes ?? []) await tx.objectStore('quotes').put(row)
  for (const row of payload.sessions ?? []) await tx.objectStore('sessions').put(row)
  for (const row of payload.collections ?? []) await tx.objectStore('collections').put(row)
  await tx.done
}
