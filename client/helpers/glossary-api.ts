import type { GlossaryAccess, GlossaryAutolinkTerm, GlossaryPage, GlossaryTerm, GlossaryTermInput, GlossaryTermSummary } from '../../shared/glossary.ts'
import { sameOriginJsonFetch } from './json-transport.ts'

export class GlossaryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
    this.name = 'GlossaryApiError'
  }
}
export type GlossaryWrite = Omit<GlossaryTermInput, 'documentationPageId' | 'documentationLabel'> &
  Partial<Pick<GlossaryTermInput, 'documentationPageId' | 'documentationLabel'>>
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const summary = (value: unknown): value is GlossaryTermSummary =>
  record(value) && integer(value.id) && integer(value.revision) && ['locale', 'term', 'expansion', 'category'].every(key => typeof value[key] === 'string')
const access = (value: unknown): value is GlossaryAccess =>
  record(value) && typeof value.locale === 'string' && ['enabled', 'canRead', 'canManage'].every(key => typeof value[key] === 'boolean')
const autolink = (value: unknown): value is GlossaryAutolinkTerm =>
  record(value) && integer(value.id) && typeof value.term === 'string' && strings(value.aliases) && typeof value.caseSensitive === 'boolean'
const term = (value: unknown): value is GlossaryTerm =>
  summary(value) &&
  record(value) &&
  ['definition', 'definitionHtml', 'documentationLabel', 'createdAt', 'updatedAt'].every(key => typeof value[key] === 'string') &&
  strings(value.aliases) &&
  Array.isArray(value.relatedIds) &&
  value.relatedIds.every(integer) &&
  Array.isArray(value.relatedTerms) &&
  value.relatedTerms.every(summary) &&
  typeof value.caseSensitive === 'boolean' &&
  typeof value.autoLink === 'boolean' &&
  (value.documentationPageId === null || integer(value.documentationPageId)) &&
  (value.documentation === null ||
    (record(value.documentation) &&
      integer(value.documentation.id) &&
      ['title', 'label', 'href', 'locale', 'path'].every(key => typeof (value.documentation as Record<string, unknown>)[key] === 'string'))) &&
  Array.isArray(value.references) &&
  value.references.every(reference => record(reference) && typeof reference.label === 'string' && typeof reference.url === 'string')
const page =
  <T>(item: (value: unknown) => value is T) =>
  (value: unknown): value is GlossaryPage<T> =>
    record(value) &&
    Array.isArray(value.items) &&
    value.items.every(item) &&
    typeof value.complete === 'boolean' &&
    (value.nextCursor === null || typeof value.nextCursor === 'string') &&
    (value.complete ? value.nextCursor === null : typeof value.nextCursor === 'string' && value.nextCursor.length > 0)
async function request<T>(path: string, valid: (value: unknown) => value is T, signal?: AbortSignal, method = 'GET', body?: unknown): Promise<T> {
  const response = await sameOriginJsonFetch(fetch, `/_api/glossary${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const value: unknown = await response.json()
  if (!response.ok)
    throw new GlossaryApiError(
      record(value) && typeof value.error === 'string' ? value.error : 'Glossary request failed.',
      response.status,
      record(value) && typeof value.code === 'string' ? value.code : ''
    )
  if (!valid(value)) throw new Error('The glossary returned an invalid response. Please reload and try again.')
  return value
}
const query = (values: Record<string, string | undefined>): string =>
  `?${new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString()}`
export const fetchGlossaryAccess = (locale: string, signal?: AbortSignal): Promise<GlossaryAccess> => request(`/access${query({ locale })}`, access, signal)
export const fetchGlossaryPage = (locale: string, search = '', cursor?: string, signal?: AbortSignal): Promise<GlossaryPage<GlossaryTermSummary>> =>
  request(`/${query({ locale, query: search, cursor, limit: '100' })}`, page(summary), signal)
export const fetchGlossaryAutolinkPage = (locale: string, cursor?: string, signal?: AbortSignal): Promise<GlossaryPage<GlossaryAutolinkTerm>> =>
  request(`/autolink${query({ locale, cursor, limit: '200' })}`, page(autolink), signal)
export const fetchGlossaryTerm = (id: number, signal?: AbortSignal): Promise<GlossaryTerm> => request(`/terms/${id}`, term, signal)
export const lookupGlossaryTerm = (locale: string, name: string, signal?: AbortSignal): Promise<GlossaryTerm> =>
  request(`/lookup${query({ locale, name })}`, term, signal)
export const saveGlossaryTerm = (input: GlossaryWrite, id?: number, expectedRevision?: number, signal?: AbortSignal): Promise<GlossaryTerm> =>
  request(id === undefined ? '/terms' : `/terms/${id}`, term, signal, id === undefined ? 'POST' : 'PUT', {
    ...input,
    ...(id === undefined ? {} : { expectedRevision })
  })
export const deleteGlossaryTerm = (id: number, expectedRevision: number, signal?: AbortSignal): Promise<{ deleted: true }> =>
  request(`/terms/${id}`, (value): value is { deleted: true } => record(value) && value.deleted === true, signal, 'DELETE', { expectedRevision })

/** Follow every server continuation; callers own lifetime/identity and never persist this catalog. */
export async function fetchGlossaryAutolinks(locale: string, signal: AbortSignal): Promise<GlossaryAutolinkTerm[]> {
  const items: GlossaryAutolinkTerm[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    signal.throwIfAborted()
    const result = await fetchGlossaryAutolinkPage(locale, cursor, signal)
    items.push(...result.items)
    if (result.complete) return items
    cursor = result.nextCursor ?? undefined
    if (!cursor || seen.has(cursor)) throw new Error('The glossary continuation did not advance. Please retry.')
    seen.add(cursor)
  }
}
