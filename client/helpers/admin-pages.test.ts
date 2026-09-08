import { afterEach, describe, expect, it } from '../../server/test/bun-test.mts'
import { applyPublication, inspectPublication, pageHref, publicationState, type PublicationReview } from './admin-pages'
const originalWindow = globalThis.window
const now = Date.parse('2026-09-06T12:00:00Z')
afterEach(() => {
  globalThis.window = originalWindow
})
describe('page administration workflows', () => {
  it('distinguishes unavailable metadata, draft, schedule, expired window and unknown legacy schedule', () => {
    const page = { isPublished: true, publishStartDate: '', publishEndDate: '' }
    const undisclosed = {}
    expect(publicationState(undisclosed, now)).toBe('Unavailable')
    expect(undisclosed).not.toHaveProperty('isPublished')
    expect(publicationState(page, now)).toBe('Published')
    expect(publicationState({ ...page, isPublished: false }, now)).toBe('Draft')
    expect(publicationState({ ...page, publishStartDate: '2026-09-07T00:00:00Z' }, now)).toBe('Scheduled')
    expect(publicationState({ ...page, publishEndDate: '2026-09-05T00:00:00Z' }, now)).toBe('Window ended')
    expect(publicationState({ ...page, publishEndDate: 'invalid' }, now)).toBe('Invalid schedule')
    expect(publicationState({ isPublished: true }, now)).toBe('Enabled')
    expect(publicationState({ ...page, publishEndDate: new Date(now).toISOString() }, now)).toBe('Published')
  })
  it('encodes navigation paths and preserves the private namespace', () => {
    expect(pageHref({ visibility: 'private', locale: 'en', path: 'notes/a?b#c' }, '/e')).toBe('/e/_private/en/notes/a%3Fb%23c')
  })
  it('does not overwrite newer revisions or retry failed bulk writes automatically', async () => {
    const requests: unknown[] = []
    globalThis.window = {
      location: { origin: 'https://wiki.test' },
      fetch: async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ error: 'Page changed; review it again' }), { status: 409, headers: { 'content-type': 'application/json' } })
      }
    } as unknown as Window & typeof globalThis
    const row = { id: 5, title: 'Page', status: 'ready', page: { sourceRevision: '7', isPublished: true }, error: '' } as PublicationReview
    await applyPublication(row, false)
    expect(row.status).toBe('error')
    expect(row.error).toContain('Page changed')
    await applyPublication(row, false)
    expect(requests).toEqual([{ isPublished: false, expectedSourceRevision: '7' }])
  })
  it('skips unchanged publication without writing and clears old snapshots when review fails', async () => {
    const row = { id: 5, title: 'Page', status: 'ready', page: { sourceRevision: '7', isPublished: true }, error: '' } as PublicationReview
    await applyPublication(row, true)
    expect(row.status).toBe('unchanged')
    globalThis.window = {
      fetch: async () => {
        throw new Error('Access changed')
      }
    } as unknown as Window & typeof globalThis
    await inspectPublication(row)
    expect(row.page).toBeNull()
    expect(row.status).toBe('error')
    expect(row.error).toBe('Access changed')
  })
})
