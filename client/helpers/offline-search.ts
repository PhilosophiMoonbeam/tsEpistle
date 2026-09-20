import { OfflineSearchDocumentV1Schema, OFFLINE_SNAPSHOT_LIMIT, type OfflineSearchDocumentV1 } from '../../shared/offline.ts'

export const OFFLINE_SEARCH_RESULT_LIMIT = 50
export const OFFLINE_SEARCH_DOCUMENT_LIMIT = OFFLINE_SNAPSHOT_LIMIT
export const OFFLINE_SEARCH_QUERY_CHARACTER_LIMIT = 512
export const OFFLINE_SEARCH_QUERY_TERM_LIMIT = 32
export const OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT = 64 * 1024
export const OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS = 16 * 1024

export type OfflineSearchResult = {
  document: OfflineSearchDocumentV1
  score: number
}

export type OfflineSearchMatch = 'exact-title' | 'title-prefix' | 'title-token' | 'description' | 'body'

/**
 * Opaque normalized corpus prepared from one committed offline corpus revision.
 * Callers may retain this value for repeated queries, but must only pass it to
 * the prepared search functions below.
 */
const OFFLINE_SEARCH_CORPUS_BRAND: unique symbol = Symbol('offline-search-corpus')
export type OfflineSearchCorpus = {
  readonly [OFFLINE_SEARCH_CORPUS_BRAND]: true
}

/**
 * A bounded ranking response. `hasMore` is true only when a matching document
 * exists beyond the effective result limit, never merely because the corpus is
 * larger than that limit.
 */
export type OfflineSearchResponse = {
  results: OfflineSearchResult[]
  hasMore: boolean
}

export type OfflineSearchOptions = {
  signal?: AbortSignal
  limit?: number
}

export type OfflineSearchPreparationOptions = {
  signal?: AbortSignal
}

type PreparedOfflineSearchDocument = {
  document: OfflineSearchDocumentV1
  title: string
  description: string
  body: string
  titleTerms: string[]
  descriptionTerms: string[]
  titleOrder: string
  localeOrder: string
  siteOrder: string
  pathOrder: string
}

type PreparedOfflineSearchCorpus = OfflineSearchCorpus & {
  readonly documents: readonly PreparedOfflineSearchDocument[]
}

type RankedOfflineSearchDocument = {
  prepared: PreparedOfflineSearchDocument
  score: number
}
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
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareDocuments = (left: RankedOfflineSearchDocument, right: RankedOfflineSearchDocument): number => {
  if (left.score !== right.score) return right.score - left.score
  const leftDocument = left.prepared
  const rightDocument = right.prepared
  const titleOrder = compareText(leftDocument.titleOrder, rightDocument.titleOrder)
  if (titleOrder !== 0) return titleOrder
  const localeOrder = compareText(leftDocument.localeOrder, rightDocument.localeOrder)
  if (localeOrder !== 0) return localeOrder
  if (leftDocument.document.pageId !== rightDocument.document.pageId) return leftDocument.document.pageId - rightDocument.document.pageId
  const siteOrder = compareText(leftDocument.siteOrder, rightDocument.siteOrder)
  if (siteOrder !== 0) return siteOrder
  return compareText(leftDocument.pathOrder, rightDocument.pathOrder)
}

const EXACT_TITLE_SCORE = 1_000_000_000
const TITLE_PREFIX_SCORE = 800_000_000
const TITLE_TOKEN_SCORE = 600_000_000
const DESCRIPTION_SCORE = 400_000_000
const BODY_SCORE = 100_000_000
const BODY_TERM_SCORE = 10_000
const BODY_FREQUENCY_LIMIT = 100

/**
 * Search work is deliberately bounded in normalized UTF-16 code units:
 * each candidate consumes at most 64 KiB across its title, description,
 * field boundaries, and body, so the first 100 candidates consume at most
 * 6,553,600 scoring characters. Async scans yield and re-check cancellation
 * every 16 KiB; query normalization admits at most 512 characters and 32
 * unique terms.
 */

type SearchPatternKind = 'phrase' | 'term' | 'word'

type SearchPattern = {
  kind: SearchPatternKind
  text: string
}

