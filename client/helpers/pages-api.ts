import { isRecord } from './type-guards'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, init: {
  method?: string
  credentials: 'same-origin'
  headers: {
    Accept: 'application/json'
    'Content-Type'?: 'application/json'
  }
  body?: string
}) => Promise<JsonResponse>

type MessageResponse = {
  message: string
}

export type PageDetails = {
  id: number
  locale: string
  path: string
  hash: string
  title: string | null
  description: string | null
  visibility: 'public' | 'private'
  ownerId: number | null
  isPublished: boolean
  publishStartDate: string | null
  publishEndDate: string | null
  contentType: string
  createdAt: string
  updatedAt: string
  editor: string
  authorId: number
  authorName: string
  authorEmail: string
  creatorId: number
  creatorName: string
  creatorEmail: string
}

export type PageLinkRow = {
  id: number
  path: string
  title: string
  links: string[]
}

export type PageListRow = {
  id: number
  locale: string
  path: string
  title: string | null
  description: string | null
  isPublished: boolean
  visibility: 'public' | 'private'
  ownerId: number | null
  contentType: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

export type RecentPageRow = {
  id: number
  locale: string
  path: string
  title: string
  updatedAt: string
  visibility: 'public' | 'private'
}

export type PageTagRow = {
  id: number
  tag: string
  title: string | null
  createdAt: string
  updatedAt: string
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && ((payload as { error: string }).error).length > 0) {
      throw new Error((payload as { error: string }).error)
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === 'string' && ((payload as { message: string }).message).length > 0) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizePageTagRow (row: unknown, fallbackMessage: string): PageTagRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const tagRow = row as Partial<PageTagRow>
  if (!Number.isInteger(tagRow.id) || typeof tagRow.tag !== 'string' || (tagRow.title !== null && typeof tagRow.title !== 'string') || typeof tagRow.createdAt !== 'string' || tagRow.createdAt.length < 1 || typeof tagRow.updatedAt !== 'string' || tagRow.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: tagRow.id!,
    tag: tagRow.tag,
    title: tagRow.title,
    createdAt: tagRow.createdAt,
    updatedAt: tagRow.updatedAt
  }
}

function normalizePageDetails (row: unknown, fallbackMessage: string): PageDetails {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const page = row as Partial<PageDetails>
  const ownerId = page.ownerId
  const validOwner = ownerId === null || (typeof ownerId === 'number' && Number.isSafeInteger(ownerId))
  if (!Number.isInteger(page.id) || typeof page.locale !== 'string' || page.locale.length < 1 || typeof page.path !== 'string' || typeof page.hash !== 'string' || (page.title !== null && typeof page.title !== 'string') || (page.description !== null && typeof page.description !== 'string') || (page.visibility !== 'public' && page.visibility !== 'private') || !validOwner || typeof page.isPublished !== 'boolean' || (page.publishStartDate !== null && typeof page.publishStartDate !== 'string') || (page.publishEndDate !== null && typeof page.publishEndDate !== 'string') || typeof page.contentType !== 'string' || typeof page.createdAt !== 'string' || page.createdAt.length < 1 || typeof page.updatedAt !== 'string' || page.updatedAt.length < 1 || typeof page.editor !== 'string' || !Number.isInteger(page.authorId) || typeof page.authorName !== 'string' || typeof page.authorEmail !== 'string' || !Number.isInteger(page.creatorId) || typeof page.creatorName !== 'string' || typeof page.creatorEmail !== 'string') {
    throw new Error(fallbackMessage)
  }

  return {
    id: page.id!,
    locale: page.locale,
    path: page.path,
    hash: page.hash,
    title: page.title,
    description: page.description,
    visibility: page.visibility,
    ownerId,
    isPublished: page.isPublished,
    publishStartDate: page.publishStartDate,
    publishEndDate: page.publishEndDate,
    contentType: page.contentType,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    editor: page.editor,
    authorId: page.authorId!,
    authorName: page.authorName,
    authorEmail: page.authorEmail,
    creatorId: page.creatorId!,
    creatorName: page.creatorName,
    creatorEmail: page.creatorEmail
  }
}

function normalizePageLinkRow (row: unknown, fallbackMessage: string): PageLinkRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<PageLinkRow>
  if (!Number.isInteger(pageRow.id) || typeof pageRow.path !== 'string' || pageRow.path.length < 1 || typeof pageRow.title !== 'string' || !Array.isArray(pageRow.links) || pageRow.links.some(link => typeof link !== 'string')) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id!,
    path: pageRow.path,
    title: pageRow.title,
    links: pageRow.links
  }
}

