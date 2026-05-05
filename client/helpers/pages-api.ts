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

type PageDetails = {
  id: number
  locale: string
  path: string
  hash: string
  title: string | null
  description: string | null
  isPrivate: boolean
  isPublished: boolean
  privateNS: string | null
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

type PageLinkRow = {
  id: number
  path: string
  title: string
  links: string[]
}

type PageListRow = {
  id: number
  locale: string
  path: string
  title: string | null
  description: string | null
  isPublished: boolean
  isPrivate: boolean
  privateNS: string | null
  contentType: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

type RecentPageRow = {
  id: number
  locale: string
  path: string
  title: string
  updatedAt: string
}

type PageTagRow = {
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
    id: tagRow.id,
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
  if (!Number.isInteger(page.id) || typeof page.locale !== 'string' || page.locale.length < 1 || typeof page.path !== 'string' || typeof page.hash !== 'string' || (page.title !== null && typeof page.title !== 'string') || (page.description !== null && typeof page.description !== 'string') || typeof page.isPrivate !== 'boolean' || typeof page.isPublished !== 'boolean' || (page.privateNS !== null && typeof page.privateNS !== 'string') || (page.publishStartDate !== null && typeof page.publishStartDate !== 'string') || (page.publishEndDate !== null && typeof page.publishEndDate !== 'string') || typeof page.contentType !== 'string' || typeof page.createdAt !== 'string' || page.createdAt.length < 1 || typeof page.updatedAt !== 'string' || page.updatedAt.length < 1 || typeof page.editor !== 'string' || !Number.isInteger(page.authorId) || typeof page.authorName !== 'string' || typeof page.authorEmail !== 'string' || !Number.isInteger(page.creatorId) || typeof page.creatorName !== 'string' || typeof page.creatorEmail !== 'string') {
    throw new Error(fallbackMessage)
  }

  return {
    id: page.id,
    locale: page.locale,
    path: page.path,
    hash: page.hash,
    title: page.title,
    description: page.description,
    isPrivate: page.isPrivate,
    isPublished: page.isPublished,
    privateNS: page.privateNS,
    publishStartDate: page.publishStartDate,
    publishEndDate: page.publishEndDate,
    contentType: page.contentType,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    editor: page.editor,
    authorId: page.authorId,
    authorName: page.authorName,
    authorEmail: page.authorEmail,
    creatorId: page.creatorId,
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
    id: pageRow.id,
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
  if (!Number.isInteger(pageRow.id) || typeof pageRow.locale !== 'string' || pageRow.locale.length < 1 || typeof pageRow.path !== 'string' || (pageRow.title !== null && typeof pageRow.title !== 'string') || (pageRow.description !== null && typeof pageRow.description !== 'string') || typeof pageRow.isPublished !== 'boolean' || typeof pageRow.isPrivate !== 'boolean' || (pageRow.privateNS !== null && typeof pageRow.privateNS !== 'string') || typeof pageRow.contentType !== 'string' || typeof pageRow.createdAt !== 'string' || pageRow.createdAt.length < 1 || typeof pageRow.updatedAt !== 'string' || pageRow.updatedAt.length < 1 || !Array.isArray(pageRow.tags) || pageRow.tags.some(tag => typeof tag !== 'string')) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    description: pageRow.description,
    isPublished: pageRow.isPublished,
    isPrivate: pageRow.isPrivate,
    privateNS: pageRow.privateNS,
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
  if (!Number.isInteger(pageRow.id) || typeof pageRow.locale !== 'string' || pageRow.locale.length < 1 || typeof pageRow.path !== 'string' || typeof pageRow.title !== 'string' || typeof pageRow.updatedAt !== 'string' || pageRow.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    updatedAt: pageRow.updatedAt
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


export async function updatePageTag (fetchImpl: FetchImpl, id: number, tag: string, title: string, fallbackMessage = 'Tag update failed'): Promise<MessageResponse> {
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