type SearchAutomatonNode = {
  transitions: Map<number, number>
  failure: number
  outputs: number[]
}

type SearchAutomaton = {
  nodes: SearchAutomatonNode[]
  patterns: SearchPattern[]
  queryTermCount: number
}

type TextScan = {
  state: number
  charactersScanned: number
  hasPhrase: boolean
  hasTerm: boolean
  matchedTerms: boolean[]
  phraseCount: number
  termCount: number
  wordCount: number
  nextAllowed: number[]
}

/**
 * Keep a bounded string well-formed when a UTF-16 limit lands before a
 * surrogate pair. Prepared fields are normalized once; the query uses this
 * helper before and after normalization.
 */
const boundedText = (value: string, limit: number): string => {
  if (limit <= 0 || value.length === 0) return ''
  if (value.length <= limit) return value
  const last = value.charCodeAt(limit - 1)
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, limit - 1) : value.slice(0, limit)
}

const normalizeOfflineQuery = (query: string): { normalizedQuery: string; queryTerms: string[] } => {
  const boundedInput = boundedText(query, OFFLINE_SEARCH_QUERY_CHARACTER_LIMIT)
  const normalizedQuery = boundedText(normalizeOfflineSearchText(boundedInput), OFFLINE_SEARCH_QUERY_CHARACTER_LIMIT)
  const queryTerms = normalizedQuery ? [...new Set(tokenize(normalizedQuery))].slice(0, OFFLINE_SEARCH_QUERY_TERM_LIMIT) : []
  return { normalizedQuery, queryTerms }
}

const incrementBounded = (value: number): number => Math.min(value + 1, BODY_FREQUENCY_LIMIT)

const createSearchAutomaton = (normalizedQuery: string, queryTerms: string[]): SearchAutomaton => {
  const patterns: SearchPattern[] = [
    { kind: 'phrase', text: normalizedQuery },
    ...queryTerms.map(text => ({ kind: 'term' as const, text })),
    ...queryTerms.map(term => ({ kind: 'word' as const, text: ` ${term} ` }))
  ]
  const nodes: SearchAutomatonNode[] = [{ transitions: new Map(), failure: 0, outputs: [] }]

  for (const [patternIndex, pattern] of patterns.entries()) {
    let nodeIndex = 0
    for (let characterIndex = 0; characterIndex < pattern.text.length; characterIndex += 1) {
      const character = pattern.text.charCodeAt(characterIndex)
      let next = nodes[nodeIndex].transitions.get(character)
      if (next === undefined) {
        next = nodes.length
        nodes[nodeIndex].transitions.set(character, next)
        nodes.push({ transitions: new Map(), failure: 0, outputs: [] })
      }
      nodeIndex = next
    }
    nodes[nodeIndex].outputs.push(patternIndex)
  }

  const queue: number[] = [...nodes[0].transitions.values()]
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const nodeIndex = queue[queueIndex]
    const node = nodes[nodeIndex]
    for (const [character, next] of node.transitions) {
      queue.push(next)
      let failure = node.failure
      while (failure > 0 && !nodes[failure].transitions.has(character)) failure = nodes[failure].failure
      const fallback = nodes[failure].transitions.get(character)
      nodes[next].failure = fallback === undefined || fallback === next ? 0 : fallback
      nodes[next].outputs.push(...nodes[nodes[next].failure].outputs)
    }
  }

  return { nodes, patterns, queryTermCount: queryTerms.length }
}

const createTextScan = (patternCount: number, queryTermCount: number): TextScan => ({
  state: 0,
  charactersScanned: 0,
  hasPhrase: false,
  hasTerm: false,
  matchedTerms: new Array(queryTermCount).fill(false),
  phraseCount: 0,
  termCount: 0,
  wordCount: 0,
  nextAllowed: new Array(patternCount).fill(0)
})

const recordMatches = (automaton: SearchAutomaton, scan: TextScan, endIndex: number): void => {
  for (const patternIndex of automaton.nodes[scan.state].outputs) {
    const pattern = automaton.patterns[patternIndex]
    const startIndex = endIndex - pattern.text.length + 1
    if (startIndex < scan.nextAllowed[patternIndex]) continue
    scan.nextAllowed[patternIndex] = endIndex + 1
    if (pattern.kind === 'phrase') {
      scan.hasPhrase = true
      scan.phraseCount = incrementBounded(scan.phraseCount)
    } else {
      scan.hasTerm = true
      scan.matchedTerms[(patternIndex - 1) % automaton.queryTermCount] = true
      if (pattern.kind === 'term') scan.termCount = incrementBounded(scan.termCount)
      else scan.wordCount = incrementBounded(scan.wordCount)
    }
  }
}

