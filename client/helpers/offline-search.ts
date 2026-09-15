import { OfflineSearchDocumentV1Schema, OFFLINE_SNAPSHOT_LIMIT, type OfflineSearchDocumentV1 } from '../../shared/offline.ts'

export const OFFLINE_SEARCH_RESULT_LIMIT = 50
export const OFFLINE_SEARCH_DOCUMENT_LIMIT = OFFLINE_SNAPSHOT_LIMIT

export type OfflineSearchMatch = 'exact-title' | 'title-prefix' | 'title-token' | 'description' | 'body'

export type OfflineSearchResult = {
  document: OfflineSearchDocumentV1
  score: number
}

export type OfflineSearchOptions = {
  signal?: AbortSignal
  limit?: number
}

const EXACT_TITLE_SCORE = 1_000_000_000
const TITLE_PREFIX_SCORE = 800_000_000
const TITLE_TOKEN_SCORE = 600_000_000
const DESCRIPTION_SCORE = 400_000_000
const BODY_SCORE = 100_000_000
const BODY_TERM_SCORE = 10_000

/**
 * Normalize only the plain text fields that are admitted to the downloaded index.
 * This intentionally does not parse markup or infer server-side search syntax.
 */
export const normalizeOfflineSearchText = (value: string): string =>
  [...value.normalize('NFKC')]
    .map(character => (character.charCodeAt(0) <= 0x1f || (character.charCodeAt(0) >= 0x7f && character.charCodeAt(0) <= 0x9f) ? ' ' : character))
    .join('')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()

const tokenize = (value: string): string[] => value.match(/[\p{L}\p{N}]+/gu) ?? []

const countTerm = (haystack: string, term: string): number => {
  if (!term || !haystack) return 0
  let count = 0
  let offset = 0
  while (offset < haystack.length) {
    const index = haystack.indexOf(term, offset)
    if (index < 0) break
    count += 1
    offset = index + Math.max(term.length, 1)
    // A very repetitive local record must not make ranking unbounded.
    if (count >= 10_000) return count
  }
  return count
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareDocuments = (left: OfflineSearchResult, right: OfflineSearchResult): number => {
  if (left.score !== right.score) return right.score - left.score
  const titleOrder = compareText(normalizeOfflineSearchText(left.document.title), normalizeOfflineSearchText(right.document.title))
  if (titleOrder !== 0) return titleOrder
  const localeOrder = compareText(normalizeOfflineSearchText(left.document.locale), normalizeOfflineSearchText(right.document.locale))
  if (localeOrder !== 0) return localeOrder
  if (left.document.pageId !== right.document.pageId) return left.document.pageId - right.document.pageId
  const siteOrder = compareText(left.document.siteId, right.document.siteId)
  if (siteOrder !== 0) return siteOrder
  return compareText(left.document.path, right.document.path)
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  if (typeof DOMException !== 'undefined') throw new DOMException('The offline search was cancelled.', 'AbortError')
  const error = new Error('The offline search was cancelled.')
  error.name = 'AbortError'
  throw error
}

const boundedLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return OFFLINE_SEARCH_RESULT_LIMIT
  return Math.max(0, Math.min(OFFLINE_SEARCH_RESULT_LIMIT, Math.floor(value)))
}

const identityFor = (document: OfflineSearchDocumentV1): string => `${document.siteId}\u0000${document.pageId}\u0000${document.locale}`

const scoreDocument = (document: OfflineSearchDocumentV1, normalizedQuery: string, queryTerms: string[]): OfflineSearchResult => {
  const title = normalizeOfflineSearchText(document.title)
  const description = normalizeOfflineSearchText(document.description)
  const body = normalizeOfflineSearchText(document.searchText)
  const titleTerms = tokenize(title)
  const descriptionTerms = tokenize(description)
  const titleExact = title === normalizedQuery
  const titlePrefix = !titleExact && title.startsWith(normalizedQuery)
  const titleToken =
    !titleExact && !titlePrefix && queryTerms.some(queryTerm => titleTerms.some(titleTerm => titleTerm === queryTerm || titleTerm.startsWith(queryTerm)))
  const descriptionHit =
    !titleExact &&
    !titlePrefix &&
    !titleToken &&
    (description.includes(normalizedQuery) || queryTerms.some(queryTerm => descriptionTerms.some(term => term.startsWith(queryTerm))))

  let score = BODY_SCORE
  if (titleExact) score = EXACT_TITLE_SCORE
  else if (titlePrefix) score = TITLE_PREFIX_SCORE
  else if (titleToken) score = TITLE_TOKEN_SCORE
  else if (descriptionHit) score = DESCRIPTION_SCORE
  else {
    const phraseCount = countTerm(body, normalizedQuery)
    const termCount = queryTerms.reduce((total, term) => total + countTerm(body, term), 0)
    score += Math.min(phraseCount, 100) * BODY_TERM_SCORE * 2 + Math.min(termCount, 100) * BODY_TERM_SCORE
    // Body frequency is only a tie breaker within the body-match tier.
    score += Math.min(
      queryTerms.reduce((total, term) => total + countTerm(body, ` ${term} `), 0),
      100
    )
  }

  return { document, score }
}

