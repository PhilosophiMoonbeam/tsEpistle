import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { canSearchReviewerDirectory, manualReviewerId, searchApprovalReviewers } from './approval-reviewer-search.ts'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('approval reviewer search', () => {
  it('reads a typed user ID as an explicit choice', () => {
    expect(manualReviewerId('42')).toBe(42)
    expect(manualReviewerId(' #7 ')).toBe(7)
    expect(manualReviewerId('0')).toBeNull()
    expect(manualReviewerId('ada')).toBeNull()
    expect(manualReviewerId('9'.repeat(13))).toBeNull()
  })

  it('uses the account directory only for user administrators', () => {
    expect(canSearchReviewerDirectory(['read:pages', 'write:pages'])).toBe(false)
    expect(canSearchReviewerDirectory(['manage:users'])).toBe(true)
    expect(canSearchReviewerDirectory(['manage:system'])).toBe(true)
  })

  it('searches the account directory for administrators', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 3, name: 'Grace Hopper', email: 'g@example.test', providerKey: 'local' }]))
    const options = await searchApprovalReviewers({ fetchImpl, pageId: 9, query: 'Grace', directory: true })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/_api/users/search?query=Grace')
    expect(options).toEqual([{ id: 3, label: 'Grace Hopper', source: 'directory' }])
  })

  it('falls back to people in this page discussion by handle', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 5, handle: 'ada', name: 'Ada' }]))
    const options = await searchApprovalReviewers({ fetchImpl, pageId: 9, query: '@Ada', directory: false })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/_api/comments/mentions?pageId=9&q=ada')
    expect(options).toEqual([{ id: 5, label: 'Ada (@ada)', source: 'discussion' }])
  })

  it('does not search for short, numeric, or non-handle discussion queries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    for (const query of ['a', '42', 'Ada Lovelace']) {
      expect(await searchApprovalReviewers({ fetchImpl, pageId: 9, query, directory: false })).toEqual([])
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a failed search so the dialog can ask for a user ID', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403))
    await expect(searchApprovalReviewers({ fetchImpl, pageId: 9, query: 'ada', directory: false })).rejects.toThrow()
  })
})