const scanTextChunk = (automaton: SearchAutomaton, text: string, scan: TextScan, startIndex: number, endIndex: number, signal?: AbortSignal): void => {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (index === startIndex || index % OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS === 0) throwIfAborted(signal)
    const character = text.charCodeAt(index)
    let next = automaton.nodes[scan.state].transitions.get(character)
    while (scan.state > 0 && next === undefined) {
      scan.state = automaton.nodes[scan.state].failure
      next = automaton.nodes[scan.state].transitions.get(character)
    }
    scan.state = next ?? 0
    recordMatches(automaton, scan, index)
  }
}

const scanText = (automaton: SearchAutomaton, text: string, maxCharacters: number, signal?: AbortSignal): TextScan => {
  const scan = createTextScan(automaton.patterns.length, automaton.queryTermCount)
  const endIndex = Math.min(text.length, Math.max(0, maxCharacters))
  for (let startIndex = 0; startIndex < endIndex; startIndex += OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS) {
    const chunkEnd = Math.min(startIndex + OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS, endIndex)
    scanTextChunk(automaton, text, scan, startIndex, chunkEnd, signal)
  }
  throwIfAborted(signal)
  scan.charactersScanned = endIndex
  return scan
}

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const scanTextAsync = async (automaton: SearchAutomaton, text: string, maxCharacters: number, signal?: AbortSignal): Promise<TextScan> => {
  const scan = createTextScan(automaton.patterns.length, automaton.queryTermCount)
  const endIndex = Math.min(text.length, Math.max(0, maxCharacters))
  for (let startIndex = 0; startIndex < endIndex; startIndex += OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS) {
    const chunkEnd = Math.min(startIndex + OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS, endIndex)
    scanTextChunk(automaton, text, scan, startIndex, chunkEnd, signal)
    throwIfAborted(signal)
    if (chunkEnd < endIndex) await yieldToEventLoop()
  }
  throwIfAborted(signal)
  scan.charactersScanned = endIndex
  return scan
}

const scoreBody = (scan: TextScan): number => BODY_SCORE + scan.phraseCount * BODY_TERM_SCORE * 2 + scan.termCount * BODY_TERM_SCORE + scan.wordCount

const matchesEveryQueryTerm = (queryTerms: readonly string[], scans: readonly TextScan[]): boolean =>
  queryTerms.every((_term, index) => scans.some(scan => scan.matchedTerms[index]))

