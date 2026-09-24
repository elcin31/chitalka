import type { TocItem } from './types'

export interface TextPage {
  text: string
  start: number
}

export interface TextDocumentData {
  text: string
  toc: TocItem[]
}

export function normalizeText(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function txtToDocument(text: string): TextDocumentData {
  const normalized = normalizeText(text)
  const toc: TocItem[] = []
  let cursor = 0
  for (const block of normalized.split(/\n\s*\n/)) {
    const trimmed = block.trim()
    const isHeading = trimmed.length > 2 && trimmed.length < 90 && (
      /^((глава|часть|chapter|part)\s+[\divxlc]+)/i.test(trimmed) ||
      /^[А-ЯЁA-Z0-9][А-ЯЁA-Z0-9\s:.,!?—-]{3,}$/.test(trimmed)
    )
    if (isHeading) {
      toc.push({ id: crypto.randomUUID(), label: trimmed.slice(0, 80), location: `char:${cursor}` })
    }
    cursor += block.length + 2
  }
  return { text: normalized, toc }
}

export function fb2ToDocument(xml: string): TextDocumentData {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Не удалось разобрать FB2')
  const body = doc.getElementsByTagName('body')[0]
  if (!body) return { text: '', toc: [] }
  const blocks = Array.from(body.querySelectorAll('title, p, subtitle, poem, cite'))
  const parts: string[] = []
  const toc: TocItem[] = []
  let offset = 0
  for (const node of blocks) {
    const value = node.textContent?.replace(/\s+/g, ' ').trim() || ''
    if (!value) continue
    const tag = node.tagName.toLowerCase()
    const prefix = parts.length ? '\n\n' : ''
    offset += prefix.length
    if (tag === 'title') {
      toc.push({ id: crypto.randomUUID(), label: value.slice(0, 90), location: `char:${offset}` })
    }
    parts.push(`${prefix}${value}`)
    offset += value.length
  }
  return { text: parts.join(''), toc }
}

export function paginateText(text: string, targetChars: number): TextPage[] {
  const normalized = normalizeText(text)
  if (!normalized) return [{ text: '', start: 0 }]
  const pages: TextPage[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + targetChars)
    if (end < normalized.length) {
      const min = Math.min(normalized.length, start + Math.floor(targetChars * 0.62))
      const paragraphBreak = normalized.lastIndexOf('\n\n', end)
      const sentenceBreak = Math.max(
        normalized.lastIndexOf('. ', end),
        normalized.lastIndexOf('! ', end),
        normalized.lastIndexOf('? ', end)
      )
      const spaceBreak = normalized.lastIndexOf(' ', end)
      if (paragraphBreak >= min) end = paragraphBreak + 2
      else if (sentenceBreak >= min) end = sentenceBreak + 2
      else if (spaceBreak >= min) end = spaceBreak + 1
    }
    const pageText = normalized.slice(start, end).trim()
    pages.push({ text: pageText, start })
    start = Math.max(end, start + 1)
  }
  return pages
}

export function pageForChar(pages: TextPage[], offset: number) {
  if (!pages.length) return 0
  let low = 0
  let high = pages.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (pages[mid].start <= offset) low = mid + 1
    else high = mid - 1
  }
  return Math.max(0, Math.min(high, pages.length - 1))
}

export function attachPagesToToc(toc: TocItem[], pages: TextPage[]) {
  return toc.map((item) => {
    const offset = item.location.startsWith('char:') ? Number(item.location.slice(5)) : 0
    const page = pageForChar(pages, Number.isFinite(offset) ? offset : 0)
    return { ...item, page, location: `page:${page}` }
  })
}

export function searchText(text: string, pages: TextPage[], query: string) {
  const term = query.trim().toLocaleLowerCase('ru')
  if (!term) return []
  const source = text.toLocaleLowerCase('ru')
  const results: Array<{ index: number; page: number; excerpt: string }> = []
  let from = 0
  while (results.length < 60) {
    const index = source.indexOf(term, from)
    if (index < 0) break
    const page = pageForChar(pages, index)
    const left = Math.max(0, index - 58)
    const right = Math.min(text.length, index + term.length + 90)
    results.push({ index, page, excerpt: text.slice(left, right).replace(/\s+/g, ' ').trim() })
    from = index + Math.max(term.length, 1)
  }
  return results
}

export function hashHue(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

export function formatDuration(seconds: number) {
  const minutes = Math.max(0, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}

export function estimateMinutesLeft(size: number, percentage: number, format: string) {
  const divisor = format === 'pdf' ? 52000 : format === 'epub' ? 36000 : 28000
  const total = Math.max(8, Math.round(size / divisor))
  return Math.max(1, Math.round(total * Math.max(0, 1 - percentage)))
}

export function formatDate(timestamp?: number) {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(timestamp)
}