function normalizePageListRow (row: unknown, fallbackMessage: string): PageListRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<PageListRow>
  const ownerId = pageRow.ownerId
  const validOwner = ownerId === null || (typeof ownerId === 'number' && Number.isSafeInteger(ownerId))
  if (!Number.isInteger(pageRow.id) || typeof pageRow.locale !== 'string' || pageRow.locale.length < 1 || typeof pageRow.path !== 'string' || (pageRow.title !== null && typeof pageRow.title !== 'string') || (pageRow.description !== null && typeof pageRow.description !== 'string') || typeof pageRow.isPublished !== 'boolean' || (pageRow.visibility !== 'public' && pageRow.visibility !== 'private') || !validOwner || typeof pageRow.contentType !== 'string' || typeof pageRow.createdAt !== 'string' || pageRow.createdAt.length < 1 || typeof pageRow.updatedAt !== 'string' || pageRow.updatedAt.length < 1 || !Array.isArray(pageRow.tags) || pageRow.tags.some(tag => typeof tag !== 'string')) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id!,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    description: pageRow.description,
    isPublished: pageRow.isPublished,
    visibility: pageRow.visibility,
    ownerId,
    contentType: pageRow.contentType,
    createdAt: pageRow.createdAt,
    updatedAt: pageRow.updatedAt,
    tags: pageRow.tags
  }
}

function normalizeRecentPageRow (row: unknown, fallbackMessage: string): RecentPageRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<RecentPageRow>
  if (!Number.isInteger(pageRow.id) || typeof pageRow.locale !== 'string' || pageRow.locale.length < 1 || typeof pageRow.path !== 'string' || typeof pageRow.title !== 'string' || typeof pageRow.updatedAt !== 'string' || pageRow.updatedAt.length < 1 || (pageRow.visibility !== 'public' && pageRow.visibility !== 'private')) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id!,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    updatedAt: pageRow.updatedAt,
    visibility: pageRow.visibility
  }
}