const scoreDocument = (
  prepared: PreparedOfflineSearchDocument,
  normalizedQuery: string,
  queryTerms: string[],
  automaton: SearchAutomaton,
  signal?: AbortSignal
): RankedOfflineSearchDocument | null => {
  const { title, description, body, titleTerms, descriptionTerms } = prepared
  const titleExact = title === normalizedQuery
  const titlePrefix = !titleExact && title.startsWith(normalizedQuery)
  const titleToken =
    !titleExact && !titlePrefix && queryTerms.every(queryTerm => titleTerms.some(titleTerm => titleTerm === queryTerm || titleTerm.startsWith(queryTerm)))
  if (titleExact) return { prepared, score: EXACT_TITLE_SCORE }
  if (titlePrefix) return { prepared, score: TITLE_PREFIX_SCORE }
  if (titleToken) return { prepared, score: TITLE_TOKEN_SCORE }

  let remainingCharacters = OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT
  const titleScan = scanText(automaton, title, remainingCharacters, signal)
  remainingCharacters -= titleScan.charactersScanned
  const scans = [titleScan]
  let metadataMatch = titleScan.hasPhrase || titleScan.hasTerm

  const descriptionToken = queryTerms.every(queryTerm => descriptionTerms.some(term => term.startsWith(queryTerm)))
  if (descriptionToken) return { prepared, score: DESCRIPTION_SCORE }
  const descriptionScan = scanText(automaton, description, remainingCharacters, signal)
  remainingCharacters -= descriptionScan.charactersScanned
  scans.push(descriptionScan)
  if (descriptionScan.hasPhrase) return { prepared, score: DESCRIPTION_SCORE }
  metadataMatch ||= descriptionScan.hasTerm

  if (!metadataMatch && remainingCharacters > 0) {
    const titleBoundary = `${title.slice(-normalizedQuery.length)} ${description.slice(0, normalizedQuery.length)}`
    const boundaryScan = scanText(automaton, titleBoundary, remainingCharacters, signal)
    remainingCharacters -= boundaryScan.charactersScanned
    scans.push(boundaryScan)
    metadataMatch ||= boundaryScan.hasPhrase || boundaryScan.hasTerm
  }
  if (!metadataMatch && remainingCharacters > 0) {
    const descriptionBoundary = `${description.slice(-normalizedQuery.length)} ${body.slice(0, normalizedQuery.length)}`
    const boundaryScan = scanText(automaton, descriptionBoundary, remainingCharacters, signal)
    remainingCharacters -= boundaryScan.charactersScanned
    scans.push(boundaryScan)
    metadataMatch ||= boundaryScan.hasPhrase || boundaryScan.hasTerm
  }

  const bodyScan = scanText(automaton, body, remainingCharacters, signal)
  scans.push(bodyScan)
  if (!matchesEveryQueryTerm(queryTerms, scans)) return null
  if (!metadataMatch && !bodyScan.hasPhrase && !bodyScan.hasTerm) return null
  return { prepared, score: scoreBody(bodyScan) }
}

const scoreDocumentAsync = async (
  prepared: PreparedOfflineSearchDocument,
  normalizedQuery: string,
  queryTerms: string[],
  automaton: SearchAutomaton,
  signal?: AbortSignal
): Promise<RankedOfflineSearchDocument | null> => {
  const { title, description, body, titleTerms, descriptionTerms } = prepared
  const titleExact = title === normalizedQuery
  const titlePrefix = !titleExact && title.startsWith(normalizedQuery)
  const titleToken =
    !titleExact && !titlePrefix && queryTerms.every(queryTerm => titleTerms.some(titleTerm => titleTerm === queryTerm || titleTerm.startsWith(queryTerm)))
  if (titleExact) return { prepared, score: EXACT_TITLE_SCORE }
  if (titlePrefix) return { prepared, score: TITLE_PREFIX_SCORE }
  if (titleToken) return { prepared, score: TITLE_TOKEN_SCORE }

  let remainingCharacters = OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT
  const titleScan = await scanTextAsync(automaton, title, remainingCharacters, signal)
  remainingCharacters -= titleScan.charactersScanned
  const scans = [titleScan]
  let metadataMatch = titleScan.hasPhrase || titleScan.hasTerm

  const descriptionToken = queryTerms.every(queryTerm => descriptionTerms.some(term => term.startsWith(queryTerm)))
  if (descriptionToken) return { prepared, score: DESCRIPTION_SCORE }
  const descriptionScan = await scanTextAsync(automaton, description, remainingCharacters, signal)
  remainingCharacters -= descriptionScan.charactersScanned
  scans.push(descriptionScan)
  if (descriptionScan.hasPhrase) return { prepared, score: DESCRIPTION_SCORE }
  metadataMatch ||= descriptionScan.hasTerm

  if (!metadataMatch && remainingCharacters > 0) {
    const titleBoundary = `${title.slice(-normalizedQuery.length)} ${description.slice(0, normalizedQuery.length)}`
    const boundaryScan = await scanTextAsync(automaton, titleBoundary, remainingCharacters, signal)
    remainingCharacters -= boundaryScan.charactersScanned
    scans.push(boundaryScan)
    metadataMatch ||= boundaryScan.hasPhrase || boundaryScan.hasTerm
  }
  if (!metadataMatch && remainingCharacters > 0) {
    const descriptionBoundary = `${description.slice(-normalizedQuery.length)} ${body.slice(0, normalizedQuery.length)}`
    const boundaryScan = await scanTextAsync(automaton, descriptionBoundary, remainingCharacters, signal)
    remainingCharacters -= boundaryScan.charactersScanned
    scans.push(boundaryScan)
    metadataMatch ||= boundaryScan.hasPhrase || boundaryScan.hasTerm
  }

  const bodyScan = await scanTextAsync(automaton, body, remainingCharacters, signal)
  scans.push(bodyScan)
  if (!matchesEveryQueryTerm(queryTerms, scans)) return null
  if (!metadataMatch && !bodyScan.hasPhrase && !bodyScan.hasTerm) return null
  return { prepared, score: scoreBody(bodyScan) }
}

