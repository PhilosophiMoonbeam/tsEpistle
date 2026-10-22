import { sameOriginJsonFetch } from './json-transport.ts'
import {
  parseLiveNoteView,
  parseLiveNoteList,
  parseLiveNoteHistoryList,
  parseLiveNoteSession,
  type LiveNoteAccess,
  type LiveNoteView,
  type LiveNoteSummary,
  type LiveNoteSession,
  type LiveNoteHistoryItem
} from '../../shared/live-notes.ts'

export class LiveNotesApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface LiveNotesApi {
  list(cursor?: string | null, signal?: AbortSignal): Promise<{ items: LiveNoteSummary[]; hasMore: boolean; nextCursor: string | null }>
  create(key?: string, signal?: AbortSignal): Promise<LiveNoteView>
  read(key: string, signal?: AbortSignal): Promise<LiveNoteView>
  access(key: string, expectedRevision: number, access: LiveNoteAccess, signal?: AbortSignal): Promise<LiveNoteView>
  remove(key: string, expectedRevision: number, signal?: AbortSignal): Promise<boolean>
  history(key: string, cursor?: string | null, signal?: AbortSignal): Promise<{ items: LiveNoteHistoryItem[]; hasMore: boolean; nextCursor: string | null }>
  revision(key: string, revision: number, signal?: AbortSignal): Promise<LiveNoteView>
  restore(key: string, revision: number, expectedRevision: number, signal?: AbortSignal): Promise<LiveNoteView>
  session(key: string, signal?: AbortSignal): Promise<LiveNoteSession>
}

export function createLiveNotesApi(fetcher: typeof fetch, csrfToken: () => string): LiveNotesApi {
  async function request<T>(path: string, parse: (value: unknown) => T, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await sameOriginJsonFetch(fetcher, `/_api/live-notes${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'x-wiki-csrf': csrfToken() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const error = value as { error?: unknown; code?: unknown }
      throw new LiveNotesApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
        typeof error?.error === 'string' ? error.error : 'Live note request failed.'
      )
    }
    return parse(value)
  }
  const keyPath = (key: string) => `/${encodeURIComponent(key)}`
  const cursorQuery = (cursor?: string | null) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
  return {
    list: (cursor?: string | null, signal?: AbortSignal) => request(`/${cursorQuery(cursor)}`, parseLiveNoteList, 'GET', undefined, signal),
    create: (key?: string, signal?: AbortSignal) => request('/', parseLiveNoteView, 'POST', key ? { key } : {}, signal),
    read: (key: string, signal?: AbortSignal) => request(keyPath(key), parseLiveNoteView, 'GET', undefined, signal),
    access: (key: string, expectedRevision: number, access: LiveNoteAccess, signal?: AbortSignal) =>
      request(keyPath(key), parseLiveNoteView, 'PATCH', { expectedRevision, access }, signal),
    remove: (key: string, expectedRevision: number, signal?: AbortSignal) =>
      request(
        keyPath(key),
        value => {
          if (!value || typeof value !== 'object' || Reflect.get(value, 'deleted') !== true) throw new Error('Invalid note deletion response.')
          return true
        },
        'DELETE',
        { expectedRevision },
        signal
      ),
    history: (key: string, cursor?: string | null, signal?: AbortSignal) =>
      request(`${keyPath(key)}/revisions${cursorQuery(cursor)}`, parseLiveNoteHistoryList, 'GET', undefined, signal),
    revision: (key: string, revision: number, signal?: AbortSignal) =>
      request(`${keyPath(key)}/revisions/${revision}`, parseLiveNoteView, 'GET', undefined, signal),
    restore: (key: string, revision: number, expectedRevision: number, signal?: AbortSignal) =>
      request(`${keyPath(key)}/revisions/${revision}/restore`, parseLiveNoteView, 'POST', { expectedRevision }, signal),
    session: (key: string, signal?: AbortSignal) => request(`${keyPath(key)}/session`, parseLiveNoteSession, 'POST', {}, signal)
  }
}