const prepareDocuments = (documents: readonly OfflineSearchDocumentV1[]): OfflineSearchDocumentV1[] => {
  const unique = new Map<string, OfflineSearchDocumentV1>()
  for (const candidate of documents) {
    const parsed = OfflineSearchDocumentV1Schema.safeParse(candidate)
    if (!parsed.success) continue
    const identity = identityFor(parsed.data)
    if (!unique.has(identity)) unique.set(identity, parsed.data)
    if (unique.size >= OFFLINE_SEARCH_DOCUMENT_LIMIT) break
  }
  return [...unique.values()]
}

/**
 * Rank a bounded set of downloaded-only search documents synchronously.
 * Invalid or duplicate records are ignored rather than becoming a second data source.
 */
export const searchOfflineDocuments = (
  documents: readonly OfflineSearchDocumentV1[],
  query = '',
  options: OfflineSearchOptions = {}
): OfflineSearchResult[] => {
  throwIfAborted(options.signal)
  const maxResults = boundedLimit(options.limit)
  const normalizedQuery = normalizeOfflineSearchText(query.slice(0, 512))
  const prepared = prepareDocuments(documents)
  if (!normalizedQuery) {
    return prepared
      .map(document => ({ document, score: 0 }))
      .sort(compareDocuments)
      .slice(0, maxResults)
  }
  const queryTerms = [...new Set(tokenize(normalizedQuery))]
  if (queryTerms.length === 0) return []
  return prepared
    .filter(document => {
      const haystack = `${normalizeOfflineSearchText(document.title)} ${normalizeOfflineSearchText(document.description)} ${normalizeOfflineSearchText(document.searchText)}`
      return haystack.includes(normalizedQuery) || queryTerms.some(term => haystack.includes(term))
    })
    .map(document => scoreDocument(document, normalizedQuery, queryTerms))
    .sort(compareDocuments)
    .slice(0, maxResults)
}

/**
 * Yield between small batches so a new keystroke can cancel stale ranking work.
 * The corpus remains bounded even when callers pass an unexpectedly large array.
 */
export const searchOfflineDocumentsAsync = async (
  documents: readonly OfflineSearchDocumentV1[],
  query = '',
  options: OfflineSearchOptions = {}
): Promise<OfflineSearchResult[]> => {
  throwIfAborted(options.signal)
  const maxResults = boundedLimit(options.limit)
  const normalizedQuery = normalizeOfflineSearchText(query.slice(0, 512))
  const prepared = prepareDocuments(documents)
  if (!normalizedQuery) {
    return prepared
      .map(document => ({ document, score: 0 }))
      .sort(compareDocuments)
      .slice(0, maxResults)
  }
  const queryTerms = [...new Set(tokenize(normalizedQuery))]
  if (queryTerms.length === 0) return []

  const results: OfflineSearchResult[] = []
  for (let index = 0; index < prepared.length; index += 1) {
    throwIfAborted(options.signal)
    const document = prepared[index]
    const haystack = `${normalizeOfflineSearchText(document.title)} ${normalizeOfflineSearchText(document.description)} ${normalizeOfflineSearchText(document.searchText)}`
    if (haystack.includes(normalizedQuery) || queryTerms.some(term => haystack.includes(term)))
      results.push(scoreDocument(document, normalizedQuery, queryTerms))
    if (index % 16 === 15) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throwIfAborted(options.signal)
  return results.sort(compareDocuments).slice(0, maxResults)
}