const normalizePreparedField = (value: string, remainingCharacters: number): string => {
  const boundedInput = boundedText(value, remainingCharacters)
  return boundedText(normalizeOfflineSearchText(boundedInput), remainingCharacters)
}

const prepareDocument = (document: OfflineSearchDocumentV1, signal?: AbortSignal): PreparedOfflineSearchDocument => {
  throwIfAborted(signal)
  let remainingCharacters = OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT
  const title = normalizePreparedField(document.title, remainingCharacters)
  throwIfAborted(signal)
  remainingCharacters = Math.max(0, remainingCharacters - title.length)
  const description = normalizePreparedField(document.description, remainingCharacters)
  throwIfAborted(signal)
  remainingCharacters = Math.max(0, remainingCharacters - description.length)
  const body = normalizePreparedField(document.searchText, remainingCharacters)
  throwIfAborted(signal)
  return {
    document,
    title,
    description,
    body,
    titleTerms: tokenize(title),
    descriptionTerms: tokenize(description),
    titleOrder: title,
    localeOrder: normalizeOfflineSearchText(document.locale),
    siteOrder: document.siteId,
    pathOrder: document.path
  }
}

const prepareDocuments = async (documents: readonly OfflineSearchDocumentV1[], signal?: AbortSignal): Promise<PreparedOfflineSearchDocument[]> => {
  const unique = new Map<string, PreparedOfflineSearchDocument>()
  const candidateLimit = Math.min(documents.length, OFFLINE_SEARCH_DOCUMENT_LIMIT)
  for (let index = 0; index < candidateLimit; index += 1) {
    throwIfAborted(signal)
    const parsed = OfflineSearchDocumentV1Schema.safeParse(documents[index])
    if (parsed.success) {
      const document = parsed.data
      const identity = identityFor(document)
      if (!unique.has(identity)) {
        const prepared = prepareDocument(document, signal)
        throwIfAborted(signal)
        unique.set(identity, prepared)
      }
    }
    await yieldToEventLoop()
  }
  throwIfAborted(signal)
  return [...unique.values()]
}

/**
 * Prepare the first 100 input candidates into an immutable normalized corpus.
 * Validation and identity deduplication happen only within that candidate
 * window, so later duplicates or invalid records cannot admit candidate 101.
 * Preparation is asynchronous so a newer corpus revision can cancel bounded
 * normalization work before it publishes a corpus.
 */
export const prepareOfflineSearchCorpus = async (
  documents: readonly OfflineSearchDocumentV1[],
  options: OfflineSearchPreparationOptions = {}
): Promise<OfflineSearchCorpus> => {
  throwIfAborted(options.signal)
  const preparedDocuments = await prepareDocuments(documents, options.signal)
  throwIfAborted(options.signal)
  const corpus: PreparedOfflineSearchCorpus = {
    [OFFLINE_SEARCH_CORPUS_BRAND]: true,
    documents: Object.freeze(preparedDocuments)
  }
  return Object.freeze(corpus)
}

const preparedDocuments = (corpus: OfflineSearchCorpus): readonly PreparedOfflineSearchDocument[] => (corpus as PreparedOfflineSearchCorpus).documents

/**
 * Combine the public Guest corpus with a private corpus that was prepared
 * under the current reading handle. Private documents win identity
 * collisions so a stale/public projection can never hide the private route.
 */