export async function fetchPageLinks (fetchImpl: FetchImpl, locale: string, fallbackMessage = 'Page links response is invalid'): Promise<PageLinkRow[]> {
  const response = await fetchImpl(`/_api/pages/links?locale=${encodeURIComponent(locale)}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizePageLinkRow(row, fallbackMessage))
}

export async function fetchPage (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Page response is invalid'): Promise<PageDetails> {
  const response = await fetchImpl(`/_api/pages/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizePageDetails(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function fetchPageList (fetchImpl: FetchImpl, fallbackMessage = 'Page list response is invalid'): Promise<PageListRow[]> {
  const response = await fetchImpl('/_api/pages', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizePageListRow(row, fallbackMessage))
}

export async function fetchPageTags (fetchImpl: FetchImpl, fallbackMessage = 'Page tags response is invalid'): Promise<PageTagRow[]> {
  const response = await fetchImpl('/_api/pages/tags', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizePageTagRow(row, fallbackMessage))
}

export async function fetchRecentPages (fetchImpl: FetchImpl, fallbackMessage = 'Recent pages response is invalid'): Promise<RecentPageRow[]> {
  const response = await fetchImpl('/_api/pages/recent', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeRecentPageRow(row, fallbackMessage))
}


export async function updatePageTag (fetchImpl: FetchImpl, id: number, tag: string, title: string | null, fallbackMessage = 'Tag update failed'): Promise<MessageResponse> {
  const response = await fetchImpl(`/_api/pages/tags/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tag, title })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}


export async function deletePageTag (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Tag delete failed'): Promise<MessageResponse> {
  const response = await fetchImpl(`/_api/pages/tags/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}


export async function deletePage (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Page delete failed'): Promise<MessageResponse> {
  const response = await fetchImpl(`/_api/pages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

type PageWriteInput = {
  content: string
  description: string
  editor: string
  visibility: 'public' | 'private'
  isPublished: boolean
  locale: string
  path: string
  publishEndDate: string
  publishStartDate: string
  scriptCss: string
  scriptJs: string
  tags: string[]
  title: string
}

export type PageConflictLatest = {
  updatedAt: string
  authorName: string
  content: string
  locale: string
  path: string
  title: string
  description: string
}

export type PageTreeRow = {
  id: number
  path: string
  title: string
  isFolder: boolean
  pageId: number | null
  parent: number
  locale: string
  visibility: 'public' | 'private'
  ownerId: number | null
}

export type PageSearchRow = {
  id: string | number
  title: string
  description: string
  path: string
  locale: string
  visibility: 'public' | 'private'
}

export type PageSearchResult = {
  results: PageSearchRow[]
  suggestions: string[]
  totalHits: number
}

async function sendJson (fetchImpl: FetchImpl, url: string, method: string, body: unknown, fallbackMessage: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return parseJsonResponse(response, fallbackMessage)
}

type WrittenPage = {
  id: number
  updatedAt: string
}

function normalizeWrittenPage (payload: unknown, fallbackMessage: string, requireId: boolean): WrittenPage {
  if (!isRecord(payload) || !isRecord(payload.page) || typeof payload.page.updatedAt !== 'string') throw new Error(fallbackMessage)
  const id = payload.page.id
  if (requireId && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)) throw new Error(fallbackMessage)
  return { id: typeof id === 'number' ? id : 0, updatedAt: payload.page.updatedAt }
}
function isNullableNumber (value: unknown): value is number | null {
  return value === null || typeof value === 'number'
}

export async function createPage (fetchImpl: FetchImpl, input: PageWriteInput, fallbackMessage = 'Page creation failed'): Promise<WrittenPage> {
  return normalizeWrittenPage(await sendJson(fetchImpl, '/_api/pages', 'POST', input, fallbackMessage), fallbackMessage, true)
}

export async function updatePage (fetchImpl: FetchImpl, id: number, input: PageWriteInput, fallbackMessage = 'Page update failed'): Promise<WrittenPage> {
  return normalizeWrittenPage(await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}`, 'PUT', input, fallbackMessage), fallbackMessage, false)
}

export async function changePageVisibility (
  fetchImpl: FetchImpl,
  id: number,
  visibility: 'public' | 'private',
  confirmPublication = false,
  fallbackMessage = 'Page visibility update failed'
): Promise<WrittenPage> {
  return normalizeWrittenPage(
    await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/visibility`, 'PATCH', { visibility, confirmPublication }, fallbackMessage),
    fallbackMessage,
    true
  )
}

export async function convertPage (fetchImpl: FetchImpl, id: number, editor: string, fallbackMessage = 'Page conversion failed'): Promise<void> {
  await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/convert`, 'POST', { editor }, fallbackMessage)
}

export async function movePage (fetchImpl: FetchImpl, id: number, destinationLocale: string, destinationPath: string, fallbackMessage = 'Page move failed'): Promise<void> {
  await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/move`, 'POST', { destinationLocale, destinationPath }, fallbackMessage)
}

export async function checkPageConflict (fetchImpl: FetchImpl, id: number, checkoutDate: string, fallbackMessage = 'Page conflict check failed'): Promise<boolean> {
  const payload = await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/conflicts/check`, 'POST', { checkoutDate }, fallbackMessage)
  if (!isRecord(payload) || typeof payload.conflict !== 'boolean') throw new Error(fallbackMessage)
  return payload.conflict
}

export async function fetchPageConflictLatest (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Latest page version fetch failed'): Promise<PageConflictLatest> {
  const response = await fetchImpl(`/_api/pages/${encodeURIComponent(id)}/conflict-latest`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (
    !isRecord(payload) ||
    typeof payload.updatedAt !== 'string' ||
    typeof payload.authorName !== 'string' ||
    typeof payload.content !== 'string' ||
    typeof payload.locale !== 'string' ||
    typeof payload.path !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.description !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    updatedAt: payload.updatedAt,
    authorName: payload.authorName,
    content: payload.content,
    locale: payload.locale,
    path: payload.path,
    title: payload.title,
    description: payload.description
  }
}

export async function fetchPageTree (fetchImpl: FetchImpl, options: { locale: string, parent?: number, path?: string, mode?: 'ALL' | 'FOLDERS' | 'PAGES', includeAncestors?: boolean }, fallbackMessage = 'Page tree response is invalid'): Promise<PageTreeRow[]> {
  const params = new URLSearchParams({ locale: options.locale, mode: options.mode || 'ALL' })
  if (options.parent !== undefined) params.set('parent', String(options.parent))
  if (options.path) params.set('path', options.path)
  if (options.includeAncestors) params.set('includeAncestors', 'true')
  const response = await fetchImpl(`/_api/pages/tree?${params.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => {
    if (!isRecord(row)) throw new Error(fallbackMessage)
    const pageId = row.pageId
    if (!isNullableNumber(pageId)) throw new Error(fallbackMessage)
    const ownerId = row.ownerId
    if (!isNullableNumber(ownerId) || (row.visibility !== 'public' && row.visibility !== 'private') || typeof row.id !== 'number' || typeof row.path !== 'string' || typeof row.title !== 'string' || typeof row.isFolder !== 'boolean' || typeof row.parent !== 'number' || typeof row.locale !== 'string') {
      throw new Error(fallbackMessage)
    }
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      isFolder: row.isFolder,
      pageId,
      parent: row.parent,
      locale: row.locale,
      visibility: row.visibility,
      ownerId
    }
  })
}

export async function searchPages (fetchImpl: FetchImpl, query: string, options: { locale?: string, path?: string } = {}, fallbackMessage = 'Page search response is invalid'): Promise<PageSearchResult> {
  const params = new URLSearchParams({ query })
  if (options.locale) params.set('locale', options.locale)
  if (options.path) params.set('path', options.path)
  const response = await fetchImpl(`/_api/pages/search?${params.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || !Array.isArray(payload.results) || !Array.isArray(payload.suggestions) || typeof payload.totalHits !== 'number') throw new Error(fallbackMessage)
  const results = payload.results.map(row => {
    if (!isRecord(row) ||
      (typeof row.id !== 'string' && typeof row.id !== 'number') ||
      typeof row.title !== 'string' ||
      typeof row.description !== 'string' ||
      typeof row.path !== 'string' ||
      typeof row.locale !== 'string' ||
      (row.visibility !== 'public' && row.visibility !== 'private')) {
      throw new Error(fallbackMessage)
    }
    const visibility: 'public' | 'private' = row.visibility
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      path: row.path,
      locale: row.locale,
      visibility
    }
  })
  if (payload.suggestions.some(suggestion => typeof suggestion !== 'string')) throw new Error(fallbackMessage)
  return { results, suggestions: payload.suggestions, totalHits: payload.totalHits }
}

export async function searchPageTags (fetchImpl: FetchImpl, query: string, fallbackMessage = 'Tag search response is invalid'): Promise<string[]> {
  const response = await fetchImpl(`/_api/pages/tags/search?query=${encodeURIComponent(query)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload) || payload.some(tag => typeof tag !== 'string')) throw new Error(fallbackMessage)
  return payload
}


export type PageHistoryTrailItem = {
  versionId: number
  authorId: number
  authorName: string
  actionType: string
  valueBefore: string | null
  valueAfter: string | null
  versionDate: string
}

export type PageVersion = Record<string, unknown> & {
  versionId: number
  content: string
  title: string
  description: string
  path: string
}

export async function fetchPages (fetchImpl: FetchImpl, options: { creatorId?: number, authorId?: number, locale?: string, tags?: string[] } = {}, fallbackMessage = 'Page list response is invalid'): Promise<PageListRow[]> {
  const params = new URLSearchParams()
  if (options.creatorId) params.set('creatorId', String(options.creatorId))
  if (options.authorId) params.set('authorId', String(options.authorId))
  if (options.locale) params.set('locale', options.locale)
  if (options.tags && options.tags.length > 0) params.set('tags', options.tags.join(','))
  const suffix = params.toString()
  const response = await fetchImpl(`/_api/pages${suffix ? `?${suffix}` : ''}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizePageListRow(row, fallbackMessage))
}

export async function fetchPageHistory (fetchImpl: FetchImpl, id: number, offsetPage: number, offsetSize: number, fallbackMessage = 'Page history fetch failed'): Promise<{ trail: PageHistoryTrailItem[], total: number }> {
  const response = await fetchImpl(`/_api/pages/${encodeURIComponent(id)}/history?offsetPage=${encodeURIComponent(offsetPage)}&offsetSize=${encodeURIComponent(offsetSize)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || !Array.isArray(payload.trail) || typeof payload.total !== 'number') throw new Error(fallbackMessage)
  const trail = payload.trail.map(row => {
    if (!isRecord(row) || !Number.isInteger(row.versionId) || !Number.isInteger(row.authorId) || typeof row.authorName !== 'string' || typeof row.actionType !== 'string' || (row.valueBefore !== null && typeof row.valueBefore !== 'string') || (row.valueAfter !== null && typeof row.valueAfter !== 'string') || typeof row.versionDate !== 'string') throw new Error(fallbackMessage)
    return row as PageHistoryTrailItem
  })
  return { trail, total: payload.total }
}

export async function fetchPageVersion (fetchImpl: FetchImpl, pageId: number, versionId: number, fallbackMessage = 'Page version fetch failed'): Promise<PageVersion> {
  const response = await fetchImpl(`/_api/pages/${encodeURIComponent(pageId)}/history/${encodeURIComponent(versionId)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || !Number.isInteger(payload.versionId) || typeof payload.content !== 'string' || typeof payload.title !== 'string' || typeof payload.description !== 'string' || typeof payload.path !== 'string') throw new Error(fallbackMessage)
  return payload as PageVersion
}

export async function restorePageVersion (fetchImpl: FetchImpl, pageId: number, versionId: number, fallbackMessage = 'Page restore failed'): Promise<void> {
  await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(pageId)}/history/${encodeURIComponent(versionId)}/restore`, 'POST', {}, fallbackMessage)
}
