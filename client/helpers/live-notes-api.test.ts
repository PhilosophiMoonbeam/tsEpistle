import { expect, it, vi } from '../../server/test/bun-test.mts'
import { createLiveNotesApi, LiveNotesApiError } from './live-notes-api.ts'

it('sends current same-origin CSRF admission without caching note data', async () => {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ token: 'signed', key: 'my-note', websocketPath: '/_api/live-notes/_socket', expiresAt: '2099-01-01T00:00:00.000Z' }), {
        status: 200
      })
  )
  let csrf = 'current'
  const api = createLiveNotesApi(fetcher as typeof fetch, () => csrf)
  await api.session('my-note')
  expect(fetcher.mock.calls[0]).toEqual([
    '/_api/live-notes/my-note/session',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: '{}',
      headers: expect.objectContaining({ 'x-wiki-csrf': 'current' })
    })
  ])
  csrf = 'replacement'
  await api.session('my-note')
  expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ 'x-wiki-csrf': 'replacement' })
})

it('preserves stale-revision rejection and does not retry a note mutation', async () => {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 'NOTE_CONFLICT', error: 'The note changed.' }), { status: 409 })
  )
  const api = createLiveNotesApi(fetcher as typeof fetch, () => 'csrf')
  await expect(api.restore('my-note', 2, 8)).rejects.toMatchObject({ status: 409, code: 'NOTE_CONFLICT', message: 'The note changed.' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1]?.body).toBe('{"expectedRevision":8}')
})

it('validates owner inventory responses and never treats a malformed response as a successful empty list', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], hasMore: true, nextCursor: null }), { status: 200 }))
  const api = createLiveNotesApi(fetcher as typeof fetch, () => 'csrf')
  await expect(api.list()).rejects.toThrow()
})

it('retains a forbidden HTTP status when the server denies current authority', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 'FORBIDDEN', error: 'Access denied.' }), { status: 403 }))
  const api = createLiveNotesApi(fetcher as typeof fetch, () => 'csrf')
  try {
    await api.access('my-note', 3, 'edit')
    throw new Error('Expected denial')
  } catch (error) {
    expect(error).toBeInstanceOf(LiveNotesApiError)
    expect(error).toMatchObject({ status: 403 })
  }
})