export const mergeOfflineSearchCorpora = (...corpora: readonly (OfflineSearchCorpus | null | undefined)[]): OfflineSearchCorpus => {
  const unique = new Map<string, PreparedOfflineSearchDocument>()
  for (const corpus of corpora) {
    if (!corpus) continue
    for (const prepared of preparedDocuments(corpus)) {
      const identity = identityFor(prepared.document)
      unique.delete(identity)
      unique.set(identity, prepared)
    }
  }
  const merged: PreparedOfflineSearchCorpus = {
    [OFFLINE_SEARCH_CORPUS_BRAND]: true,
    documents: Object.freeze([...unique.values()])
  }
  return Object.freeze(merged)
}

const finishSearch = (ranked: RankedOfflineSearchDocument[], maxResults: number, signal?: AbortSignal): OfflineSearchResponse => {
  throwIfAborted(signal)
  ranked.sort(compareDocuments)
  throwIfAborted(signal)
  return {
    results: ranked.slice(0, maxResults).map(({ prepared, score }) => ({ document: prepared.document, score })),
    hasMore: ranked.length > maxResults
  }
}

const rankPreparedDocuments = (
  prepared: readonly PreparedOfflineSearchDocument[],
  normalizedQuery: string,
  queryTerms: string[],
  signal?: AbortSignal
): RankedOfflineSearchDocument[] => {
  const ranked: RankedOfflineSearchDocument[] = []
  if (!normalizedQuery) {
    for (const document of prepared) {
      throwIfAborted(signal)
      ranked.push({ prepared: document, score: 0 })
    }
    return ranked
  }

  const automaton = createSearchAutomaton(normalizedQuery, queryTerms)
  for (const document of prepared) {
    throwIfAborted(signal)
    const scored = scoreDocument(document, normalizedQuery, queryTerms, automaton, signal)
    if (scored) ranked.push(scored)
  }
  return ranked
}

const rankPreparedDocumentsAsync = async (
  prepared: readonly PreparedOfflineSearchDocument[],
  normalizedQuery: string,
  queryTerms: string[],
  signal?: AbortSignal
): Promise<RankedOfflineSearchDocument[]> => {
  const ranked: RankedOfflineSearchDocument[] = []
  if (!normalizedQuery) {
    for (let index = 0; index < prepared.length; index += 1) {
      throwIfAborted(signal)
      ranked.push({ prepared: prepared[index], score: 0 })
      if (index % 16 === 15) await yieldToEventLoop()
    }
    return ranked
  }

  const automaton = createSearchAutomaton(normalizedQuery, queryTerms)
  for (let index = 0; index < prepared.length; index += 1) {
    throwIfAborted(signal)
    const scored = await scoreDocumentAsync(prepared[index], normalizedQuery, queryTerms, automaton, signal)
    if (scored) ranked.push(scored)
    if (index % 16 === 15) await yieldToEventLoop()
  }
  return ranked
}

/**
 * Rank one previously prepared downloaded-only corpus synchronously.
 * The prepared value is immutable and may be reused for every query in the
 * same committed corpus revision.
 */
export const searchPreparedOfflineDocuments = (corpus: OfflineSearchCorpus, query = '', options: OfflineSearchOptions = {}): OfflineSearchResponse => {
  throwIfAborted(options.signal)
  const maxResults = boundedLimit(options.limit)
  const { normalizedQuery, queryTerms } = normalizeOfflineQuery(query)
  if (normalizedQuery && queryTerms.length === 0) return { results: [], hasMore: false }
  return finishSearch(rankPreparedDocuments(preparedDocuments(corpus), normalizedQuery, queryTerms, options.signal), maxResults, options.signal)
}

/**
 * Yield at every scoring chunk so a new keystroke can cancel stale ranking
 * work. The prepared corpus and each query's scoring character budget remain
 * bounded even when the original input was huge.
 */
export const searchPreparedOfflineDocumentsAsync = async (
  corpus: OfflineSearchCorpus,
  query = '',
  options: OfflineSearchOptions = {}
): Promise<OfflineSearchResponse> => {
  throwIfAborted(options.signal)
  const maxResults = boundedLimit(options.limit)
  const { normalizedQuery, queryTerms } = normalizeOfflineQuery(query)
  if (normalizedQuery && queryTerms.length === 0) return { results: [], hasMore: false }
  const ranked = await rankPreparedDocumentsAsync(preparedDocuments(corpus), normalizedQuery, queryTerms, options.signal)
  return finishSearch(ranked, maxResults, options.signal)
}
