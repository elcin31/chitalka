import ePub from 'epubjs'
import * as pdfjsLib from 'pdfjs-dist'
import type { BookFormat, BookRecord } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

function extensionOf(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function detectFormat(file: File): BookFormat | null {
  const ext = extensionOf(file.name)
  if (ext === 'epub' || ext === 'fb2' || ext === 'txt' || ext === 'pdf') return ext
  return null
}

function authorToString(author: Element | null) {
  if (!author) return ''
  const pieces = ['first-name', 'middle-name', 'last-name']
    .map((tag) => author.getElementsByTagName(tag)[0]?.textContent?.trim())
    .filter(Boolean)
  return pieces.join(' ')
}

export function parseFb2(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Не удалось разобрать FB2')
  const titleInfo = doc.getElementsByTagName('title-info')[0]
  const title = titleInfo?.getElementsByTagName('book-title')[0]?.textContent?.trim() || 'Без названия'
  const author = authorToString(titleInfo?.getElementsByTagName('author')[0] ?? null) || 'Неизвестный автор'
  const coverImage = titleInfo?.getElementsByTagName('coverpage')[0]?.getElementsByTagName('image')[0]
  const href = coverImage?.getAttribute('l:href') || coverImage?.getAttribute('xlink:href') || coverImage?.getAttribute('href')
  let cover: string | undefined
  if (href?.startsWith('#')) {
    const binary = Array.from(doc.getElementsByTagName('binary')).find((node) => node.getAttribute('id') === href.slice(1))
    const type = binary?.getAttribute('content-type') || 'image/jpeg'
    const base64 = binary?.textContent?.replace(/\s+/g, '')
    if (base64) cover = `data:${type};base64,${base64}`
  }
  return { title, author, cover }
}

export function decodeXml(buffer: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1251').decode(buffer)
  }
}

export function decodeTxt(buffer: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1251').decode(buffer)
  }
}

async function pdfMeta(file: File) {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const meta = await pdf.getMetadata().catch(() => null)
  const info = (meta?.info ?? {}) as Record<string, unknown>
  const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : file.name.replace(/\.pdf$/i, '')
  const author = typeof info.Author === 'string' && info.Author.trim() ? info.Author.trim() : 'Неизвестный автор'
  let cover: string | undefined
  try {
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 0.55 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const context = canvas.getContext('2d')
    if (context) {
      await page.render({ canvasContext: context, viewport }).promise
      cover = canvas.toDataURL('image/jpeg', 0.82)
    }
  } catch {
    // Cover is optional.
  }
  await pdf.destroy()
  return { title, author, cover }
}

async function epubMeta(file: File) {
  const buffer = await file.arrayBuffer()
  const book = ePub(buffer)
  await book.ready
  const meta = await book.loaded.metadata
  let cover: string | undefined
  try {
    const coverUrl = await book.coverUrl()
    if (coverUrl) {
      const response = await fetch(coverUrl)
      const blob = await response.blob()
      cover = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    }
  } catch {
    // Cover is optional.
  }
  book.destroy()
  return {
    title: meta.title?.trim() || file.name.replace(/\.epub$/i, ''),
    author: meta.creator?.trim() || 'Неизвестный автор',
    cover
  }
}

export async function importBook(file: File): Promise<BookRecord> {
  const format = detectFormat(file)
  if (!format) throw new Error('Поддерживаются только EPUB, FB2, TXT и PDF')

  let title = file.name.replace(/\.[^.]+$/, '')
  let author = 'Неизвестный автор'
  let cover: string | undefined

  if (format === 'fb2') {
    const parsed = parseFb2(decodeXml(await file.arrayBuffer()))
    title = parsed.title
    author = parsed.author
    cover = parsed.cover
  } else if (format === 'pdf') {
    const parsed = await pdfMeta(file)
    title = parsed.title
    author = parsed.author
    cover = parsed.cover
  } else if (format === 'epub') {
    const parsed = await epubMeta(file)
    title = parsed.title
    author = parsed.author
    cover = parsed.cover
  }

  return {
    id: crypto.randomUUID(),
    title,
    author,
    format,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    addedAt: Date.now(),
    cover,
    file
  }
}
